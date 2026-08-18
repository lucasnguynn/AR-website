import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

export const RING_SCALE = 0.018;
export const OFFSET_Y = 0.004;
export const OFFSET_Z = 0.000;

const MODEL_PATH = import.meta.env.BASE_URL + 'models/nhan.glb';
const METAL_KEYWORDS = ['gold', 'silver', 'platinum', 'metal', 'band', 'ring'];
const GEM_KEYWORDS = ['diamond', 'gem', 'stone', 'crystal', 'ruby', 'sapphire', 'emerald'];

function disposeMaterialTextures(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value instanceof THREE.Texture) value.dispose();
  });
}

function cloneTexture(texture: THREE.Texture | null | undefined, cache: Map<THREE.Texture, THREE.Texture>) {
  if (!texture) return null;
  const cached = cache.get(texture);
  if (cached) return cached;
  const clone = texture.clone();
  clone.needsUpdate = true;
  cache.set(texture, clone);
  return clone;
}

function upgradeMaterial(
  source: THREE.Material,
  textureCache: Map<THREE.Texture, THREE.Texture>,
): THREE.MeshStandardMaterial {
  const name = source.name.toLowerCase();
  const isGem = GEM_KEYWORDS.some((keyword) => name.includes(keyword));
  const isMetal = !isGem || METAL_KEYWORDS.some((keyword) => name.includes(keyword));
  const pbrSource = source as THREE.MeshStandardMaterial;

  const material = new THREE.MeshStandardMaterial({
    name: source.name,
    color: pbrSource.color?.clone() ?? new THREE.Color(isGem ? '#ffffff' : '#f7d774'),
    map: cloneTexture(pbrSource.map, textureCache),
    normalMap: cloneTexture(pbrSource.normalMap, textureCache),
    roughnessMap: cloneTexture(pbrSource.roughnessMap, textureCache),
    metalnessMap: cloneTexture(pbrSource.metalnessMap, textureCache),
    aoMap: cloneTexture(pbrSource.aoMap, textureCache),
    emissiveMap: cloneTexture(pbrSource.emissiveMap, textureCache),
    alphaMap: cloneTexture(pbrSource.alphaMap, textureCache),
    transparent: source.transparent,
    opacity: source.opacity,
    side: source.side,
    depthWrite: source.depthWrite,
    depthTest: source.depthTest,
    metalness: isMetal ? 1.0 : 0.05,
    roughness: isGem ? 0.04 : 0.18,
    envMapIntensity: isGem ? 1.8 : 2.4,
  });

  material.toneMapped = true;
  return material;
}

function preparePremiumRingScene(source: THREE.Group) {
  const scene = source.clone(true);
  const materialCache = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const textureCache = new Map<THREE.Texture, THREE.Texture>();

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    mesh.geometry = mesh.geometry.clone();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => {
        const cached = materialCache.get(material);
        if (cached) return cached;
        const upgraded = upgradeMaterial(material, textureCache);
        materialCache.set(material, upgraded);
        return upgraded;
      });
      return;
    }

    if (mesh.material) {
      const cached = materialCache.get(mesh.material);
      if (cached) {
        mesh.material = cached;
      } else {
        const upgraded = upgradeMaterial(mesh.material, textureCache);
        materialCache.set(mesh.material, upgraded);
        mesh.material = upgraded;
      }
    }
  });

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  scene.position.sub(center);

  return scene;
}

export function disposeRingScene(scene: THREE.Object3D) {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      mesh.geometry.dispose();
      disposedGeometries.add(mesh.geometry);
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.filter(Boolean).forEach((material) => {
      if (disposedMaterials.has(material)) return;
      disposeMaterialTextures(material);
      material.dispose();
      disposedMaterials.add(material);
    });
  });
}

export function useRingModel(modelPath = MODEL_PATH) {
  const gltf = useGLTF(modelPath);
  const scene = useMemo(() => preparePremiumRingScene(gltf.scene), [gltf.scene]);

  useEffect(() => {
    console.info('[useRingModel] Model loaded from:', modelPath);
  }, [modelPath]);

  return { scene };
}

useGLTF.preload(MODEL_PATH);
