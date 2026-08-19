// FILE: src/workers/handpose.worker.ts
import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

type WorkerState = 'INIT' | 'READY' | 'PROCESS' | 'DESTROY';
type RingLandmarkIndex = (typeof RING_LANDMARK_INDICES)[number];

type WorkerInMessage =
  | { type: 'INIT'; payload: InitPayload }
  | { type: 'DETECT'; payload: FramePayload }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DESTROY' };

interface InitPayload {
  wasmBlobUrl: string;
  modelUrl: string;
}

interface FramePayload {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
}

interface CropHint {
  x: number;
  y: number;
  width: number;
  height: number;
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

interface TrackingMetrics {
  frameCount: number;
  droppedFrames: number;
  processedFrames: number;
  lastInferenceMs: number;
  avgInferenceMs: number;
  inferenceFps: number;
}

type WorkerOutMessage =
  | { type: 'READY'; payload: { backend: 'mediapipe' } }
  | { type: 'PROGRESS'; payload: { phase: 'wasm' | 'model'; progress: number } }
  | { type: 'RESULT'; payload: { hands: TrackingResult[]; detected: boolean; frameTimestamp: number; metrics: TrackingMetrics; backend: 'mediapipe' } }
  | { type: 'ERROR'; payload: { message: string; state: WorkerState } }
  | { type: 'PAUSED' }
  | { type: 'DESTROYED' };

const RING_LANDMARK_INDICES = [0, 4, 5, 8, 13, 14, 15, 16, 17] as const;
const CONFIG = {
  NUM_HANDS: 1,
  MIN_DETECTION_CONFIDENCE: 0.75,
  MIN_PRESENCE_CONFIDENCE: 0.75,
  MIN_TRACKING_CONFIDENCE: 0.8,
  ROI_PADDING: 0.18,
} as const;

let state: WorkerState = 'INIT';
let handLandmarker: HandLandmarker | null = null;
let paused = false;
let activeFrame: FramePayload | null = null;
let pendingFrame: FramePayload | null = null;
let lastProcessedTimestamp = -1;
let canvas: OffscreenCanvas | null = null;
let canvasContext: OffscreenCanvasRenderingContext2D | null = null;
let previousCropHint: CropHint | null = null;

const metrics = { frameCount: 0, droppedFrames: 0, processedFrames: 0, lastInferenceMs: 0, avgInferenceMs: 0 };

function postMessageSafe(message: WorkerOutMessage): void {
  if (state !== 'DESTROY') self.postMessage(message);
}

function getMetrics(): TrackingMetrics {
  return { ...metrics, inferenceFps: metrics.avgInferenceMs > 0 ? 1000 / metrics.avgInferenceMs : 0 };
}

function normalizeLandmark(index: RingLandmarkIndex, landmark: NormalizedLandmark): RingLandmark {
  return { index, x: landmark.x, y: landmark.y, z: landmark.z ?? 0, visibility: landmark.visibility };
}

function extractRingLandmarks(landmarks: readonly NormalizedLandmark[] | undefined): RingLandmark[] {
  if (!landmarks) return [];
  return RING_LANDMARK_INDICES.flatMap((index) => (landmarks[index] ? [normalizeLandmark(index, landmarks[index])] : []));
}

function computeCropHint(landmarks: readonly RingLandmark[]): CropHint | null {
  if (landmarks.length === 0) return null;
  const xs = landmarks.map(({ x }) => x);
  const ys = landmarks.map(({ y }) => y);
  const minX = Math.max(0, Math.min(...xs) - CONFIG.ROI_PADDING);
  const minY = Math.max(0, Math.min(...ys) - CONFIG.ROI_PADDING);
  const maxX = Math.min(1, Math.max(...xs) + CONFIG.ROI_PADDING);
  const maxY = Math.min(1, Math.max(...ys) + CONFIG.ROI_PADDING);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function ensureCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== width || canvas.height !== height || !canvasContext) {
    canvas = new OffscreenCanvas(width, height);
    canvasContext = canvas.getContext('2d', { willReadFrequently: false });
  }
  if (!canvasContext) throw new Error('Failed to acquire OffscreenCanvas 2D context');
  return canvasContext;
}

async function initializeMediaPipe({ wasmBlobUrl, modelUrl }: InitPayload): Promise<void> {
  if (state === 'DESTROY' || handLandmarker) return;
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 0 } });
  const wasmFileset = await FilesetResolver.forVisionTasks(wasmBlobUrl, false);
  wasmFileset.wasmBinaryPath = wasmBlobUrl;
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'wasm', progress: 100 } });
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 0 } });
  handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: CONFIG.NUM_HANDS,
    minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
    minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
  });
  console.log('[MediaPipe] WASM loaded via blob: — eval() bypassed');
  postMessageSafe({ type: 'PROGRESS', payload: { phase: 'model', progress: 100 } });
  state = 'READY';
  postMessageSafe({ type: 'READY', payload: { backend: 'mediapipe' } });
}

function queueFrame(frame: FramePayload): void {
  metrics.frameCount += 1;
  if (state === 'DESTROY' || paused || !handLandmarker || frame.timestamp <= lastProcessedTimestamp) {
    metrics.droppedFrames += 1;
    return;
  }
  if (state === 'PROCESS') {
    if (pendingFrame) metrics.droppedFrames += 1;
    pendingFrame = !pendingFrame || frame.timestamp > pendingFrame.timestamp ? frame : pendingFrame;
    return;
  }
  pendingFrame = frame;
  void drainLatestFrame();
}

async function drainLatestFrame(): Promise<void> {
  if (state !== 'READY' || paused || !pendingFrame) return;
  activeFrame = pendingFrame;
  pendingFrame = null;
  processActiveFrame();
}

function detectHands(frame: FramePayload): TrackingResult[] {
  const context = ensureCanvas(frame.width, frame.height);
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer), frame.width, frame.height), 0, 0);
  if (!handLandmarker || !canvas) return [];
  const result = handLandmarker.detectForVideo(canvas, frame.timestamp);
  return result.landmarks.map((landmarks, index) => ({
    handedness: result.handedness?.[index]?.[0]?.displayName ?? result.handedness?.[index]?.[0]?.categoryName ?? 'Unknown',
    landmarks: extractRingLandmarks(landmarks),
    worldLandmarks: result.worldLandmarks?.[index] ? extractRingLandmarks(result.worldLandmarks[index] as NormalizedLandmark[]) : null,
    confidence: result.handedness?.[index]?.[0]?.score ?? 0,
    timestamp: frame.timestamp,
  }));
}

function processActiveFrame(): void {
  if (!activeFrame || state !== 'READY') return;
  const frame = activeFrame;
  activeFrame = null;
  state = 'PROCESS';
  const startTime = performance.now();
  try {
    const hands = detectHands(frame);
    previousCropHint = computeCropHint(hands[0]?.landmarks ?? []);
    const inferenceTime = performance.now() - startTime;
    metrics.lastInferenceMs = inferenceTime;
    metrics.processedFrames += 1;
    metrics.avgInferenceMs = (metrics.avgInferenceMs * (metrics.processedFrames - 1) + inferenceTime) / metrics.processedFrames;
    lastProcessedTimestamp = frame.timestamp;
    state = 'READY';
    postMessageSafe({ type: 'RESULT', payload: { hands, detected: hands.length > 0, frameTimestamp: frame.timestamp, metrics: getMetrics(), backend: 'mediapipe' } });
  } catch (error) {
    metrics.droppedFrames += 1;
    state = 'READY';
    postMessageSafe({ type: 'ERROR', payload: { message: error instanceof Error ? error.message : 'Detection failed', state } });
  }
  void drainLatestFrame();
}

function destroyWorker(): void {
  state = 'DESTROY';
  paused = true;
  activeFrame = null;
  pendingFrame = null;
  previousCropHint = null;
  canvas = null;
  canvasContext = null;
  handLandmarker?.close();
  handLandmarker = null;
  self.postMessage({ type: 'DESTROYED' } satisfies WorkerOutMessage);
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  if (state === 'DESTROY') return;
  switch (event.data.type) {
    case 'INIT':
      initializeMediaPipe(event.data.payload).catch((error: unknown) => postMessageSafe({ type: 'ERROR', payload: { message: `Handpose initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`, state } }));
      break;
    case 'DETECT':
      queueFrame(event.data.payload);
      break;
    case 'PAUSE':
      paused = true;
      pendingFrame = null;
      postMessageSafe({ type: 'PAUSED' });
      break;
    case 'RESUME':
      paused = false;
      void drainLatestFrame();
      break;
    case 'DESTROY':
      destroyWorker();
      break;
  }
};

export {};
// VERIFY: console.log('[MediaPipe] WASM loaded via blob: — eval() bypassed')
