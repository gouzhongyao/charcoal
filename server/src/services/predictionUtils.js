const { badRequest } = require('../utils/errors');

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SUPPORTED_PREDICTION_ALGORITHMS = Object.freeze(['moving_average', 'linear_trend']);
const PREDICTION_RUN_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'cancelled', 'archived']);
// 预测结果统一执行六位小数舍入，P3 witness 与 P4 handler 必须复用同一合同。
const PREDICTION_ROUNDING_DIGITS = 6;
// 低置信度区间使用固定算法倍率，禁止持久化阶段或 ownership 阶段自行解释。
const PREDICTION_CONFIDENCE_RULES = Object.freeze({
  moving_average: Object.freeze({ lowMultiplier: 0.9, highMultiplier: 1.1 }),
  linear_trend: Object.freeze({ lowMultiplier: 0.85, highMultiplier: 1.15 })
});
// 方法说明中的能源编码只接受现有业务稳定编码字符集。
const PREDICTION_METHOD_ENERGY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// 方法说明中的 canonical unit 禁止使用结构分隔符或控制字符。
const PREDICTION_METHOD_UNIT_PATTERN = /^[^，。=\r\n\p{Cc}]{1,64}$/u;
const PREDICTION_SORT_COLUMNS = Object.freeze({
  createdAt: 'pr.created_at',
  completedAt: 'pr.completed_at',
  status: 'pr.status',
  algorithm: 'pr.algorithm',
  trainStartMonth: 'pr.train_start_month',
  trainEndMonth: 'pr.train_end_month',
  predictStartMonth: 'pr.predict_start_month',
  predictEndMonth: 'pr.predict_end_month'
});
const PREDICTION_RESULT_SORT_COLUMNS = Object.freeze({
  targetMonth: 'pres.target_month',
  predictedValue: 'pres.predicted_value',
  createdAt: 'pres.created_at',
  energyTypeCode: 'et.code'
});

function normalizeText(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function normalizeMonth(value, fieldName) {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }
  if (!MONTH_PATTERN.test(text)) {
    throw badRequest(`${fieldName} 必须使用 YYYY-MM 格式，且月份范围为 01-12。`, {
      code: 'INVALID_MONTH',
      fieldName,
      rawValue: text
    });
  }
  return text;
}

function monthToIndex(month) {
  const normalized = normalizeMonth(month, 'month');
  const year = Number.parseInt(normalized.slice(0, 4), 10);
  const monthNumber = Number.parseInt(normalized.slice(5, 7), 10);
  return year * 12 + monthNumber - 1;
}

function indexToMonth(index) {
  const year = Math.floor(index / 12);
  const monthNumber = index % 12 + 1;
  return `${year}-${String(monthNumber).padStart(2, '0')}`;
}

function addMonths(month, offset) {
  return indexToMonth(monthToIndex(month) + offset);
}

function compareMonths(left, right) {
  return monthToIndex(left) - monthToIndex(right);
}

function countMonthsInclusive(startMonth, endMonth) {
  return monthToIndex(endMonth) - monthToIndex(startMonth) + 1;
}

function generateMonthSequence(startMonth, endMonth) {
  const start = normalizeMonth(startMonth, 'startMonth');
  const end = normalizeMonth(endMonth, 'endMonth');
  if (compareMonths(start, end) > 0) {
    throw badRequest('月份范围开始值不能晚于结束值。', {
      code: 'INVALID_MONTH_RANGE',
      startMonth: start,
      endMonth: end
    });
  }

  const months = [];
  for (let index = monthToIndex(start); index <= monthToIndex(end); index += 1) {
    months.push(indexToMonth(index));
  }
  return months;
}

function normalizePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code: 'INVALID_POSITIVE_INTEGER',
      fieldName,
      rawValue: text
    });
  }
  const numberValue = Number.parseInt(text, 10);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(numberValue) || numberValue < min || numberValue > max) {
    throw badRequest(`${fieldName} 必须是 ${min}-${max} 范围内的正整数。`, {
      code: 'INVALID_POSITIVE_INTEGER',
      fieldName,
      rawValue: text,
      min,
      max
    });
  }
  return numberValue;
}

function normalizePredictionAlgorithm(value) {
  const algorithm = normalizeText(value) || 'moving_average';
  if (!SUPPORTED_PREDICTION_ALGORITHMS.includes(algorithm)) {
    throw badRequest('algorithm 当前仅支持 moving_average 或 linear_trend。', {
      code: 'UNSUPPORTED_PREDICTION_ALGORITHM',
      algorithm,
      supportedAlgorithms: SUPPORTED_PREDICTION_ALGORITHMS,
      reservedAlgorithms: ['year_over_year', 'manual_baseline']
    });
  }
  return algorithm;
}

function normalizePredictionStatus(value) {
  const status = normalizeText(value);
  if (!status) {
    return undefined;
  }
  if (!PREDICTION_RUN_STATUSES.includes(status)) {
    throw badRequest('status 不在预测运行状态白名单内。', {
      code: 'UNSUPPORTED_PREDICTION_STATUS',
      status,
      allowedStatuses: PREDICTION_RUN_STATUSES
    });
  }
  return status;
}

function normalizeSort(query = {}, columns = PREDICTION_SORT_COLUMNS, defaults = {}) {
  const defaultSortBy = defaults.sortBy || 'createdAt';
  const defaultSortOrder = defaults.sortOrder || 'desc';
  const sortBy = normalizeText(query.sortBy) || defaultSortBy;
  const sortOrder = (normalizeText(query.sortOrder) || defaultSortOrder).toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(columns, sortBy)) {
    throw badRequest('sortBy 不在允许排序字段白名单内。', {
      code: 'UNSUPPORTED_SORT_FIELD',
      sortBy,
      allowedSortFields: Object.keys(columns)
    });
  }
  if (!['asc', 'desc'].includes(sortOrder)) {
    throw badRequest('sortOrder 仅支持 asc 或 desc。', {
      code: 'UNSUPPORTED_SORT_ORDER',
      sortOrder,
      allowedSortOrders: ['asc', 'desc']
    });
  }
  return {
    sortBy,
    sortOrder,
    orderSql: `${columns[sortBy]} ${sortOrder.toUpperCase()}`
  };
}

function validatePredictionRange({ trainStartMonth, trainEndMonth, predictStartMonth, predictEndMonth }) {
  const trainMonths = generateMonthSequence(trainStartMonth, trainEndMonth);
  const predictionMonths = generateMonthSequence(predictStartMonth, predictEndMonth);

  if (compareMonths(addMonths(trainEndMonth, 1), predictStartMonth) > 0) {
    throw badRequest('预测开始月份必须晚于训练结束月份，避免用未来区间覆盖历史训练区间。', {
      code: 'INVALID_PREDICTION_RANGE',
      trainEndMonth,
      predictStartMonth
    });
  }

  if (predictionMonths.length > 24) {
    throw badRequest('轻量预测单次最多支持 24 个预测月份。', {
      code: 'PREDICTION_RANGE_TOO_LONG',
      predictionMonthCount: predictionMonths.length,
      maxPredictionMonths: 24
    });
  }

  return { trainMonths, predictionMonths };
}

function summarizeHistorySufficiency(points = [], trainMonths = [], options = {}) {
  const minHistoryMonths = options.minHistoryMonths ?? 3;
  const availableMonthSet = new Set(points.map((point) => point.month));
  const missingMonths = trainMonths.filter((month) => !availableMonthSet.has(month));
  const sampleMonths = availableMonthSet.size;
  const sufficient = sampleMonths >= minHistoryMonths;
  const warnings = [];

  if (!sufficient) {
    warnings.push(`历史样本月份不足：至少需要 ${minHistoryMonths} 个月，当前仅 ${sampleMonths} 个月。`);
  }
  if (missingMonths.length > 0) {
    warnings.push(`训练区间存在缺失月份：${missingMonths.join(', ')}。`);
  }

  return {
    sufficient,
    sampleMonths,
    requiredMonths: minHistoryMonths,
    expectedMonths: trainMonths.length,
    missingMonths,
    warnings
  };
}

/** 拒绝预测算法中的非 number、非有限或不允许的负数，禁止隐式转换和静默丢弃。 */
function requireFinitePredictionNumber(value, stage, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (options.nonNegative === true && value < 0)) {
    throw badRequest('预测算法遇到无效或非有限数值，已阻断结果生成。', {
      code: 'PREDICTION_NUMERIC_INTEGRITY_ERROR',
      stage,
      valueType: typeof value,
      nonNegativeRequired: options.nonNegative === true
    });
  }
  return value;
}

/** 执行有限数加法并在中间值溢出时立即阻断。 */
function addFinitePredictionNumbers(left, right, stage) {
  const result = requireFinitePredictionNumber(left, `${stage}.left`)
    + requireFinitePredictionNumber(right, `${stage}.right`);
  return requireFinitePredictionNumber(result, stage);
}

/** 执行有限数乘法并在中间值溢出时立即阻断。 */
function multiplyFinitePredictionNumbers(left, right, stage) {
  const result = requireFinitePredictionNumber(left, `${stage}.left`)
    * requireFinitePredictionNumber(right, `${stage}.right`);
  return requireFinitePredictionNumber(result, stage);
}

/** 对有符号预测诊断值执行有限六位舍入，不应用业务非负截断。 */
function roundSignedPredictionValue(value) {
  const finiteValue = requireFinitePredictionNumber(value, 'signedRound.input');
  const scale = 10 ** PREDICTION_ROUNDING_DIGITS;
  const scaledValue = multiplyFinitePredictionNumbers(finiteValue, scale, 'signedRound.scale');
  const rounded = requireFinitePredictionNumber(Math.round(scaledValue) / scale, 'signedRound.result');
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 对预测结果执行有限六位舍入，并按业务口径截断有限负值。 */
function roundPredictionValue(value) {
  return Math.max(0, roundSignedPredictionValue(value));
}

/** 校验持久预测数值已经符合统一六位舍入合同。 */
function isPredictionRoundedValue(value, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (options.nonNegative === true && value < 0) return false;
  return roundSignedPredictionValue(value) === value;
}

/** 读取算法固定 confidence 倍率。 */
function getPredictionConfidenceRule(algorithm) {
  const normalizedAlgorithm = normalizePredictionAlgorithm(algorithm);
  return PREDICTION_CONFIDENCE_RULES[normalizedAlgorithm];
}

/** 根据预测值和算法倍率重建六位舍入后的 confidence 事实。 */
function buildPredictionConfidenceFacts(algorithm, predictedValue) {
  const normalizedPredictedValue = requireFinitePredictionNumber(
    predictedValue,
    'forecastFacts.predictedValue',
    { nonNegative: true }
  );
  const rule = getPredictionConfidenceRule(algorithm);
  const confidenceLowRaw = multiplyFinitePredictionNumbers(
    normalizedPredictedValue,
    rule.lowMultiplier,
    'forecastFacts.confidenceLowRaw'
  );
  const confidenceHighRaw = multiplyFinitePredictionNumbers(
    normalizedPredictedValue,
    rule.highMultiplier,
    'forecastFacts.confidenceHighRaw'
  );
  return Object.freeze({
    confidenceLowMultiplier: rule.lowMultiplier,
    confidenceHighMultiplier: rule.highMultiplier,
    confidenceLowRaw,
    confidenceHighRaw,
    confidenceLow: roundPredictionValue(confidenceLowRaw),
    confidenceHigh: roundPredictionValue(confidenceHighRaw)
  });
}

/** 校验并格式化 forecast fact 的固定方法说明，不允许自由文本拼接。 */
function formatPredictionForecastMethodNote(forecastFact, options = {}) {
  if (!forecastFact || typeof forecastFact !== 'object' || Array.isArray(forecastFact)) {
    throw badRequest('Prediction forecast fact 必须是固定对象。', {
      code: 'PREDICTION_FORECAST_FACT_INVALID'
    });
  }
  const algorithm = normalizePredictionAlgorithm(forecastFact.algorithm);
  let note = '';
  if (algorithm === 'moving_average') {
    if (!Number.isSafeInteger(forecastFact.windowSize)
      || forecastFact.windowSize < 2 || forecastFact.windowSize > 12) {
      throw badRequest('Prediction moving average forecast fact 的 windowSize 无效。', {
        code: 'PREDICTION_FORECAST_FACT_INVALID'
      });
    }
    note = `轻量移动平均：使用最近 ${forecastFact.windowSize} 个历史/预测月份滚动平均；confidenceLevel=low，仅作趋势参考。`;
  } else {
    if (!Number.isSafeInteger(forecastFact.sampleCount) || forecastFact.sampleCount < 3
      || !isPredictionRoundedValue(forecastFact.signedSlope)
      || typeof forecastFact.clampedToZero !== 'boolean') {
      throw badRequest('Prediction linear trend forecast fact 的样本、斜率或截断事实无效。', {
        code: 'PREDICTION_FORECAST_FACT_INVALID'
      });
    }
    const clampNotice = forecastFact.clampedToZero
      ? '；趋势外推出现负值，已按业务口径截断为 0'
      : '';
    note = `轻量线性趋势：基于 ${forecastFact.sampleCount} 个历史月份做一元线性外推，slope=${forecastFact.signedSlope}；confidenceLevel=low，仅作趋势参考${clampNotice}。`;
  }
  const hasEnergyTypeCode = Object.prototype.hasOwnProperty.call(options, 'energyTypeCode');
  const hasCanonicalUnit = Object.prototype.hasOwnProperty.call(options, 'canonicalUnit');
  if (hasEnergyTypeCode !== hasCanonicalUnit) {
    throw badRequest('Prediction 方法说明能源编码与单位必须同时提供。', {
      code: 'PREDICTION_FORECAST_FACT_INVALID'
    });
  }
  if (!hasEnergyTypeCode) return note;
  if (typeof options.energyTypeCode !== 'string'
    || !PREDICTION_METHOD_ENERGY_CODE_PATTERN.test(options.energyTypeCode)
    || typeof options.canonicalUnit !== 'string'
    || !PREDICTION_METHOD_UNIT_PATTERN.test(options.canonicalUnit)) {
    throw badRequest('Prediction 方法说明能源编码或 canonical unit 无效。', {
      code: 'PREDICTION_FORECAST_FACT_INVALID'
    });
  }
  return `${note} 能源类型=${options.energyTypeCode}，单位=${options.canonicalUnit}。`;
}

/** 从正式方法说明提取结构事实，并通过 formatter 原样重建以拒绝宽松文本。 */
function parsePredictionForecastMethodNote(methodNote) {
  if (typeof methodNote !== 'string' || methodNote.length === 0) return null;
  const movingMatch = /^轻量移动平均：使用最近 ([2-9]|1[0-2]) 个历史\/预测月份滚动平均；confidenceLevel=low，仅作趋势参考。 能源类型=([A-Za-z][A-Za-z0-9_-]{0,63})，单位=([^，。=\r\n\p{Cc}]{1,64})。$/u.exec(methodNote);
  if (movingMatch) {
    const parsed = {
      algorithm: 'moving_average',
      windowSize: Number(movingMatch[1]),
      sampleCount: null,
      signedSlope: null,
      clampedToZero: false,
      energyTypeCode: movingMatch[2],
      canonicalUnit: movingMatch[3]
    };
    return formatPredictionForecastMethodNote(parsed, parsed) === methodNote
      ? Object.freeze(parsed)
      : null;
  }
  const linearMatch = /^轻量线性趋势：基于 ([1-9]\d*) 个历史月份做一元线性外推，slope=(-?(?:0|[1-9]\d*)(?:\.\d{1,6})?(?:e[+-]?\d+)?)；confidenceLevel=low，仅作趋势参考(；趋势外推出现负值，已按业务口径截断为 0)?。 能源类型=([A-Za-z][A-Za-z0-9_-]{0,63})，单位=([^，。=\r\n\p{Cc}]{1,64})。$/u.exec(methodNote);
  if (!linearMatch) return null;
  const signedSlope = Number(linearMatch[2]);
  const parsed = {
    algorithm: 'linear_trend',
    windowSize: null,
    sampleCount: Number(linearMatch[1]),
    signedSlope,
    clampedToZero: Boolean(linearMatch[3]),
    energyTypeCode: linearMatch[4],
    canonicalUnit: linearMatch[5]
  };
  if (!Number.isSafeInteger(parsed.sampleCount) || parsed.sampleCount < 3
    || !isPredictionRoundedValue(signedSlope)) return null;
  return formatPredictionForecastMethodNote(parsed, parsed) === methodNote
    ? Object.freeze(parsed)
    : null;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((total, value, index) => (
    addFinitePredictionNumbers(total, requireFinitePredictionNumber(value, `average.value.${index}`), 'average.sum')
  ), 0);
  return requireFinitePredictionNumber(sum / values.length, 'average.result');
}

function resolveMovingAverageRequiredHistoryMonths(windowSize = 3) {
  return Math.max(3, windowSize ?? 3);
}

/** 从 points 提取严格有限且非负的历史值，不做 Number 转换或 filter 丢弃。 */
function readPredictionPointValues(points, stage) {
  return points.map((point, index) => requireFinitePredictionNumber(
    point?.value,
    `${stage}.point.${index}`,
    { nonNegative: true }
  ));
}

function computeMovingAverageForecast(points = [], predictionMonths = [], options = {}) {
  const windowSize = options.windowSize ?? 3;
  const requiredHistoryMonths = resolveMovingAverageRequiredHistoryMonths(windowSize);
  const values = readPredictionPointValues(points, 'movingAverage.history');
  if (values.length < requiredHistoryMonths) {
    throw badRequest('移动平均历史样本不足，无法生成预测结果。', {
      code: 'INSUFFICIENT_HISTORY_FOR_MOVING_AVERAGE',
      sampleMonths: values.length,
      requiredMonths: requiredHistoryMonths,
      windowSize
    });
  }

  const workingValues = [...values];
  return predictionMonths.map((targetMonth) => {
    const recentValues = workingValues.slice(-windowSize);
    const rawPredictedValue = average(recentValues);
    const predictedValue = roundPredictionValue(rawPredictedValue);
    workingValues.push(predictedValue);
    const confidence = buildPredictionConfidenceFacts('moving_average', predictedValue);
    const forecastFact = {
      algorithm: 'moving_average',
      windowSize,
      sampleCount: null,
      signedSlope: null,
      clampedToZero: false
    };
    return {
      targetMonth,
      rawPredictedValue,
      predictedValue,
      confidenceLow: confidence.confidenceLow,
      confidenceHigh: confidence.confidenceHigh,
      methodNote: formatPredictionForecastMethodNote(forecastFact),
      roundingDigits: PREDICTION_ROUNDING_DIGITS,
      sourceValues: recentValues,
      confidenceLowMultiplier: confidence.confidenceLowMultiplier,
      confidenceHighMultiplier: confidence.confidenceHighMultiplier,
      confidenceLowRaw: confidence.confidenceLowRaw,
      confidenceHighRaw: confidence.confidenceHighRaw,
      ...forecastFact
    };
  });
}

function computeLinearTrendForecast(points = [], predictionMonths = []) {
  const values = readPredictionPointValues(points, 'linearTrend.history');
  if (values.length < 3) {
    throw badRequest('线性趋势历史样本不足，无法生成预测结果。', {
      code: 'INSUFFICIENT_HISTORY_FOR_LINEAR_TREND',
      sampleMonths: values.length,
      requiredMonths: 3
    });
  }

  const n = values.length;
  const xAverage = requireFinitePredictionNumber((n - 1) / 2, 'linearTrend.xAverage');
  const yAverage = average(values);
  const denominator = values.reduce((sum, _value, index) => {
    const centeredIndex = requireFinitePredictionNumber(index - xAverage, 'linearTrend.denominator.center');
    const square = multiplyFinitePredictionNumbers(centeredIndex, centeredIndex, 'linearTrend.denominator.square');
    return addFinitePredictionNumbers(sum, square, 'linearTrend.denominator.sum');
  }, 0);
  const numerator = values.reduce((sum, value, index) => {
    const centeredIndex = requireFinitePredictionNumber(index - xAverage, 'linearTrend.numerator.x');
    const centeredValue = requireFinitePredictionNumber(value - yAverage, 'linearTrend.numerator.y');
    const product = multiplyFinitePredictionNumbers(centeredIndex, centeredValue, 'linearTrend.numerator.product');
    return addFinitePredictionNumbers(sum, product, 'linearTrend.numerator.sum');
  }, 0);
  const slope = denominator === 0
    ? 0
    : requireFinitePredictionNumber(numerator / denominator, 'linearTrend.slope');
  const slopeAtAverage = multiplyFinitePredictionNumbers(slope, xAverage, 'linearTrend.intercept.product');
  const intercept = requireFinitePredictionNumber(yAverage - slopeAtAverage, 'linearTrend.intercept');

  return predictionMonths.map((targetMonth, predictionIndex) => {
    const targetIndex = n + predictionIndex;
    const trendValue = multiplyFinitePredictionNumbers(slope, targetIndex, 'linearTrend.prediction.product');
    const rawPrediction = addFinitePredictionNumbers(intercept, trendValue, 'linearTrend.prediction.raw');
    const predictedValue = roundPredictionValue(rawPrediction);
    const confidence = buildPredictionConfidenceFacts('linear_trend', predictedValue);
    const forecastFact = {
      algorithm: 'linear_trend',
      windowSize: null,
      sampleCount: n,
      signedSlope: roundSignedPredictionValue(slope),
      clampedToZero: rawPrediction < 0
    };
    return {
      targetMonth,
      targetIndex,
      sourceValues: values,
      intercept,
      rawSlope: slope,
      rawPredictedValue: rawPrediction,
      predictedValue,
      confidenceLow: confidence.confidenceLow,
      confidenceHigh: confidence.confidenceHigh,
      methodNote: formatPredictionForecastMethodNote(forecastFact),
      roundingDigits: PREDICTION_ROUNDING_DIGITS,
      confidenceLowMultiplier: confidence.confidenceLowMultiplier,
      confidenceHighMultiplier: confidence.confidenceHighMultiplier,
      confidenceLowRaw: confidence.confidenceLowRaw,
      confidenceHighRaw: confidence.confidenceHighRaw,
      ...forecastFact
    };
  });
}

function detectHistoryWarnings(points = []) {
  const values = readPredictionPointValues(points, 'historyWarnings');
  if (values.length < 2) {
    return [];
  }
  const max = values.reduce((current, value) => Math.max(current, value), values[0]);
  const min = values.reduce((current, value) => Math.min(current, value), values[0]);
  const avg = average(values);
  const warnings = [];
  const range = requireFinitePredictionNumber(max - min, 'historyWarnings.range');
  const relativeRange = avg > 0
    ? requireFinitePredictionNumber(range / avg, 'historyWarnings.relativeRange')
    : 0;
  if (relativeRange > 1) {
    warnings.push('历史数据波动较大，轻量预测结果不宜作为高精度承诺。');
  }
  return warnings;
}

function buildForecast(points = [], predictionMonths = [], options = {}) {
  const algorithm = normalizePredictionAlgorithm(options.algorithm);
  if (algorithm === 'moving_average') {
    return computeMovingAverageForecast(points, predictionMonths, { windowSize: options.windowSize ?? 3 });
  }
  return computeLinearTrendForecast(points, predictionMonths);
}

module.exports = {
  MONTH_PATTERN,
  PREDICTION_CONFIDENCE_RULES,
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_ROUNDING_DIGITS,
  PREDICTION_RUN_STATUSES,
  PREDICTION_SORT_COLUMNS,
  SUPPORTED_PREDICTION_ALGORITHMS,
  addMonths,
  buildForecast,
  buildPredictionConfidenceFacts,
  compareMonths,
  computeLinearTrendForecast,
  computeMovingAverageForecast,
  countMonthsInclusive,
  detectHistoryWarnings,
  formatPredictionForecastMethodNote,
  generateMonthSequence,
  isPredictionRoundedValue,
  normalizeMonth,
  normalizePositiveInteger,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  normalizeText,
  parsePredictionForecastMethodNote,
  roundPredictionValue,
  roundSignedPredictionValue,
  resolveMovingAverageRequiredHistoryMonths,
  summarizeHistorySufficiency,
  validatePredictionRange
};
