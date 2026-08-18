/**
 * useHandTracking.ts
 *
 * Owns the MediaPipe worker lifecycle and keeps all camera frames local to this
 * browser session. Frames are transferred only to the same-origin Web Worker for
 * on-device inference and are never uploaded by this hook.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { HandTrackingResult, LoadingState, WorkerOutMessage, TrackingMetrics } from '../types/ar.types';
import { captureVideoFrame } from '../utils/coordinateMapping';
import { GestureDetector } from '../utils/GestureDetector';
import { createVerifiedWorker } from '../utils/SecurityUtils';

export interface UseHandTrackingReturn {
  resultRef: React.RefObject<HandTrackingResult | null>;
  loadingState: LoadingState;
  startTracking: (video: HTMLVideoElement) => void;
  setActive: (active: boolean) => void;
  pause: () => void;
  resume: () => void;
  destroy: () => void;
  getMetrics: () => TrackingMetrics | null;
}

export function useHandTracking(): UseHandTrackingReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const isPausedRef = useRef(false);
  const resultRef = useRef<HandTrackingResult | null>(null);
  const metricsRef = useRef<TrackingMetrics | null>(null);
  const workerReadyRef = useRef(false);
  const inFlightRef = useRef(false);
  const inferenceTimerRef = useRef<number | null>(null);
  const gestureDetectorRef = useRef(new GestureDetector());

  const [loadingState, setLoadingState] = useState<LoadingState>({
    mediapipe: 0,
    model: 0,
    camera: false,
    ready: false,
    error: null,
  });

  const destroyWorker = useCallback((worker = workerRef.current) => {
    if (inferenceTimerRef.current !== null) {
      window.clearInterval(inferenceTimerRef.current);
      inferenceTimerRef.current = null;
    }

    activeRef.current = false;
    isPausedRef.current = true;
    resultRef.current = null;
    videoRef.current = null;
    workerReadyRef.current = false;
    inFlightRef.current = false;

    if (!worker) return;

    worker.postMessage({ type: 'DESTROY' });
    const killTimer = window.setTimeout(() => worker.terminate(), 300);
    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerOutMessage>) => {
        if (event.data?.type === 'DESTROYED') {
          window.clearTimeout(killTimer);
          worker.terminate();
        }
      },
      { once: true },
    );

    if (workerRef.current === worker) workerRef.current = null;
  }, []);

  useEffect(() => {
    const worker = createVerifiedWorker(new URL('../workers/mediapipe.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.addEventListener('message', (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;

      switch (message.type) {
        case 'PROGRESS': {
          const { phase, progress } = message.payload;
          setLoadingState((prev) => ({
            ...prev,
            mediapipe: phase === 'wasm' ? Math.round(progress / 2) : Math.round(50 + progress / 2),
          }));
          break;
        }
        case 'READY':
          workerReadyRef.current = true;
          setLoadingState((prev) => ({ ...prev, mediapipe: 100, ready: true, error: null }));
          break;
        case 'RESULT': {
          resultRef.current = message.payload;
          const gestures = gestureDetectorRef.current.detect(message.payload);
          gestures.forEach((gesture) => {
            window.dispatchEvent(new CustomEvent('ar:gesture', { detail: gesture }));
          });
          inFlightRef.current = false;
          break;
        }
        case 'PAUSED':
          isPausedRef.current = true;
          break;
        case 'ERROR':
          setLoadingState((prev) => ({ ...prev, error: message.payload.message, ready: false }));
          inFlightRef.current = false;
          break;
      }
    });

    worker.postMessage({ type: 'INIT' });

    return () => destroyWorker(worker);
  }, [destroyWorker]);

  const processFrame = useCallback(() => {
    if (!activeRef.current || isPausedRef.current || !workerReadyRef.current || inFlightRef.current) return;

    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const frame = captureVideoFrame(video);
    if (!frame) return;

    inFlightRef.current = true;
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

  useEffect(() => {
    inferenceTimerRef.current = window.setInterval(processFrame, 1000 / 30);
    return () => {
      if (inferenceTimerRef.current !== null) {
        window.clearInterval(inferenceTimerRef.current);
        inferenceTimerRef.current = null;
      }
    };
  }, [processFrame]);

  const startTracking = useCallback((video: HTMLVideoElement) => {
    videoRef.current = video;
    activeRef.current = true;
    isPausedRef.current = false;
    setLoadingState((prev) => ({ ...prev, camera: true }));
  }, []);

  const setActive = useCallback((active: boolean) => {
    activeRef.current = active;
    if (active && isPausedRef.current) {
      isPausedRef.current = false;
      workerRef.current?.postMessage({ type: 'RESUME' });
    }
  }, []);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    workerRef.current?.postMessage({ type: 'PAUSE' });
  }, []);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    workerRef.current?.postMessage({ type: 'RESUME' });
  }, []);

  const getMetrics = useCallback(() => metricsRef.current, []);

  return { resultRef, loadingState, startTracking, setActive, pause, resume, destroy: destroyWorker, getMetrics };
}
