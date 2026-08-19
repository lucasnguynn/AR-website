// FILE: src/types/tensorflow-js.d.ts
declare module '@tensorflow/tfjs-backend-webgpu';

declare module '@tensorflow/tfjs-core' {
  /** Tensor handle with synchronous data extraction. */
  export interface Tensor {
    dataSync(): Float32Array | Int32Array | Uint8Array;
    dispose(): void;
  }

  /** Keras-style model with the subset required for local micro-training. */
  export interface LayersModel {
    compile(config: { optimizer: unknown; loss: string }): void;
    fit(x: Tensor, y: Tensor, config: { epochs: number; batchSize: number; callbacks: { onEpochEnd(epoch: number, logs?: { loss?: number }): Promise<void> | void } }): Promise<unknown>;
    getWeights(): Tensor[];
    dispose(): void;
  }

  /** Layer constructors exposed by TensorFlow.js. */
  export const layers: {
    lstm(config: { units: number; inputShape: [number, number]; returnSequences: boolean }): unknown;
    dense(config: { units: number }): unknown;
  };

  /** Optimizer constructors exposed by TensorFlow.js. */
  export const train: { adam(learningRate: number): unknown };

  /** Creates a sequential model. */
  export function sequential(config: { layers: unknown[] }): LayersModel;

  /** Creates a rank-3 tensor. */
  export function tensor3d(values: number[][][]): Tensor;

  /** Creates a rank-2 tensor. */
  export function tensor2d(values: number[][]): Tensor;

  /** Selects the active TensorFlow.js backend. */
  export function setBackend(backendName: string): Promise<boolean>;

  /** Resolves when TensorFlow.js is ready. */
  export function ready(): Promise<void>;
}
