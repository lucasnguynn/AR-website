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

export class MonocularDepthEstimator {
  private worker: Worker | null = null;
  private pending = new Map<number, (result: MonocularDepthResult | null) => void>();
  private frameId = 0;
  private lastResult: MonocularDepthResult | null = null;

  constructor(private readonly modelUrl = '/models/depth/model.json') {}

  async initialize(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.worker.postMessage({ type: 'init', modelUrl: this.modelUrl });
  }

  async estimate(image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas): Promise<MonocularDepthResult | null> {
    await this.initialize();
    const worker = this.worker;
    if (!worker) return null;
    const frameId = ++this.frameId;
    return new Promise((resolve) => {
      this.pending.set(frameId, resolve);
      worker.postMessage({ type: 'estimate', frameId, image }, image instanceof ImageBitmap ? [image] : []);
    });
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
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'ready') return;
    if (message.type === 'error') {
      if (message.frameId) this.pending.get(message.frameId)?.(null);
      if (message.frameId) this.pending.delete(message.frameId);
      console.warn('Monocular depth estimator failed.', message.message);
      return;
    }
    const resolve = this.pending.get(message.frameId);
    this.pending.delete(message.frameId);
    if (message.type === 'skipped') {
      resolve?.(this.lastResult);
      return;
    }
    this.lastResult = { frameId: message.frameId, width: message.width, height: message.height, depth: message.depth };
    resolve?.(this.lastResult);
  }
}
