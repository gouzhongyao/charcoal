'use strict';

const assert = require('assert');
const { ENERGY_ANALYSIS_REASON_CODES } = require('../services/energyAnalysisContracts');
const {
  FIXED_UTC_OUTPUT_INTERVAL_MINUTES,
  allocateEnergyByUtcOverlap,
  allocateEnergyToActualShifts,
  allocateEnergyToShifts,
  allocateTimeOfUseEnergy,
  buildFixedUtcLoadBuckets,
  buildStrategyEvaluation,
  calculateEnergyBalance,
  calculateEnergyFlowNodeDifference,
  calculateLoadMetrics,
  calculatePeakIntervalEnergy,
  calculatePeriodComparison,
  calculateUtcOverlapMinutes,
  convertRatioToPercentage,
  convertToStandardCoal,
  createFixedUtcBucketIntervals,
  evaluateBenchmark,
  evaluateStrategyThreshold,
  isSupportedLocalTimeProjectionRange,
  projectFixedUtcBucketsToLocalHeatmap,
  roundAnalysisValue,
  splitTimeOfUseEnergy,
  summarizeDeviceStateCoverage
} = require('../services/energyAnalysisUtils');
const { createEnergyAnalysisAcceptanceFixture } = require('./energyAnalysisAcceptanceFixture');

// 阶段 1 统一隔离验收数据。
const fixture = createEnergyAnalysisAcceptanceFixture();

// 测试构造时间区间使用的一分钟毫秒数。
const TEST_MINUTE_MS = 60 * 1000;

/**
 * 断言两个浮点数在指定误差内相等。
 * @param {number} actual 实际值。
 * @param {number} expected 预期值。
 * @param {number} tolerance 允许误差。
 */
function assertClose(actual, expected, tolerance = 1e-10) {
  assert.strictEqual(Number.isFinite(actual), true);
  assert.strictEqual(Math.abs(actual - expected) <= tolerance, true, `${actual} 不接近 ${expected}`);
}

/**
 * 断言结果只返回阶段 1 批准原因码。
 * @param {object} result 待检查结果。
 */
function assertApprovedReasonCodes(result) {
  assert.strictEqual(Array.isArray(result.reasonCodes), true);
  result.reasonCodes.forEach((code) => {
    assert.strictEqual(ENERGY_ANALYSIS_REASON_CODES.includes(code), true, `未批准原因码：${code}`);
  });
}

/**
 * 递归断言结果中的全部数值均为有限值。
 * @param {*} value 待检查值。
 */
function assertNoNonFiniteNumbers(value) {
  if (typeof value === 'number') {
    assert.strictEqual(Number.isFinite(value), true, `发现非有限数值：${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoNonFiniteNumbers);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(assertNoNonFiniteNumbers);
  }
}

/**
 * 克隆平衡项目，避免测试之间共享修改。
 * @param {object[]} items 平衡项目。
 * @returns {object[]} 克隆结果。
 */
function cloneBalanceItems(items) {
  return items.map((item) => ({
    ...item,
    sourceMapping: { ...item.sourceMapping }
  }));
}

// 极大有限值乘精度因子溢出时，小数舍入已无意义，应安全保留原有限值。
const hugeRoundedValue = roundAnalysisValue(1e308);
assert.strictEqual(hugeRoundedValue, 1e308);
assert.strictEqual(Number.isFinite(hugeRoundedValue), true);

// UTC 左闭右开重叠分钟按边界精确计算，无重叠必须返回真实 0。
assert.strictEqual(calculateUtcOverlapMinutes(
  { startUtc: '2026-07-15T01:45:00.000Z', endUtc: '2026-07-15T02:15:00.000Z' },
  { startUtc: '2026-07-15T02:00:00.000Z', endUtc: '2026-07-15T02:30:00.000Z' }
), 15);
assert.strictEqual(calculateUtcOverlapMinutes(
  { startUtc: '2026-07-15T01:00:00.000Z', endUtc: '2026-07-15T02:00:00.000Z' },
  { startUtc: '2026-07-15T02:00:00.000Z', endUtc: '2026-07-15T03:00:00.000Z' }
), 0);
assert.strictEqual(calculateUtcOverlapMinutes(null, null), 0);

// 30 kWh 在 30 分钟内均匀分布，重叠 15 分钟分配 15 kWh。
const overlapAllocation = allocateEnergyByUtcOverlap({
  value: 30,
  startUtc: '2026-07-15T01:45:00.000Z',
  endUtc: '2026-07-15T02:15:00.000Z'
}, {
  startUtc: '2026-07-15T02:00:00.000Z',
  endUtc: '2026-07-15T02:30:00.000Z'
});
assert.strictEqual(overlapAllocation.value, 15);
assert.strictEqual(overlapAllocation.overlapMinutes, 15);
assert.strictEqual(overlapAllocation.assumption, 'uniform_within_interval');
assert.strictEqual(allocateEnergyByUtcOverlap({
  value: 30,
  startUtc: '2026-07-15T01:00:00.000Z',
  endUtc: '2026-07-15T01:30:00.000Z'
}, {
  startUtc: '2026-07-15T02:00:00.000Z',
  endUtc: '2026-07-15T02:30:00.000Z'
}).value, 0);

// 目标区间畸形时不得把无法计算伪装成无重叠的真实 0。
const invalidTargetAllocation = allocateEnergyByUtcOverlap({
  value: 30,
  startUtc: '2026-07-15T01:00:00.000Z',
  endUtc: '2026-07-15T01:30:00.000Z'
}, null);
assert.strictEqual(invalidTargetAllocation.value, null);
assert.strictEqual(invalidTargetAllocation.overlapMinutes, null);
assert.deepStrictEqual(invalidTargetAllocation.errors, ['INVALID_TARGET_INTERVAL']);
assert.deepStrictEqual(invalidTargetAllocation.reasonCodes, ['NO_TIMESERIES_DATA']);

// 固定 UTC 网格只支持 15/30/60 分钟，并可稳定生成 3000/3001 个左闭右开桶。
assert.deepStrictEqual(FIXED_UTC_OUTPUT_INTERVAL_MINUTES, [15, 30, 60]);
const epochStartUtc = '1970-01-01T00:00:00.000Z';
const threeThousandBucketEndUtc = new Date(3000 * 15 * 60 * 1000).toISOString();
const threeThousandOneBucketEndUtc = new Date(3001 * 15 * 60 * 1000).toISOString();
assert.strictEqual(createFixedUtcBucketIntervals({
  startUtc: epochStartUtc,
  endUtc: threeThousandBucketEndUtc
}, 15).length, 3000);
assert.strictEqual(createFixedUtcBucketIntervals({
  startUtc: epochStartUtc,
  endUtc: threeThousandOneBucketEndUtc
}, 15).length, 3001);
assert.deepStrictEqual(createFixedUtcBucketIntervals({
  startUtc: '2026-07-15T00:01:00.000Z',
  endUtc: '2026-07-15T00:31:00.000Z'
}, 15), []);

// 15 分钟来源投影到 15 分钟桶保持真实观测，投影到 30 分钟桶只聚合不分配。
const fixedCurveWindow = {
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T01:00:00.000Z',
  sourceTimeZone: 'Asia/Shanghai'
};
const quarterHourCurveRecords = [15, 30, 0, 15].map((value, index) => ({
  id: `fixed-quarter-${index + 1}`,
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value,
  startUtc: new Date(Date.parse(fixedCurveWindow.startUtc) + index * 15 * 60 * 1000).toISOString(),
  endUtc: new Date(Date.parse(fixedCurveWindow.startUtc) + (index + 1) * 15 * 60 * 1000).toISOString(),
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 15
}));
const fifteenToFifteenCurve = buildFixedUtcLoadBuckets(
  quarterHourCurveRecords,
  fixedCurveWindow,
  15
);
assert.deepStrictEqual(fifteenToFifteenCurve.buckets.map((bucket) => bucket.energy), [15, 30, 0, 15]);
assert.deepStrictEqual(
  fifteenToFifteenCurve.buckets.map((bucket) => bucket.observationMode),
  ['observed', 'observed', 'observed', 'observed']
);
assert.strictEqual(fifteenToFifteenCurve.observedEnergy, 60);
assert.strictEqual(fifteenToFifteenCurve.totalEnergy, 60);
assert.strictEqual(fifteenToFifteenCurve.conservationDifference, 0);
assert.deepStrictEqual(fifteenToFifteenCurve.reasonCodes, []);
const fifteenToThirtyCurve = buildFixedUtcLoadBuckets(
  quarterHourCurveRecords,
  fixedCurveWindow,
  30
);
assert.deepStrictEqual(fifteenToThirtyCurve.buckets.map((bucket) => bucket.energy), [45, 15]);
assert.deepStrictEqual(
  fifteenToThirtyCurve.buckets.map((bucket) => bucket.observationMode),
  ['aggregated', 'aggregated']
);
assert.strictEqual(fifteenToThirtyCurve.allocationUsed, false);
assert.strictEqual(fifteenToThirtyCurve.conservationDifference, 0);

// 30/60 分钟来源拆到 15 分钟桶必须显式标记 allocated 和区间内均匀分配假设。
const thirtyToFifteenCurve = buildFixedUtcLoadBuckets([{
  id: 'fixed-thirty-source',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 30,
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:30:00.000Z',
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 30
}], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:30:00.000Z'
}, 15);
assert.deepStrictEqual(thirtyToFifteenCurve.buckets.map((bucket) => bucket.energy), [15, 15]);
assert.deepStrictEqual(
  thirtyToFifteenCurve.buckets.map((bucket) => bucket.observationMode),
  ['allocated', 'allocated']
);
assert.deepStrictEqual(
  thirtyToFifteenCurve.buckets.map((bucket) => bucket.allocationAssumption),
  ['uniform_within_interval', 'uniform_within_interval']
);
const sixtyToFifteenCurve = buildFixedUtcLoadBuckets([{
  id: 'fixed-sixty-source',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 60,
  startUtc: fixedCurveWindow.startUtc,
  endUtc: fixedCurveWindow.endUtc,
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 60
}], fixedCurveWindow, 15);
assert.deepStrictEqual(sixtyToFifteenCurve.buckets.map((bucket) => bucket.energy), [15, 15, 15, 15]);
assert.strictEqual(sixtyToFifteenCurve.allocationUsed, true);
assert.strictEqual(sixtyToFifteenCurve.conservationDifference, 0);

// 跨桶边界来源按真实重叠分钟分配，部分覆盖不外推到完整桶且整体能源守恒。
const crossBoundaryCurve = buildFixedUtcLoadBuckets([{
  id: 'fixed-cross-boundary',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 30,
  startUtc: '2026-07-14T23:55:00.000Z',
  endUtc: '2026-07-15T00:25:00.000Z',
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 30
}], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:30:00.000Z'
}, 15);
assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.energy), [15, 10]);
assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.coveredMinutes), [15, 10]);
assert.deepStrictEqual(crossBoundaryCurve.buckets.map((bucket) => bucket.averageLoad), [60, 60]);
assert.strictEqual(crossBoundaryCurve.observedEnergy, 25);
assert.strictEqual(crossBoundaryCurve.totalEnergy, null);
assert.strictEqual(crossBoundaryCurve.conservationDifference, 0);
assert.deepStrictEqual(crossBoundaryCurve.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);

// 完全缺失保持 null，部分覆盖只标覆盖不足，完整真实零仍保留为 0。
const noDataFixedCurve = buildFixedUtcLoadBuckets([], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:30:00.000Z'
}, 15);
assert.deepStrictEqual(noDataFixedCurve.buckets.map((bucket) => bucket.energy), [null, null]);
assert.strictEqual(noDataFixedCurve.observedEnergy, null);
assert.deepStrictEqual(noDataFixedCurve.reasonCodes, ['NO_TIMESERIES_DATA']);
const nullValueFixedCurve = buildFixedUtcLoadBuckets([
  { ...quarterHourCurveRecords[0], value: null }
], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:15:00.000Z'
}, 15);
assert.strictEqual(nullValueFixedCurve.numericOverflow, false);
assert.deepStrictEqual(nullValueFixedCurve.buckets.map((bucket) => bucket.energy), [null]);
assert.deepStrictEqual(nullValueFixedCurve.reasonCodes, ['NO_TIMESERIES_DATA']);
const partialFixedCurve = buildFixedUtcLoadBuckets([quarterHourCurveRecords[0]], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:30:00.000Z'
}, 15);
assert.deepStrictEqual(partialFixedCurve.buckets.map((bucket) => bucket.energy), [15, null]);
assert.strictEqual(partialFixedCurve.observedEnergy, 15);
assert.strictEqual(partialFixedCurve.totalEnergy, null);
assert.deepStrictEqual(partialFixedCurve.reasonCodes, ['COVERAGE_BELOW_THRESHOLD']);
const zeroFixedCurve = buildFixedUtcLoadBuckets(
  quarterHourCurveRecords.map((record) => ({ ...record, value: 0 })),
  fixedCurveWindow,
  15
);
assert.deepStrictEqual(zeroFixedCurve.buckets.map((bucket) => bucket.energy), [0, 0, 0, 0]);
assert.deepStrictEqual(zeroFixedCurve.buckets.map((bucket) => bucket.averageLoad), [0, 0, 0, 0]);
assert.strictEqual(zeroFixedCurve.totalEnergy, 0);
assert.deepStrictEqual(zeroFixedCurve.reasonCodes, []);

// 来源重叠整次不可计算；合法非重叠混合粒度允许并通过质量属性披露。
const overlappingFixedCurve = buildFixedUtcLoadBuckets([
  quarterHourCurveRecords[0],
  { ...quarterHourCurveRecords[0], id: 'fixed-overlap-duplicate' }
], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:15:00.000Z'
}, 15);
assert.deepStrictEqual(overlappingFixedCurve.buckets.map((bucket) => bucket.energy), [null]);
assert.deepStrictEqual(overlappingFixedCurve.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
const legalMixedFixedCurve = buildFixedUtcLoadBuckets([
  quarterHourCurveRecords[0],
  {
    id: 'fixed-mixed-thirty',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 30,
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    granularityMinutes: 30
  }
], {
  ...fixedCurveWindow,
  endUtc: '2026-07-15T00:45:00.000Z'
}, 15);
assert.deepStrictEqual(legalMixedFixedCurve.buckets.map((bucket) => bucket.energy), [15, 15, 15]);
assert.strictEqual(legalMixedFixedCurve.mixedSourceGranularity, true);
assert.deepStrictEqual(legalMixedFixedCurve.sourceGranularityMinutes, [15, 30]);
assert.deepStrictEqual(legalMixedFixedCurve.reasonCodes, []);
assert.strictEqual(legalMixedFixedCurve.conservationDifference, 0);

// 长区间每桶独立舍入，末尾真实零桶不得被全局残差污染为负数。
const longCurveStartMs = Date.parse('2026-01-01T00:00:00.000Z');
const longCurveWindow = {
  startUtc: new Date(longCurveStartMs).toISOString(),
  endUtc: new Date(longCurveStartMs + 31 * 24 * 60 * TEST_MINUTE_MS).toISOString(),
  sourceTimeZone: 'Etc/GMT'
};
const offsetHourlyRecords = Array.from({ length: 745 }, (_unused, index) => {
  const startMs = longCurveStartMs - 59 * TEST_MINUTE_MS + index * 60 * TEST_MINUTE_MS;
  return {
    id: `rounding-hour-${index}`,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: index === 744 ? 0 : 37,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + 60 * TEST_MINUTE_MS).toISOString(),
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 60
  };
});
const longRoundingCurve = buildFixedUtcLoadBuckets(offsetHourlyRecords, longCurveWindow, 15);
assert.strictEqual(longRoundingCurve.buckets.length, 31 * 24 * 4);
assert.strictEqual(longRoundingCurve.buckets[longRoundingCurve.buckets.length - 1].energy, 0);
longRoundingCurve.buckets.forEach((bucket) => {
  if (bucket.energy !== null) {
    assert.strictEqual(bucket.energy >= 0, true, `固定桶能源不得为负：${bucket.energy}`);
  }
  if (bucket.averageLoad !== null) {
    assert.strictEqual(bucket.averageLoad >= 0, true, `固定桶平均负荷不得为负：${bucket.averageLoad}`);
  }
});
assertClose(longRoundingCurve.roundedBucketTotal, longRoundingCurve.buckets.reduce(
  (sum, bucket) => sum + (bucket.energy === null ? 0 : bucket.energy),
  0
), 1e-12);
assert.strictEqual(
  longRoundingCurve.conservationDifference,
  longRoundingCurve.observedEnergy - longRoundingCurve.roundedBucketTotal
);
assertClose(longRoundingCurve.conservationDifference, 0, 1e-9);

// 一个精确微量 observed 桶后接 2972 个 allocated 微量桶，不得把全局残差搬入首桶。
const microCurveStartMs = Date.parse('2026-01-01T00:00:00.000Z');
const microCurveRecords = [{
  id: 'micro-observed',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 1e-12,
  startUtc: new Date(microCurveStartMs).toISOString(),
  endUtc: new Date(microCurveStartMs + 15 * TEST_MINUTE_MS).toISOString(),
  sourceTimeZone: 'Etc/GMT',
  granularityMinutes: 15
}].concat(Array.from({ length: 743 }, (_unused, index) => {
  const startMs = microCurveStartMs + 15 * TEST_MINUTE_MS + index * 60 * TEST_MINUTE_MS;
  return {
    id: `micro-allocated-${index}`,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 1e-12,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + 60 * TEST_MINUTE_MS).toISOString(),
    sourceTimeZone: 'Etc/GMT',
    granularityMinutes: 60
  };
}));
const microCurveEndMs = microCurveStartMs + (15 + 743 * 60) * TEST_MINUTE_MS;
const microRoundingCurve = buildFixedUtcLoadBuckets(microCurveRecords, {
  startUtc: new Date(microCurveStartMs).toISOString(),
  endUtc: new Date(microCurveEndMs).toISOString(),
  sourceTimeZone: 'Etc/GMT'
}, 15);
assert.strictEqual(microRoundingCurve.buckets.length, 1 + 2972);
assert.strictEqual(microRoundingCurve.buckets[0].observationMode, 'observed');
assert.strictEqual(microRoundingCurve.buckets[0].energy, 1e-12);
assert.strictEqual(microRoundingCurve.buckets.slice(1).every((bucket) => (
  bucket.observationMode === 'allocated' && bucket.energy === 0
)), true);
assert.strictEqual(microRoundingCurve.observedEnergy, 7.44e-10);
assert.strictEqual(microRoundingCurve.roundedBucketTotal, 1e-12);
assert.strictEqual(microRoundingCurve.conservationDifference, 7.43e-10);
assert.strictEqual(
  microRoundingCurve.conservationDifference,
  microRoundingCurve.observedEnergy - microRoundingCurve.roundedBucketTotal
);

// 公元 0 年在工具层稳定拒绝；支持范围内的早期年份必须输出四位 localDate。
assert.deepStrictEqual(createFixedUtcBucketIntervals({
  startUtc: '0000-01-01T00:00:00.000Z',
  endUtc: '0000-01-01T00:15:00.000Z'
}, 15), []);
assert.deepStrictEqual(projectFixedUtcBucketsToLocalHeatmap([{
  bucketIndex: 0,
  startUtc: '0000-01-01T00:00:00.000Z',
  endUtc: '0000-01-01T00:15:00.000Z'
}], 'Etc/GMT'), []);
const earlyYearHeatmap = projectFixedUtcBucketsToLocalHeatmap(
  createFixedUtcBucketIntervals({
    startUtc: '0001-01-01T00:00:00.000Z',
    endUtc: '0001-01-01T00:15:00.000Z'
  }, 15),
  'Etc/GMT'
);
assert.strictEqual(earlyYearHeatmap.length, 1);
assert.strictEqual(earlyYearHeatmap[0].localDate, '0001-01-01');
const earlyYearWindow = {
  startUtc: '0001-01-01T00:00:00.000Z',
  endUtc: '0001-01-01T00:15:00.000Z'
};
assert.deepStrictEqual(
  isSupportedLocalTimeProjectionRange(earlyYearWindow, 'Etc/GMT'),
  { status: 'supported' }
);
['America/New_York', 'America/St_Johns'].forEach((sourceTimeZone) => {
  assert.deepStrictEqual(
    isSupportedLocalTimeProjectionRange(earlyYearWindow, sourceTimeZone),
    { status: 'unsupported_range' }
  );
});
const originalProjectionFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
try {
  Intl.DateTimeFormat.prototype.formatToParts = () => [
    { type: 'era', value: 'AD' },
    { type: 'year', value: '2026' },
    { type: 'month', value: '07' },
    { type: 'day', value: '15' },
    { type: 'hour', value: '08' },
    { type: 'minute', value: '00' },
    { type: 'second', value: '00' },
    { type: 'timeZoneName', value: 'UNEXPECTED_OFFSET' }
  ];
  assert.deepStrictEqual(isSupportedLocalTimeProjectionRange({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z'
  }, 'Asia/Shanghai'), { status: 'projection_failed' });
  Intl.DateTimeFormat.prototype.formatToParts = () => {
    throw new Error('controlled Intl projection failure');
  };
  assert.deepStrictEqual(isSupportedLocalTimeProjectionRange({
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z'
  }, 'Asia/Shanghai'), { status: 'projection_failed' });
} finally {
  Intl.DateTimeFormat.prototype.formatToParts = originalProjectionFormatToParts;
}

// 本地热力只从 UTC 桶投影：春跳不造 02 点，秋回重复 01 点分别保留 offset 和 fold。
const springUtcBuckets = createFixedUtcBucketIntervals({
  startUtc: '2026-03-08T06:00:00.000Z',
  endUtc: '2026-03-08T08:00:00.000Z'
}, 30);
const springHeatmap = projectFixedUtcBucketsToLocalHeatmap(
  springUtcBuckets,
  'America/New_York'
);
assert.deepStrictEqual(springHeatmap.map((bucket) => bucket.localTime), ['01:00', '01:30', '03:00', '03:30']);
assert.strictEqual(springHeatmap.some((bucket) => bucket.localTime.startsWith('02:')), false);
assert.deepStrictEqual(springHeatmap.map((bucket) => bucket.bucketIndex), [0, 1, 2, 3]);
const fallUtcBuckets = createFixedUtcBucketIntervals({
  startUtc: '2026-11-01T05:00:00.000Z',
  endUtc: '2026-11-01T07:00:00.000Z'
}, 30);
const fallHeatmap = projectFixedUtcBucketsToLocalHeatmap(
  fallUtcBuckets,
  'America/New_York'
);
assert.deepStrictEqual(fallHeatmap.map((bucket) => bucket.localTime), ['01:00', '01:30', '01:00', '01:30']);
assert.deepStrictEqual(fallHeatmap.map((bucket) => bucket.utcOffset), ['-04:00', '-04:00', '-05:00', '-05:00']);
assert.deepStrictEqual(fallHeatmap.map((bucket) => bucket.fold), [0, 0, 1, 1]);
assert.strictEqual(new Set(fallHeatmap.map((bucket) => bucket.key)).size, 4);

// fold 和 key 必须只由 UTC 时刻及时区关系决定，不得因查询窗口裁剪而变化。
const fallHeatmapByStartUtc = new Map(fallHeatmap.map((bucket) => [bucket.startUtc, bucket]));
const fallWindowVariants = [
  {
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T06:00:00.000Z'
  },
  {
    startUtc: '2026-11-01T06:00:00.000Z',
    endUtc: '2026-11-01T07:00:00.000Z'
  },
  {
    startUtc: '2026-11-01T05:30:00.000Z',
    endUtc: '2026-11-01T06:30:00.000Z'
  }
];
fallWindowVariants.forEach((windowInterval) => {
  const variantHeatmap = projectFixedUtcBucketsToLocalHeatmap(
    createFixedUtcBucketIntervals(windowInterval, 30),
    'America/New_York'
  );
  variantHeatmap.forEach((bucket) => {
    const fullWindowBucket = fallHeatmapByStartUtc.get(bucket.startUtc);
    assert(fullWindowBucket, `完整窗口必须包含 UTC 桶 ${bucket.startUtc}`);
    assert.strictEqual(bucket.fold, fullWindowBucket.fold);
    assert.strictEqual(bucket.key, fullWindowBucket.key);
  });
});
const firstFoldOnly = projectFixedUtcBucketsToLocalHeatmap(
  createFixedUtcBucketIntervals({
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T05:30:00.000Z'
  }, 30),
  'America/New_York'
);
const secondFoldOnly = projectFixedUtcBucketsToLocalHeatmap(
  createFixedUtcBucketIntervals({
    startUtc: '2026-11-01T06:00:00.000Z',
    endUtc: '2026-11-01T06:30:00.000Z'
  }, 30),
  'America/New_York'
);
assert.strictEqual(firstFoldOnly[0].fold, 0);
assert.strictEqual(secondFoldOnly[0].fold, 1);
assert.strictEqual(firstFoldOnly[0].localTime, secondFoldOnly[0].localTime);
assert.notStrictEqual(firstFoldOnly[0].key, secondFoldOnly[0].key);

// Lord Howe 仅回拨 30 分钟，完整与裁剪窗口中的 fold/key 仍必须按 UTC 桶保持稳定。
const lordHoweFullHeatmap = projectFixedUtcBucketsToLocalHeatmap(
  createFixedUtcBucketIntervals({
    startUtc: '2026-04-04T14:30:00.000Z',
    endUtc: '2026-04-04T15:30:00.000Z'
  }, 15),
  'Australia/Lord_Howe'
);
assert.deepStrictEqual(
  lordHoweFullHeatmap.map((bucket) => bucket.localTime),
  ['01:30', '01:45', '01:30', '01:45']
);
assert.deepStrictEqual(
  lordHoweFullHeatmap.map((bucket) => bucket.utcOffset),
  ['+11:00', '+11:00', '+10:30', '+10:30']
);
assert.deepStrictEqual(lordHoweFullHeatmap.map((bucket) => bucket.fold), [0, 0, 1, 1]);
assert.strictEqual(new Set(lordHoweFullHeatmap.map((bucket) => bucket.key)).size, 4);
const lordHoweHeatmapByStartUtc = new Map(
  lordHoweFullHeatmap.map((bucket) => [bucket.startUtc, bucket])
);
[
  {
    startUtc: '2026-04-04T14:30:00.000Z',
    endUtc: '2026-04-04T15:00:00.000Z'
  },
  {
    startUtc: '2026-04-04T15:00:00.000Z',
    endUtc: '2026-04-04T15:30:00.000Z'
  },
  {
    startUtc: '2026-04-04T14:45:00.000Z',
    endUtc: '2026-04-04T15:15:00.000Z'
  }
].forEach((windowInterval) => {
  const croppedHeatmap = projectFixedUtcBucketsToLocalHeatmap(
    createFixedUtcBucketIntervals(windowInterval, 15),
    'Australia/Lord_Howe'
  );
  croppedHeatmap.forEach((bucket) => {
    const fullWindowBucket = lordHoweHeatmapByStartUtc.get(bucket.startUtc);
    assert(fullWindowBucket, `Lord Howe 完整窗口必须包含 UTC 桶 ${bucket.startUtc}`);
    assert.strictEqual(bucket.fold, fullWindowBucket.fold);
    assert.strictEqual(bucket.key, fullWindowBucket.key);
  });
});

// Etc/GMT、半小时和 45 分钟 offset 均由 Intl 投影，不依赖手写时区表。
const offsetProbeBuckets = createFixedUtcBucketIntervals({
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:15:00.000Z'
}, 15);
const kathmanduHeatmap = projectFixedUtcBucketsToLocalHeatmap(offsetProbeBuckets, 'Asia/Kathmandu');
assert.strictEqual(kathmanduHeatmap[0].localTime, '05:45');
assert.strictEqual(kathmanduHeatmap[0].utcOffset, '+05:45');
assert.strictEqual(kathmanduHeatmap[0].utcOffsetSeconds, 5 * 60 * 60 + 45 * 60);
const kolkataHeatmap = projectFixedUtcBucketsToLocalHeatmap(offsetProbeBuckets, 'Asia/Kolkata');
assert.strictEqual(kolkataHeatmap[0].localTime, '05:30');
assert.strictEqual(kolkataHeatmap[0].utcOffset, '+05:30');
const gmtHeatmap = projectFixedUtcBucketsToLocalHeatmap(offsetProbeBuckets, 'Etc/GMT');
assert.strictEqual(gmtHeatmap[0].localTime, '00:00');
assert.strictEqual(gmtHeatmap[0].utcOffset, '+00:00');
assert.deepStrictEqual(projectFixedUtcBucketsToLocalHeatmap(offsetProbeBuckets, 'GMT'), []);

// 历史 IANA offset 可能包含秒，必须保留秒精度而不是静默返回空热力。
const historicalParisHeatmap = projectFixedUtcBucketsToLocalHeatmap(
  createFixedUtcBucketIntervals({
    startUtc: '1900-01-01T00:00:00.000Z',
    endUtc: '1900-01-01T00:15:00.000Z'
  }, 15),
  'Europe/Paris'
);
assert.strictEqual(historicalParisHeatmap.length, 1);
assert.strictEqual(historicalParisHeatmap[0].localTime, '00:09');
assert.strictEqual(historicalParisHeatmap[0].localSecond, '21');
assert.strictEqual(historicalParisHeatmap[0].utcOffset, '+00:09:21');
assert.strictEqual(historicalParisHeatmap[0].utcOffsetSeconds, 9 * 60 + 21);
assert.strictEqual(historicalParisHeatmap[0].utcOffsetMinutes, 9.35);

// 本地 09:45-10:15 跨平峰边界，30 kWh 必须按 15/15 分成 15/15。
const morningBoundarySplit = splitTimeOfUseEnergy({
  value: 30,
  startUtc: '2026-07-15T01:45:00.000Z',
  endUtc: '2026-07-15T02:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.timeOfUseRule);
assert.deepStrictEqual(morningBoundarySplit.buckets, { peak: 15, flat: 15, valley: 0 });
assert.deepStrictEqual(morningBoundarySplit.bucketMinutes, { peak: 15, flat: 15, valley: 0 });
assert.strictEqual(morningBoundarySplit.allocatedTotal, 30);
assert.strictEqual(morningBoundarySplit.conservationDifference, 0);
assert.strictEqual(morningBoundarySplit.assumption, 'uniform_within_interval');
assert.deepStrictEqual(morningBoundarySplit.reasonCodes, []);

// 本地 21:45-22:15 跨峰谷和午夜前边界，60 kWh 必须按 30/30 守恒。
const peakValleySplit = splitTimeOfUseEnergy({
  value: 60,
  startUtc: '2026-07-15T13:45:00.000Z',
  endUtc: '2026-07-15T14:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.timeOfUseRule);
assert.deepStrictEqual(peakValleySplit.buckets, { peak: 30, flat: 0, valley: 30 });
assert.strictEqual(peakValleySplit.allocatedTotal, 60);
assert.strictEqual(peakValleySplit.conservationDifference, 0);

// 本地 23:45-00:15 跨午夜后仍全部属于谷段，且星期按各自本地日期判断。
const midnightSplit = splitTimeOfUseEnergy({
  value: 30,
  startUtc: '2026-07-15T15:45:00.000Z',
  endUtc: '2026-07-15T16:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.timeOfUseRule);
assert.deepStrictEqual(midnightSplit.buckets, { peak: 0, flat: 0, valley: 30 });
assert.strictEqual(midnightSplit.allocatedTotal, 30);
assert.strictEqual(midnightSplit.conservationDifference, 0);

// Asia/Kathmandu 的 UTC :00 对应本地 :45，09:45-10:15 仍按 15/15 守恒。
const kathmanduRule = {
  ...fixture.timeOfUseRule,
  id: 'tou-kathmandu-2026',
  sourceTimeZone: 'Asia/Kathmandu'
};
const kathmanduSplit = splitTimeOfUseEnergy({
  value: 30,
  startUtc: '2026-07-15T04:00:00.000Z',
  endUtc: '2026-07-15T04:30:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Kathmandu'
}, kathmanduRule);
assert.deepStrictEqual(kathmanduSplit.buckets, { peak: 15, flat: 15, valley: 0 });
assert.strictEqual(kathmanduSplit.allocatedTotal, 30);
assert.strictEqual(kathmanduSplit.conservationDifference, 0);

// America/New_York 春季 DST 跳时的实际 60 分钟按 01:30-02:00 与 03:00-03:30 分桶并守恒。
const newYorkRule = {
  id: 'tou-new-york-2026',
  version: 'time-of-use:v1',
  sourceTimeZone: 'America/New_York',
  effectiveStartDate: '2026-01-01',
  effectiveEndDateExclusive: '2027-01-01',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  periods: [
    { type: 'valley', startMinute: 0, endMinute: 120 },
    { type: 'flat', startMinute: 120, endMinute: 240 },
    { type: 'peak', startMinute: 240, endMinute: 1440 }
  ]
};
const newYorkDstSplit = splitTimeOfUseEnergy({
  value: 60,
  startUtc: '2026-03-08T06:30:00.000Z',
  endUtc: '2026-03-08T07:30:00.000Z',
  granularityMinutes: 60,
  sourceTimeZone: 'America/New_York'
}, newYorkRule);
assert.deepStrictEqual(newYorkDstSplit.buckets, { peak: 0, flat: 30, valley: 30 });
assert.strictEqual(newYorkDstSplit.allocatedTotal, 60);
assert.strictEqual(newYorkDstSplit.conservationDifference, 0);

// 多记录 TOU 分配允许相邻混合 15/30/60 分钟来源，并稳定输出 peak/flat/valley。
const intervalAllocationWindow = {
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T01:45:00.000Z',
  sourceTimeZone: 'Asia/Shanghai'
};
const mixedIntervalRecords = [
  {
    id: 'tou-mixed-15',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 15,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    sourceTimeZone: 'Asia/Shanghai'
  },
  {
    id: 'tou-mixed-30',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 30,
    startUtc: '2026-07-15T00:15:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 30,
    sourceTimeZone: 'Asia/Shanghai'
  },
  {
    id: 'tou-mixed-60',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 60,
    startUtc: '2026-07-15T00:45:00.000Z',
    endUtc: '2026-07-15T01:45:00.000Z',
    granularityMinutes: 60,
    sourceTimeZone: 'Asia/Shanghai'
  }
];
const expandedTouRule = {
  schemeId: 'tou-shanghai-2026',
  code: 'shanghai-default',
  version: 'tou-scheme:v1',
  sourceTimeZone: 'Asia/Shanghai',
  effectiveStartUtc: '2026-01-01T00:00:00.000Z',
  effectiveEndUtc: '2027-01-01T00:00:00.000Z',
  periodsByIsoWeekday: {
    3: [
      { type: 'valley', startMinute: 0, endMinute: 480 },
      { type: 'flat', startMinute: 480, endMinute: 510 },
      { type: 'peak', startMinute: 510, endMinute: 1440 }
    ]
  }
};
const mixedTouAllocation = allocateTimeOfUseEnergy(
  mixedIntervalRecords,
  intervalAllocationWindow,
  expandedTouRule
);
assert.deepStrictEqual(mixedTouAllocation.periods.map((period) => period.type), ['peak', 'flat', 'valley']);
assert.deepStrictEqual(mixedTouAllocation.periods.map((period) => period.observed), [75, 30, 0]);
assert.deepStrictEqual(mixedTouAllocation.periods.map((period) => period.complete), [75, 30, 0]);
assertClose(mixedTouAllocation.buckets.peak.share, 75 / 105);
assertClose(mixedTouAllocation.buckets.flat.share, 30 / 105);
assert.strictEqual(mixedTouAllocation.buckets.valley.share, 0);
assert.strictEqual(mixedTouAllocation.observed, 105);
assert.strictEqual(mixedTouAllocation.complete, 105);
assert.strictEqual(mixedTouAllocation.conservationDifference, 0);
assert.deepStrictEqual(mixedTouAllocation.sourceGranularityMinutes, [15, 30, 60]);
assert.strictEqual(mixedTouAllocation.mixedSourceGranularity, true);
assert.strictEqual(mixedTouAllocation.allocationUsed, true);
assert.strictEqual(mixedTouAllocation.allocationAssumption, 'uniform_within_interval');
assert.strictEqual(mixedTouAllocation.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), false);
assert.deepStrictEqual(mixedTouAllocation.reasonCodes, []);
assert.deepStrictEqual(mixedTouAllocation.scheme, {
  schemeId: 'tou-shanghai-2026',
  code: 'shanghai-default'
});
assert.strictEqual(mixedTouAllocation.version, 'tou-scheme:v1');
assert.deepStrictEqual(mixedTouAllocation.adoptedRange, {
  startUtc: intervalAllocationWindow.startUtc,
  endUtc: intervalAllocationWindow.endUtc
});
assert.deepStrictEqual(mixedTouAllocation.configurationErrors, []);
assert.deepStrictEqual(mixedTouAllocation.energyScopes, [{
  energyTypeCode: 'electricity',
  energyTypeId: null,
  normalizedUnit: 'kWh',
  unit: 'kWh'
}]);
const partialTouAllocation = allocateTimeOfUseEnergy(
  [mixedIntervalRecords[0]],
  intervalAllocationWindow,
  expandedTouRule
);
assert.strictEqual(partialTouAllocation.observed, 15);
assert.strictEqual(partialTouAllocation.complete, null);
assert.strictEqual(partialTouAllocation.buckets.flat.observed, 15);
assert.strictEqual(partialTouAllocation.buckets.flat.complete, null);
assert.strictEqual(partialTouAllocation.buckets.peak.observed, null);
assert.strictEqual(partialTouAllocation.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
const overflowTouAllocation = allocateTimeOfUseEnergy(
  [{ ...mixedIntervalRecords[0], value: Number.POSITIVE_INFINITY }],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule
);
assert.strictEqual(overflowTouAllocation.numericOverflow, true);
assert.strictEqual(overflowTouAllocation.observed, null);
assert.deepStrictEqual(overflowTouAllocation.reasonCodes, []);
assertNoNonFiniteNumbers(overflowTouAllocation);

// TOU 规则必须对查询涉及的本地星期全天无 gap/overlap，零能源分母下 share 保持 null。
const touGapResult = allocateTimeOfUseEnergy(mixedIntervalRecords, intervalAllocationWindow, {
  ...expandedTouRule,
  schemeId: 'tou-shanghai-gap',
  code: 'shanghai-gap',
  periodsByIsoWeekday: {
    3: [
      { type: 'flat', startMinute: 0, endMinute: 500 },
      { type: 'peak', startMinute: 510, endMinute: 1440 }
    ]
  }
});
assert.strictEqual(touGapResult.complete, null);
assert.strictEqual(touGapResult.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
const missingSecondWeekdayTou = allocateTimeOfUseEnergy([{
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 60,
  startUtc: '2026-07-15T15:30:00.000Z',
  endUtc: '2026-07-15T16:30:00.000Z',
  granularityMinutes: 60,
  sourceTimeZone: 'Asia/Shanghai'
}], {
  startUtc: '2026-07-15T15:30:00.000Z',
  endUtc: '2026-07-15T16:30:00.000Z'
}, expandedTouRule);
assert.strictEqual(missingSecondWeekdayTou.complete, null);
assert.strictEqual(missingSecondWeekdayTou.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
const touRuleOverlapResult = allocateTimeOfUseEnergy(mixedIntervalRecords, intervalAllocationWindow, {
  ...expandedTouRule,
  schemeId: 'tou-shanghai-overlap',
  code: 'shanghai-overlap',
  periodsByIsoWeekday: {
    3: [
      { type: 'flat', startMinute: 0, endMinute: 520 },
      { type: 'peak', startMinute: 510, endMinute: 1440 }
    ]
  }
});
assert.strictEqual(touRuleOverlapResult.complete, null);
assert.strictEqual(touRuleOverlapResult.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
const missingVersionTou = allocateTimeOfUseEnergy(
  mixedIntervalRecords,
  intervalAllocationWindow,
  { ...expandedTouRule, version: undefined }
);
assert.strictEqual(missingVersionTou.observed, null);
assert.deepStrictEqual(missingVersionTou.configurationErrors, ['INVALID_TOU_RULE_SET']);
assert.strictEqual(missingVersionTou.scheme, null);
const outsideEffectiveRangeTou = allocateTimeOfUseEnergy(
  mixedIntervalRecords,
  intervalAllocationWindow,
  { ...expandedTouRule, effectiveEndUtc: '2026-07-15T01:00:00.000Z' }
);
assert.strictEqual(outsideEffectiveRangeTou.observed, null);
assert.deepStrictEqual(
  outsideEffectiveRangeTou.configurationErrors,
  ['TOU_RULE_SET_WINDOW_OUTSIDE_EFFECTIVE_RANGE']
);
assert.strictEqual(outsideEffectiveRangeTou.adoptedRange, null);
const arrayRuleSetTou = allocateTimeOfUseEnergy(
  mixedIntervalRecords,
  intervalAllocationWindow,
  [expandedTouRule]
);
assert.strictEqual(arrayRuleSetTou.observed, null);
assert.deepStrictEqual(arrayRuleSetTou.configurationErrors, ['INVALID_TOU_RULE_SET']);
assert.strictEqual(arrayRuleSetTou.scheme, null);
const zeroTouAllocation = allocateTimeOfUseEnergy(
  mixedIntervalRecords.map((record) => ({ ...record, value: 0 })),
  intervalAllocationWindow,
  expandedTouRule
);
assert.strictEqual(zeroTouAllocation.observed, 0);
assert.strictEqual(zeroTouAllocation.roundedToZero, false);
assert.strictEqual(zeroTouAllocation.complete, 0);
zeroTouAllocation.periods.forEach((period) => {
  assert.strictEqual(period.roundedToZero, false);
  assert.strictEqual(period.share, null);
});
const microTouAllocation = allocateTimeOfUseEnergy(
  [{ ...mixedIntervalRecords[0], value: 4e-13 }],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule
);
assert.strictEqual(microTouAllocation.observed, 0);
assert.strictEqual(microTouAllocation.roundedToZero, true);
assert.strictEqual(microTouAllocation.complete, 0);
assert.strictEqual(microTouAllocation.buckets.flat.observed, 0);
assert.strictEqual(microTouAllocation.buckets.flat.roundedToZero, true);
assert.strictEqual(microTouAllocation.buckets.flat.share, 1);
assert.strictEqual(microTouAllocation.conservationDifference, 4e-13);
assert.strictEqual(
  microTouAllocation.periods.reduce((sum, period) => sum + period.observed, 0),
  0
);

// 时序来源本身重叠时 TOU 整体不可计算，合法混合粒度不得掩盖重叠。
const overlappingTouAllocation = allocateTimeOfUseEnergy(
  [mixedIntervalRecords[0], { ...mixedIntervalRecords[0], id: 'tou-overlap' }],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule
);
assert.strictEqual(overlappingTouAllocation.observed, null);
assert.strictEqual(overlappingTouAllocation.complete, null);
assert.strictEqual(overlappingTouAllocation.coveredMinutes, 15);
assert.strictEqual(
  overlappingTouAllocation.periods.reduce((sum, period) => sum + period.coveredMinutes, 0),
  overlappingTouAllocation.coveredMinutes
);
assert.strictEqual(overlappingTouAllocation.buckets.flat.coveredMinutes, 15);
assert.deepStrictEqual(overlappingTouAllocation.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
const crossScopeTouAllocation = allocateTimeOfUseEnergy([
  mixedIntervalRecords[0],
  {
    ...mixedIntervalRecords[1],
    energyTypeCode: 'natural_gas',
    unit: 'm3'
  }
], {
  ...intervalAllocationWindow,
  endUtc: '2026-07-15T00:45:00.000Z'
}, expandedTouRule);
assert.strictEqual(crossScopeTouAllocation.observed, null);
assert.strictEqual(crossScopeTouAllocation.complete, null);
assert.strictEqual(crossScopeTouAllocation.energyScopes.length, 2);
assert.strictEqual(crossScopeTouAllocation.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
crossScopeTouAllocation.periods.forEach((period) => assert.strictEqual(period.observed, null));
const missingScopeTouAllocation = allocateTimeOfUseEnergy(
  [{ ...mixedIntervalRecords[0], unit: undefined }],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule
);
assert.strictEqual(missingScopeTouAllocation.observed, null);
assert.strictEqual(missingScopeTouAllocation.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
assert.deepStrictEqual(missingScopeTouAllocation.energyScopes, []);
const expectedScopeMatchedTou = allocateTimeOfUseEnergy(
  [mixedIntervalRecords[0]],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule,
  { expectedEnergyScope: { energyTypeCode: 'electricity', normalizedUnit: 'kWh' } }
);
assert.strictEqual(expectedScopeMatchedTou.energyScopeComparable, true);
assert.strictEqual(expectedScopeMatchedTou.observed, 15);
assert.strictEqual(expectedScopeMatchedTou.complete, 15);
assert.deepStrictEqual(expectedScopeMatchedTou.reasonCodes, []);
assert.deepStrictEqual(expectedScopeMatchedTou.expectedEnergyScope, {
  energyTypeCode: 'electricity',
  energyTypeId: null,
  normalizedUnit: 'kWh',
  unit: 'kWh'
});
const expectedScopeConflictTou = allocateTimeOfUseEnergy(
  [mixedIntervalRecords[0]],
  {
    ...intervalAllocationWindow,
    endUtc: '2026-07-15T00:15:00.000Z'
  },
  expandedTouRule,
  { expectedEnergyScope: { energyTypeCode: 'natural_gas', normalizedUnit: 'm3' } }
);
assert.strictEqual(expectedScopeConflictTou.observed, null);
assert.strictEqual(expectedScopeConflictTou.complete, null);
assert.strictEqual(expectedScopeConflictTou.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
assert.deepStrictEqual(expectedScopeConflictTou.expectedEnergyScope, {
  energyTypeCode: 'natural_gas',
  energyTypeId: null,
  normalizedUnit: 'm3',
  unit: 'm3'
});
expectedScopeConflictTou.periods.forEach((period) => assert.strictEqual(period.observed, null));

// New York 春跳只分配真实 UTC 分钟，秋回两个 fold 的重复本地小时都参与能源分配。
const expandedNewYorkRule = {
  schemeId: 'tou-new-york-2026',
  code: 'new-york-default',
  version: 'tou-scheme:v1',
  sourceTimeZone: 'America/New_York',
  effectiveStartUtc: '2026-01-01T00:00:00.000Z',
  effectiveEndUtc: '2027-01-01T00:00:00.000Z',
  periodsByIsoWeekday: {
    7: [
      { type: 'valley', startMinute: 0, endMinute: 120 },
      { type: 'flat', startMinute: 120, endMinute: 240 },
      { type: 'peak', startMinute: 240, endMinute: 1440 }
    ]
  }
};
const springTouAllocation = allocateTimeOfUseEnergy([{
  id: 'tou-spring-60',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 60,
  startUtc: '2026-03-08T06:30:00.000Z',
  endUtc: '2026-03-08T07:30:00.000Z',
  granularityMinutes: 60,
  sourceTimeZone: 'America/New_York'
}], {
  startUtc: '2026-03-08T06:30:00.000Z',
  endUtc: '2026-03-08T07:30:00.000Z'
}, expandedNewYorkRule);
assert.deepStrictEqual(springTouAllocation.periods.map((period) => period.observed), [0, 30, 30]);
assert.strictEqual(springTouAllocation.conservationDifference, 0);
const fallTouAllocation = allocateTimeOfUseEnergy([
  {
    id: 'tou-fall-first',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 60,
    startUtc: '2026-11-01T05:00:00.000Z',
    endUtc: '2026-11-01T06:00:00.000Z',
    granularityMinutes: 60,
    sourceTimeZone: 'America/New_York'
  },
  {
    id: 'tou-fall-second',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 60,
    startUtc: '2026-11-01T06:00:00.000Z',
    endUtc: '2026-11-01T07:00:00.000Z',
    granularityMinutes: 60,
    sourceTimeZone: 'America/New_York'
  }
], {
  startUtc: '2026-11-01T05:00:00.000Z',
  endUtc: '2026-11-01T07:00:00.000Z'
}, {
  ...expandedNewYorkRule,
  schemeId: 'tou-new-york-fall-2026',
  code: 'new-york-fall',
  periodsByIsoWeekday: {
    7: [
      { type: 'valley', startMinute: 0, endMinute: 60 },
      { type: 'peak', startMinute: 60, endMinute: 120 },
      { type: 'flat', startMinute: 120, endMinute: 1440 }
    ]
  }
});
assert.strictEqual(fallTouAllocation.buckets.peak.expectedMinutes, 120);
assert.strictEqual(fallTouAllocation.buckets.peak.observed, 120);
assert.strictEqual(fallTouAllocation.complete, 120);
assert.strictEqual(fallTouAllocation.conservationDifference, 0);

// 上海 1900 年 +08:05:43 秒级 offset 必须按本地整分钟边界切成 17/43/60 秒。
const historicalShanghaiPeriods = [
  { type: 'flat', startMinute: 0, endMinute: 1435 },
  { type: 'valley', startMinute: 1435, endMinute: 1439 },
  { type: 'peak', startMinute: 1439, endMinute: 1440 }
];
const historicalShanghaiRule = {
  schemeId: 'tou-shanghai-1900',
  code: 'shanghai-historical-offset',
  version: 'tou-scheme:v1',
  sourceTimeZone: 'Asia/Shanghai',
  effectiveStartUtc: '1899-01-01T00:00:00.000Z',
  effectiveEndUtc: '1901-01-01T00:00:00.000Z',
  periodsByIsoWeekday: Object.fromEntries(
    Array.from({ length: 7 }, (_unused, index) => [index + 1, historicalShanghaiPeriods])
  )
};
const historicalShanghaiAllocation = allocateTimeOfUseEnergy([{
  id: 'tou-shanghai-1900-record',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 15,
  startUtc: '1900-12-31T15:45:00.000Z',
  endUtc: '1900-12-31T16:00:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}], {
  startUtc: '1900-12-31T15:54:00.000Z',
  endUtc: '1900-12-31T15:56:00.000Z',
  sourceTimeZone: 'Asia/Shanghai'
}, historicalShanghaiRule);
const historicalSecondsByType = { peak: 17, flat: 43, valley: 60 };
historicalShanghaiAllocation.periods.forEach((period) => {
  assertClose(period.expectedMinutes, historicalSecondsByType[period.type] / 60);
  assertClose(period.coveredMinutes, historicalSecondsByType[period.type] / 60);
  assertClose(period.observed, historicalSecondsByType[period.type] / 60);
});
assertClose(historicalShanghaiAllocation.coveredMinutes, 2);
assertClose(
  historicalShanghaiAllocation.periods.reduce((sum, period) => sum + period.coveredMinutes, 0),
  historicalShanghaiAllocation.coveredMinutes
);
assert.strictEqual(historicalShanghaiAllocation.observed, 2);
assert.strictEqual(historicalShanghaiAllocation.complete, 2);
assert.strictEqual(historicalShanghaiAllocation.conservationDifference, 0);

// 实际排班分配只消费物化 UTC 区间，支持跨午夜和 definition+version 聚合。
const actualShiftWindow = {
  startUtc: '2026-07-15T23:00:00.000Z',
  endUtc: '2026-07-16T02:00:00.000Z'
};
const actualShiftEnergyRecords = Array.from({ length: 3 }, (_unused, index) => ({
  id: `actual-shift-energy-${index}`,
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 60,
  startUtc: new Date(Date.parse(actualShiftWindow.startUtc) + index * 60 * TEST_MINUTE_MS).toISOString(),
  endUtc: new Date(Date.parse(actualShiftWindow.startUtc) + (index + 1) * 60 * TEST_MINUTE_MS).toISOString(),
  granularityMinutes: 60,
  sourceTimeZone: 'Asia/Shanghai'
}));
const actualShiftSchedules = [
  {
    shiftDefinitionId: 1,
    version: 'shift:v1',
    shiftCode: 'night-a',
    startUtc: '2026-07-15T23:00:00.000Z',
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  {
    shiftDefinitionId: 1,
    version: 'shift:v1',
    shiftCode: 'night-a',
    startUtc: '2026-07-16T00:00:00.000Z',
    endUtc: '2026-07-16T00:30:00.000Z'
  },
  {
    shiftDefinitionId: 2,
    version: 'shift:v2',
    shiftCode: 'night-b',
    startUtc: '2026-07-16T00:30:00.000Z',
    endUtc: '2026-07-16T02:00:00.000Z'
  }
];
const actualShiftAllocation = allocateEnergyToActualShifts(
  actualShiftEnergyRecords,
  actualShiftWindow,
  actualShiftSchedules
);
assert.strictEqual(actualShiftAllocation.observedEnergy, 180);
assert.strictEqual(actualShiftAllocation.assignedEnergy, 180);
assert.strictEqual(actualShiftAllocation.unassignedEnergy, 0);
assert.strictEqual(actualShiftAllocation.complete, 180);
assert.deepStrictEqual(actualShiftAllocation.allocations.map((allocation) => [
  allocation.shiftDefinitionId,
  allocation.version,
  allocation.observed,
  allocation.complete
]), [
  [1, 'shift:v1', 90, 90],
  [2, 'shift:v2', 90, 90]
]);
assert.strictEqual(actualShiftAllocation.conservationDifference, 0);
assert.deepStrictEqual(actualShiftAllocation.reasonCodes, []);

// 总量 8e-13 跨两个 4e-13 班次时，独立分项原本均舍入为零，守恒舍入必须稳定保留总量。
const microShiftWindow = {
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T01:00:00.000Z'
};
const microShiftRecord = {
  id: 'actual-shift-micro-energy',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 8e-13,
  startUtc: microShiftWindow.startUtc,
  endUtc: microShiftWindow.endUtc,
  granularityMinutes: 60,
  sourceTimeZone: 'Asia/Shanghai'
};
const microShiftSchedules = [
  {
    shiftDefinitionId: 21,
    version: 'shift:micro-v1',
    shiftCode: 'micro-a',
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:30:00.000Z'
  },
  {
    shiftDefinitionId: 22,
    version: 'shift:micro-v1',
    shiftCode: 'micro-b',
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T01:00:00.000Z'
  }
];
const microShiftAllocation = allocateEnergyToActualShifts(
  [microShiftRecord],
  microShiftWindow,
  microShiftSchedules
);
assert.strictEqual(microShiftAllocation.rawObservedEnergy, 8e-13);
assert.strictEqual(microShiftAllocation.observedEnergy, 1e-12);
assert.strictEqual(microShiftAllocation.rawAssignedEnergy, 8e-13);
assert.strictEqual(microShiftAllocation.assignedEnergy, 1e-12);
assert.strictEqual(microShiftAllocation.rawUnassignedEnergy, 0);
assert.strictEqual(microShiftAllocation.unassignedEnergy, 0);
assert.deepStrictEqual(microShiftAllocation.allocations.map((allocation) => ({
  rawObserved: allocation.rawObserved,
  observed: allocation.observed,
  roundedToZero: allocation.roundedToZero,
  share: allocation.share
})), [
  { rawObserved: 4e-13, observed: 0, roundedToZero: true, share: 0.5 },
  { rawObserved: 4e-13, observed: 1e-12, roundedToZero: false, share: 0.5 }
]);
assert.strictEqual(
  microShiftAllocation.allocations.reduce((sum, allocation) => sum + allocation.observed, 0),
  microShiftAllocation.assignedEnergy
);
const reversedMicroShiftAllocation = allocateEnergyToActualShifts(
  [microShiftRecord],
  microShiftWindow,
  [...microShiftSchedules].reverse()
);
assert.deepStrictEqual(
  reversedMicroShiftAllocation.allocations,
  microShiftAllocation.allocations
);
const zeroShiftAllocation = allocateEnergyToActualShifts(
  [{ ...microShiftRecord, id: 'actual-shift-zero-energy', value: 0 }],
  microShiftWindow,
  microShiftSchedules
);
assert.strictEqual(zeroShiftAllocation.roundedToZero, false);
assert(zeroShiftAllocation.allocations.every((allocation) => (
  allocation.rawObserved === 0
  && allocation.observed === 0
  && allocation.roundedToZero === false
  && allocation.share === null
)));

// 正微量记录与显式零记录并存时，真实零班次不得吸收总量舍入差额。
const microAndZeroShiftAllocation = allocateEnergyToActualShifts([
  {
    ...microShiftRecord,
    id: 'actual-shift-positive-micro-energy',
    value: 8e-13,
    endUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30
  },
  {
    ...microShiftRecord,
    id: 'actual-shift-explicit-zero-energy',
    value: 0,
    startUtc: '2026-07-15T00:30:00.000Z',
    granularityMinutes: 30
  }
], microShiftWindow, microShiftSchedules);
assert.strictEqual(microAndZeroShiftAllocation.rawAssignedEnergy, 8e-13);
assert.strictEqual(microAndZeroShiftAllocation.assignedEnergy, 1e-12);
assert.deepStrictEqual(microAndZeroShiftAllocation.allocations.map((allocation) => ({
  rawObserved: allocation.rawObserved,
  observed: allocation.observed,
  roundedToZero: allocation.roundedToZero,
  share: allocation.share
})), [
  { rawObserved: 8e-13, observed: 1e-12, roundedToZero: false, share: 1 },
  { rawObserved: 0, observed: 0, roundedToZero: false, share: 0 }
]);
assert.strictEqual(microAndZeroShiftAllocation.conservationDifference, 0);

const mixedActualShiftAllocation = allocateEnergyToActualShifts(
  mixedIntervalRecords,
  intervalAllocationWindow,
  [{
    shiftDefinitionId: 9,
    version: 'shift:mixed-v1',
    startUtc: intervalAllocationWindow.startUtc,
    endUtc: intervalAllocationWindow.endUtc
  }]
);
assert.strictEqual(mixedActualShiftAllocation.assignedEnergy, 105);
assert.deepStrictEqual(mixedActualShiftAllocation.sourceGranularityMinutes, [15, 30, 60]);
assert.strictEqual(mixedActualShiftAllocation.mixedSourceGranularity, true);
assert.strictEqual(mixedActualShiftAllocation.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), false);
const missingShiftDefinitionAllocation = allocateEnergyToActualShifts(
  [actualShiftEnergyRecords[0]],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [{
    version: 'shift:v1',
    shiftCode: 'missing-definition',
    startUtc: actualShiftWindow.startUtc,
    endUtc: '2026-07-16T00:00:00.000Z'
  }]
);
assert.strictEqual(missingShiftDefinitionAllocation.observedEnergy, null);
assert.strictEqual(missingShiftDefinitionAllocation.assignedEnergy, null);
assert.deepStrictEqual(
  missingShiftDefinitionAllocation.configurationErrors,
  ['INVALID_SHIFT_SCHEDULE_IDENTITY']
);
const missingShiftVersionAllocation = allocateEnergyToActualShifts(
  [actualShiftEnergyRecords[0]],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [{
    shiftDefinitionId: 8,
    shiftCode: 'missing-version',
    startUtc: actualShiftWindow.startUtc,
    endUtc: '2026-07-16T00:00:00.000Z'
  }]
);
assert.strictEqual(missingShiftVersionAllocation.assignedEnergy, null);
assert.deepStrictEqual(
  missingShiftVersionAllocation.configurationErrors,
  ['INVALID_SHIFT_SCHEDULE_IDENTITY']
);
const sameDefinitionMultipleVersions = allocateEnergyToActualShifts(
  actualShiftEnergyRecords.slice(0, 2),
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T01:00:00.000Z'
  },
  [
    {
      shiftDefinitionId: 7,
      version: 'shift:v1',
      shiftCode: 'version-one',
      shiftName: '版本一',
      startUtc: '2026-07-15T23:00:00.000Z',
      endUtc: '2026-07-16T00:00:00.000Z'
    },
    {
      shiftDefinitionId: 7,
      version: 'shift:v2',
      shiftCode: 'version-two',
      shiftName: '版本二',
      startUtc: '2026-07-16T00:00:00.000Z',
      endUtc: '2026-07-16T01:00:00.000Z'
    }
  ]
);
assert.deepStrictEqual(sameDefinitionMultipleVersions.allocations.map((allocation) => [
  allocation.shiftDefinitionId,
  allocation.version,
  allocation.observed
]), [
  [7, 'shift:v1', 60],
  [7, 'shift:v2', 60]
]);
assert.deepStrictEqual(sameDefinitionMultipleVersions.configurationErrors, []);
const conflictingShiftMetadata = allocateEnergyToActualShifts(
  actualShiftEnergyRecords.slice(0, 2),
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T01:00:00.000Z'
  },
  [
    {
      shiftDefinitionId: 10,
      version: 'shift:v1',
      shiftCode: 'conflict-a',
      shiftName: '冲突甲',
      startUtc: '2026-07-15T23:00:00.000Z',
      endUtc: '2026-07-16T00:00:00.000Z'
    },
    {
      shiftDefinitionId: 10,
      version: 'shift:v1',
      shiftCode: 'conflict-b',
      shiftName: '冲突乙',
      startUtc: '2026-07-16T00:00:00.000Z',
      endUtc: '2026-07-16T01:00:00.000Z'
    }
  ]
);
assert.strictEqual(conflictingShiftMetadata.assignedEnergy, null);
assert.strictEqual(conflictingShiftMetadata.complete, null);
assert.deepStrictEqual(
  conflictingShiftMetadata.configurationErrors,
  ['SHIFT_SCHEDULE_GROUP_METADATA_CONFLICT']
);
const crossScopeShiftAllocation = allocateEnergyToActualShifts([
  mixedIntervalRecords[0],
  {
    ...mixedIntervalRecords[1],
    energyTypeCode: 'natural_gas',
    unit: 'm3'
  }
], {
  ...intervalAllocationWindow,
  endUtc: '2026-07-15T00:45:00.000Z'
}, [{
  shiftDefinitionId: 11,
  version: 'shift:v1',
  startUtc: intervalAllocationWindow.startUtc,
  endUtc: '2026-07-15T00:45:00.000Z'
}]);
assert.strictEqual(crossScopeShiftAllocation.observedEnergy, null);
assert.strictEqual(crossScopeShiftAllocation.assignedEnergy, null);
assert.strictEqual(crossScopeShiftAllocation.energyScopes.length, 2);
assert.strictEqual(crossScopeShiftAllocation.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
crossScopeShiftAllocation.allocations.forEach((allocation) => assert.strictEqual(allocation.observed, null));
const expectedScopeMatchedShift = allocateEnergyToActualShifts(
  [actualShiftEnergyRecords[0]],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [actualShiftSchedules[0]],
  { expectedEnergyScope: { energyTypeCode: 'electricity', normalizedUnit: 'kWh' } }
);
assert.strictEqual(expectedScopeMatchedShift.energyScopeComparable, true);
assert.strictEqual(expectedScopeMatchedShift.observedEnergy, 60);
assert.strictEqual(expectedScopeMatchedShift.assignedEnergy, 60);
assert.strictEqual(expectedScopeMatchedShift.complete, 60);
assert.deepStrictEqual(expectedScopeMatchedShift.reasonCodes, []);
assert.deepStrictEqual(expectedScopeMatchedShift.expectedEnergyScope, {
  energyTypeCode: 'electricity',
  energyTypeId: null,
  normalizedUnit: 'kWh',
  unit: 'kWh'
});
const expectedScopeConflictShift = allocateEnergyToActualShifts(
  [actualShiftEnergyRecords[0]],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [actualShiftSchedules[0]],
  { expectedEnergyScope: { energyTypeCode: 'natural_gas', normalizedUnit: 'm3' } }
);
assert.strictEqual(expectedScopeConflictShift.observedEnergy, null);
assert.strictEqual(expectedScopeConflictShift.assignedEnergy, null);
assert.strictEqual(expectedScopeConflictShift.unassignedEnergy, null);
assert.strictEqual(expectedScopeConflictShift.complete, null);
assert.strictEqual(expectedScopeConflictShift.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
assert.deepStrictEqual(expectedScopeConflictShift.expectedEnergyScope, {
  energyTypeCode: 'natural_gas',
  energyTypeId: null,
  normalizedUnit: 'm3',
  unit: 'm3'
});
expectedScopeConflictShift.allocations.forEach((allocation) => assert.strictEqual(allocation.observed, null));

// 排班 gap 明确形成 unassigned，overlap 整体拒绝且不得重复分配多重覆盖片段。
const scheduleGapAllocation = allocateEnergyToActualShifts(
  actualShiftEnergyRecords,
  actualShiftWindow,
  [actualShiftSchedules[0], actualShiftSchedules[2]]
);
assert.strictEqual(scheduleGapAllocation.assignedEnergy, 150);
assert.strictEqual(scheduleGapAllocation.unassignedEnergy, 30);
assert.strictEqual(scheduleGapAllocation.unassignedMinutes, 30);
assert.strictEqual(scheduleGapAllocation.complete, null);
assert.strictEqual(scheduleGapAllocation.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'), true);
const scheduleOverlapAllocation = allocateEnergyToActualShifts(
  actualShiftEnergyRecords,
  actualShiftWindow,
  actualShiftSchedules.concat({
    shiftDefinitionId: 3,
    version: 'shift:v1',
    shiftCode: 'overlap',
    startUtc: '2026-07-16T00:15:00.000Z',
    endUtc: '2026-07-16T01:00:00.000Z'
  })
);
assert.strictEqual(scheduleOverlapAllocation.assignedEnergy, null);
assert.strictEqual(scheduleOverlapAllocation.unassignedEnergy, null);
assert.strictEqual(scheduleOverlapAllocation.complete, null);
assert.strictEqual(scheduleOverlapAllocation.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
const overlappingShiftEnergyAllocation = allocateEnergyToActualShifts(
  [actualShiftEnergyRecords[0], { ...actualShiftEnergyRecords[0], id: 'actual-shift-overlap' }],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [actualShiftSchedules[0]]
);
assert.strictEqual(overlappingShiftEnergyAllocation.observedEnergy, null);
assert.strictEqual(overlappingShiftEnergyAllocation.assignedEnergy, null);
assert.deepStrictEqual(overlappingShiftEnergyAllocation.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);
const overflowShiftAllocation = allocateEnergyToActualShifts(
  [{ ...actualShiftEnergyRecords[0], value: Number.NaN }],
  {
    ...actualShiftWindow,
    endUtc: '2026-07-16T00:00:00.000Z'
  },
  [actualShiftSchedules[0]]
);
assert.strictEqual(overflowShiftAllocation.numericOverflow, true);
assert.strictEqual(overflowShiftAllocation.assignedEnergy, null);
assertNoNonFiniteNumbers(overflowShiftAllocation);
const noScheduleAllocation = allocateEnergyToActualShifts(
  actualShiftEnergyRecords,
  actualShiftWindow,
  []
);
assert.strictEqual(noScheduleAllocation.assignedEnergy, 0);
assert.strictEqual(noScheduleAllocation.unassignedEnergy, 180);
assert.strictEqual(noScheduleAllocation.reasonCodes.includes('MISSING_SHIFT_SCHEDULE'), true);

// 三班次边界分别验证白班/中班、中班/夜班和跨日夜班/白班。
const dayEveningShift = allocateEnergyToShifts({
  value: 30,
  startUtc: '2026-07-15T05:45:00.000Z',
  endUtc: '2026-07-15T06:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.shifts);
assert.deepStrictEqual(dayEveningShift.allocations.map((item) => [item.shiftCode, item.overlapMinutes, item.value]), [
  ['day-shift', 15, 15],
  ['evening-shift', 15, 15],
  ['night-shift', 0, 0]
]);
assert.strictEqual(dayEveningShift.conservationDifference, 0);

// 21:45-22:15 本地时间在中班与 22-06 跨日夜班之间各分 15 分钟。
const eveningNightShift = allocateEnergyToShifts({
  value: 30,
  startUtc: '2026-07-15T13:45:00.000Z',
  endUtc: '2026-07-15T14:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.shifts);
assert.deepStrictEqual(eveningNightShift.allocations.map((item) => [item.shiftCode, item.overlapMinutes, item.value]), [
  ['day-shift', 0, 0],
  ['evening-shift', 15, 15],
  ['night-shift', 15, 15]
]);

// 05:45-06:15 本地时间证明 22-06 夜班跨午夜后仍归属夜班。
const nightDayShift = allocateEnergyToShifts({
  value: 30,
  startUtc: '2026-07-14T21:45:00.000Z',
  endUtc: '2026-07-14T22:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, fixture.shifts);
assert.deepStrictEqual(nightDayShift.allocations.map((item) => [item.shiftCode, item.overlapMinutes, item.value]), [
  ['day-shift', 15, 15],
  ['evening-shift', 0, 0],
  ['night-shift', 15, 15]
]);
assert.strictEqual(nightDayShift.allocatedTotal, 30);
assert.deepStrictEqual(nightDayShift.reasonCodes, []);
assert.deepStrictEqual(allocateEnergyToShifts({
  value: 15,
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:15:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}, []).reasonCodes, ['MISSING_SHIFT_SCHEDULE']);

// 重复班次编码必须在累计前拒绝，不能因对象键覆盖或重复 allocations 破坏守恒。
const duplicateShiftCodeResult = allocateEnergyToShifts({
  value: 30,
  startUtc: '2026-07-15T05:45:00.000Z',
  endUtc: '2026-07-15T06:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, [fixture.shifts[0], { ...fixture.shifts[1], code: fixture.shifts[0].code }]);
assert.strictEqual(duplicateShiftCodeResult.value, null);
assert.strictEqual(duplicateShiftCodeResult.allocatedTotal, null);
assert.strictEqual(duplicateShiftCodeResult.conservationDifference, null);
assert.deepStrictEqual(duplicateShiftCodeResult.allocations, []);
assert.deepStrictEqual(duplicateShiftCodeResult.reasonCodes, ['SOURCE_OVERLAP_OR_DUPLICATE']);

// 设备状态显式记录覆盖 23 小时，其中显式 unknown 1 小时、无记录缺口 1 小时。
const deviceStateSummary = summarizeDeviceStateCoverage(
  fixture.acceptanceDay,
  fixture.deviceStates.records,
  fixture.timeSeries.electricity
);
assertClose(deviceStateSummary.coverageRate, 23 / 24);
assertClose(deviceStateSummary.knownStateCoverageRate, 22 / 24);
assert.strictEqual(deviceStateSummary.coveredMinutes, 23 * 60);
assert.strictEqual(deviceStateSummary.knownStateMinutes, 22 * 60);
assert.strictEqual(deviceStateSummary.explicitUnknownMinutes, 60);
assert.strictEqual(deviceStateSummary.unknownMinutes, 2 * 60);
assert.strictEqual(deviceStateSummary.gapMinutes, 60);
assert.strictEqual(deviceStateSummary.knownStateMinutes + deviceStateSummary.unknownMinutes, 24 * 60);
assert.strictEqual(deviceStateSummary.idleMinutes, 120);
assert.deepStrictEqual(deviceStateSummary.stateMinutes, {
  running: 17 * 60,
  idle: 2 * 60,
  stopped: 60,
  offline: 2 * 60,
  unknown: 60
});

// 空载能耗只累计显式 idle 区间的 8 条记录：104+105+106+107+100+101+102+103=828。
assert.strictEqual(deviceStateSummary.idleEnergy, 828);
assert.strictEqual(deviceStateSummary.idleEnergyObserved, 828);
assert.strictEqual(deviceStateSummary.idleEnergyComplete, null);
assert.strictEqual(deviceStateSummary.value, null);
assert.strictEqual(deviceStateSummary.idleCoverageRate, 1);
assert.strictEqual(deviceStateSummary.stateKnowledgeComplete, false);
assert.strictEqual(deviceStateSummary.raw.idleEnergyObserved, 828);
assert.strictEqual(deviceStateSummary.raw.idleEnergyComplete, null);
assert.strictEqual(deviceStateSummary.rounded.idleEnergyObserved, 828);
assert.strictEqual(deviceStateSummary.rounded.idleEnergyComplete, null);
assert.strictEqual(deviceStateSummary.raw.share, null);
assert.strictEqual(deviceStateSummary.share.raw, null);
assert.strictEqual(deviceStateSummary.share.rounded, null);
assertClose(deviceStateSummary.share.observedRaw, 828 / 9936);
assertClose(deviceStateSummary.share.observedRounded, 828 / 9936);
assert.strictEqual(deviceStateSummary.share.completeWindowAvailable, false);
assert.strictEqual(deviceStateSummary.coverage.stateCoverageRate, deviceStateSummary.coverageRate);
assert.strictEqual(deviceStateSummary.coverage.knownStateCoverageRate, deviceStateSummary.knownStateCoverageRate);
assert.strictEqual(deviceStateSummary.coverage.idleCoverageRate, 1);
assert.strictEqual(deviceStateSummary.rounding.idleEnergyObservedRoundedToZero, false);
assert.strictEqual(deviceStateSummary.reasonCodes.includes('DEVICE_STATE_GAP'), true);
const gapSegment = deviceStateSummary.segments.find((segment) => (
  segment.startUtc === fixture.deviceStates.expectedGap.startUtc
  && segment.endUtc === fixture.deviceStates.expectedGap.endUtc
));
assert.deepStrictEqual(gapSegment, {
  status: 'unknown',
  materialized: false,
  startUtc: '2026-07-15T01:00:00.000Z',
  endUtc: '2026-07-15T02:00:00.000Z',
  minutes: 60,
  reasonCodes: ['DEVICE_STATE_GAP']
});
assert.strictEqual(deviceStateSummary.segments.some((segment) => (
  segment.materialized === false && segment.status === 'idle'
)), false);
assertApprovedReasonCodes(deviceStateSummary);

// 删除显式 idle 状态后，原 idle 区间也只能成为 unknown 缺口，不能估算为空载。
const noIdleStateSummary = summarizeDeviceStateCoverage(
  fixture.acceptanceDay,
  fixture.deviceStates.records.filter((record) => record.status !== 'idle'),
  fixture.timeSeries.electricity
);
assert.strictEqual(noIdleStateSummary.idleMinutes, 0);
assert.strictEqual(noIdleStateSummary.idleEnergy, 0);
assert.strictEqual(noIdleStateSummary.idleEnergyObserved, 0);
assert.strictEqual(noIdleStateSummary.idleEnergyComplete, null);
assert.strictEqual(noIdleStateSummary.value, null);
assert.strictEqual(noIdleStateSummary.idleCoverageRate, null);
assert.strictEqual(noIdleStateSummary.stateKnowledgeComplete, false);
assert.strictEqual(noIdleStateSummary.gapMinutes, 180);
assert.strictEqual(noIdleStateSummary.share.raw, null);
assert.strictEqual(noIdleStateSummary.share.rounded, null);
assert.strictEqual(noIdleStateSummary.share.observedRaw, 0);
assert.strictEqual(noIdleStateSummary.share.observedRounded, 0);
assert.strictEqual(noIdleStateSummary.share.completeWindowAvailable, false);
assert.strictEqual(noIdleStateSummary.reasonCodes.includes('DEVICE_STATE_GAP'), true);

// 30 秒 idle 与 30 秒缺口按真实毫秒重叠累计，不能整分钟二值扩张。
const subMinuteStateSummary = summarizeDeviceStateCoverage({
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:01:00.000Z'
}, [{
  status: 'idle',
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:00:30.000Z'
}], [{
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 15,
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:15:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}]);
assert.strictEqual(subMinuteStateSummary.coverageRate, 0.5);
assert.strictEqual(subMinuteStateSummary.knownStateCoverageRate, 0.5);
assert.strictEqual(subMinuteStateSummary.coveredMinutes, 0.5);
assert.strictEqual(subMinuteStateSummary.knownStateMinutes, 0.5);
assert.strictEqual(subMinuteStateSummary.explicitUnknownMinutes, 0);
assert.strictEqual(subMinuteStateSummary.idleMinutes, 0.5);
assert.strictEqual(subMinuteStateSummary.gapMinutes, 0.5);
assert.strictEqual(subMinuteStateSummary.unknownMinutes, 0.5);
assert.strictEqual(subMinuteStateSummary.knownStateMinutes + subMinuteStateSummary.unknownMinutes, 1);
assert.strictEqual(subMinuteStateSummary.idleEnergy, 0.5);
assert.strictEqual(subMinuteStateSummary.idleEnergyObserved, 0.5);
assert.strictEqual(subMinuteStateSummary.idleEnergyComplete, null);
assert.strictEqual(subMinuteStateSummary.value, null);
assert.strictEqual(subMinuteStateSummary.idleCoverageRate, 1);
assert.deepStrictEqual(subMinuteStateSummary.segments, [
  {
    status: 'idle',
    materialized: true,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:00:30.000Z',
    minutes: 0.5,
    reasonCodes: []
  },
  {
    status: 'unknown',
    materialized: false,
    startUtc: '2026-07-15T00:00:30.000Z',
    endUtc: '2026-07-15T00:01:00.000Z',
    minutes: 0.5,
    reasonCodes: ['DEVICE_STATE_GAP']
  }
]);

// 全窗口显式 unknown 属于完整物化覆盖，但已知状态分钟必须为 0。
const fullyExplicitUnknownSummary = summarizeDeviceStateCoverage({
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:01:00.000Z'
}, [{
  status: 'unknown',
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:01:00.000Z'
}], [{
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 15,
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:15:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}]);
assert.strictEqual(fullyExplicitUnknownSummary.coverageRate, 1);
assert.strictEqual(fullyExplicitUnknownSummary.coveredMinutes, 1);
assert.strictEqual(fullyExplicitUnknownSummary.knownStateCoverageRate, 0);
assert.strictEqual(fullyExplicitUnknownSummary.knownStateMinutes, 0);
assert.strictEqual(fullyExplicitUnknownSummary.explicitUnknownMinutes, 1);
assert.strictEqual(fullyExplicitUnknownSummary.unknownMinutes, 1);
assert.strictEqual(fullyExplicitUnknownSummary.gapMinutes, 0);
assert.strictEqual(fullyExplicitUnknownSummary.idleMinutes, 0);
assert.strictEqual(fullyExplicitUnknownSummary.idleEnergy, 0);
assert.strictEqual(fullyExplicitUnknownSummary.idleEnergyObserved, 0);
assert.strictEqual(fullyExplicitUnknownSummary.idleEnergyComplete, null);
assert.strictEqual(fullyExplicitUnknownSummary.value, null);
assert.strictEqual(fullyExplicitUnknownSummary.stateKnowledgeComplete, false);
assert.strictEqual(fullyExplicitUnknownSummary.share.raw, null);
assert.strictEqual(fullyExplicitUnknownSummary.share.rounded, null);
assert.strictEqual(fullyExplicitUnknownSummary.share.observedRaw, 0);
assert.strictEqual(fullyExplicitUnknownSummary.share.observedRounded, 0);
assert.strictEqual(fullyExplicitUnknownSummary.share.completeWindowAvailable, false);
assert.strictEqual(fullyExplicitUnknownSummary.knownStateMinutes + fullyExplicitUnknownSummary.unknownMinutes, 1);
assert.deepStrictEqual(fullyExplicitUnknownSummary.reasonCodes, []);
assert.deepStrictEqual(Object.keys(fullyExplicitUnknownSummary.stateMinutes), [
  'running', 'idle', 'stopped', 'offline', 'unknown'
]);
assert.strictEqual(fullyExplicitUnknownSummary.stateMinutes.unknown, 1);

// 显式 idle 的时序无交集为 null，部分覆盖返回 observed 但 complete 保持 null。
const idleWindow = {
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:30:00.000Z'
};
const halfHourIdleState = [{
  status: 'idle',
  startUtc: idleWindow.startUtc,
  endUtc: idleWindow.endUtc
}];
const noIdleEnergyIntersection = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [{
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 15,
    startUtc: '2026-07-15T00:30:00.000Z',
    endUtc: '2026-07-15T00:45:00.000Z',
    granularityMinutes: 15,
    sourceTimeZone: 'Asia/Shanghai'
  }]
);
assert.strictEqual(noIdleEnergyIntersection.idleEnergy, null);
assert.strictEqual(noIdleEnergyIntersection.idleEnergyObserved, null);
assert.strictEqual(noIdleEnergyIntersection.idleEnergyComplete, null);
assert.strictEqual(noIdleEnergyIntersection.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
const partialIdleEnergy = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [{
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 15,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    sourceTimeZone: 'Asia/Shanghai'
  }]
);
assert.strictEqual(partialIdleEnergy.idleMinutes, 30);
assert.strictEqual(partialIdleEnergy.idleCoveredMinutes, 15);
assert.strictEqual(partialIdleEnergy.idleEnergyObserved, 15);
assert.strictEqual(partialIdleEnergy.idleEnergy, 15);
assert.strictEqual(partialIdleEnergy.idleEnergyComplete, null);
assert.strictEqual(partialIdleEnergy.value, null);
assert.strictEqual(partialIdleEnergy.share.raw, null);
assert.strictEqual(partialIdleEnergy.share.denominatorRaw, null);
assert.strictEqual(partialIdleEnergy.share.observedRaw, 1);
assert.strictEqual(partialIdleEnergy.share.observedDenominatorRaw, 15);
assert.strictEqual(partialIdleEnergy.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);

// idle 自身被时序完整覆盖时，非 idle 区间时序缺口不得冻结空载 complete。
const idleCoveredButWindowPartial = summarizeDeviceStateCoverage(
  idleWindow,
  [
    {
      status: 'idle',
      startUtc: idleWindow.startUtc,
      endUtc: '2026-07-15T00:15:00.000Z'
    },
    {
      status: 'running',
      startUtc: '2026-07-15T00:15:00.000Z',
      endUtc: idleWindow.endUtc
    }
  ],
  [{
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 15,
    startUtc: idleWindow.startUtc,
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    sourceTimeZone: 'Asia/Shanghai'
  }]
);
assert.strictEqual(idleCoveredButWindowPartial.idleCoverageRate, 1);
assert.strictEqual(idleCoveredButWindowPartial.stateKnowledgeComplete, true);
assert.strictEqual(idleCoveredButWindowPartial.idleEnergyObserved, 15);
assert.strictEqual(idleCoveredButWindowPartial.idleEnergyComplete, 15);
assert.strictEqual(idleCoveredButWindowPartial.value, 15);
assert.strictEqual(idleCoveredButWindowPartial.share.raw, null);
assert.strictEqual(idleCoveredButWindowPartial.share.rounded, null);
assert.strictEqual(idleCoveredButWindowPartial.share.denominatorRaw, null);
assert.strictEqual(idleCoveredButWindowPartial.share.denominatorRounded, null);
assert.strictEqual(idleCoveredButWindowPartial.share.observedRaw, 1);
assert.strictEqual(idleCoveredButWindowPartial.share.observedRounded, 1);
assert.strictEqual(idleCoveredButWindowPartial.share.observedDenominatorRaw, 15);
assert.strictEqual(idleCoveredButWindowPartial.share.observedDenominatorRounded, 15);
assert.strictEqual(idleCoveredButWindowPartial.share.completeWindowAvailable, false);
assert.strictEqual(
  idleCoveredButWindowPartial.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'),
  true
);

const zeroIdleEnergy = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [
    {
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 0,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:15:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 0,
      startUtc: '2026-07-15T00:15:00.000Z',
      endUtc: '2026-07-15T00:30:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    }
  ]
);
assert.strictEqual(zeroIdleEnergy.idleEnergyObserved, 0);
assert.strictEqual(zeroIdleEnergy.idleEnergyComplete, 0);
assert.strictEqual(zeroIdleEnergy.value, 0);
assert.strictEqual(zeroIdleEnergy.raw.idleEnergyObserved, 0);
assert.strictEqual(zeroIdleEnergy.rounding.idleEnergyObservedRoundedToZero, false);
assert.strictEqual(zeroIdleEnergy.idleCoverageRate, 1);

// 正微量空载能耗舍入为零时保留 raw 事实、舍入标记和真实舍入差额。
const microIdleEnergy = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [{
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 4e-13,
    startUtc: idleWindow.startUtc,
    endUtc: idleWindow.endUtc,
    granularityMinutes: 30,
    sourceTimeZone: 'Asia/Shanghai'
  }]
);
assert.strictEqual(microIdleEnergy.raw.idleEnergyObserved, 4e-13);
assert.strictEqual(microIdleEnergy.raw.idleEnergyComplete, 4e-13);
assert.strictEqual(microIdleEnergy.rounded.idleEnergyObserved, 0);
assert.strictEqual(microIdleEnergy.rounded.idleEnergyComplete, 0);
assert.strictEqual(microIdleEnergy.rounding.idleEnergyObservedRoundedToZero, true);
assert.strictEqual(microIdleEnergy.rounding.idleEnergyCompleteRoundedToZero, true);
assert.strictEqual(microIdleEnergy.rounding.idleEnergyObservedDifference, 4e-13);
assert.strictEqual(microIdleEnergy.share.raw, 1);
assert.strictEqual(microIdleEnergy.share.rounded, 1);
const crossScopeIdleEnergy = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [
    {
      energyTypeCode: 'electricity',
      normalizedUnit: 'kWh',
      value: 10,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:15:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      energyTypeCode: 'natural_gas',
      normalizedUnit: 'm3',
      value: 10,
      startUtc: '2026-07-15T00:15:00.000Z',
      endUtc: '2026-07-15T00:30:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    }
  ],
  { expectedEnergyScope: { energyTypeCode: 'electricity', normalizedUnit: 'kWh' } }
);
assert.strictEqual(crossScopeIdleEnergy.idleEnergy, null);
assert.strictEqual(crossScopeIdleEnergy.idleEnergyObserved, null);
assert.strictEqual(crossScopeIdleEnergy.idleEnergyComplete, null);
assert.strictEqual(crossScopeIdleEnergy.energyScopes.length, 2);
assert.strictEqual(crossScopeIdleEnergy.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
const missingScopeIdleEnergy = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [
    {
      value: 10,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:15:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      value: 10,
      startUtc: '2026-07-15T00:15:00.000Z',
      endUtc: '2026-07-15T00:30:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    }
  ]
);
assert.strictEqual(missingScopeIdleEnergy.energyScopeComparable, false);
assert.deepStrictEqual(missingScopeIdleEnergy.energyScopes, []);
assert.strictEqual(missingScopeIdleEnergy.idleEnergy, null);
assert.strictEqual(missingScopeIdleEnergy.idleEnergyObserved, null);
assert.strictEqual(missingScopeIdleEnergy.idleEnergyComplete, null);
assert.strictEqual(missingScopeIdleEnergy.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);

// 明确无 idle 且状态无冲突时无需时序也返回真实 0；状态毫秒级重叠则整体不可计算。
const noIdleWithoutTimeseries = summarizeDeviceStateCoverage(idleWindow, [{
  status: 'running',
  startUtc: idleWindow.startUtc,
  endUtc: idleWindow.endUtc
}], []);
assert.strictEqual(noIdleWithoutTimeseries.idleMinutes, 0);
assert.strictEqual(noIdleWithoutTimeseries.idleEnergy, 0);
assert.strictEqual(noIdleWithoutTimeseries.idleEnergyComplete, 0);
assert.strictEqual(noIdleWithoutTimeseries.value, 0);
assert.strictEqual(noIdleWithoutTimeseries.stateKnowledgeComplete, true);
assert.strictEqual(noIdleWithoutTimeseries.idleCoverageRate, null);
assert.deepStrictEqual(noIdleWithoutTimeseries.reasonCodes, []);
const overlappingStateSummary = summarizeDeviceStateCoverage({
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:01:00.000Z'
}, [
  {
    status: 'idle',
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:00:30.000Z'
  },
  {
    status: 'running',
    startUtc: '2026-07-15T00:00:15.000Z',
    endUtc: '2026-07-15T00:00:45.000Z'
  }
], [{
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 15,
  startUtc: '2026-07-15T00:00:00.000Z',
  endUtc: '2026-07-15T00:15:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}]);
assert.strictEqual(overlappingStateSummary.idleEnergy, null);
assert.strictEqual(overlappingStateSummary.value, null);
assert.strictEqual(overlappingStateSummary.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
const overlappingIdleEnergySummary = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [
    {
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 15,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:15:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 15,
      startUtc: '2026-07-15T00:00:00.000Z',
      endUtc: '2026-07-15T00:15:00.000Z',
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai'
    }
  ]
);
assert.strictEqual(overlappingIdleEnergySummary.idleEnergy, null);
assert.strictEqual(overlappingIdleEnergySummary.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
const overflowIdleEnergySummary = summarizeDeviceStateCoverage(
  idleWindow,
  halfHourIdleState,
  [{
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: Number.NEGATIVE_INFINITY,
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T00:15:00.000Z',
    granularityMinutes: 15,
    sourceTimeZone: 'Asia/Shanghai'
  }]
);
assert.strictEqual(overflowIdleEnergySummary.numericOverflow, true);
assert.strictEqual(overflowIdleEnergySummary.idleEnergy, null);
assertNoNonFiniteNumbers(overflowIdleEnergySummary);

// 扫描线、双指针和 scope Map 在较大批量输入下保持稳定结果结构，不依赖机器耗时阈值。
const performanceRecordCount = 4096;
const performanceStartMs = Date.parse('2026-01-01T00:00:00.000Z');
const performanceWindow = {
  startUtc: new Date(performanceStartMs).toISOString(),
  endUtc: new Date(performanceStartMs + performanceRecordCount * 15 * TEST_MINUTE_MS).toISOString()
};
const performanceStates = Array.from({ length: performanceRecordCount }, (_unused, index) => ({
  status: index % 2 === 0 ? 'idle' : 'running',
  startUtc: new Date(performanceStartMs + index * 15 * TEST_MINUTE_MS).toISOString(),
  endUtc: new Date(performanceStartMs + (index + 1) * 15 * TEST_MINUTE_MS).toISOString()
}));
const performanceEnergy = Array.from({ length: performanceRecordCount }, (_unused, index) => ({
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 1,
  startUtc: new Date(performanceStartMs + index * 15 * TEST_MINUTE_MS).toISOString(),
  endUtc: new Date(performanceStartMs + (index + 1) * 15 * TEST_MINUTE_MS).toISOString(),
  granularityMinutes: 15,
  sourceTimeZone: 'Etc/GMT'
}));
const performanceStateSummary = summarizeDeviceStateCoverage(
  performanceWindow,
  performanceStates,
  performanceEnergy
);
assert.strictEqual(performanceStateSummary.idleEnergy, performanceRecordCount / 2);
assert.strictEqual(performanceStateSummary.idleEnergyComplete, performanceRecordCount / 2);
assert.strictEqual(performanceStateSummary.energyScopeComparable, true);
assert.strictEqual(performanceStateSummary.energyScopes.length, 1);
assert.deepStrictEqual(performanceStateSummary.reasonCodes, []);
const distinctScopePerformanceSummary = summarizeDeviceStateCoverage(
  performanceWindow,
  performanceStates,
  performanceEnergy.map((record, index) => ({
    ...record,
    energyTypeCode: `energy_scope_${index}`
  }))
);
assert.strictEqual(distinctScopePerformanceSummary.energyScopeComparable, false);
assert.strictEqual(distinctScopePerformanceSummary.energyScopes.length, performanceRecordCount);
assert.strictEqual(distinctScopePerformanceSummary.idleEnergy, null);
assert.strictEqual(
  distinctScopePerformanceSummary.reasonCodes.includes('UNIT_NOT_COMPARABLE'),
  true
);

// 全天 96 条记录总能量为 (100+...+107)*12=9936 kWh，平均负荷为 414 kW。
const loadMetrics = calculateLoadMetrics(
  fixture.timeSeries.electricity,
  fixture.acceptanceDay,
  { minimumCoverageRate: 1 }
);
assert.strictEqual(loadMetrics.energyTypeCode, 'electricity');
assert.strictEqual(loadMetrics.unit, 'kWh');
assert.strictEqual(loadMetrics.coverageRate, 1);
assert.strictEqual(loadMetrics.totalEnergy, 9936);
assert.strictEqual(loadMetrics.averageLoad, 414);
assert.strictEqual(loadMetrics.maxLoad, 428);
assertClose(loadMetrics.loadRate, 414 / 428);
assertClose(loadMetrics.value, 414 / 428);
assert.strictEqual(loadMetrics.loadRateCalculable, true);
assert.strictEqual(loadMetrics.loadRateReason, null);
assert.deepStrictEqual(loadMetrics.reasonCodes, []);

// 完整覆盖的全零记录保留真实零负荷，零分母只影响负荷率可计算性，不污染质量原因码。
const zeroLoadMetrics = calculateLoadMetrics(
  fixture.timeSeries.electricity.map((record) => ({ ...record, value: 0 })),
  fixture.acceptanceDay,
  { minimumCoverageRate: 1 }
);
assert.strictEqual(zeroLoadMetrics.coverageRate, 1);
assert.strictEqual(zeroLoadMetrics.totalEnergy, 0);
assert.strictEqual(zeroLoadMetrics.averageLoad, 0);
assert.strictEqual(zeroLoadMetrics.maxLoad, 0);
assert.strictEqual(zeroLoadMetrics.loadRate, null);
assert.strictEqual(zeroLoadMetrics.value, null);
assert.strictEqual(zeroLoadMetrics.loadRateCalculable, false);
assert.strictEqual(zeroLoadMetrics.loadRateReason, 'ZERO_MAX_LOAD');
assert.deepStrictEqual(zeroLoadMetrics.reasonCodes, []);

// 达到阈值的 25%/50% 部分覆盖必须按有效覆盖小时计算平均负荷，而非按整窗稀释。
const quarterCoverageMetrics = calculateLoadMetrics(
  fixture.timeSeries.electricity.slice(0, 24),
  fixture.acceptanceDay,
  { minimumCoverageRate: 0.25 }
);
assert.strictEqual(quarterCoverageMetrics.coverageRate, 0.25);
assert.strictEqual(quarterCoverageMetrics.coveredMinutes, 6 * 60);
assert.strictEqual(quarterCoverageMetrics.totalEnergy, 2484);
assert.strictEqual(quarterCoverageMetrics.averageLoad, 414);
assert.strictEqual(quarterCoverageMetrics.maxLoad, 428);
assertClose(quarterCoverageMetrics.loadRate, 414 / 428);
assert.deepStrictEqual(quarterCoverageMetrics.reasonCodes, []);
const halfCoverageMetrics = calculateLoadMetrics(
  fixture.timeSeries.electricity.slice(0, 48),
  fixture.acceptanceDay,
  { minimumCoverageRate: 0.5 }
);
assert.strictEqual(halfCoverageMetrics.coverageRate, 0.5);
assert.strictEqual(halfCoverageMetrics.coveredMinutes, 12 * 60);
assert.strictEqual(halfCoverageMetrics.totalEnergy, 4968);
assert.strictEqual(halfCoverageMetrics.averageLoad, 414);
assert.strictEqual(halfCoverageMetrics.maxLoad, 428);
assertClose(halfCoverageMetrics.loadRate, 414 / 428);
assert.deepStrictEqual(halfCoverageMetrics.reasonCodes, []);

// 缺数据时覆盖率真实为 0，但不可计算指标必须为 null 而不是 0。
const missingLoadMetrics = calculateLoadMetrics([], fixture.acceptanceDay, { minimumCoverageRate: 1 });
assert.strictEqual(missingLoadMetrics.coverageRate, 0);
assert.strictEqual(missingLoadMetrics.averageLoad, null);
assert.strictEqual(missingLoadMetrics.maxLoad, null);
assert.strictEqual(missingLoadMetrics.loadRate, null);
assert.strictEqual(missingLoadMetrics.value, null);
assert.strictEqual(missingLoadMetrics.loadRateCalculable, false);
assert.strictEqual(missingLoadMetrics.loadRateReason, null);
assert.strictEqual(missingLoadMetrics.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
assert.strictEqual(missingLoadMetrics.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);

// 95/96 覆盖率低于阈值时不输出伪造负荷结论。
const lowCoverageMetrics = calculateLoadMetrics(
  fixture.timeSeries.electricity.slice(0, 95),
  fixture.acceptanceDay,
  { minimumCoverageRate: 1 }
);
assertClose(lowCoverageMetrics.coverageRate, 95 / 96);
assert.strictEqual(lowCoverageMetrics.averageLoad, null);
assert.strictEqual(lowCoverageMetrics.value, null);
assert.strictEqual(lowCoverageMetrics.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);

// 混合 15/30 分钟粒度和来源重叠/重复分别返回批准原因码。
const mixedGranularityRecords = [
  { ...fixture.timeSeries.electricity[0] },
  {
    ...fixture.timeSeries.electricity[1],
    endUtc: fixture.timeSeries.electricity[2].endUtc,
    granularityMinutes: 30,
    value: 210
  }
];
const mixedMetrics = calculateLoadMetrics(mixedGranularityRecords, {
  startUtc: mixedGranularityRecords[0].startUtc,
  endUtc: mixedGranularityRecords[1].endUtc
}, { minimumCoverageRate: 1 });
assert.strictEqual(mixedMetrics.value, null);
assert.strictEqual(mixedMetrics.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), true);
const overlapMetrics = calculateLoadMetrics([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[0], id: 'duplicate-record' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[0].endUtc
}, { minimumCoverageRate: 1 });
assert.strictEqual(overlapMetrics.value, null);
assert.strictEqual(overlapMetrics.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);

// 同一负荷入口混入不同能源或不同单位时不得跨分面求和。
const mixedEnergyLoad = calculateLoadMetrics([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[1], energyTypeCode: 'natural_gas', unit: 'm3' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[1].endUtc
}, { minimumCoverageRate: 1 });
assert.strictEqual(mixedEnergyLoad.value, null);
assert.strictEqual(mixedEnergyLoad.energyTypeCode, null);
assert.strictEqual(mixedEnergyLoad.unit, null);
assert.deepStrictEqual(mixedEnergyLoad.energyScopes, [
  { energyTypeCode: 'electricity', unit: 'kWh' },
  { energyTypeCode: 'natural_gas', unit: 'm3' }
]);
assert.deepStrictEqual(mixedEnergyLoad.reasonCodes, ['UNIT_NOT_COMPARABLE']);
const mixedUnitLoad = calculateLoadMetrics([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[1], unit: 'MWh' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[1].endUtc
}, { minimumCoverageRate: 1 });
assert.strictEqual(mixedUnitLoad.value, null);
assert.deepStrictEqual(mixedUnitLoad.reasonCodes, ['UNIT_NOT_COMPARABLE']);
assertApprovedReasonCodes(mixedMetrics);
assertApprovedReasonCodes(overlapMetrics);
assertApprovedReasonCodes(mixedEnergyLoad);
assertApprovedReasonCodes(mixedUnitLoad);

// 五类阈值操作符必须精确处理相等边界，between 同时包含上下边界。
const thresholdBoundaryCases = [
  { operator: 'gt', value: 10, actualValue: 10, matched: false },
  { operator: 'gte', value: 10, actualValue: 10, matched: true },
  { operator: 'lt', value: 10, actualValue: 10, matched: false },
  { operator: 'lte', value: 10, actualValue: 10, matched: true },
  { operator: 'between', min: 10, max: 20, actualValue: 10, matched: true },
  { operator: 'between', min: 10, max: 20, actualValue: 20, matched: true },
  { operator: 'between', min: 10, max: 20, actualValue: 21, matched: false }
];
thresholdBoundaryCases.forEach(({ actualValue, matched, ...threshold }) => {
  const result = evaluateStrategyThreshold(actualValue, { ...threshold, unit: '%' });
  assert.strictEqual(result.evaluable, true);
  assert.strictEqual(result.matched, matched);
  assert.strictEqual(result.value, matched);
  assert.strictEqual(result.actualValue, actualValue);
  assert.deepStrictEqual(result.reasonCodes, []);
});

// 非有限实际值、非法操作符、非法阈值值和倒置 between 范围必须稳定返回不可评估。
const invalidThresholdResults = [
  evaluateStrategyThreshold(Number.NaN, { operator: 'gt', value: 10, unit: '%' }),
  evaluateStrategyThreshold(Number.POSITIVE_INFINITY, { operator: 'lte', value: 10, unit: '%' }),
  evaluateStrategyThreshold(10, { operator: 'eq', value: 10, unit: '%' }),
  evaluateStrategyThreshold(10, { operator: 'gt', value: Number.NaN, unit: '%' }),
  evaluateStrategyThreshold(10, { operator: 'between', min: 20, max: 10, unit: '%' }),
  evaluateStrategyThreshold(10, { operator: 'between', min: 0, max: Number.POSITIVE_INFINITY, unit: '%' })
];
invalidThresholdResults.forEach((result) => {
  assert.strictEqual(result.evaluable, false);
  assert.strictEqual(result.matched, null);
  assert.strictEqual(result.value, null);
  assert.strictEqual(result.errors.length > 0, true);
  assertApprovedReasonCodes(result);
});
assert.strictEqual(invalidThresholdResults[0].actualValue, null);
assert.strictEqual(invalidThresholdResults[2].threshold, null);
const normalizedThresholdResult = evaluateStrategyThreshold(15, {
  operator: 'between',
  min: 10,
  max: 20,
  unit: '%',
  reductionRate: 0.08,
  ignoredField: '不得进入规范阈值'
});
assert.deepStrictEqual(normalizedThresholdResult.threshold, {
  operator: 'between',
  min: 10,
  max: 20,
  unit: '%',
  reductionRate: 0.08
});

// 负荷率比例转百分数必须显式调用，不允许构造策略时隐式混用单位。
assert.strictEqual(convertRatioToPercentage(0), 0);
assert.strictEqual(convertRatioToPercentage(0.725), 72.5);
assert.strictEqual(convertRatioToPercentage(1), 100);
assert.strictEqual(convertRatioToPercentage(-0.1), null);
assert.strictEqual(convertRatioToPercentage(1.01), null);
assert.strictEqual(convertRatioToPercentage(Number.NaN), null);

// 全天单表计峰值能量为 107 kWh/15min，12 个并列峰值按 UTC 和证据标识稳定排序并截断。
const peakIntervalSummary = calculatePeakIntervalEnergy(
  fixture.timeSeries.electricity,
  fixture.acceptanceDay,
  { minimumCoverageRate: 1, evidenceLimit: 3 }
);
assert.strictEqual(peakIntervalSummary.value, 107);
assert.strictEqual(peakIntervalSummary.peakIntervalEnergy, 107);
assert.strictEqual(peakIntervalSummary.energyTypeCode, 'electricity');
assert.strictEqual(peakIntervalSummary.sourceUnit, 'kWh');
assert.strictEqual(peakIntervalSummary.unit, 'kWh/15min');
assert.strictEqual(peakIntervalSummary.granularityMinutes, 15);
assert.strictEqual(peakIntervalSummary.coverageRate, 1);
assert.strictEqual(peakIntervalSummary.totalEnergy, 9936);
assert.strictEqual(peakIntervalSummary.totalEnergyComplete, true);
assert.strictEqual(peakIntervalSummary.peakIntervalCount, 12);
assert.deepStrictEqual(peakIntervalSummary.evidence, [
  'electricity-interval-08',
  'electricity-interval-16',
  'electricity-interval-24'
]);
assert.strictEqual(peakIntervalSummary.peakIntervals.length, 3);
assert.strictEqual(peakIntervalSummary.evidenceLimit, 3);
assert.strictEqual(peakIntervalSummary.evidenceTruncated, true);
assert.deepStrictEqual(peakIntervalSummary.reasonCodes, []);
const reversedPeakIntervalSummary = calculatePeakIntervalEnergy(
  [...fixture.timeSeries.electricity].reverse(),
  fixture.acceptanceDay,
  { minimumCoverageRate: 1, evidenceLimit: 3 }
);
assert.deepStrictEqual(reversedPeakIntervalSummary.evidence, peakIntervalSummary.evidence);
assert.deepStrictEqual(reversedPeakIntervalSummary.peakIntervals, peakIntervalSummary.peakIntervals);
const cappedPeakIntervalSummary = calculatePeakIntervalEnergy(
  fixture.timeSeries.electricity,
  fixture.acceptanceDay,
  { minimumCoverageRate: 1, evidenceLimit: 1000 }
);
assert.strictEqual(cappedPeakIntervalSummary.evidenceLimit, 100);
assert.strictEqual(cappedPeakIntervalSummary.evidence.length, 12);

// 窗口边界部分覆盖记录仍参与覆盖率和窗口总能耗，但只有完整落窗记录参与峰值。
const partialBoundaryWindow = {
  startUtc: '2026-07-14T16:05:00.000Z',
  endUtc: '2026-07-14T16:35:00.000Z',
  sourceTimeZone: 'Asia/Shanghai'
};
const partialBoundaryPeak = calculatePeakIntervalEnergy(
  fixture.timeSeries.electricity.slice(0, 3),
  partialBoundaryWindow,
  { minimumCoverageRate: 1 }
);
assert.strictEqual(partialBoundaryPeak.value, 101);
assert.strictEqual(partialBoundaryPeak.peakIntervalEnergy, 101);
assert.strictEqual(partialBoundaryPeak.coverageRate, 1);
assert.strictEqual(partialBoundaryPeak.coveredMinutes, 30);
assertClose(partialBoundaryPeak.coveredEnergy, 201.666666666667);
assertClose(partialBoundaryPeak.totalEnergy, 201.666666666667);
assert.strictEqual(partialBoundaryPeak.totalEnergyComplete, true);
assert.deepStrictEqual(partialBoundaryPeak.evidence, ['electricity-interval-02']);
assert.deepStrictEqual(partialBoundaryPeak.reasonCodes, []);

// 完整窗口仅由两个边界部分记录覆盖时可形成完整总能耗，但不得伪造完整粒度峰值。
const boundaryOnlyPeak = calculatePeakIntervalEnergy(
  fixture.timeSeries.electricity.slice(0, 2),
  {
    startUtc: '2026-07-14T16:05:00.000Z',
    endUtc: '2026-07-14T16:20:00.000Z',
    sourceTimeZone: 'Asia/Shanghai'
  },
  { minimumCoverageRate: 1 }
);
assert.strictEqual(boundaryOnlyPeak.value, null);
assert.strictEqual(boundaryOnlyPeak.coverageRate, 1);
assert.strictEqual(boundaryOnlyPeak.coveredMinutes, 15);
assertClose(boundaryOnlyPeak.totalEnergy, 100.333333333334);
assert.strictEqual(boundaryOnlyPeak.totalEnergyComplete, true);
assert.deepStrictEqual(boundaryOnlyPeak.evidence, []);
assert.deepStrictEqual(boundaryOnlyPeak.reasonCodes, ['NO_TIMESERIES_DATA']);

// 显式放宽覆盖阈值时只允许完整落窗记录参与峰值，总能耗仍因非全覆盖保持 null。
const partialCoveragePeak = calculatePeakIntervalEnergy(
  [fixture.timeSeries.electricity[1]],
  partialBoundaryWindow,
  { minimumCoverageRate: 0.5 }
);
assert.strictEqual(partialCoveragePeak.value, 101);
assert.strictEqual(partialCoveragePeak.coverageRate, 0.5);
assert.strictEqual(partialCoveragePeak.coveredEnergy, 101);
assert.strictEqual(partialCoveragePeak.totalEnergy, null);
assert.strictEqual(partialCoveragePeak.totalEnergyComplete, false);
assert.deepStrictEqual(partialCoveragePeak.evidence, ['electricity-interval-02']);

// 无数据、混合粒度、来源重叠、跨能源单位和覆盖不足均不得输出峰值数值。
const missingPeak = calculatePeakIntervalEnergy([], fixture.acceptanceDay);
assert.strictEqual(missingPeak.value, null);
assert.strictEqual(missingPeak.coverageRate, 0);
assert.strictEqual(missingPeak.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
assert.strictEqual(missingPeak.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
const mixedGranularityPeak = calculatePeakIntervalEnergy(mixedGranularityRecords, {
  startUtc: mixedGranularityRecords[0].startUtc,
  endUtc: mixedGranularityRecords[1].endUtc,
  sourceTimeZone: 'Asia/Shanghai'
});
assert.strictEqual(mixedGranularityPeak.value, null);
assert.strictEqual(mixedGranularityPeak.reasonCodes.includes('MIXED_INTERVAL_GRANULARITY'), true);
const overlapPeak = calculatePeakIntervalEnergy([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[0], id: 'duplicate-peak-record' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[0].endUtc,
  sourceTimeZone: 'Asia/Shanghai'
});
assert.strictEqual(overlapPeak.value, null);
assert.strictEqual(overlapPeak.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'), true);
const mixedUnitPeak = calculatePeakIntervalEnergy([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[1], unit: 'MWh' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[1].endUtc,
  sourceTimeZone: 'Asia/Shanghai'
});
assert.strictEqual(mixedUnitPeak.value, null);
assert.strictEqual(mixedUnitPeak.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
const mixedEnergyPeak = calculatePeakIntervalEnergy([
  fixture.timeSeries.electricity[0],
  { ...fixture.timeSeries.electricity[1], energyTypeCode: 'natural_gas', unit: 'm3' }
], {
  startUtc: fixture.timeSeries.electricity[0].startUtc,
  endUtc: fixture.timeSeries.electricity[1].endUtc,
  sourceTimeZone: 'Asia/Shanghai'
});
assert.strictEqual(mixedEnergyPeak.value, null);
assert.strictEqual(mixedEnergyPeak.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
const insufficientCoveragePeak = calculatePeakIntervalEnergy(
  fixture.timeSeries.electricity.slice(0, 3),
  {
    startUtc: fixture.timeSeries.electricity[0].startUtc,
    endUtc: fixture.timeSeries.electricity[3].endUtc,
    sourceTimeZone: 'Asia/Shanghai'
  }
);
assert.strictEqual(insufficientCoveragePeak.value, null);
assert.strictEqual(insufficientCoveragePeak.coverageRate, 0.75);
assert.strictEqual(insufficientCoveragePeak.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
[
  missingPeak,
  mixedGranularityPeak,
  overlapPeak,
  mixedUnitPeak,
  mixedEnergyPeak,
  insufficientCoveragePeak,
  partialBoundaryPeak,
  boundaryOnlyPeak
].forEach(assertApprovedReasonCodes);

// 全覆盖、匹配、合法节能率和窗口总能耗口径同时成立时才计算预计节能量。
const peakStrategyRule = {
  ruleCode: 'PEAK_LOAD_REVIEW',
  ruleVersion: 'peak-load-rule:v1',
  formulaVersion: 'load-analysis:v1',
  threshold: {
    operator: 'gt',
    value: 105,
    unit: 'kWh/15min',
    reductionRate: 0.1
  },
  priority: 'high',
  recommendation: '请人工复核并调整峰值时段用能安排。',
  savingBasis: 'window_total_energy'
};
const matchedStrategyEvaluation = buildStrategyEvaluation(
  peakStrategyRule,
  peakIntervalSummary,
  {}
);
assert.strictEqual(matchedStrategyEvaluation.matchStatus, 'matched');
assert.strictEqual(matchedStrategyEvaluation.actualValue, 107);
assert.strictEqual(matchedStrategyEvaluation.estimatedSaving, 993.6);
assert.strictEqual(matchedStrategyEvaluation.estimatedSavingUnit, 'kWh');
assert.deepStrictEqual(matchedStrategyEvaluation.threshold, peakStrategyRule.threshold);
assert.strictEqual(matchedStrategyEvaluation.recommendation, peakStrategyRule.recommendation);
assert.strictEqual(matchedStrategyEvaluation.priority, 'high');
assert.deepStrictEqual(matchedStrategyEvaluation.reasonCodes, []);
assert.deepStrictEqual(matchedStrategyEvaluation.automationBoundary, {
  usesAI: false,
  issuesControlCommand: false,
  changesDeviceState: false,
  requiresManualReview: true
});
assert.strictEqual(matchedStrategyEvaluation.usesAI, false);
assert.strictEqual(matchedStrategyEvaluation.issuesControlCommand, false);
assert.strictEqual(matchedStrategyEvaluation.changesDeviceState, false);
assert.strictEqual(matchedStrategyEvaluation.requiresManualReview, true);
assert.deepStrictEqual(matchedStrategyEvaluation.contractValidation, { valid: true, errors: [] });

// 未匹配、错误节能口径、缺少节能率或总能耗不完整时预计节能量必须为 null。
const savingGateEvaluations = [
  buildStrategyEvaluation({
    ...peakStrategyRule,
    threshold: { ...peakStrategyRule.threshold, value: 200 }
  }, peakIntervalSummary, {}),
  buildStrategyEvaluation({ ...peakStrategyRule, savingBasis: 'peak_interval_energy' }, peakIntervalSummary, {}),
  buildStrategyEvaluation({
    ...peakStrategyRule,
    threshold: { operator: 'gt', value: 105, unit: 'kWh/15min' }
  }, peakIntervalSummary, {}),
  buildStrategyEvaluation(peakStrategyRule, {
    ...peakIntervalSummary,
    totalEnergyComplete: false
  }, {})
];
assert.strictEqual(savingGateEvaluations[0].matchStatus, 'not_matched');
savingGateEvaluations.forEach((evaluation) => {
  assert.strictEqual(evaluation.estimatedSaving, null);
  assert.strictEqual(evaluation.estimatedSavingUnit, null);
  assert.deepStrictEqual(evaluation.contractValidation, { valid: true, errors: [] });
});

// 阈值和指标单位必须严格一致，比例值不得被策略构造器隐式当作百分数。
const unitMismatchEvaluation = buildStrategyEvaluation(peakStrategyRule, {
  ...peakIntervalSummary,
  unit: 'MWh/15min'
}, {});
assert.strictEqual(unitMismatchEvaluation.matchStatus, 'not_evaluable');
assert.strictEqual(unitMismatchEvaluation.actualValue, null);
assert.strictEqual(unitMismatchEvaluation.estimatedSaving, null);
assert.deepStrictEqual(unitMismatchEvaluation.reasonCodes, ['UNIT_NOT_COMPARABLE']);
assert.deepStrictEqual(unitMismatchEvaluation.contractValidation, { valid: true, errors: [] });
const ratioUnitMismatchEvaluation = buildStrategyEvaluation({
  ...peakStrategyRule,
  threshold: { operator: 'gte', value: 80, unit: '%' }
}, {
  ...peakIntervalSummary,
  value: 0.8,
  unit: 'ratio'
}, {});
assert.strictEqual(ratioUnitMismatchEvaluation.matchStatus, 'not_evaluable');
assert.strictEqual(ratioUnitMismatchEvaluation.actualValue, null);
assert.deepStrictEqual(ratioUnitMismatchEvaluation.reasonCodes, ['UNIT_NOT_COMPARABLE']);

// 覆盖不足和无有效值必须输出 not_evaluable，且 actualValue/estimatedSaving 严格为 null。
const notEvaluableStrategy = buildStrategyEvaluation(
  peakStrategyRule,
  insufficientCoveragePeak,
  {}
);
assert.strictEqual(notEvaluableStrategy.matchStatus, 'not_evaluable');
assert.strictEqual(notEvaluableStrategy.actualValue, null);
assert.strictEqual(notEvaluableStrategy.estimatedSaving, null);
assert.deepStrictEqual(notEvaluableStrategy.evidence, []);
assert.strictEqual(notEvaluableStrategy.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
assert.strictEqual(notEvaluableStrategy.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
assert.strictEqual(notEvaluableStrategy.usesAI, false);
assert.strictEqual(notEvaluableStrategy.issuesControlCommand, false);
assert.strictEqual(notEvaluableStrategy.changesDeviceState, false);
assert.strictEqual(notEvaluableStrategy.requiresManualReview, true);
assert.deepStrictEqual(notEvaluableStrategy.contractValidation, { valid: true, errors: [] });

// 非法 reductionRate 不得绕过阈值契约或形成预计节能量。
const invalidReductionStrategy = buildStrategyEvaluation({
  ...peakStrategyRule,
  threshold: { ...peakStrategyRule.threshold, reductionRate: 1.1 }
}, peakIntervalSummary, {});
assert.strictEqual(invalidReductionStrategy.matchStatus, 'not_evaluable');
assert.strictEqual(invalidReductionStrategy.actualValue, null);
assert.strictEqual(invalidReductionStrategy.estimatedSaving, null);
assert.strictEqual(invalidReductionStrategy.errors.includes('INVALID_RULE_REDUCTION_RATE'), true);
assert.deepStrictEqual(invalidReductionStrategy.contractValidation, { valid: true, errors: [] });

// 缺少真实证据、有效数据范围或规则身份时必须安全降级，不得返回匹配值或预计节能量。
const missingEvidenceStrategy = buildStrategyEvaluation(peakStrategyRule, {
  ...peakIntervalSummary,
  evidence: []
}, {});
assert.strictEqual(missingEvidenceStrategy.matchStatus, 'not_evaluable');
assert.strictEqual(missingEvidenceStrategy.actualValue, null);
assert.strictEqual(missingEvidenceStrategy.estimatedSaving, null);
assert.deepStrictEqual(missingEvidenceStrategy.evidence, []);
assert.strictEqual(missingEvidenceStrategy.errors.includes('MISSING_STRATEGY_EVIDENCE'), true);
assert.deepStrictEqual(missingEvidenceStrategy.contractValidation, { valid: true, errors: [] });
const missingDataRangeStrategy = buildStrategyEvaluation(peakStrategyRule, {
  ...peakIntervalSummary,
  dataRange: null
}, {});
assert.strictEqual(missingDataRangeStrategy.matchStatus, 'not_evaluable');
assert.strictEqual(missingDataRangeStrategy.actualValue, null);
assert.strictEqual(missingDataRangeStrategy.estimatedSaving, null);
assert.strictEqual(missingDataRangeStrategy.dataRange, null);
assert.strictEqual(missingDataRangeStrategy.errors.includes('MISSING_STRATEGY_DATA_RANGE'), true);
assert.deepStrictEqual(missingDataRangeStrategy.contractValidation, { valid: true, errors: [] });
const missingIdentityStrategy = buildStrategyEvaluation({
  ...peakStrategyRule,
  ruleCode: '',
  ruleVersion: null
}, peakIntervalSummary, {});
assert.strictEqual(missingIdentityStrategy.matchStatus, 'not_evaluable');
assert.strictEqual(missingIdentityStrategy.actualValue, null);
assert.strictEqual(missingIdentityStrategy.estimatedSaving, null);
assert.strictEqual(missingIdentityStrategy.ruleCode, 'UNSPECIFIED_STRATEGY_RULE');
assert.strictEqual(missingIdentityStrategy.errors.includes('INVALID_RULE_IDENTITY'), true);
assert.deepStrictEqual(missingIdentityStrategy.contractValidation, { valid: true, errors: [] });

// 自动执行、主体加实际设备控制动作的承诺必须降级，且不依赖文本中出现“自动”。
const controlSubjects = ['AI', '系统', '平台', '程序', '服务'];
const controlTenses = ['已', '将', '会'];
const controlActions = [
  '下发控制指令',
  '关闭设备',
  '开启设备',
  '执行设备启停',
  '远程控制设备'
];
const forbiddenControlRecommendations = [
  'AI已自动执行峰值削减方案。',
  '系统将自动下发控制命令。',
  '平台已改变设备状态。',
  ...controlSubjects.flatMap((subject) => controlTenses.flatMap((tense) => (
    controlActions.map((action) => `${subject}${tense}${action}。`)
  )))
];
forbiddenControlRecommendations.forEach((recommendation) => {
  const unsafeEvaluation = buildStrategyEvaluation({
    ...peakStrategyRule,
    recommendation
  }, peakIntervalSummary, {});
  assert.strictEqual(unsafeEvaluation.matchStatus, 'not_evaluable', recommendation);
  assert.strictEqual(unsafeEvaluation.actualValue, null, recommendation);
  assert.strictEqual(unsafeEvaluation.estimatedSaving, null, recommendation);
  assert.notStrictEqual(unsafeEvaluation.recommendation, recommendation, recommendation);
  assert.strictEqual(
    unsafeEvaluation.errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'),
    true,
    recommendation
  );
  assert.deepStrictEqual(
    unsafeEvaluation.contractValidation,
    { valid: true, errors: [] },
    recommendation
  );
});

// 人工调整计划及人工维护业务记录不属于设备控制，应保持正常评价。
const allowedManualRecommendations = [
  '建议人工调整排班计划。',
  '建议人工调整设备启停计划，并在执行前确认。',
  '请人工修改设备状态记录后重新评估。',
  '请人工补齐设备状态记录后重新评估。',
  '请人工修正数据记录后重新评估。',
  '请人工核对台账记录后重新评估。',
  '请人工修正导入记录后重新评估。'
];
allowedManualRecommendations.forEach((recommendation) => {
  const manualEvaluation = buildStrategyEvaluation({
    ...peakStrategyRule,
    recommendation
  }, peakIntervalSummary, {});
  assert.strictEqual(manualEvaluation.matchStatus, 'matched', recommendation);
  assert.strictEqual(manualEvaluation.actualValue, 107, recommendation);
  assert.strictEqual(
    manualEvaluation.errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'),
    false,
    recommendation
  );
  assert.deepStrictEqual(
    manualEvaluation.contractValidation,
    { valid: true, errors: [] },
    recommendation
  );
});
const manualStatusRecordEvaluation = buildStrategyEvaluation({
  ...peakStrategyRule,
  recommendation: '请人工修改设备状态记录后重新评估。'
}, peakIntervalSummary, {});
assert.strictEqual(
  manualStatusRecordEvaluation.recommendation,
  '请人工修改设备状态记录后重新评估。'
);

// 人工记录维护与控制承诺混写时，控制主体和动作仍必须优先拒绝。
[
  '请人工修改设备状态记录后重新评估，系统将下发控制指令。',
  '请人工核对台账记录，平台会远程控制设备。',
  '系统修改设备状态记录并下发控制。',
  '请人工修改设备状态记录后重新评估，已改变设备状态。'
].forEach((recommendation) => {
  const mixedControlEvaluation = buildStrategyEvaluation({
    ...peakStrategyRule,
    recommendation
  }, peakIntervalSummary, {});
  assert.strictEqual(mixedControlEvaluation.matchStatus, 'not_evaluable', recommendation);
  assert.strictEqual(mixedControlEvaluation.actualValue, null, recommendation);
  assert.strictEqual(mixedControlEvaluation.estimatedSaving, null, recommendation);
  assert.strictEqual(
    mixedControlEvaluation.errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'),
    true,
    recommendation
  );
  assert.deepStrictEqual(
    mixedControlEvaluation.contractValidation,
    { valid: true, errors: [] },
    recommendation
  );
});
const emptyInputStrategyEvaluation = buildStrategyEvaluation(null, null, null);
assert.strictEqual(emptyInputStrategyEvaluation.matchStatus, 'not_evaluable');
assert.strictEqual(emptyInputStrategyEvaluation.actualValue, null);
assert.strictEqual(emptyInputStrategyEvaluation.estimatedSaving, null);
assert.deepStrictEqual(emptyInputStrategyEvaluation.evidence, []);
assert.strictEqual(emptyInputStrategyEvaluation.dataRange, null);
assert.deepStrictEqual(emptyInputStrategyEvaluation.contractValidation, { valid: true, errors: [] });

// 同比/环比正常值独立按 (本期-基期)/|基期| 计算。
const periodComparison = calculatePeriodComparison(120, 100, 'year_over_year');
assert.strictEqual(periodComparison.absoluteDifference, 20);
assert.strictEqual(periodComparison.changeRate, 0.2);
assert.strictEqual(periodComparison.value, 0.2);
assert.strictEqual(periodComparison.calculable, true);
assert.strictEqual(periodComparison.calculationStatus, 'available');
assert.deepStrictEqual(periodComparison.reasonCodes, []);

// 当前值或基期缺失时保持既有原因语义，并补充稳定计算状态。
const missingBaseComparison = calculatePeriodComparison(120, null, 'period_over_period');
assert.strictEqual(missingBaseComparison.value, null);
assert.strictEqual(missingBaseComparison.changeRate, null);
assert.strictEqual(missingBaseComparison.calculationStatus, 'base_missing');
assert.strictEqual(missingBaseComparison.reasonCodes.includes('NO_TIMESERIES_DATA'), true);
const missingCurrentComparison = calculatePeriodComparison(null, 120, 'period_over_period');
assert.strictEqual(missingCurrentComparison.value, null);
assert.strictEqual(missingCurrentComparison.calculationStatus, 'current_missing');
assert.strictEqual(missingCurrentComparison.reasonCodes.includes('NO_TIMESERIES_DATA'), true);

// 基期为零时不产生 Infinity，比例值必须为 null 并保持既有不可比原因。
const zeroBaseComparison = calculatePeriodComparison(120, 0, 'year_over_year');
assert.strictEqual(zeroBaseComparison.value, null);
assert.strictEqual(zeroBaseComparison.changeRate, null);
assert.strictEqual(zeroBaseComparison.absoluteDifference, 120);
assert.strictEqual(zeroBaseComparison.calculable, false);
assert.strictEqual(zeroBaseComparison.calculationStatus, 'base_zero');
assert.strictEqual(zeroBaseComparison.reasonCodes.includes('UNIT_NOT_COMPARABLE'), true);
assert.strictEqual(Number.isFinite(zeroBaseComparison.changeRate), false);

// 当前真实零值与有限正基期仍应正常计算负向变化率。
const zeroCurrentComparison = calculatePeriodComparison(0, 100, 'period_over_period');
assert.strictEqual(zeroCurrentComparison.absoluteDifference, -100);
assert.strictEqual(zeroCurrentComparison.changeRate, -1);
assert.strictEqual(zeroCurrentComparison.calculable, true);
assert.strictEqual(zeroCurrentComparison.calculationStatus, 'available');
assert.deepStrictEqual(zeroCurrentComparison.reasonCodes, []);

// 有限大当前值和微小非零基期导致变化率溢出时，应局部降级且稳定保留有限绝对差。
const rateOverflowComparison = calculatePeriodComparison(1e308, 1e-6, 'year_over_year');
const repeatedRateOverflowComparison = calculatePeriodComparison(1e308, 1e-6, 'year_over_year');
assert.deepStrictEqual(repeatedRateOverflowComparison, rateOverflowComparison);
assert.strictEqual(rateOverflowComparison.value, null);
assert.strictEqual(rateOverflowComparison.absoluteDifference, 1e308);
assert.strictEqual(rateOverflowComparison.changeRate, null);
assert.strictEqual(rateOverflowComparison.calculable, false);
assert.strictEqual(rateOverflowComparison.calculationStatus, 'numeric_overflow');
assert.deepStrictEqual(rateOverflowComparison.reasonCodes, []);
assertNoNonFiniteNumbers(rateOverflowComparison);

// 负向有限大差同样应识别变化率溢出，不把结果标记为可计算。
const negativeRateOverflowComparison = calculatePeriodComparison(-1e308, 1e-6, 'period_over_period');
assert.strictEqual(negativeRateOverflowComparison.absoluteDifference, -1e308);
assert.strictEqual(negativeRateOverflowComparison.changeRate, null);
assert.strictEqual(negativeRateOverflowComparison.calculable, false);
assert.strictEqual(negativeRateOverflowComparison.calculationStatus, 'numeric_overflow');
assert.deepStrictEqual(negativeRateOverflowComparison.reasonCodes, []);
assertNoNonFiniteNumbers(negativeRateOverflowComparison);

// 原始绝对差自身溢出时，绝对差与变化率均不可安全表达。
const differenceOverflowComparison = calculatePeriodComparison(
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  'year_over_year'
);
assert.strictEqual(differenceOverflowComparison.absoluteDifference, null);
assert.strictEqual(differenceOverflowComparison.changeRate, null);
assert.strictEqual(differenceOverflowComparison.calculable, false);
assert.strictEqual(differenceOverflowComparison.calculationStatus, 'numeric_overflow');
assert.deepStrictEqual(differenceOverflowComparison.reasonCodes, []);
assertNoNonFiniteNumbers(differenceOverflowComparison);

// 两种能源按 fixture 系数折标，原始值×系数得到 kgce，tce 固定除以 1000。
const electricityCoal = convertToStandardCoal({
  month: '2026-07',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 1000
}, fixture.conversionFactors);
assertClose(electricityCoal.kgce, 1000 * 0.1229);
assertClose(electricityCoal.tce, 1000 * 0.1229 / 1000);
assert.strictEqual(electricityCoal.value, electricityCoal.kgce);
const gasCoal = convertToStandardCoal({
  month: '2026-07',
  energyTypeCode: 'natural_gas',
  unit: 'm3',
  value: 100
}, fixture.conversionFactors);
assertClose(gasCoal.kgce, 100 * 1.33);
assertClose(gasCoal.tce, 100 * 1.33 / 1000);

// 系数缺失和同日多版本重叠分别返回批准原因码。
const missingFactorCoal = convertToStandardCoal({
  month: '2026-07',
  energyTypeCode: 'oil',
  unit: 't',
  value: 10
}, fixture.conversionFactors);
assert.strictEqual(missingFactorCoal.value, null);
assert.deepStrictEqual(missingFactorCoal.reasonCodes, ['MISSING_CONVERSION_FACTOR']);
const ambiguousFactorCoal = convertToStandardCoal({
  month: '2026-07',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 1000
}, [fixture.conversionFactors[0], {
  ...fixture.conversionFactors[0],
  id: 'factor-electricity-overlap',
  code: 'electricity-standard-coal-overlap',
  factorValue: 0.2
}]);
assert.strictEqual(ambiguousFactorCoal.value, null);
assert.deepStrictEqual(ambiguousFactorCoal.reasonCodes, ['FACTOR_PERIOD_AMBIGUOUS']);

// 时序记录跨 7 月 1 日换版时按 15/15 分段：15×0.1 + 15×0.2 = 4.5 kgce。
const versionedFactors = [
  {
    ...fixture.conversionFactors[0],
    id: 'factor-electricity-first-half',
    code: 'electricity-first-half',
    factorValue: 0.1,
    effectiveStartDate: '2026-01-01',
    effectiveEndDateExclusive: '2026-07-01'
  },
  {
    ...fixture.conversionFactors[0],
    id: 'factor-electricity-second-half',
    code: 'electricity-second-half',
    factorValue: 0.2,
    effectiveStartDate: '2026-07-01',
    effectiveEndDateExclusive: '2027-01-01'
  }
];
const timeSeriesCoal = convertToStandardCoal({
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 30,
  startUtc: '2026-06-30T15:45:00.000Z',
  endUtc: '2026-06-30T16:15:00.000Z',
  granularityMinutes: 30,
  sourceTimeZone: 'Asia/Shanghai'
}, versionedFactors);
assertClose(timeSeriesCoal.kgce, 15 * 0.1 + 15 * 0.2);
assertClose(timeSeriesCoal.tce, (15 * 0.1 + 15 * 0.2) / 1000);
assert.strictEqual(timeSeriesCoal.applications.length, 2);
assert.deepStrictEqual(timeSeriesCoal.applications.map((item) => item.minutes), [15, 15]);
assert.deepStrictEqual(timeSeriesCoal.reasonCodes, []);

// 月度值横跨同月中两个不重叠版本时无法安全拆分，必须返回版本歧义。
const midMonthFactors = [
  {
    ...fixture.conversionFactors[0],
    id: 'factor-electricity-july-first',
    code: 'electricity-july-first',
    factorValue: 0.1,
    effectiveStartDate: '2026-07-01',
    effectiveEndDateExclusive: '2026-07-15'
  },
  {
    ...fixture.conversionFactors[0],
    id: 'factor-electricity-july-second',
    code: 'electricity-july-second',
    factorValue: 0.2,
    effectiveStartDate: '2026-07-15',
    effectiveEndDateExclusive: '2026-08-01'
  }
];
const monthlyVersionChange = convertToStandardCoal({
  month: '2026-07',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  value: 1000
}, midMonthFactors);
assert.strictEqual(monthlyVersionChange.value, null);
assert.deepStrictEqual(monthlyVersionChange.reasonCodes, ['FACTOR_PERIOD_AMBIGUOUS']);

// 对标上下文与 fixture 的指标、单位、周期、范围和有效期保持一致。
const externalContext = {
  metricCode: 'unit_product_energy',
  unit: 'kgce/t',
  periodType: 'month',
  scope: 'production-unit-a',
  date: '2026-07-15'
};
const manualContext = {
  metricCode: 'energy_recovery_rate',
  unit: '%',
  periodType: 'month',
  scope: 'production-unit-a',
  date: '2026-07-15'
};
const rangeContext = {
  metricCode: 'load_rate',
  unit: '%',
  periodType: 'day',
  scope: 'production-unit-a',
  date: '2026-07-15'
};

// lower_better、higher_better、range 三种方向分别按目标判断达标。
const lowerBenchmark = evaluateBenchmark(110, fixture.benchmarks.externalStandard, externalContext);
assert.strictEqual(lowerBenchmark.comparable, true);
assert.strictEqual(lowerBenchmark.met, true);
assert.strictEqual(lowerBenchmark.absoluteDifference, -10);
assertClose(lowerBenchmark.differenceRatio, -10 / 120);
const higherBenchmark = evaluateBenchmark(90, fixture.benchmarks.manualBenchmark, manualContext);
assert.strictEqual(higherBenchmark.comparable, true);
assert.strictEqual(higherBenchmark.met, true);
assert.strictEqual(higherBenchmark.absoluteDifference, 5);
assertClose(higherBenchmark.differenceRatio, 5 / 85);
const rangeBenchmark = evaluateBenchmark(70, fixture.benchmarks.rangeBenchmark, rangeContext);
assert.strictEqual(rangeBenchmark.comparable, true);
assert.strictEqual(rangeBenchmark.met, true);
assert.strictEqual(rangeBenchmark.absoluteDifference, 0);
assert.strictEqual(rangeBenchmark.differenceRatio, null);

// 目标为 0 时只保留绝对差额，不返回无意义比例。
const zeroTargetBenchmark = evaluateBenchmark(5, {
  ...fixture.benchmarks.externalStandard,
  targetValue: 0
}, externalContext);
assert.strictEqual(zeroTargetBenchmark.comparable, true);
assert.strictEqual(zeroTargetBenchmark.met, false);
assert.strictEqual(zeroTargetBenchmark.absoluteDifference, 5);
assert.strictEqual(zeroTargetBenchmark.differenceRatio, null);

// 单位、有效期和 range 范围不兼容时不判断达标。
[
  evaluateBenchmark(110, fixture.benchmarks.externalStandard, { ...externalContext, unit: 'kWh/t' }),
  evaluateBenchmark(110, fixture.benchmarks.externalStandard, { ...externalContext, date: '2027-01-01' }),
  evaluateBenchmark(70, { ...fixture.benchmarks.rangeBenchmark, lowerBound: 90, upperBound: 80 }, rangeContext)
].forEach((result) => {
  assert.strictEqual(result.value, null);
  assert.strictEqual(result.comparable, false);
  assert.strictEqual(result.met, null);
  assert.deepStrictEqual(result.reasonCodes, ['UNIT_NOT_COMPARABLE']);
});

// 电力节点按 1200 流入-1050 普通流出-50 显式损耗流出-100 储能变化得到 0。
const electricityFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'main-process',
  storageChange: 100,
  edges: [
    {
      fromNodeCode: 'site-boundary',
      toNodeCode: 'main-process',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 1200,
      sourceMapping: { reference: 'electricity-in' }
    },
    {
      fromNodeCode: 'main-process',
      toNodeCode: 'facility-sink',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 1050,
      sourceMapping: { reference: 'electricity-useful-out' }
    },
    {
      fromNodeCode: 'main-process',
      toNodeCode: 'known-loss',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 50,
      sourceMapping: { reference: 'electricity-known-loss-out' }
    }
  ]
});
assert.strictEqual(electricityFlow.energyTypeCode, 'electricity');
assert.strictEqual(electricityFlow.unit, 'kWh');
assert.strictEqual(electricityFlow.inflow, 1200);
assert.strictEqual(electricityFlow.outflow, 1100);
assert.strictEqual(electricityFlow.storageChange, 100);
assert.strictEqual(electricityFlow.difference, 0);
assert.strictEqual(electricityFlow.value, 0);
assert.strictEqual(electricityFlow.autoClassifiedLoss, false);

// 天然气 1000 m3 流入减 800 m3 流出保留 200 m3 差额，不自动变成损耗。
const gasFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'gas-process',
  storageChange: 0,
  edges: [
    {
      fromNodeCode: 'gas-source',
      toNodeCode: 'gas-process',
      energyTypeCode: 'natural_gas',
      unit: 'm3',
      value: 1000,
      sourceMapping: { reference: 'gas-in' }
    },
    {
      fromNodeCode: 'gas-process',
      toNodeCode: 'gas-useful',
      energyTypeCode: 'natural_gas',
      unit: 'm3',
      value: 800,
      sourceMapping: { reference: 'gas-out' }
    }
  ]
});
assert.strictEqual(gasFlow.energyTypeCode, 'natural_gas');
assert.strictEqual(gasFlow.unit, 'm3');
assert.strictEqual(gasFlow.difference, 200);
assert.strictEqual(gasFlow.value, 200);
assert.strictEqual(gasFlow.autoClassifiedLoss, false);

// 任一节点关联边缺少来源映射时不计算差额。
const unmappedFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'main-process',
  edges: [{
    fromNodeCode: 'source',
    toNodeCode: 'main-process',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 100,
    sourceMapping: null
  }]
});
assert.strictEqual(unmappedFlow.value, null);
assert.deepStrictEqual(unmappedFlow.reasonCodes, ['TOPOLOGY_SOURCE_UNMAPPED']);

// 能流入口混入不同能源或不同单位时必须拒绝跨分面差额。
const mixedEnergyFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'mixed-process',
  edges: [
    {
      fromNodeCode: 'electricity-source',
      toNodeCode: 'mixed-process',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 100,
      sourceMapping: { reference: 'electricity-source' }
    },
    {
      fromNodeCode: 'gas-source',
      toNodeCode: 'mixed-process',
      energyTypeCode: 'natural_gas',
      unit: 'm3',
      value: 20,
      sourceMapping: { reference: 'gas-source' }
    }
  ]
});
assert.strictEqual(mixedEnergyFlow.value, null);
assert.strictEqual(mixedEnergyFlow.energyTypeCode, null);
assert.strictEqual(mixedEnergyFlow.unit, null);
assert.deepStrictEqual(mixedEnergyFlow.reasonCodes, ['UNIT_NOT_COMPARABLE']);
const mixedUnitFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'mixed-unit-process',
  edges: [
    {
      fromNodeCode: 'source-a',
      toNodeCode: 'mixed-unit-process',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 100,
      sourceMapping: { reference: 'source-a' }
    },
    {
      fromNodeCode: 'source-b',
      toNodeCode: 'mixed-unit-process',
      energyTypeCode: 'electricity',
      unit: 'MWh',
      value: 1,
      sourceMapping: { reference: 'source-b' }
    }
  ]
});
assert.strictEqual(mixedUnitFlow.value, null);
assert.deepStrictEqual(mixedUnitFlow.reasonCodes, ['UNIT_NOT_COMPARABLE']);

// 显式但非有限的储能变化不得默认为 0。
const invalidStorageFlow = calculateEnergyFlowNodeDifference({
  nodeCode: 'main-process',
  storageChange: Number.NaN,
  edges: [{
    fromNodeCode: 'source',
    toNodeCode: 'main-process',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    value: 100,
    sourceMapping: { reference: 'source' }
  }]
});
assert.strictEqual(invalidStorageFlow.value, null);
assert.strictEqual(invalidStorageFlow.storageChange, null);
assert.deepStrictEqual(invalidStorageFlow.errors, ['INVALID_STORAGE_CHANGE']);
assert.deepStrictEqual(invalidStorageFlow.reasonCodes, ['BALANCE_ITEM_UNMAPPED']);

// 电力平衡公式：1000+200-100-1000-50-50=0，差额是真实 0。
const electricityBalance = calculateEnergyBalance(
  fixture.balances.electricity.items,
  { generationBoundaryConfirmed: true }
);
assert.strictEqual(electricityBalance.energyTypeCode, 'electricity');
assert.strictEqual(electricityBalance.unit, 'kWh');
assert.strictEqual(electricityBalance.inputTotal, 1200);
assert.strictEqual(electricityBalance.outputTotal, 1200);
assert.strictEqual(electricityBalance.unexplainedDifference, 0);
assert.strictEqual(electricityBalance.value, 0);
assertClose(electricityBalance.utilizationRate, 1000 / 1200);
assertClose(electricityBalance.lossRate, 50 / 1200);
assert.strictEqual(electricityBalance.imbalanceRate, 0);
assert.strictEqual(electricityBalance.autoClassifiedLoss, false);
assert.deepStrictEqual(electricityBalance.reasonCodes, []);

// 天然气平衡保留 200 m3 不可解释差额，不能写入已知损耗。
const naturalGasBalance = calculateEnergyBalance(
  fixture.balances.naturalGas.items,
  { generationBoundaryConfirmed: true }
);
assert.strictEqual(naturalGasBalance.energyTypeCode, 'natural_gas');
assert.strictEqual(naturalGasBalance.unit, 'm3');
assert.strictEqual(naturalGasBalance.inputTotal, 1000);
assert.strictEqual(naturalGasBalance.outputTotal, 800);
assert.strictEqual(naturalGasBalance.unexplainedDifference, 200);
assert.strictEqual(naturalGasBalance.value, 200);
assert.strictEqual(naturalGasBalance.autoClassifiedLoss, false);
assertClose(naturalGasBalance.utilizationRate, 650 / 1000);
assertClose(naturalGasBalance.lossRate, 50 / 1000);
assertClose(naturalGasBalance.imbalanceRate, 200 / 1000);

// 平衡入口混入跨能源或跨单位项目时不得形成有效差额。
const mixedEnergyBalanceItems = cloneBalanceItems(fixture.balances.electricity.items);
mixedEnergyBalanceItems[0].energyTypeCode = 'natural_gas';
mixedEnergyBalanceItems[0].unit = 'm3';
const mixedEnergyBalance = calculateEnergyBalance(mixedEnergyBalanceItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(mixedEnergyBalance.value, null);
assert.strictEqual(mixedEnergyBalance.energyTypeCode, null);
assert.strictEqual(mixedEnergyBalance.unit, null);
assert.deepStrictEqual(mixedEnergyBalance.reasonCodes, ['UNIT_NOT_COMPARABLE']);
const mixedUnitBalanceItems = cloneBalanceItems(fixture.balances.electricity.items);
mixedUnitBalanceItems[0].unit = 'MWh';
const mixedUnitBalance = calculateEnergyBalance(mixedUnitBalanceItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(mixedUnitBalance.value, null);
assert.deepStrictEqual(mixedUnitBalance.reasonCodes, ['UNIT_NOT_COMPARABLE']);

// 全部输入为 0 时差额可保持真实 0，但三个比率不可计算且不能写成 0。
const zeroInputItems = cloneBalanceItems(fixture.balances.naturalGas.items).map((item) => ({
  ...item,
  value: 0
}));
const zeroInputBalance = calculateEnergyBalance(zeroInputItems, { generationBoundaryConfirmed: true });
assert.strictEqual(zeroInputBalance.value, 0);
assert.strictEqual(zeroInputBalance.unexplainedDifference, 0);
assert.strictEqual(zeroInputBalance.utilizationRate, null);
assert.strictEqual(zeroInputBalance.lossRate, null);
assert.strictEqual(zeroInputBalance.imbalanceRate, null);
assert.deepStrictEqual(zeroInputBalance.reasonCodes, ['UNIT_NOT_COMPARABLE']);

// 发电边界未确认或同一来源重复计入时返回重复风险原因，不输出平衡结论。
const unconfirmedGenerationBalance = calculateEnergyBalance(
  fixture.balances.electricity.items,
  { generationBoundaryConfirmed: false }
);
assert.strictEqual(unconfirmedGenerationBalance.value, null);
assert.deepStrictEqual(unconfirmedGenerationBalance.reasonCodes, ['GENERATION_BOUNDARY_UNCONFIRMED']);
const duplicateGenerationItems = cloneBalanceItems(fixture.balances.electricity.items);
duplicateGenerationItems.push({
  ...duplicateGenerationItems.find((item) => item.role === 'self_generation'),
  id: 'duplicate-generation-output',
  role: 'output'
});
const duplicateGenerationBalance = calculateEnergyBalance(
  duplicateGenerationItems,
  { generationBoundaryConfirmed: true }
);
assert.strictEqual(duplicateGenerationBalance.value, null);
assert.deepStrictEqual(duplicateGenerationBalance.reasonCodes, ['GENERATION_BOUNDARY_UNCONFIRMED']);

// duplicateGuardKey 优先于 reference：不同 guard 可区分来源，相同 guard 即使 reference 不同仍判重复。
const distinctGuardGenerationItems = cloneBalanceItems(fixture.balances.electricity.items);
const distinctGuardSelfGeneration = distinctGuardGenerationItems.find((item) => item.role === 'self_generation');
distinctGuardSelfGeneration.duplicateGuardKey = 'generation-self-consumption';
distinctGuardGenerationItems.push({
  ...distinctGuardSelfGeneration,
  sourceMapping: { ...distinctGuardSelfGeneration.sourceMapping },
  id: 'generation-grid-export',
  role: 'output',
  duplicateGuardKey: 'generation-grid-export'
});
const distinctGuardBalance = calculateEnergyBalance(distinctGuardGenerationItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(distinctGuardBalance.reasonCodes.includes('GENERATION_BOUNDARY_UNCONFIRMED'), false);
assert.strictEqual(Number.isFinite(distinctGuardBalance.value), true);
const duplicateGuardGenerationItems = cloneBalanceItems(fixture.balances.electricity.items);
const duplicateGuardSelfGeneration = duplicateGuardGenerationItems.find((item) => item.role === 'self_generation');
duplicateGuardSelfGeneration.duplicateGuardKey = 'generation-duplicate-key';
duplicateGuardGenerationItems.push({
  ...duplicateGuardSelfGeneration,
  sourceMapping: {
    ...duplicateGuardSelfGeneration.sourceMapping,
    reference: 'different-generation-reference'
  },
  id: 'generation-duplicate-guard',
  role: 'output',
  duplicateGuardKey: 'generation-duplicate-key'
});
const duplicateGuardBalance = calculateEnergyBalance(duplicateGuardGenerationItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(duplicateGuardBalance.value, null);
assert.deepStrictEqual(duplicateGuardBalance.reasonCodes, ['GENERATION_BOUNDARY_UNCONFIRMED']);

// generation 来源只允许 self_generation/output 角色，其他角色必须拒绝。
const invalidGenerationRoleItems = cloneBalanceItems(fixture.balances.electricity.items);
invalidGenerationRoleItems[0].sourceMapping = {
  type: 'generation',
  reference: 'generation-invalid-input-role'
};
const invalidGenerationRoleBalance = calculateEnergyBalance(invalidGenerationRoleItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(invalidGenerationRoleBalance.value, null);
assert.deepStrictEqual(invalidGenerationRoleBalance.reasonCodes, ['GENERATION_BOUNDARY_UNCONFIRMED']);

// 平衡来源类型必须属于阶段 1 BALANCE_SOURCE_TYPES 白名单。
const invalidBalanceSourceTypeItems = cloneBalanceItems(fixture.balances.electricity.items);
invalidBalanceSourceTypeItems[0].sourceMapping = {
  type: 'unsupported_source',
  reference: 'unsupported-source-reference'
};
const invalidBalanceSourceTypeResult = calculateEnergyBalance(invalidBalanceSourceTypeItems, {
  generationBoundaryConfirmed: true
});
assert.strictEqual(invalidBalanceSourceTypeResult.value, null);
assert.deepStrictEqual(invalidBalanceSourceTypeResult.reasonCodes, ['BALANCE_ITEM_UNMAPPED']);

// 平衡项目缺少显式来源映射时不输出差额。
const unmappedBalanceItems = cloneBalanceItems(fixture.balances.electricity.items);
unmappedBalanceItems[0].sourceMapping = null;
const unmappedBalance = calculateEnergyBalance(unmappedBalanceItems, { generationBoundaryConfirmed: true });
assert.strictEqual(unmappedBalance.value, null);
assert.deepStrictEqual(unmappedBalance.reasonCodes, ['BALANCE_ITEM_UNMAPPED']);

// 公共纯函数面对 null 或畸形输入必须稳定返回对象，不抛 HTTP、数据库或类型错误。
[
  () => allocateEnergyByUtcOverlap(null, null),
  () => splitTimeOfUseEnergy(null, null),
  () => allocateEnergyToShifts(null, null),
  () => summarizeDeviceStateCoverage(null, null, null),
  () => calculateLoadMetrics(null, null, null),
  () => calculatePeakIntervalEnergy(null, null, null),
  () => evaluateStrategyThreshold(null, null),
  () => calculatePeriodComparison(null, null),
  () => convertToStandardCoal(null, null),
  () => evaluateBenchmark(null, null, null),
  () => calculateEnergyFlowNodeDifference(null),
  () => calculateEnergyBalance(null, null)
].forEach((probe) => {
  let result;
  assert.doesNotThrow(() => {
    result = probe();
  });
  assert.strictEqual(result !== null && typeof result === 'object' && !Array.isArray(result), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'value'), true);
  assertApprovedReasonCodes(result);
});

// 所有异常结果再次统一检查只包含阶段 1 批准原因码。
[
  invalidTargetAllocation,
  morningBoundarySplit,
  peakValleySplit,
  midnightSplit,
  kathmanduSplit,
  newYorkDstSplit,
  dayEveningShift,
  eveningNightShift,
  nightDayShift,
  duplicateShiftCodeResult,
  subMinuteStateSummary,
  missingLoadMetrics,
  lowCoverageMetrics,
  mixedMetrics,
  overlapMetrics,
  mixedEnergyLoad,
  mixedUnitLoad,
  missingBaseComparison,
  missingCurrentComparison,
  zeroBaseComparison,
  zeroCurrentComparison,
  rateOverflowComparison,
  negativeRateOverflowComparison,
  differenceOverflowComparison,
  missingFactorCoal,
  ambiguousFactorCoal,
  monthlyVersionChange,
  unmappedFlow,
  mixedEnergyFlow,
  mixedUnitFlow,
  invalidStorageFlow,
  mixedEnergyBalance,
  mixedUnitBalance,
  zeroInputBalance,
  unconfirmedGenerationBalance,
  duplicateGenerationBalance,
  duplicateGuardBalance,
  invalidGenerationRoleBalance,
  invalidBalanceSourceTypeResult,
  unmappedBalance
].forEach(assertApprovedReasonCodes);

console.log('energy analysis utils tests passed');
