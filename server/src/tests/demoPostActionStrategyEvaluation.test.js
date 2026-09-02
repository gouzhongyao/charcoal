'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// strategy 后置动作测试只使用隔离临时 SQLite，不触碰项目真实业务数据库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-strategy-action-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'strategy-action.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  getDemoOwnershipSummary
} = require('../services/demoOwnershipService');
const postActionService = require('../services/demoPostActionService');
const {
  executeDemoPostAction,
  getDemoPostActionStatus,
  previewDemoPostAction
} = postActionService;
const { createDemoPostActionStrategyHarness } = require('./helpers/demoPostActionStrategyHarness');

// cache 身份回归固定比较 production wrapper/core/registry 的真实 Module entry。
const SERVICE_MODULE_PATH = require.resolve('../services/demoPostActionService');
const CANONICAL_SERVICE_MODULE_PATH = require.resolve(
  '../services/demoPostActionCanonicalService'
);
const REGISTRY_MODULE_PATH = require.resolve('../services/demoPostActionRegistry');
const NOW = '2026-08-28T00:00:00.000Z';
const WINDOW_START = '2026-08-01T00:00:00.000Z';
const WINDOW_END = '2026-08-01T01:00:00.000Z';
const TIMESERIES_SHA = crypto.createHash('sha256').update('strategy-timeseries', 'utf8').digest('hex');
const RULE_SHA = crypto.createHash('sha256').update('strategy-rules', 'utf8').digest('hex');
// 专项测试在打开隔离数据库后创建固定 lifecycle harness。
let strategyLifecycleHarness = null;

/** 插入一个已完成的 managed-context artifact batch 和 run linkage。 */
function insertManagedBinding(db, run, definition, index) {
  const fileSha = definition.fileSha;
  const batchId = Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, file_size_bytes, file_sha256, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count, created_at, updated_at)
    VALUES (?, ?, 'xlsx', 128, ?, 'completed', 'execute', ?, ?, 0, 0, ?, ?)`).run(
    definition.importType, `${definition.artifactKey}.xlsx`, fileSha, definition.rowCount, definition.rowCount, NOW, NOW
  ).lastInsertRowid);
  const contextId = `strategy-context-${index}`;
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest, artifact_key,
     handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch, status, issued_at,
     expires_at, upload_file_sha256, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'executed', ?, ?, ?, ?)`).run(
    contextId,
    crypto.createHash('sha256').update(contextId, 'utf8').digest('hex'),
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    definition.artifactKey,
    definition.handlerKey,
    fileSha,
    run.runtimeEpoch,
    NOW,
    '2026-09-01T00:00:00.000Z',
    fileSha,
    NOW
  );
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, 'primary')`).run(run.runId, definition.artifactKey, contextId, batchId);
  return batchId;
}

/** 插入 artifact 15/18 的业务行、imported ownership 和完整来源事实。 */
function seedStrategyEvidence(db, run) {
  const energyTypeId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
    VALUES ('STRATEGY-UNIT', '策略测试单元', '/策略测试单元', 'workshop', 'active', ?, ?)`).run(NOW, NOW).lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status, created_at, updated_at)
    VALUES ('STRATEGY-METER', '策略测试表计', 'electricity', ?, ?, 'active', ?, ?)`).run(
    energyTypeId, organizationUnitId, NOW, NOW
  ).lastInsertRowid);
  const timeseriesBatchId = insertManagedBinding(db, run, {
    artifactKey: '15-energy-timeseries', handlerKey: 'energy-timeseries-import',
    importType: 'energy_timeseries', fileSha: TIMESERIES_SHA, rowCount: 4
  }, 15);
  const ruleBatchId = insertManagedBinding(db, run, {
    artifactKey: '18-strategy-rules', handlerKey: 'strategy-rules-import',
    importType: 'strategy_rule', fileSha: RULE_SHA, rowCount: 1
  }, 18);
  const insertTimeseries = db.prepare(`INSERT INTO energy_timeseries_records
    (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
     start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
     normalized_unit, normalized_value, source_reference, data_source, record_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', ?, 'kWh', ?, ?, 'upload', 'active', ?, ?)`);
  const values = [120, 135, 320, 150];
  const timeseriesIds = values.map((value, index) => Number(insertTimeseries.run(
    timeseriesBatchId,
    index + 2,
    organizationUnitId,
    meterDeviceId,
    energyTypeId,
    new Date(Date.parse(WINDOW_START) + index * 15 * 60 * 1000).toISOString(),
    new Date(Date.parse(WINDOW_START) + (index + 1) * 15 * 60 * 1000).toISOString(),
    value,
    value,
    `strategy-timeseries-${index + 1}`,
    NOW,
    NOW
  ).lastInsertRowid));
  const ruleId = Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
     source_timezone, status, created_at, updated_at)
    VALUES (?, 2, 'QL-STRATEGY-PEAK', '峰段能耗偏高提醒', 'strategy-rule:v1', 'load-analysis:v1',
      'peak_interval_energy', 'gt', 300, 'kWh/15min', 0.08, 'high', ?,
      '建议复核峰段设备错峰安排。', '天坤集团能源制度', '2025-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active', ?, ?)`).run(
    ruleBatchId,
    JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
    NOW,
    NOW
  ).lastInsertRowid);
  const ownershipDefinitions = [
    ...timeseriesIds.map((id, index) => ['15-energy-timeseries', 'energy_timeseries', id, timeseriesBatchId, index + 2]),
    ['18-strategy-rules', 'strategy_rule', ruleId, ruleBatchId, 2]
  ];
  ownershipDefinitions.forEach(([artifactKey, entityType, entityPk, sourceBatchId, sourceRowNumber]) => {
    const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
    db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest,
       source_batch_id, source_row_number, registered_by)
      VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`).run(
      run.runId,
      artifactKey,
      entityType,
      String(entityPk),
      calculateDemoEntityIdentityDigest(entityType, String(entityPk)),
      calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
      sourceBatchId,
      sourceRowNumber
    );
  });
  return {
    energyTypeId,
    organizationUnitId,
    meterDeviceId,
    timeseriesBatchId,
    ruleBatchId,
    timeseriesIds,
    ruleId
  };
}

/** 读取策略输入关系测试使用的 ownership registry 主键。 */
function readStrategyInputRegistryIds(db, run) {
  const timeseriesRegistryIds = db.prepare(`SELECT registry_id AS registryId FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '15-energy-timeseries' AND entity_type = 'energy_timeseries'
    ORDER BY registry_id`).all(run.runId).map((row) => Number(row.registryId));
  const ruleRegistry = db.prepare(`SELECT registry_id AS registryId FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '18-strategy-rules' AND entity_type = 'strategy_rule'
    ORDER BY registry_id`).get(run.runId);
  if (!ruleRegistry || timeseriesRegistryIds.length === 0) throw new Error('策略测试必须创建输入 ownership。');
  return { timeseriesRegistryIds, ruleRegistryId: Number(ruleRegistry.registryId) };
}

/** 插入 artifact 15 全部时序到 artifact 18 规则的固定 imported uses_config 闭包。 */
function insertStrategyInputRelations(db, run) {
  const registryIds = readStrategyInputRegistryIds(db, run);
  const insertInputRelation = db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`);
  registryIds.timeseriesRegistryIds.forEach((timeseriesRegistryId) => insertInputRelation.run(
    run.runId, timeseriesRegistryId, registryIds.ruleRegistryId
  ));
  return registryIds;
}

/** 为测试场景重新登记一条 imported ownership，并复用正式摘要算法。 */
function insertImportedOwnership(db, run, artifactKey, entityType, entityPk, sourceBatchId, sourceRowNumber) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest,
     source_batch_id, source_row_number, registered_by)
    VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`).run(
    run.runId,
    artifactKey,
    entityType,
    String(entityPk),
    calculateDemoEntityIdentityDigest(entityType, String(entityPk)),
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    sourceBatchId,
    sourceRowNumber
  );
}

/** 为多组测试补充一个同数据库但不同表计的正式表计。 */
function insertSecondaryMeter(db, evidence) {
  return Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status, created_at, updated_at)
    VALUES ('STRATEGY-METER-2', '策略测试第二表计', 'electricity', ?, ?, 'active', ?, ?)`).run(
    evidence.energyTypeId, evidence.organizationUnitId, NOW, NOW
  ).lastInsertRowid);
}

/** 插入与当前 demo run 无 ownership 关系的正式时序和规则，验证 exact scope 不会宽查兜底。 */
function seedUnownedFormalData(db, evidence) {
  const timeseriesBatchId = Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, file_size_bytes, file_sha256, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count, created_at, updated_at)
    VALUES ('energy_timeseries', 'unowned-timeseries.xlsx', 'xlsx', 128, ?, 'completed', 'execute',
      4, 4, 0, 0, ?, ?)`).run(
    crypto.createHash('sha256').update('unowned-timeseries', 'utf8').digest('hex'), NOW, NOW
  ).lastInsertRowid);
  const insertTimeseries = db.prepare(`INSERT INTO energy_timeseries_records
    (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
     start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
     normalized_unit, normalized_value, source_reference, data_source, record_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', 999, 'kWh', 999, ?,
      'upload', 'active', ?, ?)`);
  for (let index = 0; index < 4; index += 1) {
    insertTimeseries.run(
      timeseriesBatchId,
      index + 2,
      evidence.organizationUnitId,
      evidence.meterDeviceId,
      evidence.energyTypeId,
      new Date(Date.parse(WINDOW_START) + index * 15 * 60 * 1000).toISOString(),
      new Date(Date.parse(WINDOW_START) + (index + 1) * 15 * 60 * 1000).toISOString(),
      `unowned-timeseries-${index + 1}`,
      NOW,
      NOW
    );
  }
  const ruleBatchId = Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, file_size_bytes, file_sha256, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count, created_at, updated_at)
    VALUES ('strategy_rule', 'unowned-rules.xlsx', 'xlsx', 128, ?, 'completed', 'execute',
      1, 1, 0, 0, ?, ?)`).run(
    crypto.createHash('sha256').update('unowned-rules', 'utf8').digest('hex'), NOW, NOW
  ).lastInsertRowid);
  db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
     source_timezone, status, created_at, updated_at)
    VALUES (?, 2, 'UNOWNED-STRATEGY-RULE', '未归属正式规则', 'strategy-rule:v1', 'load-analysis:v1',
      'peak_interval_energy', 'gt', 1, 'kWh/15min', 0.1, 'high', ?, '不应被当前 demo run 选中。',
      '其他正式来源', '2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
      'Asia/Shanghai', 'active', ?, ?)`).run(
    ruleBatchId,
    JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
    NOW,
    NOW
  );
}

/** 业务行变更后同步 imported ownership 快照，用于精准触发非 ownership 类 blocker。 */
function refreshImportedOwnershipSnapshot(db, entityType, entityPk) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE entity_type = ? AND entity_pk = ? AND ownership_kind = 'imported'`).run(
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    entityType,
    String(entityPk)
  );
}

/** 按指定粒度重写完整连续时序窗口，并同步 imported ownership 快照。 */
function rewriteStrategyTimeseriesGranularity(db, evidence, granularityMinutes) {
  evidence.timeseriesIds.forEach((entityPk, index) => {
    db.prepare(`UPDATE energy_timeseries_records SET start_utc = ?, end_utc = ?,
      granularity_minutes = ? WHERE id = ?`).run(
      new Date(Date.parse(WINDOW_START) + index * granularityMinutes * 60 * 1000).toISOString(),
      new Date(Date.parse(WINDOW_START) + (index + 1) * granularityMinutes * 60 * 1000).toISOString(),
      granularityMinutes,
      entityPk
    );
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', entityPk);
  });
}

/** 断言 strategy preview 按预期 fail-closed，并返回公共 blocker DTO。 */
function assertBlockedPreview(db, run, clientRequestId, expectedCode) {
  const preview = strategyPreview(db, run, clientRequestId);
  assert.strictEqual(preview.status, 'blocked', JSON.stringify(preview));
  assert.strictEqual(preview.blocker.code, expectedCode, JSON.stringify(preview));
  assert.strictEqual(preview.outputCount, 0);
  assert.strictEqual(JSON.stringify(preview).includes('privateContext'), false);
  return preview;
}

/** 读取 rollback 前后需要保持一致的领域写入计数。 */
function readStrategyWriteCounts(db) {
  return {
    evaluationRuns: db.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count,
    ruleHits: db.prepare('SELECT COUNT(*) AS count FROM strategy_rule_hits').get().count,
    derivedRegistry: db.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE ownership_kind = 'derived'").get().count,
    relations: db.prepare("SELECT COUNT(*) AS count FROM demo_data_relations WHERE relation_type IN ('contains', 'uses_config', 'generated_from')").get().count,
    domainAudits: db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'energy.strategy.run'").get().count
  };
}

/** 读取成功 strategy action 的持久状态和输出 witness，供 fail-closed 对抗测试比较。 */
function readStrategyActionWitness(db, actionRunId) {
  const action = db.prepare(`SELECT status, result_digest AS resultDigest,
      result_json AS resultJson, output_count AS outputCount, started_at AS startedAt,
      completed_at AS completedAt FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRunId);
  const outputs = db.prepare(`SELECT output_id AS outputId, output_entity_type AS outputEntityType,
      output_entity_id AS outputEntityId, output_ref_json AS outputRefJson, created_at AS createdAt
    FROM demo_post_action_outputs WHERE action_run_id = ? ORDER BY output_id`).all(actionRunId);
  return { action, outputs };
}

/** 读取通用 lifecycle 允许的阻断预演审计增量和禁止变化的执行状态计数。 */
function readStrategyActionWriteCounts(db) {
  return {
    actionRuns: db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_runs').get().count,
    blockedActions: db.prepare("SELECT COUNT(*) AS count FROM demo_post_action_runs WHERE status = 'blocked'").get().count,
    executingActions: db.prepare("SELECT COUNT(*) AS count FROM demo_post_action_runs WHERE status = 'executing'").get().count,
    succeededActions: db.prepare("SELECT COUNT(*) AS count FROM demo_post_action_runs WHERE status = 'succeeded'").get().count,
    failedActions: db.prepare("SELECT COUNT(*) AS count FROM demo_post_action_runs WHERE status = 'failed'").get().count,
    actionOutputs: db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs').get().count,
    previewAudits: db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.preview'").get().count,
    executeAudits: db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute'").get().count
  };
}

/** 通过 production 公共服务入口执行 strategy preview。 */
function strategyPreview(db, run, clientRequestId) {
  return previewDemoPostAction({
    runId: run.runId,
    actionKey: 'strategy-evaluation-run',
    body: { clientRequestId },
    actorUserId: 1,
    db
  });
}

/** 通过 production 公共服务入口执行 strategy execute。 */
function strategyExecute(db, preview, clientRequestId) {
  return executeDemoPostAction({
    actionRunId: preview.actionRunId,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: '确认执行策略评估运行'
    },
    actorUserId: 1,
    db
  });
}

function runTest() {
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const db = openDatabase();
  try {
    const productionServiceCacheEntry = require.cache[SERVICE_MODULE_PATH];
    const productionCanonicalServiceCacheEntry =
      require.cache[CANONICAL_SERVICE_MODULE_PATH];
    const productionRegistryCacheEntry = require.cache[REGISTRY_MODULE_PATH];
    const productionRegistry = require('../services/demoPostActionRegistry');
    assert.throws(() => createDemoPostActionStrategyHarness({
      prepare() {},
      transaction() {},
      name: process.env.SQLITE_PATH
    }), /未知字段/);

    // RF-P2-081：普通临时目录外路径必须拒绝，不能只依赖 path.resolve 的词法前缀判断。
    const externalRoot = __dirname;
    assert.throws(() => createDemoPostActionStrategyHarness({
      databasePath: path.join(externalRoot, 'outside.sqlite')
    }), /临时根目录外/);

    const safeMissingDirectory = fs.mkdtempSync(path.join(tmpDir, 'canonical-safe-'));
    const safeMissingDatabasePath = path.join(safeMissingDirectory, 'not-yet-created.sqlite');
    const safeRequestedPath = process.platform === 'win32'
      ? safeMissingDatabasePath.split(path.sep).join('/').toUpperCase()
      : safeMissingDatabasePath;
    const safeMissingHarness = createDemoPostActionStrategyHarness({
      databasePath: safeRequestedPath
    });
    safeMissingHarness.close();
    assert.strictEqual(fs.existsSync(safeMissingDatabasePath), true,
      '最近存在父目录位于 canonical 临时根目录内时应允许创建新 SQLite 文件。');

    const externalLinkPath = path.join(tmpDir, 'external-junction');
    let externalLinkCreated = false;
    try {
      fs.symlinkSync(externalRoot, externalLinkPath, process.platform === 'win32' ? 'junction' : 'dir');
      externalLinkCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
      console.log('demoPostActionStrategyEvaluation.test.js skipped junction escape case: permission denied');
    }
    if (externalLinkCreated) {
      assert.throws(() => createDemoPostActionStrategyHarness({
        databasePath: path.join(externalLinkPath, 'escaped.sqlite')
      }), /临时根目录外/);
    }

    const externalFileLinkPath = path.join(tmpDir, 'external-file-link.sqlite');
    let externalFileLinkCreated = false;
    try {
      fs.symlinkSync(__filename, externalFileLinkPath, 'file');
      externalFileLinkCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
      console.log('demoPostActionStrategyEvaluation.test.js skipped file symlink escape case: permission denied');
    }
    if (externalFileLinkCreated) {
      assert.throws(() => createDemoPostActionStrategyHarness({
        databasePath: externalFileLinkPath
      }), /临时根目录外/);
    }

    const memoryHarness = createDemoPostActionStrategyHarness({
      databasePath: ':memory:',
      initializeDatabase(memoryDb) {
        memoryDb.exec('CREATE TABLE harness_memory_probe (id INTEGER PRIMARY KEY)');
      }
    });
    try {
      memoryHarness.withDatabase((memoryDb) => {
        assert.strictEqual(memoryDb.name, ':memory:');
        memoryDb.prepare('INSERT INTO harness_memory_probe (id) VALUES (1)').run();
        assert.strictEqual(memoryDb.prepare('SELECT COUNT(*) AS count FROM harness_memory_probe').get().count, 1);
      });
    } finally {
      memoryHarness.close();
    }
    // lifecycle harness 只复用已初始化的正式 service/registry，缺少 cache 时必须拒绝且不得自行注入 entry。
    delete require.cache[SERVICE_MODULE_PATH];
    delete require.cache[REGISTRY_MODULE_PATH];
    try {
      assert.throws(() => createDemoPostActionStrategyHarness({
        databasePath: process.env.SQLITE_PATH
      }), /要求 production service 与 registry 已正常初始化/);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(require.cache, SERVICE_MODULE_PATH), false);
      assert.strictEqual(
        require.cache[CANONICAL_SERVICE_MODULE_PATH],
        productionCanonicalServiceCacheEntry
      );
      assert.strictEqual(Object.prototype.hasOwnProperty.call(require.cache, REGISTRY_MODULE_PATH), false);
    } finally {
      require.cache[SERVICE_MODULE_PATH] = productionServiceCacheEntry;
      require.cache[REGISTRY_MODULE_PATH] = productionRegistryCacheEntry;
    }
    assert.strictEqual(require(SERVICE_MODULE_PATH), postActionService);
    assert.strictEqual(require(REGISTRY_MODULE_PATH), productionRegistry);

    strategyLifecycleHarness = createDemoPostActionStrategyHarness({
      databasePath: process.env.SQLITE_PATH
    });
    assert.strictEqual(require.cache[SERVICE_MODULE_PATH], productionServiceCacheEntry);
    assert.strictEqual(
      require.cache[CANONICAL_SERVICE_MODULE_PATH],
      productionCanonicalServiceCacheEntry
    );
    assert.strictEqual(require.cache[REGISTRY_MODULE_PATH], productionRegistryCacheEntry);
    assert.strictEqual(require(SERVICE_MODULE_PATH), postActionService);
    const productionStrategy = productionRegistry.requireDemoPostAction('strategy-evaluation-run');
    assert.strictEqual(productionStrategy.implementationStatus, 'connected');
    assert.strictEqual(productionStrategy.executorVersion, 'strategy-evaluation-executor:v1');
    ['_test', 'previewStrategyEvaluationLifecycleForTest', 'executeStrategyEvaluationLifecycleForTest'].forEach(
      (testEntry) => assert.strictEqual(
        Reflect.ownKeys(postActionService).includes(testEntry),
        false,
        `生产 service 出口不得暴露 ${testEntry}`
      )
    );
    const evidence = seedStrategyEvidence(db, run);
    const forbiddenBodyFields = {
      privateContext: {},
      exactScope: {},
      meterDeviceId: evidence.meterDeviceId,
      timeseriesRecordIds: evidence.timeseriesIds,
      strategyRuleIds: [evidence.ruleId],
      importBatchId: evidence.timeseriesBatchId,
      startUtc: WINDOW_START,
      manifestDigest: run.manifestDigest,
      privateDigest: '0'.repeat(64),
      contextId: 'untrusted-context',
      registryId: 1,
      capability: {}
    };
    assert.throws(() => previewDemoPostAction({
      runId: run.runId,
      actionKey: 'strategy-evaluation-run',
      body: { clientRequestId: 'strategy-body-with-private-input', ...forbiddenBodyFields },
      actorUserId: 1,
      db
    }), (error) => {
      assert.strictEqual(error.code, 'BAD_REQUEST');
      assert.strictEqual(error.details?.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
      assert.deepStrictEqual(error.details?.fields, Object.keys(forbiddenBodyFields).sort());
      return true;
    });
    assertBlockedPreview(db, run, 'strategy-relations-missing-all', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    const inputRegistryIds = insertStrategyInputRelations(db, run);
    const firstTimeseriesRegistryId = inputRegistryIds.timeseriesRegistryIds[0];
    const secondTimeseriesRegistryId = inputRegistryIds.timeseriesRegistryIds[1];
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-relations-missing-one', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );

    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, inputRegistryIds.ruleRegistryId, firstTimeseriesRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-relations-extra-uses-config', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, inputRegistryIds.ruleRegistryId, firstTimeseriesRegistryId
    );

    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, firstTimeseriesRegistryId, secondTimeseriesRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-relations-wrong-endpoint', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, firstTimeseriesRegistryId, secondTimeseriesRegistryId
    );
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );

    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'generated_from')`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-relations-wrong-type', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'generated_from'`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, firstTimeseriesRegistryId, inputRegistryIds.ruleRegistryId
    );

    db.prepare('DELETE FROM demo_data_relations WHERE run_id = ?').run(run.runId);
    const timeseriesBinding = db.prepare(`SELECT artifact_key AS artifactKey, context_id AS contextId,
      import_batch_id AS importBatchId, batch_role AS batchRole FROM demo_run_import_batches
      WHERE run_id = ? AND artifact_key = '15-energy-timeseries'`).get(run.runId);
    db.prepare(`DELETE FROM demo_run_import_batches WHERE run_id = ? AND artifact_key = '15-energy-timeseries'`).run(run.runId);
    assertBlockedPreview(db, run, 'strategy-missing-timeseries-binding', 'DEMO_STRATEGY_BINDING_NOT_UNIQUE');
    db.prepare(`INSERT INTO demo_run_import_batches
      (run_id, artifact_key, context_id, import_batch_id, batch_role) VALUES (?, ?, ?, ?, ?)`).run(
      run.runId, timeseriesBinding.artifactKey, timeseriesBinding.contextId,
      timeseriesBinding.importBatchId, timeseriesBinding.batchRole
    );

    db.prepare("DELETE FROM demo_data_registry WHERE run_id = ? AND artifact_key = '15-energy-timeseries'").run(run.runId);
    assertBlockedPreview(db, run, 'strategy-missing-timeseries', 'DEMO_STRATEGY_OWNERSHIP_MISSING');
    evidence.timeseriesIds.forEach((entityPk, index) => insertImportedOwnership(
      db, run, '15-energy-timeseries', 'energy_timeseries', entityPk, evidence.timeseriesBatchId, index + 2
    ));

    db.prepare("DELETE FROM demo_data_registry WHERE run_id = ? AND artifact_key = '18-strategy-rules'").run(run.runId);
    assertBlockedPreview(db, run, 'strategy-missing-rules', 'DEMO_STRATEGY_OWNERSHIP_MISSING');
    insertImportedOwnership(db, run, '18-strategy-rules', 'strategy_rule', evidence.ruleId, evidence.ruleBatchId, 2);
    insertStrategyInputRelations(db, run);

    const secondMeterDeviceId = insertSecondaryMeter(db, evidence);
    db.prepare('UPDATE energy_timeseries_records SET meter_device_id = ? WHERE id = ?').run(secondMeterDeviceId, evidence.timeseriesIds[3]);
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[3]);
    assertBlockedPreview(db, run, 'strategy-multiple-groups', 'DEMO_STRATEGY_GROUP_NOT_HOMOGENEOUS');
    db.prepare('UPDATE energy_timeseries_records SET meter_device_id = ? WHERE id = ?').run(evidence.meterDeviceId, evidence.timeseriesIds[3]);
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[3]);

    db.prepare('UPDATE strategy_rules SET effective_end_utc = ? WHERE id = ?').run('2026-08-01T00:30:00.000Z', evidence.ruleId);
    refreshImportedOwnershipSnapshot(db, 'strategy_rule', evidence.ruleId);
    assertBlockedPreview(db, run, 'strategy-rule-not-applicable', 'DEMO_STRATEGY_RULE_NOT_APPLICABLE');
    db.prepare('UPDATE strategy_rules SET effective_end_utc = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', evidence.ruleId);
    refreshImportedOwnershipSnapshot(db, 'strategy_rule', evidence.ruleId);

    db.prepare('UPDATE energy_timeseries_records SET start_utc = ?, end_utc = ? WHERE id = ?').run(
      '2026-08-01T01:00:00.000Z', '2026-08-01T01:15:00.000Z', evidence.timeseriesIds[3]
    );
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[3]);
    assertBlockedPreview(db, run, 'strategy-window-invalid', 'DEMO_STRATEGY_TIME_WINDOW_INVALID');
    db.prepare('UPDATE energy_timeseries_records SET start_utc = ?, end_utc = ? WHERE id = ?').run(
      '2026-08-01T00:45:00.000Z', WINDOW_END, evidence.timeseriesIds[3]
    );
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[3]);

    db.prepare("UPDATE demo_data_registry SET identity_digest = ? WHERE run_id = ? AND entity_type = 'strategy_rule'").run('0'.repeat(64), run.runId);
    assertBlockedPreview(db, run, 'strategy-ownership-digest-invalid', 'DEMO_STRATEGY_OWNERSHIP_EVIDENCE_INVALID');
    db.prepare("UPDATE demo_data_registry SET identity_digest = ? WHERE run_id = ? AND entity_type = 'strategy_rule'").run(
      calculateDemoEntityIdentityDigest('strategy_rule', String(evidence.ruleId)), run.runId
    );

    const contextRuntimeEpoch = db.prepare('SELECT runtime_epoch AS runtimeEpoch FROM demo_import_contexts WHERE context_id = ?').get('strategy-context-18').runtimeEpoch;
    db.prepare('UPDATE demo_import_contexts SET runtime_epoch = ? WHERE context_id = ?').run(Number(contextRuntimeEpoch) + 1, 'strategy-context-18');
    assertBlockedPreview(db, run, 'strategy-context-runtime-invalid', 'DEMO_STRATEGY_BINDING_STALE');
    db.prepare('UPDATE demo_import_contexts SET runtime_epoch = ? WHERE context_id = ?').run(contextRuntimeEpoch, 'strategy-context-18');

    rewriteStrategyTimeseriesGranularity(db, evidence, 30);
    assertBlockedPreview(db, run, 'strategy-granularity-30', 'DEMO_STRATEGY_TIMESERIES_NOT_ACTIVE');
    rewriteStrategyTimeseriesGranularity(db, evidence, 60);
    assertBlockedPreview(db, run, 'strategy-granularity-60', 'DEMO_STRATEGY_TIMESERIES_NOT_ACTIVE');
    rewriteStrategyTimeseriesGranularity(db, evidence, 15);

    seedUnownedFormalData(db, evidence);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM energy_timeseries_records').get().count, 8);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM strategy_rules').get().count, 2);

    const timeseriesDriftPreview = strategyPreview(db, run, 'strategy-timeseries-drift');
    assert.strictEqual(timeseriesDriftPreview.status, 'previewed');
    const timeseriesDriftCounts = readStrategyWriteCounts(db);
    db.prepare(`UPDATE energy_timeseries_records SET original_value = original_value + 1,
      normalized_value = normalized_value + 1 WHERE id = ?`).run(evidence.timeseriesIds[0]);
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[0]);
    assert.throws(
      () => strategyExecute(db, timeseriesDriftPreview, 'strategy-timeseries-drift'),
      (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE'
    );
    assert.deepStrictEqual(readStrategyWriteCounts(db), timeseriesDriftCounts);
    assert.strictEqual(getDemoPostActionStatus({
      actionRunId: timeseriesDriftPreview.actionRunId,
      actorUserId: 1,
      db
    }).status, 'previewed');
    db.prepare(`UPDATE energy_timeseries_records SET original_value = original_value - 1,
      normalized_value = normalized_value - 1 WHERE id = ?`).run(evidence.timeseriesIds[0]);
    refreshImportedOwnershipSnapshot(db, 'energy_timeseries', evidence.timeseriesIds[0]);

    const ruleDriftPreview = strategyPreview(db, run, 'strategy-rule-drift');
    assert.strictEqual(ruleDriftPreview.status, 'previewed');
    const ruleDriftCounts = readStrategyWriteCounts(db);
    db.prepare('UPDATE strategy_rules SET threshold_value = threshold_value + 1 WHERE id = ?').run(evidence.ruleId);
    refreshImportedOwnershipSnapshot(db, 'strategy_rule', evidence.ruleId);
    assert.throws(
      () => strategyExecute(db, ruleDriftPreview, 'strategy-rule-drift'),
      (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE'
    );
    assert.deepStrictEqual(readStrategyWriteCounts(db), ruleDriftCounts);
    assert.strictEqual(getDemoPostActionStatus({
      actionRunId: ruleDriftPreview.actionRunId,
      actorUserId: 1,
      db
    }).status, 'previewed');
    db.prepare('UPDATE strategy_rules SET threshold_value = threshold_value - 1 WHERE id = ?').run(evidence.ruleId);
    refreshImportedOwnershipSnapshot(db, 'strategy_rule', evidence.ruleId);

    const preview = strategyPreview(db, run, 'strategy-preview-1');
    assert.strictEqual(preview.status, 'previewed', JSON.stringify(preview));
    assert.deepStrictEqual(Object.keys(preview.input).sort(), [
      'endUtc', 'sourceTimeZone', 'sources', 'startUtc', 'strategyRuleCount', 'timeseriesCount'
    ].sort());
    assert.deepStrictEqual(preview.input.sources, ['15-energy-timeseries', '18-strategy-rules']);
    assert.strictEqual(preview.input.timeseriesCount, 4);
    assert.strictEqual(preview.input.strategyRuleCount, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(preview.input, 'privateContext'), false);
    const storedInput = db.prepare('SELECT input_json AS inputJson FROM demo_post_action_runs WHERE action_run_id = ?').get(preview.actionRunId);
    ['privateContext', 'exactScope', 'registrationScope', 'completionWitness', 'registrarReceipt', 'capability'].forEach(
      (privateField) => assert.strictEqual(storedInput.inputJson.includes(privateField), false)
    );

    const forbiddenExecuteFields = {
      privateContext: {},
      exactScope: {},
      strategyRuleIds: [evidence.ruleId],
      timeseriesRecordIds: evidence.timeseriesIds,
      importBatchId: evidence.ruleBatchId,
      privateDigest: '0'.repeat(64),
      capability: {}
    };
    assert.throws(() => executeDemoPostAction({
      actionRunId: preview.actionRunId,
      body: {
        clientRequestId: 'strategy-preview-1',
        previewDigest: preview.previewDigest,
        confirmationText: '确认执行策略评估运行',
        ...forbiddenExecuteFields
      },
      actorUserId: 1,
      db
    }), (error) => {
      assert.strictEqual(error.code, 'BAD_REQUEST');
      assert.strictEqual(error.details?.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
      assert.deepStrictEqual(error.details?.fields, Object.keys(forbiddenExecuteFields).sort());
      return true;
    });
    const previewAuditCountBeforeReplay = db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.preview'").get().count;
    const replayPreview = strategyPreview(db, run, 'strategy-preview-1');
    assert.strictEqual(replayPreview.actionRunId, preview.actionRunId);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.preview'").get().count, previewAuditCountBeforeReplay);

    const executed = strategyExecute(db, preview, 'strategy-preview-1');
    assert.strictEqual(executed.status, 'succeeded');
    assert.strictEqual(executed.outputCount, 1);
    assert.deepStrictEqual(executed.outputs[0].outputRef, {
      ruleCode: 'QL-STRATEGY-PEAK', matchStatus: 'matched', priority: 'high'
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(executed.outputs[0].outputRef, 'outputEntityId'), false);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM strategy_rule_hits').get().count, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE ownership_kind = 'derived'").get().count, 2);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS count FROM demo_data_relations relation
      JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
      JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
      WHERE source.ownership_kind = 'imported' AND target.ownership_kind = 'imported'
        AND source.artifact_key = '15-energy-timeseries'
        AND target.artifact_key = '18-strategy-rules'
        AND relation.relation_type = 'uses_config'`).get().count, 4);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS count FROM demo_data_relations relation
      JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
      WHERE source.ownership_kind = 'derived'
        AND relation.relation_type IN ('contains', 'uses_config', 'generated_from')`).get().count, 6);

    // 成功 action 的完整 derived 闭包必须允许后续 preview；不完整或额外关系必须 fail-closed。
    const postExecuteInputRegistryIds = readStrategyInputRegistryIds(db, run);
    const postExecuteFirstTimeseriesRegistryId = postExecuteInputRegistryIds.timeseriesRegistryIds[0];
    const postExecuteRuleRegistryId = postExecuteInputRegistryIds.ruleRegistryId;
    const derivedEvaluationRegistry = db.prepare(`SELECT registry_id AS registryId
      FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'derived'
        AND entity_type = 'strategy_evaluation_run'`).get(run.runId);
    const derivedHitRegistry = db.prepare(`SELECT registry_id AS registryId
      FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'derived'
        AND entity_type = 'strategy_rule_hit'`).get(run.runId);
    assert(derivedEvaluationRegistry && derivedHitRegistry);
    const postSuccessPreview = strategyPreview(db, run, 'strategy-after-derived-success');
    assert.strictEqual(postSuccessPreview.status, 'previewed');

    const completedActionRow = db.prepare(`SELECT result_digest AS resultDigest,
      result_json AS resultJson, started_at AS startedAt, completed_at AS completedAt
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
    const completedOutputRow = db.prepare(`SELECT output_entity_type AS outputEntityType,
      output_entity_id AS outputEntityId, output_ref_json AS outputRefJson, created_at AS createdAt
      FROM demo_post_action_outputs WHERE action_run_id = ? ORDER BY output_id`).get(preview.actionRunId);
    assert(completedActionRow && completedOutputRow);

    // outputRef 必须精确绑定真实 hit/current imported rule；合法 JSON 的错误值、缺失和扩展字段均 fail-closed。
    const canonicalOutputRef = JSON.parse(completedOutputRow.outputRefJson);
    const completedActionWitness = readStrategyActionWitness(db, preview.actionRunId);
    const outputRefTamperCases = [
      {
        clientRequestId: 'strategy-output-ref-wrong-content',
        outputRef: {
          ruleCode: 'WRONG-RULE',
          matchStatus: 'not_evaluable',
          priority: 'low'
        }
      },
      {
        clientRequestId: 'strategy-output-ref-wrong-rule',
        outputRef: { ...canonicalOutputRef, ruleCode: 'WRONG-RULE' }
      },
      {
        clientRequestId: 'strategy-output-ref-wrong-status',
        outputRef: { ...canonicalOutputRef, matchStatus: 'not_evaluable' }
      },
      {
        clientRequestId: 'strategy-output-ref-wrong-priority',
        outputRef: { ...canonicalOutputRef, priority: 'urgent' }
      },
      {
        clientRequestId: 'strategy-output-ref-missing-priority',
        outputRef: {
          ruleCode: canonicalOutputRef.ruleCode,
          matchStatus: canonicalOutputRef.matchStatus
        }
      },
      {
        clientRequestId: 'strategy-output-ref-missing-rule-code',
        outputRef: {
          matchStatus: canonicalOutputRef.matchStatus,
          priority: canonicalOutputRef.priority
        }
      },
      {
        clientRequestId: 'strategy-output-ref-missing-match-status',
        outputRef: {
          ruleCode: canonicalOutputRef.ruleCode,
          priority: canonicalOutputRef.priority
        }
      },
      {
        clientRequestId: 'strategy-output-ref-extra-field',
        outputRef: { ...canonicalOutputRef, evidence: ['forged-evidence'] }
      }
    ];
    outputRefTamperCases.forEach((testCase) => {
      const businessCountsBefore = readStrategyWriteCounts(db);
      const actionCountsBefore = readStrategyActionWriteCounts(db);
      strategyLifecycleHarness.withDatabase((harnessDb) => {
        harnessDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
          WHERE action_run_id = ? AND output_entity_id = ?`).run(
          JSON.stringify(testCase.outputRef),
          preview.actionRunId,
          completedOutputRow.outputEntityId
        );
      });
      try {
        const blockedPreview = assertBlockedPreview(
          db,
          run,
          testCase.clientRequestId,
          'DEMO_STRATEGY_RELATION_CLOSURE_INVALID'
        );
        assert.deepStrictEqual(readStrategyWriteCounts(db), businessCountsBefore);
        assert.deepStrictEqual(readStrategyActionWriteCounts(db), {
          ...actionCountsBefore,
          actionRuns: actionCountsBefore.actionRuns + 1,
          blockedActions: actionCountsBefore.blockedActions + 1,
          previewAudits: actionCountsBefore.previewAudits + 1
        });
        assert.deepStrictEqual(
          readStrategyActionWitness(db, preview.actionRunId).action,
          completedActionWitness.action
        );
        assert.strictEqual(
          readStrategyActionWitness(db, preview.actionRunId).outputs.length,
          completedActionWitness.outputs.length
        );
        const countsBeforeBlockedExecute = readStrategyActionWriteCounts(db);
        assert.throws(
          () => strategyExecute(db, blockedPreview, testCase.clientRequestId),
          (error) => error.code === 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID'
        );
        assert.deepStrictEqual(readStrategyWriteCounts(db), businessCountsBefore);
        assert.deepStrictEqual(
          readStrategyActionWriteCounts(db),
          countsBeforeBlockedExecute
        );
        assert.deepStrictEqual(
          readStrategyActionWitness(db, preview.actionRunId).action,
          completedActionWitness.action
        );
      } finally {
        strategyLifecycleHarness.withDatabase((harnessDb) => {
          harnessDb.prepare(`UPDATE demo_post_action_outputs SET output_ref_json = ?
            WHERE action_run_id = ? AND output_entity_id = ?`).run(
            completedOutputRow.outputRefJson,
            preview.actionRunId,
            completedOutputRow.outputEntityId
          );
        });
      }
      assert.deepStrictEqual(
        readStrategyActionWitness(db, preview.actionRunId),
        completedActionWitness
      );
    });

    // 手工改写 action 状态只证明 fail-closed 的状态冲突，不作为真实 CAS race 证据。
    strategyLifecycleHarness.withDatabase((harnessDb) => {
      harnessDb.prepare(`UPDATE demo_post_action_runs SET status = 'executing', result_digest = NULL,
        result_json = NULL, failure_reason = NULL, completed_at = NULL, updated_at = ?
        WHERE action_run_id = ?`).run(new Date().toISOString(), preview.actionRunId);
    });
    try {
      assertBlockedPreview(
        db,
        run,
        'strategy-derived-executing-action',
        'DEMO_STRATEGY_RELATION_CLOSURE_INVALID'
      );
    } finally {
      strategyLifecycleHarness.withDatabase((harnessDb) => {
        harnessDb.prepare(`UPDATE demo_post_action_runs SET status = 'succeeded', result_digest = ?,
          result_json = ?, failure_reason = NULL, completed_at = ?, updated_at = ?
          WHERE action_run_id = ?`).run(
          completedActionRow.resultDigest,
          completedActionRow.resultJson,
          completedActionRow.completedAt,
          new Date().toISOString(),
          preview.actionRunId
        );
      });
    }

    strategyLifecycleHarness.withDatabase((harnessDb) => {
      harnessDb.prepare(`UPDATE demo_post_action_runs SET status = 'failed', result_digest = NULL,
        result_json = NULL, failure_reason = 'TEST_DERIVED_ACTION_FAILED', updated_at = ?
        WHERE action_run_id = ?`).run(new Date().toISOString(), preview.actionRunId);
    });
    try {
      assertBlockedPreview(
        db,
        run,
        'strategy-derived-failed-action',
        'DEMO_STRATEGY_RELATION_CLOSURE_INVALID'
      );
    } finally {
      strategyLifecycleHarness.withDatabase((harnessDb) => {
        harnessDb.prepare(`UPDATE demo_post_action_runs SET status = 'succeeded', result_digest = ?,
          result_json = ?, failure_reason = NULL, completed_at = ?, updated_at = ?
          WHERE action_run_id = ?`).run(
          completedActionRow.resultDigest,
          completedActionRow.resultJson,
          completedActionRow.completedAt,
          new Date().toISOString(),
          preview.actionRunId
        );
      });
    }

    // completed 领域记录及 derived 闭包缺少 action/output witness 时必须视为孤立证据。
    strategyLifecycleHarness.withDatabase((harnessDb) => {
      harnessDb.prepare('DELETE FROM demo_post_action_outputs WHERE action_run_id = ?').run(preview.actionRunId);
    });
    try {
      assertBlockedPreview(
        db,
        run,
        'strategy-derived-orphan-action',
        'DEMO_STRATEGY_RELATION_CLOSURE_INVALID'
      );
    } finally {
      strategyLifecycleHarness.withDatabase((harnessDb) => {
        harnessDb.prepare(`INSERT INTO demo_post_action_outputs
          (action_run_id, output_entity_type, output_entity_id, output_ref_json, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(
          preview.actionRunId,
          completedOutputRow.outputEntityType,
          completedOutputRow.outputEntityId,
          completedOutputRow.outputRefJson,
          completedOutputRow.createdAt
        );
      });
    }

    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId, derivedHitRegistry.registryId, postExecuteFirstTimeseriesRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-derived-extra-relation', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations
      WHERE run_id = ? AND from_registry_id = ? AND to_registry_id = ? AND relation_type = 'contains'`).run(
      run.runId, derivedHitRegistry.registryId, postExecuteFirstTimeseriesRegistryId
    );

    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'generated_from')`).run(
      run.runId, postExecuteFirstTimeseriesRegistryId, derivedHitRegistry.registryId
    );
    assertBlockedPreview(db, run, 'strategy-derived-wrong-direction', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations
      WHERE run_id = ? AND from_registry_id = ? AND to_registry_id = ? AND relation_type = 'generated_from'`).run(
      run.runId, postExecuteFirstTimeseriesRegistryId, derivedHitRegistry.registryId
    );

    const legacyClaimRunId = 'strategy-legacy-closure-claim';
    db.prepare(`INSERT INTO demo_legacy_claim_runs
      (claim_run_id, dataset_id, evidence_digest, plan_digest, preview_expires_at, status)
      VALUES (?, ?, ?, ?, ?, 'previewed')`).run(
      legacyClaimRunId, run.datasetId, 'd'.repeat(64), 'e'.repeat(64), '2026-08-30T00:00:00.000Z'
    );
    const legacyRegistry = db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
       snapshot_digest, source_batch_id, source_row_number, legacy_claim_run_id, registered_by)
      VALUES (?, '12-prediction-configs', 'prediction_config', 'legacy-closure-config', 'legacy_claimed',
        ?, ?, NULL, NULL, ?, 1)`).run(
      run.runId, 'f'.repeat(64), '1'.repeat(64), legacyClaimRunId
    );
    const legacyRegistryPk = Number(legacyRegistry.lastInsertRowid);
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, legacyRegistryPk, postExecuteRuleRegistryId
    );
    assertBlockedPreview(db, run, 'strategy-legacy-relation', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE from_registry_id = ?`).run(legacyRegistryPk);
    db.prepare('DELETE FROM demo_data_registry WHERE registry_id = ?').run(legacyRegistryPk);
    db.prepare('DELETE FROM demo_legacy_claim_runs WHERE claim_run_id = ?').run(legacyClaimRunId);

    // 关闭 FK 仅构造不可由正式 registrar 产生的孤儿/跨 run 证据，验证 adapter 不静默忽略。
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      run.runId, postExecuteFirstTimeseriesRegistryId, postExecuteRuleRegistryId
    );
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, 999999, 'uses_config')`).run(
      run.runId, postExecuteFirstTimeseriesRegistryId
    );
    db.pragma('foreign_keys = ON');
    assertBlockedPreview(db, run, 'strategy-orphan-relation', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
      AND to_registry_id = 999999`).run(run.runId, postExecuteFirstTimeseriesRegistryId);

    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES ('strategy-cross-run', ?, ?, 'uses_config')`).run(
      postExecuteFirstTimeseriesRegistryId, postExecuteRuleRegistryId
    );
    db.pragma('foreign_keys = ON');
    assertBlockedPreview(db, run, 'strategy-cross-run-relation', 'DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    db.prepare(`DELETE FROM demo_data_relations WHERE run_id = 'strategy-cross-run'
      AND from_registry_id = ? AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
      postExecuteFirstTimeseriesRegistryId, postExecuteRuleRegistryId
    );
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId, postExecuteFirstTimeseriesRegistryId, postExecuteRuleRegistryId
    );

    const replayExecute = strategyExecute(db, preview, 'strategy-preview-1');
    assert.strictEqual(replayExecute.status, 'succeeded');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute'").get().count, 1);

    const status = getDemoPostActionStatus({ actionRunId: preview.actionRunId, actorUserId: 1, db });
    assert.strictEqual(status.status, 'succeeded');
    assert.strictEqual(status.outputCount, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(status.input, 'privateContext'), false);
    const publicStatusJson = JSON.stringify(status);
    ['evaluationRunId', 'registryId', 'privateContext', 'exactScope', 'registrationScope',
      'completionWitness', 'registrarReceipt', 'contextId', 'importBatchId'].forEach(
      (privateField) => assert.strictEqual(publicStatusJson.includes(privateField), false)
    );
    const actionAuditJson = JSON.stringify(db.prepare(`SELECT detail_json AS detailJson
      FROM sys_operation_logs WHERE target_type = 'demo_post_action_run' AND target_id = ?`).all(preview.actionRunId));
    ['privateContext', 'exactScope', 'registrationScope', 'completionWitness', 'registrarReceipt'].forEach(
      (privateField) => assert.strictEqual(actionAuditJson.includes(privateField), false)
    );

    const casPreview = strategyPreview(db, run, 'strategy-cas-conflict');
    assert.strictEqual(casPreview.status, 'previewed', JSON.stringify(casPreview));
    const casCountsBefore = readStrategyWriteCounts(db);
    db.prepare("UPDATE demo_post_action_runs SET status = 'executing', started_at = ?, updated_at = ? WHERE action_run_id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), casPreview.actionRunId);
    assert.throws(() => strategyExecute(db, casPreview, 'strategy-cas-conflict'),
      (error) => error.code === 'DEMO_POST_ACTION_CLAIM_CONFLICT');
    assert.deepStrictEqual(readStrategyWriteCounts(db), casCountsBefore);
    db.prepare("UPDATE demo_post_action_runs SET status = 'failed', failure_reason = 'TEST_CAS_CONFLICT', completed_at = ?, updated_at = ? WHERE action_run_id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), casPreview.actionRunId);

    const rollbackPreview = strategyPreview(db, run, 'strategy-output-rollback');
    assert.strictEqual(rollbackPreview.status, 'previewed');
    const rollbackCountsBefore = readStrategyWriteCounts(db);
    db.exec(`CREATE TRIGGER strategy_output_failure_for_test
      BEFORE INSERT ON demo_post_action_outputs
      WHEN NEW.action_run_id = '${rollbackPreview.actionRunId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced strategy output rollback');
      END`);
    let rollbackResult;
    try {
      rollbackResult = strategyExecute(db, rollbackPreview, 'strategy-output-rollback');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS strategy_output_failure_for_test');
    }
    assert.strictEqual(rollbackResult.status, 'failed');
    assert.strictEqual(rollbackResult.outputCount, 0);
    assert.deepStrictEqual(readStrategyWriteCounts(db), rollbackCountsBefore);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs WHERE action_run_id = ?').get(rollbackPreview.actionRunId).count, 0);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE target_id = ? AND operation = 'system.demo.post-action.execute'").get(rollbackPreview.actionRunId).count, 1);

    const ownershipSummary = getDemoOwnershipSummary({ runId: run.runId, db });
    assert.strictEqual(ownershipSummary.derivedOwnershipConnected, false);
    assert(ownershipSummary.cleanupBlockerCount > 0);
  } finally {
    if (strategyLifecycleHarness) strategyLifecycleHarness.close();
    db.close();
  }
  console.log('demoPostActionStrategyEvaluation.test.js passed');
}

try {
  runTest();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
