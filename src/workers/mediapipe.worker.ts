/**
 * mediapipe.worker.ts
 *
 * Web Worker for MediaPipe Hand Landmark detection.
 * 
 * Runs as a classic worker so MediaPipe can use importScripts() internally
 * while resolving its WASM assets from the CDN.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark as MPLandmark,
} from '@mediapipe/tasks-vision';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface WorkerInMessage {
  type: 'INIT' | 'DETECT' | 'DESTROY' | 'PAUSE' | 'RESUME';
  payload?: {
    buffer: ArrayBuffer;
    width: number;
    height: number;
    timestamp: number;
  };
}

interface TrackingResult {
  handedness: string;
  landmarks: Array<{ x: number; y: number; z: number; visibility?: number }>;
  worldLandmarks: Array<{ x: number; y: number; z: number; visibility?: number }> | null;
  confidence: number;
  timestamp: number;
}

interface WorkerOutMessage {
  type: 'READY' | 'PROGRESS' | 'RESULT' | 'ERROR' | 'DESTROYED' | 'PAUSED';
  payload?:
    | { phase: 'wasm' | 'model'; progress: number }
    | { hands: TrackingResult[]; detected: boolean; frameTimestamp: number }
    | { message: string }
    | { frameTimestamp: number };
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const MEDIAPIPE_WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const HAND_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Production-tuned confidence thresholds for ring finger tracking
const CONFIG = {
  NUM_HANDS: 1,                    // Single hand for performance
  MIN_DETECTION_CONFIDENCE: 0.8,   // High confidence for reliable detection
  MIN_PRESENCE_CONFIDENCE: 0.8,    // High confidence for hand presence
  MIN_TRACKING_CONFIDENCE: 0.85,   // Very high confidence for stable tracking
} as const;

// Ring finger landmark indices (MediaPipe convention)
const RING_FINGER_LANDMARKS = [
  0,  // Wrist
  5,  // Index MCP (for orientation reference)
  13, // Ring MCP
  14, // Ring PIP
  15, // Ring DIP
  16, // Ring TIP
  17, // Pinky MCP (for hand width reference)
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

let handLandmarker: HandLandmarker | null = null;
let isInitialized = false;
let isDestroyed = false;
let isPaused = false;

// Backpressure state: track pending frame and processing state
let isProcessing = false;
let pendingFrame: {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
} | null = null;
let lastProcessedTimestamp: number = -1;

// Performance metrics
const metrics = {
  frameCount: 0,
  droppedFrames: 0,
  processedFrames: 0,
  lastInferenceTime: 0,
  avgInferenceMs: 0,
};

// ──────────────────────────────────────────────────────────────────────────────
// Helper: Post message with error handling
// ──────────────────────────────────────────────────────────────────────────────

function postMessageSafe(msg: WorkerOutMessage): void {
  if (!isDestroyed) {
    self.postMessage(msg);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: Process pending frame (backpressure management)
// ──────────────────────────────────────────────────────────────────────────────

function processPendingFrame(): void {
  if (pendingFrame && !isProcessing && !isPaused && handLandmarker) {
    const frame = pendingFrame;
    pendingFrame = null;
    isProcessing = true;
    
    // Drop stale frames: only process if newer than last processed
    if (frame.timestamp <= lastProcessedTimestamp) {
      metrics.droppedFrames++;
      isProcessing = false;
      // Check for next pending frame
      setTimeout(processPendingFrame, 0);
      return;
    }
    
    processFrame(
      frame.buffer,
      frame.width,
      frame.height,
      frame.timestamp
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Initialize MediaPipe HandLandmarker with ModuleFactory patch for ES Modules
// ──────────────────────────────────────────────────────────────────────────────

async function initializeMediaPipe(): Promise<void> {
  try {
    postMessageSafe({
      type: 'PROGRESS',
      payload: { phase: 'wasm', progress: 0 },
    });

    // Step 1: Resolve the vision tasks file set structure from CDN.
    // This worker is instantiated as a classic worker so MediaPipe can call
    // importScripts() internally while loading the WASM wrapper.
    const wasmFileset = await FilesetResolver.forVisionTasks(
      MEDIAPIPE_WASM_CDN_URL
    );

    postMessageSafe({
      type: 'PROGRESS',
      payload: { phase: 'wasm', progress: 100 },
    });

    // Step 2: Load the hand landmarker model
    postMessageSafe({
      type: 'PROGRESS',
      payload: { phase: 'model', progress: 0 },
    });

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

    postMessageSafe({
      type: 'PROGRESS',
      payload: { phase: 'model', progress: 100 },
    });

    isInitialized = true;
    postMessageSafe({ type: 'READY' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown initialization error';
    console.error('[MediaPipe Worker] Initialization failed:', errorMessage);
    
    postMessageSafe({
      type: 'ERROR',
      payload: { message: `MediaPipe initialization failed: ${errorMessage}` },
    });
    
    throw error;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Process video frame for hand detection
// ──────────────────────────────────────────────────────────────────────────────

function processFrame(
  buffer: ArrayBuffer,
  width: number,
  height: number,
  timestamp: number
): void {
  const startTime = performance.now();
  
  if (!isInitialized || !handLandmarker) {
    return;
  }

  try {
    // Use OffscreenCanvas for efficient frame processing
    const imageData = new ImageData(
      new Uint8ClampedArray(buffer),
      width,
      height
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
    ctx.putImageData(imageData, 0, 0);

    const result = handLandmarker.detectForVideo(canvas, timestamp);

    // Normalize tracking output into consistent structure
    const hands: TrackingResult[] = result.landmarks.map((landmarks, index) => {
      // Extract confidence from detection scores (MediaPipe provides handedness scores)
      const handednessScore = result.handedness?.[index]?.[0]?.score ?? 0;
      const detectionConfidence = handednessScore;

      return {
        handedness: result.handedness?.[index]?.[0]?.displayName ?? 'Unknown',
        landmarks: landmarks.map((lm) => ({
          x: lm.x,
          y: lm.y,
          z: lm.z ?? 0,
          visibility: lm.visibility ?? 1,
        })),
        worldLandmarks: result.worldLandmarks?.[index]?.map((lm) => ({
          x: lm.x,
          y: lm.y,
          z: lm.z ?? 0,
          visibility: lm.visibility ?? 1,
        })) ?? null,
        confidence: detectionConfidence,
        timestamp: timestamp,
      };
    });

    const inferenceTime = performance.now() - startTime;
    metrics.lastInferenceTime = inferenceTime;
    metrics.processedFrames++;
    metrics.avgInferenceMs = 
      (metrics.avgInferenceMs * (metrics.processedFrames - 1) + inferenceTime) / 
      metrics.processedFrames;
    lastProcessedTimestamp = timestamp;
    isProcessing = false;

    postMessageSafe({
      type: 'RESULT',
      payload: {
        hands,
        detected: hands.length > 0,
        frameTimestamp: timestamp,
      },
    });

    // Process any pending frame that arrived during inference
    setTimeout(processPendingFrame, 0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Detection failed';
    console.error('[MediaPipe Worker] Detection error:', errorMessage);
    
    metrics.droppedFrames++;
    isProcessing = false;

    postMessageSafe({
      type: 'RESULT',
      payload: { hands: [], detected: false, frameTimestamp: timestamp },
    });
    
    // Process any pending frame
    setTimeout(processPendingFrame, 0);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Message handler
// ──────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'INIT':
      await initializeMediaPipe();
      break;

    case 'DETECT':
      if (msg.payload) {
        metrics.frameCount++;
        
        // Backpressure: store newest frame, drop obsolete
        if (isProcessing) {
          // If currently processing, update pending frame with newer data
          if (!pendingFrame || msg.payload.timestamp > pendingFrame.timestamp) {
            // Release old buffer if exists
            if (pendingFrame?.buffer) {
              // Buffer is transferred, no need to free
            }
            pendingFrame = {
              buffer: msg.payload.buffer,
              width: msg.payload.width,
              height: msg.payload.height,
              timestamp: msg.payload.timestamp,
            };
            metrics.droppedFrames++;
          } else {
            // Frame is stale, drop it
            metrics.droppedFrames++;
          }
        } else {
          // Not processing, start immediately
          pendingFrame = {
            buffer: msg.payload.buffer,
            width: msg.payload.width,
            height: msg.payload.height,
            timestamp: msg.payload.timestamp,
          };
          processPendingFrame();
        }
      }
      break;

    case 'PAUSE':
      isPaused = true;
      postMessageSafe({ type: 'PAUSED' });
      break;

    case 'RESUME':
      isPaused = false;
      processPendingFrame();
      break;

    case 'DESTROY':
      isDestroyed = true;
      if (handLandmarker) {
        try {
          handLandmarker.close();
        } catch (e) {
          console.warn('[MediaPipe Worker] Close error:', e);
        }
        handLandmarker = null;
      }
      isInitialized = false;
      isProcessing = false;
      pendingFrame = null;
      postMessageSafe({ type: 'DESTROYED' });
      break;
  }
};

export {};
