declare module 'three/examples/jsm/renderers/webgpu/WebGPURenderer.js' {
  import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer';

  export default class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    init(): Promise<void>;
  }
}
