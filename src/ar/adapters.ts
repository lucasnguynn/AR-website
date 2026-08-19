import { WebXRManager } from '../services/WebXRManager';
import type { ARDiagnostics, ARExperienceAdapter, ARExperienceKind } from './AROrchestrator';

type Lifecycle = { start?: () => void | Promise<void>; stop?: () => void | Promise<void> };

class LifecycleAdapter implements ARExperienceAdapter {
  private active = false;
  private stopPromise: Promise<void> | null = null;
  constructor(
    readonly kind: ARExperienceKind,
    private readonly supported: () => boolean | Promise<boolean>,
    private readonly lifecycle: Lifecycle,
    private readonly values: Omit<ARDiagnostics, 'experience' | 'state'>,
  ) {}
  async isSupported(): Promise<boolean> { return this.supported(); }
  async start(): Promise<void> { if (!this.active) { await this.lifecycle.start?.(); this.active = true; } }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.active) return Promise.resolve();
    this.active = false;
    this.stopPromise = Promise.resolve(this.lifecycle.stop?.()).then(() => undefined).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
  diagnostics(): ARDiagnostics { return { ...this.values, experience: this.kind, state: this.active ? 'active' : 'supported' }; }
}

export class WebXRAdapter implements ARExperienceAdapter {
  readonly kind = 'webxr' as const;
  constructor(private readonly manager = new WebXRManager()) {}
  async isSupported(): Promise<boolean> { return Boolean(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); }
  async start(): Promise<void> { await this.manager.start(); }
  async stop(): Promise<void> { await this.manager.stop(); }
  diagnostics(): ARDiagnostics {
    return { tracking: 'webxr-hand', filter: 'one-euro', prediction: 'none', depth: 'none', renderer: 'webgl2', experience: this.kind, state: this.manager.isRunning ? 'active' : 'supported' };
  }
}

export function createCameraCompositeAdapter(supported: () => boolean | Promise<boolean>, lifecycle: Required<Lifecycle>, renderer: 'webgpu' | 'webgl2' | 'webgl1'): ARExperienceAdapter {
  return new LifecycleAdapter('camera-composite', supported, lifecycle, { tracking: 'mediapipe', filter: 'one-euro', prediction: 'none', depth: 'geometric-proxy', renderer });
}
export function createQuickLookAdapter(supported: () => boolean | Promise<boolean>): ARExperienceAdapter {
  return new LifecycleAdapter('quick-look', supported, {}, { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer: 'webgl1' });
}
export function createInteractive3DAdapter(renderer: 'webgpu' | 'webgl2' | 'webgl1'): ARExperienceAdapter {
  return new LifecycleAdapter('interactive-3d', () => true, {}, { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer });
}
