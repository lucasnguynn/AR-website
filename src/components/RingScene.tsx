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
import { Environment } from '@react-three/drei';
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
import { RingTrackingStabilizer } from '../utils/trackingStabilizer';
import type { RingPoseSample } from '../utils/trackingStabilizer';
import { useRayTracingPipeline } from './RayTracingPipeline';
import { WebXRDepthManager, type DepthOcclusionTier } from '../services/WebXRDepthManager';
import type { GemstoneQuality, RingRendererMode } from '../materials/ringMaterialStrategy';

const FINGER_OCCLUDER_RENDER_ORDER = -1;
const RING_RENDER_ORDER = 20;
const MOBILE_SAFE_RING_SCALE = 0.015;
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
  enableRayTracing?: boolean;
  ambientLight?: AmbientLightState;
  materialRendererMode?: RingRendererMode;
  gemstoneQuality?: GemstoneQuality;
}

const DEPTH_INPUT_SIZE = 518;

function CameraDepthOcclusion({ videoRef, tierRef }: { videoRef?: React.RefObject<HTMLVideoElement | null>; tierRef: React.MutableRefObject<DepthOcclusionTier> }) {
  const { scene } = useThree();
  const pipeline = useMemo(() => new WebXRDepthManager({ modelUrl: `${import.meta.env.BASE_URL}models/depth/depth_anything_v2_small.onnx` }), []);
  const enabled = import.meta.env.VITE_ENABLE_MONOCULAR_DEPTH === 'true';

  useEffect(() => {
    scene.add(pipeline.occlusionProxy);
    void pipeline.start();
    let callback = 0;
    let cancelled = false;
    const video = videoRef?.current;
    const capture = async () => {
      if (cancelled || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !pipeline.canAcceptCameraFrame()) return;
      const started = performance.now();
      try {
        const bitmap = await createImageBitmap(video, { resizeWidth: DEPTH_INPUT_SIZE, resizeHeight: DEPTH_INPUT_SIZE, resizeQuality: 'low' });
        if (cancelled) { bitmap.close(); return; }
        pipeline.update({ cameraFrame: bitmap, captureMs: performance.now() - started });
        tierRef.current = pipeline.getTier();
      } catch {
        tierRef.current = 'geometric-proxy';
      }
    };
    const onFrame = () => {
      void capture();
      if (!cancelled && video?.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(onFrame);
    };
    if (enabled && video?.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(onFrame);
    else if (enabled) callback = window.setInterval(() => void capture(), 100);
    return () => {
      cancelled = true;
      if (video?.cancelVideoFrameCallback && callback) video.cancelVideoFrameCallback(callback);
      else if (callback) window.clearInterval(callback);
      pipeline.dispose();
    };
  }, [enabled, pipeline, scene, tierRef, videoRef]);
  return null;
}

// ── RingMesh — inner component, renders only after useGLTF resolves ──────────
// Kept separate from the Suspense boundary so ErrorBoundary can catch
// suspension errors without unmounting the whole scene.
function RingMesh({ resultRef, videoRef, facingMode = 'user', enableRayTracing = false, ambientLight, materialRendererMode = 'webgl', gemstoneQuality = 'HIGH' }: RingSceneProps) {
  const { camera, gl } = useThree();
  const groupRef   = useRef<THREE.Group>(null);
  const debugBoxRef = useRef<THREE.Mesh>(null);
  const occluderRef = useRef<THREE.Mesh>(null);
  const depthTierRef = useRef<DepthOcclusionTier>('geometric-proxy');
  const { scene }  = useRingModel(undefined, { rendererMode: materialRendererMode, quality: gemstoneQuality, preset: 'silver' });
  useRayTracingPipeline({ enabled: enableRayTracing, ringRoot: scene });

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
  const sampleRef = useRef<RingPoseSample>({
    position: rawPosition.current,
    quaternion: rawQuaternion.current,
    scale: 1,
    confidence: 0,
    timestamp: 0,
    landmarks: undefined,
  });
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

    if (!result || !result.detected || result.hands.length === 0) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      occluder.visible = stabilized.visible && depthTierRef.current === 'geometric-proxy';
      debugBox.visible = stabilized.visible;
      return;
    }

    const hand = result.hands[0];

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

    if (!projectRingLandmarks(hand.landmarks, projParams, projectedLandmarks.current)) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      occluder.visible = stabilized.visible && depthTierRef.current === 'geometric-proxy';
      debugBox.visible = stabilized.visible;
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
      occluder.visible = stabilized.visible && depthTierRef.current === 'geometric-proxy';
      debugBox.visible = stabilized.visible;
      return;
    }

    rawPosition.current.y += OFFSET_Y;
    rawPosition.current.z += OFFSET_Z;

    const sample = sampleRef.current;
    sample.scale = rawScale.current.x;
    sample.confidence = hand.confidence;
    sample.timestamp = result.frameTimestamp ?? hand.timestamp;
    sample.landmarks = hand.landmarks;

    const stabilized = stabilizer.current.update(sample);

    group.visible = stabilized.visible;
    occluder.visible = stabilized.visible && depthTierRef.current === 'geometric-proxy';
    debugBox.visible = stabilized.visible;
    if (!stabilized.visible) return;

    const mcpToPip = projectedLandmarks.current[LM.RING_MCP].distanceTo(projectedLandmarks.current[LM.RING_PIP]);
    const occluderRadius = Math.max(mcpToPip * FINGER_OCCLUDER_RADIUS_FRACTION, 0.004);
    const occluderHeight = Math.max(mcpToPip * FINGER_OCCLUDER_HEIGHT_FRACTION, occluderRadius * 3);

    occluder.position.copy(stabilized.position);
    occluder.quaternion.copy(stabilized.quaternion);
    occluder.scale.set(occluderRadius * 2, occluderHeight, occluderRadius * 2);

    debugBox.position.copy(stabilized.position);
    debugBox.quaternion.copy(stabilized.quaternion);
    debugBox.scale.set(1, 1, 1);

    group.position.copy(stabilized.position);
    group.quaternion.copy(stabilized.quaternion);
    group.scale.set(MOBILE_SAFE_RING_SCALE, MOBILE_SAFE_RING_SCALE, MOBILE_SAFE_RING_SCALE);
  });

  // Dispose cloned geometry/materials on unmount to prevent GPU memory leaks.
  useEffect(() => {
    scene.traverse((object) => {
      object.renderOrder = RING_RENDER_ORDER;
    });

    return () => {
      disposeRingScene(scene);
    };
  }, [scene]);

  return (
    <>
      <CameraDepthOcclusion videoRef={videoRef} tierRef={depthTierRef} />
      <Environment preset="city" background={false} environmentIntensity={0.65 + (ambientLight?.exposure ?? 1) * 0.22} />
      <ambientLight intensity={0.22 + (ambientLight?.exposure ?? 1) * 0.12} color={ambientLight?.keyColor ?? '#fff7e8'} />
      <hemisphereLight args={[ambientLight?.keyColor ?? '#fff7e8', '#24222a', 0.55]} />
      <rectAreaLight position={[0, 1.4, 1.6]} width={1.6} height={0.9} intensity={1.25 + (ambientLight?.exposure ?? 1) * 0.45} color={ambientLight?.keyColor ?? '#fff7e8'} />

      {/* Ring mesh — hidden until a hand is detected */}
      <mesh ref={occluderRef} visible={false} renderOrder={FINGER_OCCLUDER_RENDER_ORDER} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 1, FINGER_OCCLUDER_RADIAL_SEGMENTS, 1, false]} />
        <meshBasicMaterial color={FINGER_OCCLUDER_DEBUG_COLOR} colorWrite={false} depthWrite={true} depthTest={true} />
      </mesh>

      <mesh ref={debugBoxRef} visible={false} renderOrder={RING_RENDER_ORDER + 1}>
        <boxGeometry args={[0.02, 0.02, 0.02]} />
        <meshBasicMaterial color="#ff0000" wireframe depthTest={false} depthWrite={false} transparent />
      </mesh>

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
