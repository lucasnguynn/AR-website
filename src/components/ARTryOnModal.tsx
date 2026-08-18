/**
 * ARTryOnModal.tsx
 *
 * Top-level WebAR experience. This file is intentionally lazy-imported by
 * App.tsx, so no Three.js, R3F, MediaPipe worker, WASM, or GLB model request is
 * made during the storefront's initial load. Those assets start only after the
 * user opens the TRY ON modal and this component mounts.
 */

import React, { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';

import { useCamera, startCameraFromRef, resetCamera } from '../hook/useCamera';
import { useHandTracking } from '../hook/useHandTracking';
import { useLoadingState } from '../hook/useLoadingState';
import { RingScene } from './RingScene';

export interface ARTryOnModalProps {
  onClose: () => void;
}

export function ARTryOnModal({ onClose }: ARTryOnModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { resultRef, loadingState, startTracking, setActive } = useHandTracking();
  const { isLoading, markLoaded } = useLoadingState();
  const {
    cameraState,
    facingMode,
    isReady: cameraIsReady,
    hasError: cameraHasError,
    lastError: cameraLastError,
    switchCamera,
    recoverCamera,
  } = useCamera();

  const adaptiveDpr = useMemo<[number, number]>(() => {
    return [1, Math.min(window.devicePixelRatio, 1.75)];
  }, []);

  useEffect(() => {
    setActive(true);
    return () => {
      setActive(false);
      resetCamera();
    };
  }, [setActive]);

  useEffect(() => {
    if (videoRef.current && cameraState === 'IDLE') {
      startCameraFromRef(videoRef.current, 'user')
        .then(() => {
          if (videoRef.current) startTracking(videoRef.current);
        })
        .catch((err) => {
          console.error('[AR Camera] Failed to start:', err);
        });
    }
  }, [cameraState, startTracking]);

  useEffect(() => {
    if (cameraHasError && cameraLastError) {
      console.error('[AR Camera] Error:', cameraLastError.message);
    }
  }, [cameraHasError, cameraLastError]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const combinedProgress = Math.min(
    100,
    Math.round(loadingState.mediapipe * 0.7 + (isLoading ? 0 : 30)),
  );
  const isReady = !isLoading && loadingState.mediapipe >= 100 && loadingState.camera;

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="WebAR Jewelry Try-On"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-20 text-white bg-black/50 rounded-full p-2 hover:bg-black/80 transition-colors"
        aria-label="Close AR try-on"
      >
        ✕
      </button>

      {!isReady && (
        <LoadingOverlay
          progress={combinedProgress}
          error={loadingState.error}
          hasCamera={loadingState.camera}
        />
      )}

      <div className="relative w-full h-full overflow-hidden" style={{ maxWidth: 480, margin: '0 auto' }}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)' }}
          playsInline
          muted
          autoPlay
        />

        {cameraIsReady && (
          <button
            onClick={() => switchCamera(facingMode === 'user' ? 'environment' : 'user')}
            disabled={cameraState === 'SWITCHING'}
            className="absolute top-4 left-4 z-20 text-white bg-black/50 rounded-full p-2 hover:bg-black/80 transition-colors disabled:opacity-50"
            aria-label={`Switch to ${facingMode === 'user' ? 'rear' : 'front'} camera`}
            title="Switch camera"
          >
            {cameraState === 'SWITCHING' ? '⟳' : '⇄'}
          </button>
        )}

        {cameraHasError && cameraLastError?.recoverable && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 bg-red-900/90 text-white px-4 py-2 rounded-lg flex items-center gap-3">
            <span className="text-sm">{cameraLastError.message}</span>
            <button
              onClick={recoverCamera}
              className="px-3 py-1 bg-[#D5FD50] text-black rounded-md text-sm font-medium hover:bg-[#c0e840]"
            >
              Retry
            </button>
          </div>
        )}

        <Canvas
          className="absolute inset-0"
          style={{ background: 'transparent' }}
          gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.0;
          }}
          camera={{ fov: 45, near: 0.01, far: 100, position: [0, 0, 5] }}
          dpr={adaptiveDpr}
        >
          <OnMountNotifier onMount={markLoaded} />
          <Suspense fallback={null}>
            <RingScene resultRef={resultRef} videoRef={videoRef} facingMode={facingMode} />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}

function OnMountNotifier({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return null;
}

function LoadingOverlay({ progress, error, hasCamera }: { progress: number; error: string | null; hasCamera: boolean }) {
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
            <div className="h-full bg-[#D5FD50] rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
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
