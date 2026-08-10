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

/** 将输入转换为有限数值；无效输入不参与真实数据计算。 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
    return createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, '驾驶舱摘要缺少明确的领域授权状态。');
  }
  if (domain?.status === 'available') return createDashboardPanelState(DASHBOARD_PANEL_STATUS.SUCCESS);
  if (domain?.status === 'empty') return createDashboardPanelState(DASHBOARD_PANEL_STATUS.EMPTY);
  return createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, '驾驶舱摘要返回了无法识别的领域状态。');
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
