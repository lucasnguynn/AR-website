export type ARExperienceKind = 'webxr' | 'quick-look' | 'camera-composite' | 'interactive-3d';
export type ARRuntimeState = 'supported' | 'initializing' | 'active' | 'degraded' | 'failed' | 'fallback-active';

export interface ARDiagnostics {
  tracking: 'none' | 'mediapipe' | 'webxr-hand';
  filter: 'one-euro' | 'ukf';
  prediction: 'none' | 'lstm' | 'transformer' | 'kinematic';
  depth: 'none' | 'geometric-proxy' | 'monocular-depth' | 'degraded-depth' | 'webxr-depth';
  renderer: 'webgpu' | 'webgl2' | 'webgl1';
  experience: ARExperienceKind;
  state: ARRuntimeState;
  failure?: string;
}

export interface ARExperienceAdapter {
  readonly kind: ARExperienceKind;
  isSupported(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): ARDiagnostics;
  onUnexpectedStop?(listener: () => void): () => void;
}

export type DiagnosticsListener = (diagnostics: ARDiagnostics) => void;

/** Owns the single active AR control path and ordered, transactional fallback. */
export class AROrchestrator {
  private active: ARExperienceAdapter | null = null;
  private startPromise: Promise<ARDiagnostics> | null = null;
  private stopping: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly adapters: readonly ARExperienceAdapter[],
    private readonly onDiagnostics: DiagnosticsListener = () => undefined,
  ) {
    for (const adapter of adapters) {
      adapter.onUnexpectedStop?.(() => {
        if (this.active !== adapter) return;
        this.active = null;
        const generation = ++this.generation;
        this.startPromise = this.selectAndStart(generation).finally(() => { this.startPromise = null; });
        void this.startPromise.catch(() => undefined);
      });
    }
  }

  get activeKind(): ARExperienceKind | null { return this.active?.kind ?? null; }
  diagnostics(): ARDiagnostics | null { return this.active?.diagnostics() ?? null; }

  start(): Promise<ARDiagnostics> {
    if (this.startPromise) return this.startPromise;
    if (this.active) return Promise.resolve(this.active.diagnostics());
    const generation = ++this.generation;
    this.startPromise = this.selectAndStart(generation).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation;
    const active = this.active;
    this.active = null;
    this.stopping = (async () => {
      if (active) await active.stop();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async selectAndStart(generation: number): Promise<ARDiagnostics> {
    let lastFailure: string | undefined;
    for (const adapter of this.adapters) {
      if (generation !== this.generation) throw new Error('AR startup was cancelled.');
      let supported = false;
      try { supported = await adapter.isSupported(); } catch (error) {
        lastFailure = error instanceof Error ? error.message : 'Capability detection failed.';
      }
      if (!supported) continue;

      this.onDiagnostics({ ...adapter.diagnostics(), state: 'initializing' });
      try {
        await adapter.start();
        if (generation !== this.generation) {
          await adapter.stop();
          throw new Error('AR startup was cancelled.');
        }
        this.active = adapter;
        const diagnostics: ARDiagnostics = {
          ...adapter.diagnostics(),
          state: lastFailure ? 'fallback-active' : adapter.diagnostics().state,
          ...(lastFailure ? { failure: lastFailure } : {}),
        };
        this.onDiagnostics(diagnostics);
        return diagnostics;
      } catch (error) {
        await adapter.stop().catch(() => undefined);
        lastFailure = error instanceof Error ? error.message : `${adapter.kind} failed to start.`;
        this.onDiagnostics({ ...adapter.diagnostics(), state: 'failed', failure: lastFailure });
      }
    }
    throw new Error(lastFailure ?? 'No AR experience is supported.');
  }
}
