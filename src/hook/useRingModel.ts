// src/hooks/useRingModel.ts
import { useEffect, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ─── Calibration constants — tweak these to fit the ring on the finger ───────
export const RING_SCALE  = 0.018;   // World-space scale of the ring mesh
export const OFFSET_Y    = 0.004;   // Vertical nudge along the finger axis
export const OFFSET_Z    = 0.000;   // Depth nudge (toward/away from camera)
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️  IMPORTANT: Only set a Draco decoder path if ring.glb was actually
//    compressed with Draco. An uncompressed GLB + Draco config causes the
//    DracoLoader to spin forever waiting for a decode job that never arrives,
//    which is the exact Suspense deadlock you are experiencing.
//
//    To check: open ring.glb in https://gltf.report/ or run
//      `npx gltf-transform inspect public/models/ring.glb`
//    If it reports no Draco compression, keep the line below commented out.
//
// useGLTF.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.5/');

const MODEL_PATH = '/models/ring.glb'; // Must be relative to `public/`

/**
 * Thin wrapper around useGLTF that:
 *  1. Reports granular load progress so the loading overlay can update.
 *  2. Clones the scene so multiple instances never share geometry state.
 *  3. Exposes calibration constants alongside the model.
 */
export function useRingModel() {
  const [progress, setProgress] = useState(0);

  // useGLTF suspends the component until the file is fully parsed.
  // The Suspense boundary above us shows the loading overlay while we wait.
  const { scene } = useGLTF(
    MODEL_PATH,
    // Second arg = DRACO path override (undefined = use the default, which is
    // fine as long as we have NOT called useGLTF.setDecoderPath above).
    undefined,
    // Third arg = MESHOPT path (leave undefined unless you verified Meshopt).
    undefined,
    // Fourth arg = onProgress loader callback — this is how the overlay learns
    // that loading actually reached 100% and should dismiss.
    (xhr) => {
      if (xhr.total > 0) {
        setProgress(Math.round((xhr.loaded / xhr.total) * 100));
      }
    }
  );

  // Clone so the original cached scene is never mutated.
  // Without this, disposing one instance disposes the shared geometry.
  const clonedScene = scene.clone(true);

  return { scene: clonedScene, progress };
}

// Eagerly kick off the network request before the component mounts.
// This moves the fetch into the browser's request pipeline during app boot,
// so the Suspense delay is shorter.
useGLTF.preload(MODEL_PATH);
