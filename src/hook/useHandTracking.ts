/**
 * useHandTracking.ts
 *
 * Manages the full lifecycle of the MediaPipe Web Worker:
 *   • Spawns the worker exactly once on mount
 *   • Sends INIT and tracks PROGRESS from both the WASM phase and the model phase
 *   • Receives frame callbacks from CameraSystem for processing
 *   • Returns the latest HandTrackingResult via a ref (not state — avoids
 *     triggering a React re-render on every frame)
 *   • Reports combined loading progress as a single 0-100 number
 *
 * INTEGRATION WITH CAMERA SYSTEM:
 *   This hook receives frame callbacks from the CameraSystem instead of
 *   running its own RAF loop. This ensures:
 *     • Single frame loop authority (no duplicate loops)
 *     • Proper session guards against stale frames
 *     • Backpressure handling when worker is busy
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { HandTrackingResult, LoadingState, WorkerOutMessage } from '../types/ar.types';
import { captureVideoFrame } from '../utils/coordinateMapping';

// Vite worker import — bundled as a separate chunk for code splitting
import MediapipeWorker from '../workers/mediapipe.worker?worker';

// ──────────────────────────────────────────────────────────────────────────────
// Hook return type
// ──────────────────────────────────────────────────────────────────────────────

export interface UseHandTrackingReturn {
  /** Latest tracking result — read in useFrame, never causes React re-renders */
  resultRef: React.RefObject<HandTrackingResult | null>;
  /** Loading progress 0-100 and status flags */
  loadingState: LoadingState;
  /** Call this once the camera stream is available to start frame dispatch */
  startTracking: (video: HTMLVideoElement) => void;
  /** Pause/resume frame dispatch (e.g. when modal is hidden) */
  setActive: (active: boolean) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────────

export function useHandTracking(): UseHandTrackingReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const resultRef = useRef<HandTrackingResult | null>(null);

  const [loadingState, setLoadingState] = useState<LoadingState>({
    mediapipe: 0,
    model: 0,
    camera: false,
    ready: false,
    error: null,
  });

  // ── Spawn worker and wire up message handler ─────────────────────────────
  useEffect(() => {
    const worker = new MediapipeWorker();
    workerRef.current = worker;

    worker.addEventListener('message', (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data;

      switch (msg.type) {
        case 'PROGRESS': {
          const { phase, progress } = msg.payload;
          setLoadingState((prev) => ({
            ...prev,
            // WASM (0→100) accounts for the first half of the combined bar.
            // Model (0→100) accounts for the second half.
            mediapipe:
              phase === 'wasm'
                ? Math.round(progress / 2)        // 0-50
                : Math.round(50 + progress / 2),  // 50-100
          }));
          break;
        }

        case 'READY':
          setLoadingState((prev) => ({
            ...prev,
            mediapipe: 100,
            ready: prev.model >= 100,
          }));
          break;

        case 'RESULT':
          resultRef.current = msg.payload;
          break;

        case 'ERROR': {
          const errorMessage = msg.payload.message;
          console.error(
            '%c[MediaPipe Worker] Initialization Error: %s',
            'color: #D5FD50; font-weight: bold;',
            errorMessage
          );
          
          setLoadingState((prev) => ({
            ...prev,
            error: errorMessage,
            ready: false,
          }));
          break;
        }
      }
    });

    // Send INIT — the worker immediately starts fetching WASM + model
    worker.postMessage({ type: 'INIT' });

    // ── Cleanup: graceful DESTROY then hard terminate ──────────────────────
    return () => {
      worker.postMessage({ type: 'DESTROY' });
      const killTimer = setTimeout(() => {
        worker.terminate();
      }, 300);
      worker.addEventListener(
        'message',
        (e: MessageEvent<WorkerOutMessage>) => {
          // @ts-expect-error — DESTROYED is an internal ack not in the union type
          if (e.data?.type === 'DESTROYED') {
            clearTimeout(killTimer);
            worker.terminate();
          }
        },
        { once: true },
      );
      workerRef.current = null;
    };
  }, []);

  // ── Frame processing callback (called by CameraSystem) ───────────────────
  const processFrame = useCallback(() => {
    if (!activeRef.current) return;

    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const frame = captureVideoFrame(video);
    if (!frame) return;

    // Transfer the buffer to avoid copying pixel data every frame.
    worker.postMessage(
      {
        type: 'DETECT',
        payload: {
          buffer: frame.buffer,
          width: frame.width,
          height: frame.height,
          timestamp: performance.now(),
        },
      },
      [frame.buffer],
    );
  }, []);

  // ── Register frame callback with camera system when worker is ready ──────
  useEffect(() => {
    if (loadingState.mediapipe >= 100 && loadingState.ready) {
      // Camera system will call this function when frames are available
      (window as any).__AR_FRAME_CALLBACK__ = processFrame;
    }
    return () => {
      delete (window as any).__AR_FRAME_CALLBACK__;
    };
  }, [processFrame, loadingState.mediapipe, loadingState.ready]);

  // ── Public API ────────────────────────────────────────────────────────────

  const startTracking = useCallback(
    (video: HTMLVideoElement) => {
      videoRef.current = video;
      activeRef.current = true;
      setLoadingState((prev) => ({ ...prev, camera: true }));
      // Frame loop is now managed by CameraSystem
    },
    [],
  );

  const setActive = useCallback(
    (active: boolean) => {
      activeRef.current = active;
    },
    [],
  );

  return { resultRef, loadingState, startTracking, setActive };
}
