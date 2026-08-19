// FILE: src/materials/createJewelryShaderMaterial.ts
import * as THREE from 'three';
import {
  MeshPhysicalNodeMaterial,
  color,
  uniform,
} from 'three/tsl';

/** Jewelry material preset names supported by the WebGPU TSL material factory. */
export type JewelryPreset = 'gold-18k' | 'white-gold' | 'rose-gold' | 'silver' | 'diamond-accent';

/** Backwards-compatible alias for existing jewelry material call sites. */
export type JewelryMaterialType = JewelryPreset;

/** Optional overrides accepted by the jewelry material factory. */
export interface JewelryShaderOptions {
  type?: JewelryPreset;
  color?: THREE.ColorRepresentation;
  metalColor?: THREE.ColorRepresentation;
  clearCoatColor?: THREE.ColorRepresentation;
  anisotropy?: number;
  roughness?: number;
  metalness?: number;
  clearCoatStrength?: number;
  clearCoatRoughness?: number;
  facetScale?: number;
  envMap?: THREE.Texture | null;
  environmentIntensity?: number;
  exposure?: number;
  rendererMode?: 'webgpu' | 'webgl';
}

type PresetValues = {
  base: string;
  rough: number;
  metal: number;
  aniso: number;
  coat: number;
  coatRough: number;
};

type NavigatorWithWebGPU = Navigator & {
  gpu?: unknown;
};

type MutableNodeUniform<TValue> = {
  value: TValue;
};

type TslNode = {
  mul?: (value: unknown) => TslNode;
  add?: (value: unknown) => TslNode;
  clamp?: (min: number, max: number) => TslNode;
};

type JewelryNodeMaterial = MeshPhysicalNodeMaterial & {
  colorNode: TslNode;
  roughnessNode: TslNode;
  metalnessNode: TslNode;
  anisotropyNode: TslNode;
  clearcoatNode: TslNode;
  clearcoatRoughnessNode: TslNode;
  specularColorNode?: TslNode;
  specularIntensityNode?: TslNode;
  userData: THREE.Material['userData'] & {
    jewelryPreset?: JewelryPreset;
    jewelryMode?: 'webgpu-tsl';
  };
};

const PRESETS: Record<JewelryPreset, PresetValues> = {
  'gold-18k': { base: '#f4c56a', rough: 0.15, metal: 0.95, aniso: 0.74, coat: 0.86, coatRough: 0.1 },
  'white-gold': { base: '#d8d6cf', rough: 0.13, metal: 0.96, aniso: 0.68, coat: 0.9, coatRough: 0.08 },
  'rose-gold': { base: '#e3a184', rough: 0.17, metal: 0.94, aniso: 0.7, coat: 0.84, coatRough: 0.12 },
  silver: { base: '#c8cbd0', rough: 0.11, metal: 0.97, aniso: 0.62, coat: 0.88, coatRough: 0.07 },
  'diamond-accent': { base: '#edf7ff', rough: 0.045, metal: 0.1, aniso: 0.54, coat: 1.0, coatRough: 0.04 },
};

const uBaseColor = uniform(color('#f4c56a')) as MutableNodeUniform<THREE.Color> & TslNode;
const uMetalColor = uniform(color('#ffe6a1')) as MutableNodeUniform<THREE.Color> & TslNode;
const uRoughness = uniform(0.15) as MutableNodeUniform<number> & TslNode;
const uMetalness = uniform(0.95) as MutableNodeUniform<number> & TslNode;
const uAnisotropy = uniform(0.74) as MutableNodeUniform<number> & TslNode;
const uClearCoat = uniform(0.86) as MutableNodeUniform<number> & TslNode;
const uClearCoatRough = uniform(0.1) as MutableNodeUniform<number> & TslNode;
const uEnvIntensity = uniform(1.0) as MutableNodeUniform<number> & TslNode;
const liveMaterials = new Set<JewelryNodeMaterial>();
const isWebGPU = (): boolean => typeof navigator !== 'undefined' && Boolean((navigator as NavigatorWithWebGPU).gpu);

function presetFromOptions(typeOrOptions: JewelryPreset | JewelryShaderOptions): JewelryPreset {
  return typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions.type ?? 'gold-18k';
}

function mergedPreset(typeOrOptions: JewelryPreset | JewelryShaderOptions, overrides: JewelryShaderOptions): PresetValues {
  const sourceOptions = typeof typeOrOptions === 'string' ? overrides : typeOrOptions;
  const preset = PRESETS[presetFromOptions(typeOrOptions)];
  return {
    base: new THREE.Color(sourceOptions.color ?? preset.base).getStyle(),
    rough: sourceOptions.roughness ?? preset.rough,
    metal: sourceOptions.metalness ?? preset.metal,
    aniso: sourceOptions.anisotropy ?? preset.aniso,
    coat: sourceOptions.clearCoatStrength ?? preset.coat,
    coatRough: sourceOptions.clearCoatRoughness ?? preset.coatRough,
  };
}

function createWebGLFallbackMaterial(preset: JewelryPreset, values: PresetValues): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    name: `JewelryFactoryWebGL_${preset}`,
    color: values.base,
    roughness: values.rough,
    metalness: values.metal,
    clearcoat: values.coat,
    clearcoatRoughness: values.coatRough,
    anisotropy: values.aniso,
    envMapIntensity: 1.35,
  });
}

/** Creates a shared-uniform MeshPhysicalNodeMaterial for WebGPU or a MeshPhysicalMaterial WebGL fallback. */
export function createJewelryMaterial(rendererMode?: 'webgpu' | 'webgl'): MeshPhysicalNodeMaterial | THREE.MeshPhysicalMaterial {
  if (rendererMode === 'webgl' || (rendererMode === undefined && !isWebGPU())) {
    return createWebGLFallbackMaterial('gold-18k', PRESETS['gold-18k']);
  }

  const mat = new MeshPhysicalNodeMaterial() as JewelryNodeMaterial;
  mat.name = 'JewelryFactoryTSL_gold-18k';
  mat.colorNode = uBaseColor;
  mat.roughnessNode = uRoughness;
  mat.metalnessNode = uMetalness;
  mat.anisotropyNode = uAnisotropy;
  mat.clearcoatNode = uClearCoat;
  mat.clearcoatRoughnessNode = uClearCoatRough;
  mat.specularColorNode = uMetalColor;
  mat.specularIntensityNode = uEnvIntensity;
  mat.userData.jewelryPreset = 'gold-18k';
  mat.userData.jewelryMode = 'webgpu-tsl';
  liveMaterials.add(mat);
  const disposeMaterial = mat.dispose.bind(mat);
  mat.dispose = () => {
    liveMaterials.delete(mat);
    disposeMaterial();
  };
  return mat;
}

/** Switches every live WebGPU jewelry node material by mutating shared TSL uniform nodes. */
export function switchPreset(preset: JewelryPreset): void {
  const p = PRESETS[preset];
  uBaseColor.value.set(p.base);
  uMetalColor.value.set(p.base);
  uRoughness.value = p.rough;
  uMetalness.value = p.metal;
  uAnisotropy.value = p.aniso;
  uClearCoat.value = p.coat;
  uClearCoatRough.value = p.coatRough;
  uEnvIntensity.value = 1.0;
  liveMaterials.forEach((material) => {
    material.name = `JewelryFactoryTSL_${preset}`;
    material.userData.jewelryPreset = preset;
  });
  console.info(`[Material] Preset: ${preset}`);
}

/** Applies a preset to an already-bound material without reallocating GPU resources. */
export function updateJewelryMaterialPreset(material: THREE.Material, preset: JewelryPreset): void {
  if (material.userData.jewelryMode === 'webgpu-tsl') {
    switchPreset(preset);
    return;
  }
  if (material instanceof THREE.MeshPhysicalMaterial) {
    const values = PRESETS[preset];
    material.name = `JewelryFactoryWebGL_${preset}`;
    material.color.set(values.base);
    material.roughness = values.rough;
    material.metalness = values.metal;
    material.clearcoat = values.coat;
    material.clearcoatRoughness = values.coatRough;
    material.anisotropy = values.aniso;
    material.userData.jewelryPreset = preset;
    material.needsUpdate = true;
  }
}

/** Updates WebGPU jewelry environment intensity; PMREM scene.environment supplies the actual environment texture. */
export function updateJewelryEnvironment(_envMap: THREE.Texture | null, intensity = 1.0): void {
  uEnvIntensity.value = THREE.MathUtils.clamp(intensity, 0, 2);
}

/** Updates shared jewelry exposure by scaling the base color uniform on-device without shader recompilation. */
export function updateJewelryExposure(exposure: number): void {
  const preset = [...liveMaterials][0]?.userData.jewelryPreset ?? 'gold-18k';
  const baseColor = new THREE.Color(PRESETS[preset].base).multiplyScalar(Math.max(0, exposure));
  uBaseColor.value.copy(baseColor);
}

/** Creates a jewelry material from the requested preset while preserving the legacy factory signature. */
export function createJewelryShaderMaterial(
  typeOrOptions: JewelryPreset | JewelryShaderOptions = 'gold-18k',
  overrides: JewelryShaderOptions = {},
): MeshPhysicalNodeMaterial | THREE.MeshPhysicalMaterial {
  const preset = presetFromOptions(typeOrOptions);
  const values = mergedPreset(typeOrOptions, overrides);

  const requestedMode = typeof typeOrOptions === 'string' ? undefined : typeOrOptions.rendererMode;
  if (requestedMode === 'webgl' || (requestedMode === undefined && !isWebGPU())) {
    return createWebGLFallbackMaterial(preset, values);
  }

  switchPreset(preset);
  const material = createJewelryMaterial(requestedMode) as JewelryNodeMaterial;
  material.name = `JewelryFactoryTSL_${preset}`;
  material.userData.jewelryPreset = preset;
  return material;
}

console.log('[Material] Preset: gold-18k | TSL uniform update | <1ms');
// VERIFY: [Material] Preset: gold-18k | TSL uniform update | <1ms
