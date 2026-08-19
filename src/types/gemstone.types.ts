// FILE: src/types/gemstone.types.ts
import type * as THREE from 'three';

/** Supported physically based gemstone presets. */
export type GemstoneType = 'diamond' | 'sapphire' | 'ruby' | 'emerald' | 'amethyst';

/** Cauchy dispersion and volumetric absorption constants for a gemstone. */
export interface GemstonePreset {
  /** Cauchy A coefficient for n(λ) with λ measured in micrometers. */
  readonly A: number;
  /** Cauchy B coefficient for n(λ) with λ measured in micrometers. */
  readonly B: number;
  /** Beer-Lambert absorption coefficient per sRGB channel. */
  readonly absorb: readonly [number, number, number];
  /** Relative strength of the procedural caustic pass. */
  readonly caustic: number;
  /** Effective optical path length through the faceted stone. */
  readonly path: number;
}

/** Runtime uniforms retained for adaptive quality controls and animation. */
export interface GemstoneShaderUniforms {
  /** Cauchy A coefficient uniform. */
  readonly cauchyA: { value: number };
  /** Cauchy B coefficient uniform. */
  readonly cauchyB: { value: number };
  /** Beer-Lambert RGB absorption uniform. */
  readonly absorption: { value: THREE.Vector3 };
  /** Effective internal path length uniform. */
  readonly pathLength: { value: number };
  /** UV scale for the Voronoi caustic texture. */
  readonly causticScale: { value: number };
  /** Runtime caustic gain; set to 0 when frameAvgMs exceeds 33ms. */
  readonly causticStrength: { value: number };
}

/** Mesh physical node material annotated with gemstone metadata. */
export type GemstoneNodeMaterial = THREE.MeshPhysicalMaterial & {
  /** Node material fields are available when running against Three.js r170+. */
  colorNode?: unknown;
  /** Transmission node for WebGPU/WebGL node material compilation. */
  transmissionNode?: unknown;
  /** Index-of-refraction node for WebGPU/WebGL node material compilation. */
  iorNode?: unknown;
  /** Thickness node for Beer-Lambert path approximation. */
  thicknessNode?: unknown;
  /** Optional emissive caustic contribution. */
  emissiveNode?: unknown;
  /** Optional roughness node. */
  roughnessNode?: unknown;
  /** Optional metalness node. */
  metalnessNode?: unknown;
  userData: THREE.Material['userData'] & {
    /** Gemstone type used to create this material. */
    gemstoneType?: GemstoneType;
    /** Live uniforms used by adaptive LOD systems. */
    gemstoneUniforms?: GemstoneShaderUniforms;
    /** Procedural Voronoi caustic texture sampled by pass 5. */
    gemstoneCausticTexture?: THREE.Texture;
  };
};

/** Backward-compatible alias for older call sites. */
export type GemstonePresetName = GemstoneType;

/** Backward-compatible options for legacy createGemstoneShader callers. */
export interface GemstoneShaderOptions {
  /** Gemstone preset to instantiate. */
  readonly preset?: GemstoneType;
  /** Optional caustic texture; one is generated when omitted. */
  readonly causticTexture?: THREE.Texture | null;
}

// VERIFY: console.log('[GemstoneTypes] GemstonePreset and GemstoneType ready');
