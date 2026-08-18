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
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ModelErrorBoundary } from './ModelErrorBoundary';
import { useRingModel, RING_SCALE, OFFSET_Y, OFFSET_Z } from '../hook/useRingModel';
import type { HandTrackingResult } from '../types/ar.types';
import { LM } from '../types/ar.types';
import {
  landmarkToWorld,
  computeRingQuaternion,
  computeRingScale,
  RING_SEGMENT_T,
} from '../utils/coordinateMapping';
import { VelocityAdaptiveEMAFilter, ScalarEMAFilter } from '../utils/emaFilter';

interface RingSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
}

// ── RingMesh — inner component, renders only after useGLTF resolves ──────────
// Kept separate from the Suspense boundary so ErrorBoundary can catch
// suspension errors without unmounting the whole scene.
function RingMesh({ resultRef }: RingSceneProps) {
  const { camera, gl } = useThree();
  const groupRef   = useRef<THREE.Group>(null);
  const { scene }  = useRingModel();

  // Filters — one instance per session, reset on tracking loss
  const emaFilter   = useRef(new VelocityAdaptiveEMAFilter());
  const scaleFilter = useRef(new ScalarEMAFilter(0.35));
  const wasDetected = useRef(false);

  // ── Per-frame ring positioning (mutated refs — no React state, no re-renders)
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    // We need a valid video element to project 2D landmarks → 3D world space.
    // The canvas's domElement gives us the rendering surface dimensions.
    const canvas = gl.domElement;
    if (!canvas) return;

    const result = resultRef.current;

    if (!result || !result.detected || result.hands.length === 0) {
      group.visible = false;
      if (wasDetected.current) {
        emaFilter.current.reset();
        scaleFilter.current.reset();
        wasDetected.current = false;
      }
      return;
    }

    wasDetected.current = true;

    const hand      = result.hands[0];
    const landmarks = hand.landmarks;
    const lm13 = landmarks.find((landmark) => landmark.index === LM.RING_MCP); // base knuckle
    const lm14 = landmarks.find((landmark) => landmark.index === LM.RING_PIP); // middle knuckle
    if (!lm13 || !lm14) return;

    // For projection we need a video element to read its dimensions.
    // We synthesise a minimal object with the canvas size as a fallback
    // because the video element lives outside the Canvas context.
    const videoLike = {
      videoWidth:  canvas.width,
      videoHeight: canvas.height,
    } as HTMLVideoElement;

    const projParams = {
      videoElement:  videoLike,
      canvasElement: canvas,
      camera: camera as THREE.PerspectiveCamera,
      isMirrored: true, // front camera is CSS-mirrored
    };

    const pos13 = landmarkToWorld(lm13, projParams);
    const pos14 = landmarkToWorld(lm14, projParams);
    if (!pos13 || !pos14) return;

    // Interpolate along MCP→PIP segment; RING_SEGMENT_T=0.25 sits near base knuckle
    const rawPosition = pos13.clone().lerp(pos14, RING_SEGMENT_T);
    rawPosition.y += OFFSET_Y;
    rawPosition.z += OFFSET_Z;

    const rawQuaternion = computeRingQuaternion(pos13, pos14);
    const rawScale      = computeRingScale(pos13, pos14);

    const { position: filteredPos, quaternion: filteredQuat } =
      emaFilter.current.update(rawPosition, rawQuaternion);
    const filteredScale = scaleFilter.current.update(rawScale);

    group.visible = true;
    group.position.copy(filteredPos);
    group.quaternion.copy(filteredQuat);
    group.scale.setScalar(filteredScale * RING_SCALE);
  });

  // Dispose cloned geometry/materials on unmount to prevent GPU memory leaks.
  useEffect(() => {
    return () => {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            (mesh.material as THREE.Material)?.dispose();
          }
        }
      });
    };
  }, [scene]);

  return (
    <>
      {/* Lighting for the ring — adjust intensities to match your scene */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[2, 4, 3]}   intensity={2.0} castShadow={false} />
      <directionalLight position={[-2, 1, -1]} intensity={0.6} />

      {/* Ring mesh — hidden until a hand is detected */}
      <group ref={groupRef} visible={false}>
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
