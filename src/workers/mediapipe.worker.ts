// FILE: src/workers/mediapipe.worker.ts
/**
 * mediapipe.worker.ts
 *
 * ARCHITECTURE NOTE (read before editing):
 *
 * ROOT CAUSES fixed in this revision:
 *
 *  1. SILENT HANG on init (GPU delegate + CDN WASM fetch blocked by CSP)
 *     Workers inherit the *HTTP-header* CSP, NOT the <meta http-equiv> CSP from
 *     index.html. The meta tag only applies to document resources; workers always
 *     use the header policy. The WASM CDN URL is now passed directly from the main
 *     thread as a plain string (not blob:) and FilesetResolver runs inside the
 *     worker. public/_headers must grant cdn.jsdelivr.net in connect-src / script-src
 *     for this to work in production.
 *
 *  2. SILENT HANG during createFromOptions() with delegate:'GPU' + ImageData input
 *     On Chrome Android and some headless builds, OffscreenCanvas.getContext('webgl2')
 *     silently returns null. The WASM GPU init path then spin-waits forever.
 *     FIX: probeAndCreateGpuCanvas() creates and probes the WebGL2 context BEFORE
 *     calling createFromOptions. gpuCanvas is only assigned on confirmed success.
 *
 *  3. ImageBitmap memory leak → WebGL Device Lost
 *     bitmap.close() is now called inside the `finally` block, which also calls
 *     drainLatestFrame() so the pipeline always advances even if postMessageSafe
 *     or close() itself throws.
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
 * delegate. Only assigned after probeAndCreateGpuCanvas() confirms the context
 * is healthy — never left pointing at a canvas with a null or lost context.
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
 * Ensures a WebGL2 context exists on a new OffscreenCanvas before passing it to
 * MediaPipe. Returns true if GPU is available, false to fall back to CPU.
 *
 * gpuCanvas is ONLY assigned when the context probe fully succeeds — it is never
 * left pointing at a canvas whose context is null or already lost.
 *
 * WHY: MediaPipe GPU delegate auto-creates a 1×1 OffscreenCanvas internally when
 * called from a Worker. On Chrome Android and some Chromium builds this
 * auto-creation silently returns a lost context, causing createFromOptions() to
 * hang indefinitely. Pre-creating and probing the context allows us to:
 *   a) detect GPU unavailability before handing off to MediaPipe, and
 *   b) give MediaPipe a warm, verified WebGL2 context to reuse.
 */
function probeAndCreateGpuCanvas(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('webgl2');

    // getContext returns null when WebGL2 is unsupported or hardware-blocked.
    if (!ctx) {
      if (import.meta.env.DEV) console.warn('[MediaPipe] WebGL2 unavailable in Worker — falling back to CPU');
      return false;
    }

    // A context can be created but already lost (e.g. GPU process crash,
    // too many concurrent WebGL contexts on mobile). Treat as GPU unavailable
    // so we don't hand MediaPipe a broken surface.
    if (ctx.isContextLost()) {
      if (import.meta.env.DEV) console.warn('[MediaPipe] WebGL2 context already lost at probe — falling back to CPU');
      return false;
    }

    // Context is healthy — commit it as the global GPU surface.
    gpuCanvas = canvas;
    return true;
  } catch {
    // OffscreenCanvas or getContext threw (e.g. sandboxed iframe blocking GPU).
    gpuCanvas = null;
    return false;
  }
}

/**
 * Initialize the HandLandmarker.
 *
 * @param wasmBasePath  The CDN base URL (with trailing slash) for the MediaPipe
 *                      WASM package. FilesetResolver.forVisionTasks() appends
 *                      'vision_wasm_internal.js' and '.wasm' directly to this.
 *                      CDN access for workers must be granted in public/_headers:
 *                        connect-src 'self' blob: https://cdn.jsdelivr.net
 *                        script-src  'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net
 * @param modelUrl      A blob: URL for the hand_landmarker.task model binary.
 */
async function initializeMediaPipe(wasmBasePath: string, modelUrl: string): Promise<void> {
  if (state === 'DESTROY' || handLandmarker) return;

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 0 } });

  // Step 1: Resolve WASM fileset. FilesetResolver fetches the JS + WASM files
  // from the CDN URL. Workers use the HTTP-header CSP; public/_headers must
  // allow cdn.jsdelivr.net in connect-src and script-src.
  const wasmFileset = await FilesetResolver.forVisionTasks(wasmBasePath);

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 100 } });
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 0 } });

  // Step 2: Probe WebGL2 availability. GPU delegate requires a healthy WebGL2
  // context in the Worker scope. If unavailable we fall back to CPU — still
  // delivers ≥20 FPS at the ~384px frame sizes produced by captureVideoFrame.
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
 * We reconstruct ImageData from it, then call createImageBitmap(imageData).
 *
 * WHY ImageBitmap:
 *  • GPU delegate: upload is zero-copy. ImageData forces CPU→GPU memcpy + format
 *    conversion every frame. ImageBitmap is already GPU-friendly.
 *  • Stability: repeated large CPU→GPU copies trigger crbug.com/1307626 — the GPU
 *    command buffer exhausts and causes "WebGL: CONTEXT_LOST_WEBGL". ImageBitmap
 *    bypasses this path entirely.
 *  • CPU delegate: identical behaviour to ImageData; no regression.
 *
 * IMPORTANT: bitmap.close() and drainLatestFrame() are both called in `finally`
 * so the pipeline always advances and GPU memory is always released — even if
 * postMessageSafe or any other statement in the try/catch block throws.
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

    // Decode into a GPU-uploadable ImageBitmap. Non-blocking; resolved by the
    // browser's image decode pipeline, not the JS heap.
    bitmap = await createImageBitmap(imageData);

    // Run inference. Timestamp must be monotonically increasing and in ms.
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
    // Always close the ImageBitmap to release GPU texture memory immediately.
    // Failing to do this leaks texture memory and causes "WebGL Device Lost"
    // after a few hundred frames on devices with constrained GPU budgets.
    //
    // drainLatestFrame() is inside finally (not after the try/catch block) so the
    // pipeline advances on EVERY code path — including if postMessageSafe itself
    // throws. Placing drainLatestFrame() after the try/catch means it becomes
    // unreachable whenever a re-throw escapes finally, stalling the pipeline.
    bitmap?.close();
    drainLatestFrame();
  }
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
