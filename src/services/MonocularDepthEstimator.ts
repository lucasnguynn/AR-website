// FILE: src/services/MonocularDepthEstimator.ts
import { createVerifiedWorker } from '../utils/SecurityUtils';

/**
 * Depth map output for a processed frame.
 */
export interface MonocularDepthResult {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
}

type WorkerResponse =
  | { type: 'ready' }
  | MonocularDepthResult & { type: 'depth' }
  | { type: 'skipped'; frameId: number }
  | { type: 'error'; frameId?: number; message: string };

/**
 * Manages verified worker-backed monocular depth inference.
 */
export class MonocularDepthEstimator {
  private worker: Worker | null = null;
  private pending = new Map<number, (result: MonocularDepthResult | null) => void>();
  private frameId = 0;
  private lastResult: MonocularDepthResult | null = null;
  private initializing: Promise<void> | null = null;
  private inFlight = false;

  constructor(private readonly modelUrl = '/models/depth/depth_anything_v2_small.onnx') {}

  async initialize(): Promise<void> {
    if (this.worker) return this.initializing ?? Promise.resolve();
    this.worker = await createVerifiedWorker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.initializing = new Promise((resolve) => {
      const worker = this.worker;
      if (!worker) throw new Error('Depth worker was not created after integrity verification.');
      const previousHandler = worker.onmessage;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'ready') resolve();
        previousHandler?.call(worker, event);
      };
      worker.postMessage({ type: 'init', modelUrl: this.modelUrl });
    });
    return this.initializing;
  }

  estimate(image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas): MonocularDepthResult | null {
    void this.initialize().then(() => this.queueEstimate(image)).catch((error: unknown) => {
      this.inFlight = false;
      console.warn('Monocular depth estimator failed to initialize.', error);
    });
    return this.lastResult;
  }

  getLastResult(): MonocularDepthResult | null {
    return this.lastResult;
  }

  dispose(): void {
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.lastResult = null;
    this.initializing = null;
    this.inFlight = false;
  }

  private queueEstimate(image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas): void {
    if (!this.worker || this.inFlight) return;
    const frameId = ++this.frameId;
    this.inFlight = true;
    this.pending.set(frameId, () => undefined);
    this.worker.postMessage({ type: 'estimate', frameId, image }, image instanceof ImageBitmap ? [image] : []);
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'ready') return;
    if (message.type === 'error') {
      if (message.frameId) this.pending.delete(message.frameId);
      this.inFlight = false;
      console.warn('Monocular depth estimator failed.', message.message);
      return;
    }
    this.pending.delete(message.frameId);
    this.inFlight = false;
    if (message.type === 'skipped') return;
    this.lastResult = { frameId: message.frameId, width: message.width, height: message.height, depth: message.depth };
  }
}
// VERIFY: console.log('Depth worker constructed after awaited SRI verification')
