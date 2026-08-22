import React, { Suspense, useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { disposeRingScene, useRingModel } from '../hook/useRingModel';
import type { WebXRManager, XRHandMeasurement } from '../services/WebXRManager';
import { computeRingWorldScale } from '../config/ringModelMetadata';

function XRRuntimeBridge({ manager }: { manager: WebXRManager }) {
  const { gl, scene, camera } = useThree();
  useEffect(
    () => manager.bindRuntime({ renderer: gl as THREE.WebGLRenderer, scene, camera }),
    [camera, gl, manager, scene],
  );
  return null;
}

function XRJewelry({ manager }: { manager: WebXRManager }) {
  const group = useRef<THREE.Group>(null);
  // Immersive WebXR in Three r170 is WebGL-renderer based here. Keep gemstone
  // quality conservative because tracking stability has priority over shader cost.
  const { scene } = useRingModel(undefined, { rendererMode: 'webgl', quality: 'MEDIUM', preset: 'silver' });

  useEffect(() => {
    const apply = (measurement: XRHandMeasurement | undefined): void => {
      const target = group.current;
      if (!target) return;
      target.visible = Boolean(measurement);
      if (!measurement) return;

      target.position.fromArray(measurement.position);
      target.quaternion.fromArray(measurement.orientation);
      target.scale.setScalar(computeRingWorldScale(measurement.scaleMeters));
    };

    const unsubscribe = manager.subscribeFrames((snapshot) => {
      // Prefer a real left/right hand over `none` when browsers provide multiple sources.
      const hand = snapshot.hands.find((candidate) => candidate.handedness !== 'none') ?? snapshot.hands[0];
      apply(hand);
    });

    return () => {
      unsubscribe();
      disposeRingScene(scene);
    };
  }, [manager, scene]);

  return <group ref={group} visible={false}><primitive object={scene} dispose={null} /></group>;
}

/** R3F composition whose loop is deliberately disabled; WebXRManager owns XR frames. */
export function WebXRScene({ manager, onClose }: { manager: WebXRManager; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-transparent" role="dialog" aria-modal="true" aria-label="Immersive WebXR ring try-on">
      <Canvas
        frameloop="never"
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        camera={{ near: 0.01, far: 20 }}
        onCreated={({ gl }) => { gl.setClearColor(0, 0); }}
      >
        <XRRuntimeBridge manager={manager} />
        <ambientLight intensity={1.05} />
        <directionalLight position={[1, 2, 1]} intensity={1.8} />
        <Suspense fallback={null}><XRJewelry manager={manager} /></Suspense>
      </Canvas>
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-10 min-h-12 min-w-12 rounded-full border border-white/20 bg-black/50 text-xl text-white"
        aria-label="End immersive AR"
      >
        ×
      </button>
    </div>
  );
}
