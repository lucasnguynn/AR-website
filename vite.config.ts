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
    exclude: ['@mediapipe/tasks-vision'],
    include: ['three', 'three/examples/jsm/loaders/GLTFLoader',
              'three/examples/jsm/loaders/DRACOLoader'],
  },

  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-three': ['three'],
          'vendor-r3f': ['@react-three/fiber', '@react-three/drei'],
          'vendor-mediapipe': ['@mediapipe/tasks-vision'],
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
});
