'use strict';

const demoTestBootstrap = require('./helpers/demoServiceTestHarness');
if (!demoTestBootstrap.fixedIsolatedChild && module.parent) {
  throw new Error('Demo ownership 固定测试入口不允许被普通模块间接加载。');
}
const { runFixedDemoOwnershipTest } = demoTestBootstrap;
// private registration contract 仅注入隔离子进程中的当前固定测试 Module。
const fixedDemoTestResult = runFixedDemoOwnershipTest('energy-strategy-evaluation-service');
if (fixedDemoTestResult.delegated) process.exit(0);

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试数据库和本地目录全部隔离到系统临时目录，禁止访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-strategy-preview-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-strategy-preview.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const database = require('../db/database');
const energyStrategyEvaluationService = require('../services/energyStrategyEvaluationService');
const {
  DEFAULT_MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_ITEMS,
  MAX_RULE_CODES,
  MAX_STRATEGY_RULES,
  SUPPORTED_FORMULA_VERSION,
  assertEnergyStrategyExactScopeCapability,
  buildEnergyStrategyExactScope,
  getEnergyStrategyExactScopeMetadata,
  normalizeRuleCodes,
  parseEvidenceRequirements,
  previewEnergyStrategies,
  runEnergyStrategyEvaluation,
  stableStringify,
  updateStrategyRuleHitStatus
} = require('../services/energyStrategyEvaluationService');
const {
  assertEnergyLoadExactScopeCapability
} = require('../services/energyConsumptionAnalysisService');
const demoOwnershipService = require('../services/demoOwnershipService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = demoOwnershipService;
const { createDemoOwnershipTestHarness } = require('./helpers/demoServiceTestHarness');
const {
  buildDemoEntityRegistrationContract
} = createDemoOwnershipTestHarness();
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const strategyOwnershipProtocol = require('../services/energyStrategyOwnershipProtocol');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');

// 策略测试统一使用上海来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 策略测试统一使用一小时左闭右开窗口。
const WINDOW_START_UTC = '2026-07-15T00:00:00.000Z';
// 策略测试窗口结束时间。
const WINDOW_END_UTC = '2026-07-15T01:00:00.000Z';
// 正常策略业务写统一使用隔离库内置管理员身份。
let auditActorUserId = null;

/**
 * 构造策略写操作审计选项。
 * @param {object} db SQLite 连接。
 * @param {object} overrides 覆盖选项。
 * @returns {object} 策略服务写入选项。
 */
function createWriteOptions(db, overrides = {}) {
  return {
    db,
    actorUserId: auditActorUserId,
    actorIp: '127.0.0.1',
    ...overrides
  };
}

/**
 * 捕获同步业务错误并断言稳定 details.code。
 * @param {Function} action 待执行动作。
 * @param {string} expectedCode 预期稳定错误码。
 * @returns {object} 捕获的业务错误。
 */
function assertBadRequestCode(action, expectedCode) {
  let capturedError = null;
  try {
    action();
  } catch (error) {
    capturedError = error;
  }
  assert(capturedError, `预期抛出 ${expectedCode}，实际未抛错。`);
  assert.strictEqual(capturedError.code, 'BAD_REQUEST');
  assert.strictEqual(capturedError.statusCode, 400);
  assert(capturedError.details, '业务错误必须包含安全 details。');
  assert.strictEqual(capturedError.details.code, expectedCode);
  return capturedError;
}

/** 捕获同步服务错误并断言稳定顶层错误码。 */
function assertServiceErrorCode(action, expectedCode) {
  let capturedError = null;
  try {
    action();
  } catch (error) {
    capturedError = error;
  }
  assert(capturedError, `预期抛出 ${expectedCode}，实际未抛错。`);
  assert.strictEqual(capturedError.code, expectedCode);
  assert.strictEqual(capturedError.statusCode, 500);
  return capturedError;
}

/**
 * 创建标准策略预演输入。
 * @param {number} meterDeviceId 表计 ID。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 策略预演输入。
 */
function createInput(meterDeviceId, overrides = {}) {
  return {
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: WINDOW_START_UTC,
    endUtc: WINDOW_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    ...overrides
  };
}

/**
 * 写入策略测试组织与电力表计。
 * @param {object} db SQLite 连接。
 * @returns {object} 主数据 ID。
 */
function seedMasterData(db) {
  // 电力能源类型沿用新库内置基础数据。
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  // 隔离组织仅用于本测试表计和时序事实。
  const organizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('STRATEGY-OU-001', '策略预演测试单元', '/策略预演测试单元', 'workshop', 'active')`
  ).run().lastInsertRowid);
  // 隔离表计能源类型与输入范围严格一致。
  const meterDeviceId = Number(db.prepare(
    `INSERT INTO meter_devices
       (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES ('STRATEGY-METER-001', '策略预演测试表计', 'electricity', ?, ?, 'active')`
  ).run(electricity.id, organizationUnitId).lastInsertRowid);
  return {
    electricityId: Number(electricity.id),
    organizationUnitId,
    meterDeviceId
  };
}

/**
 * 清理当前用例的规则、时序与预演持久化表。
 * @param {object} db SQLite 连接。
 */
function resetScenario(db) {
  db.prepare('DELETE FROM strategy_rule_hits').run();
  db.prepare('DELETE FROM strategy_evaluation_runs').run();
  db.prepare('DELETE FROM strategy_rules').run();
  db.prepare('DELETE FROM energy_timeseries_records').run();
}

/**
 * 读取策略正式运行、命中和运行审计数量。
 * @param {object} db SQLite 连接。
 * @returns {object} 三类业务写入数量。
 */
function getStrategyWriteCounts(db) {
  return {
    runCount: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    hitCount: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    auditCount: db.prepare(
      "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.run'"
    ).get().total
  };
}

/**
 * 创建隔离导入批次，供策略 exact scope provenance 测试使用。
 * @param {object} db SQLite 连接。
 * @param {string} importType 导入类型。
 * @returns {number} 批次 ID。
 */
function createImportBatch(db, importType) {
  return Number(db.prepare(
    `INSERT INTO import_batches (import_type, original_filename, file_type, status)
     VALUES (?, ?, 'csv', 'completed')`
  ).run(importType, `${importType}-strategy-exact.csv`).lastInsertRowid);
}

/**
 * 创建时序事实写入函数。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @returns {Function} 单条时序事实写入函数。
 */
function createTimeseriesInserter(db, ids) {
  // 写入语句只生成 active 手工测试事实。
  const insert = db.prepare(
    `INSERT INTO energy_timeseries_records (
       source_batch_id,
       source_row_number,
       organization_unit_id,
       meter_device_id,
       energy_type_id,
       start_utc,
       end_utc,
       source_timezone,
       granularity_minutes,
       original_unit,
       original_value,
       normalized_unit,
       normalized_value,
       source_reference,
       data_source,
       record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'kWh', ?, 'kWh', ?, ?, 'manual', ?)`
  );
  // 来源序号保证默认引用唯一且可追溯。
  let sourceSequence = 0;
  return (overrides = {}) => {
    sourceSequence += 1;
    // 原始值和规范值保持一致，避免测试引入单位转换变量。
    const value = Object.prototype.hasOwnProperty.call(overrides, 'value')
      ? overrides.value
      : 10;
    return Number(insert.run(
      Object.prototype.hasOwnProperty.call(overrides, 'sourceBatchId')
        ? overrides.sourceBatchId
        : null,
      Object.prototype.hasOwnProperty.call(overrides, 'sourceRowNumber')
        ? overrides.sourceRowNumber
        : null,
      ids.organizationUnitId,
      ids.meterDeviceId,
      ids.electricityId,
      overrides.startUtc || WINDOW_START_UTC,
      overrides.endUtc || '2026-07-15T00:15:00.000Z',
      overrides.sourceTimeZone || SOURCE_TIME_ZONE,
      overrides.granularityMinutes || 15,
      value,
      value,
      overrides.sourceReference || `strategy-preview:test:${sourceSequence}`,
      overrides.recordStatus || 'active'
    ).lastInsertRowid);
  };
}

/**
 * 写入从窗口开始连续排列的十五分钟时序事实。
 * @param {Function} insertTimeseries 单条写入函数。
 * @param {number[]} values 每个十五分钟区间能源量。
 * @returns {number[]} 写入事实 ID。
 */
function insertQuarterHourSeries(insertTimeseries, values, overrides = {}) {
  return values.map((value, index) => {
    // 区间边界由固定窗口开始时间按十五分钟递增。
    const startMs = Date.parse(WINDOW_START_UTC) + index * 15 * 60 * 1000;
    return insertTimeseries({
      ...overrides,
      sourceRowNumber: Object.prototype.hasOwnProperty.call(overrides, 'sourceRowNumber')
        ? overrides.sourceRowNumber + index
        : overrides.sourceRowNumber,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(startMs + 15 * 60 * 1000).toISOString(),
      granularityMinutes: 15,
      value,
      sourceReference: overrides.sourceReference || `strategy-preview:quarter:${index + 1}`
    });
  });
}

/**
 * 创建策略规则写入函数。
 * @param {object} db SQLite 连接。
 * @returns {Function} 单条规则写入函数。
 */
function createRuleInserter(db) {
  // 写入字段精确对应 strategy_rules 当前 schema。
  const insert = db.prepare(
    `INSERT INTO strategy_rules (
       source_batch_id,
       source_row_number,
       rule_code,
       rule_name,
       rule_version,
       formula_version,
       metric_code,
       threshold_operator,
       threshold_value,
       threshold_min,
       threshold_max,
       threshold_unit,
       reduction_rate,
       priority,
       evidence_requirements_json,
       recommendation_text,
       source,
       effective_start_utc,
       effective_end_utc,
       source_timezone,
       status
     ) VALUES (
       @sourceBatchId,
       @sourceRowNumber,
       @ruleCode,
       @ruleName,
       @ruleVersion,
       @formulaVersion,
       @metricCode,
       @thresholdOperator,
       @thresholdValue,
       @thresholdMin,
       @thresholdMax,
       @thresholdUnit,
       @reductionRate,
       @priority,
       @evidenceRequirementsJson,
       @recommendation,
       @source,
       @effectiveStartUtc,
       @effectiveEndUtc,
       @sourceTimeZone,
       @status
     )`
  );
  // 规则序号用于生成满足 name:v1 契约的唯一版本。
  let ruleSequence = 0;
  return (overrides = {}) => {
    ruleSequence += 1;
    // between 与单值阈值字段按 schema 互斥写入。
    const thresholdOperator = overrides.thresholdOperator || 'gte';
    const isBetween = thresholdOperator === 'between';
    // 默认配置要求完整覆盖并允许完整窗口总能耗节能估算。
    const evidenceRequirementsJson = Object.prototype.hasOwnProperty.call(
      overrides,
      'evidenceRequirementsJson'
    ) ? overrides.evidenceRequirementsJson : JSON.stringify({
      minimumCoverageRate: 1,
      maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
      savingBasis: 'window_total_energy'
    });
    // 当前规则编码允许测试显式覆盖。
    const ruleCode = overrides.ruleCode || `STRATEGY_RULE_${ruleSequence}`;
    return Number(insert.run({
      sourceBatchId: Object.prototype.hasOwnProperty.call(overrides, 'sourceBatchId')
        ? overrides.sourceBatchId
        : null,
      sourceRowNumber: Object.prototype.hasOwnProperty.call(overrides, 'sourceRowNumber')
        ? overrides.sourceRowNumber
        : null,
      ruleCode,
      ruleName: overrides.ruleName || `策略规则 ${ruleSequence}`,
      ruleVersion: overrides.ruleVersion || `strategy-rule-${ruleSequence}:v1`,
      formulaVersion: overrides.formulaVersion || SUPPORTED_FORMULA_VERSION,
      metricCode: overrides.metricCode || 'load_rate',
      thresholdOperator,
      thresholdValue: isBetween
        ? null
        : (Object.prototype.hasOwnProperty.call(overrides, 'thresholdValue')
          ? overrides.thresholdValue
          : 60),
      thresholdMin: isBetween
        ? (Object.prototype.hasOwnProperty.call(overrides, 'thresholdMin')
          ? overrides.thresholdMin
          : 50)
        : null,
      thresholdMax: isBetween
        ? (Object.prototype.hasOwnProperty.call(overrides, 'thresholdMax')
          ? overrides.thresholdMax
          : 70)
        : null,
      thresholdUnit: overrides.thresholdUnit || '%',
      reductionRate: Object.prototype.hasOwnProperty.call(overrides, 'reductionRate')
        ? overrides.reductionRate
        : null,
      priority: overrides.priority || 'medium',
      evidenceRequirementsJson,
      recommendation: overrides.recommendation || '请人工复核指标证据后调整用能计划。',
      source: overrides.source || 'isolated-test',
      effectiveStartUtc: overrides.effectiveStartUtc || '2026-01-01T00:00:00.000Z',
      effectiveEndUtc: overrides.effectiveEndUtc || '2027-01-01T00:00:00.000Z',
      sourceTimeZone: overrides.sourceTimeZone || SOURCE_TIME_ZONE,
      status: overrides.status || 'active'
    }).lastInsertRowid);
  };
}

/**
 * 按规则编码读取单条评价。
 * @param {object} result 策略预演结果。
 * @param {string} ruleCode 规则编码。
 * @returns {object} 命中的规则评价。
 */
function getEvaluation(result, ruleCode) {
  // 同一用例规则编码唯一，缺失时直接使测试失败。
  const evaluation = result.evaluations.find((item) => item.ruleCode === ruleCode);
  assert(evaluation, `缺少规则评价 ${ruleCode}。`);
  return evaluation;
}

/**
 * 为隔离测试中的策略命中写入固定 derived ownership。
 * @param {object} db SQLite 连接。
 * @param {object} runRecord 当前演示数据集运行。
 * @param {number} hitId 策略命中 ID。
 * @returns {object} 登记行和初始 projection。
 */
function insertDerivedStrategyHitOwnership(db, runRecord, hitId) {
  // 固定 handler 是命中快照和摘要的唯一来源。
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit;
  const projection = handler.readProjection(db, hitId);
  assert(projection, `缺少策略命中 ${hitId} 的 ownership projection。`);
  const identityDigest = calculateDemoEntityIdentityDigest('strategy_rule_hit', String(hitId));
  const snapshotDigest = calculateDemoEntitySnapshotDigest(
    'strategy_rule_hit',
    String(hitId),
    projection
  );
  const registryId = Number(db.prepare(
    `INSERT INTO demo_data_registry
       (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
        snapshot_digest, source_batch_id, source_row_number, registered_by)
     VALUES (?, '18-strategy-rules', 'strategy_rule_hit', ?, 'derived', ?, ?, NULL, NULL, ?)`
  ).run(
    runRecord.runId,
    String(hitId),
    identityDigest,
    snapshotDigest,
    auditActorUserId
  ).lastInsertRowid);
  return {
    registryId,
    identityDigest,
    snapshotDigest,
    projection
  };
}

/**
 * 验证两个首期指标正常匹配、未匹配和预计节能门槛。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testSupportedMetrics(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  // 完整时序能源量依次为 10、20、30、40 kWh。
  const timeseriesIds = insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'LOAD_RATE_MATCH',
    metricCode: 'load_rate',
    thresholdOperator: 'gte',
    thresholdValue: 60,
    thresholdUnit: '%',
    reductionRate: 0.1,
    priority: 'high'
  });
  insertRule({
    ruleCode: 'PEAK_ENERGY_NOT_MATCH',
    metricCode: 'peak_interval_energy',
    thresholdOperator: 'gt',
    thresholdValue: 50,
    thresholdUnit: 'kWh/15min',
    reductionRate: 0.2
  });

  const beforeRuns = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  const beforeHits = db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total;
  const result = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const loadRateEvaluation = getEvaluation(result, 'LOAD_RATE_MATCH');
  const peakEvaluation = getEvaluation(result, 'PEAK_ENERGY_NOT_MATCH');

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.persistsEvaluationRun, false);
  assert.strictEqual(result.formulaVersion, 'load-analysis:v1');
  assert.strictEqual(result.ruleSelection.status, 'active');
  assert.strictEqual(result.ruleSelection.effectiveCoverage, 'full_window');
  assert.strictEqual(result.ruleSelection.selectedRuleCount, 2);
  assert.strictEqual(result.dataSelection.sourceTable, 'energy_timeseries_records');
  assert.strictEqual(result.dataSummary.recordCount, 4);
  assert.strictEqual(result.dataSummaryDigest.startsWith('sha256:'), true);
  assert.strictEqual(result.dataSummaryDigest.length, 71);
  assert.strictEqual(result.dataSelection.consistentReadSnapshot, true);
  assert.deepStrictEqual(result.automationBoundary, {
    usesAI: false,
    issuesControlCommand: false,
    changesDeviceState: false,
    requiresManualReview: true
  });

  assert.strictEqual(loadRateEvaluation.matchStatus, 'matched');
  assert.strictEqual(loadRateEvaluation.actualValue, 62.5);
  assert.strictEqual(loadRateEvaluation.threshold.unit, '%');
  assert.strictEqual(loadRateEvaluation.coverageRate, 1);
  assert.strictEqual(loadRateEvaluation.estimatedSaving, 10);
  assert.strictEqual(loadRateEvaluation.estimatedSavingUnit, 'kWh');
  assert.deepStrictEqual(loadRateEvaluation.configurationErrors, []);
  assert.strictEqual(
    loadRateEvaluation.evidence.includes(`timeseries:${timeseriesIds[3]}`),
    true,
    '负荷率证据必须引用真实最大负荷时序 ID。'
  );
  assert.strictEqual(
    loadRateEvaluation.evidence.includes(`data-summary-sha256:${result.dataSummaryDigest.slice(7)}`),
    true
  );
  assert.strictEqual(
    loadRateEvaluation.evidence.includes(`evaluation-sha256:${loadRateEvaluation.evaluationDigest.slice(7)}`),
    true
  );
  assert.strictEqual(loadRateEvaluation.dataSummaryDigest, result.dataSummaryDigest);
  assert.notStrictEqual(loadRateEvaluation.evaluationDigest, peakEvaluation.evaluationDigest);

  assert.strictEqual(peakEvaluation.matchStatus, 'not_matched');
  assert.strictEqual(peakEvaluation.actualValue, 40);
  assert.strictEqual(peakEvaluation.threshold.unit, 'kWh/15min');
  assert.strictEqual(peakEvaluation.estimatedSaving, null);
  assert.strictEqual(
    peakEvaluation.evidence.includes(
      'peak-interval:2026-07-15T00:45:00.000Z/2026-07-15T01:00:00.000Z'
    ),
    true
  );
  assert.deepStrictEqual(peakEvaluation.contractValidation, { valid: true, errors: [] });

  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeRuns,
    '预演不得写 strategy_evaluation_runs。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    beforeHits,
    '预演不得写 strategy_rule_hits。'
  );
}

/**
 * 验证全零负荷率和缺少完整峰值候选时正常返回不可评估。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testNotEvaluableMetricQuality(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [0, 0, 0, 0]);
  insertRule({ ruleCode: 'ZERO_LOAD_RATE', metricCode: 'load_rate' });
  insertRule({
    ruleCode: 'ZERO_PEAK_ENERGY',
    metricCode: 'peak_interval_energy',
    thresholdOperator: 'lte',
    thresholdValue: 0,
    thresholdUnit: 'kWh/15min',
    reductionRate: 0.1
  });
  const zeroResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const zeroEvaluation = getEvaluation(zeroResult, 'ZERO_LOAD_RATE');
  const zeroPeakEvaluation = getEvaluation(zeroResult, 'ZERO_PEAK_ENERGY');
  assert.strictEqual(zeroResult.dataSummary.metrics.totalEnergy, 0);
  assert.strictEqual(zeroResult.dataSummary.metrics.loadRatePercent, null);
  assert.strictEqual(zeroEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(zeroEvaluation.actualValue, null);
  assert.strictEqual(zeroEvaluation.estimatedSaving, null);
  assert.strictEqual(zeroEvaluation.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
  assert.strictEqual(zeroResult.dataSummary.peakInterval.energy, 0);
  assert.strictEqual(zeroPeakEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(zeroPeakEvaluation.actualValue, null);
  assert.strictEqual(zeroPeakEvaluation.estimatedSaving, null);
  assert.strictEqual(zeroPeakEvaluation.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
  assert.strictEqual(
    zeroPeakEvaluation.evidence.some((item) => item.startsWith('peak-interval:')),
    true,
    '零峰值仍可保留真实完整候选区间，但不得进入阈值匹配。'
  );

  resetScenario(db);
  // 单条三十分钟记录只与十五分钟查询窗口相交，不是完整落窗峰值候选。
  const partialId = insertTimeseries({
    startUtc: '2026-07-14T23:45:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 30,
    value: 20,
    sourceReference: 'strategy-preview:partial-boundary'
  });
  insertRule({
    ruleCode: 'NO_FULL_PEAK',
    metricCode: 'peak_interval_energy',
    thresholdUnit: 'kWh/30min',
    thresholdValue: 10
  });
  const partialResult = previewEnergyStrategies(createInput(ids.meterDeviceId, {
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  const partialEvaluation = getEvaluation(partialResult, 'NO_FULL_PEAK');
  assert.strictEqual(partialResult.dataSummary.quality.coverageRate, 1);
  assert.strictEqual(partialResult.dataSummary.peakInterval.energy, null);
  assert.strictEqual(partialEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(partialEvaluation.actualValue, null);
  assert.strictEqual(partialEvaluation.evidence.includes(`timeseries:${partialId}`), false);
  assert.strictEqual(
    partialEvaluation.evidence.some((item) => item.startsWith('peak-interval:')),
    false,
    '没有完整峰值候选时不得伪造峰值区间证据。'
  );
}

/**
 * 验证规则状态、完整有效期、公式版本和 ruleCodes 筛选边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testRuleSelection(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({ ruleCode: 'ACTIVE_FULL_A' });
  insertRule({ ruleCode: 'ACTIVE_FULL_B' });
  insertRule({ ruleCode: 'INACTIVE_RULE', status: 'inactive' });
  insertRule({
    ruleCode: 'LEFT_OVERLAP_ONLY',
    effectiveStartUtc: '2026-07-15T00:30:00.000Z',
    effectiveEndUtc: '2026-07-15T02:00:00.000Z'
  });
  insertRule({
    ruleCode: 'RIGHT_OVERLAP_ONLY',
    effectiveStartUtc: '2026-07-14T23:00:00.000Z',
    effectiveEndUtc: '2026-07-15T00:30:00.000Z'
  });
  insertRule({
    ruleCode: 'EXPIRED_RULE',
    effectiveStartUtc: '2025-01-01T00:00:00.000Z',
    effectiveEndUtc: '2026-01-01T00:00:00.000Z'
  });
  insertRule({
    ruleCode: 'FUTURE_RULE',
    effectiveStartUtc: '2027-01-01T00:00:00.000Z',
    effectiveEndUtc: '2028-01-01T00:00:00.000Z'
  });
  insertRule({ ruleCode: 'OTHER_FORMULA', formulaVersion: 'other-load:v1' });

  const allResult = previewEnergyStrategies(createInput(ids.meterDeviceId, { ruleCodes: [] }), { db });
  assert.deepStrictEqual(
    allResult.evaluations.map((item) => item.ruleCode),
    ['ACTIVE_FULL_A', 'ACTIVE_FULL_B'],
    '仅 active、完整覆盖窗口且公式版本一致的规则可进入预演。'
  );

  const filteredResult = previewEnergyStrategies(createInput(ids.meterDeviceId, {
    ruleCodes: ['ACTIVE_FULL_B', 'ACTIVE_FULL_B']
  }), { db });
  assert.deepStrictEqual(filteredResult.ruleSelection.requestedRuleCodes, ['ACTIVE_FULL_B']);
  assert.deepStrictEqual(filteredResult.evaluations.map((item) => item.ruleCode), ['ACTIVE_FULL_B']);

  const tooManyRuleCodes = Array.from({ length: MAX_RULE_CODES + 1 }, (_item, index) => `RULE_${index}`);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId, { ruleCodes: tooManyRuleCodes }), { db }),
    'STRATEGY_RULE_CODE_LIMIT_EXCEEDED'
  );

  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  Array.from({ length: MAX_STRATEGY_RULES + 1 }, (_item, index) => index).forEach((index) => {
    insertRule({ ruleCode: `TOO_MANY_SELECTED_${String(index).padStart(2, '0')}` });
  });
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), { db }),
    'STRATEGY_RULE_LIMIT_EXCEEDED'
  );
}

/**
 * 验证未知指标、非法阈值与证据 JSON 均逐规则安全降级。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testRuleConfigurationFailures(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({ ruleCode: 'UNKNOWN_METRIC', metricCode: 'dynamic_function_name' });
  insertRule({
    ruleCode: 'INVALID_THRESHOLD_VALUE',
    thresholdValue: Number.POSITIVE_INFINITY
  });
  insertRule({ ruleCode: 'UNIT_MISMATCH', thresholdUnit: 'ratio' });
  insertRule({ ruleCode: 'INVALID_JSON', evidenceRequirementsJson: '{bad-json' });
  insertRule({
    ruleCode: 'UNKNOWN_EVIDENCE_FIELD',
    evidenceRequirementsJson: JSON.stringify({ minimumCoverageRate: 1, unknownField: true })
  });
  insertRule({
    ruleCode: 'INVALID_COVERAGE',
    evidenceRequirementsJson: JSON.stringify({ minimumCoverageRate: 1.1 })
  });
  insertRule({
    ruleCode: 'INVALID_EVIDENCE_LIMIT',
    evidenceRequirementsJson: JSON.stringify({ maxEvidenceItems: MAX_EVIDENCE_ITEMS + 1 })
  });
  insertRule({
    ruleCode: 'INVALID_SAVING_BASIS',
    evidenceRequirementsJson: JSON.stringify({ savingBasis: 'peak_interval_energy' })
  });

  const result = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const expectedConfigurationErrors = new Map([
    ['UNKNOWN_METRIC', 'UNSUPPORTED_STRATEGY_METRIC'],
    ['INVALID_THRESHOLD_VALUE', 'INVALID_RULE_THRESHOLD_VALUE'],
    ['UNIT_MISMATCH', 'STRATEGY_THRESHOLD_UNIT_MISMATCH'],
    ['INVALID_JSON', 'INVALID_EVIDENCE_REQUIREMENTS_JSON'],
    ['UNKNOWN_EVIDENCE_FIELD', 'UNKNOWN_EVIDENCE_REQUIREMENT_FIELD'],
    ['INVALID_COVERAGE', 'INVALID_EVIDENCE_MINIMUM_COVERAGE_RATE'],
    ['INVALID_EVIDENCE_LIMIT', 'INVALID_EVIDENCE_MAX_ITEMS'],
    ['INVALID_SAVING_BASIS', 'INVALID_EVIDENCE_SAVING_BASIS']
  ]);

  expectedConfigurationErrors.forEach((expectedError, ruleCode) => {
    const evaluation = getEvaluation(result, ruleCode);
    assert.strictEqual(evaluation.matchStatus, 'not_evaluable', ruleCode);
    assert.strictEqual(evaluation.actualValue, null, ruleCode);
    assert.strictEqual(evaluation.estimatedSaving, null, ruleCode);
    assert.strictEqual(
      evaluation.configurationErrors.includes(expectedError)
        || evaluation.errors.includes(expectedError),
      true,
      `${ruleCode} 必须包含 ${expectedError}。`
    );
    assert.deepStrictEqual(evaluation.contractValidation, { valid: true, errors: [] }, ruleCode);
  });
}

/**
 * 验证覆盖率门槛、证据上限、真实 ID 和摘要确定性。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testCoverageAndEvidence(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  const timeseriesIds = insertQuarterHourSeries(insertTimeseries, [10, 20]);
  insertRule({
    ruleCode: 'COVERAGE_TOO_LOW',
    evidenceRequirementsJson: JSON.stringify({
      minimumCoverageRate: 0.75,
      maxEvidenceItems: 10,
      savingBasis: 'window_total_energy'
    })
  });
  const lowCoverageResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const lowCoverageEvaluation = getEvaluation(lowCoverageResult, 'COVERAGE_TOO_LOW');
  assert.strictEqual(lowCoverageEvaluation.coverageRate, 0.5);
  assert.strictEqual(lowCoverageEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(lowCoverageEvaluation.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
  assert.strictEqual(lowCoverageEvaluation.estimatedSaving, null);

  resetScenario(db);
  const fullTimeseriesIds = insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'ONE_EVIDENCE_ITEM',
    evidenceRequirementsJson: JSON.stringify({
      minimumCoverageRate: 1,
      maxEvidenceItems: 1,
      savingBasis: 'window_total_energy'
    })
  });
  insertRule({ ruleCode: 'DETERMINISTIC_EVIDENCE' });
  const firstResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const secondResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const limitedEvaluation = getEvaluation(firstResult, 'ONE_EVIDENCE_ITEM');
  const deterministicEvaluation = getEvaluation(firstResult, 'DETERMINISTIC_EVIDENCE');

  assert.deepStrictEqual(firstResult, secondResult, '相同规则和数据必须得到完全确定的预演响应。');
  assert.deepStrictEqual(limitedEvaluation.evidence.slice(0, 7), [
    `window:${WINDOW_START_UTC}/${WINDOW_END_UTC}`,
    `meter:${ids.meterDeviceId}`,
    `scope:energy-type=electricity;unit=kWh;source-timezone=${SOURCE_TIME_ZONE}`,
    'metric:load_rate',
    'record-count:4',
    `data-summary-sha256:${firstResult.dataSummaryDigest.slice(7)}`,
    `evaluation-sha256:${limitedEvaluation.evaluationDigest.slice(7)}`
  ]);
  assert.strictEqual(limitedEvaluation.evidence.length, 8);
  assert.strictEqual(limitedEvaluation.evidence[7], `timeseries:${fullTimeseriesIds[3]}`);
  assert.deepStrictEqual(limitedEvaluation.evidencePolicy, {
    maxEvidenceItemsSemantics: 'timeseries_detail_limit_only',
    requiredEvidenceCount: 7,
    detailEvidenceLimit: 1,
    availableDetailEvidenceCount: 1,
    returnedDetailEvidenceCount: 1,
    detailEvidenceTruncated: false
  });
  assert.strictEqual(deterministicEvaluation.evidence[0], `window:${WINDOW_START_UTC}/${WINDOW_END_UTC}`);
  assert.strictEqual(deterministicEvaluation.evidence.includes(`timeseries:${fullTimeseriesIds[3]}`), true);
  assert.strictEqual(deterministicEvaluation.evidence.includes(`timeseries:${timeseriesIds[0]}`), false);
  assert.strictEqual(
    deterministicEvaluation.evidence.includes(
      `data-summary-sha256:${firstResult.dataSummaryDigest.slice(7)}`
    ),
    true
  );
  assert.strictEqual(
    deterministicEvaluation.evidence.includes(
      `evaluation-sha256:${deterministicEvaluation.evaluationDigest.slice(7)}`
    ),
    true
  );
  assert.strictEqual(
    /^[a-f0-9]{64}$/.test(firstResult.dataSummaryDigest.slice(7)),
    true,
    '数据摘要引用必须是 SHA-256 十六进制值。'
  );
  assert.strictEqual(
    /^[a-f0-9]{64}$/.test(deterministicEvaluation.evaluationDigest.slice(7)),
    true,
    '逐规则评价摘要必须是 SHA-256 十六进制值。'
  );
}

/**
 * 验证数据摘要与逐规则评价摘要职责分离并绑定全部规则输入。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testEvaluationDigestBinding(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'DIGEST_BINDING_RULE',
    thresholdValue: 60,
    priority: 'medium',
    recommendation: '请人工复核基础规则。'
  });
  // 固定规则筛选确保每次只比较同一规则身份。
  const digestInput = createInput(ids.meterDeviceId, { ruleCodes: ['DIGEST_BINDING_RULE'] });
  const baselineResult = previewEnergyStrategies(digestInput, { db });
  const baselineEvaluation = getEvaluation(baselineResult, 'DIGEST_BINDING_RULE');

  db.prepare("UPDATE strategy_rules SET threshold_value = 61 WHERE rule_code = 'DIGEST_BINDING_RULE'").run();
  const thresholdResult = previewEnergyStrategies(digestInput, { db });
  const thresholdEvaluation = getEvaluation(thresholdResult, 'DIGEST_BINDING_RULE');
  assert.strictEqual(thresholdResult.dataSummaryDigest, baselineResult.dataSummaryDigest);
  assert.notStrictEqual(thresholdEvaluation.evaluationDigest, baselineEvaluation.evaluationDigest);

  db.prepare("UPDATE strategy_rules SET recommendation_text = '请人工复核更新后的规则。' WHERE rule_code = 'DIGEST_BINDING_RULE'").run();
  const recommendationResult = previewEnergyStrategies(digestInput, { db });
  const recommendationEvaluation = getEvaluation(recommendationResult, 'DIGEST_BINDING_RULE');
  assert.strictEqual(recommendationResult.dataSummaryDigest, baselineResult.dataSummaryDigest);
  assert.notStrictEqual(recommendationEvaluation.evaluationDigest, thresholdEvaluation.evaluationDigest);

  db.prepare("UPDATE strategy_rules SET priority = 'high' WHERE rule_code = 'DIGEST_BINDING_RULE'").run();
  const priorityResult = previewEnergyStrategies(digestInput, { db });
  const priorityEvaluation = getEvaluation(priorityResult, 'DIGEST_BINDING_RULE');
  assert.strictEqual(priorityResult.dataSummaryDigest, baselineResult.dataSummaryDigest);
  assert.notStrictEqual(priorityEvaluation.evaluationDigest, recommendationEvaluation.evaluationDigest);
  assert.strictEqual(
    priorityEvaluation.evidence.includes(
      `evaluation-sha256:${priorityEvaluation.evaluationDigest.slice(7)}`
    ),
    true,
    '证据必须引用当前逐规则评价摘要。'
  );
}

/**
 * 验证非有限阈值的规范编码不会产生逐规则评价摘要碰撞。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testNonFiniteEvaluationDigestEncoding(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'NON_FINITE_DIGEST_RULE',
    thresholdValue: Number.POSITIVE_INFINITY
  });
  // 固定规则身份和数据范围，只改变非法阈值数值。
  const digestInput = createInput(ids.meterDeviceId, { ruleCodes: ['NON_FINITE_DIGEST_RULE'] });
  // 非法阈值断言统一验证安全降级，不允许进入匹配或节能估算。
  const assertInvalidThresholdEvaluation = (evaluation, label) => {
    assert.strictEqual(evaluation.matchStatus, 'not_evaluable', label);
    assert.strictEqual(evaluation.actualValue, null, label);
    assert.strictEqual(evaluation.estimatedSaving, null, label);
    assert.strictEqual(
      evaluation.errors.some((errorCode) => [
        'INVALID_RULE_THRESHOLD_VALUE',
        'INVALID_RULE_THRESHOLD_RANGE'
      ].includes(errorCode)),
      true,
      `${label} 必须包含非法阈值错误。`
    );
  };

  const positiveInfinityResult = previewEnergyStrategies(digestInput, { db });
  const positiveInfinityRepeatResult = previewEnergyStrategies(digestInput, { db });
  const positiveInfinityEvaluation = getEvaluation(
    positiveInfinityResult,
    'NON_FINITE_DIGEST_RULE'
  );
  const positiveInfinityRepeatEvaluation = getEvaluation(
    positiveInfinityRepeatResult,
    'NON_FINITE_DIGEST_RULE'
  );
  assertInvalidThresholdEvaluation(positiveInfinityEvaluation, '正无穷阈值');
  assert.strictEqual(
    positiveInfinityRepeatEvaluation.evaluationDigest,
    positiveInfinityEvaluation.evaluationDigest,
    '相同非有限阈值输入必须得到稳定评价摘要。'
  );

  db.prepare(
    "UPDATE strategy_rules SET threshold_value = ? WHERE rule_code = 'NON_FINITE_DIGEST_RULE'"
  ).run(Number.NEGATIVE_INFINITY);
  const negativeInfinityResult = previewEnergyStrategies(digestInput, { db });
  const negativeInfinityEvaluation = getEvaluation(
    negativeInfinityResult,
    'NON_FINITE_DIGEST_RULE'
  );
  assertInvalidThresholdEvaluation(negativeInfinityEvaluation, '负无穷阈值');

  // SQLite 会把绑定 NaN 转成 NULL，使用不可转数值文本使服务规范阶段真实得到 NaN。
  db.prepare(
    "UPDATE strategy_rules SET threshold_value = 'not-a-number' WHERE rule_code = 'NON_FINITE_DIGEST_RULE'"
  ).run();
  const nanResult = previewEnergyStrategies(digestInput, { db });
  const nanEvaluation = getEvaluation(nanResult, 'NON_FINITE_DIGEST_RULE');
  assertInvalidThresholdEvaluation(nanEvaluation, 'NaN 阈值');

  assert.strictEqual(negativeInfinityResult.dataSummaryDigest, positiveInfinityResult.dataSummaryDigest);
  assert.strictEqual(nanResult.dataSummaryDigest, positiveInfinityResult.dataSummaryDigest);
  assert.strictEqual(new Set([
    positiveInfinityEvaluation.evaluationDigest,
    negativeInfinityEvaluation.evaluationDigest,
    nanEvaluation.evaluationDigest
  ]).size, 3, 'Infinity、-Infinity 与 NaN 必须得到不同评价摘要。');

  // between 上下界使用多组非有限组合，摘要必须绑定数值类型和所在位置。
  db.prepare(
    `UPDATE strategy_rules
        SET threshold_operator = 'between',
            threshold_value = NULL,
            threshold_min = ?,
            threshold_max = ?
      WHERE rule_code = 'NON_FINITE_DIGEST_RULE'`
  ).run(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  const betweenInfinityResult = previewEnergyStrategies(digestInput, { db });
  const betweenInfinityEvaluation = getEvaluation(
    betweenInfinityResult,
    'NON_FINITE_DIGEST_RULE'
  );
  assertInvalidThresholdEvaluation(betweenInfinityEvaluation, 'between 负无穷至正无穷阈值');

  db.prepare(
    `UPDATE strategy_rules
        SET threshold_min = ?,
            threshold_max = ?
      WHERE rule_code = 'NON_FINITE_DIGEST_RULE'`
  ).run(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const betweenPositiveInfinityResult = previewEnergyStrategies(digestInput, { db });
  const betweenPositiveInfinityEvaluation = getEvaluation(
    betweenPositiveInfinityResult,
    'NON_FINITE_DIGEST_RULE'
  );
  assertInvalidThresholdEvaluation(betweenPositiveInfinityEvaluation, 'between 双正无穷阈值');

  db.prepare(
    `UPDATE strategy_rules
        SET threshold_min = 'not-a-number-a',
            threshold_max = 'not-a-number-b'
      WHERE rule_code = 'NON_FINITE_DIGEST_RULE'`
  ).run();
  const betweenNanResult = previewEnergyStrategies(digestInput, { db });
  const betweenNanEvaluation = getEvaluation(betweenNanResult, 'NON_FINITE_DIGEST_RULE');
  assertInvalidThresholdEvaluation(betweenNanEvaluation, 'between 双 NaN 阈值');

  assert.strictEqual(betweenInfinityResult.dataSummaryDigest, positiveInfinityResult.dataSummaryDigest);
  assert.strictEqual(
    betweenPositiveInfinityResult.dataSummaryDigest,
    positiveInfinityResult.dataSummaryDigest
  );
  assert.strictEqual(betweenNanResult.dataSummaryDigest, positiveInfinityResult.dataSummaryDigest);
  assert.strictEqual(new Set([
    betweenInfinityEvaluation.evaluationDigest,
    betweenPositiveInfinityEvaluation.evaluationDigest,
    betweenNanEvaluation.evaluationDigest
  ]).size, 3, 'between 上下界非有限组合必须得到不同评价摘要。');
}

/**
 * 验证自动控制承诺拒绝与预计节能量全部门槛。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testAutomationAndSavingGates(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'FORBIDDEN_AUTOMATION',
    thresholdValue: 50,
    reductionRate: 0.1,
    recommendation: '系统将自动下发控制命令。'
  });
  insertRule({
    ruleCode: 'VALID_SAVING',
    thresholdValue: 50,
    reductionRate: 0.1
  });
  insertRule({
    ruleCode: 'NO_REDUCTION_RATE',
    thresholdValue: 50
  });
  insertRule({
    ruleCode: 'NO_SAVING_BASIS',
    thresholdValue: 50,
    reductionRate: 0.1,
    evidenceRequirementsJson: JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10 })
  });

  const result = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  const forbiddenEvaluation = getEvaluation(result, 'FORBIDDEN_AUTOMATION');
  const validSavingEvaluation = getEvaluation(result, 'VALID_SAVING');
  const noReductionEvaluation = getEvaluation(result, 'NO_REDUCTION_RATE');
  const noBasisEvaluation = getEvaluation(result, 'NO_SAVING_BASIS');

  assert.strictEqual(forbiddenEvaluation.matchStatus, 'not_evaluable');
  assert.strictEqual(forbiddenEvaluation.actualValue, null);
  assert.strictEqual(forbiddenEvaluation.estimatedSaving, null);
  assert.strictEqual(forbiddenEvaluation.errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'), true);
  assert.notStrictEqual(forbiddenEvaluation.recommendation, '系统将自动下发控制命令。');
  assert.strictEqual(forbiddenEvaluation.issuesControlCommand, false);
  assert.strictEqual(forbiddenEvaluation.changesDeviceState, false);

  assert.strictEqual(validSavingEvaluation.matchStatus, 'matched');
  assert.strictEqual(validSavingEvaluation.estimatedSaving, 10);
  assert.strictEqual(validSavingEvaluation.estimatedSavingUnit, 'kWh');
  assert.strictEqual(noReductionEvaluation.matchStatus, 'matched');
  assert.strictEqual(noReductionEvaluation.estimatedSaving, null);
  assert.strictEqual(noBasisEvaluation.matchStatus, 'matched');
  assert.strictEqual(noBasisEvaluation.savingBasis, null);
  assert.strictEqual(noBasisEvaluation.estimatedSaving, null);
}

/**
 * 验证非 WAL 写入阻塞、WAL 并发提交和调用方事务复用的一致读取快照。
 * @param {object} db 调用方 SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testConsistentReadSnapshot(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'SNAPSHOT_RULE',
    thresholdValue: 60,
    recommendation: '请人工复核快照规则。'
  });
  // rollback journal 下读事务允许第二连接安全失败，不允许半新半旧响应。
  db.pragma('journal_mode = DELETE');
  let competingConnection = database.openDatabase();
  let nonWalWriteCode = null;
  try {
    competingConnection.pragma('busy_timeout = 20');
    const nonWalResult = previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      testOnlyAfterLoadSummary: () => {
        try {
          competingConnection.prepare(
            "UPDATE strategy_rules SET threshold_value = 90 WHERE rule_code = 'SNAPSHOT_RULE'"
          ).run();
        } catch (error) {
          nonWalWriteCode = error.code;
        }
      }
    });
    assert.strictEqual(nonWalWriteCode, 'SQLITE_BUSY');
    assert.strictEqual(getEvaluation(nonWalResult, 'SNAPSHOT_RULE').threshold.value, 60);
    assert.strictEqual(db.inTransaction, false, '服务自建读取事务必须在返回前提交。');
  } finally {
    competingConnection.close();
  }

  // WAL 下第二连接可以在摘要与规则查询之间提交，但当前响应必须保持旧快照。
  db.pragma('journal_mode = WAL');
  competingConnection = database.openDatabase();
  let walWriteSucceeded = false;
  try {
    competingConnection.pragma('busy_timeout = 1000');
    const walResult = previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      testOnlyAfterLoadSummary: () => {
        competingConnection.prepare(
          "UPDATE strategy_rules SET threshold_value = 90 WHERE rule_code = 'SNAPSHOT_RULE'"
        ).run();
        walWriteSucceeded = true;
      }
    });
    const snapshotEvaluation = getEvaluation(walResult, 'SNAPSHOT_RULE');
    assert.strictEqual(walWriteSucceeded, true);
    assert.strictEqual(snapshotEvaluation.threshold.value, 60);
    assert.strictEqual(snapshotEvaluation.matchStatus, 'matched');

    const freshResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
    const freshEvaluation = getEvaluation(freshResult, 'SNAPSHOT_RULE');
    assert.strictEqual(freshEvaluation.threshold.value, 90);
    assert.strictEqual(freshEvaluation.matchStatus, 'not_matched');
    assert.strictEqual(freshResult.dataSummaryDigest, walResult.dataSummaryDigest);
    assert.notStrictEqual(freshEvaluation.evaluationDigest, snapshotEvaluation.evaluationDigest);
  } finally {
    competingConnection.close();
  }

  // 服务自建事务发生测试钩子错误时必须回滚，不遗留连接事务状态。
  assert.throws(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      testOnlyAfterLoadSummary: () => {
        throw new Error('controlled snapshot hook failure');
      }
    }),
    /controlled snapshot hook failure/
  );
  assert.strictEqual(db.inTransaction, false);

  // 调用方已有事务时服务只复用，成功或错误均不得代为提交或回滚。
  db.exec('BEGIN DEFERRED');
  try {
    const callerTransactionResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
    assert.strictEqual(callerTransactionResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
    assert.throws(
      () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
        db,
        testOnlyAfterLoadSummary: () => {
          throw new Error('caller transaction remains owned');
        }
      }),
      /caller transaction remains owned/
    );
    assert.strictEqual(db.inTransaction, true, '服务不得回滚调用方已有事务。');
  } finally {
    db.exec('ROLLBACK');
  }
}

/**
 * 验证 ruleCodes 参数化防注入及数据库连接所有权。
 * @param {object} db 调用方 SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testInjectionAndDatabaseOwnership(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({ ruleCode: 'SAFE_RULE' });

  const injectionResult = previewEnergyStrategies(createInput(ids.meterDeviceId, {
    ruleCodes: ["' OR 1=1 --"]
  }), { db });
  assert.deepStrictEqual(injectionResult.evaluations, []);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS total FROM strategy_rules WHERE rule_code = 'SAFE_RULE'").get().total,
    1,
    '注入型规则编码不得改变查询或数据。'
  );

  const callerResult = previewEnergyStrategies(createInput(ids.meterDeviceId), { db });
  assert.strictEqual(callerResult.meta.callerDatabaseConnection, true);
  assert.strictEqual(callerResult.meta.reusedCallerTransaction, false);
  assert.strictEqual(db.inTransaction, false);
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1, '调用方连接不得由服务关闭。');

  // 替换数据库工厂以确认服务自有连接在 finally 中关闭。
  const originalOpenDatabase = database.openDatabase;
  let ownedConnectionClosed = false;
  database.openDatabase = () => {
    const ownedDb = originalOpenDatabase();
    const originalClose = ownedDb.close.bind(ownedDb);
    ownedDb.close = () => {
      ownedConnectionClosed = true;
      return originalClose();
    };
    return ownedDb;
  };
  try {
    const ownedResult = previewEnergyStrategies(createInput(ids.meterDeviceId));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true, '服务自有连接必须在返回前关闭。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}

/**
 * 验证正式评价原子写入运行和命中，并执行受限人工状态流。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testPersistentEvaluationAndManualStatus(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({
    ruleCode: 'PERSISTED_LOAD_RATE',
    thresholdValue: 60,
    priority: 'high',
    recommendation: '请人工复核持久化规则证据。'
  });
  insertRule({
    ruleCode: 'PERSISTED_PEAK',
    metricCode: 'peak_interval_energy',
    thresholdOperator: 'gt',
    thresholdValue: 50,
    thresholdUnit: 'kWh/15min'
  });

  const result = runEnergyStrategyEvaluation(createInput(ids.meterDeviceId), createWriteOptions(db));
  assert.strictEqual(result.dryRun, false);
  assert.strictEqual(result.persistsEvaluationRun, true);
  assert.strictEqual(result.run.status, 'completed');
  assert.strictEqual(result.hits.length, 2);
  assert.strictEqual(result.meta.writesEvaluationRuns, true);
  assert.strictEqual(result.meta.writesRuleHits, true);
  assert.strictEqual(result.meta.writesOperationAudit, true);
  assert.strictEqual(Number.isInteger(result.meta.operationLogId), true);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    1
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    2
  );
  const matchedHit = result.hits.find((hit) => hit.ruleCode === 'PERSISTED_LOAD_RATE');
  assert(matchedHit);
  assert.strictEqual(matchedHit.matchStatus, 'matched');
  assert.strictEqual(matchedHit.manualStatus, 'unconfirmed');
  assert.strictEqual(matchedHit.threshold.value, 60);
  assert.strictEqual(
    matchedHit.evidenceSnapshot.evidence.some((item) => item.startsWith('data-summary-sha256:')),
    true
  );

  const accepted = updateStrategyRuleHitStatus(matchedHit.id, {
    manualStatus: 'accepted',
    reviewNote: '已核对原始时序证据。'
  }, createWriteOptions(db));
  assert.strictEqual(accepted.manualStatus, 'accepted');
  assert.strictEqual(accepted.reviewNote, '已核对原始时序证据。');
  assert.strictEqual(typeof accepted.reviewedAt, 'string');
  const resolved = updateStrategyRuleHitStatus(matchedHit.id, {
    manualStatus: 'resolved',
    reviewNote: '已由人工流程完成处置。'
  }, createWriteOptions(db));
  assert.strictEqual(resolved.manualStatus, 'resolved');
  assert.strictEqual(resolved.reviewNote, '已由人工流程完成处置。');
  assert.strictEqual(
    db.prepare(
      `SELECT COUNT(*) AS total
         FROM sys_operation_logs
        WHERE operation IN ('energy.strategy.run', 'energy.strategy.hit.review')`
    ).get().total >= 3,
    true,
    '正式运行和每次成功人工复核必须写入统一操作审计。'
  );
  assertBadRequestCode(
    () => updateStrategyRuleHitStatus(result.hits[1].id, { manualStatus: 'rejected' }, createWriteOptions(db)),
    'STRATEGY_HIT_REVIEW_NOTE_REQUIRED'
  );
  assert.throws(
    () => updateStrategyRuleHitStatus(matchedHit.id, {
      manualStatus: 'accepted',
      reviewNote: '不得重开终结记录。'
    }, createWriteOptions(db)),
    (error) => error && error.code === 'STRATEGY_HIT_STATUS_CONFLICT' && error.statusCode === 409
  );
  assert.strictEqual(db.inTransaction, false);

  // 调用方事务由调用方持有，服务不得代为提交。
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({ ruleCode: 'CALLER_TRANSACTION_RULE' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const callerTransactionResult = runEnergyStrategyEvaluation(
      createInput(ids.meterDeviceId),
      createWriteOptions(db)
    );
    assert.strictEqual(callerTransactionResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    0,
    '调用方回滚后正式运行和命中必须全部撤销。'
  );
  resetScenario(db);
}

/**
 * 验证策略业务写入与操作审计处于同一 SQLite 事务。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testAtomicOperationAuditRollback(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  insertRule({ ruleCode: 'AUDIT_ROLLBACK_RULE' });
  const beforeRunCount = db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total;
  const beforeHitCount = db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total;
  const beforeAuditCount = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;

  assert.throws(() => runEnergyStrategyEvaluation(
    createInput(ids.meterDeviceId),
    createWriteOptions(db, {
      auditWriter() {
        throw new Error('injected strategy run audit failure');
      }
    })
  ), /injected strategy run audit failure/);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeRunCount,
    '正式运行审计失败时评价运行必须回滚。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    beforeHitCount,
    '正式运行审计失败时规则命中必须回滚。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
    beforeAuditCount,
    '故障审计不得产生操作日志。'
  );

  const persisted = runEnergyStrategyEvaluation(createInput(ids.meterDeviceId), createWriteOptions(db));
  const hitId = persisted.hits[0].id;
  assert.strictEqual(persisted.hits[0].manualStatus, 'unconfirmed');
  const auditCountBeforeReview = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
  assert.throws(() => updateStrategyRuleHitStatus(hitId, {
    manualStatus: 'accepted',
    reviewNote: '该状态更新必须随审计失败回滚。'
  }, createWriteOptions(db, {
    auditWriter() {
      throw new Error('injected strategy review audit failure');
    }
  })), /injected strategy review audit failure/);
  assert.strictEqual(
    db.prepare('SELECT manual_status AS manualStatus FROM strategy_rule_hits WHERE id = ?').get(hitId).manualStatus,
    'unconfirmed',
    '人工复核审计失败时命中状态必须保持原值。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
    auditCountBeforeReview,
    '人工复核审计失败不得产生操作日志。'
  );
  resetScenario(db);
}

/**
 * 验证 derived 策略命中人工复核刷新和调用方 SAVEPOINT 回滚边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testDerivedOwnershipReviewRefresh(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  // 运行期和数据集 run 只用于满足 derived registry 的真实外键，不接入 post-action。
  toggleDemoRuntime({
    enabled: true,
    actorUserId: auditActorUserId,
    actorIp: '127.0.0.1'
  });
  const runRecord = getOrCreateActiveDemoDatasetRun({
    actorUserId: auditActorUserId,
    actorIp: '127.0.0.1'
  });
  insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40]);
  [
    'DERIVED_REVIEW_SUCCESS',
    'DERIVED_REVIEW_AUDIT_FAILURE',
    'DERIVED_REVIEW_REFRESH_FAILURE',
    'FORMAL_REVIEW_NO_OWNERSHIP'
  ].forEach((ruleCode) => insertRule({ ruleCode }));
  const evaluated = runEnergyStrategyEvaluation(
    createInput(ids.meterDeviceId),
    createWriteOptions(db)
  );
  const hitByRuleCode = new Map(evaluated.hits.map((hit) => [hit.ruleCode, hit]));
  const successHit = hitByRuleCode.get('DERIVED_REVIEW_SUCCESS');
  const auditFailureHit = hitByRuleCode.get('DERIVED_REVIEW_AUDIT_FAILURE');
  const refreshFailureHit = hitByRuleCode.get('DERIVED_REVIEW_REFRESH_FAILURE');
  const formalHit = hitByRuleCode.get('FORMAL_REVIEW_NO_OWNERSHIP');
  [successHit, auditFailureHit, refreshFailureHit, formalHit].forEach((hit) => {
    assert(hit, '正式策略执行必须为每条测试规则生成命中。');
  });

  // 固定旧时间消除同毫秒执行的不确定性，确保 review updated_at 刷新可被稳定断言。
  const oldHitTime = '2026-01-01T00:00:00.000Z';
  [successHit.id, auditFailureHit.id, refreshFailureHit.id].forEach((hitId) => {
    db.prepare('UPDATE strategy_rule_hits SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(oldHitTime, oldHitTime, hitId);
  });
  const successOwnership = insertDerivedStrategyHitOwnership(db, runRecord, successHit.id);
  const auditFailureOwnership = insertDerivedStrategyHitOwnership(db, runRecord, auditFailureHit.id);
  const refreshFailureOwnership = insertDerivedStrategyHitOwnership(db, runRecord, refreshFailureHit.id);
  const derivedRegistryCount = db.prepare(
    "SELECT COUNT(*) AS total FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND cleaned_at IS NULL"
  ).get().total;

  // 正式命中没有 active ownership 时只更新业务状态，不得隐式新增 registry。
  const formalReviewed = updateStrategyRuleHitStatus(formalHit.id, {
    manualStatus: 'accepted',
    reviewNote: '正式命中保持无 ownership。'
  }, createWriteOptions(db));
  assert.strictEqual(formalReviewed.manualStatus, 'accepted');
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND cleaned_at IS NULL"
    ).get().total,
    derivedRegistryCount,
    '无 ownership 命中人工复核不得新增 registry。'
  );
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND entity_pk = ?"
    ).get(String(formalHit.id)).total,
    0
  );

  // active derived ownership 必须在同一 review 事务中刷新为当前固定 projection 摘要。
  const successRegisteredAt = db.prepare(
    'SELECT registered_at AS registeredAt FROM demo_data_registry WHERE registry_id = ?'
  ).get(successOwnership.registryId).registeredAt;
  const successReviewed = updateStrategyRuleHitStatus(successHit.id, {
    manualStatus: 'accepted',
    reviewNote: 'derived snapshot 已随人工复核刷新。'
  }, createWriteOptions(db));
  const successProjection = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit
    .readProjection(db, successHit.id);
  const expectedSuccessDigest = calculateDemoEntitySnapshotDigest(
    'strategy_rule_hit',
    String(successHit.id),
    successProjection
  );
  const refreshedSuccessRegistry = db.prepare(
    `SELECT registry_id AS registryId, identity_digest AS identityDigest,
            snapshot_digest AS snapshotDigest, registered_by AS registeredBy,
            registered_at AS registeredAt, source_batch_id AS sourceBatchId,
            source_row_number AS sourceRowNumber
       FROM demo_data_registry WHERE registry_id = ?`
  ).get(successOwnership.registryId);
  assert.strictEqual(successReviewed.updatedAt, successProjection.updated_at);
  assert.notStrictEqual(successReviewed.updatedAt, oldHitTime, '人工复核必须刷新命中 updated_at。');
  assert.strictEqual(refreshedSuccessRegistry.snapshotDigest, expectedSuccessDigest);
  assert.notStrictEqual(refreshedSuccessRegistry.snapshotDigest, successOwnership.snapshotDigest);
  assert.strictEqual(refreshedSuccessRegistry.identityDigest, successOwnership.identityDigest);
  assert.strictEqual(refreshedSuccessRegistry.registeredBy, auditActorUserId);
  assert.strictEqual(refreshedSuccessRegistry.registeredAt, successRegisteredAt);
  assert.strictEqual(refreshedSuccessRegistry.sourceBatchId, null);
  assert.strictEqual(refreshedSuccessRegistry.sourceRowNumber, null);

  // 审计位于 refresh 之后；审计故障必须由私有 SAVEPOINT 同时回滚 hit 和 registry。
  const auditFailureProjectionBefore = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit
    .readProjection(db, auditFailureHit.id);
  const auditFailureRegistryBefore = db.prepare(
    'SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?'
  ).get(auditFailureOwnership.registryId);
  const auditCountBeforeFailure = db.prepare(
    "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.hit.review'"
  ).get().total;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-AUDIT-SENTINEL', '派生复核审计哨兵', '/派生复核审计哨兵', 'workshop', 'active')`
    ).run();
    assert.throws(() => updateStrategyRuleHitStatus(auditFailureHit.id, {
      manualStatus: 'accepted',
      reviewNote: '该 derived refresh 必须随审计故障回滚。'
    }, createWriteOptions(db, {
      auditWriter() {
        throw new Error('injected derived review audit failure');
      }
    })), /injected derived review audit failure/);
    assert.strictEqual(db.inTransaction, true, '审计故障后调用方事务必须继续保持 active。');
    assert.deepStrictEqual(
      DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(db, auditFailureHit.id),
      auditFailureProjectionBefore,
      '审计故障必须回滚命中状态、复核字段和 updated_at。'
    );
    assert.deepStrictEqual(
      db.prepare('SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?')
        .get(auditFailureOwnership.registryId),
      auditFailureRegistryBefore,
      '审计故障必须回滚 derived registry snapshot digest。'
    );
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-AUDIT-CONTINUE', '派生复核审计继续哨兵', '/派生复核审计继续哨兵', 'workshop', 'active')`
    ).run();
  } finally {
    if (db.inTransaction) db.exec('COMMIT');
  }
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM organization_units WHERE unit_code IN ('DERIVED-REVIEW-AUDIT-SENTINEL', 'DERIVED-REVIEW-AUDIT-CONTINUE')"
    ).get().total,
    2,
    'review 私有 SAVEPOINT 不得回滚调用方自身写入。'
  );
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.hit.review'"
    ).get().total,
    auditCountBeforeFailure
  );

  // review ROLLBACK TO 失败后严禁 RELEASE，必须完整回滚并终止 caller transaction。
  const originalReviewRecoveryExec = db.exec;
  let reviewRollbackToFailed = false;
  let reviewReleaseAfterRollbackFailure = false;
  db.exec = function failReviewRollbackTo(sql, ...args) {
    const normalizedSql = String(sql);
    if (/^ROLLBACK TO SAVEPOINT energy_strategy_review_/i.test(normalizedSql)) {
      reviewRollbackToFailed = true;
      const recoveryError = new Error('forced review rollback-to failure');
      recoveryError.code = 'TEST_REVIEW_ROLLBACK_TO_FAILED';
      throw recoveryError;
    }
    if (reviewRollbackToFailed
      && /^RELEASE SAVEPOINT energy_strategy_review_/i.test(normalizedSql)) {
      reviewReleaseAfterRollbackFailure = true;
    }
    return originalReviewRecoveryExec.call(db, sql, ...args);
  };
  try {
    originalReviewRecoveryExec.call(db, 'BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-RECOVERY-SENTINEL', '复核恢复哨兵', '/复核恢复哨兵', 'workshop', 'active')`
    ).run();
    const reviewRecoveryError = assertServiceErrorCode(() => updateStrategyRuleHitStatus(
      auditFailureHit.id,
      {
        manualStatus: 'accepted',
        reviewNote: 'ROLLBACK TO 失败必须完整回滚。'
      },
      createWriteOptions(db, {
        auditWriter() {
          throw new Error('injected review recovery audit failure');
        }
      })
    ), 'ENERGY_STRATEGY_REVIEW_SAVEPOINT_RECOVERY_FAILED');
    assert.strictEqual(reviewRecoveryError.details.rollbackCode, 'TEST_REVIEW_ROLLBACK_TO_FAILED');
    assert.strictEqual(reviewRecoveryError.details.releaseCode, null);
    assert.strictEqual(reviewRecoveryError.details.fullRollbackCode, null);
    assert.strictEqual(reviewRollbackToFailed, true);
    assert.strictEqual(reviewReleaseAfterRollbackFailure, false);
    assert.strictEqual(db.inTransaction, false, 'review recovery 失败后 caller transaction 必须结束。');
    assert.throws(
      () => originalReviewRecoveryExec.call(db, 'COMMIT'),
      /no transaction is active/i
    );
    assert.deepStrictEqual(
      DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(db, auditFailureHit.id),
      auditFailureProjectionBefore,
      '完整回滚后 manual_status、reviewed_at、review_note 与 updated_at 必须保持基线。'
    );
    assert.deepStrictEqual(
      db.prepare('SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?')
        .get(auditFailureOwnership.registryId),
      auditFailureRegistryBefore,
      '完整回滚后 ownership snapshot 必须保持基线。'
    );
    assert.strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.hit.review'"
      ).get().total,
      auditCountBeforeFailure,
      '完整回滚后 review audit 必须保持基线。'
    );
    assert.strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS total FROM organization_units WHERE unit_code = 'DERIVED-REVIEW-RECOVERY-SENTINEL'"
      ).get().total,
      0,
      '完整回滚必须同时撤销 caller transaction 内的哨兵写入。'
    );
  } finally {
    db.exec = originalReviewRecoveryExec;
    if (db.inTransaction) db.exec('ROLLBACK');
  }

  // 完整 ROLLBACK 仍失败时必须关闭连接，由 SQLite close 回滚全部 review 半成品。
  const closeRecoveryProjectionBefore = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit
    .readProjection(db, refreshFailureHit.id);
  const closeRecoveryRegistryBefore = db.prepare(
    'SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?'
  ).get(refreshFailureOwnership.registryId);
  const closeRecoveryDb = database.openDatabase();
  const originalCloseRecoveryExec = closeRecoveryDb.exec;
  const originalCloseRecoveryClose = closeRecoveryDb.close;
  let closeRecoveryRollbackToFailed = false;
  let closeRecoveryReleaseAfterFailure = false;
  let closeRecoveryFullRollbackFailed = false;
  let closeRecoveryConnectionClosed = false;
  closeRecoveryDb.exec = function failReviewFullRollback(sql, ...args) {
    const normalizedSql = String(sql);
    if (/^ROLLBACK TO SAVEPOINT energy_strategy_review_/i.test(normalizedSql)) {
      closeRecoveryRollbackToFailed = true;
      const recoveryError = new Error('forced review rollback-to failure before close');
      recoveryError.code = 'TEST_REVIEW_CLOSE_ROLLBACK_TO_FAILED';
      throw recoveryError;
    }
    if (closeRecoveryRollbackToFailed
      && /^RELEASE SAVEPOINT energy_strategy_review_/i.test(normalizedSql)) {
      closeRecoveryReleaseAfterFailure = true;
    }
    if (/^ROLLBACK$/i.test(normalizedSql.trim())) {
      closeRecoveryFullRollbackFailed = true;
      const recoveryError = new Error('forced review full rollback failure');
      recoveryError.code = 'TEST_REVIEW_FULL_ROLLBACK_FAILED';
      throw recoveryError;
    }
    return originalCloseRecoveryExec.call(closeRecoveryDb, sql, ...args);
  };
  closeRecoveryDb.close = function closeReviewRecoveryConnection(...args) {
    closeRecoveryConnectionClosed = true;
    return originalCloseRecoveryClose.call(closeRecoveryDb, ...args);
  };
  try {
    originalCloseRecoveryExec.call(closeRecoveryDb, 'BEGIN IMMEDIATE');
    closeRecoveryDb.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-CLOSE-SENTINEL', '复核关闭哨兵', '/复核关闭哨兵', 'workshop', 'active')`
    ).run();
    const closeRecoveryError = assertServiceErrorCode(() => updateStrategyRuleHitStatus(
      refreshFailureHit.id,
      {
        manualStatus: 'accepted',
        reviewNote: '完整 ROLLBACK 失败必须关闭连接。'
      },
      createWriteOptions(closeRecoveryDb, {
        auditWriter() {
          throw new Error('injected review close recovery audit failure');
        }
      })
    ), 'ENERGY_STRATEGY_REVIEW_SAVEPOINT_RECOVERY_FAILED');
    assert.strictEqual(
      closeRecoveryError.details.rollbackCode,
      'TEST_REVIEW_CLOSE_ROLLBACK_TO_FAILED'
    );
    assert.strictEqual(closeRecoveryError.details.releaseCode, null);
    assert.strictEqual(
      closeRecoveryError.details.fullRollbackCode,
      'TEST_REVIEW_FULL_ROLLBACK_FAILED'
    );
    assert.strictEqual(closeRecoveryError.details.closeCode, null);
    assert.strictEqual(closeRecoveryRollbackToFailed, true);
    assert.strictEqual(closeRecoveryReleaseAfterFailure, false);
    assert.strictEqual(closeRecoveryFullRollbackFailed, true);
    assert.strictEqual(closeRecoveryConnectionClosed, true);
    assert.strictEqual(closeRecoveryDb.open, false, '完整回滚失败后 SQLite 连接必须关闭。');
    assert.throws(
      () => originalCloseRecoveryExec.call(closeRecoveryDb, 'COMMIT'),
      /database connection is not open/i
    );
    assert.deepStrictEqual(
      DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(db, refreshFailureHit.id),
      closeRecoveryProjectionBefore,
      '关闭连接后 review 字段必须保持基线。'
    );
    assert.deepStrictEqual(
      db.prepare('SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?')
        .get(refreshFailureOwnership.registryId),
      closeRecoveryRegistryBefore,
      '关闭连接后 ownership snapshot 必须保持基线。'
    );
    assert.strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.hit.review'"
      ).get().total,
      auditCountBeforeFailure,
      '关闭连接后 review audit 必须保持基线。'
    );
    assert.strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS total FROM organization_units WHERE unit_code = 'DERIVED-REVIEW-CLOSE-SENTINEL'"
      ).get().total,
      0,
      '关闭连接必须由 SQLite 回滚 caller transaction 的哨兵写入。'
    );
  } finally {
    closeRecoveryDb.exec = originalCloseRecoveryExec;
    closeRecoveryDb.close = originalCloseRecoveryClose;
    if (closeRecoveryDb.open) {
      if (closeRecoveryDb.inTransaction) originalCloseRecoveryExec.call(closeRecoveryDb, 'ROLLBACK');
      originalCloseRecoveryClose.call(closeRecoveryDb);
    }
  }

  // 注入 registry CAS 更新故障，验证 refresh 失败同样只回滚本次 review SAVEPOINT。
  const refreshFailureProjectionBefore = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit
    .readProjection(db, refreshFailureHit.id);
  const refreshFailureRegistryBefore = db.prepare(
    'SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?'
  ).get(refreshFailureOwnership.registryId);
  db.exec(`CREATE TRIGGER block_derived_strategy_hit_refresh
    BEFORE UPDATE OF snapshot_digest ON demo_data_registry
    WHEN OLD.registry_id = ${refreshFailureOwnership.registryId}
      AND NEW.snapshot_digest <> OLD.snapshot_digest
    BEGIN
      SELECT RAISE(ABORT, 'injected derived registry refresh failure');
    END`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-REFRESH-SENTINEL', '派生复核刷新哨兵', '/派生复核刷新哨兵', 'workshop', 'active')`
    ).run();
    assert.throws(() => updateStrategyRuleHitStatus(refreshFailureHit.id, {
      manualStatus: 'rejected',
      reviewNote: '该 review 必须随 registry 刷新故障回滚。'
    }, createWriteOptions(db)), /injected derived registry refresh failure/);
    assert.strictEqual(db.inTransaction, true, 'refresh 故障后调用方事务必须继续保持 active。');
    assert.deepStrictEqual(
      DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(db, refreshFailureHit.id),
      refreshFailureProjectionBefore,
      'refresh 故障必须回滚命中状态、复核字段和 updated_at。'
    );
    assert.deepStrictEqual(
      db.prepare('SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE registry_id = ?')
        .get(refreshFailureOwnership.registryId),
      refreshFailureRegistryBefore,
      'refresh 故障不得改变 derived registry snapshot digest。'
    );
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('DERIVED-REVIEW-REFRESH-CONTINUE', '派生复核刷新继续哨兵', '/派生复核刷新继续哨兵', 'workshop', 'active')`
    ).run();
  } finally {
    if (db.inTransaction) db.exec('COMMIT');
    db.exec('DROP TRIGGER IF EXISTS block_derived_strategy_hit_refresh');
  }
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM organization_units WHERE unit_code IN ('DERIVED-REVIEW-REFRESH-SENTINEL', 'DERIVED-REVIEW-REFRESH-CONTINUE')"
    ).get().total,
    2
  );
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy.strategy.hit.review'"
    ).get().total,
    auditCountBeforeFailure,
    'refresh 失败发生在审计前，不得留下 review 操作日志。'
  );

  // 清除仅由本测试创建的逻辑 ownership 后再删除业务行，避免污染后续场景。
  db.prepare(
    "DELETE FROM demo_data_registry WHERE entity_type = 'strategy_rule_hit' AND entity_pk IN (?, ?, ?)"
  ).run(String(successHit.id), String(auditFailureHit.id), String(refreshFailureHit.id));
  resetScenario(db);
}

/**
 * 验证策略业务写入口拒绝缺失或非法操作者。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testAuditActorRequired(db, ids) {
  [undefined, null, 0, -1, 1.5, '1'].forEach((actorUserId) => {
    const options = actorUserId === undefined ? { db } : { db, actorUserId };
    assertBadRequestCode(
      () => runEnergyStrategyEvaluation(createInput(ids.meterDeviceId), options),
      'ENERGY_STRATEGY_AUDIT_ACTOR_REQUIRED'
    );
    assertBadRequestCode(
      () => updateStrategyRuleHitStatus(1, { manualStatus: 'accepted' }, options),
      'ENERGY_STRATEGY_AUDIT_ACTOR_REQUIRED'
    );
  });
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    0,
    '非法操作者不得产生策略评价运行。'
  );
}

/**
 * 验证策略评价服务端私有 exact scope、正式运行隔离、漂移和公共脱敏边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testServerPrivateExactScope(db, ids, insertTimeseries, insertRule) {
  resetScenario(db);
  const timeseriesBatchId = createImportBatch(db, 'energy_timeseries');
  const otherTimeseriesBatchId = createImportBatch(db, 'energy_timeseries');
  const strategyRuleBatchId = createImportBatch(db, 'strategy_rule');
  const otherStrategyRuleBatchId = createImportBatch(db, 'strategy_rule');
  const exactTimeseriesIds = insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40], {
    sourceBatchId: timeseriesBatchId,
    sourceRowNumber: 1,
    sourceReference: 'formal-sentinel-timeseries'
  });
  insertQuarterHourSeries(insertTimeseries, [100, 100, 100, 100], {
    sourceBatchId: otherTimeseriesBatchId,
    sourceRowNumber: 1,
    sourceReference: 'other-demo-run-timeseries'
  });
  const exactRuleIds = [
    insertRule({
      sourceBatchId: strategyRuleBatchId,
      sourceRowNumber: 1,
      ruleCode: 'FORMAL_SENTINEL_LOAD_RATE',
      thresholdValue: 60
    }),
    insertRule({
      sourceBatchId: strategyRuleBatchId,
      sourceRowNumber: 2,
      ruleCode: 'FORMAL_SENTINEL_PEAK',
      metricCode: 'peak_interval_energy',
      thresholdOperator: 'gte',
      thresholdValue: 40,
      thresholdUnit: 'kWh/15min'
    })
  ];
  const sameBatchExtraRuleId = insertRule({
    sourceBatchId: strategyRuleBatchId,
    sourceRowNumber: 3,
    ruleCode: 'SAME_BATCH_EXTRA_RULE'
  });
  const otherRunRuleId = insertRule({
    sourceBatchId: otherStrategyRuleBatchId,
    sourceRowNumber: 1,
    ruleCode: 'OTHER_DEMO_RUN_RULE'
  });
  const exactScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: exactTimeseriesIds,
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: exactRuleIds,
    strategyRuleSourceBatchId: strategyRuleBatchId
  });
  // 恰好五十条规则必须通过 exact normalizer 和真实参数化查询。
  const boundaryStrategyRuleIds = [
    ...exactRuleIds,
    ...Array.from({ length: MAX_STRATEGY_RULES - exactRuleIds.length }, (_value, index) => (
      insertRule({
        sourceBatchId: strategyRuleBatchId,
        sourceRowNumber: 4 + index,
        ruleCode: `BOUNDARY_RULE_${String(index + 1).padStart(2, '0')}`
      })
    ))
  ];
  const boundaryStrategyScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: exactTimeseriesIds,
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: boundaryStrategyRuleIds,
    strategyRuleSourceBatchId: strategyRuleBatchId
  });
  assert.strictEqual(boundaryStrategyScope.strategyRules.strategyRuleIds.length, MAX_STRATEGY_RULES);
  assert.strictEqual(
    boundaryStrategyScope.strategyRules.expectedStrategyRuleSnapshots.length,
    MAX_STRATEGY_RULES
  );
  const boundaryPreview = previewEnergyStrategies(createInput(ids.meterDeviceId), {
    db,
    exactScope: boundaryStrategyScope
  });
  assert.strictEqual(boundaryPreview.ruleSelection.selectedRuleCount, MAX_STRATEGY_RULES);
  // 超过五十条必须在 exact normalization 阶段稳定拒绝，不能退化为 SQL 或集合错误。
  assertBadRequestCode(
    () => buildEnergyStrategyExactScope(db, {
      timeseriesRecordIds: exactTimeseriesIds,
      timeseriesSourceBatchId: timeseriesBatchId,
      strategyRuleIds: [...boundaryStrategyRuleIds, 999999999],
      strategyRuleSourceBatchId: strategyRuleBatchId
    }),
    'STRATEGY_RULE_LIMIT_EXCEEDED'
  );
  const oversizedNormalizedScope = JSON.parse(JSON.stringify(boundaryStrategyScope));
  oversizedNormalizedScope.strategyRules.strategyRuleIds.push(999999999);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: oversizedNormalizedScope
    }),
    'STRATEGY_RULE_LIMIT_EXCEEDED'
  );
  // 私有 expected snapshots 必须与 ownership 固定 projection 摘要完全兼容。
  [
    {
      entityType: 'energy_timeseries',
      entityIds: exactTimeseriesIds,
      snapshots: exactScope.timeseries.expectedTimeseriesSnapshots
    },
    {
      entityType: 'strategy_rule',
      entityIds: exactRuleIds,
      snapshots: exactScope.strategyRules.expectedStrategyRuleSnapshots
    }
  ].forEach(({ entityType, entityIds, snapshots }) => {
    const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType];
    entityIds.forEach((entityId) => {
      const registration = buildDemoEntityRegistrationContract({
        entityType,
        entityPk: String(entityId),
        row: handler.readProjection(db, entityId)
      });
      const expectedSnapshot = snapshots.find((snapshot) => snapshot.id === entityId);
      assert(expectedSnapshot);
      assert.strictEqual(expectedSnapshot.identityDigest, registration.identityDigest);
      assert.strictEqual(expectedSnapshot.snapshotDigest, registration.snapshotDigest);
    });
  });
  // builder 必须先执行 ownership 固定 projection，不能接受领域 schema 之外的不兼容策略规则。
  [
    {
      ruleCode: 'OWNERSHIP_BAD_METRIC',
      metricCode: 'unsupported_metric'
    },
    {
      ruleCode: 'OWNERSHIP_BAD_FORMULA',
      formulaVersion: 'unsupported-formula:v1'
    },
    {
      ruleCode: 'OWNERSHIP_BAD_EVIDENCE',
      evidenceRequirementsJson: JSON.stringify({ unknown: true })
    },
    {
      ruleCode: 'OWNERSHIP_BAD_THRESHOLD_UNIT',
      thresholdUnit: ' '
    }
  ].forEach((overrides) => {
    const incompatibleRuleId = insertRule({
      sourceBatchId: strategyRuleBatchId,
      sourceRowNumber: 10,
      ...overrides
    });
    assertBadRequestCode(
      () => buildEnergyStrategyExactScope(db, {
        timeseriesRecordIds: exactTimeseriesIds,
        timeseriesSourceBatchId: timeseriesBatchId,
        strategyRuleIds: [incompatibleRuleId],
        strategyRuleSourceBatchId: strategyRuleBatchId
      }),
      'ENERGY_STRATEGY_EXACT_SCOPE_OWNERSHIP_INCOMPATIBLE'
    );
    db.prepare('DELETE FROM strategy_rules WHERE id = ?').run(incompatibleRuleId);
  });
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId, { ruleCodes: [] }), {
      db,
      exactRequired: true
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_REQUIRED'
  );
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId, { ruleCodes: [] }), {
      db,
      exactRequired: true,
      exactScope: JSON.parse(JSON.stringify(exactScope))
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  const preview = previewEnergyStrategies(createInput(ids.meterDeviceId, {
    ruleCodes: [],
    recordIds: [999999],
    sourceBatchId: otherTimeseriesBatchId,
    registry: { connected: true },
    context: { private: true },
    digest: 'client-must-be-ignored'
  }), { db, exactRequired: true, exactScope });
  assert.strictEqual(preview.ruleSelection.selectedRuleCount, 2);
  assert.deepStrictEqual(
    preview.evaluations.map((evaluation) => evaluation.ruleCode).sort(),
    ['FORMAL_SENTINEL_LOAD_RATE', 'FORMAL_SENTINEL_PEAK']
  );
  assert.strictEqual(preview.dataSummary.recordCount, 4);
  assert.strictEqual(preview.dataSummary.metrics.totalEnergy, 100);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    0,
    'exact preview 不得写 strategy_evaluation_runs。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    0,
    'exact preview 不得写 strategy_rule_hits。'
  );
  const metadata = getEnergyStrategyExactScopeMetadata(preview, { db });
  assert(metadata);
  assert.deepStrictEqual(metadata.timeseries.recordIds, exactTimeseriesIds);
  assert.deepStrictEqual(metadata.strategyRules.recordIds, exactRuleIds);
  const publicJson = JSON.stringify(preview);
  [
    'sourceBatchId',
    'sourceRowNumber',
    'strategyRuleScopeDigest',
    'timeseriesScopeDigest',
    'expectedStrategyRuleSnapshots',
    'expectedTimeseriesSnapshots',
    'registry',
    'context',
    'handler',
    'SELECT '
  ].forEach((privateToken) => {
    assert.strictEqual(publicJson.includes(privateToken), false, `公共策略预演泄露 ${privateToken}`);
  });

  // 调用方事务必须保持所有权，exact preview 不得提交或回滚。
  db.exec('BEGIN DEFERRED');
  try {
    const callerTransactionPreview = previewEnergyStrategies(
      createInput(ids.meterDeviceId),
      { db, exactScope }
    );
    assert.strictEqual(callerTransactionPreview.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
  } finally {
    db.exec('ROLLBACK');
  }

  const emptyRuleScope = JSON.parse(JSON.stringify(exactScope));
  emptyRuleScope.strategyRules.strategyRuleIds = [];
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId, { ruleCodes: [] }), {
      db,
      exactScope: emptyRuleScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_IDS_REQUIRED'
  );
  const duplicateRuleScope = JSON.parse(JSON.stringify(exactScope));
  duplicateRuleScope.strategyRules.strategyRuleIds.push(exactRuleIds[0]);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: duplicateRuleScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_ID_DUPLICATE'
  );
  const missingBatchFieldScope = JSON.parse(JSON.stringify(exactScope));
  delete missingBatchFieldScope.strategyRules.strategyRuleSourceBatchId;
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: missingBatchFieldScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_SOURCE_BATCH_REQUIRED'
  );
  const missingBatchScope = JSON.parse(JSON.stringify(exactScope));
  missingBatchScope.strategyRules.strategyRuleSourceBatchId = 999999999;
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: missingBatchScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  const crossBatchScope = JSON.parse(JSON.stringify(exactScope));
  crossBatchScope.strategyRules.strategyRuleIds.push(otherRunRuleId);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: crossBatchScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  const extraRuleScope = JSON.parse(JSON.stringify(exactScope));
  extraRuleScope.strategyRules.strategyRuleIds.push(sameBatchExtraRuleId);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: extraRuleScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  const ruleDigestDriftScope = JSON.parse(JSON.stringify(exactScope));
  ruleDigestDriftScope.strategyRules.strategyRuleScopeDigest = '0'.repeat(64);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: ruleDigestDriftScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  const timeseriesDigestDriftScope = JSON.parse(JSON.stringify(exactScope));
  timeseriesDigestDriftScope.timeseries.timeseriesScopeDigest = '0'.repeat(64);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db,
      exactScope: timeseriesDigestDriftScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );

  // active 规则漂移必须因 SQL 基础校验与 expected IDs 不一致而阻断。
  db.prepare("UPDATE strategy_rules SET status = 'inactive' WHERE id = ?").run(exactRuleIds[0]);
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), { db, exactScope }),
    'ENERGY_STRATEGY_EXACT_SCOPE_RECORD_SET_MISMATCH'
  );
  db.prepare("UPDATE strategy_rules SET status = 'active' WHERE id = ?").run(exactRuleIds[0]);
  const refreshedExactScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: exactTimeseriesIds,
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: exactRuleIds,
    strategyRuleSourceBatchId: strategyRuleBatchId
  });
  const beforeMissingExecuteRunCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_evaluation_runs'
  ).get().total;
  const beforeMissingExecuteHitCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_rule_hits'
  ).get().total;
  // exact-required execute 丢失私有 scope 时必须在任何业务写入前稳定失败。
  assertBadRequestCode(
    () => runEnergyStrategyEvaluation(
      createInput(ids.meterDeviceId, { ruleCodes: [] }),
      createWriteOptions(db, { exactRequired: true })
    ),
    'ENERGY_STRATEGY_EXACT_SCOPE_REQUIRED'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeMissingExecuteRunCount
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    beforeMissingExecuteHitCount
  );

  // caller-owned BEGIN IMMEDIATE 中的 exact ownership 错误不得留下 running 或命中记录。
  const beforeOwnershipFailureRunCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_evaluation_runs'
  ).get().total;
  const beforeOwnershipFailureHitCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_rule_hits'
  ).get().total;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('CALLER-EXACT-OWNERSHIP-SENTINEL', '调用方 ownership 哨兵', '/调用方 ownership 哨兵', 'workshop', 'active')`
    ).run();
    db.prepare("UPDATE strategy_rules SET metric_code = 'unsupported_metric' WHERE id = ?")
      .run(exactRuleIds[0]);
    assertBadRequestCode(
      () => runEnergyStrategyEvaluation(
        createInput(ids.meterDeviceId, { ruleCodes: [] }),
        createWriteOptions(db, { exactScope: refreshedExactScope })
      ),
      'ENERGY_STRATEGY_EXACT_SCOPE_OWNERSHIP_INCOMPATIBLE'
    );
    assert.strictEqual(db.inTransaction, true);
    db.prepare("UPDATE strategy_rules SET metric_code = 'load_rate' WHERE id = ?").run(exactRuleIds[0]);
  } finally {
    if (db.inTransaction) db.exec('COMMIT');
  }
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS total FROM organization_units WHERE unit_code = 'CALLER-EXACT-OWNERSHIP-SENTINEL'").get().total,
    1
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeOwnershipFailureRunCount
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    beforeOwnershipFailureHitCount
  );

  // exact digest 漂移同样必须在调用方提交后保持无业务残留，并保留调用方哨兵写入。
  const beforeDigestFailureRunCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_evaluation_runs'
  ).get().total;
  const beforeDigestFailureHitCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_rule_hits'
  ).get().total;
  const staleExactScope = JSON.parse(JSON.stringify(refreshedExactScope));
  staleExactScope.timeseries.timeseriesScopeDigest = '0'.repeat(64);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('CALLER-EXACT-DIGEST-SENTINEL', '调用方 digest 哨兵', '/调用方 digest 哨兵', 'workshop', 'active')`
    ).run();
    assertBadRequestCode(
      () => runEnergyStrategyEvaluation(
        createInput(ids.meterDeviceId, { ruleCodes: [] }),
        createWriteOptions(db, { exactScope: staleExactScope })
      ),
      'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
    );
    assert.strictEqual(db.inTransaction, true);
  } finally {
    if (db.inTransaction) db.exec('COMMIT');
  }
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS total FROM organization_units WHERE unit_code = 'CALLER-EXACT-DIGEST-SENTINEL'").get().total,
    1
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    beforeDigestFailureRunCount
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    beforeDigestFailureHitCount
  );

  // 审计失败发生在 run/hit 写入之后，私有 SAVEPOINT 必须只回滚本次业务写入。
  const beforeAuditFailureRunCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_evaluation_runs'
  ).get().total;
  const beforeAuditFailureHitCount = db.prepare(
    'SELECT COUNT(*) AS total FROM strategy_rule_hits'
  ).get().total;
  const beforeAuditFailureLogCount = db.prepare(
    'SELECT COUNT(*) AS total FROM sys_operation_logs'
  ).get().total;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO organization_units
         (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('CALLER-EXACT-AUDIT-SENTINEL', '调用方 audit 哨兵', '/调用方 audit 哨兵', 'workshop', 'active')`
    ).run();
    assert.throws(
      () => runEnergyStrategyEvaluation(
        createInput(ids.meterDeviceId, { ruleCodes: [] }),
        createWriteOptions(db, {
          exactRequired: true,
          exactScope: refreshedExactScope,
          auditWriter() {
            throw new Error('injected caller-owned exact audit failure');
          }
        })
      ),
      /injected caller-owned exact audit failure/
    );
    assert.strictEqual(db.inTransaction, true);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
      beforeAuditFailureRunCount,
      '私有 SAVEPOINT 必须回滚本次新增 run。'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
      beforeAuditFailureHitCount,
      '私有 SAVEPOINT 必须回滚本次新增 hit。'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
      beforeAuditFailureLogCount,
      '私有 SAVEPOINT 必须避免留下本次 audit。'
    );
  } finally {
    if (db.inTransaction) db.exec('COMMIT');
  }
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS total FROM organization_units WHERE unit_code = 'CALLER-EXACT-AUDIT-SENTINEL'").get().total,
    1
  );

  // 正式执行继续使用服务端 actor，并只持久化 exact 规则命中。
  const executed = runEnergyStrategyEvaluation(
    createInput(ids.meterDeviceId, { ruleCodes: [] }),
    createWriteOptions(db, { exactRequired: true, exactScope: refreshedExactScope })
  );
  assert.strictEqual(executed.hits.length, 2);
  assert.strictEqual(executed.meta.reusedCallerTransaction, false);
  assert.strictEqual(db.inTransaction, false, 'exact 正式执行必须提交服务自建写事务。');
  assert.deepStrictEqual(
    executed.hits.map((hit) => hit.ruleCode).sort(),
    ['FORMAL_SENTINEL_LOAD_RATE', 'FORMAL_SENTINEL_PEAK']
  );
  const executeJson = JSON.stringify(executed);
  assert.strictEqual(executeJson.includes('sourceBatchId'), false);
  assert.strictEqual(executeJson.includes('strategyRuleScopeDigest'), false);
  assert.strictEqual(executeJson.includes('timeseriesScopeDigest'), false);
  assert.strictEqual(executeJson.includes('registry'), false);
  assert.strictEqual(executeJson.includes('context'), false);
  resetScenario(db);
}

/**
 * 验证 strategy exact scope、metadata 和 completion witness 只允许创建连接对象消费。
 * @param {object} dbA 创建 exact capability 的 SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertTimeseries 时序写入函数。
 * @param {Function} insertRule 规则写入函数。
 */
function testExactScopeDatabaseIdentity(dbA, ids, insertTimeseries, insertRule) {
  resetScenario(dbA);
  // 清除前序用例的策略运行审计，跨连接拒绝后的三类写入必须保持绝对零值。
  dbA.prepare("DELETE FROM sys_operation_logs WHERE operation = 'energy.strategy.run'").run();
  // exact 时序和策略规则分别绑定独立来源批次。
  const timeseriesBatchId = createImportBatch(dbA, 'energy_timeseries');
  const strategyRuleBatchId = createImportBatch(dbA, 'strategy_rule');
  // 四条完整时序事实用于同连接 exact、legacy 和跨连接拒绝共用。
  const timeseriesRecordIds = insertQuarterHourSeries(insertTimeseries, [10, 20, 30, 40], {
    sourceBatchId: timeseriesBatchId,
    sourceRowNumber: 1,
    sourceReference: 'strategy-db-identity-timeseries'
  });
  // 单条规则足以验证 run、hit 和 audit 的零写入边界。
  const strategyRuleId = insertRule({
    sourceBatchId: strategyRuleBatchId,
    sourceRowNumber: 1,
    ruleCode: 'STRATEGY_DB_IDENTITY_RULE'
  });
  // 复合 exact scope 的外层和内嵌 load scope 都必须由 dbA 创建。
  const exactScope = buildEnergyStrategyExactScope(dbA, {
    timeseriesRecordIds,
    timeseriesSourceBatchId: timeseriesBatchId,
    strategyRuleIds: [strategyRuleId],
    strategyRuleSourceBatchId: strategyRuleBatchId
  });
  assertEnergyStrategyExactScopeCapability(exactScope, dbA);
  assertEnergyLoadExactScopeCapability(exactScope.timeseries, dbA);

  // 同一连接上的 exact preview 和私有 metadata 读取必须继续成功。
  const exactPreview = previewEnergyStrategies(createInput(ids.meterDeviceId), {
    db: dbA,
    exactRequired: true,
    exactScope
  });
  assert.strictEqual(exactPreview.ruleSelection.selectedRuleCount, 1);
  const exactMetadata = getEnergyStrategyExactScopeMetadata(exactPreview, { db: dbA });
  assert.deepStrictEqual(exactMetadata.timeseries.recordIds, timeseriesRecordIds);
  assert.deepStrictEqual(exactMetadata.strategyRules.recordIds, [strategyRuleId]);

  // 同一连接上的 exact run 在 caller transaction 中成功，随后由测试回滚恢复零写入基线。
  dbA.exec('BEGIN IMMEDIATE');
  try {
    const exactRun = runEnergyStrategyEvaluation(
      createInput(ids.meterDeviceId),
      createWriteOptions(dbA, { exactRequired: true, exactScope })
    );
    assert.strictEqual(exactRun.hits.length, 1);
    assert.strictEqual(exactRun.meta.reusedCallerTransaction, true);
    assert.deepStrictEqual(getStrategyWriteCounts(dbA), {
      runCount: 1,
      hitCount: 1,
      auditCount: 1
    });
  } finally {
    if (dbA.inTransaction) dbA.exec('ROLLBACK');
  }
  assert.deepStrictEqual(getStrategyWriteCounts(dbA), {
    runCount: 0,
    hitCount: 0,
    auditCount: 0
  });

  // 普通 JSON clone 在创建连接上仍不是 capability，preview 和 run 都必须保持拒绝。
  const clonedExactScope = JSON.parse(JSON.stringify(exactScope));
  assertBadRequestCode(
    () => assertEnergyStrategyExactScopeCapability(clonedExactScope, dbA),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  assertBadRequestCode(
    () => previewEnergyStrategies(createInput(ids.meterDeviceId), {
      db: dbA,
      exactScope: clonedExactScope
    }),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  assertBadRequestCode(
    () => runEnergyStrategyEvaluation(
      createInput(ids.meterDeviceId),
      createWriteOptions(dbA, { exactScope: clonedExactScope })
    ),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  assert.deepStrictEqual(getStrategyWriteCounts(dbA), {
    runCount: 0,
    hitCount: 0,
    auditCount: 0
  });

  // dbB 指向同一物理临时 SQLite 文件，但保持独立连接对象身份。
  const dbB = database.openDatabase();
  // 保存原始方法，用计数证明跨连接 exact 拒绝不触发 dbB SQL 或事务。
  const originalPrepare = dbB.prepare;
  const originalExec = dbB.exec;
  const originalClose = dbB.close;
  // dbB SQL 计数仅统计服务调用，不统计通过 dbA 完成的持久化断言。
  let prepareCount = 0;
  let execCount = 0;
  dbB.prepare = function monitoredPrepare(...args) {
    prepareCount += 1;
    return originalPrepare.apply(dbB, args);
  };
  dbB.exec = function monitoredExec(...args) {
    execCount += 1;
    return originalExec.apply(dbB, args);
  };

  try {
    assert.notStrictEqual(dbA, dbB, 'dbA/dbB 必须是不同 SQLite 连接对象。');
    assert.strictEqual(
      path.resolve(dbA.name),
      path.resolve(dbB.name),
      'dbA/dbB 必须指向同一物理临时 SQLite 文件。'
    );

    // legacy preview/run 不消费 exact capability，独立 dbB 连接必须继续正常工作。
    const legacyPreview = previewEnergyStrategies(createInput(ids.meterDeviceId), { db: dbB });
    assert.strictEqual(legacyPreview.ruleSelection.selectedRuleCount, 1);
    dbB.exec('BEGIN IMMEDIATE');
    try {
      const legacyRun = runEnergyStrategyEvaluation(
        createInput(ids.meterDeviceId),
        createWriteOptions(dbB)
      );
      assert.strictEqual(legacyRun.hits.length, 1);
      assert.strictEqual(legacyRun.meta.reusedCallerTransaction, true);
    } finally {
      if (dbB.inTransaction) dbB.exec('ROLLBACK');
    }
    assert.strictEqual(prepareCount > 0, true, 'legacy 路径必须真实读取和写入 dbB。');
    assert.strictEqual(execCount > 0, true, 'legacy 路径必须真实管理 dbB caller transaction。');
    prepareCount = 0;
    execCount = 0;

    // 外层 strategy capability 和内嵌 load capability 都必须按连接对象身份拒绝 dbB。
    assertBadRequestCode(
      () => assertEnergyStrategyExactScopeCapability(exactScope, dbB),
      'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH'
    );
    assertBadRequestCode(
      () => assertEnergyLoadExactScopeCapability(exactScope.timeseries, dbB),
      'ENERGY_LOAD_EXACT_SCOPE_DATABASE_MISMATCH'
    );

    // preview 和 run 必须在 dbB 任何业务 SQL、事务或审计写入前稳定拒绝。
    assertBadRequestCode(
      () => previewEnergyStrategies(createInput(ids.meterDeviceId), { db: dbB, exactScope }),
      'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH'
    );
    assertBadRequestCode(
      () => runEnergyStrategyEvaluation(
        createInput(ids.meterDeviceId),
        createWriteOptions(dbB, { exactRequired: true, exactScope })
      ),
      'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH'
    );

    // exact preview metadata 只能由生成响应的 dbA 对象读取，缺失 db 同样 fail-closed。
    assertBadRequestCode(
      () => getEnergyStrategyExactScopeMetadata(exactPreview, { db: dbB }),
      'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH'
    );
    assertBadRequestCode(
      () => getEnergyStrategyExactScopeMetadata(exactPreview),
      'ENERGY_STRATEGY_EXACT_SCOPE_DATABASE_MISMATCH'
    );
    assert.strictEqual(prepareCount, 0, '跨连接 exact/metadata 路径不得执行 dbB prepare。');
    assert.strictEqual(execCount, 0, '跨连接 exact/metadata 路径不得执行 dbB exec。');
    assert.strictEqual(dbB.inTransaction, false);
    assert.deepStrictEqual(getStrategyWriteCounts(dbA), {
      runCount: 0,
      hitCount: 0,
      auditCount: 0
    });

  } finally {
    if (dbB.open) originalClose.call(dbB);
    resetScenario(dbA);
  }
}

/**
 * 验证公开纯函数的严格边界，避免配置解析宽松化。
 */
function testPublicValidationHelpers() {
  assert.strictEqual(typeof energyStrategyEvaluationService.consumeEnergyStrategyEvaluationCompletionWitness, 'undefined');
  assert.strictEqual(typeof energyStrategyEvaluationService.getEnergyStrategyRegistrationRegistrarCapability, 'undefined');
  assert.strictEqual(typeof energyStrategyEvaluationService.resolveEnergyStrategyRegistrarCapability, 'undefined');
  assert.strictEqual(
    typeof energyStrategyEvaluationService.consumeEnergyStrategyEvaluationWitnessForOwnership,
    'undefined'
  );
  const witnessConsumerSymbol = Symbol.for('charcoal.energyStrategy.consumeWitness.v1');
  const witnessConsumerDescriptor = Object.getOwnPropertyDescriptor(
    energyStrategyEvaluationService,
    witnessConsumerSymbol
  );
  assert.strictEqual(typeof witnessConsumerDescriptor?.value, 'function');
  assert.strictEqual(witnessConsumerDescriptor.enumerable, false);
  assert.strictEqual(witnessConsumerDescriptor.writable, false);
  assert.strictEqual(witnessConsumerDescriptor.configurable, false);
  assertBadRequestCode(
    () => witnessConsumerDescriptor.value({}),
    'ENERGY_STRATEGY_COMPLETION_WITNESS_INPUT_INVALID'
  );
  assert.strictEqual(Object.isFrozen(energyStrategyEvaluationService), true);
  assert.strictEqual(Object.getPrototypeOf(energyStrategyEvaluationService), Object.prototype);
  [
    energyStrategyEvaluationService,
    demoOwnershipService,
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

  // evaluator 先加载后整体替换两侧 require.cache.exports，固定协议仍必须调用初始化期真实闭包。
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
  const attackerProtocolCall = () => {
    attackerProtocolExecuted = true;
    return { success: true, fake: true };
  };
  const attackerEvaluatorExports = Object.freeze({
    ...originalEvaluatorExports,
    assertEnergyStrategyExactScopeCapability: attackerProtocolCall,
    bindEnergyStrategyRegistrationScopeCapability: attackerProtocolCall
  });
  const attackerOwnershipExports = Object.freeze({
    ...originalOwnershipExports,
    activateStrategyEvaluationRegistrationScopeInTransaction: attackerProtocolCall,
    abortStrategyEvaluationRegistrationScopeInTransaction: attackerProtocolCall,
    registerDerivedStrategyEvaluationInTransaction: attackerProtocolCall,
    verifyDerivedStrategyEvaluationReceiptInTransaction: attackerProtocolCall
  });
  const attackerProtocolExports = Object.freeze({
    ...originalProtocolExports,
    energyStrategyEvaluatorProtocol: { assertExactScope: attackerProtocolCall },
    energyStrategyOwnershipProtocol: { verifyReceipt: attackerProtocolCall }
  });
  assert.strictEqual(Reflect.set(require.cache[evaluatorModulePath], 'exports', attackerEvaluatorExports), false);
  assert.strictEqual(Reflect.set(require.cache[ownershipModulePath], 'exports', attackerOwnershipExports), false);
  assert.strictEqual(Reflect.set(require.cache[protocolModulePath], 'exports', attackerProtocolExports), false);
  assert.strictEqual(require.cache[evaluatorModulePath].exports, originalEvaluatorExports);
  assert.strictEqual(require.cache[ownershipModulePath].exports, originalOwnershipExports);
  assert.strictEqual(require.cache[protocolModulePath].exports, originalProtocolExports);
  assertBadRequestCode(
    () => strategyOwnershipProtocol.energyStrategyEvaluatorProtocol.assertExactScope(
      Object.freeze({}),
      Object.freeze({})
    ),
    'ENERGY_STRATEGY_EXACT_SCOPE_CAPABILITY_REQUIRED'
  );
  assert.throws(
    () => strategyOwnershipProtocol.energyStrategyOwnershipProtocol.verifyReceipt({}),
    (error) => (error.details?.code || error.code)
      === 'DEMO_DERIVED_STRATEGY_RECEIPT_INPUT_INVALID'
  );
  assert.strictEqual(attackerProtocolExecuted, false);
  assert.deepStrictEqual(normalizeRuleCodes(undefined), []);
  assert.deepStrictEqual(normalizeRuleCodes([]), []);
  assert.deepStrictEqual(normalizeRuleCodes([' A ', 'A', 'B']), ['A', 'B']);
  assertBadRequestCode(() => normalizeRuleCodes('A'), 'INVALID_STRATEGY_RULE_CODES');
  assertBadRequestCode(() => normalizeRuleCodes(['']), 'INVALID_STRATEGY_RULE_CODE');

  const validRequirements = parseEvidenceRequirements(JSON.stringify({
    minimumCoverageRate: 0,
    maxEvidenceItems: 1,
    savingBasis: 'window_total_energy'
  }));
  assert.strictEqual(validRequirements.valid, true);
  assert.deepStrictEqual(validRequirements.requirements, {
    minimumCoverageRate: 0,
    maxEvidenceItems: 1,
    savingBasis: 'window_total_energy'
  });
  assert.strictEqual(parseEvidenceRequirements('null').valid, false);
  assert.strictEqual(parseEvidenceRequirements('[]').valid, false);
  assert.strictEqual(MAX_RULE_CODES, 50);
  assert.strictEqual(MAX_STRATEGY_RULES, 50);
  assert.strictEqual(MAX_EVIDENCE_ITEMS, 100);
  // 合法有限值保持既有 JSON 规范文本，避免正常数据摘要无谓变化。
  assert.strictEqual(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.strictEqual(stableStringify(Number.POSITIVE_INFINITY), '@number:Infinity');
  assert.strictEqual(stableStringify(Number.NEGATIVE_INFINITY), '@number:-Infinity');
  assert.strictEqual(stableStringify(Number.NaN), '@number:NaN');
  assert.strictEqual(stableStringify(-0), '@number:-0');
  assert.strictEqual(stableStringify(0), '0');
  assert.notStrictEqual(stableStringify(Number.NaN), stableStringify('@number:NaN'));
  assert.notStrictEqual(
    stableStringify(Number.NaN),
    stableStringify({ type: 'number', value: 'NaN' })
  );
}

let db = null;
try {
  database.initDatabase();
  db = database.openDatabase();
  // 测试主数据和写入助手在隔离库中复用。
  const ids = seedMasterData(db);
  auditActorUserId = Number(db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id);
  const insertTimeseries = createTimeseriesInserter(db, ids);
  const insertRule = createRuleInserter(db);

  testPublicValidationHelpers();
  testAuditActorRequired(db, ids);
  testSupportedMetrics(db, ids, insertTimeseries, insertRule);
  testNotEvaluableMetricQuality(db, ids, insertTimeseries, insertRule);
  testRuleSelection(db, ids, insertTimeseries, insertRule);
  testRuleConfigurationFailures(db, ids, insertTimeseries, insertRule);
  testCoverageAndEvidence(db, ids, insertTimeseries, insertRule);
  testEvaluationDigestBinding(db, ids, insertTimeseries, insertRule);
  testNonFiniteEvaluationDigestEncoding(db, ids, insertTimeseries, insertRule);
  testAutomationAndSavingGates(db, ids, insertTimeseries, insertRule);
  testServerPrivateExactScope(db, ids, insertTimeseries, insertRule);
  testExactScopeDatabaseIdentity(db, ids, insertTimeseries, insertRule);
  testConsistentReadSnapshot(db, ids, insertTimeseries, insertRule);
  testInjectionAndDatabaseOwnership(db, ids, insertTimeseries, insertRule);
  testPersistentEvaluationAndManualStatus(db, ids, insertTimeseries, insertRule);
  testAtomicOperationAuditRollback(db, ids, insertTimeseries, insertRule);
  testDerivedOwnershipReviewRefresh(db, ids, insertTimeseries, insertRule);

  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
    0,
    '全部预演用例结束后仍不得存在运行记录。'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total,
    0,
    '全部预演用例结束后仍不得存在规则命中记录。'
  );
  assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
  console.log('energy strategy evaluation service tests passed');
} finally {
  if (db) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
