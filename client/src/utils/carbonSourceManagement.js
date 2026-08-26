import { parseStrictUtcDateTime } from './dateTimeFields.js';
import { nextRequestGeneration } from './requestGeneration.js';

// 碳核算来源管理纯逻辑模块：默认独立来源、双分面、防双计和缺因子空值均在此冻结。

// 新统一结果来源：默认独立活动，旧能耗和 all 必须由用户显式选择。
export const CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE = 'independent_activity';
// 双来源防双计警示：页面必须醒目展示且不得替换为跨来源总计。
export const CARBON_ACCOUNTING_DOUBLE_COUNT_WARNING = '两来源不可直接合计，避免双计。';
// 服务端 all 聚合合同：页面只展示两个分面，不持久化、不合并分页。
export const CARBON_ACCOUNTING_ALL_AGGREGATION_POLICY = '两个来源分别分页且不合并；禁止跨来源和跨 emissionUnit 汇总。';

// 来源选项：权限层在页面按精确查看权限决定是否开放对应选项。
export const CARBON_ACCOUNTING_SOURCE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'independent_activity', label: '独立碳活动（默认）' }),
  Object.freeze({ value: 'energy_record', label: '旧能耗记录（显式查看）' }),
  Object.freeze({ value: 'all', label: '双来源分面（不可合计）' })
]);

// 核算结果状态选项：两来源并集与服务端白名单一致。
export const CARBON_ACCOUNTING_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: 'calculated', label: '已计算' }),
  Object.freeze({ value: 'factor_missing', label: '因子缺失' }),
  Object.freeze({ value: 'invalid_record', label: '无效记录' }),
  Object.freeze({ value: 'superseded', label: '已替代' })
]);

// 核算状态中文映射：未知状态保留原值便于诊断。
const CARBON_ACCOUNTING_STATUS_LABELS = Object.freeze(Object.fromEntries(
  CARBON_ACCOUNTING_STATUS_OPTIONS.map((item) => [item.value, item.label])
));

/** 返回核算结果状态中文名称。 */
export function carbonAccountingStatusLabel(status) {
  return CARBON_ACCOUNTING_STATUS_LABELS[String(status || '')] || String(status || '未知状态');
}

/** 返回核算结果状态标签类型，不作为统计系列颜色。 */
export function carbonAccountingStatusType(status) {
  return ({ calculated: 'success', factor_missing: 'warning', invalid_record: 'danger', superseded: 'info' })[status] || 'info';
}

/** 根据精确权限决定用户可选择的结果来源。 */
export function availableCarbonAccountingSources(permissionState = {}) {
  // 独立查看权限：控制默认来源、运行历史和独立分面。
  const canActivityView = permissionState.canActivityView === true;
  // 旧能耗查看权限：只控制显式旧来源分面。
  const canEnergyView = permissionState.canEnergyView === true;
  return CARBON_ACCOUNTING_SOURCE_OPTIONS.filter((option) => {
    if (option.value === 'independent_activity') return canActivityView;
    if (option.value === 'energy_record') return canEnergyView;
    return canActivityView && canEnergyView;
  });
}

/** 选择当前账号的安全默认来源；没有独立活动权限时保持未选择，旧来源必须由用户显式选择。 */
export function resolveInitialCarbonAccountingSource(permissionState = {}) {
  if (permissionState.canActivityView === true) return CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE;
  return null;
}

/**
 * 创建每次选择运行都会变化的结果查看意图，同一 runCode 连续选择也必须产生新 intent。
 * @param {string} runCode 运行编码。
 * @param {number} currentIntent 当前结果查看意图编号。
 * @returns {{ runCode: string, intent: number }} 标准化运行选择意图。
 */
export function createCarbonRunSelectionIntent(runCode, currentIntent = 0) {
  return {
    runCode: String(runCode || ''),
    intent: nextRequestGeneration(currentIntent)
  };
}

/**
 * 判断运行选择意图是否变化；runCode 相同但 intent 变化时仍必须重新应用。
 * @param {{ runCode?: string, intent?: number }|null} previousSelection 上一次选择。
 * @param {{ runCode?: string, intent?: number }|null} nextSelection 下一次选择。
 * @returns {boolean} 是否应重新应用运行结果筛选。
 */
export function hasCarbonRunSelectionIntentChanged(previousSelection, nextSelection) {
  return String(previousSelection?.runCode || '') !== String(nextSelection?.runCode || '')
    || previousSelection?.intent !== nextSelection?.intent;
}

/**
 * 投影碳页面读取权限，旧 carbon:view 只兼容旧因子和旧能耗板块，不扩张新 accounting 权限。
 * @param {(permission: string) => boolean} checkPermission 权限检查方法。
 * @returns {object} 页面板块与精确 accounting 权限快照。
 */
export function projectCarbonPagePermissions(checkPermission = () => false) {
  // 权限检查器：异常调用方按无权限处理，避免把非函数值解释为授权。
  const hasPermission = typeof checkPermission === 'function' ? checkPermission : () => false;
  // 旧读取权限：只用于历史因子和旧 emissions 页面兼容。
  const hasLegacyCarbonView = hasPermission('carbon:view') === true;
  // 精确旧能耗权限：新 accounting 的 energy_record 和 all 只能使用此值。
  const hasExactEnergyView = hasPermission('carbon:emissions:view') === true;
  return {
    canFactorView: hasPermission('carbon:factors:view') === true || hasLegacyCarbonView,
    canActivityView: hasPermission('carbon:activities:view') === true,
    canActivityCalculate: hasPermission('carbon:activities:calculate') === true,
    canActivityExport: hasPermission('carbon:activities:export') === true,
    canLegacyEnergyView: hasExactEnergyView || hasLegacyCarbonView,
    canAccountingEnergyView: hasExactEnergyView,
    canEnergyExport: hasPermission('carbon:emissions:export') === true
  };
}

/** 判断当前来源是否具备精确查看权限；all 必须同时拥有两套查看权限。 */
export function canViewCarbonAccountingSource(sourceType, permissionState = {}) {
  if (sourceType === 'independent_activity') return permissionState.canActivityView === true;
  if (sourceType === 'energy_record') return permissionState.canEnergyView === true;
  if (sourceType === 'all') return permissionState.canActivityView === true && permissionState.canEnergyView === true;
  return false;
}

/** 判断当前来源是否具备精确导出权限；all 必须同时拥有两套导出权限。 */
export function canExportCarbonAccountingSource(sourceType, permissionState = {}) {
  if (sourceType === 'independent_activity') return permissionState.canActivityExport === true;
  if (sourceType === 'energy_record') return permissionState.canEnergyExport === true;
  if (sourceType === 'all') return permissionState.canActivityExport === true && permissionState.canEnergyExport === true;
  return false;
}

/** 创建统一结果空筛选；运行选择重新应用时必须清除中间来源的专用条件。 */
export function createEmptyCarbonAccountingFilters() {
  return {
    runCode: '',
    status: '',
    scope: '',
    energyTypeCode: '',
    emissionUnit: '',
    calculationMethod: '',
    keyword: '',
    startUtc: null,
    endUtc: null,
    monthStart: '',
    monthEnd: '',
    includeSuperseded: false
  };
}

/**
 * 将一次运行查看意图投影为统一结果来源和筛选状态。
 * @param {{ runCode?: string, intent?: number }} selectionIntent 运行选择意图。
 * @param {object} permissionState 精确权限快照。
 * @returns {{ sourceType: string, filters: object, page: number }|null} 可应用状态。
 */
export function projectCarbonRunSelectionState(selectionIntent = {}, permissionState = {}) {
  const runCode = String(selectionIntent.runCode || '');
  if (!runCode || permissionState.canActivityView !== true) return null;
  return {
    sourceType: CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE,
    filters: {
      ...createEmptyCarbonAccountingFilters(),
      runCode
    },
    page: 1
  };
}

/** 构造统一结果、统计和导出共用筛选，始终显式提交 sourceType。 */
export function buildCarbonAccountingFilters(filters = {}, sourceType = CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE, pagination = {}) {
  // 候选参数：独立和旧来源不兼容的筛选由页面按来源控制，不在此猜测转换。
  const candidates = {
    sourceType,
    runCode: filters.runCode,
    status: filters.status,
    scope: filters.scope,
    organizationUnitId: filters.organizationUnitId,
    energyTypeId: filters.energyTypeId,
    energyTypeCode: String(filters.energyTypeCode || '').trim(),
    emissionUnit: String(filters.emissionUnit || '').trim(),
    calculationMethod: String(filters.calculationMethod || '').trim(),
    keyword: String(filters.keyword || '').trim(),
    startUtc: filters.startUtc,
    endUtc: filters.endUtc,
    monthStart: filters.monthStart,
    monthEnd: filters.monthEnd,
    includeSuperseded: filters.includeSuperseded === true ? true : undefined,
    page: pagination.page,
    pageSize: pagination.pageSize
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => (
    value !== '' && value !== null && value !== undefined
  )));
}

/** 构造创建运行的两字段严格 UTC 载荷，非法值由调用方显示中文提示。 */
export function buildCarbonCalculationRunPayload(form = {}) {
  // 开始 UTC：允许 .000Z 无损规范为秒精度，拒绝缺秒、offset 和非零毫秒。
  const startResult = parseStrictUtcDateTime(form.startUtc);
  // 结束 UTC：与开始值使用同一严格合同。
  const endResult = parseStrictUtcDateTime(form.endUtc);
  if (!startResult.valid) return { valid: false, payload: null, message: `开始时间：${startResult.message}` };
  if (!endResult.valid) return { valid: false, payload: null, message: `结束时间：${endResult.message}` };
  if (startResult.value >= endResult.value) {
    return { valid: false, payload: null, message: '运行期间必须满足开始 UTC 早于结束 UTC。' };
  }
  return { valid: true, payload: { startUtc: startResult.value, endUtc: endResult.value }, message: null };
}

// 方法模块：统一结果空状态与响应合同。

/** 判断值是否为自身可枚举字段组成的普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 判断对象是否拥有指定自身字段，禁止从原型链借用合同字段。 */
function hasOwnField(value, fieldName) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, fieldName);
}

/** 规范化空分页，页面和页大小只接受正安全整数。 */
function normalizeEmptyPagination(pagination = {}) {
  return {
    page: Number.isSafeInteger(pagination.page) && pagination.page > 0 ? pagination.page : 1,
    pageSize: Number.isSafeInteger(pagination.pageSize) && pagination.pageSize > 0 ? pagination.pageSize : 20,
    total: 0
  };
}

/** 创建指定来源的空结果分面，失败后不得继续展示旧筛选数据。 */
export function createEmptyCarbonAccountingFacet(sourceType, pagination = {}) {
  const normalizedPagination = normalizeEmptyPagination(pagination);
  if (sourceType === 'independent_activity') {
    return { sourceType, run: null, rows: [], pagination: normalizedPagination };
  }
  if (sourceType === 'energy_record') {
    return { sourceType, rows: [], pagination: normalizedPagination };
  }
  throw new Error('无法为未知碳核算来源创建空结果分面。');
}

/** 创建指定来源的空统计，失败后不得继续展示旧筛选汇总。 */
export function createEmptyCarbonAccountingStatistics(sourceType) {
  const summary = {
    totalRecords: 0,
    calculatedCount: 0,
    factorMissingCount: 0,
    invalidRecordCount: 0,
    supersededCount: 0
  };
  if (sourceType === 'independent_activity') {
    return { sourceType, run: null, summary, totalsByEmissionUnit: [] };
  }
  if (sourceType === 'energy_record') {
    return { sourceType, summary, totalsByEmissionUnit: [] };
  }
  throw new Error('无法为未知碳核算来源创建空统计。');
}

/**
 * 创建一次完整空来源状态，结果或统计失败时必须同时清空两者。
 * @param {'independent_activity'|'energy_record'} sourceType 来源类型。
 * @param {object} pagination 当前来源分页。
 * @returns {{ facet: object, statistics: object }} 完整空状态。
 */
export function createEmptyCarbonAccountingSourceState(sourceType, pagination = {}) {
  return {
    facet: createEmptyCarbonAccountingFacet(sourceType, pagination),
    statistics: createEmptyCarbonAccountingStatistics(sourceType)
  };
}

/** 严格校验单来源结果分面并返回原对象。 */
export function normalizeCarbonAccountingResultFacet(facet, expectedSourceType) {
  const hasExpectedRunField = expectedSourceType !== 'independent_activity' || hasOwnField(facet, 'run');
  const pagination = facet?.pagination;
  const hasValidPagination = isPlainObject(pagination)
    && Number.isSafeInteger(pagination.page)
    && pagination.page > 0
    && Number.isSafeInteger(pagination.pageSize)
    && pagination.pageSize > 0
    && Number.isSafeInteger(pagination.total)
    && pagination.total >= 0;
  if (!isPlainObject(facet)
    || facet.sourceType !== expectedSourceType
    || !hasExpectedRunField
    || !Array.isArray(facet.rows)
    || !hasValidPagination) {
    throw new Error(`碳核算结果分面 ${expectedSourceType} 不符合响应合同。`);
  }
  return facet;
}

/** 严格校验单来源统计分面并返回原对象。 */
export function normalizeCarbonAccountingStatisticsFacet(facet, expectedSourceType) {
  const hasExpectedRunField = expectedSourceType !== 'independent_activity' || hasOwnField(facet, 'run');
  const summary = facet?.summary;
  const summaryFields = ['totalRecords', 'calculatedCount', 'factorMissingCount', 'invalidRecordCount', 'supersededCount'];
  const hasValidSummary = isPlainObject(summary) && summaryFields.every((fieldName) => (
    Number.isSafeInteger(summary[fieldName]) && summary[fieldName] >= 0
  ));
  const hasValidTotals = Array.isArray(facet?.totalsByEmissionUnit) && facet.totalsByEmissionUnit.every((row) => (
    isPlainObject(row)
    && typeof row.emissionUnit === 'string'
    && row.emissionUnit.length > 0
    && Number.isSafeInteger(row.emissionRecordCount)
    && row.emissionRecordCount >= 0
    && Number.isFinite(row.totalEmissionValue)
  ));
  if (!isPlainObject(facet)
    || facet.sourceType !== expectedSourceType
    || !hasExpectedRunField
    || !hasValidSummary
    || !hasValidTotals) {
    throw new Error(`碳核算统计分面 ${expectedSourceType} 不符合响应合同。`);
  }
  return facet;
}

/** 严格读取 all 响应公共外壳和两个自身 facet。 */
function normalizeAllCarbonAccountingEnvelope(response, facetNormalizer) {
  const facets = response?.facets;
  if (!isPlainObject(response)
    || response.sourceType !== 'all'
    || response.crossSourceTotal !== null
    || typeof response.aggregationPolicy !== 'string'
    || response.aggregationPolicy.trim() === ''
    || !isPlainObject(facets)
    || !hasOwnField(facets, 'independentActivity')
    || !hasOwnField(facets, 'energyRecord')) {
    throw new Error('双来源核算响应不符合防双计合同。');
  }
  return {
    sourceType: 'all',
    independentActivity: facetNormalizer(facets.independentActivity, 'independent_activity'),
    energyRecord: facetNormalizer(facets.energyRecord, 'energy_record'),
    crossSourceTotal: null,
    aggregationPolicy: response.aggregationPolicy
  };
}

/** 在 all 结果响应中严格核对两个自有结果 facet 和防双计外壳。 */
export function normalizeAllCarbonAccountingResponse(response = {}) {
  return normalizeAllCarbonAccountingEnvelope(response, normalizeCarbonAccountingResultFacet);
}

/** 在 all 统计响应中严格核对两个自有统计 facet 和防双计外壳。 */
export function normalizeAllCarbonAccountingStatisticsResponse(response = {}) {
  return normalizeAllCarbonAccountingEnvelope(response, normalizeCarbonAccountingStatisticsFacet);
}

/** 格式化可空结果值，null/undefined/空字符串始终显示破折号而不是 0。 */
export function formatNullableCarbonValue(value, maximumFractionDigits = 6) {
  if (value === null || value === undefined || value === '') return '—';
  // 数值：非有限值同样视为不可计算，不能格式化成 0。
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(numericValue);
}

/** 按排放单位拼接统计总量，不创建跨单位或跨来源合计。 */
export function formatCarbonTotalsByUnit(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return '暂无已计算排放量';
  return rows.map((row) => `${formatNullableCarbonValue(row.totalEmissionValue, 6)} ${row.emissionUnit || '未标注单位'}`).join('；');
}
