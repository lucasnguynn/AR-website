/**
 * useRingModel.ts
 *
 * FIXED BUGS:
 *  1. MODEL_PATH pointed to '/models/ring.glb' but the actual file in
 *     public/models/ is 'nhan.glb'. This caused a 404, which killed
 *     the Suspense boundary and left the loading screen frozen forever.
 *     Fixed to use `import.meta.env.BASE_URL + 'models/nhan.glb'` so
 *     the path resolves correctly both in local dev (/) and on GitHub
 *     Pages (/AR-website/).
 *
 *  2. The GLB has NO Draco compression (confirmed: extensionsUsed = []).
 *     Calling useGLTF.setDecoderPath() when the model is not Draco-compressed
 *     causes DRACOLoader to initialize its WASM decoder and wait for a decode
 *     job that never comes → Suspense deadlock.
 *     The setDecoderPath call has been REMOVED from this file.
 *     The same call in ARTryOnModal.tsx has also been removed.
 *
 *  3. The `useGLTF` call passed undefined for the onProgress 4th argument via
 *     positional params (dracoPath, meshoptPath, onProgress) — this API shape
 *     only works in newer drei versions. Using the hook without extra args is
 *     cleaner and avoids internal type mismatches across drei versions.
 */

import { useEffect } from 'react';
import { useGLTF } from '@react-three/drei';

// ─── Calibration constants — tweak these to fit the ring on the finger ───────
export const RING_SCALE = 0.018;  // World-space uniform scale of the ring mesh
export const OFFSET_Y   = 0.004; // Vertical nudge along finger axis (positive = up)
export const OFFSET_Z   = 0.000; // Depth nudge (positive = toward camera)
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️  BASE_URL is critical for GitHub Pages.
//    In dev:   BASE_URL = '/'           → '/models/nhan.glb'
//    In prod:  BASE_URL = '/AR-website/' → '/AR-website/models/nhan.glb'
const MODEL_PATH = import.meta.env.BASE_URL + 'models/nhan.glb';

// ⚠️  NO useGLTF.setDecoderPath() here.
//    The model is NOT Draco-compressed. Setting a decoder path triggers
//    DRACOLoader initialisation which spins waiting for a decode job that
//    never arrives — this was the root cause of the Suspense deadlock.

/**
 * Thin wrapper around useGLTF.
 * useGLTF suspends until the file is fully parsed, then returns the scene.
 * The Suspense boundary in RingScene shows null while waiting.
 */
export function useRingModel() {
  const gltf = useGLTF(MODEL_PATH);

  // Defensive: log exactly which model path was resolved so path bugs are
  // immediately visible in the console rather than a silent loading hang.
  useEffect(() => {
    console.info('[useRingModel] Model loaded from:', MODEL_PATH);
  }, []);

  // Clone so the original cached scene is never mutated.
  // Without this, disposing one instance disposes the shared geometry for all.
  const clonedScene = gltf.scene.clone(true);

  return { scene: clonedScene };
}

// Eagerly start the network fetch before the component mounts.
// This moves the request into the browser pipeline during app boot so the
// Suspense wait is shorter when the component tree eventually renders.
useGLTF.preload(MODEL_PATH);
