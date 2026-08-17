/**
 * useCamera.ts
 *
 * Enterprise-grade React hook for camera stream lifecycle management.
 * Handles:
 *  - Mobile-first: always tries 'environment' (rear) first on mobile, falls back gracefully.
 *  - Resolution negotiation: 1080p → 720p → system default, in that order.
 *  - Camera switching: stop current tracks, re-acquire with new facingMode.
 *  - Permission error classification: distinguishes NotAllowedError vs. NotFoundError.
 *  - Orientation-change re-constraint for seamless portrait↔landscape.
 *
 * Usage:
 *   const { stream, facingMode, switchCamera, error, isAcquiring } = useCamera();
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FacingMode = 'environment' | 'user';

export interface CameraError {
  type:
    | 'PERMISSION_DENIED'
    | 'NOT_FOUND'
    | 'OVERCONSTRAINED'
    | 'NOT_SUPPORTED'
    | 'UNKNOWN';
  message: string;
  raw?: unknown;
}

export interface UseCameraResult {
  /** Active MediaStream, or null while acquiring / on error */
  stream: MediaStream | null;
  /** Current facing mode ('environment' = rear, 'user' = front) */
  facingMode: FacingMode;
  /** True while getUserMedia is in-flight */
  isAcquiring: boolean;
  /** Structured error, or null when healthy */
  error: CameraError | null;
  /** Toggle between front and rear cameras */
  switchCamera: () => Promise<void>;
  /** Force-re-acquire with the current facingMode (useful after permission grant) */
  reacquire: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution preference ladder
// Tried in order; first success wins.
// ─────────────────────────────────────────────────────────────────────────────

const RESOLUTION_LADDER: Array<{ width: number; height: number }> = [
  { width: 1920, height: 1080 }, // 1080p — ideal for high-end devices
  { width: 1280, height: 720 },  // 720p  — broad compatibility
  { width: 640,  height: 480 },  // VGA   — last resort
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when we're likely running on a real mobile device
 * (as opposed to a desktop browser with simulated mobile UA).
 */
function isMobileDevice(): boolean {
  // Primary signal: pointer precision
  if (window.matchMedia('(pointer: coarse)').matches) return true;
  // Secondary: UA sniffing as fallback for older browsers
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/**
 * Detect whether the device physically has a rear camera.
 * Uses enumerateDevices — labels are empty before permission is granted,
 * but 'videoinput' count > 1 reliably indicates front + rear on mobile.
 */
async function hasRearCamera(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    // > 1 video input almost always means front + rear on mobile
    return videoInputs.length > 1;
  } catch {
    // enumerateDevices failed — assume rear exists on mobile
    return isMobileDevice();
  }
}

/**
 * Attempt to acquire a stream at decreasing resolutions.
 * Returns the first successful MediaStream.
 * Throws the last error if all resolutions fail.
 */
async function acquireStreamWithFallback(
  facingMode: FacingMode,
  ladder: Array<{ width: number; height: number }>,
): Promise<MediaStream> {
  let lastError: unknown;

  for (const { width, height } of ladder) {
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: width },
          height: { ideal: height },
          // Reduce power consumption while maintaining quality
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream;
    } catch (err) {
      lastError = err;

      // NotAllowedError / NotFoundError won't be fixed by a resolution change — bail early
      if (err instanceof DOMException) {
        if (
          err.name === 'NotAllowedError' ||
          err.name === 'PermissionDeniedError' ||
          err.name === 'NotFoundError' ||
          err.name === 'DevicesNotFoundError'
        ) {
          throw err;
        }
      }
      // OverconstrainedError or AbortError → try next resolution
    }
  }

  throw lastError;
}

/**
 * Map a raw DOMException to our structured CameraError type.
 */
function classifyError(raw: unknown): CameraError {
  if (raw instanceof DOMException) {
    switch (raw.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return {
          type: 'PERMISSION_DENIED',
          message: 'Camera access was denied. Please grant permission and try again.',
          raw,
        };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return {
          type: 'NOT_FOUND',
          message: 'No camera was found on this device.',
          raw,
        };
      case 'OverconstrainedError':
        return {
          type: 'OVERCONSTRAINED',
          message: 'Camera does not support the requested resolution.',
          raw,
        };
      case 'NotSupportedError':
        return {
          type: 'NOT_SUPPORTED',
          message: 'Camera API is not supported in this browser.',
          raw,
        };
      default:
        return {
          type: 'UNKNOWN',
          message: `Camera error: ${raw.message}`,
          raw,
        };
    }
  }

  return {
    type: 'UNKNOWN',
    message: raw instanceof Error ? raw.message : 'An unknown camera error occurred.',
    raw,
  };
}

/**
 * Stop all tracks in a MediaStream.
 */
function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useCamera(): UseCameraResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>('environment');
  const [isAcquiring, setIsAcquiring] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);

  // Keep a stable ref so cleanup inside async callbacks always hits the latest stream
  const streamRef = useRef<MediaStream | null>(null);

  // ── Core acquisition ─────────────────────────────────────────────────────

  const acquireCamera = useCallback(async (targetFacing: FacingMode): Promise<void> => {
    if (!navigator?.mediaDevices?.getUserMedia) {
      setError({
        type: 'NOT_SUPPORTED',
        message: 'getUserMedia is not available in this browser.',
      });
      return;
    }

    setIsAcquiring(true);
    setError(null);

    // Stop previous stream immediately to release hardware
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);

    try {
      const newStream = await acquireStreamWithFallback(targetFacing, RESOLUTION_LADDER);
      streamRef.current = newStream;
      setStream(newStream);
      setFacingMode(targetFacing);
    } catch (raw) {
      const cameraError = classifyError(raw);
      setError(cameraError);
      console.error('[useCamera] Failed to acquire stream:', cameraError);
    } finally {
      setIsAcquiring(false);
    }
  }, []);

  // ── Initial acquisition ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // Mobile-first: prefer rear camera on mobile, front on desktop
      let initialFacing: FacingMode = 'user';
      if (isMobileDevice()) {
        const rearAvailable = await hasRearCamera();
        initialFacing = rearAvailable ? 'environment' : 'user';
      }

      if (!cancelled) {
        await acquireCamera(initialFacing);
      }
    };

    init();

    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Orientation change: re-apply constraints ─────────────────────────────
  // On some Android devices the active track loses its resolution when
  // the screen rotates. Re-acquiring fixes the stale constraint issue.

  useEffect(() => {
    const handleOrientationChange = () => {
      // Short delay lets the browser finish layout recalculation
      setTimeout(() => {
        if (streamRef.current) {
          acquireCamera(facingMode);
        }
      }, 300);
    };

    window.addEventListener('orientationchange', handleOrientationChange);
    return () => window.removeEventListener('orientationchange', handleOrientationChange);
  }, [facingMode, acquireCamera]);

  // ── Public API ───────────────────────────────────────────────────────────

  /** Toggle between front (user) and rear (environment) cameras */
  const switchCamera = useCallback(async (): Promise<void> => {
    const nextFacing: FacingMode = facingMode === 'environment' ? 'user' : 'environment';
    await acquireCamera(nextFacing);
  }, [facingMode, acquireCamera]);

  /** Re-acquire with the current facing mode (useful after user grants permission) */
  const reacquire = useCallback(async (): Promise<void> => {
    await acquireCamera(facingMode);
  }, [facingMode, acquireCamera]);

  return { stream, facingMode, isAcquiring, error, switchCamera, reacquire };
}
