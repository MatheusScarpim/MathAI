import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    watch: {
      usePolling: true,
      interval: 1000
    },
    proxy: {
      '/api': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        target: (process as any).env['VITE_PROXY_TARGET'] ?? 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
