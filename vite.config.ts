// FILE: vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';

export default defineConfig({
  base: repoName ? `/${repoName}/` : '/',
  resolve: {
    // Dedupe the package root; exported subpaths such as `three/tsl` then resolve
    // through the same installed Three.js package instead of being treated as
    // independent dependency roots.
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 512,
    rollupOptions: {
      output: {
        // Function form groups only modules that are actually reachable. The old
        // object form explicitly named `three/webgpu`, which could force an
        // experimental entry point into bundle planning even while production is
        // intentionally using the React18/R3F8 WebGL2 renderer.
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three-core';
          if (id.includes('/node_modules/@mediapipe/tasks-vision/')) return 'mediapipe';
          return undefined;
        },
      },
    },
  },
  plugins: [react()],
});
