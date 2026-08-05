const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-special-module-permissions-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'special-module-permissions.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { app } = require('../index');
const { initDatabase, openDatabase, uploadsDir } = require('../db/database');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 通过真实 HTTP 请求验证特殊模块的认证、权限和下载响应边界。
function request(server, method, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.body === undefined ? '' : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) })
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: isJson ? JSON.parse(body.toString('utf8')) : null
        });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

// 准备可下载的统一导入审计批次，保持原文件下载路径校验的真实服务链路。
function createImportBatchFixture() {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const storedFilename = 'special-module-permission.csv';
  fs.writeFileSync(path.join(uploadsDir, storedFilename), 'period,energy_type,value,unit\n2026-01,electricity,1,kWh\n', 'utf8');

  const now = new Date().toISOString();
  const db = openDatabase();
  try {
    return db.prepare(`INSERT INTO import_batches (
      import_type, original_filename, stored_filename, file_type, file_size_bytes,
      status, total_rows, success_count, failure_count, skipped_count,
      duplicate_strategy, created_at, updated_at
    ) VALUES (?, ?, ?, 'csv', ?, 'completed', 1, 1, 0, 0, 'skip', ?, ?)`).run(
      'energy_record',
      '特殊模块权限.csv',
      storedFilename,
      fs.statSync(path.join(uploadsDir, storedFilename)).size,
      now,
      now
    ).lastInsertRowid;
  } finally {
    db.close();
  }
}

(async () => {
  let server;
  try {
    initDatabase();
    const batchId = createImportBatchFixture();
    const ordinaryUser = register({ username: 'specialreader', password: 'Password123!' });
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    const ordinaryToken = login({ username: ordinaryUser.username, password: 'Password123!' }).token;

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const dashboardAnonymous = await request(server, 'GET', '/api/dashboard/summary');
    assert.strictEqual(dashboardAnonymous.status, 401);
    const dashboardForbidden = await request(server, 'GET', '/api/dashboard/summary', { token: ordinaryToken });
    assert.strictEqual(dashboardForbidden.status, 403);
    const dashboardAdmin = await request(server, 'GET', '/api/dashboard/summary', { token: adminToken });
    assert.strictEqual(dashboardAdmin.status, 200);

    const importsAnonymous = await request(server, 'GET', '/api/imports/batches');
    assert.strictEqual(importsAnonymous.status, 401);
    const importsForbidden = await request(server, 'GET', '/api/imports/contract', { token: ordinaryToken });
    assert.strictEqual(importsForbidden.status, 403);
    const importsAdmin = await request(server, 'GET', '/api/imports/batches', { token: adminToken });
    assert.strictEqual(importsAdmin.status, 200);
    assert(importsAdmin.json.data.some((batch) => batch.id === batchId));
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${batchId}`, { token: ordinaryToken })).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${batchId}/errors`, { token: ordinaryToken })).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${batchId}/download`, { token: ordinaryToken })).status, 403);
    const importDownload = await request(server, 'GET', `/api/imports/batches/${batchId}/download`, { token: adminToken });
    assert.strictEqual(importDownload.status, 200);
    assert.strictEqual(importDownload.body.toString('utf8'), 'period,energy_type,value,unit\n2026-01,electricity,1,kWh\n');
    assert.strictEqual((await request(server, 'POST', '/api/imports/batches')).status, 401);
    assert.strictEqual((await request(server, 'POST', '/api/imports/batches', { token: ordinaryToken })).status, 403);
    const importAdminRequest = await request(server, 'POST', '/api/imports/batches', { token: adminToken });
    assert.strictEqual(importAdminRequest.status, 400, '管理员请求必须通过认证与权限后才进入既有上传校验。');
    assert.strictEqual((await request(server, 'DELETE', `/api/imports/batches/${batchId}`, { token: ordinaryToken })).status, 403);

    const health = await request(server, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    const bootstrap = await request(server, 'GET', '/api/bootstrap');
    assert.strictEqual(bootstrap.status, 200);
    assert.deepStrictEqual(bootstrap.json.data.maintenance, { active: false });
    assert(!bootstrap.body.toString('utf8').includes(tmpDir), '公开 bootstrap 不得泄露本地目录。');
    assert.strictEqual((await request(server, 'GET', '/api/meta')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/meta', { token: ordinaryToken })).status, 403);
    const meta = await request(server, 'GET', '/api/meta', { token: adminToken });
    assert.strictEqual(meta.status, 200);
    assert(!meta.body.toString('utf8').includes(tmpDir), '受保护 meta 不得返回本地目录。');

    assert.strictEqual((await request(server, 'GET', '/api/system/backups')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/system/backups', { token: ordinaryToken })).status, 403);
    const backupCreated = await request(server, 'POST', '/api/system/backups', { token: adminToken });
    assert.strictEqual(backupCreated.status, 201);
    assert(!backupCreated.body.toString('utf8').includes(tmpDir), '备份创建响应不得泄露本地目录。');
    const backupName = backupCreated.json.data.backupName;
    const backupList = await request(server, 'GET', '/api/system/backups', { token: adminToken });
    assert.strictEqual(backupList.status, 200);
    assert(backupList.json.data.some((backup) => backup.backupName === backupName));
    assert(!backupList.body.toString('utf8').includes(tmpDir), '备份列表不得泄露本地目录。');
    assert.strictEqual((await request(server, 'GET', `/api/system/backups/${encodeURIComponent(backupName)}/download`, { token: ordinaryToken })).status, 403);
    const backupDownload = await request(server, 'GET', `/api/system/backups/${encodeURIComponent(backupName)}/download`, { token: adminToken });
    assert.strictEqual(backupDownload.status, 200);
    assert(backupDownload.body.length > 0);
    assert.strictEqual((await request(server, 'POST', `/api/system/backups/${encodeURIComponent(backupName)}/restore`, { token: ordinaryToken })).status, 403);
    assert.strictEqual((await request(server, 'DELETE', `/api/system/backups/${encodeURIComponent(backupName)}`, { token: ordinaryToken })).status, 403);

    const maintenanceResults = await runWithMaintenance('test-special-module-permissions', async () => ({
      importCreate: await request(server, 'POST', '/api/imports/batches', { token: adminToken }),
      backupCreate: await request(server, 'POST', '/api/system/backups', { token: adminToken }),
      backupRestore: await request(server, 'POST', `/api/system/backups/${encodeURIComponent(backupName)}/restore`, { token: adminToken })
    }));
    [maintenanceResults.importCreate, maintenanceResults.backupCreate, maintenanceResults.backupRestore].forEach((response) => {
      assert.strictEqual(response.status, 423);
      assert.strictEqual(response.json.error.code, 'MAINTENANCE_IN_PROGRESS');
    });

    const restored = await request(server, 'POST', `/api/system/backups/${encodeURIComponent(backupName)}/restore`, { token: adminToken });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.json.data.restoredFrom.backupName, backupName);
    assert(!restored.body.toString('utf8').includes(tmpDir), '恢复响应不得泄露本地目录。');
    const deleted = await request(server, 'DELETE', `/api/system/backups/${encodeURIComponent(backupName)}`, { token: adminToken });
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual(deleted.json.data.deleted, true);
    assert(!deleted.body.toString('utf8').includes(tmpDir), '删除响应不得泄露本地目录。');

    console.log('special module permission tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
