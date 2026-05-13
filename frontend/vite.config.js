var _a;
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
    plugins: [vue()],
    server: {
        host: '0.0.0.0',
        watch: {
            usePolling: true,
            interval: 200
        },
        proxy: {
            '/api': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                target: (_a = process.env['VITE_PROXY_TARGET']) !== null && _a !== void 0 ? _a : 'http://localhost:3001',
                changeOrigin: true
            }
        }
    }
});
