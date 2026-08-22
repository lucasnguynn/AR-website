// FILE: src/hook/useHandTracking.ts
/**
 * useHandTracking.ts
 */

import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import type { HandTrackingResult, LoadingState, TrackingMetrics } from '../types/ar.types';
import { protocolMessage, validateMediaPipeOutbound } from '../protocol/workerProtocol';
import { captureVideoFrame } from '../utils/coordinateMapping';
import { GestureDetector } from '../utils/GestureDetector';
import { createVerifiedAssetBlobUrl, createVerifiedWorker } from '../utils/SecurityUtils';
import mediapipeWorkerUrl from '../workers/mediapipe.worker.ts?worker&url';

const HAND_LANDMARKER_MODEL_PATH = 'models/hand_landmarker.task';

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

export function useHandTracking(enabled = true): UseHandTrackingReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const isPausedRef = useRef(false);
  const resultRef = useRef<HandTrackingResult | null>(null);
  const metricsRef = useRef<TrackingMetrics | null>(null);
  const workerReadyRef = useRef(false);
  const inFlightRef = useRef(false);
  const degradedRef = useRef(false);
  const modelBlobUrlRef = useRef<string | null>(null);
  const inferenceTimerRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const videoFrameCallbackOwnerRef = useRef<HTMLVideoElement | null>(null);
  const lastFrameSentAtRef = useRef(0);
  const gestureDetectorRef = useRef(new GestureDetector());
  const [cameraSchedulerEpoch, setCameraSchedulerEpoch] = useState(0);

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
    const scheduledVideo = videoFrameCallbackOwnerRef.current;
    if (videoFrameCallbackRef.current !== null && scheduledVideo?.cancelVideoFrameCallback) {
      scheduledVideo.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
      videoFrameCallbackOwnerRef.current = null;
    }

    activeRef.current = false;
    isPausedRef.current = true;
    resultRef.current = null;
    videoRef.current = null;
    workerReadyRef.current = false;
    inFlightRef.current = false;
    degradedRef.current = false;

    if (modelBlobUrlRef.current) { 
      URL.revokeObjectURL(modelBlobUrlRef.current); 
      modelBlobUrlRef.current = null; 
    }

    if (!worker) return;

    worker.postMessage(protocolMessage({ type: 'DESTROY' }));
    const killTimer = window.setTimeout(() => worker.terminate(), 300);
    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        if (validateMediaPipeOutbound(event.data) && event.data.type === 'DESTROYED') {
          window.clearTimeout(killTimer);
          worker.terminate();
        }
      },
      { once: true },
    );

    if (workerRef.current === worker) workerRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let worker: Worker | null = null;

    async function createWorker(): Promise<void> {
      const workerUrl = new URL(mediapipeWorkerUrl, window.location.href);
      try {
        worker = await createVerifiedWorker(workerUrl, { type: 'module' });
      } catch (error) {
        window.dispatchEvent(new CustomEvent('ar:security-violation', {
          detail: { asset: workerUrl.toString(), reason: 'SRI_MISMATCH', ts: Date.now() },
        }));
        setLoadingState((prev) => ({
          ...prev,
          ready: false,
          error: error instanceof Error ? error.message : 'MediaPipe worker integrity verification failed.',
        }));
        return;
      }

      const assetBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
      
      // DEVSECOPS FIX: Sử dụng CDN trực tiếp để chống lỗi 404 do thiếu file WASM trên server local
      const wasmBasePath = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
      
      const modelUrl = new URL(HAND_LANDMARKER_MODEL_PATH, assetBaseUrl);
      const modelBlobUrl = await createVerifiedAssetBlobUrl(modelUrl, 'application/octet-stream');
      
      modelBlobUrlRef.current = modelBlobUrl;

      if (cancelled) {
        URL.revokeObjectURL(modelBlobUrl);
        if (modelBlobUrlRef.current === modelBlobUrl) modelBlobUrlRef.current = null;
        return;
      }

      workerRef.current = worker;

      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!validateMediaPipeOutbound(message)) {
          window.dispatchEvent(new CustomEvent('ar:protocol-error', { detail: { worker: 'mediapipe', reason: 'INVALID_MESSAGE' } }));
          return;
        }

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

      worker.postMessage(protocolMessage({ type: 'INIT', payload: { wasmBlobUrl: wasmBasePath, modelUrl: modelBlobUrl } }));
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
  }, [destroyWorker, enabled]);

  const processFrame = useCallback(() => {
    if (!activeRef.current || isPausedRef.current || !workerReadyRef.current || inFlightRef.current) return;

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
      protocolMessage({
        type: 'DETECT',
        payload: {
          buffer: frame.buffer,
          width: frame.width,
          height: frame.height,
          timestamp: now,
        },
      }),
      [frame.buffer],
    );
  }, []);

  useEffect(() => {
    if (videoRef.current?.requestVideoFrameCallback) {
      const onVideoFrame = () => {
        processFrame();
        const currentVideo = videoRef.current;
        if (currentVideo?.requestVideoFrameCallback) {
          videoFrameCallbackOwnerRef.current = currentVideo;
          videoFrameCallbackRef.current = currentVideo.requestVideoFrameCallback(onVideoFrame);
        }
      };
      videoFrameCallbackOwnerRef.current = videoRef.current;
      videoFrameCallbackRef.current = videoRef.current.requestVideoFrameCallback(onVideoFrame);
    } else {
      inferenceTimerRef.current = window.setInterval(processFrame, 1000 / 30);
    }
    return () => {
      if (inferenceTimerRef.current !== null) {
        window.clearInterval(inferenceTimerRef.current);
        inferenceTimerRef.current = null;
      }
      const currentVideo = videoFrameCallbackOwnerRef.current;
      if (videoFrameCallbackRef.current !== null && currentVideo?.cancelVideoFrameCallback) {
        currentVideo.cancelVideoFrameCallback(videoFrameCallbackRef.current);
        videoFrameCallbackRef.current = null;
        videoFrameCallbackOwnerRef.current = null;
      }
    };
  }, [processFrame, loadingState.camera, cameraSchedulerEpoch]);

  const startTracking = useCallback((video: HTMLVideoElement) => {
    videoRef.current = video;
    activeRef.current = true;
    isPausedRef.current = false;
    setCameraSchedulerEpoch((epoch) => epoch + 1);
    setLoadingState((prev) => ({ ...prev, camera: true }));
  }, []);

  const setActive = useCallback((active: boolean) => {
    activeRef.current = active;
    if (active && isPausedRef.current) {
      isPausedRef.current = false;
      workerRef.current?.postMessage(protocolMessage({ type: 'RESUME' }));
    }
  }, []);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    workerRef.current?.postMessage(protocolMessage({ type: 'PAUSE' }));
  }, []);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    workerRef.current?.postMessage(protocolMessage({ type: 'RESUME' }));
  }, []);

  const getMetrics = useCallback(() => metricsRef.current, []);

  return { resultRef, loadingState, startTracking, setActive, pause, resume, destroy: destroyWorker, getMetrics };
}
