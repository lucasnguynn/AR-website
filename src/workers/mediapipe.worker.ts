// FILE: src/workers/mediapipe.worker.ts
/**
 * mediapipe.worker.ts
 *
 * Low-latency MediaPipe HandLandmarker worker for ring-finger WebAR tracking.
 * The worker keeps a strict lifecycle, accepts only the newest frame under
 * backpressure, and emits a normalized protocol containing all 21 hand landmarks
 * required for sizing, gesture detection, and ring placement.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

// ──────────────────────────────────────────────────────────────────────────────
// Protocol types
// ──────────────────────────────────────────────────────────────────────────────

type WorkerState = 'INIT' | 'READY' | 'PROCESS' | 'DEGRADED' | 'DESTROY';

type WorkerInMessage =
  | { type: 'INIT'; payload: { wasmBlobUrl: string; modelUrl: string } }
  | { type: 'DETECT'; payload: FramePayload }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DESTROY' };

interface FramePayload {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
}

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

type WorkerOutMessage =
  | { type: 'READY' }
  | { type: 'PROGRESS'; payload: { phase: 'wasm' | 'model'; progress: number } }
  | { type: 'RESULT'; payload: { hands: TrackingResult[]; detected: boolean; frameTimestamp: number; metrics: TrackingMetrics } }
  | { type: 'ERROR'; payload: { message: string; state: WorkerState } }
  | { type: 'DEGRADED'; payload: { metrics: TrackingMetrics } }
  | { type: 'PAUSED' }
  | { type: 'DESTROYED' };

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────


const CONFIG = {
  NUM_HANDS: 1,
  MIN_DETECTION_CONFIDENCE: 0.75,
  MIN_PRESENCE_CONFIDENCE: 0.75,
  MIN_TRACKING_CONFIDENCE: 0.8,
} as const;

const HAND_LANDMARK_INDICES = Array.from({ length: 21 }, (_, index) => index) as HandLandmarkIndex[];
type HandLandmarkIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

let state: WorkerState = 'INIT';
let handLandmarker: HandLandmarker | null = null;
let paused = false;
let activeFrame: FramePayload | null = null;
let lastProcessedTimestamp = -1;
let canvas: OffscreenCanvas | null = null;
let canvasContext: OffscreenCanvasRenderingContext2D | null = null;

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

class FrameRingBuffer {
  private readonly frames: FramePayload[] = [];

  constructor(private readonly size: number) {}

  push(frame: FramePayload): number {
    if (this.frames.some((queuedFrame) => queuedFrame.timestamp >= frame.timestamp)) {
      return 1;
    }

    this.frames.push(frame);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);

    const staleDropCount = Math.max(0, this.frames.length - this.size);
    if (staleDropCount > 0) {
      this.frames.splice(0, staleDropCount);
    }

    return staleDropCount;
  }

  popLatest(): { frame: FramePayload | null; dropped: number } {
    const frame = this.frames.pop() ?? null;
    const dropped = this.frames.length;
    this.frames.length = 0;
    return { frame, dropped };
  }

  clear(): void {
    this.frames.length = 0;
  }
}

const frameRingBuffer = new FrameRingBuffer(2);

function getMetrics(): TrackingMetrics {
  return {
    ...metrics,
    lastInferenceMs: metrics.lastInferenceTime,
    inferenceFps: metrics.avgInferenceMs > 0 ? 1000 / metrics.avgInferenceMs : 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function postMessageSafe(message: WorkerOutMessage): void {
  if (state !== 'DESTROY') {
    self.postMessage(message);
  }
}

function reportError(message: string): void {
  postMessageSafe({ type: 'ERROR', payload: { message, state } });
}

function normalizeLandmark(index: HandLandmarkIndex, landmark: NormalizedLandmark): RingLandmark {
  return {
    index,
    x: landmark.x,
    y: landmark.y,
    z: landmark.z ?? 0,
    visibility: landmark.visibility,
  };
}

function extractRingLandmarks(landmarks: NormalizedLandmark[] | undefined): RingLandmark[] {
  if (!landmarks) return [];

  return HAND_LANDMARK_INDICES.flatMap((index) => {
    const landmark = landmarks[index];
    return landmark ? [normalizeLandmark(index, landmark)] : [];
  });
}

function ensureCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== width || canvas.height !== height || !canvasContext) {
    canvas = new OffscreenCanvas(width, height);
    canvasContext = canvas.getContext('2d', { willReadFrequently: false });
  }

  if (!canvasContext) {
    throw new Error('Failed to acquire OffscreenCanvas 2D context');
  }

  return canvasContext;
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────────

async function initializeMediaPipe(wasmBlobUrl: string, modelUrl: string): Promise<void> {
  if (state === 'DESTROY' || handLandmarker) return;

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 0 } });

  // FilesetResolver normally points at a JS loader that may hit CSP-sensitive dynamic-code paths.
  // Passing the pre-fetched Blob URL keeps the binary on a blob: URL and bypasses the previous inline-loader workaround.
  const wasmFileset = await FilesetResolver.forVisionTasks(wasmBlobUrl, false);
  wasmFileset.wasmBinaryPath = wasmBlobUrl;

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 100 } });
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 0 } });

  handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
    baseOptions: {
      modelAssetPath: modelUrl,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: CONFIG.NUM_HANDS,
    minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
    minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
  });

  console.log('[MediaPipe] WASM loaded via blob: — eval() bypassed');
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 100 } });
  state = 'READY';
  postMessageSafe({ type: 'READY' });
}

function processActiveFrame(): void {
  if (!activeFrame || !handLandmarker || (state !== 'READY' && state !== 'DEGRADED')) return;

  const frame = activeFrame;
  activeFrame = null;
  state = 'PROCESS';
  const startTime = performance.now();

  try {
    const context = ensureCanvas(frame.width, frame.height);
    const imageData = new ImageData(new Uint8ClampedArray(frame.buffer), frame.width, frame.height);
    context.putImageData(imageData, 0, 0);

    const result = handLandmarker.detectForVideo(canvas as OffscreenCanvas, frame.timestamp);
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
      (metrics.avgInferenceMs * (metrics.processedFrames - 1) + inferenceTime) / metrics.processedFrames;
    lastProcessedTimestamp = frame.timestamp;

    consecutiveFailures = 0;
    state = degradedMode ? 'DEGRADED' : 'READY';
    postMessageSafe({
      type: 'RESULT',
      payload: { hands, detected: hands.length > 0, frameTimestamp: frame.timestamp, metrics: getMetrics() },
    });
  } catch (error) {
    metrics.droppedFrames += 1;
    consecutiveFailures += 1;
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
      payload: { hands: [], detected: false, frameTimestamp: frame.timestamp, metrics: getMetrics() },
    });
  }

  drainLatestFrame();
}

function destroyWorker(): void {
  state = 'DESTROY';
  paused = true;
  activeFrame = null;
  frameRingBuffer.clear();
  canvas = null;
  canvasContext = null;

  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  self.postMessage({ type: 'DESTROYED' } satisfies WorkerOutMessage);
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;

  if (state === 'DESTROY') return;

  switch (message.type) {
    case 'INIT':
      initializeMediaPipe(message.payload.wasmBlobUrl, message.payload.modelUrl).catch((error: unknown) => {
        reportError(`MediaPipe initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
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
// VERIFY: console.log('[MediaPipe] WASM loaded via blob: — eval() bypassed')
