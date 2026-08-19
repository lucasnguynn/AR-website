import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function githubPagesBase(): string {
  const configuredBase = process.env.VITE_BASE;
  if (configuredBase) return configuredBase;

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) return '/AR-website/';

  const repositoryName = repository.split('/').at(-1);
  return repositoryName ? `/${repositoryName}/` : '/';
}

export default defineConfig({
  base: githubPagesBase(),

  plugins: [react()],

  worker: {
    format: 'es',
  },

  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision', '@tensorflow/tfjs-core', '@tensorflow/tfjs-backend-webgpu', '@tensorflow/tfjs-converter'],
    include: ['three'],
  },

  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          'three/webgpu': ['three/webgpu', 'three/tsl'],
        },
      },
    },
  },
});
// VERIFY: No legacy three/examples paths remain in config.
