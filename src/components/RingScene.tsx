// src/components/RingScene.tsx
import React, { Suspense, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ModelErrorBoundary } from './ModelErrorBoundary';
import { useRingModel, RING_SCALE, OFFSET_Y, OFFSET_Z } from '../hooks/useRingModel';

interface Props {
  // Interpolated world-space position between landmarks 13 & 14
  fingerMidpoint: THREE.Vector3 | null;
  // Quaternion derived from the finger direction vector
  fingerRotation: THREE.Quaternion | null;
}

/**
 * Inner component: renders only after useGLTF resolves (inside Suspense).
 * Kept separate so the ErrorBoundary can catch its suspension errors.
 */
function RingMesh({ fingerMidpoint, fingerRotation }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const { scene } = useRingModel();

  useFrame(() => {
    if (!groupRef.current || !fingerMidpoint) return;

    // Smoothly interpolate position each frame rather than snapping,
    // which hides MediaPipe jitter without adding perceptible lag.
    groupRef.current.position.lerp(
      new THREE.Vector3(
        fingerMidpoint.x,
        fingerMidpoint.y + OFFSET_Y,
        fingerMidpoint.z + OFFSET_Z,
      ),
      0.35, // lerp factor — increase for faster tracking, decrease for smoother
    );

    if (fingerRotation) {
      groupRef.current.quaternion.slerp(fingerRotation, 0.35);
    }
  });

  // Dispose cloned geometries + materials when this component unmounts.
  // Without this, every remount leaks GPU memory — especially on mobile.
  useEffect(() => {
    const group = groupRef.current;
    return () => {
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material?.dispose();
          }
        }
      });
    };
  }, [scene]);

  return (
    <group ref={groupRef} scale={RING_SCALE}>
      <primitive object={scene} />
    </group>
  );
}

/**
 * Public component: owns the Suspense + ErrorBoundary stack.
 *
 * Suspense boundary  →  shows nothing (null) while GLB loads; the loading
 *                        overlay is driven by app-level state (see Fix 4),
 *                        NOT by this fallback, so they don't conflict.
 *
 * ErrorBoundary      →  catches parse / network errors after Suspense resolves.
 */
export function RingScene(props: Props) {
  return (
    <ModelErrorBoundary>
      <Suspense fallback={null}>
        <RingMesh {...props} />
      </Suspense>
    </ModelErrorBoundary>
  );
}
