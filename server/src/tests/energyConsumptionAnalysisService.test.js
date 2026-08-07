'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试数据库和全部本地目录均隔离到系统临时目录，禁止访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-load-summary-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-load-summary.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const database = require('../db/database');
const { ENERGY_ANALYSIS_REASON_CODES } = require('../services/energyAnalysisContracts');
const {
  ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE,
  DEFAULT_MONTHLY_ANALYSIS_TOP_N,
  DEVICE_STATE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
  DEVICE_STATE_QUERY_LIMIT,
  ENERGY_ANALYSIS_QUERY_FAILED_CODE,
  ENERGY_LOAD_CURVE_FORMULA_VERSION,
  MAX_DEVICE_STATE_RECORDS,
  MAX_ENERGY_LOAD_CURVE_BUCKETS,
  MAX_MONTHLY_ANALYSIS_MONTHS,
  MAX_MONTHLY_ANALYSIS_TOP_N,
  MAX_QUERY_RANGE_DAYS,
  MAX_SHIFT_SCHEDULE_RECORDS,
  MAX_TIMESERIES_RECORDS,
  MINIMUM_COVERAGE_RATE,
  MIN_SUPPORTED_ANALYSIS_YEAR,
  MONTHLY_ANALYSIS_LOOKBACK_MONTHS,
  SHIFT_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
  SHIFT_SCHEDULE_QUERY_LIMIT,
  TIME_OF_USE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
  TIMESERIES_QUERY_LIMIT,
  getDeviceStateConsumptionAnalysis,
  getEnergyLoadCurve,
  getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis,
  getShiftConsumptionAnalysis,
  getTimeOfUseConsumptionAnalysis,
  normalizeDeviceStateConsumptionAnalysisInput,
  normalizeEnergyLoadCurveInput,
  normalizeEnergyLoadSummaryInput,
  normalizeMonthlyConsumptionAnalysisInput,
  normalizeShiftConsumptionAnalysisInput
} = require('../services/energyConsumptionAnalysisService');

// 基础测试来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 固定测试表计编码。
const PRIMARY_METER_CODE = 'LOAD-METER-001';
// 其他精确范围测试表计编码。
const SECONDARY_METER_CODE = 'LOAD-METER-002';
// 冻结数据质量原因码集合，用于防止配置错误泄漏到 reasonCodes。
const APPROVED_REASON_CODE_SET = new Set(ENERGY_ANALYSIS_REASON_CODES);

/**
 * 捕获同步业务错误并返回稳定 details.code。
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
 * 断言班次质量原因码均属于冻结的十三项数据质量码。
 * @param {object} result 班次分析结果。
 */
function assertApprovedShiftReasonCodes(result) {
  result.quality.reasonCodes.forEach((reasonCode) => {
    assert(APPROVED_REASON_CODE_SET.has(reasonCode), `发现未批准班次原因码：${reasonCode}`);
  });
}

/**
 * 捕获月度分析数值溢出并验证稳定、脱敏的五百错误。
 * @param {Function} action 待执行动作。
 * @returns {object} 捕获的数值溢出错误。
 */
function assertAnalysisNumericOverflow(action) {
  let capturedError = null;
  try {
    action();
  } catch (error) {
    capturedError = error;
  }
  assert(capturedError, '预期抛出 ANALYSIS_NUMERIC_OVERFLOW，实际未抛错。');
  assert.strictEqual(capturedError.code, 'ANALYSIS_NUMERIC_OVERFLOW');
  assert.strictEqual(capturedError.statusCode, 500);
  assert.strictEqual(capturedError.message, '能源分析数值超出安全计算范围。');
  assert.deepStrictEqual(capturedError.details, { code: 'ANALYSIS_NUMERIC_OVERFLOW' });
  assert.strictEqual(JSON.stringify(capturedError.details).includes('1e+308'), false);
  return capturedError;
}

/**
 * 捕获班次底层查询失败并验证稳定、脱敏的五百错误。
 * @param {Function} action 待执行动作。
 * @returns {object} 捕获的安全查询错误。
 */
function assertEnergyAnalysisQueryFailed(action) {
  let capturedError = null;
  try {
    action();
  } catch (error) {
    capturedError = error;
  }
  assert(capturedError, '预期抛出 ENERGY_ANALYSIS_QUERY_FAILED，实际未抛错。');
  assert.strictEqual(capturedError.code, ENERGY_ANALYSIS_QUERY_FAILED_CODE);
  assert.strictEqual(capturedError.statusCode, 500);
  assert.strictEqual(capturedError.message, '能源分析查询失败。');
  assert.deepStrictEqual(capturedError.details, {
    code: ENERGY_ANALYSIS_QUERY_FAILED_CODE
  });
  const serializedError = JSON.stringify({
    code: capturedError.code,
    statusCode: capturedError.statusCode,
    message: capturedError.message,
    details: capturedError.details
  });
  assert.strictEqual(serializedError.includes('C:\\secret\\tenant.sqlite'), false);
  assert.strictEqual(serializedError.includes('SELECT * FROM hidden'), false);
  assert.strictEqual(serializedError.toLowerCase().includes('sqlite'), false);
  return capturedError;
}

/**
 * 捕获本地时间投影失败并验证稳定、脱敏的五百错误。
 * @param {Function} action 待执行动作。
 * @returns {object} 捕获的投影错误。
 */
function assertLocalTimeProjectionFailure(action) {
  let capturedError = null;
  try {
    action();
  } catch (error) {
    capturedError = error;
  }
  assert(capturedError, '预期抛出 ANALYSIS_LOCAL_TIME_PROJECTION_FAILED，实际未抛错。');
  assert.strictEqual(capturedError.code, 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED');
  assert.strictEqual(capturedError.statusCode, 500);
  assert.strictEqual(capturedError.message, '能源分析本地时间投影失败。');
  assert.deepStrictEqual(capturedError.details, {
    code: 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED'
  });
  return capturedError;
}

/**
 * 断言两个浮点数在允许误差内一致。
 * @param {number} actual 实际值。
 * @param {number} expected 期望值。
 * @param {number} tolerance 允许绝对误差。
 */
function assertClose(actual, expected, tolerance = 1e-10) {
  assert.strictEqual(Number.isFinite(actual), true, `${actual} 必须是有限数值。`);
  assert.strictEqual(Math.abs(actual - expected) <= tolerance, true, `${actual} 不接近 ${expected}。`);
}

/**
 * 创建标准负荷摘要输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 查询输入。
 */
function createInput(overrides = {}) {
  return {
    meterDeviceId: overrides.meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z',
    sourceTimeZone: SOURCE_TIME_ZONE,
    ...overrides
  };
}

/**
 * 创建标准固定 UTC 负荷曲线输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 曲线查询输入。
 */
function createCurveInput(overrides = {}) {
  return {
    ...createInput(overrides),
    outputIntervalMinutes: 15,
    ...overrides
  };
}

// 峰平谷测试方案编码序号，保证临时库唯一约束稳定。
let timeOfUseSchemeSequence = 0;

/**
 * 创建标准显式峰平谷消费分析输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 峰平谷查询输入。
 */
function createTimeOfUseInput(overrides = {}) {
  return {
    ...createInput(overrides),
    touSchemeId: overrides.touSchemeId,
    ...overrides
  };
}

/**
 * 清理峰平谷方案及其级联规则。
 * @param {object} db SQLite 连接。
 */
function clearTimeOfUseConfiguration(db) {
  db.prepare('DELETE FROM tou_schemes').run();
}

/**
 * 创建七天完整覆盖或调用方指定规则的峰平谷方案。
 * @param {object} db SQLite 连接。
 * @param {object} options 方案与规则覆盖项。
 * @returns {number} 新方案 ID。
 */
function seedTimeOfUseScheme(db, options = {}) {
  timeOfUseSchemeSequence += 1;
  const sourceTimeZone = options.sourceTimeZone || SOURCE_TIME_ZONE;
  const schemeCode = options.schemeCode || `TOU-TEST-${timeOfUseSchemeSequence}`;
  const version = options.version || `v${timeOfUseSchemeSequence}`;
  const schemeId = Number(db.prepare(
    `INSERT INTO tou_schemes (
       scheme_code, scheme_name, source_timezone, source, document_no, version,
       effective_start_utc, effective_end_utc, status
     ) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)`
  ).run(
    schemeCode,
    options.schemeName || `峰平谷测试方案${timeOfUseSchemeSequence}`,
    sourceTimeZone,
    options.documentNo || `DOC-${timeOfUseSchemeSequence}`,
    version,
    options.effectiveStartUtc || '2026-01-01T00:00:00.000Z',
    options.effectiveEndUtc || '2027-01-01T00:00:00.000Z',
    options.status || 'active'
  ).lastInsertRowid);
  const defaultDayRules = [
    { periodType: 'peak', startMinute: 0, endMinute: 480 },
    { periodType: 'flat', startMinute: 480, endMinute: 960 },
    { periodType: 'valley', startMinute: 960, endMinute: 1440 }
  ];
  const rules = Object.prototype.hasOwnProperty.call(options, 'rules')
    ? options.rules
    : Array.from({ length: 7 }, (_value, index) => defaultDayRules.map((rule) => ({
      dayOfWeek: index + 1,
      ...rule
    }))).flat();
  const insertRule = db.prepare(
    `INSERT INTO tou_period_rules (
       tou_scheme_id, day_of_week, period_type, start_minute, end_minute
     ) VALUES (?, ?, ?, ?, ?)`
  );
  rules.forEach((rule) => {
    insertRule.run(
      schemeId,
      rule.dayOfWeek,
      rule.periodType,
      rule.startMinute,
      rule.endMinute
    );
  });
  return schemeId;
}

/**
 * 查找峰平谷结果中的固定类型时段。
 * @param {object} result 峰平谷服务响应。
 * @param {string} type 峰平谷类型。
 * @returns {object} 对应时段。
 */
function getTimeOfUsePeriod(result, type) {
  const period = result.periods.find((item) => item.type === type);
  assert(period, `未找到峰平谷时段 ${type}。`);
  return period;
}

// 班次定义测试序号，保证临时库唯一约束稳定。
let shiftDefinitionSequence = 0;
// 实际排班来源测试序号，便于定位单条事实。
let shiftScheduleSequence = 0;

/**
 * 创建标准班次能耗分析输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 班次分析输入。
 */
function createShiftInput(overrides = {}) {
  return {
    ...createInput(overrides),
    ...overrides
  };
}

// 设备状态来源测试序号，保证临时库来源引用唯一。
let deviceStateSequence = 0;

/**
 * 创建设备状态消费分析标准输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 设备状态查询输入。
 */
function createDeviceStateInput(overrides = {}) {
  return {
    ...createInput(overrides),
    ...overrides
  };
}

/**
 * 清理设备状态事实，保持每个测试场景独立。
 * @param {object} db SQLite 连接。
 */
function clearDeviceStateRecords(db) {
  db.prepare('DELETE FROM device_state_records').run();
}

/**
 * 写入单条设备状态事实。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {object} options 状态事实覆盖项。
 * @returns {number} 状态记录 ID。
 */
function seedDeviceState(db, ids, options = {}) {
  deviceStateSequence += 1;
  const organizationUnitId = Object.prototype.hasOwnProperty.call(options, 'organizationUnitId')
    ? options.organizationUnitId
    : ids.organizationUnitId;
  const meterDeviceId = options.meterDeviceId || ids.primaryMeterId;
  const recordStatus = options.recordStatus || 'active';
  return Number(db.prepare(
    `INSERT INTO device_state_records (
       meter_device_id, organization_unit_id, device_state, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status, void_reason, voided_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
  ).run(
    meterDeviceId,
    organizationUnitId,
    options.status || 'running',
    options.startUtc || '2026-07-15T00:00:00.000Z',
    options.endUtc || '2026-07-15T01:00:00.000Z',
    options.sourceTimeZone || SOURCE_TIME_ZONE,
    options.sourceReference || `device-state:test:${deviceStateSequence}`,
    recordStatus,
    recordStatus === 'void' ? (options.voidReason || '测试作废') : null,
    recordStatus === 'void' ? (options.voidedAt || '2026-07-16T00:00:00.000Z') : null
  ).lastInsertRowid);
}

/**
 * 清理实际排班及定义，保持外键删除顺序。
 * @param {object} db SQLite 连接。
 */
function clearShiftConfiguration(db) {
  db.prepare('DELETE FROM shift_schedule_records').run();
  db.prepare('DELETE FROM shift_definitions').run();
}

/**
 * 写入班次定义；墙钟字段只作为主数据，不参与实际 UTC 排班计算。
 * @param {object} db SQLite 连接。
 * @param {object} options 定义覆盖项。
 * @returns {number} 班次定义 ID。
 */
function seedShiftDefinition(db, options = {}) {
  shiftDefinitionSequence += 1;
  const shiftCode = options.shiftCode || `SHIFT-TEST-${shiftDefinitionSequence}`;
  const version = options.version || `v${shiftDefinitionSequence}`;
  return Number(db.prepare(
    `INSERT INTO shift_definitions (
       shift_code, shift_name, start_minute, end_minute, crosses_midnight,
       source_timezone, source, version, effective_start_utc, effective_end_utc, status
     ) VALUES (?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?)`
  ).run(
    shiftCode,
    options.shiftName || `测试班次${shiftDefinitionSequence}`,
    options.startMinute === undefined ? 480 : options.startMinute,
    options.endMinute === undefined ? 960 : options.endMinute,
    options.crossesMidnight === undefined ? 0 : options.crossesMidnight,
    options.sourceTimeZone || SOURCE_TIME_ZONE,
    version,
    options.effectiveStartUtc || '2026-01-01T00:00:00.000Z',
    options.effectiveEndUtc || '2027-01-01T00:00:00.000Z',
    options.status || 'active'
  ).lastInsertRowid);
}

/**
 * 写入已物化实际 UTC 排班记录。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {object} options 排班覆盖项。
 * @returns {number} 实际排班记录 ID。
 */
function seedShiftSchedule(db, ids, options = {}) {
  shiftScheduleSequence += 1;
  const recordStatus = options.recordStatus || 'active';
  const organizationUnitId = Object.prototype.hasOwnProperty.call(options, 'organizationUnitId')
    ? options.organizationUnitId
    : ids.organizationUnitId;
  return Number(db.prepare(
    `INSERT INTO shift_schedule_records (
       shift_definition_id, organization_unit_id, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status,
       void_reason, voided_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
  ).run(
    options.shiftDefinitionId,
    organizationUnitId,
    options.startUtc || '2026-07-15T00:00:00.000Z',
    options.endUtc || '2026-07-15T01:00:00.000Z',
    options.sourceTimeZone || SOURCE_TIME_ZONE,
    options.sourceReference || `shift-schedule:test:${shiftScheduleSequence}`,
    recordStatus,
    recordStatus === 'void' ? (options.voidReason || '测试作废') : null,
    recordStatus === 'void' ? (options.voidedAt || '2026-07-16T00:00:00.000Z') : null
  ).lastInsertRowid);
}

/**
 * 查找班次结果中的严格 definition ID 与版本分组。
 * @param {object} result 班次分析响应。
 * @param {number} shiftDefinitionId 班次定义 ID。
 * @param {string} version 班次定义版本。
 * @returns {object} 对应班次分组。
 */
function getShiftAllocation(result, shiftDefinitionId, version) {
  const shift = result.shifts.find((item) => (
    item.shiftDefinitionId === shiftDefinitionId && item.version === version
  ));
  assert(shift, `未找到班次 identity ${shiftDefinitionId}/${version}。`);
  return shift;
}

/**
 * 按固定粒度写入连续时序记录。
 * @param {Function} insertRecord 单条写入函数。
 * @param {string} startUtc 起始 UTC。
 * @param {number} count 记录数量。
 * @param {number} granularityMinutes 粒度分钟数。
 * @param {number|Function} value 能源量或按索引取值函数。
 * @param {object} overrides 公共覆盖字段。
 */
function insertContinuousSeries(
  insertRecord,
  startUtc,
  count,
  granularityMinutes,
  value,
  overrides = {}
) {
  const startMs = Date.parse(startUtc);
  for (let index = 0; index < count; index += 1) {
    const recordStartMs = startMs + index * granularityMinutes * 60 * 1000;
    const recordValue = typeof value === 'function' ? value(index) : value;
    insertRecord({
      ...overrides,
      startUtc: new Date(recordStartMs).toISOString(),
      endUtc: new Date(recordStartMs + granularityMinutes * 60 * 1000).toISOString(),
      granularityMinutes,
      normalizedValue: recordValue,
      originalValue: recordValue
    });
  }
}

/**
 * 写入测试组织与两个电力表计。
 * @param {object} db SQLite 连接。
 * @returns {object} 主数据 ID。
 */
function seedMasterData(db) {
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  const naturalGas = db.prepare("SELECT id FROM energy_types WHERE code = 'natural_gas'").get();
  const organizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('LOAD-OU-001', '负荷摘要测试单元', '/负荷摘要测试单元', 'workshop', 'active')`
  ).run().lastInsertRowid);
  const insertMeter = db.prepare(
    `INSERT INTO meter_devices
       (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES (?, ?, 'electricity', ?, ?, 'active')`
  );
  const primaryMeterId = Number(insertMeter.run(
    PRIMARY_METER_CODE,
    '负荷摘要主表计',
    electricity.id,
    organizationUnitId
  ).lastInsertRowid);
  const secondaryMeterId = Number(insertMeter.run(
    SECONDARY_METER_CODE,
    '负荷摘要其他表计',
    electricity.id,
    organizationUnitId
  ).lastInsertRowid);
  return {
    electricityId: Number(electricity.id),
    naturalGasId: Number(naturalGas.id),
    organizationUnitId,
    primaryMeterId,
    secondaryMeterId
  };
}

/**
 * 删除全部测试时序事实，保持主数据不变。
 * @param {object} db SQLite 连接。
 */
function clearTimeseriesRecords(db) {
  db.prepare('DELETE FROM energy_timeseries_records').run();
}

/**
 * 创建时序事实写入函数。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @returns {Function} 单条写入函数。
 */
function createTimeseriesInserter(db, ids) {
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
       record_status,
       void_reason,
       voided_at
     ) VALUES (
       @organizationUnitId,
       @meterDeviceId,
       @energyTypeId,
       @startUtc,
       @endUtc,
       @sourceTimeZone,
       @granularityMinutes,
       @originalUnit,
       @originalValue,
       @normalizedUnit,
       @normalizedValue,
       @sourceReference,
       'manual',
       @recordStatus,
       @voidReason,
       @voidedAt
     )`
  );
  let sourceSequence = 0;
  return (overrides = {}) => {
    sourceSequence += 1;
    const recordStatus = overrides.recordStatus || 'active';
    const normalizedUnit = overrides.normalizedUnit || 'kWh';
    const normalizedValue = Object.prototype.hasOwnProperty.call(overrides, 'normalizedValue')
      ? overrides.normalizedValue
      : 10;
    return Number(insert.run({
      organizationUnitId: Object.prototype.hasOwnProperty.call(overrides, 'organizationUnitId')
        ? overrides.organizationUnitId
        : ids.organizationUnitId,
      meterDeviceId: overrides.meterDeviceId || ids.primaryMeterId,
      energyTypeId: overrides.energyTypeId || ids.electricityId,
      startUtc: overrides.startUtc || '2026-07-15T00:00:00.000Z',
      endUtc: overrides.endUtc || '2026-07-15T00:15:00.000Z',
      sourceTimeZone: overrides.sourceTimeZone || SOURCE_TIME_ZONE,
      granularityMinutes: overrides.granularityMinutes || 15,
      originalUnit: overrides.originalUnit || normalizedUnit,
      originalValue: Object.prototype.hasOwnProperty.call(overrides, 'originalValue')
        ? overrides.originalValue
        : normalizedValue,
      normalizedUnit,
      normalizedValue,
      sourceReference: overrides.sourceReference || `load-summary:test:${sourceSequence}`,
      recordStatus,
      voidReason: recordStatus === 'void' ? (overrides.voidReason || '测试作废') : null,
      voidedAt: recordStatus === 'void' ? (overrides.voidedAt || '2026-07-16T00:00:00.000Z') : null
    }).lastInsertRowid);
  };
}

/**
 * 写入连续的十五分钟记录。
 * @param {Function} insertRecord 单条写入函数。
 * @param {number[]} values 各区间能源量。
 * @param {object} overrides 公共覆盖字段。
 */
function insertQuarterHourSeries(insertRecord, values, overrides = {}) {
  values.forEach((value, index) => {
    const startMs = Date.parse('2026-07-15T00:00:00.000Z') + index * 15 * 60 * 1000;
    insertRecord({
      ...overrides,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(startMs + 15 * 60 * 1000).toISOString(),
      granularityMinutes: 15,
      normalizedValue: value,
      originalValue: value
    });
  });
}

/**
 * 验证输入规范化、固定限制与非法范围错误。
 * @param {number} meterDeviceId 有效表计 ID。
 */
function testInputValidation(meterDeviceId) {
  assert.strictEqual(MAX_QUERY_RANGE_DAYS, 31);
  assert.strictEqual(MAX_TIMESERIES_RECORDS, 50000);
  assert.strictEqual(TIMESERIES_QUERY_LIMIT, 50001);
  assert.strictEqual(MINIMUM_COVERAGE_RATE, 1);
  assert.strictEqual(MIN_SUPPORTED_ANALYSIS_YEAR, 1);
  assert.strictEqual(
    ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE,
    'ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED'
  );

  const exactRange = normalizeEnergyLoadSummaryInput(createInput({
    meterDeviceId,
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-02-01T00:00:00Z',
    minimumCoverageRate: 1
  }));
  assert.strictEqual(exactRange.durationMinutes, 31 * 24 * 60, '恰好 31 天必须允许。');
  assert.strictEqual(exactRange.startUtc, '2026-01-01T00:00:00.000Z');
  const millisecondRange = normalizeEnergyLoadSummaryInput(createInput({
    meterDeviceId,
    startUtc: '2026-07-15T00:00:00.001Z',
    endUtc: '2026-07-15T00:00:00.002Z'
  }));
  assert.strictEqual(millisecondRange.startUtc, '2026-07-15T00:00:00.001Z');
  assert.strictEqual(millisecondRange.endUtc, '2026-07-15T00:00:00.002Z');
  assertClose(millisecondRange.durationMinutes, 1 / 60000);

  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({
      meterDeviceId,
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.001Z'
    })),
    'ENERGY_LOAD_TIME_RANGE_EXCEEDED'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId, startUtc: '2026-07-15T08:00:00+08:00' })),
    'INVALID_START_UTC'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({
      meterDeviceId,
      startUtc: '0000-01-01T00:00:00.000Z'
    })),
    'INVALID_START_UTC'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({
      meterDeviceId,
      endUtc: '0000-01-01T00:15:00.000Z'
    })),
    'INVALID_END_UTC'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId, endUtc: '2026-02-30T00:00:00Z' })),
    'INVALID_END_UTC'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId, sourceTimeZone: 'Asia/Not_A_Real_Zone' })),
    'INVALID_SOURCE_TIME_ZONE'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId, endUtc: '2026-07-15T00:00:00.000Z' })),
    'INVALID_ENERGY_LOAD_TIME_RANGE'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId, minimumCoverageRate: 0.5 })),
    'ENERGY_LOAD_MINIMUM_COVERAGE_RATE_FIXED'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadSummaryInput(createInput({ meterDeviceId: '1 OR 1=1' })),
    'INVALID_METER_DEVICE_ID'
  );
}

/**
 * 验证固定 UTC 曲线的粒度、epoch 对齐、31 天和 3000 桶上限。
 * @param {number} meterDeviceId 有效表计 ID。
 */
function testCurveInputValidation(meterDeviceId) {
  assert.strictEqual(MAX_ENERGY_LOAD_CURVE_BUCKETS, 3000);
  assert.strictEqual(ENERGY_LOAD_CURVE_FORMULA_VERSION, 'load-curve-analysis:v1');
  const exactThirtyOneDays = normalizeEnergyLoadCurveInput(createCurveInput({
    meterDeviceId,
    startUtc: '2026-01-01T00:00:00.000Z',
    endUtc: '2026-02-01T00:00:00.000Z',
    outputIntervalMinutes: 15
  }));
  assert.strictEqual(exactThirtyOneDays.durationMinutes, 31 * 24 * 60);
  assert.strictEqual(exactThirtyOneDays.bucketCount, 31 * 24 * 4);
  const gmtInput = normalizeEnergyLoadCurveInput(createCurveInput({
    meterDeviceId,
    sourceTimeZone: 'Etc/GMT',
    outputIntervalMinutes: '30'
  }));
  assert.strictEqual(gmtInput.sourceTimeZone, 'Etc/GMT');
  assert.strictEqual(gmtInput.outputIntervalMinutes, 30);
  const earlyYearInput = normalizeEnergyLoadCurveInput(createCurveInput({
    meterDeviceId,
    startUtc: '0001-01-01T00:00:00.000Z',
    endUtc: '0001-01-01T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT'
  }));
  assert.strictEqual(earlyYearInput.startUtc, '0001-01-01T00:00:00.000Z');
  assert.strictEqual(earlyYearInput.bucketCount, 1);
  ['America/New_York', 'America/St_Johns'].forEach((sourceTimeZone) => {
    const localEraError = assertBadRequestCode(
      () => normalizeEnergyLoadCurveInput(createCurveInput({
        meterDeviceId,
        startUtc: '0001-01-01T00:00:00.000Z',
        endUtc: '0001-01-01T00:15:00.000Z',
        sourceTimeZone
      })),
      ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE
    );
    assert.strictEqual(localEraError.details.sourceTimeZone, sourceTimeZone);
  });

  // 冷缓存内部故障必须返回脱敏 500 且不污染缓存；明确非法时区保持 400 并复用缓存。
  const originalColdCacheDateTimeFormat = Intl.DateTimeFormat;
  const coldCacheConstructionCounts = new Map();
  function ControlledColdCacheDateTimeFormat(...args) {
    const sourceTimeZone = args[1] && args[1].timeZone;
    coldCacheConstructionCounts.set(
      sourceTimeZone,
      (coldCacheConstructionCounts.get(sourceTimeZone) || 0) + 1
    );
    if (sourceTimeZone === 'Pacific/Chatham') {
      throw new Error('controlled service cold-cache failure');
    }
    return new originalColdCacheDateTimeFormat(...args);
  }
  ControlledColdCacheDateTimeFormat.prototype = originalColdCacheDateTimeFormat.prototype;
  ControlledColdCacheDateTimeFormat.supportedLocalesOf =
    originalColdCacheDateTimeFormat.supportedLocalesOf.bind(originalColdCacheDateTimeFormat);
  try {
    Intl.DateTimeFormat = ControlledColdCacheDateTimeFormat;
    assertLocalTimeProjectionFailure(() => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      sourceTimeZone: 'Pacific/Chatham'
    })));
    assertBadRequestCode(
      () => normalizeEnergyLoadCurveInput(createCurveInput({
        meterDeviceId,
        sourceTimeZone: 'Mars/Service_Invalid_Zone'
      })),
      'INVALID_SOURCE_TIME_ZONE'
    );
    assertBadRequestCode(
      () => normalizeEnergyLoadCurveInput(createCurveInput({
        meterDeviceId,
        sourceTimeZone: 'Mars/Service_Invalid_Zone'
      })),
      'INVALID_SOURCE_TIME_ZONE'
    );
    assert.strictEqual(coldCacheConstructionCounts.get('Pacific/Chatham'), 1);
    assert.strictEqual(coldCacheConstructionCounts.get('Mars/Service_Invalid_Zone'), 1);
  } finally {
    Intl.DateTimeFormat = originalColdCacheDateTimeFormat;
  }
  const recoveredColdCacheInput = normalizeEnergyLoadCurveInput(createCurveInput({
    meterDeviceId,
    sourceTimeZone: 'Pacific/Chatham'
  }));
  assert.strictEqual(recoveredColdCacheInput.sourceTimeZone, 'Pacific/Chatham');

  const originalInputFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  try {
    Intl.DateTimeFormat.prototype.formatToParts = () => [{
      type: 'timeZoneName',
      value: 'UNEXPECTED_INPUT_OFFSET'
    }];
    assertLocalTimeProjectionFailure(() => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId
    })));
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalInputFormatToParts;
  }
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      startUtc: '0000-01-01T00:00:00.000Z',
      endUtc: '0000-01-01T00:15:00.000Z',
      sourceTimeZone: 'Etc/GMT'
    })),
    'INVALID_START_UTC'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      sourceTimeZone: 'GMT'
    })),
    'INVALID_SOURCE_TIME_ZONE'
  );

  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      outputIntervalMinutes: 10
    })),
    'INVALID_OUTPUT_INTERVAL_MINUTES'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      startUtc: '2026-07-15T00:01:00.000Z'
    })),
    'ENERGY_LOAD_CURVE_TIME_NOT_ALIGNED'
  );
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      startUtc: '2026-07-15T08:00:00+08:00'
    })),
    'INVALID_START_UTC'
  );
  const threeThousandBucketEndUtc = new Date(3000 * 15 * 60 * 1000).toISOString();
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      startUtc: '1970-01-01T00:00:00.000Z',
      endUtc: threeThousandBucketEndUtc,
      outputIntervalMinutes: 15
    })),
    'ENERGY_LOAD_TIME_RANGE_EXCEEDED'
  );
  const threeThousandOneBucketEndUtc = new Date(3001 * 15 * 60 * 1000).toISOString();
  assertBadRequestCode(
    () => normalizeEnergyLoadCurveInput(createCurveInput({
      meterDeviceId,
      startUtc: '1970-01-01T00:00:00.000Z',
      endUtc: threeThousandOneBucketEndUtc,
      outputIntervalMinutes: 15
    })),
    'ENERGY_LOAD_CURVE_BUCKET_LIMIT_EXCEEDED'
  );
}

/**
 * 验证 active、精确范围、完整覆盖和稳定输出契约。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testFullCoverageAndExactScope(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertQuarterHourSeries(insertRecord, [10, 20, 30, 40]);
  insertRecord({
    recordStatus: 'void',
    normalizedValue: 1000,
    originalValue: 1000
  });
  insertRecord({
    meterDeviceId: ids.secondaryMeterId,
    normalizedValue: 900,
    originalValue: 900
  });
  insertRecord({
    energyTypeId: ids.naturalGasId,
    normalizedUnit: 'm3',
    originalUnit: 'm3',
    normalizedValue: 800,
    originalValue: 800
  });
  insertRecord({
    normalizedUnit: 'MWh',
    originalUnit: 'MWh',
    normalizedValue: 700,
    originalValue: 700
  });
  insertRecord({
    sourceTimeZone: 'Asia/Tokyo',
    normalizedValue: 600,
    originalValue: 600
  });

  const result = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }), { db });
  assert.strictEqual(result.contractVersion, 'energy-analysis-contract:v1');
  assert.strictEqual(result.formulaVersion, 'load-analysis:v1');
  assert.strictEqual(result.scope.meterDeviceId, ids.primaryMeterId);
  assert.strictEqual(result.scope.energyTypeCode, 'electricity');
  assert.strictEqual(result.scope.unit, 'kWh');
  assert.strictEqual(result.scope.sourceTimeZone, SOURCE_TIME_ZONE);
  assert.strictEqual(result.scope.comparable, true);
  assert.strictEqual(result.dataRange.intervalConvention, '[startUtc,endUtc)');
  assert.strictEqual(result.granularityMinutes, 15);
  assert.strictEqual(result.recordCount, 4, '只能读取精确 active 表计/能源/单位/时区范围。');
  assert.strictEqual(result.quality.status, 'sufficient');
  assert.strictEqual(result.quality.coverageRate, 1);
  assert.deepStrictEqual(result.quality.reasonCodes, []);
  assert.strictEqual(result.metrics.observedEnergy, 100);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.totalEnergy, 100);
  assert.strictEqual(result.metrics.totalEnergyComplete, true);
  assert.strictEqual(result.metrics.averageLoad, 100);
  assert.strictEqual(result.metrics.maxLoad, 160);
  assert.strictEqual(result.metrics.loadUnit, 'kW');
  assertClose(result.metrics.loadRate, 0.625);
  assert.strictEqual(result.metrics.loadRatePercent, 62.5);
  assert.strictEqual(result.metrics.loadRateCalculable, true);
  assert.strictEqual(result.metrics.loadRateReason, null);
  assert.strictEqual(result.maxLoadInterval.metricCode, 'max_load');
  assert.strictEqual(result.maxLoadInterval.averageLoad, result.metrics.maxLoad);
  assert.strictEqual(result.maxLoadInterval.startUtc, '2026-07-15T00:45:00.000Z');
  assert.strictEqual(result.maxLoadInterval.endUtc, '2026-07-15T01:00:00.000Z');
  assert.strictEqual(result.maxLoadInterval.overlapMinutes, 15);
  assert.strictEqual(result.maxLoadInterval.partialOverlap, false);
  assert.strictEqual(result.maxLoadInterval.sourceEnergy.value, 40);
  assert.strictEqual(result.maxLoadInterval.sourceEnergy.unit, 'kWh');
  assert.strictEqual(result.peakInterval.metricCode, 'peak_interval_energy');
  assert.strictEqual(result.peakInterval.candidateRule, 'fully_inside_window_only');
  assert.strictEqual(result.peakInterval.startUtc, '2026-07-15T00:45:00.000Z');
  assert.strictEqual(result.peakInterval.endUtc, '2026-07-15T01:00:00.000Z');
  assert.strictEqual(result.peakInterval.energy, 40);
  assert.strictEqual(result.peakInterval.averageLoad, 160);
  assert.strictEqual(result.meta.monthlyEnergyRecordsRead, false);
  assert.strictEqual(result.meta.queryLimit, 50001);
  assert.strictEqual(result.meta.callerDatabaseConnection, true);
}

/**
 * 验证左闭右开查询边界不会读入相邻区间。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testHalfOpenBoundary(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00Z',
    endUtc: '2026-07-15T00:15:00Z',
    normalizedValue: 1,
    originalValue: 1
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    normalizedValue: 2,
    originalValue: 2
  });
  insertRecord({
    startUtc: '2026-07-15T00:30:00Z',
    endUtc: '2026-07-15T00:45:00Z',
    normalizedValue: 3,
    originalValue: 3
  });

  const result = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:15:00Z',
    endUtc: '2026-07-15T00:30:00Z'
  }), { db });
  assert.strictEqual(result.recordCount, 1);
  assert.strictEqual(result.metrics.totalEnergy, 2);
  assert.strictEqual(result.peakInterval.energy, 2);
}

/**
 * 验证毫秒级左右边界严格遵守左闭右开相交，且 Z 与 .000Z 不产生伪相交。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testMillisecondHalfOpenBoundary(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00Z',
    endUtc: '2026-07-15T00:15:00Z',
    sourceReference: 'millisecond:left'
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    sourceReference: 'millisecond:center'
  });
  insertRecord({
    startUtc: '2026-07-15T00:30:00Z',
    endUtc: '2026-07-15T00:45:00Z',
    sourceReference: 'millisecond:right'
  });

  const exactAdjacent = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(exactAdjacent.recordCount, 1, 'Z 与 .000Z 相邻区间不得产生伪相交。');

  const leftOneMillisecondOverlap = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:14:59.999Z',
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(leftOneMillisecondOverlap.recordCount, 1, '查询左边界前移 1ms 应命中左侧记录。');
  assert.strictEqual(leftOneMillisecondOverlap.quality.partialBoundaryRecordCount, 1);

  const leftOneMillisecondGap = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:15:00.001Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(leftOneMillisecondGap.recordCount, 1, '结束于查询开始前 1ms 的左侧记录不得命中。');

  const rightOneMillisecondOverlap = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T00:30:00.001Z'
  }), { db });
  assert.strictEqual(rightOneMillisecondOverlap.recordCount, 1, '查询右边界后移 1ms 应命中右侧记录。');
  assert.strictEqual(rightOneMillisecondOverlap.quality.partialBoundaryRecordCount, 1);

  const rightOneMillisecondGap = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:29:59.999Z'
  }), { db });
  assert.strictEqual(rightOneMillisecondGap.recordCount, 1, '开始于查询结束后 1ms 的右侧记录不得命中。');
  assert.strictEqual(
    rightOneMillisecondGap.meta.overlapPredicate,
    'start_utc < endUtc AND end_utc > startUtc'
  );
}

/**
 * 验证停用表计不影响已有 active 历史事实读取。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testInactiveMeterHistory(db, ids) {
  db.prepare("UPDATE meter_devices SET status = 'inactive' WHERE id = ?").run(ids.primaryMeterId);
  try {
    const result = getEnergyLoadSummary(createInput({
      meterDeviceId: ids.primaryMeterId,
      startUtc: '2026-07-15T00:15:00.000Z',
      endUtc: '2026-07-15T00:30:00.000Z'
    }), { db });
    assert.strictEqual(result.scope.meterStatus, 'inactive');
    assert.strictEqual(result.recordCount, 1, '停用表计历史事实仍必须可读。');
  } finally {
    db.prepare("UPDATE meter_devices SET status = 'active' WHERE id = ?").run(ids.primaryMeterId);
  }
}

/**
 * 验证不存在主数据使用安全 badRequest，不泄露 SQL 或本地路径。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testMasterDataAndInjectionSafety(db, ids) {
  const missingEnergyError = assertBadRequestCode(
    () => getEnergyLoadSummary(createInput({
      meterDeviceId: ids.primaryMeterId,
      energyTypeCode: "electricity' OR 1=1 --"
    }), { db }),
    'ENERGY_LOAD_ENERGY_TYPE_NOT_FOUND'
  );
  assert.strictEqual(JSON.stringify(missingEnergyError.details).includes('SELECT '), false);
  assertBadRequestCode(
    () => getEnergyLoadSummary(createInput({ meterDeviceId: 999999999 }), { db }),
    'ENERGY_LOAD_METER_DEVICE_NOT_FOUND'
  );
  assertBadRequestCode(
    () => getEnergyLoadSummary(createInput({
      meterDeviceId: ids.primaryMeterId,
      sourceTimeZone: "Asia/Shanghai' OR 1=1 --"
    }), { db }),
    'INVALID_SOURCE_TIME_ZONE'
  );

  const exactUnitResult = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    unit: "kWh' OR 1=1 --"
  }), { db });
  assert.strictEqual(exactUnitResult.recordCount, 0, '单位参数必须作为绑定值精确匹配。');
  assert.strictEqual(exactUnitResult.metrics.observedEnergy, null);
}

/**
 * 验证无数据与覆盖不足分别返回正常质量结果而非异常。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testNoDataAndCoverageGap(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  db.prepare(
    `INSERT INTO energy_records (
       energy_type_id,
       organization_unit_id,
       meter_device_id,
       original_month,
       normalized_month,
       original_unit,
       original_value,
       normalized_unit,
       normalized_value,
       duplicate_key,
       record_status
     ) VALUES (?, ?, ?, '2026-07', '2026-07', 'kWh', 9999, 'kWh', 9999, 'load-summary-monthly-proof', 'active')`
  ).run(ids.electricityId, ids.organizationUnitId, ids.primaryMeterId);
  const noData = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }), { db });
  assert.strictEqual(noData.recordCount, 0);
  assert.strictEqual(noData.quality.status, 'no_data');
  assert.strictEqual(noData.quality.coverageRate, 0);
  assert.strictEqual(noData.quality.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
  assert.strictEqual(noData.quality.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
  assert.strictEqual(noData.metrics.observedEnergy, null);
  assert.strictEqual(noData.metrics.totalEnergy, null);
  assert.strictEqual(noData.metrics.averageLoad, null);
  assert.strictEqual(noData.peakInterval.energy, null);

  insertRecord({ normalizedValue: 10, originalValue: 10 });
  const partialCoverage = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }), { db });
  assert.strictEqual(partialCoverage.recordCount, 1);
  assert.strictEqual(partialCoverage.quality.status, 'coverage_below_threshold');
  assert.strictEqual(partialCoverage.quality.coverageRate, 0.25);
  assert.strictEqual(partialCoverage.quality.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
  assert.strictEqual(partialCoverage.metrics.observedEnergy, 10);
  assert.strictEqual(partialCoverage.metrics.observedEnergyPartial, true);
  assert.strictEqual(partialCoverage.metrics.totalEnergy, null);
  assert.strictEqual(partialCoverage.metrics.averageLoad, null);
  assert.strictEqual(partialCoverage.peakInterval.energy, null);
}

/**
 * 验证跨查询边界事实按重叠比例分配，且不得成为峰值候选。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testPartialBoundaryAllocation(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-14T23:45:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 60,
    originalValue: 60,
    sourceReference: 'max-load:partial-boundary'
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30,
    sourceReference: 'peak-energy:fully-inside'
  });

  const result = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.strictEqual(result.recordCount, 2);
  assert.strictEqual(result.quality.coverageRate, 1);
  assert.strictEqual(result.quality.partialBoundaryRecordCount, 1);
  assert.strictEqual(result.metrics.observedEnergy, 60);
  assert.strictEqual(result.metrics.observedEnergyPartial, true);
  assert.strictEqual(result.metrics.totalEnergy, 60);
  assert.strictEqual(result.metrics.averageLoad, 80);
  assert.strictEqual(result.metrics.maxLoad, 120);
  assert.strictEqual(result.maxLoadInterval.metricCode, 'max_load');
  assert.strictEqual(result.maxLoadInterval.averageLoad, result.metrics.maxLoad);
  assert.strictEqual(result.maxLoadInterval.startUtc, '2026-07-15T00:00:00.000Z');
  assert.strictEqual(result.maxLoadInterval.endUtc, '2026-07-15T00:15:00.000Z');
  assert.strictEqual(result.maxLoadInterval.overlapMinutes, 15);
  assert.strictEqual(result.maxLoadInterval.partialOverlap, true);
  assert.deepStrictEqual(result.maxLoadInterval.sourceInterval, {
    startUtc: '2026-07-14T23:45:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    durationMinutes: 30
  });
  assert.deepStrictEqual(result.maxLoadInterval.sourceEnergy, { value: 60, unit: 'kWh' });
  assert.strictEqual(result.maxLoadInterval.intervals.length, 1);
  assert.strictEqual(result.maxLoadInterval.evidence.length, 1);
  assert.strictEqual(result.peakInterval.metricCode, 'peak_interval_energy');
  assert.strictEqual(result.peakInterval.energy, 30);
  assert.strictEqual(result.peakInterval.averageLoad, 60);
  assert.notStrictEqual(
    result.maxLoadInterval.averageLoad,
    result.peakInterval.averageLoad,
    '边界高负荷源记录与完整粒度能量峰值允许且应可明确不同。'
  );
}

/**
 * 验证相同最大负荷证据按源区间和事实 ID 稳定排序。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testMaxLoadEvidenceOrdering(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  const firstId = insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    normalizedValue: 30,
    originalValue: 30
  });
  const secondId = insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    normalizedValue: 30,
    originalValue: 30
  });

  const result = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(result.metrics.maxLoad, 120);
  assert.strictEqual(result.maxLoadInterval.tiedIntervalCount, 2);
  assert.deepStrictEqual(result.maxLoadInterval.evidence, [
    `energy-timeseries:${firstId}`,
    `energy-timeseries:${secondId}`
  ]);
  assert.deepStrictEqual(
    result.maxLoadInterval.intervals.map((interval) => interval.startUtc),
    ['2026-07-15T00:00:00.000Z', '2026-07-15T00:15:00.000Z']
  );
}

/**
 * 验证混合粒度与来源重叠使用不同稳定原因码。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testMixedGranularityAndOverlap(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    normalizedValue: 10,
    originalValue: 10
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 20,
    originalValue: 20
  });
  const mixed = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.strictEqual(mixed.granularityMinutes, null);
  assert.strictEqual(mixed.quality.status, 'mixed_interval_granularity');
  assert.strictEqual(mixed.quality.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), true);
  assert.strictEqual(mixed.metrics.observedEnergy, null);
  assert.strictEqual(mixed.metrics.totalEnergy, null);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const overlap = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.strictEqual(overlap.quality.status, 'overlap_or_duplicate');
  assert.strictEqual(overlap.quality.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
  assert.strictEqual(overlap.metrics.observedEnergy, null);
  assert.strictEqual(overlap.metrics.averageLoad, null);
}

/**
 * 验证单位/表计能源范围不兼容时正常返回不可比质量结果。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testUnitNotComparable(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertQuarterHourSeries(insertRecord, [1, 1, 1, 1], {
    energyTypeId: ids.naturalGasId,
    normalizedUnit: 'm3',
    originalUnit: 'm3'
  });
  const result = getEnergyLoadSummary(createInput({
    meterDeviceId: ids.primaryMeterId,
    energyTypeCode: 'natural_gas',
    unit: 'm3'
  }), { db });
  assert.strictEqual(result.recordCount, 4, '精确历史事实仍需读取用于质量判断。');
  assert.strictEqual(result.scope.comparable, false);
  assert.strictEqual(result.quality.status, 'unit_not_comparable');
  assert.deepStrictEqual(result.quality.reasonCodes, ['UNIT_NOT_COMPARABLE']);
  assert.strictEqual(result.metrics.observedEnergy, null);
  assert.strictEqual(result.metrics.totalEnergy, null);
  assert.strictEqual(result.metrics.averageLoad, null);
  assert.strictEqual(result.peakInterval.energy, null);
}

/**
 * 验证真实零值不被 null 或缺数状态覆盖。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTrueZero(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertQuarterHourSeries(insertRecord, [0, 0, 0, 0]);
  const result = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }), { db });
  assert.strictEqual(result.quality.status, 'sufficient');
  assert.strictEqual(result.quality.sufficient, true);
  assert.strictEqual(result.quality.coverageRate, 1);
  assert.deepStrictEqual(result.quality.reasonCodes, []);
  assert.strictEqual(result.scope.comparable, true);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.totalEnergy, 0);
  assert.strictEqual(result.metrics.averageLoad, 0);
  assert.strictEqual(result.metrics.maxLoad, 0);
  assert.strictEqual(result.metrics.loadRate, null, '零最大负荷下比率不可计算，但真实负荷零必须保留。');
  assert.strictEqual(result.metrics.loadRatePercent, null);
  assert.strictEqual(result.metrics.loadRateCalculable, false);
  assert.strictEqual(result.metrics.loadRateReason, 'ZERO_MAX_LOAD');
  assert.strictEqual(result.maxLoadInterval.averageLoad, 0);
  assert.strictEqual(result.maxLoadInterval.sourceEnergy.value, 0);
  assert.strictEqual(result.peakInterval.energy, 0);
  assert.strictEqual(result.peakInterval.averageLoad, 0);
}

/**
 * 验证固定 UTC 曲线的聚合、分配、缺失、零值、混合粒度与重叠语义。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testEnergyLoadCurveContract(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertQuarterHourSeries(insertRecord, [10, 20, 0, 30]);
  const fifteenMinuteCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(fifteenMinuteCurve.contractVersion, 'energy-analysis-contract:v1');
  assert.strictEqual(fifteenMinuteCurve.formulaVersion, ENERGY_LOAD_CURVE_FORMULA_VERSION);
  assert.strictEqual(fifteenMinuteCurve.dataRange.gridAlignment, 'utc_epoch');
  assert.strictEqual(fifteenMinuteCurve.dataRange.bucketCount, 4);
  assert.deepStrictEqual(fifteenMinuteCurve.buckets.map((bucket) => bucket.energy), [10, 20, 0, 30]);
  assert.deepStrictEqual(
    fifteenMinuteCurve.buckets.map((bucket) => bucket.observationMode),
    ['observed', 'observed', 'observed', 'observed']
  );
  assert.deepStrictEqual(fifteenMinuteCurve.buckets.map((bucket) => bucket.bucketIndex), [0, 1, 2, 3]);
  assert.strictEqual(fifteenMinuteCurve.metrics.observedEnergy, 60);
  assert.strictEqual(fifteenMinuteCurve.metrics.totalEnergy, 60);
  assert.strictEqual(fifteenMinuteCurve.metrics.conservationDifference, 0);
  assert.strictEqual(fifteenMinuteCurve.quality.status, 'sufficient');
  assert.deepStrictEqual(fifteenMinuteCurve.quality.reasonCodes, []);
  assert.deepStrictEqual(fifteenMinuteCurve.localHeatmap.map((bucket) => bucket.bucketIndex), [0, 1, 2, 3]);
  assert.deepStrictEqual(fifteenMinuteCurve.localHeatmap.map((bucket) => bucket.energy), [10, 20, 0, 30]);

  const thirtyMinuteCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    outputIntervalMinutes: 30
  }), { db });
  assert.deepStrictEqual(thirtyMinuteCurve.buckets.map((bucket) => bucket.energy), [30, 30]);
  assert.deepStrictEqual(
    thirtyMinuteCurve.buckets.map((bucket) => bucket.observationMode),
    ['aggregated', 'aggregated']
  );
  assert.strictEqual(thirtyMinuteCurve.quality.allocationUsed, false);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z',
    granularityMinutes: 60,
    normalizedValue: 60,
    originalValue: 60
  });
  const allocatedCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.deepStrictEqual(allocatedCurve.buckets.map((bucket) => bucket.energy), [15, 15, 15, 15]);
  assert.deepStrictEqual(
    allocatedCurve.buckets.map((bucket) => bucket.observationMode),
    ['allocated', 'allocated', 'allocated', 'allocated']
  );
  assert.strictEqual(allocatedCurve.quality.allocationUsed, true);
  allocatedCurve.buckets.forEach((bucket) => {
    assert.strictEqual(bucket.allocationAssumption, 'uniform_within_interval');
  });

  clearTimeseriesRecords(db);
  const noDataCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.deepStrictEqual(noDataCurve.buckets.map((bucket) => bucket.energy), [null, null]);
  assert.strictEqual(noDataCurve.metrics.observedEnergy, null);
  assert.strictEqual(noDataCurve.metrics.totalEnergy, null);
  assert.strictEqual(noDataCurve.quality.status, 'no_data');
  assert.deepStrictEqual(noDataCurve.quality.reasonCodes, ['NO_TIMESERIES_DATA']);

  insertRecord({ normalizedValue: 10, originalValue: 10 });
  const partialCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.deepStrictEqual(partialCurve.buckets.map((bucket) => bucket.energy), [10, null]);
  assert.strictEqual(partialCurve.metrics.observedEnergy, 10);
  assert.strictEqual(partialCurve.metrics.totalEnergy, null);
  assert.strictEqual(partialCurve.quality.status, 'coverage_below_threshold');
  assert.deepStrictEqual(partialCurve.quality.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);

  clearTimeseriesRecords(db);
  insertQuarterHourSeries(insertRecord, [0, 0], {});
  const zeroCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.deepStrictEqual(zeroCurve.buckets.map((bucket) => bucket.energy), [0, 0]);
  assert.deepStrictEqual(zeroCurve.buckets.map((bucket) => bucket.averageLoad), [0, 0]);
  assert.strictEqual(zeroCurve.metrics.observedEnergy, 0);
  assert.strictEqual(zeroCurve.metrics.totalEnergy, 0);
  assert.deepStrictEqual(zeroCurve.quality.reasonCodes, []);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-14T23:55:00.000Z',
    endUtc: '2026-07-15T00:25:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const crossBoundaryCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.energy), [15, 10]);
  assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.coveredMinutes), [15, 10]);
  assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.averageLoad), [60, 60]);
  assert.strictEqual(crossBoundaryCurve.metrics.observedEnergy, 25);
  assert.strictEqual(crossBoundaryCurve.metrics.totalEnergy, null);
  assert.strictEqual(crossBoundaryCurve.metrics.conservationDifference, 0);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    normalizedValue: 15,
    originalValue: 15
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const mixedCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.deepStrictEqual(mixedCurve.buckets.map((bucket) => bucket.energy), [15, 15, 15]);
  assert.strictEqual(mixedCurve.quality.mixedSourceGranularity, true);
  assert.deepStrictEqual(mixedCurve.quality.sourceGranularityMinutes, [15, 30]);
  assert.strictEqual(mixedCurve.quality.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), false);
  assert.deepStrictEqual(mixedCurve.quality.reasonCodes, []);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const overlapCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.deepStrictEqual(overlapCurve.buckets.map((bucket) => bucket.energy), [null, null, null]);
  assert.strictEqual(overlapCurve.metrics.observedEnergy, null);
  assert.strictEqual(overlapCurve.quality.status, 'overlap_or_duplicate');
  assert.deepStrictEqual(overlapCurve.quality.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);

  // 31 天错开一分钟的 60 分钟来源不得把全局舍入残差写入末尾真实零桶。
  clearTimeseriesRecords(db);
  const longCurveStartMs = Date.parse('2026-01-01T00:00:00.000Z');
  for (let index = 0; index < 745; index += 1) {
    const recordStartMs = longCurveStartMs - 59 * 60 * 1000 + index * 60 * 60 * 1000;
    insertRecord({
      startUtc: new Date(recordStartMs).toISOString(),
      endUtc: new Date(recordStartMs + 60 * 60 * 1000).toISOString(),
      granularityMinutes: 60,
      normalizedValue: index === 744 ? 0 : 37,
      originalValue: index === 744 ? 0 : 37
    });
  }
  const longRoundingCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-01-01T00:00:00.000Z',
    endUtc: '2026-02-01T00:00:00.000Z'
  }), { db });
  assert.strictEqual(longRoundingCurve.buckets.length, 31 * 24 * 4);
  assert.strictEqual(longRoundingCurve.buckets[longRoundingCurve.buckets.length - 1].energy, 0);
  longRoundingCurve.buckets.forEach((bucket) => {
    assert.strictEqual(bucket.energy === null || bucket.energy >= 0, true);
    assert.strictEqual(bucket.averageLoad === null || bucket.averageLoad >= 0, true);
  });
  assertClose(longRoundingCurve.metrics.roundedBucketTotal, longRoundingCurve.buckets.reduce(
    (sum, bucket) => sum + (bucket.energy === null ? 0 : bucket.energy),
    0
  ), 1e-12);
  assert.strictEqual(
    longRoundingCurve.metrics.conservationDifference,
    longRoundingCurve.metrics.observedEnergy - longRoundingCurve.metrics.roundedBucketTotal
  );
  assertClose(longRoundingCurve.metrics.conservationDifference, 0, 1e-9);

  // 精确微量 observed 桶与 2972 个 allocated 微量桶必须分别舍入，不做全局残差搬移。
  clearTimeseriesRecords(db);
  const microCurveStartMs = Date.parse('2026-01-01T00:00:00.000Z');
  insertRecord({
    startUtc: new Date(microCurveStartMs).toISOString(),
    endUtc: new Date(microCurveStartMs + 15 * 60 * 1000).toISOString(),
    granularityMinutes: 15,
    normalizedValue: 1e-12,
    originalValue: 1e-12
  });
  for (let index = 0; index < 743; index += 1) {
    const recordStartMs = microCurveStartMs + 15 * 60 * 1000 + index * 60 * 60 * 1000;
    insertRecord({
      startUtc: new Date(recordStartMs).toISOString(),
      endUtc: new Date(recordStartMs + 60 * 60 * 1000).toISOString(),
      granularityMinutes: 60,
      normalizedValue: 1e-12,
      originalValue: 1e-12
    });
  }
  const microCurveEndMs = microCurveStartMs + (15 + 743 * 60) * 60 * 1000;
  const microRoundingCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: new Date(microCurveStartMs).toISOString(),
    endUtc: new Date(microCurveEndMs).toISOString()
  }), { db });
  assert.strictEqual(microRoundingCurve.buckets.length, 1 + 2972);
  assert.strictEqual(microRoundingCurve.buckets[0].energy, 1e-12);
  assert.strictEqual(microRoundingCurve.buckets.slice(1).every((bucket) => (
    bucket.observationMode === 'allocated' && bucket.energy === 0
  )), true);
  assert.strictEqual(microRoundingCurve.metrics.observedEnergy, 7.44e-10);
  assert.strictEqual(microRoundingCurve.metrics.roundedBucketTotal, 1e-12);
  assert.strictEqual(microRoundingCurve.metrics.conservationDifference, 7.43e-10);
  assert.strictEqual(
    microRoundingCurve.metrics.conservationDifference,
    microRoundingCurve.metrics.observedEnergy - microRoundingCurve.metrics.roundedBucketTotal
  );
}

/**
 * 验证 New York DST、Kathmandu、Etc/GMT 与历史秒级 offset 本地热力投影。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条时序事实写入函数。
 */
function testEnergyLoadCurveLocalHeatmap(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  const springCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-03-08T06:00:00.000Z',
    endUtc: '2026-03-08T08:00:00.000Z',
    sourceTimeZone: 'America/New_York',
    outputIntervalMinutes: 30
  }), { db });
  assert.deepStrictEqual(
    springCurve.localHeatmap.map((bucket) => bucket.localTime),
    ['01:00', '01:30', '03:00', '03:30']
  );
  assert.strictEqual(springCurve.localHeatmap.some((bucket) => bucket.localTime.startsWith('02:')), false);

  const fallCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T07:00:00.000Z',
    sourceTimeZone: 'America/New_York',
    outputIntervalMinutes: 30
  }), { db });
  assert.deepStrictEqual(
    fallCurve.localHeatmap.map((bucket) => bucket.localTime),
    ['01:00', '01:30', '01:00', '01:30']
  );
  assert.deepStrictEqual(
    fallCurve.localHeatmap.map((bucket) => bucket.utcOffset),
    ['-04:00', '-04:00', '-05:00', '-05:00']
  );
  assert.deepStrictEqual(fallCurve.localHeatmap.map((bucket) => bucket.fold), [0, 0, 1, 1]);
  assert.strictEqual(new Set(fallCurve.localHeatmap.map((bucket) => bucket.key)).size, 4);

  const firstFoldOnlyCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T05:30:00.000Z',
    sourceTimeZone: 'America/New_York',
    outputIntervalMinutes: 30
  }), { db });
  const secondFoldOnlyCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-11-01T06:00:00.000Z',
    endUtc: '2026-11-01T06:30:00.000Z',
    sourceTimeZone: 'America/New_York',
    outputIntervalMinutes: 30
  }), { db });
  assert.strictEqual(firstFoldOnlyCurve.localHeatmap[0].fold, 0);
  assert.strictEqual(secondFoldOnlyCurve.localHeatmap[0].fold, 1);
  assert.strictEqual(firstFoldOnlyCurve.localHeatmap[0].key, fallCurve.localHeatmap[0].key);
  assert.strictEqual(secondFoldOnlyCurve.localHeatmap[0].key, fallCurve.localHeatmap[2].key);

  const kathmanduCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Asia/Kathmandu'
  }), { db });
  assert.strictEqual(kathmanduCurve.localHeatmap[0].localTime, '05:45');
  assert.strictEqual(kathmanduCurve.localHeatmap[0].utcOffset, '+05:45');

  const emptyGmtCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT'
  }), { db });
  assert.strictEqual(emptyGmtCurve.recordCount, 0);
  assert.strictEqual(emptyGmtCurve.localHeatmap[0].localTime, '00:00');
  assert.strictEqual(emptyGmtCurve.localHeatmap[0].utcOffset, '+00:00');
  const earlyYearCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '0001-01-01T00:00:00.000Z',
    endUtc: '0001-01-01T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT'
  }), { db });
  assert.strictEqual(earlyYearCurve.recordCount, 0);
  assert.strictEqual(earlyYearCurve.localHeatmap.length, 1);
  assert.strictEqual(earlyYearCurve.localHeatmap[0].localDate, '0001-01-01');
  insertRecord({
    sourceTimeZone: 'Etc/GMT',
    normalizedValue: 12,
    originalValue: 12
  });
  const populatedGmtCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT'
  }), { db });
  assert.strictEqual(populatedGmtCurve.recordCount, 1);
  assert.strictEqual(populatedGmtCurve.buckets[0].energy, 12);
  assert.strictEqual(populatedGmtCurve.localHeatmap[0].utcOffset, '+00:00');

  const historicalParisCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '1900-01-01T00:00:00.000Z',
    endUtc: '1900-01-01T00:15:00.000Z',
    sourceTimeZone: 'Europe/Paris'
  }), { db });
  assert.strictEqual(historicalParisCurve.localHeatmap.length, 1);
  assert.strictEqual(historicalParisCurve.localHeatmap[0].localSecond, '21');
  assert.strictEqual(historicalParisCurve.localHeatmap[0].utcOffset, '+00:09:21');
  assert.strictEqual(historicalParisCurve.localHeatmap[0].utcOffsetSeconds, 9 * 60 + 21);

  const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  try {
    assertLocalTimeProjectionFailure(() => getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      startUtc: '2026-07-15T01:00:00.000Z',
      endUtc: '2026-07-15T01:15:00.000Z',
      sourceTimeZone: SOURCE_TIME_ZONE
    }), {
      db,
      testOnlyAfterLoadCurveQuery() {
        Intl.DateTimeFormat.prototype.formatToParts = () => [{
          type: 'timeZoneName',
          value: 'UNEXPECTED_OFFSET'
        }];
      }
    }));
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
  }
  assert.strictEqual(db.inTransaction, false, '本地时间投影失败必须回滚服务自建读取事务。');

  db.exec('BEGIN DEFERRED');
  const callerTransactionFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  try {
    assertLocalTimeProjectionFailure(() => getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      startUtc: '2026-07-15T01:00:00.000Z',
      endUtc: '2026-07-15T01:15:00.000Z',
      sourceTimeZone: SOURCE_TIME_ZONE
    }), {
      db,
      testOnlyAfterLoadCurveQuery() {
        Intl.DateTimeFormat.prototype.formatToParts = () => [{
          type: 'timeZoneName',
          value: 'UNEXPECTED_CALLER_TRANSACTION_OFFSET'
        }];
      }
    }));
    assert.strictEqual(
      db.inTransaction,
      true,
      '投影失败时服务不得提交或回滚调用方已有事务。'
    );
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = callerTransactionFormatToParts;
    if (db.inTransaction) db.exec('ROLLBACK');
  }
}

/**
 * 验证固定 UTC 曲线数值非有限时抛出脱敏五百错误。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testEnergyLoadCurveNumericOverflow(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    normalizedValue: 1e308,
    originalValue: 1e308
  });
  assertAnalysisNumericOverflow(() => getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db }));
  assert.strictEqual(db.inTransaction, false, '曲线数值溢出必须回滚服务自建读取事务。');
}

/**
 * 验证曲线读取快照、错误回滚及调用方事务所有权。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testEnergyLoadCurveTransactionSnapshot(db, ids, insertRecord) {
  clearTimeseriesRecords(db);
  insertRecord({ normalizedValue: 10, originalValue: 10 });
  db.pragma('journal_mode = WAL');
  const competingConnection = database.openDatabase();
  const insertCompetingRecord = createTimeseriesInserter(competingConnection, ids);
  try {
    let competingWriteSucceeded = false;
    const snapshotResult = getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), {
      db,
      testOnlyAfterLoadCurveScope: () => {
        insertCompetingRecord({
          startUtc: '2026-07-15T00:15:00.000Z',
          endUtc: '2026-07-15T00:30:00.000Z',
          normalizedValue: 20,
          originalValue: 20
        });
        competingWriteSucceeded = true;
      }
    });
    assert.strictEqual(competingWriteSucceeded, true);
    assert.strictEqual(snapshotResult.recordCount, 1);
    assert.deepStrictEqual(snapshotResult.buckets.map((bucket) => bucket.energy), [10, null]);
    assert.strictEqual(db.inTransaction, false, '服务自建曲线读取事务必须提交。');

    const freshResult = getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), { db });
    assert.strictEqual(freshResult.recordCount, 2);
    assert.deepStrictEqual(freshResult.buckets.map((bucket) => bucket.energy), [10, 20]);
  } finally {
    competingConnection.close();
  }

  assert.throws(
    () => getEnergyLoadCurve(createCurveInput({ meterDeviceId: ids.primaryMeterId }), {
      db,
      testOnlyAfterLoadCurveQuery: () => {
        throw new Error('controlled load curve snapshot failure');
      }
    }),
    /controlled load curve snapshot failure/
  );
  assert.strictEqual(db.inTransaction, false, '曲线错误路径必须回滚自建事务。');

  db.exec('BEGIN DEFERRED');
  try {
    const callerTransactionResult = getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), { db });
    assert.strictEqual(callerTransactionResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
    assert.throws(
      () => getEnergyLoadCurve(createCurveInput({ meterDeviceId: ids.primaryMeterId }), {
        db,
        testOnlyAfterLoadCurveQuery: () => {
          throw new Error('caller owns load curve transaction');
        }
      }),
      /caller owns load curve transaction/
    );
    assert.strictEqual(db.inTransaction, true, '服务不得回滚调用方已有曲线事务。');
  } finally {
    db.exec('ROLLBACK');
  }
}

/**
 * 验证曲线服务的调用方连接和自有连接关闭边界。
 * @param {object} db 调用方 SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testEnergyLoadCurveDatabaseOwnership(db, ids) {
  const callerResult = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(callerResult.meta.callerDatabaseConnection, true);
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1);

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
    const ownedResult = getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true, '曲线服务自有连接必须在返回前关闭。');

    ownedConnectionClosed = false;
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    try {
      assertLocalTimeProjectionFailure(() => getEnergyLoadCurve(createCurveInput({
        meterDeviceId: ids.primaryMeterId,
        startUtc: '2026-07-15T01:00:00.000Z',
        endUtc: '2026-07-15T01:15:00.000Z',
        sourceTimeZone: SOURCE_TIME_ZONE
      }), {
        testOnlyAfterLoadCurveQuery() {
          Intl.DateTimeFormat.prototype.formatToParts = () => [{
            type: 'timeZoneName',
            value: 'UNEXPECTED_OWNED_CONNECTION_OFFSET'
          }];
        }
      }));
    } finally {
      Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
    }
    assert.strictEqual(
      ownedConnectionClosed,
      true,
      '本地时间投影失败时曲线服务自有连接仍必须在 finally 中关闭。'
    );
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}

/**
 * 验证 50001 条命中记录通过 LIMIT 50001 拒绝而非截断。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testRecordLimit(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  const touSchemeId = seedTimeOfUseScheme(db);
  const insertMany = db.transaction(() => {
    for (let index = 0; index < TIMESERIES_QUERY_LIMIT; index += 1) {
      insertRecord({
        startUtc: '2026-07-15T00:00:00.000Z',
        endUtc: '2026-07-15T00:15:00.000Z',
        granularityMinutes: 15,
        normalizedValue: 1,
        originalValue: 1,
        sourceReference: `limit:${index}`
      });
    }
  });
  insertMany();
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total,
    TIMESERIES_QUERY_LIMIT
  );
  assertBadRequestCode(
    () => getEnergyLoadSummary(createInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED'
  );
  assertBadRequestCode(
    () => getEnergyLoadCurve(createCurveInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED'
  );
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED'
  );
  assertBadRequestCode(
    () => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED'
  );
  assertBadRequestCode(
    () => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED'
  );

  db.prepare(
    'DELETE FROM energy_timeseries_records WHERE id = (SELECT MAX(id) FROM energy_timeseries_records)'
  ).run();
  const exactLimitCurve = getEnergyLoadCurve(createCurveInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactLimitCurve.recordCount, MAX_TIMESERIES_RECORDS);
  assert.deepStrictEqual(exactLimitCurve.quality.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
  const exactLimitTimeOfUse = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactLimitTimeOfUse.recordCount, MAX_TIMESERIES_RECORDS);
  assert.deepStrictEqual(
    exactLimitTimeOfUse.quality.reasonCodes,
    ['SOURCE_OVERLAP_OR_DUPLICATE']
  );
  const exactLimitShift = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactLimitShift.recordCount, MAX_TIMESERIES_RECORDS);
  assert.deepStrictEqual(
    exactLimitShift.quality.reasonCodes,
    ['SOURCE_OVERLAP_OR_DUPLICATE', 'MISSING_SHIFT_SCHEDULE']
  );
  const exactLimitDeviceState = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactLimitDeviceState.recordCount, MAX_TIMESERIES_RECORDS);
  assert.strictEqual(exactLimitDeviceState.quality.status, 'overlap_or_duplicate');
  assert.deepStrictEqual(
    exactLimitDeviceState.quality.reasonCodes,
    ['DEVICE_STATE_GAP', 'SOURCE_OVERLAP_OR_DUPLICATE']
  );
}

/**
 * 验证调用方连接不关闭，服务自开连接在 finally 中关闭。
 * @param {object} db 调用方 SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testDatabaseOwnership(db, ids) {
  clearTimeseriesRecords(db);
  const callerResult = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }), { db });
  assert.strictEqual(callerResult.meta.callerDatabaseConnection, true);
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1, '调用方连接不得由服务关闭。');

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
    const ownedResult = getEnergyLoadSummary(createInput({ meterDeviceId: ids.primaryMeterId }));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true, '服务自开连接必须在返回前关闭。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}


/**
 * 验证峰平谷输入严格标量、显式方案 ID、1/31 天边界和固定覆盖阈值。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testTimeOfUseInputValidation(db, ids) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const schemeId = seedTimeOfUseScheme(db);
  assert.strictEqual(
    TIME_OF_USE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
    'time-of-use-consumption-analysis:v1'
  );
  const oneDay = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    startUtc: '2026-07-01T00:00:00.000Z',
    endUtc: '2026-07-02T00:00:00.000Z'
  }), { db });
  assert.strictEqual(oneDay.dataRange.durationMinutes, 24 * 60);
  const thirtyOneDays = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: String(schemeId),
    startUtc: '2026-07-01T00:00:00.000Z',
    endUtc: '2026-08-01T00:00:00.000Z'
  }), { db });
  assert.strictEqual(thirtyOneDays.dataRange.durationMinutes, 31 * 24 * 60);
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      startUtc: '2026-07-01T00:00:00.000Z',
      endUtc: '2026-08-01T00:00:00.001Z'
    }), { db }),
    'ENERGY_LOAD_TIME_RANGE_EXCEEDED'
  );
  [undefined, 0, -1, '1 OR 1=1', [schemeId], { id: schemeId }].forEach((touSchemeId) => {
    assertBadRequestCode(
      () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
        meterDeviceId: ids.primaryMeterId,
        touSchemeId
      }), { db }),
      'INVALID_TOU_SCHEME_ID'
    );
  });
  [
    ['meterDeviceId', [ids.primaryMeterId], 'INVALID_METER_DEVICE_ID'],
    ['energyTypeCode', ['electricity'], 'INVALID_ENERGY_TYPE_CODE'],
    ['unit', { value: 'kWh' }, 'INVALID_ENERGY_UNIT'],
    ['startUtc', ['2026-07-15T00:00:00.000Z'], 'INVALID_START_UTC'],
    ['endUtc', { value: '2026-07-15T01:00:00.000Z' }, 'INVALID_END_UTC'],
    ['sourceTimeZone', [SOURCE_TIME_ZONE], 'INVALID_SOURCE_TIME_ZONE']
  ].forEach(([fieldName, value, code]) => {
    assertBadRequestCode(
      () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
        meterDeviceId: ids.primaryMeterId,
        touSchemeId: schemeId,
        [fieldName]: value
      }), { db }),
      code
    );
  });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      minimumCoverageRate: 1
    }), { db }),
    'TIME_OF_USE_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED'
  );
}

/**
 * 验证峰平谷方案不存在、停用、时区、有效期、空规则、缺口、重叠和显式选择边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTimeOfUseSchemeAndRuleValidation(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: 999999999
    }), { db }),
    'TOU_SCHEME_NOT_FOUND'
  );

  const inactiveSchemeId = seedTimeOfUseScheme(db, { status: 'inactive' });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: inactiveSchemeId
    }), { db }),
    'TOU_SCHEME_INACTIVE'
  );
  const mismatchedTimeZoneSchemeId = seedTimeOfUseScheme(db, { sourceTimeZone: 'Asia/Tokyo' });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: mismatchedTimeZoneSchemeId
    }), { db }),
    'TOU_SCHEME_TIME_ZONE_MISMATCH'
  );

  const effectiveSchemeId = seedTimeOfUseScheme(db, {
    effectiveStartUtc: '2026-07-15T00:00:00.000Z',
    effectiveEndUtc: '2026-07-15T01:00:00.000Z'
  });
  const exactEffectiveRange = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: effectiveSchemeId
  }), { db });
  assert.deepStrictEqual(exactEffectiveRange.scheme.adoptedRange, {
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  [
    ['2026-07-14T23:59:59.999Z', '2026-07-15T01:00:00.000Z'],
    ['2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.001Z']
  ].forEach(([startUtc, endUtc]) => {
    assertBadRequestCode(
      () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
        meterDeviceId: ids.primaryMeterId,
        touSchemeId: effectiveSchemeId,
        startUtc,
        endUtc
      }), { db }),
      'TOU_SCHEME_NOT_EFFECTIVE_FOR_RANGE'
    );
  });

  const emptyRuleSchemeId = seedTimeOfUseScheme(db, { rules: [] });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: emptyRuleSchemeId
    }), { db }),
    'TOU_RULE_SET_EMPTY'
  );
  const gapRuleSchemeId = seedTimeOfUseScheme(db, {
    rules: [
      { dayOfWeek: 3, periodType: 'peak', startMinute: 0, endMinute: 400 },
      { dayOfWeek: 3, periodType: 'flat', startMinute: 500, endMinute: 1000 },
      { dayOfWeek: 3, periodType: 'valley', startMinute: 1000, endMinute: 1440 }
    ]
  });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: gapRuleSchemeId
    }), { db }),
    'TOU_RULE_SET_INVALID'
  );
  const overlapRuleSchemeId = seedTimeOfUseScheme(db, {
    rules: [
      { dayOfWeek: 3, periodType: 'peak', startMinute: 0, endMinute: 800 },
      { dayOfWeek: 3, periodType: 'flat', startMinute: 700, endMinute: 1000 },
      { dayOfWeek: 3, periodType: 'valley', startMinute: 1000, endMinute: 1440 }
    ]
  });
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: overlapRuleSchemeId
    }), { db }),
    'TOU_RULE_SET_INVALID'
  );

  clearTimeseriesRecords(db);
  insertRecord({ normalizedValue: 10, originalValue: 10 });
  const explicitPeakSchemeId = seedTimeOfUseScheme(db, {
    rules: Array.from({ length: 7 }, (_value, index) => ({
      dayOfWeek: index + 1,
      periodType: 'peak',
      startMinute: 0,
      endMinute: 1440
    }))
  });
  seedTimeOfUseScheme(db, {
    rules: Array.from({ length: 7 }, (_value, index) => ({
      dayOfWeek: index + 1,
      periodType: 'valley',
      startMinute: 0,
      endMinute: 1440
    }))
  });
  const explicitResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: explicitPeakSchemeId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(explicitResult.scheme.id, explicitPeakSchemeId);
  assert.strictEqual(getTimeOfUsePeriod(explicitResult, 'peak').observed, 10);
  assert.strictEqual(getTimeOfUsePeriod(explicitResult, 'valley').observed, 0);
  assert.deepStrictEqual(explicitResult.quality.reasonCodes, []);
}

/**
 * 验证峰平谷跨规则边界比例、mixed 守恒、重叠、部分覆盖、无数据和真实零值语义。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTimeOfUseAnalysisContract(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const boundaryRules = Array.from({ length: 7 }, (_value, index) => [
    { dayOfWeek: index + 1, periodType: 'peak', startMinute: 0, endMinute: 10 },
    { dayOfWeek: index + 1, periodType: 'flat', startMinute: 10, endMinute: 20 },
    { dayOfWeek: index + 1, periodType: 'valley', startMinute: 20, endMinute: 1440 }
  ]).flat();
  const schemeId = seedTimeOfUseScheme(db, {
    sourceTimeZone: 'Etc/GMT',
    rules: boundaryRules
  });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 30,
    normalizedValue: 999,
    originalValue: 999,
    recordStatus: 'void'
  });
  const changesBeforeRead = db.prepare('SELECT total_changes() AS value').get().value;
  const boundaryResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  const changesAfterRead = db.prepare('SELECT total_changes() AS value').get().value;
  assert.strictEqual(changesAfterRead, changesBeforeRead, '峰平谷服务不得写入任何运行或业务记录。');
  assert.strictEqual(boundaryResult.contractVersion, 'energy-analysis-contract:v1');
  assert.strictEqual(boundaryResult.formulaVersion, TIME_OF_USE_CONSUMPTION_ANALYSIS_FORMULA_VERSION);
  assert.strictEqual(boundaryResult.scope.meterDeviceId, ids.primaryMeterId);
  assert.strictEqual(boundaryResult.scope.comparable, true);
  assert.strictEqual(boundaryResult.dataRange.intervalConvention, '[startUtc,endUtc)');
  assert.strictEqual(boundaryResult.scheme.id, schemeId);
  assert.strictEqual(boundaryResult.scheme.ruleRecordCount, 21);
  assert.deepStrictEqual(boundaryResult.applicability, {
    selectionMode: 'explicit_tou_scheme_id',
    meterBindingVerified: false,
    authoritativeTariffConfirmed: false
  });
  assert.strictEqual(boundaryResult.recordCount, 1, '只允许 active 时序事实参与分析。');
  assert.deepStrictEqual(boundaryResult.periods.map((period) => period.type), [
    'peak',
    'flat',
    'valley'
  ]);
  boundaryResult.periods.forEach((period) => {
    assert.strictEqual(period.observed, 10);
    assert.strictEqual(period.complete, 10);
    assertClose(period.share, 1 / 3);
    assert.strictEqual(period.energyUnit, 'kWh');
  });
  assert.strictEqual(boundaryResult.quality.status, 'sufficient');
  assert.strictEqual(boundaryResult.quality.coverageRate, 1);
  assert.strictEqual(boundaryResult.quality.minimumCoverageRate, 1);
  assert.deepStrictEqual(boundaryResult.quality.reasonCodes, []);
  assert.deepStrictEqual(boundaryResult.metrics, {
    observedEnergy: 30,
    roundedToZero: false,
    observedEnergyPartial: false,
    totalEnergy: 30,
    totalEnergyComplete: true,
    conservationDifference: 0,
    energyUnit: 'kWh'
  });
  assert.strictEqual(boundaryResult.meta.allocationAssumption, 'uniform_within_interval');
  assert.strictEqual(boundaryResult.meta.maximumTimeseriesRecords, 50000);
  assert.strictEqual(boundaryResult.meta.timeseriesQueryLimit, 50001);
  assert.strictEqual(boundaryResult.meta.maximumRuleRecords, 50000);
  assert.strictEqual(boundaryResult.meta.ruleQueryLimit, 50001);
  assert.strictEqual(boundaryResult.meta.readOnly, true);
  assert.strictEqual(boundaryResult.meta.usesAI, false);
  assert.strictEqual(boundaryResult.meta.issuesControlCommand, false);
  assert.strictEqual(boundaryResult.meta.changesDeviceState, false);
  assert.strictEqual(boundaryResult.meta.writesAnalysisRunRecord, false);
  assert.strictEqual(boundaryResult.meta.automaticSchemeBinding, false);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 15,
    normalizedValue: 15,
    originalValue: 15
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const mixedResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.deepStrictEqual(mixedResult.quality.sourceGranularityMinutes, [15, 30]);
  assert.strictEqual(mixedResult.quality.mixedSourceGranularity, true);
  assert.strictEqual(mixedResult.quality.allocationUsed, true);
  assert.deepStrictEqual(mixedResult.quality.reasonCodes, []);
  assert.strictEqual(mixedResult.metrics.observedEnergy, 45);
  assert.strictEqual(mixedResult.metrics.totalEnergy, 45);
  assert.strictEqual(mixedResult.metrics.conservationDifference, 0);
  assert.deepStrictEqual(mixedResult.periods.map((period) => period.observed), [10, 10, 25]);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 30,
    normalizedValue: 30,
    originalValue: 30
  });
  const overlapResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.strictEqual(overlapResult.quality.status, 'overlap_or_duplicate');
  assert.deepStrictEqual(overlapResult.quality.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
  assert.strictEqual(overlapResult.quality.coveredMinutes, 45);
  assert.strictEqual(overlapResult.metrics.observedEnergy, null);
  assert.deepStrictEqual(
    overlapResult.periods.map((period) => period.coveredMinutes),
    [10, 10, 25]
  );
  assert.strictEqual(
    overlapResult.periods.reduce((sum, period) => sum + period.coveredMinutes, 0),
    overlapResult.quality.coveredMinutes
  );
  overlapResult.periods.forEach((period) => {
    assert.strictEqual(period.observed, null);
    assert.strictEqual(period.complete, null);
    assert.strictEqual(period.roundedToZero, null);
    assert.strictEqual(period.share, null);
  });

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 15,
    normalizedValue: 15,
    originalValue: 15
  });
  const partialResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(partialResult.quality.status, 'coverage_below_threshold');
  assert.strictEqual(partialResult.quality.coverageRate, 0.5);
  assert.deepStrictEqual(partialResult.quality.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);
  assert.strictEqual(partialResult.metrics.observedEnergy, 15);
  assert.strictEqual(partialResult.metrics.observedEnergyPartial, true);
  assert.strictEqual(partialResult.metrics.totalEnergy, null);

  clearTimeseriesRecords(db);
  const noDataResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(noDataResult.quality.status, 'no_data');
  assert.deepStrictEqual(noDataResult.quality.reasonCodes, ['NO_TIMESERIES_DATA']);
  assert.strictEqual(noDataResult.metrics.observedEnergy, null);
  noDataResult.periods.forEach((period) => assert.strictEqual(period.observed, null));

  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 15, 0, {
    sourceTimeZone: 'Etc/GMT'
  });
  const zeroResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(zeroResult.quality.status, 'sufficient');
  assert.deepStrictEqual(zeroResult.quality.reasonCodes, []);
  assert.strictEqual(zeroResult.metrics.observedEnergy, 0);
  assert.strictEqual(zeroResult.metrics.totalEnergy, 0);
  zeroResult.periods.forEach((period) => {
    assert.strictEqual(period.observed, 0);
    assert.strictEqual(period.complete, 0);
    assert.strictEqual(period.roundedToZero, false);
    assert.strictEqual(period.share, null, '真实零值总量下占比分母为零，share 必须为 null。');
  });

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 15,
    normalizedValue: 4e-13,
    originalValue: 4e-13
  });
  const microResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(microResult.metrics.observedEnergy, 0);
  assert.strictEqual(microResult.metrics.roundedToZero, true);
  assert.strictEqual(microResult.metrics.totalEnergy, 0);
  assert.strictEqual(microResult.metrics.conservationDifference, 4e-13);
  assert.strictEqual(getTimeOfUsePeriod(microResult, 'peak').roundedToZero, true);
  assert.strictEqual(getTimeOfUsePeriod(microResult, 'flat').roundedToZero, true);
  assert.strictEqual(getTimeOfUsePeriod(microResult, 'valley').roundedToZero, false);
  assertClose(getTimeOfUsePeriod(microResult, 'peak').share, 2 / 3);
  assertClose(getTimeOfUsePeriod(microResult, 'flat').share, 1 / 3);
  assert.strictEqual(getTimeOfUsePeriod(microResult, 'valley').share, 0);
  assert.strictEqual(
    microResult.periods.reduce((sum, period) => sum + period.observed, 0),
    0,
    '展示舍入不得跨时段搬移微小正能耗残差。'
  );

  const incomparableResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'Etc/GMT',
    unit: 'MWh',
    endUtc: '2026-07-15T00:30:00.000Z'
  }), { db });
  assert.strictEqual(incomparableResult.scope.comparable, false);
  assert.strictEqual(incomparableResult.quality.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
  assert.strictEqual(incomparableResult.metrics.observedEnergy, null);
  incomparableResult.periods.forEach((period) => assert.strictEqual(period.observed, null));
}

/**
 * 验证 America/New_York 春跳与秋回按真实 UTC 自然分钟分配。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTimeOfUseDstAllocation(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const schemeId = seedTimeOfUseScheme(db, { sourceTimeZone: 'America/New_York' });

  insertContinuousSeries(insertRecord, '2026-03-08T05:00:00.000Z', 23, 60, 1, {
    sourceTimeZone: 'America/New_York'
  });
  const springResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'America/New_York',
    startUtc: '2026-03-08T05:00:00.000Z',
    endUtc: '2026-03-09T04:00:00.000Z'
  }), { db });
  assert.strictEqual(springResult.dataRange.durationMinutes, 23 * 60);
  assert.deepStrictEqual(springResult.periods.map((period) => period.expectedMinutes), [420, 480, 480]);
  assert.deepStrictEqual(springResult.periods.map((period) => period.observed), [7, 8, 8]);
  assert.strictEqual(springResult.metrics.totalEnergy, 23);

  clearTimeseriesRecords(db);
  insertContinuousSeries(insertRecord, '2026-11-01T04:00:00.000Z', 25, 60, 1, {
    sourceTimeZone: 'America/New_York'
  });
  const fallResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    sourceTimeZone: 'America/New_York',
    startUtc: '2026-11-01T04:00:00.000Z',
    endUtc: '2026-11-02T05:00:00.000Z'
  }), { db });
  assert.strictEqual(fallResult.dataRange.durationMinutes, 25 * 60);
  assert.deepStrictEqual(fallResult.periods.map((period) => period.expectedMinutes), [540, 480, 480]);
  assert.deepStrictEqual(fallResult.periods.map((period) => period.observed), [9, 8, 8]);
  assert.strictEqual(fallResult.metrics.totalEnergy, 25);

  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const historicalRules = Array.from({ length: 7 }, (_value, index) => [
    { dayOfWeek: index + 1, periodType: 'flat', startMinute: 0, endMinute: 1435 },
    { dayOfWeek: index + 1, periodType: 'valley', startMinute: 1435, endMinute: 1439 },
    { dayOfWeek: index + 1, periodType: 'peak', startMinute: 1439, endMinute: 1440 }
  ]).flat();
  const historicalSchemeId = seedTimeOfUseScheme(db, {
    sourceTimeZone: 'Asia/Shanghai',
    effectiveStartUtc: '1899-01-01T00:00:00.000Z',
    effectiveEndUtc: '1901-01-01T00:00:00.000Z',
    rules: historicalRules
  });
  insertRecord({
    startUtc: '1900-12-31T15:45:00.000Z',
    endUtc: '1900-12-31T16:00:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    granularityMinutes: 15,
    normalizedValue: 15,
    originalValue: 15
  });
  const historicalResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: historicalSchemeId,
    sourceTimeZone: 'Asia/Shanghai',
    startUtc: '1900-12-31T15:54:00.000Z',
    endUtc: '1900-12-31T15:56:00.000Z'
  }), { db });
  const historicalExpectedMinutes = [17 / 60, 43 / 60, 1];
  const historicalExpectedEnergy = [17 / 60, 43 / 60, 1];
  historicalResult.periods.forEach((period, index) => {
    assertClose(period.expectedMinutes, historicalExpectedMinutes[index]);
    assertClose(period.coveredMinutes, historicalExpectedMinutes[index]);
    assertClose(period.observed, historicalExpectedEnergy[index]);
  });
  assertClose(historicalResult.quality.coveredMinutes, 2);
  assertClose(
    historicalResult.periods.reduce((sum, period) => sum + period.coveredMinutes, 0),
    historicalResult.quality.coveredMinutes
  );
  assert.strictEqual(historicalResult.metrics.observedEnergy, 2);
  assert.strictEqual(historicalResult.metrics.totalEnergy, 2);
  assert.strictEqual(historicalResult.metrics.conservationDifference, 0);
}

/**
 * 验证峰平谷读取快照、错误回滚、调用方事务和连接所有权。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTimeOfUseTransactionAndOwnership(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const peakRules = Array.from({ length: 7 }, (_value, index) => ({
    dayOfWeek: index + 1,
    periodType: 'peak',
    startMinute: 0,
    endMinute: 1440
  }));
  const schemeId = seedTimeOfUseScheme(db, {
    schemeName: '快照旧方案名',
    rules: peakRules
  });
  insertRecord({ normalizedValue: 10, originalValue: 10 });
  db.pragma('journal_mode = WAL');
  const competingConnection = database.openDatabase();
  const insertCompetingRecord = createTimeseriesInserter(competingConnection, ids);
  try {
    let competingWriteSucceeded = false;
    const snapshotResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), {
      db,
      testOnlyAfterTimeOfUseScope: () => {
        competingConnection.transaction(() => {
          competingConnection.prepare(
            "UPDATE tou_schemes SET scheme_name = '快照新方案名' WHERE id = ?"
          ).run(schemeId);
          competingConnection.prepare(
            "UPDATE tou_period_rules SET period_type = 'valley' WHERE tou_scheme_id = ?"
          ).run(schemeId);
          insertCompetingRecord({
            startUtc: '2026-07-15T00:15:00.000Z',
            endUtc: '2026-07-15T00:30:00.000Z',
            normalizedValue: 20,
            originalValue: 20
          });
        })();
        competingWriteSucceeded = true;
      }
    });
    assert.strictEqual(competingWriteSucceeded, true);
    assert.strictEqual(snapshotResult.scheme.name, '快照旧方案名');
    assert.strictEqual(snapshotResult.recordCount, 1);
    assert.strictEqual(getTimeOfUsePeriod(snapshotResult, 'peak').observed, 10);
    assert.strictEqual(getTimeOfUsePeriod(snapshotResult, 'valley').observed, 0);
    assert.strictEqual(db.inTransaction, false, '服务自建峰平谷读取事务必须提交。');

    const freshResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), { db });
    assert.strictEqual(freshResult.scheme.name, '快照新方案名');
    assert.strictEqual(freshResult.recordCount, 2);
    assert.strictEqual(getTimeOfUsePeriod(freshResult, 'peak').observed, 0);
    assert.strictEqual(getTimeOfUsePeriod(freshResult, 'valley').observed, 30);
  } finally {
    competingConnection.close();
  }

  assert.throws(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), {
      db,
      testOnlyAfterTimeOfUseTimeseries: () => {
        throw new Error('controlled time-of-use snapshot failure');
      }
    }),
    /controlled time-of-use snapshot failure/
  );
  assert.strictEqual(db.inTransaction, false, '峰平谷错误路径必须回滚服务自建事务。');

  db.exec('BEGIN DEFERRED');
  try {
    const callerTransactionResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }), { db });
    assert.strictEqual(callerTransactionResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(callerTransactionResult.meta.readTransactionMode, 'caller_owned_reused');
    assert.strictEqual(db.inTransaction, true);
    assert.throws(
      () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
        meterDeviceId: ids.primaryMeterId,
        touSchemeId: schemeId,
        endUtc: '2026-07-15T00:30:00.000Z'
      }), {
        db,
        testOnlyAfterTimeOfUseScheme: () => {
          throw new Error('caller owns time-of-use transaction');
        }
      }),
      /caller owns time-of-use transaction/
    );
    assert.strictEqual(db.inTransaction, true, '服务不得提交或回滚调用方已有峰平谷事务。');
  } finally {
    db.exec('ROLLBACK');
  }

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
    const ownedResult = getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      endUtc: '2026-07-15T00:30:00.000Z'
    }));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedResult.meta.readTransactionMode, 'service_owned_begin_deferred');
    assert.strictEqual(ownedConnectionClosed, true, '峰平谷服务自有连接必须在 finally 中关闭。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}

/**
 * 验证峰平谷数值非有限时返回稳定脱敏五百错误。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 单条写入函数。
 */
function testTimeOfUseNumericOverflow(db, ids, insertRecord) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const schemeId = seedTimeOfUseScheme(db, {
    rules: Array.from({ length: 7 }, (_value, index) => ({
      dayOfWeek: index + 1,
      periodType: 'peak',
      startMinute: 0,
      endMinute: 1440
    }))
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 60, 1e308);
  assertAnalysisNumericOverflow(() => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
    meterDeviceId: ids.primaryMeterId,
    touSchemeId: schemeId,
    endUtc: '2026-07-15T02:00:00.000Z'
  }), { db }));
  assert.strictEqual(db.inTransaction, false, '峰平谷数值溢出必须回滚服务自建事务。');
}

/**
 * 验证峰平谷规则 LIMIT 50001 的超限探测，50000 条不会误报记录上限。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testTimeOfUseRuleRecordLimit(db, ids) {
  clearTimeOfUseConfiguration(db);
  clearTimeseriesRecords(db);
  const schemeId = seedTimeOfUseScheme(db, { rules: [] });
  const insertRule = db.prepare(
    `INSERT INTO tou_period_rules (
       tou_scheme_id, day_of_week, period_type, start_minute, end_minute
     ) VALUES (?, 1, 'peak', ?, ?)`
  );
  const insertManyRules = db.transaction(() => {
    let insertedCount = 0;
    for (let startMinute = 0; startMinute < 1440 && insertedCount < 50001; startMinute += 1) {
      for (
        let endMinute = startMinute + 1;
        endMinute <= 1440 && insertedCount < 50001;
        endMinute += 1
      ) {
        insertRule.run(schemeId, startMinute, endMinute);
        insertedCount += 1;
      }
    }
    assert.strictEqual(insertedCount, 50001);
  });
  insertManyRules();
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      startUtc: '2026-07-13T00:00:00.000Z',
      endUtc: '2026-07-13T00:15:00.000Z'
    }), { db }),
    'TOU_RULE_RECORD_LIMIT_EXCEEDED'
  );
  db.prepare(
    'DELETE FROM tou_period_rules WHERE id = (SELECT MAX(id) FROM tou_period_rules)'
  ).run();
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS total FROM tou_period_rules WHERE tou_scheme_id = ?')
      .get(schemeId).total,
    50000
  );
  assertBadRequestCode(
    () => getTimeOfUseConsumptionAnalysis(createTimeOfUseInput({
      meterDeviceId: ids.primaryMeterId,
      touSchemeId: schemeId,
      startUtc: '2026-07-13T00:00:00.000Z',
      endUtc: '2026-07-13T00:15:00.000Z'
    }), { db }),
    'TOU_RULE_SET_INVALID'
  );
}

/**
 * 创建月度消费分析标准输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 月度查询输入。
 */
function createMonthlyInput(overrides = {}) {
  return {
    startMonth: '2026-01',
    endMonth: '2026-04',
    ...overrides
  };
}

/**
 * 清理月度能耗事实，避免负荷摘要测试残留影响分析场景。
 * @param {object} db SQLite 连接。
 */
function clearMonthlyEnergyRecords(db) {
  db.prepare('DELETE FROM energy_records').run();
}

/**
 * 创建月度测试组织、表计，并将天然气能源类型置为停用标签。
 * @param {object} db SQLite 连接。
 * @param {object} baseIds 既有主数据 ID。
 * @returns {object} 月度场景主数据 ID。
 */
function seedMonthlyMasterData(db, baseIds) {
  const insertOrganization = db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES (?, ?, ?, 'workshop', ?)`
  );
  const inactiveOrganizationId = Number(insertOrganization.run(
    'MONTHLY-OU-INACTIVE',
    '月度停用组织',
    '/月度停用组织',
    'inactive'
  ).lastInsertRowid);
  const activeOrganizationBId = Number(insertOrganization.run(
    'MONTHLY-OU-B',
    '月度组织B',
    '/月度组织B',
    'active'
  ).lastInsertRowid);
  const activeOrganizationCId = Number(insertOrganization.run(
    'MONTHLY-OU-C',
    '月度组织C',
    '/月度组织C',
    'active'
  ).lastInsertRowid);
  const activeOrganizationDId = Number(insertOrganization.run(
    'MONTHLY-OU-D',
    '月度组织D',
    '/月度组织D',
    'active'
  ).lastInsertRowid);

  const insertMeter = db.prepare(
    `INSERT INTO meter_devices
       (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES (?, ?, 'electricity', ?, ?, ?)`
  );
  const inactiveMeterId = Number(insertMeter.run(
    'MONTHLY-METER-INACTIVE',
    '月度停用表计',
    baseIds.electricityId,
    inactiveOrganizationId,
    'inactive'
  ).lastInsertRowid);
  const meterBId = Number(insertMeter.run(
    'MONTHLY-METER-B',
    '月度表计B',
    baseIds.electricityId,
    activeOrganizationBId,
    'active'
  ).lastInsertRowid);
  const meterCId = Number(insertMeter.run(
    'MONTHLY-METER-C',
    '月度表计C',
    baseIds.electricityId,
    activeOrganizationCId,
    'active'
  ).lastInsertRowid);
  const meterDId = Number(insertMeter.run(
    'MONTHLY-METER-D',
    '月度表计D',
    baseIds.electricityId,
    activeOrganizationDId,
    'active'
  ).lastInsertRowid);
  db.prepare('UPDATE energy_types SET is_active = 0 WHERE id = ?').run(baseIds.naturalGasId);

  return {
    inactiveOrganizationId,
    activeOrganizationBId,
    activeOrganizationCId,
    activeOrganizationDId,
    inactiveMeterId,
    meterBId,
    meterCId,
    meterDId
  };
}

/**
 * 创建月度能耗事实写入函数，显式支持空组织和空表计关联。
 * @param {object} db SQLite 连接。
 * @param {object} baseIds 既有主数据 ID。
 * @param {object} monthlyIds 月度主数据 ID。
 * @returns {Function} 单条月度事实写入函数。
 */
function createMonthlyRecordInserter(db, baseIds, monthlyIds) {
  const insert = db.prepare(
    `INSERT INTO energy_records (
       energy_type_id,
       organization_unit_id,
       meter_device_id,
       original_month,
       normalized_month,
       original_unit,
       original_value,
       normalized_unit,
       normalized_value,
       duplicate_key,
       record_status
     ) VALUES (
       @energyTypeId,
       @organizationUnitId,
       @meterDeviceId,
       @month,
       @month,
       @unit,
       @value,
       @unit,
       @value,
       @duplicateKey,
       @recordStatus
     )`
  );
  let sequence = 0;
  return (overrides = {}) => {
    sequence += 1;
    const energyTypeId = Object.prototype.hasOwnProperty.call(overrides, 'energyTypeId')
      ? overrides.energyTypeId
      : baseIds.electricityId;
    const organizationUnitId = Object.prototype.hasOwnProperty.call(overrides, 'organizationUnitId')
      ? overrides.organizationUnitId
      : monthlyIds.inactiveOrganizationId;
    const meterDeviceId = Object.prototype.hasOwnProperty.call(overrides, 'meterDeviceId')
      ? overrides.meterDeviceId
      : monthlyIds.inactiveMeterId;
    const month = overrides.month || '2026-01';
    const unit = overrides.unit || 'kWh';
    const value = Object.prototype.hasOwnProperty.call(overrides, 'value') ? overrides.value : 10;
    return Number(insert.run({
      energyTypeId,
      organizationUnitId,
      meterDeviceId,
      month,
      unit,
      value,
      duplicateKey: overrides.duplicateKey || `monthly-analysis:${sequence}`,
      recordStatus: overrides.recordStatus || 'active'
    }).lastInsertRowid);
  };
}

/**
 * 按能源编码和单位查找唯一分析分面。
 * @param {object} result 月度分析结果。
 * @param {string} energyTypeCode 能源编码。
 * @param {string} unit 单位。
 * @returns {object} 唯一分面。
 */
function getMonthlyFacet(result, energyTypeCode, unit) {
  const facet = result.facets.find((item) => (
    item.energyType.code === energyTypeCode && item.unit === unit
  ));
  assert(facet, `未找到 ${energyTypeCode}/${unit} 分面。`);
  return facet;
}

/**
 * 验证月度输入的 1/36/37 月、跨年、严格标量和范围上限。
 */
function testMonthlyInputValidation() {
  assert.strictEqual(DEFAULT_MONTHLY_ANALYSIS_TOP_N, 10);
  assert.strictEqual(MAX_MONTHLY_ANALYSIS_MONTHS, 36);
  assert.strictEqual(MAX_MONTHLY_ANALYSIS_TOP_N, 50);
  assert.strictEqual(MONTHLY_ANALYSIS_LOOKBACK_MONTHS, 12);

  const oneMonth = normalizeMonthlyConsumptionAnalysisInput({
    startMonth: '2026-01',
    endMonth: '2026-01'
  });
  assert.strictEqual(oneMonth.monthCount, 1);
  assert.deepStrictEqual(oneMonth.months, ['2026-01']);
  assert.strictEqual(oneMonth.historyStartMonth, '2025-01');
  assert.strictEqual(oneMonth.topN, 10);

  const crossYear = normalizeMonthlyConsumptionAnalysisInput({
    startMonth: '2025-12',
    endMonth: '2026-02',
    includeDescendants: 'false',
    topN: '50'
  });
  assert.deepStrictEqual(crossYear.months, ['2025-12', '2026-01', '2026-02']);
  assert.strictEqual(crossYear.topN, 50);

  const thirtySixMonths = normalizeMonthlyConsumptionAnalysisInput({
    startMonth: '2024-01',
    endMonth: '2026-12'
  });
  assert.strictEqual(thirtySixMonths.monthCount, 36);
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput({ startMonth: '2023-12', endMonth: '2026-12' }),
    'MONTHLY_ANALYSIS_RANGE_EXCEEDED'
  );
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput({ startMonth: '2026-02', endMonth: '2026-01' }),
    'INVALID_MONTHLY_ANALYSIS_RANGE'
  );
  [null, [], '2026-01', 1].forEach((input) => {
    assertBadRequestCode(
      () => normalizeMonthlyConsumptionAnalysisInput(input),
      'INVALID_MONTHLY_CONSUMPTION_ANALYSIS_INPUT'
    );
  });
  [
    ['startMonth', ['2026-01'], 'INVALID_MONTHLY_ANALYSIS_START_MONTH'],
    ['endMonth', { value: '2026-04' }, 'INVALID_MONTHLY_ANALYSIS_END_MONTH'],
    ['organizationUnitId', '1 OR 1=1', 'INVALID_MONTHLY_ANALYSIS_ORGANIZATION_UNIT_ID'],
    ['organizationUnitId', [1], 'INVALID_MONTHLY_ANALYSIS_ORGANIZATION_UNIT_ID'],
    ['energyTypeCode', ['electricity'], 'INVALID_MONTHLY_ANALYSIS_ENERGY_TYPE_CODE'],
    ['unit', { value: 'kWh' }, 'INVALID_MONTHLY_ANALYSIS_UNIT'],
    ['topN', '1 OR 1=1', 'INVALID_MONTHLY_ANALYSIS_TOP_N'],
    ['topN', 51, 'INVALID_MONTHLY_ANALYSIS_TOP_N']
  ].forEach(([fieldName, value, code]) => {
    assertBadRequestCode(
      () => normalizeMonthlyConsumptionAnalysisInput(createMonthlyInput({ [fieldName]: value })),
      code
    );
  });
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput(createMonthlyInput({ includeDescendants: true })),
    'MONTHLY_ANALYSIS_DESCENDANTS_UNSUPPORTED'
  );
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput(createMonthlyInput({ includeDescendants: [] })),
    'INVALID_MONTHLY_ANALYSIS_INCLUDE_DESCENDANTS'
  );
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput(createMonthlyInput({ startMonth: '2026-1' })),
    'INVALID_MONTHLY_ANALYSIS_START_MONTH'
  );
  assertBadRequestCode(
    () => normalizeMonthlyConsumptionAnalysisInput(createMonthlyInput({ endMonth: '2026-13' })),
    'INVALID_MONTHLY_ANALYSIS_END_MONTH'
  );
}

/**
 * 写入月度综合场景，覆盖多分面、缺失、零值、结构、TopN 和同环比基期。
 * @param {object} db SQLite 连接。
 * @param {object} baseIds 既有主数据 ID。
 * @param {object} monthlyIds 月度主数据 ID。
 * @param {Function} insertMonthly 月度写入函数。
 */
function seedMonthlyComprehensiveScenario(db, baseIds, monthlyIds, insertMonthly) {
  clearMonthlyEnergyRecords(db);
  insertMonthly({ month: '2025-01', value: 100 });
  insertMonthly({ month: '2025-02', value: 0 });
  insertMonthly({ month: '2025-03', value: 0 });
  insertMonthly({ month: '2025-12', value: 80 });

  insertMonthly({ month: '2026-01', value: 100 });
  insertMonthly({
    month: '2026-01',
    value: 50,
    meterDeviceId: monthlyIds.meterBId
  });
  insertMonthly({
    month: '2026-01',
    value: 50,
    organizationUnitId: null,
    meterDeviceId: null
  });
  insertMonthly({
    month: '2026-01',
    value: 999,
    recordStatus: 'void'
  });
  insertMonthly({
    month: '2026-03',
    value: 50,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: monthlyIds.meterBId
  });
  insertMonthly({
    month: '2026-03',
    value: 50,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: monthlyIds.meterBId
  });
  insertMonthly({
    month: '2026-03',
    value: 100,
    organizationUnitId: monthlyIds.activeOrganizationCId,
    meterDeviceId: monthlyIds.meterCId
  });
  insertMonthly({
    month: '2026-04',
    value: 0,
    organizationUnitId: monthlyIds.activeOrganizationDId,
    meterDeviceId: monthlyIds.meterDId
  });

  insertMonthly({
    month: '2026-01',
    energyTypeId: baseIds.naturalGasId,
    unit: 'm3',
    value: 30,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: null
  });
  insertMonthly({
    month: '2026-01',
    energyTypeId: baseIds.naturalGasId,
    unit: 'm3',
    value: 30,
    organizationUnitId: monthlyIds.activeOrganizationCId,
    meterDeviceId: null
  });
  insertMonthly({
    month: '2026-01',
    energyTypeId: baseIds.naturalGasId,
    unit: 'kWh',
    value: 40,
    organizationUnitId: monthlyIds.activeOrganizationCId,
    meterDeviceId: null
  });
  insertMonthly({
    month: '2026-01',
    energyTypeId: baseIds.naturalGasId,
    unit: 'kg',
    value: 0,
    organizationUnitId: monthlyIds.activeOrganizationDId,
    meterDeviceId: null
  });

  db.prepare(
    'UPDATE meter_devices SET organization_unit_id = ? WHERE id = ?'
  ).run(monthlyIds.activeOrganizationCId, monthlyIds.inactiveMeterId);
}

/**
 * 验证月度趋势、同环比、分面、结构、TopN、状态标签和峰值月份契约。
 * @param {object} db SQLite 连接。
 * @param {object} baseIds 既有主数据 ID。
 * @param {object} monthlyIds 月度主数据 ID。
 * @param {Function} insertMonthly 月度写入函数。
 */
function testMonthlyAnalysisContract(db, baseIds, monthlyIds, insertMonthly) {
  seedMonthlyComprehensiveScenario(db, baseIds, monthlyIds, insertMonthly);
  const result = getMonthlyConsumptionAnalysis(createMonthlyInput({ topN: 10 }), { db });
  assert.strictEqual(result.contractVersion, 'energy-analysis-contract:v1');
  assert.strictEqual(result.formulaVersion, 'monthly-consumption-analysis:v1');
  assert.strictEqual(result.dataStatus, 'available');
  assert.deepStrictEqual(result.reasonCodes, []);
  assert.strictEqual(result.scope.monthCount, 4);
  assert.strictEqual(result.scope.historyStartMonth, '2025-01');
  assert.strictEqual(result.scope.includeDescendants, false);
  assert.strictEqual(result.facets.length, 4, 'topN 不得截断能源/单位分面。');
  assert.deepStrictEqual(result.meta.excludedDataSources, [
    'energy_timeseries_records',
    'meter_reading_records',
    'generation_records'
  ]);
  assert.strictEqual(result.meta.sourceTable, 'energy_records');
  assert.strictEqual(result.meta.readOnly, true);
  assert.strictEqual(result.meta.benchmarkApplied, false);
  assert.strictEqual(result.meta.generationOffsetApplied, false);
  assert.strictEqual(result.meta.aggregateQueryCount, 3);

  const electricity = getMonthlyFacet(result, 'electricity', 'kWh');
  assert.strictEqual(electricity.energyType.active, true);
  assert.deepStrictEqual(electricity.totals, {
    value: 400,
    recordCount: 7,
    observedMonthCount: 3,
    rangeMonthCount: 4
  });
  assert.deepStrictEqual(
    electricity.trend.map((point) => [point.month, point.value, point.recordCount]),
    [
      ['2026-01', 200, 3],
      ['2026-02', null, 0],
      ['2026-03', 200, 3],
      ['2026-04', 0, 1]
    ]
  );
  const january = electricity.trend[0];
  assert.strictEqual(january.periodOverPeriod.baseMonth, '2025-12');
  assert.strictEqual(january.periodOverPeriod.baseValueStatus, 'nonzero');
  assert.strictEqual(january.periodOverPeriod.absoluteDifference, 120);
  assert.strictEqual(january.periodOverPeriod.changeRate, 1.5);
  assert.strictEqual(january.periodOverPeriod.calculationStatus, 'available');
  assert.deepStrictEqual(january.periodOverPeriod.reasonCodes, []);
  assert.strictEqual(january.yearOverYear.baseMonth, '2025-01');
  assert.strictEqual(january.yearOverYear.changeRate, 1);
  assert.deepStrictEqual(january.yearOverYear.reasonCodes, []);
  const february = electricity.trend[1];
  assert.strictEqual(february.periodOverPeriod.status, 'current_missing');
  assert.strictEqual(february.periodOverPeriod.currentValue, null);
  assert.strictEqual(february.periodOverPeriod.baseValue, 200);
  assert.strictEqual(february.periodOverPeriod.calculable, false);
  assert.strictEqual(february.periodOverPeriod.calculationStatus, 'current_missing');
  assert.strictEqual(february.periodOverPeriod.absoluteDifference, null);
  assert.strictEqual(february.periodOverPeriod.changeRate, null);
  assert.deepStrictEqual(february.periodOverPeriod.reasonCodes, []);
  assert.strictEqual(february.yearOverYear.baseValueStatus, 'zero');
  assert.deepStrictEqual(february.yearOverYear.reasonCodes, []);
  const march = electricity.trend[2];
  assert.strictEqual(march.periodOverPeriod.status, 'base_missing');
  assert.strictEqual(march.periodOverPeriod.baseValueStatus, 'missing');
  assert.strictEqual(march.periodOverPeriod.calculable, false);
  assert.strictEqual(march.periodOverPeriod.calculationStatus, 'base_missing');
  assert.strictEqual(march.periodOverPeriod.absoluteDifference, null);
  assert.strictEqual(march.periodOverPeriod.changeRate, null);
  assert.deepStrictEqual(march.periodOverPeriod.reasonCodes, []);
  assert.strictEqual(march.yearOverYear.status, 'base_zero');
  assert.strictEqual(march.yearOverYear.baseValueStatus, 'zero');
  assert.strictEqual(march.yearOverYear.calculationStatus, 'base_zero');
  assert.strictEqual(march.yearOverYear.absoluteDifference, 200);
  assert.strictEqual(march.yearOverYear.changeRate, null);
  assert.deepStrictEqual(march.yearOverYear.reasonCodes, []);
  assert.strictEqual(JSON.stringify(result).includes('NO_TIMESERIES_DATA'), false);
  assert.strictEqual(JSON.stringify(result).includes('UNIT_NOT_COMPARABLE'), false);
  const april = electricity.trend[3];
  assert.strictEqual(april.value, 0, '当前真实零值必须保留。');
  assert.strictEqual(april.periodOverPeriod.currentValueStatus, 'zero');
  assert.strictEqual(april.periodOverPeriod.calculable, true);
  assert.strictEqual(april.periodOverPeriod.calculationStatus, 'available');
  assert.strictEqual(april.periodOverPeriod.changeRate, -1);
  assert.deepStrictEqual(electricity.peakMonths, [
    { month: '2026-01', value: 200, recordCount: 3 },
    { month: '2026-03', value: 200, recordCount: 3 }
  ]);

  assert.deepStrictEqual(electricity.structure.organization, {
    linked: { value: 350, recordCount: 6 },
    unlinked: { value: 50, recordCount: 1 }
  });
  assert.deepStrictEqual(electricity.structure.meter, {
    linked: { value: 350, recordCount: 6 },
    unlinked: { value: 50, recordCount: 1 }
  });
  assert.strictEqual(
    electricity.organizationTopN.some((item) => item.organizationUnitId === null),
    false,
    '未关联事实不得伪造组织 ID。'
  );
  assert.strictEqual(electricity.organizationTopN[0].organizationUnitId, monthlyIds.inactiveOrganizationId);
  assert.strictEqual(electricity.organizationTopN[0].organizationUnitStatus, 'inactive');
  assert.strictEqual(electricity.organizationTopN[0].totalValue, 150);
  assert.strictEqual(electricity.organizationTopN[0].recordCount, 2);
  assertClose(electricity.organizationTopN[0].share, 0.375);
  assert.strictEqual(electricity.organizationTopN[1].organizationUnitId, monthlyIds.activeOrganizationBId);
  assert.strictEqual(electricity.organizationTopN[1].totalValue, 100);
  assert.strictEqual(electricity.organizationTopN[1].recordCount, 2);
  assert.strictEqual(electricity.organizationTopN[2].organizationUnitId, monthlyIds.activeOrganizationCId);
  assert.strictEqual(electricity.organizationTopN[2].totalValue, 100);
  assert.strictEqual(electricity.organizationTopN[2].recordCount, 1);
  assert.strictEqual(electricity.organizationTopN[3].organizationUnitId, monthlyIds.activeOrganizationDId);
  assert.strictEqual(electricity.organizationTopN[3].totalValue, 0);

  assert.strictEqual(electricity.meterTopN[0].meterDeviceId, monthlyIds.meterBId);
  assert.strictEqual(electricity.meterTopN[0].totalValue, 150);
  assert.strictEqual(electricity.meterTopN[0].recordCount, 3);
  const inactiveMeter = electricity.meterTopN.find((item) => item.meterDeviceId === monthlyIds.inactiveMeterId);
  assert(inactiveMeter);
  assert.strictEqual(inactiveMeter.meterStatus, 'inactive');
  assert.strictEqual(inactiveMeter.currentOrganizationUnitId, monthlyIds.activeOrganizationCId);
  const tiedMeterRows = electricity.meterTopN.filter((item) => item.totalValue === 100 && item.recordCount === 1);
  assert.deepStrictEqual(
    tiedMeterRows.map((item) => item.meterDeviceId),
    [monthlyIds.inactiveMeterId, monthlyIds.meterCId],
    '总量和记录数并列时必须按表计 ID 升序。'
  );

  const inactiveGas = getMonthlyFacet(result, 'natural_gas', 'm3');
  assert.strictEqual(inactiveGas.energyType.active, false, '停用能源类型仍需返回当前标签。');
  assert.strictEqual(inactiveGas.totals.value, 60);
  assert.deepStrictEqual(
    inactiveGas.organizationTopN.map((item) => item.organizationUnitId),
    [monthlyIds.activeOrganizationBId, monthlyIds.activeOrganizationCId],
    '总量和记录数并列时必须按组织 ID 升序。'
  );
  const sameUnitDifferentEnergy = getMonthlyFacet(result, 'natural_gas', 'kWh');
  assert.strictEqual(sameUnitDifferentEnergy.totals.value, 40, '同单位不同能源不得合并。');
  const zeroTotalFacet = getMonthlyFacet(result, 'natural_gas', 'kg');
  assert.strictEqual(zeroTotalFacet.totals.value, 0);
  assert.strictEqual(zeroTotalFacet.organizationTopN[0].share, null, '零总量分面占比不得除以零。');
  assert.deepStrictEqual(zeroTotalFacet.peakMonths, [
    { month: '2026-01', value: 0, recordCount: 1 }
  ]);

  const topOne = getMonthlyConsumptionAnalysis(createMonthlyInput({ topN: 1 }), { db });
  assert.strictEqual(topOne.facets.length, 4);
  assert.strictEqual(getMonthlyFacet(topOne, 'electricity', 'kWh').organizationTopN.length, 1);
  assert.strictEqual(getMonthlyFacet(topOne, 'electricity', 'kWh').meterTopN.length, 1);
}

/**
 * 验证精确组织、停用组织、组织不存在和下级范围拒绝。
 * @param {object} db SQLite 连接。
 * @param {object} monthlyIds 月度主数据 ID。
 */
function testMonthlyOrganizationScope(db, monthlyIds) {
  const result = getMonthlyConsumptionAnalysis(createMonthlyInput({
    organizationUnitId: String(monthlyIds.inactiveOrganizationId)
  }), { db });
  assert.strictEqual(result.scope.organizationUnit.status, 'inactive');
  const electricity = getMonthlyFacet(result, 'electricity', 'kWh');
  assert.strictEqual(electricity.totals.value, 150);
  assert.strictEqual(electricity.organizationTopN.length, 1);
  assert.strictEqual(electricity.organizationTopN[0].organizationUnitId, monthlyIds.inactiveOrganizationId);
  assert.strictEqual(
    electricity.meterTopN.some((item) => item.currentOrganizationUnitId === monthlyIds.activeOrganizationCId),
    true,
    '精确组织必须依据历史 er.organization_unit_id，不得通过表计当前归属反推。'
  );
  assertBadRequestCode(
    () => getMonthlyConsumptionAnalysis(createMonthlyInput({ organizationUnitId: 999999999 }), { db }),
    'MONTHLY_ANALYSIS_ORGANIZATION_NOT_FOUND'
  );
  assertBadRequestCode(
    () => getMonthlyConsumptionAnalysis(createMonthlyInput({
      organizationUnitId: monthlyIds.inactiveOrganizationId,
      includeDescendants: true
    }), { db }),
    'MONTHLY_ANALYSIS_DESCENDANTS_UNSUPPORTED'
  );
}

/**
 * 验证参数化文本筛选、无数据状态和无误用质量原因码。
 * @param {object} db SQLite 连接。
 */
function testMonthlyFiltersAndNoData(db) {
  const exactEnergy = getMonthlyConsumptionAnalysis(createMonthlyInput({
    energyTypeCode: 'electricity',
    unit: 'kWh'
  }), { db });
  assert.strictEqual(exactEnergy.facets.length, 1);
  assert.strictEqual(exactEnergy.facets[0].energyType.code, 'electricity');
  const thirtySixMonthResult = getMonthlyConsumptionAnalysis({
    startMonth: '2024-01',
    endMonth: '2026-12',
    energyTypeCode: 'electricity',
    unit: 'kWh'
  }, { db });
  assert.strictEqual(thirtySixMonthResult.scope.monthCount, 36);
  assert.strictEqual(thirtySixMonthResult.facets[0].trend.length, 36);

  assertBadRequestCode(
    () => getMonthlyConsumptionAnalysis(createMonthlyInput({
      energyTypeCode: "electricity' OR 1=1 --"
    }), { db }),
    'INVALID_MONTHLY_ANALYSIS_ENERGY_TYPE_CODE'
  );
  assertBadRequestCode(
    () => getMonthlyConsumptionAnalysis(createMonthlyInput({
      unit: "kWh' OR 1=1 --"
    }), { db }),
    'INVALID_MONTHLY_ANALYSIS_UNIT'
  );

  clearMonthlyEnergyRecords(db);
  const noData = getMonthlyConsumptionAnalysis(createMonthlyInput(), { db });
  assert.strictEqual(noData.dataStatus, 'no_data');
  assert.deepStrictEqual(noData.facets, []);
  assert.deepStrictEqual(noData.reasonCodes, []);
  assert.strictEqual(JSON.stringify(noData).includes('NO_TIMESERIES_DATA'), false);
}

/**
 * 验证两条极大月度事实导致 SQLite SUM 非有限时整次服务稳定失败，不返回伪零结果。
 * @param {object} db SQLite 连接。
 * @param {object} monthlyIds 月度主数据 ID。
 * @param {Function} insertMonthly 月度写入函数。
 */
function testMonthlyNumericOverflow(db, monthlyIds, insertMonthly) {
  clearMonthlyEnergyRecords(db);
  insertMonthly({
    month: '2025-12',
    value: 1e-6,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: monthlyIds.meterBId
  });
  insertMonthly({
    month: '2026-01',
    value: 1e308,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: monthlyIds.meterBId
  });
  const finiteHugeResult = getMonthlyConsumptionAnalysis(createMonthlyInput({
    startMonth: '2026-01',
    endMonth: '2026-01'
  }), { db });
  const finiteHugeFacet = getMonthlyFacet(finiteHugeResult, 'electricity', 'kWh');
  assert.strictEqual(finiteHugeFacet.totals.value, 1e308);
  assert.strictEqual(finiteHugeFacet.trend[0].value, 1e308);
  assert.strictEqual(finiteHugeFacet.structure.organization.linked.value, 1e308);
  assert.strictEqual(finiteHugeFacet.organizationTopN[0].totalValue, 1e308);
  assert.strictEqual(finiteHugeFacet.meterTopN[0].totalValue, 1e308);
  const rateOverflowComparison = finiteHugeFacet.trend[0].periodOverPeriod;
  assert.strictEqual(rateOverflowComparison.status, 'numeric_overflow');
  assert.strictEqual(rateOverflowComparison.calculationStatus, 'numeric_overflow');
  assert.strictEqual(rateOverflowComparison.currentValueStatus, 'nonzero');
  assert.strictEqual(rateOverflowComparison.baseValueStatus, 'nonzero');
  assert.strictEqual(rateOverflowComparison.currentValue, 1e308);
  assert.strictEqual(rateOverflowComparison.baseValue, 1e-6);
  assert.strictEqual(rateOverflowComparison.absoluteDifference, 1e308);
  assert.strictEqual(rateOverflowComparison.value, null);
  assert.strictEqual(rateOverflowComparison.changeRate, null);
  assert.strictEqual(rateOverflowComparison.calculable, false);
  assert.deepStrictEqual(rateOverflowComparison.reasonCodes, []);
  Object.values(rateOverflowComparison).forEach((value) => {
    if (typeof value === 'number') assert.strictEqual(Number.isFinite(value), true);
  });
  [
    finiteHugeFacet.totals.value,
    finiteHugeFacet.trend[0].value,
    finiteHugeFacet.structure.organization.linked.value,
    finiteHugeFacet.organizationTopN[0].totalValue,
    finiteHugeFacet.meterTopN[0].totalValue
  ].forEach((value) => assert.strictEqual(Number.isFinite(value), true));

  insertMonthly({
    month: '2026-01',
    value: 1e308,
    organizationUnitId: monthlyIds.activeOrganizationCId,
    meterDeviceId: monthlyIds.meterCId
  });
  const sourceAggregate = db.prepare(
    `SELECT COUNT(id) AS recordCount, SUM(normalized_value) AS totalValue
     FROM energy_records
     WHERE record_status = 'active' AND normalized_month = '2026-01'`
  ).get();
  assert.strictEqual(sourceAggregate.recordCount, 2);
  assert.strictEqual(Number.isFinite(sourceAggregate.totalValue), false);

  assertAnalysisNumericOverflow(() => getMonthlyConsumptionAnalysis(createMonthlyInput({
    startMonth: '2026-01',
    endMonth: '2026-01'
  }), { db }));
  assert.strictEqual(db.inTransaction, false, '数值溢出必须回滚服务自建读取事务。');
  assert.strictEqual(
    db.prepare(
      "SELECT COUNT(id) AS recordCount FROM energy_records WHERE normalized_month = '2026-01'"
    ).get().recordCount,
    2,
    '输出月份源记录数必须保持为两条，不得被非有限聚合伪装为零。'
  );
}

/**
 * 验证三类聚合共享读取快照、错误回滚和调用方事务所有权。
 * @param {object} db SQLite 连接。
 * @param {object} baseIds 既有主数据 ID。
 * @param {object} monthlyIds 月度主数据 ID。
 * @param {Function} insertMonthly 月度写入函数。
 */
function testMonthlyTransactionSnapshot(db, baseIds, monthlyIds, insertMonthly) {
  clearMonthlyEnergyRecords(db);
  insertMonthly({
    month: '2026-01',
    value: 10,
    organizationUnitId: monthlyIds.activeOrganizationBId,
    meterDeviceId: monthlyIds.meterBId
  });
  db.pragma('journal_mode = WAL');
  const competingConnection = database.openDatabase();
  try {
    let competingWriteSucceeded = false;
    const snapshotResult = getMonthlyConsumptionAnalysis(createMonthlyInput({
      startMonth: '2026-01',
      endMonth: '2026-01'
    }), {
      db,
      testOnlyAfterMonthlyQuery: () => {
        competingConnection.prepare(
          `INSERT INTO energy_records (
             energy_type_id, organization_unit_id, meter_device_id,
             original_month, normalized_month, original_unit, original_value,
             normalized_unit, normalized_value, duplicate_key, record_status
           ) VALUES (?, ?, ?, '2026-01', '2026-01', 'kWh', 20, 'kWh', 20,
                     'monthly-snapshot-competing', 'active')`
        ).run(
          baseIds.electricityId,
          monthlyIds.activeOrganizationCId,
          monthlyIds.meterCId
        );
        competingWriteSucceeded = true;
      }
    });
    assert.strictEqual(competingWriteSucceeded, true);
    const snapshotFacet = getMonthlyFacet(snapshotResult, 'electricity', 'kWh');
    assert.strictEqual(snapshotFacet.totals.value, 10);
    assert.strictEqual(snapshotFacet.organizationTopN.length, 1);
    assert.strictEqual(snapshotFacet.organizationTopN[0].totalValue, 10);
    assert.strictEqual(snapshotFacet.meterTopN.length, 1);
    assert.strictEqual(snapshotFacet.meterTopN[0].totalValue, 10);
    assert.strictEqual(db.inTransaction, false, '服务自建读取事务必须提交。');

    const freshResult = getMonthlyConsumptionAnalysis(createMonthlyInput({
      startMonth: '2026-01',
      endMonth: '2026-01'
    }), { db });
    assert.strictEqual(getMonthlyFacet(freshResult, 'electricity', 'kWh').totals.value, 30);
  } finally {
    competingConnection.close();
  }

  assert.throws(
    () => getMonthlyConsumptionAnalysis(createMonthlyInput(), {
      db,
      testOnlyAfterMonthlyQuery: () => {
        throw new Error('controlled monthly snapshot failure');
      }
    }),
    /controlled monthly snapshot failure/
  );
  assert.strictEqual(db.inTransaction, false, '服务错误路径必须回滚自建事务。');

  db.exec('BEGIN DEFERRED');
  try {
    const callerTransactionResult = getMonthlyConsumptionAnalysis(createMonthlyInput(), { db });
    assert.strictEqual(callerTransactionResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
    assert.throws(
      () => getMonthlyConsumptionAnalysis(createMonthlyInput(), {
        db,
        testOnlyAfterMonthlyQuery: () => {
          throw new Error('caller owns monthly transaction');
        }
      }),
      /caller owns monthly transaction/
    );
    assert.strictEqual(db.inTransaction, true, '服务不得回滚调用方已有事务。');
  } finally {
    db.exec('ROLLBACK');
  }
}

/**
 * 验证月度服务的调用方连接和自有连接关闭边界。
 * @param {object} db 调用方 SQLite 连接。
 */
function testMonthlyDatabaseOwnership(db) {
  const callerResult = getMonthlyConsumptionAnalysis(createMonthlyInput(), { db });
  assert.strictEqual(callerResult.meta.callerDatabaseConnection, true);
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1);

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
    const ownedResult = getMonthlyConsumptionAnalysis(createMonthlyInput());
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true, '月度服务自有连接必须在返回前关闭。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}

/**
 * 验证班次分析输入、固定阈值与 31 天边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testShiftInputValidation(db, ids) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  assert.strictEqual(SHIFT_CONSUMPTION_ANALYSIS_FORMULA_VERSION, 'shift-consumption-analysis:v1');
  assert.strictEqual(MAX_SHIFT_SCHEDULE_RECORDS, 50000);
  assert.strictEqual(SHIFT_SCHEDULE_QUERY_LIMIT, 50001);

  const exactRange = normalizeShiftConsumptionAnalysisInput(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-01-01T00:00:00.000Z',
    endUtc: '2026-02-01T00:00:00.000Z'
  }));
  assert.strictEqual(exactRange.durationMinutes, 31 * 24 * 60);
  assert.strictEqual(exactRange.minimumCoverageRate, 1);
  assertBadRequestCode(
    () => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId,
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.001Z'
    }), { db }),
    'ENERGY_LOAD_TIME_RANGE_EXCEEDED'
  );
  [
    ['meterDeviceId', [ids.primaryMeterId], 'INVALID_METER_DEVICE_ID'],
    ['energyTypeCode', ['electricity'], 'INVALID_ENERGY_TYPE_CODE'],
    ['unit', { value: 'kWh' }, 'INVALID_ENERGY_UNIT'],
    ['startUtc', ['2026-07-15T00:00:00.000Z'], 'INVALID_START_UTC'],
    ['endUtc', { value: '2026-07-15T01:00:00.000Z' }, 'INVALID_END_UTC'],
    ['sourceTimeZone', [SOURCE_TIME_ZONE], 'INVALID_SOURCE_TIME_ZONE']
  ].forEach(([fieldName, value, code]) => {
    assertBadRequestCode(
      () => getShiftConsumptionAnalysis(createShiftInput({
        meterDeviceId: ids.primaryMeterId,
        [fieldName]: value
      }), { db }),
      code
    );
  });
  assertBadRequestCode(
    () => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId,
      minimumCoverageRate: 0.5
    }), { db }),
    'SHIFT_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED'
  );
}

/**
 * 验证正常三班次、严格 definition+version 分组、精确组织范围及只读契约。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftAnalysisContract(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const firstDefinitionId = seedShiftDefinition(db, {
    shiftCode: 'SHIFT-A',
    shiftName: '甲班第一版',
    version: 'v1'
  });
  const secondDefinitionId = seedShiftDefinition(db, {
    shiftCode: 'SHIFT-B',
    shiftName: '乙班',
    version: 'v1'
  });
  const thirdDefinitionId = seedShiftDefinition(db, {
    shiftCode: 'SHIFT-A',
    shiftName: '甲班第二版',
    version: 'v2',
    status: 'inactive'
  });
  [
    [firstDefinitionId, '2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.000Z'],
    [secondDefinitionId, '2026-07-15T01:00:00.000Z', '2026-07-15T02:00:00.000Z'],
    [thirdDefinitionId, '2026-07-15T02:00:00.000Z', '2026-07-15T03:00:00.000Z']
  ].forEach(([shiftDefinitionId, startUtc, endUtc]) => {
    seedShiftSchedule(db, ids, { shiftDefinitionId, startUtc, endUtc });
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: firstDefinitionId,
    organizationUnitId: null,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  const childOrganizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (parent_id, unit_code, unit_name, unit_path, unit_type, status)
     VALUES (?, 'SHIFT-CHILD-OU', '班次下级组织', '/负荷摘要测试单元/班次下级组织', 'process', 'active')`
  ).run(ids.organizationUnitId).lastInsertRowid);
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: firstDefinitionId,
    organizationUnitId: childOrganizationUnitId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: firstDefinitionId,
    recordStatus: 'void',
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  insertContinuousSeries(
    insertRecord,
    '2026-07-15T00:00:00.000Z',
    12,
    15,
    (index) => Math.floor(index / 4) + 1
  );

  const totalChangesBefore = db.prepare('SELECT total_changes() AS value').get().value;
  const result = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T03:00:00.000Z'
  }), { db });
  const totalChangesAfter = db.prepare('SELECT total_changes() AS value').get().value;
  assert.strictEqual(totalChangesAfter, totalChangesBefore, '班次分析必须保持零写入。');
  assert.strictEqual(result.formulaVersion, SHIFT_CONSUMPTION_ANALYSIS_FORMULA_VERSION);
  assert.strictEqual(result.recordCount, 12);
  assert.strictEqual(result.scheduleRecordCount, 3);
  assert.strictEqual(result.scope.organizationUnitId, ids.organizationUnitId);
  assert.strictEqual(result.quality.status, 'sufficient');
  assert.strictEqual(result.quality.coverageRate, 1);
  assert.strictEqual(result.quality.scheduleCoverageRate, 1);
  assert.deepStrictEqual(result.quality.sourceGranularityMinutes, [15]);
  assert.strictEqual(result.metrics.observedEnergy, 24);
  assert.strictEqual(result.metrics.assignedEnergy, 24);
  assert.strictEqual(result.metrics.unassignedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, 24);
  assert.strictEqual(result.metrics.roundedToZero, false);
  assert.strictEqual(result.metrics.conservationDifference, 0);
  assert.strictEqual(result.shifts.length, 3);
  assert.strictEqual(getShiftAllocation(result, firstDefinitionId, 'v1').observedEnergy, 4);
  assert.strictEqual(getShiftAllocation(result, secondDefinitionId, 'v1').observedEnergy, 8);
  assert.strictEqual(getShiftAllocation(result, thirdDefinitionId, 'v2').observedEnergy, 12);
  assert.notStrictEqual(firstDefinitionId, thirdDefinitionId);
  assert.deepStrictEqual(result.meta.shiftGroupingIdentity, ['shift_definition_id', 'version']);
  assert.deepStrictEqual(result.meta.exactScopeFields, [
    'meter_device_id',
    'organization_unit_id',
    'energy_type_id',
    'normalized_unit',
    'source_timezone'
  ]);
  assert.strictEqual(result.meta.generatesSchedulesFromWallClock, false);
  assert.strictEqual(result.meta.scheduleExpansionMode, 'materialized_utc_intervals_only');
  assert.strictEqual(result.meta.includesAncestorOrganizations, false);
  assert.strictEqual(result.meta.includesDescendantOrganizations, false);
  assert.strictEqual(result.meta.readOnly, true);
  assert.strictEqual(result.meta.generatesPolicyHit, false);
  assert.strictEqual(result.meta.estimatesEnergySavings, false);
}

/**
 * 验证班次时序严格限定为表计所属组织，不混入父级、子级、其他或空组织事实。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftTimeseriesOrganizationScope(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const parentOrganizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('SHIFT-SCOPE-PARENT', '班次范围父组织', '/班次范围父组织', 'department', 'active')`
  ).run().lastInsertRowid);
  db.prepare('UPDATE organization_units SET parent_id = ? WHERE id = ?')
    .run(parentOrganizationUnitId, ids.organizationUnitId);
  const childOrganizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (parent_id, unit_code, unit_name, unit_path, unit_type, status)
     VALUES (?, 'SHIFT-SCOPE-CHILD', '班次范围子组织',
             '/负荷摘要测试单元/班次范围子组织', 'process', 'active')`
  ).run(ids.organizationUnitId).lastInsertRowid);
  const otherOrganizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('SHIFT-SCOPE-OTHER', '班次范围其他组织', '/班次范围其他组织', 'workshop', 'active')`
  ).run().lastInsertRowid);
  const definitionId = seedShiftDefinition(db, { version: 'organization-scope-v1' });
  seedShiftSchedule(db, ids, { shiftDefinitionId: definitionId });
  insertRecord({
    organizationUnitId: ids.organizationUnitId,
    normalizedValue: 1,
    originalValue: 1,
    sourceReference: 'shift-scope:exact'
  });
  [
    [parentOrganizationUnitId, 'parent'],
    [childOrganizationUnitId, 'child'],
    [otherOrganizationUnitId, 'other'],
    [null, 'null']
  ].forEach(([organizationUnitId, label]) => {
    insertRecord({
      organizationUnitId,
      normalizedValue: 100,
      originalValue: 100,
      sourceReference: `shift-scope:${label}`
    });
  });

  const exactScopeResult = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactScopeResult.recordCount, 1);
  assert.strictEqual(exactScopeResult.metrics.observedEnergy, 1);
  assert.strictEqual(exactScopeResult.metrics.assignedEnergy, 1);
  assert.strictEqual(exactScopeResult.metrics.completeEnergy, 1);
  assert.deepStrictEqual(exactScopeResult.quality.reasonCodes, []);

  db.prepare(
    'DELETE FROM energy_timeseries_records WHERE organization_unit_id = ?'
  ).run(ids.organizationUnitId);
  const outOfScopeOnlyResult = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(outOfScopeOnlyResult.recordCount, 0);
  assert.strictEqual(outOfScopeOnlyResult.quality.status, 'no_data');
  assert(outOfScopeOnlyResult.quality.reasonCodes.includes('NO_TIMESERIES_DATA'));
  assert.strictEqual(outOfScopeOnlyResult.metrics.observedEnergy, null);
  assert.strictEqual(outOfScopeOnlyResult.metrics.assignedEnergy, null);
  assert.strictEqual(outOfScopeOnlyResult.metrics.completeEnergy, null);
}

/**
 * 验证跨午夜和 DST 均只消费数据库已物化的实际 UTC 区间。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftMaterializedUtcIntervals(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const overnightDefinitionId = seedShiftDefinition(db, {
    shiftName: '实际跨午夜班次',
    startMinute: 480,
    endMinute: 960,
    crossesMidnight: 0
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: overnightDefinitionId,
    startUtc: '2026-07-15T22:00:00.000Z',
    endUtc: '2026-07-16T02:00:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T22:00:00.000Z', 4, 60, 2);
  const overnight = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T22:00:00.000Z',
    endUtc: '2026-07-16T02:00:00.000Z'
  }), { db });
  assert.strictEqual(overnight.metrics.completeEnergy, 8);
  assert.strictEqual(getShiftAllocation(overnight, overnightDefinitionId, `v${shiftDefinitionSequence}`).expectedMinutes, 240);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const dstDefinitionId = seedShiftDefinition(db, {
    shiftName: 'DST 回拨实际班次',
    sourceTimeZone: 'America/New_York',
    startMinute: 600,
    endMinute: 660,
    crossesMidnight: 0
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: dstDefinitionId,
    sourceTimeZone: 'America/New_York',
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T07:00:00.000Z'
  });
  insertContinuousSeries(
    insertRecord,
    '2026-11-01T05:00:00.000Z',
    4,
    30,
    1,
    { sourceTimeZone: 'America/New_York' }
  );
  const dstResult = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    sourceTimeZone: 'America/New_York',
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T07:00:00.000Z'
  }), { db });
  assert.strictEqual(dstResult.dataRange.durationMinutes, 120);
  assert.strictEqual(dstResult.metrics.completeEnergy, 4);
  assert.strictEqual(dstResult.shifts[0].expectedMinutes, 120);
}

/**
 * 验证排班缺口、排班重叠、无时序、混合粒度、时序重叠及零值语义。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftQualityBoundaries(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  let definitionId = seedShiftDefinition(db, { version: 'quality-full-schedule-partial-series' });
  seedShiftSchedule(db, ids, { shiftDefinitionId: definitionId });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 15, 1);
  const fullSchedulePartialSeries = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(fullSchedulePartialSeries.quality.coverageRate, 0.5);
  assert.strictEqual(fullSchedulePartialSeries.quality.scheduleCoverageRate, 1);
  assert.strictEqual(fullSchedulePartialSeries.quality.missingScheduleMinutes, 0);
  assert.strictEqual(fullSchedulePartialSeries.quality.status, 'coverage_below_threshold');
  assert.strictEqual(fullSchedulePartialSeries.quality.sufficient, false);
  assert.deepStrictEqual(fullSchedulePartialSeries.quality.configurationErrors, []);
  assert(fullSchedulePartialSeries.quality.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'));
  assert.strictEqual(
    fullSchedulePartialSeries.quality.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'),
    false
  );
  assertApprovedShiftReasonCodes(fullSchedulePartialSeries);
  assert.strictEqual(fullSchedulePartialSeries.metrics.observedEnergy, 2);
  assert.strictEqual(fullSchedulePartialSeries.metrics.assignedEnergy, 2);
  assert.strictEqual(fullSchedulePartialSeries.metrics.unassignedEnergy, 0);
  assert.strictEqual(fullSchedulePartialSeries.metrics.completeEnergy, null);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-partial-schedule-partial-series' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:15:00.000Z', 2, 15, 1);
  const partialSchedulePartialSeries = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(partialSchedulePartialSeries.quality.coverageRate, 0.5);
  assert.strictEqual(partialSchedulePartialSeries.quality.scheduleCoverageRate, 0.5);
  assert.strictEqual(partialSchedulePartialSeries.quality.missingScheduleMinutes, 30);
  assert.strictEqual(partialSchedulePartialSeries.quality.status, 'missing_shift_schedule');
  assert.strictEqual(partialSchedulePartialSeries.quality.sufficient, false);
  assert.deepStrictEqual(partialSchedulePartialSeries.quality.configurationErrors, []);
  assert(partialSchedulePartialSeries.quality.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'));
  assert(partialSchedulePartialSeries.quality.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'));
  assertApprovedShiftReasonCodes(partialSchedulePartialSeries);
  assert.strictEqual(partialSchedulePartialSeries.metrics.observedEnergy, 2);
  assert.strictEqual(partialSchedulePartialSeries.metrics.assignedEnergy, 1);
  assert.strictEqual(partialSchedulePartialSeries.metrics.unassignedEnergy, 1);
  assert.strictEqual(partialSchedulePartialSeries.metrics.completeEnergy, null);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-partial' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 4, 15, 1);
  const partial = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(partial.quality.coverageRate, 1);
  assert.strictEqual(partial.quality.scheduleCoverageRate, 0.5);
  assert.strictEqual(partial.quality.missingScheduleMinutes, 30);
  assert(partial.quality.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'));
  assert.strictEqual(partial.metrics.observedEnergy, 4);
  assert.strictEqual(partial.metrics.assignedEnergy, 2);
  assert.strictEqual(partial.metrics.unassignedEnergy, 2);
  assert.strictEqual(partial.metrics.completeEnergy, null);

  clearShiftConfiguration(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-overlap-a' });
  const overlapDefinitionId = seedShiftDefinition(db, { version: 'quality-overlap-b' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z'
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: overlapDefinitionId,
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  const scheduleOverlap = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert(scheduleOverlap.quality.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'));
  assert.strictEqual(scheduleOverlap.metrics.observedEnergy, null);
  assert.strictEqual(scheduleOverlap.metrics.assignedEnergy, null);
  assert(scheduleOverlap.shifts.every((shift) => shift.observedEnergy === null));

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-no-data' });
  seedShiftSchedule(db, ids, { shiftDefinitionId: definitionId });
  const noData = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(noData.quality.status, 'no_data');
  assert(noData.quality.reasonCodes.includes('NO_TIMESERIES_DATA'));
  assert.strictEqual(noData.metrics.observedEnergy, null);
  assert.strictEqual(noData.metrics.completeEnergy, null);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-mixed' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:45:00.000Z'
  });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    normalizedValue: 1,
    originalValue: 1
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  insertRecord({
    startUtc: '2026-07-15T00:45:00.000Z',
    endUtc: '2026-07-15T01:45:00.000Z',
    granularityMinutes: 60,
    normalizedValue: 3,
    originalValue: 3
  });
  const mixed = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T01:45:00.000Z'
  }), { db });
  assert.strictEqual(mixed.metrics.completeEnergy, 6);
  assert.deepStrictEqual(mixed.quality.sourceGranularityMinutes, [15, 30, 60]);
  assert.strictEqual(mixed.quality.mixedSourceGranularity, true);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-source-overlap' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    endUtc: '2026-07-15T00:45:00.000Z'
  });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  const sourceOverlap = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:45:00.000Z'
  }), { db });
  assert.deepStrictEqual(sourceOverlap.quality.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
  assert.strictEqual(sourceOverlap.metrics.observedEnergy, null);
  assert.strictEqual(sourceOverlap.metrics.conservationDifference, null);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  definitionId = seedShiftDefinition(db, { version: 'quality-zero' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    endUtc: '2026-07-15T00:15:00.000Z'
  });
  insertRecord({ normalizedValue: 0, originalValue: 0 });
  const trueZero = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(trueZero.metrics.rawObservedEnergy, 0);
  assert.strictEqual(trueZero.metrics.completeEnergy, 0);
  assert.strictEqual(trueZero.metrics.roundedToZero, false);
  assert.strictEqual(trueZero.metrics.conservationDifference, 0);
  assert.strictEqual(trueZero.shifts[0].rawObservedEnergy, 0);
  assert.strictEqual(trueZero.shifts[0].observedEnergy, 0);
  assert.strictEqual(trueZero.shifts[0].roundedToZero, false);

  clearTimeseriesRecords(db);
  insertRecord({ normalizedValue: 1e-14, originalValue: 1e-14 });
  const roundedZero = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(roundedZero.metrics.completeEnergy, 0);
  assert.strictEqual(roundedZero.metrics.roundedToZero, true);
  assert.strictEqual(roundedZero.metrics.conservationDifference, 0);
  assert.strictEqual(roundedZero.shifts[0].roundedToZero, true);

  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const microFirstDefinitionId = seedShiftDefinition(db, { version: 'quality-micro-a' });
  const microSecondDefinitionId = seedShiftDefinition(db, { version: 'quality-micro-b' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: microFirstDefinitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: microSecondDefinitionId,
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z',
    granularityMinutes: 60,
    normalizedValue: 8e-13,
    originalValue: 8e-13
  });
  const microAllocation = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(microAllocation.metrics.rawObservedEnergy, 8e-13);
  assert.strictEqual(microAllocation.metrics.observedEnergy, 1e-12);
  assert.strictEqual(microAllocation.metrics.rawAssignedEnergy, 8e-13);
  assert.strictEqual(microAllocation.metrics.assignedEnergy, 1e-12);
  assert.strictEqual(microAllocation.metrics.rawUnassignedEnergy, 0);
  assert.strictEqual(microAllocation.metrics.unassignedEnergy, 0);
  assert.deepStrictEqual(microAllocation.shifts.map((shift) => ({
    rawObservedEnergy: shift.rawObservedEnergy,
    observedEnergy: shift.observedEnergy,
    roundedToZero: shift.roundedToZero,
    share: shift.share
  })), [
    { rawObservedEnergy: 4e-13, observedEnergy: 0, roundedToZero: true, share: 0.5 },
    { rawObservedEnergy: 4e-13, observedEnergy: 1e-12, roundedToZero: false, share: 0.5 }
  ]);
  assert.strictEqual(
    microAllocation.shifts.reduce((sum, shift) => sum + shift.observedEnergy, 0),
    microAllocation.metrics.assignedEnergy
  );
  assert.strictEqual(microAllocation.metrics.conservationDifference, 0);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 8e-13,
    originalValue: 8e-13
  });
  insertRecord({
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 0,
    originalValue: 0
  });
  const microAndZeroAllocation = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(microAndZeroAllocation.metrics.rawAssignedEnergy, 8e-13);
  assert.strictEqual(microAndZeroAllocation.metrics.assignedEnergy, 1e-12);
  assert.deepStrictEqual(microAndZeroAllocation.shifts.map((shift) => ({
    rawObservedEnergy: shift.rawObservedEnergy,
    observedEnergy: shift.observedEnergy,
    roundedToZero: shift.roundedToZero,
    share: shift.share
  })), [
    { rawObservedEnergy: 8e-13, observedEnergy: 1e-12, roundedToZero: false, share: 1 },
    { rawObservedEnergy: 0, observedEnergy: 0, roundedToZero: false, share: 0 }
  ]);
  assert.strictEqual(microAndZeroAllocation.metrics.conservationDifference, 0);
}

/**
 * 验证同一 identity 元数据冲突由公共函数识别并阻断对外能源结果。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftMetadataConflict(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const definitionId = seedShiftDefinition(db, {
    shiftCode: 'SHIFT-CONFLICT',
    shiftName: '冲突原始名称',
    version: 'conflict-v1'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 4, 15, 1);
  const fakeScheduleRows = [
    {
      scheduleRecordId: 1,
      shiftDefinitionId: definitionId,
      shiftCode: 'SHIFT-CONFLICT',
      shiftName: '冲突名称甲',
      version: 'conflict-v1',
      organizationUnitId: ids.organizationUnitId,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:30:00.000Z',
      sourceTimeZone: SOURCE_TIME_ZONE,
      sourceReference: 'fake:conflict:1',
      dataSource: 'manual'
    },
    {
      scheduleRecordId: 2,
      shiftDefinitionId: definitionId,
      shiftCode: 'SHIFT-CONFLICT',
      shiftName: '冲突名称乙',
      version: 'conflict-v1',
      organizationUnitId: ids.organizationUnitId,
      startUtc: '2026-07-15T00:30:00.000Z',
      endUtc: '2026-07-15T01:00:00.000Z',
      sourceTimeZone: SOURCE_TIME_ZONE,
      sourceReference: 'fake:conflict:2',
      dataSource: 'manual'
    }
  ];
  const controlledDb = {
    get inTransaction() {
      return db.inTransaction;
    },
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      if (sql.includes('FROM shift_schedule_records ssr')) {
        return { all: () => fakeScheduleRows };
      }
      return db.prepare(sql);
    }
  };
  const result = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db: controlledDb });
  assert.deepStrictEqual(result.quality.configurationErrors, [
    'SHIFT_SCHEDULE_GROUP_METADATA_CONFLICT'
  ]);
  assert.deepStrictEqual(result.quality.reasonCodes, []);
  assertApprovedShiftReasonCodes(result);
  assert.strictEqual(result.quality.status, 'shift_configuration_invalid');
  assert.strictEqual(result.quality.sufficient, false);
  assert.strictEqual(result.metrics.observedEnergy, null);
  assert.strictEqual(result.metrics.assignedEnergy, null);
  assert.strictEqual(result.metrics.completeEnergy, null);

  clearTimeseriesRecords(db);
  const noDataConfigurationError = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db: controlledDb });
  assert.deepStrictEqual(noDataConfigurationError.quality.configurationErrors, [
    'SHIFT_SCHEDULE_GROUP_METADATA_CONFLICT'
  ]);
  assert.strictEqual(noDataConfigurationError.quality.status, 'shift_configuration_invalid');
  assert.strictEqual(noDataConfigurationError.quality.sufficient, false);
  assert(noDataConfigurationError.quality.reasonCodes.includes('NO_TIMESERIES_DATA'));
  assert.strictEqual(
    noDataConfigurationError.quality.reasonCodes.includes('SHIFT_SCHEDULE_GROUP_METADATA_CONFLICT'),
    false
  );
  assertApprovedShiftReasonCodes(noDataConfigurationError);
}

/**
 * 验证班次服务事务快照、调用方事务所有权和自有连接关闭。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftTransactionAndOwnership(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const definitionId = seedShiftDefinition(db, { version: 'transaction-v1' });
  db.pragma('journal_mode = WAL');
  const competingConnection = database.openDatabase();
  const insertCompetingRecord = createTimeseriesInserter(competingConnection, ids);
  try {
    let competingWriteSucceeded = false;
    const snapshotResult = getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }), {
      db,
      testOnlyAfterShiftScope: () => {
        insertContinuousSeries(
          insertCompetingRecord,
          '2026-07-15T00:00:00.000Z',
          4,
          15,
          1
        );
        seedShiftSchedule(competingConnection, ids, { shiftDefinitionId: definitionId });
        competingWriteSucceeded = true;
      }
    });
    assert.strictEqual(competingWriteSucceeded, true);
    assert.strictEqual(snapshotResult.recordCount, 0);
    assert.strictEqual(snapshotResult.scheduleRecordCount, 0);
    assert(snapshotResult.quality.reasonCodes.includes('NO_TIMESERIES_DATA'));
    assert(snapshotResult.quality.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'));
    assert.strictEqual(db.inTransaction, false, '服务自建班次读取事务必须提交。');

    const freshResult = getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }), { db });
    assert.strictEqual(freshResult.recordCount, 4);
    assert.strictEqual(freshResult.scheduleRecordCount, 1);
    assert.strictEqual(freshResult.metrics.completeEnergy, 4);
  } finally {
    competingConnection.close();
  }

  assertEnergyAnalysisQueryFailed(() => getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), {
    db,
    testOnlyAfterShiftTimeseries: () => {
      throw new Error('controlled shift snapshot failure');
    }
  }));
  assert.strictEqual(db.inTransaction, false, '班次服务错误路径必须回滚自建事务。');

  db.exec('BEGIN DEFERRED');
  try {
    const callerResult = getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }), { db });
    assert.strictEqual(callerResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
    assertEnergyAnalysisQueryFailed(() => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }), {
      db,
      testOnlyAfterShiftSchedules: () => {
        throw new Error('caller owns shift transaction');
      }
    }));
    assert.strictEqual(db.inTransaction, true, '班次服务不得回滚调用方已有事务。');
  } finally {
    db.exec('ROLLBACK');
  }

  const callerResult = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(callerResult.meta.callerDatabaseConnection, true);
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1);

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
    const ownedResult = getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true, '班次服务自有连接必须在返回前关闭。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }
}

/**
 * 验证未知 SQLite/驱动异常统一脱敏，同时保留既有 AppError 语义。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testShiftUnknownDatabaseErrorSanitization(db, ids) {
  const originalOpenDatabase = database.openDatabase;
  let inTransaction = false;
  let beginExecuted = false;
  let rollbackExecuted = false;
  let closeExecuted = false;
  const sensitiveDriverError = new Error(
    'SQLITE_ERROR at C:\\secret\\tenant.sqlite while executing SELECT * FROM hidden'
  );
  database.openDatabase = () => ({
    get inTransaction() {
      return inTransaction;
    },
    exec(sql) {
      if (sql === 'BEGIN DEFERRED') {
        beginExecuted = true;
        inTransaction = true;
        return;
      }
      if (sql === 'ROLLBACK') {
        rollbackExecuted = true;
        inTransaction = false;
      }
    },
    prepare() {
      throw sensitiveDriverError;
    },
    close() {
      closeExecuted = true;
    }
  });
  try {
    const capturedError = assertEnergyAnalysisQueryFailed(() => (
      getShiftConsumptionAnalysis(createShiftInput({
        meterDeviceId: ids.primaryMeterId
      }))
    ));
    assert.notStrictEqual(capturedError, sensitiveDriverError);
    assert.strictEqual(beginExecuted, true, '未知查询异常前必须已开启服务自有读取事务。');
    assert.strictEqual(rollbackExecuted, true, '未知查询异常必须回滚服务自有事务。');
    assert.strictEqual(closeExecuted, true, '未知查询异常必须关闭服务自有连接。');
  } finally {
    database.openDatabase = originalOpenDatabase;
  }

  const existingAppError = assertBadRequestCode(
    () => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: 999999999
    }), { db }),
    'ENERGY_LOAD_METER_DEVICE_NOT_FOUND'
  );
  assert.strictEqual(existingAppError.code, 'BAD_REQUEST');
  assert.strictEqual(existingAppError.statusCode, 400);
  assert.strictEqual(db.inTransaction, false, '既有 AppError 路径必须回滚服务自有事务。');
}

/**
 * 验证班次服务数值溢出映射为稳定、脱敏的五百错误。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testShiftNumericOverflow(db, ids, insertRecord) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const definitionId = seedShiftDefinition(db, { version: 'overflow-v1' });
  seedShiftSchedule(db, ids, {
    shiftDefinitionId: definitionId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T02:00:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 60, 1e308);
  const error = assertAnalysisNumericOverflow(() => getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T02:00:00.000Z'
  }), { db }));
  const serializedError = JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details
  });
  assert.strictEqual(serializedError.includes(process.env.SQLITE_PATH), false);
  assert.strictEqual(serializedError.includes('SELECT'), false);
}

/**
 * 验证实际排班 50,001 条时通过 LIMIT N+1 明确拒绝，禁止静默截断。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testShiftScheduleRecordLimit(db, ids) {
  clearShiftConfiguration(db);
  clearTimeseriesRecords(db);
  const definitionId = seedShiftDefinition(db, { version: 'limit-v1' });
  db.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < ?
     )
     INSERT INTO shift_schedule_records (
       shift_definition_id, organization_unit_id, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status
     )
     SELECT ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.000Z',
            ?, 'shift-limit:' || value, 'manual', 'active'
     FROM sequence`
  ).run(
    SHIFT_SCHEDULE_QUERY_LIMIT,
    definitionId,
    ids.organizationUnitId,
    SOURCE_TIME_ZONE
  );
  assertBadRequestCode(
    () => getShiftConsumptionAnalysis(createShiftInput({
      meterDeviceId: ids.primaryMeterId
    }), { db }),
    'SHIFT_SCHEDULE_RECORD_LIMIT_EXCEEDED'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM shift_schedule_records').get().count,
    SHIFT_SCHEDULE_QUERY_LIMIT
  );

  db.prepare(
    'DELETE FROM shift_schedule_records WHERE id = (SELECT MAX(id) FROM shift_schedule_records)'
  ).run();
  const exactLimitResult = getShiftConsumptionAnalysis(createShiftInput({
    meterDeviceId: ids.primaryMeterId
  }), { db });
  assert.strictEqual(exactLimitResult.scheduleRecordCount, MAX_SHIFT_SCHEDULE_RECORDS);
  assertApprovedShiftReasonCodes(exactLimitResult);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM shift_schedule_records').get().count,
    MAX_SHIFT_SCHEDULE_RECORDS
  );
  clearShiftConfiguration(db);
}

/**
 * 验证设备状态分析输入、固定阈值与 31 天边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testDeviceStateInputValidation(db, ids) {
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  assert.strictEqual(
    DEVICE_STATE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
    'device-state-consumption-analysis:v1'
  );
  assert.strictEqual(MAX_DEVICE_STATE_RECORDS, 50000);
  assert.strictEqual(DEVICE_STATE_QUERY_LIMIT, 50001);
  const exactRange = normalizeDeviceStateConsumptionAnalysisInput(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-01-01T00:00:00.000Z',
    endUtc: '2026-02-01T00:00:00.000Z'
  }));
  assert.strictEqual(exactRange.durationMinutes, 31 * 24 * 60);
  assertBadRequestCode(
    () => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.001Z'
    }), { db }),
    'ENERGY_LOAD_TIME_RANGE_EXCEEDED'
  );
  assertBadRequestCode(
    () => normalizeDeviceStateConsumptionAnalysisInput(null),
    'INVALID_DEVICE_STATE_CONSUMPTION_ANALYSIS_INPUT'
  );
  [
    ['meterDeviceId', [ids.primaryMeterId], 'INVALID_METER_DEVICE_ID'],
    ['energyTypeCode', ['electricity'], 'INVALID_ENERGY_TYPE_CODE'],
    ['unit', { value: 'kWh' }, 'INVALID_ENERGY_UNIT'],
    ['startUtc', '2026-07-15T08:00:00+08:00', 'INVALID_START_UTC'],
    ['endUtc', { value: '2026-07-15T01:00:00.000Z' }, 'INVALID_END_UTC'],
    ['sourceTimeZone', ['Asia/Shanghai'], 'INVALID_SOURCE_TIME_ZONE']
  ].forEach(([fieldName, value, code]) => {
    assertBadRequestCode(
      () => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
        meterDeviceId: ids.primaryMeterId,
        [fieldName]: value
      }), { db }),
      code
    );
  });
  assertBadRequestCode(
    () => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      minimumCoverageRate: 0.5
    }), { db }),
    'DEVICE_STATE_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED'
  );
}

/**
 * 验证统一 fixture 的显式状态覆盖、828 空载观测值、精确过滤和只读边界。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testDeviceStateAnalysisContract(db, ids, insertRecord) {
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  insertContinuousSeries(
    insertRecord,
    '2026-07-15T00:00:00.000Z',
    96,
    15,
    (index) => 100 + index % 8
  );
  [
    ['running', '2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.000Z'],
    ['unknown', '2026-07-15T02:00:00.000Z', '2026-07-15T03:00:00.000Z'],
    ['running', '2026-07-15T03:00:00.000Z', '2026-07-15T04:00:00.000Z'],
    ['idle', '2026-07-15T04:00:00.000Z', '2026-07-15T05:00:00.000Z'],
    ['running', '2026-07-15T05:00:00.000Z', '2026-07-15T20:00:00.000Z'],
    ['stopped', '2026-07-15T20:00:00.000Z', '2026-07-15T21:00:00.000Z'],
    ['offline', '2026-07-15T21:00:00.000Z', '2026-07-15T23:00:00.000Z'],
    ['idle', '2026-07-15T23:00:00.000Z', '2026-07-16T00:00:00.000Z']
  ].forEach(([status, startUtc, endUtc]) => {
    seedDeviceState(db, ids, { status, startUtc, endUtc });
  });
  const otherOrganizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('DEVICE-STATE-OTHER-OU', '设备状态其他组织', '/设备状态其他组织', 'workshop', 'active')`
  ).run().lastInsertRowid);
  seedDeviceState(db, ids, { organizationUnitId: otherOrganizationUnitId, status: 'idle' });
  seedDeviceState(db, ids, { meterDeviceId: ids.secondaryMeterId, status: 'idle' });
  seedDeviceState(db, ids, { sourceTimeZone: 'Etc/GMT', status: 'idle' });
  seedDeviceState(db, ids, { recordStatus: 'void', status: 'idle' });
  seedDeviceState(db, ids, {
    status: 'idle',
    startUtc: '2026-07-14T22:00:00.000Z',
    endUtc: '2026-07-14T23:00:00.000Z'
  });
  insertRecord({ meterDeviceId: ids.secondaryMeterId, normalizedValue: 999, originalValue: 999 });
  insertRecord({ organizationUnitId: otherOrganizationUnitId, normalizedValue: 999, originalValue: 999 });
  insertRecord({ energyTypeId: ids.naturalGasId, normalizedValue: 999, originalValue: 999 });
  insertRecord({ normalizedUnit: 'MWh', normalizedValue: 999, originalValue: 999 });
  insertRecord({ sourceTimeZone: 'Etc/GMT', normalizedValue: 999, originalValue: 999 });
  insertRecord({ recordStatus: 'void', normalizedValue: 999, originalValue: 999 });
  insertRecord({
    startUtc: '2026-07-16T00:00:00.000Z',
    endUtc: '2026-07-16T00:15:00.000Z',
    normalizedValue: 999,
    originalValue: 999
  });

  const totalChangesBefore = db.prepare('SELECT total_changes() AS value').get().value;
  const result = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-16T00:00:00.000Z'
  }), { db });
  const totalChangesAfter = db.prepare('SELECT total_changes() AS value').get().value;
  assert.strictEqual(totalChangesAfter, totalChangesBefore, '设备状态分析必须保持零写入。');
  assert.strictEqual(result.formulaVersion, DEVICE_STATE_CONSUMPTION_ANALYSIS_FORMULA_VERSION);
  assert.strictEqual(result.recordCount, 96);
  assert.strictEqual(result.stateRecordCount, 8);
  assert.strictEqual(result.scope.organizationUnitId, ids.organizationUnitId);
  assert.strictEqual(result.quality.status, 'device_state_gap');
  assertClose(result.quality.stateCoverageRate, 23 / 24);
  assertClose(result.quality.knownStateCoverageRate, 22 / 24);
  assert.strictEqual(result.quality.idleCoverageRate, 1);
  assert.strictEqual(result.quality.explicitUnknownMinutes, 60);
  assert.strictEqual(result.quality.unmaterializedGapMinutes, 60);
  assert.strictEqual(result.metrics.rawObservedEnergy, 828);
  assert.strictEqual(result.metrics.observedEnergy, 828);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.rawShare, null);
  assert.strictEqual(result.metrics.share, null);
  assertClose(result.metrics.observedRawShare, 828 / 9936);
  assertClose(result.metrics.observedShare, 828 / 9936);
  assert.strictEqual(result.states.find((state) => state.status === 'idle').minutes, 120);
  assert.strictEqual(result.segments.some((segment) => (
    segment.status === 'unknown' && segment.materialized === false
  )), true);
  assert.deepStrictEqual(result.meta.sourceTables, [
    'energy_timeseries_records',
    'device_state_records'
  ]);
  assert.strictEqual(result.meta.readOnly, true);
  assert.strictEqual(result.meta.explicitIdleOnly, true);
  assert.strictEqual(result.meta.writesMissingStateRecords, false);
  assert.strictEqual(result.meta.estimatesEnergySavings, false);
  assert.strictEqual(result.meta.issuesControlCommand, false);
  assert.strictEqual(result.meta.writesAnalysisRunRecord, false);
  assert.strictEqual(result.meta.includesAncestorOrganizations, false);
  assert.strictEqual(result.meta.includesDescendantOrganizations, false);
  result.quality.reasonCodes.forEach((reasonCode) => {
    assert(APPROVED_REASON_CODE_SET.has(reasonCode));
  });
}

/**
 * 验证设备状态质量优先级、显式 unknown、缺口、零值、部分覆盖和混合粒度。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testDeviceStateQualityBoundaries(db, ids, insertRecord) {
  const input = createDeviceStateInput({ meterDeviceId: ids.primaryMeterId });
  const insertFullHour = (value = 1) => insertContinuousSeries(
    insertRecord,
    '2026-07-15T00:00:00.000Z',
    4,
    15,
    value
  );

  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, { status: 'unknown' });
  insertFullHour();
  let result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'explicit_unknown');
  assert.deepStrictEqual(result.quality.reasonCodes, []);
  assert.strictEqual(result.quality.stateCoverageRate, 1);
  assert.strictEqual(result.quality.knownStateCoverageRate, 0);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, 0);
  assert.strictEqual(result.metrics.observedDenominator, 4);
  assert.strictEqual(result.quality.reasonCodes.includes('DEVICE_STATE_GAP'), false);

  // 显式 unknown 与无时序组合保持 explicit_unknown 优先，且无完整窗口占比。
  clearTimeseriesRecords(db);
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'explicit_unknown');
  assert.deepStrictEqual(result.quality.reasonCodes, ['NO_TIMESERIES_DATA']);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, null);
  assert.strictEqual(result.metrics.observedDenominator, null);

  // 未物化缺口与无时序组合保持 device_state_gap 优先，不把零误报为部分空载观测。
  clearDeviceStateRecords(db);
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'device_state_gap');
  assert.deepStrictEqual(result.quality.reasonCodes, [
    'DEVICE_STATE_GAP',
    'NO_TIMESERIES_DATA'
  ]);
  assert.strictEqual(result.quality.stateCoverageRate, 0);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, null);
  assert.strictEqual(result.metrics.observedDenominator, null);

  // 未物化缺口即使具有完整时序，也不得暴露无修饰完整窗口占比。
  insertFullHour();
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'device_state_gap');
  assert.deepStrictEqual(result.quality.reasonCodes, ['DEVICE_STATE_GAP']);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, 0);
  assert.strictEqual(result.metrics.observedDenominator, 4);

  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, { status: 'running' });
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'no_data');
  assert.deepStrictEqual(result.quality.reasonCodes, ['NO_TIMESERIES_DATA']);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, 0);
  assert.strictEqual(result.metrics.complete, true);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);

  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, { status: 'idle' });
  insertFullHour(2);
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'sufficient');
  assert.deepStrictEqual(result.quality.reasonCodes, []);
  assert.strictEqual(result.metrics.observedEnergy, 8);
  assert.strictEqual(result.metrics.completeEnergy, 8);
  assert.strictEqual(result.metrics.complete, true);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, 1);
  assert.strictEqual(result.metrics.shareDenominator, 8);
  assert.strictEqual(result.metrics.observedShare, 1);
  assert.strictEqual(result.metrics.observedDenominator, 8);
  assert.strictEqual(result.quality.idleCoverageRate, 1);

  // idle 时序完整但非 idle 时序缺失时，空载 complete 可用，完整窗口 share 不可用。
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, {
    status: 'idle',
    endUtc: '2026-07-15T00:30:00.000Z'
  });
  seedDeviceState(db, ids, {
    status: 'running',
    startUtc: '2026-07-15T00:30:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 15, 2);
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'coverage_below_threshold');
  assert.deepStrictEqual(result.quality.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);
  assert.strictEqual(result.metrics.observedEnergy, 4);
  assert.strictEqual(result.metrics.completeEnergy, 4);
  assert.strictEqual(result.metrics.complete, true);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, 1);
  assert.strictEqual(result.metrics.observedDenominator, 4);
  assert.strictEqual(result.quality.idleCoverageRate, 1);

  // idle 自身时序部分覆盖时，仅返回显式部分观测口径。
  clearDeviceStateRecords(db);
  seedDeviceState(db, ids, { status: 'idle' });
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'coverage_below_threshold');
  assert.deepStrictEqual(result.quality.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);
  assert.strictEqual(result.metrics.observedEnergy, 4);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, true);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, 1);
  assert.strictEqual(result.metrics.observedDenominator, 4);
  assert.strictEqual(result.quality.idleCoverageRate, 0.5);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T01:00:00.000Z',
    endUtc: '2026-07-15T01:15:00.000Z',
    normalizedValue: 2,
    originalValue: 2
  });
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'no_data');
  assert.deepStrictEqual(result.quality.reasonCodes, ['NO_TIMESERIES_DATA']);
  assert.strictEqual(result.metrics.observedEnergy, null);
  assert.strictEqual(result.metrics.completeEnergy, null);
  assert.strictEqual(result.metrics.complete, false);
  assert.strictEqual(result.metrics.observedEnergyPartial, false);
  assert.strictEqual(result.metrics.share, null);
  assert.strictEqual(result.metrics.shareDenominator, null);
  assert.strictEqual(result.metrics.observedShare, null);
  assert.strictEqual(result.metrics.observedDenominator, null);

  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, { status: 'idle' });
  seedDeviceState(db, ids, {
    status: 'running',
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  });
  insertFullHour();
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'overlap_or_duplicate');
  assert.strictEqual(result.metrics.observedEnergy, null);

  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, { status: 'idle' });
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  result = getDeviceStateConsumptionAnalysis(input, { db });
  assert.strictEqual(result.quality.status, 'overlap_or_duplicate');

  result = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    unit: 'MWh'
  }), { db });
  assert.strictEqual(result.quality.status, 'unit_not_comparable');
  assert.strictEqual(result.metrics.observedEnergy, null);

  clearTimeseriesRecords(db);
  insertRecord({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    normalizedValue: 1,
    originalValue: 1
  });
  insertRecord({
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    normalizedValue: 2,
    originalValue: 2
  });
  insertRecord({
    startUtc: '2026-07-15T00:45:00.000Z',
    endUtc: '2026-07-15T01:45:00.000Z',
    granularityMinutes: 60,
    normalizedValue: 3,
    originalValue: 3
  });
  clearDeviceStateRecords(db);
  seedDeviceState(db, ids, {
    status: 'idle',
    endUtc: '2026-07-15T01:45:00.000Z'
  });
  result = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T01:45:00.000Z'
  }), { db });
  assert.strictEqual(result.quality.status, 'sufficient');
  assert.deepStrictEqual(result.quality.sourceGranularityMinutes, [15, 30, 60]);
  assert.strictEqual(result.metrics.completeEnergy, 6);

  clearTimeseriesRecords(db);
  clearDeviceStateRecords(db);
  seedDeviceState(db, ids, {
    status: 'idle',
    endUtc: '2026-07-15T00:15:00.000Z'
  });
  insertRecord({ normalizedValue: 0, originalValue: 0 });
  result = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(result.metrics.rawObservedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, 0);
  assert.strictEqual(result.metrics.roundedToZero, false);

  clearTimeseriesRecords(db);
  insertRecord({ normalizedValue: 4e-13, originalValue: 4e-13 });
  result = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(result.metrics.rawObservedEnergy, 4e-13);
  assert.strictEqual(result.metrics.observedEnergy, 0);
  assert.strictEqual(result.metrics.completeEnergy, 0);
  assert.strictEqual(result.metrics.roundedToZero, true);
  assert.strictEqual(result.metrics.rounding.idleEnergyObservedDifference, 4e-13);
}

/**
 * 验证设备状态记录 50000/50001 上限探针。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testDeviceStateRecordLimit(db, ids, insertRecord) {
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  insertRecord({ normalizedValue: 1, originalValue: 1 });
  db.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < ?
     )
     INSERT INTO device_state_records (
       meter_device_id, organization_unit_id, device_state, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status
     )
     SELECT ?, ?, 'idle', '2026-07-15T00:00:00.000Z', '2026-07-15T00:15:00.000Z',
            ?, 'device-state-limit:' || value, 'manual', 'active'
     FROM sequence`
  ).run(
    DEVICE_STATE_QUERY_LIMIT,
    ids.primaryMeterId,
    ids.organizationUnitId,
    SOURCE_TIME_ZONE
  );
  assertBadRequestCode(
    () => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db }),
    'DEVICE_STATE_RECORD_LIMIT_EXCEEDED'
  );
  db.prepare(
    'DELETE FROM device_state_records WHERE id = (SELECT MAX(id) FROM device_state_records)'
  ).run();
  const exactLimit = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), { db });
  assert.strictEqual(exactLimit.stateRecordCount, MAX_DEVICE_STATE_RECORDS);
  assert.strictEqual(exactLimit.quality.status, 'overlap_or_duplicate');
  clearDeviceStateRecords(db);
}

/**
 * 验证设备状态服务读取快照、连接所有权、错误脱敏和数值溢出。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {Function} insertRecord 时序写入函数。
 */
function testDeviceStateTransactionAndErrors(db, ids, insertRecord) {
  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  db.pragma('journal_mode = WAL');
  const competingConnection = database.openDatabase();
  const insertCompetingRecord = createTimeseriesInserter(competingConnection, ids);
  try {
    const snapshot = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), {
      db,
      testOnlyAfterDeviceStateScope: () => {
        insertCompetingRecord({ normalizedValue: 2, originalValue: 2 });
        seedDeviceState(competingConnection, ids, {
          status: 'idle',
          endUtc: '2026-07-15T00:15:00.000Z'
        });
      }
    });
    assert.strictEqual(snapshot.recordCount, 0);
    assert.strictEqual(snapshot.stateRecordCount, 0);
    assert.strictEqual(db.inTransaction, false);
    const fresh = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db });
    assert.strictEqual(fresh.recordCount, 1);
    assert.strictEqual(fresh.stateRecordCount, 1);
    assert.strictEqual(fresh.metrics.completeEnergy, 2);
  } finally {
    competingConnection.close();
  }

  assertEnergyAnalysisQueryFailed(() => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T00:15:00.000Z'
  }), {
    db,
    testOnlyAfterDeviceStateTimeseries: () => {
      throw new Error('controlled device state snapshot failure');
    }
  }));
  assert.strictEqual(db.inTransaction, false);

  db.exec('BEGIN DEFERRED');
  try {
    const callerResult = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), { db });
    assert.strictEqual(callerResult.meta.reusedCallerTransaction, true);
    assert.strictEqual(db.inTransaction, true);
    assertEnergyAnalysisQueryFailed(() => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }), {
      db,
      testOnlyAfterDeviceStateRecords: () => {
        throw new Error('caller owns device state transaction');
      }
    }));
    assert.strictEqual(db.inTransaction, true);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.strictEqual(db.prepare('SELECT 1 AS value').get().value, 1);

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
    const ownedResult = getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId,
      endUtc: '2026-07-15T00:15:00.000Z'
    }));
    assert.strictEqual(ownedResult.meta.callerDatabaseConnection, false);
    assert.strictEqual(ownedConnectionClosed, true);
  } finally {
    database.openDatabase = originalOpenDatabase;
  }

  let inTransaction = false;
  let rollbackExecuted = false;
  let closeExecuted = false;
  database.openDatabase = () => ({
    get inTransaction() {
      return inTransaction;
    },
    exec(sql) {
      if (sql === 'BEGIN DEFERRED') inTransaction = true;
      if (sql === 'ROLLBACK') {
        rollbackExecuted = true;
        inTransaction = false;
      }
    },
    prepare() {
      throw new Error('SQLITE_ERROR C:\\secret\\tenant.sqlite SELECT * FROM hidden');
    },
    close() {
      closeExecuted = true;
    }
  });
  try {
    assertEnergyAnalysisQueryFailed(() => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
      meterDeviceId: ids.primaryMeterId
    })));
    assert.strictEqual(rollbackExecuted, true);
    assert.strictEqual(closeExecuted, true);
  } finally {
    database.openDatabase = originalOpenDatabase;
  }

  clearDeviceStateRecords(db);
  clearTimeseriesRecords(db);
  seedDeviceState(db, ids, {
    status: 'idle',
    endUtc: '2026-07-15T02:00:00.000Z'
  });
  insertContinuousSeries(insertRecord, '2026-07-15T00:00:00.000Z', 2, 60, 1e308);
  assertAnalysisNumericOverflow(() => getDeviceStateConsumptionAnalysis(createDeviceStateInput({
    meterDeviceId: ids.primaryMeterId,
    endUtc: '2026-07-15T02:00:00.000Z'
  }), { db }));
}

let db = null;
try {
  database.initDatabase();
  db = database.openDatabase();
  const ids = seedMasterData(db);
  const insertRecord = createTimeseriesInserter(db, ids);

  testInputValidation(ids.primaryMeterId);
  testCurveInputValidation(ids.primaryMeterId);
  testFullCoverageAndExactScope(db, ids, insertRecord);
  testHalfOpenBoundary(db, ids, insertRecord);
  testMillisecondHalfOpenBoundary(db, ids, insertRecord);
  testInactiveMeterHistory(db, ids);
  testMasterDataAndInjectionSafety(db, ids);
  testNoDataAndCoverageGap(db, ids, insertRecord);
  testPartialBoundaryAllocation(db, ids, insertRecord);
  testMaxLoadEvidenceOrdering(db, ids, insertRecord);
  testMixedGranularityAndOverlap(db, ids, insertRecord);
  testUnitNotComparable(db, ids, insertRecord);
  testTrueZero(db, ids, insertRecord);
  testDatabaseOwnership(db, ids);
  testEnergyLoadCurveContract(db, ids, insertRecord);
  testEnergyLoadCurveLocalHeatmap(db, ids, insertRecord);
  testEnergyLoadCurveNumericOverflow(db, ids, insertRecord);
  testEnergyLoadCurveTransactionSnapshot(db, ids, insertRecord);
  testEnergyLoadCurveDatabaseOwnership(db, ids);
  testTimeOfUseInputValidation(db, ids);
  testTimeOfUseSchemeAndRuleValidation(db, ids, insertRecord);
  testTimeOfUseAnalysisContract(db, ids, insertRecord);
  testTimeOfUseDstAllocation(db, ids, insertRecord);
  testTimeOfUseTransactionAndOwnership(db, ids, insertRecord);
  testTimeOfUseNumericOverflow(db, ids, insertRecord);
  testTimeOfUseRuleRecordLimit(db, ids);
  testShiftInputValidation(db, ids);
  testShiftAnalysisContract(db, ids, insertRecord);
  testShiftTimeseriesOrganizationScope(db, ids, insertRecord);
  testShiftMaterializedUtcIntervals(db, ids, insertRecord);
  testShiftQualityBoundaries(db, ids, insertRecord);
  testShiftMetadataConflict(db, ids, insertRecord);
  testShiftTransactionAndOwnership(db, ids, insertRecord);
  testShiftUnknownDatabaseErrorSanitization(db, ids);
  testShiftNumericOverflow(db, ids, insertRecord);
  testShiftScheduleRecordLimit(db, ids);
  testDeviceStateInputValidation(db, ids);
  testDeviceStateAnalysisContract(db, ids, insertRecord);
  testDeviceStateQualityBoundaries(db, ids, insertRecord);
  testDeviceStateRecordLimit(db, ids, insertRecord);
  testDeviceStateTransactionAndErrors(db, ids, insertRecord);
  testRecordLimit(db, ids, insertRecord);

  const monthlyIds = seedMonthlyMasterData(db, ids);
  const insertMonthly = createMonthlyRecordInserter(db, ids, monthlyIds);
  testMonthlyInputValidation();
  testMonthlyAnalysisContract(db, ids, monthlyIds, insertMonthly);
  testMonthlyOrganizationScope(db, monthlyIds);
  testMonthlyFiltersAndNoData(db);
  testMonthlyNumericOverflow(db, monthlyIds, insertMonthly);
  testMonthlyTransactionSnapshot(db, ids, monthlyIds, insertMonthly);
  testMonthlyDatabaseOwnership(db);

  assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
  console.log('energy consumption analysis service tests passed');
} finally {
  if (db) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
