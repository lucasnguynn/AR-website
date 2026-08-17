/**
 * ARTryOnModal.tsx — UPGRADED
 *
 * What's new:
 *  1. CameraFlipButton — a sleek TailwindCSS button that calls
 *     session.switchCamera() through the Zustand sessionRef.
 *     Shows spinner while switching; shows correct icon for current facing mode.
 *  2. isSwitchingCamera state guards against double-taps.
 *  3. Progress labels in English (Vietnamese strings removed for i18n clarity —
 *     re-add your localisation layer on top of the label string).
 *  4. resize + orientation change handler moved into ARVideoCanvas (ResizeObserver);
 *     the modal itself just manages modal open/close lifecycle.
 *  5. Error boundary hint: if camera switch fails, shows inline toast without
 *     crashing the full AR session.
 */

import React, { useEffect, useCallback, useRef, useState } from 'react';
import {
  useARStore,
  selectShouldShowFallback,
  selectIsLoading,
  selectErrorMessage,
  selectFallbackMode,
  selectModelLoadingProgress,
  selectSessionRef,
  selectCurrentFacingMode,
} from '../store/useARStore';
import { DeviceProfiler } from '../utils/DeviceProfiler';

const ARVideoCanvas  = React.lazy(() => import('./ARVideoCanvas'));
const Fallback3DViewer = React.lazy(() => import('./Fallback3DViewer'));
const ARControls     = React.lazy(() => import('./ARControls'));

// ─────────────────────────────────────────────────────────────────────────────
// CameraFlipButton — fully self-contained
// ─────────────────────────────────────────────────────────────────────────────

const CameraFlipButton: React.FC = () => {
  const session     = useARStore(selectSessionRef);
  const facingMode  = useARStore(selectCurrentFacingMode);
  const setFacingMode = useARStore((s) => s.setFacingMode);

  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const handleFlip = useCallback(async () => {
    if (!session || isSwitching) return;

    setIsSwitching(true);
    setSwitchError(null);

    try {
      await session.switchCamera();
      // Reflect the new facing mode in the store
      setFacingMode(session.currentFacingMode);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Camera switch failed';
      setSwitchError(msg);
      // Auto-clear error toast after 3 s
      setTimeout(() => setSwitchError(null), 3000);
    } finally {
      setIsSwitching(false);
    }
  }, [session, isSwitching, setFacingMode]);

  // Don't render if there's no active session (e.g., fallback mode)
  if (!session) return null;

  return (
    <>
      <button
        onClick={handleFlip}
        disabled={isSwitching}
        aria-label={
          facingMode === 'environment'
            ? 'Switch to front camera'
            : 'Switch to rear camera'
        }
        className={[
          // Positioning: top-right corner, below the close button
          'absolute top-16 right-4 z-20',
          // Shape
          'flex items-center justify-center',
          'w-11 h-11 rounded-full',
          // Glass morphism background
          'bg-black/50 backdrop-blur-md border border-white/20',
          // Interaction
          'transition-all duration-200 active:scale-95',
          isSwitching
            ? 'opacity-60 cursor-not-allowed'
            : 'hover:bg-white/20 hover:border-white/40 cursor-pointer',
          // Shadow
          'shadow-lg shadow-black/30',
        ].join(' ')}
      >
        {isSwitching ? (
          /* Spinner while switching */
          <svg
            className="w-5 h-5 text-white animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            />
          </svg>
        ) : facingMode === 'environment' ? (
          /* Rear camera active → show "switch to front" icon */
          <svg
            className="w-5 h-5 text-white"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Camera body */}
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            {/* Flip arrows overlay */}
            <path d="M8 12h8M14 9l3 3-3 3" />
          </svg>
        ) : (
          /* Front camera active → show "switch to rear" icon */
          <svg
            className="w-5 h-5 text-white"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <path d="M16 12H8M10 15l-3-3 3-3" />
          </svg>
        )}
      </button>

      {/* Inline error toast */}
      {switchError && (
        <div
          className={[
            'absolute top-28 right-4 z-30',
            'px-3 py-2 rounded-lg text-xs text-white max-w-[180px] text-right',
            'bg-red-600/90 backdrop-blur-sm shadow-lg',
            'animate-fade-in',
          ].join(' ')}
        >
          {switchError}
        </div>
      )}
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Standalone camera constraint helper (unchanged from original, kept here
// for the permission pre-check in initializeAR)
// ─────────────────────────────────────────────────────────────────────────────

async function getDynamicVideoConstraints(): Promise<MediaStreamConstraints['video']> {
  const base: MediaStreamConstraints['video'] = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter((d) => d.kind === 'videoinput');
    return {
      ...base,
      facingMode: inputs.length > 1 ? 'environment' : 'user',
    };
  } catch {
    return { ...base, facingMode: 'user' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARTryOnModal
// ─────────────────────────────────────────────────────────────────────────────

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
  const shouldShowFallback    = useARStore(selectShouldShowFallback);
  const isLoading             = useARStore(selectIsLoading);
  const errorMessage          = useARStore(selectErrorMessage);
  const fallbackMode          = useARStore(selectFallbackMode);
  const modelLoadingProgress  = useARStore(selectModelLoadingProgress);

  const setCameraPermission = useARStore((s) => s.setCameraPermission);
  const setDeviceClass      = useARStore((s) => s.setDeviceClass);
  const activateFallback    = useARStore((s) => s.activateFallback);
  const setLoading          = useARStore((s) => s.setLoading);
  const closeModal          = useARStore((s) => s.closeModal);

  const modalRef          = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);

  // ── ESC key handler ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [isOpen]);

  // ── Body scroll lock ──────────────────────────────────────────────────────
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // ── Permission pre-check + device profiling ───────────────────────────────
  useEffect(() => {
    if (!isOpen || hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const initializeAR = async () => {
      try {
        const profile = await DeviceProfiler.profile();
        setDeviceClass(profile.deviceClass);
        if (profile.deviceClass === 'UNSUPPORTED' || profile.deviceClass === 'LOW') return;

        try {
          const constraints = await getDynamicVideoConstraints();
          const stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
          // Immediately stop — this was only a permission check
          stream.getTracks().forEach((t) => t.stop());
          setCameraPermission(true);
        } catch {
          setCameraPermission(false);
          activateFallback('PERMISSION_DENIED');
        }
      } catch (err) {
        console.error('[ARTryOnModal] AR init check failed:', err);
        setLoading(false);
        activateFallback('CAMERA_ERROR');
      }
    };

    initializeAR();
  }, [isOpen]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    closeModal();
    onClose();
  }, [onClose, closeModal]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  if (!isOpen) return null;

  // ── Progress label ────────────────────────────────────────────────────────
  const progress = Math.min(Math.round(modelLoadingProgress), 100);
  const progressLabel =
    progress < 30
      ? 'Starting camera...'
      : progress < 70
      ? `Loading 3D model... ${progress}%`
      : progress < 100
      ? `Processing... ${progress}%`
      : 'Ready!';

  // ─────────────────────────────────────────────────────────────────────────
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

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
          <h2
            id="ar-modal-title"
            className="text-white text-lg font-semibold tracking-wide"
          >
            Virtual Try-On
          </h2>

          {/* Close button — pointer-events re-enabled individually */}
          <button
            onClick={handleClose}
            className="pointer-events-auto p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-full transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* ── Camera Flip Button ───────────────────────────────────────────
             Only visible when AR is running (not in fallback mode).
             CameraFlipButton renders null when sessionRef is null.            */}
        {!shouldShowFallback && <CameraFlipButton />}

        {/* ── Main Content ─────────────────────────────────────────────────── */}
        <div className="w-full h-full">
          <React.Suspense
            fallback={
              <div className="flex items-center justify-center w-full h-full">
                <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-white" />
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

        {/* ── Loading Overlay ─────────────────────────────────────────────── */}
        {isLoading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm">
            <div className="animate-spin rounded-full h-20 w-20 border-t-2 border-b-2 border-amber-400 mb-4" />
            <p className="text-white text-lg font-medium">Initializing AR Experience...</p>
            <p className="text-white/60 text-sm mt-2">
              Please allow camera access when prompted
            </p>

            <div className="w-64 h-2 bg-gray-700 rounded-full mt-4 overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-white/80 text-xs mt-2">{progressLabel}</p>
          </div>
        )}

        {/* ── Error Toast ─────────────────────────────────────────────────── */}
        {errorMessage && !isLoading && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 px-6 py-3 bg-red-500/90 rounded-lg shadow-lg">
            <p className="text-white text-sm font-medium">{errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ARTryOnModal;
