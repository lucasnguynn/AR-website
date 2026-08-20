// FILE: vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';

export default defineConfig({
  base: repoName ? `/${repoName}/` : '/',
  resolve: {
    dedupe: ['three'],
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
          'three-core': ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
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
