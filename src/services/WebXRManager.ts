export type XRHandedness = 'left' | 'right' | 'none';

export interface XRDepthInformationLike {
  readonly width?: number;
  readonly height?: number;
  readonly rawValueToMeters?: number;
  getDepthInMeters?(x: number, y: number): number;
}

export interface XRJointPoseLike {
  readonly transform: XRRigidTransform;
  readonly radius?: number;
}

export interface XRHandPose {
  readonly handedness: XRHandedness;
  readonly position: Float32Array;
  readonly orientation: Float32Array;
  readonly timestamp: number;
  readonly confidence: number;
}

export interface WebXRFrameSnapshot {
  readonly timestamp: number;
  readonly viewerPose: XRViewerPose | null;
  readonly hands: readonly XRHandPose[];
  readonly activeHandCount: number;
  readonly depth: XRDepthInformationLike | null;
}

type XRSessionInitWithDepth = XRSessionInit & {
  optionalFeatures?: string[];
  requiredFeatures?: string[];
  depthSensing?: {
    usagePreference: ['cpu-optimized', 'gpu-optimized'];
    dataFormatPreference: ['luminance-alpha', 'float32'];
  };
};

type XRFrameWithDepth = XRFrame & {
  getDepthInformation?(view: XRView): XRDepthInformationLike | null | undefined;
  getJointPose(joint: XRJointSpace, baseSpace: XRSpace): XRJointPoseLike | undefined;
};

type XRInputSourceWithHand = XRInputSource & {
  hand?: Iterable<[unknown, XRJointSpace]> & { get(key: string): XRJointSpace | undefined };
};

const SESSION_INIT: XRSessionInitWithDepth = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking', 'depth-sensing', 'dom-overlay'],
  depthSensing: {
    usagePreference: ['cpu-optimized', 'gpu-optimized'],
    dataFormatPreference: ['luminance-alpha', 'float32'],
  },
};

export class WebXRManager {
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;
  private readonly handPosePool: XRHandPose[];
  private readonly handsView: readonly XRHandPose[];
  private readonly snapshot: WebXRFrameSnapshot;
  private readonly positionBuffers: Float32Array[];
  private readonly orientationBuffers: Float32Array[];
  private handCount = 0;

  constructor(maxHands = 2) {
    this.positionBuffers = Array.from({ length: maxHands }, () => new Float32Array(3));
    this.orientationBuffers = Array.from({ length: maxHands }, () => new Float32Array(4));
    this.handPosePool = this.positionBuffers.map((position, i) => ({
      handedness: 'none',
      position,
      orientation: this.orientationBuffers[i],
      timestamp: 0,
      confidence: 0,
    }));
    this.handsView = this.handPosePool;
    this.snapshot = { timestamp: 0, viewerPose: null, hands: this.handsView, activeHandCount: 0, depth: null };
  }

  get currentSession(): XRSession | null { return this.session; }
  get isRunning(): boolean { return this.session !== null; }

  async start(): Promise<XRSession> {
    if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) throw new Error('immersive-ar is not supported on this device.');
    const session = await navigator.xr.requestSession('immersive-ar', SESSION_INIT);
    this.session = session;
    this.referenceSpace = await session.requestReferenceSpace('local-floor');
    session.addEventListener('end', this.handleSessionEnd, { once: true });
    return session;
  }

  async stop(): Promise<void> {
    const active = this.session;
    if (active) await active.end();
    this.handleSessionEnd();
  }

  update(frame: XRFrameWithDepth): WebXRFrameSnapshot {
    if (!this.referenceSpace) throw new Error('WebXRManager.update called before start().');
    const pose = frame.getViewerPose(this.referenceSpace) ?? null;
    let depth: XRDepthInformationLike | null = null;
    if (pose && frame.getDepthInformation && pose.views.length > 0) {
      try {
        depth = frame.getDepthInformation(pose.views[0]) ?? null;
      } catch (error) {
        console.warn('WebXR depth unavailable; continuing without true-depth occlusion.', error);
        depth = null;
      }
    }
    this.handCount = 0;
    if (this.session) {
      for (const source of this.session.inputSources as Iterable<XRInputSourceWithHand>) {
        if (this.handCount >= this.handPosePool.length || !source.hand) continue;
        const joint = source.hand.get('wrist') ?? source.hand.get('middle-finger-metacarpal');
        if (!joint) continue;
        const jointPose = frame.getJointPose(joint, this.referenceSpace);
        if (!jointPose) continue;
        this.writeHandPose(this.handCount++, source.handedness as XRHandedness, jointPose, frame.predictedDisplayTime);
      }
    }
    (this.snapshot as { timestamp: number; viewerPose: XRViewerPose | null; hands: readonly XRHandPose[]; activeHandCount: number; depth: XRDepthInformationLike | null }).timestamp = frame.predictedDisplayTime;
    (this.snapshot as { viewerPose: XRViewerPose | null }).viewerPose = pose;
    (this.snapshot as { hands: readonly XRHandPose[] }).hands = this.handsView;
    (this.snapshot as { activeHandCount: number }).activeHandCount = this.handCount;
    (this.snapshot as { depth: XRDepthInformationLike | null }).depth = depth;
    return this.snapshot;
  }

  private writeHandPose(index: number, handedness: XRHandedness, pose: XRJointPoseLike, timestamp: number): void {
    const out = this.handPosePool[index] as { handedness: XRHandedness; timestamp: number; confidence: number };
    const p = pose.transform.position;
    const q = pose.transform.orientation;
    this.positionBuffers[index][0] = p.x; this.positionBuffers[index][1] = p.y; this.positionBuffers[index][2] = p.z;
    this.orientationBuffers[index][0] = q.x; this.orientationBuffers[index][1] = q.y; this.orientationBuffers[index][2] = q.z; this.orientationBuffers[index][3] = q.w;
    out.handedness = handedness;
    out.timestamp = timestamp;
    out.confidence = pose.radius && pose.radius > 0 ? 1 : 0.85;
  }

  private readonly handleSessionEnd = (): void => {
    this.session = null;
    this.referenceSpace = null;
    this.handCount = 0;
  };
}
