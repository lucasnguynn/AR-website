import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ---------------------------------------------------------------------------
// GitHub Pages base path — set VITE_BASE in CI env or hardcode your repo slug.
// ---------------------------------------------------------------------------
const BASE = process.env.VITE_BASE ?? '/AR-website/';

export default defineConfig({
  base: BASE,

  plugins: [
    react()
  ],

  // ---------------------------------------------------------------------------
  // Worker configuration
  // ---------------------------------------------------------------------------
  worker: {
    format: 'es',
  },

  // ---------------------------------------------------------------------------
  // Dependency pre-bundling
  // ---------------------------------------------------------------------------
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision', '@tensorflow/tfjs-core', '@tensorflow/tfjs-backend-webgpu', '@tensorflow/tfjs-converter'],
    include: ['three', 'three/examples/jsm/loaders/GLTFLoader',
              'three/examples/jsm/loaders/DRACOLoader'],
  },

  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three-core';
          if (id.includes('node_modules/@react-three')) return 'r3f';
          if (id.includes('/src/tracking/') || id.includes('@mediapipe') || id.includes('@tensorflow')) return 'tracking';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
});
