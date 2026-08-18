/**
 * vite.config.ts
 *
 * Key optimizations for sub-3s load:
 *  1. worker.format: 'es' — enables ES module workers so Vite can tree-shake
 *     and the worker gets its own entry chunk (not inlined as base64).
 *  2. manualChunks — splits Three.js, MediaPipe, and R3F into separate
 *     cacheable chunks so a ring model update doesn't bust the engine cache.
 *  3. optimizeDeps.exclude @mediapipe/tasks-vision — this package self-manages
 *     its WASM via fetch; pre-bundling it with esbuild breaks the WASM loader.
 *  4. assetsInlineLimit: 0 — prevents Vite from inlining WASM as base64 data
 *     URIs, which can inflate the JS parse time significantly.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// ---------------------------------------------------------------------------
// GitHub Pages base path — set VITE_BASE in CI env or hardcode your repo slug.
// ---------------------------------------------------------------------------
const BASE = process.env.VITE_BASE ?? '/AR-website/';

export default defineConfig({
  base: BASE,

  plugins: [
    react(),
    // Copy Draco decoder WASM files (from three.js package) into /dist/draco/
    // so DRACOLoader can fetch them without a CDN dependency at runtime.
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/three/examples/jsm/libs/draco/**/*',
          dest: 'draco',
        },
      ],
    }),
  ],

  // ---------------------------------------------------------------------------
  // Worker configuration — ES module workers are required for import() in workers.
  // ---------------------------------------------------------------------------
  worker: {
    format: 'es',
  },

  // ---------------------------------------------------------------------------
  // Dependency pre-bundling
  // ---------------------------------------------------------------------------
  optimizeDeps: {
    // @mediapipe/tasks-vision ships its own WASM loader; esbuild pre-bundling
    // changes the module resolution and breaks the WASM fetch path.
    exclude: ['@mediapipe/tasks-vision'],
    // Pre-bundle Three.js so it doesn't get double-processed.
    include: ['three', 'three/examples/jsm/loaders/GLTFLoader',
              'three/examples/jsm/loaders/DRACOLoader'],
  },

  build: {
    target: 'esnext',
    // Prevent WASM binaries from being inlined as data URIs.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js core — large, rarely changes
          'vendor-three': ['three'],
          // React Three Fiber + Drei — change together
          'vendor-r3f': ['@react-three/fiber', '@react-three/drei'],
          // MediaPipe — large, rarely changes
          'vendor-mediapipe': ['@mediapipe/tasks-vision'],
          // React — almost never changes
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
});
