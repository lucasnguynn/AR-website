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
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionManagerRef = useRef<ARSessionManager | null>(null);

  const setARState = useARStore((state) => state.setARState);
  const setError   = useARStore((state) => state.setError);
  const setLoading = useARStore((state) => state.setLoading);
  const setTakeSnapshotFn = useARStore((state) => state.setTakeSnapshotFn);

  // Initialize AR Session
  useEffect(() => {
    if (!videoRef.current || !canvasRef.current || !containerRef.current) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;

    // @fix BUG-01 & BUG-02: Removed unused ctx variable (Three.js renders to its own WebGL canvas).
    // Corrected session initialization flow: create manager, assign callbacks, call initialize(), then start().

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

    // State change callback - @fix BUG-01: Assign callback to property, not call as method
    sessionManager.onStateChange = (state) => {
      setARState(state);

      if (state === 'INITIALIZING' || state === 'CAMERA_READY') {
        setLoading(true);
      } else {
        setLoading(false);
      }
    };

    // Error callback - @fix BUG-01: Assign callback to property, not call as method
    sessionManager.onError = (error) => {
      console.error('AR Session error:', error);
      setError(error.message);
    };

    // Start AR session - @fix BUG-02: Must call initialize() first before start()
    const startAR = async () => {
      try {
        // Initialize session with container element (required to reach CAMERA_READY state)
        await sessionManager.initialize(container);
        // After initialize() resolves, start() can be called
        // Note: start() manages its own video/canvas internally via the scene
        sessionManager.start(video, canvas);
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

  // Handle resize - sync canvas to container bounding rect and update scene camera
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current && videoRef.current && sessionManagerRef.current) {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const container = canvas.parentElement;

        if (container) {
          // Get the actual rendered size of the container
          const rect = container.getBoundingClientRect();
          
          // Canvas MUST track container size, NOT video.videoWidth/videoHeight
          // This is critical because CSS object-cover scales the video differently
          // than its intrinsic aspect ratio
          canvas.width = rect.width;
          canvas.height = rect.height;
          
          // Notify ARScene to adjust camera FOV for object-cover alignment
          // We need to pass video dimensions so the scene can calculate cover scale
          try {
            // Access the private scene property through type assertion for resize call
            const scene = (sessionManagerRef.current as any).scene;
            if (scene) {
              scene.resize(rect.width, rect.height, video.videoWidth, video.videoHeight);
            }
          } catch (e) {
            console.warn('Failed to update scene resize:', e);
          }
        }
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
