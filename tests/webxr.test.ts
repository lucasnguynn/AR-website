import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WebXRAdapter } from '../src/ar/adapters';
import { WebXRManager } from '../src/services/WebXRManager';
import { WebXRDepthManager, type XRDepthInformationWithData } from '../src/services/WebXRDepthManager';

class MockSession {
  inputSources: unknown[] = [];
  ended = 0;
  private endListener: (() => void) | null = null;
  addEventListener(type: string, listener: () => void): void { if (type === 'end') this.endListener = listener; }
  async requestReferenceSpace(): Promise<object> { return {}; }
  async end(): Promise<void> { this.ended += 1; this.endListener?.(); }
  dispatchEnd(): void { this.endListener?.(); }
}

type Loop = ((time: number, frame?: XRFrame) => void) | null;
function runtime(manager: WebXRManager): { loops: Loop[]; renders: number[] } {
  const loops: Loop[] = [];
  const renders: number[] = [];
  const renderer = {
    xr: { enabled: false, setSession: async () => undefined },
    setAnimationLoop: (loop: Loop) => loops.push(loop),
    render: () => renders.push(1),
  };
  manager.bindRuntime({ renderer: renderer as unknown as THREE.WebGLRenderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  return { loops, renders };
}

function installXR(session: MockSession, reject = false): { init: XRSessionInit | undefined } {
  const observed: { init: XRSessionInit | undefined } = { init: undefined };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr: {
    isSessionSupported: async () => true,
    requestSession: async (_mode: string, init: XRSessionInit) => { observed.init = init; if (reject) throw new Error('denied'); return session; },
  } } });
  return observed;
}

export async function runWebXRTests(): Promise<void> {
  {
    const session = new MockSession();
    const observed = installXR(session);
    const manager = new WebXRManager();
    const active = runtime(manager);
    await manager.start();
    assert.equal(manager.isRunning, true, 'WEBXR is active only after session, space, and renderer setup');
    assert.deepEqual(observed.init?.optionalFeatures, ['local-floor', 'hand-tracking', 'depth-sensing', 'dom-overlay']);
    assert.equal(observed.init?.requiredFeatures, undefined, 'optional capabilities cannot reject basic AR');
    assert.equal(active.loops.filter(Boolean).length, 1, 'one XR display loop is installed');
    const frame = { predictedDisplayTime: 10, getViewerPose: () => ({ views: [] }) } as unknown as XRFrame;
    active.loops[0]?.(10, frame);
    assert.equal(active.renders.length, 1, 'one frame causes one render');
    assert.equal(manager.hasHandTracking, false, 'missing optional hands does not fail');
    assert.equal(manager.hasNativeDepth, false, 'missing optional depth does not fail');
    await manager.stop();
    assert.equal(manager.isRunning, false);
    assert.equal(active.loops.at(-1), null, 'stop cancels the owned display loop');
    await manager.start();
    await manager.stop();
    assert.equal(session.ended, 2, 'repeated lifecycle ends each session cleanly');
  }
  {
    const session = new MockSession();
    installXR(session, true);
    const manager = new WebXRManager();
    runtime(manager);
    await assert.rejects(manager.start(), /denied/, 'requestSession rejection reaches orchestrator fallback');
    assert.equal(manager.isRunning, false);
  }
  {
    const session = new MockSession();
    installXR(session);
    const manager = new WebXRManager();
    runtime(manager);
    const adapter = new WebXRAdapter(manager);
    let ended = 0;
    adapter.onUnexpectedStop(() => { ended += 1; });
    await adapter.start();
    session.dispatchEnd();
    assert.equal(ended, 1, 'device-driven session end invalidates the adapter');
  }
  {
    const manager = new WebXRDepthManager();
    const matrix = new THREE.Matrix4().makeTranslation(0.25, 0.5, 0).elements;
    const depth: XRDepthInformationWithData = {
      width: 1, height: 1, rawValueToMeters: 0.001,
      data: new Uint8Array([232, 3]),
      normDepthBufferFromNormView: { matrix } as XRRigidTransform,
    };
    const frame = { getDepthInformation: () => depth } as unknown as XRFrame;
    assert.equal(manager.updateFromWebXR(frame, {} as XRView), true);
    const uniform = (manager.occlusionProxy.material as THREE.ShaderMaterial).uniforms.depthUvTransform.value as THREE.Matrix4;
    assert.equal(uniform.elements[12], 0.25, 'browser depth reprojection transform reaches the occlusion shader');
    assert.equal((manager.depthTexture.image.data as Float32Array)[0], 1, 'packed native depth applies rawValueToMeters');
    manager.dispose();
  }
}
