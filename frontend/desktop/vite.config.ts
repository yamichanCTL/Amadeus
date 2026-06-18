import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    // Proxy API + WebSocket to backend — essential for WSL2 where
    // the Windows→WSL2 localhost forwarder can drop WebSocket upgrades.
    proxy: {
      '/v1': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,               // forward WebSocket upgrade
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
