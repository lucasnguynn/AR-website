// FILE: src/services/MonocularDepthEstimator.ts
import depthWorkerUrl from '../workers/depth.worker.ts?worker&url';
import { createVerifiedWorker, fetchVerifiedAsset } from '../utils/SecurityUtils';
import type { DepthOcclusionTier } from './WebXRDepthManager';
import { protocolMessage, validateDepthOutbound, type DepthOutboundMessage } from '../protocol/workerProtocol';

/** Depth map output for a processed frame. */
export interface MonocularDepthResult {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
  readonly tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'>;
  readonly averageMs: number;
}

export interface DepthEstimatorDiagnostics {
  readonly inFlight: boolean;
  readonly submitted: number;
  readonly dropped: number;
  readonly failures: number;
  readonly inferenceP50Ms: number;
  readonly inferenceP95Ms: number;
  readonly provider: 'webgpu' | 'wasm' | 'unavailable';
}

const INIT_TIMEOUT_MS = 12_000;

/** Manages verified worker-backed monocular depth inference. */
export class MonocularDepthEstimator {
  private worker: Worker | null = null;
  private frameId = 0;
  private lastResult: MonocularDepthResult | null = null;
  private initializing: Promise<void> | null = null;
  private inFlight = false;
  private consecutiveSuccesses = 0;
  private submitted = 0;
  private dropped = 0;
  private failures = 0;
  private readonly timings: number[] = [];
  private unavailable = false;
  private provider: 'webgpu' | 'wasm' | 'unavailable' = 'unavailable';
  private preferredTier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'> = 'monocular-depth';

  constructor(private readonly modelUrl = '/models/depth/depth_anything_v2_small.onnx') {}

  async initialize(): Promise<void> {
    if (this.worker && !this.initializing) return;
    if (this.initializing) return this.initializing;
    if (this.unavailable) throw new Error('Monocular depth estimator is unavailable for this session.');

    this.initializing = this.initializeWorker();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  /** Queues a worker inference pass and returns the latest completed depth result. */
  estimate(
    image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas,
    tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'> = this.preferredTier,
  ): MonocularDepthResult | null {
    if (this.inFlight || this.unavailable) {
      this.dropped += 1;
      if (image instanceof ImageBitmap) image.close();
      return this.lastResult;
    }

    // Reserve downstream capacity before asynchronous integrity/model startup;
    // producers therefore never extract a second expensive frame meanwhile.
    this.inFlight = true;
    this.preferredTier = tier;

    void this.initialize()
      .then(() => {
        this.inFlight = false;
        this.queueEstimate(image, tier);
      })
      .catch((error: unknown) => {
        this.inFlight = false;
        this.unavailable = true;
        this.failures += 1;
        this.terminateWorker();
        if (image instanceof ImageBitmap) image.close();
        console.warn('Monocular depth estimator failed to initialize.', error);
      });

    return this.lastResult;
  }

  /** Returns the latest completed depth result without queueing a new frame. */
  getLastResult(): MonocularDepthResult | null {
    return this.lastResult;
  }

  canAcceptFrame(): boolean {
    return !this.inFlight && !this.unavailable;
  }

  diagnostics(): DepthEstimatorDiagnostics {
    const sorted = [...this.timings].sort((a, b) => a - b);
    const percentile = (fraction: number) => (
      sorted.length === 0
        ? 0
        : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
    );

    return {
      inFlight: this.inFlight,
      submitted: this.submitted,
      dropped: this.dropped,
      failures: this.failures,
      inferenceP50Ms: percentile(0.5),
      inferenceP95Ms: percentile(0.95),
      provider: this.provider,
    };
  }

  /** Terminates the depth worker and releases session-owned state. */
  dispose(): void {
    if (this.worker) {
      try {
        this.worker.postMessage(protocolMessage({ type: 'DESTROY' }));
      } catch {
        // Worker may already be shutting down. terminateWorker() remains authoritative.
      }
    }
    this.terminateWorker();
    this.lastResult = null;
    this.initializing = null;
    this.inFlight = false;
    this.unavailable = true;
  }

  private async initializeWorker(): Promise<void> {
    // Verify immutable model bytes before allocating worker/GPU resources.
    const { bytes: model } = await fetchVerifiedAsset(this.modelUrl);

    // IMPORTANT: use Vite's compiled worker URL. Passing the source .ts URL to a
    // custom worker loader may publish raw TypeScript instead of browser JavaScript.
    const workerUrl = new URL(depthWorkerUrl, window.location.href);
    const worker = await createVerifiedWorker(workerUrl);
    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Depth worker did not become ready within ${INIT_TIMEOUT_MS}ms.`));
      }, INIT_TIMEOUT_MS);

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        callback();
      };

      worker.onerror = (event) => {
        settle(() => reject(new Error(event.message || 'Depth worker failed during initialization.')));
      };

      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (validateDepthOutbound(event.data)) {
          if (event.data.type === 'READY') {
            this.provider = event.data.payload.provider;
            settle(resolve);
          } else if (event.data.type === 'ERROR' && event.data.payload.frameId === undefined) {
            settle(() => reject(new Error(event.data.payload.message)));
          }
        }
        this.receiveMessage(event.data);
      };

      worker.postMessage(protocolMessage({ type: 'INIT', payload: { model } }), [model]);
    }).catch((error) => {
      this.terminateWorker();
      throw error;
    });
  }

  private queueEstimate(
    image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas,
    tier: Extract<DepthOcclusionTier, 'monocular-depth' | 'degraded-depth'>,
  ): void {
    if (!this.worker || this.inFlight || this.unavailable) {
      this.dropped += 1;
      if (image instanceof ImageBitmap) image.close();
      return;
    }

    const frameId = ++this.frameId;
    this.inFlight = true;
    this.submitted += 1;
    this.worker.postMessage(
      protocolMessage({ type: 'DETECT', payload: { frameId, image, tier } }),
      image instanceof ImageBitmap ? [image] : [],
    );
  }

  private receiveMessage(value: unknown): void {
    if (!validateDepthOutbound(value)) {
      window.dispatchEvent(new CustomEvent('ar:protocol-error', {
        detail: { worker: 'depth', reason: 'INVALID_MESSAGE' },
      }));
      return;
    }
    this.handleMessage(value);
  }

  private handleMessage(message: DepthOutboundMessage): void {
    if (message.type === 'READY' || message.type === 'DESTROYED') return;

    if (message.type === 'ERROR') {
      this.failures += 1;
      this.inFlight = false;
      this.preferredTier = 'degraded-depth';
      this.consecutiveSuccesses = 0;
      console.warn('Monocular depth estimator failed.', message.payload.message);
      return;
    }

    if (!('payload' in message)) return;

    this.inFlight = false;
    if (message.type === 'DEGRADED') return;

    const result = message.payload;
    this.timings.push(result.averageMs);
    if (this.timings.length > 120) this.timings.shift();

    this.consecutiveSuccesses = result.tier === 'degraded-depth'
      ? this.consecutiveSuccesses + 1
      : 0;

    this.preferredTier = result.averageMs > 30
      ? 'degraded-depth'
      : this.preferredTier;

    if (result.averageMs < 15 || this.consecutiveSuccesses >= 10) {
      this.preferredTier = 'monocular-depth';
      this.consecutiveSuccesses = 0;
    }

    this.lastResult = {
      frameId: result.frameId,
      width: result.width,
      height: result.height,
      depth: result.depth,
      tier: this.preferredTier,
      averageMs: result.averageMs,
    };
  }

  private terminateWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.provider = 'unavailable';
  }
}
