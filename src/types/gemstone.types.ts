import type * as THREE from 'three';

export type GemstonePresetName = 'diamond' | 'sapphire' | 'ruby' | 'emerald';

export interface CauchyCoefficients {
  /** Unitless Cauchy A coefficient. Diamond default is 2.3919. */
  a: number;
  /** Cauchy B coefficient for wavelengths expressed in micrometers. Diamond default is 0.01244. */
  b: number;
}

export interface GemstoneShaderOptions {
  preset?: GemstonePresetName;
  baseColor?: THREE.ColorRepresentation;
  absorptionColor?: THREE.ColorRepresentation;
  absorptionStrength?: number;
  pathLength?: number;
  cauchy?: CauchyCoefficients;
  causticTexture?: THREE.Texture | null;
  causticStrength?: number;
  causticScale?: number;
  dispersionStrength?: number;
  facetStrength?: number;
  environmentIntensity?: number;
  time?: number;
}

export interface GemstoneShaderUniforms {
  baseColor: { value: THREE.Color };
  absorptionColor: { value: THREE.Color };
  absorptionStrength: { value: number };
  pathLength: { value: number };
  cauchyA: { value: number };
  cauchyB: { value: number };
  causticStrength: { value: number };
  causticScale: { value: number };
  dispersionStrength: { value: number };
  facetStrength: { value: number };
  environmentIntensity: { value: number };
  time: { value: number };
}

export type GemstoneNodeMaterial = THREE.MeshPhysicalMaterial & Record<string, unknown> & {
  userData: THREE.Material['userData'] & {
    gemstoneUniforms?: GemstoneShaderUniforms;
    gemstoneCausticTexture?: THREE.Texture | null;
  };
};
