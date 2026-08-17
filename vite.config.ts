import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // Configurable base URL via VITE_BASE_URL environment variable
    // Default to './' for relative paths (works with GitHub Pages)
    base: env.VITE_BASE_URL ?? './',
    build: {
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
            'mediapipe-vendor': ['@mediapipe/tasks-vision'],
            'zustand-vendor': ['zustand'],
          },
        },
      },
    },
  }
})
