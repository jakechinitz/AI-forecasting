import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/AI-forecasting/',
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
