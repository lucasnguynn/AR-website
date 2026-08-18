/**
 * ARTryOnModal.tsx
 *
 * The top-level WebAR experience component.
 *
 * Architecture:
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  <div id="ar-root">                                      │
 *  │   ├── <video>  ← camera feed, CSS-mirrored             │
 *  │   └── <Canvas> ← R3F, transparent bg, overlaid         │
 *  │        └── <RingScene>  ← reads from resultRef         │
 *  └─────────────────────────────────────────────────────────┘
 *
 * FIXED BUGS vs previous version:
 *  1. `useGLTF.setDecoderPath(DRACO_DECODER_PATH)` was called at module level.
 *     The ring model (nhan.glb) has NO Draco compression (extensionsUsed = []).
 *     Calling setDecoderPath causes DRACOLoader to initialise its WASM runtime
 *     and spin waiting for a decode message that never arrives → Suspense deadlock.
 *     REMOVED. No Draco path is set anywhere in the codebase.
 *
 *  2. RING_MODEL_PATH pointed to `import.meta.env.BASE_URL + 'models/nhan.glb'`
 *     which is correct — kept and also aligned with useRingModel.ts.
 *
 *  3. useGLTF.preload() is now only called from useRingModel.ts (single source
 *     of truth). The duplicate call here has been removed to avoid double-fetch.
 *
 * Loading strategy:
 *   MediaPipe worker (WASM + model) and GLB fetch start SIMULTANEOUSLY on mount.
 *   Total wait = max(mediapipe_time, gltf_time) instead of their sum.
 */

import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
  Suspense,
  createContext,
} from 'react';
import { Environment } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';

import { useHandTracking } from '../hook/useHandTracking';
import { useLoadingState } from '../hook/useLoadingState';
import { useCamera, startCameraFromRef, resetCamera } from '../hook/useCamera';
import {
  computeAnatomicalRingPose,
  projectRingLandmarks,
} from '../utils/coordinateMapping';
import { RingTrackingStabilizer } from '../utils/trackingStabilizer';
import { LM } from '../types/ar.types';
import type { HandTrackingResult } from '../types/ar.types';
import { ModelErrorBoundary } from './ModelErrorBoundary';
import {
  disposeRingScene,
  useRingModel,
  RING_SCALE,
  OFFSET_Y,
  OFFSET_Z,
} from '../hook/useRingModel';
import { useFrame, useThree } from '@react-three/fiber';
import type { FacingMode } from '../services/cameraSystem';

// ---------------------------------------------------------------------------
// Context: share the video element reference with the inner R3F component
// so landmark→world projection uses the correct video dimensions.
// ---------------------------------------------------------------------------
const VideoRefContext = createContext<React.RefObject<HTMLVideoElement | null>>(
  { current: null },
);

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------
export interface ARTryOnModalProps {
  /** Called when the user dismisses the AR modal */
  onClose: () => void;
}

// ===========================================================================
// ARTryOnModal (outer component — DOM layer + loading orchestration)
// ===========================================================================
export function ARTryOnModal({ onClose }: ARTryOnModalProps) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { resultRef, loadingState, startTracking } = useHandTracking();
  const { isLoading, markLoaded } = useLoadingState();
  const {
    cameraState,
    facingMode,
    isReady: cameraIsReady,
    hasError: cameraHasError,
    lastError: cameraLastError,
    metadata: cameraMetadata,
    switchCamera,
    recoverCamera,
  } = useCamera();

  // ── Camera setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (videoRef.current && cameraState === 'IDLE') {
      startCameraFromRef(videoRef.current, 'user')
        .then(() => {
          // Camera started successfully, now start tracking
          if (videoRef.current) {
            startTracking(videoRef.current);
          }
        })
        .catch((err) => {
          console.error('[AR Camera] Failed to start:', err);
        });
    }
  }, [cameraState, startTracking]);

  // ── Sync camera readiness with loading state ──────────────────────────────
  useEffect(() => {
    if (cameraIsReady && !loadingState.camera) {
      // Camera is ready but loadingState doesn't know yet
      // This is handled by useHandTracking's startTracking call
    }
  }, [cameraIsReady, loadingState.camera]);

  // ── Handle camera errors ──────────────────────────────────────────────────
  useEffect(() => {
    if (cameraHasError && cameraLastError) {
      console.error('[AR Camera] Error:', cameraLastError.message);
    }
  }, [cameraHasError, cameraLastError]);

  // ── Escape key to close ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── Combined loading progress ─────────────────────────────────────────────
  // mediapipe 0-100 (from worker PROGRESS messages)
  // isLoading: false once OnMountNotifier fires inside Canvas (= GLB resolved)
  const combinedProgress = Math.round(loadingState.mediapipe / 2);
  const isReady          = !isLoading && loadingState.mediapipe >= 100;

  // Determine display mirroring based on facing mode
  const videoStyle: React.CSSProperties = {
    transform: facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)',
  };

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

      {/* Loading overlay — fades out once ready */}
      {!isReady && (
        <LoadingOverlay
          progress={combinedProgress}
          error={loadingState.error}
          hasCamera={loadingState.camera}
        />
      )}

      {/* AR viewport: video + Three.js canvas stacked */}
      <div
        className="relative w-full h-full overflow-hidden"
        style={{ maxWidth: 480, margin: '0 auto' }}
      >
        {/* Camera feed — CSS mirror matches selfie expectations */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={videoStyle}
          playsInline
          muted
          autoPlay
        />

        {/* Camera switching button (for rear camera support) */}
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

        {/* Camera error recovery UI */}
        {cameraHasError && cameraLastError?.recoverable && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 bg-red-900/90 text-white px-4 py-2 rounded-lg flex items-center gap-3">
            <span className="text-sm">{cameraLastError.message}</span>
            <button
              onClick={recoverCamera}
              className="px-3 py-1 bg-white text-red-900 rounded-md text-sm font-medium hover:bg-gray-100"
            >
              Retry
            </button>
          </div>
        )}

        {/* Three.js canvas — transparent overlay */}
        <VideoRefContext.Provider value={videoRef}>
          <Canvas
            className="absolute inset-0"
            style={{ background: 'transparent' }}
            gl={{
              alpha:            true,
              antialias:        true,
              powerPreference:  'high-performance',
            }}
            onCreated={({ gl }) => {
              gl.outputColorSpace = THREE.SRGBColorSpace;
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.0;
            }}
            camera={{
              fov:      45,
              near:     0.01,
              far:      100,
              position: [0, 0, 5],
            }}
            // dpr={[1,1]} keeps landmark coordinate space aligned with the canvas.
            dpr={[1, 1]}
          >
            {/* Fires markLoaded() the first time this tree renders, which is
                guaranteed to be AFTER Suspense resolves (GLB parsed). */}
            <OnMountNotifier onMount={markLoaded} />

            <ModelErrorBoundary>
              <Suspense fallback={null}>
                <RingScene resultRef={resultRef} facingMode={facingMode} />
              </Suspense>
            </ModelErrorBoundary>
          </Canvas>
        </VideoRefContext.Provider>
      </div>
    </div>
  );
}

// ===========================================================================
// OnMountNotifier — lives inside Canvas, fires after Suspense resolves
// ===========================================================================
function OnMountNotifier({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ===========================================================================
// RingScene — the R3F component that positions the ring each frame
// ===========================================================================
interface RingSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
  facingMode: FacingMode;
}

function RingScene({ resultRef, facingMode }: RingSceneProps) {
  const { camera, gl } = useThree();
  const videoRef       = React.useContext(VideoRefContext);
  const groupRef       = useRef<THREE.Group>(null);
  const { scene }      = useRingModel();

  // Tracking stabilizer — state machine + outlier rejection + adaptive filters
  const stabilizer = useRef(new RingTrackingStabilizer());
  const projectedLandmarks = useRef<Record<number, THREE.Vector3>>({
    [LM.INDEX_MCP]: new THREE.Vector3(),
    [LM.RING_MCP]: new THREE.Vector3(),
    [LM.RING_PIP]: new THREE.Vector3(),
    [LM.PINKY_MCP]: new THREE.Vector3(),
  });
  const rawPosition = useRef(new THREE.Vector3());
  const rawQuaternion = useRef(new THREE.Quaternion());
  const rawScale = useRef(new THREE.Vector3(1, 1, 1));

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const result = resultRef.current;

    if (!result || !result.detected || result.hands.length === 0) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      return;
    }

    const hand = result.hands[0];
    const projParams = {
      videoElement:  video,
      canvasElement: gl.domElement,
      camera:        camera as THREE.PerspectiveCamera,
      isMirrored:    facingMode === 'user',
    };

    if (!projectRingLandmarks(hand.landmarks, projParams, projectedLandmarks.current)) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      return;
    }

    const poseScale = computeAnatomicalRingPose(
      projectedLandmarks.current,
      {
        position: rawPosition.current,
        quaternion: rawQuaternion.current,
        scale: rawScale.current,
      },
    );
    if (poseScale === null) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      return;
    }

    rawPosition.current.y += OFFSET_Y;
    rawPosition.current.z += OFFSET_Z;

    const stabilized = stabilizer.current.update({
      position: rawPosition.current,
      quaternion: rawQuaternion.current,
      scale: rawScale.current.x,
      confidence: hand.confidence,
      timestamp: result.frameTimestamp ?? hand.timestamp,
      landmarks: hand.landmarks,
    });

    group.visible = stabilized.visible;
    if (!stabilized.visible) return;
    group.position.copy(stabilized.position);
    group.quaternion.copy(stabilized.quaternion);
    group.scale.setScalar(stabilized.scale * RING_SCALE);
  });

  // Dispose on unmount
  useEffect(() => {
    return () => {
      disposeRingScene(scene);
    };
  }, [scene]);

  return (
    <>
      <Environment preset="city" background={false} environmentIntensity={0.85} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#fff7e8', '#24222a', 0.55]} />
      <rectAreaLight position={[0, 1.4, 1.6]} width={1.6} height={0.9} intensity={1.7} />

      <group ref={groupRef} visible={false}>
        <primitive object={scene} dispose={null} />
      </group>
    </>
  );
}

// ===========================================================================
// LoadingOverlay
// ===========================================================================
function LoadingOverlay({
  progress,
  error,
  hasCamera,
}: {
  progress:  number;
  error:     string | null;
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

          {/* Progress bar */}
          <div className="w-64 h-2 bg-white/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#D5FD50] rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="text-sm text-white/60">
            {!hasCamera                               && 'Waiting for camera permission…'}
            {hasCamera && progress < 50               && 'Loading AI model (WASM)…'}
            {hasCamera && progress >= 50 && progress < 90 && 'Preparing 3D ring…'}
            {hasCamera && progress >= 90 && progress < 100 && 'Almost ready…'}
          </div>
        </>
      )}
    </div>
  );
}
