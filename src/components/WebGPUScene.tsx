// FILE: src/components/WebGPUScene.tsx
/**
 * Production AR scene renderer.
 *
 * The repository currently pairs React 18 with @react-three/fiber v8. R3F's
 * promise-returning `gl` factory used by WebGPURenderer is a v9-era capability,
 * so this release deliberately keeps the Canvas renderer synchronous WebGL2.
 * WebGPU capability detection remains available for the future React19/R3F9
 * migration, but production diagnostics must describe the renderer actually used.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type CanvasProps } from '@react-three/fiber';
import * as THREE from 'three';
import { RingScene } from './RingScene';
import type { HandTrackingResult } from '../types/ar.types';
import type { AmbientLightState } from '../utils/AmbientLightAdapter';
import { AdaptiveQualityController, qualitySettings, type QualityTier } from '../rendering/AdaptiveQualityController';
import { DeviceProfiler } from '../utils/DeviceProfiler';

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

/** Hardware capability only; this is not a claim that the current R3F renderer uses WebGPU. */
export function hasWebGPUSupport(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

function createWebGL2Renderer(canvas: HTMLCanvasElement | OffscreenCanvas): THREE.WebGLRenderer {
  const context = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;

  if (!context) throw new Error('WEBGL2 context is unavailable');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  return renderer;
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
  useEffect(() => { onMount?.(); }, [onMount]);
  return null;
}

function RendererLossMonitor({ onFailure }: { onFailure: () => void }) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onFailure();
    };
    canvas.addEventListener('webglcontextlost', lost, { once: true });
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [gl, onFailure]);
  return null;
}

function FrameTimeMonitor({ initialQuality, onQuality }: {
  initialQuality: QualityTier;
  onQuality: (quality: QualityTier, statistics: { averageMs: number; p95Ms: number }) => void;
}) {
  const controller = useRef<AdaptiveQualityController | null>(null);
  if (!controller.current) controller.current = new AdaptiveQualityController(initialQuality);

  useFrame((_, delta) => {
    const result = controller.current!.sample(delta * 1000);
    if (result.changed) onQuality(result.quality, result.statistics);
  });
  return null;
}

/**
 * Renders camera-composite AR using the stable React18/R3F8 WebGL2 backend.
 * The component name is retained to avoid a broad import migration.
 */
export function WebGPUScene({ resultRef, videoRef, facingMode = 'user', onMount, dpr, ambientLight }: WebGPUSceneProps) {
  const [initialModelQuality] = useState<QualityTier>(() => DeviceProfiler.recommendedQualityFromSignals());
  const [qualityTier, setQualityTier] = useState<QualityTier>(initialModelQuality);
  const [rendererEpoch, setRendererEpoch] = useState(0);
  const effectiveQuality = qualitySettings[qualityTier];
  const canvasDpr = dpr ?? effectiveQuality.dpr;

  const glFactory = useMemo<CanvasProps['gl']>(
    () => (canvas) => createWebGL2Renderer(canvas),
    [],
  );

  useEffect(() => {
    if (hasWebGPUSupport()) {
      console.info('[Renderer] WebGPU hardware detected; production Canvas remains WebGL2 until React19/R3F9 renderer migration is validated.');
    }
  }, []);

  const handleQuality = useCallback((nextQuality: QualityTier, statistics: { averageMs: number; p95Ms: number }): void => {
    setQualityTier((previous) => {
      if (previous === nextQuality) return previous;
      window.dispatchEvent(new CustomEvent('renderer:quality-changed', {
        detail: { fromQuality: previous, toQuality: nextQuality, ...statistics },
      }));
      return nextQuality;
    });
  }, []);

  const handleRendererFailure = useCallback(() => {
    // A fresh Canvas owns a fresh WebGL2 context after an unrecoverable context loss.
    setRendererEpoch((current) => current + 1);
  }, []);

  return (
    <Canvas
      key={`webgl2-${rendererEpoch}`}
      className="absolute inset-0 z-10"
      style={{ background: 'transparent', zIndex: 10, pointerEvents: 'none' }}
      gl={glFactory}
      shadows={effectiveQuality.shadows}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(0x000000, 0);
        gl.autoClear = true;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = ambientLight?.exposure ?? 1;
        gl.shadowMap.enabled = effectiveQuality.shadows;
        scene.userData.rendererMode = 'webgl2';
        scene.userData.qualityTier = qualityTier;
        scene.userData.ambientColorTemperature = ambientLight?.colorTemperature;
      }}
      camera={{ fov: 45, near: 0.01, far: 100, position: [0, 0, 5] }}
      dpr={canvasDpr}
    >
      <AdaptiveToneMapping ambientLight={ambientLight} />
      <RendererLossMonitor onFailure={handleRendererFailure} />
      <FrameTimeMonitor initialQuality={initialModelQuality} onQuality={handleQuality} />
      <RendererReadyNotifier onMount={onMount} />
      <Suspense fallback={null}>
        <RingScene
          resultRef={resultRef}
          videoRef={videoRef}
          facingMode={facingMode}
          enableWebGPUEnhancements={false}
          materialRendererMode="webgl"
          gemstoneQuality={qualityTier}
          modelQuality={initialModelQuality}
          depthIntervalMs={effectiveQuality.depthIntervalMs}
          environmentQuality={qualityTier}
          ambientLight={ambientLight}
        />
      </Suspense>
    </Canvas>
  );
}
