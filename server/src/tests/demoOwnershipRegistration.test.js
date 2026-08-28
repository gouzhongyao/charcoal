'use strict';

const assert = require('assert');
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
const {
  DEMO_CLEANUP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
  buildDemoOwnershipPlan,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  createDemoOwnershipInsertWitness,
  abortStrategyEvaluationRegistrationScopeInTransaction,
  activateStrategyEvaluationRegistrationScopeInTransaction,
  issueStrategyEvaluationRegistrationScopeInTransaction,
  registerDerivedStrategyEvaluationInTransaction,
  registerImportedDemoOwnershipInTransaction,
  runWithDemoOwnershipTransaction,
  _test: ownershipTest
} = require('../services/demoOwnershipService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const {
  buildEnergyStrategyExactScope,
  previewEnergyStrategies,
  runEnergyStrategyEvaluation
} = require('../services/energyStrategyEvaluationService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');

const ARTIFACT_FILE_SHA256 = 'a'.repeat(64);
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
    artifactFileSha256: ARTIFACT_FILE_SHA256
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

/** 在服务端声明式插入包装器内写入预测配置并返回 registrar 记录。 */
function insertPredictionWithWitness(_externalDb, input) {
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope: activeTestTransactionScope,
    entityType: 'prediction_config',
    sourceBatchId: input.batchId,
    sourceRowNumber: input.sourceRowNumber,
    insertSql: `INSERT INTO prediction_configs
      (source_batch_id, source_row_number, name, note, train_start_month, train_end_month,
        predict_start_month, predict_end_month, algorithm, window_size, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02',
        'moving_average', 3, 'active', ?, ?)`,
    insertParams: [
      input.actualBatchId === undefined ? input.batchId : input.actualBatchId,
      input.actualSourceRowNumber === undefined ? input.sourceRowNumber : input.actualSourceRowNumber,
      input.name,
      input.note || null,
      input.createdAt || '2026-08-27T00:00:00.000Z',
      input.updatedAt || '2026-08-27T00:00:00.000Z'
    ]
  });
  return {
    entityType: 'prediction_config',
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

/** 验证 strategy derived registrar 的固定来源、关系、幂等、回滚与 cleanup fail-closed。 */
function testStrategyDerivedOwnershipRegistrar(db, actorUserId, runRecord) {
  const strategyBatchId = insertImportBatch(db, 'strategy_rule', 'strategy-derived-rules.xlsx');
  const timeseriesBatchId = insertImportBatch(db, 'energy_timeseries', 'strategy-derived-timeseries.xlsx');
  const electricityId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES ('STRATEGY-DERIVED-OU', '策略派生治理单元', '/策略派生治理单元', 'workshop', 'active')`).run().lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES ('STRATEGY-DERIVED-METER', '策略派生治理表计', 'electricity', ?, ?, 'active')`)
    .run(electricityId, organizationUnitId).lastInsertRowid);
  const ruleIds = [1, 2].map((sequence) => Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, '1.0.0', 'load-analysis:v1', 'load_rate', 'gt', 10, '%', 0.1, 'high',
      '{"minimumCoverageRate":0,"maxEvidenceItems":10,"savingBasis":"window_total_energy"}',
      '人工复核后执行节能建议。', 'test', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(strategyBatchId, sequence, `STRATEGY-DERIVED-${sequence}`, `策略派生规则${sequence}`).lastInsertRowid));
  const timeseriesIds = [1, 2].map((sequence) => {
    const startUtc = `2026-08-01T00:${sequence === 1 ? '00' : '15'}:00.000Z`;
    const endUtc = `2026-08-01T00:${sequence === 1 ? '15' : '30'}:00.000Z`;
    return Number(db.prepare(`INSERT INTO energy_timeseries_records
      (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
       start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
       normalized_unit, normalized_value, source_reference, data_source, record_status,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', 10, 'kWh', 10, ?, 'upload',
        'active', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
      .run(timeseriesBatchId, sequence, organizationUnitId, meterDeviceId, electricityId,
        startUtc, endUtc, `strategy-derived:${sequence}`).lastInsertRowid);
  });
  // 直接消费正式 evaluator 的 unsupported metric 输出，确认合法 not_evaluable hit 不被 ownership 误拒绝。
  const unsupportedRuleId = Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (?, 3, 'STRATEGY-DERIVED-UNSUPPORTED', '策略派生不支持指标', '1.0.0', 'load-analysis:v1',
      'dynamic_function_name', 'gt', 10, '%', NULL, 'high',
      '{"minimumCoverageRate":0,"maxEvidenceItems":10,"savingBasis":"window_total_energy"}',
      '人工复核后执行节能建议。', 'test', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(strategyBatchId).lastInsertRowid);
  const unsupportedPreview = previewEnergyStrategies({
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: '2026-08-01T00:00:00.000Z',
    endUtc: '2026-08-01T01:00:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    ruleCodes: ['STRATEGY-DERIVED-UNSUPPORTED']
  }, { db });
  const unsupportedEvaluation = unsupportedPreview.evaluations[0];
  assert(unsupportedEvaluation, '正式 evaluator 必须返回 unsupported metric 评价结果');
  const unsupportedHitRow = {
    id: 999,
    evaluation_run_id: 101,
    strategy_rule_id: unsupportedRuleId,
    match_status: unsupportedEvaluation.matchStatus,
    manual_status: 'unconfirmed',
    actual_value: unsupportedEvaluation.actualValue,
    threshold_snapshot_json: JSON.stringify(unsupportedEvaluation.threshold),
    evidence_json: JSON.stringify({
      evidence: unsupportedEvaluation.evidence,
      evidencePolicy: unsupportedEvaluation.evidencePolicy,
      dataSummaryDigest: unsupportedEvaluation.dataSummaryDigest,
      evaluationDigest: unsupportedEvaluation.evaluationDigest,
      configurationErrors: unsupportedEvaluation.configurationErrors,
      recommendation: unsupportedEvaluation.recommendation,
      source: unsupportedEvaluation.source,
      effectiveRange: unsupportedEvaluation.effectiveRange,
      evidenceRequirements: unsupportedEvaluation.evidenceRequirements,
      automationBoundary: unsupportedPreview.automationBoundary
    }),
    reason_codes_json: unsupportedEvaluation.reasonCodes.length > 0
      ? JSON.stringify(unsupportedEvaluation.reasonCodes) : null,
    coverage_rate: unsupportedEvaluation.coverageRate,
    priority: unsupportedEvaluation.priority,
    estimated_saving: unsupportedEvaluation.estimatedSaving,
    estimated_saving_unit: unsupportedEvaluation.estimatedSavingUnit,
    data_start_utc: unsupportedPreview.dataRange.startUtc,
    data_end_utc: unsupportedPreview.dataRange.endUtc,
    source_timezone: unsupportedPreview.dataRange.sourceTimeZone,
    reviewed_at: null,
    review_note: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z'
  };
  assert.strictEqual(unsupportedEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(unsupportedEvaluation.configurationErrors.includes('UNSUPPORTED_STRATEGY_METRIC'), true);
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: unsupportedHitRow.id, row: unsupportedHitRow
  });

  // 正式 parser 在其它 evidence 字段错误时保留合法 maxEvidenceItems，不能被 handler 擅自改回默认值。
  const partialRequirementRuleId = Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (?, 4, 'STRATEGY-DERIVED-PARTIAL-REQUIREMENTS', '策略派生部分证据要求', '1.0.0', 'load-analysis:v1',
      'load_rate', 'gt', 10, '%', 0.1, 'high',
      '{"minimumCoverageRate":0,"maxEvidenceItems":3,"savingBasis":"window_total_energy","unexpected":true}',
      '人工复核后执行节能建议。', 'test', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(strategyBatchId).lastInsertRowid);
  const partialRequirementPreview = previewEnergyStrategies({
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: '2026-08-01T00:00:00.000Z',
    endUtc: '2026-08-01T01:00:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    ruleCodes: ['STRATEGY-DERIVED-PARTIAL-REQUIREMENTS']
  }, { db });
  const partialRequirementEvaluation = partialRequirementPreview.evaluations[0];
  assert(partialRequirementEvaluation, '正式 evaluator 必须返回 evidence requirements 错误结果');
  assert.strictEqual(partialRequirementEvaluation.evidenceRequirements, null);
  assert.strictEqual(partialRequirementEvaluation.evidencePolicy.detailEvidenceLimit, 3);
  const partialRequirementHitRow = {
    ...unsupportedHitRow,
    id: 1000,
    strategy_rule_id: partialRequirementRuleId,
    match_status: partialRequirementEvaluation.matchStatus,
    actual_value: partialRequirementEvaluation.actualValue,
    threshold_snapshot_json: JSON.stringify(partialRequirementEvaluation.threshold),
    evidence_json: JSON.stringify({
      evidence: partialRequirementEvaluation.evidence,
      evidencePolicy: partialRequirementEvaluation.evidencePolicy,
      dataSummaryDigest: partialRequirementEvaluation.dataSummaryDigest,
      evaluationDigest: partialRequirementEvaluation.evaluationDigest,
      configurationErrors: partialRequirementEvaluation.configurationErrors,
      recommendation: partialRequirementEvaluation.recommendation,
      source: partialRequirementEvaluation.source,
      effectiveRange: partialRequirementEvaluation.effectiveRange,
      evidenceRequirements: partialRequirementEvaluation.evidenceRequirements,
      automationBoundary: partialRequirementPreview.automationBoundary
    }),
    reason_codes_json: JSON.stringify(partialRequirementEvaluation.reasonCodes),
    coverage_rate: partialRequirementEvaluation.coverageRate,
    priority: partialRequirementEvaluation.priority,
    estimated_saving: partialRequirementEvaluation.estimatedSaving,
    estimated_saving_unit: partialRequirementEvaluation.estimatedSavingUnit,
    data_start_utc: partialRequirementPreview.dataRange.startUtc,
    data_end_utc: partialRequirementPreview.dataRange.endUtc,
    source_timezone: partialRequirementPreview.dataRange.sourceTimeZone
  };
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: partialRequirementHitRow.id, row: partialRequirementHitRow
  });

  // 正式 evaluator 在没有完整 peak candidate 时生成无 saving 的 not_evaluable，且仍保留源粒度单位。
  const partialPeakMeterId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES ('STRATEGY-DERIVED-PARTIAL-PEAK', '策略派生部分峰值表计', 'electricity', ?, ?, 'active')`)
    .run(electricityId, organizationUnitId).lastInsertRowid);
  db.prepare(`INSERT INTO energy_timeseries_records
    (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
     start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
     normalized_unit, normalized_value, source_reference, data_source, record_status,
     created_at, updated_at)
    VALUES (?, 3, ?, ?, ?, '2026-07-31T23:45:00.000Z', '2026-08-01T00:15:00.000Z',
      'Asia/Shanghai', 30, 'kWh', 20, 'kWh', 20, 'strategy-derived:partial-peak',
      'upload', 'active', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(timeseriesBatchId, organizationUnitId, partialPeakMeterId, electricityId);
  const partialPeakRuleId = Number(db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (?, 5, 'STRATEGY-DERIVED-NO-FULL-PEAK', '策略派生无完整峰值', '1.0.0', 'load-analysis:v1',
      'peak_interval_energy', 'gt', 10, 'kWh/30min', 0.1, 'high',
      '{"minimumCoverageRate":0,"maxEvidenceItems":10,"savingBasis":"window_total_energy"}',
      '人工复核后执行节能建议。', 'test', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`)
    .run(strategyBatchId).lastInsertRowid);
  const partialPeakPreview = previewEnergyStrategies({
    meterDeviceId: partialPeakMeterId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: '2026-08-01T00:00:00.000Z',
    endUtc: '2026-08-01T00:15:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    ruleCodes: ['STRATEGY-DERIVED-NO-FULL-PEAK']
  }, { db });
  const partialPeakEvaluation = partialPeakPreview.evaluations[0];
  assert(partialPeakEvaluation, '正式 evaluator 必须返回无完整 peak candidate 的评价结果');
  assert.strictEqual(partialPeakEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(partialPeakEvaluation.actualValue, null);
  assert.strictEqual(partialPeakEvaluation.estimatedSaving, null);
  assert.strictEqual(partialPeakEvaluation.threshold.unit, 'kWh/30min');
  assert.strictEqual(partialPeakEvaluation.evidence.some((item) => item.startsWith('peak-interval:')), false);
  const partialPeakHitRow = {
    ...unsupportedHitRow,
    id: 1001,
    strategy_rule_id: partialPeakRuleId,
    match_status: partialPeakEvaluation.matchStatus,
    actual_value: partialPeakEvaluation.actualValue,
    threshold_snapshot_json: JSON.stringify(partialPeakEvaluation.threshold),
    evidence_json: JSON.stringify({
      evidence: partialPeakEvaluation.evidence,
      evidencePolicy: partialPeakEvaluation.evidencePolicy,
      dataSummaryDigest: partialPeakEvaluation.dataSummaryDigest,
      evaluationDigest: partialPeakEvaluation.evaluationDigest,
      configurationErrors: partialPeakEvaluation.configurationErrors,
      recommendation: partialPeakEvaluation.recommendation,
      source: partialPeakEvaluation.source,
      effectiveRange: partialPeakEvaluation.effectiveRange,
      evidenceRequirements: partialPeakEvaluation.evidenceRequirements,
      automationBoundary: partialPeakPreview.automationBoundary
    }),
    reason_codes_json: JSON.stringify(partialPeakEvaluation.reasonCodes),
    coverage_rate: partialPeakEvaluation.coverageRate,
    priority: partialPeakEvaluation.priority,
    estimated_saving: partialPeakEvaluation.estimatedSaving,
    estimated_saving_unit: partialPeakEvaluation.estimatedSavingUnit,
    data_start_utc: partialPeakPreview.dataRange.startUtc,
    data_end_utc: partialPeakPreview.dataRange.endUtc,
    source_timezone: partialPeakPreview.dataRange.sourceTimeZone
  };
  ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit', entityPk: partialPeakHitRow.id, row: partialPeakHitRow
  });
  assertErrorCode(() => ownershipTest.buildDemoEntityRegistrationContract({
    entityType: 'strategy_rule_hit',
    entityPk: partialPeakHitRow.id,
    row: {
      ...partialPeakHitRow,
      match_status: 'matched',
      actual_value: 20,
      reason_codes_json: null
    }
  }), 'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID');

  const sourceEntities = [
    ...ruleIds.map((entityPk) => ({ entityType: 'strategy_rule', entityPk, artifactKey: '18-strategy-rules' })),
    ...timeseriesIds.map((entityPk) => ({ entityType: 'energy_timeseries', entityPk, artifactKey: '15-energy-timeseries' }))
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
    strategyRuleIds: ruleIds,
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
  const createActionRunId = (label) => {
    actionSequence += 1;
    const actionRunId = `strategy-derived-${label}-${actionSequence}`;
    insertExecutingStrategyAction(db, { actionRunId, runRecord, actorUserId });
    return actionRunId;
  };
  const issueScope = (actionRunId, scope = exactScope) => issueStrategyEvaluationRegistrationScopeInTransaction({
    db,
    runId: runRecord.runId,
    actionRunId,
    actorUserId,
    exactScope: scope,
    domainBinding
  });
  const runControlledEvaluation = (registrationScope, scope, onCompletedEvaluation) => (
    runEnergyStrategyEvaluation(evaluatorInput, {
      db,
      actorUserId,
      exactRequired: true,
      exactScope: scope,
      registrationScope,
      beforeEvaluationWrite(currentScope) {
        activateStrategyEvaluationRegistrationScopeInTransaction({
          db,
          registrationScope: currentScope
        });
      },
      onCompletedEvaluation
    })
  );

  assertErrorCode(() => registerDerivedStrategyEvaluationInTransaction({
    db,
    runId: runRecord.runId,
    actionRunId: 'legacy',
    actorUserId,
    evaluationRunId: 1,
    hitIds: [],
    sourceTimeseriesIds: [],
    strategyRuleIds: []
  }), 'DEMO_DERIVED_STRATEGY_INPUT_INVALID');

  const sourceBefore = db.prepare(`SELECT registry_id, artifact_key, ownership_kind, identity_digest,
    snapshot_digest, source_batch_id, source_row_number FROM demo_data_registry
    WHERE entity_type IN ('strategy_rule', 'energy_timeseries') ORDER BY registry_id`).all();
  const successActionRunId = createActionRunId('success');
  db.exec('BEGIN IMMEDIATE');
  const successScope = issueScope(successActionRunId);
  let successWitness = null;
  let registered = null;
  const evaluated = runControlledEvaluation(successScope, exactScope, (currentScope, witness) => {
    successWitness = witness;
    assert.deepStrictEqual(Object.keys(witness), []);
    assert.strictEqual(Object.isFrozen(witness), true);
    registered = registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: currentScope,
      evaluationWitness: witness
    });
  });
  assert.strictEqual(db.inTransaction, true, 'evaluator/registrar 不得接管 caller transaction');
  assert.strictEqual(registered.registrationCount, 1 + evaluated.hits.length);
  assert.strictEqual(registered.relationCount, (2 * evaluated.hits.length) + timeseriesIds.length);
  assert.strictEqual(JSON.stringify(evaluated).includes('Witness'), false);
  db.exec('COMMIT');
  const sourceAfter = db.prepare(`SELECT registry_id, artifact_key, ownership_kind, identity_digest,
    snapshot_digest, source_batch_id, source_row_number FROM demo_data_registry
    WHERE entity_type IN ('strategy_rule', 'energy_timeseries') ORDER BY registry_id`).all();
  assert.deepStrictEqual(sourceAfter, sourceBefore, 'strategy registrar 不得篡改 imported source registry');
  const derivedRows = db.prepare(`SELECT entity_type, entity_pk, ownership_kind, artifact_key,
    source_batch_id, source_row_number FROM demo_data_registry
    WHERE entity_type IN ('strategy_evaluation_run', 'strategy_rule_hit') ORDER BY registry_id`).all();
  assert.strictEqual(derivedRows.length, 1 + evaluated.hits.length);
  derivedRows.forEach((row) => {
    assert.strictEqual(row.ownership_kind, 'derived');
    assert.strictEqual(row.artifact_key, '18-strategy-rules');
    assert.strictEqual(row.source_batch_id, null);
    assert.strictEqual(row.source_row_number, null);
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    assertErrorCode(() => registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: successScope,
      evaluationWitness: successWitness
    }), 'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_REPLAY');
  } finally {
    db.exec('ROLLBACK');
  }

  // 普通复制、JSON clone、事务替换和同 run 的另一 exact set 都不能伪造 scope。
  const cloneActionRunId = createActionRunId('clone');
  db.exec('BEGIN IMMEDIATE');
  const cloneScope = issueScope(cloneActionRunId);
  assertErrorCode(() => runControlledEvaluation({ ...cloneScope }, exactScope, () => {}),
    'ENERGY_STRATEGY_REGISTRATION_SCOPE_CAPABILITY_REQUIRED');
  abortStrategyEvaluationRegistrationScopeInTransaction({ db, registrationScope: cloneScope });
  db.exec('COMMIT');

  const replacementActionRunId = createActionRunId('replacement');
  db.exec('BEGIN IMMEDIATE');
  const replacementScope = issueScope(replacementActionRunId);
  db.exec('COMMIT');
  db.exec('BEGIN IMMEDIATE');
  try {
    assertErrorCode(() => runControlledEvaluation(replacementScope, exactScope, () => {}),
      'DEMO_DERIVED_STRATEGY_SCOPE_ACTIVATION_FAILED');
  } finally {
    db.exec('ROLLBACK');
  }

  const reducedExactScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: [timeseriesIds[0]],
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: ruleIds,
    strategyRuleSourceBatchId: strategyBatchId
  });
  const setMismatchActionRunId = createActionRunId('set-mismatch');
  db.exec('BEGIN IMMEDIATE');
  const setMismatchScope = issueScope(setMismatchActionRunId);
  const runCountBeforeMismatch = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  assertErrorCode(() => runControlledEvaluation(setMismatchScope, reducedExactScope, () => {}),
    'ENERGY_STRATEGY_REGISTRATION_SCOPE_EXACT_MISMATCH');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    runCountBeforeMismatch
  );
  db.exec('COMMIT');

  // import_type 在 evaluator 完成后被替换时，registrar 必须整体回滚并保持外层事务可提交。
  const importTypeActionRunId = createActionRunId('import-type');
  db.exec('BEGIN IMMEDIATE');
  const importTypeScope = issueScope(importTypeActionRunId);
  const importTypeRunCount = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  assertErrorCode(() => runControlledEvaluation(importTypeScope, exactScope, (currentScope, witness) => {
    db.prepare("UPDATE import_batches SET import_type = 'energy_timeseries' WHERE id = ?")
      .run(strategyBatchId);
    registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: currentScope,
      evaluationWitness: witness
    });
  }), 'DEMO_DERIVED_STRATEGY_SOURCE_IMPORT_TYPE_INVALID');
  assert.strictEqual(db.inTransaction, true);
  assert.strictEqual(db.prepare('SELECT import_type FROM import_batches WHERE id = ?').get(strategyBatchId).import_type,
    'strategy_rule');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    importTypeRunCount);
  db.exec('COMMIT');

  // relation 中途失败必须回滚 evaluation/run/hit/registry/relation，caller sentinel 仍可提交。
  const relationFailureActionRunId = createActionRunId('relation-failure');
  db.exec('BEGIN IMMEDIATE');
  const sentinelId = Number(db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, created_at)
    VALUES (?, 'strategy.test.sentinel', 'test', 'relation-failure', '{}', '2026-08-28T12:00:00.000Z')`)
    .run(actorUserId).lastInsertRowid);
  db.exec(`CREATE TEMP TRIGGER fail_strategy_uses_config_relation
    BEFORE INSERT ON demo_data_relations
    WHEN NEW.relation_type = 'uses_config'
    BEGIN
      SELECT RAISE(ABORT, 'forced strategy relation failure');
    END`);
  const relationFailureScope = issueScope(relationFailureActionRunId);
  const countsBeforeRelationFailure = {
    runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    registry: db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
    relations: db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total
  };
  assertErrorCode(() => runControlledEvaluation(relationFailureScope, exactScope, (currentScope, witness) => {
    registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: currentScope,
      evaluationWitness: witness
    });
  }), 'DEMO_OWNERSHIP_RELATION_WRITE_FAILED');
  assert.deepStrictEqual({
    runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    registry: db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
    relations: db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total
  }, countsBeforeRelationFailure);
  db.exec('DROP TRIGGER fail_strategy_uses_config_relation');
  db.exec('COMMIT');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs WHERE id = ?').get(sentinelId).total, 1);

  // completion witness 必须同步、一次性且由 registrar 原对象消费，callback 失败不留业务写入。
  const assertControlledCallbackFailure = (label, callback, expectedCode, inspectError = null) => {
    const actionRunId = createActionRunId(label);
    db.exec('BEGIN IMMEDIATE');
    const registrationScope = issueScope(actionRunId);
    const beforeCounts = {
      runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
      hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
      registry: db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
      relations: db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total,
      logs: db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.run'").get().total
    };
    try {
      assert.throws(() => runControlledEvaluation(registrationScope, exactScope, callback), (error) => {
        assert.strictEqual(error.details?.code || error.code, expectedCode);
        if (inspectError) inspectError(error);
        return true;
      });
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual({
        runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
        hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
        registry: db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
        relations: db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total,
        logs: db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.run'").get().total
      }, beforeCounts);
    } finally {
      db.exec('COMMIT');
    }
  };
  assertControlledCallbackFailure(
    'witness-unconsumed',
    () => {},
    'ENERGY_STRATEGY_COMPLETION_WITNESS_NOT_CONSUMED'
  );
  assertControlledCallbackFailure(
    'witness-async',
    () => Promise.resolve(),
    'ENERGY_STRATEGY_COMPLETED_CALLBACK_ASYNC'
  );
  assertControlledCallbackFailure(
    'witness-clone',
    (currentScope, witness) => registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: currentScope,
      evaluationWitness: { ...witness }
    }),
    'ENERGY_STRATEGY_COMPLETION_WITNESS_CAPABILITY_REQUIRED'
  );
  assertControlledCallbackFailure(
    'witness-json-clone',
    (currentScope, witness) => registerDerivedStrategyEvaluationInTransaction({
      db,
      registrationScope: currentScope,
      evaluationWitness: JSON.parse(JSON.stringify(witness))
    }),
    'ENERGY_STRATEGY_COMPLETION_WITNESS_CAPABILITY_REQUIRED'
  );
  assertControlledCallbackFailure(
    'hit-set-missing',
    (currentScope, witness) => {
      const currentRun = db.prepare(
        "SELECT id FROM strategy_evaluation_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
      ).get();
      const hit = db.prepare(
        'SELECT id FROM strategy_rule_hits WHERE evaluation_run_id = ? ORDER BY id LIMIT 1'
      ).get(currentRun.id);
      db.prepare('DELETE FROM strategy_rule_hits WHERE id = ?').run(hit.id);
      registerDerivedStrategyEvaluationInTransaction({
        db,
        registrationScope: currentScope,
        evaluationWitness: witness
      });
    },
    'DEMO_DERIVED_STRATEGY_HIT_SET_MISMATCH'
  );
  assertControlledCallbackFailure(
    'hit-set-extra',
    (currentScope, witness) => {
      const currentRun = db.prepare(
        "SELECT id FROM strategy_evaluation_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
      ).get();
      db.prepare(`INSERT INTO strategy_rule_hits
        (evaluation_run_id, strategy_rule_id, match_status, manual_status, actual_value,
         threshold_snapshot_json, evidence_json, reason_codes_json, coverage_rate, priority,
         estimated_saving, estimated_saving_unit, data_start_utc, data_end_utc, source_timezone,
         reviewed_at, review_note, created_at, updated_at)
        SELECT evaluation_run_id, ?, match_status, manual_status, actual_value,
          threshold_snapshot_json, evidence_json, reason_codes_json, coverage_rate, priority,
          estimated_saving, estimated_saving_unit, data_start_utc, data_end_utc, source_timezone,
          reviewed_at, review_note, created_at, updated_at
        FROM strategy_rule_hits WHERE evaluation_run_id = ? ORDER BY id LIMIT 1`).run(unsupportedRuleId, currentRun.id);
      registerDerivedStrategyEvaluationInTransaction({
        db,
        registrationScope: currentScope,
        evaluationWitness: witness
      });
    },
    'DEMO_DERIVED_STRATEGY_HIT_SET_MISMATCH'
  );
  assertControlledCallbackFailure(
    'registrar-wrong-db',
    (currentScope, witness) => {
      const registrarDb = openDatabase();
      let registrarError = null;
      registrarDb.exec('BEGIN DEFERRED');
      try {
        registerDerivedStrategyEvaluationInTransaction({
          db: registrarDb,
          registrationScope: currentScope,
          evaluationWitness: witness
        });
      } catch (error) {
        registrarError = error;
      } finally {
        if (registrarDb.inTransaction) registrarDb.exec('ROLLBACK');
        registrarDb.close();
      }
      throw registrarError;
    },
    'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_DATABASE_MISMATCH'
  );
  assertControlledCallbackFailure(
    'source-snapshot-drift',
    (currentScope, witness) => {
      db.prepare('UPDATE energy_timeseries_records SET normalized_value = normalized_value + 1 WHERE id = ?')
        .run(timeseriesIds[0]);
      registerDerivedStrategyEvaluationInTransaction({
        db,
        registrationScope: currentScope,
        evaluationWitness: witness
      });
    },
    'DEMO_DERIVED_STRATEGY_SOURCE_STALE'
  );
  assertControlledCallbackFailure(
    'relation-numeric-id',
    (currentScope, witness) => {
      const currentRun = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_evaluation_run.readProjection(
        db,
        Number(db.prepare(
          "SELECT id FROM strategy_evaluation_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
        ).get().id)
      );
      const currentHit = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(
        db,
        Number(db.prepare(
          'SELECT id FROM strategy_rule_hits WHERE evaluation_run_id = ? ORDER BY id LIMIT 1'
        ).get(currentRun.id).id)
      );
      const insertDerivedRegistry = (entityType, row) => {
        const contract = ownershipTest.buildDemoEntityRegistrationContract({
          entityType,
          entityPk: row.id,
          row
        });
        return Number(db.prepare(`INSERT INTO demo_data_registry
          (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
           identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
          VALUES (?, '18-strategy-rules', ?, ?, 'derived', ?, ?, NULL, NULL, ?)`).run(
          runRecord.runId,
          contract.entityType,
          contract.entityPk,
          contract.identityDigest,
          contract.snapshotDigest,
          actorUserId
        ).lastInsertRowid);
      };
      const runRegistryId = insertDerivedRegistry('strategy_evaluation_run', currentRun);
      const hitRegistryId = insertDerivedRegistry('strategy_rule_hit', currentHit);
      db.prepare(`INSERT INTO demo_data_relations
        (run_id, from_registry_id, to_registry_id, relation_type)
        VALUES (?, ?, ?, 'uses_config')`).run(runRecord.runId, runRegistryId, hitRegistryId);
      registerDerivedStrategyEvaluationInTransaction({
        db,
        registrationScope: currentScope,
        evaluationWitness: witness
      });
    },
    'DEMO_DERIVED_STRATEGY_RELATIONS_MISMATCH',
    (error) => {
      assert.strictEqual(Number.isSafeInteger(error.details?.relationId), true);
      assert(error.details.relationId > 0);
    }
  );

  // beforeEvaluationWrite 激活后若 callback 主动结束并替换事务，必须在首次 evaluator 写入前拒绝。
  const beforeReplacementActionRunId = createActionRunId('before-replacement');
  db.exec('BEGIN IMMEDIATE');
  const beforeReplacementScope = issueScope(beforeReplacementActionRunId);
  const beforeReplacementRunCount = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, {
    db,
    actorUserId,
    exactRequired: true,
    exactScope,
    registrationScope: beforeReplacementScope,
    beforeEvaluationWrite(currentScope) {
      activateStrategyEvaluationRegistrationScopeInTransaction({ db, registrationScope: currentScope });
      db.exec('COMMIT');
      db.exec('BEGIN IMMEDIATE');
    },
    onCompletedEvaluation() {}
  }), 'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH');
  assert.strictEqual(db.inTransaction, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeReplacementRunCount);
  db.exec('COMMIT');

  const beforeAsyncActionRunId = createActionRunId('before-async');
  db.exec('BEGIN IMMEDIATE');
  const beforeAsyncScope = issueScope(beforeAsyncActionRunId);
  const beforeAsyncRunCount = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, {
    db,
    actorUserId,
    exactRequired: true,
    exactScope,
    registrationScope: beforeAsyncScope,
    beforeEvaluationWrite(currentScope) {
      activateStrategyEvaluationRegistrationScopeInTransaction({ db, registrationScope: currentScope });
      return Promise.resolve();
    },
    onCompletedEvaluation() {}
  }), 'ENERGY_STRATEGY_BEFORE_WRITE_CALLBACK_ASYNC');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeAsyncRunCount);
  db.exec('COMMIT');

  const wrongDbActionRunId = createActionRunId('wrong-db');
  db.exec('BEGIN IMMEDIATE');
  const wrongDbScope = issueScope(wrongDbActionRunId);
  const wrongDb = openDatabase();
  wrongDb.exec('BEGIN DEFERRED');
  try {
    assertErrorCode(() => runEnergyStrategyEvaluation(evaluatorInput, {
      db: wrongDb,
      actorUserId,
      exactRequired: true,
      exactScope,
      registrationScope: wrongDbScope,
      beforeEvaluationWrite() {},
      onCompletedEvaluation() {}
    }), 'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH');
  } finally {
    if (wrongDb.inTransaction) wrongDb.exec('ROLLBACK');
    wrongDb.close();
    db.exec('COMMIT');
  }

  assert.strictEqual(DEMO_CLEANUP_ENTITY_HANDLERS.strategy_evaluation_run, undefined);
  assert.strictEqual(DEMO_CLEANUP_ENTITY_HANDLERS.strategy_rule_hit, undefined);
  const cleanupPlan = buildDemoOwnershipPlan(db, runRecord.runId);
  assert(cleanupPlan.blockers.some((blocker) => blocker.code === 'DERIVED_OWNERSHIP_NOT_CONNECTED'
    && blocker.entityType === 'strategy_rule_hit'));
}

/** 执行 ownership 固定投影、row witness 与隔离 SQLite 原子登记测试。 */
async function run() {
  assert.strictEqual(DEMO_OWNERSHIP_REGISTRATION_CONNECTED, false,
    '公共登记基础不得提前开启 cleanup capability');
  const directFormalNoop = registerImportedDemoOwnershipInTransaction({ demoContext: null });
  assert.strictEqual(directFormalNoop.applied, false);
  assert.strictEqual(directFormalNoop.reason, 'demo_context_absent');
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
    const runRecord = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });

    const formalNoop = runRawImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction({
      db,
      demoContext: null,
      insertedRecords: null
    }));
    assert.strictEqual(formalNoop.applied, false);
    assert.strictEqual(formalNoop.reason, 'demo_context_absent');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total, 0);

    const predictionBatchId = insertImportBatch(db, 'prediction_config', 'prediction.xlsx');
    const predictionBindings = [{ batchId: predictionBatchId, batchRole: 'primary' }];
    const predictionContext = createPreviewedContext(db, {
      userId: actorUserId,
      runId: runRecord.runId,
      artifactKey: '12-prediction-configs',
      handlerKey: 'prediction-configs-import',
      batchBindings: predictionBindings
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
    assertErrorCode(() => runImmediateTransaction(db, () => {
      getTestDatabase(db).exec('COMMIT; BEGIN IMMEDIATE');
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      getTestDatabase(db).prepare('COMMIT');
    }), 'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN');

    let legacyInsertCalled = false;
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
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
          const record = insertPredictionWithWitness(db, {
            batchId: predictionBatchId,
            sourceRowNumber,
            name: label
          });
          entityPk = record.entityPk;
          registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
            db,
            actorUserId,
            predictionContext,
            predictionBindings,
            {
              insertedRecords: [record],
              noInsertedRecords: false,
              relations: [{
                from: { entityType: 'prediction_config', entityPk: record.entityPk },
                to: { entityType: 'prediction_config', entityPk: 999999 },
                relationType: 'uses_config'
              }]
            }
          ));
        }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
      } finally {
        if (db.inTransaction) externalRawExec.call(db, 'ROLLBACK');
      }
      assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
        .get(entityPk).total, 0, `${label} 后业务行必须回滚`);
      assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(String(entityPk)).total, 0,
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
          VALUES (${predictionBatchId}, 20, 'facade-extra-row', '2025-01', '2025-12',
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
        const registeredRecord = insertPredictionWithWitness(db, {
          batchId: predictionBatchId,
          sourceRowNumber: 20 + index,
          name: `facade-${testCase.label}-rollback`
        });
        registeredEntityPk = registeredRecord.entityPk;
        registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
          db,
          actorUserId,
          predictionContext,
          predictionBindings,
          { insertedRecords: [registeredRecord], noInsertedRecords: false }
        ));
        databaseFacade.prepare(testCase.sql);
      }), 'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
        .get(registeredEntityPk).total, 0, `${testCase.label} 尝试后业务行必须回滚`);
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(String(registeredEntityPk)).total, 0,
      `${testCase.label} 尝试后 registry 必须回滚`);
    });
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'table' AND name = 'ownership_forbidden_ddl'`).get().total, 0,
    'facade DDL 不得创建表');
    assert.notStrictEqual(db.pragma('user_version', { simple: true }), 49, 'facade 写 PRAGMA 不得生效');

    let caughtForbiddenWritePk = null;
    assertErrorCode(() => runImmediateTransaction(db, (databaseFacade) => {
      const registeredRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 26,
        name: 'caught-facade-write-must-poison'
      });
      caughtForbiddenWritePk = registeredRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        { insertedRecords: [registeredRecord], noInsertedRecords: false }
      ));
      assertErrorCode(() => databaseFacade.prepare("UPDATE prediction_configs SET note = 'caught' WHERE id = 1"),
        'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
    }), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
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
        entityType: 'prediction_config',
        sourceBatchId: predictionBatchId,
        sourceRowNumber: 30 + index,
        insertSql,
        insertParams: insertSql.includes('?')
          ? [predictionBatchId, 30 + index, `invalid-sql-${index}`]
          : []
      })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');
    });
    assertErrorCode(() => runImmediateTransaction(db, () => createDemoOwnershipInsertWitness({
      transactionScope: activeTestTransactionScope,
      entityType: 'energy_record',
      sourceBatchId: predictionBatchId,
      sourceRowNumber: 40,
      insertSql: `INSERT INTO prediction_configs
        (source_batch_id, source_row_number, name, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, ?, '2025-01', '2025-12', '2026-01', '2026-02', 'moving_average', 'active')`,
      insertParams: [predictionBatchId, 40, 'wrong-handler-table']
    })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');

    // 旧 callback API 的 getter/Proxy 必须在任何重入代码执行前被拒绝。
    let legacyGetterCalled = false;
    const legacyGetterInput = {
      transactionScope: null,
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
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
      const registeredRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 41,
        name: 'legacy-getter-rollback'
      });
      legacyGetterRollbackPk = registeredRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        { insertedRecords: [registeredRecord], noInsertedRecords: false }
      ));
      legacyGetterInput.transactionScope = transactionScope;
      createDemoOwnershipInsertWitness(legacyGetterInput);
    }), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(legacyGetterCalled, false, '旧 API getter 不得执行');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(legacyGetterRollbackPk).total, 0, '旧 API getter 输入必须使已登记业务行整体回滚');

    let legacyProxyTrapCalled = false;
    const legacyProxyInput = new Proxy({
      transactionScope: null,
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
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
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
      sourceRowNumber: 13,
      insert: () => externalInsertStatement.run(predictionBatchId)
    })), 'DEMO_OWNERSHIP_ROW_WITNESS_INVALID');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM prediction_configs WHERE name = 'external-witness-attempt'")
      .get().total, 0, '旧预保存 statement 不能通过 witness API 写入业务行');

    let expiredTransactionScope = null;
    runImmediateTransaction(db, (_databaseFacade, transactionScope) => {
      expiredTransactionScope = transactionScope;
    });
    assertErrorCode(() => runRawImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction({
        ...buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings),
        transactionScope: expiredTransactionScope
      })
    )), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED');

    const projectionFixtureId = Number(db.prepare(`INSERT INTO prediction_configs
      (source_batch_id, source_row_number, name, train_start_month, train_end_month,
        predict_start_month, predict_end_month, algorithm, window_size, status)
      VALUES (?, 2, 'projection-fixture', '2025-01', '2025-12', '2026-01', '2026-02',
        'moving_average', 3, 'active')`).run(predictionBatchId).lastInsertRowid);
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
        const input = buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings);
        delete input.noInsertedRecords;
        if (insertedRecords === undefined) delete input.insertedRecords;
        else input.insertedRecords = insertedRecords;
        return registerImportedDemoOwnershipInTransaction(input);
      }), 'DEMO_OWNERSHIP_INSERTED_RECORDS_INVALID');
    });
    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        insertedRecords: [],
        noInsertedRecords: false
      })
    )), 'DEMO_OWNERSHIP_EMPTY_INSERTED_RECORDS_UNDECLARED');

    const skippedResult = runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        insertedRecords: [],
        noInsertedRecords: true,
        skippedRecords: [{
          entityType: 'prediction_config',
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
      buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        skippedRecords: [{
          entityType: 'prediction_config',
          entityPk: null,
          batchRole: 'primary',
          sourceRowNumber: 3,
          reason: 'duplicate_existing_formal_record',
          callerMetadata: 'forbidden'
        }]
      })
    )), 'DEMO_OWNERSHIP_SKIPPED_RECORD_FIELDS_INVALID');
    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        relations: [{
          from: { entityType: 'prediction_config', entityPk: 1 },
          to: { entityType: 'prediction_config', entityPk: 2 },
          relationType: 'uses_config'
        }]
      })
    )), 'DEMO_OWNERSHIP_NO_INSERT_RELATIONS_INVALID');

    assertErrorCode(() => runImmediateTransaction(db, () => registerImportedDemoOwnershipInTransaction(
      buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        insertedRecords: [{
          entityType: 'prediction_config',
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
      entityType: 'prediction_config',
      sourceBatchId: predictionBatchId,
      sourceRowNumber: 4,
      insertSql: "UPDATE prediction_configs SET note = 'updated' WHERE id = ?",
      insertParams: [1]
    })), 'DEMO_OWNERSHIP_INSERT_SQL_INVALID');

    let rolledBackWitnessRecord = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      rolledBackWitnessRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 5,
        name: 'rollback-rebuild-same-snapshot'
      });
      throw new Error('force-rollback-after-witness');
    }), /force-rollback-after-witness/);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(rolledBackWitnessRecord.entityPk).total, 0);
    let rebuiltRegistrationResult = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      const rebuiltRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
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
        predictionContext,
        predictionBindings,
        { insertedRecords: [rolledBackWitnessRecord], noInsertedRecords: false }
      )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');
      rebuiltRegistrationResult = registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        { insertedRecords: [rebuiltRecord], noInsertedRecords: false }
      ));
      throw new Error('force-rollback-after-rebuild');
    }), /force-rollback-after-rebuild/);
    assert.strictEqual(rebuiltRegistrationResult.insertedCount, 1,
      '新 scope 下重建的同 PK/snapshot witness 必须可正常登记');
    let unregisteredWitnessPk = null;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const unregisteredRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 5,
        name: 'unregistered-witness'
      });
      unregisteredWitnessPk = unregisteredRecord.entityPk;
      return unregisteredRecord;
    }), 'DEMO_OWNERSHIP_WITNESS_NOT_REGISTERED');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(unregisteredWitnessPk).total, 0, 'callback 返回时未登记 witness 必须触发整体回滚');

    const wrongBatchId = insertImportBatch(db, 'prediction_config', 'wrong-provenance.xlsx');
    assertErrorCode(() => runImmediateTransaction(db, () => insertPredictionWithWitness(db, {
      batchId: predictionBatchId,
      actualBatchId: wrongBatchId,
      sourceRowNumber: 5,
      name: 'wrong-provenance'
    })), 'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      assertErrorCode(() => insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        actualBatchId: wrongBatchId,
        sourceRowNumber: 6,
        name: 'caught-post-insert-provenance-failure'
      }), 'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH');
    }), 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM prediction_configs WHERE name = 'caught-post-insert-provenance-failure'")
      .get().total, 0, 'helper 插入后的校验错误即使被调用方捕获也必须回滚业务行');

    let firstRecord;
    let secondRecord;
    const registrationResult = runImmediateTransaction(db, () => {
      firstRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 6,
        name: 'legal-witness-a'
      });
      secondRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 7,
        name: 'legal-witness-b'
      });
      const input = buildOwnershipInput(db, actorUserId, predictionContext, predictionBindings, {
        insertedRecords: [firstRecord, secondRecord],
        noInsertedRecords: false,
        relations: [{
          from: { entityType: 'prediction_config', entityPk: secondRecord.entityPk },
          to: { entityType: 'prediction_config', entityPk: firstRecord.entityPk },
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
      `{"entityType":"prediction_config","entityPk":"${firstRecord.entityPk}"}`);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total, 2);
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total, 1);
    assertErrorCode(() => runImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        { insertedRecords: [firstRecord], noInsertedRecords: false }
      ))
    )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');

    assertErrorCode(() => runImmediateTransaction(db, () => {
      const metadataRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 8,
        name: 'relation-extra-metadata'
      });
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [metadataRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'prediction_config', entityPk: metadataRecord.entityPk },
            to: { entityType: 'prediction_config', entityPk: secondRecord.entityPk },
            relationType: 'uses_config',
            callerMetadata: 'forbidden'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_FIELDS_INVALID');
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const prototypeRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 9,
        name: 'relation-custom-prototype'
      });
      return registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [prototypeRecord],
          noInsertedRecords: false,
          relations: [{
            from: Object.assign(Object.create({ inherited: true }), {
              entityType: 'prediction_config', entityPk: prototypeRecord.entityPk
            }),
            to: { entityType: 'prediction_config', entityPk: secondRecord.entityPk },
            relationType: 'uses_config'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_INVALID');

    assertErrorCode(() => runImmediateTransaction(db, () => (
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [firstRecord],
          noInsertedRecords: false
        }
      ))
    )), 'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED');

    let forbiddenUpdateRecordId = null;
    assertErrorCode(() => runImmediateTransaction(db, (databaseFacade) => {
      const witnessedRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 8,
        name: 'forbidden-update-after-registration'
      });
      forbiddenUpdateRecordId = witnessedRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [witnessedRecord],
          noInsertedRecords: false
        }
      ));
      databaseFacade.prepare('UPDATE prediction_configs SET source_row_number = 9 WHERE id = ?');
    }), 'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(forbiddenUpdateRecordId).total, 0, '合法登记后 UPDATE 尝试必须 poison scope 并回滚业务行');
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(String(forbiddenUpdateRecordId)).total, 0,
    '合法登记后 UPDATE 尝试必须回滚 registry');

    let casRolledBackPredictionId = null;
    assert.throws(() => runImmediateTransaction(db, () => {
      const casRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 14,
        name: 'post-registrar-cas-failure'
      });
      casRolledBackPredictionId = casRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        { insertedRecords: [casRecord], noInsertedRecords: false }
      ));
      const casError = new Error('simulated-context-cas-failure');
      casError.code = 'DEMO_CONTEXT_STATE_CONFLICT';
      throw casError;
    }), (error) => error.code === 'DEMO_CONTEXT_STATE_CONFLICT');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(casRolledBackPredictionId).total, 0, 'registrar 后置 CAS 失败必须回滚业务插入');
    assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(String(casRolledBackPredictionId)).total, 0,
    'registrar 后置 CAS 失败必须回滚 registry');

    let rolledBackPredictionId = null;
    let executeContinued = false;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const rolledBackRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 10,
        name: 'rollback-record'
      });
      rolledBackPredictionId = rolledBackRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [rolledBackRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'prediction_config', entityPk: rolledBackRecord.entityPk },
            to: { entityType: 'prediction_config', entityPk: 999999 },
            relationType: 'uses_config'
          }]
        }
      ));
      executeContinued = true;
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
    assert.strictEqual(executeContinued, false, 'registration 失败后调用方 execute 不得继续');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(rolledBackPredictionId).total, 0, 'relation 失败必须回滚业务插入');
    assert.strictEqual(getTestDatabase(db).prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(String(rolledBackPredictionId)).total, 0,
    'relation 失败必须回滚 registry');

    getTestDatabase(db).prepare('DELETE FROM demo_run_import_batches WHERE context_id = ?').run(predictionContext.contextId);
    let rolledBackBatchLinkId = null;
    assertErrorCode(() => runImmediateTransaction(db, () => {
      const batchLinkRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 12,
        name: 'rollback-batch-link'
      });
      rolledBackBatchLinkId = batchLinkRecord.entityPk;
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [batchLinkRecord],
          noInsertedRecords: false,
          relations: [{
            from: { entityType: 'prediction_config', entityPk: batchLinkRecord.entityPk },
            to: { entityType: 'prediction_config', entityPk: 999999 },
            relationType: 'uses_config'
          }]
        }
      ));
    }), 'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches WHERE context_id = ?')
      .get(predictionContext.contextId).total, 0, 'relation 失败必须回滚补写的 batch link');
    assert.strictEqual(getTestDatabase(db).prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?')
      .get(rolledBackBatchLinkId).total, 0, 'batch link 失败必须回滚业务插入');

    assertErrorCode(() => runImmediateTransaction(db, () => {
      const metadataRecord = insertPredictionWithWitness(db, {
        batchId: predictionBatchId,
        sourceRowNumber: 11,
        name: 'extra-snapshot-metadata'
      });
      registerImportedDemoOwnershipInTransaction(buildOwnershipInput(
        db,
        actorUserId,
        predictionContext,
        predictionBindings,
        {
          insertedRecords: [{ ...metadataRecord, snapshot: { caller: 'forbidden' } }],
          noInsertedRecords: false
        }
      ));
    }), 'DEMO_OWNERSHIP_INSERTED_RECORD_FIELDS_INVALID');

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
