const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-generation-import-preview-upload-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-import-preview-upload.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
delete process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET;
delete process.env.CHARCOAL_HMAC_SECRET;
delete process.env.APP_SECRET;

const { app } = require('../index');
const { initDatabase, openDatabase, uploadsDir } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { runWithMaintenance } = require('../services/maintenanceState');
const { login } = require('../services/authService');

function getUploadFiles() {
  if (!fs.existsSync(uploadsDir)) {
    return [];
  }
  return fs.readdirSync(uploadsDir).filter((name) => fs.statSync(path.join(uploadsDir, name)).isFile());
}

function postMultipart(port, filename, fileContent, mimeType = 'text/csv', token = null) {
  const boundary = `----charcoal-generation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const body = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const requestBody = Buffer.concat([head, body, tail]);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/generation/records/import/preview',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': requestBody.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (error) {
          json = { parseError: error.message, text };
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    req.end(requestBody);
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    const db = openDatabase();
    try {
      db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-UPLOAD', '发电上传预演单元', '发电上传预演单元', 'workshop', 'active', datetime('now'), datetime('now'))").run();
    } finally {
      db.close();
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    const validCsv = '用能单元编码,用能单元名称,月份,发电量 kWh,自发自用 kWh,上网电量 kWh,数据来源,备注\nGEN-UPLOAD,发电上传预演单元,2026-01,100,80,20,upload,成功预演\n';

    await runWithMaintenance('test-maintenance', async () => {
      const blocked = await postMultipart(port, 'generation-maintenance.csv', validCsv, 'text/csv', adminToken);
      assert.strictEqual(blocked.statusCode, 423, '维护态应在 multer 上传落盘前拒绝 generation import preview。');
      assert.strictEqual(blocked.json.error.code, 'MAINTENANCE_IN_PROGRESS');
      assert.strictEqual(getUploadFiles().length, 0, '维护态拒绝 preview 时不得留下上传文件。');
    });

    const success = await postMultipart(port, 'generation-success.csv', validCsv, 'text/csv', adminToken);
    assert.strictEqual(success.statusCode, 200, '合法 CSV preview 应成功。');
    assert.strictEqual(success.json.success, true);
    assert.strictEqual(success.json.data.summary.wouldImport, 1);
    assert.strictEqual(success.json.data.persistsImportBatch, true, 'preview 应持久化 generation_record 审计批次。');
    assert(Number.isInteger(success.json.data.batchId), 'preview 应返回 batchId。');
    assert.strictEqual(success.json.data.auditBatch.id, success.json.data.batchId);
    assert.strictEqual(success.json.data.auditBatch.importType, 'generation_record');
    assert.strictEqual(getUploadFiles().length, 1, 'preview 成功后应保留本次上传文件供审计批次追溯。');
    const previewBatch = getImportAuditBatchDetail(success.json.data.batchId);
    assert.strictEqual(previewBatch.status, 'completed');
    assert.strictEqual(previewBatch.auditPhase, 'preview');
    assert.strictEqual(previewBatch.previewSignature, success.json.data.previewSignature);
    assert.strictEqual(previewBatch.previewAuditDigest, success.json.data.previewAuditDigest);
    assert.strictEqual(previewBatch.issueCounts.total, 0);

    const invalid = await postMultipart(port, 'generation-invalid.xlsx', 'not a real xlsx file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', adminToken);
    assert.strictEqual(invalid.statusCode, 400, '解析失败的 xlsx preview 应返回 400。');
    assert.strictEqual(invalid.json.error.details.code, 'INVALID_EXCEL_FILE_SIGNATURE');
    assert.strictEqual(getUploadFiles().length, 1, 'preview 解析失败后应只保留先前成功审计文件，不保留本次失败上传文件。');

    console.log('generation import preview upload tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  throw error;
});
