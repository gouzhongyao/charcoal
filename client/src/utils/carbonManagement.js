import { ENERGY_TYPE_COLORS } from './energyStatistics.js';

/** 碳因子导入执行必须匹配的固定确认文本。 */
export const CARBON_FACTOR_IMPORT_CONFIRM_TEXT = '确认导入碳因子';
/** 分类图使用固定实体色，状态色不作为任何图表系列色。 */
export const CARBON_CATEGORY_COLORS = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']);

/** 将可显示数值转换为有限数字。 */
export function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** 构造因子列表或导出共用筛选参数。 */
export function buildCarbonFactorFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    energyTypeCode: filters.energyTypeCode,
    region: filters.region,
    factorYear: filters.factorYear,
    status: filters.status,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 构造排放列表、统计、缺失因子和导出共用筛选参数。 */
export function buildCarbonEmissionFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    normalizedMonthStart: filters.normalizedMonthStart,
    normalizedMonthEnd: filters.normalizedMonthEnd,
    energyTypeCode: filters.energyTypeCode,
    organization: filters.organization,
    status: filters.status,
    calculationMethod: filters.calculationMethod,
    includeSuperseded: filters.includeSuperseded,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined && value !== false));
}

/** 构造不可篡改预演候选的导入执行载荷。 */
export function buildCarbonFactorImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText || CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: numberValue(preview.summary?.wouldImport),
    candidateRowIds: preview.candidateRowIds || [],
    candidateRows: preview.candidateRows || [],
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 返回碳因子下一状态，只支持启用和停用切换。 */
export function nextCarbonFactorStatus(currentStatus) {
  return currentStatus === 'active' ? 'inactive' : 'active';
}

/** 根据实体键稳定分配分类色，能源类型沿用全局固定色。 */
export function carbonCategoryColor(key = '') {
  if (ENERGY_TYPE_COLORS[key]) return ENERGY_TYPE_COLORS[key];
  const text = String(key || 'other');
  const hash = [...text].reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
  return CARBON_CATEGORY_COLORS[hash % CARBON_CATEGORY_COLORS.length];
}

/** 仅显示选定排放单位的统计行，禁止前端跨单位相加。 */
export function rowsForEmissionUnit(rows = [], emissionUnit = '') {
  return rows.filter((row) => String(row?.emissionUnit || '') === String(emissionUnit || ''));
}

/** 汇总卡按排放单位拼接，不构造跨单位总量。 */
export function totalsByEmissionUnitLabel(rows = []) {
  if (!rows.length) return '暂无已计算排放量';
  return rows.map((row) => `${numberValue(row.totalEmissionValue).toLocaleString('zh-CN', { maximumFractionDigits: 4 })} ${row.emissionUnit || '未标注单位'}`).join('；');
}

/** 将过多分类折叠为“其他”，并仅在同一排放单位内求和。 */
export function limitChartCategories(rows = [], labelKey, maxCategories = 7) {
  const sorted = [...rows].sort((left, right) => numberValue(right.totalEmissionValue) - numberValue(left.totalEmissionValue));
  if (sorted.length <= maxCategories) return sorted;
  const visibleRows = sorted.slice(0, maxCategories - 1);
  const hiddenRows = sorted.slice(maxCategories - 1);
  return [...visibleRows, {
    [labelKey]: '其他',
    emissionUnit: hiddenRows[0]?.emissionUnit || '',
    totalEmissionValue: hiddenRows.reduce((total, row) => total + numberValue(row.totalEmissionValue), 0),
    emissionRecordCount: hiddenRows.reduce((total, row) => total + numberValue(row.emissionRecordCount), 0),
    calculatedCount: hiddenRows.reduce((total, row) => total + numberValue(row.calculatedCount), 0),
    missingFactorCount: hiddenRows.reduce((total, row) => total + numberValue(row.missingFactorCount), 0)
  }];
}
