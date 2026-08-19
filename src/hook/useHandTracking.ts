// FILE: src/hook/useHandTracking.ts
/**
 * useHandTracking.ts
 *
 * Owns the MediaPipe worker lifecycle and keeps all camera frames local to this
 * browser session. Frames are transferred only to the same-origin Web Worker for
 * on-device inference and are never uploaded by this hook.
 */

import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import type { HandTrackingResult, LoadingState, TrackingMetrics } from '../types/ar.types';
import { captureVideoFrame } from '../utils/coordinateMapping';
import { GestureDetector } from '../utils/GestureDetector';
import { createVerifiedWorker } from '../utils/SecurityUtils';

const HAND_LANDMARKER_MODEL_PATH = 'models/hand_landmarker.task';
const MEDIAPIPE_WASM_PATH = 'wasm/vision_wasm_internal.wasm';

type HandTrackingWorkerOutMessage =
  | { type: 'READY' }
  | { type: 'PROGRESS'; payload: { phase: 'wasm' | 'model'; progress: number } }
  | { type: 'RESULT'; payload: HandTrackingResult & { metrics?: TrackingMetrics } }
  | { type: 'DEGRADED'; payload: { metrics: TrackingMetrics } }
  | { type: 'ERROR'; payload: { message: string; state?: string } }
  | { type: 'PAUSED' }
  | { type: 'DESTROYED' };

/**
 * Public controls and state references for hand tracking.
 */
export interface UseHandTrackingReturn {
  resultRef: RefObject<HandTrackingResult | null>;
  loadingState: LoadingState;
  startTracking: (video: HTMLVideoElement) => void;
  setActive: (active: boolean) => void;
  pause: () => void;
  resume: () => void;
  destroy: () => void;
  getMetrics: () => TrackingMetrics | null;
}

/**
 * Creates and controls the verified MediaPipe hand-tracking worker lifecycle.
 */
export function useHandTracking(): UseHandTrackingReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const isPausedRef = useRef(false);
  const resultRef = useRef<HandTrackingResult | null>(null);
  const metricsRef = useRef<TrackingMetrics | null>(null);
  const workerReadyRef = useRef(false);
  const inFlightRef = useRef(false);
  const degradedRef = useRef(false);
  const wasmBlobUrlRef = useRef<string | null>(null);
  const inferenceTimerRef = useRef<number | null>(null);
  const lastFrameSentAtRef = useRef(0);
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
    degradedRef.current = false;

    if (wasmBlobUrlRef.current) {
      URL.revokeObjectURL(wasmBlobUrlRef.current);
      wasmBlobUrlRef.current = null;
    }

    if (!worker) return;

    worker.postMessage({ type: 'DESTROY' });
    const killTimer = window.setTimeout(() => worker.terminate(), 300);
    worker.addEventListener(
      'message',
      (event: MessageEvent<HandTrackingWorkerOutMessage>) => {
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
    let cancelled = false;
    let worker: Worker | null = null;

    async function createWorker(): Promise<void> {
      const workerUrl = new URL('../workers/mediapipe.worker.ts', import.meta.url);
      try {
        worker = await createVerifiedWorker(workerUrl, { type: 'module' });
      } catch (error) {
        window.dispatchEvent(new CustomEvent('ar:security-violation', {
          detail: { asset: workerUrl.toString(), reason: 'SRI_MISMATCH', ts: Date.now() },
        }));
        setLoadingState((prev) => ({
          ...prev,
          ready: false,
          error: error instanceof Error ? error.message : 'MediaPipe worker integrity verification failed. Refusing to start hand tracking.',
        }));
        return;
      }

      const assetBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
      const wasmUrl = new URL(MEDIAPIPE_WASM_PATH, assetBaseUrl);
      const modelUrl = new URL(HAND_LANDMARKER_MODEL_PATH, assetBaseUrl);
      const wasmResponse = await fetch(wasmUrl, {
        cache: 'force-cache',
        credentials: 'same-origin',
      });
      if (!wasmResponse.ok) {
        throw new Error(`Failed to fetch MediaPipe WASM binary: HTTP ${wasmResponse.status}`);
      }

      const wasmBlob = new Blob([await wasmResponse.arrayBuffer()], { type: 'application/wasm' });
      const wasmBlobUrl = URL.createObjectURL(wasmBlob);
      wasmBlobUrlRef.current = wasmBlobUrl;

      if (cancelled) {
        URL.revokeObjectURL(wasmBlobUrl);
        if (wasmBlobUrlRef.current === wasmBlobUrl) wasmBlobUrlRef.current = null;
        return;
      }

      workerRef.current = worker;

      worker.addEventListener('message', (event: MessageEvent<HandTrackingWorkerOutMessage>) => {
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
            metricsRef.current = message.payload.metrics ?? metricsRef.current;
            const gestures = gestureDetectorRef.current.detect(message.payload);
            gestures.forEach((gesture) => {
              window.dispatchEvent(new CustomEvent('ar:gesture', { detail: gesture }));
            });
            inFlightRef.current = false;
            break;
          }
          case 'DEGRADED':
            degradedRef.current = true;
            inFlightRef.current = false;
            metricsRef.current = message.payload.metrics;
            break;
          case 'PAUSED':
            isPausedRef.current = true;
            break;
          case 'ERROR':
            setLoadingState((prev) => ({ ...prev, error: message.payload.message, ready: false }));
            inFlightRef.current = false;
            break;
        }
      });

      worker.postMessage({ type: 'INIT', payload: { wasmBlobUrl, modelUrl: modelUrl.toString() } });
    }

    createWorker().catch((error: unknown) => {
      setLoadingState((prev) => ({
        ...prev,
        ready: false,
        error: error instanceof Error ? error.message : 'Failed to initialize MediaPipe worker',
      }));
    });

    return () => {
      cancelled = true;
      destroyWorker(worker);
    };
  }, [destroyWorker]);

  const processFrame = useCallback(() => {
    if (!activeRef.current || isPausedRef.current || !workerReadyRef.current) return;

    const now = performance.now();
    const minFrameIntervalMs = degradedRef.current ? 1000 / 15 : 1000 / 30;
    if (now - lastFrameSentAtRef.current < minFrameIntervalMs) return;

    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const frame = captureVideoFrame(video);
    if (!frame) return;

    inFlightRef.current = true;
    lastFrameSentAtRef.current = now;
    worker.postMessage(
      {
        type: 'DETECT',
        payload: {
          buffer: frame.buffer,
          width: frame.width,
          height: frame.height,
          timestamp: now,
        },
      },
      [frame.buffer],
    );
  }, []);

  useEffect(() => {
    inferenceTimerRef.current = window.setInterval(processFrame, 1000 / 60);
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
// VERIFY: console.log('[MediaPipe] WASM loaded via blob: — eval() bypassed')
