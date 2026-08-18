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

import React, { Suspense, useRef, useEffect } from 'react';
import { Environment } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ModelErrorBoundary } from './ModelErrorBoundary';
import {
  disposeRingScene,
  useRingModel,
  RING_SCALE,
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

const FINGER_OCCLUDER_RENDER_ORDER = -1;
const RING_RENDER_ORDER = 0;
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
}

// ── RingMesh — inner component, renders only after useGLTF resolves ──────────
// Kept separate from the Suspense boundary so ErrorBoundary can catch
// suspension errors without unmounting the whole scene.
function RingMesh({ resultRef, videoRef, facingMode = 'user', enableRayTracing = false, ambientLight }: RingSceneProps) {
  const { camera, gl } = useThree();
  const groupRef   = useRef<THREE.Group>(null);
  const occluderRef = useRef<THREE.Mesh>(null);
  const { scene }  = useRingModel();
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
    const occluder = occluderRef.current;
    if (!group || !occluder) return;

    const canvas = gl.domElement;
    if (!canvas) return;

    const result = resultRef.current;

    if (!result || !result.detected || result.hands.length === 0) {
      const stabilized = stabilizer.current.update(null);
      group.visible = stabilized.visible;
      occluder.visible = stabilized.visible;
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
      occluder.visible = stabilized.visible;
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
      occluder.visible = stabilized.visible;
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
    occluder.visible = stabilized.visible;
    if (!stabilized.visible) return;

    const mcpToPip = projectedLandmarks.current[LM.RING_MCP].distanceTo(projectedLandmarks.current[LM.RING_PIP]);
    const occluderRadius = Math.max(mcpToPip * FINGER_OCCLUDER_RADIUS_FRACTION, 0.004);
    const occluderHeight = Math.max(mcpToPip * FINGER_OCCLUDER_HEIGHT_FRACTION, occluderRadius * 3);

    occluder.position.copy(stabilized.position);
    occluder.quaternion.copy(stabilized.quaternion);
    occluder.scale.set(occluderRadius * 2, occluderHeight, occluderRadius * 2);

    group.position.copy(stabilized.position);
    group.quaternion.copy(stabilized.quaternion);
    group.scale.setScalar(stabilized.scale * RING_SCALE);
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
      <Environment preset="city" background={false} environmentIntensity={0.65 + (ambientLight?.exposure ?? 1) * 0.22} />
      <ambientLight intensity={0.22 + (ambientLight?.exposure ?? 1) * 0.12} color={ambientLight?.keyColor ?? '#fff7e8'} />
      <hemisphereLight args={[ambientLight?.keyColor ?? '#fff7e8', '#24222a', 0.55]} />
      <rectAreaLight position={[0, 1.4, 1.6]} width={1.6} height={0.9} intensity={1.25 + (ambientLight?.exposure ?? 1) * 0.45} color={ambientLight?.keyColor ?? '#fff7e8'} />

      {/* Ring mesh — hidden until a hand is detected */}
      <mesh ref={occluderRef} visible={false} renderOrder={FINGER_OCCLUDER_RENDER_ORDER} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 1, FINGER_OCCLUDER_RADIAL_SEGMENTS, 1, false]} />
        <meshBasicMaterial color={FINGER_OCCLUDER_DEBUG_COLOR} colorWrite={false} depthWrite={true} depthTest={true} />
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
