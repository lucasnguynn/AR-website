import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type CanvasProps } from '@react-three/fiber';
import * as THREE from 'three';
import { RingScene } from './RingScene';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';

type RenderTier = 'webgpu' | 'webgl2' | 'webgl1';
type QualityTier = 'HIGH' | 'MEDIUM' | 'LOW';
type ThreeRenderer = THREE.WebGLRenderer & { init?: () => Promise<void> };
type AdaptiveRenderer = ThreeRenderer & { shadowMap?: THREE.WebGLRenderer['shadowMap'] };
type WebGPUModule = { WebGPURenderer?: new (parameters: Record<string, unknown>) => AdaptiveRenderer };
type RendererInitResult = { renderer: ThreeRenderer; tier: RenderTier };

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

async function resolveWebGPURenderer(): Promise<WebGPUModule | null> {
  try {
    const importWebGPU = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const mod = await importWebGPU('three/' + 'webgpu') as WebGPUModule;
    if (typeof mod.WebGPURenderer === 'function') return mod;
  } catch (error) {
    console.warn('three/webgpu is unavailable; falling back to WebGL2.', error);
  }
  return null;
}

async function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, requestedTier: RenderTier): Promise<RendererInitResult> {
  if (requestedTier === 'webgpu' && hasWebGPUSupport()) {
    const mod = await resolveWebGPURenderer();
    if (mod?.WebGPURenderer) {
      try {
        const renderer = new mod.WebGPURenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        });

        await renderer.init?.();
        renderer.setClearColor?.(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        return { renderer, tier: 'webgpu' };
      } catch (error) {
        console.warn('WebGPU renderer failed; falling back to WebGL2.', error);
      }
    }
  }

  try {
    const fallbackTier = requestedTier === 'webgl1' ? 'webgl1' : 'webgl2';
    return { renderer: createWebGLRenderer(canvas, fallbackTier), tier: fallbackTier };
  } catch (error) {
    if (requestedTier === 'webgl1') throw error;
    console.warn('WebGL2 renderer failed; falling back to WebGL1.', error);
    return { renderer: createWebGLRenderer(canvas, 'webgl1'), tier: 'webgl1' };
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
  const frameCountRef = useRef(0);
  const emaMsRef = useRef(1000 / 60);

  useFrame((_, delta) => {
    const frameMs = delta * 1000;
    frameCountRef.current += 1;
    emaMsRef.current += (frameMs - emaMsRef.current) / 8;
    if (frameCountRef.current < 8 || emaMsRef.current <= 20) return;

    onDowngrade(nextRenderTier(tier), nextQualityTier(quality), emaMsRef.current);
    frameCountRef.current = 0;
  });

  return null;
}

export function WebGPUScene({ resultRef, videoRef, facingMode = 'user', onMount, dpr, ambientLight }: WebGPUSceneProps) {
  const [renderTier, setRenderTier] = useState<RenderTier>(() => (hasWebGPUSupport() ? 'webgpu' : 'webgl2'));
  const [qualityTier, setQualityTier] = useState<QualityTier>('HIGH');
  const effectiveQuality = QUALITY[qualityTier];
  const canvasDpr = dpr ?? effectiveQuality.dpr;
  const glFactory = useMemo<CanvasProps['gl']>(() => (async (canvas) => {
    const { renderer, tier } = await createRenderer(canvas, renderTier);
    if (tier !== renderTier) {
      window.requestAnimationFrame(() => setRenderTier(tier));
    }
    return renderer as THREE.WebGLRenderer;
  }) as CanvasProps['gl'], [renderTier]);

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
        if (gl.shadowMap) {
          gl.shadowMap.enabled = effectiveQuality.shadows;
        }
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
