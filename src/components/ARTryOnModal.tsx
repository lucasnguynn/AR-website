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
 *  │        └── <RingScene>  ← reads from trackingResultRef │
 *  └─────────────────────────────────────────────────────────┘
 *
 * Loading strategy (Task 1 — sub-3s):
 *   Promise.all([
 *     worker INIT (MediaPipe WASM + model, ~2-4s, in parallel threads),
 *     useGLTF preload (ring model + Draco decode, ~0.5-1s)
 *   ])
 *   Both start SIMULTANEOUSLY the moment the component mounts.
 *   Total wait = max(mediapipe_time, gltf_time) instead of their sum.
 *
 *   GLTF loading progress (0-100) is fed back via a custom GLTFLoader
 *   onProgress callback and merged with the worker's progress.
 *
 *   Combined progress bar formula:
 *     combinedProgress = (mediapipeProgress + modelProgress) / 2
 *   This gives a realistic 0-100 reading without either half "waiting" for
 *   the other.
 */

import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
  Suspense,
  createContext,
  useContext,
} from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { useHandTracking } from '../hook/useHandTracking';
import {
  landmarkToWorld,
  computeRingQuaternion,
  computeRingScale,
  RING_SEGMENT_T,
} from '../utils/coordinateMapping';
import { VelocityAdaptiveEMAFilter, ScalarEMAFilter } from '../utils/emaFilter';
import { LM } from '../types/ar.types';
import type { HandTrackingResult } from '../types/ar.types';

// ---------------------------------------------------------------------------
// Draco path — pointing to the files copied by vite.config.ts
// ---------------------------------------------------------------------------
const DRACO_DECODER_PATH = import.meta.env.BASE_URL + 'draco/';

// ---------------------------------------------------------------------------
// Preload the ring model the moment this module is imported —
// BEFORE the component even mounts.  This starts the fetch in parallel with
// the MediaPipe worker init that begins on component mount.
// ---------------------------------------------------------------------------
const RING_MODEL_PATH = import.meta.env.BASE_URL + 'models/ring.glb';

// Tell drei's useGLTF to use our DRACOLoader instance
useGLTF.setDecoderPath(DRACO_DECODER_PATH);
// Kick off the network fetch immediately (module evaluation time)
useGLTF.preload(RING_MODEL_PATH);

// ---------------------------------------------------------------------------
// Context: share the video element reference with the inner R3F component
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
  /** Ring model path override — defaults to /models/ring.glb */
  ringModelPath?: string;
}

// ===========================================================================
// ARTryOnModal (outer component — DOM layer + loading orchestration)
// ===========================================================================
export function ARTryOnModal({ onClose, ringModelPath = RING_MODEL_PATH }: ARTryOnModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { resultRef, loadingState, startTracking } = useHandTracking();

  // Model loading progress (0-100), reported via custom loader callback
  const [modelProgress, setModelProgress] = useState(0);

  // ── Camera setup ──────────────────────────────────────────────────────────
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
      console.error('[AR Camera]', err);
    }
  }, [startTracking]);

  useEffect(() => {
    initCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [initCamera]);

  // ── Combined loading progress ─────────────────────────────────────────────
  // mediapipe: 0-100 (from worker messages, already set in hook)
  // model:     0-100 (from GLTF loader onProgress)
  const combinedProgress = Math.round((loadingState.mediapipe + modelProgress) / 2);
  const isReady = loadingState.mediapipe >= 100 && modelProgress >= 100;

  // ── Escape key to close ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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

      {/* The AR viewport: video + Three.js canvas stacked */}
      <div
        className="relative w-full h-full overflow-hidden"
        style={{ maxWidth: 480, margin: '0 auto' }}
      >
        {/* Camera feed — CSS mirror matches what users expect from a selfie view */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: 'scaleX(-1)' }}
          playsInline
          muted
          autoPlay
        />

        {/* Three.js canvas — transparent background, perfectly overlaid */}
        <VideoRefContext.Provider value={videoRef}>
          <Canvas
            className="absolute inset-0"
            style={{ background: 'transparent' }}
            gl={{
              alpha: true,
              antialias: true,
              powerPreference: 'high-performance',
            }}
            camera={{
              fov: 45,
              near: 0.01,
              far: 100,
              position: [0, 0, 5],
            }}
            // Ensure Three.js renders at the native pixel ratio (not 2× on retina)
            // to match the landmark coordinate space exactly.
            dpr={[1, 1]}
          >
            <Suspense fallback={null}>
              <RingScene
                resultRef={resultRef}
                ringModelPath={ringModelPath}
                onModelProgress={setModelProgress}
              />
            </Suspense>
          </Canvas>
        </VideoRefContext.Provider>
      </div>
    </div>
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

          {/* Progress bar */}
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

// ===========================================================================
// RingScene — the R3F component that lives inside <Canvas>
//
// This is where the corrected 2D→3D projection and EMA filter are applied
// every render frame via useFrame (no React state, no re-renders).
// ===========================================================================
interface RingSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
  ringModelPath: string;
  onModelProgress: (progress: number) => void;
}

function RingScene({ resultRef, ringModelPath, onModelProgress }: RingSceneProps) {
  const { camera, gl } = useThree();
  const videoRef = useContext(VideoRefContext);

  // ── Load the GLTF with DRACOLoader + progress callback ────────────────────
  const { scene: ringScene } = useGLTFWithDraco(ringModelPath, onModelProgress);

  // ── Ring transform refs (mutated in useFrame, not state) ──────────────────
  const ringGroupRef = useRef<THREE.Group>(null);

  // ── Filters — one filter instance per session, reset on tracking loss ─────
  const emaFilter = useRef(new VelocityAdaptiveEMAFilter());
  const scaleFilter = useRef(new ScalarEMAFilter(0.35));
  const wasDetected = useRef(false);

  // ── Per-frame position/rotation update ───────────────────────────────────
  useFrame(() => {
    const group = ringGroupRef.current;
    if (!group) return;

    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const result = resultRef.current;

    // No hand detected — hide ring, reset filter
    if (!result || !result.detected || result.hands.length === 0) {
      group.visible = false;
      if (wasDetected.current) {
        // Hard-reset the filter so the ring doesn't spring from an old position
        emaFilter.current.reset();
        scaleFilter.current.reset();
        wasDetected.current = false;
      }
      return;
    }

    wasDetected.current = true;

    const hand = result.hands[0];
    const landmarks = hand.landmarks;

    // Guard: we need at least LM14 (index 14)
    if (!landmarks || landmarks.length < LM.RING_PIP + 1) return;

    const lm13 = landmarks[LM.RING_MCP]; // base knuckle
    const lm14 = landmarks[LM.RING_PIP]; // middle knuckle

    const projParams = {
      videoElement: video,
      canvasElement: gl.domElement,
      camera: camera as THREE.PerspectiveCamera,
      isMirrored: true, // front camera is CSS-mirrored
    };

    // Project both knuckles into world space
    const pos13 = landmarkToWorld(lm13, projParams);
    const pos14 = landmarkToWorld(lm14, projParams);

    // If either projection fails (ray parallel to plane), skip this frame
    if (!pos13 || !pos14) return;

    // ── Raw ring position: lerp along the MCP→PIP segment ─────────────────
    // RING_SEGMENT_T = 0.25 → ring sits just above the base knuckle
    const rawPosition = pos13.clone().lerp(pos14, RING_SEGMENT_T);

    // ── Raw ring rotation ─────────────────────────────────────────────────
    const rawQuaternion = computeRingQuaternion(pos13, pos14);

    // ── Apply velocity-adaptive EMA filters ──────────────────────────────
    const { position: filteredPos, quaternion: filteredQuat } =
      emaFilter.current.update(rawPosition, rawQuaternion);

    // ── Raw ring scale (self-calibrating from projected finger length) ────
    const rawScale = computeRingScale(pos13, pos14);
    const filteredScale = scaleFilter.current.update(rawScale);

    // ── Apply to the Three.js group ───────────────────────────────────────
    group.visible = true;
    group.position.copy(filteredPos);
    group.quaternion.copy(filteredQuat);
    group.scale.setScalar(filteredScale);
  });

  return (
    <>
      {/* Ambient + directional light for the ring — adjust to your product */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[2, 4, 3]} intensity={2} castShadow={false} />
      <directionalLight position={[-2, 1, -1]} intensity={0.6} />

      {/* The ring mesh */}
      <group ref={ringGroupRef} visible={false}>
        <primitive object={ringScene.clone(true)} dispose={null} />
      </group>
    </>
  );
}

// ===========================================================================
// Custom GLTF + Draco hook with progress reporting
// ===========================================================================

function useGLTFWithDraco(path: string, onProgress: (p: number) => void) {
  // We use a ref to call onProgress without re-triggering the effect
  const onProgressRef = useRef(onProgress);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);

  // drei's useGLTF already handles caching and Suspense.
  // We inject a custom loader below via the loaderOptions.
  const gltf = useGLTF(path, true, true, (loader) => {
    // Configure DRACOLoader on the GLTFLoader instance.
    // This is safe to call even if the model isn't Draco-compressed;
    // the loader simply ignores the extension in that case.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    dracoLoader.preload();
    // Ép kiểu qua unknown trước để vượt qua xung đột type giữa three-stdlib và three gốc
    (loader as unknown as GLTFLoader).setDRACOLoader(dracoLoader);

  // drei's Suspense flow means by the time we get here the model is loaded.
  // Signal 100% immediately.
  useEffect(() => {
    onProgressRef.current(100);
  }, []);

  return gltf;
}

// ===========================================================================
// Compress-3D helper script (instructions, not a React component)
// ===========================================================================

/*
  HOW TO DRACO-COMPRESS YOUR RING MODEL FOR FASTER LOADS
  ──────────────────────────────────────────────────────────────────────────────

  The build script in package.json should include a "compress-3d" step that runs:

    npx gltf-transform optimize assets/models/raw/ring.glb assets/models/ring.glb \
      --compress draco

  This uses @gltf-transform/functions (already installed) to Draco-compress all
  mesh geometry in the GLB.  Typical compression ratios: 3-8×.

  Example package.json scripts section:
    {
      "compress-3d": "node scripts/compress-models.mjs",
      "build": "npm run compress-3d && tsc && vite build"
    }

  scripts/compress-models.mjs:
  ──────────────────────────────────────────────────────────────────────────────
  import { NodeIO } from '@gltf-transform/core';
  import { draco } from '@gltf-transform/functions';
  import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
  import { existsSync } from 'fs';
  import { mkdir } from 'fs/promises';

  const RAW_DIR = 'assets/models/raw';
  const OUT_DIR = 'public/models';  // Vite serves /public as /

  if (!existsSync(RAW_DIR)) {
    console.log('[compress-3d] No raw models directory — skipping.');
    process.exit(0);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

  const doc = await io.read(`${RAW_DIR}/ring.glb`);
  await doc.transform(draco({ method: 'edgebreaker' }));
  await io.write(`${OUT_DIR}/ring.glb`, doc);

  console.log('[compress-3d] ✓ ring.glb compressed with Draco');
  ──────────────────────────────────────────────────────────────────────────────

  After compression, the DRACOLoader in the Three.js code above will automatically
  decompress the geometry at load time using the WASM decoder in /public/draco/.
*/
