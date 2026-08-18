/**
 * useHandTracking.ts
 *
 * Manages the full lifecycle of the MediaPipe Web Worker:
 *   • Spawns the worker exactly once on mount
 *   • Sends INIT and tracks PROGRESS from both the WASM phase and the model phase
 *   • Dispatches video frames to the worker on a requestAnimationFrame loop
 *   • Returns the latest HandTrackingResult via a ref (not state — avoids
 *     triggering a React re-render on every frame)
 *   • Reports combined loading progress as a single 0-100 number
 *
 * WHY REF INSTEAD OF STATE FOR LANDMARKS?
 *   setState → re-render → all children reconcile → DOM diff → at 30 fps this
 *   is 30 full React render cycles per second for the entire AR subtree.
 *   Instead we store the result in a ref and let the R3F useFrame hook read it
 *   directly each render without touching React at all.
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
  const rafRef = useRef<number>(0);
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
                ? Math.round(progress / 2)         // 0-50
                : Math.round(50 + progress / 2),   // 50-100
          }));
          break;
        }

        case 'READY':
          setLoadingState((prev) => ({ ...prev, mediapipe: 100, ready: prev.model >= 100 }));
          break;

        case 'RESULT':
          resultRef.current = msg.payload;
          break;

        case 'ERROR':
          setLoadingState((prev) => ({
            ...prev,
            error: msg.payload.message,
          }));
          console.error('[MediaPipe Worker]', msg.payload.message);
          break;
      }
    });

    // ── Send INIT — the worker immediately starts fetching WASM + model ──────
    worker.postMessage({ type: 'INIT' });

    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.postMessage({ type: 'DESTROY' });
      worker.terminate();
      workerRef.current = null;
    };
  }, []); // runs once

  // ── Frame dispatch loop ──────────────────────────────────────────────────
  const dispatchFrame = useCallback(() => {
    if (!activeRef.current) return;
    rafRef.current = requestAnimationFrame(dispatchFrame);

    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const frame = captureVideoFrame(video);
    if (!frame) return;

    // Transfer the buffer to avoid copying ~1.2 MB of pixel data every frame.
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
      [frame.buffer], // transferable — the buffer is detached in the sender
    );
  }, []);

  // ── Public API ────────────────────────────────────────────────────────────

  const startTracking = useCallback(
    (video: HTMLVideoElement) => {
      videoRef.current = video;
      activeRef.current = true;
      setLoadingState((prev) => ({ ...prev, camera: true }));
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(dispatchFrame);
    },
    [dispatchFrame],
  );

  const setActive = useCallback(
    (active: boolean) => {
      activeRef.current = active;
      if (active && videoRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(dispatchFrame);
      } else {
        cancelAnimationFrame(rafRef.current);
      }
    },
    [dispatchFrame],
  );

  return { resultRef, loadingState, startTracking, setActive };
}
