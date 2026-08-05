import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'client',
  plugins: [vue()],
  resolve: { alias: { '@': '/src' } },
  server: {
    host: '127.0.0.1',
    port: 7777,
    proxy: { '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true } }
  }
});
