import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Crucial for GitHub Pages deployment
  // Using './' ensures assets load correctly from subdirectories
  // like username.github.io/repo-name/
  base: './',
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
})
