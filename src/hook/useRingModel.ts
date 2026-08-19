import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  createRingMaterialStrategy,
  type GemstoneQuality,
  type RingMaterialStrategy,
  type RingRendererMode,
} from '../materials/ringMaterialStrategy';
import type { JewelryPreset } from '../materials/createJewelryShaderMaterial';

export const OFFSET_Y = 0.004;
export const OFFSET_Z = 0.000;

const MODEL_PATH = import.meta.env.BASE_URL + 'models/nhan.glb';
export interface RingModelMaterialOptions {
  readonly rendererMode?: RingRendererMode;
  readonly quality?: GemstoneQuality;
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

    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((material) => strategy.materialFor(mesh, material));
    else if (mesh.material) mesh.material = strategy.materialFor(mesh, mesh.material);
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

export function useRingModel(modelPath = MODEL_PATH, options: RingModelMaterialOptions = {}) {
  const gltf = useGLTF(modelPath);
  const rendererMode = options.rendererMode ?? 'webgl';
  const preset = options.preset ?? 'silver';
  const strategy = useMemo(() => createRingMaterialStrategy(rendererMode, preset, options.quality ?? 'HIGH'), [gltf.scene, rendererMode]);
  const scene = useMemo(() => preparePremiumRingScene(gltf.scene, strategy), [gltf.scene, strategy]);

  useEffect(() => strategy.setPreset(preset), [preset, strategy]);
  useEffect(() => strategy.setQuality(options.quality ?? 'HIGH'), [options.quality, strategy]);

  useEffect(() => {
    console.info('[useRingModel] Model loaded from:', modelPath);
  }, [modelPath]);

  return { scene };
}

useGLTF.preload(MODEL_PATH);
