import { parseStrictUtcDateTime } from './dateTimeFields.js';
import { isIanaTimeZone } from './ianaTimeZones.js';

// 能效对标页面使用的固定权限编码，前端只控制可见性，服务端仍是最终授权边界。
export const ENERGY_BENCHMARK_PERMISSIONS = Object.freeze({
  view: 'energy:benchmarks:view',
  manage: 'energy:benchmarks:manage',
  analyze: 'energy:benchmarks:analyze',
  export: 'energy:benchmarks:export',
  importPreview: 'energy:benchmarks:import:preview',
  importExecute: 'energy:benchmarks:import:execute'
});
// 组织范围分析复用现有组织台账读取权限，不扩张后端授权边界。
export const ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS = Object.freeze({
  units: 'ledger:units:view',
  organization: 'ledger:organization:view'
});
// 产品范围与内部历史计算范围复用现有产能单元台账读取权限。
export const ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS = Object.freeze({
  unit: 'ledger:production-unit:view',
  legacy: 'ledger:production:view'
});

// 页面只允许三类真实服务端导入路径。
export const ENERGY_BENCHMARK_IMPORT_TYPES = Object.freeze([
  Object.freeze({ value: 'conversion-factors', label: '能源折标系数' }),
  Object.freeze({ value: 'definitions', label: '对标定义' }),
  Object.freeze({ value: 'targets', label: '对标目标' })
]);

// 对标定义类型中文标签。
export const ENERGY_BENCHMARK_TYPE_LABELS = Object.freeze({
  external_standard: '外部标准',
  manual_benchmark: '人工标杆',
  internal_history_baseline: '企业内部历史基准'
});

// 指标方向中文标签。
export const ENERGY_BENCHMARK_DIRECTION_LABELS = Object.freeze({
  lower_better: '越低越好',
  higher_better: '越高越好',
  range: '区间达标'
});

// 对标范围中文标签。
export const ENERGY_BENCHMARK_SCOPE_LABELS = Object.freeze({
  organization: '组织',
  energy: '能源类型',
  product: '产品'
});

// 图形最多展示八个明确实体；超过容量的实体只进入完整表格，不循环复用颜色。
export const ENERGY_BENCHMARK_CHART_MAX_ENTITIES = 8;
// 组织实际对象只允许使用后端 organization_units.unit_type 的五种稳定层级。
export const ENERGY_BENCHMARK_ORGANIZATION_LEVELS = Object.freeze([
  'enterprise', 'department', 'workshop', 'process', 'equipment'
]);
// 组织对象层级中文标签。
export const ENERGY_BENCHMARK_ORGANIZATION_LEVEL_LABELS = Object.freeze({
  enterprise: '企业',
  department: '部门',
  workshop: '车间',
  process: '工序',
  equipment: '设备'
});
// 项目当前统一亮色科技风使用的已验证分类色；颜色槽禁止取模循环。
export const ENERGY_BENCHMARK_ENTITY_COLORS = Object.freeze([
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'
]);

// 服务端兼容性原因码中文说明。
export const ENERGY_BENCHMARK_REASON_LABELS = Object.freeze({
  BENCHMARK_DEFINITION_INACTIVE: '对标定义已停用',
  BENCHMARK_TARGET_INACTIVE: '目标版本已停用',
  BENCHMARK_ACTUAL_VALUE_MISSING: '实际值缺失或不是有限数字',
  BENCHMARK_METRIC_MISMATCH: '指标编码不一致',
  BENCHMARK_SCOPE_TYPE_MISMATCH: '范围类型不一致',
  BENCHMARK_SCOPE_REFERENCE_MISMATCH: '对标范围标识不一致',
  BENCHMARK_OBJECT_LEVEL_MISMATCH: '对象层级不一致',
  BENCHMARK_UNIT_MISMATCH: '单位不一致',
  BENCHMARK_ENERGY_TYPE_MISMATCH: '能源类型不一致',
  BENCHMARK_PERIOD_TYPE_MISMATCH: '周期类型不一致',
  BENCHMARK_PERIOD_RANGE_INVALID: '实际值周期不是合法 UTC 左闭右开区间',
  BENCHMARK_OUTSIDE_EFFECTIVE_PERIOD: '实际值周期超出定义有效期',
  BENCHMARK_TARGET_INVALID: '目标值或区间边界无效',
  BENCHMARK_NO_COMPARABLE_OBJECTS: '没有兼容对象，合格率不可计算'
});

// 页面请求失败时使用的业务原因码中文投影；未知码仍保留服务端消息和原始码。
export const ENERGY_BENCHMARK_REQUEST_REASON_LABELS = Object.freeze({
  BENCHMARK_DEFINITION_NOT_FOUND: '对标定义不存在或已失效',
  BENCHMARK_TARGET_NOT_FOUND: '目标版本不存在或已失效',
  BENCHMARK_DEFINITION_INACTIVE: '对标定义已停用',
  BENCHMARK_TARGET_INACTIVE: '目标版本已停用',
  BENCHMARK_TARGET_DEFINITION_MISMATCH: '目标版本不属于当前对标定义',
  BENCHMARK_ORGANIZATION_SCOPE_NOT_FOUND: '组织范围标识不存在',
  BENCHMARK_ORGANIZATION_SCOPE_INACTIVE: '组织范围已停用',
  BENCHMARK_ENERGY_SCOPE_NOT_FOUND: '能源范围编码不存在',
  BENCHMARK_ENERGY_SCOPE_INACTIVE: '能源范围已停用',
  BENCHMARK_PRODUCT_SCOPE_NOT_FOUND: '产品范围标识无法由当前产能主数据解析',
  BENCHMARK_PRODUCT_SCOPE_INACTIVE: '产品范围已停用',
  BENCHMARK_TARGET_ACTIVE_CONFLICT: '同一定义已有启用目标版本',
  BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP: '同编码启用定义的有效期发生重叠',
  BENCHMARK_ACTUALS_REQUIRED: '至少需要一个明确实际对象',
  BENCHMARK_ACTUALS_LIMIT_EXCEEDED: '实际对象数量超过服务端上限',
  BENCHMARK_INVALID_PAGE: '分页页码无效',
  BENCHMARK_INVALID_PAGE_SIZE: '分页大小无效',
  ENERGY_BENCHMARK_UNKNOWN_FIELDS: '请求包含服务端不支持的字段',
  ENERGY_BENCHMARK_INVALID_INPUT: '请求对象结构无效',
  ENERGY_BENCHMARK_JSON_INVALID: '请求数据格式无效',
  ENERGY_BENCHMARK_JSON_TOO_LARGE: '能效对标请求体超过专属大小限制',
  INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN: '内部历史派生事实只能由服务端计算',
  REQUEST_BODY_TOO_LARGE: '请求体超过服务端大小限制',
  MAINTENANCE_IN_PROGRESS: '系统处于维护态，当前写操作不可执行'
});

/** 根据当前用户已经解析的权限布尔值生成端到端能力矩阵。 */
export function buildEnergyBenchmarkCapabilityMatrix(grants = {}) {
  const analyze = grants.analyze === true;
  const exportPermission = grants.export === true;
  const importPreview = grants.importPreview === true;
  const importExecutePermission = grants.importExecute === true;
  return Object.freeze({
    view: grants.view === true,
    manage: grants.manage === true,
    analyze,
    exportPermission,
    exportWorkflow: analyze && exportPermission,
    importPreview,
    importExecutePermission,
    importExecuteWorkflow: importPreview && importExecutePermission,
    organizationView: grants.organizationUnitsView === true || grants.organizationView === true,
    productionView: grants.productionUnitView === true || grants.productionView === true
  });
}

/** 返回范围主数据选择项的可读标签，值契约仍由选择器单独绑定。 */
export function formatEnergyBenchmarkScopeOptionLabel(scopeType, item = {}) {
  if (scopeType === 'organization') return `${item.unitPath || item.unitName || '未命名组织'}（${item.unitCode || '无编码'}）`;
  if (scopeType === 'energy') return `${item.name || '未命名能源'}（${item.code || '无编码'}）`;
  if (scopeType === 'product') {
    const name = [item.productName, item.unitName].filter(Boolean).join(' / ') || '未命名产品';
    return `${name}（${item.unitCode || '无编码'}）`;
  }
  return '';
}

/** 返回不同范围类型要求的权威选择值。 */
export function resolveEnergyBenchmarkScopeOptionValue(scopeType, item = {}) {
  if (scopeType === 'organization' || scopeType === 'product') return String(item.unitCode || '').trim();
  if (scopeType === 'energy') return String(item.code || '').trim();
  return '';
}

/** 切换范围类型时清空旧范围引用，禁止跨类型保留或自动选择首项。 */
export function resetEnergyBenchmarkScopeSelection(form = {}, scopeType) {
  return { ...form, scopeType, scopeReference: '' };
}

/** 校验范围引用必须来自当前可见的 active 主数据，不接受自由输入或历史别名回退。 */
export function validateEnergyBenchmarkScopeSelection(scopeType, scopeReference, sources = {}) {
  const reference = String(scopeReference || '').trim();
  if (!reference) return { valid: false, message: '请选择 active 主数据范围。' };
  const options = scopeType === 'organization'
    ? sources.organizationUnits
    : scopeType === 'energy'
      ? sources.energyTypes
      : scopeType === 'product'
        ? sources.productionUnits
        : [];
  const matched = Array.isArray(options) && options.some((item) => resolveEnergyBenchmarkScopeOptionValue(scopeType, item) === reference);
  return matched
    ? { valid: true, message: '' }
    : { valid: false, message: `当前${ENERGY_BENCHMARK_SCOPE_LABELS[scopeType] || '范围'}标识不是可见的 active 主数据，请重新选择。` };
}

/** 将 active 定义数据源不可用归一化为不可复用旧选择、目标、对象和结果的空状态。 */
export function normalizeEnergyBenchmarkAnalysisFailureState(notice = '') {
  return {
    definitionId: null,
    targetId: null,
    targets: [],
    actualRows: [],
    organizationObjects: [],
    organizationError: '',
    singleEvaluation: null,
    rankingResult: null,
    qualificationResult: null,
    latestSuccessfulAnalysis: null,
    staleNotice: String(notice || '').trim()
  };
}

/** 对按来源保存的全页错误执行设置或清除，清除一个来源不得误删其他来源。 */
export function reduceEnergyBenchmarkPageErrors(state = {}, action = {}) {
  const source = String(action.source || '').trim();
  if (!source) return { ...state };
  const nextState = { ...state };
  delete nextState[source];
  if (action.type === 'set' && String(action.message || '').trim()) nextState[source] = String(action.message).trim();
  return nextState;
}

/** 选择最近设置且仍未清除的全页错误供页面顶部展示。 */
export function selectEnergyBenchmarkPageError(state = {}) {
  const messages = Object.values(state).filter((item) => String(item || '').trim());
  return messages.length ? messages[messages.length - 1] : '';
}

/** 根据局部目标和显式全局来源决定错误写入位置。 */
export function resolveEnergyBenchmarkErrorDestination(projection = {}, options = {}) {
  const source = String(options.source || '').trim();
  const message = String(options.message || projection.message || '').trim();
  const hasLocalTarget = options.hasLocalTarget === true;
  return {
    localMessage: hasLocalTarget ? message : '',
    // 局部错误目标拥有最高优先级；只有无局部目标的工作流才允许写入全页来源状态。
    pageErrorAction: !hasLocalTarget && source && message ? { type: 'set', source, message } : null
  };
}

/** 将 active 定义数据源事件转换为下一分析状态和页面必须执行的最小副作用。 */
export function transitionEnergyBenchmarkAnalysisState(state = {}, event = {}) {
  const currentState = { ...state };
  if (event.type === 'management-view-changed') return { nextState: currentState, effects: [] };
  if (event.type === 'active-definitions-failed') {
    return {
      nextState: { ...currentState, ...normalizeEnergyBenchmarkAnalysisFailureState(event.notice) },
      effects: [{ type: 'invalidate-analysis-requests', source: 'active-source-failure' }]
    };
  }
  if (event.type !== 'active-definitions-loaded') return { nextState: currentState, effects: [] };
  const activeDefinitions = Array.isArray(event.definitions) ? event.definitions.filter((item) => item?.status === 'active') : [];
  const selectedDefinition = activeDefinitions.find((item) => Number(item.id) === Number(currentState.definitionId));
  if (selectedDefinition) return { nextState: currentState, effects: [] };
  const defaultDefinition = activeDefinitions[0] || null;
  const hadPreviousContext = Boolean(
    (currentState.definitionId !== null && currentState.definitionId !== undefined)
    || (currentState.targetId !== null && currentState.targetId !== undefined)
    || currentState.singleEvaluation
    || currentState.rankingResult
    || currentState.qualificationResult
    || currentState.latestSuccessfulAnalysis
  );
  const nextState = {
    ...currentState,
    ...normalizeEnergyBenchmarkAnalysisFailureState(event.notice),
    definitionId: defaultDefinition?.id ?? null
  };
  const effects = [];
  if (hadPreviousContext) effects.push({ type: 'invalidate-analysis-requests', source: 'active-source-failure' });
  if (defaultDefinition) effects.push({ type: 'load-targets', definitionId: defaultDefinition.id });
  return { nextState, effects };
}

/** 判定不同来源是否应让旧分析失效，以及是否需要重建实体颜色语义上下文。 */
export function resolveEnergyBenchmarkAnalysisInvalidation(source, changed = true) {
  if (!changed) return Object.freeze({ invalidate: false, resetColors: false });
  const resetColorSources = new Set(['definition-context', 'target-context']);
  const invalidateSources = new Set(['analysis-input', 'analysis-run', 'active-source-failure', ...resetColorSources]);
  return Object.freeze({
    invalidate: invalidateSources.has(source),
    resetColors: resetColorSources.has(source)
  });
}

/** 将组织主数据权限缺失或 403 归一化为组织范围专属错误，不升级为全页错误。 */
export function normalizeEnergyBenchmarkOrganizationAccessError(error, hasOrganizationPermission) {
  if (hasOrganizationPermission !== true || Number(error?.response?.status) === 403) {
    return '组织范围需要组织台账查看权限（ledger:units:view 或 ledger:organization:view）。';
  }
  return projectEnergyBenchmarkRequestError(error, '读取组织主数据').message;
}

/** 将产能主数据权限缺失或 403 归一化为产品范围专属错误。 */
export function normalizeEnergyBenchmarkProductionAccessError(error, hasProductionPermission) {
  if (hasProductionPermission !== true || Number(error?.response?.status) === 403) {
    return '产品范围和内部历史计算范围需要产能单元查看权限（ledger:production-unit:view 或 ledger:production:view）。';
  }
  return projectEnergyBenchmarkRequestError(error, '读取产能单元主数据').message;
}

// 前端受控 CSV 中文列定义，与服务端结构化 export-rows 字段解耦。
export const ENERGY_BENCHMARK_CSV_COLUMNS = Object.freeze([
  Object.freeze({ key: 'objectId', label: '对象标识' }),
  Object.freeze({ key: 'objectName', label: '对象名称' }),
  Object.freeze({ key: 'objectLevel', label: '对象层级' }),
  Object.freeze({ key: 'actualValue', label: '实际值' }),
  Object.freeze({ key: 'targetValue', label: '目标值' }),
  Object.freeze({ key: 'lowerBound', label: '下限值' }),
  Object.freeze({ key: 'upperBound', label: '上限值' }),
  Object.freeze({ key: 'absoluteDifference', label: '差额' }),
  Object.freeze({ key: 'differenceRatio', label: '差距比例' }),
  Object.freeze({ key: 'met', label: '达标状态' }),
  Object.freeze({ key: 'rank', label: '排名' }),
  Object.freeze({ key: 'excluded', label: '是否排除' }),
  Object.freeze({ key: 'reasonCodes', label: '原因码' })
]);

/** 删除空查询值，构造定义列表允许的参数。 */
export function buildEnergyBenchmarkDefinitionFilters(filters = {}, pagination = {}) {
  return compactObject({
    status: filters.status,
    benchmarkType: filters.benchmarkType,
    benchmarkCode: filters.benchmarkCode,
    metricCode: filters.metricCode,
    scopeType: filters.scopeType,
    scopeReference: filters.scopeReference,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 删除空查询值，构造目标列表允许的参数。 */
export function buildEnergyBenchmarkTargetFilters(filters = {}, pagination = {}) {
  return compactObject({
    definitionId: filters.definitionId,
    status: filters.status,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 构造定义写入白名单载荷，并在 API 前拒绝空值或当前运行时未知的来源时区。 */
export function buildEnergyBenchmarkDefinitionPayload(form = {}) {
  // 来源时区：不能只依赖静态候选，统一执行字符串形态与 Intl 运行时识别校验。
  const sourceTimeZone = String(form.sourceTimeZone || '').trim();
  if (!sourceTimeZone) throw new Error('请选择来源时区。');
  if (!isIanaTimeZone(sourceTimeZone)) throw new Error('请选择当前运行时可识别的 IANA 来源时区。');
  return {
    benchmarkCode: String(form.benchmarkCode || '').trim(),
    benchmarkName: String(form.benchmarkName || '').trim(),
    benchmarkType: form.benchmarkType,
    metricCode: String(form.metricCode || '').trim(),
    unit: String(form.unit || '').trim(),
    periodType: String(form.periodType || '').trim(),
    scopeType: form.scopeType,
    scopeReference: String(form.scopeReference || '').trim(),
    direction: form.direction,
    source: String(form.source || '').trim(),
    documentNo: nullableText(form.documentNo),
    version: String(form.version || '').trim(),
    effectiveStartUtc: String(form.effectiveStartUtc || '').trim(),
    effectiveEndUtc: String(form.effectiveEndUtc || '').trim(),
    sourceTimeZone,
    status: form.status || 'active'
  };
}

/** 构造内部历史原子固化载荷，绝不接受或提交任何客户端派生快照字段。 */
export function buildEnergyBenchmarkInternalHistoryPayload(form = {}) {
  return {
    definition: buildEnergyBenchmarkDefinitionPayload({
      ...form.definition,
      benchmarkType: 'internal_history_baseline'
    }),
    referencePeriod: {
      startUtc: String(form.referencePeriod?.startUtc || '').trim(),
      endUtc: String(form.referencePeriod?.endUtc || '').trim()
    },
    calculationScope: {
      productionUnitId: finiteNumberOrNull(form.calculationScope?.productionUnitId),
      energyTypeCode: String(form.calculationScope?.energyTypeCode || '').trim()
    }
  };
}

/** 构造目标创建或后继版本载荷。 */
export function buildEnergyBenchmarkTargetPayload(form = {}, includeDefinitionId = false) {
  const payload = {
    targetValue: finiteNumberOrNull(form.targetValue),
    lowerBound: finiteNumberOrNull(form.lowerBound),
    upperBound: finiteNumberOrNull(form.upperBound),
    version: String(form.version || '').trim(),
    status: form.status || 'active'
  };
  if (includeDefinitionId) payload.benchmarkDefinitionId = finiteNumberOrNull(form.benchmarkDefinitionId);
  return payload;
}

/** 根据定义为页面创建一行显式实际值输入。 */
export function createEnergyBenchmarkActualRow(definition = {}, overrides = {}) {
  return {
    objectId: '',
    objectName: '',
    objectLevel: definition.scopeType === 'organization' ? '' : (definition.scopeType || ''),
    actualValue: null,
    metricCode: definition.metricCode || '',
    unit: definition.unit || '',
    periodType: definition.periodType || '',
    periodStartUtc: definition.effectiveStartUtc || '',
    periodEndUtc: definition.effectiveEndUtc || '',
    scopeType: definition.scopeType || '',
    scopeReference: '',
    benchmarkScopeReference: definition.scopeReference || '',
    energyTypeCode: definition.scopeType === 'energy' ? definition.scopeReference || '' : '',
    ...overrides
  };
}

/** 从 active 组织主数据解析组织范围定义要求的真实对象层级。 */
export function resolveEnergyBenchmarkDefinitionObjectLevel(definition = {}, organizationUnits = []) {
  if (definition.scopeType !== 'organization') return ['energy', 'product'].includes(definition.scopeType) ? definition.scopeType : '';
  const scopeUnit = Array.isArray(organizationUnits)
    ? organizationUnits.find((item) => item.status === 'active' && item.unitCode === definition.scopeReference)
    : null;
  return ENERGY_BENCHMARK_ORGANIZATION_LEVELS.includes(scopeUnit?.unitType) ? scopeUnit.unitType : '';
}

/** 将组织选择项映射为服务端要求的显式实际对象，不允许提交 organization 伪层级。 */
export function applyEnergyBenchmarkOrganizationSelection(row = {}, organization = null) {
  if (!organization || organization.status !== 'active' || !ENERGY_BENCHMARK_ORGANIZATION_LEVELS.includes(organization.unitType)) {
    return { ...row, objectId: '', objectName: '', objectLevel: '', scopeReference: '' };
  }
  return {
    ...row,
    objectId: String(organization.unitCode || '').trim(),
    objectName: String(organization.unitName || organization.unitPath || '').trim(),
    objectLevel: organization.unitType,
    scopeReference: String(organization.unitCode || '').trim()
  };
}

/** 构造可比较且可稳定序列化的当前分析输入快照。 */
export function buildEnergyBenchmarkAnalysisSnapshot(definitionId, targetId, actualRows = []) {
  return stableStringify({
    definitionId: finiteNumberOrNull(definitionId),
    targetId: finiteNumberOrNull(targetId),
    actuals: Array.isArray(actualRows) ? actualRows.map((row) => buildEnergyBenchmarkActual(row)) : []
  });
}

/** 校验已解析定义、启用目标和显式实际对象是否满足分析提交前置条件。 */
export function validateEnergyBenchmarkAnalysisContext({ definition = null, target = null, actualRows = [], organizationUnits = [] } = {}) {
  const errors = [];
  if (!definition || definition.status !== 'active' || !Number.isSafeInteger(Number(definition.id))) errors.push('请选择已解析且启用的对标定义。');
  if (!target || target.status !== 'active' || Number(target.benchmarkDefinitionId) !== Number(definition?.id)) errors.push('请选择属于当前定义的启用目标版本。');
  if (target && definition?.direction === 'range') {
    if (!hasFiniteInput(target.lowerBound) || !hasFiniteInput(target.upperBound) || Number(target.lowerBound) > Number(target.upperBound)) errors.push('当前区间目标无效。');
  } else if (target && !hasFiniteInput(target.targetValue)) errors.push('当前目标值无效。');
  const expectedObjectLevel = resolveEnergyBenchmarkDefinitionObjectLevel(definition || {}, organizationUnits);
  if (definition?.scopeType === 'organization' && !expectedObjectLevel) errors.push('当前组织范围无法从 active 组织主数据解析对象层级。');
  if (!Array.isArray(actualRows) || actualRows.length === 0) errors.push('至少新增一个明确实际对象。');
  const objectIds = new Set();
  for (const [index, row] of (Array.isArray(actualRows) ? actualRows : []).entries()) {
    const rowNumber = index + 1;
    const objectId = String(row?.objectId || '').trim();
    if (!objectId) errors.push(`第 ${rowNumber} 个对象未选择或未填写对象标识。`);
    if (objectId && objectIds.has(objectId)) errors.push(`对象标识 ${objectId} 重复。`);
    if (objectId) objectIds.add(objectId);
    if (!expectedObjectLevel || row?.objectLevel !== expectedObjectLevel) errors.push(`第 ${rowNumber} 个对象层级与定义不兼容。`);
    if (!hasFiniteInput(row?.actualValue)) errors.push(`第 ${rowNumber} 个对象实际值必须是有限数字。`);
    if (row?.metricCode !== definition?.metricCode || row?.unit !== definition?.unit || row?.periodType !== definition?.periodType) errors.push(`第 ${rowNumber} 个对象的指标、单位或周期与定义不一致。`);
    if (row?.scopeType !== definition?.scopeType || row?.benchmarkScopeReference !== definition?.scopeReference) errors.push(`第 ${rowNumber} 个对象的对标范围与定义不一致。`);
    if (!isEnergyBenchmarkStrictUtcRange(row?.periodStartUtc, row?.periodEndUtc)) errors.push(`第 ${rowNumber} 个对象必须填写合法 UTC Z 左闭右开周期。`);
    if (definition?.scopeType === 'organization') {
      const organization = organizationUnits.find((item) => item.status === 'active' && item.unitCode === objectId);
      if (!organization || organization.unitType !== expectedObjectLevel || row?.scopeReference !== objectId) errors.push(`第 ${rowNumber} 个组织对象必须从同层级 active 组织主数据中选择。`);
    }
  }
  return { ready: errors.length === 0, errors, expectedObjectLevel };
}

/** 创建按请求键隔离的 latest-response 守卫，旧令牌永远不能覆盖新上下文。 */
export function createEnergyBenchmarkLatestRequestGuard() {
  const versions = new Map();
  return Object.freeze({
    next(key, snapshot = '') {
      const version = (versions.get(key) || 0) + 1;
      versions.set(key, version);
      return Object.freeze({ key, version, snapshot: stableStringify(snapshot) });
    },
    invalidate(key) { versions.set(key, (versions.get(key) || 0) + 1); },
    isLatest(token, snapshot) {
      const normalizedSnapshot = snapshot === undefined ? token?.snapshot : stableStringify(snapshot);
      return Boolean(token && versions.get(token.key) === token.version && token.snapshot === normalizedSnapshot);
    }
  });
}

/** 将实际值行投影到服务端显式对象契约，禁止附带页面私有字段。 */
export function buildEnergyBenchmarkActual(row = {}) {
  return {
    objectId: nullableText(row.objectId),
    objectName: nullableText(row.objectName),
    objectLevel: String(row.objectLevel || '').trim(),
    actualValue: finiteNumberOrNull(row.actualValue),
    metricCode: String(row.metricCode || '').trim(),
    unit: String(row.unit || '').trim(),
    periodType: String(row.periodType || '').trim(),
    periodStartUtc: String(row.periodStartUtc || '').trim(),
    periodEndUtc: String(row.periodEndUtc || '').trim(),
    scopeType: String(row.scopeType || '').trim(),
    scopeReference: String(row.scopeReference || '').trim(),
    benchmarkScopeReference: String(row.benchmarkScopeReference || '').trim(),
    energyTypeCode: nullableText(row.energyTypeCode)
  };
}

/** 构造排名、合格率和结构化导出共用载荷。 */
export function buildEnergyBenchmarkGroupPayload(definitionId, targetId, actualRows = []) {
  return {
    definitionId: finiteNumberOrNull(definitionId),
    targetId: finiteNumberOrNull(targetId),
    actuals: actualRows.map((row) => buildEnergyBenchmarkActual(row))
  };
}

/** 构造单值评价载荷。 */
export function buildEnergyBenchmarkEvaluationPayload(definitionId, targetId, actualRow = {}) {
  return {
    definitionId: finiteNumberOrNull(definitionId),
    targetId: finiteNumberOrNull(targetId),
    actual: buildEnergyBenchmarkActual(actualRow)
  };
}

/** 构造服务端持久化预演批次的最小执行载荷。 */
export function buildEnergyBenchmarkImportExecutePayload(preview = {}, confirmText = '') {
  return {
    batchId: finiteNumberOrNull(preview.batchId),
    confirmText: String(confirmText || ''),
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 判断受控导入预演是否具备进入执行确认的完整上下文。 */
export function canExecuteEnergyBenchmarkImport(preview = null) {
  if (!preview || !Number.isSafeInteger(Number(preview.batchId)) || Number(preview.batchId) <= 0) return false;
  if (!String(preview.previewSignature || '').trim() || !String(preview.previewAuditDigest || '').trim()) return false;
  const wouldImport = Number(preview.summary?.wouldImport);
  return Number.isSafeInteger(wouldImport)
    && wouldImport > 0
    && Array.isArray(preview.candidateRows)
    && preview.candidateRows.length === wouldImport;
}

/** 格式化数值；空值与非有限值保持不可用语义。 */
export function formatEnergyBenchmarkNumber(value, digits = 4) {
  if (value === null || value === undefined || value === '') return '—';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numberValue);
}

/** 格式化差距比例；null 必须显示不可计算而不是 0%。 */
export function formatEnergyBenchmarkRatio(value) {
  if (value === null || value === undefined || value === '') return '不可计算';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '不可计算';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(numberValue * 100)}%`;
}

/** 格式化合格率；无兼容分母时明确不可计算。 */
export function formatEnergyBenchmarkQualificationRate(rate, denominator) {
  if (Number(denominator) <= 0 || rate === null || rate === undefined || !Number.isFinite(Number(rate))) return '不可计算';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(Number(rate) * 100)}%`;
}

/** 按三方向展示目标或边界。 */
export function formatEnergyBenchmarkBoundary(result = {}, unit = '') {
  const suffix = unit ? ` ${unit}` : '';
  if (result.direction === 'range') {
    return `${formatEnergyBenchmarkNumber(result.lowerBound)} ～ ${formatEnergyBenchmarkNumber(result.upperBound)}${suffix}`;
  }
  return `${formatEnergyBenchmarkNumber(result.targetValue)}${suffix}`;
}

/** 生成带图标与文字的评价状态，状态不能只靠颜色表达。 */
export function energyBenchmarkStatusPresentation(result = {}) {
  if (result.comparable === false || result.status === 'not_comparable') {
    return { key: 'not_comparable', icon: '!', label: '不兼容', type: 'info' };
  }
  if (result.met === true || result.status === 'met') {
    return { key: 'met', icon: '✓', label: '达标', type: 'success' };
  }
  return { key: 'not_met', icon: '×', label: '未达标', type: 'danger' };
}

/** 将原因码转换为“中文说明（原因码）”列表。 */
export function formatEnergyBenchmarkReasons(reasonCodes = []) {
  if (!Array.isArray(reasonCodes) || reasonCodes.length === 0) return '—';
  return reasonCodes.map((code) => `${ENERGY_BENCHMARK_REASON_LABELS[code] || '服务端返回的兼容性原因'}（${code}）`).join('；');
}

/** 创建可协调实体增删的稳定颜色注册表；幸存对象保留槽位，删除对象释放槽位。 */
export function createEnergyBenchmarkEntityColorRegistry(colors = ENERGY_BENCHMARK_ENTITY_COLORS) {
  const palette = [...colors].slice(0, ENERGY_BENCHMARK_CHART_MAX_ENTITIES);
  const assignments = new Map();
  /** 为未分配对象读取第一个当前空闲颜色槽。 */
  function firstAvailableColor() {
    const usedColors = new Set([...assignments.values()].filter(Boolean));
    return palette.find((color) => !usedColors.has(color)) || null;
  }
  return Object.freeze({
    colorFor(entityKey) {
      const key = String(entityKey ?? '').trim();
      if (!key) return null;
      if (assignments.has(key)) return assignments.get(key);
      const color = firstAvailableColor();
      assignments.set(key, color);
      return color;
    },
    reconcile(entityKeys = []) {
      const activeKeys = [...new Set(entityKeys.map((item) => String(item ?? '').trim()).filter(Boolean))];
      const activeKeySet = new Set(activeKeys);
      for (const key of assignments.keys()) {
        if (!activeKeySet.has(key)) assignments.delete(key);
      }
      for (const key of activeKeys.filter((item) => !assignments.get(item)).sort()) {
        assignments.set(key, firstAvailableColor());
      }
      return activeKeys.map((key) => ({ key, color: assignments.get(key) ?? null }));
    },
    assignedCount() { return assignments.size; }
  });
}

/** 从实体颜色注册表读取稳定颜色；没有注册表时不猜测或循环复色。 */
export function energyBenchmarkEntityColor(entityKey, registry = null) {
  return registry?.colorFor?.(entityKey) ?? null;
}

/** 按服务端排名结果构建条形图行，并为并列排名保留相同名次。 */
export function normalizeEnergyBenchmarkRankingRows(ranked = [], colorRegistry = null) {
  const rows = Array.isArray(ranked) ? ranked.map((item) => ({ ...item })) : [];
  const rankedRows = rows.every((item) => Number.isSafeInteger(Number(item.rank)) && Number(item.rank) > 0)
    ? rows
    : assignEnergyBenchmarkCompetitionRanks(rows, rows[0]?.direction || 'lower_better');
  const maximum = Math.max(...rankedRows.map((item) => Math.abs(Number(item.actualValue) || 0)), 0);
  const stableKeys = [...new Set(rankedRows.map((item) => String(item.objectId || item.objectName || '').trim()).filter(Boolean))].sort();
  stableKeys.forEach((key) => energyBenchmarkEntityColor(key, colorRegistry));
  return rankedRows.map((item) => ({
    ...item,
    entityColor: energyBenchmarkEntityColor(item.objectId || item.objectName, colorRegistry),
    barPercentage: maximum > 0 ? Math.min(100, (Math.abs(Number(item.actualValue) || 0) / maximum) * 100) : 0
  }));
}

/** 采用竞赛排名处理并列值；仅作为展示数据缺少 rank 时的纯逻辑回退。 */
export function assignEnergyBenchmarkCompetitionRanks(items = [], direction = 'lower_better') {
  const rows = [...items];
  const score = (item) => {
    const actualValue = Number(item.actualValue);
    if (direction !== 'range') return actualValue;
    if (actualValue < Number(item.lowerBound)) return Number(item.lowerBound) - actualValue;
    if (actualValue > Number(item.upperBound)) return actualValue - Number(item.upperBound);
    return 0;
  };
  rows.sort((left, right) => {
    const leftScore = score(left);
    const rightScore = score(right);
    if (direction === 'higher_better') return rightScore - leftScore;
    return leftScore - rightScore || Number(left.actualValue) - Number(right.actualValue);
  });
  let previousScore = null;
  let previousRank = 0;
  return rows.map((item, index) => {
    const currentScore = score(item);
    const rank = previousScore !== null && currentScore === previousScore ? previousRank : index + 1;
    previousScore = currentScore;
    previousRank = rank;
    return { ...item, rank };
  });
}

/** 将结构化 export-rows 转换为带 BOM、中文表头和公式注入防护的 CSV。 */
export function buildEnergyBenchmarkCsv(exportData = {}) {
  const rows = Array.isArray(exportData.rows) ? exportData.rows : [];
  const header = ENERGY_BENCHMARK_CSV_COLUMNS.map((column) => escapeCsvCell(column.label)).join(',');
  const body = rows.map((row) => ENERGY_BENCHMARK_CSV_COLUMNS.map((column) => {
    let value = row[column.key];
    if (column.key === 'reasonCodes') value = Array.isArray(value) ? value.join('|') : value;
    if (column.key === 'met') value = value === true ? '达标' : value === false ? '未达标' : '不可判定';
    if (column.key === 'excluded') value = value === true ? '是' : '否';
    return escapeCsvCell(value);
  }).join(','));
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** 判断错误是否来自服务端维护态。 */
export function isEnergyBenchmarkMaintenanceError(error) {
  return Number(error?.response?.status) === 423 || error?.response?.data?.error?.code === 'MAINTENANCE_IN_PROGRESS';
}

/** 将页面请求错误统一投影为状态、原因码、文案和重复提示抑制标志。 */
export function projectEnergyBenchmarkRequestError(error, action = '请求') {
  const status = Number(error?.response?.status) || 0;
  const apiError = error?.response?.data?.error || error?.apiError || {};
  const nestedCode = String(apiError?.details?.code || '').trim();
  const outerCode = String(apiError.code || '').trim();
  // badRequest 会把领域原因码放在 details.code；优先保留它，避免只显示 BAD_REQUEST。
  const code = nestedCode || outerCode;
  const statusLabels = {
    401: '登录状态已失效，请重新登录后再试',
    403: '当前账号没有执行此操作的权限',
    413: '请求数据超过服务端大小限制，请减少实际对象数量或文件大小',
    423: '系统处于维护态，当前写操作不可执行'
  };
  const reasonLabel = ENERGY_BENCHMARK_REQUEST_REASON_LABELS[code]
    || ENERGY_BENCHMARK_REASON_LABELS[code]
    || statusLabels[status]
    || String(apiError.message || error?.message || '接口请求失败').trim();
  const reasonCode = code || (status ? `HTTP_${status}` : 'NETWORK_ERROR');
  return {
    status,
    code: reasonCode,
    message: `${action}失败：${reasonLabel}（${reasonCode}）`,
    pageLevel: [401, 403, 413, 423].includes(status),
    suppressToast: [401, 403, 413, 423].includes(status)
  };
}

/** 从 bootstrap 投影页面所需维护态，不展示任何本地路径。 */
export function projectEnergyBenchmarkMaintenance(bootstrap = {}) {
  return {
    active: bootstrap?.maintenance?.active === true,
    reason: String(bootstrap?.maintenance?.reason || '')
  };
}

/** 稳定序列化对象键顺序，供请求和分析快照比较。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** 判断输入是否为明确的有限数字，空值不得按零处理。 */
function hasFiniteInput(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

/** 判断开始结束时间是否为共享规则支持的严格 UTC Z 左闭右开区间。 */
export function isEnergyBenchmarkStrictUtcRange(startUtc, endUtc) {
  const startResult = parseStrictUtcDateTime(startUtc);
  const endResult = parseStrictUtcDateTime(endUtc);
  return startResult.valid && endResult.valid && startResult.value < endResult.value;
}

/** 移除对象中的空字符串、null 和 undefined。 */
function compactObject(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 将可选文本规范为空值或去空白字符串。 */
function nullableText(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return String(value).trim();
}

/** 将数值输入规范为有限数字或 null，不把空值改写为零。 */
function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/** 对字符串单元格执行公式注入防护；数字类型保留为数字文本。 */
function protectCsvFormula(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^[\t\r]|^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

/** 按 RFC 4180 转义单元格，并先执行公式注入防护。 */
function escapeCsvCell(value) {
  const text = protectCsvFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
