const assert = require('assert');
const {
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_ROUNDING_DIGITS,
  PREDICTION_SORT_COLUMNS,
  addMonths,
  buildPredictionConfidenceFacts,
  computeLinearTrendForecast,
  computeMovingAverageForecast,
  formatPredictionForecastMethodNote,
  generateMonthSequence,
  normalizeMonth,
  isPredictionRoundedValue,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  parsePredictionForecastMethodNote,
  roundPredictionValue,
  roundSignedPredictionValue,
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
assert.match(linearTrend[0].methodNote, /slope=20/);
const descendingLinearTrend = computeLinearTrendForecast(
  [{ month: '2026-01', value: 2 }, { month: '2026-02', value: 1 }, { month: '2026-03', value: 0 }],
  ['2026-04']
);
assert.strictEqual(descendingLinearTrend[0].predictedValue, 0);
assert.match(descendingLinearTrend[0].methodNote, /slope=-1/);
assert.match(descendingLinearTrend[0].methodNote, /负值，已按业务口径截断为 0/);
const flatLinearTrend = computeLinearTrendForecast(
  [{ month: '2026-01', value: 5 }, { month: '2026-02', value: 5 }, { month: '2026-03', value: 5 }],
  ['2026-04']
);
assert.strictEqual(flatLinearTrend[0].predictedValue, 5);
assert.match(flatLinearTrend[0].methodNote, /slope=0/);
assert.throws(
  () => computeLinearTrendForecast([{ month: '2026-01', value: 100 }, { month: '2026-02', value: 120 }], ['2026-03']),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INSUFFICIENT_HISTORY_FOR_LINEAR_TREND'
);

// formatter/parser 对两种算法、signed slope、clamp 与能源/单位后缀执行表驱动闭环。
[
  {
    name: 'moving-average',
    fact: {
      algorithm: 'moving_average',
      windowSize: 3,
      sampleCount: null,
      signedSlope: null,
      clampedToZero: false
    },
    expected: {
      algorithm: 'moving_average',
      windowSize: 3,
      sampleCount: null,
      signedSlope: null,
      clampedToZero: false,
      energyTypeCode: 'electricity',
      canonicalUnit: 'kWh'
    },
    expectedMethodNote: '轻量移动平均：使用最近 3 个历史/预测月份滚动平均；confidenceLevel=low，仅作趋势参考。 能源类型=electricity，单位=kWh。'
  },
  {
    name: 'linear-positive',
    fact: {
      algorithm: 'linear_trend',
      windowSize: null,
      sampleCount: 4,
      signedSlope: 10.123456,
      clampedToZero: false
    },
    expected: {
      algorithm: 'linear_trend',
      windowSize: null,
      sampleCount: 4,
      signedSlope: 10.123456,
      clampedToZero: false,
      energyTypeCode: 'electricity',
      canonicalUnit: 'kWh'
    },
    expectedMethodNote: '轻量线性趋势：基于 4 个历史月份做一元线性外推，slope=10.123456；confidenceLevel=low，仅作趋势参考。 能源类型=electricity，单位=kWh。'
  },
  {
    name: 'linear-negative-clamped',
    fact: {
      algorithm: 'linear_trend',
      windowSize: null,
      sampleCount: 3,
      signedSlope: -1,
      clampedToZero: true
    },
    expected: {
      algorithm: 'linear_trend',
      windowSize: null,
      sampleCount: 3,
      signedSlope: -1,
      clampedToZero: true,
      energyTypeCode: 'water',
      canonicalUnit: 'm3'
    },
    expectedMethodNote: '轻量线性趋势：基于 3 个历史月份做一元线性外推，slope=-1；confidenceLevel=low，仅作趋势参考；趋势外推出现负值，已按业务口径截断为 0。 能源类型=water，单位=m3。'
  }
].forEach((testCase) => {
  const options = {
    energyTypeCode: testCase.expected.energyTypeCode,
    canonicalUnit: testCase.expected.canonicalUnit
  };
  const methodNote = formatPredictionForecastMethodNote(testCase.fact, options);
  assert.strictEqual(
    methodNote,
    testCase.expectedMethodNote,
    `${testCase.name} formatter 必须保持固定完整 method-note 字面量。`
  );
  assert.deepStrictEqual(
    parsePredictionForecastMethodNote(methodNote),
    testCase.expected,
    `${testCase.name} formatter/parser 必须原样闭环。`
  );
});
[
  '',
  '轻量移动平均：使用最近 3 个历史/预测月份滚动平均；confidenceLevel=high，仅作趋势参考。 能源类型=electricity，单位=kWh。',
  '轻量线性趋势：基于 4 个历史月份做一元线性外推，slope=10.1234567；confidenceLevel=low，仅作趋势参考。 能源类型=electricity，单位=kWh。',
  '轻量线性趋势：基于 2 个历史月份做一元线性外推，slope=1；confidenceLevel=low，仅作趋势参考。 能源类型=electricity，单位=kWh。'
].forEach((methodNote) => {
  assert.strictEqual(parsePredictionForecastMethodNote(methodNote), null);
});

// 两种算法 confidence 与六位舍入/负值截断共享唯一表驱动合同。
[
  {
    algorithm: 'moving_average',
    predictedValue: 113.333333,
    expected: {
      confidenceLowMultiplier: 0.9,
      confidenceHighMultiplier: 1.1,
      confidenceLow: 102,
      confidenceHigh: 124.666666
    }
  },
  {
    algorithm: 'linear_trend',
    predictedValue: 160,
    expected: {
      confidenceLowMultiplier: 0.85,
      confidenceHighMultiplier: 1.15,
      confidenceLow: 136,
      confidenceHigh: 184
    }
  }
].forEach((testCase) => {
  const confidence = buildPredictionConfidenceFacts(
    testCase.algorithm,
    testCase.predictedValue
  );
  Object.entries(testCase.expected).forEach(([fieldName, expectedValue]) => {
    assert.strictEqual(confidence[fieldName], expectedValue);
  });
});
assert.strictEqual(PREDICTION_ROUNDING_DIGITS, 6);
[
  { raw: 1.2345674, rounded: 1.234567, signed: 1.234567 },
  { raw: 1.2345675, rounded: 1.234568, signed: 1.234568 },
  { raw: -1.25, rounded: 0, signed: -1.25 },
  { raw: -0, rounded: 0, signed: 0 }
].forEach((testCase) => {
  assert.strictEqual(roundPredictionValue(testCase.raw), testCase.rounded);
  assert.strictEqual(roundSignedPredictionValue(testCase.raw), testCase.signed);
  assert.strictEqual(isPredictionRoundedValue(testCase.rounded, { nonNegative: true }), true);
});
assert.strictEqual(isPredictionRoundedValue(1.0000001), false);
assert.strictEqual(isPredictionRoundedValue(-1, { nonNegative: true }), false);

// 非 finite、隐式文本数值和算法中间溢出必须受控阻断，不能静默生成 0。
assert.throws(
  () => roundPredictionValue(Number.POSITIVE_INFINITY),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_NUMERIC_INTEGRITY_ERROR'
);
assert.throws(
  () => computeMovingAverageForecast([
    { month: '2026-01', value: Number.MAX_VALUE / 2 },
    { month: '2026-02', value: Number.MAX_VALUE / 2 },
    { month: '2026-03', value: Number.MAX_VALUE / 2 }
  ], ['2026-04'], { windowSize: 3 }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_NUMERIC_INTEGRITY_ERROR'
);
assert.throws(
  () => computeLinearTrendForecast([
    { month: '2026-01', value: Number.MAX_VALUE / 2 },
    { month: '2026-02', value: Number.MAX_VALUE / 2 },
    { month: '2026-03', value: Number.MAX_VALUE / 2 }
  ], ['2026-04']),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_NUMERIC_INTEGRITY_ERROR'
);
assert.throws(
  () => computeMovingAverageForecast([
    { month: '2026-01', value: '100' },
    { month: '2026-02', value: 110 },
    { month: '2026-03', value: 120 }
  ], ['2026-04'], { windowSize: 3 }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_NUMERIC_INTEGRITY_ERROR'
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

// 0、空串和冲突别名必须进入显式校验，不能被 falsey 合并为缺省。
[
  { sourceBatchId: 0 },
  { organizationUnitId: 0 },
  { meterDeviceId: 0 },
  { windowSize: 0 }
].forEach((override) => {
  assert.throws(
    () => normalizePredictionPayload({
      ...payload,
      ...override,
      trainStartMonth: '2026-01',
      trainEndMonth: '2026-03',
      predictStartMonth: '2026-04',
      predictEndMonth: '2026-04'
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_INTEGER'
  );
});
assert.throws(
  () => normalizePredictionPayload({
    trainStartMonth: '2026-01',
    train_start_month: '2026-02',
    trainEndMonth: '2026-03',
    predictStartMonth: '2026-04',
    predictEndMonth: '2026-04'
  }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_ALIAS_CONFLICT'
);
assert.throws(
  () => normalizePredictionPayload({
    sourceBatchId: 9,
    source_batch_id: 10,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-03',
    predictStartMonth: '2026-04',
    predictEndMonth: '2026-04'
  }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_ALIAS_CONFLICT'
);
assert.throws(
  () => normalizePredictionPayload({
    sourceBatchId: '',
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-03',
    predictStartMonth: '2026-04',
    predictEndMonth: '2026-04'
  }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'PREDICTION_EMPTY_ALIAS_VALUE'
);
assert.strictEqual(normalizePredictionPayload({
  sourceBatchId: '9',
  source_batch_id: 9,
  trainStartMonth: '2026-01',
  train_start_month: '2026-01',
  trainEndMonth: '2026-03',
  predictStartMonth: '2026-04',
  predictEndMonth: '2026-04'
}).filters.sourceBatchId, 9);

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
