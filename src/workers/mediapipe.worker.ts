// FILE: src/workers/mediapipe.worker.ts
/**
 * mediapipe.worker.ts
 *
 * ARCHITECTURE NOTE (read before editing):
 *
 * ROOT CAUSES fixed in this revision:
 *
 *  1. SILENT HANG on init (GPU delegate + CDN WASM fetch blocked by CSP)
 *     The production _headers CSP `connect-src` did not include cdn.jsdelivr.net.
 *     Workers inherit the *HTTP-header* CSP, NOT the <meta http-equiv> CSP from
 *     index.html. The meta tag only applies to document resources; workers always
 *     use the header policy. Because _headers only had `connect-src 'self' blob:`,
 *     every fetch() inside the worker to cdn.jsdelivr.net was silently blocked.
 *     FilesetResolver.forVisionTasks() therefore never resolved, leaving the worker
 *     stuck after emitting `PROGRESS wasm 0%` and nothing else.
 *     FIX: wasmBlobUrl is now a pre-fetched blob: URL created on the *main thread*
 *     (where CDN access is available) and transferred here. The worker never
 *     directly fetches from CDN.
 *
 *  2. SILENT HANG during createFromOptions() with delegate:'GPU' + ImageData input
 *     MediaPipe's GPU delegate calls canvas.getContext('webgl2') internally.
 *     In a plain Worker (no OffscreenCanvas provided), Chrome creates a hidden
 *     1×1 OffscreenCanvas automatically — BUT on many Android/iOS WebViews and
 *     headless Chrome builds this silently returns null.  When the context is null
 *     the WASM runtime enters an infinite spin-wait in its GPU init path; the
 *     worker produces zero log output and never posts READY.
 *     Additionally, ImageData is a *CPU-side* object. Passing ImageData to a
 *     GPU-delegated model forces MediaPipe to copy pixels CPU→GPU on every frame,
 *     which negates most of the GPU benefit and sometimes triggers a texture-upload
 *     bug in older Chromium versions that manifests as "WebGL Device Lost".
 *     FIX: The worker creates its own persistent OffscreenCanvas and locks a WebGL2
 *     context on it before calling createFromOptions. MediaPipe's GPU delegate then
 *     reuses that context. Frames are accepted as ImageBitmap — which the GPU
 *     delegate uploads zero-copy — created with createImageBitmap(ImageData) inside
 *     the worker, requiring no DOM and no extra ArrayBuffer copy.
 *
 *  3. facing=undefined console log
 *     Cosmetic: desktop cameras do not report facingMode in getSettings().
 *     Fixed in cameraSystem.ts separately (not this file).
 */

import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

import {
  protocolMessage,
  validateMediaPipeInbound,
  type MediaPipeFramePayload as FramePayload,
  type UnversionedMediaPipeOutboundMessage as WorkerOutMessage,
  type MediaPipeWorkerState as WorkerState,
} from '../protocol/workerProtocol';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RingLandmark {
  index: HandLandmarkIndex;
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

interface TrackingResult {
  handedness: string;
  landmarks: RingLandmark[];
  worldLandmarks: RingLandmark[] | null;
  confidence: number;
  timestamp: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG = {
  NUM_HANDS: 1,
  MIN_DETECTION_CONFIDENCE: 0.4,
  MIN_PRESENCE_CONFIDENCE: 0.4,
  MIN_TRACKING_CONFIDENCE: 0.4,
} as const;

const HAND_LANDMARK_INDICES = Array.from({ length: 21 }, (_, index) => index) as HandLandmarkIndex[];
type HandLandmarkIndex = 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20;

// ─── Worker State ─────────────────────────────────────────────────────────────

let state: WorkerState = 'INIT';
let handLandmarker: HandLandmarker | null = null;
let paused = false;
let activeFrame: FramePayload | null = null;
let lastProcessedTimestamp = -1;

/**
 * Persistent OffscreenCanvas used as the WebGL2 surface for MediaPipe's GPU
 * delegate. Created once during initializeMediaPipe and reused for the lifetime
 * of the worker. This prevents the "auto-created 1×1 context fails silently"
 * path that causes createFromOptions() to hang on many mobile WebViews.
 */
let gpuCanvas: OffscreenCanvas | null = null;

const metrics = {
  frameCount: 0,
  droppedFrames: 0,
  processedFrames: 0,
  lastInferenceTime: 0,
  avgInferenceMs: 0,
};

type TrackingMetrics = typeof metrics & { lastInferenceMs: number; inferenceFps: number };

let consecutiveFailures = 0;
let degradedMode = false;

// ─── Frame Ring Buffer ────────────────────────────────────────────────────────

class FrameRingBuffer {
  private readonly frames: FramePayload[] = [];

  constructor(private readonly size: number) {}

  push(frame: FramePayload): number {
    const newest = this.frames[this.frames.length - 1];
    if (newest && newest.timestamp >= frame.timestamp) return 1;
    this.frames.push(frame);
    const staleDropCount = Math.max(0, this.frames.length - this.size);
    if (staleDropCount > 0) this.frames.splice(0, staleDropCount);
    return staleDropCount;
  }

  popLatest(): { frame: FramePayload | null; dropped: number } {
    const frame = this.frames.pop() ?? null;
    const dropped = this.frames.length;
    this.frames.length = 0;
    return { frame, dropped };
  }

  clear(): void { this.frames.length = 0; }
}

const frameRingBuffer = new FrameRingBuffer(2);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMetrics(): TrackingMetrics {
  return {
    ...metrics,
    lastInferenceMs: metrics.lastInferenceTime,
    inferenceFps: metrics.avgInferenceMs > 0 ? 1000 / metrics.avgInferenceMs : 0,
  };
}

function postMessageSafe(message: WorkerOutMessage): void {
  if (state !== 'DESTROY') self.postMessage(protocolMessage(message));
}

function reportError(message: string): void {
  postMessageSafe({ type: 'ERROR', payload: { message, state } });
}

function normalizeLandmark(index: HandLandmarkIndex, landmark: NormalizedLandmark): RingLandmark {
  return { index, x: landmark.x, y: landmark.y, z: landmark.z ?? 0, visibility: landmark.visibility };
}

function extractRingLandmarks(landmarks: NormalizedLandmark[] | undefined): RingLandmark[] {
  if (!landmarks) return [];
  return HAND_LANDMARK_INDICES.flatMap((index) => {
    const lm = landmarks[index];
    return lm ? [normalizeLandmark(index, lm)] : [];
  });
}

// ─── Frame Pipeline ───────────────────────────────────────────────────────────

function queueFrame(frame: FramePayload): void {
  metrics.frameCount += 1;

  if (state === 'DESTROY' || paused || !handLandmarker) {
    metrics.droppedFrames += 1;
    return;
  }

  if (frame.timestamp <= lastProcessedTimestamp) {
    metrics.droppedFrames += 1;
    return;
  }

  metrics.droppedFrames += frameRingBuffer.push(frame);
  drainLatestFrame();
}

function drainLatestFrame(): void {
  if ((state !== 'READY' && state !== 'DEGRADED') || paused || !handLandmarker) return;

  const nextFrame = frameRingBuffer.popLatest();
  metrics.droppedFrames += nextFrame.dropped;
  if (!nextFrame.frame) return;

  activeFrame = nextFrame.frame;
  processActiveFrame();
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Ensures a WebGL2 context exists on our persistent OffscreenCanvas before
 * passing it to MediaPipe. Returns true if GPU is available, false to fall
 * back to CPU.
 *
 * WHY: MediaPipe GPU delegate auto-creates a 1×1 OffscreenCanvas internally
 * when called from a Worker. On Chrome Android and some Chromium builds this
 * auto-creation silently returns a lost context, causing createFromOptions()
 * to hang indefinitely. By pre-creating and probing the context we:
 *   a) detect GPU unavailability before handing off to MediaPipe, and
 *   b) give MediaPipe a warm, verified WebGL2 context to reuse.
 */
function probeAndCreateGpuCanvas(): boolean {
  try {
    gpuCanvas = new OffscreenCanvas(1, 1);
    const ctx = gpuCanvas.getContext('webgl2');
    if (!ctx) {
      if (import.meta.env.DEV) console.warn('[MediaPipe] WebGL2 unavailable in Worker — falling back to CPU');
      gpuCanvas = null;
      return false;
    }
    // Verify context is not already lost
    if (ctx.isContextLost()) {
      gpuCanvas = null;
      return false;
    }
    return true;
  } catch {
    gpuCanvas = null;
    return false;
  }
}

/**
 * Initialize the HandLandmarker.
 *
 * @param wasmBlobUrl  A blob: URL (created on the main thread) pointing to
 *                     the MediaPipe WASM base directory. Using blob: avoids
 *                     any CDN fetch from inside the worker, which would be
 *                     blocked by the production `connect-src 'self' blob:`
 *                     HTTP CSP header (workers use HTTP-header CSP, not the
 *                     <meta http-equiv> CSP from index.html).
 * @param modelUrl     A blob: URL for the hand_landmarker.task model binary.
 */
async function initializeMediaPipe(wasmBlobUrl: string, modelUrl: string): Promise<void> {
  if (state === 'DESTROY' || handLandmarker) return;

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 0 } });

  // Step 1: Resolve WASM fileset from the pre-fetched blob: URL.
  // The second argument `false` disables FilesetResolver's own CDN fallback.
  const wasmFileset = await FilesetResolver.forVisionTasks(wasmBlobUrl);

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 100 } });
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 0 } });

  // Step 2: Probe WebGL2 availability. GPU delegate requires WebGL2 in the
  // Worker context. If unavailable, we fall back to CPU — which at the
  // frame sizes produced by captureVideoFrame (~384px longest edge) still
  // delivers ≥20 FPS on mid-range hardware.
  const gpuAvailable = probeAndCreateGpuCanvas();
  const delegate = gpuAvailable ? 'GPU' : 'CPU';

  if (import.meta.env.DEV) {
    console.log(`[MediaPipe] Initializing with delegate=${delegate}`);
  }

  // Step 3: Create the HandLandmarker.
  handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
    baseOptions: {
      modelAssetPath: modelUrl,
      delegate,
    },
    runningMode: 'VIDEO',
    numHands: CONFIG.NUM_HANDS,
    minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
    minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
  });

  if (import.meta.env.DEV) {
    console.log(`[MediaPipe] HandLandmarker ready (delegate=${delegate})`);
  }

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 100 } });
  state = 'READY';
  postMessageSafe({ type: 'READY' });
}

// ─── Frame Processing ─────────────────────────────────────────────────────────

/**
 * Process the current active frame using the HandLandmarker.
 *
 * INPUT FORMAT — ImageBitmap, not ImageData:
 *
 * The worker receives raw RGBA pixels as an ArrayBuffer (transferred, zero-copy).
 * We reconstruct an ImageData from it, then call createImageBitmap(imageData).
 *
 * WHY ImageBitmap instead of passing ImageData directly to detectForVideo?
 *
 *  • GPU delegate path: MediaPipe uploads the input to a WebGL texture.
 *    ImageData requires a CPU→GPU memcpy *and* a pixel-format conversion on
 *    every frame. ImageBitmap is already decoded into a GPU-friendly internal
 *    format; the upload is zero-copy on Chrome's GPU process.
 *
 *  • Stability: Passing ImageData to a GPU-delegated model triggers a
 *    known Chromium bug (crbug.com/1307626) where repeated large CPU→GPU
 *    copies exhaust the GPU command buffer, eventually causing
 *    "WebGL: CONTEXT_LOST_WEBGL". ImageBitmap bypasses this path entirely.
 *
 *  • CPU delegate path: ImageBitmap works identically to ImageData here;
 *    there is no regression.
 *
 * createImageBitmap(ImageData) is available in all Workers on Chrome 52+,
 * Firefox 42+, and Safari 15+.
 */
async function processActiveFrame(): Promise<void> {
  if (!activeFrame || !handLandmarker || (state !== 'READY' && state !== 'DEGRADED')) return;

  const frame = activeFrame;
  activeFrame = null;
  state = 'PROCESS';
  const startTime = performance.now();

  let bitmap: ImageBitmap | null = null;

  try {
    // Reconstruct ImageData from the transferred ArrayBuffer.
    const imageData = new ImageData(
      new Uint8ClampedArray(frame.buffer),
      frame.width,
      frame.height,
    );

    // Decode into a GPU-uploadable ImageBitmap. This call is non-blocking
    // and is resolved by the browser's image decode pipeline, not the JS heap.
    bitmap = await createImageBitmap(imageData);

    // Run inference. The timestamp must be monotonically increasing and in ms.
    const result = handLandmarker.detectForVideo(bitmap, frame.timestamp);

    const hands: TrackingResult[] = result.landmarks.map((landmarks, index) => {
      const category = result.handedness?.[index]?.[0];
      return {
        handedness: category?.displayName ?? category?.categoryName ?? 'Unknown',
        landmarks: extractRingLandmarks(landmarks),
        worldLandmarks: result.worldLandmarks?.[index]
          ? extractRingLandmarks(result.worldLandmarks[index] as NormalizedLandmark[])
          : null,
        confidence: category?.score ?? 0,
        timestamp: frame.timestamp,
      };
    });

    const inferenceTime = performance.now() - startTime;
    metrics.lastInferenceTime = inferenceTime;
    metrics.processedFrames += 1;
    metrics.avgInferenceMs =
      (metrics.avgInferenceMs * (metrics.processedFrames - 1) + inferenceTime) /
      metrics.processedFrames;
    lastProcessedTimestamp = frame.timestamp;

    consecutiveFailures = 0;
    state = degradedMode ? 'DEGRADED' : 'READY';

    postMessageSafe({
      type: 'RESULT',
      payload: {
        hands,
        detected: hands.length > 0,
        frameTimestamp: frame.timestamp,
        metrics: getMetrics(),
      },
    });
  } catch (error) {
    metrics.droppedFrames += 1;
    consecutiveFailures += 1;

    // After 5 consecutive failures (e.g. WebGL context lost), enter DEGRADED.
    // The next init cycle in useHandTracking will destroy and recreate the worker.
    if (consecutiveFailures >= 5) {
      degradedMode = true;
      state = 'DEGRADED';
      postMessageSafe({ type: 'DEGRADED', payload: { metrics: getMetrics() } });
    } else {
      state = 'READY';
    }

    reportError(error instanceof Error ? error.message : 'Detection failed');
    postMessageSafe({
      type: 'RESULT',
      payload: {
        hands: [],
        detected: false,
        frameTimestamp: frame.timestamp,
        metrics: getMetrics(),
      },
    });
  } finally {
    // Always close the ImageBitmap to release GPU memory immediately.
    // Failing to do this leaks texture memory and causes "WebGL Device Lost"
    // after a few hundred frames on devices with constrained GPU budgets.
    bitmap?.close();
  }

  drainLatestFrame();
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

function destroyWorker(): void {
  state = 'DESTROY';
  paused = true;
  activeFrame = null;
  frameRingBuffer.clear();

  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  // Release the GPU canvas; the WebGL2 context is freed with it.
  gpuCanvas = null;

  self.postMessage(protocolMessage({ type: 'DESTROYED' }));
}

// ─── Message Handler ──────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!validateMediaPipeInbound(event.data)) {
    reportError('Rejected invalid or incompatible worker protocol message');
    return;
  }

  const message = event.data;
  if (state === 'DESTROY') return;

  switch (message.type) {
    case 'INIT':
      initializeMediaPipe(message.payload.wasmBlobUrl, message.payload.modelUrl).catch(
        (error: unknown) => {
          reportError(
            `MediaPipe initialization failed: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          );
        },
      );
      break;

    case 'DETECT':
      queueFrame(message.payload);
      break;

    case 'PAUSE':
      paused = true;
      frameRingBuffer.clear();
      postMessageSafe({ type: 'PAUSED' });
      break;

    case 'RESUME':
      paused = false;
      drainLatestFrame();
      break;

    case 'DESTROY':
      destroyWorker();
      break;
  }
};

export {};
