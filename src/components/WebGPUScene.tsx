import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type CanvasProps } from '@react-three/fiber';
import * as THREE from 'three';
import { RingScene } from './RingScene';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';

type RenderTier = 'webgpu' | 'webgl2' | 'webgl1';
type QualityTier = 'HIGH' | 'MEDIUM' | 'LOW';
type ThreeRenderer = THREE.WebGLRenderer & { init?: () => Promise<void> };
type WebGPURendererConstructor = new (parameters: {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  alpha: boolean;
  antialias: boolean;
  powerPreference: WebGLPowerPreference;
}) => ThreeRenderer;

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

const QUALITY: Record<QualityTier, { dpr: number; shadows: boolean }> = {
  HIGH: { dpr: 2, shadows: true },
  MEDIUM: { dpr: 1.5, shadows: false },
  LOW: { dpr: 1, shadows: false },
};

const DOWNGRADE_ORDER: QualityTier[] = ['HIGH', 'MEDIUM', 'LOW'];

export function hasWebGPUSupport(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

function createWebGLRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, tier: Extract<RenderTier, 'webgl2' | 'webgl1'>): ThreeRenderer {
  const context = tier === 'webgl2'
    ? canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null
    : canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'high-performance' }) as WebGLRenderingContext | null;

  if (!context) {
    throw new Error(`${tier.toUpperCase()} context is unavailable`);
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  }) as ThreeRenderer;
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
}

async function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, requestedTier: RenderTier): Promise<ThreeRenderer> {
  if (requestedTier === 'webgpu' && hasWebGPUSupport()) {
    try {
      // Three.js >=0.170 exposes examples modules through the `three/addons/*` alias.
      // @ts-expect-error The installed Three.js type declarations may omit this addon module.
      const { default: WebGPURenderer } = await import(/* @vite-ignore */'three/examples/jsm/renderers/webgpu/WebGPURenderer.js')
      const renderer = new WebGPURenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      }) as unknown as ThreeRenderer;
      await renderer.init?.();
      renderer.setClearColor?.(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      return renderer;
    } catch (error) {
      console.warn('WebGPU renderer failed; falling back to WebGL2.', error);
      return createWebGLRenderer(canvas, 'webgl2');
    }
  }

  try {
    return createWebGLRenderer(canvas, requestedTier === 'webgl1' ? 'webgl1' : 'webgl2');
  } catch (error) {
    if (requestedTier === 'webgl1') throw error;
    console.warn('WebGL2 renderer failed; falling back to WebGL1.', error);
    return createWebGLRenderer(canvas, 'webgl1');
  }
}

function nextQualityTier(quality: QualityTier): QualityTier {
  return DOWNGRADE_ORDER[Math.min(DOWNGRADE_ORDER.indexOf(quality) + 1, DOWNGRADE_ORDER.length - 1)];
}

function nextRenderTier(tier: RenderTier): RenderTier {
  if (tier === 'webgpu') return 'webgl2';
  if (tier === 'webgl2') return 'webgl1';
  return 'webgl1';
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

function FrameTimeMonitor({ tier, quality, onDowngrade }: { tier: RenderTier; quality: QualityTier; onDowngrade: (tier: RenderTier, quality: QualityTier, averageMs: number) => void }) {
  const cycleCountRef = useRef(0);
  const slowCycleCountRef = useRef(0);
  const totalMsRef = useRef(0);

  useFrame((_, delta) => {
    totalMsRef.current += delta * 1000;
    cycleCountRef.current += 1;
    if (cycleCountRef.current < 30) return;

    const averageMs = totalMsRef.current / cycleCountRef.current;
    slowCycleCountRef.current = averageMs > 20 ? slowCycleCountRef.current + 1 : 0;
    cycleCountRef.current = 0;
    totalMsRef.current = 0;

    if (slowCycleCountRef.current >= 3) {
      slowCycleCountRef.current = 0;
      onDowngrade(nextRenderTier(tier), nextQualityTier(quality), averageMs);
    }
  });

  return null;
}

export function WebGPUScene({ resultRef, videoRef, facingMode = 'user', onMount, dpr, ambientLight }: WebGPUSceneProps) {
  const [renderTier, setRenderTier] = useState<RenderTier>(() => (hasWebGPUSupport() ? 'webgpu' : 'webgl2'));
  const [qualityTier, setQualityTier] = useState<QualityTier>('HIGH');
  const effectiveQuality = QUALITY[qualityTier];
  const canvasDpr = dpr ?? effectiveQuality.dpr;
  const glFactory = useMemo<CanvasProps['gl']>(() => ((canvas) => createRenderer(canvas, renderTier)) as CanvasProps['gl'], [renderTier]);

  const handleDowngrade = (nextTier: RenderTier, nextQuality: QualityTier, averageMs: number): void => {
    if (nextTier === renderTier && nextQuality === qualityTier) return;
    setRenderTier(nextTier);
    setQualityTier(nextQuality);
    window.dispatchEvent(new CustomEvent('renderer:downgraded', { detail: { fromTier: renderTier, toTier: nextTier, fromQuality: qualityTier, toQuality: nextQuality, averageMs } }));
  };

  return (
    <Canvas
      key={`${renderTier}-${qualityTier}`}
      className="absolute inset-0 z-10"
      style={{ background: 'transparent', zIndex: 10, pointerEvents: 'none' }}
      gl={glFactory}
      shadows={effectiveQuality.shadows}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(0x000000, 0);
        gl.autoClear = true;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = ambientLight?.exposure ?? (renderTier === 'webgpu' ? 1.05 : 1.0);
        gl.shadowMap.enabled = effectiveQuality.shadows;
        scene.userData.rendererMode = renderTier;
        scene.userData.qualityTier = qualityTier;
        scene.userData.ambientColorTemperature = ambientLight?.colorTemperature;
      }}
      camera={{ fov: 45, near: 0.01, far: 100, position: [0, 0, 5] }}
      dpr={canvasDpr}
    >
      <AdaptiveToneMapping ambientLight={ambientLight} />
      <FrameTimeMonitor tier={renderTier} quality={qualityTier} onDowngrade={handleDowngrade} />
      <RendererReadyNotifier onMount={onMount} />
      <Suspense fallback={null}>
        <RingScene resultRef={resultRef} videoRef={videoRef} facingMode={facingMode} enableRayTracing={renderTier === 'webgpu'} ambientLight={ambientLight} />
      </Suspense>
    </Canvas>
  );
}
