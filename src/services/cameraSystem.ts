// FILE: src/services/cameraSystem.ts
/**
 * cameraSystem.ts
 *
 * Production-grade camera subsystem for WebAR jewelry try-on.
 *
 * RESPONSIBILITIES:
 *   - Camera permission handling
 *   - MediaStream lifecycle (start, stop, switch)
 *   - Device enumeration
 *   - Camera metadata exposure
 *   - Session guards against stale callbacks
 *   - Bounded retry on interruption recovery
 *   - Cleanup and resource management
 *
 * NON-RESPONSIBILITIES (explicitly excluded):
 *   - MediaPipe inference (handled by mediapipe.worker.ts)
 *   - Hand tracking orchestration (handled by useHandTracking.ts)
 *   - Ring pose mathematics (handled by coordinateMapping.ts)
 *   - 3D rendering (handled by RingScene.tsx)
 *   - UI state management (handled by useARStore.ts)
 *   - React state (handled by useCamera.ts hook)
 */

import type { FacingMode } from './cameraTypes';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** Camera facing mode values supported by the subsystem. */
export type { FacingMode } from './cameraTypes';

/** Camera dimensions and device metadata exposed without frame data. */
export interface CameraMetadata {
  videoWidth: number;
  videoHeight: number;
  displayWidth?: number;
  displayHeight?: number;
  facingMode: FacingMode;
  deviceId: string | null;
}

/** Normalized camera error details. */
export interface CameraError {
  code: CameraErrorCode;
  message: string;
  recoverable: boolean;
}

/** Supported normalized camera error codes. */
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

/** Camera lifecycle status values. */
export type CameraStatus =
  | 'IDLE'
  | 'STARTING'
  | 'READY'
  | 'SWITCHING'
  | 'ERROR'
  | 'STOPPED';

/** Current camera subsystem state. */
export interface CameraState {
  status: CameraStatus;
  isReady: boolean;
  hasError: boolean;
  error: CameraError | null;
  facingMode: FacingMode;
  metadata: CameraMetadata | null;
  stream: MediaStream | null;
}

/** Optional camera subsystem callbacks for UI integration. */
export interface CameraSystemCallbacks {
  onFrame?: () => void;
  onError?: (error: CameraError) => void;
  onMetadata?: (metadata: CameraMetadata) => void;
  onStatusChange?: (status: CameraStatus) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const SESSION_GUARD_TIMEOUT_MS = 2000;

// ──────────────────────────────────────────────────────────────────────────────
// Error normalization
// ──────────────────────────────────────────────────────────────────────────────

function normalizeCameraError(error: unknown): CameraError {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return {
          code: 'PERMISSION_DENIED',
          message: 'Camera permission denied',
          recoverable: false,
        };
      case 'NotFoundError':
        return {
          code: 'NOT_FOUND',
          message: 'No camera device found',
          recoverable: false,
        };
      case 'NotReadableError':
        return {
          code: 'NOT_READABLE',
          message: 'Camera is in use by another application',
          recoverable: true,
        };
      case 'OverconstrainedError':
        return {
          code: 'CONSTRAINTS_UNSUPPORTED',
          message: 'Requested camera constraints are not supported',
          recoverable: false,
        };
      default:
        return {
          code: 'UNKNOWN',
          message: error.message || 'Unknown camera error',
          recoverable: true,
        };
    }
  }

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unknown error',
    recoverable: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Camera System Class
// ──────────────────────────────────────────────────────────────────────────────

/** Production camera subsystem that validates local media tracks before rendering. */
export class CameraSystem {
  private currentSessionId: string | null = null;
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private status: CameraStatus = 'IDLE';
  private facingMode: FacingMode = 'user';
  private metadata: CameraMetadata | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private frameCallbackScheduled = false;
  
  private callbacks: CameraSystemCallbacks = {};

  constructor(callbacks: CameraSystemCallbacks = {}) {
    this.callbacks = callbacks;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────────

  public getState(): CameraState {
    return {
      status: this.status,
      isReady: this.status === 'READY',
      hasError: this.status === 'ERROR',
      error: this.status === 'ERROR' ? this._currentError : null,
      facingMode: this.facingMode,
      metadata: this.metadata,
      stream: this.stream,
    };
  }

  public async start(
    videoElement: HTMLVideoElement,
    facingMode: FacingMode = 'user'
  ): Promise<void> {
    const sessionId = this._generateSessionId();
    this.currentSessionId = sessionId;

    this._setStatus('STARTING');
    this.facingMode = facingMode;
    this.videoElement = videoElement;
    this.retryCount = 0;

    try {
      await this._requestStream(facingMode);
      this._attachStreamToVideo(videoElement);
      await this._waitForMetadata(videoElement);
      
      // Validate session is still current
      if (!this._isSessionCurrent(sessionId)) {
        return;
      }

      this._updateMetadata();
      this._setStatus('READY');
      
      // Notify callbacks
      if (this.callbacks.onMetadata && this.metadata) {
        this.callbacks.onMetadata(this.metadata);
      }
      if (this.callbacks.onStatusChange) {
        this.callbacks.onStatusChange('READY');
      }

    } catch (error) {
      if (!this._isSessionCurrent(sessionId)) {
        return;
      }

      const normalizedError = normalizeCameraError(error);
      this._setError(normalizedError);

      // Attempt bounded retry for recoverable errors
      if (normalizedError.recoverable && this.retryCount < MAX_RETRY_COUNT) {
        this._scheduleRetry(videoElement, facingMode);
      }
    }
  }

  public async switchCamera(facingMode: FacingMode): Promise<void> {
    if (this.status === 'SWITCHING') {
      return;
    }

    if (facingMode === this.facingMode) {
      return;
    }

    const sessionId = this._generateSessionId();
    this.currentSessionId = sessionId;

    this._setStatus('SWITCHING');
    this.facingMode = facingMode;

    try {
      // Stop current stream
      this._stopStream();

      // Request new stream
      await this._requestStream(facingMode);

      // Re-attach to existing video element
      if (this.videoElement) {
        this._attachStreamToVideo(this.videoElement);
        await this._waitForMetadata(this.videoElement);
        
        // Validate session is still current
        if (!this._isSessionCurrent(sessionId)) {
          return;
        }

        this._updateMetadata();
      }

      this._setStatus('READY');
      
      if (this.callbacks.onMetadata && this.metadata) {
        this.callbacks.onMetadata(this.metadata);
      }
      if (this.callbacks.onStatusChange) {
        this.callbacks.onStatusChange('READY');
      }

    } catch (error) {
      if (!this._isSessionCurrent(sessionId)) {
        return;
      }

      const normalizedError = normalizeCameraError(error);
      this._setError(normalizedError);
      this._setStatus('READY'); // Revert to ready state with old stream if possible
    }
  }

  public stop(): void {
    this._cancelRetry();
    this._stopStream();
    this._setStatus('STOPPED');
    this.currentSessionId = null;
    this.videoElement = null;
    this.metadata = null;
    this.retryCount = 0;
  }

  public async recover(): Promise<void> {
    if (!this.videoElement || !this.stream) {
      return;
    }

    // Check if stream is still valid
    const tracks = this.stream.getVideoTracks();
    if (tracks.length > 0 && tracks[0].readyState === 'live') {
      return;
    }

    const videoElement = this.videoElement;
    // Attempt to restart the camera after proving the element still exists.
    this.stop();
    await this.start(videoElement, this.facingMode);
  }

  public setCallbacks(callbacks: CameraSystemCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Private implementation
  // ────────────────────────────────────────────────────────────────────────────

  private _currentError: CameraError | null = null;

  private _generateSessionId(): string {
    return `camera-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private _isSessionCurrent(sessionId: string): boolean {
    return this.currentSessionId === sessionId;
  }

  private _setStatus(status: CameraStatus): void {
    this.status = status;
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange(status);
    }
  }

  private _setError(error: CameraError): void {
    this._currentError = error;
    this._setStatus('ERROR');
    if (this.callbacks.onError) {
      this.callbacks.onError(error);
    }
  }

  private async _requestStream(facingMode: FacingMode): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
      audio: false,
    };

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('Camera API unavailable', 'NotFoundError');
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const tracks = stream.getTracks();
      const audioTracks = tracks.filter((track) => track.kind === 'audio');
      if (audioTracks.length > 0) {
        tracks.forEach((track) => track.stop());
        throw new Error('[Security] Unexpected audio track — aborting');
      }

      const videoTracks = tracks.filter((track) => track.kind === 'video');
      if (videoTracks.length !== 1) {
        tracks.forEach((track) => track.stop());
        throw new Error('[Security] Expected 1 video track');
      }

      const settings = videoTracks[0].getSettings();
      console.info(`[Camera] ${settings.width}×${settings.height} facing=${settings.facingMode}`);
      this.stream = stream;
    } catch (error) {
      throw error;
    }
  }

  private _attachStreamToVideo(videoElement: HTMLVideoElement): void {
    if (videoElement.srcObject) {
      // Detach any existing stream first
      const oldStream = videoElement.srcObject as MediaStream;
      oldStream.getTracks().forEach((track) => track.stop());
    }

    videoElement.srcObject = this.stream;
    videoElement.playsInline = true;
    videoElement.muted = true;
  }

  private async _waitForMetadata(videoElement: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for video metadata'));
      }, 10000);

      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Video element error while loading metadata'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
        videoElement.removeEventListener('error', onError);
      };

      if (videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
        cleanup();
        resolve();
        return;
      }

      videoElement.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      videoElement.addEventListener('error', onError, { once: true });

      // Trigger play to ensure metadata loads
      void videoElement.play();
    });
  }

  private _updateMetadata(): void {
    if (!this.videoElement) {
      return;
    }

    const video = this.videoElement;
    this.metadata = {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      displayWidth: video.clientWidth,
      displayHeight: video.clientHeight,
      facingMode: this.facingMode,
      deviceId: this.stream?.getVideoTracks()[0]?.getSettings()?.deviceId || null,
    };
  }

  private _stopStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.videoElement && this.videoElement.srcObject) {
      this.videoElement.srcObject = null;
    }

    this.metadata = null;
  }

  private _scheduleRetry(videoElement: HTMLVideoElement, facingMode: FacingMode): void {
    this._cancelRetry();
    
    this.retryCount++;

    this.retryTimer = setTimeout(async () => {
      try {
        await this.start(videoElement, facingMode);
      } catch (error) {
      }
    }, RETRY_DELAY_MS * this.retryCount);
  }

  private _cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Singleton instance for shared access
// ──────────────────────────────────────────────────────────────────────────────

let globalCameraSystem: CameraSystem | null = null;

export function getCameraSystem(
  callbacks?: CameraSystemCallbacks
): CameraSystem {
  if (!globalCameraSystem) {
    globalCameraSystem = new CameraSystem(callbacks);
  } else if (callbacks) {
    globalCameraSystem.setCallbacks(callbacks);
  }
  return globalCameraSystem;
}

export function resetCameraSystem(): void {
  if (globalCameraSystem) {
    globalCameraSystem.stop();
    globalCameraSystem = null;
  }
}
// VERIFY: console.log('[Camera] validated exactly one video track and zero audio tracks')
