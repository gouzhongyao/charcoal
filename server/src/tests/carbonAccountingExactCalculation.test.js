'use strict';

const carbonTestBootstrap = require('./helpers/carbonAccountingFaultHarness');
if (!carbonTestBootstrap.fixedIsolatedChild && module.parent) {
  throw new Error('Carbon 固定测试入口不允许被普通模块间接加载。');
}
const { runFixedCarbonAccountingTest } = carbonTestBootstrap;
// Carbon 与 ownership 私有能力只注入隔离子进程中的当前固定测试 Module。
const fixedCarbonTestResult = runFixedCarbonAccountingTest('carbon-accounting-exact-calculation');
if (fixedCarbonTestResult.delegated) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// exact 专项始终使用隔离临时 SQLite，禁止访问真实 data 目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-exact-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-exact.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonExact123!';

const { initDatabase, openDatabase } = require('../db/database');
const {
  carbonAccountingExactProtocol,
  carbonCalculationRunService,
  runWithCarbonAccountingFaultInjectorForTest
} = require('./helpers/carbonAccountingFaultHarness');
const {
  CARBON_ACCOUNTING_ACTIVITY_LIMIT
} = carbonCalculationRunService;
const demoOwnershipService = require('../services/demoOwnershipService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = demoOwnershipService;
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');

// exact 测试使用当前 canonical manifest 身份。
const DEMO_MANIFEST_DIGEST = getDemoParkManifestDigest();

/** 在单次调用链中注入固定故障阶段，作用域退出后自动恢复。 */
function runWithFaultStages(faultStages, operation) {
  const expectedStages = new Set(faultStages);
  return runWithCarbonAccountingFaultInjectorForTest((event) => {
    assert.deepStrictEqual(Object.keys(event).sort(), ['stage', 'summary']);
    assert(Object.isFrozen(event));
    assert(Object.isFrozen(event.summary));
    assert.deepStrictEqual(event.summary, {});
    assert.strictEqual('db' in event, false);
    if (expectedStages.has(event.stage)) throw new Error(`injected ${event.stage}`);
  }, operation);
}

/** 生成稳定 SHA-256 十六进制测试值。 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 创建隔离测试能源类型。 */
function insertEnergyType(db, code) {
  return Number(db.prepare(`INSERT INTO energy_types
    (code, name, category, default_unit, standard_unit, carbon_factor_required, is_active, display_order)
    VALUES (?, ?, 'other', 'unit', 'unit', 1, 1, 980)`).run(
    code,
    `exact 能源-${code}`
  ).lastInsertRowid);
}

/** 创建带来源批次和来源行号的碳因子。 */
function insertFactor(db, input) {
  return Number(db.prepare(`INSERT INTO carbon_factors
    (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
     factor_value, factor_unit, source, effective_from, effective_to, is_active)
    VALUES (@sourceBatchId, @sourceRowNumber, @energyTypeId, @region, @factorYear, @unit,
      @factorValue, @factorUnit, @source, '2000-01-01', '2099-12-31', @isActive)`)
    .run({
      sourceBatchId: input.sourceBatchId ?? null,
      sourceRowNumber: input.sourceRowNumber ?? null,
      energyTypeId: input.energyTypeId,
      region: input.region,
      factorYear: input.factorYear ?? null,
      unit: input.unit || 'unit',
      factorValue: input.factorValue,
      factorUnit: input.factorUnit || 'kgCO2e',
      source: input.source,
      isActive: input.isActive === false ? 0 : 1
    }).lastInsertRowid);
}

/** 创建带来源批次和来源行号的 active independent_activity。 */
function insertActivity(db, input) {
  const code = input.code;
  return Number(db.prepare(`INSERT INTO carbon_activity_records
    (source_type, source_batch_id, source_row_number, energy_record_id,
     activity_code, activity_code_key, emission_scope, activity_category,
     activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
     end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
     factor_region, source_reference, duplicate_key, record_status)
    VALUES ('independent_activity', @sourceBatchId, @sourceRowNumber, NULL,
      @code, @codeKey, @emissionScope, @activityCategory, @activityCategoryKey,
      @organizationUnitId, @energyTypeId, @startWallClock, @endWallClock,
      'Asia/Shanghai', @startUtc, @endUtc, @activityValue, @activityUnit,
      @factorRegion, @sourceReference, @duplicateKey, 'active')`)
    .run({
      sourceBatchId: input.sourceBatchId ?? null,
      sourceRowNumber: input.sourceRowNumber ?? null,
      code,
      codeKey: code.toLowerCase(),
      emissionScope: input.emissionScope || 'scope_1',
      activityCategory: input.activityCategory || `exact 类别-${code}`,
      activityCategoryKey: (input.activityCategory || `exact 类别-${code}`).toLowerCase(),
      organizationUnitId: input.organizationUnitId,
      energyTypeId: input.energyTypeId,
      startWallClock: input.startWallClock || '2026-01-01T08:00',
      endWallClock: input.endWallClock || '2026-01-01T09:00',
      startUtc: input.startUtc || '2026-01-01T00:00:00Z',
      endUtc: input.endUtc || '2026-01-01T01:00:00Z',
      activityValue: input.activityValue ?? 1,
      activityUnit: input.activityUnit || 'unit',
      factorRegion: input.factorRegion || 'cn-exact',
      sourceReference: `source-${code}`,
      duplicateKey: sha256(`duplicate-${code}`)
    }).lastInsertRowid);
}

/** 创建正式导入批次。 */
function insertImportBatch(db, importType, suffix) {
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count)
    VALUES (?, ?, 'xlsx', 'completed', 'execute', 0, 0, 0, 0)`)
    .run(importType, `${suffix}.xlsx`).lastInsertRowid);
}

/** 创建当前 canonical demo run。 */
function insertDemoRun(db, runId, status = 'active') {
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`).run(
    runId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    DEMO_MANIFEST_DIGEST,
    status,
    createdAt
  );
  return {
    runId,
    datasetId: DEMO_DATASET_ID,
    manifestVersion: DEMO_MANIFEST_VERSION,
    manifestDigest: DEMO_MANIFEST_DIGEST,
    status,
    createdBy: 1,
    createdAt
  };
}

/** 创建已执行 managed context 和 primary batch 绑定。 */
function bindArtifactBatch(db, input) {
  const contextId = `context-${input.runId}-${input.artifactKey}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
     artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
     status, issued_at, expires_at, upload_file_sha256, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'executed', ?, ?, ?, ?)`)
    .run(
      contextId,
      sha256(`token-${contextId}`),
      input.runId,
      DEMO_DATASET_ID,
      DEMO_MANIFEST_VERSION,
      DEMO_MANIFEST_DIGEST,
      input.artifactKey,
      input.handlerKey,
      sha256(`artifact-${contextId}`),
      now,
      expiresAt,
      sha256(`upload-${contextId}`),
      now
    );
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, 'primary')`).run(
    input.runId,
    input.artifactKey,
    contextId,
    input.batchId
  );
  return contextId;
}

/** 为单条业务记录登记 active imported ownership。 */
function registerImportedOwnership(db, input) {
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[input.entityType];
  const projection = handler.readProjection(db, input.entityPk);
  assert(projection, `${input.entityType}:${input.entityPk} projection 必须存在。`);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`)
    .run(
      input.runId,
      input.artifactKey,
      input.entityType,
      String(input.entityPk),
      calculateDemoEntityIdentityDigest(input.entityType, String(input.entityPk)),
      calculateDemoEntitySnapshotDigest(input.entityType, String(input.entityPk), projection),
      input.sourceBatchId,
      input.sourceRowNumber
    );
}

/** 刷新业务记录的 ownership snapshot digest。 */
function refreshOwnershipSnapshotDigest(db, entityType, entityPk) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE entity_type = ? AND entity_pk = ? AND cleaned_at IS NULL`).run(
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    entityType,
    String(entityPk)
  );
}

/** 读取 exact 运行、结果和领域审计数量。 */
function readWriteCounts(db) {
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
    results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
    audits: Number(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.accounting.run.create'`).get().total)
  };
}

/** 断言函数抛出指定领域错误码。 */
function assertErrorCode(callback, expectedCode) {
  assert.throws(callback, (error) => error?.code === expectedCode || error?.details?.code === expectedCode);
}

/** 在无 prepare/业务 SQL 的边界断言 capability 校验失败。 */
function assertFailsBeforeBusinessSql(db, callback, expectedCode, options = {}) {
  const originalPrepare = db.prepare;
  const originalExec = db.exec;
  let prepareCount = 0;
  let execCount = 0;
  db.prepare = function trackedPrepare(...args) {
    prepareCount += 1;
    return originalPrepare.apply(db, args);
  };
  db.exec = function trackedExec(...args) {
    execCount += 1;
    return originalExec.apply(db, args);
  };
  try {
    assertErrorCode(callback, expectedCode);
  } finally {
    db.prepare = originalPrepare;
    db.exec = originalExec;
  }
  assert.strictEqual(prepareCount, 0, `${expectedCode} 不得执行业务 prepare。`);
  assert.strictEqual(execCount, options.expectedExecCount || 0, `${expectedCode} exec 数量不符合能力校验边界。`);
}

/** 在当前 caller transaction 中构造并执行一轮待验证 exact 计算。 */
function executePendingExactCalculation(db, fixture, actor) {
  const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
    db,
    demoRun: fixture.run,
    actor
  });
  const execution = carbonAccountingExactProtocol.executeExactInCallerTransaction({
    db,
    demoRun: fixture.run,
    actor,
    exactScope: built.exactScope,
    exactCapability: built.exactCapability
  });
  return { built, execution };
}

/** 为指定 run 复制一条不同活动主键的额外结果，验证 witness 对结果集合数量的复核。 */
function insertExtraCalculationResult(db, calculationRunId, extraActivityRecordId) {
  const columns = db.prepare('PRAGMA table_info(carbon_accounting_results)').all()
    .map((column) => column.name)
    .filter((columnName) => columnName !== 'id');
  const quotedColumns = columns.map((columnName) => `"${columnName}"`);
  const selectExpressions = columns.map((columnName) => (
    columnName === 'activity_record_id' ? '?' : `"${columnName}"`
  ));
  db.prepare(`INSERT INTO carbon_accounting_results (${quotedColumns.join(', ')})
    SELECT ${selectExpressions.join(', ')} FROM carbon_accounting_results
    WHERE calculation_run_id = ? ORDER BY id LIMIT 1`).run(
    extraActivityRecordId,
    calculationRunId
  );
}

/** 捕获 verifier 失败后仍尝试 COMMIT，并断言半成品未进入持久基线。 */
function assertFailedWitnessCannotCommit(input) {
  const { db, fixture, actor, baselineCounts, expectedCode, mutate, faultStage } = input;
  db.exec('BEGIN IMMEDIATE');
  const pending = executePendingExactCalculation(db, fixture, actor);
  if (typeof mutate === 'function') mutate(pending.execution);
  const consumeWitness = () => carbonAccountingExactProtocol
    .consumeCalculationWitnessInCallerTransaction({
      db,
      demoRun: fixture.run,
      actor,
      exactScope: pending.built.exactScope,
      calculationWitness: pending.execution.calculationWitness
    });
  assertErrorCode(
    () => faultStage
      ? runWithFaultStages([faultStage], consumeWitness)
      : consumeWitness(),
    expectedCode
  );
  let commitError = null;
  try {
    db.exec('COMMIT');
  } catch (error) {
    commitError = error;
  }
  assert(commitError || db.inTransaction === false,
    'verifier 失败后 caller COMMIT 必须完成空事务或因事务已 fail-closed 而失败。');
  assert.strictEqual(db.open, true, '当前故障夹具应通过完整回滚保留可用连接。');
  assert.deepStrictEqual(readWriteCounts(db), baselineCounts,
    'verifier 失败后调用方捕获并 COMMIT 不得持久化 run/result/audit。');
}

/** 捕获 executor 恢复失败后仍尝试 COMMIT，并断言部分 run/results 不得持久化。 */
function assertFailedExecutorCannotCommit(input) {
  const { db, fixture, actor, baselineCounts, recoveryFaultStage } = input;
  db.exec('BEGIN IMMEDIATE');
  const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
    db,
    demoRun: fixture.run,
    actor
  });
  assertErrorCode(() => runWithFaultStages(
    ['exact-before-audit', recoveryFaultStage],
    () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
      db,
      demoRun: fixture.run,
      actor,
      exactScope: built.exactScope,
      exactCapability: built.exactCapability
    })
  ), 'CARBON_ACCOUNTING_EXACT_EXECUTOR_RECOVERY_FAILED');
  let commitError = null;
  try {
    db.exec('COMMIT');
  } catch (error) {
    commitError = error;
  }
  assert(commitError || db.inTransaction === false,
    'executor 恢复失败后 caller COMMIT 必须完成空事务或因完整回滚而失败。');
  assert.strictEqual(db.open, true, '当前 executor 故障夹具应通过完整回滚保留连接。');
  assert.deepStrictEqual(readWriteCounts(db), baselineCounts,
    'executor 恢复失败后调用方捕获并 COMMIT 不得持久化部分 run/results。');
}

/** 创建 artifact 11/27 exact 正常夹具。 */
function seedExactFixture(db) {
  const run = insertDemoRun(db, 'carbon-exact-run');
  const factorBatchId = insertImportBatch(db, 'carbon_factor', 'exact-factors');
  const activityBatchId = insertImportBatch(db, 'carbon_activity', 'exact-activities');
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '11-carbon-factors',
    handlerKey: 'carbon-factors-import',
    batchId: factorBatchId
  });
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '27-carbon-activities',
    handlerKey: 'carbon-activity-import',
    batchId: activityBatchId
  });
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES ('CARBON-EXACT-OU', 'exact 组织', '/CARBON-EXACT-OU', 'department', 'active')`)
    .run().lastInsertRowid);
  const energyTypeIds = {};
  ['p1', 'p2', 'p3', 'p4', 'missing'].forEach((suffix) => {
    energyTypeIds[suffix] = insertEnergyType(db, `carbon-exact-${suffix}`);
  });
  const factorIds = [];
  let factorRow = 1;
  const addFactor = (input) => {
    const factorId = insertFactor(db, {
      ...input,
      sourceBatchId: factorBatchId,
      sourceRowNumber: factorRow
    });
    registerImportedOwnership(db, {
      runId: run.runId,
      artifactKey: '11-carbon-factors',
      entityType: 'carbon_factor',
      entityPk: factorId,
      sourceBatchId: factorBatchId,
      sourceRowNumber: factorRow
    });
    factorIds.push(factorId);
    factorRow += 1;
    return factorId;
  };
  addFactor({ energyTypeId: energyTypeIds.p1, region: 'cn-exact', factorYear: 2026, factorValue: 0.1, source: 'exact-p1-low' });
  const selectedP1FactorId = addFactor({ energyTypeId: energyTypeIds.p1, region: 'cn-exact', factorYear: 2026, factorValue: 0.12345678, factorUnit: 'kg CO₂e', source: 'exact-p1-high' });
  addFactor({ energyTypeId: energyTypeIds.p1, region: 'default', factorYear: 2026, factorValue: 0.2, source: 'exact-p1-default-year' });
  addFactor({ energyTypeId: energyTypeIds.p1, region: 'cn-exact', factorYear: null, factorValue: 0.3, source: 'exact-p1-region-generic' });
  addFactor({ energyTypeId: energyTypeIds.p1, region: 'default', factorYear: null, factorValue: 0.4, source: 'exact-p1-default-generic' });
  addFactor({ energyTypeId: energyTypeIds.p2, region: 'default', factorYear: 2026, factorValue: 2, source: 'exact-p2' });
  addFactor({ energyTypeId: energyTypeIds.p3, region: 'cn-exact', factorYear: null, factorValue: 3, source: 'exact-p3' });
  addFactor({ energyTypeId: energyTypeIds.p4, region: 'default', factorYear: null, factorValue: 4, source: 'exact-p4' });
  const missingFactorId = addFactor({ energyTypeId: energyTypeIds.missing, region: 'cn-exact', factorYear: 2026, factorValue: 5, unit: 'other', source: 'exact-missing-unit' });
  const activityIds = {};
  let activityRow = 1;
  const addActivity = (key, input) => {
    const activityId = insertActivity(db, {
      ...input,
      code: `CARBON-EXACT-${key.toUpperCase()}`,
      sourceBatchId: activityBatchId,
      sourceRowNumber: activityRow,
      organizationUnitId
    });
    registerImportedOwnership(db, {
      runId: run.runId,
      artifactKey: '27-carbon-activities',
      entityType: 'carbon_activity_record',
      entityPk: activityId,
      sourceBatchId: activityBatchId,
      sourceRowNumber: activityRow
    });
    activityIds[key] = activityId;
    activityRow += 1;
    return activityId;
  };
  addActivity('p1', { energyTypeId: energyTypeIds.p1, activityValue: 1 });
  addActivity('p2', {
    energyTypeId: energyTypeIds.p2,
    startWallClock: '2026-01-01T00:30',
    endWallClock: '2026-01-01T08:30',
    startUtc: '2025-12-31T16:30:00Z',
    endUtc: '2026-01-01T00:30:00Z'
  });
  addActivity('p3', { energyTypeId: energyTypeIds.p3 });
  addActivity('p4', { energyTypeId: energyTypeIds.p4 });
  addActivity('missing', { energyTypeId: energyTypeIds.missing });
  // 正式重叠活动没有 source batch/ownership，exact 运行不得吸收。
  const formalActivityId = insertActivity(db, {
    code: 'CARBON-EXACT-FORMAL-ACTIVITY-SENTINEL',
    organizationUnitId,
    energyTypeId: energyTypeIds.p1,
    activityValue: 999
  });
  // 更高 ID 正式因子满足同一最高优先级，exact 运行仍必须只选 scope 内因子。
  const formalFactorId = insertFactor(db, {
    energyTypeId: energyTypeIds.p1,
    region: 'cn-exact',
    factorYear: 2026,
    factorValue: 999,
    source: 'formal-factor-sentinel'
  });
  return {
    run,
    factorBatchId,
    activityBatchId,
    organizationUnitId,
    energyTypeIds,
    factorIds,
    selectedP1FactorId,
    missingFactorId,
    activityIds,
    formalActivityId,
    formalFactorId
  };
}

/** 创建 5001 条 exact 活动的边界夹具。 */
function seedActivityLimitFixture(db, baselineRunId) {
  db.prepare("UPDATE demo_dataset_runs SET status = 'failed', failure_reason = 'limit-test' WHERE run_id = ?")
    .run(baselineRunId);
  const run = insertDemoRun(db, 'carbon-exact-limit-run');
  const factorBatchId = insertImportBatch(db, 'carbon_factor', 'exact-limit-factors');
  const activityBatchId = insertImportBatch(db, 'carbon_activity', 'exact-limit-activities');
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '11-carbon-factors',
    handlerKey: 'carbon-factors-import',
    batchId: factorBatchId
  });
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '27-carbon-activities',
    handlerKey: 'carbon-activity-import',
    batchId: activityBatchId
  });
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES ('CARBON-EXACT-LIMIT-OU', 'exact 上限组织', '/CARBON-EXACT-LIMIT-OU', 'department', 'active')`)
    .run().lastInsertRowid);
  const energyTypeId = insertEnergyType(db, 'carbon-exact-limit');
  const factorId = insertFactor(db, {
    sourceBatchId: factorBatchId,
    sourceRowNumber: 1,
    energyTypeId,
    region: 'default',
    factorYear: 2030,
    factorValue: 1,
    source: 'exact-limit-factor'
  });
  registerImportedOwnership(db, {
    runId: run.runId,
    artifactKey: '11-carbon-factors',
    entityType: 'carbon_factor',
    entityPk: factorId,
    sourceBatchId: factorBatchId,
    sourceRowNumber: 1
  });
  for (let index = 1; index <= CARBON_ACCOUNTING_ACTIVITY_LIMIT + 1; index += 1) {
    const activityId = insertActivity(db, {
      code: `CARBON-EXACT-LIMIT-${index}`,
      sourceBatchId: activityBatchId,
      sourceRowNumber: index,
      organizationUnitId,
      energyTypeId,
      factorRegion: 'default',
      startWallClock: '2030-01-01T08:00',
      endWallClock: '2030-01-01T09:00',
      startUtc: '2030-01-01T00:00:00Z',
      endUtc: '2030-01-01T01:00:00Z'
    });
    registerImportedOwnership(db, {
      runId: run.runId,
      artifactKey: '27-carbon-activities',
      entityType: 'carbon_activity_record',
      entityPk: activityId,
      sourceBatchId: activityBatchId,
      sourceRowNumber: index
    });
  }
  return run;
}

try {
  initDatabase();
  const db = openDatabase();
  try {
    const fixture = db.transaction(() => seedExactFixture(db)).immediate();
    const actorRow = db.prepare(`SELECT id AS userId, username, display_name AS displayName
      FROM sys_users WHERE username = 'admin'`).get();
    const actor = Object.freeze({ ...actorRow, ip: '127.0.0.1' });

    // 正常 exact 路径：时间窗服务端派生、四级优先级、tie-break、missing 和来源墙钟年份全部冻结。
    db.exec('BEGIN IMMEDIATE');
    let committedExecution;
    try {
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      assert.deepStrictEqual(Object.keys(built.exactScope), []);
      assert.deepStrictEqual(Object.keys(built.exactCapability), []);
      committedExecution = carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      });
      assert.strictEqual(db.inTransaction, true, 'exact executor 不得提交 caller transaction。');
      assert.strictEqual(committedExecution.calculationRun.activityCount, 5);
      assert.strictEqual(committedExecution.calculationRun.startUtc, '2025-12-31T16:30:00Z');
      assert.strictEqual(committedExecution.calculationRun.endUtc, '2026-01-01T01:00:00Z');
      assert.strictEqual(Object.hasOwn(committedExecution.calculationRun, 'calculationWitness'), false);
      assert.deepStrictEqual(Object.keys(committedExecution.calculationWitness), []);
      const rows = db.prepare(`SELECT activity_record_id AS activityRecordId,
          carbon_factor_id AS carbonFactorId, factor_year AS factorYear,
          factor_unit AS factorUnit, emission_unit AS emissionUnit,
          factor_snapshot_json AS factorSnapshotJson, formula_snapshot_json AS formulaSnapshotJson,
          emission_value AS emissionValue, match_priority AS matchPriority, status
        FROM carbon_accounting_results
        WHERE calculation_run_id = ? ORDER BY activity_record_id`)
        .all(committedExecution.calculationRun.id);
      const byActivityId = new Map(rows.map((row) => [Number(row.activityRecordId), row]));
      assert.strictEqual(byActivityId.has(fixture.formalActivityId), false,
        '正式重叠 activity 哨兵不得进入 exact 结果。');
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p1).carbonFactorId), fixture.selectedP1FactorId,
        '更高 ID 正式 factor 哨兵不得被 exact 匹配吸收。');
      assert.notStrictEqual(Number(byActivityId.get(fixture.activityIds.p1).carbonFactorId), fixture.formalFactorId);
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p1).matchPriority), 1);
      const p1Result = byActivityId.get(fixture.activityIds.p1);
      assert.strictEqual(Number(p1Result.emissionValue), 0.123457);
      assert.strictEqual(p1Result.factorUnit, 'kgCO2e');
      assert.strictEqual(p1Result.emissionUnit, 'kgCO2e');
      assert.strictEqual(JSON.parse(p1Result.factorSnapshotJson).factor.factorUnit, 'kgCO2e');
      assert.strictEqual(JSON.parse(p1Result.formulaSnapshotJson).factorUnit, 'kgCO2e');
      assert.strictEqual(JSON.parse(p1Result.formulaSnapshotJson).emissionUnit, 'kgCO2e');
      assert.deepStrictEqual(committedExecution.calculationRun.emissionTotals.totals, [{
        emissionUnit: 'kgCO2e', totalEmissionValue: 9.123457, calculatedCount: 4
      }]);
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p2).factorYear), 2026,
        '因子年份必须取来源墙钟年份而不是 UTC 年份。');
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p2).matchPriority), 2);
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p3).matchPriority), 3);
      assert.strictEqual(Number(byActivityId.get(fixture.activityIds.p4).matchPriority), 4);
      assert.strictEqual(byActivityId.get(fixture.activityIds.missing).status, 'factor_missing');
      assert.strictEqual(byActivityId.get(fixture.activityIds.missing).carbonFactorId, null);
      const audit = db.prepare(`SELECT detail_json AS detailJson FROM sys_operation_logs
        WHERE operation = 'carbon.accounting.run.create' AND target_id = ?`)
        .get(committedExecution.calculationRun.runCode);
      assert(audit);
      assert.strictEqual(JSON.stringify(JSON.parse(audit.detailJson)).includes('Witness'), false,
        '领域 audit 不得包含 calculation witness。');
      const witnessFacts = carbonAccountingExactProtocol.consumeCalculationWitnessInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        calculationWitness: committedExecution.calculationWitness
      });
      assert.strictEqual(witnessFacts.run.id, committedExecution.calculationRun.id);
      assert.deepStrictEqual([...witnessFacts.exactActivityRecordIds].sort((left, right) => left - right),
        Object.values(fixture.activityIds).sort((left, right) => left - right));
      assertErrorCode(() => carbonAccountingExactProtocol.consumeCalculationWitnessInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        calculationWitness: committedExecution.calculationWitness
      }), 'CARBON_ACCOUNTING_CALCULATION_WITNESS_REPLAY');
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
    const committedCounts = readWriteCounts(db);
    assert.deepStrictEqual(committedCounts, { runs: 1, results: 5, audits: 1 });

    // witness 事实异常必须回滚外层恢复 SAVEPOINT，调用方捕获后 COMMIT 仍只能得到原基线。
    const witnessFailureCases = [
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_FACT_MISMATCH',
        mutate(execution) {
          db.prepare(`UPDATE carbon_accounting_results SET emission_value = emission_value + 1
            WHERE id = (SELECT id FROM carbon_accounting_results
              WHERE calculation_run_id = ? AND status = 'calculated' ORDER BY id LIMIT 1)`)
            .run(execution.calculationRun.id);
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_INCOMPLETE',
        mutate(execution) {
          db.prepare(`DELETE FROM sys_operation_logs
            WHERE operation = 'carbon.accounting.run.create' AND target_id = ?`)
            .run(execution.calculationRun.runCode);
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_INCOMPLETE',
        mutate(execution) {
          db.prepare(`DELETE FROM carbon_accounting_results
            WHERE id = (SELECT id FROM carbon_accounting_results
              WHERE calculation_run_id = ? ORDER BY id LIMIT 1)`)
            .run(execution.calculationRun.id);
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_INCOMPLETE',
        mutate(execution) {
          insertExtraCalculationResult(db, execution.calculationRun.id, fixture.formalActivityId);
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_INTERNAL_ERROR',
        faultStage: 'exact-witness-before-read'
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_RECOVERY_FAILED',
        faultStage: 'exact-witness-before-recovery-rollback',
        mutate(execution) {
          db.prepare(`UPDATE carbon_accounting_results SET emission_value = emission_value + 1
            WHERE id = (SELECT id FROM carbon_accounting_results
              WHERE calculation_run_id = ? AND status = 'calculated' ORDER BY id LIMIT 1)`)
            .run(execution.calculationRun.id);
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_RECOVERY_FAILED',
        faultStage: 'exact-witness-before-recovery-release',
        mutate(execution) {
          db.prepare(`UPDATE carbon_accounting_results SET emission_value = emission_value + 1
            WHERE id = (SELECT id FROM carbon_accounting_results
              WHERE calculation_run_id = ? AND status = 'calculated' ORDER BY id LIMIT 1)`)
            .run(execution.calculationRun.id);
        }
      }
    ];
    witnessFailureCases.forEach((failureCase) => assertFailedWitnessCannotCommit({
      db,
      fixture,
      actor,
      baselineCounts: committedCounts,
      ...failureCase
    }));

    // witness 跨 caller transaction 必须在任何事实 prepare 前失败，并完整回滚新事务。
    db.exec('BEGIN IMMEDIATE');
    const crossTransactionWitness = executePendingExactCalculation(db, fixture, actor);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    assertFailsBeforeBusinessSql(db, () => (
      carbonAccountingExactProtocol.consumeCalculationWitnessInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: crossTransactionWitness.built.exactScope,
        calculationWitness: crossTransactionWitness.execution.calculationWitness
      })
    ), 'CARBON_ACCOUNTING_CALCULATION_WITNESS_TRANSACTION_MISMATCH', { expectedExecCount: 2 });
    assert.strictEqual(db.inTransaction, false,
      '跨事务 witness 必须 full rollback 当前事务，不能交回可提交状态。');
    assert.deepStrictEqual(readWriteCounts(db), committedCounts);

    // caller rollback 必须撤销 run/result/audit，executor 不得自行提交。
    db.exec('BEGIN IMMEDIATE');
    try {
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      });
      assert.deepStrictEqual(readWriteCounts(db), { runs: 2, results: 10, audits: 2 });
    } finally {
      db.exec('ROLLBACK');
    }
    assert.deepStrictEqual(readWriteCounts(db), committedCounts);

    // JSON clone、额外 ID 注入、run/actor clone、cross-db 均须在业务 SQL 前 fail-closed。
    db.exec('BEGIN IMMEDIATE');
    try {
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: JSON.parse(JSON.stringify(built.exactScope)),
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_CAPABILITY_REQUIRED');
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: JSON.parse(JSON.stringify(built.exactCapability))
      }), 'CARBON_ACCOUNTING_EXACT_CAPABILITY_REQUIRED');
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability,
        activityIds: [fixture.activityIds.p1]
      }), 'CARBON_ACCOUNTING_EXACT_EXECUTOR_INPUT_INVALID');
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: { ...fixture.run },
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_BINDING_MISMATCH');
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor: { ...actor },
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_BINDING_MISMATCH');
      const otherDb = openDatabase({
        databasePath: path.join(temporaryRoot, 'cross-database.sqlite')
      });
      try {
        otherDb.exec('BEGIN');
        assertFailsBeforeBusinessSql(otherDb, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
          db: otherDb,
          demoRun: fixture.run,
          actor,
          exactScope: built.exactScope,
          exactCapability: built.exactCapability
        }), 'CARBON_ACCOUNTING_EXACT_DATABASE_MISMATCH');
        otherDb.exec('ROLLBACK');
      } finally {
        otherDb.close();
      }
      const successful = carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      });
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_CAPABILITY_REPLAY');
      assert(successful.calculationWitness);
    } finally {
      db.exec('ROLLBACK');
    }
    assert.deepStrictEqual(readWriteCounts(db), committedCounts);

    // capability 跨 caller transaction 使用必须只执行 marker 校验，不得执行业务 prepare。
    db.exec('BEGIN IMMEDIATE');
    const crossTransactionBuilt = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
      db,
      demoRun: fixture.run,
      actor
    });
    db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    try {
      assertFailsBeforeBusinessSql(db, () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: crossTransactionBuilt.exactScope,
        exactCapability: crossTransactionBuilt.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_TRANSACTION_MISMATCH', { expectedExecCount: 1 });
    } finally {
      db.exec('ROLLBACK');
    }
    assert.deepStrictEqual(readWriteCounts(db), committedCounts);

    // 原始连接约束拒绝任意 wrapper，且 builder 不接受客户端期间、实体 ID 或 SQL。
    const wrappedDb = {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      get inTransaction() { return db.inTransaction; },
      get open() { return db.open; }
    };
    assertErrorCode(() => carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
      db: wrappedDb,
      demoRun: fixture.run,
      actor
    }), 'CARBON_ACCOUNTING_EXACT_DATABASE_REQUIRED');
    const proxiedDb = new Proxy(db, {});
    assertErrorCode(() => carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
      db: proxiedDb,
      demoRun: fixture.run,
      actor
    }), 'CARBON_ACCOUNTING_EXACT_DATABASE_REQUIRED');
    assertErrorCode(() => carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
      db,
      demoRun: fixture.run,
      actor,
      startUtc: '2020-01-01T00:00:00Z',
      activityIds: [],
      sql: 'SELECT 1'
    }), 'CARBON_ACCOUNTING_EXACT_BUILDER_INPUT_INVALID');

    // ownership/batch/identity/snapshot 和双向业务集合不一致均须在写入前阻断且零新增。
    const ownershipMismatchCases = [
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_BATCH_MISMATCH',
        mutate() {
          db.prepare(`UPDATE demo_data_registry SET source_row_number = source_row_number + 1000
            WHERE entity_type = 'carbon_activity_record' AND entity_pk = ?`)
            .run(String(fixture.activityIds.p1));
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_IDENTITY_DIGEST_MISMATCH',
        mutate() {
          db.prepare(`UPDATE demo_data_registry SET identity_digest = ?
            WHERE entity_type = 'carbon_activity_record' AND entity_pk = ?`)
            .run('0'.repeat(64), String(fixture.activityIds.p1));
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_SNAPSHOT_DIGEST_MISMATCH',
        mutate() {
          db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
            WHERE entity_type = 'carbon_factor' AND entity_pk = ?`)
            .run('f'.repeat(64), String(fixture.selectedP1FactorId));
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_OWNERSHIP_MISMATCH',
        mutate() {
          db.prepare(`UPDATE demo_data_registry SET ownership_kind = 'derived'
            WHERE entity_type = 'carbon_factor' AND entity_pk = ?`)
            .run(String(fixture.selectedP1FactorId));
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_BUSINESS_SET_MISMATCH',
        mutate() {
          insertActivity(db, {
            code: 'CARBON-EXACT-UNOWNED-BUSINESS-SENTINEL',
            sourceBatchId: fixture.activityBatchId,
            sourceRowNumber: 999,
            organizationUnitId: fixture.organizationUnitId,
            energyTypeId: fixture.energyTypeIds.p1
          });
        }
      },
      {
        expectedCode: 'CARBON_ACCOUNTING_EXACT_BUSINESS_SET_MISMATCH',
        mutate() {
          db.prepare(`DELETE FROM demo_data_registry
            WHERE entity_type = 'carbon_activity_record' AND entity_pk = ?`)
            .run(String(fixture.activityIds.p1));
        }
      }
    ];
    for (const mismatchCase of ownershipMismatchCases) {
      db.exec('BEGIN IMMEDIATE');
      try {
        mismatchCase.mutate();
        assertErrorCode(() => carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
          db,
          demoRun: fixture.run,
          actor
        }), mismatchCase.expectedCode);
        assert.deepStrictEqual(readWriteCounts(db), committedCounts);
      } finally {
        db.exec('ROLLBACK');
      }
    }

    // 已签发 scope 后业务 digest 变化必须按 stale 阻断，不能吸收更新后的因子。
    db.exec('BEGIN IMMEDIATE');
    try {
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      db.prepare('UPDATE carbon_factors SET factor_value = 0.75, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), fixture.selectedP1FactorId);
      refreshOwnershipSnapshotDigest(db, 'carbon_factor', fixture.selectedP1FactorId);
      assertErrorCode(() => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_EXACT_SCOPE_STALE');
      assert.deepStrictEqual(readWriteCounts(db), committedCounts);
    } finally {
      db.exec('ROLLBACK');
    }

    // ownership 投影允许重算历史事实，但进入正式计算 factor 边界时非法单位必须 409 且零写入。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE carbon_factors SET factor_unit = ?, updated_at = ? WHERE id = ?')
        .run('PRIVATE_LEGACY_UNIT', new Date().toISOString(), fixture.selectedP1FactorId);
      refreshOwnershipSnapshotDigest(db, 'carbon_factor', fixture.selectedP1FactorId);
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      assert.throws(() => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), (error) => error?.code === 'CARBON_FACTOR_UNIT_INVALID'
        && error?.statusCode === 409
        && JSON.stringify(error?.details) === JSON.stringify({ factorId: fixture.selectedP1FactorId })
        && !JSON.stringify(error).includes('PRIVATE_LEGACY_UNIT'));
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual(readWriteCounts(db), committedCounts);
    } finally {
      db.exec('ROLLBACK');
    }

    // non-finite 和 audit 故障必须只回滚私有写入，caller transaction 保持 active 且零新增。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE carbon_factors SET factor_value = ?, updated_at = ? WHERE id = ?')
        .run(1e308, new Date().toISOString(), fixture.selectedP1FactorId);
      refreshOwnershipSnapshotDigest(db, 'carbon_factor', fixture.selectedP1FactorId);
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      assertErrorCode(() => carbonAccountingExactProtocol.executeExactInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor,
        exactScope: built.exactScope,
        exactCapability: built.exactCapability
      }), 'CARBON_ACCOUNTING_NON_FINITE_RESULT');
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual(readWriteCounts(db), committedCounts);
    } finally {
      db.exec('ROLLBACK');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: fixture.run,
        actor
      });
      assertErrorCode(() => runWithFaultStages(
        ['exact-before-audit'],
        () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
          db,
          demoRun: fixture.run,
          actor,
          exactScope: built.exactScope,
          exactCapability: built.exactCapability
        })
      ), 'CARBON_ACCOUNTING_INTERNAL_ERROR');
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual(readWriteCounts(db), committedCounts);
    } finally {
      db.exec('ROLLBACK');
    }

    // executor 私有恢复的 ROLLBACK TO 或 RELEASE 失败时必须完整回滚，caller COMMIT 不得固化部分结果。
    [
      'exact-executor-before-recovery-rollback',
      'exact-executor-before-recovery-release'
    ].forEach((recoveryFaultStage) => assertFailedExecutorCannotCommit({
      db,
      fixture,
      actor,
      baselineCounts: committedCounts,
      recoveryFaultStage
    }));

    // 5001 条 exact 活动必须整体拒绝，不得静默截断或新增 run/result/audit。
    db.exec('BEGIN IMMEDIATE');
    try {
      const limitRun = seedActivityLimitFixture(db, fixture.run.runId);
      assertErrorCode(() => carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db,
        demoRun: limitRun,
        actor
      }), 'CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED');
      assert.deepStrictEqual(readWriteCounts(db), committedCounts);
    } finally {
      db.exec('ROLLBACK');
    }

    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // witness 私有回滚和完整回滚同时故障时必须关闭原连接。
    const witnessCloseDb = openDatabase();
    try {
      witnessCloseDb.exec('BEGIN IMMEDIATE');
      const closeFallbackPending = executePendingExactCalculation(witnessCloseDb, fixture, actor);
      witnessCloseDb.prepare(`UPDATE carbon_accounting_results SET emission_value = emission_value + 1
        WHERE id = (SELECT id FROM carbon_accounting_results
          WHERE calculation_run_id = ? AND status = 'calculated' ORDER BY id LIMIT 1)`)
        .run(closeFallbackPending.execution.calculationRun.id);
      assertErrorCode(() => runWithFaultStages(
        [
          'exact-witness-before-recovery-rollback',
          'exact-witness-before-full-rollback'
        ],
        () => carbonAccountingExactProtocol.consumeCalculationWitnessInCallerTransaction({
          db: witnessCloseDb,
          demoRun: fixture.run,
          actor,
          exactScope: closeFallbackPending.built.exactScope,
          calculationWitness: closeFallbackPending.execution.calculationWitness
        })
      ), 'CARBON_ACCOUNTING_CALCULATION_WITNESS_RECOVERY_FAILED');
      assert.strictEqual(witnessCloseDb.open, false, 'witness 完整回滚失败后必须关闭原连接。');
      assert.throws(() => witnessCloseDb.exec('COMMIT'), '已关闭 witness 连接不得接受 caller COMMIT。');
    } finally {
      if (witnessCloseDb.open) witnessCloseDb.close();
    }
    assert.deepStrictEqual(readWriteCounts(db), committedCounts,
      'witness 连接关闭必须由 SQLite 自动回滚半成品事务。');

    // executor 私有回滚和完整回滚同时故障时也必须关闭原连接。
    const executorCloseDb = openDatabase();
    try {
      executorCloseDb.exec('BEGIN IMMEDIATE');
      const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
        db: executorCloseDb,
        demoRun: fixture.run,
        actor
      });
      assertErrorCode(() => runWithFaultStages(
        [
          'exact-before-audit',
          'exact-executor-before-recovery-rollback',
          'exact-executor-before-full-rollback'
        ],
        () => carbonAccountingExactProtocol.executeExactInCallerTransaction({
          db: executorCloseDb,
          demoRun: fixture.run,
          actor,
          exactScope: built.exactScope,
          exactCapability: built.exactCapability
        })
      ), 'CARBON_ACCOUNTING_EXACT_EXECUTOR_RECOVERY_FAILED');
      assert.strictEqual(executorCloseDb.open, false, 'executor 完整回滚失败后必须关闭原连接。');
      assert.throws(() => executorCloseDb.exec('COMMIT'), '已关闭 executor 连接不得接受 caller COMMIT。');
    } finally {
      if (executorCloseDb.open) executorCloseDb.close();
    }
    assert.deepStrictEqual(readWriteCounts(db), committedCounts,
      'executor 连接关闭必须由 SQLite 自动回滚部分 run/results。');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    console.log('carbonAccountingExactCalculation tests passed');
  } finally {
    if (db.open) db.close();
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
