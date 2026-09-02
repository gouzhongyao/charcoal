'use strict';

const demoTestBootstrap = require('./helpers/demoServiceTestHarness');
if (!demoTestBootstrap.fixedIsolatedChild && module.parent) {
  throw new Error('Demo ownership 固定测试入口不允许被普通模块间接加载。');
}
const { runFixedDemoOwnershipTest } = demoTestBootstrap;
// private registration contract 仅注入隔离子进程中的当前固定测试 Module。
const fixedDemoTestResult = runFixedDemoOwnershipTest('demo-ownership-registration');
if (fixedDemoTestResult.delegated) process.exit(0);

const assert = require('assert');
const Module = require('module');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本测试只使用隔离临时目录，不读取或修改项目真实 data、uploads 与 backups。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-ownership-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-ownership.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { getDatabaseAdmissionState, initDatabase, openDatabase } = require('../db/database');
const {
  bindDemoContextPreviewInTransaction,
  createDemoContext
} = require('../services/demoContextService');
const demoOwnershipService = require('../services/demoOwnershipService');
const {
  DEMO_CLEANUP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
  buildDemoOwnershipPlan,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  createDemoOwnershipInsertWitness,
  issueStrategyEvaluationRegistrationScopeInTransaction,
  registerImportedDemoOwnershipInTransaction,
  runWithDemoOwnershipTransaction
} = require('../services/demoOwnershipService');
const { createDemoOwnershipTestHarness } = require('./helpers/demoServiceTestHarness');
// ownership 私有纯逻辑仅从明确 test-only harness 获取，production exports 保持无测试控制面。
const ownershipTest = createDemoOwnershipTestHarness();
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const energyStrategyEvaluationService = require('../services/energyStrategyEvaluationService');
const {
  buildEnergyStrategyExactScope,
  runEnergyStrategyEvaluation,
  updateStrategyRuleHitStatus
} = energyStrategyEvaluationService;
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const strategyOwnershipProtocol = require('../services/energyStrategyOwnershipProtocol');
const {
  buildPredictionConfidenceFacts,
  formatPredictionForecastMethodNote
} = require('../services/predictionUtils');

const UPLOAD_FILE_SHA256 = 'b'.repeat(64);
const PREVIEW_DIGEST = `hmac-sha256:v1:audit:${'c'.repeat(64)}`;

// 测试 helper 仅在 runWithDemoOwnershipTransaction 同步 callback 内暴露当前私有 scope/facade。
let activeTestTransactionScope = null;
let activeTestDatabaseFacade = null;

/** 在事务 callback 内取得私有 facade，callback 外回退到外部连接。 */
function getTestDatabase(externalDb) {
  return activeTestDatabaseFacade || externalDb;
}

/** 使用 ownership 私有 scope 执行立即事务，错误时整体回滚并失效全部 witness。 */
function runImmediateTransaction(db, callback) {
  return runWithDemoOwnershipTransaction(db, (transactionScope, databaseFacade) => {
    activeTestTransactionScope = transactionScope;
    activeTestDatabaseFacade = databaseFacade;
    try {
      return callback(databaseFacade, transactionScope);
    } finally {
      activeTestDatabaseFacade = null;
      activeTestTransactionScope = null;
    }
  });
}

/** 仅用于验证 demo registration 缺少 ownership scope 时 fail-closed。 */
function runRawImmediateTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 插入隔离导入批次并返回正整数主键。 */
function insertImportBatch(db, importType, filename) {
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, audit_phase, total_rows)
    VALUES (?, ?, 'xlsx', 'completed', 'preview', 3)`).run(importType, filename).lastInsertRowid);
}

/** 创建、预演并持久绑定一组演示 context 批次角色。 */
function createPreviewedContext(db, input) {
  const context = createDemoContext({
    db,
    userId: input.userId,
    runId: input.runId,
    artifactKey: input.artifactKey,
    handlerKey: input.handlerKey,
    artifactFileSha256: UPLOAD_FILE_SHA256
  });
  runRawImmediateTransaction(db, () => bindDemoContextPreviewInTransaction({
    db,
    token: context.token,
    userId: input.userId,
    artifactKey: input.artifactKey,
    handlerKey: input.handlerKey,
    uploadFileSha256: UPLOAD_FILE_SHA256,
    previewDigest: PREVIEW_DIGEST,
    batchBindings: input.batchBindings
  }));
  return {
    token: context.token,
    userId: input.userId,
    contextId: context.contextId,
    runId: context.runId,
    datasetId: context.datasetId,
    manifestVersion: context.manifestVersion,
    manifestDigest: context.manifestDigest,
    artifactKey: input.artifactKey,
    handlerKey: input.handlerKey,
    uploadFileSha256: UPLOAD_FILE_SHA256,
    previewDigest: PREVIEW_DIGEST
  };
}

/** 构造 imported ownership 公共登记的稳定基础输入。 */
function buildOwnershipInput(_externalDb, actorUserId, demoContext, batchBindings, overrides = {}) {
  return {
    actorUserId,
    demoContext,
    batchBindings,
    transactionScope: activeTestTransactionScope,
    insertedRecords: [],
    noInsertedRecords: true,
    skippedRecords: [],
    relations: [],
    ...overrides
  };
}

/** 在服务端声明式插入包装器内写入通用 Artifact 18 策略规则 fixture。 */
function insertStrategyFixtureWithWitness(_externalDb, input) {
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope: activeTestTransactionScope,
    entityType: 'strategy_rule',
    sourceBatchId: input.batchId,
    sourceRowNumber: input.sourceRowNumber,
    insertSql: `INSERT INTO strategy_rules
      (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
        metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
        evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
        source_timezone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ownership-fixture:v1', 'load-analysis:v1', 'load_rate', 'gte', 80, '%',
        0.1, 'high', ?, '人工复核策略建议。', 'ownership test', '2026-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active', ?, ?)`,
    insertParams: [
      input.actualBatchId === undefined ? input.batchId : input.actualBatchId,
      input.actualSourceRowNumber === undefined ? input.sourceRowNumber : input.actualSourceRowNumber,
      `OWNERSHIP-FIXTURE-${input.sourceRowNumber}-${input.name}`,
      input.name,
      JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
      input.createdAt || '2026-08-27T00:00:00.000Z',
      input.updatedAt || '2026-08-27T00:00:00.000Z'
    ]
  });
  return {
    entityType: 'strategy_rule',
    entityPk: rowWitness.lastInsertRowid,
    batchRole: 'primary',
    sourceRowNumber: input.sourceRowNumber,
    rowWitness
  };
}

/** 在 ownership 私有事务内写入最小真实 artifact 15 时序记录。 */
function insertEnergyTimeseriesWithWitness(input) {
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope: activeTestTransactionScope,
    entityType: 'energy_timeseries',
    sourceBatchId: input.batchId,
    sourceRowNumber: input.sourceRowNumber,
    insertSql: `INSERT INTO energy_timeseries_records
      (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
       start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
       normalized_unit, normalized_value, source_reference, data_source, record_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', ?, 'kWh', ?, ?, 'upload', 'active', ?, ?)`,
    insertParams: [
      input.batchId,
      input.sourceRowNumber,
      input.organizationUnitId,
      input.meterDeviceId,
      input.energyTypeId,
      input.startUtc,
      input.endUtc,
      input.value,
      input.value,
      input.reference,
      '2026-08-29T00:00:00.000Z',
      '2026-08-29T00:00:00.000Z'
    ]
  });
  return {
    entityType: 'energy_timeseries',
    entityPk: rowWitness.lastInsertRowid,
    batchRole: 'primary',
    sourceRowNumber: input.sourceRowNumber,
    rowWitness
  };
}

/** 在 ownership 私有事务内写入最小真实 artifact 18 策略规则。 */
function insertStrategyRuleWithWitness(input) {
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope: activeTestTransactionScope,
    entityType: 'strategy_rule',
    sourceBatchId: input.batchId,
    sourceRowNumber: input.sourceRowNumber,
    insertSql: `INSERT INTO strategy_rules
      (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
       metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
       evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
       source_timezone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'strategy-rule:v1', 'load-analysis:v1', 'load_rate', 'gte', 80, '%', 0.1, 'high',
        ?, '人工复核策略建议。', 'ownership test', '2026-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active', ?, ?)`,
    insertParams: [
      input.batchId,
      input.sourceRowNumber,
      input.ruleCode,
      input.ruleName,
      JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
      '2026-08-29T00:00:00.000Z',
      '2026-08-29T00:00:00.000Z'
    ]
  });
  return {
    entityType: 'strategy_rule',
    entityPk: rowWitness.lastInsertRowid,
    batchRole: 'primary',
    sourceRowNumber: input.sourceRowNumber,
    rowWitness
  };
}

/** 断言回调抛出指定稳定错误编码。 */
function assertErrorCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.strictEqual(error.details?.code || error.code, code);
    return true;
  });
}

/** 在隔离 Node 子进程内验证模块初始化窗口，不污染当前测试进程的私有协议状态。 */
function runNodeSecurityProbe(script, label) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, `${label} 失败：${result.stderr || result.stdout}`);
}

/** 构造正式 evaluator 形态的策略命中 evidence_json 测试值。 */
function createStrategyEvidenceSnapshot(
  dataStartUtc,
  dataEndUtc,
  sourceTimeZone,
  evidenceReference = 'timeseries:1',
  effectiveRange = null
) {
  return JSON.stringify({
    evidence: [
      `window:${dataStartUtc}/${dataEndUtc}`,
      'meter:1',
      `scope:energy-type=electricity;unit=kWh;source-timezone=${sourceTimeZone}`,
      'metric:load_rate',
      'record-count:1',
      `data-summary-sha256:${'a'.repeat(64)}`,
      `evaluation-sha256:${'b'.repeat(64)}`,
      evidenceReference
    ],
    evidencePolicy: {
      maxEvidenceItemsSemantics: 'timeseries_detail_limit_only',
      requiredEvidenceCount: 7,
      detailEvidenceLimit: 10,
      availableDetailEvidenceCount: 1,
      returnedDetailEvidenceCount: 1,
      detailEvidenceTruncated: false
    },
    dataSummaryDigest: `sha256:${'a'.repeat(64)}`,
    evaluationDigest: `sha256:${'b'.repeat(64)}`,
    configurationErrors: [],
    recommendation: '人工复核后执行节能建议。',
    source: 'test',
    effectiveRange: effectiveRange || {
      startUtc: dataStartUtc,
      endUtc: dataEndUtc,
      sourceTimeZone
    },
    evidenceRequirements: {
      minimumCoverageRate: 0,
      maxEvidenceItems: 10,
      savingBasis: 'window_total_energy'
    },
    automationBoundary: {
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      requiresManualReview: true
    }
  });
}

/** 构造策略运行和命中静态 projection 的合法测试行。 */
function createStrategyDerivedProjectionRows() {
  const runRow = {
    id: 101,
    run_code: 'strategy-derived-handler-101',
    scope_type: 'meter_device',
    scope_reference: '{"energyTypeCode":"electricity","meterDeviceId":1,"sourceTimeZone":"Asia/Shanghai","unit":"kWh"}',
    start_utc: '2026-08-01T00:00:00.000Z',
    end_utc: '2026-08-01T01:00:00.000Z',
    source_timezone: 'Asia/Shanghai',
    formula_version: 'load-analysis:v1',
    status: 'completed',
    reason_codes_json: null,
    started_at: '2026-08-28T00:00:00.000Z',
    completed_at: '2026-08-28T00:00:01.000Z',
    error_message: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:01.000Z'
  };
  const hitRow = {
    id: 201,
    evaluation_run_id: 101,
    strategy_rule_id: 301,
    match_status: 'matched',
    manual_status: 'unconfirmed',
    actual_value: 12,
    threshold_snapshot_json: '{"operator":"gt","unit":"%","value":10,"reductionRate":0.1}',
    evidence_json: createStrategyEvidenceSnapshot(
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T01:00:00.000Z',
      'Asia/Shanghai'
    ),
    reason_codes_json: null,
    coverage_rate: 1,
    priority: 'high',
    estimated_saving: 1.2,
    estimated_saving_unit: 'kWh',
    data_start_utc: '2026-08-01T00:00:00.000Z',
    data_end_utc: '2026-08-01T01:00:00.000Z',
    source_timezone: 'Asia/Shanghai',
    reviewed_at: null,
    review_note: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z'
  };
  return { runRow, hitRow };
}

/** 验证 Prediction run/result handler 的固定字段、数值、月份、单位和算法文案合同。 */
function testPredictionDerivedOwnershipHandlers() {
  const parameters = {
    algorithm: 'moving_average',
    windowSize: 3,
    filters: {
      energyTypeCode: 'electricity',
      organizationUnitCode: 'PRED-UNIT',
      organizationUnitId: 11,
      meterCode: 'PRED-METER',
      meterDeviceId: 12,
      sourceBatchId: 13
    },
    trainMonths: ['2026-01', '2026-02', '2026-03'],
    predictionMonths: ['2026-04', '2026-05'],
    requiredHistoryMonths: 3,
    configSnapshot: {
      configId: 14,
      config: {
        name: '固定配置',
        note: '固定配置备注',
        energyTypeCode: 'electricity',
        organizationUnitId: 11,
        organizationUnitCode: 'PRED-UNIT',
        meterDeviceId: 12,
        meterCode: 'PRED-METER',
        sourceBatchId: 13,
        trainStartMonth: '2026-01',
        trainEndMonth: '2026-03',
        predictStartMonth: '2026-04',
        predictEndMonth: '2026-05',
        algorithm: 'moving_average',
        windowSize: 3
      }
    },
    warnings: []
  };
  const runRow = {
    id: 301,
    name: 'Prediction ownership 固定运行',
    algorithm: 'moving_average',
    status: 'completed',
    target_energy_type_id: 1,
    train_start_month: '2026-01',
    train_end_month: '2026-03',
    predict_start_month: '2026-04',
    predict_end_month: '2026-05',
    parameters_json: JSON.stringify(parameters),
    created_at: '2026-08-30T00:00:00.000Z',
    completed_at: '2026-08-30T00:00:01.000Z',
    note: '预测完成：生成 2 条结果。'
  };
  const resultRow = {
    id: 401,
    prediction_run_id: 301,
    energy_type_id: 1,
    target_month: '2026-04',
    predicted_value: 12.5,
    predicted_unit: 'kWh',
    confidence_low: 11.25,
    confidence_high: 13.75,
    method_note: '轻量移动平均：使用最近 3 个历史/预测月份滚动平均；confidenceLevel=low，仅作趋势参考。 能源类型=electricity，单位=kWh。',
    created_at: '2026-08-30T00:00:01.000Z'
  };
  assert.deepStrictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.prediction_run.projectionFields, [
    'id', 'name', 'algorithm', 'status', 'target_energy_type_id',
    'train_start_month', 'train_end_month', 'predict_start_month', 'predict_end_month',
    'parameters_json', 'created_at', 'completed_at', 'note'
  ]);
  assert.deepStrictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.prediction_result.projectionFields, [
    'id', 'prediction_run_id', 'energy_type_id', 'target_month', 'predicted_value',
    'predicted_unit', 'confidence_low', 'confidence_high', 'method_note', 'created_at'
  ]);
  const runContract = ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id, row: runRow
  });
  const resultContract = ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id, row: resultRow
  });
  assert.strictEqual(runContract.snapshotDigest,
    calculateDemoEntitySnapshotDigest('prediction_run', runRow.id, runRow));
  assert.strictEqual(resultContract.snapshotDigest,
    calculateDemoEntitySnapshotDigest('prediction_result', resultRow.id, resultRow));
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: { ...runRow, status: 'running' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: { ...runRow, parameters_json: JSON.stringify({ ...parameters, windowSize: '3' }) }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: { ...runRow, predict_start_month: '2026-03' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: {
      ...runRow,
      parameters_json: JSON.stringify({
        ...parameters,
        trainMonths: ['2026-01', '2026-03']
      })
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, method_note: resultRow.method_note.replace('单位=kWh', '单位=m3') }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, predicted_value: '12.5' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, target_month: '2026-13' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, confidence_low: 13 }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, predicted_unit: '' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, method_note: '调用外部 AI 模型生成。' }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: {
      ...runRow,
      parameters_json: JSON.stringify({ ...parameters, forged: true })
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_run', entityPk: runRow.id,
    row: {
      ...runRow,
      parameters_json: JSON.stringify({ ...parameters, warnings: [true] })
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID');
  [Number.NaN, Number.POSITIVE_INFINITY].forEach((invalidNumber) => {
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_result', entityPk: resultRow.id,
      row: { ...resultRow, predicted_value: invalidNumber }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: Number.MAX_SAFE_INTEGER + 1,
    row: { ...resultRow, id: Number.MAX_SAFE_INTEGER + 1 }
  }), 'DEMO_OWNERSHIP_ENTITY_PK_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, predicted_value: 12.1234567 }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: { ...resultRow, confidence_high: 13.751 }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: {
      ...resultRow,
      method_note: resultRow.method_note.replace('最近 3 个', '最近 13 个')
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

  const linearConfidence = buildPredictionConfidenceFacts('linear_trend', 0);
  const linearMethodNote = formatPredictionForecastMethodNote({
    algorithm: 'linear_trend',
    windowSize: null,
    sampleCount: 4,
    signedSlope: -50.123456,
    clampedToZero: true
  }, {
    energyTypeCode: 'electricity',
    canonicalUnit: 'kWh'
  });
  const linearResultRow = {
    ...resultRow,
    id: 402,
    target_month: '2026-05',
    predicted_value: 0,
    confidence_low: linearConfidence.confidenceLow,
    confidence_high: linearConfidence.confidenceHigh,
    method_note: linearMethodNote
  };
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: linearResultRow.id, row: linearResultRow
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: linearResultRow.id,
    row: {
      ...linearResultRow,
      method_note: linearMethodNote.replace('基于 4 个', '基于 2 个')
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: linearResultRow.id,
    row: {
      ...linearResultRow,
      method_note: linearMethodNote.replace('slope=-50.123456', 'slope=-50.1234567')
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
  const nonZeroLinearConfidence = buildPredictionConfidenceFacts('linear_trend', 12.5);
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'prediction_result', entityPk: resultRow.id,
    row: {
      ...resultRow,
      confidence_low: nonZeroLinearConfidence.confidenceLow,
      confidence_high: nonZeroLinearConfidence.confidenceHigh,
      method_note: formatPredictionForecastMethodNote({
        algorithm: 'linear_trend',
        windowSize: null,
        sampleCount: 4,
        signedSlope: -50,
        clampedToZero: true
      }, {
        energyTypeCode: 'electricity',
        canonicalUnit: 'kWh'
      })
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
}

/** 验证 strategy run/hit handler 的固定字段、摘要稳定性和严格嵌套合同。 */
function testStrategyDerivedOwnershipHandlers() {
  const { runRow, hitRow } = createStrategyDerivedProjectionRows();
  assert.deepStrictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_evaluation_run.projectionFields, [
    'id', 'run_code', 'scope_type', 'scope_reference', 'start_utc', 'end_utc',
    'source_timezone', 'formula_version', 'status', 'reason_codes_json', 'started_at',
    'completed_at', 'error_message', 'created_at', 'updated_at'
  ]);
  assert.deepStrictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.projectionFields, [
    'id', 'evaluation_run_id', 'strategy_rule_id', 'match_status', 'manual_status',
    'actual_value', 'threshold_snapshot_json', 'evidence_json', 'reason_codes_json',
    'coverage_rate', 'priority', 'estimated_saving', 'estimated_saving_unit',
    'data_start_utc', 'data_end_utc', 'source_timezone', 'reviewed_at', 'review_note',
    'created_at', 'updated_at'
  ]);
  const runContract = ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: runRow.id, row: runRow
  });
  const hitContract = ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: hitRow.id, row: hitRow
  });
  assert.strictEqual(runContract.snapshotDigest, calculateDemoEntitySnapshotDigest('strategy_evaluation_run', '101', runRow));
  assert.strictEqual(hitContract.snapshotDigest, calculateDemoEntitySnapshotDigest('strategy_rule_hit', '201', hitRow));
  assert.strictEqual(runContract.snapshotDigest, ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: 101, row: { ...runRow }
  }).snapshotDigest);
  assert.strictEqual(hitContract.snapshotDigest, ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: 201, row: { ...hitRow }
  }).snapshotDigest);

  // 五种 schema 状态均按固定时间、错误和原因字段矩阵验证。
  const validRunRows = [
    { ...runRow, status: 'pending', reason_codes_json: null, started_at: null, completed_at: null, error_message: null },
    { ...runRow, status: 'running', reason_codes_json: null, completed_at: null, error_message: null },
    { ...runRow, status: 'completed', reason_codes_json: '["NO_TIMESERIES_DATA"]', error_message: null },
    { ...runRow, status: 'failed', reason_codes_json: null, error_message: '评价执行失败' },
    { ...runRow, status: 'cancelled', reason_codes_json: null, started_at: null, error_message: null }
  ];
  validRunRows.forEach((row) => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: row.id, row
  }));
  const notEvaluableHit = {
    ...hitRow,
    match_status: 'not_evaluable',
    actual_value: null,
    reason_codes_json: '["NO_TIMESERIES_DATA"]',
    estimated_saving: null,
    estimated_saving_unit: null
  };
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: notEvaluableHit.id, row: notEvaluableHit
  });

  // 五种正式阈值 operator 均覆盖 matched/not_matched，并验证 accepted 人工状态的合法组合。
  const operatorCases = [
    { operator: 'gt', value: 12, threshold: { value: 10 }, matched: true },
    { operator: 'gt', value: 10, threshold: { value: 10 }, matched: false },
    { operator: 'gte', value: 10, threshold: { value: 10 }, matched: true },
    { operator: 'gte', value: 9, threshold: { value: 10 }, matched: false },
    { operator: 'lt', value: 9, threshold: { value: 10 }, matched: true },
    { operator: 'lt', value: 10, threshold: { value: 10 }, matched: false },
    { operator: 'lte', value: 10, threshold: { value: 10 }, matched: true },
    { operator: 'lte', value: 11, threshold: { value: 10 }, matched: false },
    { operator: 'between', value: 10, threshold: { min: 10, max: 20 }, matched: true },
    { operator: 'between', value: 21, threshold: { min: 10, max: 20 }, matched: false }
  ];
  operatorCases.forEach((testCase, index) => {
    const row = {
      ...hitRow,
      id: hitRow.id + index + 1,
      match_status: testCase.matched ? 'matched' : 'not_matched',
      manual_status: 'accepted',
      actual_value: testCase.value,
      threshold_snapshot_json: JSON.stringify({
        operator: testCase.operator,
        unit: '%',
        ...testCase.threshold,
        reductionRate: 0.1
      }),
      estimated_saving: testCase.matched ? 1.2 : null,
      estimated_saving_unit: testCase.matched ? 'kWh' : null,
      reviewed_at: '2026-08-28T00:00:02.000Z',
      review_note: null
    };
    ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule_hit', entityPk: row.id, row
    });
  });

  // scope_reference、阈值、证据和原因码均拒绝额外、缺失、错误形态和值域。
  const scope = JSON.parse(runRow.scope_reference);
  const threshold = JSON.parse(hitRow.threshold_snapshot_json);
  const evidence = JSON.parse(hitRow.evidence_json);

  // 配置错误、evidenceRequirements 以及 peak mandatory evidence 保持正式 evaluator 的真实生成关系。
  const thresholdMismatchEvidence = {
    ...evidence,
    configurationErrors: ['STRATEGY_THRESHOLD_UNIT_MISMATCH']
  };
  const requirementErrorEvidence = {
    ...evidence,
    configurationErrors: ['INVALID_EVIDENCE_REQUIREMENTS_JSON'],
    evidenceRequirements: null
  };
  const unsupportedMetricEvidence = {
    ...evidence,
    evidence: [
      ...evidence.evidence.slice(0, 3),
      'metric:dynamic_function_name',
      ...evidence.evidence.slice(4)
    ],
    configurationErrors: ['UNSUPPORTED_STRATEGY_METRIC']
  };
  const peakWithoutIntervalEvidence = {
    ...evidence,
    evidence: [
      ...evidence.evidence.slice(0, 3),
      'metric:peak_interval_energy',
      ...evidence.evidence.slice(4, 7)
    ],
    evidencePolicy: {
      ...evidence.evidencePolicy,
      requiredEvidenceCount: 7,
      availableDetailEvidenceCount: 0,
      returnedDetailEvidenceCount: 0
    }
  };
  const peakWithIntervalEvidence = {
    ...evidence,
    evidence: [
      ...evidence.evidence.slice(0, 3),
      'metric:peak_interval_energy',
      ...evidence.evidence.slice(4, 7),
      'peak-interval:2026-08-01T00:00:00.000Z/2026-08-01T00:15:00.000Z',
      evidence.evidence[7]
    ],
    evidencePolicy: {
      ...evidence.evidencePolicy,
      requiredEvidenceCount: 8
    }
  };
  // 无效 JSON 采用正式默认上限 10，返回数量必须是 min(available, limit)。
  const defaultDetailEvidence = Array.from({ length: 10 }, (_, index) => `timeseries:${index + 1}`)
    .sort((left, right) => left.localeCompare(right));
  const forcedDefaultEvidence = {
    ...requirementErrorEvidence,
    evidence: [
      ...requirementErrorEvidence.evidence.slice(0, 4),
      'record-count:11',
      ...requirementErrorEvidence.evidence.slice(5, 7),
      ...defaultDetailEvidence
    ],
    evidencePolicy: {
      ...requirementErrorEvidence.evidencePolicy,
      availableDetailEvidenceCount: 11,
      returnedDetailEvidenceCount: 10,
      detailEvidenceTruncated: true
    }
  };
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit',
    entityPk: notEvaluableHit.id + 50,
    row: {
      ...notEvaluableHit,
      id: notEvaluableHit.id + 50,
      evidence_json: JSON.stringify(forcedDefaultEvidence),
      reason_codes_json: '["UNIT_NOT_COMPARABLE"]'
    }
  });
  [
    {
      ...notEvaluableHit,
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh","value":10,"reductionRate":0.1}',
      evidence_json: JSON.stringify(thresholdMismatchEvidence),
      reason_codes_json: '["UNIT_NOT_COMPARABLE"]'
    },
    {
      ...notEvaluableHit,
      evidence_json: JSON.stringify(requirementErrorEvidence),
      reason_codes_json: '["UNIT_NOT_COMPARABLE"]'
    },
    {
      ...notEvaluableHit,
      evidence_json: JSON.stringify(unsupportedMetricEvidence),
      reason_codes_json: '["UNIT_NOT_COMPARABLE","NO_TIMESERIES_DATA"]'
    },
    {
      ...notEvaluableHit,
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh/15min","value":10}',
      evidence_json: JSON.stringify(peakWithoutIntervalEvidence)
    },
    {
      ...hitRow,
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh/15min","value":10,"reductionRate":0.1}',
      evidence_json: JSON.stringify(peakWithIntervalEvidence)
    }
  ].forEach((row) => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: row.id, row
  }));
  [
    { minutes: 15, endUtc: '2026-08-01T00:15:00.000Z' },
    { minutes: 30, endUtc: '2026-08-01T00:30:00.000Z' },
    { minutes: 60, endUtc: '2026-08-01T01:00:00.000Z' }
  ].forEach(({ minutes, endUtc }, index) => {
    const intervalEvidence = {
      ...evidence,
      evidence: [
        ...evidence.evidence.slice(0, 3),
        'metric:peak_interval_energy',
        ...evidence.evidence.slice(4, 7),
        `peak-interval:2026-08-01T00:00:00.000Z/${endUtc}`,
        evidence.evidence[7]
      ],
      evidencePolicy: { ...evidence.evidencePolicy, requiredEvidenceCount: 8 }
    };
    const intervalHit = {
      ...hitRow,
      id: hitRow.id + 100 + index,
      threshold_snapshot_json: JSON.stringify({
        operator: 'gt', value: 10, unit: `kWh/${minutes}min`, reductionRate: 0.1
      }),
      evidence_json: JSON.stringify(intervalEvidence)
    };
    ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule_hit', entityPk: intervalHit.id, row: intervalHit
    });
  });

  const invalidRows = [
    { entityType: 'strategy_evaluation_run', row: { ...runRow, scope_reference: JSON.stringify({ ...scope, extra: true }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, scope_reference: JSON.stringify({ meterDeviceId: 1, energyTypeCode: 'electricity', unit: 'kWh' }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, scope_reference: JSON.stringify({ ...scope, meterDeviceId: '1' }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, scope_reference: JSON.stringify({ ...scope, sourceTimeZone: 'UTC' }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, reason_codes_json: '{bad' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, reason_codes_json: '["UNKNOWN_REASON"]' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, reason_codes_json: '["NO_TIMESERIES_DATA","NO_TIMESERIES_DATA"]' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'unknown' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, start_utc: '2026-08-01 00:00:00' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'pending', started_at: runRow.started_at, completed_at: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'running', started_at: null, completed_at: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'running', completed_at: runRow.completed_at }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'completed', completed_at: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'completed', error_message: '不应存在' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'failed', error_message: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'failed', error_message: '失败', reason_codes_json: '["NO_TIMESERIES_DATA"]' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, status: 'cancelled', completed_at: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: { ...runRow, started_at: '2026-08-28T00:00:02.000Z' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: {
      ...runRow, status: 'running', created_at: '2026-08-28T00:00:02.000Z'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: {
      ...runRow, status: 'running', started_at: '2026-08-28T00:00:02.000Z'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: {
      ...runRow, status: 'completed', created_at: '2026-08-28T00:00:02.000Z'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: {
      ...runRow, status: 'completed', completed_at: '2026-08-28T00:00:02.000Z'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_evaluation_run', row: {
      ...runRow, status: 'completed', started_at: '2026-08-28T00:00:02.000Z', completed_at: '2026-08-28T00:00:01.000Z'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, threshold_snapshot_json: '[]' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, threshold_snapshot_json: JSON.stringify({ ...threshold, extra: true }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, threshold_snapshot_json: JSON.stringify({ operator: 'gt', unit: 'kWh' }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, threshold_snapshot_json: '{"operator":"gt","unit":"kWh","value":1e400}' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, threshold_snapshot_json: '{"operator":"between","min":20,"max":10,"unit":"kWh"}' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, extra: true }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, source: undefined }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, dataSummaryDigest: 'sha256:bad' }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, configurationErrors: ['UNKNOWN_CONFIGURATION_ERROR'] }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, evidencePolicy: { ...evidence.evidencePolicy, extra: true } }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, evidencePolicy: { ...evidence.evidencePolicy, detailEvidenceTruncated: true } }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, evidenceRequirements: { ...evidence.evidenceRequirements, maxEvidenceItems: 101 } }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, evidence_json: JSON.stringify({ ...evidence, automationBoundary: { ...evidence.automationBoundary, usesAI: true } }) }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [...evidence.evidence, evidence.evidence[7]],
        evidencePolicy: { ...evidence.evidencePolicy, availableDetailEvidenceCount: 2, returnedDetailEvidenceCount: 2 }
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [...evidence.evidence, 'timeseries:2']
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidencePolicy: { ...evidence.evidencePolicy, returnedDetailEvidenceCount: 0 }
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [
          ...evidence.evidence.slice(0, 4),
          'record-count:2',
          ...evidence.evidence.slice(5, 7),
          'timeseries:2',
          'timeseries:1'
        ],
        evidencePolicy: {
          ...evidence.evidencePolicy,
          availableDetailEvidenceCount: 2,
          returnedDetailEvidenceCount: 2
        }
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [evidence.evidence[1], evidence.evidence[0], ...evidence.evidence.slice(2)]
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [`window:2026-08-01T00:15:00.000Z/2026-08-01T01:00:00.000Z`, ...evidence.evidence.slice(1)]
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [evidence.evidence[0], evidence.evidence[1], 'scope:energy-type=electricity;unit=kWh;source-timezone=UTC', ...evidence.evidence.slice(3)]
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [...evidence.evidence.slice(0, 5), `data-summary-sha256:${'c'.repeat(64)}`, evidence.evidence[6], evidence.evidence[7]]
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [...evidence.evidence.slice(0, 7), 'rule:1']
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidence: [...evidence.evidence.slice(0, 7), 'timeseries:9007199254740992']
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({ ...evidence, evidenceRequirements: null })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        configurationErrors: ['INVALID_EVIDENCE_MAX_ITEMS']
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify({
        ...requirementErrorEvidence,
        evidencePolicy: {
          ...requirementErrorEvidence.evidencePolicy,
          detailEvidenceLimit: 9
        }
      }),
      reason_codes_json: '["UNIT_NOT_COMPARABLE"]'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        configurationErrors: ['STRATEGY_THRESHOLD_UNIT_MISMATCH', 'STRATEGY_THRESHOLD_UNIT_MISMATCH']
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, source_timezone: 'UTC' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, actual_value: 9 }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, match_status: 'not_matched' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      match_status: 'not_matched',
      actual_value: 12,
      estimated_saving: null,
      estimated_saving_unit: null
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({ ...evidence, configurationErrors: ['STRATEGY_THRESHOLD_UNIT_MISMATCH'] })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh","value":10}',
      evidence_json: JSON.stringify(thresholdMismatchEvidence),
      reason_codes_json: '["NO_TIMESERIES_DATA"]'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify({ ...unsupportedMetricEvidence, configurationErrors: [] }),
      reason_codes_json: '["UNIT_NOT_COMPARABLE","NO_TIMESERIES_DATA"]'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify({
        ...unsupportedMetricEvidence,
        configurationErrors: ['UNSUPPORTED_STRATEGY_METRIC', 'STRATEGY_THRESHOLD_UNIT_MISMATCH']
      }),
      reason_codes_json: '["UNIT_NOT_COMPARABLE","NO_TIMESERIES_DATA"]'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify(unsupportedMetricEvidence),
      actual_value: 12,
      estimated_saving: null,
      estimated_saving_unit: null
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify(unsupportedMetricEvidence),
      reason_codes_json: '["NO_TIMESERIES_DATA"]'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify({
        ...peakWithoutIntervalEvidence,
        configurationErrors: ['STRATEGY_METRIC_UNIT_UNAVAILABLE', 'STRATEGY_THRESHOLD_UNIT_MISMATCH']
      }),
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh/15min","value":10}'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...notEvaluableHit,
      evidence_json: JSON.stringify(peakWithoutIntervalEvidence),
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh/15min","value":10,"reductionRate":0.1}',
      estimated_saving: 1.2,
      estimated_saving_unit: 'kWh'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify(peakWithoutIntervalEvidence),
      threshold_snapshot_json: '{"operator":"gt","unit":"kWh/15min","value":10,"reductionRate":0.1}'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: createStrategyEvidenceSnapshot(
        hitRow.data_start_utc,
        hitRow.data_end_utc,
        hitRow.source_timezone,
        'timeseries:1',
        {
          startUtc: '2026-08-01T00:15:00.000Z',
          endUtc: '2026-08-01T01:00:00.000Z',
          sourceTimeZone: hitRow.source_timezone
        }
      )
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: createStrategyEvidenceSnapshot(
        hitRow.data_start_utc,
        hitRow.data_end_utc,
        hitRow.source_timezone,
        'timeseries:1',
        {
          startUtc: '2026-08-01T00:00:00.000Z',
          endUtc: '2026-08-01T00:45:00.000Z',
          sourceTimeZone: hitRow.source_timezone
        }
      )
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, match_status: 'matched', reason_codes_json: '["NO_TIMESERIES_DATA"]' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...notEvaluableHit, reason_codes_json: null }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, match_status: 'unknown' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, coverage_rate: 1.1 }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, match_status: 'not_evaluable' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      threshold_snapshot_json: '{"operator":"gt","unit":"%","value":10}',
      estimated_saving: 1.2,
      estimated_saving_unit: 'kWh'
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      coverage_rate: 0.5
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: {
      ...hitRow,
      evidence_json: JSON.stringify({
        ...evidence,
        evidenceRequirements: { ...evidence.evidenceRequirements, savingBasis: null }
      })
    }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, manual_status: 'rejected' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' },
    { entityType: 'strategy_rule_hit', row: { ...hitRow, data_start_utc: '2026-08-01T02:00:00.000Z' }, code: 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID' }
  ];
  invalidRows.forEach(({ entityType, row, code }) => assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType, entityPk: row.id, row
  }), code));

  // row 入口先拒绝 getter、setter 与 Proxy，且不得执行任何动态读取。
  let getterCalled = false;
  const getterRow = { ...runRow };
  Object.defineProperty(getterRow, 'run_code', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      return runRow.run_code;
    }
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: getterRow.id, row: getterRow
  }), 'DEMO_OWNERSHIP_SNAPSHOT_DYNAMIC_FIELD_INVALID');
  assert.strictEqual(getterCalled, false, '业务 row getter 不得执行');

  let setterCalled = false;
  const setterRow = { ...runRow };
  Object.defineProperty(setterRow, 'run_code', {
    enumerable: true,
    configurable: true,
    set(_value) {
      setterCalled = true;
    }
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: setterRow.id, row: setterRow
  }), 'DEMO_OWNERSHIP_SNAPSHOT_DYNAMIC_FIELD_INVALID');
  assert.strictEqual(setterCalled, false, '业务 row setter 不得执行');

  let proxyTrapCalled = false;
  const proxyRow = new Proxy({ ...runRow }, {
    getPrototypeOf() { proxyTrapCalled = true; return Object.prototype; },
    ownKeys(target) { proxyTrapCalled = true; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { proxyTrapCalled = true; return Object.getOwnPropertyDescriptor(target, key); },
    get(target, key, receiver) { proxyTrapCalled = true; return Reflect.get(target, key, receiver); }
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_evaluation_run', entityPk: runRow.id, row: proxyRow
  }), 'DEMO_OWNERSHIP_SNAPSHOT_INVALID');
  assert.strictEqual(proxyTrapCalled, false, '业务 row Proxy trap 不得执行');
}

/** 写入 strategy derived registrar 使用的固定 action run。 */
function insertExecutingStrategyAction(db, input) {
  const nowUtc = '2026-08-28T10:00:00.000Z';
  db.prepare(`INSERT INTO demo_post_action_runs
    (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
     executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
     runtime_epoch, runtime_revision, input_digest, preview_digest, preview_expires_at,
     input_json, requested_by, status, started_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-registry-v1', 'test-resolver-v1', 'test-executor-v1', ?, ?, ?, ?,
      1, 1, ?, ?, '2026-08-29T00:00:00.000Z', '{}', ?, 'executing', ?, ?, ?)`).run(
    input.actionRunId,
    input.runRecord.runId,
    input.runRecord.datasetId,
    input.actionKey || 'strategy-evaluation-run',
    input.actionRunId,
    input.runRecord.manifestVersion,
    input.runRecord.manifestDigest,
    'd'.repeat(64),
    'e'.repeat(64),
    'f'.repeat(64),
    input.actorUserId,
    nowUtc,
    nowUtc,
    nowUtc
  );
}

/** 读取策略派生治理可能产生的 run、hit、audit、registry 与 relation 数量。 */
function getStrategyDerivedGovernanceWriteCounts(db) {
  return {
    runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    audits: db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.run'").get().total,
    registry: db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type IN ('strategy_evaluation_run', 'strategy_rule_hit')`).get().total,
    relations: db.prepare(`SELECT COUNT(DISTINCT relation.relation_id) AS total
      FROM demo_data_relations relation
      LEFT JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
      LEFT JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
      WHERE source.entity_type IN ('strategy_evaluation_run', 'strategy_rule_hit')
         OR target.entity_type IN ('strategy_evaluation_run', 'strategy_rule_hit')`).get().total
  };
}

/** 验证固定 evaluator ownership 协议、一次性 receipt 和 caller SAVEPOINT 边界。 */
function testStrategyDerivedOwnershipRegistrar(db, actorUserId, runRecord) {
  const strategyBatchId = insertImportBatch(db, 'strategy_rule', 'strategy-fixed-rules.xlsx');
  const timeseriesBatchId = insertImportBatch(db, 'energy_timeseries', 'strategy-fixed-timeseries.xlsx');
  const electricityId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES ('STRATEGY-FIXED-OU', '策略固定治理单元', '/策略固定治理单元', 'workshop', 'active')`)
    .run().lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES ('STRATEGY-FIXED-METER', '策略固定治理表计', 'electricity', ?, ?, 'active')`)
    .run(electricityId, organizationUnitId).lastInsertRowid);
  const ruleId = Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (?, 1, 'STRATEGY-FIXED-RULE', '策略固定规则', '1.0.0', 'load-analysis:v1',
      'load_rate', 'gt', 10, '%', 0.1, 'high',
      '{"minimumCoverageRate":0,"maxEvidenceItems":10,"savingBasis":"window_total_energy"}',
      '人工复核后执行节能建议。', 'test', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(strategyBatchId).lastInsertRowid);
  const timeseriesIds = [0, 1].map((index) => Number(db.prepare(`INSERT INTO energy_timeseries_records
    (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
     start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
     normalized_unit, normalized_value, source_reference, data_source, record_status,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', 10, 'kWh', 10, ?, 'upload',
      'active', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(timeseriesBatchId, index + 1, organizationUnitId, meterDeviceId, electricityId,
      `2026-08-01T00:${index === 0 ? '00' : '15'}:00.000Z`,
      `2026-08-01T00:${index === 0 ? '15' : '30'}:00.000Z`,
      `strategy-fixed:${index + 1}`).lastInsertRowid));
  const sourceEntities = [
    { entityType: 'strategy_rule', entityPk: ruleId, artifactKey: '18-strategy-rules' },
    ...timeseriesIds.map((entityPk) => ({
      entityType: 'energy_timeseries', entityPk, artifactKey: '15-energy-timeseries'
    }))
  ];
  sourceEntities.forEach((source) => {
    const row = DEMO_OWNERSHIP_ENTITY_HANDLERS[source.entityType].readProjection(db, source.entityPk);
    db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
       snapshot_digest, source_batch_id, source_row_number, registered_by)
      VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)`).run(
      runRecord.runId,
      source.artifactKey,
      source.entityType,
      String(source.entityPk),
      calculateDemoEntityIdentityDigest(source.entityType, String(source.entityPk)),
      calculateDemoEntitySnapshotDigest(source.entityType, String(source.entityPk), row),
      row.source_batch_id,
      row.source_row_number,
      actorUserId
    );
  });
  const exactScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: timeseriesIds,
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: [ruleId],
    strategyRuleSourceBatchId: strategyBatchId
  });
  const evaluatorInput = {
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: '2026-08-01T00:00:00.000Z',
    endUtc: '2026-08-01T00:30:00.000Z',
    sourceTimeZone: 'Asia/Shanghai'
  };
  const domainBinding = { ...evaluatorInput };
  let actionSequence = 0;
  const issueScope = () => {
    actionSequence += 1;
    const actionRunId = `strategy-fixed-${actionSequence}`;
    insertExecutingStrategyAction(db, { actionRunId, runRecord, actorUserId });
    return issueStrategyEvaluationRegistrationScopeInTransaction({
      db,
      runId: runRecord.runId,
      actionRunId,
      actorUserId,
      exactScope,
      domainBinding
    });
  };
  assert.strictEqual(typeof energyStrategyEvaluationService.getEnergyStrategyRegistrationRegistrarCapability, 'undefined');
  assert.strictEqual(typeof energyStrategyEvaluationService.resolveEnergyStrategyRegistrarCapability, 'undefined');
  assert.strictEqual(typeof energyStrategyEvaluationService.consumeEnergyStrategyEvaluationCompletionWitness, 'undefined');
  const fixedOptions = (registrationScope, extra = {}) => ({
    db,
    actorUserId,
    exactRequired: true,
    exactScope,
    registrationScope,
    ...extra
  });

  // evaluator-first 与 ownership-first 均不得暴露登记入口；fake Module、fake stack 和 cache 记录替换不得注入 handler。
  const evaluatorModulePathForProbe = require.resolve('../services/energyStrategyEvaluationService');
  const ownershipModulePathForProbe = require.resolve('../services/demoOwnershipService');
  const protocolModulePathForProbe = require.resolve('../services/energyStrategyOwnershipProtocol');
  const initializationProbeScript = `
    'use strict';
    const Module = require('module');
    const vm = require('vm');
    const evaluatorPath = ${JSON.stringify(evaluatorModulePathForProbe)};
    const ownershipPath = ${JSON.stringify(ownershipModulePathForProbe)};
    const protocolPath = ${JSON.stringify(protocolModulePathForProbe)};
    require(evaluatorPath);
    require(ownershipPath);
    const protocol = require(protocolPath);
    if (typeof protocol.registerEnergyStrategyEvaluatorProtocol !== 'undefined'
      || typeof protocol.registerEnergyStrategyOwnershipProtocol !== 'undefined') process.exit(11);
    [protocolPath, evaluatorPath, ownershipPath].forEach((modulePath) => {
      const descriptor = Object.getOwnPropertyDescriptor(require.cache[modulePath], 'exports');
      if (!descriptor || descriptor.writable !== false || descriptor.configurable !== false) process.exit(12);
    });
    let fakeHandlerExecuted = false;
    const fakeSuccess = () => {
      fakeHandlerExecuted = true;
      return { success: true, result: 'fake-register-success' };
    };
    const fakeEvaluatorModule = new Module(evaluatorPath, module);
    fakeEvaluatorModule.filename = evaluatorPath;
    fakeEvaluatorModule.loaded = false;
    fakeEvaluatorModule.exports = {
      assertEnergyStrategyExactScopeCapability: fakeSuccess,
      bindEnergyStrategyRegistrationScopeCapability: fakeSuccess,
      consumeEnergyStrategyEvaluationWitnessForOwnership: fakeSuccess,
      getStrategyRuleHitWithDb: fakeSuccess,
      insertOperationLogWithDb: fakeSuccess,
      parseEvidenceRequirements: fakeSuccess
    };
    const fakeOwnershipModule = new Module(ownershipPath, module);
    fakeOwnershipModule.filename = ownershipPath;
    fakeOwnershipModule.loaded = false;
    fakeOwnershipModule.exports = {
      abortStrategyEvaluationRegistrationScopeInTransaction: fakeSuccess,
      activateStrategyEvaluationRegistrationScopeInTransaction: fakeSuccess,
      registerDerivedStrategyEvaluationInTransaction: fakeSuccess,
      verifyDerivedStrategyEvaluationReceiptInTransaction: fakeSuccess
    };
    require.cache[evaluatorPath] = fakeEvaluatorModule;
    require.cache[ownershipPath] = fakeOwnershipModule;
    globalThis.__charcoalProtocolProbe = protocol;
    globalThis.__charcoalFakeModuleProbe = fakeEvaluatorModule;
    let fakeStackRejected = false;
    try {
      vm.runInThisContext(
        'globalThis.__charcoalProtocolProbe.registerEnergyStrategyEvaluatorProtocol(' +
          'globalThis.__charcoalFakeModuleProbe, {})',
        { filename: evaluatorPath }
      );
    } catch (_error) {
      fakeStackRejected = true;
    }
    delete globalThis.__charcoalProtocolProbe;
    delete globalThis.__charcoalFakeModuleProbe;
    if (!fakeStackRejected || fakeHandlerExecuted) process.exit(13);
    let realWrapperRejected = false;
    try {
      protocol.energyStrategyEvaluatorProtocol.assertExactScope(Object.freeze({}), Object.freeze({}));
    } catch (error) {
      realWrapperRejected = (error.details && error.details.code)
        === 'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED';
    }
    if (!realWrapperRejected || fakeHandlerExecuted) process.exit(14);
    const fakeProtocolModule = new Module(protocolPath, module);
    fakeProtocolModule.filename = protocolPath;
    fakeProtocolModule.loaded = true;
    fakeProtocolModule.exports = {
      energyStrategyEvaluatorProtocol: { assertExactScope: fakeSuccess },
      energyStrategyOwnershipProtocol: { register: fakeSuccess }
    };
    require.cache[protocolPath] = fakeProtocolModule;
    try {
      protocol.energyStrategyOwnershipProtocol.verifyReceipt({});
    } catch (_error) {
      // 真实 wrapper 必须拒绝空 receipt，而不是执行 cache 中的 fake wrapper。
    }
    if (fakeHandlerExecuted) process.exit(15);
  `;
  runNodeSecurityProbe(initializationProbeScript, 'evaluator-first fake Module 与伪造栈探针');
  runNodeSecurityProbe(
    initializationProbeScript.replace(
      '    require(evaluatorPath);\n    require(ownershipPath);',
      '    require(ownershipPath);\n    require(evaluatorPath);'
    ),
    'ownership-first fake Module 与伪造栈探针'
  );
  runNodeSecurityProbe(
    initializationProbeScript.replace(
      '    require(evaluatorPath);\n    require(ownershipPath);',
      '    require(protocolPath);\n    require(evaluatorPath);\n    require(ownershipPath);'
    ),
    'protocol-first fake Module 与伪造栈探针'
  );

  // 固定协议导出和两侧服务导出均必须保持冻结、不可替换的属性描述符。
  assert.strictEqual(Object.isFrozen(strategyOwnershipProtocol), true);
  assert.strictEqual(Object.isFrozen(strategyOwnershipProtocol.energyStrategyEvaluatorProtocol), true);
  assert.strictEqual(Object.isFrozen(strategyOwnershipProtocol.energyStrategyOwnershipProtocol), true);
  [
    demoOwnershipService,
    energyStrategyEvaluationService,
    strategyOwnershipProtocol,
    strategyOwnershipProtocol.energyStrategyEvaluatorProtocol,
    strategyOwnershipProtocol.energyStrategyOwnershipProtocol
  ].forEach((exportsObject) => {
    Object.entries(Object.getOwnPropertyDescriptors(exportsObject)).forEach(([fieldName, descriptor]) => {
      assert.strictEqual(descriptor.writable, false, `${fieldName} writable 必须为 false`);
      assert.strictEqual(descriptor.configurable, false, `${fieldName} configurable 必须为 false`);
      assert.strictEqual(descriptor.enumerable, true, `${fieldName} enumerable 必须为 true`);
    });
  });
  assert.strictEqual(Object.isFrozen(demoOwnershipService), true);
  assert.strictEqual(Object.isFrozen(energyStrategyEvaluationService), true);
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(demoOwnershipService, '__charcoal_strategy_fixed_protocol_v1'),
    undefined
  );
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(energyStrategyEvaluationService, '__charcoal_strategy_fixed_protocol_v1'),
    undefined
  );
  assert.strictEqual(
    typeof strategyOwnershipProtocol.registerEnergyStrategyEvaluatorProtocol,
    'undefined'
  );
  assert.strictEqual(
    typeof strategyOwnershipProtocol.registerEnergyStrategyOwnershipProtocol,
    'undefined'
  );

  // 整体替换两侧 require.cache.exports 后，真实固定闭包仍必须执行，攻击探针不得触发。
  const evaluatorModulePath = require.resolve('../services/energyStrategyEvaluationService');
  const ownershipModulePath = require.resolve('../services/demoOwnershipService');
  const protocolModulePath = require.resolve('../services/energyStrategyOwnershipProtocol');
  [evaluatorModulePath, ownershipModulePath, protocolModulePath].forEach((modulePath) => {
    const descriptor = Object.getOwnPropertyDescriptor(require.cache[modulePath], 'exports');
    assert.strictEqual(descriptor.writable, false);
    assert.strictEqual(descriptor.configurable, false);
    assert.strictEqual(descriptor.enumerable, true);
  });
  const originalEvaluatorExports = require.cache[evaluatorModulePath].exports;
  const originalOwnershipExports = require.cache[ownershipModulePath].exports;
  const originalProtocolExports = require.cache[protocolModulePath].exports;
  let attackerProtocolExecuted = false;
  let attackerStrategyDigestExecuted = false;
  let attackerRuleHitRefreshExecuted = false;
  const attackerProtocolCall = () => {
    attackerProtocolExecuted = true;
    return { success: true, fake: true };
  };
  const attackerIdentityDigest = (...args) => {
    if (args[0] === 'strategy_rule') attackerStrategyDigestExecuted = true;
    return originalOwnershipExports.calculateDemoEntityIdentityDigest(...args);
  };
  const attackerSnapshotDigest = (...args) => {
    if (args[0] === 'strategy_rule') attackerStrategyDigestExecuted = true;
    return originalOwnershipExports.calculateDemoEntitySnapshotDigest(...args);
  };
  const attackerRuleHitRefresh = () => {
    attackerRuleHitRefreshExecuted = true;
    return { refreshed: true, reason: 'fake-wrapper-success' };
  };
  const attackerEvaluatorExports = Object.freeze({
    ...originalEvaluatorExports,
    assertEnergyStrategyExactScopeCapability: attackerProtocolCall,
    bindEnergyStrategyRegistrationScopeCapability: attackerProtocolCall,
    getStrategyRuleHitWithDb: attackerProtocolCall,
    insertOperationLogWithDb: attackerProtocolCall,
    parseEvidenceRequirements: attackerProtocolCall
  });
  const attackerOwnershipExports = Object.freeze({
    ...originalOwnershipExports,
    activateStrategyEvaluationRegistrationScopeInTransaction: attackerProtocolCall,
    abortStrategyEvaluationRegistrationScopeInTransaction: attackerProtocolCall,
    registerDerivedStrategyEvaluationInTransaction: attackerProtocolCall,
    verifyDerivedStrategyEvaluationReceiptInTransaction: attackerProtocolCall,
    calculateDemoEntityIdentityDigest: attackerIdentityDigest,
    calculateDemoEntitySnapshotDigest: attackerSnapshotDigest,
    refreshDerivedStrategyRuleHitOwnershipInTransaction: attackerRuleHitRefresh
  });
  const attackerProtocolExports = Object.freeze({
    ...originalProtocolExports,
    energyStrategyEvaluatorProtocol: { assertExactScope: attackerProtocolCall },
    energyStrategyOwnershipProtocol: {
      register: attackerProtocolCall,
      calculateIdentityDigest: attackerIdentityDigest,
      calculateSnapshotDigest: attackerSnapshotDigest,
      refreshRuleHitOwnership: attackerRuleHitRefresh
    }
  });
  assert.strictEqual(Reflect.set(require.cache[evaluatorModulePath], 'exports', attackerEvaluatorExports), false);
  assert.strictEqual(Reflect.set(require.cache[ownershipModulePath], 'exports', attackerOwnershipExports), false);
  assert.strictEqual(Reflect.set(require.cache[protocolModulePath], 'exports', attackerProtocolExports), false);
  assert.strictEqual(require.cache[evaluatorModulePath].exports, originalEvaluatorExports);
  assert.strictEqual(require.cache[ownershipModulePath].exports, originalOwnershipExports);
  assert.strictEqual(require.cache[protocolModulePath].exports, originalProtocolExports);
  {
    // 构造整体 require.cache 记录替换，覆盖仅锁定 Module.exports descriptor 无法阻止的攻击路径。
    const createFakeModuleRecord = (modulePath, exportsValue) => {
      const fakeModuleRecord = new Module(modulePath, module);
      fakeModuleRecord.filename = modulePath;
      fakeModuleRecord.loaded = true;
      fakeModuleRecord.exports = exportsValue;
      return fakeModuleRecord;
    };
    const originalEvaluatorModule = require.cache[evaluatorModulePath];
    const originalOwnershipModule = require.cache[ownershipModulePath];
    const originalProtocolModule = require.cache[protocolModulePath];
    require.cache[evaluatorModulePath] = createFakeModuleRecord(
      evaluatorModulePath,
      attackerEvaluatorExports
    );
    require.cache[ownershipModulePath] = createFakeModuleRecord(
      ownershipModulePath,
      attackerOwnershipExports
    );
    require.cache[protocolModulePath] = createFakeModuleRecord(
      protocolModulePath,
      attackerProtocolExports
    );
    try {
      // exact strategy rule 摘要必须继续执行协议初始化期捕获的真实 helper。
      const rebuiltExactScope = buildEnergyStrategyExactScope(db, {
        timeseriesRecordIds: timeseriesIds,
        timeseriesSourceBatchId: timeseriesBatchId,
        strategyRuleIds: [ruleId],
        strategyRuleSourceBatchId: strategyBatchId
      });
      assert.strictEqual(Object.isFrozen(rebuiltExactScope), true);
      assert.strictEqual(attackerStrategyDigestExecuted, false);

      const beforeCacheReplacementCounts = getStrategyDerivedGovernanceWriteCounts(db);
      db.exec('BEGIN IMMEDIATE');
      const cacheReplacementScope = issueScope();
      const cacheReplacementEvaluation = runEnergyStrategyEvaluation(
        evaluatorInput,
        fixedOptions(cacheReplacementScope)
      );
      assert(cacheReplacementEvaluation.run.id > 0);
      const cacheReplacementHitId = Number(cacheReplacementEvaluation.hits[0].id);
      const registryBeforeReview = db.prepare(`SELECT snapshot_digest AS snapshotDigest
        FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND entity_pk = ?`)
        .get(String(cacheReplacementHitId));
      const reviewedHit = updateStrategyRuleHitStatus(cacheReplacementHitId, {
        manualStatus: 'accepted',
        reviewNote: 'cache 整体替换后仍由真实 helper 刷新。'
      }, { db, actorUserId });
      const registryAfterReview = db.prepare(`SELECT snapshot_digest AS snapshotDigest
        FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND entity_pk = ?`)
        .get(String(cacheReplacementHitId));
      assert.strictEqual(reviewedHit.manualStatus, 'accepted');
      assert.notStrictEqual(registryAfterReview.snapshotDigest, registryBeforeReview.snapshotDigest);
      assert.strictEqual(attackerRuleHitRefreshExecuted, false);
      assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), {
        runs: beforeCacheReplacementCounts.runs + 1,
        hits: beforeCacheReplacementCounts.hits + 1,
        audits: beforeCacheReplacementCounts.audits + 1,
        registry: beforeCacheReplacementCounts.registry + 2,
        relations: beforeCacheReplacementCounts.relations + 4
      });
      db.exec('ROLLBACK');

      // 真实固定协议拒绝 malformed scope 时，五类治理事实必须保持攻击前基线。
      const beforeCacheReplacementFailureCounts = getStrategyDerivedGovernanceWriteCounts(db);
      db.exec('BEGIN IMMEDIATE');
      const cacheReplacementFailureScope = issueScope();
      assertErrorCode(
        () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(
          cacheReplacementFailureScope,
          { exactScope: Object.freeze({}) }
        )),
        'ENERGY_STRATEGY_EXACT_SCOPE_REQUIRED'
      );
      assert.deepStrictEqual(
        getStrategyDerivedGovernanceWriteCounts(db),
        beforeCacheReplacementFailureCounts
      );
      db.exec('ROLLBACK');
      assert.strictEqual(attackerProtocolExecuted, false, '伪造成功协议不得被调用');
      assert.strictEqual(attackerStrategyDigestExecuted, false, '伪造 strategy digest helper 不得被调用');
      assert.strictEqual(attackerRuleHitRefreshExecuted, false, '伪造 refresh helper 不得被调用');
    } finally {
      require.cache[evaluatorModulePath] = originalEvaluatorModule;
      require.cache[ownershipModulePath] = originalOwnershipModule;
      require.cache[protocolModulePath] = originalProtocolModule;
      if (db.inTransaction) db.exec('ROLLBACK');
    }
  }
  const invalidReceiptInput = {
    registrarAuthority: Object.freeze({}),
    db,
    registrationScope: Object.freeze({}),
    evaluationWitness: Object.freeze({}),
    receipt: Object.freeze({})
  };
  assertErrorCode(
    () => demoOwnershipService.verifyDerivedStrategyEvaluationReceiptInTransaction(invalidReceiptInput),
    'DEMO_DERIVED_STRATEGY_RECEIPT_CAPABILITY_REQUIRED'
  );
  assertErrorCode(
    () => demoOwnershipService.verifyDerivedStrategyEvaluationReceiptInTransaction({
      ...invalidReceiptInput,
      receipt: JSON.parse(JSON.stringify(invalidReceiptInput.receipt))
    }),
    'DEMO_DERIVED_STRATEGY_RECEIPT_CAPABILITY_REQUIRED'
  );
  const beforeSuccessfulCounts = getStrategyDerivedGovernanceWriteCounts(db);
  db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT caller_nested_strategy');
  const successfulScope = issueScope();
  const evaluated = runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(successfulScope));
  assert.strictEqual(evaluated.meta.reusedCallerTransaction, true);
  assert.strictEqual(db.inTransaction, true);
  assert.strictEqual(JSON.stringify(evaluated).includes('receipt'), false);
  assert.strictEqual(JSON.stringify(evaluated).includes('Witness'), false);
  assert.deepStrictEqual(Object.keys(evaluated).sort(), [
    'automationBoundary', 'changesDeviceState', 'contractVersion', 'dataRange',
    'dataSelection', 'dataSummary', 'dataSummaryDigest', 'dryRun', 'formulaVersion',
    'hits', 'issuesControlCommand', 'meta', 'persistsEvaluationRun', 'requiresManualReview',
    'ruleSelection', 'run', 'scope', 'usesAI'
  ].sort());
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), {
    runs: beforeSuccessfulCounts.runs + 1,
    hits: beforeSuccessfulCounts.hits + 1,
    audits: beforeSuccessfulCounts.audits + 1,
    registry: beforeSuccessfulCounts.registry + 2,
    relations: beforeSuccessfulCounts.relations + 4
  });
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE entity_type = 'strategy_evaluation_run' AND entity_pk = ?`).get(String(evaluated.run.id)).total, 1);
  db.exec('ROLLBACK TO SAVEPOINT caller_nested_strategy');
  db.exec('RELEASE SAVEPOINT caller_nested_strategy');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM strategy_evaluation_runs WHERE id = ?`)
    .get(evaluated.run.id).total, 0);
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeSuccessfulCounts);
  db.exec('COMMIT');

  // 同一 demo run 的第二次合法评价只能校验本次 receipt 端点，不得误比整段 run 历史。
  db.exec('BEGIN IMMEDIATE');
  const firstCommittedScope = issueScope();
  const firstCommittedEvaluation = runEnergyStrategyEvaluation(
    evaluatorInput,
    fixedOptions(firstCommittedScope)
  );
  db.exec('COMMIT');
  db.exec('BEGIN IMMEDIATE');
  const secondCommittedScope = issueScope();
  const secondCommittedEvaluation = runEnergyStrategyEvaluation(
    evaluatorInput,
    fixedOptions(secondCommittedScope)
  );
  assert.notStrictEqual(firstCommittedEvaluation.run.id, secondCommittedEvaluation.run.id);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '18-strategy-rules' AND ownership_kind = 'derived'
      AND cleaned_at IS NULL`).get(runRecord.runId).total, 4);
  db.exec('COMMIT');
  // 历史连续提交断言完成后清理隔离测试数据，恢复后续失败场景的五表基线。
  db.exec('BEGIN IMMEDIATE');
  db.exec(`DELETE FROM demo_data_relations
    WHERE from_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE ownership_kind = 'derived')
       OR to_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE ownership_kind = 'derived');
    DELETE FROM demo_data_registry WHERE ownership_kind = 'derived';
    DELETE FROM sys_operation_logs WHERE operation = 'energy.strategy.run';
    DELETE FROM strategy_rule_hits;
    DELETE FROM strategy_evaluation_runs;`);
  db.exec('COMMIT');
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeSuccessfulCounts);

  // scope marker 在 issue 后若跨越 COMMIT-BEGIN，必须拒绝事务世代重放并清理 marker。
  db.exec('BEGIN IMMEDIATE');
  const committedAndRebegunScope = issueScope();
  db.exec('COMMIT; BEGIN IMMEDIATE');
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(committedAndRebegunScope)),
    'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH'
  );
  assert.strictEqual(db.inTransaction, true);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = '__charcoal_strategy_registration_scope_marker'`).get().total, 0);
  db.exec('ROLLBACK');

  // caller 回滚签发 scope 的外层 SAVEPOINT 后，marker 和 action run 已撤销，scope 不得重放。
  db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT caller_scope_generation');
  const rolledBackScope = issueScope();
  db.exec('ROLLBACK TO SAVEPOINT caller_scope_generation');
  db.exec('RELEASE SAVEPOINT caller_scope_generation');
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(rolledBackScope)),
    'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH'
  );
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeSuccessfulCounts);
  db.exec('ROLLBACK');

  db.exec('BEGIN IMMEDIATE');
  const callbackScope = issueScope();
  let completedCallbackCalled = false;
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(callbackScope, {
    onCompletedEvaluation() {
      completedCallbackCalled = true;
      db.exec('COMMIT; BEGIN IMMEDIATE');
    }
  })), 'ENERGY_STRATEGY_CONTROLLED_OPTIONS_INVALID');
  assert.strictEqual(completedCallbackCalled, false);
  assert.strictEqual(db.inTransaction, true);
  db.exec('ROLLBACK');

  db.exec('BEGIN IMMEDIATE');
  const beforeCallbackScope = issueScope();
  let beforeCallbackCalled = false;
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(beforeCallbackScope, {
    beforeEvaluationWrite() {
      beforeCallbackCalled = true;
      db.exec('COMMIT; BEGIN IMMEDIATE');
    }
  })), 'ENERGY_STRATEGY_CONTROLLED_OPTIONS_INVALID');
  assert.strictEqual(beforeCallbackCalled, false);
  assert.strictEqual(db.inTransaction, true);
  db.exec('ROLLBACK');

  db.exec('BEGIN IMMEDIATE');
  const auditScope = issueScope();
  let controlledAuditWriterCalled = false;
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(auditScope, {
    auditWriter() {
      controlledAuditWriterCalled = true;
    }
  })), 'ENERGY_STRATEGY_CONTROLLED_OPTIONS_INVALID');
  assert.strictEqual(controlledAuditWriterCalled, false);
  assert.strictEqual(db.inTransaction, true);
  db.exec('ROLLBACK');

  db.exec('BEGIN IMMEDIATE');
  const registrarFieldScope = issueScope();
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(registrarFieldScope, {
    registrarCapability: Object.freeze({})
  })), 'ENERGY_STRATEGY_CONTROLLED_OPTIONS_INVALID');
  assert.strictEqual(db.inTransaction, true);
  db.exec('ROLLBACK');

  const dbB = openDatabase();
  const dbAPrepare = db.prepare;
  const dbAExec = db.exec;
  const dbBPrepare = dbB.prepare;
  const dbBExec = dbB.exec;
  const dbBClose = dbB.close;
  dbAExec.call(db, 'BEGIN IMMEDIATE');
  const crossDatabaseScope = issueScope();
  dbBExec.call(dbB, 'BEGIN DEFERRED');
  const dbASql = [];
  const dbBSql = [];
  db.prepare = function monitorDbAPrepare(sql, ...args) {
    dbASql.push(String(sql));
    return dbAPrepare.call(db, sql, ...args);
  };
  db.exec = function monitorDbAExec(sql, ...args) {
    dbASql.push(String(sql));
    return dbAExec.call(db, sql, ...args);
  };
  dbB.prepare = function monitorDbBPrepare(sql, ...args) {
    dbBSql.push(String(sql));
    return dbBPrepare.call(dbB, sql, ...args);
  };
  dbB.exec = function monitorDbBExec(sql, ...args) {
    dbBSql.push(String(sql));
    return dbBExec.call(dbB, sql, ...args);
  };
  try {
    assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, {
      db: dbB,
      actorUserId,
      exactRequired: true,
      exactScope,
      registrationScope: crossDatabaseScope
    }), 'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH');
    assert.deepStrictEqual(dbASql, []);
    assert.deepStrictEqual(dbBSql, []);
  } finally {
    db.prepare = dbAPrepare;
    db.exec = dbAExec;
    dbB.prepare = dbBPrepare;
    dbB.exec = dbBExec;
    if (dbB.inTransaction) dbBExec.call(dbB, 'ROLLBACK');
    if (dbB.open) dbBClose.call(dbB);
    if (db.inTransaction) dbAExec.call(db, 'ROLLBACK');
  }
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), {
    runs: 0,
    hits: 0,
    audits: 0,
    registry: 0,
    relations: 0
  });

  db.exec(`CREATE TEMP TRIGGER fail_fixed_strategy_relation
    BEFORE INSERT ON demo_data_relations
    WHEN NEW.relation_type = 'uses_config'
    BEGIN
      SELECT RAISE(ABORT, 'forced fixed strategy relation failure');
    END`);
  const beforeFailureCounts = getStrategyDerivedGovernanceWriteCounts(db);
  db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT caller_nested_failure');
  const failureScope = issueScope();
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(failureScope)),
    'DEMO_OWNERSHIP_RELATION_WRITE_FAILED');
  assert.strictEqual(db.inTransaction, true);
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, created_at)
    VALUES (?, 'strategy.fixed.continue', 'test', 'nested-failure', '{}', '2026-08-28T12:00:00.000Z')`)
    .run(actorUserId);
  db.exec('ROLLBACK TO SAVEPOINT caller_nested_failure');
  db.exec('RELEASE SAVEPOINT caller_nested_failure');
  db.exec('COMMIT');
  db.exec('DROP TRIGGER fail_fixed_strategy_relation');
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);

  // registry AFTER trigger 静默改写完整字段时，必须由写入前 contract 逐字段拒绝。
  db.exec(`CREATE TEMP TRIGGER rewrite_fixed_strategy_registry
    AFTER INSERT ON demo_data_registry
    WHEN NEW.ownership_kind = 'derived'
    BEGIN
      UPDATE demo_data_registry SET snapshot_digest = '${'0'.repeat(64)}'
      WHERE registry_id = NEW.registry_id;
    END`);
  db.exec('BEGIN IMMEDIATE');
  const rewrittenRegistryScope = issueScope();
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(rewrittenRegistryScope)),
    'DEMO_DERIVED_STRATEGY_REGISTRY_CONTRACT_MISMATCH'
  );
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  db.exec('ROLLBACK');
  db.exec('DROP TRIGGER rewrite_fixed_strategy_registry');

  // relation AFTER trigger 静默改写 created_at 时，必须由写入前 intent 逐字段拒绝。
  db.exec(`CREATE TEMP TRIGGER rewrite_fixed_strategy_relation
    AFTER INSERT ON demo_data_relations
    WHEN NEW.relation_type = 'uses_config'
    BEGIN
      UPDATE demo_data_relations SET created_at = '2000-01-01T00:00:00.000Z'
      WHERE relation_id = NEW.relation_id;
    END`);
  db.exec('BEGIN IMMEDIATE');
  const rewrittenRelationScope = issueScope();
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(rewrittenRelationScope)),
    'DEMO_DERIVED_STRATEGY_RELATION_INTENT_MISMATCH'
  );
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  db.exec('ROLLBACK');
  db.exec('DROP TRIGGER rewrite_fixed_strategy_relation');

  // registrar 写 registry 时若触发器删除本次 audit，完成见证和 receipt 必须同步失败。
  db.exec(`CREATE TEMP TRIGGER delete_fixed_strategy_audit
    AFTER INSERT ON demo_data_registry
    WHEN NEW.ownership_kind = 'derived'
    BEGIN
      DELETE FROM sys_operation_logs
      WHERE operation = 'energy.strategy.run' AND target_id = NEW.entity_pk;
    END`);
  db.exec('BEGIN IMMEDIATE');
  const deletedAuditScope = issueScope();
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(deletedAuditScope)),
    'DEMO_DERIVED_STRATEGY_OPERATION_AUDIT_MISMATCH'
  );
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  db.exec('ROLLBACK');
  db.exec('DROP TRIGGER delete_fixed_strategy_audit');

  // evaluator 首次重读 audit 即发现静默改写，不得签发 completion witness。
  db.exec(`CREATE TEMP TRIGGER rewrite_fixed_strategy_audit
    AFTER INSERT ON sys_operation_logs
    WHEN NEW.operation = 'energy.strategy.run'
    BEGIN
      UPDATE sys_operation_logs SET detail_json = '{"tampered":true}' WHERE id = NEW.id;
    END`);
  db.exec('BEGIN IMMEDIATE');
  const rewrittenAuditScope = issueScope();
  assertErrorCode(
    () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(rewrittenAuditScope)),
    'ENERGY_STRATEGY_OPERATION_AUDIT_MISMATCH'
  );
  assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  db.exec('ROLLBACK');
  db.exec('DROP TRIGGER rewrite_fixed_strategy_audit');

  // registrar ROLLBACK TO 失败后严禁 RELEASE 同一 SAVEPOINT，并必须完整回滚 caller transaction。
  db.exec(`CREATE TEMP TRIGGER fail_fixed_strategy_relation_recovery
    BEFORE INSERT ON demo_data_relations
    WHEN NEW.relation_type = 'uses_config'
    BEGIN
      SELECT RAISE(ABORT, 'forced registrar recovery failure');
    END`);
  const originalRegistrarRecoveryExec = db.exec;
  let registrarRollbackToFailed = false;
  let registrarReleaseAfterFailure = false;
  db.exec = function failRegistrarRollbackTo(sql, ...args) {
    const normalizedSql = String(sql);
    if (/^ROLLBACK TO SAVEPOINT demo_strategy_registrar_/i.test(normalizedSql)) {
      registrarRollbackToFailed = true;
      const recoveryError = new Error('forced registrar rollback-to failure');
      recoveryError.code = 'TEST_REGISTRAR_ROLLBACK_TO_FAILED';
      throw recoveryError;
    }
    if (registrarRollbackToFailed
      && /^RELEASE SAVEPOINT demo_strategy_registrar_/i.test(normalizedSql)) {
      registrarReleaseAfterFailure = true;
    }
    return originalRegistrarRecoveryExec.call(db, sql, ...args);
  };
  try {
    originalRegistrarRecoveryExec.call(db, 'BEGIN IMMEDIATE');
    const registrarRecoveryScope = issueScope();
    assertErrorCode(
      () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(registrarRecoveryScope)),
      'DEMO_DERIVED_STRATEGY_REGISTRAR_RECOVERY_FAILED'
    );
    assert.strictEqual(registrarRollbackToFailed, true);
    assert.strictEqual(registrarReleaseAfterFailure, false);
    assert.strictEqual(db.inTransaction, false);
    assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  } finally {
    db.exec = originalRegistrarRecoveryExec;
    if (db.inTransaction) db.exec('ROLLBACK');
    db.exec('DROP TRIGGER fail_fixed_strategy_relation_recovery');
  }

  // evaluator ROLLBACK TO 失败同样不得 RELEASE，完整 ROLLBACK 后连接仍可安全复用。
  db.exec(`CREATE TEMP TRIGGER rewrite_fixed_strategy_audit_recovery
    AFTER INSERT ON sys_operation_logs
    WHEN NEW.operation = 'energy.strategy.run'
    BEGIN
      UPDATE sys_operation_logs SET target_type = 'tampered' WHERE id = NEW.id;
    END`);
  const originalEvaluatorRecoveryExec = db.exec;
  let evaluatorRollbackToFailed = false;
  let evaluatorReleaseAfterFailure = false;
  db.exec = function failEvaluatorRollbackTo(sql, ...args) {
    const normalizedSql = String(sql);
    if (/^ROLLBACK TO SAVEPOINT energy_strategy_exact_/i.test(normalizedSql)) {
      evaluatorRollbackToFailed = true;
      const recoveryError = new Error('forced evaluator rollback-to failure');
      recoveryError.code = 'TEST_EVALUATOR_ROLLBACK_TO_FAILED';
      throw recoveryError;
    }
    if (evaluatorRollbackToFailed
      && /^RELEASE SAVEPOINT energy_strategy_exact_/i.test(normalizedSql)) {
      evaluatorReleaseAfterFailure = true;
    }
    return originalEvaluatorRecoveryExec.call(db, sql, ...args);
  };
  try {
    originalEvaluatorRecoveryExec.call(db, 'BEGIN IMMEDIATE');
    const evaluatorRecoveryScope = issueScope();
    assertErrorCode(
      () => runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(evaluatorRecoveryScope)),
      'ENERGY_STRATEGY_SAVEPOINT_RECOVERY_FAILED'
    );
    assert.strictEqual(evaluatorRollbackToFailed, true);
    assert.strictEqual(evaluatorReleaseAfterFailure, false);
    assert.strictEqual(db.inTransaction, false);
    assert.deepStrictEqual(getStrategyDerivedGovernanceWriteCounts(db), beforeFailureCounts);
  } finally {
    db.exec = originalEvaluatorRecoveryExec;
    if (db.inTransaction) db.exec('ROLLBACK');
    db.exec('DROP TRIGGER rewrite_fixed_strategy_audit_recovery');
  }

  db.exec('BEGIN IMMEDIATE');
  const replayScope = issueScope();
  const replayResult = runEnergyStrategyEvaluation(evaluatorInput, fixedOptions(replayScope));
  assert(replayResult.run.id > 0);
  assert.strictEqual(db.inTransaction, true);
  db.exec('ROLLBACK');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total, 0);
}

/** 读取当前 run 的 imported strategy 输入闭包并断言两端均为 active imported ownership。 */
function readManagedStrategyInputRelations(db, runId) {
  return db.prepare(`SELECT relation.relation_id AS relationId, relation.run_id AS runId,
      source.registry_id AS fromRegistryId, source.entity_pk AS fromEntityPk,
      source.ownership_kind AS fromOwnershipKind, source.cleaned_at AS fromCleanedAt,
      target.registry_id AS toRegistryId, target.entity_pk AS toEntityPk,
      target.ownership_kind AS toOwnershipKind, target.cleaned_at AS toCleanedAt,
      relation.relation_type AS relationType
    FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.run_id = ? AND source.artifact_key = '15-energy-timeseries'
      AND source.entity_type = 'energy_timeseries'
      AND target.artifact_key = '18-strategy-rules'
      AND target.entity_type = 'strategy_rule'
    ORDER BY relation.relation_id`).all(runId);
}

/** 创建最小 managed artifact 15/18 导入场景，验证正式 ownership 自动生成 T×R 闭包。 */
function runManagedStrategyInputScenario(db, actorUserId, runRecord, reverseOrder) {
  const strategyRunCountBefore = Number(db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_evaluation_runs'
  ).get().total);
  const strategyHitCountBefore = Number(db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_rule_hits'
  ).get().total);
  const electricityId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, ?, ?, 'workshop', 'active')`).run(
    `MANAGED-STRATEGY-${reverseOrder ? 'R' : 'F'}-OU`,
    `managed strategy ${reverseOrder ? 'reverse' : 'forward'}`,
    `/managed-strategy-${reverseOrder ? 'reverse' : 'forward'}`
  ).lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'electricity', ?, ?, 'active')`).run(
    `MANAGED-STRATEGY-${reverseOrder ? 'R' : 'F'}-METER`,
    `managed strategy meter ${reverseOrder ? 'reverse' : 'forward'}`,
    electricityId,
    organizationUnitId
  ).lastInsertRowid);
  const timeseriesBatchId = insertImportBatch(
    db,
    'energy_timeseries',
    `managed-strategy-${reverseOrder ? 'reverse' : 'forward'}-timeseries.xlsx`
  );
  const ruleBatchId = insertImportBatch(
    db,
    'strategy_rule',
    `managed-strategy-${reverseOrder ? 'reverse' : 'forward'}-rules.xlsx`
  );
  const timeseriesBindings = [{ batchId: timeseriesBatchId, batchRole: 'primary' }];
  const ruleBindings = [{ batchId: ruleBatchId, batchRole: 'primary' }];
  const timeseriesContext = createPreviewedContext(db, {
    userId: actorUserId,
    runId: runRecord.runId,
    artifactKey: '15-energy-timeseries',
    handlerKey: 'energy-timeseries-import',
    batchBindings: timeseriesBindings
  });
  const ruleContext = createPreviewedContext(db, {
    userId: actorUserId,
    runId: runRecord.runId,
    artifactKey: '18-strategy-rules',
    handlerKey: 'strategy-rules-import',
    batchBindings: ruleBindings
  });
  const createTimeseriesRecords = () => [1, 2].map((rowNumber) => (
    insertEnergyTimeseriesWithWitness({
      batchId: timeseriesBatchId,
      sourceRowNumber: rowNumber,
      organizationUnitId,
      meterDeviceId,
      energyTypeId: electricityId,
      startUtc: `2026-08-29T00:${rowNumber === 1 ? '00' : '15'}:00.000Z`,
      endUtc: `2026-08-29T00:${rowNumber === 1 ? '15' : '30'}:00.000Z`,
      value: rowNumber * 10,
      reference: `managed-strategy-${reverseOrder ? 'reverse' : 'forward'}:timeseries:${rowNumber}`
    })
  ));
  const createRuleRecords = () => [1, 2].map((rowNumber) => (
    insertStrategyRuleWithWitness({
      batchId: ruleBatchId,
      sourceRowNumber: rowNumber,
      ruleCode: `MANAGED-STRATEGY-${reverseOrder ? 'R' : 'F'}-${rowNumber}`,
      ruleName: `managed strategy rule ${rowNumber}`
    })
  ));
  let firstImportResult;
  let secondImportResult;
  if (!reverseOrder) {
    firstImportResult = runImmediateTransaction(db, () => {
      const records = createTimeseriesRecords();
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db, actorUserId, timeseriesContext, timeseriesBindings,
        { insertedRecords: records, noInsertedRecords: false }
      ));
    });
    assert.strictEqual(firstImportResult.relationCount, 0,
      'artifact 15 先登记时 artifact 18 尚不存在，不得生成不完整关系。');
    secondImportResult = runImmediateTransaction(db, () => {
      const records = createRuleRecords();
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db, actorUserId, ruleContext, ruleBindings,
        { insertedRecords: records, noInsertedRecords: false }
      ));
    });
  } else {
    firstImportResult = runImmediateTransaction(db, () => {
      const records = createRuleRecords();
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db, actorUserId, ruleContext, ruleBindings,
        { insertedRecords: records, noInsertedRecords: false }
      ));
    });
    assert.strictEqual(firstImportResult.relationCount, 0,
      'artifact 18 先登记时 artifact 15 尚不存在，不得生成不完整关系。');
    secondImportResult = runImmediateTransaction(db, () => {
      const records = createTimeseriesRecords();
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db, actorUserId, timeseriesContext, timeseriesBindings,
        { insertedRecords: records, noInsertedRecords: false }
      ));
    });
  }
  assert.strictEqual(secondImportResult.relationCount, 4,
    '两条时序与两条规则必须生成完整 2×2 imported uses_config 闭包。');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total),
    strategyRunCountBefore, 'artifact 15/18 ownership 登记不得创建 strategy evaluation run。');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total),
    strategyHitCountBefore, 'artifact 15/18 ownership 登记不得创建 strategy rule hit。');
  let relations = readManagedStrategyInputRelations(db, runRecord.runId);
  assert.strictEqual(relations.length, 4);
  relations.forEach((relation) => {
    assert.strictEqual(relation.runId, runRecord.runId);
    assert.strictEqual(relation.relationType, 'uses_config');
    assert.strictEqual(relation.fromOwnershipKind, 'imported');
    assert.strictEqual(relation.toOwnershipKind, 'imported');
    assert.strictEqual(relation.fromCleanedAt, null);
    assert.strictEqual(relation.toCleanedAt, null);
  });

  const retryContext = reverseOrder ? timeseriesContext : ruleContext;
  const retryBindings = reverseOrder ? timeseriesBindings : ruleBindings;
  const retryResult = runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
    buildOwnershipInput(db, actorUserId, retryContext, retryBindings, {
      insertedRecords: [],
      noInsertedRecords: true,
      skippedRecords: []
    })
  ));
  assert.strictEqual(retryResult.relationCount, 4, '重复 managed execute 必须返回完整既有闭包数量。');
  assert.strictEqual(retryResult.relations.length, 4);
  assert(retryResult.relations.every((relation) => relation.result === 'idempotent'));
  assert.strictEqual(readManagedStrategyInputRelations(db, runRecord.runId).length, 4,
    '重复 managed execute 不得增加 relation。');

  const cleanedEntityType = reverseOrder ? 'strategy_rule' : 'energy_timeseries';
  const cleanedEntityPk = reverseOrder
    ? relations[0].toEntityPk
    : relations[0].fromEntityPk;
  const cleanupRunId = `managed-strategy-${reverseOrder ? 'reverse' : 'forward'}-cleanup`;
  db.prepare(`INSERT INTO demo_cleanup_runs
    (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
     runtime_revision, registry_watermark, status)
    VALUES (?, ?, ?, ?, ?, 1, ?, 'succeeded')`).run(
    cleanupRunId,
    runRecord.runId,
    `${cleanupRunId}-request`,
    'c'.repeat(64),
    '2026-08-30T00:00:00.000Z',
    'managed-strategy-watermark'
  );
  const cleanedRegistry = db.prepare(`SELECT registry_id AS registryId FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ? AND entity_pk = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
    runRecord.runId,
    reverseOrder ? '18-strategy-rules' : '15-energy-timeseries',
    cleanedEntityType,
    String(cleanedEntityPk)
  );
  assert(cleanedRegistry, 'active imported 输入必须存在以验证 cleanup 后过滤。');
  db.prepare(`UPDATE demo_data_registry
    SET cleaned_at = '2026-08-29T01:00:00.000Z', cleanup_run_id = ?, cleanup_result = 'deleted'
    WHERE registry_id = ?`).run(cleanupRunId, cleanedRegistry.registryId);
  const filteredRetryResult = runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
    buildOwnershipInput(db, actorUserId, retryContext, retryBindings, {
      insertedRecords: [],
      noInsertedRecords: true,
      skippedRecords: []
    })
  ));
  assert.strictEqual(filteredRetryResult.relationCount, 2,
    'strategy 输入闭包只能使用当前 run 的 active imported ownership。');
  assert(filteredRetryResult.relations.every((relation) => relation.result === 'idempotent'));

  const failureBatchId = insertImportBatch(
    db,
    'strategy_rule',
    `managed-strategy-${reverseOrder ? 'reverse' : 'forward'}-failure.xlsx`
  );
  const failureBindings = [{ batchId: failureBatchId, batchRole: 'primary' }];
  const failureContext = createPreviewedContext(db, {
    userId: actorUserId,
    runId: runRecord.runId,
    artifactKey: '18-strategy-rules',
    handlerKey: 'strategy-rules-import',
    batchBindings: failureBindings
  });
  const failureRuleCode = `MANAGED-STRATEGY-${reverseOrder ? 'R' : 'F'}-FAILURE`;
  db.exec(`CREATE TRIGGER managed_strategy_relation_failure
    BEFORE INSERT ON demo_data_relations
    WHEN NEW.run_id = '${runRecord.runId}'
    BEGIN SELECT RAISE(ABORT, 'managed strategy relation failure'); END`);
  let failedRulePk = null;
  assertErrorCode(() => runImmediateTransaction(db, () => {
    const record = insertStrategyRuleWithWitness({
      batchId: failureBatchId,
      sourceRowNumber: 1,
      ruleCode: failureRuleCode,
      ruleName: 'managed strategy relation failure'
    });
    failedRulePk = record.entityPk;
    return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
      db, actorUserId, failureContext, failureBindings,
      { insertedRecords: [record], noInsertedRecords: false }
    ));
  }), 'DEMO_OWNERSHIP_RELATION_WRITE_FAILED');
  db.exec('DROP TRIGGER managed_strategy_relation_failure');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
    .get(failedRulePk).total, 0, 'relation 写失败必须回滚策略规则业务行。');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(failedRulePk)).total, 0,
  'relation 写失败必须回滚 strategy_rule ownership。');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_run_import_batches
    WHERE context_id = ?`).get(failureContext.contextId).total, 1,
  'relation 写失败必须保留 preview 已持久绑定的唯一 batch link，不得重复补写。');
  assert.strictEqual(db.prepare(`SELECT status FROM demo_import_contexts WHERE context_id = ?`)
    .get(failureContext.contextId).status, 'previewed',
  'relation 写失败必须回滚 execute 侧状态并保留 context 可重试。');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE rule_code = ?')
    .get(failureRuleCode).total, 0);

  db.prepare(`UPDATE demo_dataset_runs
    SET status = 'cleaned', cleaned_at = '2026-08-29T02:00:00.000Z'
    WHERE run_id = ?`).run(runRecord.runId);
  const nextRun = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });
  assert.notStrictEqual(nextRun.runId, runRecord.runId);
  return nextRun;
}

/** 执行 ownership 固定投影、row witness 与隔离 SQLite 原子登记测试。 */
async function run() {
  assert.strictEqual(DEMO_OWNERSHIP_REGISTRATION_CONNECTED, false,
    '公共登记基础不得提前开启 cleanup capability');
  const directFormalNoop = registerImportedDemoOwnershipInTransaction({ demoContext: null });
  assert.strictEqual(directFormalNoop.applied, false);
  assert.strictEqual(directFormalNoop.reason, 'demo_context_absent');
  testPredictionDerivedOwnershipHandlers();
  testStrategyDerivedOwnershipHandlers();

  initDatabase();
  const db = openDatabase();
  try {
    const admin = getTestDatabase(db).prepare(`SELECT u.id FROM sys_users u
      JOIN sys_user_roles ur ON ur.user_id = u.id
      JOIN sys_roles r ON r.id = ur.role_id
      WHERE u.status = 'active' AND r.status = 'active' AND r.role_code = 'super_admin'
      ORDER BY u.id LIMIT 1`).get();
    assert(admin, '隔离库必须存在 active 超级管理员');
    const actorUserId = Number(admin.id);
    toggleDemoRuntime({ enabled: true, actorUserId, actorIp: '127.0.0.1' });
    let runRecord = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });

    const formalNoop = runRawImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction({
      db,
      demoContext: null,
      insertedRecords: null
    }));
    assert.strictEqual(formalNoop.applied, false);
    assert.strictEqual(formalNoop.reason, 'demo_context_absent');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total, 0);

    const predictionBatchId = insertImportBatch(db, 'prediction_config', 'prediction-operation-guard.xlsx');
    const predictionBindings = [{ batchId: predictionBatchId, batchRole: 'primary' }];
    const predictionContext = createPreviewedContext(db, {
      userId: actorUserId,
      runId: runRecord.runId,
      artifactKey: '12-prediction-configs',
      handlerKey: 'prediction-configs-import',
      batchBindings: predictionBindings
    });
    const fixtureBatchId = insertImportBatch(db, 'strategy_rule', 'ownership-fixture-rules.xlsx');
    const fixtureBindings = [{ batchId: fixtureBatchId, batchRole: 'primary' }];
    const fixtureContext = createPreviewedContext(db, {
      userId: actorUserId,
      runId: runRecord.runId,
      artifactKey: '18-strategy-rules',
      handlerKey: 'strategy-rules-import',
      batchBindings: fixtureBindings
    });

    assertErrorCode(() => runRawImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction({
        ...buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings),
        transactionScope: null
      })
    )), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');
    assertErrorCode(() => runRawImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: null,
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
      sourceRowNumber: 2,
      insertSql: `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      insertParams: [predictionBatchId, 2, 'missing-scope']
    })), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
      sourceRowNumber: 2,
      insertSql: `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      insertParams: [predictionBatchId, 2, 'split-insert-forbidden']
    })), 'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED');
    assertErrorCode(() => runImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings
      ))
    )), 'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      getTestDatabase(db).exec('COMMIT; BEGIN IMMEDIATE');
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      getTestDatabase(db).prepare('COMMIT');
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');

    let legacyInsertCalled = false;
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'strategy_rule',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 2,
      insert: () => {
        legacyInsertCalled = true;
        return { changes: 1, lastInsertRowid: 1 };
      }
    })), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(legacyInsertCalled, false, '旧 insert callback API 必须在执行 callback 前被拒绝');

    // 保存外部连接 raw exec 与原型方法；ownership 私有事务不得受其事务控制影响。
    const externalRawExec = db.exec;
    const externalPrototypeExec = Object.getPrototypeOf(db).exec;
    const assertPrivateRollbackAfterExternalMutation = (mutation, sourceRowNumber, label) => {
      let entityPk = null;
      externalRawExec.call(db, 'BEGIN');
      try {
        assertErrorCode(() => runImmediateTransaction(db, () => {
          mutation();
          const record = insertStrategyFixtureWithWitness(db, {
            batchId: fixtureBatchId,
            sourceRowNumber,
            name: label
          });
          entityPk = record.entityPk;
          registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
            db,
            actorUserId,
            fixtureContext,
            fixtureBindings,
            {
              insertedRecords: [record],
              noInsertedRecords: false,
              relations: [{
                from: { entityType: 'strategy_rule', entityPk: record.entityPk },
                to: { entityType: 'strategy_rule', entityPk: 999999 },
                relationType: 'uses_config'
              }]
            }
          ));
        }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
      } finally {
        if (db.inTransaction) externalRawExec.call(db, 'ROLLBACK');
      }
      assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
        .get(entityPk).total, 0, `${label} 后业务行必须回滚`);
      assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(entityPk)).total, 0,
      `${label} 后 registry 必须回滚`);
    };
    assertPrivateRollbackAfterExternalMutation(
      () => externalRawExec.call(db, 'COMMIT; BEGIN'),
      2,
      'external-raw-commit-rebegin'
    );
    assertPrivateRollbackAfterExternalMutation(
      () => externalPrototypeExec.call(db, 'COMMIT; BEGIN'),
      3,
      'external-prototype-commit-rebegin'
    );
    assertPrivateRollbackAfterExternalMutation(
      () => externalRawExec.call(db, 'ROLLBACK'),
      4,
      'external-raw-rollback'
    );
    assertPrivateRollbackAfterExternalMutation(
      () => {
        try {
          externalRawExec.call(db, 'COMMIT; BEGIN IMMEDIATE');
        } catch (_error) {
          // 外部连接可能因私有写锁拒绝重新开始，但不应影响私有事务 scope。
        }
      },
      5,
      'external-raw-commit-rebegin-immediate'
    );
    assert.strictEqual(db.exec, externalRawExec, 'ownership wrapper 不得 monkey-patch 外部连接 exec');
    assert.strictEqual(Object.getPrototypeOf(db).exec, externalPrototypeExec,
      'ownership wrapper 不得修改外部连接原型事务方法');

    // facade 只提供 readonly prepare().get/all，statement 不携带 database/raw connection。
    const officialConnectionsBeforeFacadeTest = getDatabaseAdmissionState().activeConnections;
    let expiredDatabaseFacade = null;
    let expiredStatementFacade = null;
    runWithDemoOwnershipTransaction(process.env.SQLITE_PATH, (transactionScope, databaseFacade) => {
      expiredDatabaseFacade = databaseFacade;
      assert.strictEqual(getDatabaseAdmissionState().activeConnections,
        officialConnectionsBeforeFacadeTest + 1, 'scope callback 内必须由独立私有连接持有事务');
      assert.strictEqual(Object.getPrototypeOf(transactionScope), null);
      assert.strictEqual(Object.getPrototypeOf(databaseFacade), null);
      const statement = databaseFacade.prepare('SELECT 1 AS value');
      expiredStatementFacade = statement;
      assert.strictEqual(Object.getPrototypeOf(statement), null);
      assert.deepStrictEqual(Object.keys(transactionScope).sort(), ['db', 'facade']);
      assert.deepStrictEqual(Object.keys(databaseFacade).sort(),
        ['close', 'exec', 'inTransaction', 'prepare', 'transaction']);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(databaseFacade, 'name'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(databaseFacade, 'pragma'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(databaseFacade, 'open'), false);
      assert.strictEqual(Object.isFrozen(transactionScope), true);
      assert.strictEqual(Object.isFrozen(databaseFacade), true);
      assert.strictEqual(Object.isFrozen(statement), true);
      assert.strictEqual(statement.get().value, 1);
      assert.deepStrictEqual(statement.all(), [{ value: 1 }]);
      assert.deepStrictEqual(Object.keys(statement).sort(), ['all', 'get']);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(statement, 'run'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(statement, 'database'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(statement, 'raw'), false);
      assert.strictEqual(transactionScope.db, databaseFacade);
      assert.strictEqual(databaseFacade.inTransaction, true);
    });
    assert.strictEqual(expiredDatabaseFacade.inTransaction, false, 'scope callback 返回后 facade 必须失效');
    assert.strictEqual(getDatabaseAdmissionState().activeConnections,
      officialConnectionsBeforeFacadeTest, 'scope callback 完成后私有 SQLite 连接必须关闭');
    assertErrorCode(() => expiredDatabaseFacade.prepare('SELECT 1'),
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');
    assertErrorCode(() => expiredStatementFacade.get(),
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');
    assertErrorCode(() => runWithDemoOwnershipTransaction(process.env.SQLITE_PATH, (_transactionScope, databaseFacade) => {
      databaseFacade.exec('SELECT 1');
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');
    assertErrorCode(() => runWithDemoOwnershipTransaction(process.env.SQLITE_PATH, (_transactionScope, databaseFacade) => {
      databaseFacade.transaction(() => null);
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');
    assertErrorCode(() => runWithDemoOwnershipTransaction(process.env.SQLITE_PATH, (_transactionScope, databaseFacade) => {
      databaseFacade.close();
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');

    // async callback 必须先消费 Promise rejection，再同步拒绝并回滚，且不产生 unhandledRejection。
    let unhandledRejection = null;
    const unhandledRejectionHandler = (error) => {
      unhandledRejection = error;
    };
    process.on('unhandledRejection', unhandledRejectionHandler);
    const rejectedCallbackPromise = Promise.reject(new Error('async-callback-rejection'));
    assertErrorCode(() => runWithDemoOwnershipTransaction(process.env.SQLITE_PATH,
      () => rejectedCallbackPromise), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_ASYNC_FORBIDDEN');
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
    assert.strictEqual(unhandledRejection, null, '拒绝 async callback 不得产生 unhandledRejection');

    let thenableRejectionConsumerAttached = false;
    const rejectedThenable = {
      then(_resolve, reject) {
        thenableRejectionConsumerAttached = typeof reject === 'function';
        reject(new Error('thenable-rejection'));
        return Promise.resolve();
      }
    };
    assertErrorCode(() => runWithDemoOwnershipTransaction(process.env.SQLITE_PATH,
      () => rejectedThenable), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_ASYNC_FORBIDDEN');
    assert.strictEqual(thenableRejectionConsumerAttached, true,
      '拒绝 thenable callback 前必须绑定 rejection consumer');

    // 合法 witness 已登记后，任意 facade 写 SQL/DDL/PRAGMA 仍必须 poison scope 并整体回滚。
    const forbiddenFacadeSqlCases = [
      {
        label: 'insert',
        sql: `INSERT INTO prediction_configs
          (source_batch_id, source_row_number, name, train_start_month, train_end_month,
            predict_start_month, predict_end_month, algorithm, status)
          VALUES (${fixtureBatchId}, 20, 'facade-extra-row', '2025-01', '2025-12',
            '2026-01', '2026-02', 'moving_average', 'active')`
      },
      { label: 'update', sql: "UPDATE prediction_configs SET note = 'forbidden' WHERE id = 1" },
      { label: 'delete', sql: 'DELETE FROM prediction_configs WHERE id = 1' },
      { label: 'ddl', sql: 'CREATE TABLE ownership_forbidden_ddl (id INTEGER PRIMARY KEY)' },
      { label: 'pragma', sql: 'PRAGMA user_version = 49' }
    ];
    forbiddenFacadeSqlCases.forEach((testCase, index) => {
      let registeredEntityPk = null;
      assertErrorCode(() => runImmediateTransaction(db, (databaseFacade) => {
        const registeredRecord = insertStrategyFixtureWithWitness(db, {
          batchId: fixtureBatchId,
          sourceRowNumber: 20 + index,
          name: `facade-${testCase.label}-rollback`
        });
        registeredEntityPk = registeredRecord.entityPk;
        registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
          db,
          actorUserId,
          fixtureContext,
          fixtureBindings,
          { insertedRecords: [registeredRecord], noInsertedRecords: false }
        ));
        databaseFacade.prepare(testCase.sql);
      }), 'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
        .get(registeredEntityPk).total, 0, `${testCase.label} 尝试后业务行必须回滚`);
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(registeredEntityPk)).total, 0,
      `${testCase.label} 尝试后 registry 必须回滚`);
    });
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'table' AND name = 'ownership_forbidden_ddl'`).get().total, 0,
    'facade DDL 不得创建表');
    assert.notStrictEqual(db.pragma('user_version', { simple: true }), 49, 'facade 写 PRAGMA 不得生效');

    let caughtForbiddenWritePk = null;
    assertErrorCode(() => runImmediateTransaction(db, (databaseFacade) => {
      const registeredRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 26,
        name: 'caught-facade-write-must-poison'
      });
      caughtForbiddenWritePk = registeredRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [registeredRecord], noInsertedRecords: false }
      ));
      assertErrorCode(() => databaseFacade.prepare("UPDATE prediction_configs SET note = 'caught' WHERE id = 1"),
        'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
    }), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(caughtForbiddenWritePk).total, 0, '调用方捕获 facade 写错误后 scope 仍必须回滚');

    // 声明式 helper 只接受当前 handler 单表、单条纯 INSERT VALUES。
    const invalidInsertSqlCases = [
      `INSERT INTO import_batches
        (import_type, original_filename, file_type, status, audit_phase, total_rows)
        VALUES ('prediction_config', 'wrong-table.xlsx', 'xlsx', 'completed', 'execute', 1)`,
      `WITH source AS (SELECT 1) INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      `INSERT OR IGNORE INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active') RETURNING id`,
      `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active'); SELECT 1`
    ];
    invalidInsertSqlCases.forEach((insertSql, index) => {
      assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
        transactionScope: activeTestTransactionScope,
        entityType: 'strategy_rule',
        sourceBatchId: fixtureBatchId,
        sourceRowNumber: 30 + index,
        insertSql,
        insertParams: insertSql.includes('?')
          ? [fixtureBatchId, 30 + index, `invalid-sql-${index}`]
          : []
      })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');
    });
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'energy_record',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 40,
      insertSql: `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      insertParams: [fixtureBatchId, 40, 'wrong-handler-table']
    })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');

    // 旧 callback API 的 getter/Proxy 必须在任何重入代码执行前被拒绝。
    let legacyGetterCalled = false;
    const legacyGetterInput = {
      transactionScope: null,
      entityType: 'strategy_rule',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 41
    };
    Object.defineProperty(legacyGetterInput, 'insert', {
      enumerable: true,
      get() {
        legacyGetterCalled = true;
        return () => ({ changes: 1, lastInsertRowid: 1 });
      }
    });
    let legacyGetterRollbackPk = null;
    assertErrorCode(() => runImmediateTransaction(db, (_databaseFacade, transactionScope) => {
      const registeredRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 41,
        name: 'legacy-getter-rollback'
      });
      legacyGetterRollbackPk = registeredRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [registeredRecord], noInsertedRecords: false }
      ));
      legacyGetterInput.transactionScope = transactionScope;
      createDemoOwnershipInsertWitness(legacyGetterInput);
    }), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(legacyGetterCalled, false, '旧 API getter 不得执行');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(legacyGetterRollbackPk).total, 0, '旧 API getter 输入必须使已登记业务行整体回滚');

    let legacyProxyTrapCalled = false;
    const legacyProxyInput = new Proxy({
      transactionScope: null,
      entityType: 'strategy_rule',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 42,
      insert: () => ({ changes: 1, lastInsertRowid: 1 })
    }, {
      ownKeys(target) {
        legacyProxyTrapCalled = true;
        return Reflect.ownKeys(target);
      }
    });
    assertErrorCode(() => runImmediateTransaction(db, () => {
      createDemoOwnershipInsertWitness(legacyProxyInput);
    }), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(legacyProxyTrapCalled, false, '旧 API Proxy trap 不得执行');

    // 外部连接的预保存 statement 不能作为新声明式 witness API 的输入。
    const externalInsertStatement = db.prepare(`INSERT INTO prediction_configs
      (source_batch_id, source_row_number, name, train_start_month, train_end_month,
        predict_start_month, predict_end_month, algorithm, status)
      VALUES (?, 13, 'external-witness-attempt', '2025-01', '2025-12', '2026-01', '2026-02',
        'moving_average', 'active')`);
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'strategy_rule',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 13,
      insert: () => externalInsertStatement.run(fixtureBatchId)
    })), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM prediction_configs WHERE name = 'external-witness-attempt'")
      .get().total, 0, '旧预保存 statement 不能通过 witness API 写入业务行');

    let expiredTransactionScope = null;
    runImmediateTransaction(db, (_databaseFacade, transactionScope) => {
      expiredTransactionScope = transactionScope;
    });
    assertErrorCode(() => runRawImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction({
        ...buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings),
        transactionScope: expiredTransactionScope
      })
    )), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');

    const projectionFixtureId = Number(db.prepare(`INSERT INTO prediction_configs
      (source_batch_id, source_row_number, name, train_start_month, train_end_month,
        predict_start_month, predict_end_month, algorithm, window_size, status)
      VALUES (?, 2, 'projection-fixture', '2025-01', '2025-12', '2026-01', '2026-02',
        'moving_average', 3, 'active')`).run(fixtureBatchId).lastInsertRowid);
    const projectionFixture = {
      record: { entityPk: projectionFixtureId },
      row: db.prepare('SELECT * FROM prediction_configs WHERE id = ?').get(projectionFixtureId)
    };
    const canonicalA = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: projectionFixture.row
    });
    const canonicalB = ownershipTest.buildDemoEntityRegistrationContract({
      row: { ...projectionFixture.row },
      entityPk: String(projectionFixture.record.entityPk),
      entityType: 'prediction_config'
    });
    assert.deepStrictEqual(canonicalA, canonicalB, 'fixed projection canonical JSON 必须稳定');
    assert.strictEqual(canonicalA.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(canonicalA.snapshotDigest, calculateDemoEntitySnapshotDigest(
      'prediction_config', String(projectionFixture.record.entityPk), projectionFixture.row
    ), 'registrar 与 cleanup 必须复用同一 v1 projection helper');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: projectionFixture.row,
      snapshot: projectionFixture.row
    }), 'DEMO_OWNERSHIP_REGISTRATION_FIELDS_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: { ...projectionFixture.row, callerMetadata: 'forbidden' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELDS_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: Object.assign(Object.create({ inherited: true }), projectionFixture.row)
    }), 'DEMO_OWNERSHIP_SNAPSHOT_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: []
    }), 'DEMO_OWNERSHIP_SNAPSHOT_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: { ...projectionFixture.row, created_at: projectionFixture.row.created_at.replace(/\.\d{3}Z$/, 'Z') }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: { ...projectionFixture.row, window_size: 3.5 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'prediction_config',
      entityPk: projectionFixture.record.entityPk,
      row: { ...projectionFixture.row, note: ['forbidden'] }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    const energyProjectionRow = {
      id: 1,
      source_batch_id: 1,
      source_row_number: 2,
      energy_type_id: 1,
      organization_unit_id: 1,
      meter_device_id: null,
      original_month: '2026-08',
      normalized_month: '2026-08',
      original_unit: 'kWh',
      original_value: 12.5,
      normalized_unit: 'kWh',
      normalized_value: 12.5,
      remark: null,
      duplicate_key: 'ownership-energy-1',
      record_status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const energyContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_record',
      entityPk: 1,
      row: energyProjectionRow
    });
    assert.strictEqual(energyContract.projectionVersion, 'demo-entity-snapshot:v1');
    const shiftHandler = DEMO_OWNERSHIP_ENTITY_HANDLERS.shift_definition;
    assert(shiftHandler, 'artifact 13 必须存在固定 shift_definition ownership handler。');
    assert.deepStrictEqual(shiftHandler.expectedImportTypes, ['shift_definition']);
    assert.deepStrictEqual(shiftHandler.projectionFields, [
      'id', 'source_batch_id', 'source_row_number', 'shift_code', 'shift_name',
      'start_minute', 'end_minute', 'crosses_midnight', 'source_timezone', 'source',
      'version', 'effective_start_utc', 'effective_end_utc', 'status', 'created_at', 'updated_at'
    ]);
    const shiftProjectionRow = {
      id: 1,
      source_batch_id: 2,
      source_row_number: 3,
      shift_code: 'QL-SHIFT-NIGHT',
      shift_name: '天坤集团夜班',
      start_minute: 1200,
      end_minute: 480,
      crosses_midnight: 1,
      source_timezone: 'Asia/Shanghai',
      source: '天坤集团排班制度',
      version: 'QL-SHIFT:v1',
      effective_start_utc: '2025-01-01T00:00:00.000Z',
      effective_end_utc: '2027-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const shiftContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'shift_definition',
      entityPk: 1,
      row: shiftProjectionRow
    });
    assert.strictEqual(shiftContract.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(shiftContract.snapshotDigest,
      calculateDemoEntitySnapshotDigest('shift_definition', 1, shiftProjectionRow));
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'shift_definition',
      entityPk: 1,
      row: { ...shiftProjectionRow, start_minute: 1440 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'shift_definition',
      entityPk: 1,
      row: { ...shiftProjectionRow, crosses_midnight: 0 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'shift_definition',
      entityPk: 1,
      row: { ...shiftProjectionRow, effective_start_utc: '2025-01-01T00:00:00Z' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'shift_definition',
      entityPk: 1,
      row: { ...shiftProjectionRow, source_timezone: 'Not/A-TimeZone' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

    // artifact 15 固定 ownership handler 必须覆盖完整时序业务投影和值域。
    const energyTimeseriesHandler = DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_timeseries;
    assert(energyTimeseriesHandler, 'artifact 15 必须存在固定 energy_timeseries ownership handler。');
    assert.deepStrictEqual(energyTimeseriesHandler.expectedImportTypes, ['energy_timeseries']);
    assert.deepStrictEqual(energyTimeseriesHandler.projectionFields, [
      'id', 'source_batch_id', 'source_row_number', 'organization_unit_id',
      'meter_device_id', 'energy_type_id', 'start_utc', 'end_utc',
      'source_timezone', 'granularity_minutes', 'original_unit', 'original_value',
      'normalized_unit', 'normalized_value', 'source_reference', 'data_source',
      'record_status', 'void_reason', 'voided_at', 'created_at', 'updated_at'
    ]);
    // 合法时序 ownership 投影固定为十五分钟左闭右开区间。
    const energyTimeseriesProjectionRow = {
      id: 1,
      source_batch_id: 3,
      source_row_number: 2,
      organization_unit_id: 1,
      meter_device_id: null,
      energy_type_id: 1,
      start_utc: '2026-08-27T00:00:00Z',
      end_utc: '2026-08-27T00:15:00Z',
      source_timezone: 'Asia/Shanghai',
      granularity_minutes: 15,
      original_unit: 'kWh',
      original_value: 12.5,
      normalized_unit: 'kWh',
      normalized_value: 12.5,
      source_reference: 'ownership-timeseries-1',
      data_source: 'upload',
      record_status: 'active',
      void_reason: null,
      voided_at: null,
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    // 合法时序投影生成稳定 registration contract。
    const energyTimeseriesContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: energyTimeseriesProjectionRow
    });
    assert.strictEqual(energyTimeseriesContract.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(energyTimeseriesContract.snapshotDigest,
      calculateDemoEntitySnapshotDigest('energy_timeseries', 1, energyTimeseriesProjectionRow));
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, source_row_number: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, granularity_minutes: 15.5 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, end_utc: '2026-08-27T00:30:00Z' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, normalized_value: -1 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, source_timezone: 'Not/A-TimeZone' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_timeseries',
      entityPk: 1,
      row: { ...energyTimeseriesProjectionRow, record_status: 'active', void_reason: '不应存在' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

    // artifact 18 固定 ownership handler 必须覆盖完整策略规则投影和值域。
    const strategyRuleHandler = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule;
    assert(strategyRuleHandler, 'artifact 18 必须存在固定 strategy_rule ownership handler。');
    assert.deepStrictEqual(strategyRuleHandler.expectedImportTypes, ['strategy_rule']);
    assert.deepStrictEqual(strategyRuleHandler.projectionFields, [
      'id', 'source_batch_id', 'source_row_number', 'rule_code', 'rule_name',
      'rule_version', 'formula_version', 'metric_code', 'threshold_operator',
      'threshold_value', 'threshold_min', 'threshold_max', 'threshold_unit',
      'reduction_rate', 'priority', 'evidence_requirements_json', 'recommendation_text',
      'source', 'effective_start_utc', 'effective_end_utc', 'source_timezone',
      'status', 'created_at', 'updated_at'
    ]);
    // 合法策略规则投影仅携带受控公式、指标、阈值和证据要求。
    const strategyRuleProjectionRow = {
      id: 1,
      source_batch_id: 4,
      source_row_number: 2,
      rule_code: 'LOAD-RATE-HIGH',
      rule_name: '负荷率偏高提示',
      rule_version: 'load-rate-high:v1',
      formula_version: 'load-analysis:v1',
      metric_code: 'load_rate',
      threshold_operator: 'gte',
      threshold_value: 80,
      threshold_min: null,
      threshold_max: null,
      threshold_unit: '%',
      reduction_rate: 0.1,
      priority: 'high',
      evidence_requirements_json: JSON.stringify({
        minimumCoverageRate: 1,
        maxEvidenceItems: 10,
        savingBasis: 'window_total_energy'
      }),
      recommendation_text: '请人工复核高负荷时段。',
      source: 'ownership 测试',
      effective_start_utc: '2026-01-01T00:00:00.000Z',
      effective_end_utc: '2027-01-01T00:00:00.000Z',
      source_timezone: 'Asia/Shanghai',
      status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    // 合法策略投影生成稳定 registration contract。
    const strategyRuleContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: strategyRuleProjectionRow
    });
    assert.strictEqual(strategyRuleContract.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(strategyRuleContract.snapshotDigest,
      calculateDemoEntitySnapshotDigest('strategy_rule', 1, strategyRuleProjectionRow));
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, source_batch_id: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, formula_version: 'dynamic:v1' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, threshold_operator: 'between', threshold_value: 80 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, reduction_rate: 1.1 }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, evidence_requirements_json: '{"command":"shutdown"}' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, effective_end_utc: strategyRuleProjectionRow.effective_start_utc }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'strategy_rule',
      entityPk: 1,
      row: { ...strategyRuleProjectionRow, source_timezone: 'Not/A-TimeZone' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_record',
      entityPk: 1,
      row: { ...energyProjectionRow, original_value: Number.POSITIVE_INFINITY }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_record',
      entityPk: 1,
      row: { ...energyProjectionRow, normalized_value: '12.5' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_record',
      entityPk: 1,
      row: { ...energyProjectionRow, remark: ['forbidden'] }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID');
    const flowModelHandler = DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_flow_model;
    assert(flowModelHandler, 'artifact 22 必须存在固定 energy_flow_model ownership handler。');
    assert.deepStrictEqual(flowModelHandler.expectedImportTypes, ['energy_flow_model']);
    assert.deepStrictEqual(flowModelHandler.projectionFields, [
      'id', 'source_batch_id', 'source_row_number', 'model_code', 'model_name', 'source', 'document_no',
      'version', 'effective_start_wall_clock', 'effective_end_wall_clock', 'effective_start_utc',
      'effective_end_utc', 'source_timezone', 'classification_status', 'source_mode', 'status',
      'created_at', 'updated_at'
    ]);
    const flowModelProjectionRow = {
      id: 1,
      source_batch_id: 1,
      source_row_number: 2,
      model_code: 'QL-FLOW-MODEL-01',
      model_name: '天坤集团演示能流模型',
      source: '天坤集团演示工作簿',
      document_no: 'QL-FLOW-DOC-2026',
      version: 'energy-flow:v1',
      effective_start_wall_clock: '2026-01-01T08:00',
      effective_end_wall_clock: '2027-01-01T08:00',
      effective_start_utc: '2026-01-01T00:00:00Z',
      effective_end_utc: '2027-01-01T00:00:00Z',
      source_timezone: 'Asia/Shanghai',
      classification_status: 'workbook_facts',
      source_mode: 'workbook_facts_only',
      status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const flowModelContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_model',
      entityPk: 1,
      row: flowModelProjectionRow
    });
    assert.strictEqual(flowModelContract.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(flowModelContract.identityJson,
      JSON.stringify({ entityType: 'energy_flow_model', entityPk: '1' }));
    assert.strictEqual(flowModelContract.snapshotDigest,
      calculateDemoEntitySnapshotDigest('energy_flow_model', 1, flowModelProjectionRow));
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_model',
      entityPk: 1,
      row: { ...flowModelProjectionRow, source_row_number: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_model',
      entityPk: 1,
      row: { ...flowModelProjectionRow, effective_start_utc: '2026-01-01T00:00:00.000Z' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_model',
      entityPk: 1,
      row: { ...flowModelProjectionRow, source_mode: 'legacy_explicit_sources' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_model',
      entityPk: 1,
      row: {
        ...flowModelProjectionRow,
        effective_start_wall_clock: null,
        effective_end_wall_clock: null
      }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

    const flowNodeHandler = DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_flow_node;
    assert(flowNodeHandler, 'artifact 23 必须存在固定 energy_flow_node ownership handler。');
    assert.deepStrictEqual(flowNodeHandler.expectedImportTypes, ['energy_flow_node']);
    assert.deepStrictEqual(flowNodeHandler.projectionFields, [
      'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'energy_flow_asset_id',
      'node_code', 'node_name', 'node_type', 'stage_code', 'organization_unit_id', 'x', 'y',
      'status', 'created_at', 'updated_at'
    ]);
    const flowNodeProjectionRow = {
      id: 1,
      source_batch_id: 2,
      source_row_number: 3,
      energy_flow_model_id: 1,
      energy_flow_asset_id: null,
      node_code: 'QL-FLOW-NODE-01',
      node_name: '天坤集团演示配电节点',
      node_type: 'process',
      stage_code: 'distribution',
      organization_unit_id: null,
      x: 120.5,
      y: 80,
      status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const flowNodeContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_node',
      entityPk: 1,
      row: flowNodeProjectionRow
    });
    assert.strictEqual(flowNodeContract.projectionVersion, 'demo-entity-snapshot:v1');
    assert.strictEqual(flowNodeContract.identityJson,
      JSON.stringify({ entityType: 'energy_flow_node', entityPk: '1' }));
    assert.strictEqual(flowNodeContract.snapshotDigest,
      calculateDemoEntitySnapshotDigest('energy_flow_node', 1, flowNodeProjectionRow));
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_node',
      entityPk: 1,
      row: { ...flowNodeProjectionRow, source_batch_id: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_node',
      entityPk: 1,
      row: { ...flowNodeProjectionRow, source_batch_id: null, source_row_number: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_node',
      entityPk: 1,
      row: { ...flowNodeProjectionRow, stage_code: 'not-a-stage' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_node',
      entityPk: 1,
      row: { ...flowNodeProjectionRow, y: null }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

    const flowEdgeProjectionRow = {
      id: 1,
      source_batch_id: 1,
      source_row_number: 3,
      energy_flow_model_id: 1,
      energy_flow_path_id: null,
      path_sequence: null,
      edge_code: 'QL-FLOW-E-01',
      from_node_id: 1,
      to_node_id: 2,
      energy_type_id: 1,
      unit: 'kWh',
      source_type: 'explicit_edge_value',
      source_reference: null,
      source_mapping_json: '{"reference":"edge:QL-FLOW-E-01"}',
      status: 'active',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const flowEdgeContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_edge',
      entityPk: 1,
      row: flowEdgeProjectionRow
    });
    assert.strictEqual(flowEdgeContract.projectionVersion, 'demo-entity-snapshot:v1');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_edge',
      entityPk: 1,
      row: { ...flowEdgeProjectionRow, source_mapping_json: '{"reference":""}' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');
    const flowRecordProjectionRow = {
      id: 1,
      source_batch_id: 2,
      source_row_number: 3,
      energy_flow_model_id: 1,
      record_code: null,
      record_role: null,
      energy_flow_edge_id: 1,
      energy_flow_node_id: null,
      energy_flow_path_id: null,
      energy_flow_asset_id: null,
      stage_code: null,
      energy_type_id: null,
      start_wall_clock: null,
      end_wall_clock: null,
      start_utc: '2026-01-01T00:00:00Z',
      end_utc: '2026-02-01T00:00:00Z',
      source_timezone: 'Asia/Shanghai',
      original_unit: 'kWh',
      original_value: 12.5,
      source_type: 'explicit_edge_value',
      source_reference: null,
      source_mapping_json: '{"reference":"edge:QL-FLOW-E-01"}',
      formula_version: 'energy-flow:v1',
      record_status: 'active',
      void_reason: null,
      voided_at: null,
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z'
    };
    const flowRecordContract = ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_record',
      entityPk: 1,
      row: flowRecordProjectionRow
    });
    assert.strictEqual(flowRecordContract.projectionVersion, 'demo-entity-snapshot:v1');
    assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
      entityType: 'energy_flow_record',
      entityPk: 1,
      row: { ...flowRecordProjectionRow, start_utc: '2026-01-01T00:00:00.000Z' }
    }), 'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID');

    const invalidInsertedValues = [undefined, null, false, 0, ''];
    invalidInsertedValues.forEach((insertedRecords) => {
      assertErrorCode(() => runImmediateTransaction(db, () => {
        const input = buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings);
        delete input.noInsertedRecords;
        if (insertedRecords === undefined) delete input.insertedRecords;
        else input.insertedRecords = insertedRecords;
        return registerImportedDemoOwnershipInTransaction(input);
      }), 'DEMO_OWNERSHIP_INSERTED_RECORDS_INVALID');
    });
    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        insertedRecords: [],
        noInsertedRecords: false
      })
    )), 'DEMO_OWNERSHIP_EMPTY_INSERTED_RECORDS_UNDECLARED');

    const skippedResult = runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        insertedRecords: [],
        noInsertedRecords: true,
        skippedRecords: [{
          entityType: 'strategy_rule',
          entityPk: null,
          batchRole: 'primary',
          sourceRowNumber: 3,
          reason: 'duplicate_existing_formal_record'
        }]
      })
    ));
    assert.strictEqual(skippedResult.registrationCount, 0);
    assert.strictEqual(skippedResult.skipped[0].registration, 'not_registered');
    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        skippedRecords: [{
          entityType: 'strategy_rule',
          entityPk: null,
          batchRole: 'primary',
          sourceRowNumber: 3,
          reason: 'duplicate_existing_formal_record',
          callerMetadata: 'forbidden'
        }]
      })
    )), 'DEMO_OWNERSHIP_SKIPPED_RECORD_FIELDS_INVALID');
    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        relations: [{
          from: { entityType: 'strategy_rule', entityPk: 1 },
          to: { entityType: 'strategy_rule', entityPk: 2 },
          relationType: 'uses_config'
        }]
      })
    )), 'DEMO_OWNERSHIP_NO_INSERT_RELATIONS_INVALID');

    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        insertedRecords: [{
          entityType: 'strategy_rule',
          entityPk: 999999,
          batchRole: 'primary',
          sourceRowNumber: 2,
          rowWitness: {}
        }],
        noInsertedRecords: false
      })
    )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');

    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'strategy_rule',
      sourceBatchId: fixtureBatchId,
      sourceRowNumber: 4,
      insertSql: "UPDATE prediction_configs SET note = 'updated' WHERE id = ?",
      insertParams: [1]
    })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');

    let rolledBackWitnessRecord = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      rolledBackWitnessRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 5,
        name: 'rollback-rebuild-same-snapshot'
      });
      throw new Error('force-rollback-after-witness');
    }), /force-rollback-after-witness/);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(rolledBackWitnessRecord.entityPk).total, 0);
    let rebuiltRegistrationResult = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      const rebuiltRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 5,
        name: 'rollback-rebuild-same-snapshot'
      });
      assert.strictEqual(rebuiltRecord.entityPk, rolledBackWitnessRecord.entityPk,
        '回滚后重建应允许 SQLite 复用相同 PK');
      assert.deepStrictEqual(rebuiltRecord.rowWitness.projectedRow, rolledBackWitnessRecord.rowWitness.projectedRow,
        '回滚后重建可产生相同固定 snapshot，但旧 witness 仍必须失效');
      assertErrorCode(() => registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [rolledBackWitnessRecord], noInsertedRecords: false }
      )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');
      rebuiltRegistrationResult = registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [rebuiltRecord], noInsertedRecords: false }
      ));
      throw new Error('force-rollback-after-rebuild');
    }), /force-rollback-after-rebuild/);
    assert.strictEqual(rebuiltRegistrationResult.insertedCount, 1,
      '新 scope 下重建的同 PK/snapshot witness 必须可正常登记');
    let unregisteredWitnessPk = null;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const unregisteredRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 5,
        name: 'unregistered-witness'
      });
      unregisteredWitnessPk = unregisteredRecord.entityPk;
      return unregisteredRecord;
    }), 'DEMO_OWNERSHIP_WITNESS_NOT_REGISTERED');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(unregisteredWitnessPk).total, 0, 'callback 返回时未登记 witness 必须触发整体回滚');

    const wrongBatchId = insertImportBatch(db, 'strategy_rule', 'wrong-provenance.xlsx');
    assertErrorCode(() => runImmediateTransaction(db, () => insertStrategyFixtureWithWitness(db, {
      batchId: fixtureBatchId,
      actualBatchId: wrongBatchId,
      sourceRowNumber: 5,
      name: 'wrong-provenance'
    })), 'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      assertErrorCode(() => insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        actualBatchId: wrongBatchId,
        sourceRowNumber: 6,
        name: 'caught-post-insert-provenance-failure'
      }), 'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH');
    }), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM strategy_rules WHERE rule_name = 'caught-post-insert-provenance-failure'")
      .get().total, 0, 'helper 插入后的校验错误即使被调用方捕获也必须回滚业务行');

    let firstRecord;
    let secondRecord;
    const registrationResult = runImmediateTransaction(db, () => {
      firstRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 6,
        name: 'legal-witness-a'
      });
      secondRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 7,
        name: 'legal-witness-b'
      });
      const input = buildOwnershipInput(db, actorUserId, fixtureContext, fixtureBindings, {
        insertedRecords: [firstRecord, secondRecord],
        noInsertedRecords: false,
        relations: [{
          from: { entityType: 'strategy_rule', entityPk: secondRecord.entityPk },
          to: { entityType: 'strategy_rule', entityPk: firstRecord.entityPk },
          relationType: 'uses_config'
        }]
      });
      const first = registerImportedDemoOwnershipInTransaction(input);
      const retry = registerImportedDemoOwnershipInTransaction(input);
      assert.strictEqual(retry.idempotentCount, 2);
      assert.strictEqual(retry.relations[0].result, 'idempotent');
      return first;
    });
    assert.strictEqual(registrationResult.insertedCount, 2);
    assert.strictEqual(registrationResult.relations[0].result, 'registered');
    assert.strictEqual(registrationResult.registrations[0].identityJson,
      `{"entityType":"strategy_rule","entityPk":"${firstRecord.entityPk}"}`);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total, 2);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total, 1);
    assertErrorCode(() => runImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [firstRecord], noInsertedRecords: false }
      ))
    )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');

    assertErrorCode(() => runImmediateTransaction(db, () => {
      const metadataRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 8,
        name: 'relation-extra-metadata'
      });
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [metadataRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'strategy_rule', entityPk: metadataRecord.entityPk },
            to: { entityType: 'strategy_rule', entityPk: secondRecord.entityPk },
            relationType: 'uses_config',
            callerMetadata: 'forbidden'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_FIELDS_INVALID');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const prototypeRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 9,
        name: 'relation-custom-prototype'
      });
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [prototypeRecord],
          noInsertedRecords: false,
          relations: [{
            from: Object.assign(Object.create({ inherited: true }), {
              entityType: 'strategy_rule', entityPk: prototypeRecord.entityPk
            }),
            to: { entityType: 'strategy_rule', entityPk: secondRecord.entityPk },
            relationType: 'uses_config'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_INVALID');

    assertErrorCode(() => runImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [firstRecord],
          noInsertedRecords: false
        }
      ))
    )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');

    let forbiddenUpdateRecordId = null;
    assertErrorCode(() => runImmediateTransaction(db, (databaseFacade) => {
      const witnessedRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 8,
        name: 'forbidden-update-after-registration'
      });
      forbiddenUpdateRecordId = witnessedRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [witnessedRecord],
          noInsertedRecords: false
        }
      ));
      databaseFacade.prepare('UPDATE prediction_configs SET source_row_number = 9 WHERE id = ?');
    }), 'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(forbiddenUpdateRecordId).total, 0, '合法登记后 UPDATE 尝试必须 poison scope 并回滚业务行');
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(forbiddenUpdateRecordId)).total, 0,
    '合法登记后 UPDATE 尝试必须回滚 registry');

    let casRolledBackStrategyRuleId = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      const casRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 14,
        name: 'post-registrar-cas-failure'
      });
      casRolledBackStrategyRuleId = casRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        { insertedRecords: [casRecord], noInsertedRecords: false }
      ));
      const casError = new Error('simulated-context-cas-failure');
      casError.code = 'DEMO_CONTEXT_STATE_CONFLICT';
      throw casError;
    }), (error) => error.code === 'DEMO_CONTEXT_STATE_CONFLICT');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(casRolledBackStrategyRuleId).total, 0, 'registrar 后置 CAS 失败必须回滚业务插入');
    assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(casRolledBackStrategyRuleId)).total, 0,
    'registrar 后置 CAS 失败必须回滚 registry');

    let rolledBackStrategyRuleId = null;
    let executeContinued = false;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const rolledBackRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 10,
        name: 'rollback-record'
      });
      rolledBackStrategyRuleId = rolledBackRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [rolledBackRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'strategy_rule', entityPk: rolledBackRecord.entityPk },
            to: { entityType: 'strategy_rule', entityPk: 999999 },
            relationType: 'uses_config'
          }]
        }
      ));
      executeContinued = true;
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
    assert.strictEqual(executeContinued, false, 'registration 失败后调用方 execute 不得继续');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(rolledBackStrategyRuleId).total, 0, 'relation 失败必须回滚业务插入');
    assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'strategy_rule' AND entity_pk = ?`).get(String(rolledBackStrategyRuleId)).total, 0,
    'relation 失败必须回滚 registry');

    getTestDatabase(db).prepare('DELETE FROM demo_run_import_batches WHERE context_id = ?').run(fixtureContext.contextId);
    let rolledBackBatchLinkId = null;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const batchLinkRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 12,
        name: 'rollback-batch-link'
      });
      rolledBackBatchLinkId = batchLinkRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [batchLinkRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'strategy_rule', entityPk: batchLinkRecord.entityPk },
            to: { entityType: 'strategy_rule', entityPk: 999999 },
            relationType: 'uses_config'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches WHERE context_id = ?')
      .get(fixtureContext.contextId).total, 0, 'relation 失败必须回滚补写的 batch link');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM strategy_rules WHERE id = ?')
      .get(rolledBackBatchLinkId).total, 0, 'batch link 失败必须回滚业务插入');

    assertErrorCode(() => runImmediateTransaction(db, () => {
      const metadataRecord = insertStrategyFixtureWithWitness(db, {
        batchId: fixtureBatchId,
        sourceRowNumber: 11,
        name: 'extra-snapshot-metadata'
      });
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        fixtureContext,
        fixtureBindings,
        {
          insertedRecords: [{ ...metadataRecord, snapshot: { caller: 'forbidden' } }],
          noInsertedRecords: false
        }
      ));
    }), 'DEMO_OWNERSHIP_INSERTED_RECORD_FIELDS_INVALID');

    // 通用 Artifact 18 fixture 已完成职责；切换新 run，避免影响后续 Artifact 15×18 闭包基线。
    db.prepare(`UPDATE demo_dataset_runs
      SET status = 'cleaned', cleaned_at = '2026-08-29T03:00:00.000Z'
      WHERE run_id = ?`).run(runRecord.runId);
    runRecord = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });

    runRecord = runManagedStrategyInputScenario(getTestDatabase(db), actorUserId, runRecord, false);
    runRecord = runManagedStrategyInputScenario(getTestDatabase(db), actorUserId, runRecord, true);
    testStrategyDerivedOwnershipRegistrar(getTestDatabase(db), actorUserId, runRecord);
    console.log('demoOwnershipRegistration tests passed');
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
