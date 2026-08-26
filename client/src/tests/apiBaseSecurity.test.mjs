import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOpenInEditorBlockPlugin,
  createViteConfig
} from '../../viteConfigFactory.mjs';

// 当前测试目录模块：使用测试文件自身位置定位前端和项目根，避免依赖进程工作目录。
const currentTestPath = fileURLToPath(import.meta.url);
const currentTestDirectory = path.dirname(currentTestPath);
// 前端目录模块：用于定位 API Base 源码和 Vite 生产接线文件。
const clientRoot = path.resolve(currentTestDirectory, '..', '..');
// 项目根目录模块：用于构造冻结的假运行环境和预期根依赖目录。
const projectRoot = path.resolve(clientRoot, '..');
// 前端源码目录模块：验证 @ 别名仍指向 client/src。
const clientSourceRoot = path.join(clientRoot, 'src');
// 根依赖目录模块：Vite 文件 allowlist 只允许此前端目录与该依赖目录。
const rootNodeModules = path.join(projectRoot, 'node_modules');

// API Base 模块：保持公网地址不可信及 Bearer Token 不外发的既有安全契约。
const sourcePath = path.join(clientSourceRoot, 'utils', 'apiBase.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { applyTrustedAuthorization, applyTrustedDemoContext, isTrustedApiBase, normalizeApiBase } = await import(moduleUrl);

// 假运行环境模块：直接注入纯工厂，不修改 process.env，也不读取真实 .env。
const dynamicBackendPort = 43102;
const fakeRuntimeEnvironment = Object.freeze({
  backendHost: '127.0.0.1',
  backendPort: dynamicBackendPort,
  frontendHost: '127.0.0.1',
  frontendPort: 7777,
  backendOrigin: `http://127.0.0.1:${dynamicBackendPort}`,
  apiProxyTarget: `http://127.0.0.1:${dynamicBackendPort}`,
  developmentOrigin: 'http://127.0.0.1:7777',
  envDir: projectRoot
});
// Vite 纯配置模块：构造过程不得触发环境文件、开发服务或编辑器 I/O。
const viteConfig = createViteConfig(fakeRuntimeEnvironment);
const viteServer = viteConfig.server;
const apiProxy = viteServer.proxy['/api'];
assert.equal(viteConfig.root, clientRoot);
assert.equal(viteConfig.envDir, projectRoot);
assert.deepEqual(viteConfig.resolve.alias, { '@': clientSourceRoot });
assert.equal(viteServer.host, '127.0.0.1');
assert.equal(viteServer.port, 7777);
assert.equal(viteServer.strictPort, true);
assert.notEqual(viteServer.allowedHosts, true, '不得使用 allowedHosts=true 放宽 Host 校验。');
assert.equal(viteServer.fs.strict, true);
assert.deepEqual(viteServer.fs.allow, [clientRoot, rootNodeModules]);
assert.equal(viteServer.fs.allow.includes(projectRoot), false, '不得把整个项目根加入文件服务 allowlist。');
assert.equal(viteServer.fs.allow.includes(path.join(projectRoot, 'data')), false, 'data 目录不得进入文件服务 allowlist。');
assert.equal(Object.prototype.hasOwnProperty.call(viteServer.fs, 'deny'), false, '必须保留 Vite 默认 fs.deny。');
assert.equal(apiProxy.target, `http://127.0.0.1:${dynamicBackendPort}`);
assert.equal(apiProxy.changeOrigin, true);
assert.equal(apiProxy.headers.Origin, `http://${viteServer.host}:${viteServer.port}`);
// 插件顺序模块：编辑器安全插件必须排在 Vue 插件之前。
const editorPluginIndex = viteConfig.plugins.findIndex((plugin) => plugin?.name === 'charcoal:block-open-in-editor');
const vuePluginIndex = viteConfig.plugins.findIndex((plugin) => plugin?.name === 'vite:vue');
assert.equal(editorPluginIndex, 0);
assert(vuePluginIndex > editorPluginIndex, '编辑器安全插件必须置于 Vue 插件之前。');

// 编辑器端点插件测试模块：使用 fake Connect server/response 验证固定路径 404 和终止响应。
const openInEditorPlugin = createOpenInEditorBlockPlugin();
assert.equal(openInEditorPlugin.apply, 'serve');
assert.equal(openInEditorPlugin.enforce, 'pre');
// 中间件挂载记录模块：仅记录精确挂载路径和处理器，不启动 Vite。
let mountedEditorPath = null;
let mountedEditorHandler = null;
const fakeConnectServer = {
  middlewares: {
    use: (mountedPath, mountedHandler) => {
      mountedEditorPath = mountedPath;
      mountedEditorHandler = mountedHandler;
    }
  }
};
openInEditorPlugin.configureServer(fakeConnectServer);
assert.equal(mountedEditorPath, '/__open-in-editor');
assert.equal(typeof mountedEditorHandler, 'function');
// 请求替身模块：任何查询参数或 file 读取都会立即使测试失败。
const fakeRequest = new Proxy({}, {
  get: (_target, propertyName) => {
    throw new Error(`编辑器拦截器不得读取请求属性：${String(propertyName)}`);
  }
});
// 响应替身模块：记录状态、Content-Type 和响应体，确保处理器直接结束响应。
const responseHeaders = new Map();
const fakeResponse = {
  statusCode: 200,
  body: null,
  ended: false,
  setHeader: (headerName, headerValue) => {
    responseHeaders.set(headerName, headerValue);
  },
  end: (body) => {
    fakeResponse.body = body;
    fakeResponse.ended = true;
  }
};
// next 调用记录模块：安全处理器不得继续进入 Vite 内置编辑器中间件。
let nextCallCount = 0;
mountedEditorHandler(fakeRequest, fakeResponse, () => {
  nextCallCount += 1;
});
assert.equal(fakeResponse.statusCode, 404);
assert.equal(responseHeaders.get('Content-Type'), 'text/plain');
assert.equal(fakeResponse.body, 'Not Found');
assert.equal(fakeResponse.ended, true);
assert.equal(nextCallCount, 0);

// 函数源码提取模块：按花括号层级限定静态接线断言范围，避免跨文件宽泛匹配。
function extractFunctionSource(sourceText, functionName) {
  // 函数签名模块：同时兼容普通和 async function 声明。
  const signatureIndex = sourceText.indexOf(`function ${functionName}(`);
  assert.notEqual(signatureIndex, -1, `未找到函数 ${functionName}。`);
  // 函数起始模块：从签名后的首个左花括号开始计算层级。
  const openingBraceIndex = sourceText.indexOf('{', signatureIndex);
  assert.notEqual(openingBraceIndex, -1, `函数 ${functionName} 缺少函数体。`);
  // 花括号层级模块：目标接线函数不含非配对花括号，归零位置即函数结尾。
  let braceDepth = 0;
  for (let characterIndex = openingBraceIndex; characterIndex < sourceText.length; characterIndex += 1) {
    const currentCharacter = sourceText[characterIndex];
    if (currentCharacter === '{') {
      braceDepth += 1;
    } else if (currentCharacter === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return sourceText.slice(signatureIndex, characterIndex + 1);
      }
    }
  }
  assert.fail(`函数 ${functionName} 缺少闭合花括号。`);
}

// Vite 生产接线静态契约模块：loader 只能在 defineConfig 回调函数内调用一次。
const viteConfigPath = path.join(clientRoot, 'vite.config.js');
const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');
const runtimeConfigFunctionSource = extractFunctionSource(viteConfigSource, 'createRuntimeViteConfig');
const allLoaderCalls = viteConfigSource.match(/\bloadRuntimeEnvironment\s*\(/g) || [];
const scopedLoaderCalls = runtimeConfigFunctionSource.match(/\bloadRuntimeEnvironment\s*\(/g) || [];
assert.equal(allLoaderCalls.length, 1, 'Vite 生产接线只能调用一次运行环境 loader。');
assert.equal(scopedLoaderCalls.length, 1, '运行环境 loader 必须位于延迟配置回调函数内。');
assert.match(runtimeConfigFunctionSource, /return\s+createViteConfig\(runtimeEnvironment\);/);
assert.match(viteConfigSource, /export default defineConfig\(createRuntimeViteConfig\);/);

for (const value of [
  'https://example.com/api',
  'https://token@example.com/api',
  'https://user:password@localhost:3002/api',
  'file:///tmp/api',
  'javascript:alert(1)',
  'HtTpS://example.com/api',
  'http:\\example.com\\api',
  'https:/\\example.com/api',
  'http://localhost:3002/other',
  '//example.com/api',
  '\\\\example.com\\api'
]) assert.equal(isTrustedApiBase(value), false, `${value} must be rejected`);
for (const value of ['/api', 'http://127.0.0.1:3002/api', 'https://localhost/api', 'http://[::1]:3002/api']) {
  assert.equal(isTrustedApiBase(value), true, `${value} must be trusted`);
}
assert.equal(normalizeApiBase('https://example.com/api'), '/api');

const rejected = { url: '/auth/profile', headers: { Authorization: 'Bearer stale-token' } };
applyTrustedAuthorization(rejected, 'https://example.com/api', 'session-token');
assert.equal(rejected.headers.Authorization, undefined, 'untrusted base must not receive a bearer token');
const absoluteRemote = { url: 'https://example.com/api/auth/profile', headers: { Authorization: 'Bearer stale-token' } };
applyTrustedAuthorization(absoluteRemote, '/api', 'session-token');
assert.equal(absoluteRemote.headers.Authorization, undefined, 'absolute remote request must not receive a bearer token');
for (const unsafeUrl of ['//example.com/api/auth/profile', '\\\\example.com\\api\\auth\\profile', 'https:/\\example.com/api', 'data:text/plain,test', 'auth/profile']) {
  const unsafeRequest = { url: unsafeUrl, headers: { Authorization: 'Bearer stale-token' } };
  applyTrustedAuthorization(unsafeRequest, '/api', 'session-token');
  assert.equal(unsafeRequest.headers.Authorization, undefined, `${unsafeUrl} must not receive a bearer token`);
}
const trusted = { url: '/auth/profile', headers: {} };
applyTrustedAuthorization(trusted, 'http://127.0.0.1:3002/api', 'session-token');
assert.equal(trusted.headers.Authorization, 'Bearer session-token');

const demoToken = 'a'.repeat(43);
const trustedDemo = {
  url: '/energy-flow-imports/models/preview',
  headers: {},
  demoContext: { artifactKey: '22-energy-flow-models', handlerKey: 'energy-flow-models-import', token: demoToken }
};
applyTrustedDemoContext(trustedDemo, '/api');
assert.equal(trustedDemo.headers['X-Demo-Context'], demoToken);
assert.equal(trustedDemo.demoContext, undefined, 'Axios config 中的 context 声明必须在注入后删除');
const remoteDemo = {
  url: 'https://example.com/api/import',
  headers: { 'X-Demo-Context': 'stale-context' },
  demoContext: { artifactKey: '22-energy-flow-models', handlerKey: 'energy-flow-models-import', token: demoToken }
};
applyTrustedDemoContext(remoteDemo, '/api');
assert.equal(remoteDemo.headers['X-Demo-Context'], undefined, '外部绝对 URL 不得收到演示 context');
const undeclaredDemo = { url: '/imports', headers: { 'x-demo-context': 'stale-context' } };
applyTrustedDemoContext(undeclaredDemo, '/api');
assert.equal(undeclaredDemo.headers['x-demo-context'], undefined, '未显式声明 artifact/handler 时必须清除 context');

console.log('api base security tests passed');
