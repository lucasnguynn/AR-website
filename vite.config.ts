// FILE: vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';

export default defineConfig({
  base: repoName ? `/${repoName}/` : '/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 512,
    rollupOptions: {
      output: {
        manualChunks: {
          'three-core': ['three'],
          'three-webgpu': ['three/webgpu', 'three/tsl'],
          mediapipe: ['@mediapipe/tasks-vision'],
          tfjs: ['@tensorflow/tfjs-core', '@tensorflow/tfjs-backend-webgpu'],
          onnxruntime: ['onnxruntime-web'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  plugins: [react()],
});
// VERIFY: console.log('Vite GitHub Pages base and ES worker chunk config loaded')
