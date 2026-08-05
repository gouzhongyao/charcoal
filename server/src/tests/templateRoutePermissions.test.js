const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-template-route-permissions-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'templates.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase } = require('../db/database');
const { register } = require('../services/authService');

function request(server, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && body.length ? JSON.parse(body.toString('utf8')) : body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    register({ username: 'template-reader', password: 'Password123!' });
    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const login = (username, password) => new Promise((resolve, reject) => {
      const raw = JSON.stringify({ username, password });
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/api/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', reject);
      req.end(raw);
    });
    const adminToken = (await login('admin', 'AdminPassword123!')).data.token;
    const ordinaryToken = (await login('template-reader', 'Password123!')).data.token;

    const ledgerTemplates = [
      'organization-units',
      'meters',
      'meter-readings',
      'production-outputs',
      'generation-records'
    ];
    for (const templateType of ledgerTemplates) {
      for (const format of ['xlsx', 'csv']) {
        const pathname = `/api/templates/${templateType}.${format}`;
        const anonymous = await request(server, pathname);
        assert.strictEqual(anonymous.status, 401, `${pathname} 必须拒绝匿名下载。`);
        assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');

        const forbidden = await request(server, pathname, ordinaryToken);
        assert.strictEqual(forbidden.status, 403, `${pathname} 必须拒绝无权限普通用户。`);
        assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');

        const allowed = await request(server, pathname, adminToken);
        assert.strictEqual(allowed.status, 200, `${pathname} 必须允许超级管理员下载。`);
        assert.strictEqual(allowed.headers['x-template-type'], templateType);
        assert(allowed.body.length > 0, `${pathname} 必须返回非空模板内容。`);
      }
    }

    for (const pathname of ['/api/templates/METERS.XLSX', '/api/templates/%6deters.csv']) {
      assert.strictEqual((await request(server, pathname)).status, 401, `${pathname} 不得绕过认证。`);
      assert.strictEqual((await request(server, pathname, ordinaryToken)).status, 403, `${pathname} 不得绕过权限校验。`);
      assert.strictEqual((await request(server, pathname, adminToken)).status, 200, `${pathname} 应保持合法模板下载。`);
    }

    assert.strictEqual((await request(server, '/api/templates/energy-budgets.csv')).status, 401, '预算模板保护不能回归。');
    assert.strictEqual((await request(server, '/api/templates/energy-budgets.csv', ordinaryToken)).status, 403, '预算模板必须拒绝无权限用户。');
    assert.strictEqual((await request(server, '/api/templates/%65nergy-budgets.csv', ordinaryToken)).status, 403, '编码路径不得绕过预算模板保护。');
    assert.strictEqual((await request(server, '/api/templates/energy-budgets.csv', adminToken)).status, 200, '超级管理员必须可下载预算模板。');

    for (const templateType of ['energy-records', 'prediction-history']) {
      for (const format of ['xlsx', 'csv']) {
        const response = await request(server, `/api/templates/${templateType}.${format}`);
        assert.strictEqual(response.status, 200, `${templateType} 历史模板必须保持匿名可下载。`);
        assert.strictEqual(response.headers['x-template-type'], templateType);
      }
    }

    console.log('template route permission tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
