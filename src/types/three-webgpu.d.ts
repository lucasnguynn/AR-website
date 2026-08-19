// FILE: src/types/three-webgpu.d.ts
declare module 'three/examples/jsm/renderers/webgpu/WebGPURenderer.js' {
  import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer';

  /** WebGPU renderer entry point used by Three.js examples builds. */
  export default class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    init(): Promise<void>;
  }
}

declare module 'three/tsl' {
  import { Color, ColorRepresentation, MeshPhysicalMaterial, Texture } from 'three';

  /** Minimal TSL node surface required by the jewelry material factory. */
  export type TSLNode = {
    value?: unknown;
    mul?: (value: unknown) => TSLNode;
    add?: (value: unknown) => TSLNode;
    clamp?: (min: number, max: number) => TSLNode;
  };

  /** Physical node material with assignable TSL node slots from Three.js r170+. */
  export class MeshPhysicalNodeMaterial extends MeshPhysicalMaterial {
    colorNode: TSLNode | null;
    roughnessNode: TSLNode | null;
    metalnessNode: TSLNode | null;
    anisotropyNode: TSLNode | null;
    clearcoatNode: TSLNode | null;
    clearcoatRoughnessNode: TSLNode | null;
    specularColorNode: TSLNode | null;
    specularIntensityNode: TSLNode | null;
  }

  /** Creates a color node value from a Three.js color representation. */
  export function color(value: ColorRepresentation): Color;
  /** Creates a float node value. */
  export function float(value: number): TSLNode;
  /** Creates a mutable uniform node. */
  export function uniform<TValue>(value: TValue): TSLNode & { value: TValue };
  /** Creates a three-component vector node. */
  export function vec3(x: number, y: number, z: number): TSLNode;
  /** World-space normal accessor node. */
  export const normalWorld: TSLNode;
  /** World-space position accessor node. */
  export const positionWorld: TSLNode;
  /** Camera position accessor node. */
  export const cameraPosition: TSLNode;
  /** Creates a PMREM texture node. */
  export function pmremTexture(texture: Texture): TSLNode;
  /** Local timer node. */
  export const timerLocal: TSLNode;
  /** Material anisotropy node accessor. */
  export const anisotropy: TSLNode;
  /** Material clearcoat node accessor. */
  export const clearcoat: TSLNode;
  /** Material clearcoat roughness node accessor. */
  export const clearcoatRoughness: TSLNode;
}

declare const __threeWebgpuVerify: '[Types] three/tsl r170 declarations ready';
// VERIFY: [Types] three/tsl r170 declarations ready
