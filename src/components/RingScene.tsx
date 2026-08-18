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

import React, { Suspense, useRef, useEffect, useContext } from 'react';
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
import { LM } from '../types/ar.types';
import {
  computeAnatomicalRingPose,
  projectRingLandmarks,
} from '../utils/coordinateMapping';
import { RingTrackingStabilizer } from '../utils/trackingStabilizer';

const FINGER_OCCLUDER_RENDER_ORDER = -1;
const RING_RENDER_ORDER = 0;
const FINGER_OCCLUDER_DEBUG_COLOR = '#D5FD50';
const FINGER_OCCLUDER_RADIAL_SEGMENTS = 24;
const FINGER_OCCLUDER_RADIUS_FRACTION = 0.18;
const FINGER_OCCLUDER_HEIGHT_FRACTION = 1.18;

interface RingSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
}

// ── RingMesh — inner component, renders only after useGLTF resolves ──────────
// Kept separate from the Suspense boundary so ErrorBoundary can catch
// suspension errors without unmounting the whole scene.
function RingMesh({ resultRef }: RingSceneProps) {
  const { camera, gl } = useThree();
  const groupRef   = useRef<THREE.Group>(null);
  const occluderRef = useRef<THREE.Mesh>(null);
  const { scene }  = useRingModel();

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

  // ── Per-frame ring positioning (mutated refs — no React state, no re-renders)
  useFrame(() => {
    const group = groupRef.current;
    const occluder = occluderRef.current;
    if (!group || !occluder) return;

    // We need a valid video element to project 2D landmarks → 3D world space.
    // The canvas's domElement gives us the rendering surface dimensions.
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

    // Fallback path for the standalone RingScene: assume the canvas and video
    // share dimensions when no DOM video ref is available. ARTryOnModal uses
    // the stricter real-video path.
    const videoLike = {
      videoWidth: canvas.clientWidth || canvas.width,
      videoHeight: canvas.clientHeight || canvas.height,
      clientWidth: canvas.clientWidth || canvas.width,
      clientHeight: canvas.clientHeight || canvas.height,
    } as HTMLVideoElement;

    const projParams = {
      videoElement: videoLike,
      canvasElement: canvas,
      camera: camera as THREE.PerspectiveCamera,
      isMirrored: true,
    };

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

    const stabilized = stabilizer.current.update({
      position: rawPosition.current,
      quaternion: rawQuaternion.current,
      scale: rawScale.current.x,
      confidence: hand.confidence,
      timestamp: result.frameTimestamp ?? hand.timestamp,
      landmarks: hand.landmarks,
    });

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
      <Environment preset="city" background={false} environmentIntensity={0.85} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#fff7e8', '#24222a', 0.55]} />
      <rectAreaLight position={[0, 1.4, 1.6]} width={1.6} height={0.9} intensity={1.7} />

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
