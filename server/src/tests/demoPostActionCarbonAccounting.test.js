'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Carbon post-action 专项始终使用隔离临时 SQLite，不访问默认 data 文件。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-carbon-action-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-action.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonAction123!';
process.env.NODE_ENV = 'test';

const {
  blockDatabaseAdmission,
  initDatabase,
  openDatabase,
  unblockDatabaseAdmission
} = require('../db/database');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = require('../services/demoOwnershipService');
const carbonAdapter = require('../services/demoPostActionCarbonAccountingAdapter');
const carbonExactProtocol = require('../services/carbonAccountingExactProtocol');

// 生命周期子进程模式决定 canonical service 首次构造时使用 production 或隔离 fixture。
const carbonLifecycleChildMode = process.env.CHARCOAL_CARBON_LIFECYCLE_CHILD || '';
// Registry 模块路径用于在 fault 子进程首次加载 service 前安装可漂移测试包装器。
const postActionRegistryPath = require.resolve('../services/demoPostActionRegistry');
// Production registry 引用只用于构造隔离包装器和普通主进程断言。
const productionPostActionRegistry = require(postActionRegistryPath);
// 当前进程 registry 引用在 fault 子进程中替换为首次加载前安装的包装器。
let postActionRegistry = productionPostActionRegistry;
// 当前进程 canonical service 必须在 fake adapter 或 registry fixture 安装后才首次加载。
let postActionService = null;
// Fault 子进程通过闭包开关模拟同一 registry 原对象的当前定义漂移。
let activateCarbonRegistryDrift = null;

if (carbonLifecycleChildMode === 'fault') {
  let carbonRegistryDrifted = false;
  const faultRegistry = Object.freeze({
    ...productionPostActionRegistry,
    requireDemoPostAction(actionKey) {
      const definition = productionPostActionRegistry.requireDemoPostAction(actionKey);
      return actionKey === 'carbon-accounting-run' && carbonRegistryDrifted
        ? Object.freeze({
            ...definition,
            implementationStatus: 'not-connected',
            resolverVersion: 'carbon-accounting-resolver:future-canary',
            executorVersion: 'carbon-accounting-executor:future-canary'
          })
        : definition;
    }
  });
  require.cache[postActionRegistryPath].exports = faultRegistry;
  postActionRegistry = faultRegistry;
  activateCarbonRegistryDrift = () => {
    carbonRegistryDrifted = true;
  };
  postActionService = require('../services/demoPostActionService');
} else if (!['closed', 'recovery-outer', 'recovery-admission', 'recovery-alternate']
  .includes(carbonLifecycleChildMode)) {
  postActionService = require('../services/demoPostActionService');
}

/** 生成测试 SHA-256。 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** 按对象键排序生成测试侧稳定 JSON，不复制正式 Carbon 计算算法。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 对人工固定的正式结果投影生成测试侧 canonical 摘要。 */
function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/** 插入正式导入批次。 */
function insertImportBatch(db, importType, suffix) {
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count)
    VALUES (?, ?, 'xlsx', 'completed', 'execute', 0, 0, 0, 0)`).run(
    importType,
    `${suffix}.xlsx`
  ).lastInsertRowid);
}

/** 绑定一个已执行 managed context 与 primary batch。 */
function bindArtifact(db, run, input) {
  const contextId = `carbon-action-context-${input.artifactKey}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
     artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
     status, issued_at, expires_at, upload_file_sha256, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'executed', ?, ?, ?, ?)`).run(
    contextId,
    sha256(contextId),
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    input.artifactKey,
    input.handlerKey,
    sha256(`artifact-${contextId}`),
    now,
    new Date(Date.now() + 3600000).toISOString(),
    sha256(`upload-${contextId}`),
    now
  );
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, 'primary')`).run(run.runId, input.artifactKey, contextId, input.batchId);
  return contextId;
}

/** 登记单条 imported ownership。 */
function registerImported(db, run, artifactKey, entityType, entityPk, batchId, rowNumber) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`).run(
    run.runId,
    artifactKey,
    entityType,
    String(entityPk),
    calculateDemoEntityIdentityDigest(entityType, String(entityPk)),
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    batchId,
    rowNumber
  );
}

/** 业务行变化后刷新正式 ownership 快照。 */
function refreshSnapshot(db, entityType, entityPk) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE entity_type = ? AND entity_pk = ? AND cleaned_at IS NULL`).run(
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    entityType,
    String(entityPk)
  );
}

/** 创建 calculated、factor_missing 和未归属哨兵组成的 Carbon 输入闭包。 */
function seedCarbonEvidence(db, run) {
  const factorBatchId = insertImportBatch(db, 'carbon_factor', 'carbon-action-factors');
  const activityBatchId = insertImportBatch(db, 'carbon_activity', 'carbon-action-activities');
  const factorContextId = bindArtifact(db, run, {
    artifactKey: '11-carbon-factors',
    handlerKey: 'carbon-factors-import',
    batchId: factorBatchId
  });
  const activityContextId = bindArtifact(db, run, {
    artifactKey: '27-carbon-activities',
    handlerKey: 'carbon-activity-import',
    batchId: activityBatchId
  });
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES ('CARBON-ACTION-OU', 'Carbon 动作组织', '/CARBON-ACTION-OU', 'department', 'active')`)
    .run().lastInsertRowid);
  const insertEnergyType = db.prepare(`INSERT INTO energy_types
    (code, name, category, default_unit, standard_unit, carbon_factor_required, is_active, display_order)
    VALUES (?, ?, 'other', 'unit', 'unit', 1, 1, 995)`);
  const calculatedEnergyTypeId = Number(insertEnergyType.run('carbon-action-calculated', 'Carbon 已匹配').lastInsertRowid);
  const missingEnergyTypeId = Number(insertEnergyType.run('carbon-action-missing', 'Carbon 缺因子').lastInsertRowid);
  const factorId = Number(db.prepare(`INSERT INTO carbon_factors
    (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
     factor_value, factor_unit, source, effective_from, effective_to, is_active)
    VALUES (?, 1, ?, 'cn-action', 2026, 'unit', 0.125, 'kgCO2e',
      'carbon-action-factor', '2000-01-01', '2099-12-31', 1)`).run(
    factorBatchId,
    calculatedEnergyTypeId
  ).lastInsertRowid);
  registerImported(db, run, '11-carbon-factors', 'carbon_factor', factorId, factorBatchId, 1);
  const insertActivity = db.prepare(`INSERT INTO carbon_activity_records
    (source_type, source_batch_id, source_row_number, energy_record_id,
     activity_code, activity_code_key, emission_scope, activity_category,
     activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
     end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
     factor_region, source_reference, duplicate_key, record_status)
    VALUES ('independent_activity', ?, ?, NULL, ?, ?, 'scope_1', ?, ?, ?, ?,
      ?, ?, 'Asia/Shanghai', ?, ?, ?, 'unit', 'cn-action', ?, ?, 'active')`);
  const calculatedActivityId = Number(insertActivity.run(
    activityBatchId, 1, 'CARBON-ACTION-CALC', 'carbon-action-calc', '已匹配活动', '已匹配活动',
    organizationUnitId, calculatedEnergyTypeId, '2026-01-01T08:00', '2026-01-01T09:00',
    '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 8,
    'source-calc', sha256('carbon-action-calc')
  ).lastInsertRowid);
  const missingActivityId = Number(insertActivity.run(
    activityBatchId, 2, 'CARBON-ACTION-MISSING', 'carbon-action-missing', '缺因子活动', '缺因子活动',
    organizationUnitId, missingEnergyTypeId, '2026-01-02T08:00', '2026-01-02T09:00',
    '2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z', 3,
    'source-missing', sha256('carbon-action-missing')
  ).lastInsertRowid);
  registerImported(db, run, '27-carbon-activities', 'carbon_activity_record', calculatedActivityId, activityBatchId, 1);
  registerImported(db, run, '27-carbon-activities', 'carbon_activity_record', missingActivityId, activityBatchId, 2);
  const formalFactorId = Number(db.prepare(`INSERT INTO carbon_factors
    (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
    VALUES (?, 'cn-action', 2026, 'unit', 999, 'kgCO2e', 'formal-factor-sentinel', 1)`)
    .run(calculatedEnergyTypeId).lastInsertRowid);
  const formalActivityId = Number(db.prepare(`INSERT INTO carbon_activity_records
    (source_type, energy_record_id, activity_code, activity_code_key, emission_scope,
     activity_category, activity_category_key, organization_unit_id, energy_type_id,
     start_wall_clock, end_wall_clock, source_timezone, start_utc, end_utc,
     activity_value, activity_unit, factor_region, source_reference, duplicate_key, record_status)
    VALUES ('independent_activity', NULL, 'CARBON-ACTION-FORMAL', 'carbon-action-formal', 'scope_1',
      '正式哨兵', '正式哨兵', ?, ?, '2026-01-01T08:00', '2026-01-01T09:00', 'Asia/Shanghai',
      '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 999, 'unit', 'cn-action',
      'formal-activity-sentinel', ?, 'active')`).run(
    organizationUnitId,
    calculatedEnergyTypeId,
    sha256('carbon-action-formal')
  ).lastInsertRowid);
  return {
    factorBatchId,
    activityBatchId,
    factorContextId,
    activityContextId,
    factorId,
    calculatedActivityId,
    missingActivityId,
    formalFactorId,
    formalActivityId,
    organizationUnitId,
    calculatedEnergyTypeId
  };
}

/** 在当前事务补足 4999 条 imported 活动，用于验证 adapter preview 的 5001 上限。 */
function seedCarbonPreviewActivityLimit(db, run, evidence) {
  const insertActivity = db.prepare(`INSERT INTO carbon_activity_records
    (source_type, source_batch_id, source_row_number, energy_record_id,
     activity_code, activity_code_key, emission_scope, activity_category,
     activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
     end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
     factor_region, source_reference, duplicate_key, record_status)
    VALUES ('independent_activity', ?, ?, NULL, ?, ?, 'scope_1', '上限活动', '上限活动',
      ?, ?, '2026-01-03T08:00', '2026-01-03T09:00', 'Asia/Shanghai',
      '2026-01-03T00:00:00Z', '2026-01-03T01:00:00Z', 1, 'unit', 'cn-action',
      ?, ?, 'active')`);
  for (let rowNumber = 3; rowNumber <= 5001; rowNumber += 1) {
    const activityCode = `CARBON-ACTION-LIMIT-${rowNumber}`;
    const activityId = Number(insertActivity.run(
      evidence.activityBatchId,
      rowNumber,
      activityCode,
      activityCode.toLowerCase(),
      evidence.organizationUnitId,
      evidence.calculatedEnergyTypeId,
      `source-limit-${rowNumber}`,
      sha256(`carbon-action-limit-${rowNumber}`)
    ).lastInsertRowid);
    registerImported(
      db,
      run,
      '27-carbon-activities',
      'carbon_activity_record',
      activityId,
      evidence.activityBatchId,
      rowNumber
    );
  }
}

/** 创建 direct adapter 使用的 executing action run。 */
function insertExecutingActionRun(db, run, suffix) {
  const registry = postActionRegistry.getDemoPostActionRegistryIdentity();
  const now = new Date().toISOString();
  const actionRunId = `carbon-private-${suffix}`;
  db.prepare(`INSERT INTO demo_post_action_runs
    (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
     executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
     runtime_epoch, runtime_revision, input_digest, preview_digest, output_count,
     preview_expires_at, input_json, requested_by, status, created_at, started_at, updated_at)
    VALUES (?, ?, ?, 'carbon-accounting-run', ?, 'carbon-accounting-resolver:v1',
      'carbon-accounting-executor:v1', ?, ?, ?, ?, 1, 1, ?, ?, 0, ?, '{}', 1,
      'executing', ?, ?, ?)`).run(
    actionRunId,
    run.runId,
    run.datasetId,
    registry.version,
    `carbon-private-request-${suffix}`,
    run.manifestVersion,
    run.manifestDigest,
    registry.digest,
    sha256(`input-${suffix}`),
    sha256(`preview-${suffix}`),
    new Date(Date.now() + 3600000).toISOString(),
    now,
    now,
    now
  );
  return actionRunId;
}

/** 读取 Carbon 与后置动作目标写入数量。 */
function readWriteCounts(db) {
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
    results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
    domainAudits: Number(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'carbon.accounting.run.create'").get().total),
    derived: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE ownership_kind = 'derived'").get().total),
    relations: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total),
    outputs: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_post_action_outputs').get().total)
  };
}

/**
 * 仅从 Carbon 业务表反向构造成功 execute 的期望集合，并交叉验证审计、ownership、relations 与 outputs。
 * 不使用 adapter DTO 或 public execute 返回值作为期望来源。
 */
function assertCarbonPublicExecutePersistence(db, input) {
  const calculationRuns = db.prepare(`SELECT id, status, result_count AS resultCount
    FROM carbon_calculation_runs ORDER BY id`).all();
  assert.strictEqual(calculationRuns.length, 1, 'public execute 必须只创建一个真实 calculation run。');
  const calculationRun = calculationRuns[0];
  assert.strictEqual(calculationRun.status, 'completed');
  const resultRows = db.prepare(`SELECT id, calculation_run_id AS calculationRunId,
      activity_record_id AS activityRecordId, carbon_factor_id AS carbonFactorId, status
    FROM carbon_accounting_results WHERE calculation_run_id = ? ORDER BY id`).all(
    calculationRun.id
  );
  assert.strictEqual(resultRows.length, Number(calculationRun.resultCount));
  const expectedOutputFacts = [
    `carbon_calculation_run:${calculationRun.id}`,
    ...resultRows.map((row) => `carbon_accounting_result:${row.id}`)
  ].sort();

  const actionRun = db.prepare(`SELECT run_id AS runId, status, output_count AS outputCount,
      input_digest AS inputDigest, result_digest AS resultDigest,
      registry_digest AS registryDigest, requested_by AS requestedBy
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(input.actionRunId);
  assert.deepStrictEqual({
    runId: actionRun.runId,
    status: actionRun.status,
    outputCount: Number(actionRun.outputCount)
  }, {
    runId: input.runId,
    status: 'succeeded',
    outputCount: expectedOutputFacts.length
  });
  const executeAudits = db.prepare(`SELECT user_id AS userId, target_type AS targetType,
      target_id AS targetId, detail_json AS detailJson FROM sys_operation_logs
    WHERE operation = 'system.demo.post-action.execute' AND target_id = ? ORDER BY id`).all(
    input.actionRunId
  );
  assert.strictEqual(executeAudits.length, 1, '成功 execute audit 必须恰好一条。');
  const executeAudit = executeAudits[0];
  const executeAuditDetail = JSON.parse(executeAudit.detailJson);
  assert.deepStrictEqual(Object.keys(executeAuditDetail).sort(), [
    'actionKey',
    'inputDigest',
    'outputCount',
    'registryDigest',
    'resultDigest',
    'status'
  ]);
  assert.deepStrictEqual({
    userId: Number(executeAudit.userId),
    targetType: executeAudit.targetType,
    targetId: executeAudit.targetId,
    actionKey: executeAuditDetail.actionKey,
    status: executeAuditDetail.status,
    inputDigest: executeAuditDetail.inputDigest,
    resultDigest: executeAuditDetail.resultDigest,
    registryDigest: executeAuditDetail.registryDigest,
    outputCount: executeAuditDetail.outputCount
  }, {
    userId: Number(actionRun.requestedBy),
    targetType: 'demo_post_action_run',
    targetId: input.actionRunId,
    actionKey: 'carbon-accounting-run',
    status: 'succeeded',
    inputDigest: actionRun.inputDigest,
    resultDigest: actionRun.resultDigest,
    registryDigest: actionRun.registryDigest,
    outputCount: String(expectedOutputFacts.length)
  });

  const derivedRows = db.prepare(`SELECT registry_id AS registryId, entity_type AS entityType,
      entity_pk AS entityPk FROM demo_data_registry
    WHERE run_id = ? AND ownership_kind = 'derived' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(input.runId);
  assert.deepStrictEqual(
    derivedRows.map((row) => `${row.entityType}:${row.entityPk}`).sort(),
    expectedOutputFacts,
    'derived ownership 的 entity type/PK 必须精确对应真实 run/results。'
  );

  const relationRows = db.prepare(`SELECT relation_type AS relationType,
      source.entity_type AS sourceEntityType, source.entity_pk AS sourceEntityPk,
      target.entity_type AS targetEntityType, target.entity_pk AS targetEntityPk
    FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.run_id = ? ORDER BY relation.relation_id`).all(input.runId);
  const expectedRelations = [];
  resultRows.forEach((row) => {
    expectedRelations.push(
      `contains:carbon_calculation_run:${calculationRun.id}->carbon_accounting_result:${row.id}`,
      `generated_from:carbon_accounting_result:${row.id}->carbon_activity_record:${row.activityRecordId}`
    );
    if (row.status === 'calculated') {
      expectedRelations.push(
        `uses_factor:carbon_accounting_result:${row.id}->carbon_factor:${row.carbonFactorId}`
      );
    }
  });
  const actualRelations = relationRows.map((row) => (
    `${row.relationType}:${row.sourceEntityType}:${row.sourceEntityPk}`
      + `->${row.targetEntityType}:${row.targetEntityPk}`
  ));
  assert.deepStrictEqual(actualRelations.sort(), expectedRelations.sort());
  assert.deepStrictEqual(
    relationRows.reduce((counts, row) => ({
      ...counts,
      [row.relationType]: (counts[row.relationType] || 0) + 1
    }), {}),
    {
      contains: resultRows.length,
      generated_from: resultRows.length,
      uses_factor: resultRows.filter((row) => row.status === 'calculated').length
    }
  );

  const outputRows = db.prepare(`SELECT output_entity_type AS outputEntityType,
      output_entity_id AS outputEntityId FROM demo_post_action_outputs
    WHERE action_run_id = ? ORDER BY output_id`).all(input.actionRunId);
  assert.deepStrictEqual(
    outputRows.map((row) => `${row.outputEntityType}:${row.outputEntityId}`).sort(),
    expectedOutputFacts,
    '每条 output entity type/ID 必须精确对应真实 calculation run/results。'
  );
}

/** 读取 direct preview 相关表的完整稳定快照和连接累计写入计数。 */
function readPreviewWriteSnapshot(db) {
  const tableNames = [
    'carbon_calculation_runs',
    'carbon_accounting_results',
    'sys_operation_logs',
    'demo_data_registry',
    'demo_data_relations',
    'demo_post_action_outputs'
  ];
  return {
    totalChanges: Number(db.prepare('SELECT total_changes() AS total').get().total),
    tables: Object.fromEntries(tableNames.map((tableName) => [
      tableName,
      db.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all()
    ]))
  };
}

/** 在隔离子进程验证 adapter、service 与 exact/ownership protocol 的 CommonJS 身份合同。 */
function assertProductionModuleIdentityContracts() {
  const script = String.raw`
    'use strict';
    const assert = require('assert');
    const adapterPath = require.resolve('./server/src/services/demoPostActionCarbonAccountingAdapter');
    const exactPath = require.resolve('./server/src/services/carbonAccountingExactProtocol');
    const ownershipPath = require.resolve('./server/src/services/carbonAccountingOwnershipProtocol');
    const servicePath = require.resolve('./server/src/services/demoPostActionService');
    const corePath = require.resolve('./server/src/services/demoPostActionCanonicalService');
    const ownershipProtocolModule = require(ownershipPath);
    const adapter = require(adapterPath);
    const exact = require(exactPath);
    const service = require(servicePath);
    [adapterPath, exactPath, ownershipPath].forEach((modulePath) => {
      const first = require(modulePath);
      const cachedModule = require.cache[modulePath];
      const descriptor = Object.getOwnPropertyDescriptor(cachedModule, 'exports');
      assert.strictEqual(descriptor.value, first);
      assert.strictEqual(descriptor.writable, false);
      assert.strictEqual(descriptor.configurable, false);
      assert.strictEqual(Object.isFrozen(first), true);
      assert.throws(() => { cachedModule.exports = {}; }, TypeError);
      assert.strictEqual(require(modulePath), first);
    });
    assert.strictEqual(require.cache[servicePath].children.includes(require.cache[corePath]), true);
    assert.strictEqual(require.cache[corePath].children.includes(require.cache[adapterPath]), true);
    assert.strictEqual(require.cache[adapterPath].children.includes(require.cache[exactPath]), true);
    assert.strictEqual(require.cache[adapterPath].children.includes(require.cache[ownershipPath]), true);
    assert.deepStrictEqual(Object.keys(exact).sort(), [
      'buildExactScopeInCallerTransaction',
      'consumeCalculationWitnessInCallerTransaction',
      'executeExactInCallerTransaction',
      'inspectRegistrationContextInCallerTransaction'
    ]);
    const malicious = () => {
      const error = new Error('malicious replacement');
      error.code = 'MALICIOUS_HANDLER_CALLED';
      throw error;
    };
    require.cache[exactPath] = {
      id: exactPath, filename: exactPath, loaded: true, children: [], paths: [],
      exports: { inspectRegistrationContextInCallerTransaction: malicious }
    };
    require.cache[ownershipPath] = {
      id: ownershipPath, filename: ownershipPath, loaded: true, children: [], paths: [],
      exports: { carbonAccountingOwnershipProtocol: {
        issueRegistrationScopeInCallerTransaction: malicious,
        registerDerivedOwnershipInCallerTransaction: malicious,
        verifyRegistrationReceiptInCallerTransaction: malicious,
        abortRegistrationScopeInCallerTransaction: malicious
      } }
    };
    require.cache[adapterPath] = {
      id: adapterPath, filename: adapterPath, loaded: true, children: [], paths: [],
      exports: { resolve: malicious, previewProbe: malicious, revalidate: malicious, execute: malicious }
    };
    assert.throws(() => adapter.previewProbe({
      db: null,
      privateContext: { demoRun: null, actor: null, preview: null }
    }), (error) => error && error.code !== 'MALICIOUS_HANDLER_CALLED');
    assert.strictEqual(service.getDemoPostActionRegistry().identity.version, 'demo-post-actions:v7');
    assert.strictEqual(
      typeof ownershipProtocolModule.carbonAccountingOwnershipProtocol.issueRegistrationScopeInCallerTransaction,
      'function'
    );
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    encoding: 'utf8',
    windowsHide: true
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
}

/** 递归确认公开投影不包含 Carbon 私有字段、SQL 或恶意哨兵。 */
function assertPublicProjectionSafe(value) {
  const forbiddenFields = new Set([
    'entitypk', 'importbatchid', 'contextid', 'registryid', 'ownership',
    'privatedigest', 'privatescopedigest', 'identitydigest', 'snapshotdigest', 'capability',
    'witness', 'receipt', 'actor', 'sql', 'details'
  ]);
  const inspect = (item) => {
    if (typeof item === 'string') {
      assert.strictEqual(/PRIVATE_SENTINEL|SELECT \* FROM private_table/i.test(item), false);
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(inspect);
      return;
    }
    Object.entries(item).forEach(([fieldName, fieldValue]) => {
      assert.strictEqual(forbiddenFields.has(fieldName.toLowerCase()), false,
        `公开投影不得包含 ${fieldName}。`);
      inspect(fieldValue);
    });
  };
  inspect(value);
}

/** 对 current marker 或 legacy terminal 行逐叶验证 Carbon public input 标量白名单。 */
function assertCarbonTerminalInputScalarProjection(input) {
  const maliciousObject = {
    actor: 'PRIVATE_SENTINEL',
    capability: 'PRIVATE_SENTINEL',
    witness: 'PRIVATE_SENTINEL',
    receipt: 'PRIVATE_SENTINEL',
    privateDigest: 'PRIVATE_SENTINEL',
    privateScopeDigest: 'PRIVATE_SENTINEL',
    sql: 'SELECT * FROM private_table',
    details: 'PRIVATE_SENTINEL'
  };
  const invalidScalarValues = [
    maliciousObject,
    [maliciousObject],
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    Number.MAX_SAFE_INTEGER + 1
  ];
  const leafCases = [
    { name: 'scope.startUtc', set: (value, raw) => { raw.scope.startUtc = value; },
      setExpected: (expected) => { expected.input.scope = null; } },
    { name: 'scope.endUtc', set: (value, raw) => { raw.scope.endUtc = value; },
      setExpected: (expected) => { expected.input.scope = null; } },
    ...[
      'activityCount', 'factorCount', 'expectedRunCount', 'expectedResultCount',
      'expectedOutputCount', 'calculatedCount', 'factorMissingCount'
    ].map((fieldName) => ({
      name: fieldName,
      set: (value, raw) => { raw[fieldName] = value; },
      setExpected: (expected) => { expected.input[fieldName] = 0; },
      values: [...invalidScalarValues, '3']
    })),
    { name: 'dependencies.code', set: (value, raw) => { raw.dependencies[0].code = value; },
      setExpected: (expected) => { expected.input.dependencies[0].code = null; },
      values: [...invalidScalarValues, 'PRIVATE_SENTINEL'] },
    { name: 'dependencies.blocking', set: (value, raw) => { raw.dependencies[0].blocking = value; },
      setExpected: (expected) => { expected.input.dependencies[0].blocking = false; },
      values: [...invalidScalarValues, 'true'] },
    { name: 'dependencies.count', set: (value, raw) => { raw.dependencies[0].count = value; },
      setExpected: (expected) => { expected.input.dependencies[0].count = 0; },
      values: [...invalidScalarValues, '1'] }
  ];
  const replayTerminal = () => [
    input.service.getDemoPostActionStatus({
      actionRunId: input.actionRunId,
      actorUserId: 1
    }),
    input.service.previewDemoPostAction({
      runId: input.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: input.clientRequestId }
    }),
    input.service.executeDemoPostAction({
      actionRunId: input.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId: input.clientRequestId,
        previewDigest: input.previewDigest,
        confirmationText: input.confirmationText
      }
    })
  ];
  assert.deepStrictEqual(replayTerminal(), [input.succeeded, input.succeeded, input.succeeded]);
  const sourceCase = JSON.parse(JSON.stringify(input.persistedInput));
  sourceCase.sources = [maliciousObject];
  input.updateInput(sourceCase);
  assert.deepStrictEqual(replayTerminal(), [input.succeeded, input.succeeded, input.succeeded]);
  const scopeContainerCase = JSON.parse(JSON.stringify(input.persistedInput));
  scopeContainerCase.scope = [maliciousObject];
  input.updateInput(scopeContainerCase);
  const scopeExpected = JSON.parse(JSON.stringify(input.succeeded));
  scopeExpected.input.scope = null;
  assert.deepStrictEqual(replayTerminal(), [scopeExpected, scopeExpected, scopeExpected]);
  const dependencyContainerCase = JSON.parse(JSON.stringify(input.persistedInput));
  dependencyContainerCase.dependencies = maliciousObject;
  input.updateInput(dependencyContainerCase);
  const dependencyExpected = JSON.parse(JSON.stringify(input.succeeded));
  dependencyExpected.input.dependencies = [];
  assert.deepStrictEqual(replayTerminal(), [dependencyExpected, dependencyExpected, dependencyExpected]);
  leafCases.forEach((leafCase) => {
    (leafCase.values || invalidScalarValues).forEach((invalidValue) => {
      const raw = JSON.parse(JSON.stringify(input.persistedInput));
      leafCase.set(invalidValue, raw);
      input.updateInput(raw);
      const expected = JSON.parse(JSON.stringify(input.succeeded));
      leafCase.setExpected(expected);
      const replayed = replayTerminal();
      assert.deepStrictEqual(replayed, [expected, expected, expected], leafCase.name);
      replayed.forEach(assertPublicProjectionSafe);
    });
  });
  input.updateInput(input.persistedInput);
}

/** 对 terminal status/preview/execute 三入口复核 Carbon public UTC scope 的统一安全投影。 */
function assertCarbonTerminalUtcScopeProjection(input) {
  const validStartUtc = '2026-01-01T00:00:00Z';
  const validEndUtc = '2026-01-02T01:00:00Z';
  const invalidCases = [
    { name: 'private-text', startUtc: 'PRIVATE_SENTINEL', endUtc: validEndUtc },
    { name: 'sql', startUtc: 'SELECT * FROM private_table', endUtc: validEndUtc },
    { name: 'date-only', startUtc: '2026-01-01', endUtc: validEndUtc },
    { name: 'offset', startUtc: '2026-01-01T08:00:00+08:00', endUtc: validEndUtc },
    { name: 'invalid-calendar', startUtc: '2026-02-30T00:00:00Z', endUtc: validEndUtc },
    { name: 'non-zero-millisecond', startUtc: '2026-01-01T00:00:00.001Z', endUtc: validEndUtc },
    { name: 'overlong', startUtc: validStartUtc.repeat(20), endUtc: validEndUtc },
    { name: 'equal', startUtc: validStartUtc, endUtc: validStartUtc },
    { name: 'reverse', startUtc: validEndUtc, endUtc: validStartUtc },
    { name: 'single-valid-start', startUtc: validStartUtc, endUtc: null },
    { name: 'single-valid-end', startUtc: null, endUtc: validEndUtc },
    { name: 'object', startUtc: { sql: 'PRIVATE_SENTINEL' }, endUtc: validEndUtc },
    { name: 'array', startUtc: validStartUtc, endUtc: ['PRIVATE_SENTINEL'] }
  ];
  const validCases = [
    {
      name: 'strict-second-z',
      startUtc: validStartUtc,
      endUtc: validEndUtc,
      expected: { startUtc: validStartUtc, endUtc: validEndUtc }
    },
    {
      name: 'zero-millisecond-fold',
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-01-02T01:00:00.000Z',
      expected: { startUtc: validStartUtc, endUtc: validEndUtc }
    },
    {
      name: 'second-ordering',
      startUtc: '2026-01-01T00:00:01Z',
      endUtc: '2026-01-01T00:00:02Z',
      expected: {
        startUtc: '2026-01-01T00:00:01Z',
        endUtc: '2026-01-01T00:00:02Z'
      }
    }
  ];
  const replayTerminal = () => [
    input.service.getDemoPostActionStatus({
      actionRunId: input.actionRunId,
      actorUserId: 1
    }),
    input.service.previewDemoPostAction({
      runId: input.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: input.clientRequestId }
    }),
    input.service.executeDemoPostAction({
      actionRunId: input.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId: input.clientRequestId,
        previewDigest: input.previewDigest,
        confirmationText: input.confirmationText
      }
    })
  ];
  const setRawScope = (target, rawPayloads, scope) => {
    if (target === 'input') rawPayloads.input.scope = scope;
    if (target === 'result') rawPayloads.result.scope = scope;
    if (target === 'outputRef') Object.assign(rawPayloads.outputRef, scope);
  };
  const setExpectedScope = (target, expected, scope) => {
    if (target === 'input') expected.input.scope = scope;
    if (target === 'result') expected.result.scope = scope;
    if (target === 'outputRef') {
      const output = expected.outputs.find((item) => (
        item.outputEntityType === 'carbon_calculation_run'
      ));
      output.outputRef.startUtc = scope?.startUtc || null;
      output.outputRef.endUtc = scope?.endUtc || null;
    }
  };
  input.targets.forEach((target) => {
    [...invalidCases.map((item) => ({ ...item, expected: null })), ...validCases]
      .forEach((scopeCase) => {
        const rawPayloads = {
          input: JSON.parse(JSON.stringify(input.persistedInput)),
          result: input.persistedResult === null
            ? null
            : JSON.parse(JSON.stringify(input.persistedResult)),
          outputRef: JSON.parse(JSON.stringify(input.persistedOutputRef))
        };
        setRawScope(target, rawPayloads, {
          startUtc: scopeCase.startUtc,
          endUtc: scopeCase.endUtc
        });
        input.updatePayloads(rawPayloads);
        const expected = JSON.parse(JSON.stringify(input.terminal));
        setExpectedScope(target, expected, scopeCase.expected);
        const replayed = replayTerminal();
        assert.deepStrictEqual(replayed, [expected, expected, expected], `${target}:${scopeCase.name}`);
        replayed.forEach(assertPublicProjectionSafe);
      });
  });
  input.updatePayloads({
    input: input.persistedInput,
    result: input.persistedResult,
    outputRef: input.persistedOutputRef
  });
}

/** 对 succeeded terminal 三入口复核 Carbon 业务字符串值域和状态关联投影。 */
function assertCarbonTerminalBusinessStringProjection(input) {
  const maliciousObject = { sql: 'SELECT * FROM private_table', privateDigest: 'PRIVATE_SENTINEL' };
  const maliciousValues = [
    'PRIVATE_SENTINEL',
    'SELECT * FROM private_table',
    maliciousObject,
    [maliciousObject],
    null,
    'X'.repeat(256),
    'kgCO2e\nSELECT * FROM private_table',
    String.fromCharCode(0) + 'kgCO2e',
    'unknown-business-value'
  ];
  // JSON 可持久化的非 number 类型必须全部 fail-closed，不能依靠 Number(...) 隐式转换。
  const invalidNumericValues = ['1', '', true, false, [], [1], {}, { value: 1 }, null];
  const replayTerminal = () => [
    input.service.getDemoPostActionStatus({
      actionRunId: input.actionRunId,
      actorUserId: 1
    }),
    input.service.previewDemoPostAction({
      runId: input.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: input.clientRequestId }
    }),
    input.service.executeDemoPostAction({
      actionRunId: input.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId: input.clientRequestId,
        previewDigest: input.previewDigest,
        confirmationText: input.confirmationText
      }
    })
  ];
  const calculationRunIndex = input.persistedOutputs.findIndex((output) => (
    output.outputEntityType === 'carbon_calculation_run'
  ));
  const calculatedResultIndex = input.persistedOutputs.findIndex((output) => (
    output.outputEntityType === 'carbon_accounting_result'
      && output.outputRef.status === 'calculated'
  ));
  const factorMissingResultIndex = input.persistedOutputs.findIndex((output) => (
    output.outputEntityType === 'carbon_accounting_result'
      && output.outputRef.status === 'factor_missing'
  ));
  assert.strictEqual(calculationRunIndex >= 0, true);
  assert.strictEqual(calculatedResultIndex >= 0, true);
  assert.strictEqual(factorMissingResultIndex >= 0, true);
  assert.match(
    input.persistedOutputs[calculationRunIndex].outputRef.runCode,
    /^CAR-\d{14}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.strictEqual(
    input.persistedOutputs[calculationRunIndex].outputRef.status,
    'completed'
  );
  assert.deepStrictEqual({
    status: input.persistedOutputs[calculatedResultIndex].outputRef.status,
    emissionUnit: input.persistedOutputs[calculatedResultIndex].outputRef.emissionUnit,
    missingReason: input.persistedOutputs[calculatedResultIndex].outputRef.missingReason
  }, { status: 'calculated', emissionUnit: 'kgCO2e', missingReason: null });
  assert.deepStrictEqual({
    status: input.persistedOutputs[factorMissingResultIndex].outputRef.status,
    emissionUnit: input.persistedOutputs[factorMissingResultIndex].outputRef.emissionUnit,
    missingReason: input.persistedOutputs[factorMissingResultIndex].outputRef.missingReason
  }, {
    status: 'factor_missing',
    emissionUnit: null,
    missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
  });
  assert.deepStrictEqual(replayTerminal(), [input.terminal, input.terminal, input.terminal]);

  const projectionCases = [];
  maliciousValues.forEach((invalidValue, valueIndex) => {
    projectionCases.push({
      name: `emission-totals-unit-${valueIndex}`,
      mutate(raw) { raw.result.emissionTotals.totals[0].emissionUnit = invalidValue; },
      mutateExpected(expected) { expected.result.emissionTotals.totals[0].emissionUnit = null; }
    });
    projectionCases.push({
      name: `calculation-run-code-${valueIndex}`,
      mutate(raw) { raw.outputs[calculationRunIndex].outputRef.runCode = invalidValue; },
      mutateExpected(expected) { expected.outputs[calculationRunIndex].outputRef.runCode = null; }
    });
    projectionCases.push({
      name: `calculation-run-status-${valueIndex}`,
      mutate(raw) { raw.outputs[calculationRunIndex].outputRef.status = invalidValue; },
      mutateExpected(expected) { expected.outputs[calculationRunIndex].outputRef.status = null; }
    });
    projectionCases.push({
      name: `calculated-status-${valueIndex}`,
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.status = invalidValue; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[calculatedResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    });
    projectionCases.push({
      name: `calculated-unit-${valueIndex}`,
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.emissionUnit = invalidValue; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[calculatedResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    });
    projectionCases.push({
      name: `factor-missing-status-${valueIndex}`,
      mutate(raw) { raw.outputs[factorMissingResultIndex].outputRef.status = invalidValue; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[factorMissingResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    });
    projectionCases.push({
      name: `factor-missing-reason-${valueIndex}`,
      mutate(raw) { raw.outputs[factorMissingResultIndex].outputRef.missingReason = invalidValue; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[factorMissingResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    });
  });
  invalidNumericValues.forEach((invalidValue, valueIndex) => {
    projectionCases.push({
      name: `emission-total-value-${valueIndex}`,
      mutate(raw) { raw.result.emissionTotals.totals[0].totalEmissionValue = invalidValue; },
      mutateExpected(expected) {
        expected.result.emissionTotals.totals[0].totalEmissionValue = null;
      }
    });
    projectionCases.push({
      name: `calculated-emission-value-${valueIndex}`,
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.emissionValue = invalidValue; },
      mutateExpected(expected) {
        expected.outputs[calculatedResultIndex].outputRef.emissionValue = null;
      }
    });
  });
  [...maliciousValues.filter((value) => value !== null), 'NO_ACTIVE_EXACT_UNIT_FACTOR']
    .forEach((invalidReason, valueIndex) => projectionCases.push({
      name: `calculated-reason-${valueIndex}`,
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.missingReason = invalidReason; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[calculatedResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    }));
  [...maliciousValues.filter((value) => value !== null), 'kgCO2e']
    .forEach((invalidUnit, valueIndex) => projectionCases.push({
      name: `factor-missing-unit-${valueIndex}`,
      mutate(raw) { raw.outputs[factorMissingResultIndex].outputRef.emissionUnit = invalidUnit; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[factorMissingResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    }));
  [
    {
      name: 'invalid-calendar-run-code',
      mutate(raw) {
        raw.outputs[calculationRunIndex].outputRef.runCode =
          'CAR-20260230000000-12345678-1234-4abc-8def-1234567890ab';
      },
      mutateExpected(expected) { expected.outputs[calculationRunIndex].outputRef.runCode = null; }
    },
    {
      name: 'calculated-as-factor-missing-inconsistent',
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.status = 'factor_missing'; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[calculatedResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    },
    {
      name: 'factor-missing-as-calculated-inconsistent',
      mutate(raw) { raw.outputs[factorMissingResultIndex].outputRef.status = 'calculated'; },
      mutateExpected(expected) {
        Object.assign(expected.outputs[factorMissingResultIndex].outputRef, {
          status: null, emissionUnit: null, missingReason: null
        });
      }
    },
    {
      name: 'calculated-unit-alias-canonicalized',
      mutate(raw) { raw.outputs[calculatedResultIndex].outputRef.emissionUnit = 'kg CO₂e'; },
      mutateExpected(expected) {
        expected.outputs[calculatedResultIndex].outputRef.emissionUnit = 'kgCO2e';
      }
    },
    {
      name: 'emission-totals-aliases-merged',
      mutate(raw) {
        raw.result.emissionTotals.totals = [
          { emissionUnit: 'kg CO₂e', totalEmissionValue: 1, calculatedCount: 2 },
          { emissionUnit: 'kgCO2e', totalEmissionValue: 2, calculatedCount: 3 }
        ];
      },
      mutateExpected(expected) {
        expected.result.emissionTotals.totals = [{
          emissionUnit: 'kgCO2e', totalEmissionValue: 3, calculatedCount: 5
        }];
      }
    },
    {
      name: 'emission-totals-alias-count-overflow-normalized',
      mutate(raw) {
        raw.result.emissionTotals.totals = [
          {
            emissionUnit: 'kg CO₂e / kWh',
            totalEmissionValue: 1.25,
            calculatedCount: Number.MAX_SAFE_INTEGER
          },
          {
            emissionUnit: 'kgCO2e/(kWh)',
            totalEmissionValue: 2.75,
            calculatedCount: 1
          }
        ];
      },
      mutateExpected(expected) {
        expected.result.emissionTotals.totals = [{
          emissionUnit: 'kgCO2e/kWh', totalEmissionValue: 4, calculatedCount: 0
        }];
      }
    }
  ].forEach((projectionCase) => projectionCases.push(projectionCase));

  projectionCases.forEach((projectionCase) => {
    const raw = {
      result: JSON.parse(JSON.stringify(input.persistedResult)),
      outputs: input.persistedOutputs.map((output) => ({
        ...output,
        outputRef: JSON.parse(JSON.stringify(output.outputRef))
      }))
    };
    projectionCase.mutate(raw);
    input.updatePayloads(raw);
    const expected = JSON.parse(JSON.stringify(input.terminal));
    projectionCase.mutateExpected(expected);
    const replayed = replayTerminal();
    assert.deepStrictEqual(
      replayed,
      [expected, expected, expected],
      projectionCase.name
    );
    replayed.forEach(assertPublicProjectionSafe);
  });
  input.updatePayloads({
    result: input.persistedResult,
    outputs: input.persistedOutputs
  });
}

/**
 * 对 current/legacy succeeded terminal 构造 marker 完整性矩阵。
 * projector 身份无法完整证明时，三入口必须统一降级且不得读取持久化私有 result/outputRef。
 */
function assertCarbonTerminalMarkerIntegrityMatrix(input) {
  const markerFields = [
    'publicProjectionActionKey',
    'publicProjectionResolverVersion',
    'publicProjectionExecutorVersion',
    'publicProjectionVersion'
  ];
  const currentIdentity = {
    name: 'current-v7',
    registryVersion: 'demo-post-actions:v7',
    registryDigest: '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:v1'
  };
  const historicalV6Identity = {
    name: 'historical-v6',
    registryVersion: 'demo-post-actions:v6',
    registryDigest: 'd8823f2b483c3695087a1520ef5b61ca376db6424c5d5b47ea616325efdb635f',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:v1'
  };
  const legacyIdentity = {
    name: 'legacy',
    registryVersion: 'demo-post-actions:v5',
    registryDigest: '98385f8fdc9170335995c3cb53a6b01c691570ce8315deef870f62b3101a47d8',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:not-connected'
  };
  const persistedRow = input.db.prepare(`SELECT input_json AS inputJson, result_json AS resultJson,
      registry_version AS registryVersion, registry_digest AS registryDigest,
      resolver_version AS resolverVersion, executor_version AS executorVersion
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(input.actionRunId);
  const persistedOutputs = input.db.prepare(`SELECT output_id AS outputId,
      output_ref_json AS outputRefJson FROM demo_post_action_outputs
    WHERE action_run_id = ? ORDER BY output_id`).all(input.actionRunId);
  const originalInput = JSON.parse(persistedRow.inputJson);
  const originalResult = JSON.parse(persistedRow.resultJson);
  const poisonedResult = {
    ...originalResult,
    privateResult: { sql: 'SELECT * FROM private_table', details: 'PRIVATE_SENTINEL' }
  };
  const poisonedOutputs = persistedOutputs.map((output) => ({
    outputId: Number(output.outputId),
    outputRef: {
      ...JSON.parse(output.outputRefJson),
      privateOutput: { sql: 'SELECT * FROM private_table', details: 'PRIVATE_SENTINEL' }
    }
  }));
  const expected = JSON.parse(JSON.stringify(input.terminal));
  expected.input = {};
  expected.result = null;
  expected.outputs = expected.outputs.map((output) => ({ ...output, outputRef: null }));

  /** 更新单个矩阵案例的持久化 identity、marker 和恶意私有载荷。 */
  const persistCase = (identity, marker) => {
    const markerInput = JSON.parse(JSON.stringify(originalInput));
    markerFields.forEach((fieldName) => { delete markerInput[fieldName]; });
    Object.assign(markerInput, marker, {
      privateInput: { sql: 'SELECT * FROM private_table', details: 'PRIVATE_SENTINEL' }
    });
    input.db.prepare(`UPDATE demo_post_action_runs
      SET registry_version = ?, registry_digest = ?, resolver_version = ?, executor_version = ?,
          input_json = ?, result_json = ?
      WHERE action_run_id = ?`).run(
      identity.registryVersion,
      identity.registryDigest,
      identity.resolverVersion,
      identity.executorVersion,
      JSON.stringify(markerInput),
      JSON.stringify(poisonedResult),
      input.actionRunId
    );
    poisonedOutputs.forEach((output) => {
      input.db.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
        WHERE output_id = ?`).run(JSON.stringify(output.outputRef), output.outputId);
    });
  };

  /** 从 status/preview/execute 三个 terminal 入口读取同一运行。 */
  const replayTerminal = () => [
    input.service.getDemoPostActionStatus({
      actionRunId: input.actionRunId,
      actorUserId: 1
    }),
    input.service.previewDemoPostAction({
      runId: input.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: input.clientRequestId }
    }),
    input.service.executeDemoPostAction({
      actionRunId: input.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId: input.clientRequestId,
        previewDigest: input.previewDigest,
        confirmationText: input.confirmationText
      }
    })
  ];

  /** 验证一个不可信 marker 案例统一 fail-closed 且不泄漏私有持久化载荷。 */
  const assertFailClosedCase = (identity, name, marker) => {
    persistCase(identity, marker);
    const replayed = replayTerminal();
    assert.deepStrictEqual(replayed, [expected, expected, expected], `${identity.name}:${name}`);
    replayed.forEach(assertPublicProjectionSafe);
    assert.strictEqual(
      /PRIVATE_SENTINEL|SELECT \* FROM private_table/i.test(JSON.stringify(replayed)),
      false,
      `${identity.name}:${name} 不得泄漏持久化私有 result/outputRef。`
    );
  };

  [currentIdentity, historicalV6Identity, legacyIdentity].forEach((identity) => {
    const completeMarker = {
      publicProjectionActionKey: 'carbon-accounting-run',
      publicProjectionResolverVersion: identity.resolverVersion,
      publicProjectionExecutorVersion: identity.executorVersion,
      publicProjectionVersion: 1
    };
    markerFields.forEach((missingField) => {
      const missingMarker = { ...completeMarker };
      delete missingMarker[missingField];
      assertFailClosedCase(identity, `missing-${missingField}`, missingMarker);
    });
    [
      ['forged-action-key', 'publicProjectionActionKey', 'prediction-run'],
      ['forged-resolver', 'publicProjectionResolverVersion', 'carbon-accounting-resolver:forged'],
      ['forged-executor', 'publicProjectionExecutorVersion', 'carbon-accounting-executor:forged'],
      ['forged-projection-version', 'publicProjectionVersion', 2]
    ].forEach(([name, fieldName, forgedValue]) => {
      assertFailClosedCase(identity, name, { ...completeMarker, [fieldName]: forgedValue });
    });
    assertFailClosedCase(identity, 'partial-marker', {
      publicProjectionActionKey: completeMarker.publicProjectionActionKey,
      publicProjectionVersion: completeMarker.publicProjectionVersion
    });
  });
  assertFailClosedCase(currentIdentity, 'current-executor-no-marker', {});

  input.db.prepare(`UPDATE demo_post_action_runs
    SET registry_version = ?, registry_digest = ?, resolver_version = ?, executor_version = ?,
        input_json = ?, result_json = ?
    WHERE action_run_id = ?`).run(
    persistedRow.registryVersion,
    persistedRow.registryDigest,
    persistedRow.resolverVersion,
    persistedRow.executorVersion,
    persistedRow.inputJson,
    persistedRow.resultJson,
    input.actionRunId
  );
  persistedOutputs.forEach((output) => {
    input.db.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
      WHERE output_id = ?`).run(output.outputRefJson, output.outputId);
  });
  assert.deepStrictEqual(replayTerminal(), [input.terminal, input.terminal, input.terminal]);
}

/** 返回 fault 子进程首次构造的 production-connected canonical 生命周期服务。 */
function loadConnectedCarbonLifecycleService() {
  assert(postActionService, 'fault 子进程必须已首次构造 canonical service。');
  const definition = postActionRegistry.requireDemoPostAction('carbon-accounting-run');
  assert.strictEqual(definition.implementationStatus, 'connected');
  assert.strictEqual(definition.executorVersion, 'carbon-accounting-executor:v1');
  return postActionService;
}

/** 在 fault 子进程内切换首次加载前安装的 registry 包装器，并继续返回同一 canonical service。 */
function loadDriftedCarbonHistoryService() {
  assert.strictEqual(typeof activateCarbonRegistryDrift, 'function');
  activateCarbonRegistryDrift();
  return postActionService;
}

/** 仅允许在全新恢复子进程第一次加载 service 前安装指定私有 adapter 与数据库计数器。 */
function loadConnectedCarbonLifecycleWithAdapter(fakeAdapter, databaseCounters = null) {
  const adapterPath = require.resolve('../services/demoPostActionCarbonAccountingAdapter');
  const databasePath = require.resolve('../db/database');
  const servicePath = require.resolve('../services/demoPostActionService');
  const corePath = require.resolve('../services/demoPostActionCanonicalService');
  const originalAdapterModule = require.cache[adapterPath];
  const originalDatabaseModule = require.cache[databasePath];
  assert.strictEqual(postActionService, null);
  assert.strictEqual(require.cache[servicePath], undefined);
  assert.strictEqual(require.cache[corePath], undefined);
  assert.strictEqual(
    postActionRegistry.requireDemoPostAction('carbon-accounting-run').implementationStatus,
    'connected'
  );
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: fakeAdapter,
    children: [],
    paths: []
  };
  if (databaseCounters) {
    const proxiedDatabaseExports = Object.create(
      Object.getPrototypeOf(originalDatabaseModule.exports)
    );
    Object.defineProperties(
      proxiedDatabaseExports,
      Object.getOwnPropertyDescriptors(originalDatabaseModule.exports)
    );
    const openDatabaseDescriptor = Object.getOwnPropertyDescriptor(
      originalDatabaseModule.exports,
      'openDatabase'
    );
    Object.defineProperty(proxiedDatabaseExports, 'openDatabase', {
      ...openDatabaseDescriptor,
      value(options) {
        databaseCounters.openDatabaseCalls += 1;
        return originalDatabaseModule.exports.openDatabase(options);
      }
    });
    require.cache[databasePath] = {
      id: databasePath,
      filename: databasePath,
      loaded: true,
      children: [],
      paths: [],
      exports: proxiedDatabaseExports
    };
  }
  try {
    postActionService = require(servicePath);
    return postActionService;
  } finally {
    require.cache[adapterPath] = originalAdapterModule;
    require.cache[databasePath] = originalDatabaseModule;
  }
}

/** 安装一个只作用于固定故障阶段的隔离 SQLite trigger。 */
function installFailureTrigger(db, stage) {
  const definitions = {
    calculation_run: `CREATE TRIGGER test_carbon_action_calculation_run
      BEFORE INSERT ON carbon_calculation_runs BEGIN
        SELECT RAISE(ABORT, 'TEST_CALCULATION_RUN_FAILURE');
      END`,
    calculation_result: `CREATE TRIGGER test_carbon_action_calculation_result
      BEFORE INSERT ON carbon_accounting_results BEGIN
        SELECT RAISE(ROLLBACK, 'TEST_CALCULATION_RESULT_FULL_ROLLBACK');
      END`,
    domain_audit: `CREATE TRIGGER test_carbon_action_domain_audit
      BEFORE INSERT ON sys_operation_logs
      WHEN NEW.operation = 'carbon.accounting.run.create' BEGIN
        SELECT RAISE(ABORT, 'TEST_DOMAIN_AUDIT_FAILURE');
      END`,
    registry: `CREATE TRIGGER test_carbon_action_registry
      BEFORE INSERT ON demo_data_registry BEGIN
        SELECT RAISE(ABORT, 'TEST_REGISTRY_FAILURE');
      END`,
    relation: `CREATE TRIGGER test_carbon_action_relation
      BEFORE INSERT ON demo_data_relations BEGIN
        SELECT RAISE(ABORT, 'TEST_RELATION_FAILURE');
      END`,
    output: `CREATE TRIGGER test_carbon_action_output
      BEFORE INSERT ON demo_post_action_outputs BEGIN
        SELECT RAISE(ABORT, 'TEST_OUTPUT_FAILURE');
      END`,
    succeeded_status: `CREATE TRIGGER test_carbon_action_succeeded_status
      BEFORE UPDATE OF status ON demo_post_action_runs
      WHEN NEW.status = 'succeeded' BEGIN
        SELECT RAISE(ABORT, 'TEST_SUCCEEDED_STATUS_FAILURE');
      END`,
    success_audit: `CREATE TRIGGER test_carbon_action_success_audit
      BEFORE INSERT ON sys_operation_logs
      WHEN NEW.operation = 'system.demo.post-action.execute'
        AND json_extract(NEW.detail_json, '$.status') = 'succeeded' BEGIN
        SELECT RAISE(ABORT, 'TEST_SUCCESS_AUDIT_FAILURE');
      END`
  };
  if (!Object.prototype.hasOwnProperty.call(definitions, stage)) {
    throw new Error(`未知 Carbon 生命周期故障阶段：${stage}`);
  }
  db.exec(definitions[stage]);
}

/** 删除当前隔离数据库中的专项 trigger。 */
function removeFailureTriggers(db) {
  const triggers = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'test_carbon_action_%'`).all();
  triggers.forEach((row) => db.exec(`DROP TRIGGER ${row.name}`));
}

/** 用隔离 fake private adapter 只验证通用 lifecycle 在连接已关闭后的重新打开恢复。 */
function runClosedConnectionRecoveryTest() {
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const fakeAdapter = Object.freeze({
    resolve() {
      return {
        domainInput: { sources: ['11-carbon-factors', '27-carbon-activities'], marker: 'closed-recovery' },
        evidence: null,
        privateContext: Object.freeze({ marker: 'closed-recovery' }),
        privateDigest: sha256('closed-recovery')
      };
    },
    previewProbe() {
      return { result: { marker: 'closed-recovery' }, outputCount: 0, outputs: [] };
    },
    revalidate() {
      return this.resolve();
    },
    execute(context) {
      context.db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, created_at)
        VALUES (1, 'carbon.accounting.run.create', 'carbon_calculation_run',
          'closed-recovery-sentinel', '{}', ?)`).run(new Date().toISOString());
      context.db.close();
      throw Object.assign(new Error('隔离连接关闭故障。'), { code: 'TEST_CONNECTION_CLOSED' });
    },
    projectPublicInput(input) { return input; },
    projectPublicResult(result) { return result; },
    mapPreviewBlocker(error) { return { code: error.code || 'TEST_BLOCKED', message: '测试阻断。' }; }
  });
  const connectedService = loadConnectedCarbonLifecycleWithAdapter(fakeAdapter);
  const definition = postActionRegistry.requireDemoPostAction('carbon-accounting-run');
  const clientRequestId = 'carbon-closed-recovery';
  const preview = connectedService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  });
  const failed = connectedService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.failureReason, 'TEST_CONNECTION_CLOSED');
  const verifyDb = openDatabase();
  try {
    assert.strictEqual(Number(verifyDb.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.accounting.run.create'
        AND target_id = 'closed-recovery-sentinel'`).get().total), 0);
    assert.strictEqual(verifyDb.prepare(`SELECT status FROM demo_post_action_runs
      WHERE action_run_id = ?`).get(preview.actionRunId).status, 'failed');
  } finally {
    verifyDb.close();
  }
}

/** 创建仅用于通用严重恢复矩阵的隔离私有 adapter。 */
function createRecoveryMatrixAdapter(marker, executeHandler) {
  const resolved = Object.freeze({
    domainInput: Object.freeze({ marker }),
    evidence: null,
    privateContext: Object.freeze({ marker }),
    privateDigest: sha256(marker)
  });
  return Object.freeze({
    resolve() { return resolved; },
    previewProbe() { return { result: { marker }, outputCount: 0, outputs: [] }; },
    revalidate() { return resolved; },
    execute: executeHandler,
    projectPublicInput(input) { return { marker: input.marker || null }; },
    projectPublicResult(result) { return result ? { marker: result.marker || null } : null; },
    mapPreviewBlocker(error) {
      return { code: error?.code || 'TEST_RECOVERY_BLOCKED', message: '测试恢复阻断。' };
    }
  });
}

/** 创建可在 outer transaction 与恢复阶段注入故障并记录每个恢复分支调用次数的数据库代理。 */
function createRecoveryDatabaseProxy(db, options = {}) {
  let recoveryPhase = false;
  let getterFailure = null;
  const sentinelTargetId = `recovery-transaction-sentinel-${options.sourceCode}`;
  const counters = {
    transactionCalls: 0,
    rollbackCalls: 0,
    closeCalls: 0,
    openGetterCalls: 0,
    inTransactionGetterCalls: 0,
    nameGetterCalls: 0
  };
  const sourceError = Object.assign(
    new Error(`PRIVATE_SENTINEL ${db.name} SELECT * FROM private_table`),
    { code: options.sourceCode || 'TEST_OUTER_TRANSACTION_FAILURE' }
  );
  const proxiedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'name') counters.nameGetterCalls += 1;
      if (property === 'open') counters.openGetterCalls += 1;
      if (property === 'inTransaction') counters.inTransactionGetterCalls += 1;
      if ((property === 'open' || property === 'inTransaction') && getterFailure === property) {
        throw new Error(`PRIVATE_SENTINEL ${String(property)} getter failure`);
      }
      if (property === 'transaction') {
        return (callback) => {
          counters.transactionCalls += 1;
          const transaction = target.transaction(callback);
          if (counters.transactionCalls !== 2 || !options.outerFailure) return transaction;
          const intercepted = (...args) => transaction(...args);
          Object.defineProperty(intercepted, 'immediate', {
            value: () => {
              if (options.leaveTransactionOpen) {
                target.exec('BEGIN IMMEDIATE');
                target.prepare(`INSERT INTO sys_operation_logs
                  (user_id, operation, target_type, target_id, detail_json, created_at)
                  VALUES (1, 'carbon.accounting.run.create', 'carbon_calculation_run', ?, '{}', ?)`)
                  .run(sentinelTargetId, new Date().toISOString());
              }
              recoveryPhase = true;
              getterFailure = options.getterFailure || null;
              throw sourceError;
            },
            enumerable: true
          });
          return intercepted;
        };
      }
      if (property === 'exec') {
        return (sql) => {
          if (/^\s*ROLLBACK\s*;?\s*$/i.test(String(sql))) {
            counters.rollbackCalls += 1;
            if (recoveryPhase && options.rollbackFailure) {
              throw new Error('PRIVATE_SENTINEL rollback SQL failure');
            }
          }
          return target.exec(sql);
        };
      }
      if (property === 'close') {
        return () => {
          counters.closeCalls += 1;
          if (recoveryPhase && options.closeFailureMode === 'before') {
            throw new Error('PRIVATE_SENTINEL close-before failure');
          }
          target.close();
          if (recoveryPhase && options.closeFailureMode === 'after') {
            throw new Error('PRIVATE_SENTINEL close-after failure');
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { db: proxiedDb, counters, sentinelTargetId };
}

/** 断言严重恢复错误固定脱敏，且不带 SQL、路径或 details。 */
function assertSanitizedRecoveryFailure(operation) {
  assert.throws(operation, (error) => {
    assert.strictEqual(error?.code, 'DEMO_POST_ACTION_RECOVERY_FAILED');
    assert.strictEqual(error?.message, '后置动作失败状态无法在已证明安全的事务边界内恢复。');
    assert.strictEqual(error?.details == null, true);
    const text = JSON.stringify({ code: error?.code, message: error?.message, details: error?.details });
    assert.strictEqual(/PRIVATE_SENTINEL|SELECT|\.sqlite|private_table/i.test(text), false);
    return true;
  });
}

/** 复核恢复场景只保留允许的 terminal 事实，事务哨兵与全部 Carbon 写入物理零残留。 */
function assertRecoveryPersistence(actionRunId, expectedStatus, expectedFailedAuditCount,
  sentinelTargetId = null) {
  const verifyDb = openDatabase();
  try {
    assert.deepStrictEqual(readWriteCounts(verifyDb), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    if (sentinelTargetId) {
      assert.strictEqual(Number(verifyDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_operation_logs WHERE operation = 'carbon.accounting.run.create'
          AND target_id = ?`).get(sentinelTargetId).total), 0);
    }
    assert.strictEqual(verifyDb.prepare(`SELECT status FROM demo_post_action_runs
      WHERE action_run_id = ?`).get(actionRunId).status, expectedStatus);
    const executeAudits = verifyDb.prepare(`SELECT json_extract(detail_json, '$.status') AS status
      FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute'
        AND target_id = ? ORDER BY id`).all(actionRunId);
    assert.strictEqual(executeAudits.filter((row) => row.status === 'failed').length,
      expectedFailedAuditCount);
    assert.strictEqual(executeAudits.filter((row) => row.status === 'succeeded').length, 0);
    assert.strictEqual(executeAudits.length, expectedFailedAuditCount);
  } finally {
    verifyDb.close();
  }
}

/** 覆盖通用 lifecycle 的 rollback/close/getter/reopen/admission/原路径严重恢复矩阵。 */
function runGenericRecoveryFailureMatrix() {
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const definition = postActionRegistry.requireDemoPostAction('carbon-accounting-run');
  const databaseCounters = { openDatabaseCalls: 0 };
  const noExecuteAdapter = createRecoveryMatrixAdapter('outer-recovery', () => {
    throw Object.assign(new Error('unexpected execute'), { code: 'UNEXPECTED_EXECUTE' });
  });
  const outerFailureService = carbonLifecycleChildMode === 'recovery-outer'
    ? loadConnectedCarbonLifecycleWithAdapter(noExecuteAdapter, databaseCounters)
    : null;

  const runOuterFailureCase = (suffix, proxyOptions, expected) => {
    const clientRequestId = `carbon-recovery-${suffix}`;
    const preview = outerFailureService.previewDemoPostAction({
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId }
    });
    databaseCounters.openDatabaseCalls = 0;
    const rawDb = openDatabase();
    const recoveryProxy = createRecoveryDatabaseProxy(rawDb, proxyOptions);
    const operation = () => outerFailureService.executeDemoPostAction({
      db: recoveryProxy.db,
      actionRunId: preview.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId,
        previewDigest: preview.previewDigest,
        confirmationText: definition.confirmationText
      }
    });
    if (expected.result) {
      const result = operation();
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.failureReason, proxyOptions.sourceCode);
    } else {
      assertSanitizedRecoveryFailure(operation);
    }
    assert.strictEqual(recoveryProxy.counters.transactionCalls, 2, suffix);
    assert.strictEqual(recoveryProxy.counters.rollbackCalls, expected.rollbackCalls, suffix);
    assert.strictEqual(recoveryProxy.counters.closeCalls, expected.closeCalls, suffix);
    assert.strictEqual(databaseCounters.openDatabaseCalls, expected.reopenCalls, suffix);
    assert.strictEqual(recoveryProxy.counters.nameGetterCalls, 3, suffix);
    assert.strictEqual(recoveryProxy.counters.openGetterCalls, expected.openGetterCalls, suffix);
    assert.strictEqual(
      recoveryProxy.counters.inTransactionGetterCalls,
      expected.inTransactionGetterCalls,
      suffix
    );
    if (expected.rawConnectionOpen) {
      assert.strictEqual(rawDb.open, true, `${suffix} 原始连接必须仍开启。`);
      assert.strictEqual(rawDb.inTransaction, true, `${suffix} 未证明的事务必须仍存在。`);
      rawDb.exec('ROLLBACK');
      assert.strictEqual(rawDb.inTransaction, false, `${suffix} 测试 cleanup 必须显式回滚哨兵。`);
      assert.doesNotThrow(() => rawDb.exec('BEGIN IMMEDIATE; COMMIT'),
        `${suffix} cleanup 主动关闭前原始连接必须仍可提交新事务。`);
      rawDb.close();
    } else {
      assert.strictEqual(rawDb.open, false, `${suffix} 原始连接必须已物理关闭。`);
      assert.strictEqual(rawDb.inTransaction, false, `${suffix} 关闭后不得保留事务。`);
      assert.throws(() => rawDb.exec('COMMIT'), `${suffix} 关闭后的连接不得接受 COMMIT。`);
    }
    assertRecoveryPersistence(
      preview.actionRunId,
      expected.status,
      expected.result ? 1 : 0,
      recoveryProxy.sentinelTargetId
    );
  };

  if (carbonLifecycleChildMode === 'recovery-outer') {
    runOuterFailureCase('rollback-fail-close-success', {
      outerFailure: true,
      leaveTransactionOpen: true,
      rollbackFailure: true,
      sourceCode: 'TEST_ROLLBACK_FAIL_CLOSE_SUCCESS'
    }, {
      status: 'failed', result: true, rollbackCalls: 1, closeCalls: 1, reopenCalls: 1,
      rawConnectionOpen: false, openGetterCalls: 4, inTransactionGetterCalls: 4
    });
    runOuterFailureCase('rollback-fail-close-before-throw', {
      outerFailure: true,
      leaveTransactionOpen: true,
      rollbackFailure: true,
      closeFailureMode: 'before',
      sourceCode: 'TEST_ROLLBACK_FAIL_CLOSE_BEFORE_THROW'
    }, {
      status: 'executing', result: false, rollbackCalls: 1, closeCalls: 1, reopenCalls: 0,
      rawConnectionOpen: true, openGetterCalls: 3, inTransactionGetterCalls: 3
    });
    runOuterFailureCase('rollback-fail-close-after-physical-close-throw', {
      outerFailure: true,
      leaveTransactionOpen: true,
      rollbackFailure: true,
      closeFailureMode: 'after',
      sourceCode: 'TEST_ROLLBACK_FAIL_CLOSE_AFTER_THROW'
    }, {
      status: 'failed', result: true, rollbackCalls: 1, closeCalls: 1, reopenCalls: 1,
      rawConnectionOpen: false, openGetterCalls: 4, inTransactionGetterCalls: 4
    });
    ['open', 'inTransaction'].forEach((getterFailure) => runOuterFailureCase(
      `${getterFailure}-getter-failure`,
      {
        outerFailure: true,
        leaveTransactionOpen: true,
        getterFailure,
        sourceCode: `TEST_${getterFailure.toUpperCase()}_GETTER_FAILURE`
      },
      {
        status: 'executing', result: false, rollbackCalls: 0, closeCalls: 0, reopenCalls: 0,
        rawConnectionOpen: true,
        openGetterCalls: 2,
        inTransactionGetterCalls: getterFailure === 'inTransaction' ? 2 : 1
      }
    ));
    return;
  }

  // 原连接关闭后，official SQLite admission permit 不匹配必须固定失败且不误写 terminal。
  if (carbonLifecycleChildMode === 'recovery-admission') {
    const admissionAdapter = createRecoveryMatrixAdapter('admission-mismatch', (context) => {
    context.db.close();
    throw Object.assign(new Error('PRIVATE_SENTINEL admission reopen'), {
      code: 'TEST_ADMISSION_REOPEN_FAILURE'
    });
  });
  const admissionCounters = { openDatabaseCalls: 0 };
  const admissionService = loadConnectedCarbonLifecycleWithAdapter(
    admissionAdapter,
    admissionCounters
  );
  const admissionClientRequestId = 'carbon-recovery-admission-mismatch';
  const admissionPreview = admissionService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId: admissionClientRequestId }
  });
  admissionCounters.openDatabaseCalls = 0;
  const admissionDb = openDatabase();
  const admissionPermit = blockDatabaseAdmission();
  try {
    assertSanitizedRecoveryFailure(() => admissionService.executeDemoPostAction({
      db: admissionDb,
      admissionPermit: Object.freeze({ invalid: true }),
      actionRunId: admissionPreview.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId: admissionClientRequestId,
        previewDigest: admissionPreview.previewDigest,
        confirmationText: definition.confirmationText
      }
    }));
    assert.strictEqual(admissionCounters.openDatabaseCalls, 1);
    assert.strictEqual(admissionDb.open, false);
    assert.strictEqual(admissionDb.inTransaction, false);
    assert.throws(() => admissionDb.exec('COMMIT'));
  } finally {
    if (admissionDb.open) admissionDb.close();
    unblockDatabaseAdmission(admissionPermit);
  }
    assertRecoveryPersistence(admissionPreview.actionRunId, 'executing', 0);
    return;
  }

  assert.strictEqual(carbonLifecycleChildMode, 'recovery-alternate');
  // 非默认隔离 SQLite 必须按原连接路径重开并只落 failed + failed audit。
  const alternateDatabasePath = path.join(temporaryRoot, 'alternate-carbon-recovery.sqlite');
  initDatabase({ databasePath: alternateDatabasePath });
  const alternateDb = openDatabase({ databasePath: alternateDatabasePath });
  let alternateRun;
  try {
    alternateDb.prepare(`UPDATE demo_runtime_settings SET enabled = 1,
      runtime_epoch = runtime_epoch + 1, revision = revision + 1,
      updated_by = 1, updated_at = ?, change_reason = 'test_alternate_recovery'
      WHERE id = 1`).run(new Date().toISOString());
    alternateRun = alternateDb.transaction(() => getOrCreateActiveDemoDatasetRun({
      db: alternateDb,
      actorUserId: 1
    })).immediate();
  } finally {
    alternateDb.close();
  }
  const alternateAdapter = createRecoveryMatrixAdapter('alternate-path', (context) => {
    context.db.close();
    throw Object.assign(new Error('PRIVATE_SENTINEL alternate path close'), {
      code: 'TEST_ALTERNATE_PATH_CLOSE'
    });
  });
  const alternateCounters = { openDatabaseCalls: 0 };
  const alternateService = loadConnectedCarbonLifecycleWithAdapter(
    alternateAdapter,
    alternateCounters
  );
  const alternateClientRequestId = 'carbon-recovery-alternate-path';
  const alternatePreviewDb = openDatabase({ databasePath: alternateDatabasePath });
  let alternatePreview;
  try {
    alternatePreview = alternateService.previewDemoPostAction({
      db: alternatePreviewDb,
      runId: alternateRun.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: alternateClientRequestId }
    });
  } finally {
    alternatePreviewDb.close();
  }
  alternateCounters.openDatabaseCalls = 0;
  const alternateExecuteDb = openDatabase({ databasePath: alternateDatabasePath });
  const alternateFailed = alternateService.executeDemoPostAction({
    db: alternateExecuteDb,
    actionRunId: alternatePreview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId: alternateClientRequestId,
      previewDigest: alternatePreview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.strictEqual(alternateFailed.status, 'failed');
  assert.strictEqual(alternateFailed.failureReason, 'TEST_ALTERNATE_PATH_CLOSE');
  assert.strictEqual(alternateCounters.openDatabaseCalls, 1);
  assert.strictEqual(path.resolve(alternateExecuteDb.name), path.resolve(alternateDatabasePath));
  assert.strictEqual(alternateExecuteDb.open, false);
  assert.throws(() => alternateExecuteDb.exec('COMMIT'));
  const alternateVerifyDb = openDatabase({ databasePath: alternateDatabasePath });
  try {
    assert.deepStrictEqual(readWriteCounts(alternateVerifyDb), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    assert.strictEqual(alternateVerifyDb.prepare(`SELECT status FROM demo_post_action_runs
      WHERE action_run_id = ?`).get(alternatePreview.actionRunId).status, 'failed');
    assert.strictEqual(Number(alternateVerifyDb.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.execute' AND target_id = ?
        AND json_extract(detail_json, '$.status') = 'failed'`).get(alternatePreview.actionRunId).total), 1);
  } finally {
    alternateVerifyDb.close();
  }
  const defaultVerifyDb = openDatabase();
  try {
    assert.strictEqual(Number(defaultVerifyDb.prepare(`SELECT COUNT(*) AS total
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(alternatePreview.actionRunId).total), 0);
  } finally {
    defaultVerifyDb.close();
  }
}

/** 在第二个隔离 SQLite 中覆盖通用生命周期八类 trigger 回滚与 terminal replay。 */
function runLifecycleFaultAndReplayTests() {
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const setupDb = openDatabase();
  let evidence;
  try {
    evidence = setupDb.transaction(() => seedCarbonEvidence(setupDb, run)).immediate();
  } finally {
    setupDb.close();
  }
  const connectedService = loadConnectedCarbonLifecycleService();
  const definition = postActionRegistry.requireDemoPostAction('carbon-accounting-run');

  // wrapper 必须持有 canonical core，core 必须持有 adapter；初始化后的替换不能接管既有 consumer。
  const servicePath = require.resolve('../services/demoPostActionService');
  const corePath = require.resolve('../services/demoPostActionCanonicalService');
  const adapterPath = require.resolve('../services/demoPostActionCarbonAccountingAdapter');
  const canonicalAdapterModule = require.cache[adapterPath];
  assert.strictEqual(
    require.cache[servicePath].children.includes(require.cache[corePath]),
    true
  );
  assert.strictEqual(require.cache[corePath].children.includes(canonicalAdapterModule), true);
  let maliciousAdapterCalls = 0;
  const maliciousAdapter = Object.freeze({
    resolve() { maliciousAdapterCalls += 1; throw new Error('MALICIOUS_ADAPTER_CALLED'); },
    previewProbe() { maliciousAdapterCalls += 1; throw new Error('MALICIOUS_ADAPTER_CALLED'); },
    revalidate() { maliciousAdapterCalls += 1; throw new Error('MALICIOUS_ADAPTER_CALLED'); },
    execute() { maliciousAdapterCalls += 1; throw new Error('MALICIOUS_ADAPTER_CALLED'); }
  });
  assert.throws(() => { canonicalAdapterModule.exports = maliciousAdapter; }, TypeError);
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: maliciousAdapter,
    children: [],
    paths: []
  };
  const moduleCanaryPreview = connectedService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId: 'carbon-service-module-canary' }
  });
  require.cache[adapterPath] = canonicalAdapterModule;
  assert.strictEqual(moduleCanaryPreview.status, 'previewed');
  assert.strictEqual(maliciousAdapterCalls, 0);

  // organization/energy-type 引用事实变化必须使 connected execute stale，且不得新增 Carbon 事实。
  [
    {
      suffix: 'organization-reference',
      mutate(db) {
        db.prepare('UPDATE organization_units SET unit_name = ? WHERE id = ?')
          .run('Carbon 动作组织-stale', evidence.organizationUnitId);
      },
      restore(db) {
        db.prepare('UPDATE organization_units SET unit_name = ? WHERE id = ?')
          .run('Carbon 动作组织', evidence.organizationUnitId);
      }
    },
    {
      suffix: 'energy-type-reference',
      mutate(db) {
        db.prepare('UPDATE energy_types SET name = ? WHERE id = ?')
          .run('Carbon 已匹配-stale', evidence.calculatedEnergyTypeId);
      },
      restore(db) {
        db.prepare('UPDATE energy_types SET name = ? WHERE id = ?')
          .run('Carbon 已匹配', evidence.calculatedEnergyTypeId);
      }
    }
  ].forEach((referenceCase) => {
    const clientRequestId = `carbon-stale-${referenceCase.suffix}`;
    const preview = connectedService.previewDemoPostAction({
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId }
    });
    const mutateDb = openDatabase();
    try {
      referenceCase.mutate(mutateDb);
    } finally {
      mutateDb.close();
    }
    assert.throws(() => connectedService.executeDemoPostAction({
      actionRunId: preview.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId,
        previewDigest: preview.previewDigest,
        confirmationText: definition.confirmationText
      }
    }), (error) => error?.code === 'DEMO_POST_ACTION_INPUT_STALE');
    const verifyDb = openDatabase();
    try {
      assert.deepStrictEqual(readWriteCounts(verifyDb), {
        runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
      });
      assert.strictEqual(verifyDb.prepare(`SELECT status FROM demo_post_action_runs
        WHERE action_run_id = ?`).get(preview.actionRunId).status, 'previewed');
      referenceCase.restore(verifyDb);
    } finally {
      verifyDb.close();
    }
  });

  const stages = [
    'calculation_run', 'calculation_result', 'domain_audit', 'registry',
    'relation', 'output', 'succeeded_status', 'success_audit'
  ];
  stages.forEach((stage, index) => {
    const clientRequestId = `carbon-trigger-${index + 1}`;
    const preview = connectedService.previewDemoPostAction({
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId }
    });
    assert.strictEqual(preview.status, 'previewed');
    assert.strictEqual(preview.outputCount, 0);
    const triggerDb = openDatabase();
    try {
      installFailureTrigger(triggerDb, stage);
    } finally {
      triggerDb.close();
    }
    const failed = connectedService.executeDemoPostAction({
      actionRunId: preview.actionRunId,
      actorUserId: 1,
      body: {
        clientRequestId,
        previewDigest: preview.previewDigest,
        confirmationText: definition.confirmationText
      }
    });
    assert.strictEqual(failed.status, 'failed', `${stage} 必须稳定落为 failed。`);
    assert.strictEqual(failed.outputCount, 0);
    assert.deepStrictEqual(failed.outputs, []);
    const verifyDb = openDatabase();
    try {
      assert.deepStrictEqual(readWriteCounts(verifyDb), {
        runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
      });
      const persisted = verifyDb.prepare(`SELECT status, output_count AS outputCount,
          result_json AS resultJson, result_digest AS resultDigest
        FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
      assert.deepStrictEqual({
        status: persisted.status,
        outputCount: Number(persisted.outputCount),
        resultJson: persisted.resultJson,
        resultDigest: persisted.resultDigest
      }, { status: 'failed', outputCount: 0, resultJson: null, resultDigest: null });
      removeFailureTriggers(verifyDb);
    } finally {
      verifyDb.close();
    }
    if (index === 0) {
      const replayedFailedPreview = postActionService.previewDemoPostAction({
        runId: run.runId,
        actionKey: 'carbon-accounting-run',
        actorUserId: 1,
        body: { clientRequestId }
      });
      const replayedFailedExecute = postActionService.executeDemoPostAction({
        actionRunId: preview.actionRunId,
        actorUserId: 1,
        body: {
          clientRequestId,
          previewDigest: preview.previewDigest,
          confirmationText: definition.confirmationText
        }
      });
      const failedStatus = postActionService.getDemoPostActionStatus({
        actionRunId: preview.actionRunId,
        actorUserId: 1
      });
      assert.deepStrictEqual(replayedFailedPreview, failed);
      assert.deepStrictEqual(replayedFailedExecute, failed);
      assert.deepStrictEqual(failedStatus, failed);
      assertPublicProjectionSafe(failed);
      const failedHistoryDb = openDatabase();
      try {
        const failedInput = JSON.parse(failedHistoryDb.prepare(`SELECT input_json AS inputJson
          FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId).inputJson);
        // canonical failed 行强制 result_json/result_digest 均为空，因此坏 result 只能在 succeeded 历史行与直接 projector 覆盖。
        assert.throws(() => failedHistoryDb.prepare(`UPDATE demo_post_action_runs
          SET result_digest = ?, result_json = ? WHERE action_run_id = ?`).run(
          sha256('failed-history-result'),
          JSON.stringify({
            scope: {
              startUtc: 'PRIVATE_SENTINEL',
              endUtc: 'SELECT * FROM private_table'
            }
          }),
          preview.actionRunId
        ), /CHECK constraint failed/i);
        const failedOutputRef = {
          runCode: 'FAILED-HISTORY-CARBON-RUN',
          status: 'completed',
          startUtc: '2026-01-01T00:00:00Z',
          endUtc: '2026-01-02T01:00:00Z',
          activityCount: 2,
          resultCount: 2,
          calculatedCount: 1,
          factorMissingCount: 1
        };
        const failedOutputId = Number(failedHistoryDb.prepare(`INSERT INTO demo_post_action_outputs
          (action_run_id, output_entity_type, output_entity_id, output_ref_json, created_at)
          VALUES (?, 'carbon_calculation_run', 'failed-history-output', ?, ?)`)
          .run(preview.actionRunId, JSON.stringify(failedOutputRef), new Date().toISOString())
          .lastInsertRowid);
        const failedWithOutput = postActionService.getDemoPostActionStatus({
          actionRunId: preview.actionRunId,
          actorUserId: 1
        });
        assert.strictEqual(failedWithOutput.status, 'failed');
        assert.strictEqual(failedWithOutput.outputCount, 1);
        const updateFailedPayloads = (value) => {
          failedHistoryDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?
            WHERE action_run_id = ?`).run(JSON.stringify(value.input), preview.actionRunId);
          failedHistoryDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
            WHERE output_id = ?`).run(JSON.stringify(value.outputRef), failedOutputId);
        };
        assertCarbonTerminalUtcScopeProjection({
          service: postActionService,
          runId: run.runId,
          actionRunId: preview.actionRunId,
          clientRequestId,
          previewDigest: preview.previewDigest,
          confirmationText: definition.confirmationText,
          persistedInput: failedInput,
          persistedResult: null,
          persistedOutputRef: failedOutputRef,
          terminal: failedWithOutput,
          targets: ['input', 'outputRef'],
          updatePayloads: updateFailedPayloads
        });
        const legacyFailedInput = JSON.parse(JSON.stringify(failedInput));
        delete legacyFailedInput.publicProjectionActionKey;
        delete legacyFailedInput.publicProjectionResolverVersion;
        delete legacyFailedInput.publicProjectionExecutorVersion;
        delete legacyFailedInput.publicProjectionVersion;
        failedHistoryDb.prepare(`UPDATE demo_post_action_runs
          SET registry_version = 'demo-post-actions:v5',
              registry_digest = ?,
              executor_version = 'carbon-accounting-executor:not-connected'
          WHERE action_run_id = ?`).run(
          '98385f8fdc9170335995c3cb53a6b01c691570ce8315deef870f62b3101a47d8',
          preview.actionRunId
        );
        updateFailedPayloads({ input: legacyFailedInput, outputRef: failedOutputRef });
        assertCarbonTerminalUtcScopeProjection({
          service: postActionService,
          runId: run.runId,
          actionRunId: preview.actionRunId,
          clientRequestId,
          previewDigest: preview.previewDigest,
          confirmationText: definition.confirmationText,
          persistedInput: legacyFailedInput,
          persistedResult: null,
          persistedOutputRef: failedOutputRef,
          terminal: failedWithOutput,
          targets: ['input', 'outputRef'],
          updatePayloads: updateFailedPayloads
        });
        failedHistoryDb.prepare(`DELETE FROM demo_post_action_outputs
          WHERE output_id = ?`).run(failedOutputId);
        const blockedInput = {
          ...legacyFailedInput,
          privateInput: { sql: 'SELECT * FROM private_table', details: 'PRIVATE_SENTINEL' }
        };
        failedHistoryDb.prepare(`UPDATE demo_post_action_runs
          SET status = 'blocked', blocker_json = ?, failure_reason = NULL,
              started_at = NULL, completed_at = NULL, input_json = ?
          WHERE action_run_id = ?`).run(
          JSON.stringify({
            code: 'DEMO_CARBON_LEGACY_BLOCKED',
            message: '历史 Carbon 动作已安全阻断。'
          }),
          JSON.stringify(blockedInput),
          preview.actionRunId
        );
        const blockedStatus = postActionService.getDemoPostActionStatus({
          actionRunId: preview.actionRunId,
          actorUserId: 1
        });
        const blockedPreview = postActionService.previewDemoPostAction({
          runId: run.runId,
          actionKey: 'carbon-accounting-run',
          actorUserId: 1,
          body: { clientRequestId }
        });
        assert.deepStrictEqual(blockedPreview, blockedStatus);
        assert.deepStrictEqual({
          status: blockedStatus.status,
          input: blockedStatus.input,
          result: blockedStatus.result,
          outputCount: blockedStatus.outputCount,
          outputs: blockedStatus.outputs
        }, {
          status: 'blocked',
          input: {},
          result: null,
          outputCount: 0,
          outputs: []
        });
        assertPublicProjectionSafe(blockedStatus);
        assert.throws(() => postActionService.executeDemoPostAction({
          actionRunId: preview.actionRunId,
          actorUserId: 1,
          body: {
            clientRequestId,
            previewDigest: preview.previewDigest,
            confirmationText: definition.confirmationText
          }
        }), (error) => (
          error?.code === 'DEMO_CARBON_LEGACY_BLOCKED'
          && error?.message === '该演示后置动作已安全阻断。'
          && !/PRIVATE_SENTINEL|SELECT \* FROM private_table/i.test(JSON.stringify(error))
        ));
      } finally {
        failedHistoryDb.close();
      }
    }
  });

  // Production connected 成功链路持久化 1+N outputs；terminal replay 必须在 selector 漂移前稳定返回。
  const clientRequestId = 'carbon-terminal-replay';
  const beforePublicPreviewDb = openDatabase();
  let beforePublicPreview;
  try {
    beforePublicPreview = readWriteCounts(beforePublicPreviewDb);
  } finally {
    beforePublicPreviewDb.close();
  }
  const preview = connectedService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  });
  assert.strictEqual(preview.status, 'previewed');
  assert.deepStrictEqual(preview.input.sources, ['11-carbon-factors', '27-carbon-activities']);
  assert.strictEqual(preview.input.activityCount, 2);
  assert.strictEqual(preview.input.factorCount, 1);
  assert.strictEqual(preview.input.expectedRunCount, 1);
  assert.strictEqual(preview.input.expectedResultCount, 2);
  assert.strictEqual(preview.input.expectedOutputCount, 3);
  assert.strictEqual(preview.input.calculatedCount, 1);
  assert.strictEqual(preview.input.factorMissingCount, 1);
  assert.strictEqual(preview.result, null);
  assert.strictEqual(preview.outputCount, 0);
  assert.deepStrictEqual(preview.outputs, []);
  assertPublicProjectionSafe(preview);
  const afterPublicPreviewDb = openDatabase();
  try {
    assert.deepStrictEqual(readWriteCounts(afterPublicPreviewDb), beforePublicPreview,
      'public preview 不得写入 Carbon 业务、派生 ownership、关系或 output。');
  } finally {
    afterPublicPreviewDb.close();
  }
  const succeeded = connectedService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.strictEqual(succeeded.status, 'succeeded');
  assert.strictEqual(succeeded.outputCount, 3);
  assert.strictEqual(succeeded.outputs.length, 3);
  assertPublicProjectionSafe(succeeded.input);
  assertPublicProjectionSafe(succeeded.result);
  assertPublicProjectionSafe(succeeded.outputs);
  const beforeReplayDb = openDatabase();
  let beforeReplay;
  try {
    beforeReplay = readWriteCounts(beforeReplayDb);
    assert.deepStrictEqual(beforeReplay, {
      runs: 1,
      results: 2,
      domainAudits: 1,
      derived: 3,
      relations: 5,
      outputs: 3
    });
    assertCarbonPublicExecutePersistence(beforeReplayDb, {
      runId: run.runId,
      actionRunId: preview.actionRunId
    });
    const resultRows = beforeReplayDb.prepare(`SELECT activity_record_id AS activityRecordId,
        carbon_factor_id AS carbonFactorId, status
      FROM carbon_accounting_results ORDER BY id`).all();
    assert.strictEqual(resultRows.some((row) => (
      Number(row.activityRecordId) === evidence.formalActivityId
    )), false, 'public execute 不得吸收正式未归属 activity 哨兵。');
    const calculatedResult = resultRows.find((row) => row.status === 'calculated');
    assert.strictEqual(Number(calculatedResult.carbonFactorId), evidence.factorId);
    assert.notStrictEqual(Number(calculatedResult.carbonFactorId), evidence.formalFactorId,
      'public execute 不得吸收正式未归属 factor 哨兵。');
    const persistedTerminal = beforeReplayDb.prepare(`SELECT input_json AS inputJson,
        result_json AS resultJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
    const projectionIdentity = JSON.parse(persistedTerminal.inputJson);
    const persistedPublicPayloads = [
      persistedTerminal.inputJson,
      persistedTerminal.resultJson,
      ...beforeReplayDb.prepare(`SELECT output_ref_json AS payload
        FROM demo_post_action_outputs WHERE action_run_id = ?`).all(preview.actionRunId)
        .map((row) => row.payload),
      ...beforeReplayDb.prepare(`SELECT detail_json AS payload FROM sys_operation_logs
        WHERE target_id = ?`).all(preview.actionRunId).map((row) => row.payload)
    ];
    persistedPublicPayloads.forEach((payload) => {
      assert.strictEqual(/privateDigest|privateScopeDigest/.test(String(payload)), false);
    });
    assert.deepStrictEqual({
      actionKey: projectionIdentity.publicProjectionActionKey,
      resolverVersion: projectionIdentity.publicProjectionResolverVersion,
      executorVersion: projectionIdentity.publicProjectionExecutorVersion,
      projectionVersion: projectionIdentity.publicProjectionVersion
    }, {
      actionKey: 'carbon-accounting-run',
      resolverVersion: 'carbon-accounting-resolver:v1',
      executorVersion: 'carbon-accounting-executor:v1',
      projectionVersion: 1
    });
  } finally {
    beforeReplayDb.close();
  }
  const replayedPreview = postActionService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  });
  const replayedExecute = postActionService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  const replayedStatus = postActionService.getDemoPostActionStatus({
    actionRunId: preview.actionRunId,
    actorUserId: 1
  });
  assert.deepStrictEqual(replayedPreview, succeeded);
  assert.deepStrictEqual(replayedExecute, succeeded);
  assert.deepStrictEqual(replayedStatus, succeeded);
  const markerMatrixDb = openDatabase();
  try {
    assertCarbonTerminalMarkerIntegrityMatrix({
      db: markerMatrixDb,
      service: postActionService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      terminal: succeeded
    });
  } finally {
    markerMatrixDb.close();
  }
  const driftedHistoryService = loadDriftedCarbonHistoryService();
  assert.deepStrictEqual(driftedHistoryService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  }), succeeded);
  assert.deepStrictEqual(driftedHistoryService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  }), succeeded);
  assert.deepStrictEqual(driftedHistoryService.getDemoPostActionStatus({
    actionRunId: preview.actionRunId,
    actorUserId: 1
  }), succeeded);

  // 恶意 trigger-valid 历史 JSON 只能经过 Carbon 递归显式白名单，合法字段投影保持完全一致。
  const afterReplayDb = openDatabase();
  try {
    assert.deepStrictEqual(readWriteCounts(afterReplayDb), beforeReplay);
    assert.strictEqual(Number(afterReplayDb.prepare(`SELECT COUNT(*) AS total
      FROM demo_post_action_runs
      WHERE run_id = ? AND action_key = 'carbon-accounting-run' AND client_request_id = ?`).get(
      run.runId,
      clientRequestId
    ).total), 1);
    const persisted = afterReplayDb.prepare(`SELECT input_json AS inputJson, result_json AS resultJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
    const persistedOutputRows = afterReplayDb.prepare(`SELECT output_id AS outputId,
        output_entity_type AS outputEntityType, output_entity_id AS outputEntityId,
        output_ref_json AS outputRefJson FROM demo_post_action_outputs
      WHERE action_run_id = ? ORDER BY output_id`).all(preview.actionRunId);
    const calculationRunOutput = persistedOutputRows.find((output) => (
      output.outputEntityType === 'carbon_calculation_run'
    ));
    const maliciousInput = JSON.parse(persisted.inputJson);
    const maliciousResult = JSON.parse(persisted.resultJson);
    const persistedOutputs = persistedOutputRows.map((output) => ({
      outputId: Number(output.outputId),
      outputEntityType: output.outputEntityType,
      outputEntityId: output.outputEntityId,
      outputRef: JSON.parse(output.outputRefJson)
    }));
    const persistedCalculationRunOutputRef = calculationRunOutput
      ? JSON.parse(calculationRunOutput.outputRefJson)
      : null;
    assertCarbonTerminalUtcScopeProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedInput: maliciousInput,
      persistedResult: maliciousResult,
      persistedOutputRef: persistedCalculationRunOutputRef,
      terminal: succeeded,
      targets: ['input', 'result', 'outputRef'],
      updatePayloads(value) {
        afterReplayDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?, result_json = ?
          WHERE action_run_id = ?`).run(
          JSON.stringify(value.input),
          JSON.stringify(value.result),
          preview.actionRunId
        );
        afterReplayDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
          WHERE output_id = ?`).run(
          JSON.stringify(value.outputRef),
          calculationRunOutput.outputId
        );
      }
    });
    assertCarbonTerminalInputScalarProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedInput: maliciousInput,
      succeeded,
      updateInput(value) {
        afterReplayDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?
          WHERE action_run_id = ?`).run(JSON.stringify(value), preview.actionRunId);
      }
    });
    assertCarbonTerminalBusinessStringProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedResult: maliciousResult,
      persistedOutputs,
      terminal: succeeded,
      updatePayloads(value) {
        afterReplayDb.prepare(`UPDATE demo_post_action_runs SET result_json = ?
          WHERE action_run_id = ?`).run(JSON.stringify(value.result), preview.actionRunId);
        value.outputs.forEach((output) => {
          afterReplayDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
            WHERE output_id = ?`).run(JSON.stringify(output.outputRef), output.outputId);
        });
      }
    });
    Object.assign(maliciousInput, {
      actor: { userId: 1, details: 'PRIVATE_SENTINEL' },
      capability: { token: 'PRIVATE_SENTINEL' },
      witness: { sql: 'PRIVATE_SENTINEL' },
      privateDigest: 'PRIVATE_SENTINEL',
      privateScopeDigest: 'PRIVATE_SENTINEL'
    });
    maliciousInput.scope = { ...maliciousInput.scope, receipt: 'PRIVATE_SENTINEL' };
    maliciousInput.dependencies = maliciousInput.dependencies.map((dependency) => ({
      ...dependency,
      registryId: 999,
      details: 'PRIVATE_SENTINEL'
    }));
    Object.assign(maliciousResult, {
      actor: { userId: 1 },
      capability: 'PRIVATE_SENTINEL',
      witness: 'PRIVATE_SENTINEL',
      receipt: 'PRIVATE_SENTINEL',
      privateDigest: 'PRIVATE_SENTINEL',
      privateScopeDigest: 'PRIVATE_SENTINEL',
      sql: 'SELECT PRIVATE_SENTINEL'
    });
    maliciousResult.scope = { ...maliciousResult.scope, contextId: 'PRIVATE_SENTINEL' };
    maliciousResult.emissionTotals.details = 'PRIVATE_SENTINEL';
    maliciousResult.emissionTotals.totals = maliciousResult.emissionTotals.totals.map((total) => ({
      ...total,
      importBatchId: 999,
      receipt: 'PRIVATE_SENTINEL'
    }));
    afterReplayDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?, result_json = ?
      WHERE action_run_id = ?`).run(
      JSON.stringify(maliciousInput),
      JSON.stringify(maliciousResult),
      preview.actionRunId
    );
    const outputRows = afterReplayDb.prepare(`SELECT output_id AS outputId,
        output_ref_json AS outputRefJson FROM demo_post_action_outputs
      WHERE action_run_id = ? ORDER BY output_id`).all(preview.actionRunId);
    outputRows.forEach((outputRow) => {
      const outputRef = JSON.parse(outputRow.outputRefJson);
      Object.assign(outputRef, {
        actor: { userId: 1 },
        ownership: { registryId: 999 },
        capability: 'PRIVATE_SENTINEL',
        witness: 'PRIVATE_SENTINEL',
        receipt: 'PRIVATE_SENTINEL',
        details: { sql: 'PRIVATE_SENTINEL' }
      });
      afterReplayDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
        WHERE output_id = ?`).run(JSON.stringify(outputRef), outputRow.outputId);
    });
  } finally {
    afterReplayDb.close();
  }
  const sanitizedStatus = driftedHistoryService.getDemoPostActionStatus({
    actionRunId: preview.actionRunId,
    actorUserId: 1
  });
  const sanitizedPreviewReplay = driftedHistoryService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  });
  const sanitizedExecuteReplay = driftedHistoryService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.deepStrictEqual(sanitizedStatus, succeeded);
  assert.deepStrictEqual(sanitizedPreviewReplay, succeeded);
  assert.deepStrictEqual(sanitizedExecuteReplay, succeeded);
  assertPublicProjectionSafe(sanitizedStatus);

  // 升级前无 marker 的已知稳定 identity 历史行仍可重放；blocked 行仍不进入该兼容分支。
  const legacyDb = openDatabase();
  try {
    const legacyInput = JSON.parse(legacyDb.prepare(`SELECT input_json AS inputJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId).inputJson);
    delete legacyInput.publicProjectionActionKey;
    delete legacyInput.publicProjectionResolverVersion;
    delete legacyInput.publicProjectionExecutorVersion;
    delete legacyInput.publicProjectionVersion;
    legacyDb.prepare(`UPDATE demo_post_action_runs
      SET registry_version = 'demo-post-actions:v5',
          registry_digest = ?,
          executor_version = 'carbon-accounting-executor:not-connected',
          input_json = ?
      WHERE action_run_id = ?`).run(
      '98385f8fdc9170335995c3cb53a6b01c691570ce8315deef870f62b3101a47d8',
      JSON.stringify(legacyInput),
      preview.actionRunId
    );
    const legacyPersistedResult = JSON.parse(legacyDb.prepare(`SELECT result_json AS resultJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId).resultJson);
    const legacyPersistedOutputRows = legacyDb.prepare(`SELECT output_id AS outputId,
        output_entity_type AS outputEntityType, output_entity_id AS outputEntityId,
        output_ref_json AS outputRefJson FROM demo_post_action_outputs
      WHERE action_run_id = ? ORDER BY output_id`).all(preview.actionRunId);
    const legacyCalculationRunOutput = legacyPersistedOutputRows.find((output) => (
      output.outputEntityType === 'carbon_calculation_run'
    ));
    const legacyPersistedOutputs = legacyPersistedOutputRows.map((output) => ({
      outputId: Number(output.outputId),
      outputEntityType: output.outputEntityType,
      outputEntityId: output.outputEntityId,
      outputRef: JSON.parse(output.outputRefJson)
    }));
    const legacyCalculationRunOutputRef = legacyCalculationRunOutput
      ? JSON.parse(legacyCalculationRunOutput.outputRefJson)
      : null;
    assertCarbonTerminalUtcScopeProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedInput: legacyInput,
      persistedResult: legacyPersistedResult,
      persistedOutputRef: legacyCalculationRunOutputRef,
      terminal: succeeded,
      targets: ['input', 'result', 'outputRef'],
      updatePayloads(value) {
        legacyDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?, result_json = ?
          WHERE action_run_id = ?`).run(
          JSON.stringify(value.input),
          JSON.stringify(value.result),
          preview.actionRunId
        );
        legacyDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
          WHERE output_id = ?`).run(
          JSON.stringify(value.outputRef),
          legacyCalculationRunOutput.outputId
        );
      }
    });
    assertCarbonTerminalInputScalarProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedInput: legacyInput,
      succeeded,
      updateInput(value) {
        legacyDb.prepare(`UPDATE demo_post_action_runs SET input_json = ?
          WHERE action_run_id = ?`).run(JSON.stringify(value), preview.actionRunId);
      }
    });
    assertCarbonTerminalBusinessStringProjection({
      service: driftedHistoryService,
      runId: run.runId,
      actionRunId: preview.actionRunId,
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText,
      persistedResult: legacyPersistedResult,
      persistedOutputs: legacyPersistedOutputs,
      terminal: succeeded,
      updatePayloads(value) {
        legacyDb.prepare(`UPDATE demo_post_action_runs SET result_json = ?
          WHERE action_run_id = ?`).run(JSON.stringify(value.result), preview.actionRunId);
        value.outputs.forEach((output) => {
          legacyDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
            WHERE output_id = ?`).run(JSON.stringify(output.outputRef), output.outputId);
        });
      }
    });
  } finally {
    legacyDb.close();
  }
  assert.deepStrictEqual(driftedHistoryService.getDemoPostActionStatus({
    actionRunId: preview.actionRunId,
    actorUserId: 1
  }), succeeded);
  assert.deepStrictEqual(driftedHistoryService.previewDemoPostAction({
    runId: run.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: 1,
    body: { clientRequestId }
  }), succeeded);
  assert.deepStrictEqual(driftedHistoryService.executeDemoPostAction({
    actionRunId: preview.actionRunId,
    actorUserId: 1,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  }), succeeded);
}

const carbonLifecycleChildModes = Object.freeze([
  'closed',
  'recovery-outer',
  'recovery-admission',
  'recovery-alternate',
  'fault'
]);

if (carbonLifecycleChildModes.includes(carbonLifecycleChildMode)) {
  try {
    if (carbonLifecycleChildMode === 'closed') {
      runClosedConnectionRecoveryTest();
    } else if (carbonLifecycleChildMode === 'fault') {
      runLifecycleFaultAndReplayTests();
    } else {
      runGenericRecoveryFailureMatrix();
    }
    console.log(`demoPostActionCarbonAccounting ${carbonLifecycleChildMode} child tests passed`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
} else try {
  assertProductionModuleIdentityContracts();
  carbonLifecycleChildModes.forEach((childMode) => {
    const lifecycleChild = spawnSync(process.execPath, [__filename], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      env: {
        ...process.env,
        CHARCOAL_CARBON_LIFECYCLE_CHILD: childMode,
        NODE_OPTIONS: '',
        NODE_PATH: ''
      },
      encoding: 'utf8',
      windowsHide: true
    });
    assert.strictEqual(
      lifecycleChild.status,
      0,
      `${childMode}: ${lifecycleChild.stderr || lifecycleChild.stdout}`
    );
  });
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const db = openDatabase();
  try {
    const evidence = db.transaction(() => seedCarbonEvidence(db, run)).immediate();

    // Production registry 已正式连接 Carbon，public preview 必须服务端重建 11/27 exact scope 且不写业务事实。
    const registry = postActionService.getDemoPostActionRegistry();
    assert.strictEqual(registry.identity.version, 'demo-post-actions:v7');
    assert.strictEqual(registry.identity.digest, '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a');
    const carbonDefinition = registry.actions.find((item) => item.actionKey === 'carbon-accounting-run');
    assert.strictEqual(carbonDefinition.implementationStatus, 'connected');
    assert.strictEqual(carbonDefinition.executorVersion, 'carbon-accounting-executor:v1');
    assert.deepStrictEqual(registry.actions.filter((item) => item.implementationStatus === 'connected')
      .map((item) => item.actionKey), [
      'meter-readings-to-energy-records',
      'carbon-accounting-run',
      'prediction-run',
      'strategy-evaluation-run',
      'energy-flow-analysis'
    ]);
    assert.deepStrictEqual(registry.actions.filter((item) => item.implementationStatus === 'not-connected')
      .map((item) => item.actionKey), [
      'benchmark-evaluation',
      'energy-balance-snapshot',
      'dashboard-refresh-check'
    ]);
    const untrustedFields = {
      scope: {}, entity: {}, batch: {}, context: {}, sql: 'SELECT 1', adapter: 'forbidden'
    };
    assert.throws(() => postActionService.previewDemoPostAction({
      db,
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: 'carbon-public-untrusted', ...untrustedFields }
    }), (error) => error?.code === 'BAD_REQUEST'
      && error?.details?.code === 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN'
      && JSON.stringify(error.details.fields) === JSON.stringify(Object.keys(untrustedFields).sort()));
    const publicPreviewWritesBefore = readWriteCounts(db);
    const publicPreview = postActionService.previewDemoPostAction({
      db,
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: 'carbon-public-connected' }
    });
    assert.strictEqual(publicPreview.status, 'previewed');
    assert.deepStrictEqual(publicPreview.input.sources, ['11-carbon-factors', '27-carbon-activities']);
    assert.strictEqual(publicPreview.input.activityCount, 2);
    assert.strictEqual(publicPreview.input.factorCount, 1);
    assert.strictEqual(publicPreview.input.expectedRunCount, 1);
    assert.strictEqual(publicPreview.input.expectedResultCount, 2);
    assert.strictEqual(publicPreview.input.expectedOutputCount, 3);
    assert.strictEqual(publicPreview.input.calculatedCount, 1);
    assert.strictEqual(publicPreview.input.factorMissingCount, 1);
    assert.strictEqual(publicPreview.result, null);
    assert.strictEqual(publicPreview.outputCount, 0);
    assert.deepStrictEqual(publicPreview.outputs, []);
    assertPublicProjectionSafe(publicPreview);
    assert.deepStrictEqual(readWriteCounts(db), publicPreviewWritesBefore,
      'public preview 不得写入 Carbon 业务、派生 ownership、关系或 output。');
    assert.deepStrictEqual(postActionService.previewDemoPostAction({
      db,
      runId: run.runId,
      actionKey: 'carbon-accounting-run',
      actorUserId: 1,
      body: { clientRequestId: 'carbon-public-connected' }
    }), publicPreview);
    assert.deepStrictEqual(postActionService.getDemoPostActionStatus({
      db,
      actionRunId: publicPreview.actionRunId,
      actorUserId: 1
    }), publicPreview);
    const persistedPublicInput = JSON.parse(db.prepare(`SELECT input_json AS inputJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(publicPreview.actionRunId).inputJson);
    assert.deepStrictEqual({
      actionKey: persistedPublicInput.publicProjectionActionKey,
      resolverVersion: persistedPublicInput.publicProjectionResolverVersion,
      executorVersion: persistedPublicInput.publicProjectionExecutorVersion,
      projectionVersion: persistedPublicInput.publicProjectionVersion
    }, {
      actionKey: 'carbon-accounting-run',
      resolverVersion: 'carbon-accounting-resolver:v1',
      executorVersion: 'carbon-accounting-executor:v1',
      projectionVersion: 1
    });

    // production reflection：adapter 冻结、字段 allowlist 固定且没有 getter/setter、Symbol 或测试后门。
    const adapterKeys = ['execute', 'mapPreviewBlocker', 'previewProbe', 'projectPublicInput',
      'projectPublicResult', 'resolve', 'revalidate'];
    assert.deepStrictEqual(Object.keys(carbonAdapter).sort(), adapterKeys);
    assert.strictEqual(Object.isFrozen(carbonAdapter), true);
    assert.deepStrictEqual(Object.getOwnPropertySymbols(carbonAdapter), []);
    Object.values(Object.getOwnPropertyDescriptors(carbonAdapter)).forEach((descriptor) => {
      assert.strictEqual(typeof descriptor.get, 'undefined');
      assert.strictEqual(typeof descriptor.set, 'undefined');
      assert.strictEqual(descriptor.writable, false);
      assert.strictEqual(descriptor.configurable, false);
    });
    assert.strictEqual(/(?:_test|fault|sql|database|capability|witness|receipt)/i.test(adapterKeys.join('|')), false);
    assert.deepStrictEqual(Object.keys(postActionService).sort(), [
      'executeDemoPostAction', 'getDemoPostActionRegistry', 'getDemoPostActionStatus', 'previewDemoPostAction'
    ]);
    const serviceSymbols = Object.getOwnPropertySymbols(postActionService);
    assert.strictEqual(serviceSymbols.length, 1);
    const predictionInstances = postActionService[serviceSymbols[0]];
    assert(predictionInstances && Object.isFrozen(predictionInstances));
    assert.deepStrictEqual(Object.keys(predictionInstances), ['adapter', 'p4']);
    assert.strictEqual(
      Reflect.ownKeys(predictionInstances).some((fieldName) => (
        typeof fieldName === 'string'
        && /(?:issuer|verifier|secret|authority|bindIssuer|bindAdapter|bindP4)/i.test(fieldName)
      )),
      false
    );

    // private preview 复用 exact 正式算法，缺因子为非阻断依赖且不产生任何业务/治理写入。
    db.exec('BEGIN IMMEDIATE');
    const previewBaseline = readPreviewWriteSnapshot(db);
    let resolved;
    let privatePreview;
    db.pragma('query_only = ON');
    try {
      resolved = carbonAdapter.resolve(db, run, {}, 1, '127.0.0.1');
      privatePreview = carbonAdapter.previewProbe({
        db,
        run,
        privateContext: resolved.privateContext
      });
    } finally {
      db.pragma('query_only = OFF');
    }
    assert.strictEqual(Object.isFrozen(resolved.privateContext.preview), true);
    assert.strictEqual(Object.isFrozen(resolved.privateContext.preview.summary), true);
    assert.strictEqual(Object.isFrozen(resolved.privateContext.preview.summary.dependencies), true);
    assert.deepStrictEqual(readPreviewWriteSnapshot(db), previewBaseline);
    assert.strictEqual(privatePreview.outputCount, 0);
    assert.deepStrictEqual(privatePreview.outputs, []);
    assert.strictEqual(privatePreview.result.expectedRunCount, 1);
    assert.strictEqual(privatePreview.result.expectedResultCount, 2);
    assert.strictEqual(privatePreview.result.expectedOutputCount, 3);
    assert.strictEqual(privatePreview.result.calculatedCount, 1);
    assert.strictEqual(privatePreview.result.factorMissingCount, 1);
    assert.deepStrictEqual(privatePreview.result.dependencies, [{
      code: 'NO_ACTIVE_EXACT_UNIT_FACTOR', blocking: false, count: 1
    }]);
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor,
      extra: true
    }), (error) => error?.code === 'CARBON_ACCOUNTING_REGISTRATION_CONTEXT_INPUT_INVALID');
    const publicInput = carbonAdapter.projectPublicInput(resolved.domainInput);
    const publicResult = carbonAdapter.projectPublicResult(privatePreview.result);
    assertPublicProjectionSafe(publicInput);
    assertPublicProjectionSafe(publicResult);
    assert.deepStrictEqual(publicInput.scope, resolved.domainInput.scope);
    assert.deepStrictEqual(publicResult.scope, privatePreview.result.scope);
    assert.strictEqual(Object.isFrozen(publicInput.scope), true);
    assert.deepStrictEqual(carbonAdapter.projectPublicResult({
      scope: {
        startUtc: '2026-01-01T00:00:00.000Z',
        endUtc: '2026-01-01T00:00:01.000Z'
      }
    }).scope, {
      startUtc: '2026-01-01T00:00:00Z',
      endUtc: '2026-01-01T00:00:01Z'
    });
    assert.doesNotThrow(() => carbonAdapter.projectPublicResult({
      scope: {
        startUtc: 'SELECT * FROM private_table',
        endUtc: '2026-01-01T00:00:01Z'
      }
    }));
    assert.strictEqual(carbonAdapter.projectPublicResult({
      scope: {
        startUtc: 'SELECT * FROM private_table',
        endUtc: '2026-01-01T00:00:01Z'
      }
    }).scope, null);

    // 直接 projector 复用正式 runCode/status/reason/unit 值域并对恶意历史字符串 fail closed。
    const validRunCode = 'CAR-20260830010203-12345678-1234-4abc-8def-1234567890ab';
    const projectOutputRef = (outputRef, outputEntityType) => carbonAdapter.projectPublicResult(
      outputRef,
      { kind: 'outputRef', outputEntityType }
    );
    assert.deepStrictEqual(projectOutputRef({
      runCode: validRunCode,
      status: 'completed',
      startUtc: '2026-01-01T00:00:00Z',
      endUtc: '2026-01-02T00:00:00Z',
      activityCount: 2,
      resultCount: 2,
      calculatedCount: 1,
      factorMissingCount: 1
    }, 'carbon_calculation_run'), {
      runCode: validRunCode,
      status: 'completed',
      startUtc: '2026-01-01T00:00:00Z',
      endUtc: '2026-01-02T00:00:00Z',
      activityCount: 2,
      resultCount: 2,
      calculatedCount: 1,
      factorMissingCount: 1
    });
    assert.deepStrictEqual(projectOutputRef({
      status: 'calculated', emissionValue: 1.25, emissionUnit: 'kgCO2e', missingReason: null
    }, 'carbon_accounting_result'), {
      status: 'calculated', emissionValue: 1.25, emissionUnit: 'kgCO2e', missingReason: null
    });
    assert.deepStrictEqual(projectOutputRef({
      status: 'factor_missing', emissionValue: null, emissionUnit: null,
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
    }, 'carbon_accounting_result'), {
      status: 'factor_missing', emissionValue: null, emissionUnit: null,
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
    });
    assert.deepStrictEqual(carbonAdapter.projectPublicResult({
      emissionTotals: {
        version: 1,
        totals: ['kgCO2e', 'tCO2e', 'MtCO2e/MWh'].map((emissionUnit) => ({
          emissionUnit, totalEmissionValue: 1, calculatedCount: 1
        }))
      }
    }).emissionTotals.totals.map((total) => total.emissionUnit), [
      'kgCO2e', 'tCO2e', 'MtCO2e/MWh'
    ]);
    assert.deepStrictEqual(carbonAdapter.projectPublicResult({
      emissionTotals: {
        version: 1,
        totals: [
          { emissionUnit: 'kg CO₂e / kWh', totalEmissionValue: 1.25, calculatedCount: 2 },
          { emissionUnit: 'kgCO2e/(kWh)', totalEmissionValue: 2.75, calculatedCount: 3 }
        ]
      }
    }).emissionTotals, {
      version: 1,
      totals: [{ emissionUnit: 'kgCO2e/kWh', totalEmissionValue: 4, calculatedCount: 5 }]
    });
    assert.deepStrictEqual(projectOutputRef({
      status: 'calculated', emissionValue: 1.25, emissionUnit: 'tCO₂e/m³', missingReason: null
    }, 'carbon_accounting_result'), {
      status: 'calculated', emissionValue: 1.25, emissionUnit: 'tCO2e/m3', missingReason: null
    });
    assert.deepStrictEqual(carbonAdapter.projectPublicResult({
      emissionTotals: {
        version: 1,
        totals: [
          { emissionUnit: 'GtCO2e', totalEmissionValue: Number.MAX_VALUE, calculatedCount: 1 },
          { emissionUnit: 'Gt CO2e', totalEmissionValue: Number.MAX_VALUE, calculatedCount: 1 }
        ]
      }
    }).emissionTotals.totals, [{
      emissionUnit: 'GtCO2e', totalEmissionValue: null, calculatedCount: 2
    }]);
    [
      'PRIVATE_SENTINEL',
      'SELECT * FROM private_table',
      { sql: 'PRIVATE_SENTINEL' },
      ['PRIVATE_SENTINEL'],
      null,
      'X'.repeat(256),
      'kgCO2e\r\nSELECT * FROM private_table',
      String.fromCharCode(0) + 'kgCO2e'
    ].forEach((maliciousValue) => {
      const runProjection = projectOutputRef({
        runCode: maliciousValue,
        status: maliciousValue,
        startUtc: '2026-01-01T00:00:00Z',
        endUtc: '2026-01-02T00:00:00Z'
      }, 'carbon_calculation_run');
      assert.strictEqual(runProjection.runCode, null);
      assert.strictEqual(runProjection.status, null);
      const totalProjection = carbonAdapter.projectPublicResult({
        emissionTotals: {
          version: 1,
          totals: [{ emissionUnit: maliciousValue, totalEmissionValue: 1, calculatedCount: 1 }]
        }
      });
      assert.strictEqual(totalProjection.emissionTotals.totals[0].emissionUnit, null);
      const resultProjection = projectOutputRef({
        status: 'calculated', emissionValue: 1, emissionUnit: maliciousValue, missingReason: null
      }, 'carbon_accounting_result');
      assert.deepStrictEqual({
        status: resultProjection.status,
        emissionUnit: resultProjection.emissionUnit,
        missingReason: resultProjection.missingReason
      }, { status: null, emissionUnit: null, missingReason: null });
    });
    assert.deepStrictEqual(projectOutputRef({
      status: 'calculated', emissionValue: 1, emissionUnit: 'kgCO2e',
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
    }, 'carbon_accounting_result'), {
      status: null, emissionValue: 1, emissionUnit: null, missingReason: null
    });
    assert.deepStrictEqual(projectOutputRef({
      status: 'factor_missing', emissionValue: null, emissionUnit: 'kgCO2e',
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
    }, 'carbon_accounting_result'), {
      status: null, emissionValue: null, emissionUnit: null, missingReason: null
    });
    assert.deepStrictEqual(carbonAdapter.projectPublicInput({
      sources: [{ sql: 'PRIVATE_SENTINEL' }],
      scope: {
        startUtc: { actor: 'PRIVATE_SENTINEL' },
        endUtc: ['PRIVATE_SENTINEL']
      },
      activityCount: Number.NaN,
      factorCount: Number.POSITIVE_INFINITY,
      expectedRunCount: -1,
      expectedResultCount: Number.MAX_SAFE_INTEGER + 1,
      expectedOutputCount: '3',
      calculatedCount: { privateDigest: 'PRIVATE_SENTINEL' },
      factorMissingCount: ['PRIVATE_SENTINEL'],
      dependencies: [{
        code: { capability: 'PRIVATE_SENTINEL' },
        blocking: { witness: 'PRIVATE_SENTINEL' },
        count: Number.NEGATIVE_INFINITY
      }]
    }), {
      sources: ['11-carbon-factors', '27-carbon-activities'],
      scope: null,
      activityCount: 0,
      factorCount: 0,
      expectedRunCount: 0,
      expectedResultCount: 0,
      expectedOutputCount: 0,
      calculatedCount: 0,
      factorMissingCount: 0,
      dependencies: [{ code: null, blocking: false, count: 0 }]
    });
    db.exec('ROLLBACK');
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    }), (error) => error?.code === 'CARBON_ACCOUNTING_EXACT_CALLER_TRANSACTION_REQUIRED');

    // adapter/direct preview 对来源墙钟年份和 priority 2/3/4 均消费同一正式 factor selector。
    [
      {
        name: 'source-wall-clock-year',
        mutate() {
          db.prepare('UPDATE carbon_factors SET factor_year = 2027 WHERE id = ?').run(evidence.factorId);
          db.prepare(`UPDATE carbon_activity_records
            SET start_wall_clock = '2027-01-01T08:00', end_wall_clock = '2027-01-01T09:00'
            WHERE id = ?`).run(evidence.calculatedActivityId);
          refreshSnapshot(db, 'carbon_factor', evidence.factorId);
          refreshSnapshot(db, 'carbon_activity_record', evidence.calculatedActivityId);
        }
      },
      {
        name: 'priority-2-default-year',
        mutate() {
          db.prepare("UPDATE carbon_factors SET region = 'default', factor_year = 2026 WHERE id = ?")
            .run(evidence.factorId);
          refreshSnapshot(db, 'carbon_factor', evidence.factorId);
        }
      },
      {
        name: 'priority-3-requested-generic',
        mutate() {
          db.prepare("UPDATE carbon_factors SET region = 'cn-action', factor_year = NULL WHERE id = ?")
            .run(evidence.factorId);
          refreshSnapshot(db, 'carbon_factor', evidence.factorId);
        }
      },
      {
        name: 'priority-4-default-generic',
        mutate() {
          db.prepare("UPDATE carbon_factors SET region = 'default', factor_year = NULL WHERE id = ?")
            .run(evidence.factorId);
          refreshSnapshot(db, 'carbon_factor', evidence.factorId);
        }
      }
    ].forEach((semanticCase) => {
      db.exec('BEGIN IMMEDIATE');
      semanticCase.mutate();
      const directSemanticPreview = carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
        db,
        demoRun: resolved.privateContext.demoRun,
        actor: resolved.privateContext.actor
      });
      const adapterSemanticResolved = carbonAdapter.resolve(db, run, {}, 1);
      const adapterSemanticPreview = carbonAdapter.previewProbe({
        db,
        run,
        privateContext: adapterSemanticResolved.privateContext
      });
      assert.strictEqual(directSemanticPreview.summary.calculatedCount, 1, semanticCase.name);
      assert.strictEqual(directSemanticPreview.summary.factorMissingCount, 1, semanticCase.name);
      assert.strictEqual(adapterSemanticPreview.result.calculatedCount, 1, semanticCase.name);
      assert.strictEqual(adapterSemanticPreview.result.factorMissingCount, 1, semanticCase.name);
      assert.strictEqual(
        adapterSemanticResolved.privateDigest,
        directSemanticPreview.privateDigest,
        semanticCase.name
      );
      assert.deepStrictEqual(readWriteCounts(db), {
        runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
      });
      db.exec('ROLLBACK');
    });

    // stale：因子、活动、organization/energy-type 引用、ownership、context、batch 与业务集合变化均改变 digest 或稳定拒绝。
    db.exec('BEGIN IMMEDIATE');
    const staleBaseline = carbonAdapter.resolve(db, run, {}, 1);
    db.prepare('UPDATE carbon_factors SET factor_value = 0.25 WHERE id = ?').run(evidence.factorId);
    refreshSnapshot(db, 'carbon_factor', evidence.factorId);
    const factorChanged = carbonAdapter.revalidate({ db, run, actorUserId: 1 });
    assert.notStrictEqual(factorChanged.privateDigest, staleBaseline.privateDigest);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    const activityBaseline = carbonAdapter.resolve(db, run, {}, 1);
    db.prepare('UPDATE carbon_activity_records SET activity_value = 9 WHERE id = ?').run(evidence.calculatedActivityId);
    refreshSnapshot(db, 'carbon_activity_record', evidence.calculatedActivityId);
    const activityChanged = carbonAdapter.revalidate({ db, run, actorUserId: 1 });
    assert.notStrictEqual(activityChanged.privateDigest, activityBaseline.privateDigest);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    const organizationBaseline = carbonAdapter.resolve(db, run, {}, 1);
    db.prepare('UPDATE organization_units SET unit_name = ? WHERE id = ?')
      .run('Carbon 动作组织-direct-stale', evidence.organizationUnitId);
    const organizationChanged = carbonAdapter.revalidate({ db, run, actorUserId: 1 });
    assert.notStrictEqual(organizationChanged.privateDigest, organizationBaseline.privateDigest);
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    const energyTypeBaseline = carbonAdapter.resolve(db, run, {}, 1);
    db.prepare('UPDATE energy_types SET name = ? WHERE id = ?')
      .run('Carbon 已匹配-direct-stale', evidence.calculatedEnergyTypeId);
    const energyTypeChanged = carbonAdapter.revalidate({ db, run, actorUserId: 1 });
    assert.notStrictEqual(energyTypeChanged.privateDigest, energyTypeBaseline.privateDigest);
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE demo_data_registry SET snapshot_digest = ? WHERE entity_type = 'carbon_factor' AND entity_pk = ?")
      .run('0'.repeat(64), String(evidence.factorId));
    assert.throws(() => carbonAdapter.revalidate({ db, run, actorUserId: 1 }), /ownership|digest/i);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`UPDATE demo_import_contexts
      SET status = 'expired', revoked_at = ?, revoke_reason = 'TEST_STALE'
      WHERE context_id = ?`).run(new Date().toISOString(), evidence.factorContextId);
    assert.throws(() => carbonAdapter.revalidate({ db, run, actorUserId: 1 }));
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE import_batches SET status = 'failed' WHERE id = ?").run(evidence.factorBatchId);
    assert.throws(() => carbonAdapter.revalidate({ db, run, actorUserId: 1 }));
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO carbon_factors
      (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
       factor_value, factor_unit, source, is_active)
      VALUES (?, 99, ?, 'default', NULL, 'unit', 1, 'kgCO2e', 'unowned-business-row', 1)`)
      .run(evidence.factorBatchId, evidence.calculatedEnergyTypeId);
    assert.throws(() => carbonAdapter.revalidate({ db, run, actorUserId: 1 }));
    db.exec('ROLLBACK');

    // preview 直接复用正式 finite 与 5000 活动上限判定，不复制计算算法或静默截断。
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE carbon_factors SET factor_value = ? WHERE id = ?')
      .run(1e308, evidence.factorId);
    refreshSnapshot(db, 'carbon_factor', evidence.factorId);
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    }), (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_RESULT');
    assert.throws(() => carbonAdapter.resolve(db, run, {}, 1),
      (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_RESULT');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');

    // 每条正式结果均有限，但同排放单位累计后的六位缩放溢出必须由 direct/adapter preview 一致拒绝。
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE carbon_factors SET factor_value = ? WHERE id = ?')
      .run(1e302, evidence.factorId);
    refreshSnapshot(db, 'carbon_factor', evidence.factorId);
    db.prepare(`UPDATE carbon_activity_records SET energy_type_id = ?, activity_value = 1
      WHERE id IN (?, ?)`).run(
      evidence.calculatedEnergyTypeId,
      evidence.calculatedActivityId,
      evidence.missingActivityId
    );
    refreshSnapshot(db, 'carbon_activity_record', evidence.calculatedActivityId);
    refreshSnapshot(db, 'carbon_activity_record', evidence.missingActivityId);
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    }), (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_TOTAL');
    assert.throws(() => carbonAdapter.resolve(db, run, {}, 1),
      (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_TOTAL');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');

    db.exec('BEGIN IMMEDIATE');
    seedCarbonPreviewActivityLimit(db, run, evidence);
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    }), (error) => error?.code === 'CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED');
    assert.throws(() => carbonAdapter.resolve(db, run, {}, 1),
      (error) => error?.code === 'CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');

    // preview 必须按同优先级 factor ID 降序选择；高 ID 溢出因子使错误与低 ID 正常因子可区分。
    db.exec('BEGIN IMMEDIATE');
    const overflowTieFactorId = Number(db.prepare(`INSERT INTO carbon_factors
      (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
       factor_value, factor_unit, source, effective_from, effective_to, is_active)
      VALUES (?, 3, ?, 'cn-action', 2026, 'unit', ?, 'kgCO2e',
        'carbon-action-tie-overflow-high-id', '2000-01-01', '2099-12-31', 1)`).run(
      evidence.factorBatchId,
      evidence.calculatedEnergyTypeId,
      1e308
    ).lastInsertRowid);
    assert.strictEqual(overflowTieFactorId > evidence.factorId, true);
    registerImported(db, run, '11-carbon-factors', 'carbon_factor', overflowTieFactorId,
      evidence.factorBatchId, 3);
    assert.throws(() => carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    }), (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_RESULT');
    assert.throws(() => carbonAdapter.resolve(db, run, {}, 1),
      (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_RESULT');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.exec('ROLLBACK');

    // 同优先级采用最高 factor ID，正式 execute 的六位舍入与紧邻 preview 共享同一 exact scope。
    const tieActionRunId = insertExecutingActionRun(db, run, 'tie-rounding');
    db.exec('BEGIN IMMEDIATE');
    const tieFactorId = Number(db.prepare(`INSERT INTO carbon_factors
      (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit,
       factor_value, factor_unit, source, effective_from, effective_to, is_active)
      VALUES (?, 3, ?, 'cn-action', 2026, 'unit', 0.333333, 'kgCO2e',
        'carbon-action-tie-high-id', '2000-01-01', '2099-12-31', 1)`).run(
      evidence.factorBatchId,
      evidence.calculatedEnergyTypeId
    ).lastInsertRowid);
    registerImported(db, run, '11-carbon-factors', 'carbon_factor', tieFactorId,
      evidence.factorBatchId, 3);
    db.prepare('UPDATE carbon_activity_records SET activity_value = 3.333333 WHERE id = ?')
      .run(evidence.calculatedActivityId);
    refreshSnapshot(db, 'carbon_activity_record', evidence.calculatedActivityId);
    const directTiePreview = carbonExactProtocol.inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: resolved.privateContext.demoRun,
      actor: resolved.privateContext.actor
    });
    const expectedTiePrivateDigest = sha256Json({
      version: 1,
      privateScopeDigest: directTiePreview.privateScopeDigest,
      results: [
        {
          status: 'calculated',
          emissionValue: 1.11111,
          emissionUnit: 'kgCO2e',
          missingReason: null,
          matchPriority: 1
        },
        {
          status: 'factor_missing',
          emissionValue: null,
          emissionUnit: null,
          missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR',
          matchPriority: null
        }
      ],
      emissionTotals: {
        version: 1,
        totals: [{
          emissionUnit: 'kgCO2e',
          totalEmissionValue: 1.11111,
          calculatedCount: 1
        }]
      }
    });
    assert.strictEqual(directTiePreview.privateDigest, expectedTiePrivateDigest);
    const tieResolved = carbonAdapter.resolve(db, run, {}, 1);
    assert.strictEqual(tieResolved.privateDigest, expectedTiePrivateDigest);
    const tiePreview = carbonAdapter.previewProbe({
      db,
      run,
      privateContext: tieResolved.privateContext
    });
    assert.strictEqual(tiePreview.result.calculatedCount, 1);
    assertPublicProjectionSafe(tiePreview);
    const tieExecution = carbonAdapter.execute({
      db,
      run,
      privateContext: tieResolved.privateContext,
      actionRunId: tieActionRunId,
      actorUserId: 1
    });
    assert.strictEqual(tieExecution.outputCount, 3);
    const tieRunOutput = tieExecution.outputs.find((output) => (
      output.outputEntityType === 'carbon_calculation_run'
    ));
    const tieCalculatedOutput = tieExecution.outputs.find((output) => (
      output.outputEntityType === 'carbon_accounting_result'
        && output.outputRef.status === 'calculated'
    ));
    const tieMissingOutput = tieExecution.outputs.find((output) => (
      output.outputEntityType === 'carbon_accounting_result'
        && output.outputRef.status === 'factor_missing'
    ));
    assert.match(
      tieRunOutput.outputRef.runCode,
      /^CAR-\d{14}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    assert.strictEqual(tieRunOutput.outputRef.status, 'completed');
    assert.deepStrictEqual({
      status: tieCalculatedOutput.outputRef.status,
      emissionUnit: tieCalculatedOutput.outputRef.emissionUnit,
      missingReason: tieCalculatedOutput.outputRef.missingReason
    }, { status: 'calculated', emissionUnit: 'kgCO2e', missingReason: null });
    assert.deepStrictEqual({
      status: tieMissingOutput.outputRef.status,
      emissionUnit: tieMissingOutput.outputRef.emissionUnit,
      missingReason: tieMissingOutput.outputRef.missingReason
    }, {
      status: 'factor_missing',
      emissionUnit: null,
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR'
    });
    assert.deepStrictEqual(tieExecution.result.emissionTotals, {
      version: 1,
      totals: [{ emissionUnit: 'kgCO2e', totalEmissionValue: 1.11111, calculatedCount: 1 }]
    });
    const tieResult = db.prepare(`SELECT carbon_factor_id AS factorId, emission_value AS emissionValue
      FROM carbon_accounting_results WHERE status = 'calculated'`).get();
    assert.strictEqual(Number(tieResult.factorId), tieFactorId);
    assert.strictEqual(Number(tieResult.emissionValue), 1.11111);
    db.exec('ROLLBACK');
    db.prepare(`UPDATE demo_post_action_runs SET status = 'failed', failure_reason = 'TEST_TIE_ROLLBACK',
      completed_at = ?, updated_at = ? WHERE action_run_id = ?`).run(
      new Date().toISOString(),
      new Date().toISOString(),
      tieActionRunId
    );

    // caller rollback：adapter 返回 1+N outputs，但 calculation/audit/derived/relation 全部随 caller 回滚。
    const rollbackActionRunId = insertExecutingActionRun(db, run, 'rollback');
    db.exec('BEGIN IMMEDIATE');
    const rollbackResolved = carbonAdapter.revalidate({ db, run, actorUserId: 1, actorIp: '127.0.0.1' });
    const ownershipProtocolPath = require.resolve('../services/carbonAccountingOwnershipProtocol');
    const canonicalOwnershipProtocolModule = require.cache[ownershipProtocolPath];
    let maliciousOwnershipCalls = 0;
    const maliciousOwnershipHandler = () => {
      maliciousOwnershipCalls += 1;
      throw Object.assign(new Error('malicious ownership replacement'), {
        code: 'MALICIOUS_OWNERSHIP_HANDLER_CALLED'
      });
    };
    assert.throws(() => {
      canonicalOwnershipProtocolModule.exports = {
        carbonAccountingOwnershipProtocol: {}
      };
    }, TypeError);
    require.cache[ownershipProtocolPath] = {
      id: ownershipProtocolPath,
      filename: ownershipProtocolPath,
      loaded: true,
      children: [],
      paths: [],
      exports: {
        carbonAccountingOwnershipProtocol: {
          issueRegistrationScopeInCallerTransaction: maliciousOwnershipHandler,
          registerDerivedOwnershipInCallerTransaction: maliciousOwnershipHandler,
          verifyRegistrationReceiptInCallerTransaction: maliciousOwnershipHandler,
          abortRegistrationScopeInCallerTransaction: maliciousOwnershipHandler
        }
      }
    };
    let rollbackExecution;
    try {
      rollbackExecution = carbonAdapter.execute({
        db,
        run,
        privateContext: rollbackResolved.privateContext,
        actionRunId: rollbackActionRunId,
        actorUserId: 1
      });
    } finally {
      require.cache[ownershipProtocolPath] = canonicalOwnershipProtocolModule;
    }
    assert.strictEqual(maliciousOwnershipCalls, 0);
    assert.strictEqual(rollbackExecution.outputCount, 3);
    assert.strictEqual(rollbackExecution.outputs.length, 3);
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 1, results: 2, domainAudits: 1, derived: 3, relations: 5, outputs: 0
    });
    db.exec('ROLLBACK');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 0, results: 0, domainAudits: 0, derived: 0, relations: 0, outputs: 0
    });
    db.prepare("UPDATE demo_post_action_runs SET status = 'failed', failure_reason = 'TEST_ROLLBACK', completed_at = ?, updated_at = ? WHERE action_run_id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), rollbackActionRunId);

    // caller commit：写入 1 run、N results、domain audit、1+N ownership 和固定 relations。
    const commitActionRunId = insertExecutingActionRun(db, run, 'commit');
    db.exec('BEGIN IMMEDIATE');
    const commitResolved = carbonAdapter.revalidate({ db, run, actorUserId: 1, actorIp: '127.0.0.1' });
    const committed = carbonAdapter.execute({
      db,
      run,
      privateContext: commitResolved.privateContext,
      actionRunId: commitActionRunId,
      actorUserId: 1
    });
    db.exec('COMMIT');
    assert.strictEqual(committed.outputCount, 3);
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 1, results: 2, domainAudits: 1, derived: 3, relations: 5, outputs: 0
    });
    const resultRows = db.prepare(`SELECT activity_record_id AS activityRecordId,
        carbon_factor_id AS carbonFactorId, status
      FROM carbon_accounting_results ORDER BY id`).all();
    assert.strictEqual(resultRows.some((row) => Number(row.activityRecordId) === evidence.formalActivityId), false);
    const calculated = resultRows.find((row) => row.status === 'calculated');
    const missing = resultRows.find((row) => row.status === 'factor_missing');
    assert.strictEqual(Number(calculated.carbonFactorId), evidence.factorId);
    assert.notStrictEqual(Number(calculated.carbonFactorId), evidence.formalFactorId);
    assert.strictEqual(missing.carbonFactorId, null);
    const missingResultId = Number(db.prepare("SELECT id FROM carbon_accounting_results WHERE status = 'factor_missing'").get().id);
    const missingRegistryId = Number(db.prepare("SELECT registry_id AS id FROM demo_data_registry WHERE entity_type = 'carbon_accounting_result' AND entity_pk = ?").get(String(missingResultId)).id);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_relations WHERE from_registry_id = ? AND relation_type = 'uses_factor'").get(missingRegistryId).total), 0);

    // active derived closure 阻断第二套新运行；原 terminal action 事实保持不重复。
    assert.throws(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        carbonAdapter.revalidate({ db, run, actorUserId: 1 });
      } finally {
        if (db.inTransaction) db.exec('ROLLBACK');
      }
    }, (error) => error?.code === 'DEMO_CARBON_ACTIVE_DERIVED_CLOSURE_EXISTS');
    assert.deepStrictEqual(readWriteCounts(db), {
      runs: 1, results: 2, domainAudits: 1, derived: 3, relations: 5, outputs: 0
    });

    console.log('demoPostActionCarbonAccounting tests passed');
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
