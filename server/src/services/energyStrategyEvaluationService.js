'use strict';

const crypto = require('crypto');
const database = require('../db/database');
const { badRequest } = require('../utils/errors');
const { ENERGY_ANALYSIS_VERSIONS } = require('./energyAnalysisContracts');
const {
  getEnergyLoadSummary,
  normalizeEnergyLoadSummaryInput
} = require('./energyConsumptionAnalysisService');
const { buildStrategyEvaluation } = require('./energyAnalysisUtils');

// 单次预演允许筛选的规则编码上限，去重后不得超过该值。
const MAX_RULE_CODES = 50;
// 单次预演允许实际评价的规则数量上限。
const MAX_STRATEGY_RULES = 50;
// 查询多取一条，仅用于识别规则超限并安全拒绝。
const STRATEGY_RULE_QUERY_LIMIT = MAX_STRATEGY_RULES + 1;
// 单条规则默认返回的证据数量上限。
const DEFAULT_MAX_EVIDENCE_ITEMS = 10;
// 单条规则允许返回的证据数量硬上限。
const MAX_EVIDENCE_ITEMS = 100;
// 首期策略服务只读取负荷分析公式版本一致的规则。
const SUPPORTED_FORMULA_VERSION = ENERGY_ANALYSIS_VERSIONS.loadAnalysis;
// 首期策略指标白名单，禁止把数据库字段解释成可执行函数。
const SUPPORTED_METRIC_CODES = Object.freeze(['load_rate', 'peak_interval_energy']);
// 证据要求 JSON 仅允许这些稳定字段。
const EVIDENCE_REQUIREMENT_KEYS = Object.freeze([
  'minimumCoverageRate',
  'maxEvidenceItems',
  'savingBasis'
]);
// 策略预演固定的人工复核自动化边界。
const AUTOMATION_BOUNDARY = Object.freeze({
  usesAI: false,
  issuesControlCommand: false,
  changesDeviceState: false,
  requiresManualReview: true
});

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范可选规则编码数组，保持首次出现顺序并在去重后执行上限校验。
 * @param {*} ruleCodes 原始规则编码数组。
 * @returns {string[]} 规范规则编码。
 */
function normalizeRuleCodes(ruleCodes) {
  if (ruleCodes === undefined || ruleCodes === null) {
    return [];
  }
  if (!Array.isArray(ruleCodes)) {
    throw badRequest('ruleCodes 必须是字符串数组。', {
      code: 'INVALID_STRATEGY_RULE_CODES'
    });
  }

  // 规范后的规则编码保持调用方首次出现顺序。
  const normalizedRuleCodes = [];
  // 已出现编码集合用于安全去重。
  const seenRuleCodes = new Set();
  ruleCodes.forEach((ruleCode, index) => {
    if (typeof ruleCode !== 'string' || ruleCode.trim() === '') {
      throw badRequest('ruleCodes 只能包含非空字符串。', {
        code: 'INVALID_STRATEGY_RULE_CODE',
        index
      });
    }
    // 单个规则编码只进行去空白处理，不拼接到 SQL 文本。
    const normalizedRuleCode = ruleCode.trim();
    if (!seenRuleCodes.has(normalizedRuleCode)) {
      seenRuleCodes.add(normalizedRuleCode);
      normalizedRuleCodes.push(normalizedRuleCode);
    }
  });

  if (normalizedRuleCodes.length > MAX_RULE_CODES) {
    throw badRequest(`ruleCodes 去重后不得超过 ${MAX_RULE_CODES} 个。`, {
      code: 'STRATEGY_RULE_CODE_LIMIT_EXCEEDED',
      maximumRuleCodes: MAX_RULE_CODES,
      actualRuleCodes: normalizedRuleCodes.length
    });
  }
  return normalizedRuleCodes;
}

/**
 * 规范策略预演输入，并复用负荷摘要的范围校验契约。
 * @param {*} input 原始预演输入。
 * @returns {object} 规范输入。
 */
function normalizeStrategyPreviewInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('策略预演参数必须是对象。', {
      code: 'INVALID_ENERGY_STRATEGY_PREVIEW_INPUT'
    });
  }
  // 负荷摘要输入由公共查询服务统一规范，避免两套范围口径漂移。
  const loadSummaryInput = normalizeEnergyLoadSummaryInput(input);
  // 可选规则编码独立规范，空数组表示查询全部候选规则。
  const ruleCodes = normalizeRuleCodes(input.ruleCodes);
  return { loadSummaryInput, ruleCodes };
}

/**
 * 查询满足状态、完整有效期和公式版本约束的策略规则。
 * @param {object} db SQLite 连接。
 * @param {object} normalizedInput 规范预演输入。
 * @returns {object[]} 稳定排序的候选规则。
 */
function queryStrategyRules(db, normalizedInput) {
  // 查询参数只包含固定范围值和调用方规范后的规则编码。
  const parameters = {
    startUtc: normalizedInput.loadSummaryInput.startUtc,
    endUtc: normalizedInput.loadSummaryInput.endUtc,
    formulaVersion: SUPPORTED_FORMULA_VERSION
  };
  // IN 占位符名称仅由数组索引生成，不使用调用方文本。
  const ruleCodePlaceholders = normalizedInput.ruleCodes.map((ruleCode, index) => {
    const parameterName = `ruleCode${index}`;
    parameters[parameterName] = ruleCode;
    return `@${parameterName}`;
  });
  // 空规则编码数组不追加筛选，表示读取全部满足基础约束的规则。
  const ruleCodeFilter = ruleCodePlaceholders.length > 0
    ? ` AND rule_code IN (${ruleCodePlaceholders.join(', ')})`
    : '';

  return db.prepare(
    `SELECT id,
            rule_code AS ruleCode,
            rule_name AS ruleName,
            rule_version AS ruleVersion,
            formula_version AS formulaVersion,
            metric_code AS metricCode,
            threshold_operator AS thresholdOperator,
            threshold_value AS thresholdValue,
            threshold_min AS thresholdMin,
            threshold_max AS thresholdMax,
            threshold_unit AS thresholdUnit,
            reduction_rate AS reductionRate,
            priority,
            evidence_requirements_json AS evidenceRequirementsJson,
            recommendation_text AS recommendation,
            source,
            effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc,
            source_timezone AS sourceTimeZone
       FROM strategy_rules
      WHERE status = 'active'
        AND formula_version = @formulaVersion
        AND julianday(effective_start_utc) <= julianday(@startUtc)
        AND julianday(effective_end_utc) >= julianday(@endUtc)
        ${ruleCodeFilter}
      ORDER BY rule_code ASC, rule_version ASC, id ASC
      LIMIT ${STRATEGY_RULE_QUERY_LIMIT}`
  ).all(parameters);
}

/**
 * 严格解析规则证据要求，未知字段和非法值均作为该规则配置错误。
 * @param {*} rawJson 数据库存储的 JSON 文本。
 * @returns {object} 解析结果、稳定配置错误和安全证据上限。
 */
function parseEvidenceRequirements(rawJson) {
  // 缺省证据要求保持公共服务的完整覆盖门槛和有限响应大小。
  const defaultRequirements = {
    minimumCoverageRate: 1,
    maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
    savingBasis: null
  };
  // 配置错误按校验顺序稳定返回。
  const errors = [];
  let parsedRequirements = null;
  try {
    parsedRequirements = JSON.parse(rawJson);
  } catch (_error) {
    return {
      valid: false,
      requirements: null,
      errors: ['INVALID_EVIDENCE_REQUIREMENTS_JSON'],
      maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS
    };
  }

  if (!isPlainObject(parsedRequirements)) {
    return {
      valid: false,
      requirements: null,
      errors: ['INVALID_EVIDENCE_REQUIREMENTS_OBJECT'],
      maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS
    };
  }

  // 未知字段一律拒绝，防止将配置文本扩展成隐式执行能力。
  const unknownKeys = Object.keys(parsedRequirements)
    .filter((key) => !EVIDENCE_REQUIREMENT_KEYS.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    errors.push('UNKNOWN_EVIDENCE_REQUIREMENT_FIELD');
  }

  // 覆盖率必须是闭区间 [0,1] 内有限数。
  const minimumCoverageRate = Object.prototype.hasOwnProperty.call(
    parsedRequirements,
    'minimumCoverageRate'
  ) ? parsedRequirements.minimumCoverageRate : defaultRequirements.minimumCoverageRate;
  if (!Number.isFinite(minimumCoverageRate)
    || minimumCoverageRate < 0
    || minimumCoverageRate > 1) {
    errors.push('INVALID_EVIDENCE_MINIMUM_COVERAGE_RATE');
  }

  // 证据上限必须是 1 至 100 的正整数。
  const maxEvidenceItems = Object.prototype.hasOwnProperty.call(parsedRequirements, 'maxEvidenceItems')
    ? parsedRequirements.maxEvidenceItems
    : defaultRequirements.maxEvidenceItems;
  if (!Number.isInteger(maxEvidenceItems)
    || maxEvidenceItems <= 0
    || maxEvidenceItems > MAX_EVIDENCE_ITEMS) {
    errors.push('INVALID_EVIDENCE_MAX_ITEMS');
  }

  // 首期节能估算只允许完整窗口总能耗作为计算基数。
  const savingBasis = Object.prototype.hasOwnProperty.call(parsedRequirements, 'savingBasis')
    ? parsedRequirements.savingBasis
    : defaultRequirements.savingBasis;
  if (savingBasis !== null && savingBasis !== 'window_total_energy') {
    errors.push('INVALID_EVIDENCE_SAVING_BASIS');
  }

  if (errors.length > 0) {
    return {
      valid: false,
      requirements: null,
      errors: [...new Set(errors)],
      maxEvidenceItems: Number.isInteger(maxEvidenceItems)
        && maxEvidenceItems > 0
        && maxEvidenceItems <= MAX_EVIDENCE_ITEMS
        ? maxEvidenceItems
        : DEFAULT_MAX_EVIDENCE_ITEMS
    };
  }

  return {
    valid: true,
    requirements: {
      minimumCoverageRate,
      maxEvidenceItems,
      savingBasis
    },
    errors: [],
    maxEvidenceItems
  };
}

/**
 * 将数值序列化为稳定且无类型碰撞的规范文本。
 * @param {number} value 待序列化数值。
 * @returns {string} 规范数值文本。
 */
function stableStringifyNumber(value) {
  // 合法有限数保持原 JSON 数值文本，兼容既有正常数据摘要。
  if (Number.isFinite(value) && !Object.is(value, -0)) {
    return JSON.stringify(value);
  }
  // 非 JSON 数值使用不带引号的保留标记，普通字符串和对象无法产生同一文本。
  if (Number.isNaN(value)) {
    return '@number:NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '@number:Infinity';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '@number:-Infinity';
  }
  return '@number:-0';
}

/**
 * 将对象递归序列化为键顺序稳定的规范文本。
 * @param {*} value 待序列化值。
 * @returns {string} 稳定规范文本。
 */
function stableStringify(value) {
  if (typeof value === 'number') {
    return stableStringifyNumber(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 构造不包含连接所有权和当前时间的规范负荷摘要快照。
 * @param {object} loadSummary 公共负荷摘要。
 * @returns {object} 可稳定摘要的事实快照。
 */
function buildNormalizedSummarySnapshot(loadSummary) {
  return {
    contractVersion: loadSummary.contractVersion,
    formulaVersion: loadSummary.formulaVersion,
    scope: loadSummary.scope,
    dataRange: loadSummary.dataRange,
    granularityMinutes: loadSummary.granularityMinutes,
    recordCount: loadSummary.recordCount,
    quality: loadSummary.quality,
    metrics: loadSummary.metrics,
    maxLoadInterval: loadSummary.maxLoadInterval,
    peakInterval: loadSummary.peakInterval
  };
}

/**
 * 计算规范负荷数据摘要的 SHA-256 十六进制摘要。
 * @param {object} loadSummary 公共负荷摘要。
 * @returns {string} 六十四位十六进制数据摘要。
 */
function createDataSummaryDigest(loadSummary) {
  // 摘要载荷排除连接所有权等非业务事实，确保相同数据得到相同结果。
  const digestPayload = stableStringify(buildNormalizedSummarySnapshot(loadSummary));
  return crypto.createHash('sha256').update(digestPayload, 'utf8').digest('hex');
}

/**
 * 对规范载荷计算 SHA-256 十六进制摘要。
 * @param {object} payload 规范摘要载荷。
 * @returns {string} 六十四位十六进制摘要。
 */
function createStableDigest(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

/**
 * 将公共摘要证据引用统一成策略服务的 timeseries:<id> 形式。
 * @param {*} reference 原始证据引用。
 * @returns {string|null} 规范证据引用。
 */
function normalizeTimeseriesEvidenceReference(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    return null;
  }
  const normalizedReference = reference.trim();
  if (normalizedReference.startsWith('energy-timeseries:')) {
    return `timeseries:${normalizedReference.slice('energy-timeseries:'.length)}`;
  }
  if (normalizedReference.startsWith('timeseries:')) {
    return normalizedReference;
  }
  return null;
}

/**
 * 读取指标相关的全部真实时序明细证据并稳定排序。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {string} metricCode 指标编码。
 * @returns {string[]} 真实时序明细引用。
 */
function collectTimeseriesDetailEvidence(loadSummary, metricCode) {
  // 峰值使用完整峰值候选，负荷率使用最大负荷候选作为明细来源。
  const metricReferences = metricCode === 'peak_interval_energy'
    ? loadSummary.peakInterval.evidence
    : loadSummary.maxLoadInterval.evidence;
  return [...new Set((Array.isArray(metricReferences) ? metricReferences : [])
    .map(normalizeTimeseriesEvidenceReference)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 构造逐规则评价摘要的规范载荷，绑定规则、数据和实际评价输入。
 * @param {object} rule 数据库规则。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {string} dataSummaryDigest 数据摘要。
 * @param {object} threshold 规则阈值。
 * @param {object} evidenceRequirements 证据要求解析结果。
 * @param {object} evaluationInput 实际评价输入。
 * @param {string[]} detailEvidenceCandidates 全部时序明细证据候选。
 * @returns {object} 逐规则评价摘要载荷。
 */
function buildEvaluationDigestPayload(
  rule,
  loadSummary,
  dataSummaryDigest,
  threshold,
  evidenceRequirements,
  evaluationInput,
  detailEvidenceCandidates
) {
  return {
    scope: {
      meterDeviceId: loadSummary.scope.meterDeviceId,
      energyTypeCode: loadSummary.scope.energyTypeCode,
      unit: loadSummary.scope.unit,
      sourceTimeZone: loadSummary.scope.sourceTimeZone
    },
    dataRange: {
      startUtc: loadSummary.dataRange.startUtc,
      endUtc: loadSummary.dataRange.endUtc,
      sourceTimeZone: loadSummary.dataRange.sourceTimeZone
    },
    dataSummaryDigest: `sha256:${dataSummaryDigest}`,
    metricCode: rule.metricCode,
    rule: {
      id: Number(rule.id),
      code: rule.ruleCode,
      name: rule.ruleName,
      version: rule.ruleVersion,
      formulaVersion: rule.formulaVersion,
      threshold,
      priority: rule.priority,
      recommendation: rule.recommendation,
      evidenceRequirements: evidenceRequirements.valid
        ? evidenceRequirements.requirements
        : null,
      evidenceRequirementsRaw: rule.evidenceRequirementsJson,
      reductionRate: rule.reductionRate === null ? null : Number(rule.reductionRate),
      source: rule.source,
      effectiveStartUtc: rule.effectiveStartUtc,
      effectiveEndUtc: rule.effectiveEndUtc,
      sourceTimeZone: rule.sourceTimeZone
    },
    evaluationInput,
    detailEvidenceCandidates
  };
}

/**
 * 构造不可被明细上限截断的必备证据和受控时序明细证据。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {string} metricCode 指标编码。
 * @param {string} dataSummaryDigest 数据摘要。
 * @param {string} evaluationDigest 逐规则评价摘要。
 * @param {string[]} detailEvidenceCandidates 时序明细证据候选。
 * @param {number} maximumDetailItems 时序明细数量上限。
 * @returns {object} 最终证据与上限语义。
 */
function buildMetricEvidence(
  loadSummary,
  metricCode,
  dataSummaryDigest,
  evaluationDigest,
  detailEvidenceCandidates,
  maximumDetailItems
) {
  // 必备证据固定按窗口、表计/范围、指标、记录数、数据摘要和评价摘要排列。
  const requiredEvidence = [
    `window:${loadSummary.dataRange.startUtc}/${loadSummary.dataRange.endUtc}`,
    `meter:${loadSummary.scope.meterDeviceId}`,
    `scope:energy-type=${loadSummary.scope.energyTypeCode};unit=${loadSummary.scope.unit};source-timezone=${loadSummary.scope.sourceTimeZone}`,
    `metric:${metricCode}`,
    `record-count:${loadSummary.recordCount}`,
    `data-summary-sha256:${dataSummaryDigest}`,
    `evaluation-sha256:${evaluationDigest}`
  ];
  // 峰值区间只在公共摘要存在真实完整候选时追加，零峰值也保留真实区间证据。
  if (metricCode === 'peak_interval_energy'
    && loadSummary.peakInterval.startUtc
    && loadSummary.peakInterval.endUtc) {
    requiredEvidence.push(
      `peak-interval:${loadSummary.peakInterval.startUtc}/${loadSummary.peakInterval.endUtc}`
    );
  }
  // maxEvidenceItems 只限制详细 timeseries 引用，不得截断任何必备证据。
  const detailEvidence = detailEvidenceCandidates.slice(0, maximumDetailItems);
  return {
    evidence: [...requiredEvidence, ...detailEvidence],
    policy: {
      maxEvidenceItemsSemantics: 'timeseries_detail_limit_only',
      requiredEvidenceCount: requiredEvidence.length,
      detailEvidenceLimit: maximumDetailItems,
      availableDetailEvidenceCount: detailEvidenceCandidates.length,
      returnedDetailEvidenceCount: detailEvidence.length,
      detailEvidenceTruncated: detailEvidenceCandidates.length > detailEvidence.length
    }
  };
}

/**
 * 将数据库阈值列映射为公共策略 builder 的固定结构。
 * @param {object} rule 数据库规则。
 * @returns {object} 阈值对象。
 */
function buildRuleThreshold(rule) {
  // between 与单值操作符使用互斥字段，严格遵循现有 schema。
  const threshold = rule.thresholdOperator === 'between'
    ? {
      operator: rule.thresholdOperator,
      min: Number(rule.thresholdMin),
      max: Number(rule.thresholdMax),
      unit: rule.thresholdUnit
    }
    : {
      operator: rule.thresholdOperator,
      value: Number(rule.thresholdValue),
      unit: rule.thresholdUnit
    };
  if (rule.reductionRate !== null && rule.reductionRate !== undefined) {
    threshold.reductionRate = Number(rule.reductionRate);
  }
  return threshold;
}

/**
 * 根据公共负荷摘要构造首期白名单指标。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {string} metricCode 指标编码。
 * @returns {object} 指标事实。
 */
function resolveMetricFact(loadSummary, metricCode) {
  if (metricCode === 'load_rate') {
    return {
      supported: true,
      value: loadSummary.metrics.loadRatePercent,
      unit: '%',
      calculable: loadSummary.metrics.loadRateCalculable === true
        && Number.isFinite(loadSummary.metrics.loadRatePercent)
    };
  }
  if (metricCode === 'peak_interval_energy') {
    // 峰值单位明确携带完整落窗粒度，不把区间能源量伪装成负荷功率。
    const metricUnit = loadSummary.peakInterval.energyUnit
      && Number.isInteger(loadSummary.granularityMinutes)
      ? `${loadSummary.peakInterval.energyUnit}/${loadSummary.granularityMinutes}min`
      : null;
    return {
      supported: true,
      value: loadSummary.peakInterval.energy,
      unit: metricUnit,
      calculable: Number.isFinite(loadSummary.peakInterval.energy)
        && loadSummary.peakInterval.energy > 0
        && metricUnit !== null
        && loadSummary.peakInterval.startUtc !== null
        && loadSummary.peakInterval.endUtc !== null
    };
  }
  return {
    supported: false,
    value: null,
    unit: null,
    calculable: false
  };
}

/**
 * 合并公共质量原因与规则级不可评估原因，保持首次出现顺序。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {object} metricFact 指标事实。
 * @param {object} evidenceRequirements 证据要求解析结果。
 * @param {string[]} configurationErrors 规则配置错误。
 * @returns {string[]} 公共契约允许的原因码。
 */
function buildMetricReasonCodes(
  loadSummary,
  metricFact,
  evidenceRequirements,
  configurationErrors
) {
  // 公共负荷摘要的质量原因是规则判断的首要事实。
  const reasonCodes = Array.isArray(loadSummary.quality.reasonCodes)
    ? [...loadSummary.quality.reasonCodes]
    : [];
  if (evidenceRequirements.valid
    && loadSummary.quality.coverageRate < evidenceRequirements.requirements.minimumCoverageRate) {
    reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  }
  if (!metricFact.supported || configurationErrors.length > 0) {
    reasonCodes.push('UNIT_NOT_COMPARABLE');
  }
  if (!metricFact.calculable) {
    reasonCodes.push('NO_TIMESERIES_DATA');
  }
  return [...new Set(reasonCodes)];
}

/**
 * 将单条数据库规则通过公共 builder 构造成安全预演结果。
 * @param {object} rule 数据库规则。
 * @param {object} loadSummary 公共负荷摘要。
 * @param {string} dataSummaryDigest 规范数据摘要哈希。
 * @returns {object} 单条规则预演结果。
 */
function evaluateStrategyRule(rule, loadSummary, dataSummaryDigest) {
  // 证据要求解析失败只影响当前规则，不中断整次只读预演。
  const evidenceRequirements = parseEvidenceRequirements(rule.evidenceRequirementsJson);
  // 白名单外指标始终作为安全配置错误处理。
  const metricFact = resolveMetricFact(loadSummary, rule.metricCode);
  // 阈值结构沿用现有 builder，单位先在服务层做指标语义校验。
  const threshold = buildRuleThreshold(rule);
  // 规则级配置错误稳定去重，不执行数据库中的任何文本。
  const configurationErrors = [...new Set([
    ...evidenceRequirements.errors,
    ...(!SUPPORTED_METRIC_CODES.includes(rule.metricCode) ? ['UNSUPPORTED_STRATEGY_METRIC'] : []),
    ...(metricFact.supported && metricFact.unit !== null && rule.thresholdUnit !== metricFact.unit
      ? ['STRATEGY_THRESHOLD_UNIT_MISMATCH']
      : []),
    ...(metricFact.supported && metricFact.unit === null
      ? ['STRATEGY_METRIC_UNIT_UNAVAILABLE']
      : [])
  ])];
  // 覆盖率同时受公共数据质量和当前规则要求约束。
  const coverageMeetsRule = evidenceRequirements.valid
    && loadSummary.quality.coverageRate >= evidenceRequirements.requirements.minimumCoverageRate;
  // 只有配置、覆盖、公共质量和指标值全部满足时才允许阈值判断。
  const metricEvaluable = configurationErrors.length === 0
    && coverageMeetsRule
    && loadSummary.quality.sufficient === true
    && metricFact.calculable;
  // 公共原因码绑定本次实际评价输入并交给 builder。
  const metricReasonCodes = buildMetricReasonCodes(
    loadSummary,
    metricFact,
    evidenceRequirements,
    configurationErrors
  );
  // builder 只接收静态规则对象，不执行公式、函数或模块加载。
  const builderRule = {
    ruleCode: rule.ruleCode,
    ruleVersion: rule.ruleVersion,
    formulaVersion: rule.formulaVersion,
    threshold,
    priority: rule.priority,
    recommendation: rule.recommendation,
    savingBasis: evidenceRequirements.valid
      ? evidenceRequirements.requirements.savingBasis
      : null
  };
  // 实际评价输入在生成逐规则摘要前固定，避免摘要与阈值判断输入漂移。
  const evaluationInput = {
    formulaVersion: loadSummary.formulaVersion,
    value: metricEvaluable ? metricFact.value : null,
    metricUnit: metricFact.unit || rule.thresholdUnit,
    coverageRate: loadSummary.quality.coverageRate,
    coverageMeetsRule,
    qualitySufficient: loadSummary.quality.sufficient === true,
    evaluable: metricEvaluable,
    reasonCodes: metricReasonCodes,
    configurationErrors,
    dataRange: loadSummary.dataRange,
    totalEnergy: loadSummary.metrics.totalEnergy,
    totalEnergyComplete: loadSummary.metrics.totalEnergyComplete === true,
    totalEnergyUnit: loadSummary.metrics.energyUnit,
    peakInterval: rule.metricCode === 'peak_interval_energy'
      ? {
        startUtc: loadSummary.peakInterval.startUtc,
        endUtc: loadSummary.peakInterval.endUtc,
        energy: loadSummary.peakInterval.energy,
        energyUnit: loadSummary.peakInterval.energyUnit,
        granularityMinutes: loadSummary.granularityMinutes
      }
      : null
  };
  // 全部真实时序候选进入摘要载荷，maxEvidenceItems 只控制最终返回的明细数量。
  const detailEvidenceCandidates = collectTimeseriesDetailEvidence(loadSummary, rule.metricCode);
  // 逐规则摘要绑定数据摘要、规则身份/配置、有效期和实际评价输入。
  const evaluationDigest = createStableDigest(buildEvaluationDigestPayload(
    rule,
    loadSummary,
    dataSummaryDigest,
    threshold,
    evidenceRequirements,
    evaluationInput,
    detailEvidenceCandidates
  ));
  // 必备证据不受明细上限影响，详细 timeseries 引用才受规则上限约束。
  const evidenceResult = buildMetricEvidence(
    loadSummary,
    rule.metricCode,
    dataSummaryDigest,
    evaluationDigest,
    detailEvidenceCandidates,
    evidenceRequirements.maxEvidenceItems
  );
  // 指标结果复用公共摘要的完整窗口总能耗门槛。
  const builderMetric = {
    ...evaluationInput,
    evidence: evidenceResult.evidence
  };
  // 公共 builder 负责最终匹配状态、节能门槛和自动化边界自校验。
  const evaluation = buildStrategyEvaluation(builderRule, builderMetric, {});

  return {
    strategyRuleId: Number(rule.id),
    ruleName: rule.ruleName,
    metricCode: rule.metricCode,
    source: rule.source,
    effectiveRange: {
      startUtc: rule.effectiveStartUtc,
      endUtc: rule.effectiveEndUtc,
      sourceTimeZone: rule.sourceTimeZone
    },
    evidenceRequirements: evidenceRequirements.valid
      ? evidenceRequirements.requirements
      : null,
    evidencePolicy: evidenceResult.policy,
    dataSummaryDigest: `sha256:${dataSummaryDigest}`,
    evaluationDigest: `sha256:${evaluationDigest}`,
    configurationErrors,
    ...evaluation
  };
}

/**
 * 预演满足条件的本地确定性策略规则，不写运行记录或命中记录。
 * @param {object} input 单表计负荷范围及可选规则编码。
 * @param {object} options 可注入调用方 SQLite 连接。
 * @returns {object} 只读策略预演结果。
 */
function previewEnergyStrategies(input, options = {}) {
  // 输入先统一规范，任何数据库读取都使用规范后的范围值。
  const normalizedInput = normalizeStrategyPreviewInput(input);
  // 调用方连接存在时由调用方持有生命周期。
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  // 服务自开连接仅在本函数 finally 中关闭。
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  // 仅测试代码可通过 options 注入同步回调，客户端 input 无法控制该入口。
  const afterLoadSummaryTestHook = isPlainObject(options)
    && typeof options.testOnlyAfterLoadSummary === 'function'
    ? options.testOnlyAfterLoadSummary
    : null;
  // 调用方已有事务时只复用，不提交或回滚调用方事务。
  const shouldOwnReadTransaction = db.inTransaction !== true;
  // 事务开始标记用于错误路径精确回滚服务自建事务。
  let ownedReadTransactionActive = false;

  try {
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }
    // 第一次消费查询在规则查询前建立一致读取快照。
    const loadSummary = getEnergyLoadSummary(normalizedInput.loadSummaryInput, { db });
    if (afterLoadSummaryTestHook) {
      afterLoadSummaryTestHook();
    }
    // 规则只按状态、完整有效期、公式版本和参数化编码筛选读取。
    const strategyRules = queryStrategyRules(db, normalizedInput);
    if (strategyRules.length > MAX_STRATEGY_RULES) {
      throw badRequest(`单次预演规则不得超过 ${MAX_STRATEGY_RULES} 条。`, {
        code: 'STRATEGY_RULE_LIMIT_EXCEEDED',
        maximumRules: MAX_STRATEGY_RULES
      });
    }
    // 数据摘要只绑定规范负荷摘要，规则变化不得改变该摘要。
    const dataSummaryDigest = createDataSummaryDigest(loadSummary);
    // 规则结果按 SQL 稳定顺序逐条构建，不并发、不写库。
    const evaluations = strategyRules.map((rule) => (
      evaluateStrategyRule(rule, loadSummary, dataSummaryDigest)
    ));
    // 返回载荷不包含当前时间，保证相同快照与规则得到确定结果。
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: SUPPORTED_FORMULA_VERSION,
      dryRun: true,
      persistsEvaluationRun: false,
      ruleSelection: {
        sourceTable: 'strategy_rules',
        status: 'active',
        effectiveCoverage: 'full_window',
        formulaVersion: SUPPORTED_FORMULA_VERSION,
        requestedRuleCodes: normalizedInput.ruleCodes,
        maximumRuleCodes: MAX_RULE_CODES,
        maximumEvaluatedRules: MAX_STRATEGY_RULES,
        selectedRuleCount: strategyRules.length
      },
      dataSelection: {
        sourceTable: 'energy_timeseries_records',
        recordStatus: 'active',
        intervalConvention: loadSummary.dataRange.intervalConvention,
        exactScopeFields: [...loadSummary.meta.exactScopeFields],
        overlapPredicate: loadSummary.meta.overlapPredicate,
        monthlyEnergyRecordsRead: false,
        consistentReadSnapshot: true
      },
      scope: loadSummary.scope,
      dataRange: loadSummary.dataRange,
      dataSummary: {
        granularityMinutes: loadSummary.granularityMinutes,
        recordCount: loadSummary.recordCount,
        quality: loadSummary.quality,
        metrics: loadSummary.metrics,
        peakInterval: loadSummary.peakInterval
      },
      dataSummaryDigest: `sha256:${dataSummaryDigest}`,
      evaluations,
      automationBoundary: { ...AUTOMATION_BOUNDARY },
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      requiresManualReview: true,
      meta: {
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction,
        writesEvaluationRuns: false,
        writesRuleHits: false
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
        // 保留原始错误；连接关闭或上层处理负责最终资源回收。
      }
      ownedReadTransactionActive = false;
    }
    throw error;
  } finally {
    if (shouldCloseDatabase) {
      db.close();
    }
  }
}

module.exports = {
  DEFAULT_MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_ITEMS,
  MAX_RULE_CODES,
  MAX_STRATEGY_RULES,
  SUPPORTED_FORMULA_VERSION,
  SUPPORTED_METRIC_CODES,
  createDataSummaryDigest,
  normalizeRuleCodes,
  parseEvidenceRequirements,
  previewEnergyStrategies,
  stableStringify
};
