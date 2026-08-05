const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-production-unit-import-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'production-unit-import-api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.PRODUCTION_UNIT_IMPORT_HMAC_SECRET = 'test-production-unit-import-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { createOrganizationUnit } = require('../services/ledgerService');
const { createProductionUnit } = require('../services/productionService');
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
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && buffer.length ? JSON.parse(buffer.toString('utf8')) : buffer });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----production-unit-${Date.now()}`;
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
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function login(server, username, password) {
  return request(server, 'POST', '/api/login', { username, password }).then((response) => response.body.data.token);
}

function executeBody(preview, overrides = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    previewSignature: preview.previewSignature,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    ...overrides
  };
}

(async () => {
  let server;
  try {
    initDatabase();
    const root = createOrganizationUnit({ unitCode: 'PU-ROOT', unitName: '产能总厂', unitType: 'enterprise' });
    const activeOrganization = createOrganizationUnit({ unitCode: 'PU-ORG', unitName: '产能车间', unitType: 'workshop', parentId: root.id });
    const inactiveOrganization = createOrganizationUnit({ unitCode: 'PU-OFF', unitName: '停用车间', unitType: 'workshop', parentId: root.id, status: 'inactive' });
    createProductionUnit({ unitCode: 'PU-EXISTS', unitName: '既有产线', organizationUnitId: activeOrganization.id, productName: '既有产品', outputUnit: 't' });
    createProductionUnit({ unitCode: 'PU-INACTIVE', unitName: '停用产线', organizationUnitId: activeOrganization.id, productName: '停用产品', outputUnit: '件', status: 'inactive' });
    register({ username: 'production-unit-reader', password: 'Password123!' });

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const adminToken = await login(server, 'admin', 'AdminPassword123!');
    const ordinaryToken = await login(server, 'production-unit-reader', 'Password123!');

    for (const pathname of ['/api/templates/production-units.csv', '/api/production/units/export?format=csv']) {
      const anonymous = await request(server, 'GET', pathname);
      assert.strictEqual(anonymous.status, 401, `${pathname} 必须拒绝匿名请求。`);
      const forbidden = await request(server, 'GET', pathname, undefined, ordinaryToken);
      assert.strictEqual(forbidden.status, 403, `${pathname} 必须拒绝无权限账号。`);
      const allowed = await request(server, 'GET', pathname, undefined, adminToken);
      assert.strictEqual(allowed.status, 200, `${pathname} 必须允许超级管理员访问。`);
    }

    const template = await request(server, 'GET', '/api/templates/production-units.csv', undefined, adminToken);
    assert.strictEqual(template.headers['x-template-type'], 'production-units');
    assert(template.body.toString('utf8').includes('organizationUnitCode'), '产能单元模板必须包含组织映射字段。');

    const exportActive = await request(server, 'GET', `/api/production/units/export?format=csv&status=active&keyword=${encodeURIComponent('既有')}`, undefined, adminToken);
    const exportText = exportActive.body.toString('utf8');
    assert(exportText.includes('unitCode'), '产能单元导出必须使用模板契约字段。');
    assert(exportText.includes('PU-EXISTS'), '导出必须应用 keyword/status 筛选。');
    assert(!exportText.includes('PU-INACTIVE'), '导出不得包含不满足当前筛选的停用产能单元。');
    assert(String(exportActive.headers['content-disposition']).includes('filename*=UTF-8'), '导出必须提供中文文件名编码。');
    assert(!exportText.includes(process.env.SQLITE_PATH), '导出内容不得泄露本地数据库路径。');
    const exportXlsx = await request(server, 'GET', '/api/production/units/export?format=xlsx&status=active', undefined, adminToken);
    assert.strictEqual(exportXlsx.status, 200);
    assert(String(exportXlsx.headers['content-type']).includes('spreadsheetml.sheet'));
    const exportWorkbook = XLSX.read(exportXlsx.body, { type: 'buffer' });
    assert.strictEqual(exportWorkbook.SheetNames[0], '产能单元');
    assert(XLSX.utils.sheet_to_json(exportWorkbook.Sheets['产能单元']).some((row) => row.unitCode === 'PU-EXISTS'));

    const csv = [
      'unitCode,unitName,organizationUnitCode,productName,outputUnit,remark,status',
      'PU-NEW,新建产线,PU-ORG,产品A,t,可导入,active',
      'PU-EXISTS,既有产线,PU-ORG,既有产品,t,重复跳过,active',
      'PU-BAD,无效组织产线,UNKNOWN-ORG,产品B,件,组织不存在,active',
      'PU-OFF-ORG,停用组织产线,PU-OFF,产品C,t,组织停用,active'
    ].join('\n');
    const anonymousPreview = await multipart(server, '/api/production/units/import/preview', 'production-units.csv', csv);
    assert.strictEqual(anonymousPreview.status, 401, '导入 preview 必须拒绝匿名请求。');
    const forbiddenPreview = await multipart(server, '/api/production/units/import/preview', 'production-units.csv', csv, ordinaryToken);
    assert.strictEqual(forbiddenPreview.status, 403, '导入 preview 必须拒绝无导入权限账号。');

    const previewResponse = await multipart(server, '/api/production/units/import/preview', '产能单元导入.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.writesProductionUnits, false);
    assert.strictEqual(preview.persistsImportBatch, true);
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual(preview.summary.blocked, 2);
    assert(Number.isInteger(preview.batchId));
    let db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_units WHERE unit_code = 'PU-NEW'").get().total, 0, 'preview 不得写入 production_units。');
    } finally {
      db.close();
    }
    const previewBatch = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(previewBatch.importType, 'production_unit');
    assert.strictEqual(previewBatch.auditPhase, 'preview');
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'DUPLICATE_PRODUCTION_UNIT_CODE_SKIPPED' && issue.severity === 'warning'));
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'UNKNOWN_ORGANIZATION_UNIT'));
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'INACTIVE_ORGANIZATION_UNIT'));

    const confirmationRejected = await request(server, 'POST', '/api/production/units/import/execute', executeBody(preview, { confirmText: '错误确认文本' }), adminToken);
    assert.strictEqual(confirmationRejected.status, 400, '错误确认文本必须拒绝执行。');
    assert.strictEqual(confirmationRejected.body.error.details.code, 'PRODUCTION_UNIT_IMPORT_CONFIRM_TEXT_MISMATCH');

    const goodPreviewResponse = await multipart(server, '/api/production/units/import/preview', '产能单元执行.csv', csv, adminToken);
    const goodPreview = goodPreviewResponse.body.data;
    const signatureRejected = await request(server, 'POST', '/api/production/units/import/execute', executeBody(goodPreview, {
      candidateRows: goodPreview.candidateRows.map((row, index) => (index === 0 ? { ...row, unitName: '篡改名称' } : row))
    }), adminToken);
    assert.strictEqual(signatureRejected.status, 400, '篡改 HMAC 签名覆盖的候选行必须拒绝执行。');
    assert.strictEqual(signatureRejected.body.error.details.code, 'PRODUCTION_UNIT_IMPORT_PREVIEW_SIGNATURE_MISMATCH');

    const executePreviewResponse = await multipart(server, '/api/production/units/import/preview', '产能单元确认执行.csv', csv, adminToken);
    const executePreview = executePreviewResponse.body.data;
    const executed = await request(server, 'POST', '/api/production/units/import/execute', executeBody(executePreview), adminToken);
    assert.strictEqual(executed.status, 200);
    assert.strictEqual(executed.body.data.imported, 1);
    assert.strictEqual(executed.body.data.skipped, 3);
    assert(executed.body.data.backup && executed.body.data.backup.backupName, 'execute 必须创建备份。');

    const executedBatch = getImportAuditBatchDetail(executePreview.batchId);
    assert.strictEqual(executedBatch.auditPhase, 'execute');
    assert.strictEqual(executedBatch.status, 'completed_with_errors');
    db = openDatabase();
    try {
      const imported = db.prepare("SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber, organization_unit_id AS organizationUnitId, status FROM production_units WHERE unit_code = 'PU-NEW'").get();
      assert.strictEqual(imported.sourceBatchId, executePreview.batchId, '导入单位必须保存 source_batch_id。');
      assert.strictEqual(imported.sourceRowNumber, 2, '导入单位必须保存 source_row_number。');
      assert.strictEqual(imported.organizationUnitId, activeOrganization.id, '必须按 active 用能单元编码关联。');
      assert.strictEqual(imported.status, 'active');
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_units WHERE unit_code IN ('PU-BAD', 'PU-OFF-ORG')").get().total, 0, '无效用能单元不得自动创建或静默挂接。');
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_units WHERE unit_code = 'PU-EXISTS'").get().total, 1, '重复 active 编码必须保持 skip，不覆盖、不新增。');
      assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '隔离库外键检查必须通过。');
    } finally {
      db.close();
    }

    console.log('production unit import API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
