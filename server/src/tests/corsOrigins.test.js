const assert = require('assert');
const http = require('http');

// 测试环境模块：在加载应用前注入精确来源与无效 wildcard 配置。
const originalCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;
process.env.CORS_ALLOWED_ORIGINS = [
  'https://demo.trycloudflare.com',
  'https://*.trycloudflare.com',
  '*'
].join(',');

const {
  app,
  defaultAllowedOrigins,
  parseAllowedOrigin,
  buildAllowedOrigins,
  isCorsOriginAllowed
} = require('../index');

// HTTP 请求模块：通过真实 Express 中间件链路验证预检响应。
function requestCorsPreflight(server, origin) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'OPTIONS',
      path: '/api/login',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: rawBody ? JSON.parse(rawBody) : null
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

// 测试执行模块：覆盖来源解析、白名单构建和真实拒绝响应契约。
async function run() {
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

  let server;
  try {
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const localProxyResponse = await requestCorsPreflight(server, 'http://127.0.0.1:7777');
    assert.strictEqual(localProxyResponse.statusCode, 204, '本地 Vite 代理 Origin 应通过 CORS 预检。');
    assert.strictEqual(localProxyResponse.headers['access-control-allow-origin'], 'http://127.0.0.1:7777');
    const exposedHeaders = new Set(String(localProxyResponse.headers['access-control-expose-headers'] || '')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    [
      'x-demo-dataset-id',
      'x-demo-run-id',
      'x-demo-artifact-key',
      'x-demo-handler-key',
      'x-demo-manifest-version',
      'x-demo-manifest-digest',
      'x-demo-artifact-sha256',
      'x-demo-context',
      'x-exported-row-count',
      'x-exported-row-count-independent-activity',
      'x-exported-row-count-energy-record'
    ].forEach((headerName) => assert(exposedHeaders.has(headerName), `CORS 必须暴露 ${headerName}。`));

    const exactOriginResponse = await requestCorsPreflight(server, 'https://demo.trycloudflare.com');
    assert.strictEqual(exactOriginResponse.statusCode, 204, '精确配置的额外 Origin 应通过 CORS 预检。');
    assert.strictEqual(exactOriginResponse.headers['access-control-allow-origin'], 'https://demo.trycloudflare.com');

    for (const forbiddenOrigin of ['https://evil.example.com', 'https://random.trycloudflare.com']) {
      const forbiddenResponse = await requestCorsPreflight(server, forbiddenOrigin);
      assert.strictEqual(forbiddenResponse.statusCode, 403, `${forbiddenOrigin} 应返回 403，而不是归一为 500。`);
      assert.strictEqual(forbiddenResponse.body.success, false);
      assert.strictEqual(forbiddenResponse.body.error.code, 'CORS_ORIGIN_FORBIDDEN');
      assert.strictEqual(forbiddenResponse.body.error.message, '当前请求来源未被允许访问 API。');
    }
  } finally {
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    if (originalCorsAllowedOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = originalCorsAllowedOrigins;
    }
  }

  console.log('cors origin tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
