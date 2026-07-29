const assert = require('assert');
const {
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_SORT_COLUMNS,
  addMonths,
  computeLinearTrendForecast,
  computeMovingAverageForecast,
  generateMonthSequence,
  normalizeMonth,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  resolveMovingAverageRequiredHistoryMonths,
  summarizeHistorySufficiency,
  validatePredictionRange
} = require('../services/predictionUtils');
const {
  buildHistoryWhere,
  buildResultWhere,
  buildRunListWhere,
  normalizePredictionPayload
} = require('../services/predictionService');

assert.strictEqual(normalizeMonth('2026-01', 'month'), '2026-01');
assert.throws(
  () => normalizeMonth('2026-00', 'month'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH'
);
assert.throws(
  () => normalizeMonth('2026-13', 'month'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH'
);
assert.deepStrictEqual(generateMonthSequence('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
assert.strictEqual(addMonths('2026-12', 1), '2027-01');
assert.throws(
  () => generateMonthSequence('2026-12', '2026-01'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH_RANGE'
);

const range = validatePredictionRange({
  trainStartMonth: '2026-01',
  trainEndMonth: '2026-03',
  predictStartMonth: '2026-04',
  predictEndMonth: '2026-06'
});
assert.deepStrictEqual(range.trainMonths, ['2026-01', '2026-02', '2026-03']);
assert.deepStrictEqual(range.predictionMonths, ['2026-04', '2026-05', '2026-06']);
assert.throws(
  () => validatePredictionRange({ trainStartMonth: '2026-01', trainEndMonth: '2026-06', predictStartMonth: '2026-06', predictEndMonth: '2026-07' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_PREDICTION_RANGE'
);
assert.throws(
  () => validatePredictionRange({ trainStartMonth: '2026-01', trainEndMonth: '2026-03', predictStartMonth: '2026-04', predictEndMonth: '2028-04' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_RANGE_TOO_LONG'
);

const sufficiency = summarizeHistorySufficiency(
  [{ month: '2026-01', value: 100 }, { month: '2026-03', value: 120 }],
  ['2026-01', '2026-02', '2026-03'],
  { minHistoryMonths: 3 }
);
assert.strictEqual(sufficiency.sufficient, false);
assert.strictEqual(sufficiency.sampleMonths, 2);
assert.deepStrictEqual(sufficiency.missingMonths, ['2026-02']);
assert.match(sufficiency.warnings.join('；'), /历史样本月份不足/);

assert.strictEqual(resolveMovingAverageRequiredHistoryMonths(2), 3);
const movingAverageWindowTwoInsufficient = summarizeHistorySufficiency(
  [{ month: '2026-01', value: 100 }, { month: '2026-02', value: 110 }],
  ['2026-01', '2026-02'],
  { minHistoryMonths: resolveMovingAverageRequiredHistoryMonths(2) }
);
assert.strictEqual(movingAverageWindowTwoInsufficient.sufficient, false);
assert.strictEqual(movingAverageWindowTwoInsufficient.sampleMonths, 2);
assert.strictEqual(movingAverageWindowTwoInsufficient.requiredMonths, 3);
assert.throws(
  () => computeMovingAverageForecast(
    [{ month: '2026-01', value: 100 }, { month: '2026-02', value: 110 }],
    ['2026-03'],
    { windowSize: 2 }
  ),
  (error) => error.code === 'BAD_REQUEST'
    && error.details.code === 'INSUFFICIENT_HISTORY_FOR_MOVING_AVERAGE'
    && error.details.requiredMonths === 3
    && error.details.sampleMonths === 2
);

const movingAverage = computeMovingAverageForecast(
  [{ month: '2026-01', value: 100 }, { month: '2026-02', value: 110 }, { month: '2026-03', value: 130 }],
  ['2026-04', '2026-05'],
  { windowSize: 3 }
);
assert.strictEqual(movingAverage[0].predictedValue, 113.333333);
assert.strictEqual(movingAverage[1].predictedValue, 117.777778);
assert.strictEqual(movingAverage[0].confidenceLow, 102);
assert.match(movingAverage[0].methodNote, /移动平均/);
assert.throws(
  () => computeMovingAverageForecast([{ month: '2026-01', value: 100 }], ['2026-02'], { windowSize: 3 }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INSUFFICIENT_HISTORY_FOR_MOVING_AVERAGE'
);

const linearTrend = computeLinearTrendForecast(
  [{ month: '2026-01', value: 100 }, { month: '2026-02', value: 120 }, { month: '2026-03', value: 140 }],
  ['2026-04', '2026-05']
);
assert.strictEqual(linearTrend[0].predictedValue, 160);
assert.strictEqual(linearTrend[1].predictedValue, 180);
assert.strictEqual(linearTrend[0].confidenceLow, 136);
assert.strictEqual(linearTrend[0].confidenceHigh, 184);
assert.match(linearTrend[0].methodNote, /线性趋势/);
assert.throws(
  () => computeLinearTrendForecast([{ month: '2026-01', value: 100 }, { month: '2026-02', value: 120 }], ['2026-03']),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INSUFFICIENT_HISTORY_FOR_LINEAR_TREND'
);

assert.strictEqual(normalizePredictionAlgorithm(undefined), 'moving_average');
assert.strictEqual(normalizePredictionAlgorithm('linear_trend'), 'linear_trend');
assert.throws(
  () => normalizePredictionAlgorithm('year_over_year'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_PREDICTION_ALGORITHM'
);
assert.strictEqual(normalizePredictionStatus('completed'), 'completed');
assert.throws(
  () => normalizePredictionStatus('completed;DROP TABLE prediction_runs'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_PREDICTION_STATUS'
);

Object.keys(PREDICTION_SORT_COLUMNS).forEach((sortBy) => {
  assert.strictEqual(normalizeSort({ sortBy, sortOrder: 'asc' }).sortBy, sortBy);
});
Object.keys(PREDICTION_RESULT_SORT_COLUMNS).forEach((sortBy) => {
  assert.strictEqual(normalizeSort({ sortBy, sortOrder: 'desc' }, PREDICTION_RESULT_SORT_COLUMNS).sortBy, sortBy);
});
assert.throws(
  () => normalizeSort({ sortBy: 'created_at;DROP TABLE prediction_runs' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_SORT_FIELD'
);
assert.throws(
  () => normalizeSort({ sortBy: 'createdAt', sortOrder: 'delete' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_SORT_ORDER'
);

const payload = normalizePredictionPayload({
  algorithm: 'moving_average',
  energyTypeCode: 'electricity',
  trainStartMonth: '2026-01',
  trainEndMonth: '2026-03',
  predictStartMonth: '2026-04',
  predictEndMonth: '2026-04',
  organization: '总部',
  site: 'A园区',
  department: '生产部',
  sourceBatchId: '9',
  windowSize: '2'
});
assert.strictEqual(payload.algorithm, 'moving_average');
assert.strictEqual(payload.filters.energyTypeCode, 'electricity');
assert.strictEqual(payload.filters.sourceBatchId, 9);
assert.strictEqual(payload.windowSize, 2);
assert.strictEqual(payload.requiredHistoryMonths, 3);
assert.deepStrictEqual(payload.predictionMonths, ['2026-04']);

const historyWhere = buildHistoryWhere(payload);
assert.strictEqual(historyWhere.whereSql.includes('et.code = @energyTypeCode'), true);
assert.strictEqual(historyWhere.whereSql.includes('electricity'), false);
assert.strictEqual(historyWhere.params.energyTypeCode, 'electricity');
assert.strictEqual(historyWhere.params.sourceBatchId, 9);

const runWhere = buildRunListWhere({ algorithm: 'moving_average', status: 'completed', energyTypeCode: 'electricity' });
assert.strictEqual(runWhere.whereSql.includes('pr.algorithm = @algorithm'), true);
assert.strictEqual(runWhere.whereSql.includes('moving_average'), false);
assert.strictEqual(runWhere.params.status, 'completed');

const resultWhere = buildResultWhere({ runId: 7, energyTypeCode: 'electricity', targetMonthStart: '2026-04', targetMonthEnd: '2026-06' });
assert.strictEqual(resultWhere.whereSql.includes('pres.prediction_run_id = @runId'), true);
assert.strictEqual(resultWhere.whereSql.includes('2026-04'), false);
assert.strictEqual(resultWhere.params.runId, 7);

console.log('prediction utility tests passed');
