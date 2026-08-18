import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree, type CanvasProps } from '@react-three/fiber';
import * as THREE from 'three';
import { RingScene } from './RingScene';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';

type WebGPURendererModule = typeof import('three/examples/jsm/renderers/webgpu/WebGPURenderer.js');
type ThreeRenderer = THREE.WebGLRenderer & { init?: () => Promise<void> };

declare global {
  interface Navigator {
    gpu?: unknown;
  }
}

export interface WebGPUSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  facingMode?: 'user' | 'environment';
  onMount?: () => void;
  dpr?: CanvasProps['dpr'];
  ambientLight?: AmbientLightState;
}

export function hasWebGPUSupport(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

async function createHighPerformanceRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ThreeRenderer> {
  if (hasWebGPUSupport()) {
    const { default: WebGPURenderer } = await import('three/examples/jsm/renderers/webgpu/WebGPURenderer.js') as WebGPURendererModule;
    const renderer = new WebGPURenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    }) as unknown as ThreeRenderer;
    await renderer.init?.();
    return renderer;
  }

  return new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  }) as ThreeRenderer;
}

function AdaptiveToneMapping({ ambientLight }: { ambientLight?: AmbientLightState }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    if (!ambientLight) return;
    gl.toneMappingExposure = ambientLight.exposure;
    scene.userData.ambientColorTemperature = ambientLight.colorTemperature;
  }, [ambientLight, gl, scene]);
  return null;
}

function RendererReadyNotifier({ onMount }: { onMount?: () => void }) {
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  return null;
}

export function WebGPUScene({ resultRef, videoRef, facingMode = 'user', onMount, dpr, ambientLight }: WebGPUSceneProps) {
  const [rendererMode] = useState<'webgpu' | 'webgl'>(() => (hasWebGPUSupport() ? 'webgpu' : 'webgl'));
  const glFactory = useMemo(() => createHighPerformanceRenderer as unknown as CanvasProps['gl'], []);

  return (
    <Canvas
      className="absolute inset-0"
      style={{ background: 'transparent' }}
      gl={glFactory}
      onCreated={({ gl, scene }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = ambientLight?.exposure ?? (rendererMode === 'webgpu' ? 1.05 : 1.0);
        scene.userData.rendererMode = rendererMode;
        scene.userData.ambientColorTemperature = ambientLight?.colorTemperature;
      }}
      camera={{ fov: 45, near: 0.01, far: 100, position: [0, 0, 5] }}
      dpr={dpr}
    >
      <AdaptiveToneMapping ambientLight={ambientLight} />
      <RendererReadyNotifier onMount={onMount} />
      <Suspense fallback={null}>
        <RingScene resultRef={resultRef} videoRef={videoRef} facingMode={facingMode} enableRayTracing={rendererMode === 'webgpu'} ambientLight={ambientLight} />
      </Suspense>
    </Canvas>
  );
}
