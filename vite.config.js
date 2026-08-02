import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The RS3 scoring service (server/app.py) runs on :8001; proxy /api to it so the
// browser sees a single origin.
export default defineConfig({
  plugins: [react()],
  build: {
    // Keep fingerprinted chunks from recent builds so browser tabs that were
    // already open during a deployment can finish loading lazy features.
    emptyOutDir: false,
  },
  server: {
    host: '0.0.0.0',
    port: 8000,
    watch: {
      ignored: ['**/.conda-env/**', '**/reference/**', '**/index/**'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
})
