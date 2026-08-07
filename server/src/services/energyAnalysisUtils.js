'use strict';

const {
  BALANCE_INPUT_ROLES,
  BALANCE_SOURCE_TYPES,
  BENCHMARK_DIRECTIONS,
  DEVICE_STATES,
  ENERGY_ANALYSIS_REASON_CODES,
  ENERGY_ANALYSIS_VERSIONS,
  RULE_PRIORITIES,
  RULE_THRESHOLD_OPERATORS,
  SUPPORTED_INTERVAL_MINUTES,
  TIME_OF_USE_PERIOD_TYPES,
  hasForbiddenAutomationRecommendation,
  isIanaTimeZone,
  isStrictCalendarDate,
  isStrictUtcIso,
  validateRuleEvaluationContract,
  validateTimeIntervalContract,
  validateTimeOfUseRuleContract
} = require('./energyAnalysisContracts');

// 一分钟对应的毫秒数。
const MINUTE_MS = 60 * 1000;

// 一天包含的分钟数。
const DAY_MINUTES = 24 * 60;

// 数值结果默认保留的小数位数。
const DEFAULT_PRECISION = 12;

// 固定 UTC 负荷曲线允许的输出粒度。
const FIXED_UTC_OUTPUT_INTERVAL_MINUTES = Object.freeze([15, 30, 60]);

// 判定 DST 重复本地时刻时使用的邻近 UTC 探针小时偏移。
const LOCAL_HEATMAP_FOLD_PROBE_HOURS = Object.freeze([-72, -36, -12, 12, 36, 72]);

// 星期英文缩写到 ISO 星期序号的映射。
const ISO_WEEKDAY_BY_SHORT_NAME = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
});

// 平衡公式左侧角色。
const BALANCE_INBOUND_ROLES = Object.freeze([
  'input',
  'self_generation',
  'inventory_decrease',
  'adjustment_increase'
]);

// 平衡公式右侧角色。
const BALANCE_OUTBOUND_ROLES = Object.freeze([
  'output',
  'useful_utilization',
  'known_loss',
  'inventory_increase',
  'adjustment_decrease'
]);

// 已批准原因码集合，仅允许公共纯函数返回冻结契约中的原因码。
const APPROVED_REASON_CODE_SET = new Set(ENERGY_ANALYSIS_REASON_CODES);

// 峰值并列证据的默认返回上限。
const DEFAULT_PEAK_EVIDENCE_LIMIT = 10;

// 峰值并列证据允许的最大返回上限。
const MAX_PEAK_EVIDENCE_LIMIT = 100;

// 策略建议固定为人工复核边界，不使用 AI、不控制设备且不改变设备状态。
const STRATEGY_AUTOMATION_BOUNDARY = Object.freeze({
  usesAI: false,
  issuesControlCommand: false,
  changesDeviceState: false,
  requiresManualReview: true
});

// 策略规则版本必须满足冻结的 name:v1 格式。
const STRATEGY_VERSION_PATTERN = /^[a-z][a-z0-9-]*:v1$/;

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判断值是否为有限非负数。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为有限非负数。
 */
function isFiniteNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

/**
 * 按统一精度处理浮点结果，不把非法值改写为零。
 * @param {*} value 待处理值。
 * @param {number} precision 小数位数。
 * @returns {number|null} 有限数值或 null。
 */
function roundAnalysisValue(value, precision = DEFAULT_PRECISION) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const multiplier = 10 ** precision;
  const adjustedValue = value + Number.EPSILON;
  const scaledValue = adjustedValue * multiplier;
  if (!Number.isFinite(multiplier) || multiplier === 0 || !Number.isFinite(scaledValue)) {
    return value;
  }
  const roundedValue = Math.round(scaledValue) / multiplier;
  return Number.isFinite(roundedValue) ? roundedValue : value;
}

/**
 * 去重并过滤未批准原因码。
 * @param {string[]} reasonCodes 原因码列表。
 * @returns {string[]} 稳定原因码列表。
 */
function normalizeReasonCodes(reasonCodes = []) {
  return [...new Set(reasonCodes.filter((code) => APPROVED_REASON_CODE_SET.has(code)))];
}

/**
 * 安全解析严格 UTC 时间戳。
 * @param {*} value UTC 时间戳。
 * @returns {number|null} 毫秒时间戳或 null。
 */
function parseUtc(value) {
  return isStrictUtcIso(value) && value.slice(0, 4) !== '0000'
    ? Date.parse(value)
    : null;
}

/**
 * 读取时间区间边界。
 * @param {*} interval 时间区间对象。
 * @returns {{ startMs: number, endMs: number }|null} 有效边界。
 */
function resolveIntervalBounds(interval) {
  if (!isPlainObject(interval)) {
    return null;
  }
  const startMs = parseUtc(interval.startUtc);
  const endMs = parseUtc(interval.endUtc);
  if (startMs === null || endMs === null || startMs >= endMs) {
    return null;
  }
  return { startMs, endMs };
}

/**
 * 计算两个 UTC 左闭右开区间的重叠分钟数。
 * @param {*} leftInterval 左侧区间。
 * @param {*} rightInterval 右侧区间。
 * @returns {number} 重叠分钟数，无重叠或输入非法时为 0。
 */
function calculateUtcOverlapMinutes(leftInterval, rightInterval) {
  const leftBounds = resolveIntervalBounds(leftInterval);
  const rightBounds = resolveIntervalBounds(rightInterval);
  if (!leftBounds || !rightBounds) {
    return 0;
  }
  const overlapMs = Math.max(
    0,
    Math.min(leftBounds.endMs, rightBounds.endMs) - Math.max(leftBounds.startMs, rightBounds.startMs)
  );
  return overlapMs / MINUTE_MS;
}

/**
 * 按重叠分钟比例分配区间能量，显式采用区间内均匀分布假设。
 * @param {*} record 含 value 的来源记录。
 * @param {*} targetInterval 目标区间。
 * @returns {object} 稳定分配结果。
 */
function allocateEnergyByUtcOverlap(record, targetInterval) {
  const recordBounds = resolveIntervalBounds(record);
  const targetBounds = resolveIntervalBounds(targetInterval);
  const totalMinutes = recordBounds ? (recordBounds.endMs - recordBounds.startMs) / MINUTE_MS : null;
  const validValue = isPlainObject(record) && isFiniteNonNegativeNumber(record.value);
  if (!targetBounds) {
    return {
      value: null,
      overlapMinutes: null,
      totalMinutes: roundAnalysisValue(totalMinutes),
      assumption: 'uniform_within_interval',
      errors: ['INVALID_TARGET_INTERVAL'],
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }
  const overlapMinutes = calculateUtcOverlapMinutes(record, targetInterval);
  const value = validValue && Number.isFinite(totalMinutes) && totalMinutes > 0
    ? roundAnalysisValue(record.value * overlapMinutes / totalMinutes)
    : null;
  return {
    value,
    overlapMinutes: roundAnalysisValue(overlapMinutes),
    totalMinutes: roundAnalysisValue(totalMinutes),
    assumption: 'uniform_within_interval',
    errors: [],
    reasonCodes: value === null ? ['NO_TIMESERIES_DATA'] : []
  };
}

/**
 * 判断时区是否可用于能源分析，必须与数据库可落库的 IANA 契约一致。
 * @param {*} timeZone 待验证时区。
 * @returns {boolean} 是否为有效 IANA 时区。
 */
function isEnergyAnalysisTimeZone(timeZone) {
  return isIanaTimeZone(timeZone);
}

/**
 * 创建指定 IANA 时区的本地日期格式化器。
 * @param {string} timeZone IANA 时区。
 * @returns {Intl.DateTimeFormat|null} 格式化器。
 */
function createLocalDateTimeFormatter(timeZone) {
  if (!isEnergyAnalysisTimeZone(timeZone)) {
    return null;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
}

/**
 * 将 UTC 时刻转换为来源时区的日期、星期和日内分钟。
 * @param {number} timestampMs UTC 毫秒时间戳。
 * @param {Intl.DateTimeFormat} formatter 本地格式化器。
 * @returns {{ localDate: string, isoWeekday: number, minuteOfDay: number }|null} 本地时间字段。
 */
function getLocalTimeParts(timestampMs, formatter) {
  if (!Number.isFinite(timestampMs) || !formatter) {
    return null;
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const year = Number(parts.year);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const isoWeekday = ISO_WEEKDAY_BY_SHORT_NAME[parts.weekday];
  const commonEra = parts.era === undefined || parts.era === 'AD';
  if (!commonEra
    || !Number.isInteger(year)
    || year < 1
    || year > 9999
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || !isoWeekday) {
    return null;
  }
  return {
    localDate: `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`,
    isoWeekday,
    minuteOfDay: hour * 60 + minute
  };
}

/**
 * 创建固定 UTC 负荷桶的左闭右开区间。
 * @param {*} windowInterval 严格 UTC 查询窗口。
 * @param {*} outputIntervalMinutes 输出粒度分钟数。
 * @returns {object[]} 固定 UTC 桶区间。
 */
function createFixedUtcBucketIntervals(windowInterval, outputIntervalMinutes) {
  const windowBounds = resolveIntervalBounds(windowInterval);
  if (!windowBounds || !FIXED_UTC_OUTPUT_INTERVAL_MINUTES.includes(outputIntervalMinutes)) {
    return [];
  }
  const intervalMs = outputIntervalMinutes * MINUTE_MS;
  if (windowBounds.startMs % intervalMs !== 0
    || windowBounds.endMs % intervalMs !== 0
    || (windowBounds.endMs - windowBounds.startMs) % intervalMs !== 0) {
    return [];
  }
  const bucketCount = (windowBounds.endMs - windowBounds.startMs) / intervalMs;
  return Array.from({ length: bucketCount }, (_unused, bucketIndex) => {
    const bucketStartMs = windowBounds.startMs + bucketIndex * intervalMs;
    return {
      bucketIndex,
      startUtc: new Date(bucketStartMs).toISOString(),
      endUtc: new Date(bucketStartMs + intervalMs).toISOString(),
      durationMinutes: outputIntervalMinutes
    };
  });
}

/**
 * 判断来源记录是否可用于固定 UTC 负荷曲线。
 * @param {*} record 来源记录。
 * @returns {boolean} 是否为有限非负且粒度自洽的记录。
 */
function isValidFixedUtcLoadRecord(record) {
  const bounds = resolveIntervalBounds(record);
  return Boolean(bounds
    && isPlainObject(record)
    && isFiniteNonNegativeNumber(record.value)
    && FIXED_UTC_OUTPUT_INTERVAL_MINUTES.includes(record.granularityMinutes)
    && bounds.endMs - bounds.startMs === record.granularityMinutes * MINUTE_MS
    && isEnergyAnalysisTimeZone(record.sourceTimeZone));
}

/**
 * 将固定桶转换为不可计算输出，完整缺失必须保持 null。
 * @param {object[]} bucketIntervals 固定 UTC 桶区间。
 * @param {string} observationMode 观测模式。
 * @returns {object[]} 不可计算桶列表。
 */
function createUnavailableFixedUtcBuckets(bucketIntervals, observationMode) {
  return bucketIntervals.map((interval) => ({
    ...interval,
    energy: null,
    averageLoad: null,
    coveredMinutes: 0,
    coverageRate: 0,
    coverageStatus: 'missing',
    observationMode,
    allocationAssumption: null,
    sourceRecordCount: 0,
    sourceGranularityMinutes: []
  }));
}

/**
 * 将数值中的负零统一为真实零。
 * @param {number|null} value 待规范值。
 * @returns {number|null} 规范后的数值。
 */
function normalizeAnalysisZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * 按来源区间与固定 UTC 桶的重叠比例构建负荷曲线。
 * @param {*} records 单表计、单能源、单单位和单来源时区记录。
 * @param {*} windowInterval 严格 UTC 查询窗口。
 * @param {*} outputIntervalMinutes 输出粒度分钟数。
 * @returns {object} 固定桶、覆盖质量和能源守恒结果。
 */
function buildFixedUtcLoadBuckets(records, windowInterval, outputIntervalMinutes) {
  const bucketIntervals = createFixedUtcBucketIntervals(windowInterval, outputIntervalMinutes);
  const windowBounds = resolveIntervalBounds(windowInterval);
  const expectedMinutes = windowBounds
    ? (windowBounds.endMs - windowBounds.startMs) / MINUTE_MS
    : null;
  if (!windowBounds || bucketIntervals.length === 0) {
    return {
      value: null,
      buckets: [],
      coverageRate: null,
      coveredMinutes: 0,
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes: [],
      mixedSourceGranularity: false,
      allocationUsed: false,
      observationModes: [],
      numericOverflow: false,
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }

  const recordList = Array.isArray(records) ? records : [];
  const numericOverflow = recordList.some((record) => (
    isPlainObject(record)
    && typeof record.value === 'number'
    && !Number.isFinite(record.value)
  ));
  if (numericOverflow) {
    return {
      value: null,
      buckets: createUnavailableFixedUtcBuckets(bucketIntervals, 'unavailable'),
      coverageRate: null,
      coveredMinutes: null,
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes: [],
      mixedSourceGranularity: false,
      allocationUsed: false,
      observationModes: ['unavailable'],
      numericOverflow: true,
      reasonCodes: []
    };
  }

  const clippedRecords = recordList
    .filter(isValidFixedUtcLoadRecord)
    .map((record) => ({ record, range: clipIntervalToWindow(record, windowBounds) }))
    .filter((item) => item.range)
    .sort((left, right) => (
      left.range.startMs - right.range.startMs
      || left.range.endMs - right.range.endMs
      || String(left.record.id || '').localeCompare(String(right.record.id || ''))
    ));
  const sourceGranularityMinutes = [...new Set(
    clippedRecords.map(({ record }) => record.granularityMinutes)
  )].sort((left, right) => left - right);
  const mixedSourceGranularity = sourceGranularityMinutes.length > 1;

  if (clippedRecords.length === 0) {
    return {
      value: null,
      buckets: createUnavailableFixedUtcBuckets(bucketIntervals, 'missing'),
      coverageRate: 0,
      coveredMinutes: 0,
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes,
      mixedSourceGranularity,
      allocationUsed: false,
      observationModes: ['missing'],
      numericOverflow: false,
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }

  const clippedRanges = clippedRecords.map((item) => item.range);
  const coveredMinutes = calculateMergedMinutes(clippedRanges);
  const coverageRate = roundAnalysisValue(coveredMinutes / expectedMinutes);
  if (hasOverlapOrDuplicate(clippedRanges)) {
    return {
      value: null,
      buckets: createUnavailableFixedUtcBuckets(bucketIntervals, 'unavailable'),
      coverageRate,
      coveredMinutes: roundAnalysisValue(coveredMinutes),
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes,
      mixedSourceGranularity,
      allocationUsed: false,
      observationModes: ['unavailable'],
      numericOverflow: false,
      reasonCodes: ['SOURCE_OVERLAP_OR_DUPLICATE']
    };
  }

  let firstCandidateIndex = 0;
  let rawBucketEnergyTotal = 0;
  let allocationUsed = false;
  let calculationOverflow = false;
  const calculatedBuckets = bucketIntervals.map((interval) => {
    const bucketStartMs = Date.parse(interval.startUtc);
    const bucketEndMs = Date.parse(interval.endUtc);
    while (firstCandidateIndex < clippedRecords.length
      && clippedRecords[firstCandidateIndex].range.endMs <= bucketStartMs) {
      firstCandidateIndex += 1;
    }

    let candidateIndex = firstCandidateIndex;
    let rawEnergy = 0;
    let bucketCoveredMs = 0;
    let bucketAllocationUsed = false;
    const sourceRecords = [];
    while (candidateIndex < clippedRecords.length
      && clippedRecords[candidateIndex].range.startMs < bucketEndMs) {
      const sourceItem = clippedRecords[candidateIndex];
      const sourceBounds = resolveIntervalBounds(sourceItem.record);
      const overlapStartMs = Math.max(sourceItem.range.startMs, bucketStartMs);
      const overlapEndMs = Math.min(sourceItem.range.endMs, bucketEndMs);
      if (overlapStartMs < overlapEndMs) {
        const overlapMs = overlapEndMs - overlapStartMs;
        const sourceDurationMs = sourceBounds.endMs - sourceBounds.startMs;
        const allocatedEnergy = sourceItem.record.value * overlapMs / sourceDurationMs;
        if (!Number.isFinite(allocatedEnergy) || !Number.isFinite(rawEnergy + allocatedEnergy)) {
          calculationOverflow = true;
        } else {
          rawEnergy += allocatedEnergy;
          bucketCoveredMs += overlapMs;
          sourceRecords.push(sourceItem.record);
          if (overlapMs < sourceDurationMs) {
            bucketAllocationUsed = true;
            allocationUsed = true;
          }
        }
      }
      candidateIndex += 1;
    }

    if (!Number.isFinite(rawBucketEnergyTotal + rawEnergy)) {
      calculationOverflow = true;
    } else {
      rawBucketEnergyTotal += rawEnergy;
    }
    const coveredBucketMinutes = bucketCoveredMs / MINUTE_MS;
    const bucketCoverageRate = coveredBucketMinutes / outputIntervalMinutes;
    const exactObservation = sourceRecords.length === 1
      && sourceRecords[0].granularityMinutes === outputIntervalMinutes
      && Date.parse(sourceRecords[0].startUtc) === bucketStartMs
      && Date.parse(sourceRecords[0].endUtc) === bucketEndMs;
    const observationMode = sourceRecords.length === 0
      ? 'missing'
      : bucketAllocationUsed ? 'allocated' : exactObservation ? 'observed' : 'aggregated';
    const averageLoad = coveredBucketMinutes > 0
      ? rawEnergy * 60 / coveredBucketMinutes
      : null;
    if (averageLoad !== null && !Number.isFinite(averageLoad)) {
      calculationOverflow = true;
    }
    return {
      ...interval,
      energy: sourceRecords.length === 0 ? null : roundAnalysisValue(rawEnergy),
      averageLoad: sourceRecords.length === 0 ? null : roundAnalysisValue(averageLoad),
      coveredMinutes: roundAnalysisValue(coveredBucketMinutes),
      coverageRate: roundAnalysisValue(bucketCoverageRate),
      coverageStatus: sourceRecords.length === 0
        ? 'missing'
        : bucketCoverageRate === 1 ? 'complete' : 'partial',
      observationMode,
      allocationAssumption: bucketAllocationUsed ? 'uniform_within_interval' : null,
      sourceRecordCount: sourceRecords.length,
      sourceGranularityMinutes: [...new Set(
        sourceRecords.map((record) => record.granularityMinutes)
      )].sort((left, right) => left - right)
    };
  });

  if (calculationOverflow) {
    return {
      value: null,
      buckets: createUnavailableFixedUtcBuckets(bucketIntervals, 'unavailable'),
      coverageRate: null,
      coveredMinutes: null,
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes,
      mixedSourceGranularity,
      allocationUsed,
      observationModes: ['unavailable'],
      numericOverflow: true,
      reasonCodes: []
    };
  }

  const observedEnergy = roundAnalysisValue(rawBucketEnergyTotal);
  const bucketsWithEnergy = calculatedBuckets.filter((bucket) => bucket.energy !== null);
  const roundedBucketTotal = bucketsWithEnergy.reduce((sum, bucket) => sum + bucket.energy, 0);
  if (!Number.isFinite(observedEnergy) || !Number.isFinite(roundedBucketTotal)) {
    return {
      value: null,
      buckets: createUnavailableFixedUtcBuckets(bucketIntervals, 'unavailable'),
      coverageRate: null,
      coveredMinutes: null,
      expectedMinutes,
      observedEnergy: null,
      roundedBucketTotal: null,
      totalEnergy: null,
      totalEnergyComplete: false,
      conservationDifference: null,
      sourceGranularityMinutes,
      mixedSourceGranularity,
      allocationUsed,
      observationModes: ['unavailable'],
      numericOverflow: true,
      reasonCodes: []
    };
  }
  const reasonCodes = coverageRate < 1 ? ['COVERAGE_BELOW_THRESHOLD'] : [];
  const totalEnergyComplete = coverageRate === 1;
  const observationModes = [...new Set(calculatedBuckets.map((bucket) => bucket.observationMode))];
  return {
    value: totalEnergyComplete ? observedEnergy : null,
    buckets: calculatedBuckets,
    coverageRate,
    coveredMinutes: roundAnalysisValue(coveredMinutes),
    expectedMinutes,
    observedEnergy,
    roundedBucketTotal: normalizeAnalysisZero(roundedBucketTotal),
    totalEnergy: totalEnergyComplete ? observedEnergy : null,
    totalEnergyComplete,
    conservationDifference: normalizeAnalysisZero(observedEnergy - roundedBucketTotal),
    sourceGranularityMinutes,
    mixedSourceGranularity,
    allocationUsed,
    observationModes,
    numericOverflow: false,
    reasonCodes
  };
}

/**
 * 创建带 UTC offset 的本地热力格式化器。
 * @param {string} sourceTimeZone 来源时区。
 * @returns {Intl.DateTimeFormat|null} 本地格式化器。
 */
function createLocalHeatmapFormatter(sourceTimeZone) {
  if (!isEnergyAnalysisTimeZone(sourceTimeZone)) {
    return null;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: sourceTimeZone,
    weekday: 'short',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  });
}

/**
 * 将 Intl 的 GMT offset 文本规范为带符号的时分秒，并保留精确秒数。
 * @param {*} offsetText Intl 返回的 offset 文本。
 * @returns {{ utcOffset: string, utcOffsetMinutes: number, utcOffsetSeconds: number }|null} 规范 UTC offset。
 */
function normalizeIntlUtcOffset(offsetText) {
  if (offsetText === 'GMT' || offsetText === 'UTC') {
    return {
      utcOffset: '+00:00',
      utcOffsetMinutes: 0,
      utcOffsetSeconds: 0
    };
  }
  const match = typeof offsetText === 'string'
    ? /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(offsetText)
    : null;
  if (!match) {
    return null;
  }
  const offsetHours = Number(match[2]);
  const offsetMinutes = Number(match[3] || '00');
  const offsetSeconds = Number(match[4] || '00');
  if (!Number.isInteger(offsetHours)
    || !Number.isInteger(offsetMinutes)
    || !Number.isInteger(offsetSeconds)
    || offsetMinutes > 59
    || offsetSeconds > 59) {
    return null;
  }
  const direction = match[1] === '-' ? -1 : 1;
  const totalOffsetSeconds = direction * (
    offsetHours * 60 * 60 + offsetMinutes * 60 + offsetSeconds
  );
  const normalizedOffset = `${match[1]}${String(offsetHours).padStart(2, '0')}`
    + `:${String(offsetMinutes).padStart(2, '0')}`
    + (offsetSeconds === 0 ? '' : `:${String(offsetSeconds).padStart(2, '0')}`);
  return {
    utcOffset: normalizedOffset,
    utcOffsetMinutes: totalOffsetSeconds / 60,
    utcOffsetSeconds: totalOffsetSeconds
  };
}

/**
 * 读取单个 UTC 时刻的本地热力字段和精确 offset。
 * @param {number} timestampMs UTC 毫秒时间戳。
 * @param {Intl.DateTimeFormat} formatter 本地热力格式化器。
 * @returns {object|null} 本地热力字段。
 */
function getLocalHeatmapParts(timestampMs, formatter) {
  if (!Number.isFinite(timestampMs) || !formatter) {
    return null;
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const normalizedOffset = normalizeIntlUtcOffset(parts.timeZoneName);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second || '00');
  const isoWeekday = ISO_WEEKDAY_BY_SHORT_NAME[parts.weekday];
  const commonEra = parts.era === undefined || parts.era === 'AD';
  if (!normalizedOffset
    || !commonEra
    || !Number.isInteger(year)
    || year < 1
    || year > 9999
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || !Number.isInteger(second)
    || !isoWeekday) {
    return null;
  }
  const localDate = `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isoWeekday,
    minuteOfDay: hour * 60 + minute,
    localDate,
    localTime,
    localSecond: String(second).padStart(2, '0'),
    wallTimeIdentity: `${localDate}T${localTime}:${String(second).padStart(2, '0')}`,
    ...normalizedOffset
  };
}

/**
 * 在候选片段内定位首次 UTC offset 变化的毫秒时刻。
 * @param {number} startMs 候选片段开始毫秒。
 * @param {number} endMs 候选片段结束毫秒。
 * @param {number} initialOffsetSeconds 片段开始处 UTC offset 秒数。
 * @param {Intl.DateTimeFormat} formatter 带精确 offset 的本地格式化器。
 * @returns {number|null} 首次 offset 变化时刻，不变化时为 null。
 */
function findUtcOffsetTransitionMs(startMs, endMs, initialOffsetSeconds, formatter) {
  if (endMs - startMs <= 1) {
    return null;
  }
  const endParts = getLocalHeatmapParts(endMs - 1, formatter);
  if (!endParts || endParts.utcOffsetSeconds === initialOffsetSeconds) {
    return null;
  }
  let lowerBoundMs = startMs;
  let upperBoundMs = endMs - 1;
  while (lowerBoundMs + 1 < upperBoundMs) {
    const midpointMs = lowerBoundMs + Math.floor((upperBoundMs - lowerBoundMs) / 2);
    const midpointParts = getLocalHeatmapParts(midpointMs, formatter);
    if (!midpointParts || midpointParts.utcOffsetSeconds !== initialOffsetSeconds) {
      upperBoundMs = midpointMs;
    } else {
      lowerBoundMs = midpointMs;
    }
  }
  return upperBoundMs;
}

/**
 * 按来源时区本地整分钟边界遍历 UTC 区间，并在 offset 变化时精确拆分。
 * @param {number} startMs UTC 开始毫秒。
 * @param {number} endMs UTC 结束毫秒。
 * @param {Intl.DateTimeFormat} formatter 带精确 offset 的本地格式化器。
 * @param {Function} visitor 本地分钟片段访问函数。
 * @returns {boolean} 是否完成全部本地时间投影。
 */
function visitLocalMinuteSlices(startMs, endMs, formatter, visitor) {
  if (!Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || startMs >= endMs
    || !formatter
    || typeof visitor !== 'function') {
    return false;
  }
  let sliceStartMs = startMs;
  while (sliceStartMs < endMs) {
    const localParts = getLocalHeatmapParts(sliceStartMs, formatter);
    if (!localParts) {
      return false;
    }
    const offsetMs = localParts.utcOffsetSeconds * 1000;
    const localTimestampMs = sliceStartMs + offsetMs;
    const nextLocalMinuteMs = (
      Math.floor(localTimestampMs / MINUTE_MS) + 1
    ) * MINUTE_MS - offsetMs;
    let sliceEndMs = Math.min(endMs, Math.max(sliceStartMs + 1, nextLocalMinuteMs));
    const transitionMs = findUtcOffsetTransitionMs(
      sliceStartMs,
      sliceEndMs,
      localParts.utcOffsetSeconds,
      formatter
    );
    if (transitionMs !== null) {
      sliceEndMs = transitionMs;
    }
    visitor(sliceStartMs, sliceEndMs, localParts);
    sliceStartMs = sliceEndMs;
  }
  return true;
}

/**
 * 分类 UTC 窗口两端的本地投影范围，区分确认越界与 Intl 内部投影故障。
 * @param {*} windowInterval 严格 UTC 左闭右开窗口。
 * @param {*} sourceTimeZone 来源 IANA 时区。
 * @returns {{ status: 'supported'|'unsupported_range'|'projection_failed' }} 投影范围分类。
 */
function isSupportedLocalTimeProjectionRange(windowInterval, sourceTimeZone) {
  const windowBounds = resolveIntervalBounds(windowInterval);
  if (!windowBounds) {
    return { status: 'projection_failed' };
  }
  try {
    const formatter = createLocalHeatmapFormatter(sourceTimeZone);
    if (!formatter) {
      return { status: 'projection_failed' };
    }
    const boundaryTimestamps = [windowBounds.startMs, windowBounds.endMs - 1];
    for (const timestampMs of boundaryTimestamps) {
      const formattedParts = formatter.formatToParts(new Date(timestampMs));
      if (!Array.isArray(formattedParts)) {
        return { status: 'projection_failed' };
      }
      const parts = Object.fromEntries(
        formattedParts
          .filter((part) => part && part.type !== 'literal')
          .map((part) => [part.type, part.value])
      );
      const year = Number(parts.year);
      if (parts.era === 'BC'
        || (Number.isInteger(year) && (year < 1 || year > 9999))) {
        return { status: 'unsupported_range' };
      }
      const month = Number(parts.month);
      const day = Number(parts.day);
      const hour = Number(parts.hour);
      const minute = Number(parts.minute);
      const second = Number(parts.second || '00');
      if (parts.era !== 'AD'
        || !Number.isInteger(year)
        || !Number.isInteger(month)
        || !Number.isInteger(day)
        || !Number.isInteger(hour)
        || !Number.isInteger(minute)
        || !Number.isInteger(second)
        || !normalizeIntlUtcOffset(parts.timeZoneName)) {
        return { status: 'projection_failed' };
      }
    }
    return { status: 'supported' };
  } catch (_projectionError) {
    return { status: 'projection_failed' };
  }
}

/**
 * 将本地墙上时间字段转换为不含时区含义的 UTC epoch，供候选 offset 反推。
 * @param {object} localParts 本地墙上时间字段。
 * @returns {number|null} 本地字段对应的 epoch 毫秒。
 */
function createLocalWallTimeEpoch(localParts) {
  if (!isPlainObject(localParts)) {
    return null;
  }
  const localWallDate = new Date(0);
  localWallDate.setUTCFullYear(localParts.year, localParts.month - 1, localParts.day);
  localWallDate.setUTCHours(localParts.hour, localParts.minute, localParts.second, 0);
  const localWallTimeMs = localWallDate.getTime();
  return Number.isFinite(localWallTimeMs) ? localWallTimeMs : null;
}

/**
 * 基于 UTC 时刻、邻近 offset 与时区转换关系稳定判定重复本地时刻的 fold。
 * @param {number} timestampMs 当前 UTC 毫秒时间戳。
 * @param {object} localParts 当前本地时间字段。
 * @param {Intl.DateTimeFormat} formatter 本地热力格式化器。
 * @returns {number|null} 较早实例为 0，较晚实例为 1，失败为 null。
 */
function resolveStableLocalFold(timestampMs, localParts, formatter) {
  const localWallTimeMs = createLocalWallTimeEpoch(localParts);
  if (localWallTimeMs === null) {
    return null;
  }
  const nearbyOffsetSeconds = new Set([localParts.utcOffsetSeconds]);
  LOCAL_HEATMAP_FOLD_PROBE_HOURS.forEach((probeHours) => {
    const probeParts = getLocalHeatmapParts(timestampMs + probeHours * 60 * MINUTE_MS, formatter);
    if (probeParts) {
      nearbyOffsetSeconds.add(probeParts.utcOffsetSeconds);
    }
  });
  const matchingUtcTimes = [...nearbyOffsetSeconds]
    .map((utcOffsetSeconds) => localWallTimeMs - utcOffsetSeconds * 1000)
    .filter((candidateTimestampMs) => {
      const candidateParts = getLocalHeatmapParts(candidateTimestampMs, formatter);
      return candidateParts && candidateParts.wallTimeIdentity === localParts.wallTimeIdentity;
    })
    .filter((candidateTimestampMs, index, candidates) => candidates.indexOf(candidateTimestampMs) === index)
    .sort((left, right) => left - right);
  const currentOccurrenceIndex = matchingUtcTimes.indexOf(timestampMs);
  if (currentOccurrenceIndex < 0) {
    return null;
  }
  return currentOccurrenceIndex === 0 ? 0 : 1;
}

/**
 * 仅从固定 UTC 桶投影 IANA 本地热力坐标，DST 回拨重复时刻保留稳定 fold。
 * @param {*} buckets 固定 UTC 桶。
 * @param {*} sourceTimeZone 来源时区。
 * @returns {object[]} 按 UTC 桶顺序排列的本地热力单元。
 */
function projectFixedUtcBucketsToLocalHeatmap(buckets, sourceTimeZone) {
  const bucketList = Array.isArray(buckets) ? buckets : [];
  const formatter = createLocalHeatmapFormatter(sourceTimeZone);
  if (!formatter) {
    return [];
  }
  const projectedBuckets = [];
  for (const bucket of bucketList) {
    const bucketStartMs = isPlainObject(bucket) ? parseUtc(bucket.startUtc) : null;
    if (bucketStartMs === null) {
      return [];
    }
    const localParts = getLocalHeatmapParts(bucketStartMs, formatter);
    const fold = localParts
      ? resolveStableLocalFold(bucketStartMs, localParts, formatter)
      : null;
    if (!localParts || fold === null) {
      return [];
    }
    projectedBuckets.push({
      ...bucket,
      sourceTimeZone,
      localDate: localParts.localDate,
      localTime: localParts.localTime,
      localSecond: localParts.localSecond,
      utcOffset: localParts.utcOffset,
      utcOffsetMinutes: localParts.utcOffsetMinutes,
      utcOffsetSeconds: localParts.utcOffsetSeconds,
      fold,
      key: `${localParts.localDate}|${localParts.localTime}|${localParts.utcOffset}|${fold}`
    });
  }
  return projectedBuckets;
}

/**
 * 遍历 UTC 区间内的每个自然分钟。
 * @param {number} startMs 开始毫秒。
 * @param {number} endMs 结束毫秒。
 * @param {Function} visitor 分钟访问函数。
 */
function visitUtcMinutes(startMs, endMs, visitor) {
  for (let minuteStartMs = startMs; minuteStartMs < endMs; minuteStartMs += MINUTE_MS) {
    const minuteEndMs = Math.min(endMs, minuteStartMs + MINUTE_MS);
    visitor(minuteStartMs, (minuteEndMs - minuteStartMs) / MINUTE_MS);
  }
}

/**
 * 按 UTC epoch 对齐的自然分钟遍历区间，边缘不足一分钟时保留真实权重。
 * @param {number} startMs 开始毫秒。
 * @param {number} endMs 结束毫秒。
 * @param {Function} visitor 分钟片段访问函数。
 */
function visitNaturalUtcMinuteSlices(startMs, endMs, visitor) {
  const firstMinuteStartMs = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
  for (let minuteStartMs = firstMinuteStartMs; minuteStartMs < endMs; minuteStartMs += MINUTE_MS) {
    const sliceStartMs = Math.max(startMs, minuteStartMs);
    const sliceEndMs = Math.min(endMs, minuteStartMs + MINUTE_MS);
    if (sliceStartMs < sliceEndMs) {
      visitor(minuteStartMs, sliceStartMs, sliceEndMs);
    }
  }
}

/**
 * 解析多记录能源分面，能源标识可使用 code 或 id，单位优先使用 normalizedUnit。
 * @param {*} records 能源记录列表。
 * @param {*} expectedEnergyScope 调用方明确要求的能源分面。
 * @returns {object} 分面可比性、实际分面和预期分面。
 */
function resolveIntervalEnergyScopes(records, expectedEnergyScope = null) {
  const recordList = Array.isArray(records) ? records : [];
  const normalizeScope = (value) => {
    if (!isPlainObject(value)) {
      return null;
    }
    const energyTypeCode = typeof value.energyTypeCode === 'string'
      && value.energyTypeCode.trim() !== ''
      ? value.energyTypeCode.trim()
      : null;
    const energyTypeId = (Number.isSafeInteger(value.energyTypeId) && value.energyTypeId > 0)
      || (typeof value.energyTypeId === 'string' && /^\d+$/.test(value.energyTypeId.trim()))
      ? String(value.energyTypeId).trim()
      : null;
    const normalizedUnit = typeof value.normalizedUnit === 'string'
      && value.normalizedUnit.trim() !== ''
      ? value.normalizedUnit.trim()
      : typeof value.unit === 'string' && value.unit.trim() !== ''
        ? value.unit.trim()
        : null;
    if ((!energyTypeCode && !energyTypeId) || !normalizedUnit) {
      return null;
    }
    return {
      key: energyTypeCode
        ? JSON.stringify(['code', energyTypeCode, normalizedUnit])
        : JSON.stringify(['id', energyTypeId, normalizedUnit]),
      energyTypeCode,
      energyTypeId,
      normalizedUnit,
      unit: normalizedUnit
    };
  };
  const actualScopeMap = new Map();
  let missingRecordScope = false;
  recordList.forEach((record) => {
    const scope = normalizeScope(record);
    if (!scope) {
      missingRecordScope = true;
      return;
    }
    if (!actualScopeMap.has(scope.key)) {
      actualScopeMap.set(scope.key, scope);
    }
  });
  const actualScopes = [...actualScopeMap.values()];
  const expectedProvided = expectedEnergyScope !== null && expectedEnergyScope !== undefined;
  const normalizedExpectedScope = expectedProvided ? normalizeScope(expectedEnergyScope) : null;
  const matchesExpectedScope = (scope) => {
    if (!normalizedExpectedScope || scope.normalizedUnit !== normalizedExpectedScope.normalizedUnit) {
      return false;
    }
    const codeMatches = normalizedExpectedScope.energyTypeCode && scope.energyTypeCode
      ? normalizedExpectedScope.energyTypeCode === scope.energyTypeCode
      : null;
    const idMatches = normalizedExpectedScope.energyTypeId && scope.energyTypeId
      ? normalizedExpectedScope.energyTypeId === scope.energyTypeId
      : null;
    return codeMatches !== false
      && idMatches !== false
      && (codeMatches === true || idMatches === true);
  };
  const expectedScopeConflict = normalizedExpectedScope
    ? actualScopes.some((scope) => !matchesExpectedScope(scope))
    : expectedProvided;
  const actualScopesComparable = actualScopes.length <= 1
    || (Boolean(normalizedExpectedScope) && actualScopes.every(matchesExpectedScope));
  const comparable = !missingRecordScope
    && actualScopesComparable
    && !expectedScopeConflict;
  const toPublicScope = (scope) => scope ? {
    energyTypeCode: scope.energyTypeCode,
    energyTypeId: scope.energyTypeId,
    normalizedUnit: scope.normalizedUnit,
    unit: scope.unit
  } : null;
  return {
    comparable,
    energyScopes: actualScopes.map(toPublicScope),
    expectedEnergyScope: toPublicScope(normalizedExpectedScope)
  };
}

/**
 * 为多记录区间能源分配准备统一的裁剪、粒度、分面和质量元数据。
 * @param {*} records 15/30/60 分钟时序记录。
 * @param {*} windowInterval 严格 UTC 左闭右开窗口。
 * @param {*} expectedEnergyScope 调用方明确要求的能源分面。
 * @returns {object} 排序后的时序记录和质量摘要。
 */
function prepareIntervalEnergyRecords(records, windowInterval, expectedEnergyScope = null) {
  const windowBounds = resolveIntervalBounds(windowInterval);
  const recordList = Array.isArray(records) ? records : [];
  const numericOverflow = recordList.some((record) => (
    isPlainObject(record)
    && typeof record.value === 'number'
    && !Number.isFinite(record.value)
  ));
  const expectedMinutes = windowBounds
    ? (windowBounds.endMs - windowBounds.startMs) / MINUTE_MS
    : null;
  const candidateItems = [];
  if (windowBounds) {
    recordList.forEach((record) => {
      const intervalValidation = validateTimeIntervalContract(record);
      if (!intervalValidation.valid
        || !SUPPORTED_INTERVAL_MINUTES.includes(record.granularityMinutes)) {
        return;
      }
      const sourceBounds = resolveIntervalBounds(record);
      if (!sourceBounds) {
        return;
      }
      const range = {
        startMs: Math.max(sourceBounds.startMs, windowBounds.startMs),
        endMs: Math.min(sourceBounds.endMs, windowBounds.endMs)
      };
      if (range.startMs < range.endMs) {
        candidateItems.push({ record, sourceBounds, range });
      }
    });
  }
  const scopedRecords = candidateItems.map((item) => item.record);
  const energyScope = resolveIntervalEnergyScopes(scopedRecords, expectedEnergyScope);
  if (!windowBounds || numericOverflow) {
    return {
      windowBounds,
      expectedMinutes,
      items: [],
      sourceGranularityMinutes: [],
      mixedSourceGranularity: false,
      allocationUsed: false,
      allocationAssumption: 'uniform_within_interval',
      coveredMinutes: numericOverflow ? null : 0,
      coverageRate: numericOverflow ? null : 0,
      rawObservedEnergy: null,
      observedEnergy: null,
      energyScopeComparable: energyScope.comparable,
      energyScopes: energyScope.energyScopes,
      expectedEnergyScope: energyScope.expectedEnergyScope,
      numericOverflow,
      sourceOverlap: false,
      reasonCodes: normalizeReasonCodes([
        ...(!windowBounds && !numericOverflow ? ['NO_TIMESERIES_DATA'] : []),
        ...(!energyScope.comparable && scopedRecords.length > 0 ? ['UNIT_NOT_COMPARABLE'] : [])
      ])
    };
  }

  const items = candidateItems
    .filter((item) => isFiniteNonNegativeNumber(item.record.value))
    .sort((left, right) => (
      left.range.startMs - right.range.startMs
      || left.range.endMs - right.range.endMs
      || String(left.record.id || '').localeCompare(String(right.record.id || ''))
    ));
  const sourceGranularityMinutes = [...new Set(
    items.map((item) => item.record.granularityMinutes)
  )].sort((left, right) => left - right);
  const sourceOverlap = hasOverlapOrDuplicate(items.map((item) => item.range));
  const coveredMinutes = calculateMergedMinutes(items.map((item) => item.range));
  let rawObservedEnergy = 0;
  let calculationOverflow = false;
  items.forEach((item) => {
    const allocatedEnergy = item.record.value
      * (item.range.endMs - item.range.startMs)
      / (item.sourceBounds.endMs - item.sourceBounds.startMs);
    if (!Number.isFinite(allocatedEnergy) || !Number.isFinite(rawObservedEnergy + allocatedEnergy)) {
      calculationOverflow = true;
      return;
    }
    rawObservedEnergy += allocatedEnergy;
  });
  const reasonCodes = [];
  if (items.length === 0) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  }
  if (!energyScope.comparable && items.length > 0) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  if (sourceOverlap) {
    reasonCodes.push('SOURCE_OVERLAP_OR_DUPLICATE');
  } else if (items.length > 0 && coveredMinutes < expectedMinutes) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  return {
    windowBounds,
    expectedMinutes,
    items,
    sourceGranularityMinutes,
    mixedSourceGranularity: sourceGranularityMinutes.length > 1,
    allocationUsed: items.some((item) => (
      item.range.startMs !== item.sourceBounds.startMs
      || item.range.endMs !== item.sourceBounds.endMs
    )),
    allocationAssumption: 'uniform_within_interval',
    coveredMinutes: calculationOverflow ? null : roundAnalysisValue(coveredMinutes),
    coverageRate: calculationOverflow ? null : roundAnalysisValue(coveredMinutes / expectedMinutes),
    rawObservedEnergy: calculationOverflow
      || sourceOverlap
      || !energyScope.comparable
      || items.length === 0
      ? null
      : rawObservedEnergy,
    observedEnergy: calculationOverflow
      || sourceOverlap
      || !energyScope.comparable
      || items.length === 0
      ? null
      : roundAnalysisValue(rawObservedEnergy),
    energyScopeComparable: energyScope.comparable,
    energyScopes: energyScope.energyScopes,
    expectedEnergyScope: energyScope.expectedEnergyScope,
    numericOverflow: calculationOverflow,
    sourceOverlap,
    reasonCodes: normalizeReasonCodes(reasonCodes)
  };
}

/**
 * 读取完整单方案 ruleSet 中按 ISO 星期展开的峰平谷时段。
 * @param {*} ruleSet 调用方显式选择的单方案规则集。
 * @returns {Map<number, object[]>} 星期到时段列表的映射。
 */
function collectTimeOfUsePeriodsByDay(ruleSet) {
  const periodsByDay = new Map();
  if (!isPlainObject(ruleSet) || !isPlainObject(ruleSet.periodsByIsoWeekday)) {
    return periodsByDay;
  }
  Object.entries(ruleSet.periodsByIsoWeekday).forEach(([isoWeekday, periods]) => {
    const dayOfWeek = Number(isoWeekday);
    if (Number.isInteger(dayOfWeek)
      && dayOfWeek >= 1
      && dayOfWeek <= 7
      && Array.isArray(periods)) {
      periodsByDay.set(dayOfWeek, periods);
    }
  });
  return periodsByDay;
}

/**
 * 验证查询涉及的每个本地星期均被峰平谷规则全天唯一覆盖。
 * @param {*} rule 峰平谷规则。
 * @param {Set<number>} involvedDays 查询涉及的 ISO 星期集合。
 * @returns {object} 规范时段和质量结果。
 */
function validateExpandedTimeOfUseRule(ruleSet, involvedDays, windowBounds) {
  const schemeIdValid = isPlainObject(ruleSet)
    && ((typeof ruleSet.schemeId === 'string' && ruleSet.schemeId.trim() !== '')
      || (Number.isSafeInteger(ruleSet.schemeId) && ruleSet.schemeId > 0));
  const codeValid = isPlainObject(ruleSet)
    && typeof ruleSet.code === 'string'
    && ruleSet.code.trim() !== '';
  const versionValid = isPlainObject(ruleSet)
    && typeof ruleSet.version === 'string'
    && ruleSet.version.trim() !== '';
  const timeZone = isPlainObject(ruleSet) && isEnergyAnalysisTimeZone(ruleSet.sourceTimeZone)
    ? ruleSet.sourceTimeZone
    : null;
  const effectiveBounds = isPlainObject(ruleSet) ? resolveIntervalBounds({
    startUtc: ruleSet.effectiveStartUtc,
    endUtc: ruleSet.effectiveEndUtc
  }) : null;
  const periodsShapeValid = isPlainObject(ruleSet) && isPlainObject(ruleSet.periodsByIsoWeekday);
  const contractValid = !Array.isArray(ruleSet)
    && schemeIdValid
    && codeValid
    && versionValid
    && Boolean(timeZone)
    && Boolean(effectiveBounds)
    && periodsShapeValid;
  const windowWithinEffectiveRange = Boolean(contractValid && windowBounds
    && windowBounds.startMs >= effectiveBounds.startMs
    && windowBounds.endMs <= effectiveBounds.endMs);
  const periodsByDay = collectTimeOfUsePeriodsByDay(ruleSet);
  let hasGap = false;
  let hasOverlap = false;
  const normalizedPeriodsByDay = new Map();
  const minuteTypesByDay = new Map();
  involvedDays.forEach((dayOfWeek) => {
    const sourcePeriods = periodsByDay.get(dayOfWeek) || [];
    const periods = sourcePeriods
      .filter((period) => (
        isPlainObject(period)
        && TIME_OF_USE_PERIOD_TYPES.includes(period.type)
        && Number.isInteger(period.startMinute)
        && Number.isInteger(period.endMinute)
        && period.startMinute >= 0
        && period.endMinute <= DAY_MINUTES
        && period.startMinute < period.endMinute
      ))
      .map((period) => ({
        type: period.type,
        startMinute: period.startMinute,
        endMinute: period.endMinute
      }))
      .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    if (periods.length !== sourcePeriods.length) {
      hasGap = true;
    }
    let cursorMinute = 0;
    periods.forEach((period) => {
      if (period.startMinute > cursorMinute) {
        hasGap = true;
      }
      if (period.startMinute < cursorMinute) {
        hasOverlap = true;
      }
      cursorMinute = Math.max(cursorMinute, period.endMinute);
    });
    if (periods.length === 0 || cursorMinute < DAY_MINUTES) {
      hasGap = true;
    }
    const minuteTypes = Array(DAY_MINUTES).fill(null);
    periods.forEach((period) => {
      for (let minuteOfDay = period.startMinute; minuteOfDay < period.endMinute; minuteOfDay += 1) {
        if (minuteTypes[minuteOfDay] !== null) {
          hasOverlap = true;
        } else {
          minuteTypes[minuteOfDay] = period.type;
        }
      }
    });
    if (minuteTypes.some((type) => type === null)) {
      hasGap = true;
    }
    normalizedPeriodsByDay.set(dayOfWeek, periods);
    minuteTypesByDay.set(dayOfWeek, minuteTypes);
  });
  const configurationErrors = [
    ...(!contractValid ? ['INVALID_TOU_RULE_SET'] : []),
    ...(contractValid && !windowWithinEffectiveRange
      ? ['TOU_RULE_SET_WINDOW_OUTSIDE_EFFECTIVE_RANGE']
      : [])
  ];
  return {
    valid: contractValid && windowWithinEffectiveRange && !hasGap && !hasOverlap,
    contractValid,
    windowWithinEffectiveRange,
    scheme: contractValid ? {
      schemeId: ruleSet.schemeId,
      code: ruleSet.code.trim()
    } : null,
    version: contractValid ? ruleSet.version.trim() : null,
    effectiveRange: effectiveBounds ? {
      startUtc: ruleSet.effectiveStartUtc,
      endUtc: ruleSet.effectiveEndUtc
    } : null,
    timeZone,
    periodsByDay: normalizedPeriodsByDay,
    minuteTypesByDay,
    hasGap,
    hasOverlap,
    configurationErrors,
    reasonCodes: normalizeReasonCodes([
      ...(hasGap ? ['NO_TIMESERIES_DATA'] : []),
      ...(hasOverlap ? ['SOURCE_OVERLAP_OR_DUPLICATE'] : [])
    ])
  };
}

/**
 * 按本地 ISO 星期和日内分钟定位峰平谷类型。
 * @param {object} localParts 已投影的本地时间字段。
 * @param {Map<number, string[]>} minuteTypesByDay 星期到日内分钟类型的映射。
 * @returns {string|null} 峰平谷类型。
 */
function resolveTimeOfUseType(localParts, minuteTypesByDay) {
  if (!localParts) {
    return null;
  }
  const minuteTypes = minuteTypesByDay.get(localParts.isoWeekday);
  return minuteTypes ? minuteTypes[localParts.minuteOfDay] : null;
}

/**
 * 将多条时序能量按 IANA 本地峰平谷规则分配，按精确 offset 拆分本地分钟与 DST 变化。
 * @param {*} records 15/30/60 分钟时序记录。
 * @param {*} windowInterval 严格 UTC 左闭右开窗口。
 * @param {*} ruleSet 完整单方案峰平谷规则集。
 * @param {*} options 可选预期能源分面。
 * @returns {object} 峰平谷能源、方案追溯、完整性、占比和质量披露。
 */
function allocateTimeOfUseEnergy(records, windowInterval, ruleSet, options = {}) {
  const normalizedOptions = isPlainObject(options) ? options : {};
  const prepared = prepareIntervalEnergyRecords(
    records,
    windowInterval,
    normalizedOptions.expectedEnergyScope
  );
  const involvedDays = new Set();
  const preliminaryFormatter = isPlainObject(ruleSet)
    ? createLocalHeatmapFormatter(ruleSet.sourceTimeZone)
    : null;
  let localProjectionValid = true;
  if (prepared.windowBounds && preliminaryFormatter) {
    localProjectionValid = visitLocalMinuteSlices(
      prepared.windowBounds.startMs,
      prepared.windowBounds.endMs,
      preliminaryFormatter,
      (_sliceStartMs, _sliceEndMs, localParts) => {
        involvedDays.add(localParts.isoWeekday);
      }
    );
  }
  const ruleValidation = validateExpandedTimeOfUseRule(
    ruleSet,
    involvedDays,
    prepared.windowBounds
  );
  const sourceTimeZoneMatches = Boolean(ruleValidation.timeZone)
    && (!isPlainObject(windowInterval)
      || windowInterval.sourceTimeZone === undefined
      || windowInterval.sourceTimeZone === ruleValidation.timeZone)
    && prepared.items.every((item) => item.record.sourceTimeZone === ruleValidation.timeZone);
  const formatter = ruleValidation.valid && sourceTimeZoneMatches
    ? createLocalHeatmapFormatter(ruleValidation.timeZone)
    : null;
  const rawByType = Object.fromEntries(TIME_OF_USE_PERIOD_TYPES.map((type) => [type, 0]));
  const coveredMsByType = Object.fromEntries(TIME_OF_USE_PERIOD_TYPES.map((type) => [type, 0]));
  const expectedMsByType = Object.fromEntries(TIME_OF_USE_PERIOD_TYPES.map((type) => [type, 0]));
  let calculationOverflow = prepared.numericOverflow;
  let allocationUsed = prepared.allocationUsed;

  if (prepared.windowBounds && formatter) {
    localProjectionValid = visitLocalMinuteSlices(
      prepared.windowBounds.startMs,
      prepared.windowBounds.endMs,
      formatter,
      (sliceStartMs, sliceEndMs, localParts) => {
        const type = resolveTimeOfUseType(localParts, ruleValidation.minuteTypesByDay);
        if (type) {
          expectedMsByType[type] += sliceEndMs - sliceStartMs;
        }
      }
    ) && localProjectionValid;
  }

  if (formatter && localProjectionValid) {
    const coveredRanges = mergeUtcRanges(prepared.items.map((item) => item.range));
    coveredRanges.forEach((range) => {
      const rangeProjected = visitLocalMinuteSlices(
        range.startMs,
        range.endMs,
        formatter,
        (sliceStartMs, sliceEndMs, localParts) => {
          const type = resolveTimeOfUseType(localParts, ruleValidation.minuteTypesByDay);
          if (type) {
            coveredMsByType[type] += sliceEndMs - sliceStartMs;
          }
        }
      );
      localProjectionValid = localProjectionValid && rangeProjected;
    });
  }

  if (!prepared.sourceOverlap
    && prepared.energyScopeComparable
    && !calculationOverflow
    && formatter
    && localProjectionValid) {
    prepared.items.forEach((item) => {
      const sourceDurationMs = item.sourceBounds.endMs - item.sourceBounds.startMs;
      const recordTypes = new Set();
      const recordProjected = visitLocalMinuteSlices(
        item.range.startMs,
        item.range.endMs,
        formatter,
        (sliceStartMs, sliceEndMs, localParts) => {
          const type = resolveTimeOfUseType(localParts, ruleValidation.minuteTypesByDay);
          if (!type) {
            return;
          }
          const overlapMs = sliceEndMs - sliceStartMs;
          const allocatedEnergy = item.record.value * overlapMs / sourceDurationMs;
          if (!Number.isFinite(allocatedEnergy)
            || !Number.isFinite(rawByType[type] + allocatedEnergy)) {
            calculationOverflow = true;
            return;
          }
          rawByType[type] += allocatedEnergy;
          recordTypes.add(type);
        }
      );
      localProjectionValid = localProjectionValid && recordProjected;
      if (recordTypes.size > 1) {
        allocationUsed = true;
      }
    });
  }

  const rawAllocatedTotal = TIME_OF_USE_PERIOD_TYPES.reduce(
    (sum, type) => sum + rawByType[type],
    0
  );
  if (!Number.isFinite(rawAllocatedTotal)) {
    calculationOverflow = true;
  }
  const rawObservedTotal = calculationOverflow
    || prepared.sourceOverlap
    || !prepared.energyScopeComparable
    || !ruleValidation.valid
    || !sourceTimeZoneMatches
    || !localProjectionValid
    ? null
    : prepared.rawObservedEnergy;
  const observedTotal = Number.isFinite(rawObservedTotal)
    ? roundAnalysisValue(rawObservedTotal)
    : null;
  const roundedObservedByType = Object.fromEntries(TIME_OF_USE_PERIOD_TYPES.map((type) => {
    if (expectedMsByType[type] === 0) {
      return [type, 0];
    }
    return [type, coveredMsByType[type] === 0 ? null : roundAnalysisValue(rawByType[type])];
  }));
  const shareDenominator = ruleValidation.valid && Number.isFinite(rawObservedTotal)
    ? rawObservedTotal
    : null;
  const periods = TIME_OF_USE_PERIOD_TYPES.map((type) => {
    const expectedMinutes = expectedMsByType[type] / MINUTE_MS;
    const coveredMinutes = coveredMsByType[type] / MINUTE_MS;
    const observed = calculationOverflow
      || prepared.sourceOverlap
      || !prepared.energyScopeComparable
      || !ruleValidation.valid
      || !sourceTimeZoneMatches
      || !localProjectionValid
      ? null
      : roundedObservedByType[type];
    const complete = observed !== null && coveredMsByType[type] === expectedMsByType[type]
      ? observed
      : null;
    return {
      type,
      observed,
      complete,
      roundedToZero: observed === 0 && rawByType[type] > 0,
      share: observed !== null && shareDenominator > 0
        ? roundAnalysisValue(rawByType[type] / shareDenominator)
        : null,
      expectedMinutes: roundAnalysisValue(expectedMinutes),
      coveredMinutes: roundAnalysisValue(coveredMinutes),
      coverageRate: expectedMinutes === 0
        ? 1
        : roundAnalysisValue(coveredMinutes / expectedMinutes)
    };
  });
  const buckets = Object.fromEntries(periods.map((period) => [period.type, { ...period }]));
  const roundedAllocatedTotal = periods.reduce(
    (sum, period) => sum + (period.observed === null ? 0 : period.observed),
    0
  );
  const reasonCodes = normalizeReasonCodes([
    ...prepared.reasonCodes,
    ...ruleValidation.reasonCodes,
    ...(!sourceTimeZoneMatches || !localProjectionValid ? ['NO_TIMESERIES_DATA'] : [])
  ]);
  const complete = ruleValidation.valid
    && sourceTimeZoneMatches
    && localProjectionValid
    && !calculationOverflow
    && !prepared.sourceOverlap
    && prepared.coverageRate === 1
    && Number.isFinite(rawObservedTotal)
    ? observedTotal
    : null;
  return {
    value: complete,
    observed: observedTotal,
    roundedToZero: observedTotal === 0 && rawObservedTotal > 0,
    complete,
    totalEnergy: complete,
    totalEnergyComplete: complete !== null,
    scheme: ruleValidation.scheme,
    version: ruleValidation.version,
    effectiveRange: ruleValidation.effectiveRange,
    adoptedRange: ruleValidation.contractValid && ruleValidation.windowWithinEffectiveRange
      && prepared.windowBounds
      ? {
        startUtc: windowInterval.startUtc,
        endUtc: windowInterval.endUtc
      }
      : null,
    configurationErrors: ruleValidation.configurationErrors,
    periods,
    buckets,
    energyScopeComparable: prepared.energyScopeComparable,
    energyScopes: prepared.energyScopes,
    expectedEnergyScope: prepared.expectedEnergyScope,
    sourceGranularityMinutes: prepared.sourceGranularityMinutes,
    mixedSourceGranularity: prepared.mixedSourceGranularity,
    allocationUsed,
    allocationAssumption: 'uniform_within_interval',
    coveredMinutes: prepared.coveredMinutes,
    expectedMinutes: prepared.expectedMinutes,
    coverageRate: prepared.coverageRate,
    conservationDifference: Number.isFinite(rawObservedTotal)
      && ruleValidation.valid
      && sourceTimeZoneMatches
      && localProjectionValid
      && !calculationOverflow
      ? normalizeAnalysisZero(rawObservedTotal - roundedAllocatedTotal)
      : null,
    numericOverflow: calculationOverflow,
    reasonCodes
  };
}

/**
 * 解析实际排班区间的严格二元分组键，禁止降级到 code 或 schedule id。
 * @param {*} schedule 实际排班区间。
 * @param {number} index 排序前索引。
 * @returns {object} 排班分组描述和身份合法性。
 */
function resolveActualShiftGroup(schedule, index) {
  const rawDefinitionId = isPlainObject(schedule) ? schedule.shiftDefinitionId : null;
  const shiftDefinitionId = Number.isSafeInteger(rawDefinitionId) && rawDefinitionId > 0
    ? rawDefinitionId
    : typeof rawDefinitionId === 'string'
      && /^\d+$/.test(rawDefinitionId.trim())
      && Number.isSafeInteger(Number(rawDefinitionId.trim()))
      && Number(rawDefinitionId.trim()) > 0
      ? Number(rawDefinitionId.trim())
      : null;
  const version = isPlainObject(schedule)
    && typeof schedule.version === 'string'
    && schedule.version.trim() !== ''
    ? schedule.version.trim()
    : null;
  const validIdentity = shiftDefinitionId !== null && version !== null;
  const shiftCode = isPlainObject(schedule)
    && typeof schedule.shiftCode === 'string'
    && schedule.shiftCode.trim() !== ''
    ? schedule.shiftCode.trim()
    : null;
  const shiftNameValue = isPlainObject(schedule) ? (schedule.shiftName ?? schedule.name) : null;
  const shiftName = typeof shiftNameValue === 'string' && shiftNameValue.trim() !== ''
    ? shiftNameValue.trim()
    : null;
  return {
    key: validIdentity
      ? `definition:${shiftDefinitionId}|version:${version}`
      : `invalid:${index}`,
    validIdentity,
    shiftDefinitionId,
    version,
    shiftCode,
    shiftName
  };
}

/**
 * 按稳定顺序累计舍入非负分项，使分项舍入和与舍入总量确定性守恒。
 * @param {number[]} rawValues 非负原始分项值。
 * @returns {{ rawTotal: number|null, roundedTotal: number|null, roundedValues: Array<number|null>, numericOverflow: boolean }} 守恒舍入结果。
 */
function roundNonNegativeAllocationsConservatively(rawValues) {
  const normalizedRawValues = Array.isArray(rawValues) ? rawValues : [];
  let rawTotal = 0;
  let numericOverflow = false;
  normalizedRawValues.forEach((rawValue) => {
    if (!isFiniteNonNegativeNumber(rawValue) || !Number.isFinite(rawTotal + rawValue)) {
      numericOverflow = true;
      return;
    }
    rawTotal += rawValue;
  });
  if (numericOverflow) {
    return {
      rawTotal: null,
      roundedTotal: null,
      roundedValues: normalizedRawValues.map(() => null),
      numericOverflow: true
    };
  }

  const roundedTotal = roundAnalysisValue(rawTotal);
  let rawCumulative = 0;
  let roundedCumulative = 0;
  const roundedValues = normalizedRawValues.map((rawValue, index) => {
    rawCumulative += rawValue;
    const nextRoundedCumulative = index === normalizedRawValues.length - 1
      ? roundedTotal
      : roundAnalysisValue(rawCumulative);
    const roundedValue = normalizeAnalysisZero(roundAnalysisValue(
      nextRoundedCumulative - roundedCumulative
    ));
    roundedCumulative = nextRoundedCumulative;
    return roundedValue;
  });
  return {
    rawTotal,
    roundedTotal,
    roundedValues,
    numericOverflow: false
  };
}

/**
 * 将多条时序能量分配到已物化的实际 UTC 排班区间，不从班次定义递归生成排班。
 * @param {*} records 15/30/60 分钟时序记录。
 * @param {*} windowInterval 严格 UTC 左闭右开窗口。
 * @param {*} schedules 实际 UTC 排班区间。
 * @param {*} options 可选预期能源分面。
 * @returns {object} 已分配、未分配、完整性和质量披露。
 */
function allocateEnergyToActualShifts(records, windowInterval, schedules, options = {}) {
  const normalizedOptions = isPlainObject(options) ? options : {};
  const prepared = prepareIntervalEnergyRecords(
    records,
    windowInterval,
    normalizedOptions.expectedEnergyScope
  );
  const scheduleList = Array.isArray(schedules) ? schedules : [];
  const scheduleItems = prepared.windowBounds
    ? scheduleList.map((schedule, index) => ({
      schedule,
      group: resolveActualShiftGroup(schedule, index),
      range: clipIntervalToWindow(schedule, prepared.windowBounds)
    })).filter((item) => item.range)
      .sort((left, right) => (
        left.range.startMs - right.range.startMs
        || left.range.endMs - right.range.endMs
        || left.group.key.localeCompare(right.group.key)
      ))
    : [];
  const scheduleOverlap = hasOverlapOrDuplicate(scheduleItems.map((item) => item.range));
  const invalidScheduleIdentity = scheduleItems.some((item) => !item.group.validIdentity);
  const scheduledMinutes = calculateMergedMinutes(scheduleItems.map((item) => item.range));
  const missingScheduleMinutes = prepared.expectedMinutes === null
    ? null
    : Math.max(0, prepared.expectedMinutes - scheduledMinutes);
  const groupMap = new Map();
  let scheduleMetadataConflict = false;
  scheduleItems.forEach((item) => {
    if (!groupMap.has(item.group.key)) {
      groupMap.set(item.group.key, {
        ...item.group,
        expectedMs: 0,
        coveredMs: 0,
        rawEnergy: 0
      });
    } else {
      const existingGroup = groupMap.get(item.group.key);
      if (existingGroup.shiftCode !== item.group.shiftCode
        || existingGroup.shiftName !== item.group.shiftName) {
        scheduleMetadataConflict = true;
      }
    }
    groupMap.get(item.group.key).expectedMs += item.range.endMs - item.range.startMs;
  });
  const scheduleConfigurationValid = !invalidScheduleIdentity && !scheduleMetadataConflict;

  let calculationOverflow = prepared.numericOverflow;
  let allocationUsed = prepared.allocationUsed;
  if (!prepared.sourceOverlap
    && prepared.energyScopeComparable
    && !scheduleOverlap
    && scheduleConfigurationValid
    && !calculationOverflow) {
    let firstScheduleIndex = 0;
    prepared.items.forEach((item) => {
      while (firstScheduleIndex < scheduleItems.length
        && scheduleItems[firstScheduleIndex].range.endMs <= item.range.startMs) {
        firstScheduleIndex += 1;
      }
      let candidateIndex = firstScheduleIndex;
      let matchedScheduleCount = 0;
      let matchedScheduleMs = 0;
      while (candidateIndex < scheduleItems.length
        && scheduleItems[candidateIndex].range.startMs < item.range.endMs) {
        const scheduleItem = scheduleItems[candidateIndex];
        const overlapStartMs = Math.max(item.range.startMs, scheduleItem.range.startMs);
        const overlapEndMs = Math.min(item.range.endMs, scheduleItem.range.endMs);
        if (overlapStartMs < overlapEndMs) {
          const overlapMs = overlapEndMs - overlapStartMs;
          const sourceDurationMs = item.sourceBounds.endMs - item.sourceBounds.startMs;
          const allocatedEnergy = item.record.value * overlapMs / sourceDurationMs;
          const group = groupMap.get(scheduleItem.group.key);
          if (!Number.isFinite(allocatedEnergy)
            || !Number.isFinite(group.rawEnergy + allocatedEnergy)) {
            calculationOverflow = true;
          } else {
            group.rawEnergy += allocatedEnergy;
            group.coveredMs += overlapMs;
            matchedScheduleCount += 1;
            matchedScheduleMs += overlapMs;
          }
        }
        candidateIndex += 1;
      }
      if (matchedScheduleCount > 1
        || (matchedScheduleMs > 0 && matchedScheduleMs < item.range.endMs - item.range.startMs)) {
        allocationUsed = true;
      }
    });
  }

  const groups = [...groupMap.values()];
  const allocationCalculable = !calculationOverflow
    && !prepared.sourceOverlap
    && prepared.energyScopeComparable
    && !scheduleOverlap
    && scheduleConfigurationValid;
  const allocationRounding = allocationCalculable
    ? roundNonNegativeAllocationsConservatively(groups.map((group) => group.rawEnergy))
    : {
      rawTotal: null,
      roundedTotal: null,
      roundedValues: groups.map(() => null),
      numericOverflow: false
    };
  calculationOverflow = calculationOverflow || allocationRounding.numericOverflow;
  const rawObservedEnergy = calculationOverflow
    || prepared.sourceOverlap
    || !prepared.energyScopeComparable
    || !scheduleConfigurationValid
    ? null
    : prepared.rawObservedEnergy;
  const observedEnergy = Number.isFinite(rawObservedEnergy)
    ? roundAnalysisValue(rawObservedEnergy)
    : null;
  const rawAssignedEnergy = calculationOverflow || !allocationCalculable
    ? null
    : allocationRounding.rawTotal;
  const assignedEnergy = calculationOverflow || !allocationCalculable || observedEnergy === null
    ? null
    : allocationRounding.roundedTotal;
  const rawUnassignedEnergy = Number.isFinite(rawObservedEnergy) && Number.isFinite(rawAssignedEnergy)
    ? Math.max(0, rawObservedEnergy - rawAssignedEnergy)
    : null;
  const unassignedEnergy = assignedEnergy === null
    ? null
    : normalizeAnalysisZero(roundAnalysisValue(observedEnergy - assignedEnergy));
  const allocations = groups.map((group, index) => {
    const expectedMinutes = group.expectedMs / MINUTE_MS;
    const coveredMinutes = group.coveredMs / MINUTE_MS;
    const rawObserved = allocationCalculable && !calculationOverflow && group.coveredMs > 0
      ? group.rawEnergy
      : null;
    const observed = rawObserved === null ? null : allocationRounding.roundedValues[index];
    const complete = observed !== null && group.coveredMs === group.expectedMs ? observed : null;
    return {
      shiftDefinitionId: group.shiftDefinitionId,
      version: group.version,
      shiftCode: group.shiftCode,
      shiftName: group.shiftName,
      rawObserved,
      observed,
      complete,
      roundedToZero: observed === 0 && rawObserved > 0,
      share: rawObserved !== null && rawAssignedEnergy > 0
        ? roundAnalysisValue(rawObserved / rawAssignedEnergy)
        : null,
      expectedMinutes: roundAnalysisValue(expectedMinutes),
      coveredMinutes: roundAnalysisValue(coveredMinutes),
      coverageRate: expectedMinutes === 0
        ? 1
        : roundAnalysisValue(coveredMinutes / expectedMinutes)
    };
  });
  const reasonCodes = normalizeReasonCodes([
    ...prepared.reasonCodes,
    ...(missingScheduleMinutes > 0 ? ['MISSING_SHIFT_SCHEDULE'] : []),
    ...(scheduleOverlap ? ['SOURCE_OVERLAP_OR_DUPLICATE'] : [])
  ]);
  const configurationErrors = [
    ...(invalidScheduleIdentity ? ['INVALID_SHIFT_SCHEDULE_IDENTITY'] : []),
    ...(scheduleMetadataConflict ? ['SHIFT_SCHEDULE_GROUP_METADATA_CONFLICT'] : [])
  ];
  const complete = !calculationOverflow
    && !prepared.sourceOverlap
    && prepared.energyScopeComparable
    && !scheduleOverlap
    && scheduleConfigurationValid
    && missingScheduleMinutes === 0
    && prepared.coverageRate === 1
    && Number.isFinite(observedEnergy)
    ? observedEnergy
    : null;
  return {
    value: complete,
    observed: observedEnergy,
    complete,
    rawObservedEnergy,
    observedEnergy,
    roundedToZero: observedEnergy === 0 && rawObservedEnergy > 0,
    rawAssignedEnergy,
    assignedEnergy,
    rawUnassignedEnergy,
    unassignedEnergy,
    assignedMinutes: roundAnalysisValue(scheduledMinutes),
    unassignedMinutes: missingScheduleMinutes === null
      ? null
      : roundAnalysisValue(missingScheduleMinutes),
    allocations,
    configurationErrors,
    energyScopeComparable: prepared.energyScopeComparable,
    energyScopes: prepared.energyScopes,
    expectedEnergyScope: prepared.expectedEnergyScope,
    sourceGranularityMinutes: prepared.sourceGranularityMinutes,
    mixedSourceGranularity: prepared.mixedSourceGranularity,
    allocationUsed,
    allocationAssumption: 'uniform_within_interval',
    coveredMinutes: prepared.coveredMinutes,
    expectedMinutes: prepared.expectedMinutes,
    coverageRate: prepared.coverageRate,
    conservationDifference: Number.isFinite(observedEnergy)
      && Number.isFinite(assignedEnergy)
      && Number.isFinite(unassignedEnergy)
      ? normalizeAnalysisZero(roundAnalysisValue(observedEnergy - assignedEnergy - unassignedEnergy))
      : null,
    numericOverflow: calculationOverflow,
    reasonCodes
  };
}

/**
 * 按来源时区、本地星期和日内分钟将记录切分到峰平谷桶。
 * @param {*} record 15/30/60 分钟时序记录。
 * @param {*} rule 峰平谷规则。
 * @returns {object} 峰平谷分桶结果。
 */
function splitTimeOfUseEnergy(record, rule) {
  const emptyBuckets = { peak: 0, flat: 0, valley: 0 };
  const intervalValidation = validateTimeIntervalContract(record);
  const ruleValidation = validateTimeOfUseRuleContract(rule);
  const valueValid = isPlainObject(record) && isFiniteNonNegativeNumber(record.value);
  const sameTimeZone = intervalValidation.valid && ruleValidation.valid
    && record.sourceTimeZone === rule.sourceTimeZone;
  if (!intervalValidation.valid || !ruleValidation.valid || !valueValid || !sameTimeZone) {
    return {
      value: null,
      buckets: emptyBuckets,
      allocatedTotal: null,
      originalTotal: valueValid ? record.value : null,
      conservationDifference: null,
      unallocatedMinutes: null,
      assumption: 'uniform_within_interval',
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }

  const recordBounds = resolveIntervalBounds(record);
  const formatter = createLocalDateTimeFormatter(record.sourceTimeZone);
  const totalMinutes = (recordBounds.endMs - recordBounds.startMs) / MINUTE_MS;
  const energyPerMinute = record.value / totalMinutes;
  const bucketMinutes = { peak: 0, flat: 0, valley: 0 };
  let unallocatedMinutes = 0;

  visitUtcMinutes(recordBounds.startMs, recordBounds.endMs, (minuteStartMs, minuteWeight) => {
    const localParts = getLocalTimeParts(minuteStartMs, formatter);
    const period = localParts
      && localParts.localDate >= rule.effectiveStartDate
      && localParts.localDate < rule.effectiveEndDateExclusive
      && rule.daysOfWeek.includes(localParts.isoWeekday)
      ? rule.periods.find((item) => (
        TIME_OF_USE_PERIOD_TYPES.includes(item.type)
        && localParts.minuteOfDay >= item.startMinute
        && localParts.minuteOfDay < item.endMinute
      ))
      : null;
    if (!period) {
      unallocatedMinutes += minuteWeight;
      return;
    }
    bucketMinutes[period.type] += minuteWeight;
  });

  const buckets = Object.fromEntries(TIME_OF_USE_PERIOD_TYPES.map((type) => [
    type,
    roundAnalysisValue(bucketMinutes[type] * energyPerMinute)
  ]));
  const allocatedTotal = roundAnalysisValue(Object.values(buckets).reduce((sum, value) => sum + value, 0));
  const reasonCodes = unallocatedMinutes > 0 ? ['NO_TIMESERIES_DATA'] : [];
  return {
    value: reasonCodes.length === 0 ? allocatedTotal : null,
    buckets,
    allocatedTotal,
    originalTotal: record.value,
    conservationDifference: roundAnalysisValue(record.value - allocatedTotal),
    bucketMinutes,
    unallocatedMinutes: roundAnalysisValue(unallocatedMinutes),
    assumption: 'uniform_within_interval',
    reasonCodes
  };
}

/**
 * 判断本地日内分钟是否属于班次。
 * @param {number} minuteOfDay 日内分钟。
 * @param {*} shift 班次配置。
 * @returns {boolean} 是否属于班次。
 */
function isMinuteInsideShift(minuteOfDay, shift) {
  if (!isPlainObject(shift)
    || !Number.isInteger(shift.startMinute)
    || !Number.isInteger(shift.endMinute)
    || shift.startMinute < 0
    || shift.startMinute >= DAY_MINUTES
    || shift.endMinute < 0
    || shift.endMinute >= DAY_MINUTES
    || shift.startMinute === shift.endMinute) {
    return false;
  }
  const crossesMidnight = shift.crossesMidnight === true || shift.startMinute > shift.endMinute;
  return crossesMidnight
    ? minuteOfDay >= shift.startMinute || minuteOfDay < shift.endMinute
    : minuteOfDay >= shift.startMinute && minuteOfDay < shift.endMinute;
}

/**
 * 按本地班次重叠分钟分配时序能量，支持 22:00-06:00 跨日班次。
 * @param {*} record 时序记录。
 * @param {*} shifts 班次列表。
 * @returns {object} 班次分配结果。
 */
function allocateEnergyToShifts(record, shifts) {
  const intervalValidation = validateTimeIntervalContract(record);
  const valueValid = isPlainObject(record) && isFiniteNonNegativeNumber(record.value);
  const shiftList = Array.isArray(shifts) ? shifts : [];
  const timeZone = intervalValidation.valid ? record.sourceTimeZone : null;
  const schedulesValid = shiftList.length > 0 && shiftList.every((shift) => (
    isPlainObject(shift)
    && typeof shift.code === 'string'
    && shift.code.trim() !== ''
    && shift.sourceTimeZone === timeZone
    && (isMinuteInsideShift(shift.startMinute, shift)
      || isMinuteInsideShift((shift.startMinute + DAY_MINUTES - 1) % DAY_MINUTES, shift))
  ));
  const shiftCodes = schedulesValid ? shiftList.map((shift) => shift.code) : [];
  const duplicateShiftCodes = new Set(shiftCodes).size !== shiftCodes.length;
  if (!intervalValidation.valid || !valueValid || !schedulesValid || duplicateShiftCodes) {
    return {
      value: null,
      allocations: [],
      allocatedTotal: null,
      originalTotal: valueValid ? record.value : null,
      conservationDifference: null,
      unallocatedMinutes: null,
      overlappingScheduleMinutes: null,
      assumption: 'uniform_within_interval',
      reasonCodes: [duplicateShiftCodes ? 'SOURCE_OVERLAP_OR_DUPLICATE' : 'MISSING_SHIFT_SCHEDULE']
    };
  }

  const recordBounds = resolveIntervalBounds(record);
  const formatter = createLocalDateTimeFormatter(timeZone);
  const totalMinutes = (recordBounds.endMs - recordBounds.startMs) / MINUTE_MS;
  const energyPerMinute = record.value / totalMinutes;
  const minuteTotals = Object.fromEntries(shiftList.map((shift) => [shift.code, 0]));
  let unallocatedMinutes = 0;
  let overlappingScheduleMinutes = 0;

  visitUtcMinutes(recordBounds.startMs, recordBounds.endMs, (minuteStartMs, minuteWeight) => {
    const localParts = getLocalTimeParts(minuteStartMs, formatter);
    const matches = localParts
      ? shiftList.filter((shift) => isMinuteInsideShift(localParts.minuteOfDay, shift))
      : [];
    if (matches.length !== 1) {
      unallocatedMinutes += matches.length === 0 ? minuteWeight : 0;
      overlappingScheduleMinutes += matches.length > 1 ? minuteWeight : 0;
      return;
    }
    minuteTotals[matches[0].code] += minuteWeight;
  });

  const allocations = shiftList.map((shift) => ({
    shiftCode: shift.code,
    shiftName: shift.name || shift.code,
    overlapMinutes: roundAnalysisValue(minuteTotals[shift.code]),
    value: roundAnalysisValue(minuteTotals[shift.code] * energyPerMinute)
  }));
  const allocatedTotal = roundAnalysisValue(allocations.reduce((sum, item) => sum + item.value, 0));
  const reasonCodes = [
    ...(unallocatedMinutes > 0 ? ['MISSING_SHIFT_SCHEDULE'] : []),
    ...(overlappingScheduleMinutes > 0 ? ['SOURCE_OVERLAP_OR_DUPLICATE'] : [])
  ];
  return {
    value: reasonCodes.length === 0 ? allocatedTotal : null,
    allocations,
    allocatedTotal,
    originalTotal: record.value,
    conservationDifference: roundAnalysisValue(record.value - allocatedTotal),
    unallocatedMinutes: roundAnalysisValue(unallocatedMinutes),
    overlappingScheduleMinutes: roundAnalysisValue(overlappingScheduleMinutes),
    assumption: 'uniform_within_interval',
    reasonCodes
  };
}

/**
 * 合并 UTC 左闭右开区间，保留不重复覆盖范围。
 * @param {Array<{ startMs: number, endMs: number }>} ranges 时间范围。
 * @returns {Array<{ startMs: number, endMs: number }>} 合并后的范围。
 */
function mergeUtcRanges(ranges) {
  const sortedRanges = ranges
    .filter((range) => Number.isFinite(range.startMs)
      && Number.isFinite(range.endMs)
      && range.startMs < range.endMs)
    .map((range) => ({ startMs: range.startMs, endMs: range.endMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (sortedRanges.length === 0) {
    return [];
  }
  const mergedRanges = [sortedRanges[0]];
  sortedRanges.slice(1).forEach((range) => {
    const currentRange = mergedRanges[mergedRanges.length - 1];
    if (range.startMs <= currentRange.endMs) {
      currentRange.endMs = Math.max(currentRange.endMs, range.endMs);
      return;
    }
    mergedRanges.push(range);
  });
  return mergedRanges;
}

/**
 * 合并时间区间并计算不重复覆盖分钟数。
 * @param {Array<{ startMs: number, endMs: number }>} ranges 时间范围。
 * @returns {number} 合并后的分钟数。
 */
function calculateMergedMinutes(ranges) {
  return mergeUtcRanges(ranges).reduce(
    (totalMs, range) => totalMs + range.endMs - range.startMs,
    0
  ) / MINUTE_MS;
}

/**
 * 将来源区间裁剪到统计窗口。
 * @param {*} interval 来源区间。
 * @param {{ startMs: number, endMs: number }} windowBounds 窗口边界。
 * @returns {{ startMs: number, endMs: number }|null} 裁剪结果。
 */
function clipIntervalToWindow(interval, windowBounds) {
  const bounds = resolveIntervalBounds(interval);
  if (!bounds || !windowBounds) {
    return null;
  }
  const startMs = Math.max(bounds.startMs, windowBounds.startMs);
  const endMs = Math.min(bounds.endMs, windowBounds.endMs);
  return startMs < endMs ? { startMs, endMs } : null;
}

/**
 * 检查区间列表是否存在重叠或重复。
 * @param {Array<{ startMs: number, endMs: number }>} ranges 时间范围。
 * @returns {boolean} 是否存在重叠或重复。
 */
function hasOverlapOrDuplicate(ranges) {
  const sortedRanges = [...ranges].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  return sortedRanges.some((range, index) => index > 0 && range.startMs < sortedRanges[index - 1].endMs);
}

/**
 * 合并状态、物化标识和原因一致的相邻状态片段。
 * @param {object[]} rawSegments 原始状态片段。
 * @returns {object[]} 合并后的状态片段。
 */
function coalesceStateSegments(rawSegments) {
  const segments = [];
  rawSegments.forEach((segment) => {
    const previous = segments[segments.length - 1];
    const sameReasons = previous
      && previous.reasonCodes.join('|') === segment.reasonCodes.join('|');
    if (previous
      && sameReasons
      && previous.status === segment.status
      && previous.materialized === segment.materialized
      && previous.endUtc === segment.startUtc) {
      previous.endUtc = segment.endUtc;
      previous.minutes += segment.minutes;
      return;
    }
    segments.push({ ...segment, reasonCodes: [...segment.reasonCodes] });
  });
  return segments.map((segment) => ({
    ...segment,
    minutes: roundAnalysisValue(segment.minutes)
  }));
}

/**
 * 计算显式设备状态覆盖、空载时长和空载能耗，缺口只标记 unknown。
 * @param {*} windowInterval 统计窗口。
 * @param {*} stateRecords 设备状态记录。
 * @param {*} energyRecords 同设备时序能耗记录。
 * @param {*} options 可选预期能源分面。
 * @returns {object} 设备状态覆盖摘要。
 */
function summarizeDeviceStateCoverage(windowInterval, stateRecords, energyRecords = [], options = {}) {
  const normalizedOptions = isPlainObject(options) ? options : {};
  const windowBounds = resolveIntervalBounds(windowInterval);
  const emptyStateMinutes = Object.fromEntries(DEVICE_STATES.map((status) => [status, 0]));
  const fallbackEnergyScope = resolveIntervalEnergyScopes(
    Array.isArray(energyRecords) ? energyRecords : [],
    normalizedOptions.expectedEnergyScope
  );
  if (!windowBounds) {
    return {
      value: null,
      coverageRate: null,
      knownStateCoverageRate: null,
      idleCoverageRate: null,
      idleMinutes: null,
      idleEnergy: null,
      idleEnergyObserved: null,
      idleEnergyComplete: null,
      raw: {
        idleEnergyObserved: null,
        idleEnergyComplete: null,
        sourceObservedEnergy: null,
        share: null,
        observedShare: null,
        observedDenominator: null
      },
      rounded: {
        idleEnergyObserved: null,
        idleEnergyComplete: null,
        sourceObservedEnergy: null,
        share: null,
        observedShare: null,
        observedDenominator: null
      },
      coverage: {
        stateCoverageRate: null,
        knownStateCoverageRate: null,
        idleCoverageRate: null,
        materializedMinutes: null,
        knownStateMinutes: null,
        explicitUnknownMinutes: null,
        gapMinutes: null,
        idleMinutes: null,
        idleCoveredMinutes: null
      },
      share: {
        raw: null,
        rounded: null,
        denominatorRaw: null,
        denominatorRounded: null,
        observedRaw: null,
        observedRounded: null,
        observedDenominatorRaw: null,
        observedDenominatorRounded: null,
        completeWindowAvailable: false
      },
      rounding: {
        precision: DEFAULT_PRECISION,
        idleEnergyObservedRoundedToZero: false,
        idleEnergyCompleteRoundedToZero: false,
        idleEnergyObservedDifference: null,
        idleEnergyCompleteDifference: null,
        shareDifference: null,
        observedShareDifference: null
      },
      stateKnowledgeComplete: false,
      energyScopeComparable: fallbackEnergyScope.comparable,
      energyScopes: fallbackEnergyScope.energyScopes,
      expectedEnergyScope: fallbackEnergyScope.expectedEnergyScope,
      stateMinutes: emptyStateMinutes,
      segments: [],
      sourceGranularityMinutes: [],
      mixedSourceGranularity: false,
      allocationUsed: false,
      allocationAssumption: 'uniform_within_interval',
      numericOverflow: false,
      reasonCodes: ['DEVICE_STATE_GAP']
    };
  }

  const stateList = Array.isArray(stateRecords) ? stateRecords : [];
  const windowMinutes = (windowBounds.endMs - windowBounds.startMs) / MINUTE_MS;
  const clippedStateRanges = stateList.map((record, index) => ({
    index,
    record,
    range: clipIntervalToWindow(record, windowBounds)
  })).filter((item) => item.range && DEVICE_STATES.includes(item.record.status));
  const stateEvents = new Map();
  const appendStateEvent = (timestampMs, type, item) => {
    const events = stateEvents.get(timestampMs) || [];
    events.push({ type, item });
    stateEvents.set(timestampMs, events);
  };
  clippedStateRanges.forEach((item) => {
    appendStateEvent(item.range.startMs, 'start', item);
    appendStateEvent(item.range.endMs, 'end', item);
  });
  const stateBoundaries = [...new Set([
    windowBounds.startMs,
    windowBounds.endMs,
    ...stateEvents.keys()
  ])].sort((left, right) => left - right);
  const activeStates = new Map();
  const rawSegments = [];
  const idleRanges = [];
  const stateMinutes = { ...emptyStateMinutes };
  let materializedMinutes = 0;
  let knownStateMinutes = 0;
  let explicitUnknownMinutes = 0;
  let unknownMinutes = 0;
  let gapMinutes = 0;
  let idleMinutes = 0;
  let stateOverlap = false;

  for (let index = 0; index < stateBoundaries.length - 1; index += 1) {
    const segmentStartMs = stateBoundaries[index];
    const boundaryEvents = stateEvents.get(segmentStartMs) || [];
    boundaryEvents.filter((event) => event.type === 'end').forEach((event) => {
      activeStates.delete(event.item.index);
    });
    boundaryEvents.filter((event) => event.type === 'start').forEach((event) => {
      activeStates.set(event.item.index, event.item);
    });
    const segmentEndMs = stateBoundaries[index + 1];
    const segmentMinutes = (segmentEndMs - segmentStartMs) / MINUTE_MS;
    const activeStateCount = activeStates.size;
    const activeStateItem = activeStateCount === 1
      ? activeStates.values().next().value
      : null;
    const materialized = activeStateCount === 1;
    const status = materialized ? activeStateItem.record.status : 'unknown';
    const segmentReasonCodes = activeStateCount === 0
      ? ['DEVICE_STATE_GAP']
      : activeStateCount > 1 ? ['SOURCE_OVERLAP_OR_DUPLICATE'] : [];
    if (activeStateCount > 1) {
      stateOverlap = true;
    }
    if (materialized) {
      materializedMinutes += segmentMinutes;
      stateMinutes[status] += segmentMinutes;
      if (status === 'unknown') {
        explicitUnknownMinutes += segmentMinutes;
      } else {
        knownStateMinutes += segmentMinutes;
      }
    }
    if (status === 'unknown') {
      unknownMinutes += segmentMinutes;
    }
    if (activeStateCount === 0) {
      gapMinutes += segmentMinutes;
    }
    if (materialized && status === 'idle') {
      idleMinutes += segmentMinutes;
      idleRanges.push({ startMs: segmentStartMs, endMs: segmentEndMs });
    }
    rawSegments.push({
      status,
      materialized,
      startUtc: new Date(segmentStartMs).toISOString(),
      endUtc: new Date(segmentEndMs).toISOString(),
      minutes: segmentMinutes,
      reasonCodes: segmentReasonCodes
    });
  }

  const preparedEnergy = prepareIntervalEnergyRecords(
    energyRecords,
    windowInterval,
    normalizedOptions.expectedEnergyScope
  );
  // 原始空载能耗与展示舍入值分离，避免把正微量舍入零误判为真实零。
  let rawIdleEnergyObserved = null;
  let rawIdleEnergyComplete = null;
  let idleEnergyObserved = null;
  let idleEnergyComplete = null;
  let idleCoveredMs = 0;
  let allocationUsed = preparedEnergy.allocationUsed;
  let calculationOverflow = preparedEnergy.numericOverflow;
  const stateKnowledgeComplete = gapMinutes === 0
    && explicitUnknownMinutes === 0
    && !stateOverlap;
  if (!stateOverlap
    && !preparedEnergy.sourceOverlap
    && preparedEnergy.energyScopeComparable
    && !calculationOverflow) {
    if (idleRanges.length === 0) {
      rawIdleEnergyObserved = 0;
      idleEnergyObserved = 0;
      if (stateKnowledgeComplete) {
        rawIdleEnergyComplete = 0;
        idleEnergyComplete = 0;
      }
    } else if (preparedEnergy.items.length > 0) {
      let rawIdleEnergy = 0;
      let firstEnergyIndex = 0;
      idleRanges.forEach((idleRange) => {
        while (firstEnergyIndex < preparedEnergy.items.length
          && preparedEnergy.items[firstEnergyIndex].range.endMs <= idleRange.startMs) {
          firstEnergyIndex += 1;
        }
        let candidateIndex = firstEnergyIndex;
        while (candidateIndex < preparedEnergy.items.length
          && preparedEnergy.items[candidateIndex].range.startMs < idleRange.endMs) {
          const energyItem = preparedEnergy.items[candidateIndex];
          const overlapStartMs = Math.max(idleRange.startMs, energyItem.range.startMs);
          const overlapEndMs = Math.min(idleRange.endMs, energyItem.range.endMs);
          if (overlapStartMs < overlapEndMs) {
            const overlapMs = overlapEndMs - overlapStartMs;
            const sourceDurationMs = energyItem.sourceBounds.endMs - energyItem.sourceBounds.startMs;
            const allocatedEnergy = energyItem.record.value * overlapMs / sourceDurationMs;
            if (!Number.isFinite(allocatedEnergy) || !Number.isFinite(rawIdleEnergy + allocatedEnergy)) {
              calculationOverflow = true;
            } else {
              rawIdleEnergy += allocatedEnergy;
              idleCoveredMs += overlapMs;
              if (overlapMs < sourceDurationMs) {
                allocationUsed = true;
              }
            }
          }
          candidateIndex += 1;
        }
      });
      if (!calculationOverflow && idleCoveredMs > 0) {
        rawIdleEnergyObserved = rawIdleEnergy;
        idleEnergyObserved = roundAnalysisValue(rawIdleEnergy);
        if (stateKnowledgeComplete
          && idleCoveredMs === idleMinutes * MINUTE_MS) {
          rawIdleEnergyComplete = rawIdleEnergy;
          idleEnergyComplete = idleEnergyObserved;
        }
      }
    }
  }

  const allocationInvalid = stateOverlap
    || preparedEnergy.sourceOverlap
    || !preparedEnergy.energyScopeComparable
    || calculationOverflow;
  const idleEnergy = allocationInvalid ? null : idleEnergyObserved;
  const reasonCodes = [];
  if (gapMinutes > 0) {
    reasonCodes.push('DEVICE_STATE_GAP');
  }
  if (stateOverlap || preparedEnergy.sourceOverlap) {
    reasonCodes.push('SOURCE_OVERLAP_OR_DUPLICATE');
  }
  if (!preparedEnergy.energyScopeComparable) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  if (idleMinutes > 0
    && preparedEnergy.energyScopeComparable
    && idleCoveredMs === 0
    && !calculationOverflow) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  } else if (idleMinutes > 0 && idleCoveredMs > 0 && idleCoveredMs < idleMinutes * MINUTE_MS) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  if (!preparedEnergy.sourceOverlap
    && preparedEnergy.energyScopeComparable
    && preparedEnergy.items.length > 0
    && preparedEnergy.coverageRate < 1) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  const stateCoverageRate = roundAnalysisValue(materializedMinutes / windowMinutes);
  const knownStateCoverageRate = roundAnalysisValue(knownStateMinutes / windowMinutes);
  const idleCoverageRate = idleMinutes > 0
    ? roundAnalysisValue(idleCoveredMs / (idleMinutes * MINUTE_MS))
    : null;
  const sourceObservedEnergyRaw = allocationInvalid ? null : preparedEnergy.rawObservedEnergy;
  const sourceObservedEnergyRounded = Number.isFinite(sourceObservedEnergyRaw)
    ? roundAnalysisValue(sourceObservedEnergyRaw)
    : null;
  // 无修饰占比只表示状态与时序均完整的窗口占比；局部观测占比使用显式 observed 命名。
  const completeWindowShareAvailable = !allocationInvalid
    && stateKnowledgeComplete
    && Number.isFinite(rawIdleEnergyComplete)
    && preparedEnergy.coverageRate === 1
    && Number.isFinite(sourceObservedEnergyRaw);
  const shareDenominatorRaw = completeWindowShareAvailable ? sourceObservedEnergyRaw : null;
  const shareDenominatorRounded = completeWindowShareAvailable ? sourceObservedEnergyRounded : null;
  const rawIdleShare = Number.isFinite(rawIdleEnergyComplete)
    && Number.isFinite(shareDenominatorRaw)
    && shareDenominatorRaw > 0
    ? rawIdleEnergyComplete / shareDenominatorRaw
    : null;
  const roundedIdleShare = Number.isFinite(rawIdleShare)
    ? roundAnalysisValue(rawIdleShare)
    : null;
  const observedRawIdleShare = Number.isFinite(rawIdleEnergyObserved)
    && Number.isFinite(sourceObservedEnergyRaw)
    && sourceObservedEnergyRaw > 0
    ? rawIdleEnergyObserved / sourceObservedEnergyRaw
    : null;
  const observedRoundedIdleShare = Number.isFinite(observedRawIdleShare)
    ? roundAnalysisValue(observedRawIdleShare)
    : null;
  const roundedIdleEnergyComplete = allocationInvalid ? null : idleEnergyComplete;
  return {
    value: roundedIdleEnergyComplete,
    coverageRate: stateCoverageRate,
    knownStateCoverageRate,
    idleCoverageRate,
    coveredMinutes: roundAnalysisValue(materializedMinutes),
    knownStateMinutes: roundAnalysisValue(knownStateMinutes),
    explicitUnknownMinutes: roundAnalysisValue(explicitUnknownMinutes),
    unknownMinutes: roundAnalysisValue(unknownMinutes),
    gapMinutes: roundAnalysisValue(gapMinutes),
    stateMinutes: Object.fromEntries(DEVICE_STATES.map((status) => [
      status,
      roundAnalysisValue(stateMinutes[status])
    ])),
    idleMinutes: roundAnalysisValue(idleMinutes),
    idleCoveredMinutes: roundAnalysisValue(idleCoveredMs / MINUTE_MS),
    idleEnergy,
    idleEnergyObserved: idleEnergy,
    idleEnergyComplete: roundedIdleEnergyComplete,
    raw: {
      idleEnergyObserved: allocationInvalid ? null : rawIdleEnergyObserved,
      idleEnergyComplete: allocationInvalid ? null : rawIdleEnergyComplete,
      sourceObservedEnergy: sourceObservedEnergyRaw,
      share: rawIdleShare,
      observedShare: observedRawIdleShare,
      observedDenominator: sourceObservedEnergyRaw
    },
    rounded: {
      idleEnergyObserved: idleEnergy,
      idleEnergyComplete: roundedIdleEnergyComplete,
      sourceObservedEnergy: sourceObservedEnergyRounded,
      share: roundedIdleShare,
      observedShare: observedRoundedIdleShare,
      observedDenominator: sourceObservedEnergyRounded
    },
    coverage: {
      stateCoverageRate,
      knownStateCoverageRate,
      idleCoverageRate,
      materializedMinutes: roundAnalysisValue(materializedMinutes),
      knownStateMinutes: roundAnalysisValue(knownStateMinutes),
      explicitUnknownMinutes: roundAnalysisValue(explicitUnknownMinutes),
      gapMinutes: roundAnalysisValue(gapMinutes),
      idleMinutes: roundAnalysisValue(idleMinutes),
      idleCoveredMinutes: roundAnalysisValue(idleCoveredMs / MINUTE_MS)
    },
    share: {
      raw: rawIdleShare,
      rounded: roundedIdleShare,
      denominatorRaw: shareDenominatorRaw,
      denominatorRounded: shareDenominatorRounded,
      observedRaw: observedRawIdleShare,
      observedRounded: observedRoundedIdleShare,
      observedDenominatorRaw: sourceObservedEnergyRaw,
      observedDenominatorRounded: sourceObservedEnergyRounded,
      completeWindowAvailable: completeWindowShareAvailable
    },
    rounding: {
      precision: DEFAULT_PRECISION,
      idleEnergyObservedRoundedToZero: idleEnergy === 0 && rawIdleEnergyObserved > 0,
      idleEnergyCompleteRoundedToZero: roundedIdleEnergyComplete === 0 && rawIdleEnergyComplete > 0,
      idleEnergyObservedDifference: Number.isFinite(rawIdleEnergyObserved) && Number.isFinite(idleEnergy)
        ? rawIdleEnergyObserved - idleEnergy
        : null,
      idleEnergyCompleteDifference: Number.isFinite(rawIdleEnergyComplete)
        && Number.isFinite(roundedIdleEnergyComplete)
        ? rawIdleEnergyComplete - roundedIdleEnergyComplete
        : null,
      shareDifference: Number.isFinite(rawIdleShare) && Number.isFinite(roundedIdleShare)
        ? rawIdleShare - roundedIdleShare
        : null,
      observedShareDifference: Number.isFinite(observedRawIdleShare)
        && Number.isFinite(observedRoundedIdleShare)
        ? observedRawIdleShare - observedRoundedIdleShare
        : null
    },
    stateKnowledgeComplete,
    energyScopeComparable: preparedEnergy.energyScopeComparable,
    energyScopes: preparedEnergy.energyScopes,
    expectedEnergyScope: preparedEnergy.expectedEnergyScope,
    segments: coalesceStateSegments(rawSegments),
    assumption: 'energy_uniform_within_interval',
    sourceGranularityMinutes: preparedEnergy.sourceGranularityMinutes,
    mixedSourceGranularity: preparedEnergy.mixedSourceGranularity,
    allocationUsed,
    allocationAssumption: 'uniform_within_interval',
    numericOverflow: calculationOverflow,
    reasonCodes: normalizeReasonCodes(reasonCodes)
  };
}

/**
 * 解析记录列表唯一的能源类型和单位分面。
 * @param {object[]} items 带能源类型和单位的记录。
 * @returns {object} 分面解析结果。
 */
function resolveUniqueEnergyScope(items) {
  const itemList = Array.isArray(items) ? items : [];
  const scopes = [];
  let hasInvalidScope = itemList.length === 0;
  itemList.forEach((item) => {
    if (!isPlainObject(item)
      || typeof item.energyTypeCode !== 'string'
      || item.energyTypeCode.trim() === ''
      || typeof item.unit !== 'string'
      || item.unit.trim() === '') {
      hasInvalidScope = true;
      return;
    }
    const scopeKey = JSON.stringify([item.energyTypeCode, item.unit]);
    if (!scopes.some((scope) => scope.key === scopeKey)) {
      scopes.push({
        key: scopeKey,
        energyTypeCode: item.energyTypeCode,
        unit: item.unit
      });
    }
  });
  const uniqueScope = !hasInvalidScope && scopes.length === 1 ? scopes[0] : null;
  return {
    valid: uniqueScope !== null,
    energyTypeCode: uniqueScope ? uniqueScope.energyTypeCode : null,
    unit: uniqueScope ? uniqueScope.unit : null,
    scopes: scopes.map(({ energyTypeCode, unit }) => ({ energyTypeCode, unit }))
  };
}

/**
 * 分析时序记录的覆盖率、粒度、分面和重叠质量。
 * @param {*} records 时序记录。
 * @param {*} windowInterval 统计窗口。
 * @returns {object} 数据质量摘要。
 */
function analyzeTimeSeriesQuality(records, windowInterval) {
  const windowBounds = resolveIntervalBounds(windowInterval);
  const recordList = Array.isArray(records) ? records : [];
  const validRecords = recordList.filter((record) => (
    validateTimeIntervalContract(record).valid
    && SUPPORTED_INTERVAL_MINUTES.includes(record.granularityMinutes)
    && isFiniteNonNegativeNumber(record.value)
  ));
  if (!windowBounds) {
    const invalidWindowScope = resolveUniqueEnergyScope(validRecords);
    return {
      windowBounds: null,
      windowMinutes: null,
      validRecords: [],
      clippedRanges: [],
      coverageRate: null,
      energyTypeCode: invalidWindowScope.energyTypeCode,
      unit: invalidWindowScope.unit,
      energyScopes: invalidWindowScope.scopes,
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }
  const clippedRecords = validRecords.map((record) => ({
    record,
    range: clipIntervalToWindow(record, windowBounds)
  })).filter((item) => item.range);
  const clippedRanges = clippedRecords.map((item) => item.range);
  const windowMinutes = (windowBounds.endMs - windowBounds.startMs) / MINUTE_MS;
  const coveredMinutes = calculateMergedMinutes(clippedRanges);
  const granularities = new Set(clippedRecords.map(({ record }) => record.granularityMinutes));
  const energyScope = resolveUniqueEnergyScope(clippedRecords.map((item) => item.record));
  const reasonCodes = [];
  if (clippedRecords.length === 0) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  }
  if (granularities.size > 1) {
    reasonCodes.push('MIXED_INTERVAL_GRANULARITY');
  }
  if (hasOverlapOrDuplicate(clippedRanges)) {
    reasonCodes.push('SOURCE_OVERLAP_OR_DUPLICATE');
  }
  if (clippedRecords.length > 0 && !energyScope.valid) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  return {
    windowBounds,
    windowMinutes,
    validRecords: clippedRecords.map((item) => item.record),
    clippedRecords,
    clippedRanges,
    coverageRate: roundAnalysisValue(coveredMinutes / windowMinutes),
    coveredMinutes: roundAnalysisValue(coveredMinutes),
    energyTypeCode: energyScope.energyTypeCode,
    unit: energyScope.unit,
    energyScopes: energyScope.scopes,
    reasonCodes: normalizeReasonCodes(reasonCodes)
  };
}

/**
 * 规范峰值并列证据的返回上限。
 * @param {*} evidenceLimit 用户指定上限。
 * @returns {number} 1 到最大上限之间的整数。
 */
function normalizePeakEvidenceLimit(evidenceLimit) {
  if (!Number.isInteger(evidenceLimit) || evidenceLimit <= 0) {
    return DEFAULT_PEAK_EVIDENCE_LIMIT;
  }
  return Math.min(evidenceLimit, MAX_PEAK_EVIDENCE_LIMIT);
}

/**
 * 生成峰值区间的稳定证据标识。
 * @param {*} record 时序记录。
 * @returns {string} 稳定证据标识。
 */
function resolvePeakEvidenceReference(record) {
  if (isPlainObject(record) && typeof record.id === 'string' && record.id.trim() !== '') {
    return record.id;
  }
  if (isPlainObject(record)
    && typeof record.sourceReference === 'string'
    && record.sourceReference.trim() !== '') {
    return `${record.sourceReference}:${record.startUtc}/${record.endUtc}`;
  }
  return `${record.startUtc}/${record.endUtc}`;
}

/**
 * 按 Unicode 字面顺序稳定比较证据标识，避免运行环境区域设置影响排序。
 * @param {string} left 左侧标识。
 * @param {string} right 右侧标识。
 * @returns {number} 排序比较结果。
 */
function compareEvidenceReferences(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * 判断记录是否完整落在统计窗口内，部分相交记录不得作为完整粒度峰值。
 * @param {*} record 时序记录。
 * @param {{ startMs: number, endMs: number }} windowBounds 统计窗口边界。
 * @returns {boolean} 是否完整落窗。
 */
function isRecordFullyInsideWindow(record, windowBounds) {
  const recordBounds = resolveIntervalBounds(record);
  return Boolean(recordBounds && windowBounds
    && recordBounds.startMs >= windowBounds.startMs
    && recordBounds.endMs <= windowBounds.endMs);
}

/**
 * 计算单能源、单单位、单粒度时序记录的峰值区间能量摘要。
 * @param {*} records 时序能耗记录。
 * @param {*} windowInterval 严格 UTC 左闭右开统计窗口。
 * @param {*} options 覆盖率阈值和证据上限选项。
 * @returns {object} 峰值区间能量摘要。
 */
function calculatePeakIntervalEnergy(records, windowInterval, options = {}) {
  const quality = analyzeTimeSeriesQuality(records, windowInterval);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const minimumCoverageRate = Number.isFinite(normalizedOptions.minimumCoverageRate)
    ? Math.min(1, Math.max(0, normalizedOptions.minimumCoverageRate))
    : 1;
  const evidenceLimit = normalizePeakEvidenceLimit(normalizedOptions.evidenceLimit);
  const completeRecords = quality.windowBounds
    ? quality.validRecords.filter((record) => isRecordFullyInsideWindow(record, quality.windowBounds))
    : [];
  const coveredMinutes = quality.coveredMinutes;
  const coverageRate = quality.coverageRate;
  const granularities = new Set(quality.validRecords.map((record) => record.granularityMinutes));
  const granularityMinutes = granularities.size === 1 ? [...granularities][0] : null;
  let coveredEnergy = null;
  if (quality.windowBounds && quality.validRecords.length > 0 && quality.reasonCodes.length === 0) {
    const allocations = quality.validRecords.map((record) => allocateEnergyByUtcOverlap(record, windowInterval));
    if (allocations.every((allocation) => Number.isFinite(allocation.value))) {
      coveredEnergy = roundAnalysisValue(
        allocations.reduce((sum, allocation) => sum + allocation.value, 0)
      );
    }
  }
  const totalEnergyComplete = coverageRate === 1
    && quality.reasonCodes.length === 0
    && Number.isFinite(coveredEnergy);
  const reasonCodes = [...quality.reasonCodes];
  if (quality.windowBounds && completeRecords.length === 0 && quality.validRecords.length > 0) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  }
  if (Number.isFinite(coverageRate) && coverageRate < minimumCoverageRate) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  const sourceUnit = quality.unit;
  const metricUnit = sourceUnit && granularityMinutes
    ? `${sourceUnit}/${granularityMinutes}min`
    : null;
  const dataRange = quality.windowBounds && isPlainObject(windowInterval)
    ? {
      startUtc: windowInterval.startUtc,
      endUtc: windowInterval.endUtc,
      sourceTimeZone: windowInterval.sourceTimeZone
    }
    : null;

  if (!quality.windowBounds || completeRecords.length === 0 || normalizedReasonCodes.length > 0) {
    return {
      value: null,
      peakIntervalEnergy: null,
      energyTypeCode: quality.energyTypeCode,
      unit: metricUnit,
      sourceUnit,
      energyScopes: quality.energyScopes || [],
      granularityMinutes,
      coverageRate,
      coveredMinutes: roundAnalysisValue(coveredMinutes),
      expectedMinutes: quality.windowMinutes,
      minimumCoverageRate,
      coveredEnergy,
      totalEnergy: totalEnergyComplete ? coveredEnergy : null,
      totalEnergyUnit: sourceUnit,
      totalEnergyComplete,
      peakIntervals: [],
      peakIntervalCount: 0,
      evidence: [],
      evidenceLimit,
      evidenceTruncated: false,
      dataRange,
      reasonCodes: normalizedReasonCodes
    };
  }

  const sortedRecords = [...completeRecords].sort((left, right) => (
    Date.parse(left.startUtc) - Date.parse(right.startUtc)
    || Date.parse(left.endUtc) - Date.parse(right.endUtc)
    || compareEvidenceReferences(
      resolvePeakEvidenceReference(left),
      resolvePeakEvidenceReference(right)
    )
  ));
  const peakIntervalEnergy = sortedRecords.reduce(
    (currentPeak, record) => Math.max(currentPeak, record.value),
    sortedRecords[0].value
  );
  const allPeakIntervals = sortedRecords
    .filter((record) => record.value === peakIntervalEnergy)
    .map((record) => ({
      evidenceReference: resolvePeakEvidenceReference(record),
      startUtc: record.startUtc,
      endUtc: record.endUtc,
      value: record.value
    }));
  const peakIntervals = allPeakIntervals.slice(0, evidenceLimit);
  return {
    value: roundAnalysisValue(peakIntervalEnergy),
    peakIntervalEnergy: roundAnalysisValue(peakIntervalEnergy),
    energyTypeCode: quality.energyTypeCode,
    unit: metricUnit,
    sourceUnit,
    energyScopes: quality.energyScopes,
    granularityMinutes,
    coverageRate,
    coveredMinutes: roundAnalysisValue(coveredMinutes),
    expectedMinutes: quality.windowMinutes,
    minimumCoverageRate,
    coveredEnergy,
    totalEnergy: totalEnergyComplete ? coveredEnergy : null,
    totalEnergyUnit: sourceUnit,
    totalEnergyComplete,
    peakIntervals,
    peakIntervalCount: allPeakIntervals.length,
    evidence: peakIntervals.map((item) => item.evidenceReference),
    evidenceLimit,
    evidenceTruncated: allPeakIntervals.length > peakIntervals.length,
    dataRange,
    reasonCodes: []
  };
}

/**
 * 计算覆盖率、平均负荷、最大负荷和负荷率。
 * @param {*} records 时序能耗记录。
 * @param {*} windowInterval 统计窗口。
 * @param {*} options 计算选项。
 * @returns {object} 负荷指标结果。
 */
function calculateLoadMetrics(records, windowInterval, options = {}) {
  const quality = analyzeTimeSeriesQuality(records, windowInterval);
  const normalizedOptions = isPlainObject(options) ? options : {};
  const minimumCoverageRate = Number.isFinite(normalizedOptions.minimumCoverageRate)
    ? Math.min(1, Math.max(0, normalizedOptions.minimumCoverageRate))
    : 1;
  const reasonCodes = [...quality.reasonCodes];
  if (Number.isFinite(quality.coverageRate) && quality.coverageRate < minimumCoverageRate) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  if (!quality.windowBounds || normalizedReasonCodes.length > 0) {
    return {
      value: null,
      energyTypeCode: quality.energyTypeCode,
      unit: quality.unit,
      energyScopes: quality.energyScopes || [],
      coverageRate: quality.coverageRate,
      coveredMinutes: quality.coveredMinutes || 0,
      expectedMinutes: quality.windowMinutes,
      averageLoad: null,
      maxLoad: null,
      loadRate: null,
      loadRateCalculable: false,
      loadRateReason: null,
      totalEnergy: null,
      minimumCoverageRate,
      reasonCodes: normalizedReasonCodes
    };
  }

  let totalEnergy = 0;
  let maxLoad = null;
  quality.clippedRecords.forEach(({ record }) => {
    const allocation = allocateEnergyByUtcOverlap(record, windowInterval);
    totalEnergy += allocation.value;
    const durationMinutes = calculateUtcOverlapMinutes(record, record);
    const recordLoad = durationMinutes > 0 ? record.value * 60 / durationMinutes : null;
    maxLoad = maxLoad === null ? recordLoad : Math.max(maxLoad, recordLoad);
  });
  const averageLoad = totalEnergy / (quality.coveredMinutes / 60);
  const loadRate = maxLoad > 0 ? averageLoad / maxLoad : null;
  const loadRateCalculable = loadRate !== null;
  return {
    value: roundAnalysisValue(loadRate),
    energyTypeCode: quality.energyTypeCode,
    unit: quality.unit,
    energyScopes: quality.energyScopes,
    coverageRate: quality.coverageRate,
    coveredMinutes: quality.coveredMinutes,
    expectedMinutes: quality.windowMinutes,
    averageLoad: roundAnalysisValue(averageLoad),
    maxLoad: roundAnalysisValue(maxLoad),
    loadRate: roundAnalysisValue(loadRate),
    loadRateCalculable,
    loadRateReason: loadRateCalculable ? null : 'ZERO_MAX_LOAD',
    totalEnergy: roundAnalysisValue(totalEnergy),
    minimumCoverageRate,
    reasonCodes: []
  };
}

/**
 * 将 0 到 1 的负荷率比例显式转换为百分数，禁止策略构造器隐式换算单位。
 * @param {*} ratio 负荷率比例。
 * @returns {number|null} 百分数或不可转换的 null。
 */
function convertRatioToPercentage(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return null;
  }
  return roundAnalysisValue(ratio * 100);
}

/**
 * 规范策略阈值并返回稳定校验结果。
 * @param {*} threshold 策略阈值。
 * @returns {{ valid: boolean, threshold: object|null, errors: string[] }} 阈值校验结果。
 */
function normalizeStrategyThreshold(threshold) {
  const errors = [];
  if (!isPlainObject(threshold)) {
    return { valid: false, threshold: null, errors: ['INVALID_RULE_THRESHOLD'] };
  }
  if (!RULE_THRESHOLD_OPERATORS.includes(threshold.operator)) {
    errors.push('INVALID_RULE_THRESHOLD_OPERATOR');
  }
  if (typeof threshold.unit !== 'string' || threshold.unit.trim() === '') {
    errors.push('INVALID_RULE_THRESHOLD_UNIT');
  }
  if (threshold.operator === 'between') {
    if (!Number.isFinite(threshold.min)
      || !Number.isFinite(threshold.max)
      || threshold.min > threshold.max) {
      errors.push('INVALID_RULE_THRESHOLD_RANGE');
    }
  } else if (RULE_THRESHOLD_OPERATORS.includes(threshold.operator)
    && !Number.isFinite(threshold.value)) {
    errors.push('INVALID_RULE_THRESHOLD_VALUE');
  }
  if (Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')
    && (!Number.isFinite(threshold.reductionRate)
      || threshold.reductionRate <= 0
      || threshold.reductionRate > 1)) {
    errors.push('INVALID_RULE_REDUCTION_RATE');
  }
  if (errors.length > 0) {
    return { valid: false, threshold: null, errors: [...new Set(errors)] };
  }

  const normalizedThreshold = threshold.operator === 'between'
    ? {
      operator: threshold.operator,
      min: threshold.min,
      max: threshold.max,
      unit: threshold.unit
    }
    : {
      operator: threshold.operator,
      value: threshold.value,
      unit: threshold.unit
    };
  if (Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')) {
    normalizedThreshold.reductionRate = threshold.reductionRate;
  }
  return { valid: true, threshold: normalizedThreshold, errors: [] };
}

/**
 * 按冻结操作符计算策略阈值，非法数值或配置稳定返回不可评估结果。
 * @param {*} actualValue 实际指标值。
 * @param {*} threshold 策略阈值。
 * @returns {object} 阈值匹配结果。
 */
function evaluateStrategyThreshold(actualValue, threshold) {
  const thresholdValidation = normalizeStrategyThreshold(threshold);
  const actualValueValid = Number.isFinite(actualValue);
  if (!thresholdValidation.valid || !actualValueValid) {
    return {
      value: null,
      evaluable: false,
      matched: null,
      actualValue: actualValueValid ? actualValue : null,
      threshold: thresholdValidation.threshold,
      errors: [
        ...thresholdValidation.errors,
        ...(!actualValueValid ? ['INVALID_STRATEGY_ACTUAL_VALUE'] : [])
      ],
      reasonCodes: [thresholdValidation.valid ? 'NO_TIMESERIES_DATA' : 'UNIT_NOT_COMPARABLE']
    };
  }

  const normalizedThreshold = thresholdValidation.threshold;
  let matched = false;
  if (normalizedThreshold.operator === 'gt') {
    matched = actualValue > normalizedThreshold.value;
  } else if (normalizedThreshold.operator === 'gte') {
    matched = actualValue >= normalizedThreshold.value;
  } else if (normalizedThreshold.operator === 'lt') {
    matched = actualValue < normalizedThreshold.value;
  } else if (normalizedThreshold.operator === 'lte') {
    matched = actualValue <= normalizedThreshold.value;
  } else {
    matched = actualValue >= normalizedThreshold.min && actualValue <= normalizedThreshold.max;
  }
  return {
    value: matched,
    evaluable: true,
    matched,
    actualValue,
    threshold: normalizedThreshold,
    errors: [],
    reasonCodes: []
  };
}

/**
 * 从指标结果或调用上下文读取规则输出的数据范围。
 * @param {*} metricResult 指标结果。
 * @param {*} context 策略上下文。
 * @returns {object|null} 数据范围。
 */
function resolveStrategyDataRange(metricResult, context) {
  const candidates = [
    isPlainObject(metricResult) ? metricResult.dataRange : null,
    isPlainObject(context) ? context.dataRange : null,
    isPlainObject(context) ? context : null
  ];
  const candidate = candidates.find((item) => isPlainObject(item)
    && isStrictUtcIso(item.startUtc)
    && isStrictUtcIso(item.endUtc)
    && Date.parse(item.startUtc) < Date.parse(item.endUtc)
    && isIanaTimeZone(item.sourceTimeZone));
  return candidate
    ? {
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      sourceTimeZone: candidate.sourceTimeZone
    }
    : null;
}

/**
 * 规范调用方提供的真实规则证据，不生成无法追溯的占位证据。
 * @param {*} metricResult 指标结果。
 * @param {*} context 策略上下文。
 * @returns {string[]} 调用方提供的去重证据列表。
 */
function resolveStrategyEvidence(metricResult, context) {
  const metricEvidence = isPlainObject(metricResult) && Array.isArray(metricResult.evidence)
    ? metricResult.evidence
    : [];
  const contextEvidence = isPlainObject(context) && Array.isArray(context.evidence)
    ? context.evidence
    : [];
  return [...new Set([...metricEvidence, ...contextEvidence]
    .filter((item) => typeof item === 'string' && item.trim() !== ''))];
}

/**
 * 构造本地确定性策略预演结果，并通过冻结契约执行最终自校验。
 * @param {*} rule 策略规则。
 * @param {*} metricResult 公共计算层指标结果。
 * @param {*} context 统计范围和补充证据上下文。
 * @returns {object} 确定性策略预演结果。
 */
function buildStrategyEvaluation(rule, metricResult, context = {}) {
  const normalizedRule = isPlainObject(rule) ? rule : {};
  const normalizedMetric = isPlainObject(metricResult) ? metricResult : {};
  const normalizedContext = isPlainObject(context) ? context : {};
  const explicitRuleCode = typeof normalizedRule.ruleCode === 'string' && normalizedRule.ruleCode.trim() !== ''
    ? normalizedRule.ruleCode
    : typeof normalizedRule.code === 'string' && normalizedRule.code.trim() !== ''
      ? normalizedRule.code
      : null;
  const explicitRuleVersion = normalizedRule.ruleVersion || normalizedRule.version || null;
  const explicitFormulaVersion = normalizedRule.formulaVersion || normalizedMetric.formulaVersion || null;
  const ruleIdentityValid = explicitRuleCode !== null
    && STRATEGY_VERSION_PATTERN.test(explicitRuleVersion || '')
    && STRATEGY_VERSION_PATTERN.test(explicitFormulaVersion || '');
  const ruleCode = ruleIdentityValid ? explicitRuleCode : 'UNSPECIFIED_STRATEGY_RULE';
  const ruleVersion = ruleIdentityValid ? explicitRuleVersion : ENERGY_ANALYSIS_VERSIONS.strategyRule;
  const formulaVersion = ruleIdentityValid ? explicitFormulaVersion : ENERGY_ANALYSIS_VERSIONS.loadAnalysis;
  const thresholdValidation = normalizeStrategyThreshold(normalizedRule.threshold);
  const metricUnit = typeof normalizedMetric.metricUnit === 'string' && normalizedMetric.metricUnit.trim() !== ''
    ? normalizedMetric.metricUnit
    : typeof normalizedMetric.unit === 'string' && normalizedMetric.unit.trim() !== ''
      ? normalizedMetric.unit
      : null;
  const fallbackThresholdUnit = isPlainObject(normalizedRule.threshold)
    && typeof normalizedRule.threshold.unit === 'string'
    && normalizedRule.threshold.unit.trim() !== ''
    ? normalizedRule.threshold.unit
    : metricUnit || 'unknown';
  const normalizedThreshold = thresholdValidation.threshold || {
    operator: 'gt',
    value: 0,
    unit: fallbackThresholdUnit
  };
  const metricReasonCodes = normalizeReasonCodes(normalizedMetric.reasonCodes);
  const coverageRateValid = Number.isFinite(normalizedMetric.coverageRate)
    && normalizedMetric.coverageRate >= 0
    && normalizedMetric.coverageRate <= 1;
  const coverageRate = coverageRateValid ? normalizedMetric.coverageRate : 0;
  const unitMatches = thresholdValidation.valid && metricUnit === normalizedThreshold.unit;
  const actualValueValid = Number.isFinite(normalizedMetric.value);
  const evidence = resolveStrategyEvidence(normalizedMetric, normalizedContext);
  const dataRange = resolveStrategyDataRange(normalizedMetric, normalizedContext);
  const priorityValid = RULE_PRIORITIES.includes(normalizedRule.priority);
  const rawRecommendation = typeof normalizedRule.recommendation === 'string'
    && normalizedRule.recommendation.trim() !== ''
    ? normalizedRule.recommendation
    : null;
  const forbiddenRecommendation = hasForbiddenAutomationRecommendation(rawRecommendation);
  const recommendation = rawRecommendation && !forbiddenRecommendation
    ? rawRecommendation
    : '请人工复核指标证据后决定是否执行用能调整。';
  const inputErrors = [
    ...thresholdValidation.errors,
    ...(!ruleIdentityValid ? ['INVALID_RULE_IDENTITY'] : []),
    ...(!coverageRateValid ? ['INVALID_RULE_COVERAGE_RATE'] : []),
    ...(!actualValueValid ? ['INVALID_STRATEGY_ACTUAL_VALUE'] : []),
    ...(!unitMatches ? ['STRATEGY_THRESHOLD_UNIT_MISMATCH'] : []),
    ...(dataRange === null ? ['MISSING_STRATEGY_DATA_RANGE'] : []),
    ...(evidence.length === 0 ? ['MISSING_STRATEGY_EVIDENCE'] : []),
    ...(!priorityValid ? ['INVALID_RULE_PRIORITY'] : []),
    ...(rawRecommendation === null ? ['INVALID_RULE_RECOMMENDATION'] : []),
    ...(forbiddenRecommendation ? ['FORBIDDEN_AUTOMATION_RECOMMENDATION'] : [])
  ];
  const notEvaluableReasonCodes = normalizeReasonCodes([
    ...metricReasonCodes,
    ...(!ruleIdentityValid || !thresholdValidation.valid || !unitMatches
      || !priorityValid || forbiddenRecommendation
      ? ['UNIT_NOT_COMPARABLE']
      : []),
    ...(!coverageRateValid || !actualValueValid || normalizedMetric.evaluable === false
      || dataRange === null || evidence.length === 0 || rawRecommendation === null
      ? ['NO_TIMESERIES_DATA']
      : [])
  ]);
  const thresholdEvaluation = notEvaluableReasonCodes.length === 0
    ? evaluateStrategyThreshold(normalizedMetric.value, normalizedThreshold)
    : {
      evaluable: false,
      matched: null
    };
  const matchStatus = thresholdEvaluation.evaluable
    ? thresholdEvaluation.matched ? 'matched' : 'not_matched'
    : 'not_evaluable';
  const reductionRate = normalizedThreshold.reductionRate;
  const savingBasis = normalizedRule.savingBasis || null;
  const totalEnergyUnit = typeof normalizedMetric.totalEnergyUnit === 'string'
    && normalizedMetric.totalEnergyUnit.trim() !== ''
    ? normalizedMetric.totalEnergyUnit
    : typeof normalizedMetric.sourceUnit === 'string' && normalizedMetric.sourceUnit.trim() !== ''
      ? normalizedMetric.sourceUnit
      : null;
  const savingAllowed = matchStatus === 'matched'
    && coverageRate === 1
    && normalizedMetric.totalEnergyComplete === true
    && Number.isFinite(normalizedMetric.totalEnergy)
    && normalizedMetric.totalEnergy >= 0
    && totalEnergyUnit !== null
    && savingBasis === 'window_total_energy'
    && Number.isFinite(reductionRate)
    && reductionRate > 0
    && reductionRate <= 1;
  const estimatedSaving = savingAllowed
    ? roundAnalysisValue(normalizedMetric.totalEnergy * reductionRate)
    : null;
  const evaluation = {
    ruleCode,
    ruleVersion,
    formulaVersion,
    matchStatus,
    reviewStatus: 'unconfirmed',
    threshold: normalizedThreshold,
    actualValue: matchStatus === 'not_evaluable'
      ? null
      : roundAnalysisValue(normalizedMetric.value),
    evidence,
    dataRange,
    coverageRate,
    priority: priorityValid ? normalizedRule.priority : 'medium',
    recommendation,
    savingBasis,
    estimatedSaving,
    estimatedSavingUnit: estimatedSaving === null ? null : totalEnergyUnit,
    reasonCodes: matchStatus === 'not_evaluable'
      ? (notEvaluableReasonCodes.length > 0 ? notEvaluableReasonCodes : ['NO_TIMESERIES_DATA'])
      : [],
    automationBoundary: { ...STRATEGY_AUTOMATION_BOUNDARY },
    usesAI: false,
    issuesControlCommand: false,
    changesDeviceState: false,
    requiresManualReview: true,
    errors: [...new Set(inputErrors)]
  };
  const contractValidation = validateRuleEvaluationContract(evaluation);
  if (contractValidation.valid) {
    return { ...evaluation, contractValidation };
  }

  const safeFailureEvaluation = {
    ...evaluation,
    ruleCode: 'UNSPECIFIED_STRATEGY_RULE',
    ruleVersion: ENERGY_ANALYSIS_VERSIONS.strategyRule,
    formulaVersion: ENERGY_ANALYSIS_VERSIONS.loadAnalysis,
    matchStatus: 'not_evaluable',
    actualValue: null,
    evidence: evidence.filter((item) => typeof item === 'string' && item.trim() !== ''),
    dataRange: dataRange || null,
    coverageRate: coverageRateValid ? coverageRate : 0,
    priority: 'medium',
    recommendation: '请人工复核指标证据后决定是否执行用能调整。',
    estimatedSaving: null,
    estimatedSavingUnit: null,
    reasonCodes: notEvaluableReasonCodes.length > 0
      ? notEvaluableReasonCodes
      : ['UNIT_NOT_COMPARABLE'],
    automationBoundary: { ...STRATEGY_AUTOMATION_BOUNDARY },
    usesAI: false,
    issuesControlCommand: false,
    changesDeviceState: false,
    requiresManualReview: true,
    errors: [...new Set([...inputErrors, ...contractValidation.errors, 'CONTRACT_SELF_CHECK_RECOVERED'])]
  };
  return {
    ...safeFailureEvaluation,
    contractValidation: validateRuleEvaluationContract(safeFailureEvaluation)
  };
}

/**
 * 计算同比或环比的绝对差额与相对变化率。
 * @param {*} currentValue 本期值。
 * @param {*} baseValue 基期值。
 * @param {string} comparisonType 比较类型。
 * @returns {object} 比较结果。
 */
function calculatePeriodComparison(currentValue, baseValue, comparisonType = 'period_over_period') {
  const currentValid = Number.isFinite(currentValue);
  const baseValid = Number.isFinite(baseValue);
  if (!currentValid || !baseValid) {
    return {
      value: null,
      comparisonType,
      currentValue: currentValid ? currentValue : null,
      baseValue: baseValid ? baseValue : null,
      absoluteDifference: null,
      changeRate: null,
      calculable: false,
      calculationStatus: currentValid ? 'base_missing' : 'current_missing',
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }

  const rawDifference = currentValue - baseValue;
  if (!Number.isFinite(rawDifference)) {
    return {
      value: null,
      comparisonType,
      currentValue,
      baseValue,
      absoluteDifference: null,
      changeRate: null,
      calculable: false,
      calculationStatus: 'numeric_overflow',
      reasonCodes: []
    };
  }

  const absoluteDifference = roundAnalysisValue(rawDifference);
  if (baseValue === 0) {
    return {
      value: null,
      comparisonType,
      currentValue,
      baseValue,
      absoluteDifference,
      changeRate: null,
      calculable: false,
      calculationStatus: 'base_zero',
      reasonCodes: ['UNIT_NOT_COMPARABLE']
    };
  }

  const rawChangeRate = rawDifference / Math.abs(baseValue);
  if (!Number.isFinite(rawChangeRate)) {
    return {
      value: null,
      comparisonType,
      currentValue,
      baseValue,
      absoluteDifference,
      changeRate: null,
      calculable: false,
      calculationStatus: 'numeric_overflow',
      reasonCodes: []
    };
  }

  const changeRate = roundAnalysisValue(rawChangeRate);
  return {
    value: changeRate,
    comparisonType,
    currentValue,
    baseValue,
    absoluteDifference,
    changeRate,
    calculable: true,
    calculationStatus: 'available',
    reasonCodes: []
  };
}

/**
 * 判断折标系数是否匹配能源、单位、状态和目标单位。
 * @param {*} factor 折标系数。
 * @param {*} record 能源记录。
 * @returns {boolean} 是否匹配基础范围。
 */
function isMatchingConversionFactor(factor, record) {
  return isPlainObject(factor)
    && factor.status === 'active'
    && factor.energyTypeCode === record.energyTypeCode
    && factor.sourceUnit === record.unit
    && factor.targetUnit === 'kgce'
    && Number.isFinite(factor.factorValue)
    && factor.factorValue > 0
    && isStrictCalendarDate(factor.effectiveStartDate)
    && isStrictCalendarDate(factor.effectiveEndDateExclusive)
    && factor.effectiveStartDate < factor.effectiveEndDateExclusive;
}

/**
 * 按本地日期选择唯一生效折标系数。
 * @param {object[]} factors 折标系数列表。
 * @param {*} record 能源记录。
 * @param {string} localDate 本地日期。
 * @returns {object} 系数选择结果。
 */
function selectConversionFactorForDate(factors, record, localDate) {
  const matches = factors.filter((factor) => (
    isMatchingConversionFactor(factor, record)
    && localDate >= factor.effectiveStartDate
    && localDate < factor.effectiveEndDateExclusive
  ));
  if (matches.length === 0) {
    return { factor: null, reasonCode: 'MISSING_CONVERSION_FACTOR' };
  }
  if (matches.length > 1) {
    return { factor: null, reasonCode: 'FACTOR_PERIOD_AMBIGUOUS' };
  }
  return { factor: matches[0], reasonCode: null };
}

/**
 * 返回 YYYY-MM 月份覆盖的全部日历日期。
 * @param {string} month 月份。
 * @returns {string[]} 日期列表。
 */
function listMonthDates(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return [];
  }
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const dayCount = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: dayCount }, (_unused, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

/**
 * 将月度值按整月唯一系数折算为 kgce/tce，月内换版直接判定歧义。
 * @param {*} record 月度能源记录。
 * @param {object[]} factors 折标系数。
 * @returns {object} 月度折标结果。
 */
function convertMonthlyValueToStandardCoal(record, factors) {
  const monthDates = listMonthDates(record.month);
  if (monthDates.length === 0) {
    return {
      value: null,
      kgce: null,
      tce: null,
      applications: [],
      reasonCodes: ['MISSING_CONVERSION_FACTOR']
    };
  }
  const selectedFactors = [];
  for (const localDate of monthDates) {
    const selection = selectConversionFactorForDate(factors, record, localDate);
    if (selection.reasonCode) {
      return {
        value: null,
        kgce: null,
        tce: null,
        applications: [],
        reasonCodes: [selection.reasonCode]
      };
    }
    selectedFactors.push(selection.factor);
  }
  const distinctFactors = [...new Set(selectedFactors)];
  if (distinctFactors.length !== 1) {
    return {
      value: null,
      kgce: null,
      tce: null,
      applications: [],
      reasonCodes: ['FACTOR_PERIOD_AMBIGUOUS']
    };
  }
  const factor = distinctFactors[0];
  const kgce = roundAnalysisValue(record.value * factor.factorValue);
  return {
    value: kgce,
    kgce,
    tce: roundAnalysisValue(kgce / 1000),
    sourceValue: record.value,
    applications: [{
      factorCode: factor.code,
      factorValue: factor.factorValue,
      sourceValue: record.value,
      kgce
    }],
    reasonCodes: []
  };
}

/**
 * 将时序记录按来源时区和系数有效期逐分钟分段折标。
 * @param {*} record 时序能源记录。
 * @param {object[]} factors 折标系数。
 * @returns {object} 时序折标结果。
 */
function convertTimeSeriesValueToStandardCoal(record, factors) {
  const validation = validateTimeIntervalContract(record);
  if (!validation.valid || !isFiniteNonNegativeNumber(record.value)) {
    return {
      value: null,
      kgce: null,
      tce: null,
      applications: [],
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }
  const bounds = resolveIntervalBounds(record);
  const formatter = createLocalDateTimeFormatter(record.sourceTimeZone);
  const totalMinutes = (bounds.endMs - bounds.startMs) / MINUTE_MS;
  const sourceValuePerMinute = record.value / totalMinutes;
  const applicationsByFactor = new Map();
  const reasonCodes = [];

  visitUtcMinutes(bounds.startMs, bounds.endMs, (minuteStartMs, minuteWeight) => {
    const localParts = getLocalTimeParts(minuteStartMs, formatter);
    const selection = localParts
      ? selectConversionFactorForDate(factors, record, localParts.localDate)
      : { factor: null, reasonCode: 'MISSING_CONVERSION_FACTOR' };
    if (selection.reasonCode) {
      reasonCodes.push(selection.reasonCode);
      return;
    }
    const current = applicationsByFactor.get(selection.factor) || { minutes: 0, sourceValue: 0 };
    current.minutes += minuteWeight;
    current.sourceValue += sourceValuePerMinute * minuteWeight;
    applicationsByFactor.set(selection.factor, current);
  });

  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  if (normalizedReasonCodes.length > 0) {
    return {
      value: null,
      kgce: null,
      tce: null,
      applications: [],
      reasonCodes: normalizedReasonCodes
    };
  }
  const applications = [...applicationsByFactor.entries()].map(([factor, allocation]) => {
    const sourceValue = roundAnalysisValue(allocation.sourceValue);
    return {
      factorCode: factor.code,
      factorValue: factor.factorValue,
      minutes: roundAnalysisValue(allocation.minutes),
      sourceValue,
      kgce: roundAnalysisValue(sourceValue * factor.factorValue)
    };
  });
  const kgce = roundAnalysisValue(applications.reduce((sum, item) => sum + item.kgce, 0));
  return {
    value: kgce,
    kgce,
    tce: roundAnalysisValue(kgce / 1000),
    sourceValue: record.value,
    applications,
    assumption: 'uniform_within_interval',
    reasonCodes: []
  };
}

/**
 * 按能源、单位和有效期执行折标。
 * @param {*} record 月度或时序能源记录。
 * @param {*} factors 折标系数列表。
 * @returns {object} kgce/tce 折标结果。
 */
function convertToStandardCoal(record, factors) {
  const factorList = Array.isArray(factors) ? factors : [];
  if (!isPlainObject(record) || !isFiniteNonNegativeNumber(record.value)) {
    return {
      value: null,
      kgce: null,
      tce: null,
      applications: [],
      reasonCodes: ['NO_TIMESERIES_DATA']
    };
  }
  if (record.month !== undefined) {
    return convertMonthlyValueToStandardCoal(record, factorList);
  }
  return convertTimeSeriesValueToStandardCoal(record, factorList);
}

/**
 * 判断对标定义和实际值上下文是否兼容。
 * @param {*} benchmark 对标定义。
 * @param {*} context 实际值上下文。
 * @returns {boolean} 是否兼容。
 */
function isBenchmarkComparable(benchmark, context) {
  if (!isPlainObject(benchmark) || !isPlainObject(context)) {
    return false;
  }
  if (!BENCHMARK_DIRECTIONS.includes(benchmark.direction)
    || benchmark.unit !== context.unit
    || benchmark.metricCode !== context.metricCode
    || benchmark.periodType !== context.periodType
    || benchmark.scope !== context.scope) {
    return false;
  }
  if (benchmark.effectiveStartDate || benchmark.effectiveEndDateExclusive) {
    if (!isStrictCalendarDate(context.date)
      || !isStrictCalendarDate(benchmark.effectiveStartDate)
      || !isStrictCalendarDate(benchmark.effectiveEndDateExclusive)
      || context.date < benchmark.effectiveStartDate
      || context.date >= benchmark.effectiveEndDateExclusive) {
      return false;
    }
  }
  if (benchmark.direction === 'range') {
    return Number.isFinite(benchmark.lowerBound)
      && Number.isFinite(benchmark.upperBound)
      && benchmark.lowerBound <= benchmark.upperBound;
  }
  return Number.isFinite(benchmark.targetValue);
}

/**
 * 按 lower_better、higher_better 或 range 方向执行能效对标。
 * @param {*} actualValue 实际值。
 * @param {*} benchmark 对标定义。
 * @param {*} context 实际值上下文。
 * @returns {object} 对标结果。
 */
function evaluateBenchmark(actualValue, benchmark, context) {
  if (!Number.isFinite(actualValue) || !isBenchmarkComparable(benchmark, context)) {
    return {
      value: null,
      comparable: false,
      met: null,
      actualValue: Number.isFinite(actualValue) ? actualValue : null,
      targetValue: null,
      absoluteDifference: null,
      differenceRatio: null,
      reasonCodes: ['UNIT_NOT_COMPARABLE']
    };
  }

  let met = false;
  let targetValue = null;
  let absoluteDifference = null;
  let differenceRatio = null;
  if (benchmark.direction === 'lower_better') {
    targetValue = benchmark.targetValue;
    met = actualValue <= targetValue;
    absoluteDifference = actualValue - targetValue;
    differenceRatio = targetValue === 0 ? null : absoluteDifference / Math.abs(targetValue);
  } else if (benchmark.direction === 'higher_better') {
    targetValue = benchmark.targetValue;
    met = actualValue >= targetValue;
    absoluteDifference = actualValue - targetValue;
    differenceRatio = targetValue === 0 ? null : absoluteDifference / Math.abs(targetValue);
  } else if (actualValue < benchmark.lowerBound) {
    targetValue = benchmark.lowerBound;
    absoluteDifference = actualValue - benchmark.lowerBound;
    differenceRatio = benchmark.lowerBound === 0 ? null : absoluteDifference / Math.abs(benchmark.lowerBound);
  } else if (actualValue > benchmark.upperBound) {
    targetValue = benchmark.upperBound;
    absoluteDifference = actualValue - benchmark.upperBound;
    differenceRatio = benchmark.upperBound === 0 ? null : absoluteDifference / Math.abs(benchmark.upperBound);
  } else {
    met = true;
    absoluteDifference = 0;
  }
  return {
    value: roundAnalysisValue(absoluteDifference),
    comparable: true,
    met,
    direction: benchmark.direction,
    actualValue,
    targetValue,
    lowerBound: benchmark.direction === 'range' ? benchmark.lowerBound : null,
    upperBound: benchmark.direction === 'range' ? benchmark.upperBound : null,
    absoluteDifference: roundAnalysisValue(absoluteDifference),
    differenceRatio: roundAnalysisValue(differenceRatio),
    reasonCodes: []
  };
}

/**
 * 判断来源映射是否具备非空引用。
 * @param {*} sourceMapping 来源映射。
 * @returns {boolean} 是否已映射。
 */
function hasSourceMapping(sourceMapping) {
  return isPlainObject(sourceMapping)
    && typeof sourceMapping.reference === 'string'
    && sourceMapping.reference.trim() !== '';
}

/**
 * 计算能流节点的流入减流出再减储能变化差额。
 * @param {*} input 节点计算输入。
 * @returns {object} 节点差额结果。
 */
function calculateEnergyFlowNodeDifference(input) {
  const normalizedInput = isPlainObject(input) ? input : {};
  const nodeCode = normalizedInput.nodeCode || null;
  const edges = Array.isArray(normalizedInput.edges) ? normalizedInput.edges : [];
  const storageChangeProvided = Object.prototype.hasOwnProperty.call(normalizedInput, 'storageChange');
  const storageChangeValid = !storageChangeProvided || Number.isFinite(normalizedInput.storageChange);
  const storageChange = storageChangeValid && storageChangeProvided ? normalizedInput.storageChange : 0;
  const incidentEdges = edges.filter((edge) => isPlainObject(edge)
    && (edge.fromNodeCode === nodeCode || edge.toNodeCode === nodeCode));
  const energyScope = resolveUniqueEnergyScope(incidentEdges);
  const requestedScopeMismatch = energyScope.valid
    && ((typeof normalizedInput.energyTypeCode === 'string'
      && normalizedInput.energyTypeCode !== energyScope.energyTypeCode)
      || (typeof normalizedInput.unit === 'string' && normalizedInput.unit !== energyScope.unit));
  const unmapped = incidentEdges.some((edge) => !hasSourceMapping(edge.sourceMapping));
  const invalidValue = incidentEdges.some((edge) => !Number.isFinite(edge.value));
  const reasonCodes = [];
  const errors = [];
  if (unmapped) {
    reasonCodes.push('TOPOLOGY_SOURCE_UNMAPPED');
  }
  if (!storageChangeValid) {
    reasonCodes.push('BALANCE_ITEM_UNMAPPED');
    errors.push('INVALID_STORAGE_CHANGE');
  }
  if (incidentEdges.length > 0 && (!energyScope.valid || requestedScopeMismatch)) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  if (!nodeCode || incidentEdges.length === 0 || invalidValue) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  }
  const normalizedReasonCodes = normalizeReasonCodes(reasonCodes);
  if (normalizedReasonCodes.length > 0) {
    return {
      value: null,
      energyTypeCode: energyScope.energyTypeCode,
      unit: energyScope.unit,
      energyScopes: energyScope.scopes,
      inflow: null,
      outflow: null,
      storageChange: storageChangeValid ? roundAnalysisValue(storageChange) : null,
      difference: null,
      autoClassifiedLoss: false,
      errors,
      reasonCodes: normalizedReasonCodes
    };
  }
  const inflow = incidentEdges
    .filter((edge) => edge.toNodeCode === nodeCode)
    .reduce((sum, edge) => sum + edge.value, 0);
  const outflow = incidentEdges
    .filter((edge) => edge.fromNodeCode === nodeCode)
    .reduce((sum, edge) => sum + edge.value, 0);
  const difference = inflow - outflow - storageChange;
  return {
    value: roundAnalysisValue(difference),
    energyTypeCode: energyScope.energyTypeCode,
    unit: energyScope.unit,
    energyScopes: energyScope.scopes,
    inflow: roundAnalysisValue(inflow),
    outflow: roundAnalysisValue(outflow),
    storageChange: roundAnalysisValue(storageChange),
    difference: roundAnalysisValue(difference),
    autoClassifiedLoss: false,
    errors: [],
    reasonCodes: []
  };
}

/**
 * 汇总指定角色的平衡项目值。
 * @param {object[]} items 平衡项目。
 * @param {string[]} roles 角色列表。
 * @returns {number} 汇总值。
 */
function sumBalanceRoles(items, roles) {
  return items
    .filter((item) => roles.includes(item.role))
    .reduce((sum, item) => sum + item.value, 0);
}

/**
 * 判断发电来源是否存在未确认或重复计入风险。
 * @param {object[]} items 平衡项目。
 * @param {*} options 平衡选项。
 * @returns {boolean} 是否存在边界风险。
 */
function hasGenerationBoundaryRisk(items, options) {
  const generationItems = items.filter((item) => item.sourceMapping.type === 'generation');
  if (generationItems.length === 0) {
    return false;
  }
  if (!isPlainObject(options) || options.generationBoundaryConfirmed !== true) {
    return true;
  }
  if (generationItems.some((item) => !['self_generation', 'output'].includes(item.role))) {
    return true;
  }
  const duplicateKeys = generationItems.map((item) => {
    const explicitGuardKey = typeof item.duplicateGuardKey === 'string' && item.duplicateGuardKey.trim() !== ''
      ? item.duplicateGuardKey
      : isPlainObject(item.sourceMapping)
        && typeof item.sourceMapping.duplicateGuardKey === 'string'
        && item.sourceMapping.duplicateGuardKey.trim() !== ''
        ? item.sourceMapping.duplicateGuardKey
        : null;
    return explicitGuardKey
      ? `guard:${explicitGuardKey}`
      : `reference:${item.sourceMapping.reference}`;
  });
  return new Set(duplicateKeys).size !== duplicateKeys.length;
}

/**
 * 计算能源平衡差额、利用率、损耗率和不平衡率。
 * @param {*} items 九类显式平衡项目。
 * @param {*} options 发电边界等选项。
 * @returns {object} 能源平衡结果。
 */
function calculateEnergyBalance(items, options = {}) {
  const itemList = Array.isArray(items) ? items : [];
  const energyScope = resolveUniqueEnergyScope(itemList);
  const roleValid = itemList.length > 0 && itemList.every((item) => (
    isPlainObject(item)
    && BALANCE_INPUT_ROLES.includes(item.role)
    && Number.isFinite(item.value)
  ));
  const mappingValid = roleValid && itemList.every((item) => (
    isPlainObject(item.sourceMapping)
    && BALANCE_SOURCE_TYPES.includes(item.sourceMapping.type)
    && hasSourceMapping(item.sourceMapping)
  ));
  const generationRisk = mappingValid && hasGenerationBoundaryRisk(itemList, options);
  const reasonCodes = [];
  if (!mappingValid) {
    reasonCodes.push('BALANCE_ITEM_UNMAPPED');
  }
  if (itemList.length > 0 && !energyScope.valid) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  if (generationRisk) {
    reasonCodes.push('GENERATION_BOUNDARY_UNCONFIRMED');
  }
  if (reasonCodes.length > 0) {
    return {
      value: null,
      energyTypeCode: energyScope.energyTypeCode,
      unit: energyScope.unit,
      energyScopes: energyScope.scopes,
      inputTotal: null,
      outputTotal: null,
      unexplainedDifference: null,
      utilizationRate: null,
      lossRate: null,
      imbalanceRate: null,
      autoClassifiedLoss: false,
      reasonCodes: normalizeReasonCodes(reasonCodes)
    };
  }

  const inputTotal = sumBalanceRoles(itemList, BALANCE_INBOUND_ROLES);
  const outputTotal = sumBalanceRoles(itemList, BALANCE_OUTBOUND_ROLES);
  const usefulUtilization = sumBalanceRoles(itemList, ['useful_utilization']);
  const knownLoss = sumBalanceRoles(itemList, ['known_loss']);
  const unexplainedDifference = inputTotal - outputTotal;
  const denominatorAvailable = inputTotal !== 0;
  return {
    value: roundAnalysisValue(unexplainedDifference),
    energyTypeCode: energyScope.energyTypeCode,
    unit: energyScope.unit,
    energyScopes: energyScope.scopes,
    inputTotal: roundAnalysisValue(inputTotal),
    outputTotal: roundAnalysisValue(outputTotal),
    unexplainedDifference: roundAnalysisValue(unexplainedDifference),
    utilizationRate: denominatorAvailable ? roundAnalysisValue(usefulUtilization / inputTotal) : null,
    lossRate: denominatorAvailable ? roundAnalysisValue(knownLoss / inputTotal) : null,
    imbalanceRate: denominatorAvailable
      ? roundAnalysisValue(Math.abs(unexplainedDifference) / Math.abs(inputTotal))
      : null,
    autoClassifiedLoss: false,
    reasonCodes: denominatorAvailable ? [] : ['UNIT_NOT_COMPARABLE']
  };
}

module.exports = {
  FIXED_UTC_OUTPUT_INTERVAL_MINUTES,
  allocateEnergyByUtcOverlap,
  allocateEnergyToActualShifts,
  allocateEnergyToShifts,
  allocateTimeOfUseEnergy,
  analyzeTimeSeriesQuality,
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
  isEnergyAnalysisTimeZone,
  isSupportedLocalTimeProjectionRange,
  projectFixedUtcBucketsToLocalHeatmap,
  roundAnalysisValue,
  splitTimeOfUseEnergy,
  summarizeDeviceStateCoverage
};
