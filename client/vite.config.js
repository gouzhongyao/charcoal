import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发服务器地址模块：host、port 与代理 Origin 必须保持同源派生关系。
const developmentHost = '127.0.0.1';
const developmentPort = 7777;
const developmentOrigin = `http://${developmentHost}:${developmentPort}`;
const apiProxyTarget = 'http://127.0.0.1:3002';

export default defineConfig({
  root: 'client',
  plugins: [vue()],
  resolve: { alias: { '@': '/src' } },
  server: {
    host: developmentHost,
    port: developmentPort,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        headers: { Origin: developmentOrigin }
      }
    }
  }
});
