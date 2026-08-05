const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-import-audit-query-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'import-audit-query-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');

const { app } = require('../index');
const { getDatabaseInfo, initDatabase, openDatabase, uploadsDir } = require('../db/database');

function requestJson(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch (error) {
          json = { parseError: error.message, text: body.toString('utf8') };
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function insertBatch(db, input) {
  return db.prepare(
    `INSERT INTO import_batches (
       import_type,
       original_filename,
       stored_filename,
       file_type,
       file_size_bytes,
       file_sha256,
       status,
       audit_phase,
       preview_signature,
       preview_audit_digest,
       audit_context_json,
       execute_result_json,
       backup_json,
       total_rows,
       success_count,
       failure_count,
       skipped_count,
       duplicate_strategy,
       field_mapping_json,
       started_at,
       finished_at,
       created_at,
       updated_at,
       error_summary
     ) VALUES (
       @importType,
       @originalFilename,
       @storedFilename,
       @fileType,
       @fileSizeBytes,
       @fileSha256,
       @status,
       @auditPhase,
       @previewSignature,
       @previewAuditDigest,
       @auditContextJson,
       @executeResultJson,
       @backupJson,
       @totalRows,
       @successCount,
       @failureCount,
       @skippedCount,
       'skip',
       @fieldMappingJson,
       @startedAt,
       @finishedAt,
       @createdAt,
       @updatedAt,
       @errorSummary
     )`
  ).run({
    fileType: 'csv',
    fileSizeBytes: null,
    fileSha256: null,
    status: 'completed',
    auditPhase: 'preview',
    previewSignature: null,
    previewAuditDigest: null,
    auditContextJson: null,
    executeResultJson: null,
    backupJson: null,
    totalRows: 1,
    successCount: 1,
    failureCount: 0,
    skippedCount: 0,
    fieldMappingJson: null,
    startedAt: '2026-08-04T01:00:00.000Z',
    finishedAt: '2026-08-04T01:01:00.000Z',
    createdAt: input.createdAt || '2026-08-04T01:00:00.000Z',
    updatedAt: input.updatedAt || '2026-08-04T01:01:00.000Z',
    errorSummary: null,
    ...input
  }).lastInsertRowid;
}

function insertIssue(db, batchId, input) {
  db.prepare(
    `INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
     VALUES (@batchId, @rowNumber, @fieldName, @rawValue, @errorCode, @errorReason, @severity)`
  ).run({
    batchId,
    rowNumber: 2,
    fieldName: 'row',
    rawValue: null,
    errorCode: 'IMPORT_TEST_ISSUE',
    errorReason: '测试导入明细。',
    severity: 'error',
    ...input
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '查询/下载路由测试必须使用隔离 SQLite 文件。');
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, 'production-query.csv'), 'unit_code,normalized_month\nPU-001,2026-01\n', 'utf8');
    fs.writeFileSync(path.join(uploadsDir, 'generation-query.csv'), '用能单元编码,月份\nGEN-001,2026-01\n', 'utf8');
    fs.writeFileSync(path.join(uploadsDir, 'energy-query.csv'), 'energy_type,month\nelectricity,2026-01\n', 'utf8');

    let productionBatchId;
    let generationBatchId;
    let energyBatchId;
    let badJsonBatchId;
    let missingFileBatchId;
    let escapeFileBatchId;
    const db = openDatabase();
    try {
      productionBatchId = insertBatch(db, {
        importType: 'production_output',
        originalFilename: '月度产量 查询.csv',
        storedFilename: 'production-query.csv',
        fileSizeBytes: fs.statSync(path.join(uploadsDir, 'production-query.csv')).size,
        fileSha256: 'production-file-sha256',
        status: 'completed_with_errors',
        auditPhase: 'execute',
        previewSignature: 'hmac-sha256:v2:production-query',
        auditContextJson: JSON.stringify({ summary: { totalRows: 3, wouldImport: 1, skipped: 1, blocked: 1 }, candidateRowIds: [2] }),
        executeResultJson: JSON.stringify({ executed: true, imported: 1, skipped: 1, summary: { totalRows: 3, imported: 1 } }),
        backupJson: JSON.stringify({
          backupName: 'production-output-import.sqlite',
          reason: 'production-output-import',
          method: 'better-sqlite3-backup-api',
          sizeBytes: 8192,
          createdAt: '2026-08-04T00:59:00.000Z',
          updatedAt: '2026-08-04T00:59:01.000Z',
          sha256: 'backup-query-sha256',
          path: path.join(process.env.BACKUPS_DIR, 'production-output-import.sqlite'),
          databasePath: process.env.SQLITE_PATH,
          backupsDir: process.env.BACKUPS_DIR
        }),
        totalRows: 3,
        successCount: 1,
        failureCount: 1,
        skippedCount: 1,
        fieldMappingJson: JSON.stringify({ unitCode: '产能单元编码' }),
        errorSummary: '月度产量导入存在 1 行阻断、1 行跳过。'
      });
      insertIssue(db, productionBatchId, {
        rowNumber: 3,
        fieldName: 'unitCode+normalizedMonth',
        rawValue: 'PU-DUP|2026-01',
        errorCode: 'DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED',
        errorReason: '重复 active 月度产量按 skip 策略跳过。',
        severity: 'warning'
      });
      insertIssue(db, productionBatchId, {
        rowNumber: 4,
        fieldName: 'unitCode',
        rawValue: 'PU-MISSING',
        errorCode: 'UNKNOWN_PRODUCTION_UNIT',
        errorReason: '未知产能单元阻断导入。',
        severity: 'error'
      });

      generationBatchId = insertBatch(db, {
        importType: 'generation_record',
        originalFilename: '发电记录 查询.csv',
        storedFilename: 'generation-query.csv',
        fileSizeBytes: fs.statSync(path.join(uploadsDir, 'generation-query.csv')).size,
        fileSha256: 'generation-file-sha256',
        status: 'completed_with_errors',
        auditPhase: 'execute',
        previewSignature: 'hmac-sha256:v1:generation-query',
        previewAuditDigest: 'hmac-sha256:v1:audit:generation-query',
        auditContextJson: JSON.stringify({ previewAudit: { summary: { skipped: 1, blocked: 1 } }, nonLinkage: { writesEnergyRecords: false, writesCarbonEmissions: false } }),
        executeResultJson: JSON.stringify({ executed: true, imported: 1, skipped: 1, blocked: 1 }),
        backupJson: JSON.stringify({ backupName: 'generation-record-import.sqlite', reason: 'generation-record-import' }),
        totalRows: 3,
        successCount: 1,
        failureCount: 1,
        skippedCount: 1,
        fieldMappingJson: JSON.stringify({ organizationUnitCode: '用能单元编码' }),
        errorSummary: '发电导入存在 1 行阻断、1 行跳过。'
      });
      insertIssue(db, generationBatchId, {
        rowNumber: 3,
        fieldName: 'organizationUnitCode+normalizedMonth+energyTypeCode',
        rawValue: 'GEN-DUP|2026-01|photovoltaic',
        errorCode: 'DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED',
        errorReason: '重复 active 发电记录按 skip 策略跳过。',
        severity: 'warning'
      });
      insertIssue(db, generationBatchId, {
        rowNumber: 4,
        fieldName: 'organizationUnitCode',
        rawValue: 'GEN-MISSING',
        errorCode: 'UNKNOWN_ORGANIZATION_UNIT',
        errorReason: '未知用能单元阻断导入。',
        severity: 'error'
      });

      energyBatchId = insertBatch(db, {
        importType: 'energy_record',
        originalFilename: '能耗旧批次.csv',
        storedFilename: 'energy-query.csv',
        totalRows: 1,
        successCount: 1,
        createdAt: '2026-08-04T00:00:00.000Z'
      });
      badJsonBatchId = insertBatch(db, {
        importType: 'production_output',
        originalFilename: '坏 JSON 批次.csv',
        storedFilename: 'production-query.csv',
        status: 'completed_with_errors',
        auditContextJson: '{bad-json',
        executeResultJson: '[bad-json',
        backupJson: '{backup-bad-json',
        fieldMappingJson: '{field-bad-json',
        errorSummary: '坏 JSON 应安全返回原值。',
        createdAt: '2026-08-04T00:10:00.000Z'
      });
      missingFileBatchId = insertBatch(db, {
        importType: 'generation_record',
        originalFilename: '缺失原文件.csv',
        storedFilename: 'missing-file.csv',
        createdAt: '2026-08-04T00:20:00.000Z'
      });
      escapeFileBatchId = insertBatch(db, {
        importType: 'production_output',
        originalFilename: '越权原文件.csv',
        storedFilename: '../escape.csv',
        createdAt: '2026-08-04T00:30:00.000Z'
      });
    } finally {
      db.close();
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const productionList = await requestJson(port, 'GET', '/api/imports/batches?importType=production_output&pageSize=20');
    assert.strictEqual(productionList.statusCode, 200);
    assert(productionList.json.data.length >= 3, 'production_output 筛选应返回 production 审计批次。');
    assert(productionList.json.data.every((row) => row.importType === 'production_output'), 'production_output 筛选不得混入其他类型。');
    assert(productionList.json.data.some((row) => row.id === productionBatchId && row.importTypeLabel === '月度产量导入'));

    const generationList = await requestJson(port, 'GET', '/api/imports/batches?importType=generation_record&pageSize=20');
    assert.strictEqual(generationList.statusCode, 200);
    assert(generationList.json.data.every((row) => row.importType === 'generation_record'), 'generation_record 筛选不得混入其他类型。');
    assert(generationList.json.data.some((row) => row.id === generationBatchId && row.importTypeLabel === '发电记录导入'));

    const energyList = await requestJson(port, 'GET', '/api/imports/batches?importType=energy_record&pageSize=20');
    assert.strictEqual(energyList.statusCode, 200);
    assert.deepStrictEqual(energyList.json.data.map((row) => row.id), [energyBatchId], '旧 energy_record 类型仍应可筛选查询。');

    const detail = await requestJson(port, 'GET', `/api/imports/batches/${productionBatchId}`);
    assert.strictEqual(detail.statusCode, 200);
    assert.strictEqual(detail.json.data.id, productionBatchId);
    assert.strictEqual(detail.json.data.importTypeLabel, '月度产量导入');
    assert.deepStrictEqual(detail.json.data.auditContext.candidateRowIds, [2]);
    assert.strictEqual(detail.json.data.executeResult.imported, 1);
    assert.strictEqual(detail.json.data.backup.reason, 'production-output-import');
    assert.strictEqual(detail.json.data.backup.method, 'better-sqlite3-backup-api');
    assert.strictEqual(detail.json.data.backup.sizeBytes, 8192);
    assert.strictEqual(detail.json.data.backup.sha256, 'backup-query-sha256');
    assert.deepStrictEqual(Object.keys(detail.json.data.backup).sort(), ['backupName', 'createdAt', 'method', 'reason', 'sha256', 'sizeBytes', 'updatedAt'].sort(), '详情接口 backup 仅应返回审计白名单字段。');
    assert(!JSON.stringify(detail.json.data).includes(process.env.SQLITE_PATH), '详情接口不得暴露数据库本地路径。');
    assert(!JSON.stringify(detail.json.data).includes(process.env.BACKUPS_DIR), '详情接口不得暴露备份目录本地路径。');
    assert.deepStrictEqual(detail.json.data.issueCounts, { total: 2, error: 1, warning: 1 });
    assert.strictEqual(detail.json.data.issueSummary.length, 2);
    assert.strictEqual(detail.json.data.download.available, true);

    const badJsonDetail = await requestJson(port, 'GET', `/api/imports/batches/${badJsonBatchId}`);
    assert.strictEqual(badJsonDetail.statusCode, 200, '坏 JSON 不应导致详情接口 500。');
    assert.strictEqual(badJsonDetail.json.data.auditContext, '{bad-json');
    assert.strictEqual(badJsonDetail.json.data.executeResult, '[bad-json');
    assert.strictEqual(badJsonDetail.json.data.backup, '{backup-bad-json');
    assert.strictEqual(badJsonDetail.json.data.fieldMapping, '{field-bad-json');

    const skippedIssues = await requestJson(port, 'GET', `/api/imports/batches/${generationBatchId}/errors?status=skipped`);
    assert.strictEqual(skippedIssues.statusCode, 200);
    assert.strictEqual(skippedIssues.json.data.length, 1);
    assert.strictEqual(skippedIssues.json.data[0].severity, 'warning');
    assert.strictEqual(skippedIssues.json.data[0].errorCode, 'DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED');

    const blockedIssues = await requestJson(port, 'GET', `/api/imports/batches/${generationBatchId}/errors?status=blocked`);
    assert.strictEqual(blockedIssues.statusCode, 200);
    assert.strictEqual(blockedIssues.json.data.length, 1);
    assert.strictEqual(blockedIssues.json.data[0].severity, 'error');
    assert.strictEqual(blockedIssues.json.data[0].errorCode, 'UNKNOWN_ORGANIZATION_UNIT');

    const codeIssues = await requestJson(port, 'GET', `/api/imports/batches/${productionBatchId}/errors?severity=warning&code=DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED`);
    assert.strictEqual(codeIssues.statusCode, 200);
    assert.strictEqual(codeIssues.json.meta.pagination.total, 1);

    const download = await requestJson(port, 'GET', `/api/imports/batches/${productionBatchId}/download`);
    assert.strictEqual(download.statusCode, 200);
    assert.strictEqual(download.body.toString('utf8'), 'unit_code,normalized_month\nPU-001,2026-01\n');
    assert(download.headers['content-disposition'].includes("filename*=UTF-8''"), '下载响应应包含 UTF-8 filename*。');
    assert(download.headers['content-disposition'].includes(encodeURIComponent('月度产量 查询.csv')), '中文原文件名应安全编码到 Content-Disposition。');

    const missingDownload = await requestJson(port, 'GET', `/api/imports/batches/${missingFileBatchId}/download`);
    assert.strictEqual(missingDownload.statusCode, 404);
    assert.strictEqual(missingDownload.json.error.code, 'NOT_FOUND');
    assert.strictEqual(missingDownload.json.error.message, '导入批次原始文件不存在或已被移动。');

    const escapeDownload = await requestJson(port, 'GET', `/api/imports/batches/${escapeFileBatchId}/download`);
    assert.strictEqual(escapeDownload.statusCode, 400);
    assert.strictEqual(escapeDownload.json.error.details.code, 'INVALID_STORED_IMPORT_FILENAME');

    const deleteProduction = await requestJson(port, 'DELETE', `/api/imports/batches/${productionBatchId}`);
    assert.strictEqual(deleteProduction.statusCode, 400);
    assert.strictEqual(deleteProduction.json.error.details.code, 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');
    const deleteGeneration = await requestJson(port, 'DELETE', `/api/imports/batches/${generationBatchId}`);
    assert.strictEqual(deleteGeneration.statusCode, 400);
    assert.strictEqual(deleteGeneration.json.error.details.code, 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');

    const verifyDb = openDatabase();
    try {
      assert.strictEqual(verifyDb.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE id IN (?, ?)').get(productionBatchId, generationBatchId).total, 2, '通用删除禁用后审计批次应保留。');
      assert.deepStrictEqual(verifyDb.prepare('PRAGMA foreign_key_check').all(), [], '查询/下载隔离库 foreign_key_check 应通过。');
    } finally {
      verifyDb.close();
    }

    console.log('import audit query routes tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
