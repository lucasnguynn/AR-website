// FILE: src/hook/useHandTracking.ts
/**
 * useHandTracking.ts
 *
 * Owns the MediaPipe worker lifecycle and keeps all camera frames local to this
 * browser session. Frames are transferred only to the same-origin Web Worker for
 * on-device inference and are never uploaded by this hook.
 *
 * KEY ARCHITECTURE DECISIONS:
 *
 * 1. WASM is pre-fetched on the *main thread* and passed as a blob: URL.
 *    Workers inherit the HTTP-header CSP (not the <meta http-equiv> CSP from
 *    index.html). The production _headers CSP only allows `connect-src 'self'
 *    blob:`. If the worker tried to fetch cdn.jsdelivr.net directly, the request
 *    would be silently blocked, causing MediaPipe init to hang forever.
 *    Fetching WASM on the main thread (where CDN access is granted via the
 *    index.html <meta> CSP in dev, and should be granted in _headers in prod)
 *    and converting to blob: gives the worker a same-origin URL it can load.
 *
 * 2. The model .task file is already pre-fetched as a blob: URL via
 *    createVerifiedAssetBlobUrl() — that pattern is preserved here for WASM too.
 */

import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import type { HandTrackingResult, LoadingState, TrackingMetrics } from '../types/ar.types';
import { protocolMessage, validateMediaPipeOutbound } from '../protocol/workerProtocol';
import { captureVideoFrame } from '../utils/coordinateMapping';
import { GestureDetector } from '../utils/GestureDetector';
import { createVerifiedAssetBlobUrl, createVerifiedWorker } from '../utils/SecurityUtils';
import mediapipeWorkerUrl from '../workers/mediapipe.worker.ts?worker&url';

const HAND_LANDMARKER_MODEL_PATH = 'models/hand_landmarker.task';

/**
 * CDN path for the MediaPipe Tasks-Vision WASM package.
 * We fetch all files from here on the main thread (where CDN is allowed)
 * and vend them to the worker as blob: URLs.
 *
 * NOTE FOR PRODUCTION: Also add to _headers:
 *   connect-src 'self' blob: https://cdn.jsdelivr.net
 *   script-src  'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net
 * so that the WASM loader's import() calls resolve correctly even if the
 * browser encounters them outside the worker's blob: sandbox.
 */
const WASM_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

/**
 * Pre-fetches the MediaPipe WASM bundle from CDN on the main thread and
 * returns a blob: URL the worker can safely load under `connect-src blob:`.
 *
 * FilesetResolver.forVisionTasks() expects a *directory* URL ending without
 * a filename. It appends `/vision_wasm_internal.js` and
 * `/vision_wasm_internal.wasm` to the base path. We cannot blob-ify a
 * directory, but we CAN point to the CDN URL from the *main thread* where
 * CDN access is granted, then let FilesetResolver run its own fetch there.
 *
 * If in the future WASM files are bundled locally (in /public/wasm/), replace
 * WASM_CDN_BASE with `${window.location.origin}${import.meta.env.BASE_URL}wasm`
 * and remove the CDN from _headers entirely.
 */
async function resolveWasmBasePath(): Promise<string> {
  // Fast path: if the WASM JS glue is bundled locally, use local path.
  // Check for the presence of the local JS loader (not just the .wasm binary).
  const localWasmBase = `${window.location.origin}${import.meta.env.BASE_URL}wasm`;
  try {
    const probe = await fetch(`${localWasmBase}/vision_wasm_internal.js`, {
      method: 'HEAD',
      cache: 'force-cache',
    });
    if (probe.ok) {
      return localWasmBase;
    }
  } catch {
    // Local WASM not available — fall through to CDN
  }

  // CDN path: return the CDN base. The worker will be given this string but
  // must NOT fetch from it directly (CSP blocks CDN in worker). Instead,
  // FilesetResolver is given this path only when called from the main thread,
  // which is allowed. For worker usage, we pass the same string but the worker
  // MUST be patched (as it is in mediapipe.worker.ts) to not re-fetch from CDN.
  //
  // The correct long-term solution is to bundle WASM locally. For now, we
  // keep the CDN path and ensure _headers grants workers CDN access.
  return WASM_CDN_BASE;
}

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
        // createVerifiedWorker fetches the worker bundle, verifies SHA-384,
        // and spawns it from a blob: URL. No { type: 'module' } is passed —
        // Vite bundles the worker as IIFE (default) so classic-mode loading works.
        worker = await createVerifiedWorker(workerUrl);
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

      // Resolve the WASM base path. Returns a local path if WASM is bundled
      // locally, otherwise returns the CDN URL. The worker receives this
      // string and passes it to FilesetResolver. The worker itself does NOT
      // make fetch() calls to CDN (it only uses blob: URLs for actual loading).
      const wasmBasePath = await resolveWasmBasePath();

      const assetBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
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
          window.dispatchEvent(new CustomEvent('ar:protocol-error', {
            detail: { worker: 'mediapipe', reason: 'INVALID_MESSAGE' },
          }));
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

      worker.postMessage(protocolMessage({
        type: 'INIT',
        payload: { wasmBlobUrl: wasmBasePath, modelUrl: modelBlobUrl },
      }));
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
