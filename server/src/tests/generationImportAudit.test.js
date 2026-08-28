const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-generation-import-audit-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-import-audit.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET = 'test-generation-record-import-audit-secret';

const { getDatabaseInfo, initDatabase, openDatabase } = require('../db/database');
const { createOrganizationUnit } = require('../services/ledgerService');
const {
  GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
  createGenerationRecord,
  createGenerationRecordImportPreviewFromUpload,
  executeGenerationRecordImport
} = require('../services/generationService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeGenerationCsv(fileName, rows) {
  const filePath = path.join(tmpDir, fileName);
  const header = '用能单元编码,用能单元名称,月份,发电量 kWh,自发自用 kWh,上网电量 kWh,数据来源,备注';
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
    confirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    previewAudit: preview.previewAudit,
    previewAuditDigest: preview.previewAuditDigest,
    acknowledgeSkippedRisks: true,
    requireBackup: true,
    ...overrides
  };
}

function executeRequiredBodyFromPreview(preview, overrides = {}) {
  return {
    batchId: preview.batchId,
    confirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    acknowledgeSkippedRisks: true,
    requireBackup: true,
    ...overrides
  };
}

function getCounts() {
  const db = openDatabase();
  try {
    return {
      generationRecords: db.prepare('SELECT COUNT(*) AS total FROM generation_records').get().total,
      energyRecords: db.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total,
      carbonEmissions: db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total
    };
  } finally {
    db.close();
  }
}

(async () => {
  try {
    initDatabase();
    assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '发电导入审计测试必须使用隔离 SQLite 文件。');

    const root = createOrganizationUnit({ unitCode: 'GEN-AUDIT-ROOT', unitName: '发电审计总厂', unitType: 'enterprise' });
    const importUnit = createOrganizationUnit({ unitCode: 'GEN-AUDIT', unitName: '发电审计单元', unitType: 'workshop', parentId: root.id });
    const duplicateUnit = createOrganizationUnit({ unitCode: 'GEN-DUP', unitName: '发电重复单元', unitType: 'workshop', parentId: root.id });
    createGenerationRecord({ organizationUnitId: duplicateUnit.id, normalizedMonth: '2026-01', generationValueKwh: 10, selfUseValueKwh: 8, gridExportValueKwh: 2 });

    const seedDb = openDatabase();
    try {
      const electricityId = seedDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity' AND is_active = 1").get().id;
      const energyRecordId = seedDb.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-01', '2026-01', 'kWh', 1, 'kWh', 1, 'generation-audit-energy-boundary', 'active', datetime('now'), datetime('now'))").run(electricityId, importUnit.id).lastInsertRowid;
      seedDb.prepare("INSERT INTO carbon_emissions (energy_record_id, calculation_method, calculation_basis, activity_value, activity_unit, emission_unit, status, calculated_at, note) VALUES (?, 'seed', 'seed', 1, 'kWh', 'kgCO2e', 'factor_missing', datetime('now'), '发电审计边界种子')").run(energyRecordId);
    } finally {
      seedDb.close();
    }

    const initialCounts = getCounts();
    const previewFilePath = writeGenerationCsv('generation-audit-preview.csv', [
      'GEN-AUDIT,发电审计单元,2026-04,100,80,20,upload,可导入',
      'GEN-DUP,发电重复单元,2026-01,20,16,4,upload,重复跳过',
      'GEN-MISSING,未知发电单元,2026-04,50,40,10,upload,未知阻断'
    ]);
    const preview = createGenerationRecordImportPreviewFromUpload(buildUpload(previewFilePath, '发电导入审计.csv'));

    assert.strictEqual(preview.dryRun, true);
    assert.strictEqual(preview.writesGenerationRecords, false, 'preview 不应写 generation_records。');
    assert.strictEqual(preview.persistsImportBatch, true);
    assert(Number.isInteger(preview.batchId), 'preview 应返回 batchId。');
    assert.strictEqual(preview.auditBatch.id, preview.batchId);
    assert.strictEqual(preview.auditBatch.importType, 'generation_record');
    assert.strictEqual(preview.auditBatch.auditPhase, 'preview');
    assert.strictEqual(preview.auditBatch.fileSha256, sha256File(previewFilePath));
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual(preview.summary.blocked, 1);
    assert.deepStrictEqual(getCounts(), initialCounts, 'preview 不得写业务表、能耗或碳排。');

    const previewBatch = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(previewBatch.originalFilename, '发电导入审计.csv');
    assert.strictEqual(previewBatch.storedFilename, 'generation-audit-preview.csv');
    assert.strictEqual(previewBatch.status, 'completed_with_errors');
    assert.strictEqual(previewBatch.previewSignature, preview.previewSignature);
    assert.strictEqual(previewBatch.previewAuditDigest, preview.previewAuditDigest);
    assert.deepStrictEqual(previewBatch.issueCounts, { total: 2, error: 1, warning: 1 });
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED' && issue.severity === 'warning'), '重复 skip warning 应写入 import_errors。');
    assert(previewBatch.issues.some((issue) => issue.errorCode === 'UNKNOWN_ORGANIZATION_UNIT' && issue.severity === 'error'), 'blocked error 应写入 import_errors。');
    assert.strictEqual(previewBatch.auditContext.previewAuditDigest, preview.previewAuditDigest);
    assert.strictEqual(previewBatch.auditContext.summary.wouldImport, 1);
    assert.deepStrictEqual(previewBatch.auditContext.candidateRowIds, [2]);
    assert.strictEqual(previewBatch.auditContext.nonLinkage.writesEnergyRecords, false);

    const executed = await executeGenerationRecordImport(executeBodyFromPreview(preview));
    assert.strictEqual(executed.executed, true);
    assert.strictEqual(executed.persistsImportBatch, true);
    assert.strictEqual(executed.batchId, preview.batchId);
    assert.strictEqual(executed.imported, 1);
    assert.strictEqual(executed.skipped, 1);
    assert.strictEqual(executed.blocked, 1);
    assert(executed.backup && executed.backup.reason === 'generation-record-import', 'execute 成功必须自动备份。');
    assert(fs.existsSync(executed.backup.path), '备份文件应写入隔离 BACKUPS_DIR。');
    assert.strictEqual(path.dirname(executed.backup.path), process.env.BACKUPS_DIR);
    assert.strictEqual(executed.meta.nonLinkage.writesEnergyRecords, false);
    assert.strictEqual(executed.meta.nonLinkage.writesCarbonEmissions, false);
    assert.strictEqual(executed.meta.nonLinkage.affectsProductionIntensity, false);

    const executedBatch = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(executedBatch.auditPhase, 'execute');
    assert.strictEqual(executedBatch.status, 'completed_with_errors');
    assert.strictEqual(executedBatch.executeResult.imported, 1);
    assert.strictEqual(executedBatch.executeResult.previewAudit.digest, preview.previewAuditDigest);
    assert.strictEqual(executedBatch.backup.reason, 'generation-record-import');

    let db = openDatabase();
    try {
      const importedRecord = db.prepare(
        `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber, generation_value_kwh AS generationValueKwh
         FROM generation_records
         WHERE organization_unit_id = ? AND normalized_month = '2026-04' AND record_status = 'active'`
      ).get(importUnit.id);
      assert(importedRecord, 'execute 应写入 wouldImport 业务记录。');
      assert.strictEqual(importedRecord.sourceBatchId, preview.batchId, '新导入业务记录应写入 source_batch_id。');
      assert.strictEqual(importedRecord.sourceRowNumber, 2, '新导入业务记录应写入 source_row_number。');
      assert.strictEqual(importedRecord.generationValueKwh, 100);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE organization_unit_id = ? AND normalized_month = '2026-01' AND record_status = 'active'").get(duplicateUnit.id).total, 1, '重复 skip 策略应保持不覆盖、不新增。');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total, initialCounts.energyRecords, 'execute 不得写 energy_records。');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total, initialCounts.carbonEmissions, 'execute 不得写 carbon_emissions。');
    } finally {
      db.close();
    }

    const persistedFallbackFilePath = writeGenerationCsv('generation-audit-persisted-fallback.csv', [
      'GEN-AUDIT,发电审计单元,2026-07,130,100,30,upload,无审计请求仍保留原预览',
      'GEN-DUP,发电重复单元,2026-01,20,16,4,upload,重复跳过需保留',
      'GEN-MISSING,未知发电单元,2026-07,50,40,10,upload,未知阻断需保留'
    ]);
    const persistedFallbackPreview = createGenerationRecordImportPreviewFromUpload(buildUpload(persistedFallbackFilePath, '无请求审计发电.csv'));
    assert.strictEqual(persistedFallbackPreview.summary.wouldImport, 1);
    assert.strictEqual(persistedFallbackPreview.summary.skipped, 1);
    assert.strictEqual(persistedFallbackPreview.summary.blocked, 1);
    const persistedFallbackBody = executeRequiredBodyFromPreview(persistedFallbackPreview);
    assert(!Object.prototype.hasOwnProperty.call(persistedFallbackBody, 'previewAudit'), '兼容请求不携带 previewAudit。');
    assert(!Object.prototype.hasOwnProperty.call(persistedFallbackBody, 'previewAuditDigest'), '兼容请求不携带 previewAuditDigest。');
    const persistedFallbackExecuted = await executeGenerationRecordImport(persistedFallbackBody);
    assert.strictEqual(persistedFallbackExecuted.executed, true);
    assert.strictEqual(persistedFallbackExecuted.imported, 1);
    assert.strictEqual(persistedFallbackExecuted.skipped, 1, '无请求 previewAudit 时 execute 应从持久批次还原 skipped 统计。');
    assert.strictEqual(persistedFallbackExecuted.blocked, 1, '无请求 previewAudit 时 execute 应从持久批次还原 blocked 统计。');
    assert.strictEqual(persistedFallbackExecuted.previewAudit.digest, persistedFallbackPreview.previewAuditDigest);
    assert.strictEqual(persistedFallbackExecuted.previewAudit.source, 'persisted-preview-audit-batch');
    assert.strictEqual(persistedFallbackExecuted.previewAudit.summary.skipped, 1);
    assert.strictEqual(persistedFallbackExecuted.previewAudit.summary.blocked, 1);
    assert(persistedFallbackExecuted.previewAudit.items.some((item) => item.status === 'skipped' && item.reasonCodes.includes('DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED')), '持久批次还原的 previewAudit 应保留 skipped 行原因。');
    assert(persistedFallbackExecuted.previewAudit.items.some((item) => item.status === 'blocked' && item.reasonCodes.includes('UNKNOWN_ORGANIZATION_UNIT')), '持久批次还原的 previewAudit 应保留 blocked 行原因。');
    const persistedFallbackBatch = getImportAuditBatchDetail(persistedFallbackPreview.batchId);
    assert.strictEqual(persistedFallbackBatch.auditPhase, 'execute');
    assert.strictEqual(persistedFallbackBatch.status, 'completed_with_errors');
    assert.strictEqual(persistedFallbackBatch.totalRows, 3);
    assert.strictEqual(persistedFallbackBatch.successCount, 1);
    assert.strictEqual(persistedFallbackBatch.failureCount, 1);
    assert.strictEqual(persistedFallbackBatch.skippedCount, 1);
    assert.strictEqual(persistedFallbackBatch.executeResult.previewAudit.digest, persistedFallbackPreview.previewAuditDigest);
    assert.strictEqual(persistedFallbackBatch.executeResult.previewAudit.source, 'persisted-preview-audit-batch');
    assert.strictEqual(persistedFallbackBatch.executeResult.previewAudit.summary.skipped, 1);
    assert.strictEqual(persistedFallbackBatch.executeResult.previewAudit.summary.blocked, 1);
    assert(persistedFallbackBatch.executeResult.previewAudit.items.some((item) => item.status === 'skipped' && item.reasonCodes.includes('DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED')));
    assert(persistedFallbackBatch.executeResult.previewAudit.items.some((item) => item.status === 'blocked' && item.reasonCodes.includes('UNKNOWN_ORGANIZATION_UNIT')));

    const requireBackupFilePath = writeGenerationCsv('generation-audit-require-backup.csv', [
      'GEN-AUDIT,发电审计单元,2026-05,110,90,20,upload,缺备份拒绝'
    ]);
    const requireBackupPreview = createGenerationRecordImportPreviewFromUpload(buildUpload(requireBackupFilePath, '缺备份发电.csv'));
    await assert.rejects(
      () => executeGenerationRecordImport(executeBodyFromPreview(requireBackupPreview, { requireBackup: false })),
      (error) => error.code === 'BAD_REQUEST' && error.details.code === 'GENERATION_RECORD_IMPORT_BACKUP_REQUIRED'
    );
    const requireBackupBatch = getImportAuditBatchDetail(requireBackupPreview.batchId);
    assert.strictEqual(requireBackupBatch.auditPhase, 'execute');
    assert.strictEqual(requireBackupBatch.status, 'failed');
    assert.strictEqual(requireBackupBatch.executeResult.executed, false);
    assert.strictEqual(requireBackupBatch.executeResult.requireBackup, false);
    db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE organization_unit_id = ? AND normalized_month = '2026-05'").get(importUnit.id).total, 0, 'requireBackup 缺失拒绝后不得写业务表。');
    } finally {
      db.close();
    }

    const mismatchFilePath = writeGenerationCsv('generation-audit-mismatch.csv', [
      'GEN-AUDIT,发电审计单元,2026-06,120,100,20,upload,候选篡改拒绝'
    ]);
    const mismatchPreview = createGenerationRecordImportPreviewFromUpload(buildUpload(mismatchFilePath, '候选篡改发电.csv'));
    await assert.rejects(
      () => executeGenerationRecordImport(executeBodyFromPreview(mismatchPreview, { candidateRowIds: [999] })),
      (error) => error.code === 'BAD_REQUEST' && error.details.code === 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_IDS_MISMATCH'
    );
    const mismatchBatch = getImportAuditBatchDetail(mismatchPreview.batchId);
    assert.strictEqual(mismatchBatch.auditPhase, 'execute');
    assert.strictEqual(mismatchBatch.status, 'failed');
    assert.strictEqual(mismatchBatch.executeResult.executed, false);
    db = openDatabase();
    try {
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE organization_unit_id = ? AND normalized_month = '2026-06'").get(importUnit.id).total, 0, '候选不一致拒绝后不得写业务表。');
      assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '隔离库外键检查应通过。');
    } finally {
      db.close();
    }

    assert(!JSON.stringify(preview).includes(process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET), 'preview 响应不得泄露 HMAC secret。');
    assert(!JSON.stringify(executed).includes(process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET), 'execute 响应不得泄露 HMAC secret。');
    console.log('generation import audit tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = 1;
});
