// 能源消费分析页面的权限、筛选、状态和图表纯逻辑。

/** 页面使用的冻结权限编码。 */
export const ENERGY_ANALYSIS_PERMISSIONS = Object.freeze({
  view: 'energy:analysis:view',
  strategyEvaluate: 'energy:strategy:evaluate',
  strategyRun: 'energy:strategy:run',
  strategyReview: 'energy:strategy:review',
  configView: 'energy:analysis:config:view',
  shiftManage: 'energy:analysis:shift:manage',
  touManage: 'energy:analysis:tou:manage',
  strategyRuleManage: 'energy:strategy:rule:manage',
  timeseriesPreview: 'energy:analysis:timeseries:preview',
  timeseriesExecute: 'energy:analysis:timeseries:execute',
  operationsPreview: 'energy:analysis:operations:preview',
  operationsExecute: 'energy:analysis:operations:execute'
});

/** 三类受控导入定义。 */
export const ENERGY_ANALYSIS_IMPORT_TYPES = Object.freeze({
  timeseries: Object.freeze({ key: 'timeseries', label: '时序能耗', previewPermission: ENERGY_ANALYSIS_PERMISSIONS.timeseriesPreview, executePermission: ENERGY_ANALYSIS_PERMISSIONS.timeseriesExecute }),
  shifts: Object.freeze({ key: 'shift-schedules', label: '排班记录', previewPermission: ENERGY_ANALYSIS_PERMISSIONS.operationsPreview, executePermission: ENERGY_ANALYSIS_PERMISSIONS.operationsExecute }),
  states: Object.freeze({ key: 'device-states', label: '设备状态', previewPermission: ENERGY_ANALYSIS_PERMISSIONS.operationsPreview, executePermission: ENERGY_ANALYSIS_PERMISSIONS.operationsExecute })
});

/** 固定图表系列颜色，状态颜色不得复用为数据系列。 */
export const ENERGY_ANALYSIS_COLORS = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100']);

/** 峰平谷稳定业务键、标签和颜色，筛选缺类时不得按数组位置重排颜色。 */
export const ENERGY_ANALYSIS_TOU_PRESENTATION = Object.freeze({
  peak: Object.freeze({ label: '峰', color: '#2a78d6' }),
  flat: Object.freeze({ label: '平', color: '#eb6834' }),
  valley: Object.freeze({ label: '谷', color: '#1baf7a' })
});

/** 配置服务冻结的状态、策略和证据字段白名单。 */
export const ENERGY_ANALYSIS_CONFIGURATION_CONTRACT = Object.freeze({
  statuses: Object.freeze(['active', 'inactive']),
  touPeriodTypes: Object.freeze(['peak', 'flat', 'valley']),
  strategyFormulaVersions: Object.freeze(['load-analysis:v1']),
  strategyMetricCodes: Object.freeze(['load_rate', 'peak_interval_energy']),
  strategyThresholdOperators: Object.freeze(['gt', 'gte', 'lt', 'lte', 'between']),
  strategyPriorities: Object.freeze(['low', 'medium', 'high']),
  evidenceRequirementKeys: Object.freeze(['minimumCoverageRate', 'maxEvidenceItems', 'savingBasis'])
});

/** 后端原因码中文说明。 */
export const ENERGY_ANALYSIS_REASON_LABELS = Object.freeze({
  NO_TIMESERIES_DATA: '缺少时序能耗数据',
  COVERAGE_BELOW_THRESHOLD: '数据覆盖率低于要求',
  MIXED_INTERVAL_GRANULARITY: '时序记录粒度混合，当前结果不可直接计算',
  SOURCE_OVERLAP_OR_DUPLICATE: '时序来源存在重叠或重复记录',
  UNIT_NOT_COMPARABLE: '单位不可比或指标单位不可用',
  MISSING_CONVERSION_FACTOR: '缺少适用的折标系数',
  FACTOR_PERIOD_AMBIGUOUS: '折标系数有效期存在歧义',
  MISSING_SHIFT_SCHEDULE: '排班记录存在缺口',
  DEVICE_STATE_GAP: '设备状态存在缺口，缺口保持未知',
  MISSING_PRODUCTION_OUTPUT: '缺少产量分母',
  TOPOLOGY_SOURCE_UNMAPPED: '能流来源尚未显式映射',
  GENERATION_BOUNDARY_UNCONFIRMED: '发电边界尚未确认',
  BALANCE_ITEM_UNMAPPED: '平衡项目尚未映射',
  PARTIAL_BOUNDARY_RECORD: '存在跨查询边界的部分记录',
  MIXED_SOURCE_GRANULARITY: '来源粒度混合，已披露分配假设',
  NO_PRODUCTION_OUTPUT: '缺少产量分母',
  ZERO_PRODUCTION_OUTPUT: '产量分母为真实零值，强度不可计算',
  DENOMINATOR_UNIT_INCOMPATIBLE: '产量单位不兼容',
  EXPLICIT_UNKNOWN_STATE: '存在显式 unknown 状态',
  SHIFT_SCHEDULE_GAP: '排班记录存在缺口',
  TOU_SCHEME_NOT_APPLICABLE: '峰平谷方案不适用于当前范围',
  TOU_CONFIGURATION_ERROR: '峰平谷方案配置不完整',
  MULTIPLE_ACTIVE_TOU_SCHEMES: '存在多个可用方案，请显式选择',
  ORGANIZATION_SCOPE_NO_METERS: '组织范围内没有可分析表计',
  PEAK_NOT_CALCULABLE: '覆盖不足，高峰贡献不可计算',
  STRATEGY_HIT_STATUS_CONFLICT: '命中状态已变化，请刷新后再处理',
  MAINTENANCE_IN_PROGRESS: '系统处于维护态，当前写操作已阻止',
  IMPORT_FILE_TOO_LARGE: '上传文件超过服务端大小限制',
  ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE: '执行确认正文超过 2MB 限制',
  ENERGY_ANALYSIS_EXECUTE_JSON_INVALID: '执行确认正文不是合法 JSON',
  ANALYSIS_NUMERIC_OVERFLOW: '分析数值超出安全范围'
});

/** 服务端实际质量状态中文说明。 */
export const ENERGY_ANALYSIS_QUALITY_STATUS_LABELS = Object.freeze({
  no_data: '无数据',
  insufficient: '覆盖不足',
  partial: '部分可用',
  available: '数据可用',
  sufficient: '数据可用',
  coverage_below_threshold: '覆盖率低于要求',
  overlap_or_duplicate: '来源存在重叠或重复',
  mixed_interval_granularity: '时序粒度混合',
  unit_not_comparable: '单位不可比',
  missing_shift_schedule: '排班记录存在缺口',
  shift_configuration_invalid: '排班配置无效',
  device_state_gap: '设备状态存在缺口',
  explicit_unknown: '存在显式 unknown 状态',
  denominator_missing: '缺少产量分母',
  denominator_unit_incompatible: '产量单位不兼容'
});

/** 策略人工状态中文说明。 */
export const STRATEGY_STATUS_LABELS = Object.freeze({
  unconfirmed: '待人工确认',
  accepted: '已接受',
  rejected: '已拒绝',
  resolved: '已解决'
});

/** 策略人工状态允许的单向流转。 */
export const STRATEGY_STATUS_TRANSITIONS = Object.freeze({
  unconfirmed: Object.freeze(['accepted', 'rejected']),
  accepted: Object.freeze(['rejected', 'resolved']),
  rejected: Object.freeze([]),
  resolved: Object.freeze([])
});

/** 深拷贝并冻结请求输入或结果快照，避免异步期间被后续表单修改污染。 */
export function createEnergyAnalysisSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => createEnergyAnalysisSnapshot(item)));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, createEnergyAnalysisSnapshot(item)])));
  }
  return value;
}

/** 创建只允许最新请求提交结果的序号门，旧响应必须被调用方丢弃。 */
export function createLatestEnergyAnalysisRequestGate() {
  let latestRequestId = 0;
  return Object.freeze({
    start(input = {}) {
      latestRequestId += 1;
      return Object.freeze({ requestId: latestRequestId, inputSnapshot: createEnergyAnalysisSnapshot(input) });
    },
    isLatest(run) {
      return Boolean(run && run.requestId === latestRequestId);
    },
    invalidate() {
      latestRequestId += 1;
      return latestRequestId;
    }
  });
}

/** 返回全部分析切片的空结果，单项失败时不得沿用上一轮切片。 */
export function createEmptyEnergyAnalysisResult() {
  return {
    loadSummary: { metrics: {}, quality: {} },
    loadCurve: { buckets: [], quality: {} },
    monthlyAnalysis: { facets: [] },
    intensityAnalysis: { facets: [] },
    touAnalysis: { periods: [] },
    shiftAnalysis: { shifts: [] },
    deviceStateAnalysis: { states: [] },
    peakContribution: { contributors: [] }
  };
}

/** 开始分析结果状态转换；刷新期间继续展示上一已提交查询快照。 */
export function startEnergyAnalysisResultTransition(displaySnapshot, run) {
  if (!run || !Number.isInteger(run.requestId) || !run.inputSnapshot) throw new Error('分析请求快照无效。');
  return createEnergyAnalysisSnapshot({
    displaySnapshot: displaySnapshot || null,
    pendingSnapshot: {
      requestId: run.requestId,
      inputSnapshot: run.inputSnapshot
    }
  });
}

/** 完成分析结果状态转换；结果与产生它的输入快照必须原子提交。 */
export function completeEnergyAnalysisResultTransition(transition, run, result) {
  if (!transition?.pendingSnapshot || transition.pendingSnapshot.requestId !== run?.requestId) return transition;
  return createEnergyAnalysisSnapshot({
    displaySnapshot: {
      requestId: run.requestId,
      inputSnapshot: run.inputSnapshot,
      resultSnapshot: {
        ...createEmptyEnergyAnalysisResult(),
        ...(result || {})
      }
    },
    pendingSnapshot: null
  });
}

/** 创建单一策略展示快照；预演和正式运行不能同时保留不同请求结果。 */
export function createEnergyAnalysisStrategyResultSnapshot(run, kind, result = {}) {
  if (!run || !Number.isInteger(run.requestId) || !run.inputSnapshot) throw new Error('策略请求快照无效。');
  if (!['evaluate', 'run'].includes(kind)) throw new Error('策略请求类型只允许 evaluate 或 run。');
  return createEnergyAnalysisSnapshot({
    requestId: run.requestId,
    kind,
    inputSnapshot: run.inputSnapshot,
    resultSnapshot: result
  });
}

/** 原子提交单一策略结果；新请求快照必须整体替换任意旧预演或正式运行快照。 */
export function commitEnergyAnalysisStrategyResult(_currentSnapshot, run, kind, result = {}) {
  return createEnergyAnalysisStrategyResultSnapshot(run, kind, result);
}

/** 用人工复核响应替换正式运行快照中的单条命中。 */
export function replaceEnergyAnalysisStrategyHit(snapshot, updatedHit) {
  if (snapshot?.kind !== 'run' || !updatedHit?.id) return snapshot;
  const hits = Array.isArray(snapshot.resultSnapshot?.hits)
    ? snapshot.resultSnapshot.hits.map((hit) => hit.id === updatedHit.id ? updatedHit : hit)
    : [];
  return createEnergyAnalysisSnapshot({
    ...snapshot,
    resultSnapshot: {
      ...snapshot.resultSnapshot,
      hits
    }
  });
}

/** 返回当前月所在的默认月份范围和最近七天 UTC 范围。 */
export function createDefaultEnergyAnalysisFilters(now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 7);
  const month = end.toISOString().slice(0, 7);
  const startMonthDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
  return {
    startMonth: startMonthDate.toISOString().slice(0, 7),
    endMonth: month,
    startUtc: start.toISOString().slice(0, 16),
    endUtc: end.toISOString().slice(0, 16),
    sourceTimeZone: 'Asia/Shanghai',
    organizationUnitId: '',
    productionUnitId: '',
    meterDeviceId: '',
    energyTypeCode: '',
    unit: '',
    outputIntervalMinutes: 60,
    minimumCoverageRate: 0.8,
    touSchemeId: ''
  };
}

/** 将来源时区中的日期时间控件值规范为 UTC ISO 字符串。 */
export function toUtcIso(value, sourceTimeZone = 'UTC') {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  const text = String(value).trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const absoluteDate = new Date(text);
    return Number.isNaN(absoluteDate.getTime()) ? '' : absoluteDate.toISOString();
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return '';
  const parts = match.slice(1).map(Number);
  const targetUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5] || 0);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: sourceTimeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    let candidate = targetUtc;
    for (let pass = 0; pass < 2; pass += 1) {
      const localParts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
      const renderedUtc = Date.UTC(localParts.year, localParts.month - 1, localParts.day, localParts.hour, localParts.minute, localParts.second);
      candidate -= renderedUtc - targetUtc;
    }
    return new Date(candidate).toISOString();
  } catch (_error) {
    return '';
  }
}

/** 清除空筛选字段，防止前端发送未冻结参数。 */
export function compactEnergyAnalysisParams(params = {}) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 构造单表计时序分析参数。 */
export function buildTimeseriesAnalysisParams(filters = {}) {
  return compactEnergyAnalysisParams({
    meterDeviceId: filters.meterDeviceId,
    energyTypeCode: filters.energyTypeCode,
    unit: filters.unit,
    startUtc: toUtcIso(filters.startUtc, filters.sourceTimeZone),
    endUtc: toUtcIso(filters.endUtc, filters.sourceTimeZone),
    sourceTimeZone: filters.sourceTimeZone
  });
}

/** 构造负荷摘要参数。 */
export function buildLoadSummaryParams(filters = {}) {
  return compactEnergyAnalysisParams({
    ...buildTimeseriesAnalysisParams(filters),
    minimumCoverageRate: filters.minimumCoverageRate
  });
}

/** 构造负荷曲线参数。 */
export function buildLoadCurveParams(filters = {}) {
  return compactEnergyAnalysisParams({
    ...buildTimeseriesAnalysisParams(filters),
    outputIntervalMinutes: filters.outputIntervalMinutes
  });
}

/** 构造月度消费分析参数，组织范围保持精确且不自动含下级。 */
export function buildMonthlyAnalysisParams(filters = {}) {
  return compactEnergyAnalysisParams({
    startMonth: filters.startMonth,
    endMonth: filters.endMonth,
    organizationUnitId: filters.organizationUnitId,
    includeDescendants: false,
    energyTypeCode: filters.energyTypeCode,
    unit: filters.unit,
    topN: 10
  });
}

/** 构造强度分析参数。 */
export function buildIntensityParams(filters = {}) {
  return compactEnergyAnalysisParams({
    productionUnitId: filters.productionUnitId,
    startMonth: filters.startMonth,
    endMonth: filters.endMonth,
    energyTypeCode: filters.energyTypeCode,
    unit: filters.unit
  });
}

/** 构造峰平谷分析参数。 */
export function buildTouParams(filters = {}) {
  return compactEnergyAnalysisParams({ ...buildTimeseriesAnalysisParams(filters), touSchemeId: filters.touSchemeId });
}

/** 构造精确组织高峰贡献参数。 */
export function buildPeakContributionParams(filters = {}) {
  return compactEnergyAnalysisParams({
    organizationUnitId: filters.organizationUnitId,
    energyTypeCode: filters.energyTypeCode,
    unit: filters.unit,
    startUtc: toUtcIso(filters.startUtc, filters.sourceTimeZone),
    endUtc: toUtcIso(filters.endUtc, filters.sourceTimeZone),
    sourceTimeZone: filters.sourceTimeZone,
    outputIntervalMinutes: filters.outputIntervalMinutes,
    topContributors: 10
  });
}

/** 构造本地策略预演或正式运行参数。 */
export function buildStrategyParams(filters = {}, ruleCodes = []) {
  return compactEnergyAnalysisParams({
    ...buildLoadSummaryParams(filters),
    ruleCodes: Array.isArray(ruleCodes) && ruleCodes.length ? [...new Set(ruleCodes.filter(Boolean))] : undefined
  });
}

/** 保留真实零值并区分缺失、不可计算和普通数值。 */
export function formatAnalysisValue(value, options = {}) {
  const { unit = '', digits = 2, calculable = true, missingText = '缺失', unavailableText = '不可计算' } = options;
  if (!calculable) return unavailableText;
  if (value === null || value === undefined || value === '') return missingText;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return unavailableText;
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numericValue);
  return `${formatted}${unit ? ` ${unit}` : ''}`;
}

/** 将覆盖率规范为百分比文案。 */
export function formatCoverageRate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '覆盖率缺失';
  return `覆盖率 ${(Number(value) * 100).toFixed(1)}%`;
}

/** 将原因码列表翻译为可追溯中文文案，未知码仍原样展示。 */
export function reasonCodeLabel(code) {
  return ENERGY_ANALYSIS_REASON_LABELS[code] || `后端原因码：${code}`;
}

/** 将多个原因码合并为中文说明。 */
export function reasonCodesText(reasonCodes = []) {
  return Array.isArray(reasonCodes) && reasonCodes.length ? reasonCodes.map(reasonCodeLabel).join('；') : '无附加原因';
}

/** 返回质量状态中文说明，优先投影服务端稳定状态并保留覆盖率。 */
export function qualityStatusText(quality = {}) {
  const status = quality?.status;
  const label = ENERGY_ANALYSIS_QUALITY_STATUS_LABELS[status];
  if (label) return quality?.coverageRate === undefined ? label : `${label}（${formatCoverageRate(quality.coverageRate)}）`;
  if (quality?.sufficient === false) return `覆盖不足（${formatCoverageRate(quality?.coverageRate)}）`;
  if (quality?.sufficient === true) return `数据可用（${formatCoverageRate(quality?.coverageRate)}）`;
  return quality?.coverageRate === undefined ? '状态未知' : formatCoverageRate(quality.coverageRate);
}

/** 返回月度同比环比状态中文说明。 */
export function monthlyComparisonText(comparison = {}) {
  if (comparison.status === 'current_missing') return '本期缺失';
  if (comparison.status === 'base_missing') return '基期缺失';
  if (comparison.status === 'base_zero') return '基期为真实零值，不可计算';
  if (comparison.status === 'numeric_overflow') return '变化率数值溢出';
  const value = comparison.changeRate ?? comparison.rate ?? comparison.percentage;
  return formatAnalysisValue(value === null || value === undefined ? null : Number(value) * 100, { unit: '%', missingText: '不可计算' });
}

/** 返回条形图可见宽度百分比，真实零值严格编码为零宽度。 */
export function energyAnalysisBarPercentage(value, maximum) {
  const numericValue = Number(value);
  const numericMaximum = Number(maximum);
  if (!Number.isFinite(numericValue) || numericValue <= 0 || !Number.isFinite(numericMaximum) || numericMaximum <= 0) return 0;
  return Math.min(100, (numericValue / numericMaximum) * 100);
}

/** 返回峰平谷业务键对应的稳定展示信息。 */
export function touPresentation(type) {
  return ENERGY_ANALYSIS_TOU_PRESENTATION[type] || Object.freeze({ label: type || '未知时段', color: '#728199' });
}

/** 从负荷桶生成图表和等价表格共享行。 */
export function normalizeLoadCurveRows(buckets = []) {
  return (Array.isArray(buckets) ? buckets : []).map((bucket, index) => ({
    key: bucket.startUtc || bucket.bucketStartUtc || String(index),
    startUtc: bucket.startUtc || bucket.bucketStartUtc || '',
    endUtc: bucket.endUtc || bucket.bucketEndUtc || '',
    energy: bucket.energy === null || bucket.energy === undefined ? null : Number(bucket.energy),
    energyUnit: bucket.energyUnit || '',
    averageLoad: bucket.averageLoad === null || bucket.averageLoad === undefined ? null : Number(bucket.averageLoad),
    loadUnit: bucket.loadUnit || '',
    observationMode: bucket.observationMode || 'missing'
  }));
}

/** 为单轴折线图计算 SVG 点，缺失值不参与连线。 */
export function buildLoadCurvePoints(rows = [], width = 720, height = 260) {
  const left = 58;
  const right = width - 20;
  const top = 24;
  const bottom = height - 42;
  const numericRows = rows.filter((row) => Number.isFinite(row.energy));
  const maxValue = Math.max(...numericRows.map((row) => row.energy), 1);
  return rows.map((row, index) => ({
    ...row,
    x: rows.length <= 1 ? (left + right) / 2 : left + (index * (right - left)) / (rows.length - 1),
    y: Number.isFinite(row.energy) ? bottom - (row.energy / maxValue) * (bottom - top) : null
  }));
}

/** 将连续有效点拆成 SVG polyline 段，缺失桶形成显式断线。 */
export function buildLoadCurveSegments(points = []) {
  const segments = [];
  let current = [];
  points.forEach((point) => {
    if (Number.isFinite(point.y)) current.push(point);
    else if (current.length) { segments.push(current); current = []; }
  });
  if (current.length) segments.push(current);
  return segments.map((segment) => segment.map((point) => `${point.x},${point.y}`).join(' '));
}

/** 返回策略人工状态允许的目标状态。 */
export function allowedStrategyStatuses(currentStatus) {
  return [...(STRATEGY_STATUS_TRANSITIONS[currentStatus] || [])];
}

/** 校验策略人工状态流和备注要求。 */
export function validateStrategyReview(currentStatus, targetStatus, reviewNote = '') {
  if (!allowedStrategyStatuses(currentStatus).includes(targetStatus)) return { valid: false, message: '当前状态不允许流转到目标状态。' };
  if (['rejected', 'resolved'].includes(targetStatus) && !String(reviewNote).trim()) return { valid: false, message: '拒绝或解决时必须填写人工复核备注。' };
  return { valid: true, message: '' };
}

/** 返回配置抽屉初值；首版本不预填班次、周期、阈值、有效期等未经确认的业务事实。 */
export function createEnergyAnalysisConfigForm(kind, source = null) {
  const shared = {
    source: source?.source || '',
    sourceTimeZone: source?.sourceTimeZone || '',
    effectiveStartUtc: source?.effectiveStartUtc?.slice(0, 16) || '',
    effectiveEndUtc: source?.effectiveEndUtc?.slice(0, 16) || '',
    status: ''
  };
  if (kind === 'shift') {
    return {
      ...shared,
      shiftCode: source?.shiftCode || '',
      shiftName: source?.shiftName || '',
      startMinute: source?.startMinute ?? null,
      endMinute: source?.endMinute ?? null,
      crossesMidnight: source ? Boolean(source.crossesMidnight) : null,
      version: ''
    };
  }
  if (kind === 'tou') {
    const sourceRules = Array.isArray(source?.periodRules)
      ? source.periodRules.map(({ dayOfWeek, periodType, startMinute, endMinute }) => ({ dayOfWeek, periodType, startMinute, endMinute }))
      : null;
    return {
      ...shared,
      schemeCode: source?.schemeCode || '',
      schemeName: source?.schemeName || '',
      documentNo: source?.documentNo || '',
      version: '',
      periodRulesText: sourceRules ? JSON.stringify(sourceRules, null, 2) : ''
    };
  }
  return {
    ...shared,
    ruleCode: source?.ruleCode || '',
    ruleName: source?.ruleName || '',
    ruleVersion: '',
    formulaVersion: source?.formulaVersion || '',
    metricCode: source?.metricCode || '',
    thresholdOperator: source?.thresholdOperator || '',
    thresholdValue: source?.thresholdValue ?? null,
    thresholdMin: source?.thresholdMin ?? null,
    thresholdMax: source?.thresholdMax ?? null,
    thresholdUnit: source?.thresholdUnit || '',
    reductionRate: source?.reductionRate ?? null,
    priority: source?.priority || '',
    evidenceRequirementsText: source?.evidenceRequirements ? JSON.stringify(source.evidenceRequirements, null, 2) : '',
    recommendationText: source?.recommendationText || ''
  };
}

/** 校验配置必填文本并返回去空白结果。 */
function requiredConfigurationText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`请填写${label}。`);
  return text;
}

/** 校验配置必填有限数值并返回数值。 */
function requiredConfigurationNumber(value, label) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(`请填写有效的${label}。`);
  return Number(value);
}

/** 解析配置 JSON 字段并提供业务化错误提示。 */
function parseConfigurationJson(value, label) {
  const text = requiredConfigurationText(value, label);
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`${label}必须是合法 JSON。`);
  }
}

/** 按后端契约校验完整 TOU 周期规则并返回规范字段。 */
export function validateEnergyAnalysisTouPeriodRules(rules) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 168) throw new Error('完整周期规则必须是 1 至 168 条规则的数组。');
  const normalizedRules = rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`第 ${index + 1} 条 TOU 周期规则必须是对象。`);
    if (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 1 || rule.dayOfWeek > 7) throw new Error(`第 ${index + 1} 条规则的 dayOfWeek 必须是 1 至 7 的整数。`);
    if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.touPeriodTypes.includes(rule.periodType)) throw new Error(`第 ${index + 1} 条规则的 periodType 只允许 peak、flat 或 valley。`);
    if (!Number.isInteger(rule.startMinute) || rule.startMinute < 0 || rule.startMinute > 1439) throw new Error(`第 ${index + 1} 条规则的 startMinute 必须是 0 至 1439 的整数。`);
    if (!Number.isInteger(rule.endMinute) || rule.endMinute < 1 || rule.endMinute > 1440) throw new Error(`第 ${index + 1} 条规则的 endMinute 必须是 1 至 1440 的整数。`);
    if (rule.startMinute >= rule.endMinute) throw new Error(`第 ${index + 1} 条规则的开始分钟必须早于结束分钟。`);
    return {
      dayOfWeek: rule.dayOfWeek,
      periodType: rule.periodType,
      startMinute: rule.startMinute,
      endMinute: rule.endMinute
    };
  });
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    const dailyRules = normalizedRules
      .filter((rule) => rule.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    let expectedStart = 0;
    dailyRules.forEach((rule) => {
      if (rule.startMinute !== expectedStart) throw new Error(`星期 ${dayOfWeek} 的 TOU 规则必须无重叠、无缺口地覆盖 0 至 1440 分钟。`);
      expectedStart = rule.endMinute;
    });
    if (expectedStart !== 1440) throw new Error(`星期 ${dayOfWeek} 的 TOU 规则必须覆盖至 1440 分钟。`);
  }
  return normalizedRules;
}

/** 按后端固定字段和值域校验策略证据要求。 */
export function validateEnergyAnalysisEvidenceRequirements(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) throw new Error('证据要求必须是 JSON 对象。');
  const unknownKeys = Object.keys(requirements).filter((key) => !ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.evidenceRequirementKeys.includes(key));
  if (unknownKeys.length) throw new Error(`证据要求包含后端不支持的字段：${unknownKeys.sort().join('、')}。`);
  if (Object.prototype.hasOwnProperty.call(requirements, 'minimumCoverageRate')) {
    if (!Number.isFinite(requirements.minimumCoverageRate) || requirements.minimumCoverageRate < 0 || requirements.minimumCoverageRate > 1) throw new Error('证据要求 minimumCoverageRate 必须是 0 至 1 的有限数。');
  }
  if (Object.prototype.hasOwnProperty.call(requirements, 'maxEvidenceItems')) {
    if (!Number.isInteger(requirements.maxEvidenceItems) || requirements.maxEvidenceItems < 1 || requirements.maxEvidenceItems > 100) throw new Error('证据要求 maxEvidenceItems 必须是 1 至 100 的整数。');
  }
  if (Object.prototype.hasOwnProperty.call(requirements, 'savingBasis')) {
    if (requirements.savingBasis !== null && requirements.savingBasis !== 'window_total_energy') throw new Error('证据要求 savingBasis 只允许 null 或 window_total_energy。');
  }
  return { ...requirements };
}

/** 构造配置请求正文；表单未确认完整时直接阻止提交，不把空默认事实转换成零或 false。 */
export function buildEnergyAnalysisConfigPayload(kind, form = {}, hasSource = false) {
  if (!['shift', 'tou', 'rule'].includes(kind)) throw new Error('配置类型只允许 shift、tou 或 rule。');
  const sourceTimeZone = requiredConfigurationText(form.sourceTimeZone, '来源时区');
  const effectiveStartUtc = toUtcIso(requiredConfigurationText(form.effectiveStartUtc, '生效开始 UTC'));
  const effectiveEndUtc = toUtcIso(requiredConfigurationText(form.effectiveEndUtc, '生效结束 UTC'));
  if (!effectiveStartUtc || !effectiveEndUtc) throw new Error('生效时间或来源时区无效。');
  if (Date.parse(effectiveStartUtc) >= Date.parse(effectiveEndUtc)) throw new Error('生效开始时间必须早于生效结束时间。');
  if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.statuses.includes(form.status)) throw new Error('请选择启用或停用状态。');
  const shared = {
    source: requiredConfigurationText(form.source, '来源'),
    sourceTimeZone,
    effectiveStartUtc,
    effectiveEndUtc,
    status: form.status
  };
  if (kind === 'shift') {
    if (typeof form.crossesMidnight !== 'boolean') throw new Error('请选择班次是否跨日。');
    const startMinute = requiredConfigurationNumber(form.startMinute, '开始分钟');
    const endMinute = requiredConfigurationNumber(form.endMinute, '结束分钟');
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || startMinute > 1439 || endMinute < 0 || endMinute > 1439) throw new Error('班次起止分钟必须是 0 至 1439 的整数。');
    if ((form.crossesMidnight && startMinute <= endMinute) || (!form.crossesMidnight && startMinute >= endMinute)) throw new Error('班次起止分钟与跨日选择不一致。');
    return {
      ...(hasSource ? {} : { shiftCode: requiredConfigurationText(form.shiftCode, '排班编码') }),
      shiftName: requiredConfigurationText(form.shiftName, '排班名称'),
      startMinute,
      endMinute,
      crossesMidnight: form.crossesMidnight,
      version: requiredConfigurationText(form.version, '版本'),
      ...shared
    };
  }
  if (kind === 'tou') {
    const periodRules = validateEnergyAnalysisTouPeriodRules(parseConfigurationJson(form.periodRulesText, '完整周期规则'));
    return {
      ...(hasSource ? {} : { schemeCode: requiredConfigurationText(form.schemeCode, '方案编码') }),
      schemeName: requiredConfigurationText(form.schemeName, '方案名称'),
      documentNo: String(form.documentNo || '').trim() || undefined,
      version: requiredConfigurationText(form.version, '版本'),
      periodRules,
      ...shared
    };
  }
  const formulaVersion = requiredConfigurationText(form.formulaVersion, '公式版本');
  if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyFormulaVersions.includes(formulaVersion)) throw new Error('公式版本只允许 load-analysis:v1。');
  const metricCode = requiredConfigurationText(form.metricCode, '指标');
  if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyMetricCodes.includes(metricCode)) throw new Error('指标只允许 load_rate 或 peak_interval_energy。');
  const thresholdOperator = requiredConfigurationText(form.thresholdOperator, '阈值运算符');
  if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyThresholdOperators.includes(thresholdOperator)) throw new Error('阈值运算符不在后端固定白名单中。');
  const priority = requiredConfigurationText(form.priority, '优先级');
  if (!ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyPriorities.includes(priority)) throw new Error('优先级只允许 low、medium 或 high。');
  const between = thresholdOperator === 'between';
  const evidenceRequirements = validateEnergyAnalysisEvidenceRequirements(parseConfigurationJson(form.evidenceRequirementsText, '证据要求'));
  const thresholdValue = between ? undefined : requiredConfigurationNumber(form.thresholdValue, '阈值');
  const thresholdMin = between ? requiredConfigurationNumber(form.thresholdMin, '阈值下限') : undefined;
  const thresholdMax = between ? requiredConfigurationNumber(form.thresholdMax, '阈值上限') : undefined;
  if (between && thresholdMin > thresholdMax) throw new Error('阈值下限不能大于阈值上限。');
  const reductionRate = form.reductionRate === '' || form.reductionRate === null || form.reductionRate === undefined ? undefined : requiredConfigurationNumber(form.reductionRate, '可削减比例');
  if (reductionRate !== undefined && (reductionRate <= 0 || reductionRate > 1)) throw new Error('可削减比例必须大于 0 且不超过 1。');
  return {
    ...(hasSource ? {} : { ruleCode: requiredConfigurationText(form.ruleCode, '规则编码') }),
    ruleName: requiredConfigurationText(form.ruleName, '规则名称'),
    ruleVersion: requiredConfigurationText(form.ruleVersion, '规则版本'),
    formulaVersion,
    metricCode,
    thresholdOperator,
    thresholdValue,
    thresholdMin,
    thresholdMax,
    thresholdUnit: requiredConfigurationText(form.thresholdUnit, '阈值单位'),
    reductionRate,
    priority,
    evidenceRequirements,
    recommendationText: requiredConfigurationText(form.recommendationText, '建议文本'),
    ...shared
  };
}

/** 从服务端预演结果构造完整执行见证，禁止丢失候选和摘要字段。 */
export function buildImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    duplicateStrategy: preview.duplicateStrategy,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport ?? preview.summary?.wouldImport,
    candidateRowIds: Array.isArray(preview.candidateRowIds) ? [...preview.candidateRowIds] : [],
    candidateRows: Array.isArray(preview.candidateRows) ? preview.candidateRows.map((row) => ({ ...row })) : []
  };
}

/** 判断导入预演是否具备执行所需的完整候选见证。 */
export function canExecuteEnergyAnalysisImport(preview = {}) {
  if (!preview || typeof preview !== 'object') return false;
  const expected = Number(preview.expectedWouldImport ?? preview.summary?.wouldImport ?? 0);
  return Boolean(
    preview.batchId
    && preview.previewSignature
    && preview.previewAuditDigest
    && preview.fileSha256
    && preview.confirmText
    && expected > 0
    && Array.isArray(preview.candidateRows)
    && Array.isArray(preview.candidateRowIds)
    && preview.candidateRows.length === expected
    && preview.candidateRowIds.length === expected
  );
}

/** 收集 API 错误中的业务原因码，优先展示 details 内的具体原因。 */
function energyAnalysisErrorReasonCodes(apiError = {}) {
  const codes = [
    apiError.details?.code,
    ...(Array.isArray(apiError.details?.reasonCodes) ? apiError.details.reasonCodes : []),
    ...(Array.isArray(apiError.reasonCodes) ? apiError.reasonCodes : []),
    apiError.code
  ].filter(Boolean);
  return [...new Set(codes)];
}

/** 判断原因码是否有页面稳定投影。 */
function hasEnergyAnalysisReasonLabel(code) {
  return Object.prototype.hasOwnProperty.call(ENERGY_ANALYSIS_REASON_LABELS, code);
}

/** 将 API 异常转换为包含登录、权限、大小、维护态和业务原因码的稳定文案。 */
export function energyAnalysisErrorText(error, fallback = '接口请求失败。', options = {}) {
  const status = error?.response?.status;
  const apiError = error?.response?.data?.error || error?.apiError || {};
  const reasonCodes = energyAnalysisErrorReasonCodes(apiError);
  const globallyHandled = options.suppressGlobalHandledStatus === true && [401, 403].includes(status);
  if (globallyHandled) return '';
  if (status === 401) return '登录状态已失效，请重新登录后再试。';
  if (status === 403) return '权限不足：当前账号没有执行该操作的权限。';
  const mappedCodes = reasonCodes.filter(hasEnergyAnalysisReasonLabel);
  if (mappedCodes.length) return mappedCodes.map(reasonCodeLabel).join('；');
  if (status === 423) return reasonCodeLabel('MAINTENANCE_IN_PROGRESS');
  if (status === 413) return reasonCodeLabel('ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE');
  return apiError.message || error?.message || fallback;
}

/** 返回配置列表响应中的 items，兼容直接数据与统一响应包装。 */
export function responseItems(response) {
  const data = response?.data ?? response ?? {};
  return Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
}

/** 返回主数据列表并宽容处理常见分页包装。 */
export function masterDataItems(response) {
  const data = response?.data ?? response ?? [];
  if (Array.isArray(data)) return data;
  return data.items || data.records || data.list || [];
}
