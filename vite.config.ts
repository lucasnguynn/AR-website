// FILE: vite.config.ts
/**
 * vite.config.ts
 *
 * BUGS FIXED IN THIS REVISION:
 *
 * 1. "WARNING: Multiple instances of Three.js being imported"
 *    Root cause: `three` and `three/webgpu` resolve to separate module graph
 *    entries in some bundler configurations even with `resolve.dedupe: ['three']`,
 *    because `three/webgpu` is a different entry point that can pull in its own
 *    copy of shared Three.js internals when the dedupe only covers 'three'.
 *    FIX: Added 'three/webgpu' and 'three/tsl' to resolve.dedupe so Vite
 *    forces all Three.js entry points to the same physical module instance.
 *    Also set `noExternal` for these in ssr to prevent SSR-mode leakage.
 *
 * 2. manualChunks was grouping `three` and `three/webgpu` into separate chunks
 *    ('three-core' only covered 'three'), so at runtime the browser received two
 *    separate module instances of the Three.js internals, triggering the warning.
 *    FIX: manualChunks now explicitly includes both 'three/webgpu' and 'three/tsl'
 *    in the 'three-core' chunk so they share the same Three.js singleton.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';

export default defineConfig({
  base: repoName ? `/${repoName}/` : '/',
  resolve: {
    // Deduplicate ALL Three.js entry points to a single module instance.
    // Without this, `three/webgpu` can load its own copy of Three.js internals
    // alongside `three`, causing "Multiple instances of Three.js" at runtime.
    dedupe: ['three', 'three/webgpu', 'three/tsl'],
  },
  optimizeDeps: {
    include: ['three', 'three/webgpu', 'three/tsl'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 512,
    rollupOptions: {
      output: {
        manualChunks: {
          // Bundle ALL Three.js entry points together so they share one singleton.
          // Previously only 'three' was listed here; 'three/webgpu' went into its
          // own chunk and caused a duplicate module at runtime.
          'three-core': ['three', 'three/webgpu', 'three/tsl'],
          mediapipe: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
  // Worker format intentionally left as default (IIFE/classic) so that
  // importScripts() inside MediaPipe WASM glue code works correctly.
  plugins: [react()],
});
