import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';

// 当前模块路径模块：基于 import.meta.url 计算稳定的绝对前端目录，不依赖进程工作目录。
const currentModulePath = fileURLToPath(import.meta.url);
// 前端根目录模块：Vite 仅以 client 目录作为应用根和文件服务主范围。
const clientRoot = path.dirname(currentModulePath);
// 项目根目录模块：只用于定位根 node_modules，不加入 Vite 文件服务 allowlist。
const projectRoot = path.resolve(clientRoot, '..');
// 根依赖目录模块：允许前端开发服务器读取项目根安装的依赖。
const rootNodeModules = path.join(projectRoot, 'node_modules');
// 前端源码目录模块：为 @ 别名提供不依赖工作目录的绝对路径。
const clientSourceRoot = path.join(clientRoot, 'src');

// 编辑器端点响应模块：固定返回 404，不读取请求参数、不调用 next 或本机编辑器。
function blockOpenInEditorRequest(_request, response) {
  response.statusCode = 404;
  response.setHeader('Content-Type', 'text/plain');
  response.end('Not Found');
}

// 编辑器端点挂载模块：在 Vite 内置中间件前精确拦截固定路径。
function configureOpenInEditorBlocking(server) {
  server.middlewares.use('/__open-in-editor', blockOpenInEditorRequest);
}

// 编辑器端点安全插件模块：仅在开发服务阶段启用固定 404 拦截。
export function createOpenInEditorBlockPlugin() {
  return {
    name: 'charcoal:block-open-in-editor',
    apply: 'serve',
    enforce: 'pre',
    configureServer: configureOpenInEditorBlocking
  };
}

// Vite 纯配置工厂模块：仅使用调用方传入的运行环境，不读取 .env 或 process.env。
export function createViteConfig(runtimeEnvironment) {
  // API 代理模块：保持同源 /api、动态后端端口和受控开发 Origin。
  const apiProxy = {
    target: runtimeEnvironment.apiProxyTarget,
    changeOrigin: true,
    headers: { Origin: runtimeEnvironment.developmentOrigin }
  };

  return {
    root: clientRoot,
    envDir: runtimeEnvironment.envDir,
    plugins: [createOpenInEditorBlockPlugin(), vue()],
    resolve: { alias: { '@': clientSourceRoot } },
    server: {
      host: runtimeEnvironment.frontendHost,
      port: runtimeEnvironment.frontendPort,
      strictPort: true,
      fs: {
        strict: true,
        allow: [clientRoot, rootNodeModules]
      },
      proxy: { '/api': apiProxy }
    }
  };
}
