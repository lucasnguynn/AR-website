/**
 * RingScene.tsx
 *
 * R3F component that reads hand tracking results each frame via useFrame
 * and positions the ring on the detected finger.
 *
 * FIXED BUGS:
 *  1. Import path was `../hooks/useRingModel` (plural "hooks") but the
 *     directory is `../hook/useRingModel` (singular). This caused a
 *     module-not-found build error.
 *
 *  2. Props interface expected `fingerMidpoint` / `fingerRotation` (raw
 *     Three.js objects from a previous architecture), but ARScene now
 *     passes `resultRef` (the raw MediaPipe ref). Updated to accept
 *     `resultRef` and do the landmark → world projection internally,
 *     consistent with how ARTryOnModal.tsx's RingScene worked.
 */

import React, { Suspense, useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ModelErrorBoundary } from './ModelErrorBoundary';
import {
  disposeRingScene,
  useRingModel,
  OFFSET_Y,
  OFFSET_Z,
} from '../hook/useRingModel';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';
import { LM } from '../types/ar.types';
import {
  computeAnatomicalRingPose,
  projectRingLandmarks,
} from '../utils/coordinateMapping';
import { UKFPosePipeline } from '../tracking/PosePipeline';
import { useJewelryRenderingEnhancer } from './JewelryRenderingEnhancer';
import { WebXRDepthManager, type DepthOcclusionTier } from '../services/WebXRDepthManager';
import type { GemstoneQuality, RingRendererMode } from '../materials/ringMaterialStrategy';
import { AR_RUNTIME_CONFIG } from '../config/arRuntimeConfig';

const FINGER_OCCLUDER_RENDER_ORDER = -1;
const RING_RENDER_ORDER = 20;
const FINGER_OCCLUDER_DEBUG_COLOR = '#D5FD50';
const FINGER_OCCLUDER_RADIAL_SEGMENTS = 24;
const FINGER_OCCLUDER_RADIUS_FRACTION = 0.18;
const FINGER_OCCLUDER_HEIGHT_FRACTION = 1.18;
type MutableVideoMetrics = HTMLVideoElement & {
  videoWidth: number;
  videoHeight: number;
  clientWidth: number;
  clientHeight: number;
};

interface RingSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  facingMode?: 'user' | 'environment';
  enableWebGPUEnhancements?: boolean;
  ambientLight?: AmbientLightState;
  materialRendererMode?: RingRendererMode;
  gemstoneQuality?: GemstoneQuality;
  /** Fixed GLB LOD for the current session; do not swap assets on adaptive shader changes. */
  modelQuality?: GemstoneQuality;
  depthIntervalMs?: number;
  environmentQuality?: GemstoneQuality;
}

function CameraDepthOcclusion({ videoRef, tierRef, intervalMs = 100 }: { videoRef?: React.RefObject<HTMLVideoElement | null>; tierRef: React.MutableRefObject<DepthOcclusionTier>; intervalMs?: number }) {
  const { scene } = useThree();
  const pipeline = useMemo(() => new WebXRDepthManager({ modelUrl: AR_RUNTIME_CONFIG.assets.depthModel }), []);
  const enabled = AR_RUNTIME_CONFIG.features.monocularDepth;
  const intervalRef = useRef(Math.max(intervalMs, 66));

  useEffect(() => {
    intervalRef.current = Math.max(intervalMs, 66);
  }, [intervalMs]);

  // Pipeline ownership is independent from adaptive quality. Disposing it when
  // intervalMs changes permanently disables the memoized instance.
  useEffect(() => {
    scene.add(pipeline.occlusionProxy);
    void pipeline.start();
    return () => {
      pipeline.occlusionProxy.removeFromParent();
      pipeline.geometricProxy.removeFromParent();
      pipeline.dispose();
    };
  }, [pipeline, scene]);

  useEffect(() => {
    if (!enabled) {
      tierRef.current = 'geometric-proxy';
      return;
    }

    let cancelled = false;
    let lastCapture = 0;
    let inFlight = false;

    const capture = async () => {
      const video = videoRef?.current;
      const now = performance.now();
      if (cancelled || inFlight || now - lastCapture < intervalRef.current || !video
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !pipeline.canAcceptCameraFrame()) return;

      lastCapture = now;
      inFlight = true;
      const started = performance.now();
      try {
        const bitmap = await createImageBitmap(video);
        if (cancelled) { bitmap.close(); return; }
        pipeline.update({ cameraFrame: bitmap, captureMs: performance.now() - started });
        tierRef.current = pipeline.getTier();
      } catch {
        tierRef.current = 'geometric-proxy';
      } finally {
        inFlight = false;
      }
    };

    // A bounded timer is intentionally used instead of binding the effect to a
    // ref's current video node. React refs do not trigger effects when populated.
    const timer = window.setInterval(() => void capture(), 66);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, pipeline, tierRef, videoRef]);

  return null;
}

// ── RingMesh — inner component, renders only after useGLTF resolves ──────────
// Kept separate from the Suspense boundary so ErrorBoundary can catch
// suspension errors without unmounting the whole scene.
function RingMesh({ resultRef, videoRef, facingMode = 'user', enableWebGPUEnhancements = false, ambientLight, materialRendererMode = 'webgl', gemstoneQuality = 'HIGH', modelQuality = gemstoneQuality, depthIntervalMs = 100, environmentQuality = 'HIGH' }: RingSceneProps) {
  const { camera, gl } = useThree();
  const groupRef   = useRef<THREE.Group>(null);
  const debugBoxRef = useRef<THREE.Mesh>(null);
  const occluderRef = useRef<THREE.Mesh>(null);
  const depthTierRef = useRef<DepthOcclusionTier>('geometric-proxy');
  const { scene }  = useRingModel(undefined, { rendererMode: materialRendererMode, quality: gemstoneQuality, modelQuality, preset: 'silver' });
  useJewelryRenderingEnhancer({ enabled: enableWebGPUEnhancements, ringRoot: scene });

  const posePipeline = useRef(new UKFPosePipeline());
  const lastProjectedTimestamp = useRef<number | null>(null);
  const projectedLandmarks = useRef<Record<number, THREE.Vector3>>({
    [LM.INDEX_MCP]: new THREE.Vector3(),
    [LM.RING_MCP]: new THREE.Vector3(),
    [LM.RING_PIP]: new THREE.Vector3(),
    [LM.PINKY_MCP]: new THREE.Vector3(),
  });
  const rawPosition = useRef(new THREE.Vector3());
  const rawQuaternion = useRef(new THREE.Quaternion());
  const rawScale = useRef(new THREE.Vector3(1, 1, 1));
  const fallbackVideoRef = useRef({
    videoWidth: 1,
    videoHeight: 1,
    clientWidth: 1,
    clientHeight: 1,
  } as MutableVideoMetrics);
  const projectionParams = useRef({
    videoElement: fallbackVideoRef.current,
    canvasElement: null as unknown as HTMLCanvasElement,
    camera: camera as THREE.PerspectiveCamera,
    isMirrored: true,
  });

  // ── Per-frame ring positioning (mutated refs — no React state, no re-renders)
  useFrame(() => {
    const group = groupRef.current;
    const debugBox = debugBoxRef.current;
    const occluder = occluderRef.current;
    if (!group || !debugBox || !occluder) return;

    const canvas = gl.domElement;
    if (!canvas) return;

    const result = resultRef.current;

    const hand = result?.detected ? result.hands[0] : undefined;
    const sourceTimestamp = result?.frameTimestamp ?? hand?.timestamp ?? null;

    const actualVideo = videoRef?.current;
    const fallbackVideo = fallbackVideoRef.current;
    fallbackVideo.videoWidth = canvas.clientWidth || canvas.width;
    fallbackVideo.videoHeight = canvas.clientHeight || canvas.height;
    fallbackVideo.clientWidth = fallbackVideo.videoWidth;
    fallbackVideo.clientHeight = fallbackVideo.videoHeight;

    const projParams = projectionParams.current;
    projParams.videoElement = actualVideo && actualVideo.videoWidth > 0 ? actualVideo : fallbackVideo;
    projParams.canvasElement = canvas;
    projParams.camera = camera as THREE.PerspectiveCamera;
    projParams.isMirrored = facingMode === 'user';

    if (hand && sourceTimestamp !== null && sourceTimestamp !== lastProjectedTimestamp.current
      && projectRingLandmarks(hand.landmarks, projParams, projectedLandmarks.current)) {
      const poseScale = computeAnatomicalRingPose(projectedLandmarks.current, { position: rawPosition.current, quaternion: rawQuaternion.current, scale: rawScale.current });
      if (poseScale !== null) {
        rawPosition.current.y += OFFSET_Y;
        rawPosition.current.z += OFFSET_Z;
        posePipeline.current.ingest({
          sourceTimestamp,
          position: [rawPosition.current.x, rawPosition.current.y, rawPosition.current.z],
          quaternion: [rawQuaternion.current.x, rawQuaternion.current.y, rawQuaternion.current.z, rawQuaternion.current.w],
          scale: rawScale.current.x,
          scaleMode: 'visual-relative',
          confidence: hand.confidence,
        });
        lastProjectedTimestamp.current = sourceTimestamp;
      }
    }

    const pose = posePipeline.current.sample(performance.now());
    const visible = pose?.visible ?? false;
    group.visible = visible;
    occluder.visible = visible && depthTierRef.current === 'geometric-proxy';
    debugBox.visible = visible;
    if (!pose) return;

    const mcpToPip = projectedLandmarks.current[LM.RING_MCP].distanceTo(projectedLandmarks.current[LM.RING_PIP]);
    const occluderRadius = Math.max(mcpToPip * FINGER_OCCLUDER_RADIUS_FRACTION, 0.004);
    const occluderHeight = Math.max(mcpToPip * FINGER_OCCLUDER_HEIGHT_FRACTION, occluderRadius * 3);

    occluder.position.fromArray(pose.position);
    occluder.quaternion.fromArray(pose.quaternion);
    occluder.scale.set(occluderRadius * 2, occluderHeight, occluderRadius * 2);

    debugBox.position.fromArray(pose.position);
    debugBox.quaternion.fromArray(pose.quaternion);
    debugBox.scale.set(1, 1, 1);

    group.position.fromArray(pose.position);
    group.quaternion.fromArray(pose.quaternion);
    group.scale.setScalar(pose.scale);
  });

  // Dispose cloned geometry/materials on unmount to prevent GPU memory leaks.
  useEffect(() => {
    scene.traverse((object) => {
      object.renderOrder = RING_RENDER_ORDER;
    });

    return () => {
      posePipeline.current.reset();
      disposeRingScene(scene);
    };
  }, [scene]);

  return (
    <>
      <CameraDepthOcclusion videoRef={videoRef} tierRef={depthTierRef} intervalMs={depthIntervalMs} />
      <ambientLight intensity={0.22 + (ambientLight?.exposure ?? 1) * 0.12} color={ambientLight?.keyColor ?? '#fff7e8'} />
      <hemisphereLight args={[ambientLight?.keyColor ?? '#fff7e8', '#24222a', 0.55]} />
      <rectAreaLight position={[0, 1.4, 1.6]} width={1.6} height={0.9} intensity={1.25 + (ambientLight?.exposure ?? 1) * 0.45} color={ambientLight?.keyColor ?? '#fff7e8'} />
      {environmentQuality !== 'LOW' && <rectAreaLight position={[-1.2, -0.4, 0.8]} rotation={[0, Math.PI / 3, 0]} width={1.1} height={1.4} intensity={0.7} color="#dce8ff" />}

      {/* Ring mesh — hidden until a hand is detected */}
      <mesh ref={occluderRef} visible={false} renderOrder={FINGER_OCCLUDER_RENDER_ORDER} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 1, FINGER_OCCLUDER_RADIAL_SEGMENTS, 1, false]} />
        <meshBasicMaterial color={FINGER_OCCLUDER_DEBUG_COLOR} colorWrite={false} depthWrite={true} depthTest={true} />
      </mesh>

      {import.meta.env.DEV && (
        <mesh ref={debugBoxRef} visible={false} renderOrder={RING_RENDER_ORDER + 1}>
          <boxGeometry args={[0.02, 0.02, 0.02]} />
          <meshBasicMaterial color="#ff0000" wireframe depthTest={false} depthWrite={false} transparent />
        </mesh>
      )}

      <group ref={groupRef} visible={false} renderOrder={RING_RENDER_ORDER}>
        <primitive object={scene} dispose={null} />
      </group>
    </>
  );
}

/**
 * Public export: owns the ErrorBoundary + Suspense stack.
 *
 * Suspense  → shows null while GLB loads; the loading overlay is controlled
 *             by useLoadingState in the parent, not by this fallback.
 * ErrorBoundary → catches parse/404/WebGL errors; renders a fallback torus
 *                 so the camera feed keeps working.
 */
export function RingScene(props: RingSceneProps) {
  return (
    <ModelErrorBoundary>
      <Suspense fallback={null}>
        <RingMesh {...props} />
      </Suspense>
    </ModelErrorBoundary>
  );
}
