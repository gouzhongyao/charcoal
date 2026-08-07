'use strict';

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
const {
  DEFAULT_MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_ITEMS,
  MAX_RULE_CODES,
  MAX_STRATEGY_RULES,
  SUPPORTED_FORMULA_VERSION,
  normalizeRuleCodes,
  parseEvidenceRequirements,
  previewEnergyStrategies,
  stableStringify
} = require('../services/energyStrategyEvaluationService');

// 策略测试统一使用上海来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 策略测试统一使用一小时左闭右开窗口。
const WINDOW_START_UTC = '2026-07-15T00:00:00.000Z';
// 策略测试窗口结束时间。
const WINDOW_END_UTC = '2026-07-15T01:00:00.000Z';

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
 * 创建时序事实写入函数。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @returns {Function} 单条时序事实写入函数。
 */
function createTimeseriesInserter(db, ids) {
  // 写入语句只生成 active 手工测试事实。
  const insert = db.prepare(
    `INSERT INTO energy_timeseries_records (
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'kWh', ?, 'kWh', ?, ?, 'manual', 'active')`
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
      ids.organizationUnitId,
      ids.meterDeviceId,
      ids.electricityId,
      overrides.startUtc || WINDOW_START_UTC,
      overrides.endUtc || '2026-07-15T00:15:00.000Z',
      overrides.sourceTimeZone || SOURCE_TIME_ZONE,
      overrides.granularityMinutes || 15,
      value,
      value,
      overrides.sourceReference || `strategy-preview:test:${sourceSequence}`
    ).lastInsertRowid);
  };
}

/**
 * 写入从窗口开始连续排列的十五分钟时序事实。
 * @param {Function} insertTimeseries 单条写入函数。
 * @param {number[]} values 每个十五分钟区间能源量。
 * @returns {number[]} 写入事实 ID。
 */
function insertQuarterHourSeries(insertTimeseries, values) {
  return values.map((value, index) => {
    // 区间边界由固定窗口开始时间按十五分钟递增。
    const startMs = Date.parse(WINDOW_START_UTC) + index * 15 * 60 * 1000;
    return insertTimeseries({
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(startMs + 15 * 60 * 1000).toISOString(),
      granularityMinutes: 15,
      value,
      sourceReference: `strategy-preview:quarter:${index + 1}`
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
 * 验证公开纯函数的严格边界，避免配置解析宽松化。
 */
function testPublicValidationHelpers() {
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
  const insertTimeseries = createTimeseriesInserter(db, ids);
  const insertRule = createRuleInserter(db);

  testPublicValidationHelpers();
  testSupportedMetrics(db, ids, insertTimeseries, insertRule);
  testNotEvaluableMetricQuality(db, ids, insertTimeseries, insertRule);
  testRuleSelection(db, ids, insertTimeseries, insertRule);
  testRuleConfigurationFailures(db, ids, insertTimeseries, insertRule);
  testCoverageAndEvidence(db, ids, insertTimeseries, insertRule);
  testEvaluationDigestBinding(db, ids, insertTimeseries, insertRule);
  testNonFiniteEvaluationDigestEncoding(db, ids, insertTimeseries, insertRule);
  testAutomationAndSavingGates(db, ids, insertTimeseries, insertRule);
  testConsistentReadSnapshot(db, ids, insertTimeseries, insertRule);
  testInjectionAndDatabaseOwnership(db, ids, insertTimeseries, insertRule);

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
