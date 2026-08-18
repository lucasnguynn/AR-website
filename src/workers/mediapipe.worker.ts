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
} from '@mediapipe/tasks-vision';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface WorkerInMessage {
  type: 'INIT' | 'DETECT' | 'DESTROY';
  payload?: {
    buffer: ArrayBuffer;
    width: number;
    height: number;
    timestamp: number;
  };
}

interface WorkerOutMessage {
  type: 'READY' | 'PROGRESS' | 'RESULT' | 'ERROR' | 'DESTROYED';
  payload?:
    | { phase: 'wasm' | 'model'; progress: number }
    | { hands: Array<{ landmarks: unknown[]; handedness: string; score: number }>; detected: boolean }
    | { message: string };
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const MEDIAPIPE_WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const HAND_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

let handLandmarker: HandLandmarker | null = null;
let isInitialized = false;
let isDestroyed = false;

// ──────────────────────────────────────────────────────────────────────────────
// Helper: Post message with error handling
// ──────────────────────────────────────────────────────────────────────────────

function postMessageSafe(msg: WorkerOutMessage): void {
  if (!isDestroyed) {
    self.postMessage(msg);
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
      numHands: 2,
      minHandDetectionConfidence: 0.7,
      minHandPresenceConfidence: 0.7,
      minTrackingConfidence: 0.7,
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
  if (!isInitialized || !handLandmarker) {
    return;
  }

  try {
    const imageData = new ImageData(
      new Uint8ClampedArray(buffer),
      width,
      height
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
    ctx.putImageData(imageData, 0, 0);

    const result = handLandmarker.detectForVideo(canvas, timestamp);

    const hands = result.landmarks.map((landmarks, index) => ({
      landmarks: landmarks.map((lm) => ({
        x: lm.x,
        y: lm.y,
        z: lm.z ?? 0,
        visibility: lm.visibility ?? 1,
      })),
      handedness: result.handedness?.[index]?.[0]?.displayName ?? 'Unknown',
      score: 1.0,
    }));

    postMessageSafe({
      type: 'RESULT',
      payload: {
        hands,
        detected: hands.length > 0,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Detection failed';
    console.error('[MediaPipe Worker] Detection error:', errorMessage);
    
    postMessageSafe({
      type: 'RESULT',
      payload: { hands: [], detected: false },
    });
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
        processFrame(
          msg.payload.buffer,
          msg.payload.width,
          msg.payload.height,
          msg.payload.timestamp
        );
      }
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
      postMessageSafe({ type: 'DESTROYED' });
      break;
  }
};

export {};
