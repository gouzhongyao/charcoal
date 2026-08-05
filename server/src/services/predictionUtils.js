const { badRequest } = require('../utils/errors');

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SUPPORTED_PREDICTION_ALGORITHMS = Object.freeze(['moving_average', 'linear_trend']);
const PREDICTION_RUN_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'cancelled', 'archived']);
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
  const min = options.min || 1;
  const max = options.max || Number.MAX_SAFE_INTEGER;
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
  const minHistoryMonths = options.minHistoryMonths || 3;
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

function roundPredictionValue(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value * 1000000) / 1000000);
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resolveMovingAverageRequiredHistoryMonths(windowSize = 3) {
  return Math.max(3, windowSize || 3);
}

function computeMovingAverageForecast(points = [], predictionMonths = [], options = {}) {
  const windowSize = options.windowSize || 3;
  const requiredHistoryMonths = resolveMovingAverageRequiredHistoryMonths(windowSize);
  const values = points.map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
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
    const predictedValue = roundPredictionValue(average(recentValues));
    workingValues.push(predictedValue);
    return {
      targetMonth,
      predictedValue,
      confidenceLow: roundPredictionValue(predictedValue * 0.9),
      confidenceHigh: roundPredictionValue(predictedValue * 1.1),
      methodNote: `轻量移动平均：使用最近 ${windowSize} 个历史/预测月份滚动平均；confidenceLevel=low，仅作趋势参考。`
    };
  });
}

function computeLinearTrendForecast(points = [], predictionMonths = []) {
  const values = points.map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
  if (values.length < 3) {
    throw badRequest('线性趋势历史样本不足，无法生成预测结果。', {
      code: 'INSUFFICIENT_HISTORY_FOR_LINEAR_TREND',
      sampleMonths: values.length,
      requiredMonths: 3
    });
  }

  const n = values.length;
  const xAverage = (n - 1) / 2;
  const yAverage = average(values);
  const denominator = values.reduce((sum, _value, index) => sum + ((index - xAverage) ** 2), 0);
  const slope = denominator === 0
    ? 0
    : values.reduce((sum, value, index) => sum + ((index - xAverage) * (value - yAverage)), 0) / denominator;
  const intercept = yAverage - slope * xAverage;

  return predictionMonths.map((targetMonth, predictionIndex) => {
    const rawPrediction = intercept + slope * (n + predictionIndex);
    const clamped = roundPredictionValue(rawPrediction);
    const clampNotice = rawPrediction < 0 ? '；趋势外推出现负值，已按业务口径截断为 0' : '';
    return {
      targetMonth,
      predictedValue: clamped,
      confidenceLow: roundPredictionValue(clamped * 0.85),
      confidenceHigh: roundPredictionValue(clamped * 1.15),
      methodNote: `轻量线性趋势：基于 ${n} 个历史月份做一元线性外推，slope=${roundPredictionValue(slope)}；confidenceLevel=low，仅作趋势参考${clampNotice}。`
    };
  });
}

function detectHistoryWarnings(points = []) {
  const values = points.map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
  if (values.length < 2) {
    return [];
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = average(values);
  const warnings = [];
  if (avg > 0 && (max - min) / avg > 1) {
    warnings.push('历史数据波动较大，轻量预测结果不宜作为高精度承诺。');
  }
  return warnings;
}

function buildForecast(points = [], predictionMonths = [], options = {}) {
  const algorithm = normalizePredictionAlgorithm(options.algorithm);
  if (algorithm === 'moving_average') {
    return computeMovingAverageForecast(points, predictionMonths, { windowSize: options.windowSize || 3 });
  }
  return computeLinearTrendForecast(points, predictionMonths);
}

module.exports = {
  MONTH_PATTERN,
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_RUN_STATUSES,
  PREDICTION_SORT_COLUMNS,
  SUPPORTED_PREDICTION_ALGORITHMS,
  addMonths,
  buildForecast,
  compareMonths,
  computeLinearTrendForecast,
  computeMovingAverageForecast,
  countMonthsInclusive,
  detectHistoryWarnings,
  generateMonthSequence,
  normalizeMonth,
  normalizePositiveInteger,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  normalizeText,
  roundPredictionValue,
  resolveMovingAverageRequiredHistoryMonths,
  summarizeHistorySufficiency,
  validatePredictionRange
};
