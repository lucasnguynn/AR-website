import * as THREE from 'three';
import { createCausticTexture } from './causticTexture';
import { createGemstoneMaterial, createGemstoneWebGLMaterial } from './createGemstoneShader';
import { createJewelryShaderMaterial, updateJewelryMaterialPreset, type JewelryPreset } from './createJewelryShaderMaterial';
import type { GemstoneType } from '../types/gemstone.types';

export type RingRendererMode = 'webgpu' | 'webgl';
export type GemstoneQuality = 'HIGH' | 'MEDIUM' | 'LOW';
export type RingMaterialRole = 'metal' | 'gemstone' | 'accent';

export interface RingMaterialSemantic {
  readonly role: RingMaterialRole;
  readonly gemstone?: GemstoneType;
  readonly source: 'extras' | 'name' | 'pbr-fallback';
}

export interface RingSemanticSummary {
  readonly metalMeshes: number;
  readonly gemstoneMeshes: number;
  readonly accentMeshes: number;
  readonly fallbackClassifications: number;
  readonly gemstoneTypes: readonly GemstoneType[];
  readonly productionReady: boolean;
}

const GEM_TYPES: readonly GemstoneType[] = ['diamond', 'sapphire', 'ruby', 'emerald', 'amethyst'];
const METAL_NAMES = /(?:silver|gold|platinum|metal|band|shank|setting|ring)/i;
const GEM_NAMES = /(?:diamond|sapphire|ruby|emerald|amethyst|gem|stone|crystal)/i;
const ACCENT_NAMES = /(?:accent|detail|enamel)/i;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Exporter extras win, then stable names, then conservative PBR fallback. */
export function classifyRingMaterial(mesh: THREE.Mesh, material: THREE.Material): RingMaterialSemantic {
  const extras = { ...material.userData, ...mesh.userData };
  const explicitRole = stringValue(extras.materialRole)?.toLowerCase();
  const explicitGem = stringValue(extras.gemstoneType)?.toLowerCase();
  const gem = GEM_TYPES.find((type) => type === explicitGem);

  if (explicitRole === 'gemstone') return { role: 'gemstone', gemstone: gem ?? 'diamond', source: 'extras' };
  if (explicitRole === 'metal') return { role: 'metal', source: 'extras' };
  if (explicitRole === 'accent') return { role: 'accent', source: 'extras' };
  if (gem) return { role: 'gemstone', gemstone: gem, source: 'extras' };

  // Backward compatibility for the current single-mesh demo asset. This is not
  // considered production-ready because it cannot expose a distinct gemstone mesh.
  if (mesh.name === 'model' && material.name === 'model') return { role: 'metal', source: 'name' };

  const names = `${mesh.name} ${material.name}`;
  const namedGem = GEM_TYPES.find((type) => names.toLowerCase().includes(type));
  if (namedGem || GEM_NAMES.test(names)) return { role: 'gemstone', gemstone: namedGem ?? 'diamond', source: 'name' };
  if (ACCENT_NAMES.test(names)) return { role: 'accent', source: 'name' };
  if (METAL_NAMES.test(names)) return { role: 'metal', source: 'name' };

  const pbr = material as THREE.MeshStandardMaterial;
  return pbr.metalness >= 0.5
    ? { role: 'metal', source: 'pbr-fallback' }
    : { role: 'accent', source: 'pbr-fallback' };
}

export interface RingMaterialStrategy {
  readonly mode: RingRendererMode;
  materialFor(mesh: THREE.Mesh, source: THREE.Material): THREE.Material;
  setPreset(preset: JewelryPreset): void;
  setQuality(quality: GemstoneQuality): void;
  semanticSummary(): RingSemanticSummary;
  dispose(): void;
}

export function createRingMaterialStrategy(
  mode: RingRendererMode,
  initialPreset: JewelryPreset = 'silver',
  initialQuality: GemstoneQuality = 'HIGH',
): RingMaterialStrategy {
  const owned = new Set<THREE.Material>();
  const cache = new Map<string, THREE.Material>();
  const semanticByMesh = new Map<THREE.Mesh, RingMaterialSemantic>();
  const gemstoneMeshes = new Map<THREE.Mesh, GemstoneType>();
  const causticTexture = mode === 'webgpu' ? createCausticTexture() : null;
  let preset = initialPreset;
  let quality = initialQuality;

  const getMaterial = (semantic: RingMaterialSemantic): THREE.Material => {
    const key = semantic.role === 'gemstone' ? `gem:${semantic.gemstone}:${quality}` : semantic.role;
    const cached = cache.get(key);
    if (cached) return cached;

    let material: THREE.Material;
    if (semantic.role === 'gemstone') {
      const gem = semantic.gemstone ?? 'diamond';
      material = mode === 'webgpu'
        ? createGemstoneMaterial(gem, causticTexture!, quality)
        : createGemstoneWebGLMaterial(gem, quality);
    } else if (semantic.role === 'metal') {
      material = createJewelryShaderMaterial({ type: preset, rendererMode: mode });
    } else {
      material = new THREE.MeshPhysicalMaterial({
        name: 'RingAccentWebGL',
        color: '#d8d6cf',
        roughness: 0.3,
        metalness: 0.15,
        clearcoat: 0.45,
      });
    }

    cache.set(key, material);
    owned.add(material);
    return material;
  };

  const summary = (): RingSemanticSummary => {
    let metalMeshes = 0;
    let gemstoneCount = 0;
    let accentMeshes = 0;
    let fallbackClassifications = 0;
    const gemstoneTypes = new Set<GemstoneType>();

    semanticByMesh.forEach((semantic) => {
      if (semantic.role === 'metal') metalMeshes += 1;
      else if (semantic.role === 'gemstone') {
        gemstoneCount += 1;
        gemstoneTypes.add(semantic.gemstone ?? 'diamond');
      } else accentMeshes += 1;
      if (semantic.source === 'pbr-fallback') fallbackClassifications += 1;
    });

    return Object.freeze({
      metalMeshes,
      gemstoneMeshes: gemstoneCount,
      accentMeshes,
      fallbackClassifications,
      gemstoneTypes: Object.freeze([...gemstoneTypes]),
      productionReady: metalMeshes > 0 && gemstoneCount > 0 && fallbackClassifications === 0,
    });
  };

  return {
    mode,
    materialFor(mesh, source) {
      const semantic = classifyRingMaterial(mesh, source);
      semanticByMesh.set(mesh, semantic);
      if (semantic.role === 'gemstone') gemstoneMeshes.set(mesh, semantic.gemstone ?? 'diamond');
      mesh.userData.ringMaterialSemantic = semantic;
      return getMaterial(semantic);
    },
    setPreset(nextPreset) {
      if (nextPreset === preset) return;
      preset = nextPreset;
      const material = cache.get('metal');
      if (material) updateJewelryMaterialPreset(material, preset);
    },
    setQuality(nextQuality) {
      if (nextQuality === quality) return;
      quality = nextQuality;
      gemstoneMeshes.forEach((gem, mesh) => {
        mesh.material = getMaterial({ role: 'gemstone', gemstone: gem, source: 'extras' });
      });
    },
    semanticSummary: summary,
    dispose() {
      owned.forEach((material) => material.dispose());
      owned.clear();
      cache.clear();
      semanticByMesh.clear();
      gemstoneMeshes.clear();
      causticTexture?.dispose();
    },
  };
}
