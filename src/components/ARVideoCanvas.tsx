/**
 * ARVideoCanvas.tsx
 *
 * Video canvas component that renders the camera feed and overlays
 * the 3D ring model using the ARSessionManager.
 */

import React, { useEffect, useRef } from 'react';
import { useARStore } from '../store/useARStore';
import { ARSessionManager, ARSessionConfig } from '../ARSessionManager';

interface ARVideoCanvasProps {
  ringModelUrl: string;
}

export const ARVideoCanvas: React.FC<ARVideoCanvasProps> = ({ ringModelUrl }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionManagerRef = useRef<ARSessionManager | null>(null);

  const setARState = useARStore((state) => state.setARState);
  const setError   = useARStore((state) => state.setError);
  const setLoading = useARStore((state) => state.setLoading);
  const setTakeSnapshotFn = useARStore((state) => state.setTakeSnapshotFn);

  // Initialize AR Session
  useEffect(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext('2d');

    if (!ctx) {
      setError('Failed to initialize canvas context');
      return;
    }

    // Configure AR Session
    // FIXED: mediaPipeWasmPath previously used a relative '/wasm/' path that
    // produces a 404 on GitHub Pages. It now points directly to the jsDelivr
    // CDN bundle so the WASM binary is always reachable regardless of deploy base.
    const config: ARSessionConfig = {
      mediaPipeWasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      ringModelUrl,
      ringScale: 1.0,
      trackingFPS: 15,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
      videoConstraints: {
        facingMode: 'environment',
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    };

    // Create session manager
    const sessionManager = new ARSessionManager(config);
    sessionManagerRef.current = sessionManager;

    // Register the takeSnapshot function in the store for ARControls to access
    setTakeSnapshotFn(() => sessionManager.takeSnapshot());

    // State change callback
    sessionManager.onStateChange((state) => {
      setARState(state);

      if (state === 'INITIALIZING' || state === 'CAMERA_READY') {
        setLoading(true);
      } else {
        setLoading(false);
      }
    });

    // Error callback
    sessionManager.onError((error) => {
      console.error('AR Session error:', error);
      setError(error.message);
    });

    // Start AR session
    const startAR = async () => {
      try {
        await sessionManager.start(video, canvas);
      } catch (error) {
        console.error('Failed to start AR:', error);
        setError('Failed to start AR session');
      }
    };

    startAR();

    // Cleanup
    return () => {
      sessionManager.stop();
      sessionManagerRef.current = null;
      setTakeSnapshotFn(null);
    };
  }, [ringModelUrl]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current && videoRef.current) {
        const video  = videoRef.current;
        const canvas = canvasRef.current;

        // Match canvas size to video display size
        canvas.width  = video.videoWidth  || 1280;
        canvas.height = video.videoHeight || 720;
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="relative w-full h-full overflow-hidden bg-black">
      {/* Video Element - Camera Feed */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover transform scale-x-[-1]" // Mirror for natural interaction
      />

      {/* AR Canvas Overlay - Renders 3D ring */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover transform scale-x-[-1]" // Match video mirroring
      />

      {/* Vignette Overlay for premium feel */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-radial from-transparent via-transparent to-black/20" />
    </div>
  );
};

export default ARVideoCanvas;
