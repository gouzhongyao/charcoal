'use strict';

const carbonTestBootstrap = require('./helpers/carbonAccountingFaultHarness');
if (!carbonTestBootstrap.fixedIsolatedChild && module.parent) {
  throw new Error('Carbon 固定测试入口不允许被普通模块间接加载。');
}
const { runFixedCarbonAccountingTest } = carbonTestBootstrap;
// Carbon 与 ownership 私有能力只注入隔离子进程中的当前固定测试 Module。
const fixedCarbonTestResult = runFixedCarbonAccountingTest('carbon-accounting-derived-ownership');
if (fixedCarbonTestResult.delegated) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-ownership-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'bootstrap.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonOwner123!';

const { initDatabase, openDatabase } = require('../db/database');
const {
  carbonAccountingExactProtocol,
  carbonAccountingOwnershipProtocol,
  carbonAccountingOwnershipService,
  carbonCalculationRunService,
  runWithCarbonAccountingFaultInjectorForTest
} = require('./helpers/carbonAccountingFaultHarness');
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

const DEMO_MANIFEST_DIGEST = getDemoParkManifestDigest();

/** 生成稳定 SHA-256 测试值。 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 断言函数抛出指定稳定错误码。 */
function assertErrorCode(callback, expectedCode) {
  assert.throws(callback, (error) => (
    error?.code === expectedCode || error?.details?.code === expectedCode
  ));
}

/** 断言公开 capability/receipt 只是无字段、无 Symbol、不可序列化私有状态的空壳。 */
function assertOpaqueCarbonOwnershipValue(value, label) {
  assert.deepStrictEqual(Object.keys(value), [], `${label} 不得公开可枚举字段。`);
  assert.deepStrictEqual(Object.getOwnPropertyNames(value), [], `${label} 不得公开自有字段。`);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(value), [], `${label} 不得公开 Symbol。`);
  assert.strictEqual(JSON.stringify(value), '{}', `${label} 序列化不得泄露私有 state。`);
}

/** 在私有 ALS 测试作用域中注入固定 ownership 故障阶段。 */
function runWithOwnershipFaultStages(faultStages, operation) {
  const expectedStages = new Set(faultStages);
  return runWithCarbonAccountingFaultInjectorForTest((event) => {
    assert.deepStrictEqual(Object.keys(event).sort(), ['stage', 'summary']);
    assert(Object.isFrozen(event));
    assert(Object.isFrozen(event.summary));
    assert.deepStrictEqual(event.summary, {});
    assert.strictEqual('db' in event, false);
    assert.strictEqual('state' in event, false);
    assert.strictEqual('scope' in event, false);
    assert.strictEqual('capability' in event, false);
    assert.strictEqual('witness' in event, false);
    assert.strictEqual('receipt' in event, false);
    if (expectedStages.has(event.stage)) {
      const error = new Error('injected carbon ownership fault');
      error.code = 'INJECTED_CARBON_OWNERSHIP_FAULT';
      throw error;
    }
  }, operation);
}

/** 创建独立临时 SQLite 测试夹具。 */
function createHarness(name) {
  const databasePath = path.join(temporaryRoot, `${name}.sqlite`);
  initDatabase({ databasePath });
  const db = openDatabase({ databasePath });
  const actorRow = db.prepare(`SELECT id AS userId, username, display_name AS displayName
    FROM sys_users WHERE username = 'admin'`).get();
  const actor = Object.freeze({ ...actorRow, ip: '127.0.0.1' });
  const fixture = seedFixture(db, name, actor.userId);
  return { db, actor, fixture, databasePath };
}

/** 创建能源类型。 */
function insertEnergyType(db, code) {
  return Number(db.prepare(`INSERT INTO energy_types
    (code, name, category, default_unit, standard_unit, carbon_factor_required, is_active, display_order)
    VALUES (?, ?, 'other', 'unit', 'unit', 1, 1, 990)`).run(
    code,
    `ownership 能源-${code}`
  ).lastInsertRowid);
}

/** 创建正式导入批次。 */
function insertImportBatch(db, importType, suffix) {
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count)
    VALUES (?, ?, 'xlsx', 'completed', 'execute', 0, 0, 0, 0)`).run(
    importType,
    `${suffix}.xlsx`
  ).lastInsertRowid);
}

/** 创建当前 canonical demo run。 */
function insertDemoRun(db, runId, actorUserId) {
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
    runId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    DEMO_MANIFEST_DIGEST,
    actorUserId,
    createdAt
  );
  return Object.freeze({
    runId,
    datasetId: DEMO_DATASET_ID,
    manifestVersion: DEMO_MANIFEST_VERSION,
    manifestDigest: DEMO_MANIFEST_DIGEST,
    status: 'active',
    createdBy: actorUserId,
    createdAt
  });
}

/** 创建已执行 context 和 primary batch 绑定。 */
function bindArtifactBatch(db, input) {
  const contextId = `context-${input.runId}-${input.artifactKey}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
     artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
     status, issued_at, expires_at, upload_file_sha256, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'executed', ?, ?, ?, ?)`).run(
    contextId,
    sha256(`token-${contextId}`),
    input.runId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    DEMO_MANIFEST_DIGEST,
    input.artifactKey,
    input.handlerKey,
    sha256(`artifact-${contextId}`),
    input.actorUserId,
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
}

/** 登记 active imported ownership。 */
function registerImportedOwnership(db, input) {
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[input.entityType];
  const projection = handler.readProjection(db, input.entityPk);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)`).run(
    input.runId,
    input.artifactKey,
    input.entityType,
    String(input.entityPk),
    calculateDemoEntityIdentityDigest(input.entityType, String(input.entityPk)),
    calculateDemoEntitySnapshotDigest(input.entityType, String(input.entityPk), projection),
    input.sourceBatchId,
    input.sourceRowNumber,
    input.actorUserId
  );
}

/** 创建 executing carbon action run 固定投影。 */
function insertActionRun(db, run, actorUserId, suffix) {
  const now = new Date().toISOString();
  const actionRun = Object.freeze({
    actionRunId: `carbon-action-${suffix}`,
    runId: run.runId,
    datasetId: run.datasetId,
    actionKey: 'carbon-accounting-run',
    requestedBy: actorUserId,
    status: 'executing'
  });
  db.prepare(`INSERT INTO demo_post_action_runs
    (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
     executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
     runtime_epoch, runtime_revision, input_digest, preview_digest, output_count,
     preview_expires_at, input_json, requested_by, status, created_at, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-registry:v1', 'test-resolver:v1',
      'carbon-accounting-executor:not-connected', ?, ?, ?, ?, 1, 1, ?, ?, 0,
      ?, '{}', ?, 'executing', ?, ?, ?)`).run(
    actionRun.actionRunId,
    run.runId,
    run.datasetId,
    actionRun.actionKey,
    `request-${suffix}`,
    run.manifestVersion,
    run.manifestDigest,
    sha256(`registry-${suffix}`),
    sha256(`input-${suffix}`),
    sha256(`preview-${suffix}`),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    actorUserId,
    now,
    now,
    now
  );
  return actionRun;
}

/** 创建计算因子。 */
function insertFactor(db, input) {
  return Number(db.prepare(`INSERT INTO carbon_factors
    (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
     factor_value, factor_unit, source, effective_from, effective_to, is_active)
    VALUES (?, ?, ?, ?, 2026, 'unit', ?, 'kgCO2e', ?, '2000-01-01', '2099-12-31', 1)`).run(
    input.batchId,
    input.rowNumber,
    input.energyTypeId,
    input.region,
    input.factorValue,
    input.source
  ).lastInsertRowid);
}

/** 创建 active independent activity。 */
function insertActivity(db, input) {
  return Number(db.prepare(`INSERT INTO carbon_activity_records
    (source_type, source_batch_id, source_row_number, energy_record_id,
     activity_code, activity_code_key, emission_scope, activity_category,
     activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
     end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
     factor_region, source_reference, duplicate_key, record_status)
    VALUES ('independent_activity', ?, ?, NULL, ?, ?, 'scope_1', ?, ?, ?, ?,
      ?, ?, 'Asia/Shanghai', ?, ?, ?, 'unit', ?, ?, ?, 'active')`).run(
    input.batchId,
    input.rowNumber,
    input.code,
    input.code.toLowerCase(),
    `类别-${input.code}`,
    `category-${input.code.toLowerCase()}`,
    input.organizationUnitId,
    input.energyTypeId,
    input.startWallClock,
    input.endWallClock,
    input.startUtc,
    input.endUtc,
    input.activityValue,
    input.region,
    `source-${input.code}`,
    sha256(`duplicate-${input.code}`)
  ).lastInsertRowid);
}

/** 创建 calculated、missing 和正式哨兵组成的 exact ownership 夹具。 */
function seedFixture(db, suffix, actorUserId) {
  const run = insertDemoRun(db, `carbon-ownership-${suffix}`, actorUserId);
  const factorBatchId = insertImportBatch(db, 'carbon_factor', `${suffix}-factors`);
  const activityBatchId = insertImportBatch(db, 'carbon_activity', `${suffix}-activities`);
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '11-carbon-factors',
    handlerKey: 'carbon-factors-import',
    batchId: factorBatchId,
    actorUserId
  });
  bindArtifactBatch(db, {
    runId: run.runId,
    artifactKey: '27-carbon-activities',
    handlerKey: 'carbon-activity-import',
    batchId: activityBatchId,
    actorUserId
  });
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, ?, ?, 'department', 'active')`).run(
    `OWN-${suffix}`,
    `ownership 组织-${suffix}`,
    `/OWN-${suffix}`
  ).lastInsertRowid);
  const calculatedEnergyTypeId = insertEnergyType(db, `owner-calculated-${suffix}`);
  const missingEnergyTypeId = insertEnergyType(db, `owner-missing-${suffix}`);
  const factorId = insertFactor(db, {
    batchId: factorBatchId,
    rowNumber: 1,
    energyTypeId: calculatedEnergyTypeId,
    region: 'cn-owner',
    factorValue: 0.25,
    source: `factor-${suffix}`
  });
  registerImportedOwnership(db, {
    runId: run.runId,
    artifactKey: '11-carbon-factors',
    entityType: 'carbon_factor',
    entityPk: factorId,
    sourceBatchId: factorBatchId,
    sourceRowNumber: 1,
    actorUserId
  });
  const calculatedActivityId = insertActivity(db, {
    batchId: activityBatchId,
    rowNumber: 1,
    code: `CALC-${suffix}`,
    organizationUnitId,
    energyTypeId: calculatedEnergyTypeId,
    startWallClock: '2026-01-01T08:00',
    endWallClock: '2026-01-01T09:00',
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-01T01:00:00Z',
    activityValue: 8,
    region: 'cn-owner'
  });
  const missingActivityId = insertActivity(db, {
    batchId: activityBatchId,
    rowNumber: 2,
    code: `MISS-${suffix}`,
    organizationUnitId,
    energyTypeId: missingEnergyTypeId,
    startWallClock: '2026-01-02T08:00',
    endWallClock: '2026-01-02T10:00',
    startUtc: '2026-01-02T00:00:00Z',
    endUtc: '2026-01-02T02:00:00Z',
    activityValue: 3,
    region: 'cn-owner'
  });
  [calculatedActivityId, missingActivityId].forEach((entityPk, index) => {
    registerImportedOwnership(db, {
      runId: run.runId,
      artifactKey: '27-carbon-activities',
      entityType: 'carbon_activity_record',
      entityPk,
      sourceBatchId: activityBatchId,
      sourceRowNumber: index + 1,
      actorUserId
    });
  });
  const formalFactorId = Number(db.prepare(`INSERT INTO carbon_factors
    (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
    VALUES (?, 'cn-owner', 2026, 'unit', 999, 'kgCO2e', 'formal-sentinel', 1)`).run(
    calculatedEnergyTypeId
  ).lastInsertRowid);
  const actionRun = insertActionRun(db, run, actorUserId, suffix);
  return {
    run,
    actionRun,
    factorId,
    formalFactorId,
    calculatedActivityId,
    missingActivityId
  };
}

/** 执行 exact 并签发尚未登记的 registration scope，可传入同身份可变 demo run 验证快照隔离。 */
function issuePendingOwnershipRegistration(db, fixture, actor, demoRun = fixture.run) {
  const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
    db,
    demoRun,
    actor
  });
  const execution = carbonAccountingExactProtocol.executeExactInCallerTransaction({
    db,
    demoRun,
    actor,
    exactScope: built.exactScope,
    exactCapability: built.exactCapability
  });
  const binding = {
    db,
    demoRun,
    actionRun: fixture.actionRun,
    actor,
    exactScope: built.exactScope,
    calculationWitness: execution.calculationWitness
  };
  const registrationScope = carbonAccountingOwnershipProtocol
    .issueRegistrationScopeInCallerTransaction(binding);
  return { built, execution, binding, registrationScope };
}

/** 执行 exact、签发 scope 并登记 derived ownership。 */
function registerPendingOwnership(db, fixture, actor) {
  const pending = issuePendingOwnershipRegistration(db, fixture, actor);
  const registrationReceipt = carbonAccountingOwnershipProtocol
    .registerDerivedOwnershipInCallerTransaction({
      ...pending.binding,
      registrationScope: pending.registrationScope
    });
  return { ...pending, registrationReceipt };
}

/** 读取 derived registry 和 relation 数量。 */
function readDerivedCounts(db) {
  return {
    registries: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE ownership_kind = 'derived'`).get().total),
    relations: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total)
  };
}

/** 读取 handoff 失败后必须整体回到零的 calculation、audit 与 derived 写入数量。 */
function readCarbonHandoffWriteCounts(db) {
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
    results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
    audits: Number(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.accounting.run.create'`).get().total),
    ...readDerivedCounts(db)
  };
}

/** 捕获 ownership 错误并确认公开错误不包含内部 SQL、SAVEPOINT 名称或对象。 */
function captureCarbonOwnershipError(callback, expectedCode) {
  let captured = null;
  try {
    callback();
  } catch (error) {
    captured = error;
  }
  assert(captured, 'ownership 故障必须抛出稳定错误。');
  assert.strictEqual(captured.code, expectedCode);
  const publicErrorText = JSON.stringify({
    code: captured.code,
    message: captured.message,
    details: captured.details
  });
  assert.strictEqual(/(?:SAVEPOINT|SELECT|INSERT|UPDATE|DELETE|ROLLBACK|RELEASE)\s+[A-Za-z_]/i
    .test(publicErrorText), false);
  assert.strictEqual(publicErrorText.includes('carbon_ownership_'), false);
  assert.strictEqual(publicErrorText.includes('simulated'), false);
  assert.strictEqual(publicErrorText.includes('[object Object]'), false);
  return captured;
}

/** 捕获 registrar handoff 固定错误并锁定公开 details 仅含安全错误码槽位。 */
function captureCarbonHandoffError(callback) {
  const captured = captureCarbonOwnershipError(
    callback,
    'CARBON_ACCOUNTING_REGISTRAR_HANDOFF_FAILED'
  );
  assert.deepStrictEqual(
    Object.keys(captured.details).sort(),
    ['closeCode', 'fullRollbackCode', 'originalCode']
  );
  return captured;
}

/** 断言公开 ownership 错误不包含指定内部持久化字段值。 */
function assertCarbonOwnershipErrorHidesValues(error, values) {
  const publicErrorText = JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details
  });
  values.forEach((value) => {
    assert.strictEqual(
      publicErrorText.includes(String(value)),
      false,
      'ownership 公开错误不得泄露内部持久化字段值。'
    );
  });
}

/** 断言 fail-closed 后原连接不可提交，且新连接重读全部目标写入为零。 */
function assertCarbonHandoffPersistenceIsEmpty(db, databasePath) {
  assert.strictEqual(db.inTransaction, false, 'handoff 故障后不得保留可提交事务。');
  assert.throws(() => db.exec('COMMIT'), 'handoff 故障后 caller COMMIT 必须失败。');
  if (db.open) {
    assert.deepStrictEqual(readCarbonHandoffWriteCounts(db), {
      runs: 0,
      results: 0,
      audits: 0,
      registries: 0,
      relations: 0
    });
  }
  const observerDb = openDatabase({ databasePath });
  try {
    assert.deepStrictEqual(readCarbonHandoffWriteCounts(observerDb), {
      runs: 0,
      results: 0,
      audits: 0,
      registries: 0,
      relations: 0
    });
  } finally {
    observerDb.close();
  }
}

/** 断言 mutation 失败仍由 caller 持有外层事务，且独立连接始终观察不到未提交业务写入。 */
function assertCarbonMutationFailureIsUncommitted(db, databasePath, expectedLocalCounts, label) {
  assert.strictEqual(db.inTransaction, true, `${label} 不得错误结束或提交 caller 外层事务。`);
  assert.deepStrictEqual(
    readCarbonHandoffWriteCounts(db),
    expectedLocalCounts,
    `${label} 私有恢复边界必须回滚 derived ownership，但保留 caller 可回滚的 calculation 事实。`
  );
  const beforeRollbackObserver = openDatabase({ databasePath });
  try {
    assert.deepStrictEqual(readCarbonHandoffWriteCounts(beforeRollbackObserver), {
      runs: 0,
      results: 0,
      audits: 0,
      registries: 0,
      relations: 0
    }, `${label} 独立连接不得观察到任何未提交 calculation/ownership/relation。`);
  } finally {
    beforeRollbackObserver.close();
  }
  db.exec('ROLLBACK');
  assert.strictEqual(db.inTransaction, false, `${label} caller rollback 必须结束外层事务。`);
  assert.throws(() => db.exec('COMMIT'), `${label} rollback 后不得存在可提交事务。`);
  const afterRollbackObserver = openDatabase({ databasePath });
  try {
    assert.deepStrictEqual(readCarbonHandoffWriteCounts(afterRollbackObserver), {
      runs: 0,
      results: 0,
      audits: 0,
      registries: 0,
      relations: 0
    }, `${label} caller rollback 后物理事实必须保持零残留。`);
  } finally {
    afterRollbackObserver.close();
  }
}

/** 仅允许篡改 calculated 结果的 factor/formula 单位快照 JSON。 */
function mutateCalculatedResultUnitSnapshot(db, calculationRunId, columnName, mutateSnapshot) {
  assert(['factor_snapshot_json', 'formula_snapshot_json'].includes(columnName));
  const row = db.prepare(`SELECT id, ${columnName} AS snapshotJson
    FROM carbon_accounting_results
    WHERE calculation_run_id = ? AND status = 'calculated'`).get(calculationRunId);
  assert(row, `${columnName} mutation 必须命中 calculated 结果。`);
  const snapshot = JSON.parse(row.snapshotJson);
  mutateSnapshot(snapshot);
  const updated = db.prepare(`UPDATE carbon_accounting_results SET ${columnName} = ? WHERE id = ?`)
    .run(JSON.stringify(snapshot), row.id);
  assert.strictEqual(updated.changes, 1, `${columnName} mutation 必须只改写一条持久化结果。`);
}

/** 插入指定 run/artifact 范围的测试 derived registry。 */
function insertTestDerivedRegistry(db, input) {
  const inserted = db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, registered_by, registered_at)
    VALUES (?, ?, ?, ?, 'derived', ?, ?, ?, ?)`).run(
    input.runId,
    input.artifactKey,
    input.entityType,
    input.entityPk,
    sha256(`identity-${input.entityType}-${input.entityPk}`),
    sha256(`snapshot-${input.entityType}-${input.entityPk}`),
    input.actorUserId,
    new Date().toISOString()
  );
  return Number(inserted.lastInsertRowid);
}

/** 复制既有结果并改用非 exact 活动标识，构造多余结果集合。 */
function insertExtraCarbonResult(db, calculationRunId) {
  const sourceRow = db.prepare(`SELECT * FROM carbon_accounting_results
    WHERE calculation_run_id = ? ORDER BY id LIMIT 1`).get(calculationRunId);
  const insertRow = { ...sourceRow };
  delete insertRow.id;
  insertRow.activity_record_id = Number(insertRow.activity_record_id) + 1000000;
  const fields = Object.keys(insertRow);
  db.prepare(`INSERT INTO carbon_accounting_results
    (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(
    ...fields.map((fieldName) => insertRow[fieldName])
  );
}

/** 运行单个隔离夹具并确保连接关闭。 */
function withHarness(name, callback) {
  const harness = createHarness(name);
  try {
    callback(harness);
  } finally {
    if (harness.db.open) {
      if (harness.db.inTransaction) harness.db.exec('ROLLBACK');
      harness.db.close();
    }
  }
}

try {
  assert(Object.isFrozen(carbonAccountingOwnershipProtocol));
  assert.deepStrictEqual(Object.keys(carbonAccountingOwnershipService), []);
  assert.strictEqual(Object.keys(carbonCalculationRunService)
    .includes('inspectRegistrationContextInCallerTransaction'), false);
  [
    carbonAccountingOwnershipService,
    require('../services/carbonAccountingOwnershipProtocol')
  ].forEach((productionModule) => {
    Reflect.ownKeys(productionModule).forEach((key) => {
      const keyText = typeof key === 'symbol' ? String(key.description || '') : String(key);
      assert(!/fault|ForTest|setFaultInjector|testInternal|ownershipProtocolTest/i.test(keyText),
        `ownership production own key 不得暴露测试故障控制面：${keyText}`);
      const value = Object.getOwnPropertyDescriptor(productionModule, key)?.value;
      if (value && (typeof value === 'object' || typeof value === 'function')) {
        Reflect.ownKeys(value).forEach((nestedKey) => {
          const nestedText = typeof nestedKey === 'symbol'
            ? String(nestedKey.description || '')
            : String(nestedKey);
          assert(!/fault|ForTest|setFaultInjector|runWith.*Injector|testInternal/i.test(nestedText),
            `ownership production value 不得暴露测试故障入口：${nestedText}`);
        });
      }
    });
  });
  [
    'charcoal.carbonAccounting.ownershipTestInternal.v1',
    'charcoal.carbonAccounting.ownershipProtocolTest.v1'
  ].forEach((symbolName) => {
    assert.strictEqual(carbonAccountingOwnershipService[Symbol.for(symbolName)], undefined);
    assert.strictEqual(require('../services/carbonAccountingOwnershipProtocol')[Symbol.for(symbolName)], undefined);
  });

  // 成功路径同时覆盖 calculated、factor_missing、正式因子哨兵隔离、固定 relation 闭包和 caller commit。
  withHarness('success', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = registerPendingOwnership(db, fixture, actor);
    assertOpaqueCarbonOwnershipValue(pending.registrationScope, 'registration scope');
    assertOpaqueCarbonOwnershipValue(pending.registrationReceipt, 'registration receipt');
    assert.strictEqual(carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope,
        registrationReceipt: pending.registrationReceipt
      }), true);
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 3, relations: 5 });
    const factorRelations = db.prepare(`SELECT source.entity_pk AS factorPk
      FROM demo_data_relations relation
      JOIN demo_data_registry source ON source.registry_id = relation.to_registry_id
      WHERE relation.relation_type = 'uses_factor'`).all();
    assert.deepStrictEqual(factorRelations.map((row) => Number(row.factorPk)), [fixture.factorId]);
    assert.strictEqual(factorRelations.some((row) => Number(row.factorPk) === fixture.formalFactorId), false);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
      JOIN demo_data_registry target ON target.registry_id = relation.from_registry_id
      WHERE relation.relation_type = 'uses_factor'
        AND target.entity_type = 'carbon_accounting_result'`).get().total, 1);
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope,
        registrationReceipt: pending.registrationReceipt
      }), 'CARBON_ACCOUNTING_RECEIPT_REPLAY');
    db.exec('COMMIT');
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 3, relations: 5 });
    assert.strictEqual(db.prepare(`SELECT status FROM demo_post_action_runs
      WHERE action_run_id = ?`).get(fixture.actionRun.actionRunId).status, 'executing',
    '阶段 C 不得切换 not-connected action 状态。');
  });

  // caller rollback 必须同时撤销 calculation 和 derived ownership。
  withHarness('rollback', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = registerPendingOwnership(db, fixture, actor);
    carbonAccountingOwnershipProtocol.verifyRegistrationReceiptInCallerTransaction({
      ...pending.binding,
      registrationScope: pending.registrationScope,
      registrationReceipt: pending.registrationReceipt
    });
    db.exec('ROLLBACK');
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 0);
  });

  // scope clone、Proxy、run/actor/action clone 在 registrar 任何新业务 SQL 前拒绝。
  withHarness('capability', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
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
    const binding = {
      db,
      demoRun: fixture.run,
      actionRun: fixture.actionRun,
      actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction({
        ...binding,
        demoRun: { ...fixture.run }
      }), 'CARBON_ACCOUNTING_REGISTRATION_BINDING_MISMATCH');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction({
        ...binding,
        actor: { ...actor }
      }), 'CARBON_ACCOUNTING_REGISTRATION_BINDING_MISMATCH');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction({
        ...binding,
        actionRun: new Proxy(fixture.actionRun, {})
      }), 'CARBON_ACCOUNTING_ACTION_RUN_OBJECT_INVALID');
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({
        ...binding,
        actionRun: { ...fixture.actionRun },
        registrationScope
      }), 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_BINDING_MISMATCH');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({
        ...binding,
        registrationScope: JSON.parse(JSON.stringify(registrationScope))
      }), 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_REQUIRED');
    const receipt = carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope });
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...binding,
        registrationScope,
        registrationReceipt: JSON.parse(JSON.stringify(receipt))
      }), 'CARBON_ACCOUNTING_RECEIPT_REQUIRED');
    carbonAccountingOwnershipProtocol.verifyRegistrationReceiptInCallerTransaction({
      ...binding,
      registrationScope,
      registrationReceipt: receipt
    });
    db.exec('ROLLBACK');
  });

  // RF-P2-134：witness 签发后由 registrar 对真实 result/run 单位闭包 mutation fail-closed。
  const mutatedEmissionUnit = 'tCO2e';
  const expectedUncommittedCalculationCounts = Object.freeze({
    runs: 1,
    results: 2,
    audits: 1,
    registries: 0,
    relations: 0
  });
  const carbonUnitClosureMutationCases = [
    {
      name: 'result-factor-unit',
      registrarExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      receiptExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      mutate(db, pending) {
        const updated = db.prepare(`UPDATE carbon_accounting_results SET factor_unit = ?
          WHERE calculation_run_id = ? AND status = 'calculated'`).run(
          mutatedEmissionUnit,
          pending.execution.calculationRun.id
        );
        assert.strictEqual(updated.changes, 1, 'factor_unit mutation 必须命中唯一 calculated 结果。');
      }
    },
    {
      name: 'result-emission-unit',
      registrarHandoffOriginalCode: 'CARBON_ACCOUNTING_CALCULATION_WITNESS_FACT_MISMATCH',
      receiptExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      mutate(db, pending) {
        const updated = db.prepare(`UPDATE carbon_accounting_results SET emission_unit = ?
          WHERE calculation_run_id = ? AND status = 'calculated'`).run(
          mutatedEmissionUnit,
          pending.execution.calculationRun.id
        );
        assert.strictEqual(updated.changes, 1, 'emission_unit mutation 必须命中唯一 calculated 结果。');
      }
    },
    {
      name: 'factor-snapshot-unit',
      registrarExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      receiptExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      mutate(db, pending) {
        mutateCalculatedResultUnitSnapshot(
          db,
          pending.execution.calculationRun.id,
          'factor_snapshot_json',
          (snapshot) => {
            snapshot.factor.factorUnit = mutatedEmissionUnit;
          }
        );
      }
    },
    {
      name: 'formula-snapshot-unit',
      registrarExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      receiptExpectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      mutate(db, pending) {
        mutateCalculatedResultUnitSnapshot(
          db,
          pending.execution.calculationRun.id,
          'formula_snapshot_json',
          (snapshot) => {
            snapshot.emissionUnit = mutatedEmissionUnit;
          }
        );
      }
    },
    {
      name: 'run-emission-totals-unit',
      registrarExpectedCode: 'CARBON_ACCOUNTING_RUN_FACTS_INVALID',
      receiptExpectedCode: 'CARBON_ACCOUNTING_RUN_FACTS_INVALID',
      mutate(db, pending) {
        const calculationRunId = pending.execution.calculationRun.id;
        const row = db.prepare(`SELECT emission_totals_json AS emissionTotalsJson
          FROM carbon_calculation_runs WHERE id = ?`).get(calculationRunId);
        const emissionTotals = JSON.parse(row.emissionTotalsJson);
        assert.strictEqual(emissionTotals.totals.length, 1, 'totals mutation 夹具必须只有一个 calculated 单位。');
        emissionTotals.totals[0].emissionUnit = mutatedEmissionUnit;
        const updated = db.prepare(`UPDATE carbon_calculation_runs SET emission_totals_json = ?
          WHERE id = ?`).run(JSON.stringify(emissionTotals), calculationRunId);
        assert.strictEqual(updated.changes, 1, 'emission_totals_json mutation 必须命中唯一 calculation run。');
      }
    }
  ];
  carbonUnitClosureMutationCases.forEach((failureCase) => {
    withHarness(`rf-p2-134-registrar-${failureCase.name}`, ({
      db,
      actor,
      fixture,
      databasePath
    }) => {
      db.exec('BEGIN IMMEDIATE');
      const pending = issuePendingOwnershipRegistration(db, fixture, actor);
      failureCase.mutate(db, pending);
      if (failureCase.registrarHandoffOriginalCode) {
        const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
          .registerDerivedOwnershipInCallerTransaction({
            ...pending.binding,
            registrationScope: pending.registrationScope
          }));
        assert.strictEqual(
          handoffError.details.originalCode,
          failureCase.registrarHandoffOriginalCode,
          `${failureCase.name} 必须由 witness/registrar handoff 拒绝。`
        );
        assert.strictEqual(
          handoffError.details.fullRollbackCode,
          null,
          `${failureCase.name} 完整回滚不得产生恢复错误。`
        );
        assert.strictEqual(
          handoffError.details.closeCode,
          null,
          `${failureCase.name} 完整回滚成功时不得尝试以关闭异常兜底。`
        );
        assert.strictEqual(db.open, true, `${failureCase.name} 完整回滚成功后必须保留原连接。`);
        assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
        return;
      }
      assertErrorCode(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }), failureCase.registrarExpectedCode);
      assertCarbonMutationFailureIsUncommitted(
        db,
        databasePath,
        expectedUncommittedCalculationCounts,
        `registrar ${failureCase.name}`
      );
    });
  });

  // RF-P2-134：registration 后再次篡改同一真实投影，receipt verifier 必须回滚 derived 写入。
  carbonUnitClosureMutationCases.forEach((failureCase) => {
    withHarness(`rf-p2-134-receipt-${failureCase.name}`, ({
      db,
      actor,
      fixture,
      databasePath
    }) => {
      db.exec('BEGIN IMMEDIATE');
      const pending = registerPendingOwnership(db, fixture, actor);
      failureCase.mutate(db, pending);
      assertErrorCode(() => carbonAccountingOwnershipProtocol
        .verifyRegistrationReceiptInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope,
          registrationReceipt: pending.registrationReceipt
        }), failureCase.receiptExpectedCode);
      assertCarbonMutationFailureIsUncommitted(
        db,
        databasePath,
        expectedUncommittedCalculationCounts,
        `receipt verifier ${failureCase.name}`
      );
    });
  });

  // audit 删除、projection 漂移与 relation 闭包破坏均回滚 derived 写入。
  const receiptFailureCases = [
    {
      name: 'audit-delete',
      expectedCode: 'CARBON_ACCOUNTING_DOMAIN_AUDIT_INVALID',
      mutate(db, pending) {
        db.prepare(`DELETE FROM sys_operation_logs
          WHERE operation = 'carbon.accounting.run.create'
            AND target_id = ?`).run(pending.execution.calculationRun.runCode);
      }
    },
    {
      name: 'audit-rewrite',
      expectedCode: 'CARBON_ACCOUNTING_DOMAIN_AUDIT_INVALID',
      mutate(db, pending) {
        db.prepare(`UPDATE sys_operation_logs SET detail_json = '{}'
          WHERE operation = 'carbon.accounting.run.create'
            AND target_id = ?`).run(pending.execution.calculationRun.runCode);
      }
    },
    {
      name: 'result-extra',
      expectedCode: 'CARBON_ACCOUNTING_RESULT_SET_MISMATCH',
      mutate(db, pending) {
        insertExtraCarbonResult(db, pending.execution.calculationRun.id);
      }
    },
    {
      name: 'result-projection-drift',
      expectedCode: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      mutate(db, pending) {
        db.prepare(`UPDATE carbon_accounting_results SET activity_value = activity_value + 1
          WHERE calculation_run_id = ? AND status = 'calculated'`).run(
          pending.execution.calculationRun.id
        );
      }
    },
    {
      name: 'result-delete',
      expectedCode: 'CARBON_ACCOUNTING_RESULT_SET_MISMATCH',
      mutate(db, pending) {
        db.prepare(`DELETE FROM carbon_accounting_results
          WHERE id = (SELECT MIN(id) FROM carbon_accounting_results
            WHERE calculation_run_id = ?)`).run(pending.execution.calculationRun.id);
      }
    },
    {
      name: 'action-run-drift',
      expectedCode: 'CARBON_ACCOUNTING_ACTION_RUN_BINDING_INVALID',
      mutate(db, _pending, fixture) {
        db.prepare(`UPDATE demo_post_action_runs SET action_key = 'carbon-accounting-run-drift'
          WHERE action_run_id = ?`).run(fixture.actionRun.actionRunId);
      }
    },
    {
      name: 'source-registry-drift',
      expectedCode: 'CARBON_ACCOUNTING_SOURCE_OWNERSHIP_INVALID',
      mutate(db) {
        db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
          WHERE ownership_kind = 'imported' AND entity_type = 'carbon_factor'`).run(
          'a'.repeat(64)
        );
      }
    },
    {
      name: 'derived-registry-drift',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH',
      mutate(db) {
        db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
          WHERE ownership_kind = 'derived'
            AND registry_id = (SELECT MIN(registry_id) FROM demo_data_registry
              WHERE ownership_kind = 'derived')`).run('b'.repeat(64));
      }
    },
    {
      name: 'derived-registry-extra',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_REGISTRY_CLOSURE_MISMATCH',
      mutate(db, _pending, fixture) {
        insertTestDerivedRegistry(db, {
          runId: fixture.run.runId,
          artifactKey: '27-carbon-activities',
          entityType: 'rf_p2_093_extra',
          entityPk: 'receipt-extra',
          actorUserId: fixture.run.createdBy
        });
      }
    },
    {
      name: 'derived-registry-extra-relation',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_REGISTRY_CLOSURE_MISMATCH',
      mutate(db, _pending, fixture) {
        const extraRegistryId = insertTestDerivedRegistry(db, {
          runId: fixture.run.runId,
          artifactKey: '27-carbon-activities',
          entityType: 'rf_p2_093_extra_relation',
          entityPk: 'receipt-extra-relation',
          actorUserId: fixture.run.createdBy
        });
        const expectedRegistry = db.prepare(`SELECT registry_id AS registryId
          FROM demo_data_registry WHERE run_id = ? AND artifact_key = '27-carbon-activities'
            AND ownership_kind = 'derived' AND entity_type = 'carbon_calculation_run'
            AND cleaned_at IS NULL`).get(fixture.run.runId);
        db.prepare(`INSERT INTO demo_data_relations
          (run_id, from_registry_id, to_registry_id, relation_type)
          VALUES (?, ?, ?, 'uses_config')`).run(
          fixture.run.runId,
          extraRegistryId,
          expectedRegistry.registryId
        );
      }
    },
    {
      name: 'cross-artifact-derived-relation',
      expectedCode: 'CARBON_ACCOUNTING_RELATION_CLOSURE_MISMATCH',
      mutate(db, _pending, fixture) {
        const extraRegistryId = insertTestDerivedRegistry(db, {
          runId: fixture.run.runId,
          artifactKey: '11-carbon-factors',
          entityType: 'rf_p2_093_cross_artifact_relation',
          entityPk: 'cross-artifact-relation',
          actorUserId: fixture.run.createdBy
        });
        const expectedRegistry = db.prepare(`SELECT registry_id AS registryId
          FROM demo_data_registry WHERE run_id = ? AND artifact_key = '27-carbon-activities'
            AND ownership_kind = 'derived' AND entity_type = 'carbon_calculation_run'
            AND cleaned_at IS NULL`).get(fixture.run.runId);
        db.prepare(`INSERT INTO demo_data_relations
          (run_id, from_registry_id, to_registry_id, relation_type)
          VALUES (?, ?, ?, 'uses_config')`).run(
          fixture.run.runId,
          extraRegistryId,
          expectedRegistry.registryId
        );
      }
    },
    {
      name: 'relation-delete',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH',
      mutate(db) {
        db.prepare('DELETE FROM demo_data_relations WHERE relation_id = (SELECT MIN(relation_id) FROM demo_data_relations)').run();
      }
    },
    {
      name: 'relation-extra-reverse',
      expectedCode: 'CARBON_ACCOUNTING_RELATION_CLOSURE_MISMATCH',
      mutate(db, _pending, fixture) {
        const relation = db.prepare(`SELECT relation.from_registry_id AS fromId,
            relation.to_registry_id AS toId
          FROM demo_data_relations relation
          WHERE relation.relation_type = 'generated_from' LIMIT 1`).get();
        db.prepare(`INSERT INTO demo_data_relations
          (run_id, from_registry_id, to_registry_id, relation_type)
          VALUES (?, ?, ?, 'generated_from')`).run(
          fixture.run.runId,
          relation.toId,
          relation.fromId
        );
      }
    },
    {
      name: 'relation-type',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH',
      mutate(db) {
        db.prepare(`UPDATE demo_data_relations SET relation_type = 'uses_config'
          WHERE relation_id = (SELECT MIN(relation_id) FROM demo_data_relations)`).run();
      }
    },
    {
      name: 'relation-endpoint',
      expectedCode: 'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH',
      mutate(db) {
        const imported = db.prepare(`SELECT registry_id AS registryId FROM demo_data_registry
          WHERE ownership_kind = 'imported' AND entity_type = 'carbon_factor' LIMIT 1`).get();
        db.prepare(`UPDATE demo_data_relations SET to_registry_id = ?
          WHERE relation_id = (SELECT MIN(relation_id) FROM demo_data_relations)`).run(
          imported.registryId
        );
      }
    }
  ];
  receiptFailureCases.forEach((failureCase) => {
    withHarness(failureCase.name, ({ db, actor, fixture }) => {
      db.exec('BEGIN IMMEDIATE');
      const pending = registerPendingOwnership(db, fixture, actor);
      failureCase.mutate(db, pending, fixture);
      assertErrorCode(() => carbonAccountingOwnershipProtocol
        .verifyRegistrationReceiptInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope,
          registrationReceipt: pending.registrationReceipt
        }), failureCase.expectedCode);
      assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 },
        `${failureCase.name} 必须回滚全部 derived 写入。`);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 1,
        'receipt 失败只恢复 registrar SAVEPOINT，不接管 caller outer transaction。');
      assert.strictEqual(db.inTransaction, true);
      db.exec('ROLLBACK');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 0,
        'caller rollback 必须继续完整撤销 calculation 事实。');
    });
  });

  // trigger 静默改写 registry 或 relation 必须在 registrar 返回 receipt 前被检测并恢复。
  const triggerCases = [
    {
      name: 'registry-trigger',
      expectedCode: 'CARBON_ACCOUNTING_REGISTRY_CONTRACT_MISMATCH',
      create(db) {
        db.exec(`CREATE TRIGGER test_carbon_registry_rewrite
          AFTER INSERT ON demo_data_registry
          WHEN NEW.ownership_kind = 'derived'
          BEGIN
            UPDATE demo_data_registry SET snapshot_digest = '${'f'.repeat(64)}'
            WHERE registry_id = NEW.registry_id;
          END`);
      }
    },
    {
      name: 'registry-extra-trigger',
      expectedCode: 'CARBON_ACCOUNTING_REGISTRY_CLOSURE_MISMATCH',
      create(db) {
        db.exec(`CREATE TRIGGER test_carbon_registry_extra
          AFTER INSERT ON demo_data_registry
          WHEN NEW.ownership_kind = 'derived'
            AND NEW.artifact_key = '27-carbon-activities'
            AND NEW.entity_type IN ('carbon_calculation_run', 'carbon_accounting_result')
          BEGIN
            INSERT INTO demo_data_registry
              (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
               identity_digest, snapshot_digest, registered_by)
            VALUES
              (NEW.run_id, NEW.artifact_key, 'rf_p2_093_trigger_extra',
               'trigger-' || NEW.registry_id, 'derived',
               '${'c'.repeat(64)}', '${'d'.repeat(64)}', NEW.registered_by);
          END`);
      }
    },
    {
      name: 'relation-trigger-extra-registry',
      expectedCode: 'CARBON_ACCOUNTING_REGISTRY_CLOSURE_MISMATCH',
      create(db) {
        db.exec(`CREATE TRIGGER test_carbon_relation_extra_registry
          AFTER INSERT ON demo_data_relations
          BEGIN
            INSERT INTO demo_data_registry
              (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
               identity_digest, snapshot_digest, registered_by)
            VALUES
              (NEW.run_id, '27-carbon-activities', 'rf_p2_093_relation_trigger_extra',
               'relation-' || NEW.relation_id, 'derived',
               '${'e'.repeat(64)}', '${'f'.repeat(64)}', NULL);
          END`);
      }
    },
    {
      name: 'relation-extra-trigger',
      expectedCode: 'CARBON_ACCOUNTING_RELATION_CLOSURE_MISMATCH',
      create(db) {
        db.exec(`CREATE TRIGGER test_carbon_relation_extra
          AFTER INSERT ON demo_data_relations
          WHEN NEW.relation_type IN ('contains', 'generated_from', 'uses_factor')
          BEGIN
            INSERT INTO demo_data_relations
              (run_id, from_registry_id, to_registry_id, relation_type)
            VALUES
              (NEW.run_id, NEW.to_registry_id, NEW.from_registry_id, 'uses_config');
          END`);
      }
    },
    {
      name: 'relation-trigger',
      expectedCode: 'CARBON_ACCOUNTING_RELATION_CONTRACT_MISMATCH',
      create(db) {
        db.exec(`CREATE TRIGGER test_carbon_relation_rewrite
          AFTER INSERT ON demo_data_relations
          BEGIN
            UPDATE demo_data_relations SET relation_type = 'uses_config'
            WHERE relation_id = NEW.relation_id;
          END`);
      }
    }
  ];
  triggerCases.forEach((triggerCase) => {
    withHarness(triggerCase.name, ({ db, actor, fixture }) => {
      triggerCase.create(db);
      db.exec('BEGIN IMMEDIATE');
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
      const binding = {
        db,
        demoRun: fixture.run,
        actionRun: fixture.actionRun,
        actor,
        exactScope: built.exactScope,
        calculationWitness: execution.calculationWitness
      };
      const registrationScope = carbonAccountingOwnershipProtocol
        .issueRegistrationScopeInCallerTransaction(binding);
      assertErrorCode(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope }),
      triggerCase.expectedCode);
      assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 1);
      db.exec('ROLLBACK');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 0);
    });
  });

  // 跨 artifact、跨 run 与已 cleaned derived registry 不属于当前 active artifact27 全集。
  withHarness('registry-scope-boundaries', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = registerPendingOwnership(db, fixture, actor);
    insertTestDerivedRegistry(db, {
      runId: fixture.run.runId,
      artifactKey: '11-carbon-factors',
      entityType: 'rf_p2_093_cross_artifact',
      entityPk: 'cross-artifact',
      actorUserId: actor.userId
    });
    const otherRunId = `${fixture.run.runId}-other`;
    db.prepare(`INSERT INTO demo_dataset_runs
      (run_id, dataset_id, manifest_version, manifest_digest, status, created_by)
      VALUES (?, ?, ?, ?, 'failed', ?)`).run(
      otherRunId,
      fixture.run.datasetId,
      fixture.run.manifestVersion,
      fixture.run.manifestDigest,
      actor.userId
    );
    insertTestDerivedRegistry(db, {
      runId: otherRunId,
      artifactKey: '27-carbon-activities',
      entityType: 'rf_p2_093_cross_run',
      entityPk: 'cross-run',
      actorUserId: actor.userId
    });
    const cleanupRunId = `cleanup-${fixture.run.runId}`;
    db.prepare(`INSERT INTO demo_cleanup_runs
      (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
       runtime_revision, registry_watermark, status)
      VALUES (?, ?, ?, ?, ?, 1, ?, 'succeeded')`).run(
      cleanupRunId,
      fixture.run.runId,
      `request-${cleanupRunId}`,
      sha256(`preview-${cleanupRunId}`),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      `watermark-${cleanupRunId}`
    );
    db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
       identity_digest, snapshot_digest, registered_by, cleaned_at,
       cleanup_run_id, cleanup_result)
      VALUES (?, '27-carbon-activities', 'rf_p2_093_cleaned', 'cleaned', 'derived',
        ?, ?, ?, ?, ?, 'already_missing')`).run(
      fixture.run.runId,
      sha256('identity-cleaned'),
      sha256('snapshot-cleaned'),
      actor.userId,
      new Date().toISOString(),
      cleanupRunId
    );
    assert.strictEqual(carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope,
        registrationReceipt: pending.registrationReceipt
      }), true);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '27-carbon-activities'
        AND ownership_kind = 'derived' AND cleaned_at IS NULL`).get(fixture.run.runId).total, 3);
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 6, relations: 5 });
    db.exec('ROLLBACK');
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
  });

  // registration scope 与 receipt 均绑定原始 SQLite 连接，跨库调用不得触碰目标库事务。
  const crossDatabaseSource = createHarness('cross-db-source');
  const crossDatabaseTarget = createHarness('cross-db-target');
  try {
    crossDatabaseSource.db.exec('BEGIN IMMEDIATE');
    const built = carbonAccountingExactProtocol.buildExactScopeInCallerTransaction({
      db: crossDatabaseSource.db,
      demoRun: crossDatabaseSource.fixture.run,
      actor: crossDatabaseSource.actor
    });
    const execution = carbonAccountingExactProtocol.executeExactInCallerTransaction({
      db: crossDatabaseSource.db,
      demoRun: crossDatabaseSource.fixture.run,
      actor: crossDatabaseSource.actor,
      exactScope: built.exactScope,
      exactCapability: built.exactCapability
    });
    const binding = {
      db: crossDatabaseSource.db,
      demoRun: crossDatabaseSource.fixture.run,
      actionRun: crossDatabaseSource.fixture.actionRun,
      actor: crossDatabaseSource.actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    crossDatabaseTarget.db.exec('BEGIN IMMEDIATE');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({
        ...binding,
        db: crossDatabaseTarget.db,
        registrationScope
      }), 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_BINDING_MISMATCH');
    assert.strictEqual(crossDatabaseTarget.db.inTransaction, true);
    const registrationReceipt = carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope });
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...binding,
        db: crossDatabaseTarget.db,
        registrationScope,
        registrationReceipt
      }), 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_BINDING_MISMATCH');
    assert.strictEqual(crossDatabaseTarget.db.inTransaction, true);
    carbonAccountingOwnershipProtocol.verifyRegistrationReceiptInCallerTransaction({
      ...binding,
      registrationScope,
      registrationReceipt
    });
    crossDatabaseSource.db.exec('ROLLBACK');
    crossDatabaseTarget.db.exec('ROLLBACK');
  } finally {
    [crossDatabaseSource.db, crossDatabaseTarget.db].forEach((db) => {
      if (db.open && db.inTransaction) db.exec('ROLLBACK');
      if (db.open) db.close();
    });
  }

  // scope 跨事务必须在 registrar 新业务读取前释放 marker 失败并完整回滚当前事务。
  withHarness('cross-transaction', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
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
    const binding = {
      db,
      demoRun: fixture.run,
      actionRun: fixture.actionRun,
      actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope }),
    'CARBON_ACCOUNTING_REGISTRATION_TRANSACTION_MISMATCH');
    assert.strictEqual(db.inTransaction, false);
  });

  // receipt 跨事务必须通过私有 marker 失败，并完整回滚误开的新事务。
  withHarness('receipt-cross-transaction', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = registerPendingOwnership(db, fixture, actor);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    assertErrorCode(() => carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope,
        registrationReceipt: pending.registrationReceipt
      }), 'CARBON_ACCOUNTING_RECEIPT_TRANSACTION_MISMATCH');
    assert.strictEqual(db.inTransaction, false);
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
  });

  // scope marker RELEASE 本身失败也必须完整回滚，不能把 exact calculation 交回 caller。
  withHarness('registration-marker-release-failure', ({ db, actor, fixture, databasePath }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const originalExec = db.exec;
    db.exec = function failRegistrationMarkerRelease(sql, ...args) {
      if (/^RELEASE SAVEPOINT carbon_ownership_scope_marker_[0-9a-f]+$/.test(String(sql))) {
        const error = new Error('simulated registration marker release failure');
        error.code = 'SQLITE_ERROR';
        throw error;
      }
      return originalExec.call(db, sql, ...args);
    };
    try {
      captureCarbonOwnershipError(
        () => carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }),
        'CARBON_ACCOUNTING_REGISTRATION_TRANSACTION_MISMATCH'
      );
    } finally {
      db.exec = originalExec;
    }
    assert.strictEqual(db.open, true, 'marker 完整回滚成功后应保留连接。');
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  });

  // marker RELEASE 与完整回滚同时失败时必须关闭原连接，由 SQLite 撤销未提交 exact 写入。
  const markerCloseHarness = createHarness('registration-marker-full-rollback-close');
  try {
    const { db, actor, fixture, databasePath } = markerCloseHarness;
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const originalExec = db.exec;
    db.exec = function failRegistrationMarkerRelease(sql, ...args) {
      if (/^RELEASE SAVEPOINT carbon_ownership_scope_marker_[0-9a-f]+$/.test(String(sql))) {
        const error = new Error('simulated registration marker release failure');
        error.code = 'SQLITE_ERROR';
        throw error;
      }
      return originalExec.call(db, sql, ...args);
    };
    try {
      const markerError = captureCarbonOwnershipError(() => runWithOwnershipFaultStages(
        ['carbon-registration-marker-before-full-rollback'],
        () => carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        })
      ), 'CARBON_ACCOUNTING_REGISTRATION_MARKER_RECOVERY_FAILED');
      assert.strictEqual(markerError.details.releaseCode, 'SQLITE_ERROR');
      assert.strictEqual(
        markerError.details.fullRollbackCode,
        'INJECTED_CARBON_OWNERSHIP_FAULT'
      );
    } finally {
      db.exec = originalExec;
    }
    assert.strictEqual(db.open, false, 'marker 完整回滚失败必须关闭原始连接。');
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  } finally {
    if (markerCloseHarness.db.open) markerCloseHarness.db.close();
  }

  // scope 签发后、registrar 调用前同步修改 caller demo run 与 DB，也不能改写冻结签发快照。
  withHarness('demo-run-caller-sync-before-register', ({
    db,
    actor,
    fixture,
    databasePath
  }) => {
    db.exec('BEGIN IMMEDIATE');
    const mutableDemoRun = { ...fixture.run };
    const pending = issuePendingOwnershipRegistration(db, fixture, actor, mutableDemoRun);
    assert.strictEqual(Object.isFrozen(mutableDemoRun), false, '服务不得冻结 caller demo run 原对象。');
    assertOpaqueCarbonOwnershipValue(pending.registrationScope, 'registration scope');
    mutableDemoRun.status = 'completed';
    db.prepare(`UPDATE demo_dataset_runs SET status = 'completed' WHERE run_id = ?`).run(
      fixture.run.runId
    );
    const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope
      }));
    assert.strictEqual(
      handoffError.details.originalCode,
      'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE'
    );
    assertCarbonOwnershipErrorHidesValues(handoffError, [
      fixture.run.runId,
      fixture.run.datasetId,
      'active',
      'completed'
    ]);
    assert.strictEqual(db.open, true, 'caller 同步篡改完整回滚后应保留连接。');
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  });

  // caller 原对象单独漂移也必须与冻结签发快照比较，不能因为数据库未变化而继续登记。
  [
    {
      name: 'demo-run-caller-created-by-drift',
      hiddenValue: 900001,
      mutate(demoRun) {
        demoRun.createdBy = 900001;
      }
    },
    {
      name: 'demo-run-caller-created-at-drift',
      hiddenValue: '2024-01-01T00:00:00.000Z',
      mutate(demoRun) {
        demoRun.createdAt = '2024-01-01T00:00:00.000Z';
      }
    },
    {
      name: 'demo-run-caller-manifest-digest-drift',
      hiddenValue: 'e'.repeat(64),
      mutate(demoRun) {
        demoRun.manifestDigest = 'e'.repeat(64);
      }
    }
  ].forEach((failureCase) => {
    withHarness(failureCase.name, ({ db, actor, fixture, databasePath }) => {
      db.exec('BEGIN IMMEDIATE');
      const mutableDemoRun = { ...fixture.run };
      const pending = issuePendingOwnershipRegistration(db, fixture, actor, mutableDemoRun);
      failureCase.mutate(mutableDemoRun);
      const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }));
      assert.strictEqual(
        handoffError.details.originalCode,
        'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE'
      );
      assertCarbonOwnershipErrorHidesValues(handoffError, [failureCase.hiddenValue]);
      assert.strictEqual(db.open, true, `${failureCase.name} 完整回滚成功后应保留连接。`);
      assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
    });
  });

  // marker 释放后 demo/action 重读漂移必须统一 fail-closed，caller 捕获后也不能 COMMIT exact 写入。
  [
    {
      name: 'demo-run-status-reread-drift',
      originalCode: 'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      hiddenValues: ['active', 'completed'],
      syncDemoRun: true,
      mutate(db, fixture, demoRun) {
        demoRun.status = 'completed';
        db.prepare(`UPDATE demo_dataset_runs SET status = 'completed' WHERE run_id = ?`).run(
          fixture.run.runId
        );
      }
    },
    {
      name: 'demo-run-created-by-reread-drift',
      originalCode: 'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      syncDemoRun: true,
      mutate(db, fixture, demoRun) {
        demoRun.createdBy = null;
        db.prepare('UPDATE demo_dataset_runs SET created_by = NULL WHERE run_id = ?').run(
          fixture.run.runId
        );
      }
    },
    {
      name: 'demo-run-created-at-reread-drift',
      originalCode: 'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      hiddenValues: ['2025-01-01T00:00:00.000Z'],
      syncDemoRun: true,
      mutate(db, fixture, demoRun) {
        demoRun.createdAt = '2025-01-01T00:00:00.000Z';
        db.prepare('UPDATE demo_dataset_runs SET created_at = ? WHERE run_id = ?').run(
          demoRun.createdAt,
          fixture.run.runId
        );
      }
    },
    {
      name: 'demo-run-reread-drift',
      originalCode: 'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      hiddenValues: ['f'.repeat(64)],
      syncDemoRun: true,
      mutate(db, fixture, demoRun) {
        demoRun.manifestDigest = 'f'.repeat(64);
        db.prepare(`UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?`).run(
          demoRun.manifestDigest,
          fixture.run.runId
        );
      }
    },
    {
      name: 'action-run-reread-drift',
      originalCode: 'CARBON_ACCOUNTING_ACTION_RUN_BINDING_INVALID',
      hiddenValues: ['carbon-accounting-run-drift'],
      mutate(db, fixture) {
        db.prepare(`UPDATE demo_post_action_runs SET action_key = 'carbon-accounting-run-drift'
          WHERE action_run_id = ?`).run(fixture.actionRun.actionRunId);
      }
    }
  ].forEach((failureCase) => {
    withHarness(failureCase.name, ({ db, actor, fixture, databasePath }) => {
      db.exec('BEGIN IMMEDIATE');
      const demoRun = failureCase.syncDemoRun ? { ...fixture.run } : fixture.run;
      const pending = issuePendingOwnershipRegistration(db, fixture, actor, demoRun);
      assertOpaqueCarbonOwnershipValue(pending.registrationScope, 'registration scope');
      if (failureCase.syncDemoRun) {
        assert.strictEqual(Object.isFrozen(demoRun), false, 'caller demo run 必须保持可变以验证快照隔离。');
      }
      const originalExec = db.exec;
      let mutatedAfterMarkerRelease = false;
      db.exec = function mutateAfterRegistrationMarkerRelease(sql, ...args) {
        const result = originalExec.call(db, sql, ...args);
        if (!mutatedAfterMarkerRelease
          && /^RELEASE SAVEPOINT carbon_ownership_scope_marker_[0-9a-f]+$/.test(String(sql))) {
          mutatedAfterMarkerRelease = true;
          failureCase.mutate(db, fixture, demoRun);
        }
        return result;
      };
      let handoffError = null;
      try {
        handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
          .registerDerivedOwnershipInCallerTransaction({
            ...pending.binding,
            registrationScope: pending.registrationScope
          }));
      } finally {
        db.exec = originalExec;
      }
      assert.strictEqual(mutatedAfterMarkerRelease, true, '漂移必须发生在 marker 释放成功之后。');
      assert.strictEqual(handoffError.details.originalCode, failureCase.originalCode);
      if (Array.isArray(failureCase.hiddenValues)) {
        assertCarbonOwnershipErrorHidesValues(handoffError, failureCase.hiddenValues);
      }
      assert.strictEqual(db.open, true, `${failureCase.name} 完整回滚成功后应保留连接。`);
      assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
    });
  });

  // marker 释放后的 demo run 读取异常必须完整回滚并只公开稳定错误码。
  withHarness('demo-run-reread-error', ({ db, actor, fixture, databasePath }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const originalExec = db.exec;
    const originalPrepare = db.prepare;
    let markerReleased = false;
    db.exec = function trackRegistrationMarkerRelease(sql, ...args) {
      const result = originalExec.call(db, sql, ...args);
      if (/^RELEASE SAVEPOINT carbon_ownership_scope_marker_[0-9a-f]+$/.test(String(sql))) {
        markerReleased = true;
      }
      return result;
    };
    db.prepare = function failDemoRunReread(sql, ...args) {
      if (markerReleased && /FROM demo_dataset_runs/i.test(String(sql))) {
        const error = new Error('simulated demo run reread failure with SELECT secret');
        error.code = 'SQLITE_IOERR';
        throw error;
      }
      return originalPrepare.call(db, sql, ...args);
    };
    try {
      const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }));
      assert.strictEqual(handoffError.details.originalCode, 'SQLITE_IOERR');
    } finally {
      db.exec = originalExec;
      db.prepare = originalPrepare;
    }
    assert.strictEqual(db.open, true, '读取异常完整回滚成功后应保留连接。');
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  });

  // marker 释放后的其它异常与 witness consume 前异常都必须完整回滚。
  [
    'carbon-registrar-handoff-after-marker-release',
    'carbon-registrar-handoff-before-witness-consume'
  ].forEach((faultStage) => {
    withHarness(`handoff-${faultStage.split('-').slice(-3).join('-')}`,
      ({ db, actor, fixture, databasePath }) => {
        db.exec('BEGIN IMMEDIATE');
        const pending = issuePendingOwnershipRegistration(db, fixture, actor);
        const handoffError = captureCarbonHandoffError(() => runWithOwnershipFaultStages(
          [faultStage],
          () => carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...pending.binding,
            registrationScope: pending.registrationScope
          })
        ));
        assert.strictEqual(
          handoffError.details.originalCode,
          'INJECTED_CARBON_OWNERSHIP_FAULT'
        );
        assert.strictEqual(db.open, true, `${faultStage} 完整回滚成功后应保留连接。`);
        assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
      });
  });

  // registrar 随机 SAVEPOINT 名称生成失败时，witness 对应 calculation 写入必须立即完整回滚。
  withHarness('handoff-savepoint-name-failure', ({ db, actor, fixture, databasePath }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const originalRandomBytes = crypto.randomBytes;
    crypto.randomBytes = function failRegistrarSavepointName() {
      const error = new Error('simulated registrar recovery SAVEPOINT name failure');
      error.code = 'CRYPTO_RANDOM_FAILED';
      throw error;
    };
    try {
      const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }));
      assert.strictEqual(handoffError.details.originalCode, 'CRYPTO_RANDOM_FAILED');
    } finally {
      crypto.randomBytes = originalRandomBytes;
    }
    assert.strictEqual(db.open, true);
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  });

  // witness 已消费到 registrar SAVEPOINT 建立完成前的前置故障必须完整回滚，caller COMMIT 不得固化半成品。
  [
    'carbon-registrar-handoff-before-savepoint-name',
    'carbon-registrar-handoff-before-savepoint'
  ].forEach((faultStage) => {
    withHarness(`handoff-${faultStage.split('-').slice(-2).join('-')}`,
      ({ db, actor, fixture, databasePath }) => {
        db.exec('BEGIN IMMEDIATE');
        const pending = issuePendingOwnershipRegistration(db, fixture, actor);
        const handoffError = captureCarbonHandoffError(() => runWithOwnershipFaultStages(
          [faultStage],
          () => carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...pending.binding,
            registrationScope: pending.registrationScope
          })
        ));
        assert.strictEqual(handoffError.details.fullRollbackCode, null);
        assert.strictEqual(db.open, true, `${faultStage} 完整回滚成功后应保留连接。`);
        assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
      });
  });

  // 直接模拟 registrar SAVEPOINT SQL 建立失败，仍必须走同一 handoff 完整回滚路径。
  withHarness('handoff-savepoint-establish-failure', ({ db, actor, fixture, databasePath }) => {
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const originalExec = db.exec;
    db.exec = function failRegistrarRecoverySavepoint(sql, ...args) {
      if (/^SAVEPOINT carbon_ownership_registrar_recovery_[0-9a-f]+$/.test(String(sql))) {
        const error = new Error('simulated registrar recovery SAVEPOINT establishment failure');
        error.code = 'SQLITE_ERROR';
        throw error;
      }
      return originalExec.call(db, sql, ...args);
    };
    try {
      const handoffError = captureCarbonHandoffError(() => carbonAccountingOwnershipProtocol
        .registerDerivedOwnershipInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope
        }));
      assert.strictEqual(handoffError.details.originalCode, 'SQLITE_ERROR');
    } finally {
      db.exec = originalExec;
    }
    assert.strictEqual(db.open, true);
    assertCarbonHandoffPersistenceIsEmpty(db, databasePath);
  });

  // handoff 完整回滚本身失败时必须关闭原始连接，由 SQLite close 撤销全部未提交事实。
  const handoffCloseHarness = createHarness('handoff-full-rollback-close');
  try {
    const { db, actor, fixture, databasePath } = handoffCloseHarness;
    db.exec('BEGIN IMMEDIATE');
    const pending = issuePendingOwnershipRegistration(db, fixture, actor);
    const handoffError = captureCarbonHandoffError(() => runWithOwnershipFaultStages([
      'carbon-registrar-handoff-before-savepoint-name',
      'carbon-registrar-handoff-before-full-rollback'
    ], () => carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction({
      ...pending.binding,
      registrationScope: pending.registrationScope
    })));
    assert.strictEqual(
      handoffError.details.fullRollbackCode,
      'INJECTED_CARBON_OWNERSHIP_FAULT'
    );
    assert.strictEqual(db.open, false, 'handoff 完整回滚失败必须关闭原始连接。');
    assert.throws(() => db.exec('COMMIT'), '关闭后的原始连接不得接受 caller COMMIT。');
    const observerDb = openDatabase({ databasePath });
    try {
      assert.deepStrictEqual(readCarbonHandoffWriteCounts(observerDb), {
        runs: 0,
        results: 0,
        audits: 0,
        registries: 0,
        relations: 0
      });
    } finally {
      observerDb.close();
    }
  } finally {
    if (handoffCloseHarness.db.open) handoffCloseHarness.db.close();
  }

  // registrar SAVEPOINT 已建立后的恢复失败矩阵必须完整回滚；full rollback 失败时关闭连接。
  withHarness('registrar-recovery', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
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
    const binding = {
      db,
      demoRun: fixture.run,
      actionRun: fixture.actionRun,
      actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    assertErrorCode(() => runWithOwnershipFaultStages([
      'after-registry-write',
      'carbon-registrar-before-recovery-rollback'
    ], () => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope })),
    'CARBON_ACCOUNTING_REGISTRAR_RECOVERY_FAILED');
    assert.strictEqual(db.inTransaction, false);
    assert.strictEqual(db.open, true);
  });

  withHarness('registrar-recovery-release', ({ db, actor, fixture }) => {
    db.exec('BEGIN IMMEDIATE');
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
    const binding = {
      db,
      demoRun: fixture.run,
      actionRun: fixture.actionRun,
      actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    assertErrorCode(() => runWithOwnershipFaultStages([
      'after-registry-write',
      'carbon-registrar-before-recovery-release'
    ], () => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope })),
    'CARBON_ACCOUNTING_REGISTRAR_RECOVERY_FAILED');
    assert.strictEqual(db.inTransaction, false);
    assert.strictEqual(db.open, true);
    assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
  });

  const closeHarness = createHarness('full-rollback-close');
  try {
    const { db, actor, fixture } = closeHarness;
    db.exec('BEGIN IMMEDIATE');
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
    const binding = {
      db,
      demoRun: fixture.run,
      actionRun: fixture.actionRun,
      actor,
      exactScope: built.exactScope,
      calculationWitness: execution.calculationWitness
    };
    const registrationScope = carbonAccountingOwnershipProtocol
      .issueRegistrationScopeInCallerTransaction(binding);
    assertErrorCode(() => runWithOwnershipFaultStages([
      'after-registry-write',
      'carbon-registrar-before-recovery-rollback',
      'carbon-registrar-before-full-rollback'
    ], () => carbonAccountingOwnershipProtocol
      .registerDerivedOwnershipInCallerTransaction({ ...binding, registrationScope })),
    'CARBON_ACCOUNTING_REGISTRAR_RECOVERY_FAILED');
    assert.strictEqual(db.open, false, '完整回滚失败必须关闭原始连接。');
  } finally {
    if (closeHarness.db.open) closeHarness.db.close();
  }

  [
    'carbon-receipt-before-recovery-rollback',
    'carbon-receipt-before-recovery-release'
  ].forEach((recoveryStage) => {
    withHarness(`receipt-${recoveryStage.split('-').slice(-2).join('-')}`, ({ db, actor, fixture }) => {
      db.exec('BEGIN IMMEDIATE');
      const pending = registerPendingOwnership(db, fixture, actor);
      assertErrorCode(() => runWithOwnershipFaultStages([
        'receipt-before-read',
        recoveryStage
      ], () => carbonAccountingOwnershipProtocol
        .verifyRegistrationReceiptInCallerTransaction({
          ...pending.binding,
          registrationScope: pending.registrationScope,
          registrationReceipt: pending.registrationReceipt
        })), 'CARBON_ACCOUNTING_RECEIPT_RECOVERY_FAILED');
      assert.strictEqual(db.inTransaction, false);
      assert.strictEqual(db.open, true);
      assert.deepStrictEqual(readDerivedCounts(db), { registries: 0, relations: 0 });
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 0);
    });
  });

  const receiptCloseHarness = createHarness('receipt-full-rollback-close');
  try {
    const { db, actor, fixture } = receiptCloseHarness;
    db.exec('BEGIN IMMEDIATE');
    const pending = registerPendingOwnership(db, fixture, actor);
    assertErrorCode(() => runWithOwnershipFaultStages([
      'receipt-before-read',
      'carbon-receipt-before-recovery-rollback',
      'carbon-receipt-before-full-rollback'
    ], () => carbonAccountingOwnershipProtocol
      .verifyRegistrationReceiptInCallerTransaction({
        ...pending.binding,
        registrationScope: pending.registrationScope,
        registrationReceipt: pending.registrationReceipt
      })), 'CARBON_ACCOUNTING_RECEIPT_RECOVERY_FAILED');
    assert.strictEqual(db.open, false, 'receipt 完整回滚失败必须关闭原始连接。');
  } finally {
    if (receiptCloseHarness.db.open) receiptCloseHarness.db.close();
  }

  // exact-first 与全部相关加载顺序均取得同一冻结协议和固定四 wrapper descriptor。
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  [
    [
      './server/src/services/carbonAccountingExactProtocol',
      './server/src/services/carbonCalculationRunService',
      './server/src/services/carbonAccountingOwnershipService',
      './server/src/services/carbonAccountingOwnershipProtocol'
    ],
    [
      './server/src/services/carbonCalculationRunService',
      './server/src/services/carbonAccountingExactProtocol',
      './server/src/services/carbonAccountingOwnershipService',
      './server/src/services/carbonAccountingOwnershipProtocol'
    ],
    [
      './server/src/services/carbonAccountingOwnershipService',
      './server/src/services/carbonAccountingExactProtocol',
      './server/src/services/carbonCalculationRunService',
      './server/src/services/carbonAccountingOwnershipProtocol'
    ],
    [
      './server/src/services/carbonAccountingOwnershipProtocol',
      './server/src/services/carbonAccountingExactProtocol',
      './server/src/services/carbonAccountingOwnershipService',
      './server/src/services/carbonCalculationRunService'
    ]
  ].forEach((order) => {
    const script = `'use strict';${JSON.stringify(order)}.forEach((item)=>require(item));`
      + `const exactPath=require.resolve('./server/src/services/carbonAccountingExactProtocol');`
      + `const exact=require(exactPath);`
      + `const expected=['buildExactScopeInCallerTransaction','consumeCalculationWitnessInCallerTransaction',`
      + `'executeExactInCallerTransaction','inspectRegistrationContextInCallerTransaction'];`
      + `if(JSON.stringify(Object.keys(exact).sort())!==JSON.stringify(expected))process.exit(2);`
      + `if(!Object.isFrozen(exact))process.exit(3);`
      + `for(const key of expected){const d=Object.getOwnPropertyDescriptor(exact,key);`
      + `if(!d||!d.enumerable||d.writable||d.configurable||typeof d.value!=='function')process.exit(4);}`
      + `const moduleDescriptor=Object.getOwnPropertyDescriptor(require.cache[exactPath],'exports');`
      + `if(!moduleDescriptor||moduleDescriptor.value!==exact||!moduleDescriptor.enumerable`
      + `||moduleDescriptor.writable||moduleDescriptor.configurable)process.exit(5);`
      + `const p=require('./server/src/services/carbonAccountingOwnershipProtocol');`
      + `if(!Object.isFrozen(p.carbonAccountingOwnershipProtocol))process.exit(6);`
      + `if(Object.keys(require('./server/src/services/carbonAccountingOwnershipService')).length!==0)process.exit(7);`;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(temporaryRoot, `load-${order[0].split('/').pop()}`),
        SQLITE_PATH: path.join(temporaryRoot, `load-${sha256(order.join('|')).slice(0, 8)}.sqlite`)
      },
      encoding: 'utf8'
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  });

  // dependency require 期间 exact Module 已固定 exports descriptor，四 wrapper 只在依赖校验后安装。
  const exactInitializationWindowScript = `'use strict';`
    + `const exactPath=require.resolve('./server/src/services/carbonAccountingExactProtocol');`
    + `const calculationPath=require.resolve('./server/src/services/carbonCalculationRunService');`
    + `const protocolSymbol=Symbol.for('charcoal.carbonAccounting.exactInternal.v1');`
    + `let observed=false;let initializationShell=null;`
    + `const handlers={`
    + `buildExactScopeInCallerTransaction:()=>1,executeExactInCallerTransaction:()=>2,`
    + `inspectRegistrationContextInCallerTransaction:()=>3,consumeCalculationWitnessInCallerTransaction:()=>4};`
    + `const fakeExports={};`
    + `Object.defineProperty(fakeExports,protocolSymbol,{enumerable:false,configurable:false,get(){`
    + `const record=require.cache[exactPath];const descriptor=record&&Object.getOwnPropertyDescriptor(record,'exports');`
    + `if(!descriptor||!descriptor.enumerable||descriptor.writable||descriptor.configurable)process.exit(2);`
    + `if(Object.keys(descriptor.value).length!==0)process.exit(3);`
    + `initializationShell=descriptor.value;observed=true;return Object.freeze(handlers);}});`
    + `require.cache[calculationPath]={exports:fakeExports};`
    + `const exact=require(exactPath);`
    + `if(!observed||exact!==initializationShell)process.exit(4);`
    + `if(exact.buildExactScopeInCallerTransaction()!==1||exact.executeExactInCallerTransaction()!==2`
    + `||exact.inspectRegistrationContextInCallerTransaction()!==3`
    + `||exact.consumeCalculationWitnessInCallerTransaction()!==4)process.exit(5);`
    + `if(!Object.isFrozen(exact))process.exit(6);`;
  const exactInitializationWindowChild = spawnSync(
    process.execPath,
    ['-e', exactInitializationWindowScript],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.strictEqual(
    exactInitializationWindowChild.status,
    0,
    exactInitializationWindowChild.stderr || exactInitializationWindowChild.stdout
  );

  // exact 初始化失败必须移除失败 cache；测试替换前无 entry 和已有原 entry 两种情况都可恢复。
  ['absent', 'present'].forEach((originalEntryMode) => {
    const initializationFailureScript = `'use strict';`
      + `const exactPath=require.resolve('./server/src/services/carbonAccountingExactProtocol');`
      + `const calculationPath=require.resolve('./server/src/services/carbonCalculationRunService');`
      + `delete require.cache[exactPath];delete require.cache[calculationPath];`
      + `const mode=${JSON.stringify(originalEntryMode)};`
      + `const original=mode==='present'?(require(calculationPath),require.cache[calculationPath]):null;`
      + `const fake={exports:{}};require.cache[calculationPath]=fake;`
      + `let code=null;try{require(exactPath);}catch(error){code=error.code||null;}`
      + `if(code!=='CARBON_ACCOUNTING_EXACT_PROTOCOL_UNAVAILABLE')process.exit(2);`
      + `if(require.cache[exactPath])process.exit(3);`
      + `if(original)require.cache[calculationPath]=original;else delete require.cache[calculationPath];`
      + `const calculation=require(calculationPath);const exact=require(exactPath);`
      + `if(typeof calculation.createCarbonCalculationRun!=='function'||!Object.isFrozen(exact))process.exit(4);`
      + `if(mode==='present'&&require.cache[calculationPath]!==original)process.exit(5);`
      + `if(mode==='absent'&&require.cache[calculationPath]===fake)process.exit(6);`;
    const initializationFailureChild = spawnSync(process.execPath, ['-e', initializationFailureScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(temporaryRoot, `exact-init-${originalEntryMode}`),
        SQLITE_PATH: path.join(temporaryRoot, `exact-init-${originalEntryMode}.sqlite`)
      },
      encoding: 'utf8'
    });
    assert.strictEqual(
      initializationFailureChild.status,
      0,
      initializationFailureChild.stderr || initializationFailureChild.stdout
    );
  });

  // 初始化后替换 exports 赋值或 require.cache Module record 不能接管 consumer 捕获的四个正式 handler。
  const cacheReplacementScript = `'use strict';`
    + `const ownership=require('./server/src/services/carbonAccountingOwnershipProtocol').carbonAccountingOwnershipProtocol;`
    + `const exactPath=require.resolve('./server/src/services/carbonAccountingExactProtocol');`
    + `const exact=require(exactPath);`
    + `const ownershipPath=require.resolve('./server/src/services/carbonAccountingOwnershipService');`
    + `const calculationPath=require.resolve('./server/src/services/carbonCalculationRunService');`
    + `let maliciousCalls=0;`
    + `const malicious=()=>{maliciousCalls+=1;return Object.freeze({});};`
    + `const maliciousExact={buildExactScopeInCallerTransaction:malicious,`
    + `executeExactInCallerTransaction:malicious,inspectRegistrationContextInCallerTransaction:malicious,`
    + `consumeCalculationWitnessInCallerTransaction:malicious};`
    + `let assignmentBlocked=false;try{require.cache[exactPath].exports=maliciousExact;}`
    + `catch(error){assignmentBlocked=error instanceof TypeError;}`
    + `if(!assignmentBlocked||require.cache[exactPath].exports!==exact)process.exit(2);`
    + `require.cache[ownershipPath]={exports:{[Symbol.for('charcoal.carbonAccounting.ownershipInternal.v1')]:{`
    + `issueRegistrationScopeInCallerTransaction:malicious,registerDerivedOwnershipInCallerTransaction:malicious,`
    + `verifyRegistrationReceiptInCallerTransaction:malicious,abortRegistrationScopeInCallerTransaction:malicious}}};`
    + `require.cache[calculationPath]={exports:{[Symbol.for('charcoal.carbonAccounting.exactInternal.v1')]:maliciousExact}};`
    + `require.cache[exactPath]={exports:maliciousExact};`
    + `const readCode=(operation)=>{try{operation();return null;}catch(error){return error.code||error.details?.code||null;}};`
    + `const ownershipCode=readCode(()=>ownership.issueRegistrationScopeInCallerTransaction({`
    + `db:null,demoRun:null,actionRun:null,actor:null,exactScope:null,calculationWitness:null}));`
    + `const codes=[`
    + `readCode(()=>exact.buildExactScopeInCallerTransaction({db:null,demoRun:null,actor:null})),`
    + `readCode(()=>exact.executeExactInCallerTransaction({db:null,demoRun:null,actor:null,exactScope:null,exactCapability:null})),`
    + `readCode(()=>exact.inspectRegistrationContextInCallerTransaction({db:null,demoRun:null,actionRun:null,actor:null,exactScope:null,calculationWitness:null})),`
    + `readCode(()=>exact.consumeCalculationWitnessInCallerTransaction({db:null,demoRun:null,actor:null,exactScope:null,calculationWitness:null}))];`
    + `if(ownershipCode!=='CARBON_ACCOUNTING_OWNERSHIP_TRANSACTION_REQUIRED')process.exit(3);`
    + `if(codes.some((code)=>code!=='CARBON_ACCOUNTING_EXACT_DATABASE_REQUIRED'))process.exit(4);`
    + `if(maliciousCalls!==0)process.exit(5);`;
  const cacheReplacementChild = spawnSync(process.execPath, ['-e', cacheReplacementScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: path.join(temporaryRoot, 'cache-replacement'),
      SQLITE_PATH: path.join(temporaryRoot, 'cache-replacement.sqlite')
    },
    encoding: 'utf8'
  });
  assert.strictEqual(
    cacheReplacementChild.status,
    0,
    cacheReplacementChild.stderr || cacheReplacementChild.stdout
  );

  console.log('carbonAccountingDerivedOwnership tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
