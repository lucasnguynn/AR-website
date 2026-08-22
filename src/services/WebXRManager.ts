import * as THREE from 'three';
import { WebXRDepthManager, type XRFrameWithDepthData } from './WebXRDepthManager';

export type XRHandedness = 'left' | 'right' | 'none';

/** Renderer-independent hand contract consumed by the XR jewelry scene. Values are in the active XR reference space. */
export interface XRHandMeasurement {
  readonly handedness: XRHandedness;
  readonly position: readonly [number, number, number];
  readonly orientation: readonly [number, number, number, number];
  readonly scaleMeters: number;
  readonly timestamp: number;
  readonly confidence: number;
}

export interface WebXRFrameSnapshot {
  readonly timestamp: number;
  readonly viewerPose: XRViewerPose | null;
  readonly hands: readonly XRHandMeasurement[];
  readonly depthActive: boolean;
}

export interface WebXRRuntimeBinding {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
}

type XRSessionInitWithDepth = XRSessionInit & {
  optionalFeatures?: string[];
  depthSensing?: {
    usagePreference: string[];
    dataFormatPreference: string[];
  };
  domOverlay?: { root: Element };
};

type XRFrameWithJoints = XRFrameWithDepthData & {
  getJointPose(joint: XRJointSpace, baseSpace: XRSpace): XRJointPose | undefined;
};
type XRHandMap = { get(name: string): XRJointSpace | undefined };
type XRInputSourceWithHand = XRInputSource & { hand?: XRHandMap };
type SnapshotListener = (snapshot: WebXRFrameSnapshot) => void;
type StateListener = () => void;

const SESSION_INIT = (): XRSessionInitWithDepth => ({
  // Every advanced feature is optional: a basic immersive-ar session must remain usable.
  optionalFeatures: ['local-floor', 'hand-tracking', 'depth-sensing', 'dom-overlay'],
  depthSensing: {
    usagePreference: ['cpu-optimized'],
    dataFormatPreference: ['float32', 'luminance-alpha'],
  },
  ...(typeof document === 'undefined' ? {} : { domOverlay: { root: document.body } }),
});

/** Owns one immersive session and its sole Three display loop. */
export class WebXRManager {
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;
  private binding: WebXRRuntimeBinding | null = null;
  private configuredBinding: WebXRRuntimeBinding | null = null;
  private readonly depthManager = new WebXRDepthManager();
  private readonly frameListeners = new Set<SnapshotListener>();
  private readonly stateListeners = new Set<StateListener>();
  private stopping: Promise<void> | null = null;
  private handAvailable = false;
  private depthAvailable = false;
  private snapshot: WebXRFrameSnapshot = { timestamp: 0, viewerPose: null, hands: [], depthActive: false };

  get currentSession(): XRSession | null { return this.session; }
  get isRunning(): boolean {
    return this.session !== null && this.referenceSpace !== null && this.configuredBinding !== null;
  }
  get hasHandTracking(): boolean { return this.handAvailable; }
  get hasNativeDepth(): boolean { return this.depthAvailable; }

  /**
   * Binds the React/Three runtime when WebXRScene mounts. Importantly, session
   * creation does NOT wait for this binding; doing so creates a circular dependency
   * because WebXRScene itself is selected only after requestSession succeeds.
   */
  bindRuntime(binding: WebXRRuntimeBinding): () => void {
    this.binding = binding;
    const session = this.session;
    if (session && this.referenceSpace) {
      void this.configureRuntime(binding, session).catch((error) => {
        console.error('WebXR runtime configuration failed.', error);
        if (this.session === session) void this.endSession(session);
      });
    }
    return () => {
      if (this.configuredBinding === binding) this.releaseRuntime(binding);
      if (this.binding === binding) this.binding = null;
      this.notifyState();
    };
  }

  subscribeFrames(listener: SnapshotListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * requestSession is intentionally the first asynchronous WebXR operation.
   * Browsers gate immersive sessions on transient user activation; do not add an
   * awaited capability probe (for example isSessionSupported) before this call.
   */
  async start(): Promise<XRSession> {
    if (this.session) return this.session;
    if (!navigator.xr) throw new Error('WebXR is not available on this device.');

    const session = await navigator.xr.requestSession('immersive-ar', SESSION_INIT());
    this.session = session;
    session.addEventListener('end', this.handleSessionEnd, { once: true });

    try {
      this.referenceSpace = await this.requestBestReferenceSpace(session);
      const binding = this.binding;
      if (binding) await this.configureRuntime(binding, session);
      this.notifyState();
      return session;
    } catch (error) {
      await this.endSession(session);
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.session;
    this.stopping = (active ? this.endSession(active) : Promise.resolve())
      .finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async requestBestReferenceSpace(session: XRSession): Promise<XRReferenceSpace> {
    try { return await session.requestReferenceSpace('local-floor'); }
    catch { return session.requestReferenceSpace('local'); }
  }

  private async configureRuntime(binding: WebXRRuntimeBinding, session: XRSession): Promise<void> {
    if (this.session !== session || !this.referenceSpace) return;
    if (this.configuredBinding === binding) return;

    if (this.configuredBinding && this.configuredBinding !== binding) {
      this.releaseRuntime(this.configuredBinding);
    }

    binding.renderer.xr.enabled = true;
    await binding.renderer.xr.setSession(session);
    if (this.session !== session) return;

    this.depthManager.attachToScene(binding.scene);
    binding.renderer.setAnimationLoop(this.onXRFrame);
    this.configuredBinding = binding;
    this.notifyState();
  }

  private releaseRuntime(binding: WebXRRuntimeBinding): void {
    binding.renderer.setAnimationLoop(null);
    binding.renderer.xr.enabled = false;
    void binding.renderer.xr.setSession(null);
    this.depthManager.detach();
    if (this.configuredBinding === binding) this.configuredBinding = null;
  }

  private readonly onXRFrame = (_time: number, frame?: XRFrame): void => {
    const binding = this.configuredBinding;
    const referenceSpace = this.referenceSpace;
    if (!frame || !binding || !referenceSpace || !this.session) return;
    const xrFrame = frame as XRFrameWithJoints;
    const viewerPose = xrFrame.getViewerPose(referenceSpace) ?? null;
    const hands = this.readHands(xrFrame, referenceSpace);
    if (hands[0]) this.depthManager.updateXRHandProxy(hands[0].position, hands[0].orientation, hands[0].scaleMeters);
    this.handAvailable ||= hands.length > 0;
    let depthActive = false;
    if (viewerPose?.views[0]) depthActive = this.depthManager.updateFromWebXR(xrFrame, viewerPose.views[0]);
    this.depthManager.setGeometricFallbackEnabled(!depthActive && hands.length > 0);
    this.depthAvailable = depthActive;
    this.snapshot = { timestamp: frame.predictedDisplayTime, viewerPose, hands, depthActive };
    for (const listener of this.frameListeners) listener(this.snapshot);
    binding.renderer.render(binding.scene, binding.camera);
  };

  private readHands(frame: XRFrameWithJoints, space: XRReferenceSpace): XRHandMeasurement[] {
    const measurements: XRHandMeasurement[] = [];
    for (const source of this.session?.inputSources as Iterable<XRInputSourceWithHand> ?? []) {
      const hand = source.hand;
      const mcpSpace = hand?.get('ring-finger-metacarpal');
      const pipSpace = hand?.get('ring-finger-phalanx-proximal');
      const indexSpace = hand?.get('index-finger-metacarpal');
      if (!mcpSpace || !pipSpace || !indexSpace) continue;
      const mcp = frame.getJointPose(mcpSpace, space);
      const pip = frame.getJointPose(pipSpace, space);
      const index = frame.getJointPose(indexSpace, space);
      if (!mcp || !pip || !index) continue;
      const mcpPosition = new THREE.Vector3(mcp.transform.position.x, mcp.transform.position.y, mcp.transform.position.z);
      const pipPosition = new THREE.Vector3(pip.transform.position.x, pip.transform.position.y, pip.transform.position.z);
      const indexPosition = new THREE.Vector3(index.transform.position.x, index.transform.position.y, index.transform.position.z);
      const along = pipPosition.clone().sub(mcpPosition);
      const across = indexPosition.clone().sub(mcpPosition);
      const scaleMeters = along.length();
      if (scaleMeters < 0.005 || across.lengthSq() < 1e-8) continue;

      const y = along.clone().normalize();
      const zRaw = new THREE.Vector3().crossVectors(across, y);
      if (zRaw.lengthSq() < 1e-8) continue;
      const z = zRaw.normalize();
      const x = new THREE.Vector3().crossVectors(y, z).normalize();
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      // Move slightly from the MCP toward the PIP so the ring sits on the proximal
      // phalanx rather than directly on the knuckle center. Device calibration can
      // tune this fraction later without changing the renderer.
      const anchor = mcpPosition.clone().lerp(pipPosition, 0.28);
      measurements.push({
        handedness: source.handedness as XRHandedness,
        position: [anchor.x, anchor.y, anchor.z],
        orientation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        scaleMeters,
        timestamp: frame.predictedDisplayTime,
        confidence: 1,
      });
    }
    return measurements;
  }

  private async endSession(session: XRSession): Promise<void> {
    if (this.session === session) {
      try { await session.end(); } catch { /* An ended session is already clean. */ }
    }
    this.cleanup();
  }

  private readonly handleSessionEnd = (): void => { this.cleanup(); };

  private cleanup(): void {
    if (this.configuredBinding) this.releaseRuntime(this.configuredBinding);
    this.session = null;
    this.referenceSpace = null;
    this.handAvailable = false;
    this.depthAvailable = false;
    this.snapshot = { timestamp: 0, viewerPose: null, hands: [], depthActive: false };
    this.notifyState();
  }

  private notifyState(): void { for (const listener of this.stateListeners) listener(); }
}
