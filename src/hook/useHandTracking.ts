// src/hooks/useHandTracking.ts  — excerpt showing the corrected useEffect
// (replace your existing worker useEffect with this block)

useEffect(() => {
  // Guard: don't init if the video element isn't ready
  if (!videoRef.current) return;

  const worker = new Worker(
    new URL('../workers/handTrackingWorker.ts', import.meta.url),
    { type: 'module' }
  );

  worker.onmessage = (e: MessageEvent<HandTrackingResult>) => {
    // ... your existing message handler
  };

  worker.onerror = (err) => {
    console.error('[useHandTracking] Worker error:', err);
  };

  // Start the worker
  worker.postMessage({ type: 'INIT', payload: { /* config */ } });

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  // Without terminate(), the MediaPipe WASM runtime keeps running after the
  // component unmounts (e.g. during React HMR or route changes), consuming
  // CPU and leaking the camera stream lock.
  return () => {
    worker.postMessage({ type: 'DESTROY' }); // let the worker close MediaPipe gracefully
    // Give it 300 ms to flush, then hard-terminate regardless.
    const killTimer = setTimeout(() => worker.terminate(), 300);
    worker.addEventListener('message', (e) => {
      if (e.data?.type === 'DESTROYED') {
        clearTimeout(killTimer);
        worker.terminate();
      }
    }, { once: true });
  };
}, [videoRef]); // re-init only if the video element reference changes
