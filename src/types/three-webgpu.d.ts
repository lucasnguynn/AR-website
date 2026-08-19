// FILE: src/types/three-webgpu.d.ts
declare module 'three/examples/jsm/renderers/webgpu/WebGPURenderer.js' {
  import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer';

  /** WebGPU renderer entry point used by Three.js examples builds. */
  export default class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    init(): Promise<void>;
  }
}

declare module 'three/addons/renderers/webgpu/WebGPURenderer.js' {
  import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer';
  export default class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    init(): Promise<void>;
  }
}

declare module 'three/tsl' {
  import { Color, ColorRepresentation, MeshPhysicalMaterial, Texture } from 'three';

  /** Minimal TSL node surface required by WebGPU material factories. */
  export interface TSLNode {
    readonly value?: unknown;
    readonly x?: TSLNode;
    readonly y?: TSLNode;
    readonly z?: TSLNode;
    readonly r?: TSLNode;
    readonly rgb?: TSLNode;
    mul?: (value: unknown) => TSLNode;
    add?: (value: unknown) => TSLNode;
    sub?: (value: unknown) => TSLNode;
    div?: (value: unknown) => TSLNode;
    negate?: () => TSLNode;
    normalize?: () => TSLNode;
    exp?: () => TSLNode;
    sin?: () => TSLNode;
    cos?: () => TSLNode;
    asin?: () => TSLNode;
    clamp?: (min: number, max: number) => TSLNode;
    lessThan?: (value: unknown) => TSLNode;
    select?: (whenTrue: TSLNode, whenFalse: TSLNode) => TSLNode;
  }

  /** Physical node material with assignable TSL node slots from Three.js r170+. */
  export class MeshPhysicalNodeMaterial extends MeshPhysicalMaterial {
    colorNode: TSLNode | null;
    transmissionNode: TSLNode | null;
    iorNode: TSLNode | null;
    thicknessNode: TSLNode | null;
    emissiveNode: TSLNode | null;
    roughnessNode: TSLNode | null;
    metalnessNode: TSLNode | null;
    anisotropyNode: TSLNode | null;
    clearcoatNode: TSLNode | null;
    clearcoatRoughnessNode: TSLNode | null;
    specularColorNode: TSLNode | null;
    specularIntensityNode: TSLNode | null;
  }

  /** Creates a composable TSL function node. */
  export function Fn(factory: (args: readonly TSLNode[]) => TSLNode): (...args: readonly TSLNode[]) => TSLNode;
  /** Compatibility name used by the r163-r170 nodes entry point. */
  export const tslFn: typeof Fn;
  /** Creates a color node value from a Three.js color representation. */
  export function color(value: ColorRepresentation): Color;
  /** Creates a float node value. */
  export function float(value: number): TSLNode;
  /** Creates a mutable uniform node. */
  export function uniform<TValue>(value: TValue): TSLNode & { value: TValue };
  /** Creates a two-component vector node. */
  export function vec2(x: TSLNode | number, y: TSLNode | number): TSLNode;
  /** Creates a three-component vector node. */
  export function vec3(x: TSLNode | number, y?: TSLNode | number, z?: TSLNode | number): TSLNode;
  /** Linearly interpolates between two nodes. */
  export function mix(a: TSLNode, b: TSLNode, t: TSLNode): TSLNode;
  /** Reflects an incident vector around a normal. */
  export function reflect(incident: TSLNode, normal: TSLNode): TSLNode;
  /** Refracts an incident vector through a normal. */
  export function refract(incident: TSLNode, normal: TSLNode, eta: TSLNode): TSLNode;
  /** Samples a texture node. */
  export function texture(texture: Texture | TSLNode, uv?: TSLNode): TSLNode;
  /** Dot product node. */
  export function dot(a: TSLNode, b: TSLNode): TSLNode;
  /** Maximum value node. */
  export function max(a: TSLNode, b: TSLNode | number): TSLNode;
  /** Clamp value node. */
  export function clamp(value: TSLNode, min: TSLNode | number, max: TSLNode | number): TSLNode;
  /** World-space normal accessor node. */
  export const normalWorld: TSLNode;
  /** World-space position accessor node. */
  export const positionWorld: TSLNode;
  /** Camera position accessor node. */
  export const cameraPosition: TSLNode;
  /** Creates a PMREM texture node. */
  export function pmremTexture(texture: Texture): TSLNode;
  /** Local timer node. */
  export function timerLocal(): TSLNode;
  /** Material anisotropy node accessor. */
  export const anisotropy: TSLNode;
  /** Material clearcoat node accessor. */
  export const clearcoat: TSLNode;
  /** Material clearcoat roughness node accessor. */
  export const clearcoatRoughness: TSLNode;
}

/** r163-r170 compatibility export; r170 keeps the nodes entry point alongside three/tsl. */
declare module 'three/nodes' {
  export * from 'three/tsl';
}

declare const __threeWebgpuVerify: '[Types] three/tsl r170 declarations ready';
// VERIFY: [Types] three/tsl r170 declarations ready
