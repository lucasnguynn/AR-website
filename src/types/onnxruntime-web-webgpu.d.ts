// FILE: src/types/onnxruntime-web-webgpu.d.ts
declare module 'onnxruntime-web/webgpu' {
  /** ONNX Runtime tensor data type supported by the depth worker. */
  export type TensorDataType = 'float32';

  /** ONNX Runtime tensor used by the depth worker. */
  export class Tensor {
    /** Creates a typed ONNX tensor. */
    constructor(type: TensorDataType, data: Float32Array, dims: readonly number[]);
  }

  /** ONNX Runtime tensor output shape used by the depth worker. */
  export interface TensorLike {
    readonly data: Float32Array | readonly number[];
    readonly dims: readonly number[];
  }

  /** ONNX Runtime inference session options. */
  export interface InferenceSessionOptions {
    readonly executionProviders: readonly string[];
    readonly graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
  }

  /** ONNX Runtime inference session used by the depth worker. */
  export interface InferenceSession {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    /** Runs one inference pass. */
    run(feeds: Record<string, Tensor>): Promise<Record<string, TensorLike>>;
  }

  /** Factory namespace for ONNX Runtime inference sessions. */
  export const InferenceSession: {
    /** Creates an inference session from an in-memory ONNX model. */
    create(model: ArrayBuffer, options: InferenceSessionOptions): Promise<InferenceSession>;
  };

  /** Runtime environment configuration for ONNX Runtime Web. */
  export const env: { wasm: { wasmPaths: string } };
}
// VERIFY: console.log('onnxruntime-web/webgpu type shim supports strict worker compilation')
