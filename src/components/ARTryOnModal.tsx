/**
 * ARTryOnModal.tsx
 *
 * Main overlay modal component for the AR Try-On experience.
 * Implements graceful degradation: checks DeviceProfiler and mounts either
 * ARVideoCanvas (for supported devices) or Fallback3DViewer (for unsupported).
 */

import React, { useEffect, useCallback, useRef } from 'react';
import {
  useARStore,
  selectShouldShowFallback,
  selectIsLoading,
  selectErrorMessage,
  selectFallbackMode,
  selectModelLoadingProgress,
} from '../store/useARStore';
import { DeviceProfiler } from '../utils/DeviceProfiler';

const ARVideoCanvas = React.lazy(() => import('./ARVideoCanvas'));
const Fallback3DViewer = React.lazy(() => import('./Fallback3DViewer'));
const ARControls = React.lazy(() => import('./ARControls'));

async function getDynamicVideoConstraints(): Promise<MediaStreamConstraints['video']> {
  const baseConstraints: MediaStreamConstraints['video'] = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(device => device.kind === 'videoinput');

    if (videoInputs.length > 1) {
      return { ...baseConstraints, facingMode: 'environment' };
    }

    return { ...baseConstraints, facingMode: 'user' };
  } catch (error) {
    console.warn('Could not enumerate devices, using default constraints:', error);
    return { ...baseConstraints, facingMode: 'user' };
  }
}

interface ARTryOnModalProps {
  isOpen: boolean;
  onClose: () => void;
  ringModelUrl: string;
}

export const ARTryOnModal: React.FC<ARTryOnModalProps> = ({
  isOpen,
  onClose,
  ringModelUrl,
}) => {
  const shouldShowFallback = useARStore(selectShouldShowFallback);
  const isLoading = useARStore(selectIsLoading);
  const errorMessage = useARStore(selectErrorMessage);
  const fallbackMode = useARStore(selectFallbackMode);
  const modelLoadingProgress = useARStore(selectModelLoadingProgress);

  const setCameraPermission = useARStore((state) => state.setCameraPermission);
  const setDeviceClass = useARStore((state) => state.setDeviceClass);
  const activateFallback = useARStore((state) => state.activateFallback);
  const setLoading = useARStore((state) => state.setLoading);
  const closeModal = useARStore((state) => state.closeModal);

  const modalRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // Initialize device profiling on modal open
  useEffect(() => {
    if (!isOpen || hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const initializeAR = async () => {
      try {
        const profile = await DeviceProfiler.profile();
        setDeviceClass(profile.deviceClass);

        if (profile.deviceClass === 'UNSUPPORTED' || profile.deviceClass === 'LOW') {
          return;
        }

        try {
          const videoConstraints = await getDynamicVideoConstraints();
          const stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
          });
          stream.getTracks().forEach(track => track.stop());
          setCameraPermission(true);
        } catch (permissionError) {
          console.warn('Camera permission denied:', permissionError);
          setCameraPermission(false);
          activateFallback('PERMISSION_DENIED');
          return;
        }

      } catch (error) {
        console.error('AR initialization failed:', error);
        // FIX BUG-4: Explicitly clear isLoading here in case ARVideoCanvas's
        // onStateChange callback hasn't fired yet (race condition on fast failures).
        setLoading(false);
        activateFallback('CAMERA_ERROR');
      }
    };

    initializeAR();
  }, [isOpen]);

  const handleClose = useCallback(() => {
    closeModal();
    onClose();
  }, [onClose]);

  const handleBackdropClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      handleClose();
    }
  }, [handleClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ar-modal-title"
    >
      <div className="relative w-full h-full max-w-7xl max-h-screen bg-gray-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/60 to-transparent">
          <h2
            id="ar-modal-title"
            className="text-white text-lg font-semibold tracking-wide"
          >
            Virtual Try-On
          </h2>

          <button
            onClick={handleClose}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-full transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Main Content Area */}
        <div className="w-full h-full">
          <React.Suspense
            fallback={
              <div className="flex items-center justify-center w-full h-full">
                <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-white"></div>
              </div>
            }
          >
            {shouldShowFallback ? (
              <Fallback3DViewer
                ringModelUrl={ringModelUrl}
                fallbackReason={fallbackMode}
                onRetry={() => {
                  hasInitializedRef.current = false;
                  useARStore.getState().reset();
                  useARStore.getState().openModal();
                }}
              />
            ) : (
              <>
                <ARVideoCanvas ringModelUrl={ringModelUrl} />
                <ARControls />
              </>
            )}
          </React.Suspense>
        </div>

        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="animate-spin rounded-full h-20 w-20 border-t-2 border-b-2 border-amber-400 mb-4"></div>
            <p className="text-white text-lg font-medium">Initializing AR Experience...</p>
            <p className="text-white/60 text-sm mt-2">Please allow camera access when prompted</p>

            {/*
              FIX BUG-3 (169% display):
              modelLoadingProgress is now guaranteed to be in [0, 100] because ARScene.ts
              clamps intermediate progress to [0, 99] and only emits 100 from onLoad.
              Math.round() here is still correct; just displaying a reliable value now.
            */}
            <div className="w-64 h-2 bg-gray-700 rounded-full mt-4 overflow-hidden">
              <div
                className="h-full bg-brand-neon transition-all duration-300 ease-out"
                style={{ width: `${Math.min(modelLoadingProgress, 100)}%` }}
              />
            </div>
            <p className="text-white/80 text-xs mt-2">
              {modelLoadingProgress < 100
                ? `Loading model... ${Math.min(Math.round(modelLoadingProgress), 99)}%`
                : 'Finalizing...'}
            </p>
          </div>
        )}

        {/* Error Message Display */}
        {errorMessage && !isLoading && (
          <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2 z-30 px-6 py-3 bg-red-500/90 rounded-lg shadow-lg">
            <p className="text-white text-sm font-medium">{errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ARTryOnModal;
