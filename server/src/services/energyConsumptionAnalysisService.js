'use strict';

const database = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const {
  ENERGY_ANALYSIS_VERSIONS,
  TIME_INTERVAL_BOUNDARY,
  TIME_OF_USE_PERIOD_TYPES,
  isIanaTimeZone,
  isStrictUtcIso,
  validateIanaTimeZone
} = require('./energyAnalysisContracts');
const {
  FIXED_UTC_OUTPUT_INTERVAL_MINUTES,
  allocateEnergyToActualShifts,
  allocateTimeOfUseEnergy,
  analyzeTimeSeriesQuality,
  buildFixedUtcLoadBuckets,
  calculateLoadMetrics,
  calculatePeakIntervalEnergy,
  calculatePeriodComparison,
  convertRatioToPercentage,
  isSupportedLocalTimeProjectionRange,
  projectFixedUtcBucketsToLocalHeatmap,
  roundAnalysisValue,
  summarizeDeviceStateCoverage
} = require('./energyAnalysisUtils');

// 负荷摘要允许查询的最大自然时长为三十一天。
const MAX_QUERY_RANGE_DAYS = 31;
// 三十一天对应的固定毫秒数，用于严格 UTC 范围校验。
const MAX_QUERY_RANGE_MS = MAX_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000;
// 单次负荷摘要允许参与计算的最大时序事实数量。
const MAX_TIMESERIES_RECORDS = 50000;
// 查询多取一条，仅用于识别超限并拒绝，禁止静默截断。
const TIMESERIES_QUERY_LIMIT = MAX_TIMESERIES_RECORDS + 1;
// 服务端固定要求完整覆盖，调用方不得降低覆盖率阈值。
const MINIMUM_COVERAGE_RATE = 1;
// 浮点交叉校验采用的绝对误差。
const ENERGY_CROSS_CHECK_TOLERANCE = 1e-9;
// 最大负荷并列证据返回上限，避免全零长序列生成过大响应。
const MAX_LOAD_EVIDENCE_LIMIT = 100;
// 月度消费分析允许查询的最少月份数。
const MIN_MONTHLY_ANALYSIS_MONTHS = 1;
// 月度消费分析允许查询的最大月份数。
const MAX_MONTHLY_ANALYSIS_MONTHS = 36;
// 月度消费分析为同比额外读取的历史月份数。
const MONTHLY_ANALYSIS_LOOKBACK_MONTHS = 12;
// 每个能源与单位分面默认返回的组织和表计数量。
const DEFAULT_MONTHLY_ANALYSIS_TOP_N = 10;
// 每个能源与单位分面允许返回的最大组织和表计数量。
const MAX_MONTHLY_ANALYSIS_TOP_N = 50;
// 月度消费分析公式版本，保持独立于时序负荷公式。
const MONTHLY_CONSUMPTION_ANALYSIS_FORMULA_VERSION = 'monthly-consumption-analysis:v1';
// 固定 UTC 负荷曲线公式版本。
const ENERGY_LOAD_CURVE_FORMULA_VERSION = 'load-curve-analysis:v1';
// 峰平谷消费分析公式版本。
const TIME_OF_USE_CONSUMPTION_ANALYSIS_FORMULA_VERSION = 'time-of-use-consumption-analysis:v1';
// 固定 UTC 负荷曲线最多返回的桶数量。
const MAX_ENERGY_LOAD_CURVE_BUCKETS = 3000;
// 单次峰平谷分析允许读取的最大规则数量。
const MAX_TOU_RULE_RECORDS = 50000;
// 峰平谷规则查询多取一条，仅用于识别超限并拒绝。
const TOU_RULE_QUERY_LIMIT = MAX_TOU_RULE_RECORDS + 1;
// 单次班次消费分析允许读取的最大实际排班记录数量。
const MAX_SHIFT_SCHEDULE_RECORDS = 50000;
// 实际排班查询多取一条，仅用于识别超限并拒绝。
const SHIFT_SCHEDULE_QUERY_LIMIT = MAX_SHIFT_SCHEDULE_RECORDS + 1;
// 班次消费分析公式版本，只消费已物化的实际 UTC 排班。
const SHIFT_CONSUMPTION_ANALYSIS_FORMULA_VERSION = 'shift-consumption-analysis:v1';
// 单次设备状态消费分析允许读取的最大显式状态记录数量。
const MAX_DEVICE_STATE_RECORDS = 50000;
// 设备状态查询多取一条，仅用于识别超限并拒绝。
const DEVICE_STATE_QUERY_LIMIT = MAX_DEVICE_STATE_RECORDS + 1;
// 设备状态消费分析公式版本，只把显式 idle 作为空载依据。
const DEVICE_STATE_CONSUMPTION_ANALYSIS_FORMULA_VERSION = 'device-state-consumption-analysis:v1';
// 设备状态输出顺序与冻结状态枚举保持一致。
const DEVICE_STATE_OUTPUT_ORDER = Object.freeze([
  'running',
  'idle',
  'stopped',
  'offline',
  'unknown'
]);
// 一分钟对应的固定毫秒数。
const MINUTE_MS = 60 * 1000;
// 本地星期英文缩写到 ISO 星期序号的映射。
const ISO_WEEKDAY_BY_SHORT_NAME = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
});
// 月份参数必须严格采用 YYYY-MM，且月份真实落在 01 至 12。
const STRICT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// 可选文本筛选拒绝引号、语句分隔、SQL 注释和控制字符。
const UNSAFE_MONTHLY_FILTER_TEXT_PATTERN = /['";]|--|\/\*|\*\/|[\x00-\x1F\x7F]/;
// 月度分析聚合出现非有限数值时使用的稳定服务端错误码。
const ANALYSIS_NUMERIC_OVERFLOW_CODE = 'ANALYSIS_NUMERIC_OVERFLOW';
// 班次分析底层查询、连接或驱动出现未知异常时使用的稳定脱敏错误码。
const ENERGY_ANALYSIS_QUERY_FAILED_CODE = 'ENERGY_ANALYSIS_QUERY_FAILED';
// 本地热力时区投影失败时使用的稳定服务端错误码。
const ANALYSIS_LOCAL_TIME_PROJECTION_FAILED_CODE = 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED';
// 查询窗口本地投影超出公元支持范围时使用的稳定输入错误码。
const ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE = 'ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED';
// 能源分析查询支持的最小公历年份，拒绝 ISO 公元 0 年进入 Intl 投影。
const MIN_SUPPORTED_ANALYSIS_YEAR = 1;

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范必填非空文本，禁止把对象或数组隐式转换为查询参数。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {string} 去除首尾空白的文本。
 */
function normalizeRequiredText(value, fieldName, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} 必须是非空字符串。`, { code, fieldName });
  }
  return value.trim();
}

/**
 * 规范正整数 ID，允许安全的十进制数字字符串但拒绝注入型文本。
 * @param {*} value 原始 ID。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {number} 正整数 ID。
 */
function normalizePositiveInteger(value, fieldName, code = 'INVALID_METER_DEVICE_ID') {
  const normalizedText = typeof value === 'number' ? String(value) : value;
  if (typeof normalizedText !== 'string' || !/^\d+$/.test(normalizedText.trim())) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code,
      fieldName
    });
  }
  const normalizedValue = Number(normalizedText.trim());
  if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code,
      fieldName
    });
  }
  return normalizedValue;
}

/**
 * 将严格 UTC 时间统一为带毫秒的 ISO 文本，避免等秒边界出现文本格式差异。
 * @param {*} value 原始 UTC 时间。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {string} 规范 UTC ISO 时间。
 */
function normalizeStrictUtc(value, fieldName, code) {
  if (!isStrictUtcIso(value)) {
    throw badRequest(`${fieldName} 必须使用严格 ISO UTC Z 格式。`, { code, fieldName });
  }
  const calendarYear = Number(value.slice(0, 4));
  if (!Number.isInteger(calendarYear) || calendarYear < MIN_SUPPORTED_ANALYSIS_YEAR) {
    throw badRequest(`${fieldName} 必须使用公历 0001 年起的严格 ISO UTC Z 格式。`, {
      code,
      fieldName,
      minimumCalendarYear: MIN_SUPPORTED_ANALYSIS_YEAR
    });
  }
  return new Date(Date.parse(value)).toISOString();
}

/**
 * 规范单表计负荷摘要输入，并冻结服务端完整覆盖阈值。
 * @param {*} input 原始输入。
 * @returns {object} 规范化查询输入。
 */
function normalizeEnergyLoadSummaryInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('负荷摘要查询参数必须是对象。', { code: 'INVALID_ENERGY_LOAD_SUMMARY_INPUT' });
  }

  const meterDeviceId = normalizePositiveInteger(input.meterDeviceId, 'meterDeviceId');
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc', 'INVALID_START_UTC');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc', 'INVALID_END_UTC');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );

  if (!isIanaTimeZone(sourceTimeZone)) {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_ENERGY_LOAD_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  if (endMs - startMs > MAX_QUERY_RANGE_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_QUERY_RANGE_DAYS} 天。`, {
      code: 'ENERGY_LOAD_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_QUERY_RANGE_DAYS
    });
  }

  if (Object.prototype.hasOwnProperty.call(input, 'minimumCoverageRate')
    && Number(input.minimumCoverageRate) !== MINIMUM_COVERAGE_RATE) {
    throw badRequest('minimumCoverageRate 由服务端固定为 1，不允许调用方降低或改写。', {
      code: 'ENERGY_LOAD_MINIMUM_COVERAGE_RATE_FIXED',
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
  }

  return {
    meterDeviceId,
    energyTypeCode,
    unit,
    startUtc,
    endUtc,
    sourceTimeZone,
    startMs,
    endMs,
    durationMinutes: (endMs - startMs) / (60 * 1000),
    minimumCoverageRate: MINIMUM_COVERAGE_RATE
  };
}

/**
 * 规范固定 UTC 负荷曲线输入，并校验 epoch 网格、范围和桶上限。
 * @param {*} input 原始输入。
 * @returns {object} 规范化曲线输入。
 */
function normalizeEnergyLoadCurveInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('负荷曲线查询参数必须是对象。', { code: 'INVALID_ENERGY_LOAD_CURVE_INPUT' });
  }

  const meterDeviceId = normalizePositiveInteger(input.meterDeviceId, 'meterDeviceId');
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc', 'INVALID_START_UTC');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc', 'INVALID_END_UTC');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );
  const sourceTimeZoneValidation = validateIanaTimeZone(sourceTimeZone);
  if (sourceTimeZoneValidation.status === 'invalid') {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }
  if (sourceTimeZoneValidation.status !== 'valid') {
    throw createLocalTimeProjectionFailedError();
  }
  const outputIntervalText = typeof input.outputIntervalMinutes === 'number'
    ? String(input.outputIntervalMinutes)
    : input.outputIntervalMinutes;
  const outputIntervalMinutes = typeof outputIntervalText === 'string'
    && /^\d+$/.test(outputIntervalText.trim())
    ? Number(outputIntervalText.trim())
    : null;
  if (!Number.isInteger(outputIntervalMinutes)
    || !FIXED_UTC_OUTPUT_INTERVAL_MINUTES.includes(outputIntervalMinutes)) {
    throw badRequest('outputIntervalMinutes 仅允许 15、30 或 60。', {
      code: 'INVALID_OUTPUT_INTERVAL_MINUTES',
      fieldName: 'outputIntervalMinutes',
      supportedValues: [...FIXED_UTC_OUTPUT_INTERVAL_MINUTES]
    });
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_ENERGY_LOAD_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  const localProjectionRange = isSupportedLocalTimeProjectionRange(
    { startUtc, endUtc },
    sourceTimeZone
  );
  if (localProjectionRange.status === 'unsupported_range') {
    throw badRequest('查询窗口超出来源时区的本地时间投影支持范围。', {
      code: ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE,
      sourceTimeZone,
      minimumCalendarYear: MIN_SUPPORTED_ANALYSIS_YEAR
    });
  }
  if (localProjectionRange.status !== 'supported') {
    throw createLocalTimeProjectionFailedError();
  }
  const intervalMs = outputIntervalMinutes * 60 * 1000;
  if (startMs % intervalMs !== 0 || endMs % intervalMs !== 0) {
    throw badRequest('查询起止时间必须对齐 UTC epoch 固定输出网格。', {
      code: 'ENERGY_LOAD_CURVE_TIME_NOT_ALIGNED',
      outputIntervalMinutes
    });
  }
  const bucketCount = (endMs - startMs) / intervalMs;
  if (bucketCount > MAX_ENERGY_LOAD_CURVE_BUCKETS) {
    throw badRequest(`固定 UTC 负荷曲线不得超过 ${MAX_ENERGY_LOAD_CURVE_BUCKETS} 个桶。`, {
      code: 'ENERGY_LOAD_CURVE_BUCKET_LIMIT_EXCEEDED',
      maximumBuckets: MAX_ENERGY_LOAD_CURVE_BUCKETS
    });
  }
  if (endMs - startMs > MAX_QUERY_RANGE_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_QUERY_RANGE_DAYS} 天。`, {
      code: 'ENERGY_LOAD_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_QUERY_RANGE_DAYS
    });
  }

  return {
    meterDeviceId,
    energyTypeCode,
    unit,
    startUtc,
    endUtc,
    sourceTimeZone,
    outputIntervalMinutes,
    startMs,
    endMs,
    durationMinutes: (endMs - startMs) / (60 * 1000),
    bucketCount
  };
}

/**
 * 规范显式单方案峰平谷消费分析输入，服务端固定完整覆盖阈值。
 * @param {*} input 原始输入。
 * @returns {object} 规范化峰平谷查询输入。
 */
function normalizeTimeOfUseConsumptionAnalysisInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('峰平谷消费分析查询参数必须是对象。', {
      code: 'INVALID_TIME_OF_USE_CONSUMPTION_ANALYSIS_INPUT'
    });
  }

  const meterDeviceId = normalizePositiveInteger(input.meterDeviceId, 'meterDeviceId');
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc', 'INVALID_START_UTC');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc', 'INVALID_END_UTC');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );
  const touSchemeId = normalizePositiveInteger(
    input.touSchemeId,
    'touSchemeId',
    'INVALID_TOU_SCHEME_ID'
  );
  const sourceTimeZoneValidation = validateIanaTimeZone(sourceTimeZone);
  if (sourceTimeZoneValidation.status === 'invalid') {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }
  if (sourceTimeZoneValidation.status !== 'valid') {
    throw createLocalTimeProjectionFailedError();
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_ENERGY_LOAD_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  if (endMs - startMs > MAX_QUERY_RANGE_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_QUERY_RANGE_DAYS} 天。`, {
      code: 'ENERGY_LOAD_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_QUERY_RANGE_DAYS
    });
  }
  const localProjectionRange = isSupportedLocalTimeProjectionRange(
    { startUtc, endUtc },
    sourceTimeZone
  );
  if (localProjectionRange.status === 'unsupported_range') {
    throw badRequest('查询窗口超出来源时区的本地时间投影支持范围。', {
      code: ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED_CODE,
      sourceTimeZone,
      minimumCalendarYear: MIN_SUPPORTED_ANALYSIS_YEAR
    });
  }
  if (localProjectionRange.status !== 'supported') {
    throw createLocalTimeProjectionFailedError();
  }
  if (Object.prototype.hasOwnProperty.call(input, 'minimumCoverageRate')) {
    throw badRequest('峰平谷分析不接受 minimumCoverageRate，完整覆盖阈值固定为 1。', {
      code: 'TIME_OF_USE_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED',
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
  }

  return {
    meterDeviceId,
    energyTypeCode,
    unit,
    startUtc,
    endUtc,
    sourceTimeZone,
    touSchemeId,
    startMs,
    endMs,
    durationMinutes: (endMs - startMs) / MINUTE_MS,
    minimumCoverageRate: MINIMUM_COVERAGE_RATE
  };
}

/**
 * 规范已物化实际排班的班次消费分析输入，服务端固定完整覆盖阈值。
 * @param {*} input 原始输入。
 * @returns {object} 规范化班次查询输入。
 */
function normalizeShiftConsumptionAnalysisInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('班次消费分析查询参数必须是对象。', {
      code: 'INVALID_SHIFT_CONSUMPTION_ANALYSIS_INPUT'
    });
  }

  const meterDeviceId = normalizePositiveInteger(input.meterDeviceId, 'meterDeviceId');
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc', 'INVALID_START_UTC');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc', 'INVALID_END_UTC');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );
  const sourceTimeZoneValidation = validateIanaTimeZone(sourceTimeZone);
  if (sourceTimeZoneValidation.status === 'invalid') {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }
  if (sourceTimeZoneValidation.status !== 'valid') {
    throw createLocalTimeProjectionFailedError();
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_ENERGY_LOAD_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  if (endMs - startMs > MAX_QUERY_RANGE_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_QUERY_RANGE_DAYS} 天。`, {
      code: 'ENERGY_LOAD_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_QUERY_RANGE_DAYS
    });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'minimumCoverageRate')) {
    throw badRequest('班次分析不接受 minimumCoverageRate，完整覆盖阈值固定为 1。', {
      code: 'SHIFT_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED',
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
  }

  return {
    meterDeviceId,
    energyTypeCode,
    unit,
    startUtc,
    endUtc,
    sourceTimeZone,
    startMs,
    endMs,
    durationMinutes: (endMs - startMs) / MINUTE_MS,
    minimumCoverageRate: MINIMUM_COVERAGE_RATE
  };
}

/**
 * 规范显式设备状态消费分析输入，服务端固定完整覆盖阈值。
 * @param {*} input 原始输入。
 * @returns {object} 规范化设备状态查询输入。
 */
function normalizeDeviceStateConsumptionAnalysisInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('设备状态消费分析查询参数必须是对象。', {
      code: 'INVALID_DEVICE_STATE_CONSUMPTION_ANALYSIS_INPUT'
    });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'minimumCoverageRate')) {
    throw badRequest('设备状态分析不接受 minimumCoverageRate，完整覆盖阈值固定为 1。', {
      code: 'DEVICE_STATE_MINIMUM_COVERAGE_RATE_NOT_ACCEPTED',
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
  }

  const meterDeviceId = normalizePositiveInteger(input.meterDeviceId, 'meterDeviceId');
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc', 'INVALID_START_UTC');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc', 'INVALID_END_UTC');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );
  const sourceTimeZoneValidation = validateIanaTimeZone(sourceTimeZone);
  if (sourceTimeZoneValidation.status === 'invalid') {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }
  if (sourceTimeZoneValidation.status !== 'valid') {
    throw createLocalTimeProjectionFailedError();
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_ENERGY_LOAD_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  if (endMs - startMs > MAX_QUERY_RANGE_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_QUERY_RANGE_DAYS} 天。`, {
      code: 'ENERGY_LOAD_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_QUERY_RANGE_DAYS
    });
  }

  return {
    meterDeviceId,
    energyTypeCode,
    unit,
    startUtc,
    endUtc,
    sourceTimeZone,
    startMs,
    endMs,
    durationMinutes: (endMs - startMs) / MINUTE_MS,
    minimumCoverageRate: MINIMUM_COVERAGE_RATE
  };
}

/**
 * 查询并校验能源类型与表计主数据是否存在，不以当前启停状态过滤历史事实。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范查询输入。
 * @returns {object} 主数据范围事实。
 */
function resolveLoadSummaryScope(db, normalizedInput) {
  const energyType = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE code = ?`
  ).get(normalizedInput.energyTypeCode);
  if (!energyType) {
    throw badRequest('指定能源类型不存在。', {
      code: 'ENERGY_LOAD_ENERGY_TYPE_NOT_FOUND',
      energyTypeCode: normalizedInput.energyTypeCode
    });
  }

  const meterDevice = db.prepare(
    `SELECT id, meter_code AS meterCode, meter_name AS meterName,
            energy_type_id AS energyTypeId, organization_unit_id AS organizationUnitId,
            status
     FROM meter_devices
     WHERE id = ?`
  ).get(normalizedInput.meterDeviceId);
  if (!meterDevice) {
    throw badRequest('指定计量器具不存在。', {
      code: 'ENERGY_LOAD_METER_DEVICE_NOT_FOUND',
      meterDeviceId: normalizedInput.meterDeviceId
    });
  }

  return {
    energyType,
    meterDevice,
    comparable: Number(meterDevice.energyTypeId) === Number(energyType.id)
      && normalizedInput.unit === energyType.standardUnit
  };
}

/**
 * 读取精确数据流内与统计窗口相交的 active 时序事实。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范查询输入。
 * @param {object} scope 主数据范围事实。
 * @param {object} options 可选精确组织范围；缺省保持既有分析契约。
 * @returns {object[]} 最多 50001 条原始查询行。
 */
function queryLoadSummaryRows(db, normalizedInput, scope, options = {}) {
  const normalizedOptions = isPlainObject(options) ? options : {};
  const requiresExactOrganization = Object.prototype.hasOwnProperty.call(
    normalizedOptions,
    'organizationUnitId'
  );
  const organizationPredicate = requiresExactOrganization
    ? '\n       AND etr.organization_unit_id = @organizationUnitId'
    : '';
  const queryParameters = {
    meterDeviceId: normalizedInput.meterDeviceId,
    energyTypeId: scope.energyType.id,
    unit: normalizedInput.unit,
    sourceTimeZone: normalizedInput.sourceTimeZone,
    startUtc: normalizedInput.startUtc,
    endUtc: normalizedInput.endUtc
  };
  if (requiresExactOrganization) {
    queryParameters.organizationUnitId = normalizedOptions.organizationUnitId;
  }
  return db.prepare(
    `SELECT etr.id,
            etr.source_batch_id AS sourceBatchId,
            etr.source_row_number AS sourceRowNumber,
            etr.start_utc AS startUtc,
            etr.end_utc AS endUtc,
            etr.source_timezone AS sourceTimeZone,
            etr.granularity_minutes AS granularityMinutes,
            etr.normalized_unit AS normalizedUnit,
            etr.normalized_value AS normalizedValue,
            etr.source_reference AS sourceReference,
            etr.data_source AS dataSource
     FROM energy_timeseries_records etr
     WHERE etr.record_status = 'active'
       AND etr.meter_device_id = @meterDeviceId
       AND etr.energy_type_id = @energyTypeId
       AND etr.normalized_unit = @unit
       AND etr.source_timezone = @sourceTimeZone${organizationPredicate}
       AND julianday(etr.start_utc) < julianday(@endUtc)
       AND julianday(etr.end_utc) > julianday(@startUtc)
     ORDER BY etr.start_utc ASC, etr.end_utc ASC, etr.id ASC
     LIMIT ${TIMESERIES_QUERY_LIMIT}`
  ).all(queryParameters);
}

/**
 * 将数据库事实映射为公共计算层冻结的时序记录结构。
 * @param {object[]} rows 数据库行。
 * @param {object} normalizedInput 规范查询输入。
 * @returns {object[]} 公共计算记录。
 */
function mapRowsToCalculationRecords(rows, normalizedInput) {
  return rows.map((row) => ({
    id: `energy-timeseries:${row.id}`,
    sourceReference: row.sourceReference,
    energyTypeCode: normalizedInput.energyTypeCode,
    unit: row.normalizedUnit,
    value: Number(row.normalizedValue),
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    sourceTimeZone: row.sourceTimeZone,
    granularityMinutes: Number(row.granularityMinutes)
  }));
}

/**
 * 读取表计所属精确组织范围内与窗口相交的 active 实际排班，多取一条识别超限。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范查询输入。
 * @param {object} scope 表计与能源主数据范围。
 * @returns {object[]} 最多 50001 条实际排班行。
 */
function queryActualShiftScheduleRows(db, normalizedInput, scope) {
  return db.prepare(
    `SELECT ssr.id AS scheduleRecordId,
            ssr.shift_definition_id AS shiftDefinitionId,
            sd.shift_code AS shiftCode,
            sd.shift_name AS shiftName,
            sd.version,
            ssr.organization_unit_id AS organizationUnitId,
            ssr.start_utc AS startUtc,
            ssr.end_utc AS endUtc,
            ssr.source_timezone AS sourceTimeZone,
            ssr.source_reference AS sourceReference,
            ssr.data_source AS dataSource
     FROM shift_schedule_records ssr
     JOIN shift_definitions sd ON sd.id = ssr.shift_definition_id
     WHERE ssr.record_status = 'active'
       AND ((@organizationUnitId IS NULL AND ssr.organization_unit_id IS NULL)
         OR ssr.organization_unit_id = @organizationUnitId)
       AND ssr.source_timezone = @sourceTimeZone
       AND sd.source_timezone = @sourceTimeZone
       AND julianday(ssr.start_utc) < julianday(@endUtc)
       AND julianday(ssr.end_utc) > julianday(@startUtc)
     ORDER BY ssr.start_utc ASC, ssr.end_utc ASC, ssr.id ASC
     LIMIT ${SHIFT_SCHEDULE_QUERY_LIMIT}`
  ).all({
    organizationUnitId: scope.meterDevice.organizationUnitId,
    sourceTimeZone: normalizedInput.sourceTimeZone,
    startUtc: normalizedInput.startUtc,
    endUtc: normalizedInput.endUtc
  });
}

/**
 * 将数据库实际排班映射为公共计算层冻结的 UTC 排班结构。
 * @param {object[]} rows 实际排班数据库行。
 * @returns {object[]} 公共计算排班记录。
 */
function mapRowsToActualShiftSchedules(rows) {
  return rows.map((row) => ({
    scheduleRecordId: Number(row.scheduleRecordId),
    shiftDefinitionId: Number(row.shiftDefinitionId),
    shiftCode: row.shiftCode,
    shiftName: row.shiftName,
    version: row.version,
    organizationUnitId: row.organizationUnitId === null ? null : Number(row.organizationUnitId),
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    sourceTimeZone: row.sourceTimeZone,
    sourceReference: row.sourceReference,
    dataSource: row.dataSource
  }));
}

/**
 * 读取单表计、精确组织和来源时区内与窗口相交的 active 显式设备状态。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范查询输入。
 * @param {object} scope 表计与能源主数据范围。
 * @returns {object[]} 最多 50001 条设备状态行。
 */
function queryDeviceStateRows(db, normalizedInput, scope) {
  return db.prepare(
    `SELECT dsr.id AS stateRecordId,
            dsr.source_batch_id AS sourceBatchId,
            dsr.source_row_number AS sourceRowNumber,
            dsr.meter_device_id AS meterDeviceId,
            dsr.organization_unit_id AS organizationUnitId,
            dsr.device_state AS deviceState,
            dsr.start_utc AS startUtc,
            dsr.end_utc AS endUtc,
            dsr.source_timezone AS sourceTimeZone,
            dsr.source_reference AS sourceReference,
            dsr.data_source AS dataSource
     FROM device_state_records dsr
     WHERE dsr.record_status = 'active'
       AND dsr.meter_device_id = @meterDeviceId
       AND ((@organizationUnitId IS NULL AND dsr.organization_unit_id IS NULL)
         OR dsr.organization_unit_id = @organizationUnitId)
       AND dsr.source_timezone = @sourceTimeZone
       AND julianday(dsr.start_utc) < julianday(@endUtc)
       AND julianday(dsr.end_utc) > julianday(@startUtc)
     ORDER BY dsr.start_utc ASC, dsr.end_utc ASC, dsr.id ASC
     LIMIT ${DEVICE_STATE_QUERY_LIMIT}`
  ).all({
    meterDeviceId: normalizedInput.meterDeviceId,
    organizationUnitId: scope.meterDevice.organizationUnitId,
    sourceTimeZone: normalizedInput.sourceTimeZone,
    startUtc: normalizedInput.startUtc,
    endUtc: normalizedInput.endUtc
  });
}

/**
 * 将数据库设备状态行映射为公共纯函数消费的显式状态区间。
 * @param {object[]} rows 设备状态数据库行。
 * @returns {object[]} 公共计算状态记录。
 */
function mapRowsToDeviceStateRecords(rows) {
  return rows.map((row) => ({
    stateRecordId: Number(row.stateRecordId),
    status: row.deviceState,
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    sourceTimeZone: row.sourceTimeZone,
    sourceReference: row.sourceReference,
    dataSource: row.dataSource
  }));
}

/**
 * 按显式 ID 读取单个峰平谷方案，不自动绑定或猜测其他方案。
 * @param {object} db SQLite 连接。
 * @param {number} touSchemeId 峰平谷方案 ID。
 * @returns {object|null} 峰平谷方案行。
 */
function queryExplicitTimeOfUseScheme(db, touSchemeId) {
  return db.prepare(
    `SELECT id,
            scheme_code AS schemeCode,
            scheme_name AS schemeName,
            source_timezone AS sourceTimeZone,
            source,
            document_no AS documentNo,
            version,
            effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc,
            status
     FROM tou_schemes
     WHERE id = ?`
  ).get(touSchemeId) || null;
}

/**
 * 校验显式峰平谷方案的状态、来源时区和完整有效期范围。
 * @param {object|null} scheme 峰平谷方案行。
 * @param {object} normalizedInput 规范查询输入。
 */
function validateExplicitTimeOfUseScheme(scheme, normalizedInput) {
  if (!scheme) {
    throw badRequest('指定峰平谷方案不存在。', {
      code: 'TOU_SCHEME_NOT_FOUND',
      touSchemeId: normalizedInput.touSchemeId
    });
  }
  if (scheme.status !== 'active') {
    throw badRequest('指定峰平谷方案未启用。', {
      code: 'TOU_SCHEME_INACTIVE',
      touSchemeId: normalizedInput.touSchemeId
    });
  }
  if (scheme.sourceTimeZone !== normalizedInput.sourceTimeZone) {
    throw badRequest('峰平谷方案来源时区与查询来源时区不一致。', {
      code: 'TOU_SCHEME_TIME_ZONE_MISMATCH',
      touSchemeId: normalizedInput.touSchemeId
    });
  }
  const effectiveRangeValid = isStrictUtcIso(scheme.effectiveStartUtc)
    && isStrictUtcIso(scheme.effectiveEndUtc)
    && Date.parse(scheme.effectiveStartUtc) < Date.parse(scheme.effectiveEndUtc);
  if (!effectiveRangeValid
    || normalizedInput.startMs < Date.parse(scheme.effectiveStartUtc)
    || normalizedInput.endMs > Date.parse(scheme.effectiveEndUtc)) {
    throw badRequest('查询窗口必须完整落在峰平谷方案有效期内。', {
      code: 'TOU_SCHEME_NOT_EFFECTIVE_FOR_RANGE',
      touSchemeId: normalizedInput.touSchemeId
    });
  }
  if (typeof scheme.schemeCode !== 'string' || scheme.schemeCode.trim() === ''
    || typeof scheme.version !== 'string' || scheme.version.trim() === '') {
    throw badRequest('峰平谷方案规则集结构无效。', {
      code: 'TOU_RULE_SET_INVALID',
      touSchemeId: normalizedInput.touSchemeId
    });
  }
}

/**
 * 查询显式方案的全部峰平谷规则，多取一条用于识别记录上限。
 * @param {object} db SQLite 连接。
 * @param {number} touSchemeId 峰平谷方案 ID。
 * @returns {object[]} 峰平谷规则行。
 */
function queryTimeOfUseRuleRows(db, touSchemeId) {
  return db.prepare(
    `SELECT id,
            tou_scheme_id AS touSchemeId,
            day_of_week AS dayOfWeek,
            period_type AS periodType,
            start_minute AS startMinute,
            end_minute AS endMinute
     FROM tou_period_rules
     WHERE tou_scheme_id = ?
     ORDER BY day_of_week ASC, start_minute ASC, end_minute ASC, id ASC
     LIMIT ${TOU_RULE_QUERY_LIMIT}`
  ).all(touSchemeId);
}

/**
 * 解析查询窗口实际涉及的来源时区 ISO 星期集合。
 * @param {object} normalizedInput 规范查询输入。
 * @returns {Set<number>} 查询实际涉及的 ISO 星期集合。
 */
function collectInvolvedLocalIsoWeekdays(normalizedInput) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: normalizedInput.sourceTimeZone,
      weekday: 'short'
    });
  } catch (_error) {
    throw createLocalTimeProjectionFailedError();
  }
  const involvedDays = new Set();
  const firstMinuteStartMs = Math.floor(normalizedInput.startMs / MINUTE_MS) * MINUTE_MS;
  try {
    for (
      let minuteStartMs = firstMinuteStartMs;
      minuteStartMs < normalizedInput.endMs;
      minuteStartMs += MINUTE_MS
    ) {
      const weekdayPart = formatter.formatToParts(new Date(minuteStartMs))
        .find((part) => part.type === 'weekday');
      const isoWeekday = weekdayPart ? ISO_WEEKDAY_BY_SHORT_NAME[weekdayPart.value] : null;
      if (!isoWeekday) {
        throw new Error('无法解析本地 ISO 星期。');
      }
      involvedDays.add(isoWeekday);
    }
  } catch (_error) {
    throw createLocalTimeProjectionFailedError();
  }
  return involvedDays;
}

/**
 * 从数据库规则行构造并冻结完整单方案 ruleSet，同时校验涉及星期全天无缺口和重叠。
 * @param {object} scheme 已通过状态与有效期校验的方案。
 * @param {object[]} ruleRows 数据库规则行。
 * @param {Set<number>} involvedDays 查询实际涉及的 ISO 星期集合。
 * @returns {object} 冻结的完整单方案规则集。
 */
function buildTimeOfUseRuleSet(scheme, ruleRows, involvedDays) {
  if (ruleRows.length === 0) {
    throw badRequest('峰平谷方案规则集为空。', {
      code: 'TOU_RULE_SET_EMPTY',
      touSchemeId: Number(scheme.id)
    });
  }
  if (ruleRows.length > MAX_TOU_RULE_RECORDS) {
    throw badRequest(`峰平谷规则超过 ${MAX_TOU_RULE_RECORDS} 条。`, {
      code: 'TOU_RULE_RECORD_LIMIT_EXCEEDED',
      maximumRecords: MAX_TOU_RULE_RECORDS
    });
  }

  const periodsByIsoWeekday = {};
  let validRecordShape = true;
  ruleRows.forEach((row) => {
    const dayOfWeek = Number(row.dayOfWeek);
    const startMinute = Number(row.startMinute);
    const endMinute = Number(row.endMinute);
    if (!Number.isSafeInteger(Number(row.id))
      || Number(row.id) <= 0
      || Number(row.touSchemeId) !== Number(scheme.id)
      || !Number.isInteger(dayOfWeek)
      || dayOfWeek < 1
      || dayOfWeek > 7
      || !TIME_OF_USE_PERIOD_TYPES.includes(row.periodType)
      || !Number.isInteger(startMinute)
      || startMinute < 0
      || startMinute > 1439
      || !Number.isInteger(endMinute)
      || endMinute < 1
      || endMinute > 1440
      || startMinute >= endMinute) {
      validRecordShape = false;
      return;
    }
    if (!periodsByIsoWeekday[dayOfWeek]) periodsByIsoWeekday[dayOfWeek] = [];
    periodsByIsoWeekday[dayOfWeek].push(Object.freeze({
      type: row.periodType,
      startMinute,
      endMinute
    }));
  });

  let involvedDaysFullyCovered = involvedDays.size > 0;
  involvedDays.forEach((dayOfWeek) => {
    const periods = periodsByIsoWeekday[dayOfWeek] || [];
    let cursorMinute = 0;
    periods.forEach((period) => {
      if (period.startMinute !== cursorMinute) involvedDaysFullyCovered = false;
      cursorMinute = Math.max(cursorMinute, period.endMinute);
    });
    if (periods.length === 0 || cursorMinute !== 1440) involvedDaysFullyCovered = false;
  });
  if (!validRecordShape || !involvedDaysFullyCovered) {
    throw badRequest('峰平谷规则必须按实际涉及星期全天唯一覆盖，且跨午夜必须拆分为多行。', {
      code: 'TOU_RULE_SET_INVALID',
      touSchemeId: Number(scheme.id)
    });
  }

  Object.keys(periodsByIsoWeekday).forEach((dayOfWeek) => {
    periodsByIsoWeekday[dayOfWeek] = Object.freeze(periodsByIsoWeekday[dayOfWeek]);
  });
  return Object.freeze({
    schemeId: Number(scheme.id),
    code: scheme.schemeCode.trim(),
    version: scheme.version.trim(),
    sourceTimeZone: scheme.sourceTimeZone,
    effectiveStartUtc: new Date(Date.parse(scheme.effectiveStartUtc)).toISOString(),
    effectiveEndUtc: new Date(Date.parse(scheme.effectiveEndUtc)).toISOString(),
    periodsByIsoWeekday: Object.freeze(periodsByIsoWeekday)
  });
}

/**
 * 推导能源量对应的负荷单位，常见电量单位直接转换为功率单位。
 * @param {string|null} energyUnit 能源量单位。
 * @returns {string|null} 负荷单位。
 */
function resolveLoadUnit(energyUnit) {
  const directUnits = Object.freeze({ Wh: 'W', kWh: 'kW', MWh: 'MW', GWh: 'GW' });
  if (typeof energyUnit !== 'string' || energyUnit.trim() === '') {
    return null;
  }
  return directUnits[energyUnit] || `${energyUnit}/h`;
}

/**
 * 统计与查询窗口边界相交但未完整落窗的记录数量。
 * @param {object[]} records 公共计算记录。
 * @param {object} normalizedInput 规范查询输入。
 * @returns {number} 部分边界记录数。
 */
function countPartialBoundaryRecords(records, normalizedInput) {
  return records.filter((record) => (
    Date.parse(record.startUtc) < normalizedInput.startMs
    || Date.parse(record.endUtc) > normalizedInput.endMs
  )).length;
}

/**
 * 对两个权威公共计算入口的能源量执行交叉校验。
 * @param {number|null} loadTotal 负荷指标计算能源量。
 * @param {number|null} peakCovered 峰值入口覆盖能源量。
 */
function assertEnergyCalculationConsistency(loadTotal, peakCovered) {
  if (!Number.isFinite(loadTotal) || !Number.isFinite(peakCovered)) {
    return;
  }
  if (Math.abs(loadTotal - peakCovered) > ENERGY_CROSS_CHECK_TOLERANCE) {
    throw new Error('能源负荷公共计算结果交叉校验失败。');
  }
}

/**
 * 合并并保持阶段 1 冻结顺序的数据质量原因码。
 * @param {string[][]} reasonCodeGroups 原因码分组。
 * @returns {string[]} 去重原因码。
 */
function mergeReasonCodes(...reasonCodeGroups) {
  return [...new Set(reasonCodeGroups.flat().filter(Boolean))];
}

/**
 * 根据事实数量与冻结原因码生成稳定质量状态。
 * @param {number} recordCount 查询记录数。
 * @param {string[]} reasonCodes 原因码。
 * @returns {string} 质量状态。
 */
function resolveQualityStatus(recordCount, reasonCodes) {
  if (recordCount === 0 || reasonCodes.includes('NO_TIMESERIES_DATA')) return 'no_data';
  if (reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')) return 'overlap_or_duplicate';
  if (reasonCodes.includes('MIXED_INTERVAL_GRANULARITY')) return 'mixed_interval_granularity';
  if (reasonCodes.includes('UNIT_NOT_COMPARABLE')) return 'unit_not_comparable';
  if (reasonCodes.includes('COVERAGE_BELOW_THRESHOLD')) return 'coverage_below_threshold';
  return 'sufficient';
}

/**
 * 构造峰值区间摘要；峰值只接受完整落在窗口内的粒度记录。
 * @param {object} peakResult 公共峰值计算结果。
 * @param {string|null} loadUnit 负荷单位。
 * @returns {object} 峰值摘要。
 */
function buildPeakIntervalSummary(peakResult, loadUnit) {
  const primaryInterval = peakResult.peakIntervals[0] || null;
  const peakEnergy = Number.isFinite(peakResult.peakIntervalEnergy)
    ? peakResult.peakIntervalEnergy
    : null;
  const peakLoad = peakEnergy !== null && Number.isFinite(peakResult.granularityMinutes)
    ? roundAnalysisValue(peakEnergy * 60 / peakResult.granularityMinutes)
    : null;
  return {
    metricCode: 'peak_interval_energy',
    candidateRule: 'fully_inside_window_only',
    startUtc: primaryInterval ? primaryInterval.startUtc : null,
    endUtc: primaryInterval ? primaryInterval.endUtc : null,
    energy: peakEnergy,
    energyUnit: peakResult.sourceUnit || null,
    averageLoad: peakLoad,
    loadUnit: peakLoad === null ? null : loadUnit,
    tiedIntervalCount: peakResult.peakIntervalCount,
    intervals: peakResult.peakIntervals,
    evidence: peakResult.evidence,
    evidenceTruncated: peakResult.evidenceTruncated,
    reasonCodes: peakResult.reasonCodes
  };
}

/**
 * 将一条相交源记录构造成最大负荷候选证据。
 * @param {object} record 公共计算记录。
 * @param {object} normalizedInput 规范查询输入。
 * @param {string|null} loadUnit 负荷单位。
 * @returns {object|null} 最大负荷候选证据。
 */
function buildMaxLoadCandidate(record, normalizedInput, loadUnit) {
  const sourceStartMs = Date.parse(record.startUtc);
  const sourceEndMs = Date.parse(record.endUtc);
  const sourceDurationMinutes = (sourceEndMs - sourceStartMs) / (60 * 1000);
  const overlapStartMs = Math.max(sourceStartMs, normalizedInput.startMs);
  const overlapEndMs = Math.min(sourceEndMs, normalizedInput.endMs);
  if (!Number.isFinite(record.value)
    || !Number.isFinite(sourceDurationMinutes)
    || sourceDurationMinutes <= 0
    || overlapStartMs >= overlapEndMs) {
    return null;
  }

  return {
    metricCode: 'max_load',
    startUtc: new Date(overlapStartMs).toISOString(),
    endUtc: new Date(overlapEndMs).toISOString(),
    overlapMinutes: roundAnalysisValue((overlapEndMs - overlapStartMs) / (60 * 1000)),
    partialOverlap: sourceStartMs < normalizedInput.startMs || sourceEndMs > normalizedInput.endMs,
    sourceInterval: {
      startUtc: new Date(sourceStartMs).toISOString(),
      endUtc: new Date(sourceEndMs).toISOString(),
      durationMinutes: roundAnalysisValue(sourceDurationMinutes)
    },
    sourceEnergy: {
      value: roundAnalysisValue(record.value),
      unit: record.unit
    },
    averageLoad: roundAnalysisValue(record.value * 60 / sourceDurationMinutes),
    loadUnit,
    evidenceReference: record.id || record.sourceReference || null
  };
}

/**
 * 按负荷降序和源区间字面顺序稳定排列最大负荷候选。
 * @param {object} left 左候选。
 * @param {object} right 右候选。
 * @returns {number} 排序结果。
 */
function compareMaxLoadCandidates(left, right) {
  if (left.averageLoad !== right.averageLoad) {
    return right.averageLoad - left.averageLoad;
  }
  const sourceStartComparison = left.sourceInterval.startUtc.localeCompare(right.sourceInterval.startUtc);
  if (sourceStartComparison !== 0) return sourceStartComparison;
  const sourceEndComparison = left.sourceInterval.endUtc.localeCompare(right.sourceInterval.endUtc);
  if (sourceEndComparison !== 0) return sourceEndComparison;
  return String(left.evidenceReference || '').localeCompare(String(right.evidenceReference || ''));
}

/**
 * 构造与公共 maxLoad 同口径的源记录证据，边界裁剪不稀释源区间负荷。
 * @param {object[]} records 公共计算记录。
 * @param {object} normalizedInput 规范查询输入。
 * @param {number|null} maxLoad 公共计算最大负荷。
 * @param {string|null} loadUnit 负荷单位。
 * @param {string[]} reasonCodes 当前质量原因码。
 * @returns {object} 最大负荷区间摘要。
 */
function buildMaxLoadIntervalSummary(
  records,
  normalizedInput,
  maxLoad,
  loadUnit,
  reasonCodes
) {
  const unavailableSummary = {
    metricCode: 'max_load',
    startUtc: null,
    endUtc: null,
    overlapMinutes: null,
    partialOverlap: null,
    sourceInterval: null,
    sourceEnergy: null,
    averageLoad: null,
    loadUnit: null,
    evidenceReference: null,
    tiedIntervalCount: 0,
    intervals: [],
    evidence: [],
    evidenceTruncated: false,
    reasonCodes
  };
  if (!Number.isFinite(maxLoad)) {
    return unavailableSummary;
  }

  const sortedCandidates = records
    .map((record) => buildMaxLoadCandidate(record, normalizedInput, loadUnit))
    .filter(Boolean)
    .sort(compareMaxLoadCandidates);
  const tiedCandidates = sortedCandidates.filter((candidate) => candidate.averageLoad === maxLoad);
  const primaryCandidate = tiedCandidates[0] || null;
  if (!primaryCandidate) {
    return unavailableSummary;
  }
  const returnedCandidates = tiedCandidates.slice(0, MAX_LOAD_EVIDENCE_LIMIT);

  return {
    ...primaryCandidate,
    tiedIntervalCount: tiedCandidates.length,
    intervals: returnedCandidates.map((candidate) => ({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      overlapMinutes: candidate.overlapMinutes,
      partialOverlap: candidate.partialOverlap,
      sourceInterval: candidate.sourceInterval,
      sourceEnergy: candidate.sourceEnergy,
      averageLoad: candidate.averageLoad,
      loadUnit: candidate.loadUnit,
      evidenceReference: candidate.evidenceReference
    })),
    evidence: returnedCandidates.map((candidate) => candidate.evidenceReference),
    evidenceTruncated: tiedCandidates.length > returnedCandidates.length,
    reasonCodes: []
  };
}

/**
 * 构造单表计、单能源、单单位时序负荷摘要。
 * @param {object} input 查询范围和数据流范围。
 * @param {object} options 可注入调用方 SQLite 连接。
 * @returns {object} 稳定负荷摘要契约。
 */
function getEnergyLoadSummary(input, options = {}) {
  const normalizedInput = normalizeEnergyLoadSummaryInput(input);
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;

  try {
    const scope = resolveLoadSummaryScope(db, normalizedInput);
    const rows = queryLoadSummaryRows(db, normalizedInput, scope);
    if (rows.length > MAX_TIMESERIES_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_TIMESERIES_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_TIMESERIES_RECORDS
      });
    }

    const records = mapRowsToCalculationRecords(rows, normalizedInput);
    const windowInterval = {
      startUtc: normalizedInput.startUtc,
      endUtc: normalizedInput.endUtc,
      sourceTimeZone: normalizedInput.sourceTimeZone
    };
    const baseQuality = analyzeTimeSeriesQuality(records, windowInterval);
    const loadMetrics = calculateLoadMetrics(records, windowInterval, {
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
    const peakResult = calculatePeakIntervalEnergy(records, windowInterval, {
      minimumCoverageRate: MINIMUM_COVERAGE_RATE
    });
    const scopeReasonCodes = scope.comparable ? [] : ['UNIT_NOT_COMPARABLE'];
    const qualityReasonCodes = mergeReasonCodes(
      baseQuality.reasonCodes,
      loadMetrics.reasonCodes,
      scopeReasonCodes
    );
    const partialBoundaryRecordCount = countPartialBoundaryRecords(records, normalizedInput);
    const granularities = [...new Set(records.map((record) => record.granularityMinutes))];
    const granularityMinutes = granularities.length === 1 ? granularities[0] : null;
    const loadUnit = resolveLoadUnit(normalizedInput.unit);
    const calculationAllowed = scope.comparable;

    if (calculationAllowed) {
      assertEnergyCalculationConsistency(loadMetrics.totalEnergy, peakResult.coveredEnergy);
    }

    const observedEnergy = calculationAllowed && Number.isFinite(peakResult.coveredEnergy)
      ? peakResult.coveredEnergy
      : null;
    const completeCoverage = calculationAllowed
      && baseQuality.coverageRate === MINIMUM_COVERAGE_RATE
      && baseQuality.reasonCodes.length === 0
      && Number.isFinite(peakResult.totalEnergy);
    const totalEnergy = completeCoverage ? peakResult.totalEnergy : null;
    const averageLoad = calculationAllowed ? loadMetrics.averageLoad : null;
    const maxLoad = calculationAllowed ? loadMetrics.maxLoad : null;
    const loadRate = calculationAllowed ? loadMetrics.loadRate : null;
    const loadRateCalculable = calculationAllowed && loadMetrics.loadRateCalculable === true;
    const loadRateReason = calculationAllowed ? loadMetrics.loadRateReason : null;
    const maxLoadInterval = buildMaxLoadIntervalSummary(
      baseQuality.validRecords,
      normalizedInput,
      maxLoad,
      loadUnit,
      qualityReasonCodes
    );
    const peakInterval = calculationAllowed
      ? buildPeakIntervalSummary(peakResult, loadUnit)
      : buildPeakIntervalSummary({
        ...peakResult,
        peakIntervalEnergy: null,
        peakIntervals: [],
        peakIntervalCount: 0,
        evidence: [],
        evidenceTruncated: false,
        reasonCodes: mergeReasonCodes(peakResult.reasonCodes, ['UNIT_NOT_COMPARABLE'])
      }, loadUnit);

    return {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: ENERGY_ANALYSIS_VERSIONS.loadAnalysis,
      scope: {
        meterDeviceId: normalizedInput.meterDeviceId,
        meterCode: scope.meterDevice.meterCode,
        meterName: scope.meterDevice.meterName,
        meterStatus: scope.meterDevice.status,
        organizationUnitId: scope.meterDevice.organizationUnitId,
        energyTypeId: scope.energyType.id,
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyTypeActive: Number(scope.energyType.isActive) === 1,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        durationMinutes: normalizedInput.durationMinutes,
        intervalConvention: TIME_INTERVAL_BOUNDARY
      },
      granularityMinutes,
      recordCount: rows.length,
      quality: {
        status: resolveQualityStatus(rows.length, qualityReasonCodes),
        sufficient: qualityReasonCodes.length === 0,
        coverageRate: baseQuality.coverageRate,
        coveredMinutes: baseQuality.coveredMinutes || 0,
        expectedMinutes: baseQuality.windowMinutes,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        partialBoundaryRecordCount,
        hasPartialBoundaryRecords: partialBoundaryRecordCount > 0,
        reasonCodes: qualityReasonCodes
      },
      metrics: {
        observedEnergy,
        observedEnergyPartial: observedEnergy !== null
          && (baseQuality.coverageRate < 1 || partialBoundaryRecordCount > 0),
        totalEnergy,
        totalEnergyComplete: totalEnergy !== null,
        energyUnit: normalizedInput.unit,
        averageLoad,
        maxLoad,
        loadUnit: averageLoad === null && maxLoad === null ? null : loadUnit,
        loadRate,
        loadRatePercent: convertRatioToPercentage(loadRate),
        loadRateCalculable,
        loadRateReason
      },
      maxLoadInterval,
      peakInterval,
      meta: {
        sourceTable: 'energy_timeseries_records',
        recordStatus: 'active',
        exactScopeFields: [
          'meter_device_id',
          'energy_type_id',
          'normalized_unit',
          'source_timezone'
        ],
        overlapPredicate: 'start_utc < endUtc AND end_utc > startUtc',
        allocationAssumption: 'uniform_within_interval',
        peakCandidateRule: 'fully_inside_window_only',
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        maximumRangeDays: MAX_QUERY_RANGE_DAYS,
        maximumRecords: MAX_TIMESERIES_RECORDS,
        queryLimit: TIMESERIES_QUERY_LIMIT,
        monthlyEnergyRecordsRead: false,
        callerDatabaseConnection: callerDatabase !== null
      }
    };
  } finally {
    if (shouldCloseDatabase) {
      db.close();
    }
  }
}

/**
 * 查询固定 UTC 负荷曲线，并从同一组 UTC 桶直接投影 IANA 本地热力。
 * @param {object} input 单表计、单能源、单单位、单来源时区与固定网格输入。
 * @param {object} options 可注入调用方 SQLite 连接与仅测试快照钩子。
 * @returns {object} 固定 UTC 桶与本地热力结果。
 */
function getEnergyLoadCurve(input, options = {}) {
  const normalizedInput = normalizeEnergyLoadCurveInput(input);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const callerDatabase = normalizedOptions.db || null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  const shouldOwnReadTransaction = db.inTransaction !== true;
  const afterScopeTestHook = typeof normalizedOptions.testOnlyAfterLoadCurveScope === 'function'
    ? normalizedOptions.testOnlyAfterLoadCurveScope
    : null;
  const afterQueryTestHook = typeof normalizedOptions.testOnlyAfterLoadCurveQuery === 'function'
    ? normalizedOptions.testOnlyAfterLoadCurveQuery
    : null;
  let ownedReadTransactionActive = false;

  try {
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }
    const scope = resolveLoadSummaryScope(db, normalizedInput);
    if (afterScopeTestHook) afterScopeTestHook();
    const rows = queryLoadSummaryRows(db, normalizedInput, scope);
    if (rows.length > MAX_TIMESERIES_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_TIMESERIES_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_TIMESERIES_RECORDS
      });
    }
    if (afterQueryTestHook) afterQueryTestHook();

    const records = mapRowsToCalculationRecords(rows, normalizedInput);
    const windowInterval = {
      startUtc: normalizedInput.startUtc,
      endUtc: normalizedInput.endUtc,
      sourceTimeZone: normalizedInput.sourceTimeZone
    };
    const curveResult = buildFixedUtcLoadBuckets(
      records,
      windowInterval,
      normalizedInput.outputIntervalMinutes
    );
    if (curveResult.numericOverflow) {
      throw createAnalysisNumericOverflowError();
    }

    const scopeReasonCodes = scope.comparable ? [] : ['UNIT_NOT_COMPARABLE'];
    const qualityReasonCodes = mergeReasonCodes(curveResult.reasonCodes, scopeReasonCodes);
    const loadUnit = resolveLoadUnit(normalizedInput.unit);
    const outputBuckets = curveResult.buckets.map((bucket) => {
      const bucketCalculable = scope.comparable && bucket.energy !== null;
      return {
        ...bucket,
        energy: bucketCalculable ? bucket.energy : null,
        energyUnit: normalizedInput.unit,
        averageLoad: bucketCalculable ? bucket.averageLoad : null,
        loadUnit: bucketCalculable ? loadUnit : null,
        observationMode: scope.comparable ? bucket.observationMode : 'unavailable'
      };
    });
    let localHeatmap = null;
    try {
      localHeatmap = projectFixedUtcBucketsToLocalHeatmap(
        outputBuckets,
        normalizedInput.sourceTimeZone
      );
    } catch (_projectionError) {
      throw createLocalTimeProjectionFailedError();
    }
    if (!Array.isArray(localHeatmap) || localHeatmap.length !== outputBuckets.length) {
      throw createLocalTimeProjectionFailedError();
    }
    const calculationAllowed = scope.comparable
      && !qualityReasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE');
    const observedEnergy = calculationAllowed ? curveResult.observedEnergy : null;
    const totalEnergy = calculationAllowed ? curveResult.totalEnergy : null;
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: ENERGY_LOAD_CURVE_FORMULA_VERSION,
      scope: {
        meterDeviceId: normalizedInput.meterDeviceId,
        meterCode: scope.meterDevice.meterCode,
        meterName: scope.meterDevice.meterName,
        meterStatus: scope.meterDevice.status,
        organizationUnitId: scope.meterDevice.organizationUnitId,
        energyTypeId: scope.energyType.id,
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyTypeActive: Number(scope.energyType.isActive) === 1,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        durationMinutes: normalizedInput.durationMinutes,
        outputIntervalMinutes: normalizedInput.outputIntervalMinutes,
        bucketCount: normalizedInput.bucketCount,
        intervalConvention: TIME_INTERVAL_BOUNDARY,
        gridAlignment: 'utc_epoch'
      },
      recordCount: rows.length,
      buckets: outputBuckets,
      localHeatmap,
      quality: {
        status: resolveQualityStatus(rows.length, qualityReasonCodes),
        sufficient: qualityReasonCodes.length === 0,
        coverageRate: curveResult.coverageRate,
        coveredMinutes: curveResult.coveredMinutes,
        expectedMinutes: curveResult.expectedMinutes,
        sourceGranularityMinutes: curveResult.sourceGranularityMinutes,
        mixedSourceGranularity: curveResult.mixedSourceGranularity,
        allocationUsed: curveResult.allocationUsed,
        observationModes: curveResult.observationModes,
        reasonCodes: qualityReasonCodes
      },
      metrics: {
        observedEnergy,
        observedEnergyPartial: observedEnergy !== null && curveResult.coverageRate < 1,
        roundedBucketTotal: calculationAllowed && Number.isFinite(curveResult.roundedBucketTotal)
          ? curveResult.roundedBucketTotal
          : null,
        totalEnergy,
        totalEnergyComplete: totalEnergy !== null && curveResult.totalEnergyComplete,
        conservationDifference: calculationAllowed ? curveResult.conservationDifference : null,
        energyUnit: normalizedInput.unit,
        loadUnit
      },
      meta: {
        sourceTable: 'energy_timeseries_records',
        recordStatus: 'active',
        exactScopeFields: [
          'meter_device_id',
          'energy_type_id',
          'normalized_unit',
          'source_timezone'
        ],
        overlapPredicate: 'start_utc < endUtc AND end_utc > startUtc',
        allocationAssumption: 'uniform_within_interval',
        heatmapProjectionSource: 'fixed_utc_buckets',
        maximumRangeDays: MAX_QUERY_RANGE_DAYS,
        maximumBuckets: MAX_ENERGY_LOAD_CURVE_BUCKETS,
        maximumRecords: MAX_TIMESERIES_RECORDS,
        queryLimit: TIMESERIES_QUERY_LIMIT,
        monthlyEnergyRecordsRead: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction
      }
    };

    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db.inTransaction === true) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 保留原始错误，连接关闭或调用方负责最终资源回收。
      }
      ownedReadTransactionActive = false;
    }
    throw error;
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

/**
 * 查询显式单方案峰平谷消费分析，并在同一 SQLite 读取快照内解析全部事实与配置。
 * @param {object} input 单表计、单能源、单单位、单来源时区和显式方案输入。
 * @param {object} options 可注入调用方 SQLite 连接与仅测试快照钩子。
 * @returns {object} 稳定峰平谷消费分析契约。
 */
function getTimeOfUseConsumptionAnalysis(input, options = {}) {
  const normalizedInput = normalizeTimeOfUseConsumptionAnalysisInput(input);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const callerDatabase = normalizedOptions.db || null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  const shouldOwnReadTransaction = db.inTransaction !== true;
  const afterScopeTestHook = typeof normalizedOptions.testOnlyAfterTimeOfUseScope === 'function'
    ? normalizedOptions.testOnlyAfterTimeOfUseScope
    : null;
  const afterTimeseriesTestHook = typeof normalizedOptions.testOnlyAfterTimeOfUseTimeseries === 'function'
    ? normalizedOptions.testOnlyAfterTimeOfUseTimeseries
    : null;
  const afterSchemeTestHook = typeof normalizedOptions.testOnlyAfterTimeOfUseScheme === 'function'
    ? normalizedOptions.testOnlyAfterTimeOfUseScheme
    : null;
  let ownedReadTransactionActive = false;

  try {
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }

    const scope = resolveLoadSummaryScope(db, normalizedInput);
    if (afterScopeTestHook) afterScopeTestHook();
    const rows = queryLoadSummaryRows(db, normalizedInput, scope);
    if (rows.length > MAX_TIMESERIES_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_TIMESERIES_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_TIMESERIES_RECORDS
      });
    }
    if (afterTimeseriesTestHook) afterTimeseriesTestHook();

    const scheme = queryExplicitTimeOfUseScheme(db, normalizedInput.touSchemeId);
    validateExplicitTimeOfUseScheme(scheme, normalizedInput);
    if (afterSchemeTestHook) afterSchemeTestHook();
    const ruleRows = queryTimeOfUseRuleRows(db, normalizedInput.touSchemeId);
    const involvedDays = collectInvolvedLocalIsoWeekdays(normalizedInput);
    const ruleSet = buildTimeOfUseRuleSet(scheme, ruleRows, involvedDays);
    const records = mapRowsToCalculationRecords(rows, normalizedInput);
    const windowInterval = {
      startUtc: normalizedInput.startUtc,
      endUtc: normalizedInput.endUtc,
      sourceTimeZone: normalizedInput.sourceTimeZone
    };
    const allocationResult = allocateTimeOfUseEnergy(records, windowInterval, ruleSet, {
      expectedEnergyScope: {
        energyTypeCode: normalizedInput.energyTypeCode,
        normalizedUnit: normalizedInput.unit
      }
    });
    if (allocationResult.numericOverflow) {
      throw createAnalysisNumericOverflowError();
    }
    if (allocationResult.configurationErrors.length > 0) {
      throw badRequest('峰平谷规则集无法应用于当前查询窗口。', {
        code: 'TOU_RULE_SET_INVALID',
        touSchemeId: normalizedInput.touSchemeId
      });
    }
    const expectedPeriodMinutes = allocationResult.periods.reduce(
      (sum, period) => sum + period.expectedMinutes,
      0
    );
    if (!Number.isFinite(expectedPeriodMinutes)
      || Math.abs(expectedPeriodMinutes - normalizedInput.durationMinutes) > 1e-9) {
      throw createLocalTimeProjectionFailedError();
    }

    const scopeReasonCodes = scope.comparable ? [] : ['UNIT_NOT_COMPARABLE'];
    const qualityReasonCodes = mergeReasonCodes(allocationResult.reasonCodes, scopeReasonCodes);
    const calculationAllowed = scope.comparable
      && !qualityReasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')
      && !qualityReasonCodes.includes('UNIT_NOT_COMPARABLE');
    const partialBoundaryRecordCount = countPartialBoundaryRecords(records, normalizedInput);
    const periods = allocationResult.periods.map((period) => ({
      type: period.type,
      observed: calculationAllowed ? period.observed : null,
      complete: calculationAllowed ? period.complete : null,
      roundedToZero: calculationAllowed ? period.roundedToZero : null,
      share: calculationAllowed ? period.share : null,
      energyUnit: normalizedInput.unit,
      expectedMinutes: period.expectedMinutes,
      coveredMinutes: period.coveredMinutes,
      coverageRate: period.coverageRate
    }));
    const observedEnergy = calculationAllowed ? allocationResult.observed : null;
    const totalEnergy = calculationAllowed ? allocationResult.totalEnergy : null;
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: TIME_OF_USE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
      scope: {
        meterDeviceId: normalizedInput.meterDeviceId,
        meterCode: scope.meterDevice.meterCode,
        meterName: scope.meterDevice.meterName,
        meterStatus: scope.meterDevice.status,
        organizationUnitId: scope.meterDevice.organizationUnitId,
        energyTypeId: scope.energyType.id,
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyTypeActive: Number(scope.energyType.isActive) === 1,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        durationMinutes: normalizedInput.durationMinutes,
        intervalConvention: TIME_INTERVAL_BOUNDARY
      },
      scheme: {
        id: Number(scheme.id),
        code: scheme.schemeCode,
        name: scheme.schemeName,
        version: scheme.version,
        sourceTimeZone: scheme.sourceTimeZone,
        source: scheme.source,
        documentNo: scheme.documentNo,
        status: scheme.status,
        effectiveStartUtc: new Date(Date.parse(scheme.effectiveStartUtc)).toISOString(),
        effectiveEndUtc: new Date(Date.parse(scheme.effectiveEndUtc)).toISOString(),
        adoptedRange: allocationResult.adoptedRange,
        ruleRecordCount: ruleRows.length
      },
      applicability: {
        selectionMode: 'explicit_tou_scheme_id',
        meterBindingVerified: false,
        authoritativeTariffConfirmed: false
      },
      recordCount: rows.length,
      quality: {
        status: resolveQualityStatus(rows.length, qualityReasonCodes),
        sufficient: qualityReasonCodes.length === 0,
        coverageRate: allocationResult.coverageRate,
        coveredMinutes: allocationResult.coveredMinutes,
        expectedMinutes: allocationResult.expectedMinutes,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        sourceGranularityMinutes: allocationResult.sourceGranularityMinutes,
        mixedSourceGranularity: allocationResult.mixedSourceGranularity,
        allocationUsed: allocationResult.allocationUsed,
        partialBoundaryRecordCount,
        hasPartialBoundaryRecords: partialBoundaryRecordCount > 0,
        reasonCodes: qualityReasonCodes
      },
      metrics: {
        observedEnergy,
        roundedToZero: calculationAllowed ? allocationResult.roundedToZero : null,
        observedEnergyPartial: observedEnergy !== null
          && (allocationResult.coverageRate < 1 || partialBoundaryRecordCount > 0),
        totalEnergy,
        totalEnergyComplete: totalEnergy !== null && allocationResult.totalEnergyComplete,
        conservationDifference: calculationAllowed
          ? allocationResult.conservationDifference
          : null,
        energyUnit: normalizedInput.unit
      },
      periods,
      meta: {
        sourceTables: ['energy_timeseries_records', 'tou_schemes', 'tou_period_rules'],
        recordStatus: 'active',
        exactScopeFields: [
          'meter_device_id',
          'energy_type_id',
          'normalized_unit',
          'source_timezone'
        ],
        overlapPredicate: 'start_utc < endUtc AND end_utc > startUtc',
        allocationAssumption: allocationResult.allocationAssumption,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        maximumRangeDays: MAX_QUERY_RANGE_DAYS,
        maximumTimeseriesRecords: MAX_TIMESERIES_RECORDS,
        timeseriesQueryLimit: TIMESERIES_QUERY_LIMIT,
        maximumRuleRecords: MAX_TOU_RULE_RECORDS,
        ruleQueryLimit: TOU_RULE_QUERY_LIMIT,
        explicitSchemeSelectionRequired: true,
        automaticSchemeBinding: false,
        readOnly: true,
        usesAI: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        writesAnalysisRunRecord: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction,
        readTransactionMode: shouldOwnReadTransaction
          ? 'service_owned_begin_deferred'
          : 'caller_owned_reused'
      }
    };

    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db.inTransaction === true) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 保留原始错误，连接关闭或调用方负责最终资源回收。
      }
      ownedReadTransactionActive = false;
    }
    throw error;
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

/**
 * 根据班次事实数量与原因码生成稳定质量状态。
 * @param {number} recordCount 时序事实数量。
 * @param {string[]} reasonCodes 原因码。
 * @param {string[]} configurationErrors 排班配置错误。
 * @returns {string} 班次分析质量状态。
 */
function resolveShiftQualityStatus(recordCount, reasonCodes, configurationErrors) {
  if (configurationErrors.length > 0) return 'shift_configuration_invalid';
  if (recordCount === 0 || reasonCodes.includes('NO_TIMESERIES_DATA')) return 'no_data';
  if (reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')) return 'overlap_or_duplicate';
  if (reasonCodes.includes('UNIT_NOT_COMPARABLE')) return 'unit_not_comparable';
  if (reasonCodes.includes('MISSING_SHIFT_SCHEDULE')) return 'missing_shift_schedule';
  if (reasonCodes.includes('COVERAGE_BELOW_THRESHOLD')) return 'coverage_below_threshold';
  return 'sufficient';
}

/**
 * 查询已物化实际排班的班次能耗分析，并在同一 SQLite 读取快照内解析全部事实。
 * @param {object} input 单表计、单能源、单单位、单来源时区输入。
 * @param {object} options 可注入调用方 SQLite 连接与仅测试快照钩子。
 * @returns {object} 稳定班次能耗分析契约。
 */
function getShiftConsumptionAnalysis(input, options = {}) {
  const normalizedInput = normalizeShiftConsumptionAnalysisInput(input);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const callerDatabase = normalizedOptions.db || null;
  const shouldCloseDatabase = callerDatabase === null;
  const afterScopeTestHook = typeof normalizedOptions.testOnlyAfterShiftScope === 'function'
    ? normalizedOptions.testOnlyAfterShiftScope
    : null;
  const afterTimeseriesTestHook = typeof normalizedOptions.testOnlyAfterShiftTimeseries === 'function'
    ? normalizedOptions.testOnlyAfterShiftTimeseries
    : null;
  const afterSchedulesTestHook = typeof normalizedOptions.testOnlyAfterShiftSchedules === 'function'
    ? normalizedOptions.testOnlyAfterShiftSchedules
    : null;
  let db = null;
  let shouldOwnReadTransaction = false;
  let ownedReadTransactionActive = false;
  let operationError = null;

  try {
    db = callerDatabase || database.openDatabase();
    shouldOwnReadTransaction = db.inTransaction !== true;
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }

    const scope = resolveLoadSummaryScope(db, normalizedInput);
    if (afterScopeTestHook) afterScopeTestHook();
    const rows = queryLoadSummaryRows(db, normalizedInput, scope, {
      organizationUnitId: scope.meterDevice.organizationUnitId
    });
    if (rows.length > MAX_TIMESERIES_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_TIMESERIES_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_TIMESERIES_RECORDS
      });
    }
    if (afterTimeseriesTestHook) afterTimeseriesTestHook();
    const scheduleRows = queryActualShiftScheduleRows(db, normalizedInput, scope);
    if (scheduleRows.length > MAX_SHIFT_SCHEDULE_RECORDS) {
      throw badRequest(`匹配实际排班记录超过 ${MAX_SHIFT_SCHEDULE_RECORDS} 条，请缩小查询范围。`, {
        code: 'SHIFT_SCHEDULE_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_SHIFT_SCHEDULE_RECORDS
      });
    }
    if (afterSchedulesTestHook) afterSchedulesTestHook();

    const records = mapRowsToCalculationRecords(rows, normalizedInput);
    const schedules = mapRowsToActualShiftSchedules(scheduleRows);
    const windowInterval = {
      startUtc: normalizedInput.startUtc,
      endUtc: normalizedInput.endUtc,
      sourceTimeZone: normalizedInput.sourceTimeZone
    };
    const allocationResult = allocateEnergyToActualShifts(
      records,
      windowInterval,
      schedules,
      {
        expectedEnergyScope: {
          energyTypeCode: normalizedInput.energyTypeCode,
          normalizedUnit: normalizedInput.unit
        }
      }
    );
    if (allocationResult.numericOverflow) {
      throw createAnalysisNumericOverflowError();
    }

    const scopeReasonCodes = scope.comparable ? [] : ['UNIT_NOT_COMPARABLE'];
    const qualityReasonCodes = mergeReasonCodes(
      allocationResult.reasonCodes,
      scopeReasonCodes
    );
    const calculationAllowed = scope.comparable
      && allocationResult.configurationErrors.length === 0
      && !qualityReasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')
      && !qualityReasonCodes.includes('UNIT_NOT_COMPARABLE');
    const scheduleCoverageRate = allocationResult.expectedMinutes === null
      ? null
      : roundAnalysisValue(allocationResult.assignedMinutes / allocationResult.expectedMinutes);
    if (scheduleCoverageRate !== null && !Number.isFinite(scheduleCoverageRate)) {
      throw createAnalysisNumericOverflowError();
    }
    const rawObservedEnergy = calculationAllowed ? allocationResult.rawObservedEnergy : null;
    const observedEnergy = calculationAllowed ? allocationResult.observedEnergy : null;
    const rawAssignedEnergy = calculationAllowed ? allocationResult.rawAssignedEnergy : null;
    const assignedEnergy = calculationAllowed ? allocationResult.assignedEnergy : null;
    const rawUnassignedEnergy = calculationAllowed ? allocationResult.rawUnassignedEnergy : null;
    const unassignedEnergy = calculationAllowed ? allocationResult.unassignedEnergy : null;
    const completeEnergy = calculationAllowed ? allocationResult.complete : null;
    const roundedToZero = calculationAllowed ? allocationResult.roundedToZero : null;
    const shifts = allocationResult.allocations.map((allocation) => ({
      shiftDefinitionId: allocation.shiftDefinitionId,
      version: allocation.version,
      code: allocation.shiftCode,
      name: allocation.shiftName,
      rawObservedEnergy: calculationAllowed ? allocation.rawObserved : null,
      observedEnergy: calculationAllowed ? allocation.observed : null,
      completeEnergy: calculationAllowed ? allocation.complete : null,
      roundedToZero: calculationAllowed ? allocation.roundedToZero : null,
      share: calculationAllowed ? allocation.share : null,
      energyUnit: normalizedInput.unit,
      expectedMinutes: allocation.expectedMinutes,
      coveredMinutes: allocation.coveredMinutes,
      coverageRate: allocation.coverageRate
    }));
    const partialBoundaryRecordCount = countPartialBoundaryRecords(records, normalizedInput);
    const qualityStatus = resolveShiftQualityStatus(
      rows.length,
      qualityReasonCodes,
      allocationResult.configurationErrors
    );
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: SHIFT_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
      scope: {
        meterDeviceId: normalizedInput.meterDeviceId,
        meterCode: scope.meterDevice.meterCode,
        meterName: scope.meterDevice.meterName,
        meterStatus: scope.meterDevice.status,
        organizationUnitId: scope.meterDevice.organizationUnitId,
        energyTypeId: scope.energyType.id,
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyTypeActive: Number(scope.energyType.isActive) === 1,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        durationMinutes: normalizedInput.durationMinutes,
        intervalConvention: TIME_INTERVAL_BOUNDARY
      },
      recordCount: rows.length,
      scheduleRecordCount: scheduleRows.length,
      quality: {
        status: qualityStatus,
        sufficient: qualityStatus === 'sufficient',
        coverageRate: allocationResult.coverageRate,
        coveredMinutes: allocationResult.coveredMinutes,
        expectedMinutes: allocationResult.expectedMinutes,
        scheduleCoverageRate,
        scheduledMinutes: allocationResult.assignedMinutes,
        missingScheduleMinutes: allocationResult.unassignedMinutes,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        sourceGranularityMinutes: allocationResult.sourceGranularityMinutes,
        mixedSourceGranularity: allocationResult.mixedSourceGranularity,
        allocationUsed: allocationResult.allocationUsed,
        partialBoundaryRecordCount,
        hasPartialBoundaryRecords: partialBoundaryRecordCount > 0,
        configurationErrors: allocationResult.configurationErrors,
        reasonCodes: qualityReasonCodes
      },
      metrics: {
        rawObservedEnergy,
        observedEnergy,
        roundedToZero,
        observedEnergyPartial: observedEnergy !== null
          && (allocationResult.coverageRate < 1 || partialBoundaryRecordCount > 0),
        rawAssignedEnergy,
        assignedEnergy,
        rawUnassignedEnergy,
        unassignedEnergy,
        completeEnergy,
        complete: completeEnergy !== null,
        conservationDifference: calculationAllowed
          ? allocationResult.conservationDifference
          : null,
        energyUnit: normalizedInput.unit
      },
      shifts,
      meta: {
        sourceTables: [
          'energy_timeseries_records',
          'shift_schedule_records',
          'shift_definitions'
        ],
        recordStatus: 'active',
        scheduleRecordStatus: 'active',
        exactScopeFields: [
          'meter_device_id',
          'organization_unit_id',
          'energy_type_id',
          'normalized_unit',
          'source_timezone'
        ],
        exactScheduleScopeFields: [
          'organization_unit_id',
          'source_timezone'
        ],
        overlapPredicate: 'start_utc < endUtc AND end_utc > startUtc',
        shiftGroupingIdentity: ['shift_definition_id', 'version'],
        scheduleExpansionMode: 'materialized_utc_intervals_only',
        generatesSchedulesFromWallClock: false,
        includesAncestorOrganizations: false,
        includesDescendantOrganizations: false,
        allocationAssumption: allocationResult.allocationAssumption,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        maximumRangeDays: MAX_QUERY_RANGE_DAYS,
        maximumTimeseriesRecords: MAX_TIMESERIES_RECORDS,
        timeseriesQueryLimit: TIMESERIES_QUERY_LIMIT,
        maximumScheduleRecords: MAX_SHIFT_SCHEDULE_RECORDS,
        scheduleQueryLimit: SHIFT_SCHEDULE_QUERY_LIMIT,
        readOnly: true,
        usesAI: false,
        generatesPolicyHit: false,
        estimatesEnergySavings: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        writesAnalysisRunRecord: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction,
        readTransactionMode: shouldOwnReadTransaction
          ? 'service_owned_begin_deferred'
          : 'caller_owned_reused'
      }
    };

    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 回滚异常不得覆盖原始业务错误或泄露底层数据库详情。
      }
      ownedReadTransactionActive = false;
    }
    operationError = error instanceof AppError
      ? error
      : createEnergyAnalysisQueryFailedError();
    throw operationError;
  } finally {
    if (shouldCloseDatabase && db) {
      try {
        db.close();
      } catch (_closeError) {
        if (!operationError) {
          throw createEnergyAnalysisQueryFailedError();
        }
      }
    }
  }
}

/**
 * 按冻结优先级解析设备状态消费分析质量状态。
 * @param {number} recordCount 时序事实数量。
 * @param {object} stateSummary 公共设备状态覆盖摘要。
 * @param {string[]} reasonCodes 冻结原因码。
 * @returns {string} 稳定质量状态。
 */
function resolveDeviceStateQualityStatus(recordCount, stateSummary, reasonCodes) {
  if (reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')) return 'overlap_or_duplicate';
  if (reasonCodes.includes('UNIT_NOT_COMPARABLE')) return 'unit_not_comparable';
  if (reasonCodes.includes('DEVICE_STATE_GAP')) return 'device_state_gap';
  if (stateSummary.explicitUnknownMinutes > 0) return 'explicit_unknown';
  if (recordCount === 0 || reasonCodes.includes('NO_TIMESERIES_DATA')) return 'no_data';
  if (reasonCodes.includes('COVERAGE_BELOW_THRESHOLD')) return 'coverage_below_threshold';
  return 'sufficient';
}

/**
 * 查询显式设备状态与 idle 空载能耗，并在同一 SQLite 读取快照内解析全部事实。
 * @param {object} input 单表计、单能源、单单位、单来源时区输入。
 * @param {object} options 可注入调用方 SQLite 连接与仅测试快照钩子。
 * @returns {object} 稳定设备状态消费分析契约。
 */
function getDeviceStateConsumptionAnalysis(input, options = {}) {
  const normalizedInput = normalizeDeviceStateConsumptionAnalysisInput(input);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const callerDatabase = normalizedOptions.db || null;
  const shouldCloseDatabase = callerDatabase === null;
  const afterScopeTestHook = typeof normalizedOptions.testOnlyAfterDeviceStateScope === 'function'
    ? normalizedOptions.testOnlyAfterDeviceStateScope
    : null;
  const afterTimeseriesTestHook = typeof normalizedOptions.testOnlyAfterDeviceStateTimeseries === 'function'
    ? normalizedOptions.testOnlyAfterDeviceStateTimeseries
    : null;
  const afterStatesTestHook = typeof normalizedOptions.testOnlyAfterDeviceStateRecords === 'function'
    ? normalizedOptions.testOnlyAfterDeviceStateRecords
    : null;
  let db = null;
  let shouldOwnReadTransaction = false;
  let ownedReadTransactionActive = false;
  let operationError = null;

  try {
    db = callerDatabase || database.openDatabase();
    shouldOwnReadTransaction = db.inTransaction !== true;
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }

    const scope = resolveLoadSummaryScope(db, normalizedInput);
    if (afterScopeTestHook) afterScopeTestHook();
    const rows = queryLoadSummaryRows(db, normalizedInput, scope, {
      organizationUnitId: scope.meterDevice.organizationUnitId
    });
    if (rows.length > MAX_TIMESERIES_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_TIMESERIES_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_LOAD_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_TIMESERIES_RECORDS
      });
    }
    if (afterTimeseriesTestHook) afterTimeseriesTestHook();
    const stateRows = queryDeviceStateRows(db, normalizedInput, scope);
    if (stateRows.length > MAX_DEVICE_STATE_RECORDS) {
      throw badRequest(`匹配设备状态记录超过 ${MAX_DEVICE_STATE_RECORDS} 条，请缩小查询范围。`, {
        code: 'DEVICE_STATE_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_DEVICE_STATE_RECORDS
      });
    }
    if (afterStatesTestHook) afterStatesTestHook();

    const records = mapRowsToCalculationRecords(rows, normalizedInput);
    const stateRecords = mapRowsToDeviceStateRecords(stateRows);
    const windowInterval = {
      startUtc: normalizedInput.startUtc,
      endUtc: normalizedInput.endUtc,
      sourceTimeZone: normalizedInput.sourceTimeZone
    };
    const stateSummary = summarizeDeviceStateCoverage(
      windowInterval,
      stateRecords,
      records,
      {
        expectedEnergyScope: {
          energyTypeCode: normalizedInput.energyTypeCode,
          normalizedUnit: normalizedInput.unit
        }
      }
    );
    if (stateSummary.numericOverflow) {
      throw createAnalysisNumericOverflowError();
    }

    const timeseriesQuality = analyzeTimeSeriesQuality(records, windowInterval);
    const applicableTimeseriesReasonCodes = [
      ...timeseriesQuality.reasonCodes.filter((reasonCode) => (
        reasonCode === 'NO_TIMESERIES_DATA'
        || reasonCode === 'SOURCE_OVERLAP_OR_DUPLICATE'
        || reasonCode === 'UNIT_NOT_COMPARABLE'
      )),
      ...(rows.length > 0 && timeseriesQuality.coverageRate < MINIMUM_COVERAGE_RATE
        ? ['COVERAGE_BELOW_THRESHOLD']
        : [])
    ];
    const scopeReasonCodes = scope.comparable ? [] : ['UNIT_NOT_COMPARABLE'];
    const qualityReasonCodes = mergeReasonCodes(
      stateSummary.reasonCodes,
      applicableTimeseriesReasonCodes,
      scopeReasonCodes
    );
    const calculationAllowed = scope.comparable
      && !qualityReasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')
      && !qualityReasonCodes.includes('UNIT_NOT_COMPARABLE');
    const qualityStatus = resolveDeviceStateQualityStatus(
      rows.length,
      stateSummary,
      qualityReasonCodes
    );
    const partialBoundaryRecordCount = countPartialBoundaryRecords(records, normalizedInput);
    const observedEnergy = calculationAllowed ? stateSummary.idleEnergyObserved : null;
    const completeEnergy = calculationAllowed ? stateSummary.idleEnergyComplete : null;
    const rawObservedEnergy = calculationAllowed ? stateSummary.raw.idleEnergyObserved : null;
    const rawCompleteEnergy = calculationAllowed ? stateSummary.raw.idleEnergyComplete : null;
    const states = DEVICE_STATE_OUTPUT_ORDER.map((status) => ({
      status,
      minutes: stateSummary.stateMinutes[status],
      share: roundAnalysisValue(stateSummary.stateMinutes[status] / normalizedInput.durationMinutes),
      explicit: true
    }));
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: DEVICE_STATE_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
      scope: {
        meterDeviceId: normalizedInput.meterDeviceId,
        meterCode: scope.meterDevice.meterCode,
        meterName: scope.meterDevice.meterName,
        meterStatus: scope.meterDevice.status,
        organizationUnitId: scope.meterDevice.organizationUnitId,
        energyTypeId: scope.energyType.id,
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyTypeActive: Number(scope.energyType.isActive) === 1,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        durationMinutes: normalizedInput.durationMinutes,
        intervalConvention: TIME_INTERVAL_BOUNDARY
      },
      recordCount: rows.length,
      stateRecordCount: stateRows.length,
      quality: {
        status: qualityStatus,
        sufficient: qualityStatus === 'sufficient',
        coverageRate: timeseriesQuality.coverageRate,
        coveredMinutes: timeseriesQuality.coveredMinutes,
        expectedMinutes: normalizedInput.durationMinutes,
        stateCoverageRate: stateSummary.coverageRate,
        knownStateCoverageRate: stateSummary.knownStateCoverageRate,
        idleCoverageRate: stateSummary.idleCoverageRate,
        materializedStateMinutes: stateSummary.coveredMinutes,
        knownStateMinutes: stateSummary.knownStateMinutes,
        explicitUnknownMinutes: stateSummary.explicitUnknownMinutes,
        unmaterializedGapMinutes: stateSummary.gapMinutes,
        idleMinutes: stateSummary.idleMinutes,
        idleCoveredMinutes: stateSummary.idleCoveredMinutes,
        stateKnowledgeComplete: stateSummary.stateKnowledgeComplete,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        sourceGranularityMinutes: stateSummary.sourceGranularityMinutes,
        mixedSourceGranularity: stateSummary.mixedSourceGranularity,
        allocationUsed: stateSummary.allocationUsed,
        partialBoundaryRecordCount,
        hasPartialBoundaryRecords: partialBoundaryRecordCount > 0,
        reasonCodes: qualityReasonCodes
      },
      metrics: {
        rawObservedEnergy,
        observedEnergy,
        rawCompleteEnergy,
        completeEnergy,
        complete: completeEnergy !== null,
        roundedToZero: calculationAllowed
          ? stateSummary.rounding.idleEnergyObservedRoundedToZero
          : null,
        observedEnergyPartial: completeEnergy === null
          && observedEnergy !== null
          && stateSummary.idleMinutes > 0,
        rawShare: calculationAllowed ? stateSummary.share.raw : null,
        share: calculationAllowed ? stateSummary.share.rounded : null,
        shareDenominatorRaw: calculationAllowed ? stateSummary.share.denominatorRaw : null,
        shareDenominator: calculationAllowed ? stateSummary.share.denominatorRounded : null,
        observedRawShare: calculationAllowed ? stateSummary.share.observedRaw : null,
        observedShare: calculationAllowed ? stateSummary.share.observedRounded : null,
        observedDenominatorRaw: calculationAllowed
          ? stateSummary.share.observedDenominatorRaw
          : null,
        observedDenominator: calculationAllowed
          ? stateSummary.share.observedDenominatorRounded
          : null,
        rounding: calculationAllowed ? stateSummary.rounding : null,
        energyUnit: normalizedInput.unit
      },
      states,
      segments: stateSummary.segments,
      meta: {
        sourceTables: ['energy_timeseries_records', 'device_state_records'],
        recordStatus: 'active',
        stateRecordStatus: 'active',
        exactScopeFields: [
          'meter_device_id',
          'organization_unit_id',
          'energy_type_id',
          'normalized_unit',
          'source_timezone'
        ],
        exactStateScopeFields: [
          'meter_device_id',
          'organization_unit_id',
          'source_timezone'
        ],
        overlapPredicate: 'start_utc < endUtc AND end_utc > startUtc',
        allocationAssumption: stateSummary.allocationAssumption,
        explicitIdleOnly: true,
        unmaterializedStateSemantic: 'unknown',
        writesMissingStateRecords: false,
        minimumCoverageRate: MINIMUM_COVERAGE_RATE,
        maximumRangeDays: MAX_QUERY_RANGE_DAYS,
        maximumTimeseriesRecords: MAX_TIMESERIES_RECORDS,
        timeseriesQueryLimit: TIMESERIES_QUERY_LIMIT,
        maximumDeviceStateRecords: MAX_DEVICE_STATE_RECORDS,
        deviceStateQueryLimit: DEVICE_STATE_QUERY_LIMIT,
        includesAncestorOrganizations: false,
        includesDescendantOrganizations: false,
        readOnly: true,
        usesAI: false,
        estimatesEnergySavings: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        generatesPolicyHit: false,
        writesAnalysisRunRecord: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction,
        readTransactionMode: shouldOwnReadTransaction
          ? 'service_owned_begin_deferred'
          : 'caller_owned_reused'
      }
    };

    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 回滚异常不得覆盖原始业务错误或泄露底层数据库详情。
      }
      ownedReadTransactionActive = false;
    }
    operationError = error instanceof AppError
      ? error
      : createEnergyAnalysisQueryFailedError();
    throw operationError;
  } finally {
    if (shouldCloseDatabase && db) {
      try {
        db.close();
      } catch (_closeError) {
        if (!operationError) {
          throw createEnergyAnalysisQueryFailedError();
        }
      }
    }
  }
}

/**
 * 将严格月份转换为连续月份序号，便于跨年范围计算。
 * @param {string} month 严格 YYYY-MM 月份。
 * @returns {number} 连续月份序号。
 */
function monthToSerial(month) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/**
 * 将连续月份序号转换为严格 YYYY-MM 月份。
 * @param {number} serial 连续月份序号。
 * @returns {string} 严格 YYYY-MM 月份。
 */
function serialToMonth(serial) {
  const year = Math.floor(serial / 12);
  const month = serial - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * 规范严格月份字段，拒绝数组、对象、空白和不存在的月份。
 * @param {*} value 原始月份。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {string} 严格月份。
 */
function normalizeStrictMonth(value, fieldName, code) {
  if (typeof value !== 'string' || !STRICT_MONTH_PATTERN.test(value) || Number(value.slice(0, 4)) < 1) {
    throw badRequest(`${fieldName} 必须使用严格 YYYY-MM 格式。`, { code, fieldName });
  }
  return value;
}

/**
 * 规范可选非空文本筛选，禁止数组、对象和隐式字符串转换。
 * @param {*} value 原始筛选值。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {string|null} 规范文本或 null。
 */
function normalizeOptionalText(value, fieldName, code) {
  if (value === undefined) return null;
  if (typeof value !== 'string'
    || value.trim() === ''
    || UNSAFE_MONTHLY_FILTER_TEXT_PATTERN.test(value)) {
    throw badRequest(`${fieldName} 必须是安全的非空字符串。`, { code, fieldName });
  }
  return value.trim();
}

/**
 * 规范月度分析正整数参数，允许查询字符串中的纯十进制文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {number} 正整数。
 */
function normalizeMonthlyPositiveInteger(value, fieldName, code) {
  const normalizedText = typeof value === 'number' ? String(value) : value;
  if (typeof normalizedText !== 'string' || !/^\d+$/.test(normalizedText)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code, fieldName });
  }
  const normalizedValue = Number(normalizedText);
  if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code, fieldName });
  }
  return normalizedValue;
}

/**
 * 规范精确组织范围的后代开关；首期只允许缺省或 false。
 * @param {*} value 原始开关值。
 * @returns {false} 固定精确组织范围。
 */
function normalizeIncludeDescendants(value) {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') {
    throw badRequest('月度消费分析首期不支持包含下级组织。', {
      code: 'MONTHLY_ANALYSIS_DESCENDANTS_UNSUPPORTED',
      fieldName: 'includeDescendants'
    });
  }
  throw badRequest('includeDescendants 仅允许缺省或 false。', {
    code: 'INVALID_MONTHLY_ANALYSIS_INCLUDE_DESCENDANTS',
    fieldName: 'includeDescendants'
  });
}

/**
 * 规范月度消费分析输入并计算输出月份与同比回看范围。
 * @param {*} input 原始输入。
 * @returns {object} 规范月度分析输入。
 */
function normalizeMonthlyConsumptionAnalysisInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('月度消费分析查询参数必须是对象。', {
      code: 'INVALID_MONTHLY_CONSUMPTION_ANALYSIS_INPUT'
    });
  }

  const startMonth = normalizeStrictMonth(input.startMonth, 'startMonth', 'INVALID_MONTHLY_ANALYSIS_START_MONTH');
  const endMonth = normalizeStrictMonth(input.endMonth, 'endMonth', 'INVALID_MONTHLY_ANALYSIS_END_MONTH');
  const startSerial = monthToSerial(startMonth);
  const endSerial = monthToSerial(endMonth);
  if (startSerial > endSerial) {
    throw badRequest('startMonth 不得晚于 endMonth。', {
      code: 'INVALID_MONTHLY_ANALYSIS_RANGE',
      startMonth,
      endMonth
    });
  }
  const monthCount = endSerial - startSerial + 1;
  if (monthCount < MIN_MONTHLY_ANALYSIS_MONTHS || monthCount > MAX_MONTHLY_ANALYSIS_MONTHS) {
    throw badRequest(`月度消费分析范围必须为 ${MIN_MONTHLY_ANALYSIS_MONTHS} 至 ${MAX_MONTHLY_ANALYSIS_MONTHS} 个月。`, {
      code: 'MONTHLY_ANALYSIS_RANGE_EXCEEDED',
      minimumMonths: MIN_MONTHLY_ANALYSIS_MONTHS,
      maximumMonths: MAX_MONTHLY_ANALYSIS_MONTHS,
      monthCount
    });
  }

  const organizationUnitId = input.organizationUnitId === undefined
    ? null
    : normalizeMonthlyPositiveInteger(
      input.organizationUnitId,
      'organizationUnitId',
      'INVALID_MONTHLY_ANALYSIS_ORGANIZATION_UNIT_ID'
    );
  const includeDescendants = normalizeIncludeDescendants(input.includeDescendants);
  const energyTypeCode = normalizeOptionalText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_MONTHLY_ANALYSIS_ENERGY_TYPE_CODE'
  );
  const unit = normalizeOptionalText(input.unit, 'unit', 'INVALID_MONTHLY_ANALYSIS_UNIT');
  const topN = input.topN === undefined
    ? DEFAULT_MONTHLY_ANALYSIS_TOP_N
    : normalizeMonthlyPositiveInteger(input.topN, 'topN', 'INVALID_MONTHLY_ANALYSIS_TOP_N');
  if (topN > MAX_MONTHLY_ANALYSIS_TOP_N) {
    throw badRequest(`topN 不得超过 ${MAX_MONTHLY_ANALYSIS_TOP_N}。`, {
      code: 'INVALID_MONTHLY_ANALYSIS_TOP_N',
      fieldName: 'topN',
      maximumTopN: MAX_MONTHLY_ANALYSIS_TOP_N
    });
  }

  const months = Array.from({ length: monthCount }, (_unused, index) => serialToMonth(startSerial + index));
  return {
    startMonth,
    endMonth,
    startSerial,
    endSerial,
    monthCount,
    months,
    historyStartMonth: serialToMonth(startSerial - MONTHLY_ANALYSIS_LOOKBACK_MONTHS),
    organizationUnitId,
    includeDescendants,
    energyTypeCode,
    unit,
    topN
  };
}

/**
 * 读取精确组织标签；停用组织仍可作为历史查询范围。
 * @param {object} db SQLite 连接。
 * @param {number|null} organizationUnitId 组织 ID。
 * @returns {object|null} 当前组织标签。
 */
function resolveMonthlyOrganizationScope(db, organizationUnitId) {
  if (organizationUnitId === null) return null;
  const organizationUnit = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName,
            unit_path AS unitPath, unit_type AS unitType, status
     FROM organization_units
     WHERE id = ?`
  ).get(organizationUnitId);
  if (!organizationUnit) {
    throw badRequest('指定组织不存在。', {
      code: 'MONTHLY_ANALYSIS_ORGANIZATION_NOT_FOUND',
      organizationUnitId
    });
  }
  return organizationUnit;
}

/**
 * 构造三类月度聚合查询共用的参数化筛选片段。
 * @returns {string} SQL WHERE 追加片段。
 */
function buildMonthlyAnalysisFilterSql() {
  return `AND (@organizationUnitId IS NULL OR er.organization_unit_id = @organizationUnitId)
          AND (@energyTypeCode IS NULL OR et.code = @energyTypeCode)
          AND (@unit IS NULL OR er.normalized_unit = @unit)`;
}

/**
 * 读取月度总量、记录数及组织/表计关联结构；包含同比所需前十二个月。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范输入。
 * @returns {object[]} 月度聚合行。
 */
function queryMonthlyConsumptionRows(db, normalizedInput) {
  const filterSql = buildMonthlyAnalysisFilterSql();
  return db.prepare(
    `SELECT er.energy_type_id AS energyTypeId,
            et.code AS energyTypeCode,
            et.name AS energyTypeName,
            et.category AS energyCategory,
            et.default_unit AS energyDefaultUnit,
            et.standard_unit AS energyStandardUnit,
            et.is_active AS energyTypeActive,
            et.display_order AS energyDisplayOrder,
            er.normalized_unit AS unit,
            er.normalized_month AS month,
            COUNT(er.id) AS recordCount,
            SUM(er.normalized_value) AS totalValue,
            SUM(CASE WHEN er.organization_unit_id IS NOT NULL THEN 1 ELSE 0 END) AS organizationLinkedCount,
            SUM(CASE WHEN er.organization_unit_id IS NULL THEN 1 ELSE 0 END) AS organizationUnlinkedCount,
            SUM(CASE WHEN er.organization_unit_id IS NOT NULL THEN er.normalized_value ELSE 0 END) AS organizationLinkedValue,
            SUM(CASE WHEN er.organization_unit_id IS NULL THEN er.normalized_value ELSE 0 END) AS organizationUnlinkedValue,
            SUM(CASE WHEN er.meter_device_id IS NOT NULL THEN 1 ELSE 0 END) AS meterLinkedCount,
            SUM(CASE WHEN er.meter_device_id IS NULL THEN 1 ELSE 0 END) AS meterUnlinkedCount,
            SUM(CASE WHEN er.meter_device_id IS NOT NULL THEN er.normalized_value ELSE 0 END) AS meterLinkedValue,
            SUM(CASE WHEN er.meter_device_id IS NULL THEN er.normalized_value ELSE 0 END) AS meterUnlinkedValue
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     WHERE er.record_status = 'active'
       AND er.normalized_month BETWEEN @historyStartMonth AND @endMonth
       ${filterSql}
     GROUP BY er.energy_type_id, et.code, et.name, et.category,
              et.default_unit, et.standard_unit, et.is_active, et.display_order,
              er.normalized_unit, er.normalized_month
     ORDER BY et.display_order ASC, er.energy_type_id ASC,
              er.normalized_unit ASC, er.normalized_month ASC`
  ).all(normalizedInput);
}

/**
 * 读取输出范围内每个能源与单位分面的具名组织聚合。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范输入。
 * @returns {object[]} 组织聚合行。
 */
function queryMonthlyOrganizationRows(db, normalizedInput) {
  const filterSql = buildMonthlyAnalysisFilterSql();
  return db.prepare(
    `SELECT er.energy_type_id AS energyTypeId,
            er.normalized_unit AS unit,
            er.organization_unit_id AS organizationUnitId,
            ou.unit_code AS organizationUnitCode,
            ou.unit_name AS organizationUnitName,
            ou.unit_path AS organizationUnitPath,
            ou.unit_type AS organizationUnitType,
            ou.status AS organizationUnitStatus,
            COUNT(er.id) AS recordCount,
            SUM(er.normalized_value) AS totalValue
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     JOIN organization_units ou ON ou.id = er.organization_unit_id
     WHERE er.record_status = 'active'
       AND er.normalized_month BETWEEN @startMonth AND @endMonth
       AND er.organization_unit_id IS NOT NULL
       ${filterSql}
     GROUP BY er.energy_type_id, er.normalized_unit, er.organization_unit_id,
              ou.unit_code, ou.unit_name, ou.unit_path, ou.unit_type, ou.status`
  ).all(normalizedInput);
}

/**
 * 读取输出范围内每个能源与单位分面的具名表计聚合。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范输入。
 * @returns {object[]} 表计聚合行。
 */
function queryMonthlyMeterRows(db, normalizedInput) {
  const filterSql = buildMonthlyAnalysisFilterSql();
  return db.prepare(
    `SELECT er.energy_type_id AS energyTypeId,
            er.normalized_unit AS unit,
            er.meter_device_id AS meterDeviceId,
            md.meter_code AS meterCode,
            md.meter_name AS meterName,
            md.meter_type AS meterType,
            md.status AS meterStatus,
            md.online_status AS meterOnlineStatus,
            md.organization_unit_id AS currentOrganizationUnitId,
            COUNT(er.id) AS recordCount,
            SUM(er.normalized_value) AS totalValue
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     JOIN meter_devices md ON md.id = er.meter_device_id
     WHERE er.record_status = 'active'
       AND er.normalized_month BETWEEN @startMonth AND @endMonth
       AND er.meter_device_id IS NOT NULL
       ${filterSql}
     GROUP BY er.energy_type_id, er.normalized_unit, er.meter_device_id,
              md.meter_code, md.meter_name, md.meter_type, md.status,
              md.online_status, md.organization_unit_id`
  ).all(normalizedInput);
}

/**
 * 构造能源与单位分面的稳定内部键。
 * @param {*} energyTypeId 能源类型 ID。
 * @param {*} unit 标准化单位。
 * @returns {string} 分面键。
 */
function buildMonthlyFacetKey(energyTypeId, unit) {
  return JSON.stringify([Number(energyTypeId), unit]);
}

/**
 * 判断月份值的数据状态，真实零值不得被视为缺失。
 * @param {number|null} value 月份值。
 * @returns {string} missing、zero 或 nonzero。
 */
function resolveMonthlyValueStatus(value) {
  if (!Number.isFinite(value)) return 'missing';
  return value === 0 ? 'zero' : 'nonzero';
}

/**
 * 使用公共公式构造同比或环比，并补充月份与显式缺失状态。
 * @param {number|null} currentValue 本期值。
 * @param {number|null} baseValue 基期值。
 * @param {string} currentMonth 本期月份。
 * @param {string} baseMonth 基期月份。
 * @param {string} comparisonType 比较类型。
 * @returns {object} 月度比较结果。
 */
function buildMonthlyComparison(currentValue, baseValue, currentMonth, baseMonth, comparisonType) {
  const comparison = calculatePeriodComparison(currentValue, baseValue, comparisonType);
  const baseValueStatus = resolveMonthlyValueStatus(baseValue);
  let status = 'available';
  if (!Number.isFinite(currentValue)) status = 'current_missing';
  else if (baseValueStatus === 'missing') status = 'base_missing';
  else if (baseValueStatus === 'zero') status = 'base_zero';
  else if (comparison.calculationStatus === 'numeric_overflow') status = 'numeric_overflow';
  return {
    ...comparison,
    reasonCodes: [],
    status,
    currentMonth,
    baseMonth,
    currentValueStatus: resolveMonthlyValueStatus(currentValue),
    baseValueStatus
  };
}

/**
 * 创建月度分析数值溢出的安全服务端异常。
 * @returns {AppError} 脱敏且稳定的五百错误。
 */
function createAnalysisNumericOverflowError() {
  return new AppError(
    ANALYSIS_NUMERIC_OVERFLOW_CODE,
    '能源分析数值超出安全计算范围。',
    {
      statusCode: 500,
      details: { code: ANALYSIS_NUMERIC_OVERFLOW_CODE }
    }
  );
}

/**
 * 创建班次分析底层查询失败的稳定脱敏服务端异常。
 * @returns {AppError} 不包含 SQL、路径或驱动详情的五百错误。
 */
function createEnergyAnalysisQueryFailedError() {
  return new AppError(
    ENERGY_ANALYSIS_QUERY_FAILED_CODE,
    '能源分析查询失败。',
    {
      statusCode: 500,
      details: { code: ENERGY_ANALYSIS_QUERY_FAILED_CODE }
    }
  );
}

/**
 * 创建本地热力时区投影失败的安全服务端异常。
 * @returns {AppError} 脱敏且稳定的五百错误。
 */
function createLocalTimeProjectionFailedError() {
  return new AppError(
    ANALYSIS_LOCAL_TIME_PROJECTION_FAILED_CODE,
    '能源分析本地时间投影失败。',
    {
      statusCode: 500,
      details: { code: ANALYSIS_LOCAL_TIME_PROJECTION_FAILED_CODE }
    }
  );
}

/**
 * 将聚合行数值字段转换为有限 JavaScript 数值，非有限结果必须中止整次分析。
 * @param {*} value SQLite 聚合值。
 * @returns {number} 有限数值。
 */
function toAggregateNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createAnalysisNumericOverflowError();
  }
  return value;
}

/**
 * 安全汇总聚合行字段，防止多个有限分组在 JavaScript 累加时再次溢出。
 * @param {object[]} rows 聚合行。
 * @param {string} valueField 待汇总字段。
 * @returns {number} 有限汇总值。
 */
function sumMonthlyAggregateValues(rows, valueField) {
  return rows.reduce((sum, row) => {
    const nextValue = sum + toAggregateNumber(row[valueField]);
    if (!Number.isFinite(nextValue)) {
      throw createAnalysisNumericOverflowError();
    }
    return nextValue;
  }, 0);
}

/**
 * 按总量、记录数和 ID 稳定排列具名 TopN。
 * @param {string} idField ID 字段名。
 * @returns {Function} 排序函数。
 */
function createMonthlyTopNComparator(idField) {
  return (left, right) => (
    right.totalValue - left.totalValue
    || right.recordCount - left.recordCount
    || Number(left[idField]) - Number(right[idField])
  );
}

/**
 * 为 TopN 项补充分面总量占比，总量为零时避免零除。
 * @param {object[]} rows 聚合行。
 * @param {string} idField ID 字段名。
 * @param {number} totalValue 分面总量。
 * @param {number} topN 返回数量。
 * @returns {object[]} 排序并截取后的 TopN。
 */
function buildMonthlyTopN(rows, idField, totalValue, topN) {
  return rows
    .map((row) => ({
      ...row,
      recordCount: toAggregateNumber(row.recordCount),
      totalValue: roundAnalysisValue(toAggregateNumber(row.totalValue))
    }))
    .sort(createMonthlyTopNComparator(idField))
    .slice(0, topN)
    .map((row) => ({
      ...row,
      share: totalValue === 0 ? null : roundAnalysisValue(row.totalValue / totalValue)
    }));
}

/**
 * 汇总月度结构中的关联值和记录数。
 * @param {object[]} outputRows 输出范围内月度行。
 * @param {string} valueField 值字段。
 * @param {string} countField 记录数字段。
 * @returns {{ value: number, recordCount: number }} 结构汇总。
 */
function summarizeMonthlyStructure(outputRows, valueField, countField) {
  return {
    value: roundAnalysisValue(sumMonthlyAggregateValues(outputRows, valueField)),
    recordCount: sumMonthlyAggregateValues(outputRows, countField)
  };
}

/**
 * 从三类聚合行构造完整月序列、同环比、结构、TopN 与并列峰值。
 * @param {object[]} monthlyRows 月度聚合行。
 * @param {object[]} organizationRows 组织聚合行。
 * @param {object[]} meterRows 表计聚合行。
 * @param {object} normalizedInput 规范输入。
 * @returns {object[]} 能源与单位分面列表。
 */
function buildMonthlyConsumptionFacets(monthlyRows, organizationRows, meterRows, normalizedInput) {
  const monthlyRowsByFacet = new Map();
  monthlyRows.forEach((row) => {
    const facetKey = buildMonthlyFacetKey(row.energyTypeId, row.unit);
    if (!monthlyRowsByFacet.has(facetKey)) monthlyRowsByFacet.set(facetKey, []);
    monthlyRowsByFacet.get(facetKey).push(row);
  });
  const outputFacetEntries = [...monthlyRowsByFacet.entries()]
    .map(([facetKey, rows]) => ({
      facetKey,
      rows,
      firstOutputRow: rows.find((row) => row.month >= normalizedInput.startMonth)
    }))
    .filter((entry) => entry.firstOutputRow)
    .sort((left, right) => (
      toAggregateNumber(left.firstOutputRow.energyDisplayOrder)
        - toAggregateNumber(right.firstOutputRow.energyDisplayOrder)
      || Number(left.firstOutputRow.energyTypeId) - Number(right.firstOutputRow.energyTypeId)
      || String(left.firstOutputRow.unit).localeCompare(String(right.firstOutputRow.unit))
    ));

  return outputFacetEntries.map(({ facetKey, rows, firstOutputRow }) => {
    const monthRows = new Map(rows.map((row) => [row.month, row]));
    const outputRows = rows.filter((row) => row.month >= normalizedInput.startMonth);
    const totalValue = roundAnalysisValue(sumMonthlyAggregateValues(outputRows, 'totalValue'));
    const recordCount = sumMonthlyAggregateValues(outputRows, 'recordCount');
    const trend = normalizedInput.months.map((month) => {
      const currentRow = monthRows.get(month) || null;
      const currentValue = currentRow ? roundAnalysisValue(toAggregateNumber(currentRow.totalValue)) : null;
      const previousMonth = serialToMonth(monthToSerial(month) - 1);
      const previousYearMonth = serialToMonth(monthToSerial(month) - 12);
      const previousMonthRow = monthRows.get(previousMonth) || null;
      const previousYearRow = monthRows.get(previousYearMonth) || null;
      return {
        month,
        value: currentValue,
        recordCount: currentRow ? toAggregateNumber(currentRow.recordCount) : 0,
        periodOverPeriod: buildMonthlyComparison(
          currentValue,
          previousMonthRow ? roundAnalysisValue(toAggregateNumber(previousMonthRow.totalValue)) : null,
          month,
          previousMonth,
          'period_over_period'
        ),
        yearOverYear: buildMonthlyComparison(
          currentValue,
          previousYearRow ? roundAnalysisValue(toAggregateNumber(previousYearRow.totalValue)) : null,
          month,
          previousYearMonth,
          'year_over_year'
        )
      };
    });
    const validTrendPoints = trend.filter((point) => Number.isFinite(point.value));
    const peakValue = validTrendPoints.length > 0
      ? Math.max(...validTrendPoints.map((point) => point.value))
      : null;
    const peakMonths = validTrendPoints
      .filter((point) => point.value === peakValue)
      .map((point) => ({ month: point.month, value: point.value, recordCount: point.recordCount }));
    const facetOrganizationRows = organizationRows
      .filter((row) => buildMonthlyFacetKey(row.energyTypeId, row.unit) === facetKey)
      .map((row) => ({
        organizationUnitId: Number(row.organizationUnitId),
        organizationUnitCode: row.organizationUnitCode,
        organizationUnitName: row.organizationUnitName,
        organizationUnitPath: row.organizationUnitPath,
        organizationUnitType: row.organizationUnitType,
        organizationUnitStatus: row.organizationUnitStatus,
        recordCount: row.recordCount,
        totalValue: row.totalValue
      }));
    const facetMeterRows = meterRows
      .filter((row) => buildMonthlyFacetKey(row.energyTypeId, row.unit) === facetKey)
      .map((row) => ({
        meterDeviceId: Number(row.meterDeviceId),
        meterCode: row.meterCode,
        meterName: row.meterName,
        meterType: row.meterType,
        meterStatus: row.meterStatus,
        meterOnlineStatus: row.meterOnlineStatus,
        currentOrganizationUnitId: row.currentOrganizationUnitId === null
          ? null
          : Number(row.currentOrganizationUnitId),
        recordCount: row.recordCount,
        totalValue: row.totalValue
      }));

    return {
      energyType: {
        id: Number(firstOutputRow.energyTypeId),
        code: firstOutputRow.energyTypeCode,
        name: firstOutputRow.energyTypeName,
        category: firstOutputRow.energyCategory,
        defaultUnit: firstOutputRow.energyDefaultUnit,
        standardUnit: firstOutputRow.energyStandardUnit,
        active: Number(firstOutputRow.energyTypeActive) === 1
      },
      unit: firstOutputRow.unit,
      dataStatus: 'available',
      reasonCodes: [],
      totals: {
        value: totalValue,
        recordCount,
        observedMonthCount: outputRows.length,
        rangeMonthCount: normalizedInput.monthCount
      },
      trend,
      structure: {
        organization: {
          linked: summarizeMonthlyStructure(outputRows, 'organizationLinkedValue', 'organizationLinkedCount'),
          unlinked: summarizeMonthlyStructure(outputRows, 'organizationUnlinkedValue', 'organizationUnlinkedCount')
        },
        meter: {
          linked: summarizeMonthlyStructure(outputRows, 'meterLinkedValue', 'meterLinkedCount'),
          unlinked: summarizeMonthlyStructure(outputRows, 'meterUnlinkedValue', 'meterUnlinkedCount')
        }
      },
      organizationTopN: buildMonthlyTopN(
        facetOrganizationRows,
        'organizationUnitId',
        totalValue,
        normalizedInput.topN
      ),
      meterTopN: buildMonthlyTopN(
        facetMeterRows,
        'meterDeviceId',
        totalValue,
        normalizedInput.topN
      ),
      peakMonths
    };
  });
}

/**
 * 查询月度消费趋势、同环比、关联结构、每分面 TopN 和并列峰值月份。
 * @param {object} input 月份范围与可选精确筛选。
 * @param {object} options 可注入调用方 SQLite 连接与仅测试快照钩子。
 * @returns {object} 稳定月度消费分析契约。
 */
function getMonthlyConsumptionAnalysis(input, options = {}) {
  const normalizedInput = normalizeMonthlyConsumptionAnalysisInput(input);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const callerDatabase = normalizedOptions.db || null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  const shouldOwnReadTransaction = db.inTransaction !== true;
  const afterMonthlyQueryTestHook = typeof normalizedOptions.testOnlyAfterMonthlyQuery === 'function'
    ? normalizedOptions.testOnlyAfterMonthlyQuery
    : null;
  let ownedReadTransactionActive = false;

  try {
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }
    const organizationUnit = resolveMonthlyOrganizationScope(db, normalizedInput.organizationUnitId);
    const monthlyRows = queryMonthlyConsumptionRows(db, normalizedInput);
    if (afterMonthlyQueryTestHook) afterMonthlyQueryTestHook();
    const organizationRows = queryMonthlyOrganizationRows(db, normalizedInput);
    const meterRows = queryMonthlyMeterRows(db, normalizedInput);
    const facets = buildMonthlyConsumptionFacets(
      monthlyRows,
      organizationRows,
      meterRows,
      normalizedInput
    );
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: MONTHLY_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
      dataStatus: facets.length === 0 ? 'no_data' : 'available',
      reasonCodes: [],
      scope: {
        startMonth: normalizedInput.startMonth,
        endMonth: normalizedInput.endMonth,
        monthCount: normalizedInput.monthCount,
        historyStartMonth: normalizedInput.historyStartMonth,
        comparisonLookbackMonths: MONTHLY_ANALYSIS_LOOKBACK_MONTHS,
        organizationUnitId: normalizedInput.organizationUnitId,
        organizationUnit,
        includeDescendants: false,
        energyTypeCode: normalizedInput.energyTypeCode,
        unit: normalizedInput.unit,
        topN: normalizedInput.topN
      },
      facets,
      meta: {
        sourceTable: 'energy_records',
        sourceFields: ['normalized_month', 'normalized_value', 'normalized_unit'],
        recordStatus: 'active',
        readOnly: true,
        benchmarkApplied: false,
        exactOrganizationScope: true,
        currentMasterStatusUsedAsFilter: false,
        aggregateQueryCount: 3,
        excludedDataSources: [
          'energy_timeseries_records',
          'meter_reading_records',
          'generation_records'
        ],
        generationOffsetApplied: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction
      }
    };

    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db.inTransaction === true) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 保留原始错误，连接关闭或调用方负责最终资源回收。
      }
      ownedReadTransactionActive = false;
    }
    throw error;
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

module.exports = {
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
  MIN_MONTHLY_ANALYSIS_MONTHS,
  MIN_SUPPORTED_ANALYSIS_YEAR,
  MONTHLY_ANALYSIS_LOOKBACK_MONTHS,
  MONTHLY_CONSUMPTION_ANALYSIS_FORMULA_VERSION,
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
};
