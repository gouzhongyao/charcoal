const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-budget-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-budget-api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && text ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject); req.end(raw);
  });
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----energy-budget-${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end(body);
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    const ordinary = register({ username: 'budgetreader', password: 'Password123!' });
    const { app } = require('../index');
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const adminLogin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    const ordinaryLogin = await request(server, 'POST', '/api/login', { username: 'budgetreader', password: 'Password123!' });
    const adminToken = adminLogin.body.data.token;

    assert.strictEqual((await request(server, 'GET', '/api/energy-budgets')).status, 401, '预算列表必须拒绝未登录请求。');
    const forbidden = await request(server, 'GET', '/api/energy-budgets', undefined, ordinaryLogin.body.data.token);
    assert.strictEqual(forbidden.status, 403, '无预算权限用户必须被服务端拒绝。');
    assert.strictEqual(ordinary.id > 0, true);
    assert.strictEqual((await request(server, 'GET', '/api/energy-budgets', undefined, adminToken)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/templates/energy-budgets.csv')).status, 401, '预算模板下载必须受认证保护。');
    const template = await request(server, 'GET', '/api/templates/energy-budgets.csv', undefined, adminToken);
    assert.strictEqual(template.status, 200);
    assert.strictEqual(template.headers['x-template-type'], 'energy-budgets');

    await runWithMaintenance('budget-api-test', async () => {
      const blocked = await request(server, 'POST', '/api/energy-budgets', { periodMonth: '2028-01', energyTypeCode: 'electricity', budgetValue: 1 }, adminToken);
      assert.strictEqual(blocked.status, 423, '维护态必须在已授权写操作前拒绝。');
    });

    const csv = 'periodMonth,energyTypeCode,organizationScope,budgetValue,unit,remark,status\n2028-01,electricity,接口导入单元,66,kWh,接口预演,active\n2028-01,electricity,接口导入单元,77,kWh,重复候选,active\n';
    const previewResponse = await multipart(server, '/api/energy-budgets/import/preview', 'energy-budgets.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual((await request(server, 'GET', '/api/energy-budgets?periodMonth=2028-01', undefined, adminToken)).body.meta.pagination.total, 0, 'preview 不得写入预算。');
    const auditPreview = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditPreview.importType, 'energy_budget');
    assert.strictEqual(auditPreview.auditPhase, 'preview');
    assert.strictEqual(auditPreview.issueCounts.warning, 1);

    const execute = await request(server, 'POST', '/api/energy-budgets/import/execute', {
      batchId: preview.batchId,
      confirmText: preview.confirmText,
      previewSignature: preview.previewSignature,
      expectedWouldImport: preview.summary.wouldImport,
      candidateRowIds: preview.candidateRowIds,
      candidateRows: preview.candidateRows,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(execute.status, 200);
    assert.strictEqual(execute.body.data.imported, 1);
    const auditExecute = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditExecute.auditPhase, 'execute');
    assert.strictEqual(auditExecute.status, 'completed_with_errors');
    const db = openDatabase();
    try {
      const imported = db.prepare("SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber FROM energy_budgets WHERE period_month = '2028-01'").get();
      assert.strictEqual(imported.sourceBatchId, preview.batchId);
      assert.strictEqual(imported.sourceRowNumber, 2);
    } finally { db.close(); }
    console.log('energy budget API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
