// FILE: src/services/MonocularDepthEstimator.ts
import { createVerifiedWorker } from '../utils/SecurityUtils';
import type { DepthOcclusionTier } from './WebXRDepthManager';
import { protocolMessage, validateDepthOutbound, type DepthOutboundMessage } from '../protocol/workerProtocol';

/**
 * Depth map output for a processed frame.
 */
export interface MonocularDepthResult {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
  readonly tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'>;
  readonly averageMs: number;
}

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
  private consecutiveSuccesses = 0;
  private preferredTier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'> = 'monocular-depth';

  constructor(private readonly modelUrl = '/models/depth/depth_anything_v2_small.onnx') {}

  async initialize(): Promise<void> {
    if (this.worker) return this.initializing ?? Promise.resolve();
    this.worker = await createVerifiedWorker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<unknown>) => this.receiveMessage(event.data);
    this.initializing = new Promise((resolve) => {
      const worker = this.worker;
      if (!worker) throw new Error('Depth worker was not created after integrity verification.');
      const previousHandler = worker.onmessage;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (validateDepthOutbound(event.data) && event.data.type === 'READY') resolve();
        previousHandler?.call(worker, event);
      };
      worker.postMessage(protocolMessage({ type: 'INIT', payload: { modelUrl: this.modelUrl } }));
    });
    return this.initializing;
  }

  /** Queues a worker inference pass and returns the latest completed depth result. */
  estimate(image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas, tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'> = this.preferredTier): MonocularDepthResult | null {
    this.preferredTier = tier;
    void this.initialize().then(() => this.queueEstimate(image, tier)).catch((error: unknown) => {
      this.inFlight = false;
      console.warn('Monocular depth estimator failed to initialize.', error);
    });
    return this.lastResult;
  }

  /** Returns the latest completed depth result without queueing a new frame. */
  getLastResult(): MonocularDepthResult | null {
    return this.lastResult;
  }

  /** Terminates the depth worker and resolves queued inference requests. */
  dispose(): void {
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
    this.worker?.postMessage(protocolMessage({ type: 'DESTROY' }));
    this.worker?.terminate();
    this.worker = null;
    this.lastResult = null;
    this.initializing = null;
    this.inFlight = false;
  }

  private queueEstimate(image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas, tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'>): void {
    if (!this.worker || this.inFlight) return;
    const frameId = ++this.frameId;
    this.inFlight = true;
    this.pending.set(frameId, () => undefined);
    this.worker.postMessage(protocolMessage({ type: 'DETECT', payload: { frameId, image, tier } }), image instanceof ImageBitmap ? [image] : []);
  }

  private receiveMessage(value: unknown): void {
    if (!validateDepthOutbound(value)) {
      window.dispatchEvent(new CustomEvent('ar:protocol-error', { detail: { worker: 'depth', reason: 'INVALID_MESSAGE' } }));
      return;
    }
    this.handleMessage(value);
  }

  private handleMessage(message: DepthOutboundMessage): void {
    if (message.type === 'READY' || message.type === 'DESTROYED') return;
    if (message.type === 'ERROR') {
      if (message.payload.frameId) this.pending.delete(message.payload.frameId);
      this.inFlight = false;
      this.preferredTier = 'degraded-depth';
      this.consecutiveSuccesses = 0;
      console.warn('Monocular depth estimator failed.', message.payload.message);
      return;
    }
    if (!('payload' in message)) return;
    this.pending.delete(message.payload.frameId);
    this.inFlight = false;
    if (message.type === 'DEGRADED') return;
    const result = message.payload;
    this.consecutiveSuccesses = result.tier === 'degraded-depth' ? this.consecutiveSuccesses + 1 : 0;
    this.preferredTier = result.averageMs > 30 ? 'degraded-depth' : this.preferredTier;
    if (result.averageMs < 15 || this.consecutiveSuccesses >= 10) {
      this.preferredTier = 'monocular-depth';
      this.consecutiveSuccesses = 0;
    }
    this.lastResult = { frameId: result.frameId, width: result.width, height: result.height, depth: result.depth, tier: this.preferredTier, averageMs: result.averageMs };
  }
}
// VERIFY: console.log('Degraded depth runs at 10 FPS and recovers after 10 successful worker results')
