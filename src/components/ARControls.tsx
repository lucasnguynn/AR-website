/**
 * ARControls.tsx
 * 
 * UI overlay containing loading spinner, tracking guidance, and action buttons.
 */

import React from 'react';
import { useARStore, selectARState, selectIsLoading, selectTakeSnapshotFn } from '../store/useARStore';
// @fix BUG-03: Fixed import path for ARSessionState (was './ARSessionManager', should be '../ARSessionManager')
import { ARSessionState } from '../ARSessionManager';

export const ARControls: React.FC = () => {
  const arState = useARStore(selectARState);
  const isLoading = useARStore(selectIsLoading);
  const takeSnapshotFn = useARStore(selectTakeSnapshotFn);

  const handleTakePhoto = () => {
    if (!takeSnapshotFn) {
      console.warn('Snapshot function not available');
      return;
    }

    const dataUrl = takeSnapshotFn();
    if (!dataUrl) {
      console.warn('Failed to take snapshot');
      return;
    }

    // Create a temporary anchor element and trigger download
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'ring-try-on.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const showLostTrackingGuide = arState === ARSessionState.TRACKING_LOST;
  // @fix NEW-10: Show loading indicator for ALL loading phases, not just INITIALIZING
  const showLoading = isLoading

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
          <div className="flex items-center justify-center gap-4">
            {/* Take Photo Button */}
            <button
              onClick={handleTakePhoto}
              className="group relative flex items-center justify-center w-16 h-16 rounded-full bg-white hover:bg-gray-100 transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105"
              aria-label="Take photo"
            >
              <div className="w-14 h-14 rounded-full border-2 border-gray-300 group-hover:border-gray-400 transition-colors"></div>
              <div className="absolute w-12 h-12 rounded-full bg-white"></div>
            </button>
          </div>
          
          {/* Helper Text */}
          <p className="text-center text-white/70 text-xs mt-4">
            Position your hand naturally for best results
          </p>
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
