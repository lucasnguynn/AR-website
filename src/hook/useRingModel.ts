import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  createRingMaterialStrategy,
  type GemstoneQuality,
  type RingMaterialStrategy,
  type RingRendererMode,
  type RingSemanticSummary,
} from '../materials/ringMaterialStrategy';
import type { JewelryPreset } from '../materials/createJewelryShaderMaterial';
import { ringModelUrlForQuality } from '../config/arRuntimeConfig';

export const OFFSET_Y = 0.004;
export const OFFSET_Z = 0.000;

export interface RingModelMaterialOptions {
  readonly rendererMode?: RingRendererMode;
  readonly quality?: GemstoneQuality;
  /** Asset LOD is intentionally independent from shader quality. */
  readonly modelQuality?: GemstoneQuality;
  readonly preset?: JewelryPreset;
}

export function preparePremiumRingScene(source: THREE.Group, strategy: RingMaterialStrategy) {
  const scene = source.clone(true);

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    mesh.geometry = mesh.geometry.clone();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => strategy.materialFor(mesh, material));
    } else if (mesh.material) {
      mesh.material = strategy.materialFor(mesh, mesh.material);
    }
  });

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  scene.position.sub(center);
  scene.userData.ringMaterialStrategy = strategy;
  return scene;
}

export function disposeRingScene(scene: THREE.Object3D) {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      mesh.geometry.dispose();
      disposedGeometries.add(mesh.geometry);
    }
  });

  const strategy = scene.userData.ringMaterialStrategy as RingMaterialStrategy | undefined;
  strategy?.dispose();
  delete scene.userData.ringMaterialStrategy;
}

export function useRingModel(modelPath?: string, options: RingModelMaterialOptions = {}) {
  const quality = options.quality ?? 'HIGH';
  const modelQuality = options.modelQuality ?? quality;
  const resolvedPath = modelPath ?? ringModelUrlForQuality(modelQuality);
  const gltf = useGLTF(resolvedPath);
  const rendererMode = options.rendererMode ?? 'webgl';
  const preset = options.preset ?? 'silver';

  // Keep one strategy per source scene / renderer mode. Quality and preset update
  // in place to avoid rebuilding geometry every time the adaptive tier changes.
  const strategy = useMemo(
    () => createRingMaterialStrategy(rendererMode, preset, quality),
    [gltf.scene, rendererMode],
  );
  const scene = useMemo(() => preparePremiumRingScene(gltf.scene, strategy), [gltf.scene, strategy]);
  const semanticSummary: RingSemanticSummary = strategy.semanticSummary();

  useEffect(() => strategy.setPreset(preset), [preset, strategy]);
  useEffect(() => strategy.setQuality(quality), [quality, strategy]);

  useEffect(() => {
    console.info('[useRingModel] Model loaded:', resolvedPath, semanticSummary);
    if (!semanticSummary.productionReady) {
      console.warn(
        '[Ring asset] Production semantic contract not satisfied. Export separate Metal/Gemstone nodes with extras.materialRole.',
        semanticSummary,
      );
      window.dispatchEvent(new CustomEvent('ar:asset-semantic-warning', { detail: semanticSummary }));
    }
  }, [resolvedPath, semanticSummary.accentMeshes, semanticSummary.fallbackClassifications, semanticSummary.gemstoneMeshes, semanticSummary.metalMeshes, semanticSummary.productionReady]);

  return { scene, semanticSummary, modelPath: resolvedPath };
}

useGLTF.preload(ringModelUrlForQuality('HIGH'));
