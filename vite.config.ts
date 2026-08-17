import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // SỬA LỖI CHÍ MẠNG: Khai báo chính xác tên repo trên GitHub
  base: '/AR-website/',
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
