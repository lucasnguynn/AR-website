/**
 * mediapipe.worker.ts
 *
 * Web Worker for MediaPipe hand landmark detection.
 * Runs in a separate thread to prevent blocking the main UI during CV processing.
 * Zero-upload architecture: image data never leaves the browser process.
 */

/// <reference lib="webworker" />

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

let handLandmarker: HandLandmarker | null = null;
let minDetectionConfidence = 0.5;
let minTrackingConfidence = 0.5;

interface InitMessage {
  type: 'INIT';
  wasmPath: string;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
}

interface ProcessMessage {
  type: 'PROCESS';
  imageData: ImageData;
  timestamp: number;
}

interface StopMessage {
  type: 'STOP';
}

type IncomingMessage = InitMessage | ProcessMessage | StopMessage;

interface ReadyResponse {
  type: 'READY';
}

interface HandResultResponse {
  type: 'HAND_RESULT';
  result: {
    landmarks: Array<{ x: number; y: number; z: number; visibility?: number; confidence?: number }>;
    handedness: 'Left' | 'Right';
    confidence: number;
  } | null;
  timestamp: number;
}

interface ErrorResponse {
  type: 'ERROR';
  error: string;
}

type OutgoingMessage = ReadyResponse | HandResultResponse | ErrorResponse;

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const { type } = event.data;

  if (type === 'INIT') {
    try {
      const { wasmPath, minDetectionConfidence: detConf, minTrackingConfidence: trackConf } =
        event.data as InitMessage;
      minDetectionConfidence = detConf;
      minTrackingConfidence = trackConf;

      // Import MediaPipe Tasks Vision dynamically from CDN
      // This is legal inside a real module worker
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');

      // Initialize Hand Landmarker
      const filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);
      handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          // Use direct CDN URL for hand_landmarker.task
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: minDetectionConfidence,
        minHandPresenceConfidence: minTrackingConfidence,
        minTrackingConfidence: minTrackingConfidence,
      });

      self.postMessage({ type: 'READY' } as ReadyResponse);
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error instanceof Error ? error.message : 'Unknown initialization error',
      } as ErrorResponse);
    }
  } else if (type === 'PROCESS') {
    if (!handLandmarker) {
      self.postMessage({
        type: 'ERROR',
        error: 'Hand landmarker not initialized',
      } as ErrorResponse);
      return;
    }

    try {
      const { imageData, timestamp } = event.data as ProcessMessage;

      // Detect landmarks
      const results = handLandmarker.detectForVideo(imageData, timestamp);

      if (results.landmarks && results.landmarks.length > 0) {
        // Extract first hand's landmarks
        const landmarks = results.landmarks[0].map((lm) => ({
          x: lm.x,
          y: lm.y,
          z: lm.z,
          visibility: lm.visibility,
          confidence: undefined, // MediaPipe doesn't provide per-landmark confidence in this version
        }));

        const handedness =
          results.handednesses?.[0]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';
        const confidence = results.handednesses?.[0]?.[0]?.score ?? 1.0;

        self.postMessage({
          type: 'HAND_RESULT',
          result: {
            landmarks,
            handedness,
            confidence,
          },
          timestamp,
        } as HandResultResponse);
      } else {
        self.postMessage({
          type: 'HAND_RESULT',
          result: null,
          timestamp,
        } as HandResultResponse);
      }

      // IMPORTANT: Clear results to free memory (zero-upload privacy)
      results.landmarks = null;
      results.handednesses = null;
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error instanceof Error ? error.message : 'Unknown processing error',
      } as ErrorResponse);
    }
  } else if (type === 'STOP') {
    // Cleanup
    if (handLandmarker) {
      handLandmarker.close();
      handLandmarker = null;
    }
  }
};

export default {} as Record<string, never>;
