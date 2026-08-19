import assert from 'node:assert/strict';
import { AROrchestrator, type ARDiagnostics, type ARExperienceAdapter, type ARExperienceKind } from '../src/ar/AROrchestrator';
import { WORKER_PROTOCOL_VERSION, protocolMessage, validateMediaPipeInbound } from '../src/protocol/workerProtocol';

class FakeAdapter implements ARExperienceAdapter {
  starts = 0;
  stops = 0;
  active = false;
  constructor(readonly kind: ARExperienceKind, private readonly supported: boolean, private readonly failure = false) {}
  async isSupported(): Promise<boolean> { return this.supported; }
  async start(): Promise<void> { this.starts += 1; if (this.failure) throw new Error(`${this.kind} requestSession failed`); this.active = true; }
  async stop(): Promise<void> { if (this.active) this.stops += 1; this.active = false; }
  diagnostics(): ARDiagnostics { return { tracking: this.kind === 'webxr' ? 'webxr-hand' : this.kind === 'camera-composite' ? 'mediapipe' : 'none', filter: 'one-euro', prediction: 'none', depth: this.kind === 'camera-composite' ? 'geometric-proxy' : 'none', renderer: 'webgl2', experience: this.kind, state: this.active ? 'active' : 'supported' }; }
}

async function selected(adapters: FakeAdapter[]): Promise<{ result: ARDiagnostics; adapters: FakeAdapter[]; orchestrator: AROrchestrator }> {
  const orchestrator = new AROrchestrator(adapters);
  return { result: await orchestrator.start(), adapters, orchestrator };
}

export async function run(): Promise<void> {
  {
    const webxr = new FakeAdapter('webxr', true);
    const result = await selected([webxr, new FakeAdapter('camera-composite', true)]);
    assert.equal(result.result.experience, 'webxr', 'WebXR session success activates WebXR');
    assert.equal(webxr.starts, 1);
  }
  {
    const webxr = new FakeAdapter('webxr', true, true);
    const camera = new FakeAdapter('camera-composite', true);
    const { result } = await selected([webxr, new FakeAdapter('quick-look', false), camera]);
    assert.equal(result.experience, 'camera-composite', 'requestSession failure falls back');
    assert.equal(result.state, 'fallback-active');
  }
  {
    const quickLook = new FakeAdapter('quick-look', true);
    assert.equal((await selected([new FakeAdapter('webxr', false), quickLook, new FakeAdapter('camera-composite', true)])).result.experience, 'quick-look');
  }
  {
    const camera = new FakeAdapter('camera-composite', true);
    assert.equal((await selected([new FakeAdapter('webxr', false), new FakeAdapter('quick-look', false), camera])).result.experience, 'camera-composite');
  }
  {
    const interactive = new FakeAdapter('interactive-3d', true);
    const { result, adapters } = await selected([new FakeAdapter('webxr', false), new FakeAdapter('quick-look', false), new FakeAdapter('camera-composite', false), interactive]);
    assert.equal(result.experience, 'interactive-3d');
    assert.equal(adapters.reduce((sum, adapter) => sum + adapter.starts, 0), 1, 'only one adapter starts');
  }
  {
    const camera = new FakeAdapter('camera-composite', true);
    const { orchestrator } = await selected([camera]);
    await Promise.all([orchestrator.stop(), orchestrator.stop()]);
    await orchestrator.stop();
    assert.equal(camera.stops, 1, 'cleanup is idempotent');
  }
  assert.equal(validateMediaPipeInbound({ type: 'DESTROY' }), false, 'unversioned messages are rejected');
  assert.equal(validateMediaPipeInbound({ type: 'DESTROY', protocolVersion: WORKER_PROTOCOL_VERSION + 1 }), false, 'version mismatches are rejected');
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'DESTROY' })), true);
}
