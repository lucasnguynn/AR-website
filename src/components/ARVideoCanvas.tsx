/**
 * ARVideoCanvas.tsx — UPGRADED
 *
 * Changes vs original:
 *  1. Exposes sessionManagerRef via the Zustand store so ARTryOnModal
 *     can call switchCamera() without prop-drilling through Suspense boundaries.
 *  2. Orientation-change handler added: calls session.resize() on rotate.
 *  3. ResizeObserver used instead of window 'resize' for more accurate
 *     container-size tracking (handles split-screen, browser chrome changes).
 */

import React, { useEffect, useRef, useCallback } from 'react';
import {
  useARStore,
  selectARState,
  selectRingScale,
} from '../store/useARStore';
import { ARSessionManager, ARSessionConfig, FacingMode } from '../ARSessionManager';
import RingCatalog from './RingCatalog';

interface ARVideoCanvasProps {
  ringModelUrl: string;
}

export const ARVideoCanvas: React.FC<ARVideoCanvasProps> = ({ ringModelUrl }) => {
  const containerRef    = useRef<HTMLDivElement>(null);
  const sessionRef      = useRef<ARSessionManager | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const arState   = useARStore(selectARState);
  const ringScale = useARStore(selectRingScale);
  const setARState  = useARStore((s) => s.setARState);
  const setError    = useARStore((s) => s.setError);
  const setLoading  = useARStore((s) => s.setLoading);
  const setSessionRef = useARStore((s) => s.setSessionRef);   // ← new store action

  // ── Ring scale sync ───────────────────────────────────────────────────────
  useEffect(() => {
    sessionRef.current?.setRingScale(ringScale);
  }, [ringScale]);

  // ── Stable resize handler ─────────────────────────────────────────────────
  const handleResize = useCallback((width: number, height: number) => {
    sessionRef.current?.resize(width, height);
  }, []);

  // ── AR Session lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const config: ARSessionConfig = {
      mediaPipeWasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      ringModelUrl,
      ringScale: 1.0,
      trackingFPS: 20,
      // ── UPGRADED confidence thresholds ──
      minDetectionConfidence: 0.7,
      minTrackingConfidence:  0.7,
      // Let ARSessionManager run its own mobile-first detection logic
      // by omitting videoConstraints here (pass undefined = auto-detect).
    };

    const session = new ARSessionManager(config);
    sessionRef.current = session;

    // Expose session to store so ARTryOnModal can call switchCamera()
    setSessionRef(session);

    session.onStateChange = (state) => { setARState(state); };
    session.onError = (error) => {
      console.error('[ARVideoCanvas] Session error:', error);
      setError(error.message);
    };

    const startAR = async () => {
      const initTimeoutId = setTimeout(() => {
        setError('AR initialization timed out. Check camera permissions and network.');
      }, 20_000);

      try {
        setLoading(true);
        await session.initialize(container);
        clearTimeout(initTimeoutId);
        setLoading(false);
        session.startLoops();
      } catch (err) {
        clearTimeout(initTimeoutId);
        console.error('[ARVideoCanvas] startAR failed:', err);
        setLoading(false);
        setError('Failed to start AR session');
      }
    };

    startAR();

    // ── ResizeObserver — more reliable than window resize ─────────────────
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        handleResize(width, height);
      }
    });
    ro.observe(container);
    resizeObserverRef.current = ro;

    // ── Orientation change ────────────────────────────────────────────────
    const handleOrientationChange = () => {
      setTimeout(() => {
        if (containerRef.current) {
          const { clientWidth, clientHeight } = containerRef.current;
          handleResize(clientWidth, clientHeight);
        }
      }, 350); // wait for browser layout reflow
    };
    window.addEventListener('orientationchange', handleOrientationChange);

    return () => {
      session.dispose();
      sessionRef.current = null;
      setSessionRef(null);
      ro.disconnect();
      resizeObserverRef.current = null;
      window.removeEventListener('orientationchange', handleOrientationChange);
      useARStore.getState().setSnapshotRef(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringModelUrl]);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-black">
      {arState === 'TRACKING_ACTIVE' && (
        <RingCatalog
          onSelectRing={(modelUrl) => {
            sessionRef.current?.swapRingModel(modelUrl);
          }}
        />
      )}
    </div>
  );
};

export default ARVideoCanvas;

// ─────────────────────────────────────────────────────────────────────────────
// Type augmentation helpers (consumed by ARTryOnModal)
// ─────────────────────────────────────────────────────────────────────────────
export type { FacingMode };
