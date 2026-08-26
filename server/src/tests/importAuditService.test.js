const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-import-audit-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'import-audit-service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { getDatabaseInfo, initDatabase, openDatabase } = require('../db/database');
const {
  assertAuditBatchCanUseGenericDelete,
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  isGenericDeleteAllowedForImportType,
  replaceImportAuditIssues,
  updateExecuteAuditResult
} = require('../services/importAuditService');
const { assertImportBatchCanUseGenericDelete } = require('../services/importService');

try {
  initDatabase();
  assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '审计服务测试必须使用隔离 SQLite 文件。');

  const productionPreview = createPreviewAuditBatch({
    importType: 'production_output',
    originalFilename: '月度产量导入.xlsx',
    storedFilename: 'production-audit-upload.xlsx',
    fileType: 'xlsx',
    fileSizeBytes: 128,
    fileSha256: 'sha256-production-preview',
    duplicateStrategy: 'skip',
    fieldMapping: {
      outputValue: '产量值',
      unitCode: '产能单元编码'
    },
    previewSignature: 'hmac-sha256:v2:production-preview-signature',
    auditContext: {
      confirmText: '确认导入月度产量记录',
      hmacSecret: 'must-not-be-stored',
      accessToken: 'access-token-must-not-be-stored',
      refreshToken: 'refresh-token-must-not-be-stored',
      sessionToken: 'session-token-must-not-be-stored',
      authToken: 'auth-token-must-not-be-stored',
      api_key: 'api-key-must-not-be-stored',
      privateKey: 'private-key-must-not-be-stored',
      summary: {
        totalRows: 3,
        wouldImport: 1,
        skipped: 1,
        blocked: 1,
        warnings: 1,
        errors: 1
      },
      candidateRowIds: [2]
    },
    statistics: {
      totalRows: 3,
      successCount: 1,
      failureCount: 1,
      skippedCount: 1
    },
    errorSummary: 'preview 存在 1 行阻断与 1 行跳过。'
  });

  assert.strictEqual(productionPreview.importType, 'production_output');
  assert.strictEqual(productionPreview.status, 'completed_with_errors');
  assert.strictEqual(productionPreview.auditPhase, 'preview');
  assert.deepStrictEqual(productionPreview.fieldMapping, { outputValue: '产量值', unitCode: '产能单元编码' });
  assert.strictEqual(productionPreview.auditContext.hmacSecret, '[redacted]', '审计 JSON 不应保存 HMAC secret 原值。');
  assert.strictEqual(productionPreview.auditContext.accessToken, '[redacted]', '审计 JSON 不应保存 accessToken 原值。');
  assert.strictEqual(productionPreview.auditContext.refreshToken, '[redacted]', '审计 JSON 不应保存 refreshToken 原值。');
  assert.strictEqual(productionPreview.auditContext.sessionToken, '[redacted]', '审计 JSON 不应保存 sessionToken 原值。');
  assert.strictEqual(productionPreview.auditContext.authToken, '[redacted]', '审计 JSON 不应保存 authToken 原值。');
  assert.strictEqual(productionPreview.auditContext.api_key, '[redacted]', '审计 JSON 不应保存 api_key 原值。');
  assert.strictEqual(productionPreview.auditContext.privateKey, '[redacted]', '审计 JSON 不应保存 privateKey 原值。');

  const productionWithIssues = replaceImportAuditIssues(productionPreview.id, [
    {
      rowNumber: 3,
      fieldName: 'outputValue',
      rawValue: { input: '', header: '产量值' },
      code: 'REQUIRED_FIELD_MISSING',
      message: '必填字段 outputValue 为空或未映射。',
      severity: 'error'
    },
    {
      rowNumber: 4,
      fieldName: 'unitCode+normalizedMonth',
      rawValue: 'PU-001|2026-01',
      code: 'DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED',
      message: '同一产能单元同月份已有 active 产量，按策略跳过。',
      severity: 'warning'
    }
  ]);
  assert.strictEqual(productionWithIssues.issueCounts.total, 2);
  assert.strictEqual(productionWithIssues.issueCounts.error, 1);
  assert.strictEqual(productionWithIssues.issueCounts.warning, 1);
  assert.strictEqual(productionWithIssues.issues[0].rowNumber, 3);
  assert.strictEqual(productionWithIssues.issues[0].rawValue, '{"header":"产量值","input":""}', '对象 rawValue 应稳定序列化。');

  const productionAfterReplace = replaceImportAuditIssues(productionPreview.id, [
    {
      rowNumber: 5,
      fieldName: 'outputUnit',
      rawValue: 'kg',
      code: 'OUTPUT_UNIT_MISMATCH',
      message: '导入产量单位与产能单元产量单位不一致。',
      severity: 'warning'
    }
  ]);
  assert.strictEqual(productionAfterReplace.issueCounts.total, 1, '批量写入应替换同批次既有错误/警告明细。');
  assert.strictEqual(productionAfterReplace.issueCounts.warning, 1);

  const completedAt = '2026-08-04T08:00:00.000Z';
  const productionExecuted = updateExecuteAuditResult(productionPreview.id, {
    status: 'completed_with_errors',
    statistics: {
      totalRows: 3,
      successCount: 1,
      failureCount: 0,
      skippedCount: 2
    },
    executeResult: {
      imported: 1,
      skipped: 2,
      importedItems: [{ rowNumber: 2, outputRecordId: 101 }],
      skippedItems: [{ rowNumber: 4, reason: 'duplicate' }, { rowNumber: 5, reason: 'warning' }]
    },
    backup: {
      backupName: 'production-output-import-20260804.sqlite',
      reason: 'production-output-import',
      method: 'better-sqlite3-backup-api',
      fileSizeBytes: 4096,
      fileSha256: 'backup-sha256',
      createdAt: '2026-08-04T07:59:00.000Z',
      updatedAt: '2026-08-04T07:59:01.000Z',
      path: path.join(process.env.BACKUPS_DIR, 'production-output-import-20260804.sqlite'),
      databasePath: process.env.SQLITE_PATH,
      backupsDir: process.env.BACKUPS_DIR
    },
    completedAt
  });
  assert.strictEqual(productionExecuted.auditPhase, 'execute');
  assert.strictEqual(productionExecuted.finishedAt, completedAt);
  assert.strictEqual(productionExecuted.completedAt, completedAt);
  assert.strictEqual(productionExecuted.executeResult.imported, 1);
  assert.strictEqual(productionExecuted.backup.backupName, 'production-output-import-20260804.sqlite');
  assert.strictEqual(productionExecuted.backup.method, 'better-sqlite3-backup-api');
  assert.strictEqual(productionExecuted.backup.sizeBytes, 4096);
  assert.strictEqual(productionExecuted.backup.sha256, 'backup-sha256');
  assert.strictEqual(productionExecuted.backup.createdAt, '2026-08-04T07:59:00.000Z');
  assert.strictEqual(productionExecuted.backup.updatedAt, '2026-08-04T07:59:01.000Z');
  assert(!Object.prototype.hasOwnProperty.call(productionExecuted.backup, 'path'), '审计详情 backup 不应返回备份文件本地路径。');
  assert(!Object.prototype.hasOwnProperty.call(productionExecuted.backup, 'databasePath'), '审计详情 backup 不应返回数据库本地路径。');
  assert(!Object.prototype.hasOwnProperty.call(productionExecuted.backup, 'backupsDir'), '审计详情 backup 不应返回备份目录本地路径。');

  const generationPreview = createPreviewAuditBatch({
    importType: 'generation_record',
    originalFilename: '发电导入.csv',
    storedFilename: 'generation-audit-upload.csv',
    fileType: 'csv',
    fileSizeBytes: 96,
    fileSha256: 'sha256-generation-preview',
    fieldMapping: {
      organizationUnitCode: '用能单元编码',
      normalizedMonth: '月份'
    },
    previewSignature: 'hmac-sha256:v2:generation-preview-signature',
    previewAuditDigest: 'generation-preview-audit-digest',
    auditContext: {
      previewAudit: {
        digest: 'generation-preview-audit-digest',
        blockedRows: []
      },
      summary: {
        totalRows: 2,
        wouldImport: 2,
        skipped: 0,
        blocked: 0,
        warnings: 0,
        errors: 0
      }
    },
    statistics: {
      totalRows: 2,
      successCount: 2,
      failureCount: 0,
      skippedCount: 0
    }
  });
  assert.strictEqual(generationPreview.importType, 'generation_record');
  assert.strictEqual(generationPreview.status, 'completed');
  assert.strictEqual(generationPreview.previewAuditDigest, 'generation-preview-audit-digest');

  const generationWithIssues = replaceImportAuditIssues(generationPreview.id, [
    {
      rowNumber: 2,
      fieldName: 'organizationUnitCode',
      rawValue: 'OU-001',
      code: 'GENERATION_DUPLICATE_SKIPPED',
      message: '同一用能单元同月份同能源类型已有 active 发电记录，按 skip 策略跳过。',
      severity: 'warning'
    },
    {
      rowNumber: 3,
      fieldName: 'generationValueKwh',
      rawValue: '-1',
      code: 'INVALID_GENERATION_VALUE',
      message: '发电量必须是非负数字。',
      severity: 'error'
    }
  ]);
  assert.deepStrictEqual(generationWithIssues.issueCounts, { total: 2, error: 1, warning: 1 });

  const generationSummary = getImportAuditSummary(generationPreview.id);
  assert.strictEqual(generationSummary.importType, 'generation_record');
  assert.strictEqual(generationSummary.counts.totalRows, 2);
  assert.strictEqual(generationSummary.issueCounts.total, 2);
  assert.strictEqual(generationSummary.hasBackup, false);

  assert.strictEqual(isGenericDeleteAllowedForImportType('energy_record'), true);
  assert.strictEqual(isGenericDeleteAllowedForImportType('production_output'), false);
  assert.strictEqual(isGenericDeleteAllowedForImportType('generation_record'), false);
  assert.strictEqual(isGenericDeleteAllowedForImportType('supplier'), false, '未来新增但未授权的导入类型必须默认拒绝通用删除。');
  assert.strictEqual(isGenericDeleteAllowedForImportType(''), false, '空导入类型不得回退为普通能耗。');
  assert.strictEqual(isGenericDeleteAllowedForImportType(undefined), false, '缺失导入类型不得回退为普通能耗。');
  assert.throws(
    () => assertAuditBatchCanUseGenericDelete({ id: productionPreview.id, importType: 'production_output' }),
    /默认禁止通过通用导入批次删除接口删除/,
    'production_output 默认禁止通用删除。'
  );
  assert.throws(
    () => assertImportBatchCanUseGenericDelete({ id: generationPreview.id, importType: 'generation_record' }),
    /默认禁止通过通用导入批次删除接口删除/,
    'importService 通用删除 helper 也应默认禁止 generation_record。'
  );
  assert.throws(
    () => assertAuditBatchCanUseGenericDelete({ id: 999, importType: 'supplier' }),
    /通用删除仅允许普通能耗 energy_record 批次/,
    '未来新增导入类型必须在白名单外默认拒绝。'
  );
  assert.throws(
    () => assertAuditBatchCanUseGenericDelete({ id: 1000 }),
    /通用删除仅允许普通能耗 energy_record 批次/,
    '缺失导入类型必须默认拒绝。'
  );

  const db = openDatabase();
  try {
    const energyBatchId = db.prepare(
      `INSERT INTO import_batches (
         import_type,
         original_filename,
         file_type,
         status,
         total_rows,
         success_count,
         failure_count,
         skipped_count,
         duplicate_strategy
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('energy_record', '能耗导入.xlsx', 'xlsx', 'completed', 1, 1, 0, 0, 'skip').lastInsertRowid;
    const energyBefore = db.prepare('SELECT import_type AS importType, original_filename AS originalFilename, status FROM import_batches WHERE id = ?').get(energyBatchId);
    assert.throws(
      () => createPreviewAuditBatch({
        batchId: energyBatchId,
        importType: 'production_output',
        originalFilename: '不应误改为产量.xlsx',
        storedFilename: 'should-not-overwrite.xlsx',
        fileType: 'xlsx',
        fileSizeBytes: 64,
        fileSha256: 'should-not-overwrite-sha256',
        statistics: { totalRows: 1, successCount: 1, failureCount: 0, skippedCount: 0 }
      }, { db }),
      /preview 批次类型不支持更新/,
      'energy_record 批次不能被 production_output preview 更新路径误改。'
    );
    const energyAfter = db.prepare('SELECT import_type AS importType, original_filename AS originalFilename, status FROM import_batches WHERE id = ?').get(energyBatchId);
    assert.deepStrictEqual(energyAfter, energyBefore, '非审计类型批次更新失败后原批次不应改变。');

    const productionBeforeMismatch = db.prepare('SELECT import_type AS importType, original_filename AS originalFilename, preview_signature AS previewSignature FROM import_batches WHERE id = ?').get(productionPreview.id);
    assert.throws(
      () => createPreviewAuditBatch({
        batchId: productionPreview.id,
        importType: 'generation_record',
        originalFilename: '不应误改为发电.csv',
        storedFilename: 'should-not-switch-type.csv',
        fileType: 'csv',
        fileSizeBytes: 64,
        fileSha256: 'should-not-switch-type-sha256',
        previewSignature: 'should-not-switch-type-signature',
        statistics: { totalRows: 1, successCount: 1, failureCount: 0, skippedCount: 0 }
      }, { db }),
      /preview 批次类型与本次导入类型不一致/,
      '已有 production_output 批次不能被 generation_record preview 更新路径改写类型。'
    );
    const productionAfterMismatch = db.prepare('SELECT import_type AS importType, original_filename AS originalFilename, preview_signature AS previewSignature FROM import_batches WHERE id = ?').get(productionPreview.id);
    assert.deepStrictEqual(productionAfterMismatch, productionBeforeMismatch, '审计类型不一致更新失败后原批次不应改变。');

    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '审计服务隔离库 foreign_key_check 应通过。');
    const storedContext = db.prepare('SELECT audit_context_json AS auditContextJson FROM import_batches WHERE id = ?').get(productionPreview.id).auditContextJson;
    const storedBackup = db.prepare('SELECT backup_json AS backupJson FROM import_batches WHERE id = ?').get(productionPreview.id).backupJson;
    assert(!storedBackup.includes(process.env.SQLITE_PATH), '落库 backup_json 不应包含数据库本地路径。');
    assert(!storedBackup.includes(process.env.BACKUPS_DIR), '落库 backup_json 不应包含备份目录本地路径。');
    assert(!storedBackup.includes('"path"'), '落库 backup_json 不应包含备份文件 path 字段。');
    assert(!storedBackup.includes('"databasePath"'), '落库 backup_json 不应包含 databasePath 字段。');
    assert(!storedBackup.includes('"backupsDir"'), '落库 backup_json 不应包含 backupsDir 字段。');
    assert(!storedContext.includes('must-not-be-stored'), '落库 JSON 不应包含 HMAC secret 原值。');
    assert(!storedContext.includes('access-token-must-not-be-stored'), '落库 JSON 不应包含 accessToken 原值。');
    assert(!storedContext.includes('refresh-token-must-not-be-stored'), '落库 JSON 不应包含 refreshToken 原值。');
    assert(!storedContext.includes('session-token-must-not-be-stored'), '落库 JSON 不应包含 sessionToken 原值。');
    assert(!storedContext.includes('auth-token-must-not-be-stored'), '落库 JSON 不应包含 authToken 原值。');
    assert(!storedContext.includes('api-key-must-not-be-stored'), '落库 JSON 不应包含 api_key 原值。');
    assert(!storedContext.includes('private-key-must-not-be-stored'), '落库 JSON 不应包含 privateKey 原值。');
  } finally {
    db.close();
  }

  assert(getImportAuditBatchDetail(productionPreview.id).issues.length === 1, '详情查询应返回替换后的明细。');

  console.log('import audit service tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
