'use strict';

// 时间区间统一采用左闭右开语义。
const TIME_INTERVAL_BOUNDARY = '[startUtc,endUtc)';

// 时序数据首期支持的分钟粒度。
const SUPPORTED_INTERVAL_MINUTES = Object.freeze([15, 30, 60]);

// IANA 时区验证缓存固定上限，按插入顺序淘汰最早结果。
const IANA_TIME_ZONE_CACHE_LIMIT = 128;

// IANA 时区验证结果缓存，避免大批量同来源记录重复创建 Intl formatter。
const ianaTimeZoneValidationCache = new Map();

// 设备状态白名单，缺口按 unknown 语义处理但不得伪造状态记录。
const DEVICE_STATES = Object.freeze(['running', 'idle', 'stopped', 'offline', 'unknown']);

// 峰平谷时段类型白名单。
const TIME_OF_USE_PERIOD_TYPES = Object.freeze(['peak', 'flat', 'valley']);

// 折标系数状态白名单。
const CONVERSION_FACTOR_STATUSES = Object.freeze(['active', 'inactive']);

// 能效对标类型白名单。
const BENCHMARK_TYPES = Object.freeze(['external_standard', 'manual_benchmark', 'internal_history_baseline']);

// 能效对标方向白名单。
const BENCHMARK_DIRECTIONS = Object.freeze(['lower_better', 'higher_better', 'range']);

// 能流节点类型白名单。
const ENERGY_FLOW_NODE_TYPES = Object.freeze(['source', 'process', 'storage', 'sink', 'loss', 'boundary']);

// 能流边来源类型白名单。
const ENERGY_FLOW_SOURCE_TYPES = Object.freeze([
  'timeseries',
  'monthly_energy',
  'generation',
  'explicit_edge_value'
]);

// 平衡项目来源类型白名单，显式值与既有领域来源均需可追溯。
const BALANCE_SOURCE_TYPES = Object.freeze([
  'timeseries',
  'monthly_energy',
  'generation',
  'explicit_edge_value',
  'explicit_balance_value'
]);

// 平衡项目角色白名单，不包含由公式计算的不可解释差额。
const BALANCE_INPUT_ROLES = Object.freeze([
  'input',
  'self_generation',
  'inventory_decrease',
  'adjustment_increase',
  'output',
  'useful_utilization',
  'known_loss',
  'inventory_increase',
  'adjustment_decrease'
]);

// 本地确定性规则匹配状态白名单。
const RULE_MATCH_STATUSES = Object.freeze(['matched', 'not_matched', 'not_evaluable']);

// 规则建议人工处理状态白名单。
const MANUAL_HANDLING_STATUSES = Object.freeze(['unconfirmed', 'accepted', 'rejected', 'resolved']);

// 规则建议优先级白名单。
const RULE_PRIORITIES = Object.freeze(['low', 'medium', 'high']);

// 规则阈值操作符白名单。
const RULE_THRESHOLD_OPERATORS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'between']);

// 策略自动化边界必须精确包含的字段。
const STRATEGY_AUTOMATION_BOUNDARY_KEYS = Object.freeze([
  'usesAI',
  'issuesControlCommand',
  'changesDeviceState',
  'requiresManualReview'
]);

// 明确宣称自动执行或自动下发控制的建议文本禁止模式。
const FORBIDDEN_AUTOMATION_RECOMMENDATION_PATTERNS = Object.freeze([
  /AI\s*(?:已|将|会)?自动(?:执行|调整|控制|下发)/i,
  /(?:已|将|会)?自动(?:下发|发送|执行)(?:控制|指令|命令)/,
  /\bAI\s+(?:has\s+|will\s+)?automatically\s+(?:execute|executed|apply|applied|control|controlled)\b/i,
  /\bautomatically\s+(?:issue|issued|send|sent|execute|executed)\b.{0,16}\b(?:control|command)\b/i,
  /\b(?:changed|changes|will\s+change)\s+(?:the\s+)?device\s+state\b/i
]);

// 控制主体与实际设备动作组合出现时，即使未写“自动”也视为控制承诺。
const AUTOMATION_CONTROL_SUBJECT_ACTION_PATTERN = /(?:AI|系统|平台|程序|服务)(?:已|将|会)?[^。！？；;\n]{0,24}(?:下发(?:控制(?:指令|命令)?|指令|命令)|执行(?:控制(?:指令|命令)?|(?:设备|装置)?启停)|远程控制(?:设备|装置)?|(?:启停|开启|关闭)(?:设备|装置)|切换(?:设备|装置)(?:运行)?状态|(?:改变|修改)(?:实际)?(?:设备|装置)状态(?!记录))/i;

// 无主体的明确实际设备状态改变承诺仍需禁止，但“设备状态记录”属于数据维护。
const AUTOMATION_DEVICE_STATE_ACTION_PATTERN = /(?:已|将|会)?(?:自动)?(?:改变|切换|修改)(?:实际)?(?:设备)?状态(?!记录)/;

// 阶段 1 冻结的数据质量原因码。
const ENERGY_ANALYSIS_REASON_CODES = Object.freeze([
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
]);

// 四板块共享的稳定契约和公式版本标识。
const ENERGY_ANALYSIS_VERSIONS = Object.freeze({
  contract: 'energy-analysis-contract:v1',
  loadAnalysis: 'load-analysis:v1',
  conversion: 'standard-coal-conversion:v1',
  benchmark: 'energy-benchmark:v1',
  energyFlow: 'energy-flow:v1',
  balance: 'energy-balance:v1',
  strategyRule: 'strategy-rule:v1'
});

// 严格 UTC ISO 时间戳格式，必须显式携带 Z。
const STRICT_UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// N8 能流输入只允许秒精度或可无损折叠的零毫秒。
const ENERGY_FLOW_UTC_SECOND_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/;
// N8 模型、节点和边稳定编码只接受首字符为字母或数字的受控 ASCII。
const ENERGY_FLOW_IDENTITY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// N8 模型版本使用独立受控 ASCII 合同，长度与 schema.sql 的 1..64 字符约束一致。
const ENERGY_FLOW_MODEL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// IANA 来源时区格式，要求区域与地点分段。
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)+$/;

// 日期字段采用严格 YYYY-MM-DD 格式。
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 稳定版本标识采用 name:v1 格式。
const VERSION_PATTERN = /^[a-z][a-z0-9-]*:v1$/;

/**
 * 构造不抛异常的稳定验证结果。
 * @param {string[]} errors 验证错误码列表。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function createValidationResult(errors) {
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)]
  };
}

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判断值是否为非空字符串。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为非空字符串。
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 判断普通对象是否至少包含一个键。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为非空普通对象。
 */
function isNonEmptyPlainObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

/**
 * 判断普通对象是否只包含指定键集合。
 * @param {*} value 待判断对象。
 * @param {string[]} expectedKeys 预期键集合。
 * @returns {boolean} 是否精确匹配。
 */
function hasExactObjectKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

/**
 * 判断值是否为严格 UTC ISO 时间戳。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isStrictUtcIso(value) {
  if (typeof value !== 'string' || !STRICT_UTC_ISO_PATTERN.test(value)) {
    return false;
  }

  const timeValue = Date.parse(value);
  if (!Number.isFinite(timeValue)) {
    return false;
  }

  const canonicalValue = new Date(timeValue).toISOString();
  return value.includes('.') ? canonicalValue === value : canonicalValue.replace('.000Z', 'Z') === value;
}

/**
 * 将 N8 能流稳定键规范化为 trim + Unicode NFKC + 大写比较值。
 * @param {*} value 待规范化值。
 * @returns {string|null} 规范比较键。
 */
function normalizeEnergyFlowKey(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim().normalize('NFKC').toUpperCase();
}

/**
 * 校验并规范 N8 模型、节点和边稳定编码，同时返回显示值和规范比较键。
 * @param {*} value 待校验编码。
 * @returns {{valid:boolean,value:string|null,key:string|null,errorCode:string|null}} 稳定校验结果。
 */
function validateAndNormalizeEnergyFlowIdentityCode(value) {
  if (value === null || value === undefined) {
    return {
      valid: false,
      value: null,
      key: null,
      errorCode: 'REQUIRED_FIELD_MISSING'
    };
  }
  const displayValue = String(value).trim();
  const normalizedKey = normalizeEnergyFlowKey(displayValue);
  if (!displayValue || !normalizedKey) {
    return {
      valid: false,
      value: null,
      key: null,
      errorCode: 'REQUIRED_FIELD_MISSING'
    };
  }
  if (!ENERGY_FLOW_IDENTITY_CODE_PATTERN.test(displayValue)) {
    return {
      valid: false,
      value: displayValue,
      key: normalizedKey,
      errorCode: 'INVALID_ENERGY_FLOW_IDENTITY'
    };
  }
  return {
    valid: true,
    value: displayValue,
    key: normalizedKey,
    errorCode: null
  };
}

/**
 * 将 N8 模型版本规范为 trim + Unicode NFKC + 大写比较值。
 * @param {*} value 待规范化模型版本。
 * @returns {string|null} 模型版本规范比较键。
 */
function normalizeEnergyFlowModelVersionKey(value) {
  return normalizeEnergyFlowKey(value);
}

/**
 * 校验并规范 N8 模型版本，保留 trim 后 ASCII 显示值和 NFKC 大写比较键。
 * @param {*} value 待校验模型版本。
 * @returns {{valid:boolean,value:string|null,key:string|null,errorCode:string|null}} 稳定校验结果。
 */
function validateAndNormalizeEnergyFlowModelVersion(value) {
  if (value === null || value === undefined) {
    return {
      valid: false,
      value: null,
      key: null,
      errorCode: 'REQUIRED_FIELD_MISSING'
    };
  }
  const displayValue = String(value).trim();
  const normalizedKey = normalizeEnergyFlowModelVersionKey(displayValue);
  if (!displayValue || !normalizedKey) {
    return {
      valid: false,
      value: null,
      key: null,
      errorCode: 'REQUIRED_FIELD_MISSING'
    };
  }
  if (!ENERGY_FLOW_MODEL_VERSION_PATTERN.test(displayValue)) {
    return {
      valid: false,
      value: displayValue,
      key: normalizedKey,
      errorCode: 'INVALID_ENERGY_FLOW_MODEL_VERSION'
    };
  }
  return {
    valid: true,
    value: displayValue,
    key: normalizedKey,
    errorCode: null
  };
}

/**
 * 将 N8 能流 UTC 时间规范为严格秒精度，零毫秒无损折叠为 Z。
 * @param {*} value 待规范化值。
 * @returns {string|null} 秒精度 UTC 时间；非法或非零毫秒返回 null。
 */
function normalizeEnergyFlowUtcSecond(value) {
  if (typeof value !== 'string' || !ENERGY_FLOW_UTC_SECOND_INPUT_PATTERN.test(value)) {
    return null;
  }
  const normalizedValue = value.endsWith('.000Z')
    ? `${value.slice(0, -5)}Z`
    : value;
  const timeValue = Date.parse(normalizedValue);
  if (!Number.isFinite(timeValue)) {
    return null;
  }
  const canonicalValue = new Date(timeValue).toISOString().replace('.000Z', 'Z');
  return canonicalValue === normalizedValue ? normalizedValue : null;
}

/**
 * 判断值是否符合 N8 能流 UTC 秒精度合同。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否可规范为秒精度 UTC。
 */
function isEnergyFlowUtcSecond(value) {
  const normalizedValue = normalizeEnergyFlowUtcSecond(value);
  return normalizedValue !== null && normalizedValue === value;
}

/**
 * 判断值是否为真实存在的严格日历日期。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isStrictCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }

  const dateValue = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(dateValue) && new Date(dateValue).toISOString().slice(0, 10) === value;
}

/**
 * 写入 IANA 时区稳定校验结果，并按插入顺序淘汰最早缓存项。
 * @param {string} value IANA 时区文本。
 * @param {'valid'|'invalid'} status 可安全缓存的稳定结果。
 */
function cacheIanaTimeZoneValidationStatus(value, status) {
  if (ianaTimeZoneValidationCache.size >= IANA_TIME_ZONE_CACHE_LIMIT) {
    const oldestKey = ianaTimeZoneValidationCache.keys().next().value;
    ianaTimeZoneValidationCache.delete(oldestKey);
  }
  ianaTimeZoneValidationCache.set(value, status);
}

/**
 * 详细验证 IANA 时区，区分明确非法与运行时校验故障。
 * @param {*} value 待验证值。
 * @returns {{ status: 'valid'|'invalid'|'validation_failed' }} 校验状态。
 */
function validateIanaTimeZone(value) {
  if (typeof value !== 'string' || !IANA_TIME_ZONE_PATTERN.test(value)) {
    return { status: 'invalid' };
  }
  if (ianaTimeZoneValidationCache.has(value)) {
    return { status: ianaTimeZoneValidationCache.get(value) };
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch (error) {
    if (error instanceof RangeError) {
      cacheIanaTimeZoneValidationStatus(value, 'invalid');
      return { status: 'invalid' };
    }
    return { status: 'validation_failed' };
  }

  try {
    formatter.format(new Date(0));
  } catch (_error) {
    return { status: 'validation_failed' };
  }

  cacheIanaTimeZoneValidationStatus(value, 'valid');
  return { status: 'valid' };
}

/**
 * 判断值是否为可识别的 IANA 时区，保持公共 boolean 兼容契约。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isIanaTimeZone(value) {
  return validateIanaTimeZone(value).status === 'valid';
}

/**
 * 向错误列表追加严格有效期校验结果。
 * @param {string[]} errors 错误列表。
 * @param {*} startDate 有效期开始日期。
 * @param {*} endDateExclusive 有效期结束日期。
 * @param {string} invalidDateCode 非法日期错误码。
 * @param {string} invalidRangeCode 非法范围错误码。
 */
function appendDateRangeErrors(errors, startDate, endDateExclusive, invalidDateCode, invalidRangeCode) {
  if (!isStrictCalendarDate(startDate) || !isStrictCalendarDate(endDateExclusive)) {
    errors.push(invalidDateCode);
  } else if (startDate >= endDateExclusive) {
    errors.push(invalidRangeCode);
  }
}

/**
 * 验证单条左闭右开时序记录及持续时间粒度。
 * @param {*} interval 时间区间契约。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateTimeIntervalContract(interval) {
  const errors = [];
  if (!isPlainObject(interval)) {
    return createValidationResult(['INVALID_TIME_INTERVAL']);
  }

  const startValid = isStrictUtcIso(interval.startUtc);
  const endValid = isStrictUtcIso(interval.endUtc);
  const granularitySupported = SUPPORTED_INTERVAL_MINUTES.includes(interval.granularityMinutes);

  if (!startValid) {
    errors.push('INVALID_START_UTC');
  }
  if (!endValid) {
    errors.push('INVALID_END_UTC');
  }
  if (!isIanaTimeZone(interval.sourceTimeZone)) {
    errors.push('INVALID_SOURCE_TIME_ZONE');
  }
  if (!granularitySupported) {
    errors.push('UNSUPPORTED_GRANULARITY_MINUTES');
  }

  if (startValid && endValid) {
    const startTime = Date.parse(interval.startUtc);
    const endTime = Date.parse(interval.endUtc);
    if (startTime >= endTime) {
      errors.push('INVALID_HALF_OPEN_RANGE');
    }
    if (startTime % 60000 !== 0 || endTime % 60000 !== 0) {
      errors.push('INTERVAL_BOUNDARY_NOT_WHOLE_MINUTE');
    }
    if (startTime < endTime && granularitySupported
      && endTime - startTime !== interval.granularityMinutes * 60 * 1000) {
      errors.push('INTERVAL_DURATION_MISMATCH');
    }
  }

  return createValidationResult(errors);
}

/**
 * 验证峰平谷规则的版本、时区、有效期、星期和全天连续时段。
 * @param {*} rule 峰平谷规则。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateTimeOfUseRuleContract(rule) {
  const errors = [];
  if (!isPlainObject(rule)) {
    return createValidationResult(['INVALID_TIME_OF_USE_RULE']);
  }

  if (!VERSION_PATTERN.test(rule.version || '')) {
    errors.push('INVALID_TIME_OF_USE_VERSION');
  }
  if (!isIanaTimeZone(rule.sourceTimeZone)) {
    errors.push('INVALID_SOURCE_TIME_ZONE');
  }
  appendDateRangeErrors(
    errors,
    rule.effectiveStartDate,
    rule.effectiveEndDateExclusive,
    'INVALID_EFFECTIVE_DATE',
    'INVALID_EFFECTIVE_RANGE'
  );

  const daysOfWeek = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek : [];
  if (daysOfWeek.length === 0
    || daysOfWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    errors.push('INVALID_DAYS_OF_WEEK');
  }
  if (new Set(daysOfWeek).size !== daysOfWeek.length) {
    errors.push('DUPLICATE_DAY_OF_WEEK');
  }

  if (!Array.isArray(rule.periods) || rule.periods.length === 0) {
    errors.push('MISSING_TIME_OF_USE_PERIODS');
    return createValidationResult(errors);
  }

  const validPeriods = [];
  rule.periods.forEach((period) => {
    if (!isPlainObject(period)) {
      errors.push('INVALID_TIME_OF_USE_PERIOD');
      return;
    }
    if (!TIME_OF_USE_PERIOD_TYPES.includes(period.type)) {
      errors.push('INVALID_TIME_OF_USE_PERIOD_TYPE');
    }
    if (!Number.isInteger(period.startMinute) || !Number.isInteger(period.endMinute)
      || period.startMinute < 0 || period.startMinute > 1440
      || period.endMinute < 0 || period.endMinute > 1440) {
      errors.push('INVALID_TIME_OF_USE_PERIOD_RANGE');
      return;
    }
    if (period.startMinute >= period.endMinute) {
      errors.push('CROSS_MIDNIGHT_TIME_OF_USE_PERIOD_UNSUPPORTED');
      return;
    }
    validPeriods.push(period);
  });

  if (validPeriods.length !== rule.periods.length) {
    return createValidationResult(errors);
  }

  const sortedPeriods = [...validPeriods].sort((left, right) => left.startMinute - right.startMinute);
  if (sortedPeriods[0].startMinute !== 0) {
    errors.push('TIME_OF_USE_PERIODS_MUST_START_AT_ZERO');
  }
  for (let index = 1; index < sortedPeriods.length; index += 1) {
    const previousPeriod = sortedPeriods[index - 1];
    const currentPeriod = sortedPeriods[index];
    if (currentPeriod.startMinute < previousPeriod.endMinute) {
      errors.push('TIME_OF_USE_PERIOD_OVERLAP');
    } else if (currentPeriod.startMinute > previousPeriod.endMinute) {
      errors.push('TIME_OF_USE_PERIOD_GAP');
    }
  }
  if (sortedPeriods[sortedPeriods.length - 1].endMinute !== 1440) {
    errors.push('TIME_OF_USE_PERIODS_MUST_END_AT_1440');
  }

  return createValidationResult(errors);
}

/**
 * 验证折标系数的编码、状态、目标单位、来源、版本和有效期。
 * @param {*} factor 折标系数契约。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateConversionFactorContract(factor) {
  const errors = [];
  if (!isPlainObject(factor)) {
    return createValidationResult(['INVALID_CONVERSION_FACTOR']);
  }

  if (!isNonEmptyString(factor.code)) {
    errors.push('MISSING_FACTOR_CODE');
  }
  if (!isNonEmptyString(factor.energyTypeCode) || !isNonEmptyString(factor.sourceUnit)) {
    errors.push('MISSING_FACTOR_SCOPE');
  }
  if (!Number.isFinite(factor.factorValue) || factor.factorValue <= 0) {
    errors.push('INVALID_FACTOR_VALUE');
  }
  if (factor.targetUnit !== 'kgce') {
    errors.push('INVALID_FACTOR_TARGET_UNIT');
  }
  if (!isNonEmptyString(factor.source) || !isNonEmptyString(factor.documentNo)) {
    errors.push('MISSING_FACTOR_SOURCE');
  }
  if (!VERSION_PATTERN.test(factor.version || '')) {
    errors.push('INVALID_FACTOR_VERSION');
  }
  if (!CONVERSION_FACTOR_STATUSES.includes(factor.status)) {
    errors.push('INVALID_FACTOR_STATUS');
  }
  appendDateRangeErrors(
    errors,
    factor.effectiveStartDate,
    factor.effectiveEndDateExclusive,
    'INVALID_EFFECTIVE_DATE',
    'INVALID_EFFECTIVE_RANGE'
  );

  return createValidationResult(errors);
}

/**
 * 验证对标定义类型、方向、范围和对应来源字段。
 * @param {*} benchmark 对标定义。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateBenchmarkContract(benchmark) {
  const errors = [];
  if (!isPlainObject(benchmark)) {
    return createValidationResult(['INVALID_BENCHMARK']);
  }

  if (!BENCHMARK_TYPES.includes(benchmark.type)) {
    errors.push('INVALID_BENCHMARK_TYPE');
  }
  if (!BENCHMARK_DIRECTIONS.includes(benchmark.direction)) {
    errors.push('INVALID_BENCHMARK_DIRECTION');
  }
  if (!isNonEmptyString(benchmark.metricCode) || !isNonEmptyString(benchmark.unit)
    || !isNonEmptyString(benchmark.periodType) || !isNonEmptyString(benchmark.scope)) {
    errors.push('MISSING_BENCHMARK_SCOPE');
  }
  if (benchmark.direction === 'range') {
    if (!Number.isFinite(benchmark.lowerBound) || !Number.isFinite(benchmark.upperBound)
      || benchmark.lowerBound > benchmark.upperBound) {
      errors.push('INVALID_BENCHMARK_RANGE');
    }
  } else if (BENCHMARK_DIRECTIONS.includes(benchmark.direction) && !Number.isFinite(benchmark.targetValue)) {
    errors.push('INVALID_BENCHMARK_TARGET');
  }

  if (benchmark.type === 'external_standard' || benchmark.type === 'manual_benchmark') {
    if (!isNonEmptyString(benchmark.source)) {
      errors.push('MISSING_BENCHMARK_SOURCE');
    }
    appendDateRangeErrors(
      errors,
      benchmark.effectiveStartDate,
      benchmark.effectiveEndDateExclusive,
      'INVALID_EFFECTIVE_DATE',
      'INVALID_EFFECTIVE_RANGE'
    );
  }

  if (benchmark.type === 'internal_history_baseline') {
    appendDateRangeErrors(
      errors,
      benchmark.referencePeriodStart,
      benchmark.referencePeriodEndExclusive,
      'INVALID_REFERENCE_PERIOD_DATE',
      'INVALID_REFERENCE_PERIOD_RANGE'
    );
    if (!Number.isFinite(benchmark.frozenValue) || !isStrictUtcIso(benchmark.frozenAt)
      || benchmark.frozen !== true || benchmark.autoRefresh !== false
      || !isNonEmptyString(benchmark.sourceDataDigest)
      || benchmark.targetValue !== benchmark.frozenValue) {
      errors.push('INVALID_INTERNAL_BASELINE_SNAPSHOT');
    }
    if (Object.prototype.hasOwnProperty.call(benchmark, 'sampleMonthCount')
      && (!Number.isInteger(benchmark.sampleMonthCount) || benchmark.sampleMonthCount <= 0)) {
      errors.push('INVALID_INTERNAL_BASELINE_SAMPLE_COUNT');
    }
    if (Object.prototype.hasOwnProperty.call(benchmark, 'productionSummary')) {
      if (!isPlainObject(benchmark.productionSummary)
        || Object.values(benchmark.productionSummary).some((value) => (
          typeof value === 'number' && !Number.isFinite(value)
        ))) {
        errors.push('INVALID_INTERNAL_BASELINE_PRODUCTION_SUMMARY');
      }
    }
  }

  return createValidationResult(errors);
}

/**
 * 验证显式能流模型的编码、节点、边、能源、单位和来源映射。
 * @param {*} model 能流模型。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateEnergyFlowModelContract(model) {
  const errors = [];
  if (!isPlainObject(model)) {
    return createValidationResult(['INVALID_ENERGY_FLOW_MODEL']);
  }

  if (!validateAndNormalizeEnergyFlowIdentityCode(model.modelCode).valid) {
    errors.push('INVALID_ENERGY_FLOW_MODEL_IDENTITY');
  }
  if (!validateAndNormalizeEnergyFlowModelVersion(model.version).valid) {
    errors.push('INVALID_ENERGY_FLOW_MODEL_VERSION');
  }

  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  const edges = Array.isArray(model.edges) ? model.edges : [];
  if (!Array.isArray(model.nodes) || nodes.length === 0) {
    errors.push('MISSING_ENERGY_FLOW_NODES');
  }
  if (!Array.isArray(model.edges) || edges.length === 0) {
    errors.push('MISSING_ENERGY_FLOW_EDGES');
  }

  const nodeCodes = new Set();
  nodes.forEach((node) => {
    if (!isPlainObject(node)) {
      errors.push('INVALID_ENERGY_FLOW_NODE');
      return;
    }
    if (!isNonEmptyString(node.code) || nodeCodes.has(node.code)) {
      errors.push('INVALID_OR_DUPLICATE_NODE_CODE');
    } else {
      nodeCodes.add(node.code);
    }
    if (!ENERGY_FLOW_NODE_TYPES.includes(node.type)) {
      errors.push('INVALID_ENERGY_FLOW_NODE_TYPE');
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      errors.push('INVALID_ENERGY_FLOW_NODE_COORDINATE');
    }
  });

  const edgeCodes = new Set();
  edges.forEach((edge) => {
    if (!isPlainObject(edge)) {
      errors.push('INVALID_ENERGY_FLOW_EDGE');
      return;
    }
    if (!isNonEmptyString(edge.code) || edgeCodes.has(edge.code)) {
      errors.push('INVALID_OR_DUPLICATE_EDGE_CODE');
    } else {
      edgeCodes.add(edge.code);
    }
    if (!nodeCodes.has(edge.fromNodeCode) || !nodeCodes.has(edge.toNodeCode)) {
      errors.push('INVALID_ENERGY_FLOW_EDGE_ENDPOINT');
    } else if (edge.fromNodeCode === edge.toNodeCode) {
      errors.push('ENERGY_FLOW_SELF_LOOP_UNSUPPORTED');
    }
    if (!isNonEmptyString(edge.energyTypeCode) || !isNonEmptyString(edge.unit)) {
      errors.push('MISSING_ENERGY_FLOW_EDGE_SCOPE');
    }
    if (!ENERGY_FLOW_SOURCE_TYPES.includes(edge.sourceType)) {
      errors.push('INVALID_ENERGY_FLOW_SOURCE_TYPE');
    }
    if (!isPlainObject(edge.sourceMapping)
      || !isNonEmptyString(edge.sourceMapping.reference)) {
      errors.push('TOPOLOGY_SOURCE_UNMAPPED');
    }
  });

  return createValidationResult(errors);
}

/**
 * 验证平衡项目只使用批准角色且均有显式来源映射。
 * @param {*} items 平衡项目列表。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateBalanceItemsContract(items) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) {
    return createValidationResult(['MISSING_BALANCE_ITEMS']);
  }

  items.forEach((item) => {
    if (!isPlainObject(item)) {
      errors.push('INVALID_BALANCE_ITEM');
      return;
    }
    if (!BALANCE_INPUT_ROLES.includes(item.role)) {
      errors.push('INVALID_BALANCE_ROLE');
    }
    if (!isNonEmptyString(item.energyTypeCode) || !isNonEmptyString(item.unit) || !Number.isFinite(item.value)) {
      errors.push('INVALID_BALANCE_ITEM_VALUE');
    }
    if (!hasExactObjectKeys(item.sourceMapping, ['type', 'reference'])
      || !BALANCE_SOURCE_TYPES.includes(item.sourceMapping.type)
      || !isNonEmptyString(item.sourceMapping.reference)) {
      errors.push('BALANCE_ITEM_UNMAPPED');
    }
  });

  return createValidationResult(errors);
}

/**
 * 验证规则输出中的统计范围对象。
 * @param {*} dataRange 统计范围。
 * @returns {boolean} 是否有效。
 */
function isValidRuleDataRange(dataRange) {
  if (!isPlainObject(dataRange) || !isStrictUtcIso(dataRange.startUtc)
    || !isStrictUtcIso(dataRange.endUtc) || !isIanaTimeZone(dataRange.sourceTimeZone)) {
    return false;
  }
  return Date.parse(dataRange.startUtc) < Date.parse(dataRange.endUtc);
}

/**
 * 向错误列表追加规则阈值结构校验结果。
 * @param {string[]} errors 错误列表。
 * @param {*} threshold 规则阈值。
 */
function appendRuleThresholdErrors(errors, threshold) {
  if (!isPlainObject(threshold)) {
    errors.push('INVALID_RULE_THRESHOLD');
    return;
  }
  if (!RULE_THRESHOLD_OPERATORS.includes(threshold.operator)) {
    errors.push('INVALID_RULE_THRESHOLD_OPERATOR');
  }
  if (!isNonEmptyString(threshold.unit)) {
    errors.push('INVALID_RULE_THRESHOLD_UNIT');
  }
  if (threshold.operator === 'between') {
    if (!Number.isFinite(threshold.min) || !Number.isFinite(threshold.max)
      || threshold.min > threshold.max) {
      errors.push('INVALID_RULE_THRESHOLD_RANGE');
    }
  } else if (RULE_THRESHOLD_OPERATORS.includes(threshold.operator)
    && !Number.isFinite(threshold.value)) {
    errors.push('INVALID_RULE_THRESHOLD_VALUE');
  }
  if (Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')
    && (!Number.isFinite(threshold.reductionRate)
      || threshold.reductionRate <= 0 || threshold.reductionRate > 1)) {
    errors.push('INVALID_RULE_REDUCTION_RATE');
  }
}

/**
 * 按规则阈值操作符判断实际值是否匹配。
 * @param {number} actualValue 实际值。
 * @param {object} threshold 已通过结构验证的阈值。
 * @returns {boolean|null} 匹配结果，结构不足时为 null。
 */
function evaluateRuleThresholdMatch(actualValue, threshold) {
  if (!Number.isFinite(actualValue) || !isPlainObject(threshold)) {
    return null;
  }
  if (threshold.operator === 'gt' && Number.isFinite(threshold.value)) {
    return actualValue > threshold.value;
  }
  if (threshold.operator === 'gte' && Number.isFinite(threshold.value)) {
    return actualValue >= threshold.value;
  }
  if (threshold.operator === 'lt' && Number.isFinite(threshold.value)) {
    return actualValue < threshold.value;
  }
  if (threshold.operator === 'lte' && Number.isFinite(threshold.value)) {
    return actualValue <= threshold.value;
  }
  if (threshold.operator === 'between'
    && Number.isFinite(threshold.min)
    && Number.isFinite(threshold.max)
    && threshold.min <= threshold.max) {
    return actualValue >= threshold.min && actualValue <= threshold.max;
  }
  return null;
}

/**
 * 统一判断建议文本是否包含明确的自动执行或设备控制承诺，供正式契约与 builder 共用。
 * @param {*} recommendation 建议文本。
 * @returns {boolean} 是否包含禁止承诺。
 */
function hasForbiddenAutomationRecommendation(recommendation) {
  if (!isNonEmptyString(recommendation)) {
    return false;
  }
  if (AUTOMATION_CONTROL_SUBJECT_ACTION_PATTERN.test(recommendation)) {
    return true;
  }
  if (FORBIDDEN_AUTOMATION_RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(recommendation))) {
    return true;
  }
  return AUTOMATION_DEVICE_STATE_ACTION_PATTERN.test(recommendation);
}

/**
 * 验证策略自动化边界及其顶层镜像字段。
 * @param {string[]} errors 错误列表。
 * @param {*} evaluation 规则评价。
 */
function appendStrategyAutomationBoundaryErrors(errors, evaluation) {
  const boundary = evaluation.automationBoundary;
  if (!hasExactObjectKeys(boundary, STRATEGY_AUTOMATION_BOUNDARY_KEYS)
    || boundary.usesAI !== false
    || boundary.issuesControlCommand !== false
    || boundary.changesDeviceState !== false
    || boundary.requiresManualReview !== true
    || evaluation.usesAI !== false
    || evaluation.issuesControlCommand !== false
    || evaluation.changesDeviceState !== false
    || evaluation.requiresManualReview !== true) {
    errors.push('INVALID_STRATEGY_AUTOMATION_BOUNDARY');
  }
  if (hasForbiddenAutomationRecommendation(evaluation.recommendation)) {
    errors.push('FORBIDDEN_AUTOMATION_RECOMMENDATION');
  }
}

/**
 * 验证本地规则输出的版本、状态、阈值、证据和节能量边界。
 * @param {*} evaluation 规则输出。
 * @returns {{ valid: boolean, errors: string[] }} 验证结果。
 */
function validateRuleEvaluationContract(evaluation) {
  const errors = [];
  if (!isPlainObject(evaluation)) {
    return createValidationResult(['INVALID_RULE_EVALUATION']);
  }

  if (!isNonEmptyString(evaluation.ruleCode)
    || !VERSION_PATTERN.test(evaluation.ruleVersion || '')
    || !VERSION_PATTERN.test(evaluation.formulaVersion || '')) {
    errors.push('INVALID_RULE_IDENTITY');
  }
  if (!RULE_MATCH_STATUSES.includes(evaluation.matchStatus)) {
    errors.push('INVALID_RULE_MATCH_STATUS');
  }
  if (!MANUAL_HANDLING_STATUSES.includes(evaluation.reviewStatus)) {
    errors.push('INVALID_MANUAL_HANDLING_STATUS');
  }
  appendRuleThresholdErrors(errors, evaluation.threshold);
  if (!isNonEmptyString(evaluation.recommendation)) {
    errors.push('INVALID_RULE_RECOMMENDATION');
  }
  appendStrategyAutomationBoundaryErrors(errors, evaluation);

  const notEvaluable = evaluation.matchStatus === 'not_evaluable';
  if (notEvaluable) {
    if (evaluation.actualValue !== null) {
      errors.push('INVALID_RULE_ACTUAL_VALUE');
    }
    if (!Array.isArray(evaluation.reasonCodes) || evaluation.reasonCodes.length === 0
      || evaluation.reasonCodes.some((code) => !ENERGY_ANALYSIS_REASON_CODES.includes(code))) {
      errors.push('MISSING_NOT_EVALUABLE_REASON');
    }
  } else if (!Number.isFinite(evaluation.actualValue)) {
    errors.push('INVALID_RULE_ACTUAL_VALUE');
  }

  const evidenceValid = Array.isArray(evaluation.evidence)
    && evaluation.evidence.every((item) => isNonEmptyString(item));
  if (!evidenceValid || (!notEvaluable && evaluation.evidence.length === 0)) {
    errors.push('INCOMPLETE_RULE_EVIDENCE');
  }
  if (notEvaluable) {
    if (evaluation.dataRange !== null && !isValidRuleDataRange(evaluation.dataRange)) {
      errors.push('INVALID_RULE_DATA_RANGE');
    }
  } else if (!isValidRuleDataRange(evaluation.dataRange)) {
    errors.push('INVALID_RULE_DATA_RANGE');
  }
  if (!Number.isFinite(evaluation.coverageRate)
    || evaluation.coverageRate < 0 || evaluation.coverageRate > 1) {
    errors.push('INVALID_RULE_COVERAGE_RATE');
  }
  if (!RULE_PRIORITIES.includes(evaluation.priority)) {
    errors.push('INVALID_RULE_PRIORITY');
  }

  const thresholdMatch = evaluateRuleThresholdMatch(evaluation.actualValue, evaluation.threshold);
  if (evaluation.matchStatus === 'matched' && thresholdMatch !== true) {
    errors.push('RULE_MATCH_STATUS_THRESHOLD_MISMATCH');
  }
  if (evaluation.matchStatus === 'not_matched' && thresholdMatch !== false) {
    errors.push('RULE_MATCH_STATUS_THRESHOLD_MISMATCH');
  }

  const reductionRate = isPlainObject(evaluation.threshold)
    ? evaluation.threshold.reductionRate
    : undefined;
  const estimatedSavingProvided = evaluation.estimatedSaving !== null;
  const savingAllowed = evaluation.matchStatus === 'matched'
    && evaluation.coverageRate === 1
    && Number.isFinite(reductionRate)
    && reductionRate > 0
    && reductionRate <= 1;
  if (estimatedSavingProvided && !savingAllowed) {
    errors.push('ESTIMATED_SAVING_MUST_BE_NULL');
  } else if (estimatedSavingProvided
    && (!Number.isFinite(evaluation.estimatedSaving) || evaluation.estimatedSaving < 0)) {
    errors.push('INVALID_ESTIMATED_SAVING');
  }
  if (estimatedSavingProvided && !isNonEmptyString(evaluation.estimatedSavingUnit)) {
    errors.push('MISSING_ESTIMATED_SAVING_UNIT');
  }
  if (!estimatedSavingProvided
    && evaluation.estimatedSavingUnit !== undefined
    && evaluation.estimatedSavingUnit !== null) {
    errors.push('ESTIMATED_SAVING_UNIT_MUST_BE_NULL');
  }

  return createValidationResult(errors);
}

module.exports = {
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
  isEnergyFlowUtcSecond,
  isIanaTimeZone,
  isStrictCalendarDate,
  isStrictUtcIso,
  normalizeEnergyFlowKey,
  normalizeEnergyFlowModelVersionKey,
  normalizeEnergyFlowUtcSecond,
  validateAndNormalizeEnergyFlowIdentityCode,
  validateAndNormalizeEnergyFlowModelVersion,
  validateBalanceItemsContract,
  validateBenchmarkContract,
  validateConversionFactorContract,
  validateEnergyFlowModelContract,
  validateIanaTimeZone,
  validateRuleEvaluationContract,
  validateTimeIntervalContract,
  validateTimeOfUseRuleContract
};
