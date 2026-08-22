// FILE: src/components/ARTryOnModal.tsx
/**
 * ARTryOnModal.tsx
 *
 * Entry point for progressive AR enhancement. Immersive WebXR starts only from
 * an explicit user gesture; unsupported/denied XR falls through to iOS Quick
 * Look, camera-composite AR, and finally interactive 3D. Camera frames remain
 * local to the browser session.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useCamera, startCameraFromRef, resetCamera } from '../hook/useCamera';
import { useHandTracking } from '../hook/useHandTracking';
import { useLoadingState } from '../hook/useLoadingState';
import { useAmbientLightAdapter } from '../utils/AmbientLightAdapter';
import { DeviceProfiler } from '../utils/DeviceProfiler';
import { AROrchestrator, type ARDiagnostics } from '../ar/AROrchestrator';
import { WebXRAdapter, createCameraCompositeAdapter, createInteractive3DAdapter, createQuickLookAdapter } from '../ar/adapters';
import { assertLocalCameraPrivacy } from '../utils/SecurityUtils';
import { estimateRingSizeFromPinch, type RingSizeEstimate } from '../utils/SizingTool';
import { ARControls } from './ARControls';
import { WebGPUScene } from './WebGPUScene';
import { QuickLookViewer } from './QuickLookViewer';
import { WebXRScene } from './WebXRScene';
import { Fallback3DViewer } from './Fallback3DViewer';
import { containModalFocus } from '../utils/modalFocus';
import { AR_RUNTIME_CONFIG, metricSizingEnabled, ringModelUrlForQuality } from '../config/arRuntimeConfig';
import { trackAREvent } from '../utils/ARAnalytics';

/** Props for the top-level AR try-on modal. */
export interface ARTryOnModalProps {
  onClose: () => void;
}

type CriticalError = {
  title: string;
  message: string;
  retryable: boolean;
};

const TRACKING_TIMEOUT_MS = 12_000;
const SMART_HUD_DELAY_MS = 2_000;
const QUICK_LOOK_USDZ_URL = AR_RUNTIME_CONFIG.assets.usdz;
const QUICK_LOOK_PREVIEW_URL = AR_RUNTIME_CONFIG.assets.preview;
const QUICK_LOOK_PRODUCT_NAME = AR_RUNTIME_CONFIG.product.name;
const QUICK_LOOK_DIAMETER_MM = AR_RUNTIME_CONFIG.product.referenceOuterDiameterMm;

function hasWebGLSupport(): boolean {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return false;
  const loseContext = gl.getExtension('WEBGL_lose_context');
  loseContext?.loseContext();
  return true;
}

function rendererKind(): 'webgl2' {
  // React18 + R3F8 production Canvas uses the validated synchronous WebGL2 path.
  // navigator.gpu is only a hardware capability signal, not the active renderer.
  return 'webgl2';
}

export function ARTryOnModal({ onClose }: ARTryOnModalProps) {
  const dialogRef = useDialogFocus();
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRequestedRef = useRef(false);
  const trackingTimeoutRef = useRef<number | null>(null);
  const [criticalError, setCriticalError] = useState<CriticalError | null>(null);
  const [trackingEnabled, setTrackingEnabled] = useState(false);

  // videoReady gates orchestrator.start() until the <video> element is in DOM.
  // Without this gate, the camera-composite adapter's start() can run before
  // videoRef.current is non-null, throwing "Camera preview is not mounted."
  // which surfaces as "Uncaught (in promise) undefined" from the orchestrator's
  // swallowed catch.
  const [videoReady, setVideoReady] = useState(false);
  const [experienceRequested, setExperienceRequested] = useState(false);

  const { resultRef, loadingState, startTracking, restartTracking, setActive, destroy } = useHandTracking(trackingEnabled);
  const { isLoading, markLoaded } = useLoadingState();
  const ambientLight = useAmbientLightAdapter(videoRef);
  const [hudVisible, setHudVisible] = useState(false);
  const [sizeEstimate, setSizeEstimate] = useState<RingSizeEstimate | null>(null);
  const [diagnostics, setDiagnostics] = useState<ARDiagnostics | null>(null);

  useEffect(() => {
    const updateDepth = (event: Event) => {
      const detail = (event as CustomEvent<{ tier?: ARDiagnostics['depth'] }>).detail;
      if (!detail?.tier) return;
      const tier = detail.tier;
      setDiagnostics((current) => current ? { ...current, depth: tier } : current);
    };
    window.addEventListener('ar:depth-diagnostics', updateDepth);
    return () => window.removeEventListener('ar:depth-diagnostics', updateDepth);
  }, []);

  const {
    cameraState,
    facingMode,
    isReady: cameraIsReady,
    hasError: cameraHasError,
    lastError: cameraLastError,
    switchCamera,
    recoverCamera,
    stopCamera,
  } = useCamera();

  const webxrAdapter = useMemo(() => new WebXRAdapter(), []);
  useEffect(() => { void webxrAdapter.preflight(); }, [webxrAdapter]);
  const orchestrator = useMemo(() => new AROrchestrator([
    webxrAdapter,
    createQuickLookAdapter(() => DeviceProfiler.checkQuickLookSupport()),
    createCameraCompositeAdapter(
      () => typeof navigator.mediaDevices?.getUserMedia === 'function' && hasWebGLSupport(),
      {
        start: async () => {
          const video = videoRef.current;
          if (!video) throw new Error('Camera preview is not mounted.');
          await startCameraFromRef(video, 'user');
          setTrackingEnabled(true);
          startTracking(video);
          setActive(true);
        },
        stop: () => {
          setActive(false);
          setTrackingEnabled(false);
          destroy();
          stopCamera();
          assertLocalCameraPrivacy(videoRef.current);
          resetCamera();
        },
      },
      rendererKind(),
    ),
    createInteractive3DAdapter(rendererKind()),
  ], setDiagnostics), [destroy, setActive, startTracking, stopCamera, webxrAdapter]);

  const combinedProgress = Math.min(100, Math.round(loadingState.mediapipe * 0.7 + (isLoading ? 0 : 30)));
  const isReady = !isLoading && loadingState.mediapipe >= 100 && loadingState.camera && !criticalError;

  const closeAR = useCallback(() => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    if (trackingTimeoutRef.current !== null) {
      window.clearTimeout(trackingTimeoutRef.current);
      trackingTimeoutRef.current = null;
    }
    trackAREvent('AR_SESSION_ENDED', diagnostics ? { experience: diagnostics.experience, renderer: diagnostics.renderer, depthTier: diagnostics.depth } : undefined);
    void orchestrator.stop().finally(onClose);
  }, [diagnostics, onClose, orchestrator]);

  const retryExperience = useCallback(async () => {
    setCriticalError(null);
    (resultRef as React.MutableRefObject<typeof resultRef.current>).current = null;
    const video = videoRef.current;

    try {
      if (cameraHasError) {
        await recoverCamera();
        if (video) restartTracking(video);
        return;
      }

      if (loadingState.error) {
        if (video) restartTracking(video);
        return;
      }

      // Hand-not-detected recovery should not tear down a healthy camera.
      if (video) {
        startTracking(video);
        setActive(true);
      }
    } catch (error) {
      setCriticalError({
        title: 'Unable to restart AR',
        message: error instanceof Error ? error.message : 'Camera or hand tracking could not restart.',
        retryable: true,
      });
    }
  }, [cameraHasError, loadingState.error, recoverCamera, restartTracking, resultRef, setActive, startTracking]);

  // WebXR immersive sessions require transient user activation. Starting from an
  // effect loses that browser gesture. Keep startup behind the explicit button below.
  const startExperience = useCallback(() => {
    if (!videoReady || experienceRequested) return;
    setExperienceRequested(true);
    trackAREvent('AR_CTA_CLICKED');
    void orchestrator.start().then((selected) => {
      trackAREvent('AR_MODE_SELECTED', { experience: selected.experience, renderer: selected.renderer, depthTier: selected.depth });
      trackAREvent('AR_SESSION_STARTED', { experience: selected.experience, renderer: selected.renderer, depthTier: selected.depth });
    }).catch((error: unknown) => {
      setExperienceRequested(false);
      trackAREvent('AR_FATAL_ERROR', { reasonCode: error instanceof Error ? error.name || 'START_FAILED' : 'START_FAILED' });
      setCriticalError({
        title: 'AR unavailable',
        message: error instanceof Error ? error.message : 'No AR experience could start.',
        retryable: false,
      });
    });
  }, [experienceRequested, orchestrator, videoReady]);

  useEffect(() => () => {
    if (trackingTimeoutRef.current !== null) window.clearTimeout(trackingTimeoutRef.current);
    void orchestrator.stop();
  }, [orchestrator]);

  // Once the WebXR scene binds its renderer, refresh diagnostics from
  // `initializing` to `active` without restarting the orchestrator.
  useEffect(() => webxrAdapter.manager.subscribeState(() => {
    if (orchestrator.activeKind === 'webxr') setDiagnostics(webxrAdapter.diagnostics());
  }), [orchestrator, webxrAdapter]);

  useEffect(() => {
    if (!cameraHasError || !cameraLastError) return;
    setCriticalError({
      title: cameraLastError.code === 'PERMISSION_DENIED' ? 'Camera permission needed' : 'Camera interrupted',
      message:
        cameraLastError.code === 'PERMISSION_DENIED'
          ? 'Enable camera access for this site, then retry. Video is processed locally and never uploaded.'
          : `${cameraLastError.message}. Retry the camera or close this view.`,
      retryable: cameraLastError.recoverable || cameraLastError.code === 'PERMISSION_DENIED',
    });
  }, [cameraHasError, cameraLastError]);

  useEffect(() => {
    if (!loadingState.error) return;
    setCriticalError({
      title: 'AR model did not load',
      message: 'The hand-tracking engine could not start. Check your connection and retry.',
      retryable: true,
    });
  }, [loadingState.error]);

  useEffect(() => {
    if (!loadingState.ready || !loadingState.camera || resultRef.current?.detected) return;
    trackingTimeoutRef.current = window.setTimeout(() => {
      if (!resultRef.current?.detected) {
        setCriticalError({
          title: 'Hand not detected',
          message: 'Place your hand in the frame and move naturally, or retry the AR session.',
          retryable: true,
        });
      }
    }, TRACKING_TIMEOUT_MS);
    return () => {
      if (trackingTimeoutRef.current !== null) window.clearTimeout(trackingTimeoutRef.current);
    };
  }, [loadingState.camera, loadingState.ready, resultRef]);

  useEffect(() => {
    if (!isReady) {
      setHudVisible(false);
      return;
    }

    let missingSince: number | null = null;
    let rafId = 0;
    const monitor = () => {
      const result = resultRef.current;
      const confidence = result?.hands[0]?.confidence ?? 0;
      const tracked = Boolean(result?.detected && confidence >= 0.65);
      const now = performance.now();
      setSizeEstimate(estimateRingSizeFromPinch(result ?? null, videoRef.current));

      if (tracked) {
        missingSince = null;
        setHudVisible(false);
      } else {
        missingSince ??= now;
        setHudVisible(now - missingSince > SMART_HUD_DELAY_MS);
      }
      rafId = window.requestAnimationFrame(monitor);
    };
    rafId = window.requestAnimationFrame(monitor);
    return () => window.cancelAnimationFrame(rafId);
  }, [isReady, resultRef]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAR();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeAR]);

  // Callback ref: fires when the video element is attached to the DOM.
  // Sets videoReady=true so the orchestrator effect above can safely run.
  const videoCallbackRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    if (el) setVideoReady(true);
  }, []);

  if (diagnostics?.experience === 'quick-look') {
    return (
      <FallbackModal title="View in your space" onClose={closeAR}>
        <QuickLookViewer
          usdzUrl={QUICK_LOOK_USDZ_URL}
          previewImageUrl={QUICK_LOOK_PREVIEW_URL}
          productName={QUICK_LOOK_PRODUCT_NAME}
          realWorldDiameterMm={QUICK_LOOK_DIAMETER_MM}
          onDismiss={closeAR}
        />
        <p className="mt-4 text-center text-sm text-white/65">iOS Quick Look opens a private, on-device AR preview with no camera upload.</p>
      </FallbackModal>
    );
  }

  if (diagnostics?.experience === 'webxr') {
    return <WebXRScene manager={webxrAdapter.manager} onClose={closeAR} />;
  }

  if (diagnostics?.experience === 'interactive-3d') {
    return (
      <FallbackModal title="Interactive 3D preview" onClose={closeAR}>
        <div className="h-72 w-full" aria-label={`Interactive model of ${QUICK_LOOK_PRODUCT_NAME}`}>
          <Fallback3DViewer ringModelUrl={ringModelUrlForQuality('LOW')} fallbackReason="DEVICE_UNSUPPORTED" />
        </div>
        <p className="mt-4 text-center text-sm text-white/65">Camera AR is unavailable. Drag the model to inspect the ring from every angle.</p>
      </FallbackModal>
    );
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black text-white antialiased"
      role="dialog"
      aria-modal="true"
      aria-label="WebAR jewelry try-on"
    >
      <div className="relative h-full w-full max-w-[480px] overflow-hidden bg-black" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {/* videoCallbackRef fires when the element mounts, unblocking orchestrator.start() */}
        <video
          ref={videoCallbackRef}
          className="absolute inset-0 z-0 h-full w-full object-cover"
          style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)' }}
          aria-label="Local camera preview for virtual ring try-on"
          playsInline
          muted
          autoPlay
        />

        <WebGPUScene
          resultRef={resultRef}
          videoRef={videoRef}
          facingMode={facingMode}
          onMount={markLoaded}
          ambientLight={ambientLight}
        />

        <div className="pointer-events-none absolute inset-x-4 top-[calc(env(safe-area-inset-top)+1rem)] z-20 flex items-start justify-between gap-3">
          {cameraIsReady && (
            <button
              onClick={() => switchCamera(facingMode === 'user' ? 'environment' : 'user')}
              disabled={cameraState === 'SWITCHING'}
              className="pointer-events-auto min-h-12 min-w-12 rounded-full border border-white/15 bg-black/45 px-4 text-lg font-semibold backdrop-blur-xl transition active:bg-[#D5FD50] active:text-black disabled:opacity-50"
              aria-label={`Switch to ${facingMode === 'user' ? 'rear' : 'front'} camera`}
              title="Switch camera"
            >
              {cameraState === 'SWITCHING' ? '⟳' : '⇄'}
            </button>
          )}
          <button
            onClick={closeAR}
            className="pointer-events-auto ml-auto min-h-12 min-w-12 rounded-full border border-white/15 bg-black/45 text-xl font-light backdrop-blur-xl transition active:bg-[#D5FD50] active:text-black"
            aria-label="Close AR try-on"
          >
            ×
          </button>
        </div>

        {isReady && <GuidanceOverlay ambientLight={ambientLight} />}
        {isReady && <ARControls confidence={resultRef.current?.hands[0]?.confidence ?? 0} sizeEstimate={sizeEstimate} />}
        {isReady && hudVisible && <SmartHud />}
        {!experienceRequested && !criticalError && <StartExperienceOverlay ready={videoReady} metricValidated={metricSizingEnabled()} onStart={startExperience} />}
        {experienceRequested && !isReady && !criticalError && <LoadingOverlay progress={combinedProgress} hasCamera={loadingState.camera} />}
        {criticalError && <RecoveryOverlay error={criticalError} onRetry={retryExperience} onClose={closeAR} />}
      </div>
    </div>
  );
}

function FallbackModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div ref={useDialogFocus()} className="fixed inset-0 z-50 flex items-center justify-center bg-black text-white antialiased" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="relative flex w-full max-w-sm flex-col items-center rounded-[2rem] border border-white/10 bg-neutral-950 p-6 shadow-2xl">
        <button onClick={onClose} className="absolute right-4 top-4 min-h-10 min-w-10 rounded-full border border-white/15 text-xl font-light" aria-label="Close AR try-on">
          ×
        </button>
        <p className="mb-4 text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">{title}</p>
        {children}
      </div>
    </div>
  );
}

function useDialogFocus(): React.RefObject<HTMLDivElement> {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  useEffect(() => dialogRef.current ? containModalFocus(dialogRef.current, previous.current) : undefined, []);
  return dialogRef;
}

function GuidanceOverlay({ ambientLight }: { ambientLight: ReturnType<typeof useAmbientLightAdapter> }) {
  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-[calc(env(safe-area-inset-bottom)+2rem)] z-20 rounded-3xl border border-white/10 bg-black/35 px-5 py-4 text-center backdrop-blur-xl">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">Live try-on</p>
      <p className="mt-2 text-lg font-light tracking-[-0.02em]">Place your ring finger flat in frame.</p>
      <p className="mt-1 text-sm text-white/70">Light matched at {ambientLight.colorTemperature}K · camera processed locally.</p>
    </div>
  );
}

function SmartHud() {
  return (
    <div className="pointer-events-none absolute inset-6 z-20 flex items-center justify-center rounded-[2rem] border border-[#D5FD50]/70 bg-black/20 text-center shadow-[0_0_40px_rgba(213,253,80,0.16)] backdrop-blur-[2px]" aria-live="polite">
      <div className="rounded-full border border-[#D5FD50]/40 bg-black/55 px-5 py-3">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">Tracking paused</p>
        <p className="mt-1 text-sm text-white/80">Return your hand to the frame.</p>
      </div>
    </div>
  );
}

function StartExperienceOverlay({ ready, metricValidated, onStart }: { ready: boolean; metricValidated: boolean; onStart: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/90 px-6 text-center backdrop-blur-md">
      <div className="w-full max-w-sm rounded-[2rem] border border-white/10 bg-neutral-950/95 p-6 shadow-2xl">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">Private AR try-on</p>
        <h2 className="mt-3 text-2xl font-light tracking-[-0.04em]">Try the ring in AR</h2>
        <p className="mt-3 text-sm leading-6 text-white/70">Camera frames stay on this device. Tap once to start the best AR mode supported by your browser.</p>
        {!metricValidated && <p className="mt-2 text-xs leading-5 text-white/50">Visual placement only — do not use this preview as an exact ring-size measurement.</p>}
        <button
          type="button"
          onClick={onStart}
          disabled={!ready}
          className="mt-6 min-h-12 w-full rounded-full bg-[#D5FD50] px-5 font-semibold text-black transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Start AR try-on"
        >
          {ready ? 'Start AR try-on' : 'Preparing preview…'}
        </button>
      </div>
    </div>
  );
}

function LoadingOverlay({ progress, hasCamera }: { progress: number; hasCamera: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-black/85 px-8 text-center backdrop-blur-sm" aria-live="polite">
      <div className="h-12 w-12 rounded-full border-2 border-white/15 border-t-[#D5FD50] animate-spin" aria-hidden="true" />
      <div>
        <p className="text-xl font-light tracking-[-0.03em]">Preparing your private AR preview</p>
        <p className="mt-2 text-sm text-white/60">
          {!hasCamera ? 'Allow camera access to begin.' : progress < 90 ? 'Loading hand tracking securely on-device.' : 'Place your hand in the frame.'}
        </p>
      </div>
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-white/15" aria-label={`Loading ${progress}%`}>
        <div className="h-full rounded-full bg-[#D5FD50] transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function RecoveryOverlay({ error, onRetry, onClose }: { error: CriticalError; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/88 px-6 backdrop-blur-md" role="alertdialog" aria-label={error.title}>
      <div className="w-full max-w-sm rounded-[2rem] border border-white/10 bg-neutral-950/95 p-6 text-center shadow-2xl">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">Try-on paused</p>
        <h2 className="mt-3 text-2xl font-light tracking-[-0.04em]">{error.title}</h2>
        <p className="mt-3 text-sm leading-6 text-white/70">{error.message}</p>
        <div className="mt-6 flex flex-col gap-3">
          {error.retryable && (
            <button onClick={onRetry} className="min-h-12 rounded-full bg-[#D5FD50] px-5 font-semibold text-black transition active:scale-[0.98]" aria-label="Retry AR try-on">
              Retry
            </button>
          )}
          <button onClick={onClose} className="min-h-12 rounded-full border border-white/15 px-5 font-semibold text-white transition active:bg-[#D5FD50] active:text-black" aria-label="Close AR try-on">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
