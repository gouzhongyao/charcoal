'use strict';

const assert = require('assert');
const {
  BALANCE_INPUT_ROLES,
  BALANCE_SOURCE_TYPES,
  BENCHMARK_DIRECTIONS,
  BENCHMARK_TYPES,
  CONVERSION_FACTOR_STATUSES,
  DEVICE_STATES,
  ENERGY_ANALYSIS_REASON_CODES,
  ENERGY_ANALYSIS_VERSIONS,
  ENERGY_FLOW_NODE_TYPES,
  ENERGY_FLOW_SOURCE_TYPES,
  MANUAL_HANDLING_STATUSES,
  RULE_MATCH_STATUSES,
  RULE_PRIORITIES,
  RULE_THRESHOLD_OPERATORS,
  SUPPORTED_INTERVAL_MINUTES,
  TIME_INTERVAL_BOUNDARY,
  TIME_OF_USE_PERIOD_TYPES,
  hasForbiddenAutomationRecommendation,
  isIanaTimeZone,
  isStrictCalendarDate,
  isStrictUtcIso,
  validateBalanceItemsContract,
  validateBenchmarkContract,
  validateConversionFactorContract,
  validateEnergyFlowModelContract,
  validateIanaTimeZone,
  validateRuleEvaluationContract,
  validateTimeIntervalContract,
  validateTimeOfUseRuleContract
} = require('../services/energyAnalysisContracts');
const { createEnergyAnalysisAcceptanceFixture } = require('./energyAnalysisAcceptanceFixture');

// 枚举预期值独立硬编码，避免由生产常量反向生成断言。
const EXPECTED_ENUMS = {
  intervalMinutes: [15, 30, 60],
  deviceStates: ['running', 'idle', 'stopped', 'offline', 'unknown'],
  timeOfUseTypes: ['peak', 'flat', 'valley'],
  conversionFactorStatuses: ['active', 'inactive'],
  benchmarkTypes: ['external_standard', 'manual_benchmark', 'internal_history_baseline'],
  benchmarkDirections: ['lower_better', 'higher_better', 'range'],
  nodeTypes: ['source', 'process', 'storage', 'sink', 'loss', 'boundary'],
  sourceTypes: ['timeseries', 'monthly_energy', 'generation', 'explicit_edge_value'],
  balanceSourceTypes: [
    'timeseries',
    'monthly_energy',
    'generation',
    'explicit_edge_value',
    'explicit_balance_value'
  ],
  balanceRoles: [
    'input',
    'self_generation',
    'inventory_decrease',
    'adjustment_increase',
    'output',
    'useful_utilization',
    'known_loss',
    'inventory_increase',
    'adjustment_decrease'
  ],
  ruleMatchStatuses: ['matched', 'not_matched', 'not_evaluable'],
  manualStatuses: ['unconfirmed', 'accepted', 'rejected', 'resolved'],
  rulePriorities: ['low', 'medium', 'high'],
  ruleThresholdOperators: ['gt', 'gte', 'lt', 'lte', 'between']
};

// 七项版本预期对象独立硬编码，防止只校验格式产生自证循环。
const EXPECTED_VERSIONS = {
  contract: 'energy-analysis-contract:v1',
  loadAnalysis: 'load-analysis:v1',
  conversion: 'standard-coal-conversion:v1',
  benchmark: 'energy-benchmark:v1',
  energyFlow: 'energy-flow:v1',
  balance: 'energy-balance:v1',
  strategyRule: 'strategy-rule:v1'
};

// 原因码预期值独立硬编码并精确断言。
const EXPECTED_REASON_CODES = [
  'NO_TIMESERIES_DATA',
  'COVERAGE_BELOW_THRESHOLD',
  'MIXED_INTERVAL_GRANULARITY',
  'SOURCE_OVERLAP_OR_DUPLICATE',
  'UNIT_NOT_COMPARABLE',
  'MISSING_CONVERSION_FACTOR',
  'FACTOR_PERIOD_AMBIGUOUS',
  'MISSING_SHIFT_SCHEDULE',
  'DEVICE_STATE_GAP',
  'MISSING_PRODUCTION_OUTPUT',
  'TOPOLOGY_SOURCE_UNMAPPED',
  'GENERATION_BOUNDARY_UNCONFIRMED',
  'BALANCE_ITEM_UNMAPPED'
];

/**
 * 断言数组被冻结且没有重复值。
 * @param {Array} values 待检查数组。
 */
function assertFrozenUniqueArray(values) {
  assert.strictEqual(Object.isFrozen(values), true);
  assert.strictEqual(new Set(values).size, values.length);
}

/**
 * 将班次配置展开为自然日分钟段。
 * @param {object} shift 班次配置。
 * @returns {Array<{ start: number, end: number }>} 分钟段。
 */
function expandShiftSegments(shift) {
  if (!shift.crossesMidnight) {
    return [{ start: shift.startMinute, end: shift.endMinute }];
  }
  return [
    { start: shift.startMinute, end: 1440 },
    { start: 0, end: shift.endMinute }
  ];
}

/**
 * 根据批准角色公式独立计算不可解释差额。
 * @param {object[]} items 平衡项目。
 * @returns {number} 不可解释差额。
 */
function calculateExpectedUnexplained(items) {
  const values = Object.fromEntries(items.map((item) => [item.role, item.value]));
  const inputTotal = values.input
    + values.self_generation
    + values.inventory_decrease
    + values.adjustment_increase;
  const outputTotal = values.output
    + values.useful_utilization
    + values.known_loss
    + values.inventory_increase
    + values.adjustment_decrease;
  return inputTotal - outputTotal;
}

/**
 * 断言验证器面对输入时不抛异常且返回无效结果。
 * @param {Function} validator 验证器。
 * @param {*} value 测试输入。
 * @returns {object} 验证结果。
 */
function assertStableInvalidResult(validator, value) {
  let result;
  assert.doesNotThrow(() => {
    result = validator(value);
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(Array.isArray(result.errors), true);
  assert.strictEqual(result.errors.length > 0, true);
  return result;
}

// 枚举必须精确匹配批准计划的稳定字面量。
assert.deepStrictEqual(SUPPORTED_INTERVAL_MINUTES, EXPECTED_ENUMS.intervalMinutes);
assert.deepStrictEqual(DEVICE_STATES, EXPECTED_ENUMS.deviceStates);
assert.deepStrictEqual(TIME_OF_USE_PERIOD_TYPES, EXPECTED_ENUMS.timeOfUseTypes);
assert.deepStrictEqual(CONVERSION_FACTOR_STATUSES, EXPECTED_ENUMS.conversionFactorStatuses);
assert.deepStrictEqual(BENCHMARK_TYPES, EXPECTED_ENUMS.benchmarkTypes);
assert.deepStrictEqual(BENCHMARK_DIRECTIONS, EXPECTED_ENUMS.benchmarkDirections);
assert.deepStrictEqual(ENERGY_FLOW_NODE_TYPES, EXPECTED_ENUMS.nodeTypes);
assert.deepStrictEqual(ENERGY_FLOW_SOURCE_TYPES, EXPECTED_ENUMS.sourceTypes);
assert.deepStrictEqual(BALANCE_SOURCE_TYPES, EXPECTED_ENUMS.balanceSourceTypes);
assert.deepStrictEqual(BALANCE_INPUT_ROLES, EXPECTED_ENUMS.balanceRoles);
assert.deepStrictEqual(RULE_MATCH_STATUSES, EXPECTED_ENUMS.ruleMatchStatuses);
assert.deepStrictEqual(MANUAL_HANDLING_STATUSES, EXPECTED_ENUMS.manualStatuses);
assert.deepStrictEqual(RULE_PRIORITIES, EXPECTED_ENUMS.rulePriorities);
assert.deepStrictEqual(RULE_THRESHOLD_OPERATORS, EXPECTED_ENUMS.ruleThresholdOperators);

// 所有枚举必须冻结且不允许重复。
[
  SUPPORTED_INTERVAL_MINUTES,
  DEVICE_STATES,
  TIME_OF_USE_PERIOD_TYPES,
  CONVERSION_FACTOR_STATUSES,
  BENCHMARK_TYPES,
  BENCHMARK_DIRECTIONS,
  ENERGY_FLOW_NODE_TYPES,
  ENERGY_FLOW_SOURCE_TYPES,
  BALANCE_SOURCE_TYPES,
  BALANCE_INPUT_ROLES,
  RULE_MATCH_STATUSES,
  MANUAL_HANDLING_STATUSES,
  RULE_PRIORITIES,
  RULE_THRESHOLD_OPERATORS,
  ENERGY_ANALYSIS_REASON_CODES
].forEach(assertFrozenUniqueArray);

// 设备状态明确包含 offline 和 unknown，且严禁扩展 fault。
assert.strictEqual(DEVICE_STATES.includes('offline'), true);
assert.strictEqual(DEVICE_STATES.includes('unknown'), true);
assert.strictEqual(DEVICE_STATES.includes('fault'), false);

// 原因码和七项版本对象必须精确匹配批准计划。
assert.deepStrictEqual(ENERGY_ANALYSIS_REASON_CODES, EXPECTED_REASON_CODES);
assert.strictEqual(Object.isFrozen(ENERGY_ANALYSIS_VERSIONS), true);
assert.deepStrictEqual(ENERGY_ANALYSIS_VERSIONS, EXPECTED_VERSIONS);
assert.strictEqual(new Set(Object.values(ENERGY_ANALYSIS_VERSIONS)).size, 7);

// 日历日期必须真实存在，闰日有效而伪造日期无效。
assert.strictEqual(isStrictCalendarDate('2024-02-29'), true);
assert.strictEqual(isStrictCalendarDate('2025-02-29'), false);
assert.strictEqual(isStrictCalendarDate('2026-02-30'), false);
assert.strictEqual(isStrictCalendarDate('2026-13-01'), false);
assert.strictEqual(isStrictCalendarDate('2026-7-1'), false);

// 时间边界固定为左闭右开，UTC 和 IANA 时区均严格校验。
assert.strictEqual(TIME_INTERVAL_BOUNDARY, '[startUtc,endUtc)');
assert.strictEqual(isStrictUtcIso('2026-07-14T16:00:00Z'), true);
assert.strictEqual(isStrictUtcIso('2026-07-14T16:00:00.000Z'), true);
assert.strictEqual(isStrictUtcIso('2026-07-15T00:00:00+08:00'), false);
assert.strictEqual(isStrictUtcIso('2026-07-15T00:00:00'), false);
assert.strictEqual(isStrictUtcIso('2026-02-30T00:00:00Z'), false);
assert.strictEqual(isIanaTimeZone('Asia/Shanghai'), true);
assert.strictEqual(isIanaTimeZone('Asia/Kathmandu'), true);
assert.strictEqual(isIanaTimeZone('Etc/UTC'), true);
assert.strictEqual(isIanaTimeZone('+08:00'), false);
assert.strictEqual(isIanaTimeZone('Mars/Olympus_Mons'), false);
assert.deepStrictEqual(validateIanaTimeZone('+08:00'), { status: 'invalid' });
assert.deepStrictEqual(validateIanaTimeZone('Mars/Olympus_Mons'), { status: 'invalid' });

// 冷缓存构造故障和 format 故障不得缓存，运行时恢复后同一时区必须重新验证成功。
const nativeDateTimeFormat = Intl.DateTimeFormat;
function FailingColdCacheDateTimeFormat(...args) {
  if (args[1] && args[1].timeZone === 'Pacific/Chatham') {
    throw new Error('controlled cold-cache constructor failure');
  }
  if (args[1] && args[1].timeZone === 'Pacific/Auckland') {
    return {
      format() {
        throw new Error('controlled cold-cache format failure');
      }
    };
  }
  return new nativeDateTimeFormat(...args);
}
FailingColdCacheDateTimeFormat.prototype = nativeDateTimeFormat.prototype;
FailingColdCacheDateTimeFormat.supportedLocalesOf = nativeDateTimeFormat.supportedLocalesOf.bind(
  nativeDateTimeFormat
);
try {
  Intl.DateTimeFormat = FailingColdCacheDateTimeFormat;
  assert.deepStrictEqual(
    validateIanaTimeZone('Pacific/Chatham'),
    { status: 'validation_failed' }
  );
  assert.deepStrictEqual(
    validateIanaTimeZone('Pacific/Auckland'),
    { status: 'validation_failed' }
  );
} finally {
  Intl.DateTimeFormat = nativeDateTimeFormat;
}
assert.deepStrictEqual(validateIanaTimeZone('Pacific/Chatham'), { status: 'valid' });
assert.deepStrictEqual(validateIanaTimeZone('Pacific/Auckland'), { status: 'valid' });
assert.strictEqual(isIanaTimeZone('Pacific/Chatham'), true);
assert.strictEqual(isIanaTimeZone('Pacific/Auckland'), true);

// 同一 IANA 形态时区重复验证必须复用有界缓存，不重复构造 Intl formatter。
const originalDateTimeFormat = Intl.DateTimeFormat;
let dateTimeFormatConstructionCount = 0;
function CountingDateTimeFormat(...args) {
  dateTimeFormatConstructionCount += 1;
  return new originalDateTimeFormat(...args);
}
CountingDateTimeFormat.prototype = originalDateTimeFormat.prototype;
CountingDateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf.bind(
  originalDateTimeFormat
);
try {
  Intl.DateTimeFormat = CountingDateTimeFormat;
  const boundedCacheProbeZones = Array.from(
    { length: 129 },
    (_unused, index) => `Mars/Bounded_Cache_${index}`
  );
  boundedCacheProbeZones.forEach((sourceTimeZone) => {
    assert.deepStrictEqual(validateIanaTimeZone(sourceTimeZone), { status: 'invalid' });
  });
  assert.strictEqual(dateTimeFormatConstructionCount, 129);
  assert.deepStrictEqual(
    validateIanaTimeZone(boundedCacheProbeZones[128]),
    { status: 'invalid' }
  );
  assert.strictEqual(dateTimeFormatConstructionCount, 129);
  assert.deepStrictEqual(
    validateIanaTimeZone(boundedCacheProbeZones[0]),
    { status: 'invalid' }
  );
  assert.strictEqual(dateTimeFormatConstructionCount, 130);
} finally {
  Intl.DateTimeFormat = originalDateTimeFormat;
}

// 单条时序记录按持续时间验证 15/30/60 分钟，不锚定 UTC epoch 粒度整点。
[
  { startUtc: '2026-07-14T16:05:00.000Z', endUtc: '2026-07-14T16:20:00.000Z', granularityMinutes: 15 },
  { startUtc: '2026-07-14T16:05:00.000Z', endUtc: '2026-07-14T16:35:00.000Z', granularityMinutes: 30 },
  { startUtc: '2026-07-14T16:05:00.000Z', endUtc: '2026-07-14T17:05:00.000Z', granularityMinutes: 60 }
].forEach((interval) => {
  assert.deepStrictEqual(validateTimeIntervalContract({
    ...interval,
    sourceTimeZone: 'Asia/Shanghai'
  }), { valid: true, errors: [] });
});

// Asia/Kathmandu 的本地整点对应 UTC :15，60 分钟记录必须合法。
assert.deepStrictEqual(validateTimeIntervalContract({
  startUtc: '2026-07-14T18:15:00.000Z',
  endUtc: '2026-07-14T19:15:00.000Z',
  granularityMinutes: 60,
  sourceTimeZone: 'Asia/Kathmandu'
}), { valid: true, errors: [] });

// 非 UTC、非 IANA、不支持粒度、非整分钟和持续时间不符均返回稳定错误对象。
assert.deepStrictEqual(validateTimeIntervalContract({
  startUtc: '2026-07-15T00:00:00+08:00',
  endUtc: '2026-07-15T00:15:00+08:00',
  granularityMinutes: 10,
  sourceTimeZone: '+08:00'
}), {
  valid: false,
  errors: ['INVALID_START_UTC', 'INVALID_END_UTC', 'INVALID_SOURCE_TIME_ZONE', 'UNSUPPORTED_GRANULARITY_MINUTES']
});
assert.strictEqual(validateTimeIntervalContract({
  startUtc: '2026-07-14T16:00:00.000Z',
  endUtc: '2026-07-14T16:00:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}).errors.includes('INVALID_HALF_OPEN_RANGE'), true);
assert.strictEqual(validateTimeIntervalContract({
  startUtc: '2026-07-14T16:00:30.000Z',
  endUtc: '2026-07-14T16:15:30.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}).errors.includes('INTERVAL_BOUNDARY_NOT_WHOLE_MINUTE'), true);
assert.strictEqual(validateTimeIntervalContract({
  startUtc: '2026-07-14T16:05:00.000Z',
  endUtc: '2026-07-14T16:35:00.000Z',
  granularityMinutes: 15,
  sourceTimeZone: 'Asia/Shanghai'
}).errors.includes('INTERVAL_DURATION_MISMATCH'), true);
assertStableInvalidResult(validateTimeIntervalContract, null);

// 每次构造 fixture 都必须返回全新对象，避免测试间共享可变状态。
const fixture = createEnergyAnalysisAcceptanceFixture();
const independentFixture = createEnergyAnalysisAcceptanceFixture();
assert.notStrictEqual(fixture, independentFixture);
assert.notStrictEqual(fixture.timeSeries.electricity, independentFixture.timeSeries.electricity);
fixture.timeSeries.electricity[0].value = 9999;
assert.strictEqual(independentFixture.timeSeries.electricity[0].value, 100);
fixture.timeSeries.electricity[0].value = 100;

// 自然日必须是 Asia/Shanghai 的完整一天并对应严格 UTC 左闭右开边界。
assert.deepStrictEqual(fixture.acceptanceDay, {
  localDate: '2026-07-15',
  sourceTimeZone: 'Asia/Shanghai',
  startUtc: '2026-07-14T16:00:00.000Z',
  endUtc: '2026-07-15T16:00:00.000Z',
  boundary: '[startUtc,endUtc)',
  granularityMinutes: 15
});
assert.strictEqual(Date.parse(fixture.acceptanceDay.endUtc) - Date.parse(fixture.acceptanceDay.startUtc), 24 * 60 * 60 * 1000);

// 两种能源各有 96 条连续、无重叠、粒度一致的 15 分钟记录。
[
  { records: fixture.timeSeries.electricity, energyTypeCode: 'electricity', unit: 'kWh' },
  { records: fixture.timeSeries.naturalGas, energyTypeCode: 'natural_gas', unit: 'm3' }
].forEach(({ records, energyTypeCode, unit }) => {
  assert.strictEqual(records.length, 96);
  assert.strictEqual(records[0].startUtc, fixture.acceptanceDay.startUtc);
  assert.strictEqual(records[95].endUtc, fixture.acceptanceDay.endUtc);
  records.forEach((record, index) => {
    assert.strictEqual(record.energyTypeCode, energyTypeCode);
    assert.strictEqual(record.unit, unit);
    assert.deepStrictEqual(validateTimeIntervalContract(record), { valid: true, errors: [] });
    assert.strictEqual(Date.parse(record.endUtc) - Date.parse(record.startUtc), 15 * 60 * 1000);
    if (index > 0) {
      assert.strictEqual(records[index - 1].endUtc, record.startUtc);
      assert.strictEqual(Date.parse(records[index - 1].endUtc) <= Date.parse(record.startUtc), true);
    }
  });
});

// 两种能源保持原单位分面，不得直接合并求和。
assert.deepStrictEqual(fixture.crossEnergyAggregation.separateFacets, [
  { energyTypeCode: 'electricity', unit: 'kWh' },
  { energyTypeCode: 'natural_gas', unit: 'm3' }
]);
assert.strictEqual(fixture.crossEnergyAggregation.allowed, false);
assert.strictEqual(fixture.crossEnergyAggregation.reasonCode, 'UNIT_NOT_COMPARABLE');
assert.strictEqual(Object.prototype.hasOwnProperty.call(fixture.crossEnergyAggregation, 'combinedTotal'), false);

// 三班次固定为 06-14、14-22、22-06，展开后覆盖 1440 分钟且无重叠。
assert.deepStrictEqual(fixture.shifts.map((shift) => [shift.startLocal, shift.endLocal]), [
  ['06:00', '14:00'],
  ['14:00', '22:00'],
  ['22:00', '06:00']
]);
assert.strictEqual(fixture.shifts[2].crossesMidnight, true);
const shiftCoverage = Array(1440).fill(0);
fixture.shifts.flatMap(expandShiftSegments).forEach((segment) => {
  for (let minute = segment.start; minute < segment.end; minute += 1) {
    shiftCoverage[minute] += 1;
  }
});
assert.strictEqual(shiftCoverage.every((count) => count === 1), true);

// 设备状态按 96 个 15 分钟槽精确检查：指定缺口为 0，其余槽恰好覆盖 1 次。
const deviceStateCoverage = Array(96).fill(0);
const deviceStateLabels = Array(96).fill(null);
const acceptanceStartTime = Date.parse(fixture.acceptanceDay.startUtc);
fixture.deviceStates.records.forEach((record) => {
  assert.strictEqual(DEVICE_STATES.includes(record.status), true);
  assert.strictEqual(isStrictUtcIso(record.startUtc), true);
  assert.strictEqual(isStrictUtcIso(record.endUtc), true);
  const startSlot = (Date.parse(record.startUtc) - acceptanceStartTime) / (15 * 60 * 1000);
  const endSlot = (Date.parse(record.endUtc) - acceptanceStartTime) / (15 * 60 * 1000);
  assert.strictEqual(Number.isInteger(startSlot), true);
  assert.strictEqual(Number.isInteger(endSlot), true);
  assert.strictEqual(startSlot >= 0 && endSlot <= 96 && startSlot < endSlot, true);
  for (let slot = startSlot; slot < endSlot; slot += 1) {
    deviceStateCoverage[slot] += 1;
    deviceStateLabels[slot] = record.status;
  }
});
const expectedGapStartSlot = (Date.parse(fixture.deviceStates.expectedGap.startUtc) - acceptanceStartTime) / (15 * 60 * 1000);
const expectedGapEndSlot = (Date.parse(fixture.deviceStates.expectedGap.endUtc) - acceptanceStartTime) / (15 * 60 * 1000);
deviceStateCoverage.forEach((coverage, slot) => {
  const insideExpectedGap = slot >= expectedGapStartSlot && slot < expectedGapEndSlot;
  assert.strictEqual(coverage, insideExpectedGap ? 0 : 1);
});
assert.strictEqual(deviceStateCoverage.some((coverage) => coverage > 1), false);
assert.strictEqual(deviceStateCoverage.filter((coverage) => coverage === 0).length, 4);
assert.strictEqual(deviceStateLabels.slice(32, 36).every((status) => status === 'unknown'), true);
assert.strictEqual(deviceStateLabels.slice(expectedGapStartSlot, expectedGapEndSlot).every((status) => status === null), true);
assert.deepStrictEqual(fixture.deviceStates.expectedGap, {
  startUtc: '2026-07-15T01:00:00.000Z',
  endUtc: '2026-07-15T02:00:00.000Z',
  semanticStatus: 'unknown',
  materializedAsStateRecord: false,
  reasonCode: 'DEVICE_STATE_GAP',
  mustNotAutoClassifyAs: ['idle', 'stopped']
});
assert.strictEqual(fixture.expectedReasonCodes.includes('DEVICE_STATE_GAP'), true);

// 峰平谷规则包含严格日期、唯一星期和全天连续不重叠时段。
assert.deepStrictEqual(validateTimeOfUseRuleContract(fixture.timeOfUseRule), { valid: true, errors: [] });
assert.deepStrictEqual([...new Set(fixture.timeOfUseRule.periods.map((period) => period.type))].sort(), ['flat', 'peak', 'valley']);
const timeOfUseCoverage = Array(1440).fill(0);
fixture.timeOfUseRule.periods.forEach((period) => {
  for (let minute = period.startMinute; minute < period.endMinute; minute += 1) {
    timeOfUseCoverage[minute] += 1;
  }
});
assert.strictEqual(timeOfUseCoverage.every((count) => count === 1), true);
assert.deepStrictEqual(fixture.timeOfUseRule.crossBoundaryWindow.expectedPeriodTypes, ['valley', 'flat']);
assert.strictEqual(
  fixture.timeOfUseRule.periods.filter((period) => period.startMinute < 375 && period.endMinute > 345).length,
  2
);

// 峰平谷验证器必须先排序，再拒绝非法日期、重复星期、null、跨午夜、重叠和缺口。
assert.deepStrictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: [...fixture.timeOfUseRule.periods].reverse()
}), { valid: true, errors: [] });
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  effectiveStartDate: '2026-02-30'
}).errors.includes('INVALID_EFFECTIVE_DATE'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  daysOfWeek: [1, 1, 2]
}).errors.includes('DUPLICATE_DAY_OF_WEEK'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: null
}).errors.includes('MISSING_TIME_OF_USE_PERIODS'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: [null]
}).errors.includes('INVALID_TIME_OF_USE_PERIOD'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: [{ type: 'valley', startMinute: 1320, endMinute: 360 }]
}).errors.includes('CROSS_MIDNIGHT_TIME_OF_USE_PERIOD_UNSUPPORTED'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: [
    { type: 'valley', startMinute: 0, endMinute: 400 },
    { type: 'flat', startMinute: 360, endMinute: 1440 }
  ]
}).errors.includes('TIME_OF_USE_PERIOD_OVERLAP'), true);
assert.strictEqual(validateTimeOfUseRuleContract({
  ...fixture.timeOfUseRule,
  periods: [
    { type: 'valley', startMinute: 0, endMinute: 300 },
    { type: 'flat', startMinute: 360, endMinute: 1440 }
  ]
}).errors.includes('TIME_OF_USE_PERIOD_GAP'), true);
assertStableInvalidResult(validateTimeOfUseRuleContract, null);

// 折标系数必须具备编码、状态、来源文号、版本、严格有效期和 kgce 目标单位。
assert.strictEqual(fixture.conversionFactors.length, 2);
fixture.conversionFactors.forEach((factor) => {
  assert.deepStrictEqual(validateConversionFactorContract(factor), { valid: true, errors: [] });
  assert.strictEqual(factor.targetUnit, 'kgce');
  assert.strictEqual(factor.displayUnit, 'tce');
  assert.strictEqual(factor.displayDivisor, 1000);
  assert.strictEqual(factor.status, 'active');
  assert.strictEqual(Boolean(factor.code && factor.source && factor.documentNo && factor.version), true);
});
assert.strictEqual(validateConversionFactorContract({
  ...fixture.conversionFactors[0],
  targetUnit: 'tce'
}).errors.includes('INVALID_FACTOR_TARGET_UNIT'), true);
assert.strictEqual(validateConversionFactorContract({
  ...fixture.conversionFactors[0],
  code: '',
  status: 'deleted',
  effectiveEndDateExclusive: '2026-02-30'
}).valid, false);
assertStableInvalidResult(validateConversionFactorContract, null);
assertStableInvalidResult(validateConversionFactorContract, {});

// 三类对标均形成合法定义，range 提供有效上下界，内部历史基准字段已固化。
assert.deepStrictEqual(validateBenchmarkContract(fixture.benchmarks.externalStandard), { valid: true, errors: [] });
assert.deepStrictEqual(validateBenchmarkContract(fixture.benchmarks.manualBenchmark), { valid: true, errors: [] });
assert.deepStrictEqual(validateBenchmarkContract(fixture.benchmarks.rangeBenchmark), { valid: true, errors: [] });
assert.deepStrictEqual(validateBenchmarkContract(fixture.benchmarks.internalFrozenBaseline), { valid: true, errors: [] });
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.rangeBenchmark,
  lowerBound: 90,
  upperBound: 80
}).errors.includes('INVALID_BENCHMARK_RANGE'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.externalStandard,
  documentNo: '',
  effectiveStartDate: '2026-02-30'
}).valid, false);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  frozenAt: null
}).errors.includes('INVALID_INTERNAL_BASELINE_SNAPSHOT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  version: ''
}).errors.includes('INVALID_INTERNAL_BASELINE_VERSION'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  frozen: false
}).errors.includes('INVALID_INTERNAL_BASELINE_SNAPSHOT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  autoRefresh: true
}).errors.includes('INVALID_INTERNAL_BASELINE_SNAPSHOT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  sourceDataDigest: ''
}).errors.includes('INVALID_INTERNAL_BASELINE_SNAPSHOT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  targetValue: 127
}).errors.includes('INVALID_INTERNAL_BASELINE_SNAPSHOT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  sampleMonthCount: 0
}).errors.includes('INVALID_INTERNAL_BASELINE_SAMPLE_COUNT'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  productionSummary: []
}).errors.includes('INVALID_INTERNAL_BASELINE_PRODUCTION_SUMMARY'), true);
assert.strictEqual(validateBenchmarkContract({
  ...fixture.benchmarks.internalFrozenBaseline,
  productionSummary: { outputValue: Number.POSITIVE_INFINITY }
}).errors.includes('INVALID_INTERNAL_BASELINE_PRODUCTION_SUMMARY'), true);
assertStableInvalidResult(validateBenchmarkContract, null);
assertStableInvalidResult(validateBenchmarkContract, {});
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.frozen, true);
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.autoRefresh, false);
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.referencePeriodStart, '2025-01-01');
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.referencePeriodEndExclusive, '2026-01-01');
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.targetValue, 128.4);
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.frozenValue, 128.4);
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.sampleMonthCount, 12);
assert.deepStrictEqual(fixture.benchmarks.internalFrozenBaseline.productionSummary, {
  outputValue: 5800,
  monthCount: 12
});
assert.strictEqual(fixture.benchmarks.internalFrozenBaseline.sourceDataDigest, 'sha256:acceptance-baseline-2025-fixed');

// 显式能流正常模型覆盖六类节点和四类来源，每条边均显式声明映射。
assert.deepStrictEqual(validateEnergyFlowModelContract(fixture.energyFlowModels.normal), { valid: true, errors: [] });
assert.deepStrictEqual(
  [...new Set(fixture.energyFlowModels.normal.nodes.map((node) => node.type))].sort(),
  ['boundary', 'loss', 'process', 'sink', 'source', 'storage']
);
assert.deepStrictEqual(
  [...new Set(fixture.energyFlowModels.normal.edges.map((edge) => edge.sourceType))].sort(),
  ['explicit_edge_value', 'generation', 'monthly_energy', 'timeseries']
);
fixture.energyFlowModels.normal.edges.forEach((edge) => {
  assert.strictEqual(Boolean(edge.code && edge.fromNodeCode && edge.toNodeCode), true);
  assert.strictEqual(Boolean(edge.energyTypeCode && edge.unit && edge.sourceType), true);
  assert.strictEqual(Boolean(edge.sourceMapping && edge.sourceMapping.reference), true);
});
assert.strictEqual(validateEnergyFlowModelContract({
  ...fixture.energyFlowModels.normal,
  edges: [{
    ...fixture.energyFlowModels.normal.edges[0],
    sourceMapping: { reference: '   ' }
  }]
}).errors.includes('TOPOLOGY_SOURCE_UNMAPPED'), true);

// 未映射异常变体必须由正常验证器明确拒绝，且与正常模型相互独立。
const unmappedValidation = validateEnergyFlowModelContract(fixture.energyFlowModels.unmappedVariant);
assert.strictEqual(unmappedValidation.valid, false);
assert.strictEqual(unmappedValidation.errors.includes('TOPOLOGY_SOURCE_UNMAPPED'), true);
assert.deepStrictEqual(fixture.energyFlowModels.unmappedVariant.expectedReasonCodes, ['TOPOLOGY_SOURCE_UNMAPPED']);
assert.notStrictEqual(fixture.energyFlowModels.normal, fixture.energyFlowModels.unmappedVariant);
assert.strictEqual(fixture.energyFlowModels.normal.edges[1].sourceType, 'monthly_energy');
assert.strictEqual(fixture.energyFlowModels.unmappedVariant.edges[1].sourceMapping, null);
assertStableInvalidResult(validateEnergyFlowModelContract, null);
assertStableInvalidResult(validateEnergyFlowModelContract, { modelCode: 'x', version: 'x:v1', nodes: [null], edges: [null] });
assert.strictEqual(validateEnergyFlowModelContract({
  ...fixture.energyFlowModels.normal,
  nodes: [...fixture.energyFlowModels.normal.nodes, { ...fixture.energyFlowModels.normal.nodes[0] }]
}).errors.includes('INVALID_OR_DUPLICATE_NODE_CODE'), true);
assert.strictEqual(validateEnergyFlowModelContract({
  ...fixture.energyFlowModels.normal,
  edges: [{
    ...fixture.energyFlowModels.normal.edges[0],
    toNodeCode: fixture.energyFlowModels.normal.edges[0].fromNodeCode
  }]
}).errors.includes('ENERGY_FLOW_SELF_LOOP_UNSUPPORTED'), true);

// 平衡项目严格使用九类批准角色，null 条目不得导致 TypeError。
assert.strictEqual(BALANCE_INPUT_ROLES.includes('unexplained'), false);
assert.deepStrictEqual(validateBalanceItemsContract(fixture.balances.electricity.items), { valid: true, errors: [] });
assert.deepStrictEqual(validateBalanceItemsContract(fixture.balances.naturalGas.items), { valid: true, errors: [] });
assert.deepStrictEqual(fixture.balances.electricity.items.map((item) => item.role), EXPECTED_ENUMS.balanceRoles);
assert.deepStrictEqual(fixture.balances.naturalGas.items.map((item) => item.role), EXPECTED_ENUMS.balanceRoles);
assertStableInvalidResult(validateBalanceItemsContract, null);
assertStableInvalidResult(validateBalanceItemsContract, [null]);
assert.strictEqual(validateBalanceItemsContract([{
  ...fixture.balances.electricity.items[0],
  sourceMapping: { unexpected: 'value' }
}]).errors.includes('BALANCE_ITEM_UNMAPPED'), true);
assert.strictEqual(validateBalanceItemsContract([{
  ...fixture.balances.electricity.items[0],
  sourceMapping: { type: 'unsupported_source', reference: 'source:1' }
}]).errors.includes('BALANCE_ITEM_UNMAPPED'), true);
assert.strictEqual(validateBalanceItemsContract([{
  ...fixture.balances.electricity.items[0],
  sourceMapping: { type: 'timeseries', reference: '', unexpected: 'value' }
}]).errors.includes('BALANCE_ITEM_UNMAPPED'), true);

// 电力差额为零，天然气 200 m3 保持不可解释且不得自动归为损耗、空载或停机。
assert.strictEqual(calculateExpectedUnexplained(fixture.balances.electricity.items), 0);
assert.strictEqual(fixture.balances.electricity.expectedUnexplainedValue, 0);
assert.strictEqual(calculateExpectedUnexplained(fixture.balances.naturalGas.items), 200);
assert.strictEqual(fixture.balances.naturalGas.expectedUnexplainedValue, 200);
assert.strictEqual(fixture.balances.naturalGas.expectedClassification, 'unexplained');
assert.deepStrictEqual(fixture.balances.naturalGas.mustNotAutoClassifyAs, ['known_loss', 'stopped', 'idle']);
assert.strictEqual(fixture.balances.naturalGas.items.find((item) => item.role === 'known_loss').value, 50);

// 月度产量和发电总量、自用量、上网量均存在，发电记录携带稳定防重复标识。
assert.deepStrictEqual(fixture.monthlyProduction, {
  month: '2026-07',
  productionUnitId: 'production-unit-a',
  outputValue: 500,
  outputUnit: 't',
  sourceReference: 'production-record:production-unit-a:2026-07'
});
assert.strictEqual(fixture.generation.totalValue, fixture.generation.selfConsumptionValue + fixture.generation.gridExportValue);
assert.strictEqual(fixture.generation.antiDoubleCountingKey, 'generation-boundary:production-unit-a:2026-07:electricity');
assert.strictEqual(fixture.generation.boundaryConfirmed, true);
assert.deepStrictEqual(fixture.generation.permittedRoles, ['self_generation', 'output']);

// fixture 覆盖匹配和不可评估状态，未匹配状态在独立反例中验证。
assert.deepStrictEqual(fixture.ruleEvaluations.map((item) => item.matchStatus), [
  'matched',
  'matched',
  'not_evaluable'
]);
fixture.ruleEvaluations.forEach((evaluation) => {
  assert.deepStrictEqual(validateRuleEvaluationContract(evaluation), { valid: true, errors: [] });
});
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  matchStatus: 'unknown'
}).errors.includes('INVALID_RULE_MATCH_STATUS'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  reviewStatus: 'pending'
}).errors.includes('INVALID_MANUAL_HANDLING_STATUS'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[2],
  reasonCodes: []
}).errors.includes('MISSING_NOT_EVALUABLE_REASON'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  estimatedSaving: 12
}).errors.includes('ESTIMATED_SAVING_MUST_BE_NULL'), true);
assert.deepStrictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: {
    ...fixture.ruleEvaluations[0].threshold,
    reductionRate: 0.1
  },
  estimatedSaving: 14.8,
  estimatedSavingUnit: 'kWh'
}), { valid: true, errors: [] });

// matchStatus 必须与阈值操作符真实语义一致，between 的 72 落在 65..85 内必须为 matched。
assert.strictEqual(fixture.ruleEvaluations[1].actualValue, 72);
assert.deepStrictEqual(fixture.ruleEvaluations[1].threshold, {
  operator: 'between',
  min: 65,
  max: 85,
  unit: '%'
});
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[1],
  matchStatus: 'not_matched'
}).errors.includes('RULE_MATCH_STATUS_THRESHOLD_MISMATCH'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  matchStatus: 'not_matched'
}).errors.includes('RULE_MATCH_STATUS_THRESHOLD_MISMATCH'), true);
[
  { threshold: { operator: 'gte', value: 148, unit: 'kWh/15min' }, matchStatus: 'matched' },
  { threshold: { operator: 'lt', value: 149, unit: 'kWh/15min' }, matchStatus: 'matched' },
  { threshold: { operator: 'lte', value: 148, unit: 'kWh/15min' }, matchStatus: 'matched' },
  { threshold: { operator: 'gt', value: 148, unit: 'kWh/15min' }, matchStatus: 'not_matched' }
].forEach(({ threshold, matchStatus }) => {
  assert.deepStrictEqual(validateRuleEvaluationContract({
    ...fixture.ruleEvaluations[0],
    threshold,
    matchStatus
  }), { valid: true, errors: [] });
});
const validNotMatchedEvaluation = {
  ...fixture.ruleEvaluations[0],
  matchStatus: 'not_matched',
  threshold: { operator: 'gt', value: 200, unit: 'kWh/15min' },
  estimatedSaving: null,
  estimatedSavingUnit: null
};
assert.deepStrictEqual(validateRuleEvaluationContract(validNotMatchedEvaluation), { valid: true, errors: [] });

// estimatedSaving 非空仅允许 matched + 全覆盖 + 合法节能率，并必须携带单位。
assert.strictEqual(validateRuleEvaluationContract({
  ...validNotMatchedEvaluation,
  threshold: { ...validNotMatchedEvaluation.threshold, reductionRate: 0.1 },
  estimatedSaving: 10,
  estimatedSavingUnit: 'kWh'
}).errors.includes('ESTIMATED_SAVING_MUST_BE_NULL'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { ...fixture.ruleEvaluations[0].threshold, reductionRate: 0.1 },
  coverageRate: 0.99,
  estimatedSaving: 10,
  estimatedSavingUnit: 'kWh'
}).errors.includes('ESTIMATED_SAVING_MUST_BE_NULL'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { ...fixture.ruleEvaluations[0].threshold, reductionRate: 0.1 },
  estimatedSaving: 10,
  estimatedSavingUnit: null
}).errors.includes('MISSING_ESTIMATED_SAVING_UNIT'), true);

// matched/not_matched 必须有真实证据和数据范围；not_evaluable 可安全保留空证据与空范围。
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  evidence: []
}).errors.includes('INCOMPLETE_RULE_EVIDENCE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  dataRange: null
}).errors.includes('INVALID_RULE_DATA_RANGE'), true);
assert.deepStrictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[2],
  evidence: [],
  dataRange: null
}), { valid: true, errors: [] });

// 自动化边界必须精确保持无 AI、无控制、无状态改变且需要人工复核。
[
  { usesAI: true },
  { issuesControlCommand: true },
  { changesDeviceState: true },
  { requiresManualReview: false }
].forEach((boundaryPatch) => {
  assert.strictEqual(validateRuleEvaluationContract({
    ...fixture.ruleEvaluations[0],
    automationBoundary: {
      ...fixture.ruleEvaluations[0].automationBoundary,
      ...boundaryPatch
    }
  }).errors.includes('INVALID_STRATEGY_AUTOMATION_BOUNDARY'), true);
});
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  changesDeviceState: true
}).errors.includes('INVALID_STRATEGY_AUTOMATION_BOUNDARY'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  automationBoundary: {
    ...fixture.ruleEvaluations[0].automationBoundary,
    unexpected: false
  }
}).errors.includes('INVALID_STRATEGY_AUTOMATION_BOUNDARY'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  usesAI: true
}).errors.includes('INVALID_STRATEGY_AUTOMATION_BOUNDARY'), true);
// 共享自动化规则必须覆盖全部主体、时态和控制动作组合，直接契约校验不得漏判。
const automationControlSubjects = ['AI', '系统', '平台', '程序', '服务'];
const automationControlTenses = ['已', '将', '会'];
const automationControlActions = [
  '下发控制指令',
  '关闭设备',
  '开启设备',
  '执行设备启停',
  '远程控制设备'
];
const forbiddenAutomationRecommendations = [
  'AI已自动执行峰值削减方案。',
  '系统将自动下发控制命令。',
  '平台已改变设备状态。',
  ...automationControlSubjects.flatMap((subject) => automationControlTenses.flatMap((tense) => (
    automationControlActions.map((action) => `${subject}${tense}${action}。`)
  )))
];
forbiddenAutomationRecommendations.forEach((recommendation) => {
  assert.strictEqual(hasForbiddenAutomationRecommendation(recommendation), true, recommendation);
  assert.strictEqual(validateRuleEvaluationContract({
    ...fixture.ruleEvaluations[0],
    recommendation
  }).errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'), true, recommendation);
});

// 人工调整计划和人工维护业务记录不属于实际设备控制，应通过共享规则与正式契约。
[
  '建议人工调整排班计划。',
  '建议人工调整设备启停计划，并在执行前确认。',
  '请人工修改设备状态记录后重新评估。',
  '请人工补齐设备状态记录后重新评估。',
  '请人工修正数据记录后重新评估。',
  '请人工核对台账记录后重新评估。',
  '请人工修正导入记录后重新评估。'
].forEach((recommendation) => {
  assert.strictEqual(hasForbiddenAutomationRecommendation(recommendation), false, recommendation);
  assert.deepStrictEqual(validateRuleEvaluationContract({
    ...fixture.ruleEvaluations[0],
    recommendation
  }), { valid: true, errors: [] }, recommendation);
});

// 人工记录维护与控制承诺混写时，正式契约仍必须拒绝控制部分。
[
  '请人工修改设备状态记录后重新评估，系统将下发控制指令。',
  '请人工核对台账记录，平台会远程控制设备。',
  '系统修改设备状态记录并下发控制。',
  '请人工修改设备状态记录后重新评估，已改变设备状态。'
].forEach((recommendation) => {
  assert.strictEqual(hasForbiddenAutomationRecommendation(recommendation), true, recommendation);
  assert.strictEqual(validateRuleEvaluationContract({
    ...fixture.ruleEvaluations[0],
    recommendation
  }).errors.includes('FORBIDDEN_AUTOMATION_RECOMMENDATION'), true, recommendation);
});
assert.strictEqual(hasForbiddenAutomationRecommendation(null), false);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  recommendation: ''
}).errors.includes('INVALID_RULE_RECOMMENDATION'), true);

assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { unexpected: true }
}).valid, false);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { operator: 'gt', value: Number.NaN, unit: 'kWh' }
}).errors.includes('INVALID_RULE_THRESHOLD_VALUE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { operator: 'between', min: 90, max: 80, unit: '%' }
}).errors.includes('INVALID_RULE_THRESHOLD_RANGE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { operator: 'lte', value: 100, unit: '' }
}).errors.includes('INVALID_RULE_THRESHOLD_UNIT'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { operator: 'lte', value: 100, unit: 'kWh', reductionRate: 0 }
}).errors.includes('INVALID_RULE_REDUCTION_RATE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  threshold: { operator: 'lte', value: 100, unit: 'kWh', reductionRate: 1.1 }
}).errors.includes('INVALID_RULE_REDUCTION_RATE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[2],
  actualValue: 0
}).errors.includes('INVALID_RULE_ACTUAL_VALUE'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[2],
  estimatedSaving: 1
}).errors.includes('ESTIMATED_SAVING_MUST_BE_NULL'), true);
assert.strictEqual(validateRuleEvaluationContract({
  ...fixture.ruleEvaluations[0],
  ruleCode: '',
  formulaVersion: null,
  threshold: null,
  evidence: [],
  coverageRate: 2
}).valid, false);
assertStableInvalidResult(validateRuleEvaluationContract, null);
assertStableInvalidResult(validateRuleEvaluationContract, {});

console.log('energy analysis contract tests passed');
