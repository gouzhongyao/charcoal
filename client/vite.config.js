import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import { createViteConfig } from './viteConfigFactory.mjs';

// CommonJS 复用模块：Vite 配置通过项目根集中配置读取同一组本地地址。
const require = createRequire(import.meta.url);
const { loadRuntimeEnvironment } = require('../config/runtimeEnvironment');

// Vite 运行配置接线模块：仅在 Vite CLI 执行配置回调时加载根环境文件。
function createRuntimeViteConfig() {
  // 开发运行环境模块：envDir 指向项目根，API 代理随集中后端 PORT 派生。
  const runtimeEnvironment = loadRuntimeEnvironment();
  return createViteConfig(runtimeEnvironment);
}

export default defineConfig(createRuntimeViteConfig);
