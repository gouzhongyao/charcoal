import { parseStrictUtcDateTime } from './dateTimeFields.js';

// 能流节点类型及中文文案模块。
export const ENERGY_FLOW_NODE_TYPES = Object.freeze([
  { value: 'source', label: '来源' },
  { value: 'process', label: '过程' },
  { value: 'storage', label: '储能' },
  { value: 'sink', label: '去向' },
  { value: 'loss', label: '已知损耗' },
  { value: 'boundary', label: '边界' }
]);

// 能流来源类型及中文文案模块。
export const ENERGY_FLOW_SOURCE_TYPES = Object.freeze([
  { value: 'timeseries', label: '时序能耗' },
  { value: 'monthly_energy', label: '月度能耗' },
  { value: 'generation', label: '发电记录' },
  { value: 'explicit_edge_value', label: '显式导入边值' }
]);

// 发电记录必须显式选择的字段模块，禁止自动抵扣。
export const GENERATION_VALUE_FIELDS = Object.freeze([
  { value: 'generation', label: '发电量（generation）' },
  { value: 'self_use', label: '自发自用量（self_use）' },
  { value: 'grid_export', label: '上网电量（grid_export）' }
]);

// 来源映射字段白名单模块，页面只允许生成后端识别的显式选择器。
export const SOURCE_MAPPING_FIELD_WHITELIST = Object.freeze({
  explicit_edge_value: Object.freeze(['reference']),
  timeseries: Object.freeze(['reference', 'recordIds', 'meterDeviceId', 'sourceTimeZone']),
  monthly_energy: Object.freeze(['reference', 'recordIds', 'meterDeviceId', 'organizationUnitId', 'sourceTimeZone']),
  generation: Object.freeze(['reference', 'recordIds', 'organizationUnitId', 'valueField'])
});

// 能流分析原因码中文解释模块。
export const ENERGY_FLOW_REASON_TEXT = Object.freeze({
  SOURCE_RECORD_REUSED_ACROSS_EDGES: '同一来源记录被多条边重复使用，相关边已阻止重复计入。',
  SOURCE_OVERLAP_OR_DUPLICATE: '来源区间重叠、重复，或同一来源记录跨边复用。',
  MISSING_CONVERSION_FACTOR: '缺少覆盖统计期的有效折标系数，不能生成折标结论。',
  FACTOR_PERIOD_AMBIGUOUS: '统计期命中多个折标系数版本，不能自行选择或平均。',
  TOPOLOGY_SOURCE_UNMAPPED: '边未完成显式来源映射。',
  UNIT_NOT_COMPARABLE: '配置单位与能源标准单位不可比，不能直接合计。',
  BALANCE_ITEM_UNMAPPED: '储能变化或平衡项目未提供显式来源。',
  COVERAGE_BELOW_THRESHOLD: '来源覆盖统计期不足，当前值按缺失处理。',
  NO_TIMESERIES_DATA: '统计期内没有匹配来源记录。',
  GENERATION_BOUNDARY_UNCONFIRMED: '发电边界未确认；必须显式选择发电量、自发自用量或上网电量。',
  ANALYSIS_NUMERIC_OVERFLOW: '分析数值超出可安全计算范围。',
  SOURCE_MAPPING_REFERENCE_MISSING: '来源映射缺少可追溯标识。',
  GENERATION_SELECTOR_OR_VALUE_FIELD_MISSING: '发电来源缺少记录选择器或 generation/self_use/grid_export 字段。',
  SOURCE_TYPE_UNSUPPORTED: '来源类型不受当前能流契约支持。',
  ENERGY_FLOW_RANGE_TOO_LARGE: '统计期超过能流分析允许的约 36 个月范围。',
  ENERGY_FLOW_RANGE_MODE_CONFLICT: '月份范围和 UTC 时间范围不能同时提交。',
  INVALID_MONTH_RANGE: '开始月份不能晚于结束月份。',
  SOURCE_MAPPING_RECORD_IDS_INVALID: '来源映射中的记录 ID 集合无效。',
  SOURCE_MAPPING_METER_ID_INVALID: '来源映射中的计量器具 ID 无效。',
  SOURCE_MAPPING_ORGANIZATION_ID_INVALID: '来源映射中的用能单元 ID 无效。',
  SOURCE_MAPPING_TIME_ZONE_INVALID: '来源映射中的时区无效。',
  TIMESERIES_SELECTOR_MISSING: '时序来源缺少记录 ID 或计量器具选择器。',
  MONTHLY_ENERGY_SELECTOR_MISSING: '月度能耗来源缺少记录、计量器具或用能单元选择器。'
});

// 能源分面固定色序模块；三个色槽已按拓扑全配对场景校验，文字和表格承担第二编码。
export const ENERGY_FLOW_SERIES_COLORS = Object.freeze([
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)'
]);
// 默认能源业务键色域模块；同一业务键不随当前可见集合或排序变化。
export const ENERGY_FLOW_DEFAULT_COLOR_DOMAIN = Object.freeze(['electricity', 'photovoltaic', 'natural_gas']);
// 超出固定色序的能源分面统一折叠为“其他”，不得循环复用分类色。
export const ENERGY_FLOW_OTHER_SERIES_COLOR = 'var(--series-other)';

// 能流分析正文允许字段模块。
export const ENERGY_FLOW_ANALYSIS_FIELDS = Object.freeze(['startMonth', 'endMonth', 'startUtc', 'endUtc', 'storageChanges']);
// 能流页面 HTTP 状态中文表达模块。
export const ENERGY_FLOW_HTTP_STATUS_TEXT = Object.freeze({
  401: '登录状态已失效，请重新登录后重试。',
  403: '当前账号没有执行此能流操作的权限。',
  413: '上传文件超过服务端允许大小，请缩小文件后重新选择。',
  423: '系统处于维护态，当前写入或导入执行已被阻断。'
});

// 能流严格 UTC 字段定义模块。
const ENERGY_FLOW_MODEL_UTC_FIELDS = Object.freeze([
  Object.freeze({ fieldName: 'effectiveStartUtc', label: '模型有效期开始 UTC' }),
  Object.freeze({ fieldName: 'effectiveEndUtc', label: '模型有效期结束 UTC' })
]);
const ENERGY_FLOW_ANALYSIS_UTC_FIELDS = Object.freeze([
  Object.freeze({ fieldName: 'startUtc', label: '分析开始 UTC' }),
  Object.freeze({ fieldName: 'endUtc', label: '分析结束 UTC' })
]);

/**
 * 规范指定能流 UTC 字段；合法零毫秒统一为秒精度，非法字段清空且仅在诊断中保留原文。
 * @param {object} source 原始表单或筛选对象。
 * @param {{fieldName:string,label:string}[]} definitions UTC 字段定义。
 * @returns {{valid:boolean,value:object,errors:string[],message:string}} 规范结果。
 */
function normalizeEnergyFlowUtcFields(source = {}, definitions = []) {
  const value = { ...(source || {}) };
  const errors = [];
  definitions.forEach(({ fieldName, label }) => {
    const originalValue = value[fieldName];
    const result = parseStrictUtcDateTime(originalValue);
    if (result.valid) {
      value[fieldName] = result.value;
      return;
    }
    const originalDiagnostic = originalValue === '' || originalValue === null || originalValue === undefined
      ? ''
      : `（原值：${String(originalValue)}）`;
    value[fieldName] = '';
    errors.push(`${label}：${result.message}${originalDiagnostic}`);
  });
  return {
    valid: errors.length === 0,
    value,
    errors: Object.freeze(errors),
    message: errors.join('；')
  };
}

/** 规范能流模型有效期 UTC 字段。 */
export function normalizeEnergyFlowModelUtcFields(model = {}) {
  return normalizeEnergyFlowUtcFields(model, ENERGY_FLOW_MODEL_UTC_FIELDS);
}

/** 规范 UTC 模式分析字段；月份模式保持原筛选不变。 */
export function normalizeEnergyFlowAnalysisUtcFields(filters = {}) {
  if (filters?.rangeMode !== 'utc') {
    return { valid: true, value: { ...(filters || {}) }, errors: Object.freeze([]), message: '' };
  }
  return normalizeEnergyFlowUtcFields(filters, ENERGY_FLOW_ANALYSIS_UTC_FIELDS);
}

/**
 * 将任意记录投影为指定字段白名单。
 * @param {object} source 原始记录。
 * @param {string[]} fields 允许字段。
 * @returns {object} 投影结果。
 */
export function pickEnergyFlowFields(source = {}, fields = []) {
  return Object.fromEntries(fields
    .filter((fieldName) => Object.prototype.hasOwnProperty.call(source || {}, fieldName))
    .map((fieldName) => [fieldName, source[fieldName]]));
}

/**
 * 将逗号文本或数组规范为去重正整数 ID。
 * @param {string|number[]} value 原始 ID 集合。
 * @returns {number[]|undefined} 合法 ID 集合。
 */
export function normalizeEnergyFlowRecordIds(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/);
  const ids = [...new Set(items.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0))];
  return ids.length ? ids : undefined;
}

/**
 * 按来源类型构造显式来源映射，仅保留后端白名单字段。
 * @param {string} sourceType 来源类型。
 * @param {object} input 页面输入。
 * @returns {object} 来源映射。
 */
export function buildEnergyFlowSourceMapping(sourceType, input = {}) {
  const allowedFields = SOURCE_MAPPING_FIELD_WHITELIST[sourceType] || [];
  const normalized = {
    reference: String(input.reference || '').trim(),
    recordIds: normalizeEnergyFlowRecordIds(input.recordIds),
    meterDeviceId: Number(input.meterDeviceId) > 0 ? Number(input.meterDeviceId) : undefined,
    organizationUnitId: Number(input.organizationUnitId) > 0 ? Number(input.organizationUnitId) : undefined,
    sourceTimeZone: String(input.sourceTimeZone || '').trim() || undefined,
    valueField: GENERATION_VALUE_FIELDS.some((item) => item.value === input.valueField) ? input.valueField : undefined
  };
  return Object.fromEntries(allowedFields
    .filter((fieldName) => normalized[fieldName] !== undefined && normalized[fieldName] !== '')
    .map((fieldName) => [fieldName, normalized[fieldName]]));
}

/**
 * 生成人类可读的来源映射摘要。
 * @param {object} edge 能流边。
 * @returns {string} 来源摘要。
 */
export function energyFlowSourceSummary(edge = {}) {
  const mapping = edge.sourceMapping || {};
  const sourceLabel = ENERGY_FLOW_SOURCE_TYPES.find((item) => item.value === edge.sourceType)?.label || edge.sourceType || '未配置来源';
  const selectors = [
    mapping.reference && `标识 ${mapping.reference}`,
    mapping.recordIds?.length && `记录 ${mapping.recordIds.join(',')}`,
    mapping.meterDeviceId && `仪表 #${mapping.meterDeviceId}`,
    mapping.organizationUnitId && `用能单元 #${mapping.organizationUnitId}`,
    mapping.sourceTimeZone && `时区 ${mapping.sourceTimeZone}`,
    mapping.valueField && GENERATION_VALUE_FIELDS.find((item) => item.value === mapping.valueField)?.label
  ].filter(Boolean);
  return `${sourceLabel}${selectors.length ? `；${selectors.join('；')}` : '；未映射'}`;
}

/**
 * 规范显式储能变化，仅保留用户明确填写变化值的项目；显式 0 会被保留。
 * @param {object[]} storageChanges 页面储能变化输入。
 * @returns {object[]} 可提交储能变化。
 */
export function normalizeEnergyFlowStorageChanges(storageChanges = []) {
  return (Array.isArray(storageChanges) ? storageChanges : [])
    .filter((row) => row?.value !== '' && row?.value !== null && row?.value !== undefined)
    .map((row) => ({
      ...row,
      sourceMapping: row?.sourceMapping ? { ...row.sourceMapping } : row?.sourceMapping
    }));
}

/**
 * 构造后端分析白名单正文，展示视图和来源时区不会被误传给后端。
 * @param {object} filters 分析筛选。
 * @param {object[]} storageChanges 显式储能变化。
 * @returns {object} API 正文。
 */
export function buildEnergyFlowAnalysisPayload(filters = {}, storageChanges = []) {
  const normalizedStorageChanges = normalizeEnergyFlowStorageChanges(storageChanges);
  const raw = filters.rangeMode === 'utc'
    ? { startUtc: filters.startUtc, endUtc: filters.endUtc, storageChanges: normalizedStorageChanges }
    : { startMonth: filters.startMonth, endMonth: filters.endMonth, storageChanges: normalizedStorageChanges };
  return Object.fromEntries(Object.entries(pickEnergyFlowFields(raw, ENERGY_FLOW_ANALYSIS_FIELDS))
    .filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/**
 * 深度复制并冻结请求快照，避免响应等待期间被响应式输入改写。
 * @param {*} value 待冻结值。
 * @returns {*} 冻结副本。
 */
function cloneAndFreezeEnergyFlowSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreezeEnergyFlowSnapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreezeEnergyFlowSnapshot(item)])));
  }
  return value;
}

/**
 * 将分析指纹对象稳定序列化，避免对象键顺序造成误判。
 * @param {*} value 待序列化值。
 * @returns {string} 稳定序列化文本。
 */
function stableSerializeEnergyFlowValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerializeEnergyFlowValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerializeEnergyFlowValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 生成与后端分析输入一致的稳定指纹，储能行顺序变化不会产生虚假脏状态。
 * @param {*} modelId 模型 ID。
 * @param {object} filters 分析筛选。
 * @param {object[]} storageChanges 储能变化。
 * @returns {string} 当前分析输入指纹。
 */
export function createEnergyFlowAnalysisInputFingerprint(modelId, filters = {}, storageChanges = []) {
  const payload = buildEnergyFlowAnalysisPayload(filters, storageChanges);
  const normalizedStorageChanges = [...(payload.storageChanges || [])]
    .sort((left, right) => stableSerializeEnergyFlowValue(left).localeCompare(stableSerializeEnergyFlowValue(right)));
  return stableSerializeEnergyFlowValue({
    modelId: Number(modelId),
    range: filters.rangeMode === 'utc'
      ? { rangeMode: 'utc', startUtc: payload.startUtc || '', endUtc: payload.endUtc || '' }
      : { rangeMode: 'month', startMonth: payload.startMonth || '', endMonth: payload.endMonth || '' },
    storageChanges: normalizedStorageChanges
  });
}

/**
 * 判断分析响应是否仍绑定最新票据、当前模型和当前输入。
 * @param {object} context 响应提交上下文。
 * @returns {boolean} 是否允许提交响应。
 */
export function canCommitEnergyFlowAnalysisResponse(context = {}) {
  return Boolean(context.isLatest
    && Number(context.snapshot?.modelId) === Number(context.currentModelId)
    && context.snapshot?.inputFingerprint
    && context.snapshot.inputFingerprint === context.currentInputFingerprint);
}

/**
 * 创建分析请求快照，固定模型、筛选、储能变化、输入指纹和最终白名单正文。
 * @param {*} modelId 模型 ID。
 * @param {object} filters 分析筛选。
 * @param {object[]} storageChanges 储能变化。
 * @returns {object} 冻结请求快照。
 */
export function createEnergyFlowAnalysisRequestSnapshot(modelId, filters = {}, storageChanges = []) {
  const filterSnapshot = cloneAndFreezeEnergyFlowSnapshot(filters || {});
  const storageSnapshot = cloneAndFreezeEnergyFlowSnapshot(normalizeEnergyFlowStorageChanges(storageChanges));
  return cloneAndFreezeEnergyFlowSnapshot({
    modelId: Number(modelId),
    filters: filterSnapshot,
    storageChanges: storageSnapshot,
    inputFingerprint: createEnergyFlowAnalysisInputFingerprint(modelId, filterSnapshot, storageSnapshot),
    payload: buildEnergyFlowAnalysisPayload(filterSnapshot, storageSnapshot)
  });
}

/**
 * 创建 latest-response 守卫；新请求或主动失效后，旧票据不可再提交响应。
 * @returns {{begin:function,invalidate:function,isCurrent:function}} 请求守卫。
 */
export function createEnergyFlowLatestResponseGuard() {
  let latestRequestId = 0;
  return {
    begin(snapshot = null) {
      latestRequestId += 1;
      return Object.freeze({ requestId: latestRequestId, snapshot });
    },
    invalidate() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent(ticket) {
      return Number(ticket?.requestId) === latestRequestId;
    }
  };
}

/**
 * 按后端分页契约逐页收集完整数据，避免固定截断在单页上限。
 * @param {function(object):Promise<object>} fetchPage 分页请求函数。
 * @param {object} params 固定查询参数。
 * @param {object} options 分页选项。
 * @returns {Promise<object[]>} 全部去重行。
 */
export async function collectEnergyFlowPaginatedRows(fetchPage, params = {}, options = {}) {
  const requestedPageSize = Math.max(1, Number(options.pageSize) || 200);
  const maximumPages = Math.max(1, Number(options.maximumPages) || 10000);
  const rows = [];
  const seenKeys = new Set();
  let page = 1;
  while (page <= maximumPages) {
    const response = await fetchPage({ ...params, page, pageSize: requestedPageSize });
    const pageRows = Array.isArray(response?.data) ? response.data : [];
    const pagination = response?.meta?.pagination || {};
    let addedUniqueCount = 0;
    pageRows.forEach((row, index) => {
      const stableKey = row?.id === null || row?.id === undefined ? `page:${page}:row:${index}` : `id:${row.id}`;
      if (seenKeys.has(stableKey)) return;
      seenKeys.add(stableKey);
      rows.push(row);
      addedUniqueCount += 1;
    });
    const totalPagesValue = pagination.totalPages;
    const totalValue = pagination.total;
    const totalPages = totalPagesValue === null || totalPagesValue === undefined || totalPagesValue === '' ? null : Number(totalPagesValue);
    const total = totalValue === null || totalValue === undefined || totalValue === '' ? null : Number(totalValue);
    const hasValidTotalPages = Number.isSafeInteger(totalPages) && totalPages > 0;
    const hasValidTotal = Number.isSafeInteger(total) && total >= 0;
    const effectivePageSize = Math.max(1, Number(pagination.pageSize) || requestedPageSize);

    if (pageRows.length && addedUniqueCount === 0) {
      throw new Error(`分页停滞：第 ${page} 页没有新增唯一 ID，请检查服务端是否重复返回同一页。`);
    }
    if (hasValidTotal && rows.length > total) {
      throw new Error(`分页数据不完整：去重后唯一行数 ${rows.length} 超过服务端总条数 ${total}。`);
    }
    if (hasValidTotal && rows.length === total) return rows;
    if (!pageRows.length) {
      if (hasValidTotal) {
        throw new Error(`分页数据不完整：第 ${page} 页提前返回空页，当前仅收到 ${rows.length}/${total} 条唯一数据。`);
      }
      if (hasValidTotalPages && page < totalPages) {
        throw new Error(`分页数据不完整：第 ${page} 页在到达总页数 ${totalPages} 前提前返回空页。`);
      }
      return rows;
    }
    if (hasValidTotalPages && page >= totalPages) {
      if (hasValidTotal && rows.length !== total) {
        throw new Error(`分页数据不完整：到达总页数后仅收到 ${rows.length}/${total} 条唯一数据。`);
      }
      return rows;
    }
    if (!hasValidTotalPages && !hasValidTotal && pageRows.length < effectivePageSize) return rows;
    page += 1;
  }
  throw new Error(`分页读取超过安全上限 ${maximumPages} 页。`);
}

/**
 * 规范化显式坐标并生成确定性的 SVG 节点和方向边。
 * @param {object[]} nodes 显式节点。
 * @param {object[]} edges 显式边。
 * @param {object} options 布局尺寸。
 * @returns {object} 确定性拓扑展示模型。
 */
export function buildDeterministicEnergyFlowTopology(nodes = [], edges = [], options = {}) {
  const width = Number(options.width) || 1000;
  const height = Number(options.height) || 600;
  const padding = Number(options.padding) || 90;
  const nodeWidth = Number(options.nodeWidth) || 150;
  const nodeHeight = Number(options.nodeHeight) || 58;
  const sortedNodes = [...nodes].sort((left, right) => Number(left.id) - Number(right.id) || String(left.nodeCode).localeCompare(String(right.nodeCode)));
  const xs = sortedNodes.map((node) => Number(node.x)).filter(Number.isFinite);
  const ys = sortedNodes.map((node) => Number(node.y)).filter(Number.isFinite);
  const minimumX = xs.length ? Math.min(...xs) : 0;
  const maximumX = xs.length ? Math.max(...xs) : 0;
  const minimumY = ys.length ? Math.min(...ys) : 0;
  const maximumY = ys.length ? Math.max(...ys) : 0;
  const spanX = Math.max(maximumX - minimumX, 1);
  const spanY = Math.max(maximumY - minimumY, 1);
  const scaleX = (width - padding * 2) / spanX;
  const scaleY = (height - padding * 2) / spanY;
  const nodeRows = sortedNodes.map((node, index) => {
    const explicitX = Number.isFinite(Number(node.x)) ? Number(node.x) : index;
    const explicitY = Number.isFinite(Number(node.y)) ? Number(node.y) : 0;
    return {
      ...node,
      displayX: maximumX === minimumX ? width / 2 : padding + (explicitX - minimumX) * scaleX,
      displayY: maximumY === minimumY ? height / 2 : padding + (explicitY - minimumY) * scaleY,
      width: nodeWidth,
      height: nodeHeight
    };
  });
  const nodeById = new Map(nodeRows.map((node) => [Number(node.id), node]));
  const edgeRows = [...edges]
    .sort((left, right) => Number(left.id) - Number(right.id) || String(left.edgeCode).localeCompare(String(right.edgeCode)))
    .map((edge) => {
      const fromNode = nodeById.get(Number(edge.fromNodeId));
      const toNode = nodeById.get(Number(edge.toNodeId));
      if (!fromNode || !toNode) return { ...edge, visible: false };
      const deltaX = toNode.displayX - fromNode.displayX;
      const deltaY = toNode.displayY - fromNode.displayY;
      const distance = Math.max(Math.hypot(deltaX, deltaY), 1);
      const unitX = deltaX / distance;
      const unitY = deltaY / distance;
      const horizontalOffset = Math.min(nodeWidth / 2, Math.abs(unitX) > 0.01 ? nodeWidth / 2 : 0);
      const verticalOffset = Math.min(nodeHeight / 2, Math.abs(unitY) > 0.01 ? nodeHeight / 2 : 0);
      const startOffset = Math.max(Math.abs(unitX) * horizontalOffset, Math.abs(unitY) * verticalOffset);
      const endOffset = startOffset + 8;
      return {
        ...edge,
        visible: true,
        fromNode,
        toNode,
        x1: fromNode.displayX + unitX * startOffset,
        y1: fromNode.displayY + unitY * startOffset,
        x2: toNode.displayX - unitX * endOffset,
        y2: toNode.displayY - unitY * endOffset,
        labelX: (fromNode.displayX + toNode.displayX) / 2,
        labelY: (fromNode.displayY + toNode.displayY) / 2 - 8,
        directionLabel: `${fromNode.nodeName || fromNode.nodeCode} → ${toNode.nodeName || toNode.nodeCode}`
      };
    });
  return { width, height, nodeWidth, nodeHeight, nodes: nodeRows, edges: edgeRows };
}

/**
 * 按完整业务色域构造稳定颜色注册表；容量外业务键统一使用其他色并依赖文本第二编码。
 * @param {string[]} colorDomain 完整能源业务键顺序。
 * @returns {Map<string,number>} 业务键到固定色槽的映射。
 */
export function buildStableEnergyFlowColorRegistry(colorDomain = []) {
  const normalizedDomain = [...new Set([
    ...ENERGY_FLOW_DEFAULT_COLOR_DOMAIN,
    ...(Array.isArray(colorDomain) ? colorDomain : [])
  ].map((key) => String(key || '').trim()).filter(Boolean))];
  const fixedSlotByBusinessKey = new Map(ENERGY_FLOW_DEFAULT_COLOR_DOMAIN.map((key, index) => [key, index + 1]));
  return new Map(normalizedDomain.map((key) => [key, fixedSlotByBusinessKey.get(key) || 0]));
}

/**
 * 将拓扑展示模型与分析边值合并为 SVG 和表格共用行。
 * @param {object} layout 拓扑布局。
 * @param {object[]} edgeValues 分析边值。
 * @param {object} options 展示选项。
 * @returns {object[]} 边展示行。
 */
export function buildEnergyFlowEdgePresentation(layout = {}, edgeValues = [], options = {}) {
  const valuesByEdgeId = new Map(edgeValues.map((item) => [Number(item.edgeId), item]));
  const colorSlotByEnergyType = buildStableEnergyFlowColorRegistry(options.colorDomain);
  return (layout.edges || []).map((edge) => {
    const analysis = valuesByEdgeId.get(Number(edge.id)) || null;
    const energyTypeKey = String(edge.energyTypeCode || 'unknown');
    const colorSlot = colorSlotByEnergyType.get(energyTypeKey) || 0;
    return {
      ...edge,
      analysis,
      value: analysis?.value ?? null,
      observedValue: analysis?.observedValue ?? null,
      trueZero: analysis?.trueZero === true,
      analysisStatus: analysis?.status || 'not_analyzed',
      reasonCodes: [...new Set([...(edge.reasonCodes || []), ...(edge.configurationErrors || []), ...(analysis?.reasonCodes || []), ...(analysis?.configurationErrors || [])])],
      colorSlot,
      colorBusinessKey: energyTypeKey,
      isOtherSeries: colorSlot === 0,
      color: colorSlot > 0 ? ENERGY_FLOW_SERIES_COLORS[colorSlot - 1] : ENERGY_FLOW_OTHER_SERIES_COLOR
    };
  });
}

/**
 * 区分真实零、缺失和可用数值。
 * @param {*} value 数值。
 * @param {boolean} trueZero 是否为服务端确认的真实零。
 * @param {number} digits 小数位。
 * @returns {string} 展示文本。
 */
export function formatEnergyFlowValue(value, trueZero = false, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '缺失';
  if (trueZero || Number(value) === 0) return '0';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value));
}

/**
 * 返回原因码中文文案，未知码仍保留技术码便于追溯。
 * @param {string} code 原因码。
 * @returns {string} 中文说明。
 */
export function energyFlowReasonText(code) {
  return ENERGY_FLOW_REASON_TEXT[code] || `未识别原因：${code}`;
}

// 通用 API 错误信封码模块；这些码只描述 HTTP 信封，不得冒充能流业务原因。
const ENERGY_FLOW_ENVELOPE_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'LOCKED',
  'INTERNAL_ERROR'
]);

/**
 * 从字符串、原因对象或嵌套数组中提取业务原因码。
 * @param {*} value 原因码载荷。
 * @returns {string[]} 业务原因码。
 */
function collectEnergyFlowBusinessCodes(value) {
  if (Array.isArray(value)) return value.flatMap(collectEnergyFlowBusinessCodes);
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return [
    value.code,
    value.reasonCode,
    ...collectEnergyFlowBusinessCodes(value.reasonCodes),
    ...collectEnergyFlowBusinessCodes(value.configurationErrors),
    ...collectEnergyFlowBusinessCodes(value.authorizationErrors)
  ].filter(Boolean);
}

/**
 * 将共享 HTTP 错误统一转换为能流页面可理解表达，并说明当前影响。
 * @param {object} error 请求错误。
 * @param {string} fallback 无服务端消息时的兜底文案。
 * @param {string} impact 当前失败影响。
 * @returns {string} 页面错误文案。
 */
export function energyFlowRequestErrorMessage(error, fallback = '能流请求失败。', impact = '') {
  const status = Number(error?.response?.status);
  const apiError = error?.apiError || error?.response?.data?.error || {};
  const reasonCodes = [...new Set([
    ...collectEnergyFlowBusinessCodes(apiError.reasonCodes),
    ...collectEnergyFlowBusinessCodes(apiError.configurationErrors),
    ...collectEnergyFlowBusinessCodes(apiError.authorizationErrors),
    ...collectEnergyFlowBusinessCodes(apiError.reasonCode),
    ...collectEnergyFlowBusinessCodes(apiError.details?.code),
    ...collectEnergyFlowBusinessCodes(apiError.details?.reasonCode),
    ...collectEnergyFlowBusinessCodes(apiError.details?.reasonCodes),
    ...collectEnergyFlowBusinessCodes(apiError.details?.configurationErrors),
    ...collectEnergyFlowBusinessCodes(apiError.details?.authorizationErrors),
    ...(ENERGY_FLOW_ENVELOPE_CODES.has(apiError.code) ? [] : collectEnergyFlowBusinessCodes(apiError.code))
  ].filter((code) => !ENERGY_FLOW_ENVELOPE_CODES.has(code)))];
  const statusText = ENERGY_FLOW_HTTP_STATUS_TEXT[status];
  const baseText = statusText || apiError.message || error?.message || fallback;
  const reasonText = reasonCodes
    .filter((code) => !String(baseText).includes(code))
    .map((code) => ENERGY_FLOW_REASON_TEXT[code] ? `${code}：${ENERGY_FLOW_REASON_TEXT[code]}` : `原因码 ${code}`)
    .join('；');
  return [baseText, reasonText, impact].filter(Boolean).join('；');
}

/**
 * 生成上传文件稳定指纹，用于将预演结果绑定当前受控文件。
 * @param {object|null} file 浏览器 File 或上传文件对象。
 * @returns {string} 文件指纹。
 */
export function createEnergyFlowImportFileFingerprint(file) {
  if (!file) return '';
  const rawFile = file.raw || file;
  return stableSerializeEnergyFlowValue({
    name: String(rawFile.name || file.name || ''),
    size: Number(rawFile.size ?? file.size ?? 0),
    type: String(rawFile.type || file.type || ''),
    lastModified: Number(rawFile.lastModified ?? file.lastModified ?? 0),
    uid: String(file.uid || rawFile.uid || '')
  });
}

/**
 * 判断预演绑定是否仍属于当前文件、最新请求且不在加载中。
 * @param {object} context 预演执行上下文。
 * @returns {boolean} 绑定是否有效。
 */
function hasCurrentEnergyFlowImportBinding(context = {}) {
  return Boolean(!context.loading
    && context.isLatest
    && context.currentFileFingerprint
    && context.previewFileFingerprint
    && context.currentFileFingerprint === context.previewFileFingerprint);
}

/**
 * 判断单批次能流导入预演是否具备完整执行上下文。
 * @param {object|null} preview 预演结果。
 * @param {object} context 当前文件和请求绑定上下文。
 * @returns {boolean} 是否可执行。
 */
function canExecuteEnergyFlowSingleBatchImport(preview, context = {}) {
  return Boolean(hasCurrentEnergyFlowImportBinding(context)
    && preview?.batchId
    && preview?.confirmText
    && preview?.previewSignature
    && preview?.previewAuditDigest
    && Number(preview?.expectedWouldImport) > 0
    && Array.isArray(preview?.candidateRows)
    && Array.isArray(preview?.candidateRowIds)
    && preview.candidateRows.length === Number(preview.expectedWouldImport)
    && preview.candidateRowIds.length === Number(preview.expectedWouldImport));
}

/** 判断模型导入预演是否具备执行上下文。 */
export function canExecuteEnergyFlowModelImport(preview, context = {}) {
  return canExecuteEnergyFlowSingleBatchImport(preview, context);
}

/** 判断节点导入预演是否具备执行上下文。 */
export function canExecuteEnergyFlowNodeImport(preview, context = {}) {
  return canExecuteEnergyFlowSingleBatchImport(preview, context);
}

/**
 * 构造单批次能流导入完整受控执行正文。
 * @param {object} preview 可信预演结果。
 * @returns {object} execute 正文。
 */
function buildEnergyFlowSingleBatchImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/**
 * 冻结能流导入 execute 的种类、预演和文件指纹，避免异步完成时读取变化后的响应式状态。
 * @param {string} kind 导入种类。
 * @param {object} preview 当前预演。
 * @param {string} fingerprint 当前文件指纹。
 * @returns {object} 冻结执行快照。
 */
export function createEnergyFlowImportExecuteSnapshot(kind, preview, fingerprint) {
  return cloneAndFreezeEnergyFlowSnapshot({
    kind: String(kind || ''),
    preview: preview || null,
    fingerprint: String(fingerprint || '')
  });
}

/**
 * 判断 execute 响应是否仍属于最新请求及其冻结文件上下文。
 * @param {object} context execute 响应上下文。
 * @returns {boolean} 是否允许提交响应。
 */
export function canCommitEnergyFlowImportExecuteResponse(context = {}) {
  return Boolean(context.isLatest
    && context.snapshot?.kind
    && context.snapshot?.preview
    && context.snapshot?.fingerprint
    && context.snapshot.kind === context.currentKind
    && context.snapshot.fingerprint === context.currentFingerprint);
}

/** 构造模型导入服务端受控最小执行正文。 */
export function buildEnergyFlowModelImportExecutePayload(preview = {}) {
  return buildEnergyFlowSingleBatchImportExecutePayload(preview);
}

/** 构造节点导入服务端受控最小执行正文。 */
export function buildEnergyFlowNodeImportExecutePayload(preview = {}) {
  return buildEnergyFlowSingleBatchImportExecutePayload(preview);
}

/**
 * 判断双工作表预演是否具备最小执行上下文。
 * @param {object|null} preview 预演结果。
 * @param {object} context 当前文件和请求绑定上下文。
 * @returns {boolean} 是否可执行。
 */
export function canExecuteEnergyFlowBundleImport(preview, context = {}) {
  return Boolean(hasCurrentEnergyFlowImportBinding(context)
    && preview?.edgeBatchId
    && preview?.recordBatchId
    && Number(preview.edgeBatchId) !== Number(preview.recordBatchId)
    && preview?.confirmText
    && Number(preview?.expectedWouldImport) > 0);
}

/**
 * 构造双工作表导入服务端受控最小正文，不提交客户端候选和签名。
 * @param {object} preview 可信预演结果。
 * @returns {object} execute 正文。
 */
export function buildEnergyFlowBundleImportExecutePayload(preview = {}) {
  return {
    edgeBatchId: preview.edgeBatchId,
    recordBatchId: preview.recordBatchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}
