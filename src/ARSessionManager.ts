/**
 * ARSessionManager.ts — UPGRADED
 *
 * Changes vs original:
 *  1. minDetectionConfidence / minTrackingConfidence defaults raised to 0.7.
 *  2. getDynamicVideoConstraints: mobile-first environment facing, resolution ladder,
 *     robust device enumeration.
 *  3. NEW public method: switchCamera(facingMode) — stops tracks, re-acquires stream,
 *     reconnects VideoTexture to Three.js scene without tearing down the full session.
 *  4. ARSessionConfig exposes currentFacingMode for UI sync.
 *  5. setupCamera respects config.videoConstraints if explicitly provided by caller.
 */

import { RingPoseEstimator, HandTrackingResult, RingPose } from './RingPoseEstimator';
import { ARScene } from './ARScene';
import { useARStore } from './store/useARStore';
import MediaPipeWorker from './workers/mediapipe.worker?worker';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export enum ARSessionState {
  IDLE         = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  CAMERA_READY = 'CAMERA_READY',
  TRACKING_ACTIVE = 'TRACKING_ACTIVE',
  TRACKING_LOST   = 'TRACKING_LOST',
  ERROR  = 'ERROR',
  STOPPED = 'STOPPED',
}

export type FacingMode = 'environment' | 'user';

export interface ARSessionConfig {
  mediaPipeWasmPath: string;
  ringModelUrl: string;
  ringScale: number;
  trackingFPS: number;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
  videoConstraints?: MediaStreamConstraints['video'];
}

const DEFAULT_CONFIG: ARSessionConfig = {
  mediaPipeWasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  ringModelUrl: '',
  ringScale: 1.0,
  trackingFPS: 20,
  // ── UPGRADED: 0.7 prevents jittery detections in poor lighting ──
  minDetectionConfidence: 0.7,
  minTrackingConfidence:  0.7,
};

/** Resolution ladder: tried in order, first success wins */
const RESOLUTION_LADDER = [
  { width: 1920, height: 1080 },
  { width: 1280, height:  720 },
  { width:  640, height:  480 },
];

export type SessionStateCallback = (state: ARSessionState, error?: string) => void;
export type PoseUpdateCallback   = (pose: RingPose | null) => void;

// Worker message types (internal)
interface WorkerInitMessage    { type: 'INIT'; wasmPath: string; minDetectionConfidence: number; minTrackingConfidence: number; }
interface WorkerProcessMessage { type: 'PROCESS'; buffer: ArrayBuffer; width: number; height: number; timestamp: number; }
interface WorkerStopMessage    { type: 'STOP'; }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isMobile(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
  );
}

async function preferredFacingMode(): Promise<FacingMode> {
  if (!isMobile()) return 'user'; // desktop always front
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    return videoInputs.length > 1 ? 'environment' : 'user';
  } catch {
    return 'environment'; // safe default on mobile
  }
}

async function acquireStreamWithFallback(facingMode: FacingMode): Promise<MediaStream> {
  let lastError: unknown;
  for (const { width, height } of RESOLUTION_LADDER) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width:  { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });
    } catch (err) {
      lastError = err;
      if (err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'NotFoundError')) {
        throw err; // won't be fixed by resolution change
      }
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARSessionManager
// ─────────────────────────────────────────────────────────────────────────────

export class ARSessionManager {
  private config: ARSessionConfig;
  private scene: ARScene | null = null;
  private poseEstimator: RingPoseEstimator | null = null;

  private videoElement: HTMLVideoElement | null = null;
  private mediaStream: MediaStream | null = null;
  private worker: Worker | null = null;

  private state: ARSessionState = ARSessionState.IDLE;
  private lastPose: RingPose | null = null;
  private isTracking: boolean = false;
  private isRendering: boolean = false;

  private animationFrameId: number | null = null;
  private trackingIntervalId: ReturnType<typeof setInterval> | null = null;
  private workerBusy = false;

  /** Current facing mode — readable by UI to update camera flip button icon */
  public currentFacingMode: FacingMode = 'environment';

  public onStateChange: SessionStateCallback | null = null;
  private onPoseUpdate: PoseUpdateCallback | null = null;
  public onError: ((error: Error) => void) | null = null;

  constructor(config: Partial<ARSessionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Callback setters (unchanged) ─────────────────────────────────────────

  setStateCallback(callback: SessionStateCallback): void  { this.onStateChange = callback; }
  setErrorCallback(callback: (e: Error) => void): void    { this.onError = callback; }
  setPoseCallback(callback: PoseUpdateCallback): void     { this.onPoseUpdate = callback; }
  getState(): ARSessionState                              { return this.state; }

  private setState(newState: ARSessionState, error?: string): void {
    this.state = newState;
    this.onStateChange?.(newState, error);
  }

  // ── Initialize ───────────────────────────────────────────────────────────

  async initialize(containerElement: HTMLElement): Promise<void> {
    try {
      this.setState(ARSessionState.INITIALIZING);

      this.videoElement = document.createElement('video');
      this.videoElement.setAttribute('playsinline', 'true');
      this.videoElement.setAttribute('muted', 'true');
      this.videoElement.style.display = 'none';

      await this.setupCamera();

      const rect = containerElement.getBoundingClientRect();
      this.scene = new ARScene({ width: rect.width, height: rect.height });
      this.scene.setVideoElement(this.videoElement);
      containerElement.appendChild(this.scene.getDomElement());

      this.poseEstimator = new RingPoseEstimator();
      await this.setupWorker();

      const { setModelLoadingProgress, setSnapshotRef } = useARStore.getState();
      await this.scene.loadRing(
        this.config.ringModelUrl,
        this.config.ringScale,
        (p: number) => setModelLoadingProgress(p),
      );
      setSnapshotRef(this.takeSnapshot.bind(this));

      this.setState(ARSessionState.CAMERA_READY);
    } catch (error) {
      console.error('[ARSessionManager] Initialization failed:', error);
      this.setState(
        ARSessionState.ERROR,
        error instanceof Error ? error.message : 'Unknown error',
      );
      throw error;
    }
  }

  // ── Camera setup (mobile-first) ──────────────────────────────────────────

  private async setupCamera(): Promise<void> {
    if (!this.videoElement) throw new Error('Video element not created');

    try {
      // If the caller passed explicit constraints, respect them.
      // Otherwise run the mobile-first, resolution-fallback logic.
      if (this.config.videoConstraints) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: this.config.videoConstraints,
          audio: false,
        });
        // Detect actual facing mode from the track settings
        const track = this.mediaStream.getVideoTracks()[0];
        const settings = track?.getSettings();
        this.currentFacingMode =
          (settings?.facingMode as FacingMode) ??
          (isMobile() ? 'environment' : 'user');
      } else {
        const facing = await preferredFacingMode();
        this.currentFacingMode = facing;
        this.mediaStream = await acquireStreamWithFallback(facing);
      }

      this.videoElement.srcObject = this.mediaStream;

      return new Promise((resolve, reject) => {
        this.videoElement!.onloadedmetadata = () =>
          this.videoElement!.play().then(resolve).catch(reject);
        this.videoElement!.onerror = () =>
          reject(new Error('Video element failed to load'));
      });
    } catch (error) {
      throw new Error(
        `Camera access failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── PUBLIC: Camera switching ─────────────────────────────────────────────
  /**
   * Switch between front ('user') and rear ('environment') cameras WITHOUT
   * tearing down the MediaPipe worker or the Three.js scene.
   *
   * Steps:
   *   1. Stop current video tracks.
   *   2. Acquire new stream with requested facingMode.
   *   3. Reconnect video element srcObject.
   *   4. Reconnect Three.js VideoTexture (scene.setVideoElement).
   *   5. Reset pose estimator smoother (prevents position pop artefact).
   */
  public async switchCamera(targetFacing?: FacingMode): Promise<void> {
    const nextFacing: FacingMode =
      targetFacing ?? (this.currentFacingMode === 'environment' ? 'user' : 'environment');

    try {
      // 1. Stop current tracks
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;

      // 2. Acquire with resolution fallback
      this.mediaStream = await acquireStreamWithFallback(nextFacing);
      this.currentFacingMode = nextFacing;

      // 3. Reconnect video element
      if (this.videoElement) {
        this.videoElement.srcObject = this.mediaStream;
        await new Promise<void>((resolve, reject) => {
          this.videoElement!.onloadedmetadata = () =>
            this.videoElement!.play().then(resolve).catch(reject);
          this.videoElement!.onerror = () =>
            reject(new Error('Video reload failed after camera switch'));
        });
      }

      // 4. Reconnect VideoTexture in Three.js scene
      if (this.scene && this.videoElement) {
        this.scene.setVideoElement(this.videoElement);
      }

      // 5. Reset filters to avoid pose pop from stale position/rotation state
      this.poseEstimator?.reset();
      this.lastPose = null;

    } catch (error) {
      console.error('[ARSessionManager] Camera switch failed:', error);
      throw error;
    }
  }

  // ── Worker setup (unchanged logic, tidied) ───────────────────────────────

  private async setupWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker = new MediaPipeWorker();
      let timeoutId: ReturnType<typeof setTimeout>;

      this.worker.onmessage = (
        event: MessageEvent<{ type: string; result?: unknown; timestamp?: number; error?: string }>,
      ) => {
        if (event.data.type === 'READY') {
          clearTimeout(timeoutId);
          resolve();
        } else if (event.data.type === 'HAND_RESULT') {
          this.handleHandResult(
            event.data.result as HandTrackingResult | null,
            event.data.timestamp ?? 0,
          );
        } else if (event.data.type === 'ERROR') {
          console.error('[Worker] Error:', event.data.error);
        }
      };

      this.worker.onerror = (err) => { clearTimeout(timeoutId); reject(err); };

      this.worker.postMessage({
        type: 'INIT',
        wasmPath:               this.config.mediaPipeWasmPath,
        minDetectionConfidence: this.config.minDetectionConfidence,
        minTrackingConfidence:  this.config.minTrackingConfidence,
      } as WorkerInitMessage);

      timeoutId = setTimeout(() => reject(new Error('Worker initialization timed out')), 10000);
    });
  }

  // ── Hand result handler (unchanged) ─────────────────────────────────────

  private handleHandResult(result: HandTrackingResult | null, timestamp: number): void {
    this.workerBusy = false;
    if (!this.poseEstimator || !this.scene) return;

    if (result?.landmarks) {
      const pose = this.poseEstimator.estimatePose(result, this.scene.camera, timestamp);
      if (pose) {
        this.lastPose = pose;
        this.isTracking = true;
        if (this.state !== ARSessionState.TRACKING_ACTIVE) {
          this.setState(ARSessionState.TRACKING_ACTIVE);
        }
        this.onPoseUpdate?.(pose);
      } else {
        this.isTracking = false;
        if (this.state === ARSessionState.TRACKING_ACTIVE) {
          this.setState(ARSessionState.TRACKING_LOST);
        }
      }
    } else {
      this.isTracking = false;
      if (this.state === ARSessionState.TRACKING_ACTIVE) {
        this.setState(ARSessionState.TRACKING_LOST);
      }
    }
  }

  // ── Tracking loop ────────────────────────────────────────────────────────

  private startTrackingLoop(): void {
    const offscreenCanvas = document.createElement('canvas');
    let offscreenCtx: CanvasRenderingContext2D | null = null;

    const processFrame = async () => {
      if (!this.isTracking || !this.worker || !this.videoElement) return;
      if (this.workerBusy) return;

      try {
        const vw = this.videoElement.videoWidth;
        const vh = this.videoElement.videoHeight;

        if (offscreenCanvas.width !== vw || offscreenCanvas.height !== vh) {
          offscreenCanvas.width = vw;
          offscreenCanvas.height = vh;
          offscreenCtx = offscreenCanvas.getContext('2d');
        }

        if (!offscreenCtx) return;

        offscreenCtx.drawImage(this.videoElement, 0, 0, vw, vh);
        const imageData = offscreenCtx.getImageData(0, 0, vw, vh);
        const timestamp = performance.now();

        this.workerBusy = true;
        this.worker.postMessage(
          {
            type: 'PROCESS',
            buffer: imageData.data.buffer,
            width: vw,
            height: vh,
            timestamp,
          } as WorkerProcessMessage,
          [imageData.data.buffer],
        );
      } catch (err) {
        console.error('[ARSessionManager] Frame processing error:', err);
        this.workerBusy = false;
      }

      if (this.isTracking && this.videoElement) {
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
          this.videoElement.requestVideoFrameCallback(processFrame);
        }
      }
    };

    this.isTracking = true;

    const intervalMs = 1000 / this.config.trackingFPS;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.videoElement?.requestVideoFrameCallback(processFrame);
    } else {
      // Firefox fallback
      this.trackingIntervalId = setInterval(() => {
        if (!this.isTracking) return;
        processFrame();
      }, intervalMs);
    }
  }

  // ── Render loop ──────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    const render = () => {
      if (!this.isRendering || !this.scene) return;
      if (this.lastPose) this.scene.updatePose(this.lastPose);
      this.scene.render();
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.isRendering = true;
    render();
  }

  // ── Public start/stop/resize ─────────────────────────────────────────────

  public startLoops(): void {
    if (
      this.state !== ARSessionState.CAMERA_READY &&
      this.state !== ARSessionState.TRACKING_LOST
    ) {
      console.warn('[ARSessionManager] Cannot start loops in state:', this.state);
      return;
    }
    this.startTrackingLoop();
    this.startRenderLoop();
  }

  public resize(width: number, height: number): void {
    if (!this.videoElement || !this.scene) return;
    this.scene.resize(width, height, this.videoElement.videoWidth, this.videoElement.videoHeight);
  }

  public setRingScale(scale: number): void {
    this.poseEstimator?.setMetadata({ scale });
  }

  public async swapRingModel(url: string): Promise<void> {
    if (!this.scene) return;
    const { setModelLoadingProgress } = useARStore.getState();
    setModelLoadingProgress(0);
    await this.scene.loadRing(url, this.config.ringScale, (p) => setModelLoadingProgress(p));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  stop(): void {
    this.isTracking = false;
    this.isRendering = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.trackingIntervalId !== null) {
      clearInterval(this.trackingIntervalId);
      this.trackingIntervalId = null;
    }
    this.setState(ARSessionState.STOPPED);
  }

  dispose(): void {
    this.stop();

    if (this.worker) {
      this.worker.postMessage({ type: 'STOP' } as WorkerStopMessage);
      this.worker.terminate();
      this.worker = null;
    }

    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.remove();
      this.videoElement = null;
    }

    this.scene?.dispose();
    this.scene = null;

    this.poseEstimator?.dispose();
    this.poseEstimator = null;

    this.lastPose = null;
    this.setState(ARSessionState.IDLE);
  }

  getCurrentPose(): RingPose | null { return this.lastPose; }
  isActivelyTracking(): boolean {
    return this.isTracking && this.state === ARSessionState.TRACKING_ACTIVE;
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  public takeSnapshot(): string | null {
    if (!this.videoElement || !this.scene) return null;

    const scene = this.scene as unknown as { renderer: import('three').WebGLRenderer };
    const renderer = scene.renderer;
    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    if (!vw || !vh) return null;

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = vw;
    compositeCanvas.height = vh;
    const ctx = compositeCanvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(this.videoElement, 0, 0, vw, vh);
    this.scene.render();
    ctx.drawImage(renderer.domElement, 0, 0, vw, vh);

    return compositeCanvas.toDataURL('image/jpeg', 0.92);
  }
}

export default ARSessionManager;
