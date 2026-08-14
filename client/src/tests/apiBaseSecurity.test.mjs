import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFromFile } from 'vite';
// API Base 模块：保持公网地址不可信及 Bearer Token 不外发的既有安全契约。
const sourcePath = path.resolve('client/src/utils/apiBase.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { applyTrustedAuthorization, applyTrustedDemoContext, isTrustedApiBase, normalizeApiBase } = await import(moduleUrl);

// Vite 代理模块：验证开发地址与转发 Origin 使用同一固定本地来源。
const viteConfigPath = path.resolve('client/vite.config.js');
const loadedViteConfig = await loadConfigFromFile({ command: 'serve', mode: 'test' }, viteConfigPath);
assert(loadedViteConfig, 'Vite 配置应可正常加载。');
const viteServer = loadedViteConfig.config.server;
const apiProxy = viteServer.proxy['/api'];
assert.equal(viteServer.host, '127.0.0.1');
assert.equal(viteServer.port, 7777);
assert.equal(apiProxy.target, 'http://127.0.0.1:3002');
assert.equal(apiProxy.changeOrigin, true);
assert.equal(apiProxy.headers.Origin, `http://${viteServer.host}:${viteServer.port}`);

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
