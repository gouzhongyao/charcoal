/** 能效平衡页面稳定权限编码。 */
export const ENERGY_BALANCE_PERMISSIONS = Object.freeze({
  view: 'energy:balance:view',
  manage: 'energy:balance:manage',
  calculate: 'energy:balance:calculate',
  suggestionReview: 'energy:balance:suggestion:review'
});

/** 九类显式平衡角色及其中文口径。 */
export const BALANCE_ROLE_DEFINITIONS = Object.freeze([
  { value: 'input', label: '外部输入', side: 'input', description: '从平衡边界外部进入的能源。' },
  { value: 'self_generation', label: '自发自用输入', side: 'input', description: '仅显式映射发电自用量，不自动抵扣能耗台账。' },
  { value: 'inventory_decrease', label: '库存减少（输入）', side: 'input', description: '库存释放形成的平衡输入。' },
  { value: 'adjustment_increase', label: '调整增加（输入）', side: 'input', description: '有依据的人工增加调整。' },
  { value: 'output', label: '外送 / 输出', side: 'output', description: '离开边界的能源；发电来源仅可显式映射上网量。' },
  { value: 'useful_utilization', label: '有效利用', side: 'output', description: '有事实依据的有效利用量。' },
  { value: 'known_loss', label: '已知损耗', side: 'output', description: '已有证据确认的损耗，不包含不可解释差额。' },
  { value: 'inventory_increase', label: '库存增加（输出）', side: 'output', description: '进入库存形成的平衡输出。' },
  { value: 'adjustment_decrease', label: '调整减少（输出）', side: 'output', description: '有依据的人工减少调整。' }
]);

/** 平衡项目显式来源类型及其中文口径。 */
export const BALANCE_SOURCE_TYPE_DEFINITIONS = Object.freeze([
  { value: 'timeseries', label: '时序能耗记录', recordIdsOptional: true },
  { value: 'monthly_energy', label: '月度能耗记录', recordIdsRequired: true },
  { value: 'generation', label: '发电记录', recordIdsRequired: true },
  { value: 'explicit_edge_value', label: '显式能流边值', recordIdsRequired: true },
  { value: 'explicit_balance_value', label: '人工显式平衡值', recordIdsRequired: false }
]);

/** 计算冻结或质量原因码的用户可读说明。 */
export const BALANCE_REASON_LABELS = Object.freeze({
  NO_TIMESERIES_DATA: '统计期内没有匹配的时序数据',
  COVERAGE_BELOW_THRESHOLD: '来源覆盖率不足 100%',
  MIXED_INTERVAL_GRANULARITY: '时序粒度混合，不能直接比较',
  SOURCE_OVERLAP_OR_DUPLICATE: '来源记录重叠或被重复计入',
  UNIT_NOT_COMPARABLE: '来源单位与项目原单位不可比',
  MISSING_CONVERSION_FACTOR: '缺少统计期内有效的 kgce 折标系数',
  FACTOR_PERIOD_AMBIGUOUS: '统计期内折标系数有效期存在歧义',
  MISSING_SHIFT_SCHEDULE: '缺少班次配置',
  DEVICE_STATE_GAP: '设备状态存在缺口',
  MISSING_PRODUCTION_OUTPUT: '缺少产量事实',
  TOPOLOGY_SOURCE_UNMAPPED: '能流拓扑来源未映射',
  GENERATION_BOUNDARY_UNCONFIRMED: '发电边界尚未人工确认',
  BALANCE_ITEM_UNMAPPED: '平衡项目没有匹配到显式来源'
});

/** 建议人工状态的中文标签。 */
export const SUGGESTION_STATUS_LABELS = Object.freeze({
  unconfirmed: '待复核',
  accepted: '已接受',
  rejected: '已拒绝',
  resolved: '已解决'
});

/** 建议状态允许的人工流转。 */
export const SUGGESTION_STATUS_TRANSITIONS = Object.freeze({
  unconfirmed: Object.freeze(['accepted', 'rejected']),
  accepted: Object.freeze(['rejected', 'resolved']),
  rejected: Object.freeze([]),
  resolved: Object.freeze([])
});

/** 从对象中删除空查询字段。 */
export function compactEnergyBalanceQuery(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => (
    value !== '' && value !== null && value !== undefined
  )));
}

/** 构造边界列表查询参数。 */
export function buildBoundaryFilters(filters = {}, pagination = {}) {
  return compactEnergyBalanceQuery({
    status: filters.status,
    organizationUnitId: filters.organizationUnitId,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 构造边界项目查询参数。 */
export function buildItemFilters(filters = {}, pagination = {}) {
  return compactEnergyBalanceQuery({
    status: filters.status,
    role: filters.role,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 构造快照列表查询参数，运行编号是主要分组筛选键。 */
export function buildSnapshotFilters(filters = {}, pagination = {}) {
  return compactEnergyBalanceQuery({
    boundaryId: filters.boundaryId,
    energyTypeId: filters.energyTypeId,
    confirmationStatus: filters.confirmationStatus,
    calculationRunId: filters.calculationRunId,
    sourceDataDigest: filters.sourceDataDigest,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 构造建议列表查询参数，运行编号和摘要保持不同语义。 */
export function buildSuggestionFilters(filters = {}, pagination = {}) {
  return compactEnergyBalanceQuery({
    snapshotId: filters.snapshotId,
    boundaryId: filters.boundaryId,
    calculationRunId: filters.calculationRunId,
    sourceDataDigest: filters.sourceDataDigest,
    manualStatus: filters.manualStatus,
    priority: filters.priority,
    page: pagination.page,
    pageSize: pagination.pageSize
  });
}

/** 将快照严格按 calculationRunId 分组，绝不使用 digest 合并不同运行。 */
export function groupSnapshotsByCalculationRun(snapshots = []) {
  const runMap = new Map();
  snapshots.forEach((snapshot, index) => {
    const calculationRunId = typeof snapshot?.calculationRunId === 'string' && snapshot.calculationRunId
      ? snapshot.calculationRunId
      : `missing-run:${snapshot?.id ?? index}`;
    if (!runMap.has(calculationRunId)) {
      runMap.set(calculationRunId, {
        calculationRunId,
        sourceDataDigest: snapshot?.sourceDataDigest || null,
        sourceDataDigests: new Set(),
        snapshots: [],
        latestCreatedAt: snapshot?.createdAt || ''
      });
    }
    const run = runMap.get(calculationRunId);
    run.snapshots.push(snapshot);
    if (snapshot?.sourceDataDigest) run.sourceDataDigests.add(snapshot.sourceDataDigest);
    if ((snapshot?.createdAt || '') > run.latestCreatedAt) run.latestCreatedAt = snapshot.createdAt;
  });
  return [...runMap.values()]
    .map((run) => ({
      calculationRunId: run.calculationRunId,
      sourceDataDigest: run.sourceDataDigest,
      digestIntegrityWarning: run.sourceDataDigests.size > 1,
      snapshots: [...run.snapshots].sort((left, right) => Number(left.id) - Number(right.id)),
      latestCreatedAt: run.latestCreatedAt
    }))
    .sort((left, right) => right.latestCreatedAt.localeCompare(left.latestCreatedAt));
}

/** 读取 IANA 时区下某一 UTC 时刻的日历字段。 */
export function getZonedDateTimeParts(timestamp, sourceTimeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: sourceTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const readPart = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
    second: readPart('second')
  };
}

/** 解析严格 YYYY-MM 月份。 */
export function parseEnergyBalanceMonth(monthValue) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return { year, month };
}

/** 返回指定月份之后若干个月的年月。 */
export function addEnergyBalanceMonths(monthValue, count) {
  const parsed = parseEnergyBalanceMonth(monthValue);
  if (!parsed || !Number.isInteger(count)) return null;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1 + count, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 将来源时区中的月首零点转换为真实 UTC ISO。 */
export function zonedMonthBoundaryToUtc(monthValue, sourceTimeZone) {
  const parsed = parseEnergyBalanceMonth(monthValue);
  if (!parsed || !sourceTimeZone) return null;
  const targetLocalAsUtc = Date.UTC(parsed.year, parsed.month - 1, 1, 0, 0, 0);
  let utcGuess = targetLocalAsUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = getZonedDateTimeParts(utcGuess, sourceTimeZone);
    const actualLocalAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = targetLocalAsUtc - actualLocalAsUtc;
    utcGuess += correction;
    if (correction === 0) break;
  }
  const verified = getZonedDateTimeParts(utcGuess, sourceTimeZone);
  if (verified.year !== parsed.year || verified.month !== parsed.month || verified.day !== 1
    || verified.hour !== 0 || verified.minute !== 0 || verified.second !== 0) {
    return null;
  }
  return new Date(utcGuess).toISOString();
}

/** 根据含首尾月份的范围构造完整自然月左闭右开窗口。 */
export function buildFullMonthCalculationWindow(monthRange, sourceTimeZone) {
  if (!Array.isArray(monthRange) || monthRange.length !== 2) {
    return { valid: false, message: '请选择开始月份和结束月份。' };
  }
  const [startMonth, endMonth] = monthRange;
  if (!parseEnergyBalanceMonth(startMonth) || !parseEnergyBalanceMonth(endMonth) || startMonth > endMonth) {
    return { valid: false, message: '统计期月份格式无效，且开始月份不能晚于结束月份。' };
  }
  try {
    const endExclusiveMonth = addEnergyBalanceMonths(endMonth, 1);
    const startUtc = zonedMonthBoundaryToUtc(startMonth, sourceTimeZone);
    const endUtc = zonedMonthBoundaryToUtc(endExclusiveMonth, sourceTimeZone);
    if (!startUtc || !endUtc || Date.parse(startUtc) >= Date.parse(endUtc)) {
      return { valid: false, message: '无法按来源时区换算完整自然月，请核对 IANA 时区。' };
    }
    return {
      valid: true,
      startUtc,
      endUtc,
      sourceTimeZone,
      intervalBoundary: '[startUtc,endUtc)',
      startMonth,
      endMonth
    };
  } catch (_error) {
    return { valid: false, message: '来源时区无效或当前浏览器不支持该 IANA 时区。' };
  }
}

/** 判断 UTC 窗口是否在来源时区中首尾都对齐自然月月首零点。 */
export function isFullNaturalMonthWindow(startUtc, endUtc, sourceTimeZone) {
  if (!startUtc || !endUtc || Date.parse(startUtc) >= Date.parse(endUtc)) return false;
  try {
    const start = getZonedDateTimeParts(startUtc, sourceTimeZone);
    const end = getZonedDateTimeParts(endUtc, sourceTimeZone);
    const isBoundary = (parts) => parts.day === 1 && parts.hour === 0
      && parts.minute === 0 && parts.second === 0;
    return isBoundary(start) && isBoundary(end);
  } catch (_error) {
    return false;
  }
}

/** 返回 API 错误对象及其业务详情。 */
export function energyBalanceApiError(error) {
  return error?.apiError || error?.response?.data?.error || {};
}

/** 提取 API 顶层或 details 中的稳定业务错误码。 */
export function energyBalanceErrorCode(error) {
  const apiError = energyBalanceApiError(error);
  const topLevelCode = apiError.code || error?.code || '';
  return apiError.details?.code || topLevelCode;
}

/** 将页面级权限、维护态、自然月、质量冻结和审计错误投影为稳定文案。 */
export function formatEnergyBalanceRequestError(error, fallback = '能效平衡请求失败。') {
  const status = Number(error?.response?.status || error?.status || 0);
  const apiError = energyBalanceApiError(error);
  const code = energyBalanceErrorCode(error);
  const message = apiError.message || error?.message || fallback;
  if (status === 401 || code === 'UNAUTHORIZED') {
    return '登录状态已失效，请重新登录后再访问能效平衡页面。';
  }
  if (status === 403 || code === 'FORBIDDEN') {
    return '权限不足：当前账号没有执行该能效平衡操作的权限。';
  }
  if (status === 413 || code.includes('BODY_TOO_LARGE') || code.includes('PAYLOAD_TOO_LARGE')) {
    return '请求内容超过服务端限制，请减少本次显式值或筛选范围后重试。';
  }
  if (status === 423 || code === 'MAINTENANCE_IN_PROGRESS') {
    return `${message} 当前处于维护态，只读查询仍可使用；请等待维护结束后再执行写入、计算或建议复核。`;
  }
  if (code === 'BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH') {
    const sourceTimeZone = apiError.details?.sourceTimeZone || '边界来源时区';
    return `${message} 修正建议：改用“完整自然月”统计期，确保开始时间为 ${sourceTimeZone} 月初 00:00，结束时间为下一月月初 00:00；页面将按左闭右开区间重新换算 UTC。`;
  }
  if (code === 'COVERAGE_BELOW_THRESHOLD') {
    return `${message} 原因：${balanceReasonLabel(code)}；请补齐统计期来源记录后重新计算。`;
  }
  if (Object.prototype.hasOwnProperty.call(BALANCE_REASON_LABELS, code)) {
    return `${message} 原因：${balanceReasonLabel(code)}；当前结果必须保持不可计算或冻结。`;
  }
  if (code === 'MISSING_ACTIVE_BALANCE_ITEMS') {
    return `${message} 请先为当前边界维护至少一条启用的显式平衡项目。`;
  }
  if (code === 'ENERGY_BALANCE_BOUNDARY_INACTIVE') {
    return `${message} 请先启用边界，再重新发起计算。`;
  }
  if (code === 'BALANCE_WINDOW_OUTSIDE_BOUNDARY_EFFECTIVE_RANGE') {
    return `${message} 请重新选择完全位于边界有效期内的完整自然月。`;
  }
  if (code === 'ENERGY_BALANCE_OPERATION_FAILED') {
    return `${message} 本次业务写入或审计未完成，服务端事务已回滚；请重试并保留错误信息供管理员核查。`;
  }
  if (code.includes('AUDIT')) {
    return `${message} 审计记录未完成，本次操作不能视为成功；请保留错误码并联系管理员核查。`;
  }
  return code ? `${message}（${code}）` : message;
}

/** 解析逗号分隔的正整数来源记录 ID。 */
export function parseBalanceRecordIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0))];
  }
  return [...new Set(String(value || '').split(/[，,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
}

/** 根据项目表单构造服务端显式来源映射。 */
export function buildBalanceSourceMapping(form = {}) {
  const sourceType = form.sourceType;
  const mapping = {
    type: sourceType,
    reference: String(form.sourceMappingReference || '').trim()
  };
  const recordIds = parseBalanceRecordIds(form.sourceRecordIds);
  if (sourceType === 'timeseries') {
    if (recordIds.length) mapping.recordIds = recordIds;
    const sourceReference = String(form.timeseriesSourceReference || '').trim();
    if (sourceReference) mapping.sourceReference = sourceReference;
  } else if (sourceType === 'explicit_balance_value') {
    if (form.explicitValue !== '' && form.explicitValue !== null && form.explicitValue !== undefined) {
      mapping.value = Number(form.explicitValue);
    }
  } else {
    mapping.recordIds = recordIds;
  }
  if (sourceType === 'generation') {
    mapping.valueField = form.role === 'self_generation'
      ? 'self_use_value_kwh'
      : 'grid_export_value_kwh';
  }
  return mapping;
}

/** 构造平衡项目新增或修改载荷。 */
export function buildBalanceItemPayload(form = {}) {
  return {
    itemCode: String(form.itemCode || '').trim(),
    itemName: String(form.itemName || '').trim(),
    role: form.role,
    energyTypeId: Number(form.energyTypeId),
    originalUnit: String(form.originalUnit || '').trim(),
    sourceType: form.sourceType,
    sourceMapping: buildBalanceSourceMapping(form),
    generationAntiDoubleCountKey: form.sourceType === 'generation'
      ? String(form.generationAntiDoubleCountKey || '').trim()
      : null
  };
}

/** 返回角色中文标签。 */
export function balanceRoleLabel(role) {
  return BALANCE_ROLE_DEFINITIONS.find((item) => item.value === role)?.label || role || '未知角色';
}

/** 返回来源类型中文标签。 */
export function balanceSourceTypeLabel(sourceType) {
  return BALANCE_SOURCE_TYPE_DEFINITIONS.find((item) => item.value === sourceType)?.label || sourceType || '未知来源';
}

/** 返回来源映射的简明追溯说明。 */
export function balanceSourceMappingSummary(mapping = {}) {
  const recordIds = Array.isArray(mapping?.recordIds) ? mapping.recordIds.join('、') : '';
  const sourceReference = mapping?.sourceReference ? `；来源标识 ${mapping.sourceReference}` : '';
  const valueField = mapping?.valueField ? `；字段 ${mapping.valueField}` : '';
  const value = mapping?.value !== undefined ? `；显式值 ${mapping.value}` : '';
  return `${mapping?.reference || '未填写来源说明'}${recordIds ? `；记录 #${recordIds}` : ''}${sourceReference}${valueField}${value}`;
}

/** 返回原因码中文说明。 */
export function balanceReasonLabel(reasonCode) {
  return BALANCE_REASON_LABELS[reasonCode] || reasonCode || '未知原因';
}

/** 递归冻结平衡请求快照，避免异步期间输入被后续操作改写。 */
export function freezeEnergyBalanceRequestSnapshot(source) {
  if (Array.isArray(source)) {
    return Object.freeze(source.map((item) => freezeEnergyBalanceRequestSnapshot(item)));
  }
  if (source && typeof source === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(source).map(([key, value]) => (
      [key, freezeEnergyBalanceRequestSnapshot(value)]
    ))));
  }
  return source;
}

/** 创建只接受最后一次响应的请求守卫。 */
export function createLatestEnergyBalanceRequestGuard() {
  let latestRequestId = 0;
  return Object.freeze({
    begin(snapshot = {}) {
      latestRequestId += 1;
      return Object.freeze({
        requestId: latestRequestId,
        snapshot: freezeEnergyBalanceRequestSnapshot(snapshot)
      });
    },
    isLatest(request) {
      return request?.requestId === latestRequestId;
    },
    invalidate() {
      latestRequestId += 1;
    }
  });
}

/** 按既有分页契约读取全部平衡项目，避免 200 条截断。 */
export async function loadAllEnergyBalanceItems(fetchPage, pageSize = 200) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await fetchPage({ page, pageSize });
    const pageItems = Array.isArray(response?.data) ? response.data : [];
    const pagination = response?.meta?.pagination || {};
    items.push(...pageItems);
    totalPages = Number.isSafeInteger(Number(pagination.totalPages))
      ? Math.max(1, Number(pagination.totalPages))
      : pageItems.length < pageSize ? page : page + 1;
    if (pageItems.length === 0 || (Number(pagination.total) >= 0 && items.length >= Number(pagination.total))) break;
    page += 1;
    if (page > 10000) throw new Error('平衡项目分页超过安全上限。');
  } while (page <= totalPages);
  return items;
}

/** 计算发散条在半轴中的可见宽度，真实零严格保持零宽。 */
export function calculateBalanceBarWidth(absoluteValue, maximumValue) {
  const value = Number(absoluteValue);
  const maximum = Number(maximumValue);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(48, (value / maximum) * 48);
}

/** 构造原单位、kgce 或 tce 的同源图表与表格行。 */
export function buildBalanceChartRows(balance = {}, unitMode = 'original') {
  const fieldSets = {
    original: {
      unit: balance.originalUnit || '',
      input: 'inputTotalOriginal',
      output: 'outputTotalOriginal',
      storage: 'storageChangeOriginal',
      difference: 'unexplainedOriginal'
    },
    kgce: {
      unit: 'kgce',
      input: 'inputTotalKgce',
      output: 'outputTotalKgce',
      storage: 'storageChangeKgce',
      difference: 'unexplainedKgce'
    },
    tce: {
      unit: 'tce',
      input: 'inputTotalTce',
      output: 'outputTotalTce',
      storage: 'storageChangeTce',
      difference: 'unexplainedTce'
    }
  };
  const fields = fieldSets[unitMode] || fieldSets.original;
  const definitions = [
    { key: 'input', label: '综合输入', field: fields.input, side: 'left', tone: 'input' },
    { key: 'output', label: '综合输出', field: fields.output, side: 'right', tone: 'output' },
    { key: 'storage', label: '储能变化', field: fields.storage, sideBySign: true, tone: 'storage' },
    { key: 'difference', label: '不可解释差额', field: fields.difference, differenceSide: true, tone: 'difference' }
  ];
  return definitions.map((definition) => {
    const rawValue = balance?.[definition.field];
    const value = rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))
      ? null
      : Number(rawValue);
    let side = definition.side || 'right';
    if (definition.sideBySign) side = value !== null && value < 0 ? 'left' : 'right';
    if (definition.differenceSide) side = value !== null && value >= 0 ? 'left' : 'right';
    return {
      key: definition.key,
      label: definition.label,
      value,
      absoluteValue: value === null ? null : Math.abs(value),
      side,
      tone: definition.tone,
      unit: fields.unit,
      available: value !== null
    };
  });
}

/** 返回当前建议状态允许的目标状态。 */
export function suggestionReviewTargets(currentStatus) {
  return [...(SUGGESTION_STATUS_TRANSITIONS[currentStatus] || [])];
}

/** 校验建议人工流转及拒绝、解决备注。 */
export function validateSuggestionReview(currentStatus, targetStatus, reviewNote) {
  if (!suggestionReviewTargets(currentStatus).includes(targetStatus)) {
    return { valid: false, message: '当前建议状态不允许执行该流转。' };
  }
  const normalizedNote = String(reviewNote || '').trim();
  if ((targetStatus === 'rejected' || targetStatus === 'resolved') && !normalizedNote) {
    return { valid: false, message: '拒绝或解决建议时必须填写复核备注。' };
  }
  if (normalizedNote.length > 1000) {
    return { valid: false, message: '复核备注不能超过 1000 个字符。' };
  }
  return {
    valid: true,
    payload: {
      manualStatus: targetStatus,
      reviewNote: normalizedNote || null
    }
  };
}
