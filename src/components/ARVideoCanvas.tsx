/**
 * ARVideoCanvas.tsx
 *
 * Video canvas component that renders the camera feed and overlays
 * the 3D ring model using the ARSessionManager.
 */

import React, { useEffect, useRef } from 'react';
import { useARStore, selectARState } from '../store/useARStore';
import { ARSessionManager, ARSessionConfig } from '../ARSessionManager';
import RingCatalog from './RingCatalog';

interface ARVideoCanvasProps {
  ringModelUrl: string;
}

export const ARVideoCanvas: React.FC<ARVideoCanvasProps> = ({ ringModelUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionManagerRef = useRef<ARSessionManager | null>(null);

  const arState = useARStore(selectARState);
  const setARState = useARStore((state) => state.setARState);
  const setError   = useARStore((state) => state.setError);
  const setLoading = useARStore((state) => state.setLoading);
  const setTakeSnapshotFn = useARStore((state) => state.setTakeSnapshotFn);

  // Initialize AR Session
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // @fix NEW-01: containerRef now attached to JSX div, so initialization proceeds correctly
    // @fix NEW-02: Removed video/canvas refs - ARSessionManager handles them internally via initialize()

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

    // Start AR session - @fix NEW-02: Call initialize() then startLoops() instead of start(video, canvas)
    const startAR = async () => {
      try {
        // Initialize session with container element - creates camera stream and Three.js canvas internally
        await sessionManager.initialize(container);
        // After initialize() resolves, start the tracking and render loops
        sessionManager.startLoops();
      } catch (error) {
        console.error('Failed to start AR:', error);
        setError('Failed to start AR session');
      }
    };

    startAR();

    // Cleanup - @fix NEW-02: Use dispose() which releases camera/worker/WebGL properly
    return () => {
      sessionManager.dispose();
      sessionManagerRef.current = null;
      setTakeSnapshotFn(null);
    };
  }, [ringModelUrl]);

  // Handle resize - sync canvas to container bounding rect and update scene camera
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && sessionManagerRef.current) {
        const container = containerRef.current;

        // Get the actual rendered size of the container
        const rect = container.getBoundingClientRect();
        
        // @fix NEW-02: Use new public resize() method instead of (as any).scene hack
        sessionManagerRef.current.resize(rect.width, rect.height);
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-black">
      {/* Ring Catalog - only show when tracking is active */}
      {arState === 'TRACKING_ACTIVE' && (
        <RingCatalog
          onSelectRing={(modelUrl) => {
            sessionManagerRef.current?.swapRingModel(modelUrl);
          }}
        />
      )}
    </div>
  );
};

export default ARVideoCanvas;
