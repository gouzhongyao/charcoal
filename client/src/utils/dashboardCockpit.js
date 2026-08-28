/** 驾驶舱面板允许使用的局部状态。 */
export const DASHBOARD_PANEL_STATUS = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  SUCCESS: 'success',
  EMPTY: 'empty',
  FORBIDDEN: 'forbidden',
  ERROR: 'error'
});

/** 用能预算预警状态的展示优先级。 */
const BUDGET_WARNING_PRIORITY = Object.freeze({
  unit_mismatch: 5,
  exceeded: 4,
  missing_budget: 3,
  nearing: 2,
  normal: 1
});

/** 碳排数值固定保留的最少小数位。 */
const CARBON_MINIMUM_FRACTION_DIGITS = 4;
/** 碳排常规小数展示允许保留的最多小数位。 */
const CARBON_MAXIMUM_FRACTION_DIGITS = 8;
/** 小于该绝对值的非零碳排改用科学计数法，避免显示成精确零。 */
const CARBON_SCIENTIFIC_THRESHOLD = 10 ** -8;
/** 百分比常规展示的小数位数。 */
const PERCENTAGE_FRACTION_DIGITS = 1;
/** 百分比小于该显示精度时使用阈值文本，避免非零值显示为 0.0%。 */
const PERCENTAGE_THRESHOLD = 0.5 * (10 ** -PERCENTAGE_FRACTION_DIGITS);

/** 将输入转换为有限数值；无效输入不参与真实数据计算。 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 统一格式化驾驶舱能源与碳排数值；碳排非零小值不得显示成精确零。 */
export function formatDashboardMeasurement(value, options = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const number = finiteNumber(value);
  if (number === null) return '—';
  const kind = String(options.kind || 'energy');
  if (kind === 'carbon') {
    if (number !== 0 && Math.abs(number) < CARBON_SCIENTIFIC_THRESHOLD) {
      return number.toExponential(CARBON_MINIMUM_FRACTION_DIGITS).replace('e+', 'e');
    }
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: CARBON_MINIMUM_FRACTION_DIGITS,
      maximumFractionDigits: CARBON_MAXIMUM_FRACTION_DIGITS
    }).format(number);
  }
  const requestedDigits = Number.parseInt(String(options.maximumFractionDigits ?? 2), 10);
  const maximumFractionDigits = Number.isInteger(requestedDigits)
    ? Math.min(20, Math.max(0, requestedDigits))
    : 2;
  const scientificThreshold = 0.5 * (10 ** -maximumFractionDigits);
  if (number !== 0 && Math.abs(number) < scientificThreshold) {
    return number.toExponential(Math.max(1, Math.min(4, maximumFractionDigits || 2))).replace('e+', 'e');
  }
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(number);
}

/** 格式化真实百分比；极小非零绝对值使用明确阈值文本。 */
export function formatDashboardPercentage(value, options = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const number = finiteNumber(value);
  if (number === null) return '—';
  const requestedDigits = Number.parseInt(String(options.maximumFractionDigits ?? PERCENTAGE_FRACTION_DIGITS), 10);
  const maximumFractionDigits = Number.isInteger(requestedDigits)
    ? Math.min(20, Math.max(0, requestedDigits))
    : PERCENTAGE_FRACTION_DIGITS;
  const displayUnit = 10 ** -maximumFractionDigits;
  const threshold = maximumFractionDigits === PERCENTAGE_FRACTION_DIGITS
    ? PERCENTAGE_THRESHOLD
    : 0.5 * displayUnit;
  const absoluteValue = Math.abs(number);
  if (absoluteValue > 0 && absoluteValue < threshold) {
    const thresholdText = new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: maximumFractionDigits,
      maximumFractionDigits
    }).format(displayUnit);
    return `${number < 0 ? '>' : '<'}${number < 0 ? '-' : ''}${thresholdText}%`;
  }
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(number)}%`;
}

/** 计算趋势图真实数值轴最大值；仅全零或无数据时回退到 1。 */
export function resolveTrendAxisMaximum(rows = []) {
  const maximum = (Array.isArray(rows) ? rows : []).reduce((currentMaximum, row) => {
    const value = finiteNumber(row?.totalNormalizedValue);
    return value !== null && value > currentMaximum ? value : currentMaximum;
  }, 0);
  return maximum > 0 ? maximum : 1;
}

/** 返回安全年度及其完整月份范围。 */
export function buildDashboardYearRange(year, fallbackYear = new Date().getFullYear()) {
  const parsedYear = Number.parseInt(String(year), 10);
  const parsedFallbackYear = Number.parseInt(String(fallbackYear), 10);
  const safeFallbackYear = Number.isInteger(parsedFallbackYear) ? parsedFallbackYear : new Date().getFullYear();
  const safeYear = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 9999 ? parsedYear : safeFallbackYear;
  return {
    year: safeYear,
    normalizedMonthStart: `${safeYear}-01`,
    normalizedMonthEnd: `${safeYear}-12`
  };
}

/** 创建统一的驾驶舱局部面板状态。 */
export function createDashboardPanelState(status = DASHBOARD_PANEL_STATUS.IDLE, data = null, error = '') {
  const allowedStatuses = Object.values(DASHBOARD_PANEL_STATUS);
  const safeStatus = allowedStatuses.includes(status) ? status : DASHBOARD_PANEL_STATUS.IDLE;
  return { status: safeStatus, data, error: String(error || '') };
}

/** 将成功响应投影为 success 或 empty，空结果仍属于真实成功结果。 */
export function settleDashboardPanelSuccess(data, isEmpty = false) {
  return createDashboardPanelState(
    isEmpty ? DASHBOARD_PANEL_STATUS.EMPTY : DASHBOARD_PANEL_STATUS.SUCCESS,
    data,
    ''
  );
}

/** 将驾驶舱摘要领域授权元数据投影为明确面板状态。 */
export function resolveDashboardSummaryDomainState(domain = {}) {
  if (domain?.authorized === false || domain?.status === 'forbidden') {
    return createDashboardPanelState(DASHBOARD_PANEL_STATUS.FORBIDDEN);
  }
  if (domain?.authorized !== true) {
    return createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, '中控摘要缺少明确的领域授权状态。');
  }
  if (domain?.status === 'available') return createDashboardPanelState(DASHBOARD_PANEL_STATUS.SUCCESS);
  if (domain?.status === 'empty') return createDashboardPanelState(DASHBOARD_PANEL_STATUS.EMPTY);
  return createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, '中控摘要返回了无法识别的领域状态。');
}

/** 判断响应请求版本是否仍是当前版本，防止旧年度响应覆盖新筛选。 */
export function isLatestDashboardRequest(requestVersion, currentVersion) {
  return Number(requestVersion) === Number(currentVersion);
}

/** 计算允许真实零值的百分比，不为零值伪造最小图形。 */
export function calculateZeroSafePercentage(value, maximum) {
  const safeValue = finiteNumber(value);
  const safeMaximum = finiteNumber(maximum);
  if (safeValue === null || safeValue <= 0 || safeMaximum === null || safeMaximum <= 0) return 0;
  return Math.min(100, (safeValue / safeMaximum) * 100);
}

/** 按单位安全分组，禁止不同单位在同一数值口径中直接相加。 */
function groupRowsByUnit(rows, unitKey) {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const unit = String(row?.[unitKey] || '').trim();
    if (!unit) return;
    const currentRows = groups.get(unit) || [];
    currentRows.push(row);
    groups.set(unit, currentRows);
  });
  return [...groups.entries()]
    .map(([unit, groupedRows]) => ({ unit, rows: groupedRows }))
    .sort((left, right) => left.unit.localeCompare(right.unit, 'zh-CN'));
}

/** 按 normalizedUnit 对能源数据安全分组。 */
export function groupEnergyRowsByUnit(rows = []) {
  return groupRowsByUnit(rows, 'normalizedUnit').map((group) => ({
    ...group,
    totalValue: group.rows.reduce((total, row) => total + (finiteNumber(row?.totalNormalizedValue) || 0), 0),
    recordCount: group.rows.reduce((total, row) => total + (finiteNumber(row?.recordCount) || 0), 0)
  }));
}

/** 按 energyTypeCode 与 normalizedUnit 构建互不跨单位的月度能源序列。 */
export function buildEnergyTrendSeries(rows = []) {
  const seriesMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const energyTypeCode = String(row?.energyTypeCode || '').trim();
    const normalizedUnit = String(row?.normalizedUnit || '').trim();
    const month = String(row?.month || '').trim();
    if (!energyTypeCode || !normalizedUnit || !month) return;
    const key = `${energyTypeCode}::${normalizedUnit}`;
    const current = seriesMap.get(key) || {
      key,
      energyTypeCode,
      energyTypeName: String(row?.energyTypeName || energyTypeCode),
      normalizedUnit,
      rows: []
    };
    current.rows.push({
      ...row,
      month,
      totalNormalizedValue: finiteNumber(row?.totalNormalizedValue) || 0,
      recordCount: finiteNumber(row?.recordCount) || 0
    });
    seriesMap.set(key, current);
  });
  return [...seriesMap.values()]
    .map((series) => ({
      ...series,
      rows: [...series.rows].sort((left, right) => left.month.localeCompare(right.month)),
      totalValue: series.rows.reduce((total, row) => total + row.totalNormalizedValue, 0),
      recordCount: series.rows.reduce((total, row) => total + row.recordCount, 0)
    }))
    .sort((left, right) => left.key.localeCompare(right.key, 'zh-CN'));
}

/** 按 emissionUnit 对碳排放统计安全分组。 */
export function groupCarbonRowsByUnit(rows = []) {
  return groupRowsByUnit(rows, 'emissionUnit').map((group) => ({
    ...group,
    totalValue: group.rows.reduce((total, row) => total + (finiteNumber(row?.totalEmissionValue) || 0), 0),
    recordCount: group.rows.reduce((total, row) => total + (finiteNumber(row?.emissionRecordCount) || 0), 0)
  }));
}

/** 按排放单位构建仅包含真实已核算月份的碳排趋势序列。 */
export function buildCarbonTrendSeries(rows = []) {
  const seriesMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const emissionUnit = String(row?.emissionUnit || '').trim();
    const month = String(row?.normalizedMonth || row?.month || '').trim();
    if (!emissionUnit || !month) return;
    const current = seriesMap.get(emissionUnit) || {
      key: `carbon::${emissionUnit}`,
      kind: 'carbon',
      label: '年度碳排趋势',
      normalizedUnit: emissionUnit,
      rows: [],
      missingFactorCount: 0
    };
    current.missingFactorCount += finiteNumber(row?.missingFactorCount) || 0;
    if ((finiteNumber(row?.calculatedCount) || 0) > 0) {
      current.rows.push({
        month,
        totalNormalizedValue: finiteNumber(row?.totalEmissionValue) || 0,
        recordCount: finiteNumber(row?.emissionRecordCount) || 0,
        calculatedCount: finiteNumber(row?.calculatedCount) || 0,
        missingFactorCount: finiteNumber(row?.missingFactorCount) || 0
      });
    }
    seriesMap.set(emissionUnit, current);
  });
  return [...seriesMap.values()]
    .filter((series) => series.rows.length > 0)
    .map((series) => ({
      ...series,
      rows: [...series.rows].sort((left, right) => left.month.localeCompare(right.month)),
      totalValue: series.rows.reduce((total, row) => total + row.totalNormalizedValue, 0),
      recordCount: series.rows.reduce((total, row) => total + row.recordCount, 0)
    }))
    .sort((left, right) => left.normalizedUnit.localeCompare(right.normalizedUnit, 'zh-CN'));
}

/** 将标准化月份解析为不受本地时区影响的连续月份序号。 */
function monthIndex(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || '').trim());
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/** 返回指定月份的自然前一月；不接受非 YYYY-MM 月份。 */
function previousCalendarMonth(month) {
  const index = monthIndex(month);
  if (index === null) return '';
  const year = Math.floor((index - 1) / 12);
  const monthNumber = ((index - 1) % 12) + 1;
  return `${year}-${String(monthNumber).padStart(2, '0')}`;
}

/** 创建只供年度趋势环比使用的上一自然月请求范围。 */
export function buildDashboardBaselineRange(selectedRange = {}) {
  const start = String(selectedRange?.normalizedMonthStart || '').trim();
  const baselineMonth = previousCalendarMonth(start);
  return baselineMonth
    ? { normalizedMonthStart: baselineMonth, normalizedMonthEnd: baselineMonth }
    : null;
}

/** 按标准化月份范围隔离真实年度行；没有月份字段的汇总行保持原样。 */
export function filterDashboardRowsByMonthRange(rows = [], selectedRange = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const start = String(selectedRange?.normalizedMonthStart || '').trim();
  const end = String(selectedRange?.normalizedMonthEnd || '').trim();
  if (!start || !end) return safeRows;
  return safeRows.filter((row) => {
    const month = String(row?.normalizedMonth || row?.month || '').trim();
    return !month || (month >= start && month <= end);
  });
}

/** 将额外的上一自然月序列挂到年度序列，仅供环比投影而不进入年度总计。 */
export function attachSeriesComparisonRows(series = [], comparisonSeries = []) {
  const comparisonMap = new Map(
    (Array.isArray(comparisonSeries) ? comparisonSeries : []).map((item) => [item.key, item])
  );
  return (Array.isArray(series) ? series : []).map((item) => ({
    ...item,
    comparisonRows: [...(comparisonMap.get(item.key)?.rows || [])]
  }));
}

/** 投影单一真实趋势序列的最新月份、自然前月差值和变化方向，不为缺月伪造环比。 */
export function projectSeriesChange(series = null) {
  const rowMap = new Map();
  [...(Array.isArray(series?.comparisonRows) ? series.comparisonRows : []), ...(Array.isArray(series?.rows) ? series.rows : [])]
    .map((row) => ({
      month: String(row?.month || '').trim(),
      value: finiteNumber(row?.totalNormalizedValue)
    }))
    .filter((row) => row.month && row.value !== null)
    .forEach((row) => rowMap.set(row.month, row));
  const rows = [...rowMap.values()].sort((left, right) => left.month.localeCompare(right.month));
  if (!rows.length) {
    return {
      status: 'empty', comparisonStatus: 'empty', latestMonth: '', latestValue: null,
      previousMonth: '', previousValue: null, delta: null, rate: null, direction: 'none'
    };
  }
  const latest = rows.at(-1);
  const expectedPreviousMonth = previousCalendarMonth(latest.month);
  const previous = expectedPreviousMonth
    ? rows.find((row) => row.month === expectedPreviousMonth)
    : null;
  const comparisonStatus = rows.length === 1
    ? 'single'
    : previous
      ? 'available'
      : 'missing-previous-month';
  const delta = previous ? latest.value - previous.value : null;
  const rate = previous && previous.value !== 0 ? (delta / Math.abs(previous.value)) * 100 : null;
  return {
    status: 'available',
    comparisonStatus,
    latestMonth: latest.month,
    latestValue: latest.value,
    previousMonth: expectedPreviousMonth,
    previousValue: previous?.value ?? null,
    delta,
    rate,
    direction: delta === null
      ? comparisonStatus === 'single' ? 'single' : 'missing'
      : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  };
}

/** 将碳排统计投影为总量、趋势和因子缺口一致的驾驶舱数据。 */
export function projectCarbonDashboardStats(stats = {}) {
  const calculatedCount = finiteNumber(stats?.calculatedCount) || 0;
  const missingFactorCount = finiteNumber(stats?.missingFactorCount) || 0;
  const trendSeries = calculatedCount > 0 ? buildCarbonTrendSeries(stats?.byMonth || []) : [];
  const calculatedUnits = new Set(trendSeries.map((series) => series.normalizedUnit));
  (Array.isArray(stats?.byEnergyType) ? stats.byEnergyType : []).forEach((row) => {
    if ((finiteNumber(row?.calculatedCount) || 0) > 0 && String(row?.emissionUnit || '').trim()) calculatedUnits.add(String(row.emissionUnit).trim());
  });
  const allUnitGroups = calculatedCount > 0 ? groupCarbonRowsByUnit(stats?.totalsByEmissionUnit || []) : [];
  const unitGroups = calculatedUnits.size > 0 ? allUnitGroups.filter((group) => calculatedUnits.has(group.unit)) : allUnitGroups;
  return {
    calculatedCount,
    missingFactorCount,
    unitGroups,
    trendSeries,
    hasMissingGap: missingFactorCount > 0,
    hasOnlyMissingFactors: calculatedCount === 0 && missingFactorCount > 0
  };
}

/** 返回预算比较行的标准预警级别，单位不一致优先于普通预警字段。 */
function normalizeBudgetWarningLevel(row = {}) {
  if (row?.comparisonStatus === 'unit_mismatch' || row?.warningLevel === 'unit_mismatch') return 'unit_mismatch';
  return BUDGET_WARNING_PRIORITY[row?.warningLevel] ? row.warningLevel : 'normal';
}

/** 将预算执行行投影为驾驶舱预警摘要，不跨单位汇总预算金额。 */
export function projectBudgetWarningStatus(rows = []) {
  const safeRows = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, dashboardWarningLevel: normalizeBudgetWarningLevel(row) }));
  const counts = { normal: 0, nearing: 0, exceeded: 0, missingBudget: 0, unitMismatch: 0 };
  safeRows.forEach((row) => {
    if (row.dashboardWarningLevel === 'unit_mismatch') counts.unitMismatch += 1;
    else if (row.dashboardWarningLevel === 'exceeded') counts.exceeded += 1;
    else if (row.dashboardWarningLevel === 'nearing') counts.nearing += 1;
    else if (row.dashboardWarningLevel === 'missing_budget') counts.missingBudget += 1;
    else counts.normal += 1;
  });
  const highestLevel = safeRows.reduce((currentLevel, row) => (
    BUDGET_WARNING_PRIORITY[row.dashboardWarningLevel] > BUDGET_WARNING_PRIORITY[currentLevel] ? row.dashboardWarningLevel : currentLevel
  ), 'normal');
  return {
    rowCount: safeRows.length,
    warningCount: counts.nearing + counts.exceeded + counts.missingBudget + counts.unitMismatch,
    highestLevel,
    counts,
    warningRows: safeRows
      .filter((row) => row.dashboardWarningLevel !== 'normal')
      .sort((left, right) => BUDGET_WARNING_PRIORITY[right.dashboardWarningLevel] - BUDGET_WARNING_PRIORITY[left.dashboardWarningLevel])
  };
}

/** 将五个真实面板状态聚合为园区业务示意状态，不掩盖局部失败或无权限。 */
export function projectDashboardSceneState(panelStates = []) {
  const statuses = (Array.isArray(panelStates) ? panelStates : [])
    .map((panel) => String(panel?.status || panel || DASHBOARD_PANEL_STATUS.IDLE))
    .filter(Boolean);
  const counts = statuses.reduce((result, status) => {
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  const total = statuses.length;
  if (total === 0 || counts.idle || counts.loading) {
    return { status: 'loading', description: '正在汇总已授权的真实业务面板状态。' };
  }
  if (counts.forbidden === total) {
    return { status: 'forbidden', description: '当前账号没有可用于园区业务示意的领域数据权限。' };
  }
  if (counts.error === total) {
    return { status: 'error', description: '全部业务面板读取失败，请分别使用面板重试入口。' };
  }
  if (counts.empty === total) {
    return { status: 'empty', description: '已完成读取，但当前范围内五个业务面板均暂无数据。' };
  }
  if (counts.error || counts.forbidden) {
    const unavailableCount = (counts.error || 0) + (counts.forbidden || 0);
    if (!counts.success) {
      const unavailableDescriptions = [
        counts.empty ? `${counts.empty} 个面板暂无数据` : '',
        counts.error ? `${counts.error} 个面板读取失败` : '',
        counts.forbidden ? `${counts.forbidden} 个面板无权限` : ''
      ].filter(Boolean);
      return { status: 'partial', description: `当前没有可汇总/展示的真实业务数据：${unavailableDescriptions.join('，')}。` };
    }
    return { status: 'partial', description: `已汇总部分真实业务数据，另有 ${unavailableCount} 个面板读取失败或无权限。` };
  }
  return {
    status: 'success',
    description: counts.empty ? '真实业务面板已完成汇总，部分领域当前暂无数据。' : '五个真实业务面板已完成汇总。'
  };
}
