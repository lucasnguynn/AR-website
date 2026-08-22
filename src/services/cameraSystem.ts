// FILE: src/services/cameraSystem.ts
/**
 * Camera lifecycle for the WebAR camera-composite path.
 *
 * Invariants:
 * - exactly one video track and zero audio tracks;
 * - a stale getUserMedia result is stopped immediately;
 * - start() rejects after bounded retries so the AR orchestrator can fall back;
 * - recover() can restart after an initial acquisition failure;
 * - switching either commits the requested camera, restores the previous one,
 *   or leaves the system in ERROR — never READY with a stopped stream;
 * - callbacks are replaceable so React unmounts cannot retain stale setters.
 */

import type { FacingMode } from './cameraTypes';

export type { FacingMode } from './cameraTypes';

export interface CameraMetadata {
  videoWidth: number;
  videoHeight: number;
  displayWidth?: number;
  displayHeight?: number;
  facingMode: FacingMode;
  deviceId: string | null;
}

export interface CameraError {
  code: CameraErrorCode;
  message: string;
  recoverable: boolean;
}

export type CameraErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'CONSTRAINTS_UNSUPPORTED'
  | 'SWITCH_FAILED'
  | 'INTERRUPTED'
  | 'WEBGL_UNSUPPORTED'
  | 'METADATA_TIMEOUT'
  | 'UNKNOWN';

export type CameraStatus = 'IDLE' | 'STARTING' | 'READY' | 'SWITCHING' | 'ERROR' | 'STOPPED';

export interface CameraState {
  status: CameraStatus;
  isReady: boolean;
  hasError: boolean;
  error: CameraError | null;
  facingMode: FacingMode;
  metadata: CameraMetadata | null;
  stream: MediaStream | null;
}

export interface CameraSystemCallbacks {
  onFrame?: () => void;
  onError?: (error: CameraError) => void;
  onMetadata?: (metadata: CameraMetadata) => void;
  onStatusChange?: (status: CameraStatus) => void;
}

const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const METADATA_TIMEOUT_MS = 10_000;

function normalizeCameraError(error: unknown): CameraError {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return { code: 'PERMISSION_DENIED', message: 'Camera permission denied', recoverable: false };
      case 'NotFoundError':
        return { code: 'NOT_FOUND', message: 'No camera device found', recoverable: false };
      case 'NotReadableError':
      case 'AbortError':
        return { code: 'NOT_READABLE', message: 'Camera is temporarily unavailable or already in use', recoverable: true };
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return { code: 'CONSTRAINTS_UNSUPPORTED', message: 'Requested camera constraints are not supported', recoverable: false };
      default:
        return { code: 'UNKNOWN', message: error.message || 'Unknown camera error', recoverable: true };
    }
  }

  if (error instanceof Error && /metadata/i.test(error.message)) {
    return { code: 'METADATA_TIMEOUT', message: error.message, recoverable: true };
  }

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unknown camera error',
    recoverable: true,
  };
}

function toThrownError(cameraError: CameraError, cause?: unknown): Error {
  const error = new Error(cameraError.message);
  error.name = cameraError.code;
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function stopMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => {
    try { track.stop(); } catch { /* stopping is best-effort and idempotent */ }
  });
}

export class CameraSystem {
  private currentSessionId: string | null = null;
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private status: CameraStatus = 'IDLE';
  private facingMode: FacingMode = 'user';
  private metadata: CameraMetadata | null = null;
  private currentError: CameraError | null = null;
  private callbacks: CameraSystemCallbacks;

  constructor(
    callbacks: CameraSystemCallbacks = {},
    private readonly retryDelayMs = RETRY_DELAY_MS,
  ) {
    this.callbacks = callbacks;
  }

  public getState(): CameraState {
    return {
      status: this.status,
      isReady: this.status === 'READY',
      hasError: this.status === 'ERROR',
      error: this.status === 'ERROR' ? this.currentError : null,
      facingMode: this.facingMode,
      metadata: this.metadata,
      stream: this.stream,
    };
  }

  /** Starts a fresh camera operation. Final failure rejects for orchestrator fallback. */
  public async start(videoElement: HTMLVideoElement, facingMode: FacingMode = 'user'): Promise<void> {
    const sessionId = this.beginOperation(videoElement, facingMode, 'STARTING');
    this.stopStreamOnly();

    let finalFailure: CameraError | null = null;
    let finalCause: unknown;

    for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt += 1) {
      if (!this.isSessionCurrent(sessionId)) return;
      if (attempt > 0) await this.delay(this.retryDelayMs * attempt);
      if (!this.isSessionCurrent(sessionId)) return;

      try {
        const committed = await this.acquireAndCommit(videoElement, facingMode, sessionId);
        if (!committed) return;
        this.currentError = null;
        this.setStatus('READY');
        this.emitMetadata();
        return;
      } catch (error) {
        if (!this.isSessionCurrent(sessionId)) return;
        this.stopStreamOnly();
        finalFailure = normalizeCameraError(error);
        finalCause = error;
        const mayRetry = finalFailure.recoverable && attempt < MAX_RETRY_COUNT;
        if (!mayRetry) break;
      }
    }

    const failure = finalFailure ?? { code: 'UNKNOWN' as const, message: 'Camera failed to start', recoverable: true };
    this.setError(failure);
    throw toThrownError(failure, finalCause);
  }

  /**
   * Switches camera transactionally. If the requested camera fails, the previous
   * facing mode is restored before READY is reported.
   */
  public async switchCamera(nextFacingMode: FacingMode): Promise<void> {
    if (this.status === 'SWITCHING' || nextFacingMode === this.facingMode) return;
    const video = this.videoElement;
    if (!video) return;

    const previousFacingMode = this.facingMode;
    const sessionId = this.beginOperation(video, nextFacingMode, 'SWITCHING');
    this.stopStreamOnly();

    try {
      const committed = await this.acquireAndCommit(video, nextFacingMode, sessionId);
      if (!committed) return;
      this.currentError = null;
      this.setStatus('READY');
      this.emitMetadata();
      return;
    } catch (switchFailure) {
      if (!this.isSessionCurrent(sessionId)) return;
      this.stopStreamOnly();
      this.facingMode = previousFacingMode;

      try {
        const restored = await this.acquireAndCommit(video, previousFacingMode, sessionId);
        if (!restored) return;
        this.currentError = null;
        this.setStatus('READY');
        this.emitMetadata();
        console.warn('[Camera] Requested camera switch failed; previous camera was restored.', switchFailure);
        return;
      } catch (restoreFailure) {
        if (!this.isSessionCurrent(sessionId)) return;
        this.stopStreamOnly();
        const normalized = normalizeCameraError(restoreFailure);
        this.setError({
          code: 'SWITCH_FAILED',
          message: `Unable to switch camera and restore the previous camera: ${normalized.message}`,
          recoverable: true,
        });
      }
    }
  }

  public stop(): void {
    // Invalidate any pending getUserMedia / metadata operation first.
    this.currentSessionId = null;
    this.stopStreamOnly();
    this.videoElement = null;
    this.metadata = null;
    this.currentError = null;
    this.setStatus('STOPPED');
  }

  /** Restarts even when the initial getUserMedia attempt never produced a stream. */
  public async recover(): Promise<void> {
    const video = this.videoElement;
    if (!video) return;

    const track = this.stream?.getVideoTracks()[0];
    if (this.status === 'READY' && track?.readyState === 'live') return;

    const facingMode = this.facingMode;
    await this.start(video, facingMode);
  }

  /** Replace callbacks instead of merging, so React cleanup can clear stale setters. */
  public setCallbacks(callbacks: CameraSystemCallbacks): void {
    this.callbacks = callbacks;
  }

  private beginOperation(video: HTMLVideoElement, facingMode: FacingMode, status: CameraStatus): string {
    const sessionId = this.generateSessionId();
    this.currentSessionId = sessionId;
    this.videoElement = video;
    this.facingMode = facingMode;
    this.currentError = null;
    this.setStatus(status);
    return sessionId;
  }

  private async acquireAndCommit(
    video: HTMLVideoElement,
    facingMode: FacingMode,
    sessionId: string,
  ): Promise<boolean> {
    const stream = await this.requestStream(facingMode);

    if (!this.isSessionCurrent(sessionId)) {
      stopMediaStream(stream);
      return false;
    }

    this.attachStreamToVideo(video, stream);
    this.stream = stream;

    try {
      await this.waitForMetadata(video);
      await video.play();
    } catch (error) {
      if (this.stream === stream) this.stopStreamOnly();
      else stopMediaStream(stream);
      throw error;
    }

    if (!this.isSessionCurrent(sessionId)) {
      if (this.stream === stream) this.stopStreamOnly();
      else stopMediaStream(stream);
      return false;
    }

    this.updateMetadata();
    return true;
  }

  private async requestStream(facingMode: FacingMode): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Camera API unavailable', 'NotFoundError');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
      audio: false,
    });

    const tracks = stream.getTracks();
    const audioTracks = tracks.filter((track) => track.kind === 'audio');
    const videoTracks = tracks.filter((track) => track.kind === 'video');

    if (audioTracks.length > 0 || videoTracks.length !== 1) {
      stopMediaStream(stream);
      throw new Error(audioTracks.length > 0
        ? '[Security] Unexpected audio track — aborting camera stream'
        : '[Security] Expected exactly one video track');
    }

    const settings = videoTracks[0].getSettings();
    console.info(`[Camera] ${settings.width ?? '?'}×${settings.height ?? '?'} facing=${settings.facingMode ?? 'unknown'}`);
    return stream;
  }

  private attachStreamToVideo(video: HTMLVideoElement, stream: MediaStream): void {
    if (video.srcObject && video.srcObject !== stream) stopMediaStream(video.srcObject as MediaStream);
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
  }

  private waitForMetadata(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for video metadata'));
      }, METADATA_TIMEOUT_MS);

      const onLoadedMetadata = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Video element error while loading metadata')); };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      video.addEventListener('error', onError, { once: true });
      void video.play().catch(() => undefined);
    });
  }

  private updateMetadata(): void {
    const video = this.videoElement;
    if (!video) return;
    this.metadata = {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      displayWidth: video.clientWidth,
      displayHeight: video.clientHeight,
      facingMode: this.facingMode,
      deviceId: this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null,
    };
  }

  private emitMetadata(): void {
    if (this.metadata) this.callbacks.onMetadata?.(this.metadata);
  }

  private stopStreamOnly(): void {
    const stream = this.stream;
    this.stream = null;
    stopMediaStream(stream);
    if (this.videoElement?.srcObject) {
      const attached = this.videoElement.srcObject as MediaStream;
      if (attached !== stream) stopMediaStream(attached);
      this.videoElement.srcObject = null;
    }
    this.metadata = null;
  }

  private setStatus(status: CameraStatus): void {
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }

  private setError(error: CameraError): void {
    this.currentError = error;
    this.setStatus('ERROR');
    this.callbacks.onError?.(error);
  }

  private isSessionCurrent(sessionId: string): boolean {
    return this.currentSessionId === sessionId;
  }

  private generateSessionId(): string {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `camera-session-${Date.now()}-${random}`;
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }
}

let globalCameraSystem: CameraSystem | null = null;

export function getCameraSystem(callbacks?: CameraSystemCallbacks): CameraSystem {
  if (!globalCameraSystem) globalCameraSystem = new CameraSystem(callbacks);
  else if (callbacks) globalCameraSystem.setCallbacks(callbacks);
  return globalCameraSystem;
}

export function resetCameraSystem(): void {
  globalCameraSystem?.stop();
  globalCameraSystem = null;
}
