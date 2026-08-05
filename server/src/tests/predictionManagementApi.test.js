const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-prediction-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'prediction.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { register } = require('../services/authService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const buffer = Buffer.concat(chunks); const isJson = String(res.headers['content-type'] || '').includes('application/json'); resolve({ status: res.statusCode, headers: res.headers, body: isJson && buffer.length ? JSON.parse(buffer.toString('utf8')) : buffer }); });
    });
    req.on('error', reject); req.end(raw);
  });
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----prediction-${Date.now()}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.end(body);
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    register({ username: 'prediction-reader', password: 'Password123!' });
    const { app } = require('../index');
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const adminToken = (await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' })).body.data.token;
    const readerToken = (await request(server, 'POST', '/api/login', { username: 'prediction-reader', password: 'Password123!' })).body.data.token;

    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, readerToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, adminToken)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/templates/prediction-configs.csv')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/templates/prediction-configs.csv', undefined, readerToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/templates/prediction-configs.csv', undefined, adminToken)).status, 200);

    const db = openDatabase();
    try {
      const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const insert = db.prepare("INSERT INTO energy_records (energy_type_id,original_month,normalized_month,original_unit,original_value,normalized_unit,normalized_value,organization,duplicate_key,record_status) VALUES (?, ?, ?, 'kWh', ?, 'kWh', ?, '预测组织', ?, 'active')");
      [100, 120, 140].forEach((value, index) => insert.run(energyTypeId, `2026-0${index + 1}`, `2026-0${index + 1}`, value, value, `prediction-history-${index}`));
    } finally { db.close(); }

    const payload = { name: '关键字预测草稿', note: '可编辑', energyTypeCode: 'electricity', organizationScope: '预测组织', trainStartMonth: '2026-01', trainEndMonth: '2026-03', predictStartMonth: '2026-04', predictEndMonth: '2026-05', algorithm: 'linear_trend', status: 'draft' };
    const created = await request(server, 'POST', '/api/predictions/configs', payload, adminToken);
    assert.strictEqual(created.status, 201);
    const configId = created.body.data.id;
    assert.strictEqual(created.body.data.status, 'draft');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs?keyword=%E5%85%B3%E9%94%AE%E5%AD%97', undefined, adminToken)).body.meta.pagination.total, 1);
    const run = await request(server, 'POST', `/api/predictions/configs/${configId}/runs`, {}, adminToken);
    assert.strictEqual(run.status, 201);
    assert.strictEqual(run.body.data.run.status, 'completed');
    const runId = run.body.data.run.id;
    assert.strictEqual(run.body.data.summary.resultCount, 2);
    assert.strictEqual(run.body.data.run.parameters.configSnapshot.configId, configId, '运行必须保存配置快照。');
    const unchanged = await request(server, 'PUT', `/api/predictions/configs/${configId}`, { ...payload, name: '已编辑草稿' }, adminToken);
    assert.strictEqual(unchanged.status, 200);
    assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}`, undefined, adminToken)).body.data.parameters.configSnapshot.config.name, '关键字预测草稿', '编辑草稿不得篡改已运行快照。');
    const stats = await request(server, 'GET', '/api/predictions/runs/stats?keyword=%E5%85%B3%E9%94%AE%E5%AD%97', undefined, adminToken);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.data.completedCount, 1);
    const exported = await request(server, 'GET', `/api/predictions/results/export?format=csv&runId=${runId}`, undefined, adminToken);
    assert.strictEqual(exported.status, 200);
    assert(exported.body.toString('utf8').includes('predictedValue'));
    assert.strictEqual((await request(server, 'PATCH', `/api/predictions/runs/${runId}/status`, { status: 'cancelled' }, adminToken)).status, 400, '已完成运行不允许取消或改写结果。');
    assert.strictEqual((await request(server, 'PATCH', `/api/predictions/runs/${runId}/status`, { status: 'archived' }, adminToken)).status, 200);

    const csv = 'name,note,energyTypeCode,organizationScope,trainStartMonth,trainEndMonth,predictStartMonth,predictEndMonth,algorithm,windowSize,status\n导入预测草稿,不能直接产生结果,electricity,预测组织,2026-01,2026-03,2026-04,2026-05,moving_average,3,active\n导入预测草稿,同文件重复应跳过,electricity,预测组织,2026-01,2026-03,2026-04,2026-05,moving_average,3,active\n';
    const previewResponse = await multipart(server, '/api/predictions/configs/import/preview', 'prediction-configs.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.writesPredictionConfigs, false);
    assert.strictEqual(preview.writesPredictionRuns, false);
    assert.strictEqual(preview.writesPredictionResults, false);
    assert.strictEqual(preview.summary.skipped, 1, '同文件同名配置必须以 skip 警告保留审计。');
    assert.strictEqual(getImportAuditBatchDetail(preview.batchId).importType, 'prediction_config');
    const beforeResults = (await request(server, 'GET', '/api/predictions/results', undefined, adminToken)).body.meta.pagination.total;
    const executed = await request(server, 'POST', '/api/predictions/configs/import/execute', { batchId: preview.batchId, confirmText: preview.confirmText, previewSignature: preview.previewSignature, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, requireBackup: true, acknowledgeSkippedRisks: true }, adminToken);
    assert.strictEqual(executed.status, 200);
    assert.strictEqual(executed.body.data.writesPredictionRuns, false);
    assert.strictEqual(executed.body.data.writesPredictionResults, false);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/results', undefined, adminToken)).body.meta.pagination.total, beforeResults, '配置导入不得写结果。');
    const audit = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.status, 'completed_with_errors');
    assert.strictEqual((await request(server, 'POST', '/api/predictions/configs/import/execute', { batchId: preview.batchId, confirmText: '错误', previewSignature: preview.previewSignature, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, requireBackup: true, acknowledgeSkippedRisks: true }, adminToken)).status, 400);
    console.log('prediction management API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
