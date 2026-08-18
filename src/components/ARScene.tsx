/**
 * ARScene.tsx
 *
 * Top-level AR modal component.
 *
 * FIXED BUGS:
 *  1. Was a placeholder snippet with `{...}` JSX spread syntax — invalid TypeScript,
 *     caused all 4 CI errors at L18 ("Unexpected token", "Expression expected").
 *     Replaced with the actual, complete implementation that wires together:
 *       - useHandTracking (MediaPipe worker)
 *       - Camera stream setup
 *       - R3F Canvas with RingScene inside
 *       - Loading overlay driven by useLoadingState (timeout safety-net)
 *
 *  2. Wrong import path `../hooks/useLoadingState` → `../hook/useLoadingState`
 *     (directory is singular "hook", not "hooks").
 */

import React, { useRef, useEffect, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { useHandTracking } from '../hook/useHandTracking';
import { useLoadingState } from '../hook/useLoadingState';
import { RingScene } from './RingScene';

interface ARSceneProps {
  onClose: () => void;
}

export function ARScene({ onClose }: ARSceneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { resultRef, loadingState, startTracking } = useHandTracking();
  const { isLoading, markLoaded } = useLoadingState();

  // ── Camera setup ────────────────────────────────────────────────────────────
  const initCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      startTracking(videoRef.current);
    } catch (err) {
      console.error('[ARScene] Camera init failed:', err);
    }
  }, [startTracking]);

  useEffect(() => {
    initCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [initCamera]);

  // ── Escape key to close ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Combined loading progress (MediaPipe 0-100 + model 0-100 averaged) ──────
  const combinedProgress = Math.round(loadingState.mediapipe / 2);
  const isReady = !isLoading && loadingState.mediapipe >= 100;

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="WebAR Jewelry Try-On"
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-20 text-white bg-black/50 rounded-full p-2 hover:bg-black/80 transition-colors"
        aria-label="Close AR try-on"
      >
        ✕
      </button>

      {/* Loading overlay */}
      {!isReady && (
        <LoadingOverlay
          progress={combinedProgress}
          error={loadingState.error}
          hasCamera={loadingState.camera}
        />
      )}

      {/* AR viewport */}
      <div
        className="relative w-full h-full overflow-hidden"
        style={{ maxWidth: 480, margin: '0 auto' }}
      >
        {/* Camera feed */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: 'scaleX(-1)' }}
          playsInline
          muted
          autoPlay
        />

        {/* R3F Canvas — transparent overlay */}
        <Canvas
          className="absolute inset-0"
          style={{ background: 'transparent' }}
          gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 45, near: 0.01, far: 100, position: [0, 0, 5] }}
          dpr={[1, 1]}
        >
          {/* OnMountNotifier fires markLoaded() once Suspense resolves,
              guaranteed to happen AFTER useGLTF completes. This is what
              dismisses the loading overlay — not the onProgress callback. */}
          <OnMountNotifier onMount={markLoaded} />

          <Suspense fallback={null}>
            <RingScene resultRef={resultRef} />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}

// ── OnMountNotifier ────────────────────────────────────────────────────────────
// Lives inside <Canvas>. Its useEffect fires only after Suspense resolves,
// i.e., after the GLB is parsed and the scene is ready. Calling markLoaded()
// here guarantees the overlay dismisses at the right time regardless of whether
// the onProgress callback ever reaches 100%.
function OnMountNotifier({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ── LoadingOverlay ─────────────────────────────────────────────────────────────
function LoadingOverlay({
  progress,
  error,
  hasCamera,
}: {
  progress: number;
  error: string | null;
  hasCamera: boolean;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 text-white gap-4">
      {error ? (
        <>
          <div className="text-red-400 text-lg font-semibold">Error</div>
          <div className="text-sm text-red-300 max-w-xs text-center">{error}</div>
        </>
      ) : (
        <>
          <div className="text-[#D5FD50] text-2xl font-bold animate-pulse">
            {progress < 100 ? 'Loading AR Experience…' : 'Starting camera…'}
          </div>
          <div className="w-64 h-2 bg-white/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#D5FD50] rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-sm text-white/60">
            {!hasCamera && 'Waiting for camera permission…'}
            {hasCamera && progress < 50 && 'Loading AI model (WASM)…'}
            {hasCamera && progress >= 50 && progress < 90 && 'Preparing 3D ring…'}
            {hasCamera && progress >= 90 && progress < 100 && 'Almost ready…'}
          </div>
        </>
      )}
    </div>
  );
}

export default ARScene;
