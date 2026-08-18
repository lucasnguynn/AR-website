/**
 * mediapipe.worker.ts
 *
 * Low-latency MediaPipe HandLandmarker worker for ring-finger WebAR tracking.
 * The worker keeps a strict lifecycle, accepts only the newest frame under
 * backpressure, and emits a normalized protocol containing only the landmarks
 * required for ring placement.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

// ──────────────────────────────────────────────────────────────────────────────
// Protocol types
// ──────────────────────────────────────────────────────────────────────────────

type WorkerState = 'INIT' | 'READY' | 'PROCESS' | 'DESTROY';

type WorkerInMessage =
  | { type: 'INIT' }
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
  index: RingLandmarkIndex;
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
  | { type: 'RESULT'; payload: { hands: TrackingResult[]; detected: boolean; frameTimestamp: number } }
  | { type: 'ERROR'; payload: { message: string; state: WorkerState } }
  | { type: 'PAUSED' }
  | { type: 'DESTROYED' };

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const MEDIAPIPE_VERSION = '0.10.14';
const MEDIAPIPE_WASM_CDN_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const HAND_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const CONFIG = {
  NUM_HANDS: 1,
  MIN_DETECTION_CONFIDENCE: 0.75,
  MIN_PRESENCE_CONFIDENCE: 0.75,
  MIN_TRACKING_CONFIDENCE: 0.8,
} as const;

const RING_LANDMARK_INDICES = [0, 5, 13, 14, 15, 16, 17] as const;
type RingLandmarkIndex = (typeof RING_LANDMARK_INDICES)[number];

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

let state: WorkerState = 'INIT';
let handLandmarker: HandLandmarker | null = null;
let paused = false;
let activeFrame: FramePayload | null = null;
let pendingFrame: FramePayload | null = null;
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

function normalizeLandmark(index: RingLandmarkIndex, landmark: NormalizedLandmark): RingLandmark {
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

  return RING_LANDMARK_INDICES.flatMap((index) => {
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

async function applyWasmLoaderWorkaround(wasmFileset: { wasmLoaderPath: string }): Promise<void> {
  // Preserve the Vite/GitHub Pages workaround: fetch and evaluate the classic
  // MediaPipe WASM loader manually so createFromOptions can find ModuleFactory
  // without relying on ES module worker import semantics.
  const response = await fetch(wasmFileset.wasmLoaderPath, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch MediaPipe WASM loader (${response.status})`);
  }

  const loaderSource = await response.text();
  (0, eval)(loaderSource);
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

  if (state === 'PROCESS') {
    if (!pendingFrame || frame.timestamp > pendingFrame.timestamp) {
      if (pendingFrame) metrics.droppedFrames += 1;
      pendingFrame = frame;
    } else {
      metrics.droppedFrames += 1;
    }
    return;
  }

  pendingFrame = frame;
  drainLatestFrame();
}

function drainLatestFrame(): void {
  if (state !== 'READY' || paused || !pendingFrame || !handLandmarker) return;

  activeFrame = pendingFrame;
  pendingFrame = null;
  processActiveFrame();
}

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────────

async function initializeMediaPipe(): Promise<void> {
  if (state === 'DESTROY' || handLandmarker) return;

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 0 } });

  const wasmFileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_CDN_URL, false);
  await applyWasmLoaderWorkaround(wasmFileset);

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 100 } });
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 0 } });

  handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
    baseOptions: {
      modelAssetPath: HAND_LANDMARKER_MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: CONFIG.NUM_HANDS,
    minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
    minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
  });

  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 100 } });
  state = 'READY';
  postMessageSafe({ type: 'READY' });
}

function processActiveFrame(): void {
  if (!activeFrame || !handLandmarker || state !== 'READY') return;

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

    state = 'READY';
    postMessageSafe({
      type: 'RESULT',
      payload: { hands, detected: hands.length > 0, frameTimestamp: frame.timestamp },
    });
  } catch (error) {
    metrics.droppedFrames += 1;
    state = 'READY';
    reportError(error instanceof Error ? error.message : 'Detection failed');
    postMessageSafe({
      type: 'RESULT',
      payload: { hands: [], detected: false, frameTimestamp: frame.timestamp },
    });
  }

  drainLatestFrame();
}

function destroyWorker(): void {
  state = 'DESTROY';
  paused = true;
  activeFrame = null;
  pendingFrame = null;
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
      initializeMediaPipe().catch((error: unknown) => {
        reportError(`MediaPipe initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
      break;

    case 'DETECT':
      queueFrame(message.payload);
      break;

    case 'PAUSE':
      paused = true;
      pendingFrame = null;
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
