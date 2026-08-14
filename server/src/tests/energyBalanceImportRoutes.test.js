'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

// 路由测试使用隔离数据库与目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-balance-routes-'));
process.env.DATA_DIR = temporaryRoot;
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.SQLITE_PATH = path.join(temporaryRoot, 'routes.sqlite');
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyBalanceRoutes123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-balance-routes-test-secret-2026';
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyBalanceImportRouter = require('../routes/energyBalanceImports');
const { login } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

/** 创建只挂载平衡导入路由的 Express 应用。 */
function createApp() {
  const app = express();
  app.use('/api/energy-balance-imports', energyBalanceImportRouter);
  app.use(express.json({ limit: '1mb' }));
  app.post('/api/ordinary-json', (req, res) => res.status(200).json({ success: true, data: req.body, meta: {} }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** 发送 JSON 请求。 */
function requestJson(server, requestPath, body, token = null) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: requestPath,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(raw);
  });
}

/** 发送指定原始正文的 JSON 请求。 */
function requestRawJson(server, requestPath, raw, token = null) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: requestPath,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(raw);
  });
}

async function run() {
  initDatabase();
  const database = openDatabase();
  const normalRole = database.prepare("SELECT id FROM sys_roles WHERE role_code='user'").get();
  const normalUser = database.prepare("SELECT id FROM sys_users WHERE username='admin'").get();
  database.prepare('DELETE FROM sys_user_roles WHERE user_id = ?').run(normalUser.id);
  database.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(normalUser.id, normalRole.id, new Date().toISOString());
  database.close();
  const token = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
  const permissionDatabase = openDatabase();
  const now = new Date().toISOString();
  const executeMenu = permissionDatabase.prepare(
    "SELECT id FROM sys_menus WHERE permission_code='energy:balance:import:execute'"
  ).get();
  assert(executeMenu, '隔离数据库必须包含平衡导入 execute 权限种子。');
  const executeRoleId = permissionDatabase.prepare(
    "INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at) VALUES ('energy-balance-import-executor', '平衡导入执行员', 'active', ?, ?)"
  ).run(now, now).lastInsertRowid;
  permissionDatabase.prepare(
    'INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)'
  ).run(executeRoleId, executeMenu.id, now);
  permissionDatabase.close();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const anonymous = await requestJson(server, '/api/energy-balance-imports/bundle/execute', {
      payload: 'x'.repeat((64 * 1024) + 1024)
    });
    assert.strictEqual(anonymous.status, 401, '匿名超大 execute 必须在读取正文前先被认证阻断。');

    const forbidden = await requestRawJson(
      server,
      '/api/energy-balance-imports/bundle/execute',
      '{"invalid":',
      token
    );
    assert.strictEqual(forbidden.status, 403, '缺少 execute 权限的非法 JSON 必须在解析前被授权中间件阻断。');

    const grantDatabase = openDatabase();
    grantDatabase.prepare(
      'INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)'
    ).run(normalUser.id, executeRoleId, new Date().toISOString());
    grantDatabase.close();

    const invalidJson = await requestRawJson(
      server,
      '/api/energy-balance-imports/bundle/execute',
      '{"invalid":',
      token
    );
    assert.strictEqual(invalidJson.status, 400, '具备 execute 权限的非法 JSON 必须返回 400。');
    assert.strictEqual(invalidJson.body.error.code, 'INVALID_JSON_BODY');

    const oversized = await requestJson(server, '/api/energy-balance-imports/bundle/execute', {
      payload: 'x'.repeat((64 * 1024) + 1024)
    }, token);
    assert.strictEqual(oversized.status, 413, '具备 execute 权限的超大正文必须返回 413。');
    assert.strictEqual(oversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');

    const ordinaryJson = await requestJson(server, '/api/ordinary-json', { value: '仍由后续全局解析器处理' }, token);
    assert.strictEqual(ordinaryJson.status, 200, '平衡 execute 局部解析器不得影响后续普通 JSON 路由。');
    assert.deepStrictEqual(ordinaryJson.body.data, { value: '仍由后续全局解析器处理' });

    await runWithMaintenance('test.energy-balance-import', async () => {
      const maintenance = await requestJson(server, '/api/energy-balance-imports/bundle/execute', {
        boundaryBatchId: 1, itemBatchId: 2, confirmText: '确认导入平衡边界及九角色项目', requireBackup: true, acknowledgeSkippedRisks: true
      }, token);
      assert.strictEqual(maintenance.status, 423, '已授权用户在维护态下必须由 requireWritable 返回 423。');
      assert.strictEqual(maintenance.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    }, { actorUserId: normalUser.id });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run()
  .then(() => console.log('energyBalanceImportRoutes.test.js passed'))
  .finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
