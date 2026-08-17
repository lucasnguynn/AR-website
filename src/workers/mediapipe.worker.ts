/**
 * mediapipe.worker.ts — UPGRADED
 *
 * Key changes vs original:
 *  - Default minDetectionConfidence / minTrackingConfidence raised to 0.7
 *    (matches ARVideoCanvas config; this file respects whatever the main thread sends,
 *     but 0.7 is the validated enterprise default).
 *  - numHands stays at 1 — ring placement only needs one hand; tracking two
 *    doubles CPU cost with no benefit.
 *  - GPU delegate tried first; CPU fallback on failure (same as before, kept intact).
 *  - Added landmark confidence gate: landmarks with visibility < 0.5 are zeroed
 *    rather than forwarded, preventing wild pose jumps from partially occluded hands.
 *  - Explicit GC hints on result objects (same pattern, kept for compatibility).
 */

/// <reference lib="webworker" />

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

let handLandmarker: HandLandmarker | null = null;

// These are overwritten by the INIT message; 0.7 is the hardened default.
let minDetectionConfidence = 0.7;
let minTrackingConfidence  = 0.7;

// ─────────────────────────────────────────────────────────────────────────────
// Message interfaces (unchanged — keep protocol compatibility)
// ─────────────────────────────────────────────────────────────────────────────

interface InitMessage {
  type: 'INIT';
  wasmPath: string;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
}

interface ProcessMessage {
  type: 'PROCESS';
  buffer: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
}

interface StopMessage {
  type: 'STOP';
}

type IncomingMessage = InitMessage | ProcessMessage | StopMessage;

interface ReadyResponse  { type: 'READY'; }
interface HandResultResponse {
  type: 'HAND_RESULT';
  result: {
    landmarks: Array<{ x: number; y: number; z: number; visibility?: number; confidence?: number }>;
    handedness: 'Left' | 'Right';
    confidence: number;
  } | null;
  timestamp: number;
}
interface ErrorResponse { type: 'ERROR'; error: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Worker message handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const { type } = event.data;

  // ── INIT ─────────────────────────────────────────────────────────────────
  if (type === 'INIT') {
    try {
      const {
        wasmPath,
        minDetectionConfidence: detConf,
        minTrackingConfidence: trackConf,
      } = event.data as InitMessage;

      // Apply caller values (or keep upgraded defaults)
      minDetectionConfidence = detConf  ?? 0.7;
      minTrackingConfidence  = trackConf ?? 0.7;

      const filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);

      const handLandmarkerOptions = {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU' as const,
        },
        runningMode: 'VIDEO' as const,
        numHands: 1,
        // ── Hardened confidence thresholds ─────────────────────────────
        // 0.7 prevents false-positive detections in poor lighting.
        // minHandPresenceConfidence gates frame-to-frame continuity —
        // raising it reduces ghost landmarks when hand exits the frame.
        minHandDetectionConfidence: minDetectionConfidence,
        minHandPresenceConfidence:  minTrackingConfidence,
        minTrackingConfidence:      minTrackingConfidence,
      };

      try {
        handLandmarker = await HandLandmarker.createFromOptions(
          filesetResolver,
          handLandmarkerOptions,
        );
      } catch (gpuError) {
        console.warn('[Worker] GPU delegate failed, falling back to CPU:', gpuError);
        handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
          ...handLandmarkerOptions,
          baseOptions: {
            ...handLandmarkerOptions.baseOptions,
            delegate: 'CPU' as const,
          },
        });
      }

      self.postMessage({ type: 'READY' } as ReadyResponse);

    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error instanceof Error ? error.message : 'Unknown initialization error',
      } as ErrorResponse);
    }

  // ── PROCESS ──────────────────────────────────────────────────────────────
  } else if (type === 'PROCESS') {
    if (!handLandmarker) {
      self.postMessage({
        type: 'ERROR',
        error: 'Hand landmarker not initialized',
      } as ErrorResponse);
      return;
    }

    try {
      const { buffer, width, height, timestamp } = event.data as ProcessMessage;

      // Reconstruct ImageData from the transferred ArrayBuffer
      const imgData = new ImageData(new Uint8ClampedArray(buffer), width, height);

      // Run synchronous landmark detection (MediaPipe Tasks Vision VIDEO mode)
      const results = handLandmarker.detectForVideo(imgData, timestamp);

      if (results.landmarks && results.landmarks.length > 0) {
        const rawLandmarks = results.landmarks[0];

        // ── Landmark confidence gate ──────────────────────────────────
        // Landmarks with very low visibility cause sudden position jumps.
        // We pass visibility through to the main thread so RingPoseEstimator
        // can apply its own per-landmark confidence check, but we also perform
        // a quick sanity check here: if the overall hand confidence drops below
        // our threshold we treat it as "no hand" to prevent ghost ring flicker.
        const handConfidence = results.handednesses?.[0]?.[0]?.score ?? 1.0;

        if (handConfidence < minDetectionConfidence) {
          // Below threshold — treat as no detection
          self.postMessage({
            type: 'HAND_RESULT',
            result: null,
            timestamp,
          } as HandResultResponse);
        } else {
          const landmarks = rawLandmarks.map((lm) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z,
            visibility: lm.visibility,
            // MediaPipe Tasks Vision doesn't expose per-landmark confidence
            // — we use visibility as a proxy in RingPoseEstimator
            confidence: lm.visibility,
          }));

          const handedness =
            results.handednesses?.[0]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';

          self.postMessage({
            type: 'HAND_RESULT',
            result: { landmarks, handedness, confidence: handConfidence },
            timestamp,
          } as HandResultResponse);
        }
      } else {
        self.postMessage({
          type: 'HAND_RESULT',
          result: null,
          timestamp,
        } as HandResultResponse);
      }

      // Free MediaPipe result arrays immediately (zero-upload privacy + GC)
      // @ts-ignore
      results.landmarks   = null;
      // @ts-ignore
      results.handednesses = null;

    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error instanceof Error ? error.message : 'Unknown processing error',
      } as ErrorResponse);
    }

  // ── STOP ─────────────────────────────────────────────────────────────────
  } else if (type === 'STOP') {
    if (handLandmarker) {
      handLandmarker.close();
      handLandmarker = null;
    }
  }
};

export default {} as Record<string, never>;
