const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { register } = require('../services/authService');

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf8')) : bodyBuffer });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----carbon-factor-${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    register({ username: 'carbon-reader', password: 'Password123!' });
    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const adminLogin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    const readerLogin = await request(server, 'POST', '/api/login', { username: 'carbon-reader', password: 'Password123!' });
    const adminToken = adminLogin.body.data.token;
    const readerToken = readerLogin.body.data.token;

    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors')).status, 401, '碳因子列表必须拒绝匿名访问。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, readerToken)).status, 403, '无因子权限用户必须被服务端拒绝。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, adminToken)).status, 200, '超级管理员必须绕过细粒度碳权限。');
    assert.strictEqual((await request(server, 'GET', '/api/templates/carbon-factors.csv')).status, 401, '碳因子模板必须拒绝匿名下载。');
    assert.strictEqual((await request(server, 'GET', '/api/templates/carbon-factors.csv', undefined, readerToken)).status, 403, '碳因子模板必须拒绝无权限用户。');
    const template = await request(server, 'GET', '/api/templates/carbon-factors.csv', undefined, adminToken);
    assert.strictEqual(template.status, 200);
    assert.strictEqual(template.headers['x-template-type'], 'carbon-factors');
    assert(template.body.toString('utf8').includes('energyTypeCode'), '碳因子模板必须使用统一字段头。');

    const created = await request(server, 'POST', '/api/carbon/factors', {
      energyTypeCode: 'electricity', region: 'default', factorYear: 2028, unit: 'kWh', factorValue: 0.5, factorUnit: 'kgCO2e', source: 'API 测试因子', status: 'active'
    }, adminToken);
    assert.strictEqual(created.status, 201);
    const factorId = created.body.data.id;
    assert.strictEqual((await request(server, 'GET', `/api/carbon/factors/${factorId}`, undefined, adminToken)).body.data.status, 'active');

    const db = openDatabase();
    try {
      const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      db.prepare(`INSERT INTO energy_records (energy_type_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, site, department, duplicate_key, record_status, created_at, updated_at) VALUES (?, '2028-01', '2028-01', 'kWh', 100, 'kWh', 100, '碳统计组织', '碳统计厂区', '碳统计部门', 'carbon-api-energy-record', 'active', datetime('now'), datetime('now'))`).run(electricityId);
    } finally { db.close(); }

    const calculated = await request(server, 'POST', '/api/carbon/emissions/calculate', { normalizedMonth: '2028-01' }, adminToken);
    assert.strictEqual(calculated.status, 201);
    assert.strictEqual(calculated.body.data.calculatedCount, 1);
    const emissions = await request(server, 'GET', '/api/carbon/emissions?normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(emissions.status, 200);
    assert.strictEqual(emissions.body.meta.pagination.total, 1);
    const emissionId = emissions.body.data[0].id;

    const stats = await request(server, 'GET', '/api/carbon/emissions/stats?normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.data.totalRecords, 1);
    assert.strictEqual(stats.body.data.calculatedCount, 1);
    assert.strictEqual(stats.body.data.byMonth[0].normalizedMonth, '2028-01');
    assert.strictEqual(stats.body.data.byEnergyType[0].energyTypeCode, 'electricity');
    assert.strictEqual(stats.body.data.byOrganization[0].organization, '碳统计组织');
    assert.strictEqual(stats.body.data.totalsByEmissionUnit[0].totalEmissionValue, 50);

    const safeKeyword = await request(server, 'GET', '/api/carbon/factors?keyword=%25', undefined, adminToken);
    assert.strictEqual(safeKeyword.status, 200);
    assert.strictEqual(safeKeyword.body.meta.pagination.total, 0, 'LIKE 通配符必须被转义，不能扩大因子查询。');
    const safeEmissionKeyword = await request(server, 'GET', '/api/carbon/emissions?keyword=%25', undefined, adminToken);
    assert.strictEqual(safeEmissionKeyword.status, 200);
    assert.strictEqual(safeEmissionKeyword.body.meta.pagination.total, 0, 'LIKE 通配符必须被转义，不能扩大排放查询。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors?factorYear=2028%3BDROP%20TABLE%20carbon_factors', undefined, adminToken)).status, 400, '年份注入输入必须被拒绝。');

    const statusChange = await request(server, 'PATCH', `/api/carbon/factors/${factorId}/status`, { status: 'inactive' }, adminToken);
    assert.strictEqual(statusChange.status, 200);
    assert.strictEqual(statusChange.body.data.status, 'inactive');
    const historyDb = openDatabase();
    try {
      const historical = historyDb.prepare('SELECT id, carbon_factor_id AS carbonFactorId, factor_value AS factorValue, emission_value AS emissionValue, status FROM carbon_emissions WHERE id = ?').get(emissionId);
      assert.strictEqual(historical.carbonFactorId, factorId, '停用因子不得断开历史排放关联。');
      assert.strictEqual(historical.factorValue, 0.5, '停用因子不得篡改历史快照因子值。');
      assert.strictEqual(historical.emissionValue, 50, '停用因子不得篡改历史排放结果。');
      assert.strictEqual(historical.status, 'calculated');
    } finally { historyDb.close(); }

    const csv = 'energyTypeCode,region,factorYear,unit,factorValue,factorUnit,source,sourceUrl,effectiveFrom,effectiveTo,status\nheat,default,2028,MJ,0.1,kgCO2e,导入测试来源,,, ,active\nheat,default,2028,MJ,0.2,kgCO2e,导入测试来源,,,,active\n';
    const previewResponse = await multipart(server, '/api/carbon/factors/import/preview', 'carbon-factors.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual(preview.writesCarbonFactors, false);
    assert.strictEqual(preview.writesCarbonEmissions, false);
    const auditPreview = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditPreview.importType, 'carbon_factor');
    assert.strictEqual(auditPreview.auditPhase, 'preview');
    assert.strictEqual(auditPreview.issueCounts.warning, 1);

    const execute = await request(server, 'POST', '/api/carbon/factors/import/execute', {
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
    assert.strictEqual(execute.body.data.writesCarbonEmissions, false);
    assert(!JSON.stringify(execute.body).includes(tmpDir), '导入执行响应不得泄露本地路径。');
    const auditExecute = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditExecute.auditPhase, 'execute');
    assert.strictEqual(auditExecute.status, 'completed_with_errors');

    const factorExport = await request(server, 'GET', '/api/carbon/factors/export?format=csv&energyTypeCode=electricity', undefined, adminToken);
    assert.strictEqual(factorExport.status, 200);
    assert(!factorExport.body.toString('utf8').includes(tmpDir), '因子导出不得泄露本地路径。');
    const emissionExport = await request(server, 'GET', '/api/carbon/emissions/export?format=csv&normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(emissionExport.status, 200);
    assert(!emissionExport.body.toString('utf8').includes(tmpDir), '排放导出不得泄露本地路径。');

    console.log('carbon accounting API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
