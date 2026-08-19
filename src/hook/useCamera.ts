// FILE: src/hook/useCamera.ts
/**
 * useCamera.ts
 *
 * Thin React integration layer for the camera subsystem.
 *
 * RESPONSIBILITIES:
 *   - React lifecycle management (useEffect hooks)
 *   - Subscription to cameraSystem state changes
 *   - UI-consumable camera state exposure
 *   - Imperative camera action wrappers
 *
 * NON-RESPONSIBILITIES:
 *   - Direct MediaStream manipulation (handled by cameraSystem)
 *   - getUserMedia calls (handled by cameraSystem)
 *   - Frame scheduling (handled by cameraSystem)
 *   - Camera switching logic (handled by cameraSystem)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CameraSystem,
  getCameraSystem,
  type CameraState,
  type CameraMetadata,
  type CameraError,
  type FacingMode,
} from '../services/cameraSystem';

/** Camera facing mode supported by the camera subsystem. */
export { type FacingMode } from '../services/cameraSystem';

/** React camera hook state and imperative controls. */
export interface UseCameraReturn {
  cameraState: CameraState['status'];
  isReady: boolean;
  hasError: boolean;
  lastError: CameraError | null;
  facingMode: FacingMode;
  metadata: CameraMetadata | null;
  switchCamera: (facingMode: FacingMode) => Promise<void>;
  recoverCamera: () => Promise<void>;
  stopCamera: () => void;
}

let cameraSystemInstance: CameraSystem | null = null;

function getOrCreateCameraSystem(): CameraSystem {
  if (!cameraSystemInstance) {
    cameraSystemInstance = getCameraSystem();
  }
  return cameraSystemInstance;
}

/**
 * Provides React state and controls for the shared camera subsystem.
 */
export function useCamera(): UseCameraReturn {
  const cameraSystem = getOrCreateCameraSystem();
  
  const [cameraState, setCameraState] = useState<CameraState['status']>('IDLE');
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [lastError, setLastError] = useState<CameraError | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const [metadata, setMetadata] = useState<CameraMetadata | null>(null);

  // Ref to track if we're subscribed to avoid duplicate subscriptions
  const isSubscribedRef = useRef(false);

  useEffect(() => {
    if (isSubscribedRef.current) {
      return;
    }
    
    isSubscribedRef.current = true;

    const handleStatusChange = (status: CameraState['status']) => {
      setCameraState(status);
      setIsReady(status === 'READY');
      setHasError(status === 'ERROR');
    };

    const handleError = (error: CameraError) => {
      setLastError(error);
      setHasError(true);
    };

    const handleMetadata = (meta: CameraMetadata) => {
      setMetadata(meta);
      setFacingMode(meta.facingMode);
    };

    cameraSystem.setCallbacks({
      onStatusChange: handleStatusChange,
      onError: handleError,
      onMetadata: handleMetadata,
    });

    // Sync initial state
    const initialState = cameraSystem.getState();
    setCameraState(initialState.status);
    setIsReady(initialState.isReady);
    setHasError(initialState.hasError);
    setFacingMode(initialState.facingMode);
    setMetadata(initialState.metadata);

    return () => {
      // Cleanup on unmount - but don't stop the camera here
      // The camera should be stopped explicitly by the component using it
      isSubscribedRef.current = false;
    };
  }, [cameraSystem]);

  const switchCamera = useCallback(
    async (newFacingMode: FacingMode) => {
      await cameraSystem.switchCamera(newFacingMode);
    },
    [cameraSystem],
  );

  const recoverCamera = useCallback(async () => {
    await cameraSystem.recover();
  }, [cameraSystem]);

  const stopCamera = useCallback(() => {
    cameraSystem.stop();
    setCameraState('STOPPED');
    setIsReady(false);
    setHasError(false);
    setLastError(null);
    setMetadata(null);
  }, [cameraSystem]);

  return {
    cameraState,
    isReady,
    hasError,
    lastError,
    facingMode,
    metadata,
    switchCamera,
    recoverCamera,
    stopCamera,
  };
}

/**
 * Imperative function to start camera from a video element ref.
 * Used when the video element is managed outside React state.
 */
export async function startCameraFromRef(
  videoElement: HTMLVideoElement,
  facingMode: FacingMode = 'user',
): Promise<void> {
  const cameraSystem = getOrCreateCameraSystem();
  await cameraSystem.start(videoElement, facingMode);
}

/**
 * Reset the camera system singleton.
 * Should be called when the AR modal is closed to ensure clean state.
 */
export function resetCamera(): void {
  if (cameraSystemInstance) {
    cameraSystemInstance.stop();
    cameraSystemInstance = null;
  }
}
// VERIFY: console.log('[Camera] validated exactly one video track and zero audio tracks')
