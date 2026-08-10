// 用能预算执行对比状态模块：统一识别可比较行、单位字段和多单位摘要。
const COMPARABLE_STATUS = 'comparable';
const UNIT_MISMATCH_STATUS = 'unit_mismatch';

// 判断值是否可作为服务端有效汇总值展示，避免 null 被转换为 0。
function hasSummaryValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

// 格式化可选汇总数值；无值时明确返回占位符。
function formatOptionalNumber(value) {
  if (!hasSummaryValue(value)) return '—';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 将 totalsByUnit 的数组或单位键对象契约统一为数组。
function normalizeTotalsByUnit(totalsByUnit) {
  if (Array.isArray(totalsByUnit)) return totalsByUnit;
  if (!totalsByUnit || typeof totalsByUnit !== 'object') return [];
  return Object.entries(totalsByUnit).map(([unit, totals]) => ({ unit, ...(totals || {}) }));
}

// 读取预算单位，兼容既有 unit 字段并优先使用新契约 budgetUnit。
export function budgetComparisonBudgetUnit(row = {}) {
  return row.budgetUnit || row.unit || '';
}

// 读取实际单位；实际值不存在时允许返回空单位。
export function budgetComparisonActualUnit(row = {}) {
  return row.actualUnit || '';
}

// 判断预算执行行是否属于单位不一致状态。
export function isBudgetUnitMismatch(row = {}) {
  return row.comparisonStatus === UNIT_MISMATCH_STATUS || row.warningLevel === UNIT_MISMATCH_STATUS;
}

// 仅当服务端明确标记可比较且预算、实际单位一致时允许进入比较图表和指标计算。
export function isComparableBudgetRow(row = {}) {
  const budgetUnit = budgetComparisonBudgetUnit(row);
  const actualUnit = budgetComparisonActualUnit(row);
  return row.isComparable === true
    && row.comparisonStatus === COMPARABLE_STATUS
    && !isBudgetUnitMismatch(row)
    && Boolean(budgetUnit)
    && budgetUnit === actualUnit;
}

// 提取可比较图表支持的共同单位，单位不一致及其他不可比较行不会进入选择器。
export function budgetComparisonUnits(rows = []) {
  return [...new Set(rows.filter(isComparableBudgetRow).map(budgetComparisonBudgetUnit))];
}

// 按共同单位筛选图表数据；表格应继续使用原始完整行集合。
export function budgetComparisonChartRows(rows = [], unit = '') {
  if (!unit) return [];
  return rows.filter((row) => isComparableBudgetRow(row) && budgetComparisonBudgetUnit(row) === unit);
}

// 不可比较行不读取差额或使用率，避免展示服务端遗留值造成误解。
export function budgetComparisonMetricValue(row = {}, field) {
  if (!isComparableBudgetRow(row)) return null;
  const value = row[field];
  return hasSummaryValue(value) ? Number(value) : null;
}

// 提供稳定的中文状态文案，确保单位不一致和缺少预算始终可识别。
export function budgetComparisonStatusLabel(row = {}) {
  if (isBudgetUnitMismatch(row)) return '单位不一致 / 不可比较';
  if (row.comparisonStatus === 'missing_budget') return row.warningLabel || '缺少预算';
  if (row.comparisonStatus === 'no_actual') return row.warningLabel || '暂无实际值';
  if (row.comparisonStatus === 'no_data') return row.warningLabel || '暂无数据';
  return row.warningLabel || (isComparableBudgetRow(row) ? '可比较' : '不可比较');
}

// 按单位展示执行汇总；多单位时优先使用 totalsByUnit，绝不把 null 总计伪装为 0。
export function budgetComparisonSummaryLabel(summary = {}) {
  const totalsByUnit = normalizeTotalsByUnit(summary.totalsByUnit);
  if (totalsByUnit.length) {
    const detail = totalsByUnit.map((row) => {
      const budgetValue = row.totalBudgetValue ?? row.budgetValue;
      const actualValue = row.totalActualValue ?? row.actualValue;
      return `${row.unit || '未标注单位'}（预算 ${formatOptionalNumber(budgetValue)}，实际 ${formatOptionalNumber(actualValue)}）`;
    }).join('；');
    return totalsByUnit.length > 1 ? `多单位汇总：${detail}` : detail;
  }

  const summaryUnit = summary.summaryUnit || '';
  const totalBudgetValue = summary.totalBudgetValue;
  const totalActualValue = summary.totalActualValue;
  if (summaryUnit && (hasSummaryValue(totalBudgetValue) || hasSummaryValue(totalActualValue))) {
    return `${summaryUnit}（预算 ${formatOptionalNumber(totalBudgetValue)}，实际 ${formatOptionalNumber(totalActualValue)}）`;
  }
  if (summary.summaryUnit === null || summaryUnit === '') return '多单位或无共同单位，不能跨单位合计';
  return '暂无执行汇总';
}
