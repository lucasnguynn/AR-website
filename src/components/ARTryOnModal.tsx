/**
 * ARTryOnModal.tsx
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
  } catch {
    return { ...baseConstraints, facingMode: 'user' };
  }
}

interface ARTryOnModalProps {
  isOpen: boolean;
  onClose: () => void;
  ringModelUrl: string;
}

export const ARTryOnModal: React.FC<ARTryOnModalProps> = ({ isOpen, onClose, ringModelUrl }) => {
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

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const initializeAR = async () => {
      try {
        const profile = await DeviceProfiler.profile();
        setDeviceClass(profile.deviceClass);
        if (profile.deviceClass === 'UNSUPPORTED' || profile.deviceClass === 'LOW') return;

        try {
          const videoConstraints = await getDynamicVideoConstraints();
          const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
          stream.getTracks().forEach(track => track.stop());
          setCameraPermission(true);
        } catch {
          setCameraPermission(false);
          activateFallback('PERMISSION_DENIED');
        }
      } catch (error) {
        console.error('AR initialization failed:', error);
        setLoading(false);
        activateFallback('CAMERA_ERROR');
      }
    };

    initializeAR();
  }, [isOpen]);

  const handleClose = useCallback(() => { closeModal(); onClose(); }, [onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) handleClose();
  }, [handleClose]);

  if (!isOpen) return null;

  // Tính progress label rõ ràng hơn
  const progressClamped = Math.min(Math.round(modelLoadingProgress), 100);
  const progressLabel = progressClamped < 30
    ? 'Đang khởi động camera...'
    : progressClamped < 70
    ? `Đang tải mô hình 3D... ${progressClamped}%`
    : progressClamped < 100
    ? `Đang xử lý... ${progressClamped}%`
    : 'Sẵn sàng!';

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
          <h2 id="ar-modal-title" className="text-white text-lg font-semibold tracking-wide">
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

        {/* Main Content */}
        <div className="w-full h-full">
          <React.Suspense fallback={
            <div className="flex items-center justify-center w-full h-full">
              <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-white"></div>
            </div>
          }>
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

        {/* Loading Overlay — chỉ hiện khi isLoading === true */}
        {isLoading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="animate-spin rounded-full h-20 w-20 border-t-2 border-b-2 border-amber-400 mb-4"></div>
            <p className="text-white text-lg font-medium">Initializing AR Experience...</p>
            <p className="text-white/60 text-sm mt-2">Please allow camera access when prompted</p>

            <div className="w-64 h-2 bg-gray-700 rounded-full mt-4 overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all duration-300 ease-out"
                style={{ width: `${progressClamped}%` }}
              />
            </div>
            <p className="text-white/80 text-xs mt-2">{progressLabel}</p>
          </div>
        )}

        {/* Error */}
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
