import React, { Suspense, useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { disposeRingScene, useRingModel } from '../hook/useRingModel';
import type { WebXRManager, XRHandMeasurement } from '../services/WebXRManager';

function XRRuntimeBridge({ manager }: { manager: WebXRManager }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => manager.bindRuntime({ renderer: gl as THREE.WebGLRenderer, scene, camera }), [camera, gl, manager, scene]);
  return null;
}

function XRJewelry({ manager }: { manager: WebXRManager }) {
  const group = useRef<THREE.Group>(null);
  const { scene } = useRingModel();
  useEffect(() => {
    const apply = (measurement: XRHandMeasurement | undefined): void => {
      if (!group.current) return;
      group.current.visible = Boolean(measurement);
      if (!measurement) return;
      group.current.position.fromArray(measurement.position);
      group.current.quaternion.fromArray(measurement.orientation);
      // The GLB is authored in display units; anchor its known 15 mm baseline to the measured proximal segment.
      const scale = 0.015 * THREE.MathUtils.clamp(measurement.scaleMeters / 0.045, 0.65, 1.45);
      group.current.scale.setScalar(scale);
    };
    const unsubscribe = manager.subscribeFrames((snapshot) => apply(snapshot.hands[0]));
    return () => { unsubscribe(); disposeRingScene(scene); };
  }, [manager, scene]);
  return <group ref={group} visible={false}><primitive object={scene} dispose={null} /></group>;
}

/** R3F composition whose loop is deliberately disabled; WebXRManager owns the sole XR display loop. */
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
        <ambientLight intensity={1.1} />
        <directionalLight position={[1, 2, 1]} intensity={2} />
        <Suspense fallback={null}><XRJewelry manager={manager} /></Suspense>
      </Canvas>
      <button onClick={onClose} className="absolute right-4 top-4 z-10 min-h-12 min-w-12 rounded-full border border-white/20 bg-black/50 text-xl text-white" aria-label="End immersive AR">×</button>
    </div>
  );
}
