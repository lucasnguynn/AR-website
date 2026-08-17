/**
 * ARControls.tsx
 * 
 * UI overlay containing loading spinner, tracking guidance, and action buttons.
 */

import React from 'react';
import { useARStore, selectARState, selectTakeSnapshotFn, selectRingScale } from '../store/useARStore';
// @fix BUG-03: Fixed import path for ARSessionState (was './ARSessionManager', should be '../ARSessionManager')
import { ARSessionState } from '../ARSessionManager';

export const ARControls: React.FC = () => {
  const arState = useARStore(selectARState);
  const isLoading = useARStore((state) => state.isLoading);
  const takeSnapshotFn = useARStore(selectTakeSnapshotFn);
  const ringScale = useARStore(selectRingScale);
  const setRingScale = useARStore((state) => state.setRingScale);

  const handleTakePhoto = async () => {
    if (!takeSnapshotFn) {
      console.warn('Snapshot function not available');
      return;
    }

    const dataUrl = takeSnapshotFn();
    if (!dataUrl) {
      console.warn('Failed to take snapshot');
      return;
    }

    try {
      // Convert base64 dataUrl to Blob for Web Share API
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], 'ring-try-on.jpg', { type: 'image/jpeg' });

      // Check if Web Share API is supported and can share files
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Check out this ring!',
            text: 'Virtual try-on powered by WebAR',
            files: [file],
          });
          return;
        } catch (err) {
          // User cancelled share — fall through to download
          if (err instanceof Error && err.name === 'AbortError') return;
        }
      }
    } catch (err) {
      console.error('Share failed:', err);
    }

    // Fallback: download
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'ring-try-on.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const showLostTrackingGuide = arState === ARSessionState.TRACKING_LOST;
  // @fix NEW-10: Show loading indicator for ALL loading phases, not just INITIALIZING
  const showLoading = isLoading;

  const canShare = typeof navigator !== 'undefined' && 'canShare' in navigator;

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      {/* Top Controls */}
      <div className="absolute top-20 left-0 right-0 flex justify-center px-4">
        {showLoading && (
          <div className="flex items-center gap-3 bg-black/60 backdrop-blur-md px-6 py-3 rounded-full">
            <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-amber-400"></div>
            <span className="text-white text-sm font-medium">Initializing camera...</span>
          </div>
        )}
      </div>

      {/* Lost Tracking Guide Overlay */}
      {showLostTrackingGuide && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="bg-gray-900/95 p-8 rounded-2xl shadow-2xl max-w-md mx-4 text-center border border-gray-700">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-400/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <h3 className="text-white text-xl font-semibold mb-2">Hand Not Detected</h3>
            <p className="text-gray-300 mb-6">
              Please bring your hand into the camera frame and ensure good lighting.
            </p>
            <div className="flex items-center justify-center gap-2 text-amber-400 text-sm">
              <svg className="w-5 h-5 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
              <span>Position hand in view</span>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Action Bar */}
      {!showLostTrackingGuide && arState === ARSessionState.TRACKING_ACTIVE && (
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent pointer-events-auto">
          <div className="flex flex-col items-center justify-center gap-4">
            {/* Ring Size Slider */}
            <div className="flex items-center gap-3 px-4 py-2 bg-black/60 backdrop-blur-md rounded-full">
              <span className="text-white/70 text-xs">Size</span>
              <input 
                type="range" 
                min="0.5" 
                max="2.0" 
                step="0.05"
                value={ringScale}
                onChange={(e) => setRingScale(parseFloat(e.target.value))}
                className="w-24 accent-brand-neon"
              />
              <span className="text-white/70 text-xs w-8 text-right">
                {ringScale.toFixed(1)}×
              </span>
            </div>

            {/* Take Photo / Share Button */}
            <button
              onClick={handleTakePhoto}
              className="group relative flex items-center justify-center w-16 h-16 rounded-full bg-white hover:bg-gray-100 transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105"
              aria-label={canShare ? 'Share photo' : 'Save photo'}
            >
              <div className="w-14 h-14 rounded-full border-2 border-gray-300 group-hover:border-gray-400 transition-colors"></div>
              <div className="absolute w-12 h-12 rounded-full bg-white flex items-center justify-center">
                {canShare ? (
                  <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </div>
            </button>
            
            {/* Helper Text */}
            <p className="text-center text-white/70 text-xs mt-1">
              {canShare ? 'Share' : 'Save Photo'}
            </p>
          </div>
        </div>
      )}

      {/* Status Indicator (Top Right) */}
      <div className="absolute top-20 right-4 flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-2 rounded-full">
        <div
          className={`w-2 h-2 rounded-full ${
            arState === ARSessionState.TRACKING_ACTIVE
              ? 'bg-green-400'
              : arState === ARSessionState.TRACKING_LOST
              ? 'bg-amber-400'
              : arState === ARSessionState.ERROR
              ? 'bg-red-400'
              : 'bg-gray-400'
          }`}
        ></div>
        <span className="text-white text-xs font-medium">
          {arState === ARSessionState.TRACKING_ACTIVE
            ? 'Tracking'
            : arState === ARSessionState.TRACKING_LOST
            ? 'Searching'
            : arState === ARSessionState.ERROR
            ? 'Error'
            : 'Ready'}
        </span>
      </div>
    </div>
  );
};

export default ARControls;
