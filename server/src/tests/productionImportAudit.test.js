const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-production-import-audit-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'production-import-audit.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET = 'test-production-output-import-audit-secret';
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { getDatabaseInfo, initDatabase, openDatabase } = require('../db/database');
const { createOrganizationUnit } = require('../services/ledgerService');
const {
  PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT,
  createProductionOutput,
  createProductionOutputImportPreviewFromUpload,
  createProductionUnit,
  executeProductionOutputImport
} = require('../services/productionService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeProductionCsv(fileName, rows) {
  const filePath = path.join(tmpDir, fileName);
  const header = 'unit_code,unit_name,normalized_month,output_value,output_unit,data_source,remark';
  fs.writeFileSync(filePath, `﻿${[header, ...rows].join('\n')}\n`, 'utf8');
  return filePath;
}

function buildUpload(filePath, originalname) {
  return {
    path: filePath,
    originalname,
    filename: path.basename(filePath),
    size: fs.statSync(filePath).size
  };
}

function executeBodyFromPreview(preview, overrides = {}) {
  return {
    batchId: preview.batchId,
    confirmText: PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    acknowledgeSkippedRisks: true,
    requireBackup: true,
    ...overrides
  };
}

(async () => {
  try {
    initDatabase();
    assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '月度产量审计测试必须使用隔离 SQLite 文件。');

    const root = createOrganizationUnit({ unitCode: 'AUDIT-ROOT', unitName: '审计总厂', unitType: 'enterprise' });
    const workshop = createOrganizationUnit({ unitCode: 'AUDIT-WS', unitName: '审计车间', unitType: 'workshop', parentId: root.id });
    const importUnit = createProductionUnit({ unitCode: 'PU-AUDIT', unitName: '审计产线', organizationUnitId: workshop.id, productName: '产品A', outputUnit: 't' });
    const duplicateUnit = createProductionUnit({ unitCode: 'PU-DUP', unitName: '重复产线', organizationUnitId: workshop.id, productName: '产品B', outputUnit: '件' });
    createProductionOutput({ productionUnitId: duplicateUnit.id, normalizedMonth: '2026-01', outputValue: 10, outputUnit: '件' });

    const previewFilePath = writeProductionCsv('production-audit-preview.csv', [
      'PU-AUDIT,审计产线,2026-04,100,t,upload,可导入',
      'PU-DUP,重复产线,2026-01,20,件,upload,重复跳过',
      'PU-MISSING,未知产线,2026-04,50,t,upload,未知阻断'
    ]);
    const preview = createProductionOutputImportPreviewFromUpload(buildUpload(previewFilePath, '月度产量审计.csv'));

    assert.strictEqual(preview.dryRun, true);
    assert.strictEqual(preview.writesProductionOutputs, false, 'preview 不应写 production_output_records。');
    assert.strictEqual(preview.persistsImportBatch, true);
    assert(Number.isInteger(preview.batchId), 'preview 应返回 batchId。');
    assert.strictEqual(preview.auditBatch.id, preview.batchId);
    assert.strictEqual(preview.auditBatch.importType, 'production_output');
    assert.strictEqual(preview.auditBatch.auditPhase, 'preview');
    assert.strictEqual(preview.auditBatch.fileSha256, sha256File(previewFilePath));
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual(preview.summary.blocked, 1);

    let db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ? AND normalized_month = '2026-04'").get(importUnit.id).total, 0, 'preview 不写业务表。');
    } finally {
      db.close();
    }

    const previewBatch = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(previewBatch.originalFilename, '月度产量审计.csv');
    assert.strictEqual(previewBatch.storedFilename, 'production-audit-preview.csv');
    assert.strictEqual(previewBatch.status, 'completed_with_errors');
    assert.strictEqual(previewBatch.previewSignature, preview.previewSignature);
    assert.deepStrictEqual(previewBatch.issueCounts, { total: 2, error: 1, warning: 1 });
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED' && issue.severity === 'warning'), '重复 skip warning 应写入 import_errors。');
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'UNKNOWN_PRODUCTION_UNIT' && issue.severity === 'error'), 'blocked error 应写入 import_errors。');
    assert.strictEqual(previewBatch.auditContext.summary.wouldImport, 1);
    assert.deepStrictEqual(previewBatch.auditContext.candidateRowIds, [2]);

    const executed = await executeProductionOutputImport(executeBodyFromPreview(preview));
    assert.strictEqual(executed.executed, true);
    assert.strictEqual(executed.persistsImportBatch, true);
    assert.strictEqual(executed.batchId, preview.batchId);
    assert.strictEqual(executed.imported, 1);
    assert.strictEqual(executed.skipped, 2);
    assert(executed.backup && executed.backup.reason === 'production-output-import', 'execute 成功必须自动备份。');
    assert(fs.existsSync(executed.backup.path), '备份文件应写入隔离 BACKUPS_DIR。');
    assert.strictEqual(path.dirname(executed.backup.path), process.env.BACKUPS_DIR);

    const executedBatch = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(executedBatch.auditPhase, 'execute');
    assert.strictEqual(executedBatch.status, 'completed_with_errors');
    assert.strictEqual(executedBatch.executeResult.imported, 1);
    assert.strictEqual(executedBatch.backup.reason, 'production-output-import');

    db = openDatabase();
    try {
      const importedRecord = db.prepare(
        `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber, output_value AS outputValue
         FROM production_output_records
         WHERE production_unit_id = ? AND normalized_month = '2026-04' AND record_status = 'active'`
      ).get(importUnit.id);
      assert(importedRecord, 'execute 应写入 wouldImport 业务记录。');
      assert.strictEqual(importedRecord.sourceBatchId, preview.batchId, '新导入业务记录应写入 source_batch_id。');
      assert.strictEqual(importedRecord.sourceRowNumber, 2, '新导入业务记录应写入 source_row_number。');
      assert.strictEqual(importedRecord.outputValue, 100);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ? AND normalized_month = '2026-01' AND record_status = 'active'").get(duplicateUnit.id).total, 1, '重复 skip 策略应保持不覆盖、不新增。');
    } finally {
      db.close();
    }

    const requireBackupFilePath = writeProductionCsv('production-audit-require-backup.csv', [
      'PU-AUDIT,审计产线,2026-05,110,t,upload,缺备份拒绝'
    ]);
    const requireBackupPreview = createProductionOutputImportPreviewFromUpload(buildUpload(requireBackupFilePath, '缺备份产量.csv'));
    await assert.rejects(
      () => executeProductionOutputImport(executeBodyFromPreview(requireBackupPreview, { requireBackup: false })),
      (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PRODUCTION_OUTPUT_IMPORT_BACKUP_REQUIRED'
    );
    const requireBackupBatch = getImportAuditBatchDetail(requireBackupPreview.batchId);
    assert.strictEqual(requireBackupBatch.auditPhase, 'execute');
    assert.strictEqual(requireBackupBatch.status, 'failed');
    assert.strictEqual(requireBackupBatch.executeResult.executed, false);
    assert.strictEqual(requireBackupBatch.executeResult.requireBackup, false);
    db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ? AND normalized_month = '2026-05'").get(importUnit.id).total, 0, 'requireBackup 缺失拒绝后不得写业务表。');
    } finally {
      db.close();
    }

    const mismatchFilePath = writeProductionCsv('production-audit-mismatch.csv', [
      'PU-AUDIT,审计产线,2026-06,120,t,upload,候选篡改拒绝'
    ]);
    const mismatchPreview = createProductionOutputImportPreviewFromUpload(buildUpload(mismatchFilePath, '候选篡改产量.csv'));
    await assert.rejects(
      () => executeProductionOutputImport(executeBodyFromPreview(mismatchPreview, { candidateRowIds: [999] })),
      (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PRODUCTION_OUTPUT_IMPORT_CANDIDATE_ROW_IDS_MISMATCH'
    );
    const mismatchBatch = getImportAuditBatchDetail(mismatchPreview.batchId);
    assert.strictEqual(mismatchBatch.auditPhase, 'execute');
    assert.strictEqual(mismatchBatch.status, 'failed');
    assert.strictEqual(mismatchBatch.executeResult.executed, false);
    db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ? AND normalized_month = '2026-06'").get(importUnit.id).total, 0, '候选不一致拒绝后不得写业务表。');
      assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '隔离库外键检查应通过。');
    } finally {
      db.close();
    }

    assert(!JSON.stringify(preview).includes(process.env.PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET), 'preview 响应不得泄露 HMAC secret。');
    assert(!JSON.stringify(executed).includes(process.env.PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET), 'execute 响应不得泄露 HMAC secret。');
    console.log('production import audit tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = 1;
});
