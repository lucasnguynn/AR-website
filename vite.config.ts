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

  resolve: {
    alias: {
      'three/webgpu': 'three/examples/jsm/renderers/webgpu/WebGPURenderer.js',
    },
  },

  worker: {
    format: 'es',
  },

  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision', '@tensorflow/tfjs-core', '@tensorflow/tfjs-backend-webgpu', '@tensorflow/tfjs-converter'],
    include: ['three', 'three/examples/jsm/loaders/GLTFLoader', 'three/examples/jsm/loaders/DRACOLoader'],
  },

  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@mediapipe') || id.includes('node_modules/@tensorflow')) return 'mediapipe';
          if (id.includes('three/examples/jsm') && /webgpu|webgl|gpu/i.test(id)) return 'three-webgpu';
          if (id.includes('node_modules/three')) return 'three-core';
          if (id.includes('node_modules/@react-three')) return 'r3f';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
});
