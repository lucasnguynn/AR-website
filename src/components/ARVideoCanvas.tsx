/**
 * ARVideoCanvas.tsx
 *
 * Video canvas component that renders the camera feed and overlays
 * the 3D ring model using the ARSessionManager.
 */

import React, { useEffect, useRef } from 'react';
import { useARStore, selectARState, selectRingScale, selectSnapshotRef } from '../store/useARStore';
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

  const ringScale = useARStore(selectRingScale);

  useEffect(() => {
    if (sessionManagerRef.current) {
      sessionManagerRef.current.setRingScale(ringScale);
    }
  }, [ringScale]);

  // Initialize AR Session
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    const config: ARSessionConfig = {
      mediaPipeWasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      ringModelUrl,
      ringScale: 1.0,
      trackingFPS: 20,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
      videoConstraints: {
        facingMode: 'environment',
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    };

    const sessionManager = new ARSessionManager(config);
    sessionManagerRef.current = sessionManager;

    // FIX: onStateChange chỉ dùng để sync arState cho UI (RingCatalog visibility, v.v.)
    // KHÔNG dùng để control isLoading nữa — vì state CAMERA_READY có thể tồn tại
    // vô thời hạn nếu người dùng chưa đưa tay vào camera, khiến loading stuck mãi.
    sessionManager.onStateChange = (state) => {
      setARState(state);
      // Chỉ set loading=true khi đang khởi tạo thật sự
      // loading=false được xử lý bởi startAR() sau khi initialize() resolve
    };

    sessionManager.onError = (error) => {
      console.error('AR Session error:', error);
      setError(error.message);
      // setError → activateFallback → isLoading: false (handled in store)
    };

    const startAR = async () => {
      // Safety timeout: 20 giây
      const initTimeoutId = setTimeout(() => {
        console.error('AR initialization timed out');
        setError('AR initialization timed out. Please check camera permissions and network.');
      }, 20000);

      try {
        setLoading(true); // Bắt đầu loading

        await sessionManager.initialize(container);

        clearTimeout(initTimeoutId);

        // FIX CHÍNH: Tắt loading NGAY SAU KHI initialize() resolve thành công.
        // Lúc này camera đã bật, model đã load xong, Three.js canvas đã mount.
        // Không cần chờ TRACKING_ACTIVE (chờ người dùng đưa tay vào camera).
        setLoading(false);

        sessionManager.startLoops();
      } catch (error) {
        clearTimeout(initTimeoutId);
        console.error('Failed to start AR:', error);
        setLoading(false); // Đảm bảo loading luôn tắt dù có lỗi
        setError('Failed to start AR session');
      }
    };

    startAR();

    return () => {
      sessionManager.dispose();
      sessionManagerRef.current = null;
      useARStore.getState().setSnapshotRef(null);
    };
  }, [ringModelUrl]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && sessionManagerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        sessionManagerRef.current.resize(rect.width, rect.height);
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-black">
      {/* Ring Catalog - chỉ hiện khi đang track tay */}
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
