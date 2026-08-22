import { WebXRManager } from '../services/WebXRManager';
import type { ARDiagnostics, ARExperienceAdapter, ARExperienceKind } from './AROrchestrator';

type Lifecycle = { start?: () => void | Promise<void>; stop?: () => void | Promise<void> };

class LifecycleAdapter implements ARExperienceAdapter {
  private active = false;
  private starting = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    readonly kind: ARExperienceKind,
    private readonly supported: () => boolean | Promise<boolean>,
    private readonly lifecycle: Lifecycle,
    private readonly values: Omit<ARDiagnostics, 'experience' | 'state'>,
  ) {}

  isSupported(): boolean | Promise<boolean> { return this.supported(); }

  async start(): Promise<void> {
    if (this.active || this.starting) return;
    this.starting = true;
    try {
      await this.lifecycle.start?.();
      this.active = true;
    } catch (error) {
      // A lifecycle can allocate camera/worker state before failing. Clean that
      // partial state before the orchestrator moves to the next adapter.
      try { await this.lifecycle.stop?.(); } catch { /* preserve the original startup error */ }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.active && !this.starting) return Promise.resolve();
    this.active = false;
    this.starting = false;
    this.stopPromise = Promise.resolve(this.lifecycle.stop?.())
      .then(() => undefined)
      .finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  diagnostics(): ARDiagnostics {
    return { ...this.values, experience: this.kind, state: this.active ? 'active' : this.starting ? 'initializing' : 'supported' };
  }
}

export class WebXRAdapter implements ARExperienceAdapter {
  readonly kind = 'webxr' as const;
  private immersiveSupported: boolean | null = null;
  constructor(readonly manager = new WebXRManager()) {}
  /** Run outside the click handler; `isSupported()` remains synchronous at click time. */
  async preflight(): Promise<boolean> {
    if (!navigator.xr) { this.immersiveSupported = false; return false; }
    if (typeof navigator.xr.isSessionSupported !== 'function') { this.immersiveSupported = null; return true; }
    try {
      this.immersiveSupported = await navigator.xr.isSessionSupported('immersive-ar');
      return this.immersiveSupported;
    } catch {
      this.immersiveSupported = null;
      return true;
    }
  }
  isSupported(): boolean { return this.immersiveSupported ?? Boolean(navigator.xr); }
  async start(): Promise<void> { await this.manager.start(); }
  async stop(): Promise<void> { await this.manager.stop(); }
  onUnexpectedStop(listener: () => void): () => void {
    let wasRunning = false;
    return this.manager.subscribeState(() => {
      if (wasRunning && !this.manager.isRunning) listener();
      wasRunning = this.manager.isRunning;
    });
  }
  diagnostics(): ARDiagnostics {
    return {
      tracking: this.manager.hasHandTracking ? 'webxr-hand' : 'none',
      filter: 'one-euro',
      prediction: 'none',
      depth: this.manager.hasNativeDepth ? 'webxr-depth' : 'geometric-proxy',
      renderer: 'webgl2',
      experience: this.kind,
      state: this.manager.isRunning ? 'active' : this.manager.currentSession ? 'initializing' : 'supported',
    };
  }
}

export function createCameraCompositeAdapter(supported: () => boolean | Promise<boolean>, lifecycle: Required<Lifecycle>, renderer: 'webgpu' | 'webgl2'): ARExperienceAdapter {
  return new LifecycleAdapter('camera-composite', supported, lifecycle, { tracking: 'mediapipe', filter: 'one-euro', prediction: 'none', depth: 'geometric-proxy', renderer });
}
export function createQuickLookAdapter(supported: () => boolean | Promise<boolean>): ARExperienceAdapter {
  return new LifecycleAdapter('quick-look', supported, {}, { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer: 'native' });
}
export function createInteractive3DAdapter(renderer: 'webgpu' | 'webgl2'): ARExperienceAdapter {
  return new LifecycleAdapter('interactive-3d', () => true, {}, { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer });
}
