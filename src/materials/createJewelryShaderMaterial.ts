import * as THREE from 'three';
export type JewelryMaterialType = 'gold-18k' | 'white-gold' | 'rose-gold' | 'silver' | 'diamond-accent';

export interface JewelryShaderOptions {
  type?: JewelryMaterialType;
  color?: THREE.ColorRepresentation;
  metalColor?: THREE.ColorRepresentation;
  clearCoatColor?: THREE.ColorRepresentation;
  anisotropy?: number;
  roughness?: number;
  clearCoatStrength?: number;
  facetScale?: number;
  envMap?: THREE.Texture | null;
  environmentIntensity?: number;
  exposure?: number;
}

type JewelryPreset = Required<Pick<JewelryShaderOptions,
  'color' | 'metalColor' | 'clearCoatColor' | 'anisotropy' | 'roughness' | 'clearCoatStrength' | 'facetScale' | 'environmentIntensity' | 'exposure'
>>;

type TSLNode = { value?: unknown; mul?: (value: unknown) => TSLNode; clamp?: (min: number, max: number) => TSLNode };

type JewelryNodeUniforms = {
  baseColor: TSLNode;
  metalColor: TSLNode;
  clearCoatColor: TSLNode;
  anisotropy: TSLNode;
  roughness: TSLNode;
  clearCoatStrength: TSLNode;
  facetScale: TSLNode;
  environmentIntensity: TSLNode;
  exposure: TSLNode;
};

type JewelryNodeMaterial = THREE.MeshPhysicalMaterial & Record<string, unknown> & {
  userData: THREE.Material['userData'] & {
    jewelryUniforms?: JewelryNodeUniforms;
    jewelryBaseColor?: THREE.Color;
  };
};

const PRESETS: Record<JewelryMaterialType, JewelryPreset> = {
  'gold-18k': {
    color: '#f4c56a',
    metalColor: '#ffe6a1',
    clearCoatColor: '#fff8da',
    anisotropy: 0.74,
    roughness: 0.15,
    clearCoatStrength: 0.86,
    facetScale: 176,
    environmentIntensity: 0.88,
    exposure: 1.0,
  },
  'white-gold': {
    color: '#d8d6cf',
    metalColor: '#f8f6ed',
    clearCoatColor: '#ffffff',
    anisotropy: 0.68,
    roughness: 0.13,
    clearCoatStrength: 0.9,
    facetScale: 212,
    environmentIntensity: 0.92,
    exposure: 1.04,
  },
  'rose-gold': {
    color: '#e3a184',
    metalColor: '#ffd0ba',
    clearCoatColor: '#fff1e9',
    anisotropy: 0.7,
    roughness: 0.17,
    clearCoatStrength: 0.84,
    facetScale: 168,
    environmentIntensity: 0.82,
    exposure: 1.0,
  },
  silver: {
    color: '#c8cbd0',
    metalColor: '#f2f7ff',
    clearCoatColor: '#ffffff',
    anisotropy: 0.62,
    roughness: 0.11,
    clearCoatStrength: 0.88,
    facetScale: 196,
    environmentIntensity: 0.78,
    exposure: 1.06,
  },
  'diamond-accent': {
    color: '#edf7ff',
    metalColor: '#ffffff',
    clearCoatColor: '#ccecff',
    anisotropy: 0.54,
    roughness: 0.045,
    clearCoatStrength: 1.0,
    facetScale: 340,
    environmentIntensity: 1.0,
    exposure: 1.16,
  },
};

const liveMaterials = new Set<JewelryNodeMaterial>();
const clampEnv = (value: number) => THREE.MathUtils.clamp(value, 0.65, 1.0);

function setUniformValue(node: TSLNode | undefined, value: number): void {
  if (!node) return;
  node.value = value;
}

function createUniformNode(value: unknown): TSLNode {
  return { value };
}

function createColorNode(value: THREE.ColorRepresentation): TSLNode {
  return { value: new THREE.Color(value) };
}

function createUniformNodes(options: JewelryShaderOptions, preset: JewelryPreset): JewelryNodeUniforms {
  return {
    baseColor: createColorNode(options.color ?? preset.color),
    metalColor: createColorNode(options.metalColor ?? preset.metalColor),
    clearCoatColor: createColorNode(options.clearCoatColor ?? preset.clearCoatColor),
    anisotropy: createUniformNode(options.anisotropy ?? preset.anisotropy),
    roughness: createUniformNode(options.roughness ?? preset.roughness),
    clearCoatStrength: createUniformNode(options.clearCoatStrength ?? preset.clearCoatStrength),
    facetScale: createUniformNode(options.facetScale ?? preset.facetScale),
    environmentIntensity: createUniformNode(clampEnv(options.environmentIntensity ?? preset.environmentIntensity)),
    exposure: createUniformNode(options.exposure ?? preset.exposure),
  };
}

export function updateJewelryEnvironment(envMap: THREE.Texture | null, intensity = 0.88): void {
  liveMaterials.forEach((material) => {
    material.envMap = envMap;
    material.envMapIntensity = clampEnv(intensity);
    setUniformValue(material.userData.jewelryUniforms?.environmentIntensity, material.envMapIntensity);
    material.needsUpdate = true;
  });
}

export function updateJewelryExposure(exposure: number): void {
  liveMaterials.forEach((material) => {
    const safeExposure = Math.max(0.0, exposure);
    setUniformValue(material.userData.jewelryUniforms?.exposure, safeExposure);
    const baseColor = material.userData.jewelryBaseColor ?? material.color;
    material.color.copy(baseColor).multiplyScalar(safeExposure);
    material.needsUpdate = true;
  });
}

export function createJewelryShaderMaterial(
  typeOrOptions: JewelryMaterialType | JewelryShaderOptions = 'gold-18k',
  overrides: JewelryShaderOptions = {},
): THREE.MeshPhysicalMaterial {
  const options = typeof typeOrOptions === 'string' ? { ...overrides, type: typeOrOptions } : typeOrOptions;
  const materialType = options.type ?? 'gold-18k';
  const preset = PRESETS[materialType];
  const uniforms = createUniformNodes(options, preset);
  const baseColor = new THREE.Color(options.color ?? preset.color);
  const metalColor = new THREE.Color(options.metalColor ?? preset.metalColor);
  const clearCoatColor = new THREE.Color(options.clearCoatColor ?? preset.clearCoatColor);
  const exposure = options.exposure ?? preset.exposure;
  const roughness = options.roughness ?? preset.roughness;
  const clearCoatStrength = options.clearCoatStrength ?? preset.clearCoatStrength;
  const environmentIntensity = clampEnv(options.environmentIntensity ?? preset.environmentIntensity);

  const material = new THREE.MeshPhysicalMaterial({
    name: `JewelryFactoryTSL_${materialType}`,
    color: baseColor.clone().multiplyScalar(exposure),
    metalness: materialType === 'diamond-accent' ? 0.08 : 1.0,
    roughness,
    clearcoat: clearCoatStrength,
    clearcoatRoughness: THREE.MathUtils.clamp(roughness * 0.42, 0.02, 0.18),
    envMap: options.envMap ?? null,
    envMapIntensity: environmentIntensity,
  }) as JewelryNodeMaterial;

  const nodeMaterial = material as JewelryNodeMaterial;
  nodeMaterial.colorNode = uniforms.baseColor.mul?.(uniforms.exposure) ?? uniforms.baseColor;
  nodeMaterial.specularColorNode = uniforms.metalColor;
  nodeMaterial.specularIntensityNode = uniforms.environmentIntensity;
  nodeMaterial.roughnessNode = uniforms.roughness;
  nodeMaterial.metalnessNode = createUniformNode(materialType === 'diamond-accent' ? 0.08 : 1.0);
  nodeMaterial.clearcoatNode = uniforms.clearCoatStrength;
  nodeMaterial.clearcoatRoughnessNode = uniforms.roughness.mul?.(0.42).clamp?.(0.02, 0.18) ?? uniforms.roughness;
  nodeMaterial.sheenNode = uniforms.anisotropy.mul?.(0.18) ?? uniforms.anisotropy;
  nodeMaterial.sheenRoughnessNode = uniforms.roughness;
  nodeMaterial.emissiveNode = uniforms.clearCoatColor.mul?.(uniforms.environmentIntensity).mul?.(0.035) ?? uniforms.clearCoatColor;
  material.userData.jewelryUniforms = uniforms;
  material.userData.jewelryBaseColor = baseColor.clone();
  material.userData.facetScale = uniforms.facetScale;
  material.userData.clearCoatColor = clearCoatColor;
  material.userData.metalColor = metalColor;

  const baseDispose = material.dispose.bind(material);
  material.dispose = () => {
    liveMaterials.delete(material);
    baseDispose();
  };
  liveMaterials.add(material);
  return material;
}
