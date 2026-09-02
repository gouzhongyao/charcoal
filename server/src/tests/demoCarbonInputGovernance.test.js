'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 碳输入治理测试只使用系统临时目录、隔离 SQLite、隔离上传和隔离备份目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-carbon-input-'));
const temporaryDataDir = path.join(temporaryRoot, 'data');
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
const temporaryDatabasePath = path.join(temporaryDataDir, 'demo-carbon-input.sqlite');
process.env.DATA_DIR = temporaryDataDir;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoCarbonInput123!';
process.env.CHARCOAL_HMAC_SECRET = 'demo-carbon-input-shared-secret-2026';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'demo-carbon-input-analysis-secret-2026';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const {
  CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
  CARBON_FACTOR_IMPORT_HEADERS,
  createCarbonFactorImportPreviewFromUpload,
  executeCarbonFactorImport
} = require('../services/carbonAccountingService');
const {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  executeCarbonActivityImport,
  previewCarbonActivityImport
} = require('../services/carbonActivityImportService');
const {
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_WORKSHEET_NAME
} = require('../services/carbonActivityContracts');
const { getDemoArtifactRegistration } = require('../services/demoArtifactRegistry');
const { createDemoContext, sha256Buffer } = require('../services/demoContextService');
const {
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_SNAPSHOT_PROJECTION_VERSION,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest
} = require('../services/demoOwnershipService');
const { requireDemoPostAction } = require('../services/demoPostActionRegistry');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');

// 两类 managed artifact 使用固定服务端注册身份，测试不得由请求动态指定 handler 或 ownership 类型。
const FACTOR_ARTIFACT_KEY = '11-carbon-factors';
const ACTIVITY_ARTIFACT_KEY = '27-carbon-activities';
// 隔离组织和能源类型由测试初始化后固定使用。
const TEST_ORGANIZATION_CODE = 'DEMO-CARBON-OU';
let actor = null;
let demoRun = null;
let energyType = null;

/** 将碳因子业务行生成固定中文表头 XLSX。 */
function buildFactorWorkbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([CARBON_FACTOR_IMPORT_HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, '碳因子模板');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 构造一条可导入碳因子业务行。 */
function buildFactorRow(source, overrides = {}) {
  const row = {
    energyTypeCode: energyType.code,
    region: 'demo-governance',
    factorYear: 2026,
    unit: energyType.standardUnit,
    factorValue: 0.456,
    factorUnit: 'kgCO2e',
    source,
    sourceUrl: 'https://example.com/demo-factor',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    status: 'active',
    ...overrides
  };
  return [
    row.energyTypeCode,
    row.region,
    row.factorYear,
    row.unit,
    row.factorValue,
    row.factorUnit,
    row.source,
    row.sourceUrl,
    row.effectiveFrom,
    row.effectiveTo,
    row.status
  ];
}

/** 将独立碳活动业务行生成固定单工作表 XLSX。 */
function buildActivityWorkbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([CARBON_ACTIVITY_IMPORT_HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, CARBON_ACTIVITY_WORKSHEET_NAME);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 构造一条独立碳活动业务行。 */
function buildActivityRow(activityCode, overrides = {}) {
  const row = {
    supersedesActivityCode: '',
    emissionScope: '范围二',
    activityCategory: '购入电力',
    organizationUnitCode: TEST_ORGANIZATION_CODE,
    energyTypeCode: energyType.code,
    startWallClock: '2026-09-01T09:00',
    endWallClock: '2026-09-01T10:00',
    sourceTimezone: 'Asia/Shanghai',
    activityValue: '100',
    activityUnit: energyType.standardUnit,
    factorRegion: 'demo-governance',
    sourceReference: `source-${activityCode}`,
    evidenceReference: `evidence-${activityCode}`,
    note: 'managed 碳输入治理测试',
    ...overrides
  };
  return [
    activityCode,
    row.supersedesActivityCode,
    row.emissionScope,
    row.activityCategory,
    row.organizationUnitCode,
    row.energyTypeCode,
    row.startWallClock,
    row.endWallClock,
    row.sourceTimezone,
    row.activityValue,
    row.activityUnit,
    row.factorRegion,
    row.sourceReference,
    row.evidenceReference,
    row.note
  ];
}

/** 把测试 Buffer 保存为 retained upload，并返回 Multer 风格文件对象。 */
function storeUpload(filename, buffer) {
  const filePath = path.join(temporaryUploadsDir, filename);
  fs.writeFileSync(filePath, buffer);
  return {
    originalname: filename,
    filename,
    size: buffer.length,
    path: filePath
  };
}

/** 为指定 artifact 文件字节创建当前 run 的中央 managed context。 */
function createManagedContext(db, artifactKey, buffer) {
  const registration = getDemoArtifactRegistration(artifactKey);
  assert(registration, `缺少 artifact 注册：${artifactKey}`);
  return createDemoContext({
    db,
    userId: actor.userId,
    runId: demoRun.runId,
    artifactKey,
    handlerKey: registration.handlerKey,
    artifactFileSha256: sha256Buffer(buffer)
  });
}

/** 将 context 投影为领域服务允许接收的固定字段。 */
function projectManagedContext(context, overrides = {}) {
  return {
    token: context.token,
    userId: actor.userId,
    artifactKey: context.artifactKey,
    handlerKey: context.handlerKey,
    ...overrides
  };
}

/** 返回不访问真实备份目录的确定性备份测试替身。 */
async function createIsolatedBackup(input = {}) {
  return {
    backupName: 'demo-carbon-input-backup.sqlite',
    reason: input.reason || null,
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    method: 'test-double',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z'
  };
}

/** 构造 managed 碳因子最小 execute 请求。 */
function buildManagedFactorExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 构造无 context 碳因子正式 execute 见证。 */
function buildFormalFactorExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    previewAudit: preview.previewAudit,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 构造独立碳活动最小 execute 请求。 */
function buildActivityExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 返回 managed 碳因子服务固定依赖选项。 */
function buildManagedFactorOptions(db, context, overrides = {}) {
  return {
    db,
    uploadsDir: temporaryUploadsDir,
    actor,
    demoContext: projectManagedContext(context),
    createBackup: createIsolatedBackup,
    ...overrides
  };
}

/** 返回独立碳活动服务固定依赖选项。 */
function buildActivityOptions(db, context = null, overrides = {}) {
  return {
    db,
    uploadsDir: temporaryUploadsDir,
    env: { ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET },
    actor,
    createBackup: createIsolatedBackup,
    ...(context ? { demoContext: projectManagedContext(context) } : {}),
    ...overrides
  };
}

/** 读取固定表行数，表名只允许测试内部常量调用。 */
function countRows(db, tableName, whereSql = '', params = []) {
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName} ${whereSql}`).get(...params).total);
}

/** 读取 context、批次、ownership 和业务表的稳定计数快照。 */
function snapshotManagedState(db, contextId, batchId) {
  return {
    context: db.prepare('SELECT * FROM demo_import_contexts WHERE context_id = ?').get(contextId),
    batch: db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId),
    links: db.prepare('SELECT * FROM demo_run_import_batches WHERE context_id = ? ORDER BY id').all(contextId),
    registry: db.prepare('SELECT * FROM demo_data_registry WHERE run_id = ? ORDER BY registry_id').all(demoRun.runId),
    factors: db.prepare('SELECT * FROM carbon_factors ORDER BY id').all(),
    activities: db.prepare('SELECT * FROM carbon_activity_records ORDER BY id').all(),
    operationLogs: db.prepare(`SELECT * FROM sys_operation_logs
      WHERE operation IN ('carbon.activity.import.preview', 'carbon.activity.import.execute')
      ORDER BY id`).all()
  };
}

/** 断言异步操作返回稳定错误码，并可选校验统一包装保留的安全原因码。 */
async function assertAsyncError(action, expectedCode, expectedCauseCode = null) {
  await assert.rejects(async () => action(), (error) => {
    assert.strictEqual(error?.details?.code || error?.code, expectedCode);
    if (expectedCauseCode) {
      assert.strictEqual(error?.details?.causeCode, expectedCauseCode);
    }
    return true;
  });
}

/** 断言 context 与导入批次仍停留在可重试 preview 状态。 */
function assertPreviewStatePreserved(db, contextId, batchId) {
  const context = db.prepare('SELECT status, executed_at AS executedAt FROM demo_import_contexts WHERE context_id = ?')
    .get(contextId);
  const batch = db.prepare(`SELECT status, audit_phase AS auditPhase, execute_result_json AS executeResultJson,
      backup_json AS backupJson FROM import_batches WHERE id = ?`).get(batchId);
  assert.strictEqual(context.status, 'previewed');
  assert.strictEqual(context.executedAt, null);
  assert(['completed', 'completed_with_errors'].includes(batch.status));
  assert.strictEqual(batch.auditPhase, 'preview');
  assert.strictEqual(batch.executeResultJson, null);
  assert.strictEqual(batch.backupJson, null);
}

/** 验证 imported ownership 的固定 identity、projection version 和 snapshot digest。 */
function assertOwnershipDigest(db, entityType, entityPk) {
  const registry = db.prepare(`SELECT identity_digest AS identityDigest, snapshot_digest AS snapshotDigest
    FROM demo_data_registry WHERE run_id = ? AND entity_type = ? AND entity_pk = ?`).get(
    demoRun.runId,
    entityType,
    String(entityPk)
  );
  assert(registry, `${entityType}:${entityPk} 必须登记 ownership。`);
  assert.strictEqual(registry.identityDigest, calculateDemoEntityIdentityDigest(entityType, String(entityPk)));
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType];
  assert.strictEqual(handler.projectionVersion, DEMO_OWNERSHIP_SNAPSHOT_PROJECTION_VERSION);
  const projection = handler.readProjection(db, Number(entityPk));
  assert.strictEqual(
    registry.snapshotDigest,
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection)
  );
}

/** 验证 artifact 11 成功、preview 无 ownership、批次绑定和终态只读回放。 */
async function testManagedFactorSuccessAndReplay(db) {
  const buffer = buildFactorWorkbookBuffer([
    buildFactorRow('DEMO-MANAGED-FACTOR-A', {
      factorValue: 0.401,
      factorUnit: 'kg CO₂e / (kWh)',
      sourceUrl: 'https://example.com/demo-factor-a',
      effectiveFrom: '2026-02-01',
      effectiveTo: '2026-11-30'
    }),
    buildFactorRow('DEMO-MANAGED-FACTOR-B', {
      factorYear: '',
      factorValue: 0.402,
      sourceUrl: '',
      effectiveFrom: '',
      effectiveTo: ''
    })
  ]);
  const file = storeUpload('managed-factor-success.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const options = buildManagedFactorOptions(db, context);
  const registryBeforePreview = countRows(db, 'demo_data_registry');
  const factorsBeforePreview = countRows(db, 'carbon_factors');
  const preview = createCarbonFactorImportPreviewFromUpload(file, options);
  assert.strictEqual(preview.summary.wouldImport, 2);
  assert.deepStrictEqual(preview.candidateRows.map((row) => row.factorUnit), ['kgCO2e/kWh', 'kgCO2e']);
  assert.deepStrictEqual({
    factorYear: preview.candidateRows[1].factorYear,
    sourceUrl: preview.candidateRows[1].sourceUrl ?? null,
    effectiveFrom: preview.candidateRows[1].effectiveFrom ?? null,
    effectiveTo: preview.candidateRows[1].effectiveTo ?? null
  }, {
    factorYear: null,
    sourceUrl: null,
    effectiveFrom: null,
    effectiveTo: null
  });
  assert.strictEqual(countRows(db, 'carbon_factors'), factorsBeforePreview, 'artifact 11 preview 不得写业务表。');
  assert.strictEqual(countRows(db, 'demo_data_registry'), registryBeforePreview, 'artifact 11 preview 不得登记 ownership。');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'previewed');

  const executed = await executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), options);
  assert.strictEqual(executed.imported, 2);
  assert.deepStrictEqual(executed.importedRecords.map((row) => row.factorUnit), ['kgCO2e/kWh', 'kgCO2e']);
  assert.strictEqual(executed.previewSignature, preview.previewSignature,
    'managed execute 锁内重建 preview 后必须保持原签名。');
  assert.strictEqual(executed.previewAuditDigest, preview.previewAuditDigest,
    'managed execute 锁内重建 preview 后必须保持原审计摘要。');
  assert.deepStrictEqual(db.prepare(`SELECT factor_year AS factorYear, source_url AS sourceUrl,
      effective_from AS effectiveFrom, effective_to AS effectiveTo
    FROM carbon_factors WHERE source = 'DEMO-MANAGED-FACTOR-A'`).get(), {
    factorYear: 2026,
    sourceUrl: 'https://example.com/demo-factor-a',
    effectiveFrom: '2026-02-01',
    effectiveTo: '2026-11-30'
  }, '非空可选字段必须保持 canonical 值原样写入。');
  assert.deepStrictEqual(db.prepare(`SELECT factor_year AS factorYear, source_url AS sourceUrl,
      effective_from AS effectiveFrom, effective_to AS effectiveTo
    FROM carbon_factors WHERE source = 'DEMO-MANAGED-FACTOR-B'`).get(), {
    factorYear: null,
    sourceUrl: null,
    effectiveFrom: null,
    effectiveTo: null
  }, '空可选字段必须统一保存为 SQLite null。');
  assert.strictEqual(executed.writesCarbonFactors, true);
  assert.strictEqual(executed.writesCarbonEmissions, false);
  assert.strictEqual(executed.ownership.registrationCount, 2);
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'executed');
  const links = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ?`).all(context.contextId);
  assert.deepStrictEqual(links, [{ batchId: preview.batchId, batchRole: 'primary' }]);
  const ownershipRows = db.prepare(`SELECT entity_pk AS entityPk, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = 'carbon_factor'
    ORDER BY registry_id`).all(demoRun.runId, FACTOR_ARTIFACT_KEY);
  assert.strictEqual(ownershipRows.length, 2);
  assert(ownershipRows.every((row) => Number(row.sourceBatchId) === preview.batchId));
  ownershipRows.forEach((row) => assertOwnershipDigest(db, 'carbon_factor', row.entityPk));
  const persistedExecuteResult = JSON.parse(db.prepare('SELECT execute_result_json AS json FROM import_batches WHERE id = ?')
    .get(preview.batchId).json);
  assert.deepStrictEqual(persistedExecuteResult.importedIds, executed.importedIds);

  const stateBeforeReplay = snapshotManagedState(db, context.contextId, preview.batchId);
  const replay = await executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), options);
  assert.strictEqual(replay.terminalReplay, true);
  assert.deepStrictEqual(replay.importedIds, persistedExecuteResult.importedIds);
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), stateBeforeReplay,
    'artifact 11 重复 execute 必须严格只读。');
}

/** 验证 managed factor preview 对空值和合同外单位逐行阻断且不写业务表。 */
function testManagedFactorUnitValidation(db) {
  const buffer = buildFactorWorkbookBuffer([
    buildFactorRow('DEMO-MANAGED-EMPTY-UNIT', { factorUnit: '' }),
    buildFactorRow('DEMO-MANAGED-INVALID-UNIT', { factorUnit: 'PRIVATE_LEGACY_UNIT' })
  ]);
  const file = storeUpload('managed-factor-invalid-units.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const factorsBeforePreview = countRows(db, 'carbon_factors');
  const preview = createCarbonFactorImportPreviewFromUpload(
    file,
    buildManagedFactorOptions(db, context)
  );
  assert.deepStrictEqual(preview.summary, {
    totalRows: 2,
    wouldImport: 0,
    skipped: 0,
    blocked: 2,
    warnings: 0,
    errors: 2
  });
  preview.items.forEach((item) => {
    assert(item.reasonCodes.includes('CARBON_EMISSION_UNIT_INVALID'));
    assert.strictEqual(item.factorUnit, null);
    assert.strictEqual(JSON.stringify(item.reasons).includes('PRIVATE_LEGACY_UNIT'), false);
  });
  assert.deepStrictEqual(preview.candidateRows, []);
  assert.strictEqual(countRows(db, 'carbon_factors'), factorsBeforePreview);
}

/** 验证下载 artifact 摘要与 preview 实际上传字节不一致时原子拒绝。 */
function testFactorDownloadDigestMismatch(db) {
  const downloadedBuffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-DOWNLOAD-DIGEST-A')]);
  const uploadedBuffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-DOWNLOAD-DIGEST-B')]);
  const file = storeUpload('factor-download-digest-mismatch.xlsx', uploadedBuffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, downloadedBuffer);
  const batchesBefore = countRows(db, 'import_batches');
  assert.throws(
    () => createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context)),
    (error) => (error?.details?.code || error?.code) === 'DEMO_CONTEXT_REASSOCIATED_FILE_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'import_batches'), batchesBefore, 'artifact 11 文件摘要不匹配不得遗留 preview 批次。');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'issued');
}

/** 验证 actor mismatch 在业务写、ownership 和 context CAS 前拒绝。 */
async function testFactorActorMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-ACTOR-MISMATCH')]);
  const file = storeUpload('factor-actor-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  const factorCountBefore = countRows(db, 'carbon_factors');
  await assertAsyncError(
    () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context, {
      actor: { ...actor, userId: actor.userId + 1000 }
    })),
    'CARBON_FACTOR_IMPORT_ACTOR_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'carbon_factors'), factorCountBefore);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证 context run 指向非当前 active run 时 preview fail-closed。 */
function testFactorRunMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-RUN-MISMATCH')]);
  const file = storeUpload('factor-run-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const failedRunId = 'demo-run-carbon-input-failed';
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at, failure_reason)
    VALUES (?, ?, ?, ?, 'failed', ?, ?, 'test-only')`).run(
    failedRunId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    getDemoParkManifestDigest(),
    actor.userId,
    '2026-08-29T00:00:00.000Z'
  );
  db.prepare('UPDATE demo_import_contexts SET run_id = ? WHERE context_id = ?').run(failedRunId, context.contextId);
  const batchesBefore = countRows(db, 'import_batches');
  assert.throws(
    () => createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context)),
    (error) => (error?.details?.code || error?.code) === 'DEMO_RUN_INVALID'
  );
  assert.strictEqual(countRows(db, 'import_batches'), batchesBefore);
}

/** 验证 context manifest 身份漂移时 preview fail-closed。 */
function testFactorManifestMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-MANIFEST-MISMATCH')]);
  const file = storeUpload('factor-manifest-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  db.prepare('UPDATE demo_import_contexts SET manifest_digest = ? WHERE context_id = ?')
    .run('f'.repeat(64), context.contextId);
  const batchesBefore = countRows(db, 'import_batches');
  assert.throws(
    () => createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context)),
    (error) => (error?.details?.code || error?.code) === 'DEMO_CONTEXT_BINDING_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'import_batches'), batchesBefore);
}

/** 验证 retained upload 实际 SHA 漂移时 execute 在解析、备份和写入前拒绝。 */
async function testFactorRetainedFileDigestMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-RETAINED-DIGEST')]);
  const file = storeUpload('factor-retained-digest-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  const tamperedBuffer = Buffer.from(buffer);
  tamperedBuffer[tamperedBuffer.length - 1] ^= 1;
  fs.writeFileSync(file.path, tamperedBuffer);
  const factorCountBefore = countRows(db, 'carbon_factors');
  await assertAsyncError(
    () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context)),
    'CARBON_FACTOR_IMPORT_CURRENT_FILE_SHA256_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'carbon_factors'), factorCountBefore);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证 context preview digest 漂移时 execute fail-closed。 */
async function testFactorPreviewDigestMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-PREVIEW-DIGEST')]);
  const file = storeUpload('factor-preview-digest-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  db.prepare('UPDATE demo_import_contexts SET preview_digest = ? WHERE context_id = ?')
    .run(`hmac-sha256:v1:audit:${'d'.repeat(64)}`, context.contextId);
  const factorCountBefore = countRows(db, 'carbon_factors');
  await assertAsyncError(
    () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context)),
    'DEMO_CONTEXT_PREVIEW_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'carbon_factors'), factorCountBefore);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证静态 primary batch role 被持久化篡改时 execute fail-closed。 */
async function testFactorBatchRoleMismatch(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-BATCH-ROLE-MISMATCH')]);
  const file = storeUpload('factor-batch-role-mismatch.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  db.prepare('UPDATE demo_run_import_batches SET batch_role = ? WHERE context_id = ?')
    .run('tampered-primary', context.contextId);
  const factorCountBefore = countRows(db, 'carbon_factors');
  await assertAsyncError(
    () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context)),
    'DEMO_OWNERSHIP_IMPORT_BATCH_CONFLICT'
  );
  assert.strictEqual(countRows(db, 'carbon_factors'), factorCountBefore);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证中途业务写失败时已插入碳因子、ownership、成功审计和 context CAS 整体回滚。 */
async function testFactorBusinessWriteRollback(db) {
  const buffer = buildFactorWorkbookBuffer([
    buildFactorRow('DEMO-BUSINESS-ROLLBACK-A', { factorValue: 0.501 }),
    buildFactorRow('DEMO-BUSINESS-ROLLBACK-B', { factorValue: 0.502 })
  ]);
  const file = storeUpload('factor-business-rollback.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  await assert.rejects(
    () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context, {
      beforeManagedInsertCandidate({ index }) {
        if (index === 1) throw new Error('injected factor business write failure');
      }
    })),
    /injected factor business write failure/
  );
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证 ownership INSERT 失败时业务写、成功审计和 context CAS 整体回滚。 */
async function testFactorOwnershipWriteRollback(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-OWNERSHIP-ROLLBACK')]);
  const file = storeUpload('factor-ownership-rollback.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  db.exec(`CREATE TRIGGER test_factor_ownership_failure
    BEFORE INSERT ON demo_data_registry
    BEGIN
      SELECT RAISE(ABORT, 'injected factor ownership failure');
    END`);
  try {
    await assertAsyncError(
      () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context)),
      'DEMO_OWNERSHIP_REGISTRY_WRITE_FAILED'
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_factor_ownership_failure');
  }
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证 context executed CAS 失败时业务写、ownership 和成功审计整体回滚。 */
async function testFactorContextCasRollback(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-CONTEXT-CAS-ROLLBACK')]);
  const file = storeUpload('factor-context-cas-rollback.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, buildManagedFactorOptions(db, context));
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  db.exec(`CREATE TRIGGER test_factor_context_cas_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW WHEN NEW.status = 'executed'
    BEGIN
      SELECT RAISE(ABORT, 'injected factor context cas failure');
    END`);
  try {
    await assert.rejects(
      () => executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), buildManagedFactorOptions(db, context)),
      /injected factor context cas failure/
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_factor_context_cas_failure');
  }
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证无 context 碳因子正式导入保持原行为且不登记 demo ownership。 */
async function testFormalFactorImportDoesNotClaimOwnership(db) {
  const buffer = buildFactorWorkbookBuffer([buildFactorRow('DEMO-FORMAL-FACTOR')]);
  const file = storeUpload('formal-factor.xlsx', buffer);
  const preview = createCarbonFactorImportPreviewFromUpload(file, { db, uploadsDir: temporaryUploadsDir });
  const ownershipBefore = countRows(db, 'demo_data_registry');
  const result = await executeCarbonFactorImport(buildFormalFactorExecuteBody(preview));
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(countRows(db, 'demo_data_registry'), ownershipBefore);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);
}

/** 验证 managed 导入只认领本次真实 INSERT，不得认领因正式既有数据而 skip 的碳因子。 */
async function testManagedFactorDoesNotClaimFormalSkip(db) {
  const formalFactor = db.prepare("SELECT id FROM carbon_factors WHERE source = 'DEMO-FORMAL-FACTOR'").get();
  assert(formalFactor, '正式碳因子哨兵必须存在。');
  const buffer = buildFactorWorkbookBuffer([
    buildFactorRow('DEMO-FORMAL-FACTOR'),
    buildFactorRow('DEMO-MANAGED-AFTER-FORMAL-SKIP', { factorValue: 0.654 })
  ]);
  const file = storeUpload('managed-factor-formal-skip.xlsx', buffer);
  const context = createManagedContext(db, FACTOR_ARTIFACT_KEY, buffer);
  const options = buildManagedFactorOptions(db, context);
  const preview = createCarbonFactorImportPreviewFromUpload(file, options);
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(preview.summary.skipped, 1);
  const result = await executeCarbonFactorImport(buildManagedFactorExecuteBody(preview), options);
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.ownership.registrationCount, 1);
  assert.strictEqual(countRows(db, 'demo_data_registry', "WHERE entity_type = 'carbon_factor' AND entity_pk = ?", [String(formalFactor.id)]), 0);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 1);
}

/** 验证 artifact 27 下载文件摘要与实际上传字节不一致时在 preview 审计前拒绝。 */
function testActivityDownloadDigestMismatch(db) {
  const downloadedBuffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-DOWNLOAD-A', {
      startWallClock: '2026-09-02T09:00',
      endWallClock: '2026-09-02T10:00'
    })
  ]);
  const uploadedBuffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-DOWNLOAD-B', {
      startWallClock: '2026-09-02T11:00',
      endWallClock: '2026-09-02T12:00'
    })
  ]);
  const file = storeUpload('activity-download-digest-mismatch.xlsx', uploadedBuffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, downloadedBuffer);
  const batchesBefore = countRows(db, 'import_batches');
  assert.throws(
    () => previewCarbonActivityImport(file, buildActivityOptions(db, context)),
    (error) => (error?.details?.code || error?.code) === 'DEMO_CONTEXT_REASSOCIATED_FILE_MISMATCH'
  );
  assert.strictEqual(countRows(db, 'import_batches'), batchesBefore);
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'issued');
}

/** 验证 artifact 27 retained upload 字节漂移时保持 preview 审计，并可恢复原文件重试。 */
async function testActivityRetainedFileDigestMismatch(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-RETAINED-DIGEST', {
      startWallClock: '2026-09-08T09:00',
      endWallClock: '2026-09-08T10:00'
    })
  ]);
  const file = storeUpload('activity-retained-digest-mismatch.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  const tamperedBuffer = Buffer.from(buffer);
  tamperedBuffer[tamperedBuffer.length - 1] ^= 1;
  fs.writeFileSync(file.path, tamperedBuffer);
  await assertAsyncError(
    () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
    'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH'
  );
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);

  fs.writeFileSync(file.path, buffer);
  const retried = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(retried.imported, 1);
  assert.strictEqual(retried.ownership.registrationCount, 1);
}

/** 验证 artifact 27 preview digest 漂移时整体只读失败，并可恢复持久摘要重试。 */
async function testActivityPreviewDigestMismatch(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-PREVIEW-DIGEST', {
      startWallClock: '2026-09-09T09:00',
      endWallClock: '2026-09-09T10:00'
    })
  ]);
  const file = storeUpload('activity-preview-digest-mismatch.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  const originalPreviewDigest = db.prepare(
    'SELECT preview_digest AS previewDigest FROM demo_import_contexts WHERE context_id = ?'
  ).get(context.contextId).previewDigest;
  db.prepare('UPDATE demo_import_contexts SET preview_digest = ? WHERE context_id = ?')
    .run(`hmac-sha256:v1:audit:${'e'.repeat(64)}`, context.contextId);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  await assertAsyncError(
    () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
    'DEMO_CONTEXT_PREVIEW_MISMATCH'
  );
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);

  db.prepare('UPDATE demo_import_contexts SET preview_digest = ? WHERE context_id = ?')
    .run(originalPreviewDigest, context.contextId);
  const retried = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(retried.imported, 1);
  assert.strictEqual(retried.ownership.registrationCount, 1);
}

/** 验证 artifact 27 静态 batch role 漂移时统一包装事务错误，并可恢复绑定重试。 */
async function testActivityBatchRoleMismatch(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-BATCH-ROLE', {
      startWallClock: '2026-09-10T09:00',
      endWallClock: '2026-09-10T10:00'
    })
  ]);
  const file = storeUpload('activity-batch-role-mismatch.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  db.prepare('UPDATE demo_run_import_batches SET batch_role = ? WHERE context_id = ?')
    .run('tampered-primary', context.contextId);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  await assertAsyncError(
    () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
    'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED',
    'DEMO_OWNERSHIP_IMPORT_BATCH_CONFLICT'
  );
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);

  db.prepare('UPDATE demo_run_import_batches SET batch_role = ? WHERE context_id = ?')
    .run('primary', context.contextId);
  const retried = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(retried.imported, 1);
  assert.strictEqual(retried.ownership.registrationCount, 1);
}

/** 验证 artifact 27 多行中途 INSERT 失败时首行、审计、ownership 与 context 整体回滚。 */
async function testActivityMultiRowBusinessRollback(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-MULTI-ROLLBACK-A', {
      startWallClock: '2026-09-11T09:00',
      endWallClock: '2026-09-11T10:00'
    }),
    buildActivityRow('DEMO-ACTIVITY-MULTI-ROLLBACK-B', {
      startWallClock: '2026-09-11T10:00',
      endWallClock: '2026-09-11T11:00'
    })
  ]);
  const file = storeUpload('activity-multi-row-rollback.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  assert.strictEqual(preview.summary.wouldImport, 2);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  db.exec(`CREATE TRIGGER test_activity_multi_row_failure
    BEFORE INSERT ON carbon_activity_records
    FOR EACH ROW WHEN NEW.activity_code = 'DEMO-ACTIVITY-MULTI-ROLLBACK-B'
    BEGIN SELECT RAISE(ABORT, 'injected activity second row failure'); END`);
  try {
    await assertAsyncError(
      () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
      'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_activity_multi_row_failure');
  }
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);

  const retried = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(retried.imported, 2);
  assert.strictEqual(retried.ownership.registrationCount, 2);
}

/** 验证 artifact 27 context executed CAS 失败时全部先行写入回滚，并可移除故障后重试。 */
async function testActivityContextCasRollback(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-CONTEXT-CAS', {
      startWallClock: '2026-09-12T09:00',
      endWallClock: '2026-09-12T10:00'
    })
  ]);
  const file = storeUpload('activity-context-cas-rollback.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  db.exec(`CREATE TRIGGER test_activity_context_cas_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW WHEN NEW.status = 'executed'
    BEGIN SELECT RAISE(ABORT, 'injected activity context cas failure'); END`);
  try {
    await assertAsyncError(
      () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
      'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_activity_context_cas_failure');
  }
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);

  const retried = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(retried.imported, 1);
  assert.strictEqual(retried.ownership.registrationCount, 1);
}

/** 验证 artifact 27 成功、preview 无 ownership、批次绑定和终态只读回放。 */
async function testManagedActivitySuccessAndReplay(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-MANAGED-ACTIVITY', {
      startWallClock: '2026-09-03T09:00',
      endWallClock: '2026-09-03T10:00'
    })
  ]);
  const file = storeUpload('managed-activity-success.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const registryBeforePreview = countRows(db, 'demo_data_registry');
  const activitiesBeforePreview = countRows(db, 'carbon_activity_records');
  const preview = previewCarbonActivityImport(file, options);
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(countRows(db, 'carbon_activity_records'), activitiesBeforePreview, 'artifact 27 preview 不得写业务表。');
  assert.strictEqual(countRows(db, 'demo_data_registry'), registryBeforePreview, 'artifact 27 preview 不得登记 ownership。');

  const executed = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(executed.imported, 1);
  assert.strictEqual(executed.ownership.registrationCount, 1);
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'executed');
  const link = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ?`).get(context.contextId);
  assert.deepStrictEqual(link, { batchId: preview.batchId, batchRole: 'primary' });
  assertOwnershipDigest(db, 'carbon_activity_record', executed.importedIds[0]);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = 'carbon.activity.import.execute' AND target_id = ?`).get(String(preview.batchId)).total, 1);

  const persistedExecuteResult = JSON.parse(db.prepare('SELECT execute_result_json AS json FROM import_batches WHERE id = ?')
    .get(preview.batchId).json);
  const stateBeforeReplay = snapshotManagedState(db, context.contextId, preview.batchId);
  const replay = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(replay.terminalReplay, true);
  assert.deepStrictEqual(replay.importedIds, persistedExecuteResult.importedIds);
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), stateBeforeReplay,
    'artifact 27 重复 execute 必须严格只读。');
}

/** 验证 managed activity 只能 supersede 当前 run 已认领记录，并同事务刷新旧 ownership snapshot。 */
async function testManagedActivitySupersedesOwnedRecord(db) {
  const original = db.prepare(`SELECT activity.id, registry.snapshot_digest AS snapshotDigest
    FROM carbon_activity_records activity
    JOIN demo_data_registry registry
      ON registry.entity_type = 'carbon_activity_record' AND registry.entity_pk = CAST(activity.id AS TEXT)
    WHERE registry.run_id = ? AND registry.artifact_key = ? AND activity.activity_code = 'DEMO-MANAGED-ACTIVITY'`)
    .get(demoRun.runId, ACTIVITY_ARTIFACT_KEY);
  assert(original, '同 run managed 碳活动原记录及 ownership 必须存在。');
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-MANAGED-ACTIVITY-V2', {
      supersedesActivityCode: 'DEMO-MANAGED-ACTIVITY',
      startWallClock: '2026-09-03T09:00',
      endWallClock: '2026-09-03T10:00',
      activityValue: '105',
      sourceReference: 'managed-owned-replacement'
    })
  ]);
  const file = storeUpload('managed-activity-owned-supersede.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  assert.strictEqual(preview.summary.wouldImport, 1);
  const result = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(result.imported, 1);
  const replacementId = result.importedIds[0];
  const persistedOriginal = db.prepare(`SELECT record_status AS recordStatus,
      superseded_by_activity_id AS supersededByActivityId FROM carbon_activity_records WHERE id = ?`).get(original.id);
  const persistedReplacement = db.prepare(`SELECT record_status AS recordStatus,
      supersedes_activity_id AS supersedesActivityId FROM carbon_activity_records WHERE id = ?`).get(replacementId);
  assert.deepStrictEqual(persistedOriginal, { recordStatus: 'superseded', supersededByActivityId: replacementId });
  assert.deepStrictEqual(persistedReplacement, { recordStatus: 'active', supersedesActivityId: original.id });
  const refreshedOriginal = db.prepare(`SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = 'carbon_activity_record' AND entity_pk = ?`).get(
    demoRun.runId,
    ACTIVITY_ARTIFACT_KEY,
    String(original.id)
  );
  assert.notStrictEqual(refreshedOriginal.snapshotDigest, original.snapshotDigest,
    '旧活动 supersede projection 变化后必须刷新 ownership snapshot digest。');
  assertOwnershipDigest(db, 'carbon_activity_record', original.id);
  assertOwnershipDigest(db, 'carbon_activity_record', replacementId);
}

/** 创建一条无 context 正式碳活动哨兵并证明正式路径不登记 ownership。 */
async function createFormalActivitySentinel(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-FORMAL-SENTINEL', {
      startWallClock: '2026-09-05T09:00',
      endWallClock: '2026-09-05T10:00',
      sourceReference: 'formal-sentinel'
    })
  ]);
  const file = storeUpload('formal-activity-sentinel.xlsx', buffer);
  const preview = previewCarbonActivityImport(file, buildActivityOptions(db));
  const ownershipBefore = countRows(db, 'demo_data_registry');
  const result = await executeCarbonActivityImport(buildActivityExecuteBody(preview), buildActivityOptions(db));
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(countRows(db, 'demo_data_registry'), ownershipBefore);
  const sentinel = db.prepare(`SELECT id, record_status AS recordStatus, superseded_by_activity_id AS supersededByActivityId
    FROM carbon_activity_records WHERE activity_code = 'DEMO-FORMAL-SENTINEL'`).get();
  assert(sentinel);
  assert.strictEqual(sentinel.recordStatus, 'active');
  return sentinel;
}

/** 验证 artifact 27 managed 全 skip 成功消费 context，但不插入业务行或认领正式记录。 */
async function testManagedActivityAllSkipDoesNotClaimFormalRecord(db, sentinel) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-MANAGED-ALL-SKIP', {
      startWallClock: '2026-09-05T09:00',
      endWallClock: '2026-09-05T10:00',
      sourceReference: 'formal-sentinel'
    })
  ]);
  const file = storeUpload('managed-activity-all-skip.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const activityCountBefore = countRows(db, 'carbon_activity_records');
  const registryBefore = countRows(db, 'demo_data_registry');
  const preview = previewCarbonActivityImport(file, options);
  assert.strictEqual(preview.summary.wouldImport, 0);
  assert.strictEqual(preview.summary.skipped, 1);
  assert.strictEqual(countRows(db, 'demo_data_registry'), registryBefore, 'all-skip preview 不得登记 ownership。');

  const result = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.writesBusinessRecords, false);
  assert.deepStrictEqual(result.importedIds, []);
  assert.deepStrictEqual(result.ownership, {
    applied: true,
    mode: 'demo',
    noInsertedRecords: true,
    registrationCount: 0,
    insertedCount: 0,
    idempotentCount: 0,
    skippedCount: 1,
    relationCount: 0
  });
  assert.strictEqual(countRows(db, 'carbon_activity_records'), activityCountBefore);
  assert.strictEqual(countRows(db, 'demo_data_registry'), registryBefore);
  assert.strictEqual(countRows(db, 'demo_data_registry', 'WHERE source_batch_id = ?', [preview.batchId]), 0);
  assert.strictEqual(countRows(db, 'demo_data_registry', "WHERE entity_type = 'carbon_activity_record' AND entity_pk = ?", [String(sentinel.id)]), 0);
  assert.strictEqual(
    db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status,
    'executed'
  );
  const persistedBatch = db.prepare(`SELECT status, audit_phase AS auditPhase,
      execute_result_json AS executeResultJson FROM import_batches WHERE id = ?`).get(preview.batchId);
  assert.strictEqual(persistedBatch.status, 'completed_with_errors');
  assert.strictEqual(persistedBatch.auditPhase, 'execute');
  assert.strictEqual(JSON.parse(persistedBatch.executeResultJson).ownership.noInsertedRecords, true);

  const stateBeforeReplay = snapshotManagedState(db, context.contextId, preview.batchId);
  const replay = await executeCarbonActivityImport(buildActivityExecuteBody(preview), options);
  assert.strictEqual(replay.terminalReplay, true);
  assert.strictEqual(replay.imported, 0);
  assert.strictEqual(replay.ownership.noInsertedRecords, true);
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), stateBeforeReplay);
}

/** 验证 managed artifact 27 不得 supersede 正式哨兵且失败后保持可重试 preview。 */
async function testManagedActivityRejectsFormalSupersede(db, sentinel) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-MANAGED-REPLACEMENT', {
      supersedesActivityCode: 'DEMO-FORMAL-SENTINEL',
      startWallClock: '2026-09-05T09:00',
      endWallClock: '2026-09-05T10:00',
      activityValue: '120',
      sourceReference: 'managed-replacement'
    })
  ]);
  const file = storeUpload('managed-activity-formal-supersede.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  assert.strictEqual(preview.summary.wouldImport, 1);
  const activityCountBefore = countRows(db, 'carbon_activity_records');
  await assertAsyncError(
    () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
    'DEMO_CARBON_ACTIVITY_SUPERSEDE_OWNERSHIP_REQUIRED'
  );
  assert.strictEqual(countRows(db, 'carbon_activity_records'), activityCountBefore);
  const persistedSentinel = db.prepare(`SELECT id, record_status AS recordStatus,
      superseded_by_activity_id AS supersededByActivityId
    FROM carbon_activity_records WHERE id = ?`).get(sentinel.id);
  assert.deepStrictEqual(persistedSentinel, sentinel);
  assert.strictEqual(countRows(db, 'demo_data_registry', "WHERE entity_type = 'carbon_activity_record' AND entity_pk = ?", [String(sentinel.id)]), 0);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证 artifact 27 ownership 写失败时业务行、操作审计和 context 状态整体回滚。 */
async function testManagedActivityOwnershipRollback(db) {
  const buffer = buildActivityWorkbookBuffer([
    buildActivityRow('DEMO-ACTIVITY-OWNERSHIP-ROLLBACK', {
      startWallClock: '2026-09-07T09:00',
      endWallClock: '2026-09-07T10:00'
    })
  ]);
  const file = storeUpload('managed-activity-ownership-rollback.xlsx', buffer);
  const context = createManagedContext(db, ACTIVITY_ARTIFACT_KEY, buffer);
  const options = buildActivityOptions(db, context);
  const preview = previewCarbonActivityImport(file, options);
  const before = snapshotManagedState(db, context.contextId, preview.batchId);
  db.exec(`CREATE TRIGGER test_activity_ownership_failure
    BEFORE INSERT ON demo_data_registry
    BEGIN
      SELECT RAISE(ABORT, 'injected activity ownership failure');
    END`);
  try {
    await assertAsyncError(
      () => executeCarbonActivityImport(buildActivityExecuteBody(preview), options),
      'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED',
      'DEMO_OWNERSHIP_REGISTRY_WRITE_FAILED'
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_activity_ownership_failure');
  }
  assert.deepStrictEqual(snapshotManagedState(db, context.contextId, preview.batchId), before);
  assertPreviewStatePreserved(db, context.contextId, preview.batchId);
}

/** 验证输入治理本身不创建碳核算输出，同时 Carbon 公共动作保持正式 connected 身份。 */
function assertNoCarbonAccountingPostActionOutputs(db) {
  assert.strictEqual(countRows(db, 'carbon_calculation_runs'), 0);
  assert.strictEqual(countRows(db, 'carbon_accounting_results'), 0);
  assert.strictEqual(countRows(db, 'carbon_emissions'), 0);
  const carbonAction = requireDemoPostAction('carbon-accounting-run');
  assert.strictEqual(carbonAction.implementationStatus, 'connected');
  assert.strictEqual(carbonAction.executorVersion, 'carbon-accounting-executor:v1');
}

/** 初始化隔离数据库和两类碳输入依赖的正式基础数据。 */
function initializeFixture(db) {
  const admin = db.prepare("SELECT id, username FROM sys_users WHERE username = 'admin'").get();
  assert(admin, '隔离库必须初始化内置管理员。');
  actor = { userId: Number(admin.id), username: admin.username, ip: '127.0.0.1' };
  db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, '碳输入治理测试组织', ?, 'department', 'active')`).run(
    TEST_ORGANIZATION_CODE,
    `/${TEST_ORGANIZATION_CODE}`
  );
  energyType = db.prepare(`SELECT id, code, name, standard_unit AS standardUnit
    FROM energy_types WHERE is_active = 1 AND standard_unit IS NOT NULL
    ORDER BY id LIMIT 1`).get();
  assert(energyType, '隔离库必须存在启用且含标准单位的能源类型。');
  toggleDemoRuntime({ enabled: true, actorUserId: actor.userId, actorIp: actor.ip, db });
  demoRun = db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: actor.userId, db })).immediate();
}

(async () => {
  let db = null;
  try {
    fs.mkdirSync(temporaryDataDir, { recursive: true });
    fs.mkdirSync(temporaryUploadsDir, { recursive: true });
    fs.mkdirSync(temporaryBackupsDir, { recursive: true });
    initDatabase({ databasePath: temporaryDatabasePath });
    db = openDatabase({ databasePath: temporaryDatabasePath });
    initializeFixture(db);

    assert.strictEqual(getDemoArtifactRegistration(FACTOR_ARTIFACT_KEY).downloadLifecycle, 'managed-context-auto-runtime');
    assert.deepStrictEqual(getDemoArtifactRegistration(FACTOR_ARTIFACT_KEY).ownershipTargets, ['carbon_factor']);
    assert.strictEqual(getDemoArtifactRegistration(ACTIVITY_ARTIFACT_KEY).downloadLifecycle, 'managed-context-auto-runtime');
    assert.deepStrictEqual(getDemoArtifactRegistration(ACTIVITY_ARTIFACT_KEY).ownershipTargets, ['carbon_activity_record']);
    assert.strictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.carbon_factor.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.carbon_activity_record.projectionVersion, 'demo-entity-snapshot:v1');

    testFactorDownloadDigestMismatch(db);
    testFactorRunMismatch(db);
    testFactorManifestMismatch(db);
    testManagedFactorUnitValidation(db);
    await testManagedFactorSuccessAndReplay(db);
    await testFactorActorMismatch(db);
    await testFactorRetainedFileDigestMismatch(db);
    await testFactorPreviewDigestMismatch(db);
    await testFactorBatchRoleMismatch(db);
    await testFactorBusinessWriteRollback(db);
    await testFactorOwnershipWriteRollback(db);
    await testFactorContextCasRollback(db);
    await testFormalFactorImportDoesNotClaimOwnership(db);
    await testManagedFactorDoesNotClaimFormalSkip(db);
    testActivityDownloadDigestMismatch(db);
    await testActivityRetainedFileDigestMismatch(db);
    await testActivityPreviewDigestMismatch(db);
    await testActivityBatchRoleMismatch(db);
    await testActivityMultiRowBusinessRollback(db);
    await testActivityContextCasRollback(db);
    await testManagedActivitySuccessAndReplay(db);
    await testManagedActivitySupersedesOwnedRecord(db);
    const formalSentinel = await createFormalActivitySentinel(db);
    await testManagedActivityAllSkipDoesNotClaimFormalRecord(db, formalSentinel);
    await testManagedActivityRejectsFormalSupersede(db, formalSentinel);
    await testManagedActivityOwnershipRollback(db);
    assertNoCarbonAccountingPostActionOutputs(db);

    console.log('demo carbon input governance tests passed');
  } finally {
    if (db) db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
