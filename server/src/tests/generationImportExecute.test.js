const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-generation-import-execute-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-import-execute.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');

const { initDatabase, openDatabase } = require('../db/database');
const backupService = require('../services/backupService');
const {
  GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
  buildGenerationRecordImportPreviewFromRows,
  executeGenerationRecordImport
} = require('../services/generationService');

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

function getBackupFileCount() {
  if (!fs.existsSync(process.env.BACKUPS_DIR)) return 0;
  return fs.readdirSync(process.env.BACKUPS_DIR).filter((name) => /\.(sqlite|db)$/i.test(name)).length;
}

function assertBadRequestCode(promise, expectedCode) {
  return assert.rejects(
    promise,
    (error) => error && error.code === 'BAD_REQUEST' && error.details && error.details.code === expectedCode
  );
}

function makeRows(unitCode, unitName, month, suffix = '') {
  return [{
    '用能单元编码': unitCode,
    '用能单元名称': unitName,
    '月份': month,
    '发电量 kWh': '100',
    '自发自用 kWh': '80',
    '上网电量 kWh': '20',
    '数据来源': 'upload',
    '备注': `execute ${suffix || month}`
  }];
}

function buildExecuteBody(preview, overrides = {}) {
  return {
    confirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
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
  try {
    initDatabase();
    const db = openDatabase();
    let unitId;
    let photovoltaicId;
    let electricityId;
    try {
      unitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-EXEC', '发电执行单元', '发电执行单元', 'workshop', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
      photovoltaicId = db.prepare("SELECT id FROM energy_types WHERE code = 'photovoltaic' AND is_active = 1").get().id;
      electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity' AND is_active = 1").get().id;
      db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-01', '2026-01', 'kWh', 1, 'kWh', 1, '发电执行单元', 'generation-execute-energy-boundary', 'active', datetime('now'), datetime('now'))").run(electricityId, unitId);
      db.prepare("INSERT INTO carbon_emissions (energy_record_id, calculation_method, calculation_basis, activity_value, activity_unit, emission_unit, status, calculated_at, note) VALUES ((SELECT id FROM energy_records WHERE duplicate_key = 'generation-execute-energy-boundary'), 'seed', 'seed', 1, 'kWh', 'kgCO2e', 'factor_missing', datetime('now'), 'execute 边界种子')").run();
    } finally {
      db.close();
    }

    const initialCounts = getCounts();
    const successPreview = buildGenerationRecordImportPreviewFromRows(makeRows('GEN-EXEC', '发电执行单元', '2026-01', 'success'));
    assert.strictEqual(successPreview.summary.wouldImport, 1, '成功用例 preview 应产生 1 条候选。');
    const backupsBeforeSuccess = getBackupFileCount();
    const success = await executeGenerationRecordImport(buildExecuteBody(successPreview));
    assert.strictEqual(success.executed, true);
    assert.strictEqual(success.writesGenerationRecords, true);
    assert.strictEqual(success.persistsImportBatch, false);
    assert.strictEqual(success.imported, 1);
    assert.strictEqual(success.skipped, 0);
    assert.strictEqual(success.importedRecords.length, 1);
    assert.strictEqual(success.importedRecords[0].organizationUnitId, unitId);
    assert.strictEqual(success.importedRecords[0].organizationUnitCode, 'GEN-EXEC');
    assert.strictEqual(success.importedRecords[0].organizationUnitName, '发电执行单元');
    assert.strictEqual(success.importedRecords[0].organizationUnitPath, '发电执行单元');
    assert.strictEqual(success.importedRecords[0].energyTypeCode, 'photovoltaic');
    assert.strictEqual(success.importedRecords[0].normalizedMonth, '2026-01');
    assert.strictEqual(success.importedRecords[0].recordStatus, 'active');
    assert.strictEqual(success.importedRecords[0].dataSource, 'upload');
    assert.strictEqual(success.importedItems[0].organizationUnitCode, 'GEN-EXEC', 'execute 成功行级审计应展示用能单元编码。');
    assert.strictEqual(success.importedItems[0].organizationUnitName, '发电执行单元', 'execute 成功行级审计应展示用能单元名称。');
    assert.strictEqual(success.importedItems[0].organizationUnitPath, '发电执行单元', 'execute 成功行级审计应展示用能单元路径。');
    assert(success.backup && success.backup.backupName, 'execute 成功前应自动创建备份。');
    assert.strictEqual(success.backup.reason, 'generation-record-import', 'execute 自动备份应保留发电导入审计 reason。');
    assert.strictEqual(success.backup.requestedReason, 'generation-record-import', 'execute 返回应保留请求的发电导入备份 reason。');
    assert(success.backup.backupName.includes('generation-record-import'), 'execute 自动备份文件名应包含发电导入 reason。');
    assert.strictEqual(getBackupFileCount(), backupsBeforeSuccess + 1, 'execute 成功应新增一个 SQLite 备份文件。');
    assert.strictEqual(success.meta.nonLinkage.writesEnergyRecords, false);
    assert.strictEqual(success.meta.nonLinkage.writesCarbonEmissions, false);
    assert.strictEqual(success.meta.nonLinkage.affectsProductionIntensity, false);
    const afterSuccessCounts = getCounts();
    assert.strictEqual(afterSuccessCounts.generationRecords, initialCounts.generationRecords + 1, 'execute 只应新增 generation_records。');
    assert.strictEqual(afterSuccessCounts.energyRecords, initialCounts.energyRecords, 'execute 不得写入 energy_records。');
    assert.strictEqual(afterSuccessCounts.carbonEmissions, initialCounts.carbonEmissions, 'execute 不得写入 carbon_emissions。');

    const auditPreview = buildGenerationRecordImportPreviewFromRows([
      ...makeRows('GEN-EXEC', '发电执行单元', '2026-02', 'audit-import'),
      ...makeRows('GEN-EXEC', '发电执行单元', '2026-01', 'audit-skipped'),
      { '用能单元名称': '发电执行单元', '月份': '2026-07', '发电量 kWh': '50', '自发自用 kWh': '40', '上网电量 kWh': '10', '备注': '缺编码阻断审计' }
    ]);
    assert.strictEqual(auditPreview.summary.wouldImport, 1, '审计用例应保留 1 条可导入候选。');
    assert.strictEqual(auditPreview.summary.skipped, 1, '审计用例应包含原始 skipped 风险。');
    assert.strictEqual(auditPreview.summary.blocked, 1, '审计用例应包含原始 blocked 风险。');
    const auditSuccess = await executeGenerationRecordImport(buildExecuteBody(auditPreview, {
      previewAudit: auditPreview.previewAudit,
      previewAuditDigest: auditPreview.previewAuditDigest
    }));
    assert.strictEqual(auditSuccess.imported, 1);
    assert(auditSuccess.previewAudit, 'execute 成功结果应保留 previewAudit 审计快照。');
    assert.strictEqual(auditSuccess.previewAudit.digest, auditPreview.previewAuditDigest, 'execute 应保留原始 previewAuditDigest。');
    assert.strictEqual(auditSuccess.previewAudit.summary.skipped, 1, 'execute 审计应反映用户确认过的原始 skipped 行。');
    assert.strictEqual(auditSuccess.previewAudit.summary.blocked, 1, 'execute 审计应反映用户确认过的原始 blocked 行。');
    assert(auditSuccess.previewAudit.items.some((item) => item.status === 'skipped' && item.reasonCodes.includes('DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED')), 'execute 审计应保留原始 skipped 行原因。');
    assert(auditSuccess.previewAudit.items.some((item) => item.status === 'blocked' && item.reasonCodes.includes('REQUIRED_FIELD_MISSING')), 'execute 审计应保留原始 blocked 行原因。');
    const afterAuditSuccessCounts = getCounts();
    assert.strictEqual(afterAuditSuccessCounts.generationRecords, afterSuccessCounts.generationRecords + 1, '审计快照不得授权 skipped/blocked 行写入。');
    assert.strictEqual(afterAuditSuccessCounts.energyRecords, afterSuccessCounts.energyRecords);
    assert.strictEqual(afterAuditSuccessCounts.carbonEmissions, afterSuccessCounts.carbonEmissions);

    const validationPreview = buildGenerationRecordImportPreviewFromRows(makeRows('GEN-EXEC', '发电执行单元', '2026-08', 'validation'));
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { confirmText: '错误确认文本' })), 'GENERATION_RECORD_IMPORT_CONFIRM_TEXT_MISMATCH');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { previewSignature: `${validationPreview.previewSignature}-bad` })), 'GENERATION_RECORD_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { expectedWouldImport: validationPreview.summary.wouldImport + 1 })), 'GENERATION_RECORD_IMPORT_EXPECTED_COUNT_MISMATCH');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { candidateRowIds: [999] })), 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_IDS_MISMATCH');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { requireBackup: false })), 'GENERATION_RECORD_IMPORT_BACKUP_REQUIRED');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { acknowledgeSkippedRisks: false })), 'GENERATION_RECORD_IMPORT_SKIPPED_RISKS_ACK_REQUIRED');
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(validationPreview, { candidateRows: [{ ...validationPreview.candidateRows[0], status: 'skipped', wouldImport: false }] })), 'GENERATION_RECORD_IMPORT_CANDIDATE_STATUS_INVALID');
    assert.deepStrictEqual(getCounts(), afterAuditSuccessCounts, '参数校验失败不得写入任何业务表。');

    const stalePreview = buildGenerationRecordImportPreviewFromRows(makeRows('GEN-EXEC', '发电执行单元', '2026-03', 'stale'));
    const staleDb = openDatabase();
    try {
      staleDb.prepare("INSERT INTO generation_records (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, '2026-03', 1, 1, 0, 'manual', 'active', '并发写入', datetime('now'), datetime('now'))").run(unitId, photovoltaicId);
    } finally {
      staleDb.close();
    }
    await assertBadRequestCode(executeGenerationRecordImport(buildExecuteBody(stalePreview)), 'GENERATION_RECORD_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
    const afterStaleCounts = getCounts();
    assert.strictEqual(afterStaleCounts.generationRecords, afterAuditSuccessCounts.generationRecords + 1, '过期 preview 拒绝时只应保留测试并发种子，不得额外导入。');
    assert.strictEqual(afterStaleCounts.energyRecords, afterAuditSuccessCounts.energyRecords);
    assert.strictEqual(afterStaleCounts.carbonEmissions, afterAuditSuccessCounts.carbonEmissions);

    const backupFailurePreview = buildGenerationRecordImportPreviewFromRows(makeRows('GEN-EXEC', '发电执行单元', '2026-04', 'backup-failure'));
    const originalCreateBackup = backupService.createBackup;
    backupService.createBackup = async () => {
      throw new Error('模拟备份失败');
    };
    try {
      await assert.rejects(executeGenerationRecordImport(buildExecuteBody(backupFailurePreview)), /模拟备份失败/);
    } finally {
      backupService.createBackup = originalCreateBackup;
    }
    const afterBackupFailureCounts = getCounts();
    assert.strictEqual(afterBackupFailureCounts.generationRecords, afterStaleCounts.generationRecords, '备份失败不得写入 generation_records。');
    assert.strictEqual(afterBackupFailureCounts.energyRecords, afterStaleCounts.energyRecords);
    assert.strictEqual(afterBackupFailureCounts.carbonEmissions, afterStaleCounts.carbonEmissions);

    const transactionPreview = buildGenerationRecordImportPreviewFromRows([
      ...makeRows('GEN-EXEC', '发电执行单元', '2026-05', 'transaction-1'),
      ...makeRows('GEN-EXEC', '发电执行单元', '2026-06', 'transaction-2')
    ]);
    assert.strictEqual(transactionPreview.summary.wouldImport, 2, '事务用例应有两条候选。');
    const triggerDb = openDatabase();
    try {
      triggerDb.exec("CREATE TRIGGER generation_import_execute_fail_second BEFORE INSERT ON generation_records WHEN NEW.normalized_month = '2026-06' BEGIN SELECT RAISE(FAIL, '模拟第二条写入失败'); END");
    } finally {
      triggerDb.close();
    }
    await assert.rejects(executeGenerationRecordImport(buildExecuteBody(transactionPreview)), /模拟第二条写入失败/);
    const afterTransactionFailureDb = openDatabase();
    try {
      assert.strictEqual(afterTransactionFailureDb.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE normalized_month IN ('2026-05', '2026-06')").get().total, 0, 'execute 事务失败不得产生半写入。');
      afterTransactionFailureDb.exec('DROP TRIGGER generation_import_execute_fail_second');
    } finally {
      afterTransactionFailureDb.close();
    }
    const afterTransactionFailureCounts = getCounts();
    assert.strictEqual(afterTransactionFailureCounts.generationRecords, afterBackupFailureCounts.generationRecords, 'execute 事务失败不得新增 generation_records。');
    assert.strictEqual(afterTransactionFailureCounts.energyRecords, afterBackupFailureCounts.energyRecords);
    assert.strictEqual(afterTransactionFailureCounts.carbonEmissions, afterBackupFailureCounts.carbonEmissions);

    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'generation.js'), 'utf8');
    assert(routeSource.includes("router.post('/records/import/preview'"), 'preview 路由应保留。');
    assert(routeSource.includes("router.post('/records/import/execute', authenticate, requirePermission('ledger:generation:execute'), requireWritable('generation:records-import-execute')"), 'execute 路由应存在且挂维护态写保护。');
    assert(routeSource.includes('executeGenerationRecordImport'), 'execute 路由应调用受控导入服务。');

    console.log('generation import execute tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  throw error;
});
