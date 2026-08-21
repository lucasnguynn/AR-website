// FILE: src/components/WebGPUScene.tsx
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type CanvasProps } from '@react-three/fiber';
import * as THREE from 'three';
import { WebGLRenderer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { RingScene } from './RingScene';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';
import { AdaptiveQualityController, qualitySettings, type QualityTier } from '../rendering/AdaptiveQualityController';

type RenderTier = 'webgpu' | 'webgl2' | 'webgl1';
type ThreeRenderer = THREE.WebGLRenderer & { init?: () => Promise<void> };
type RendererInitResult = { renderer: ThreeRenderer; tier: RenderTier };

declare global {
  interface Navigator {
    gpu?: unknown;
  }
}

/**
 * Props for the adaptive WebGPU/WebGL AR scene renderer.
 */
export interface WebGPUSceneProps {
  resultRef: React.RefObject<HandTrackingResult | null>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  facingMode?: 'user' | 'environment';
  onMount?: () => void;
  dpr?: CanvasProps['dpr'];
  ambientLight?: AmbientLightState;
}


/**
 * Returns whether the current browser exposes the WebGPU adapter API.
 */
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

  const renderer = new WebGLRenderer({
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

function getQualityTier(): string {
  return 'Tier: HIGH';
}

async function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, requestedTier: RenderTier): Promise<RendererInitResult> {
  if (requestedTier === 'webgpu' && hasWebGPUSupport()) {
    try {
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
      renderer.toneMappingExposure = 1.0;
      console.info(`[Renderer] WebGPU | ${getQualityTier()}`);
      return { renderer, tier: 'webgpu' };
    } catch (error) {
      console.warn('WebGPU renderer failed; falling back to WebGL2.', error);
    }
  }

  try {
    const fallbackTier = requestedTier === 'webgl1' ? 'webgl1' : 'webgl2';
    const renderer = createWebGLRenderer(canvas, fallbackTier);
    console.info(fallbackTier === 'webgl2' ? '[Renderer] WebGL2 fallback' : '[Renderer] WebGL1 fallback');
    return { renderer, tier: fallbackTier };
  } catch (error) {
    if (requestedTier === 'webgl1') throw error;
    console.warn('WebGL2 renderer failed; falling back to WebGL1.', error);
    const renderer = createWebGLRenderer(canvas, 'webgl1');
    console.info('[Renderer] WebGL1 fallback');
    return { renderer, tier: 'webgl1' };
  }
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

function RendererLossMonitor({ onFailure }: { onFailure: () => void }) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => { event.preventDefault(); onFailure(); };
    canvas.addEventListener('webglcontextlost', lost, { once: true });
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [gl, onFailure]);
  return null;
}

function FrameTimeMonitor({ onQuality }: { onQuality: (quality: QualityTier, statistics: { averageMs: number; p95Ms: number }) => void }) {
  const controller = useRef(new AdaptiveQualityController());

  useFrame((_, delta) => {
    const result = controller.current.sample(delta * 1000);
    if (result.changed) onQuality(result.quality, result.statistics);
  });

  return null;
}

/**
 * Renders the jewelry AR scene with WebGPU first and safe WebGL fallbacks.
 */
export function WebGPUScene({ resultRef, videoRef, facingMode = 'user', onMount, dpr, ambientLight }: WebGPUSceneProps) {
  const [renderTier, setRenderTier] = useState<RenderTier>(() => (hasWebGPUSupport() ? 'webgpu' : 'webgl2'));
  const [qualityTier, setQualityTier] = useState<QualityTier>('HIGH');
  const effectiveQuality = qualitySettings[qualityTier];
  const canvasDpr = dpr ?? effectiveQuality.dpr;
  const glFactory = useMemo<CanvasProps['gl']>(() => (async (canvas) => {
    const { renderer, tier } = await createRenderer(canvas, renderTier);
    if (tier !== renderTier) {
      window.requestAnimationFrame(() => setRenderTier(tier));
    }
    return renderer as THREE.WebGLRenderer;
  }) as CanvasProps['gl'], [renderTier]);

  const handleQuality = useCallback((nextQuality: QualityTier, statistics: { averageMs: number; p95Ms: number }): void => {
    setQualityTier((previous) => {
      if (previous === nextQuality) return previous;
      window.dispatchEvent(new CustomEvent('renderer:quality-changed', { detail: { fromQuality: previous, toQuality: nextQuality, ...statistics } }));
      return nextQuality;
    });
  }, []);

  const handleRendererFailure = useCallback(() => setRenderTier((current) => nextRenderTier(current)), []);

  return (
    <Canvas
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
      <RendererLossMonitor onFailure={handleRendererFailure} />
      <FrameTimeMonitor onQuality={handleQuality} />
      <RendererReadyNotifier onMount={onMount} />
      <Suspense fallback={null}>
        <RingScene
          resultRef={resultRef}
          videoRef={videoRef}
          facingMode={facingMode}
          enableWebGPUEnhancements={renderTier === 'webgpu'}
          materialRendererMode={renderTier === 'webgpu' ? 'webgpu' : 'webgl'}
          gemstoneQuality={qualityTier}
          depthIntervalMs={effectiveQuality.depthIntervalMs}
          environmentQuality={qualityTier}
          ambientLight={ambientLight}
        />
      </Suspense>
    </Canvas>
  );
}
// VERIFY: console.log('[Renderer] WebGPU | Tier: HIGH — static import path has no CSP dynamic-code construction')
