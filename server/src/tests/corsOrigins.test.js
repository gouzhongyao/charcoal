const assert = require('assert');
const {
  defaultAllowedOrigins,
  parseAllowedOrigin,
  buildAllowedOrigins,
  isCorsOriginAllowed
} = require('../index');

assert.strictEqual(parseAllowedOrigin('https://demo.trycloudflare.com'), 'https://demo.trycloudflare.com');
assert.strictEqual(parseAllowedOrigin('https://demo.ngrok-free.app'), 'https://demo.ngrok-free.app');
assert.strictEqual(parseAllowedOrigin('http://localhost:7777'), 'http://localhost:7777');
assert.strictEqual(parseAllowedOrigin('http://[::1]:7777'), 'http://[::1]:7777');
assert.strictEqual(parseAllowedOrigin(' https://mixed-case.example.com '), 'https://mixed-case.example.com');

assert.strictEqual(parseAllowedOrigin('*'), '');
assert.strictEqual(parseAllowedOrigin('https://*.trycloudflare.com'), '');
assert.strictEqual(parseAllowedOrigin('ftp://example.com'), '');
assert.strictEqual(parseAllowedOrigin('file:///tmp/demo.html'), '');
assert.strictEqual(parseAllowedOrigin('javascript:alert(1)'), '');
assert.strictEqual(parseAllowedOrigin('https://example.com/path'), '');
assert.strictEqual(parseAllowedOrigin('https://example.com?debug=1'), '');
assert.strictEqual(parseAllowedOrigin('https://example.com#hash'), '');
assert.strictEqual(parseAllowedOrigin('https://user:pass@example.com'), '');
assert.strictEqual(parseAllowedOrigin('not a url'), '');

const allowedOrigins = buildAllowedOrigins([
  'https://demo.trycloudflare.com',
  'https://demo.ngrok-free.app',
  '*',
  'ftp://example.com',
  'https://example.com/path'
].join(','));

assert(defaultAllowedOrigins.every((origin) => allowedOrigins.has(origin)), '默认本地 Origin 应始终保留。');
assert(allowedOrigins.has('https://demo.trycloudflare.com'), '显式配置的 Cloudflare Tunnel 前端 Origin 应加入白名单。');
assert(allowedOrigins.has('https://demo.ngrok-free.app'), '显式配置的 ngrok 前端 Origin 应加入白名单。');
assert(!allowedOrigins.has('*'), '不得将 wildcard 加入 CORS 白名单。');
assert(!allowedOrigins.has('ftp://example.com'), '不得将非 http(s) 来源加入 CORS 白名单。');
assert(!allowedOrigins.has('https://example.com/path'), '不得将带路径的地址作为 Origin 加入 CORS 白名单。');

assert.strictEqual(isCorsOriginAllowed(undefined, allowedOrigins), true, '非浏览器同源或无 Origin 请求应保留原行为。');
assert.strictEqual(isCorsOriginAllowed('http://127.0.0.1:7777', allowedOrigins), true, '本地前端 Origin 应默认允许。');
assert.strictEqual(isCorsOriginAllowed('http://[::1]:7777', allowedOrigins), true, 'IPv6 本地前端 Origin 应默认允许。');
assert.strictEqual(isCorsOriginAllowed('https://demo.trycloudflare.com', allowedOrigins), true, '显式配置的公网前端 Origin 应允许。');
assert.strictEqual(isCorsOriginAllowed('https://evil.example.com', allowedOrigins), false, '未显式配置的公网 Origin 不得被任意回显或放行。');

console.log('cors origin tests passed');
