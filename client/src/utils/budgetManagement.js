import { ENERGY_TYPE_COLORS } from './energyStatistics.js';

export const ENERGY_BUDGET_IMPORT_CONFIRM_TEXT = '确认导入用能预算';

export const BUDGET_CATEGORY_COLORS = Object.freeze([
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948'
]);

export function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function buildBudgetFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    monthStart: filters.monthStart,
    monthEnd: filters.monthEnd,
    energyTypeCode: filters.energyTypeCode,
    organizationScope: filters.organizationScope,
    status: filters.status,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function totalsByUnitLabel(rows = []) {
  if (!rows.length) return '暂无原始预算值';
  return rows.map((row) => `${Number(row.budgetValue || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${row.unit || '未标注单位'}`).join('；');
}

export function buildBudgetImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText || ENERGY_BUDGET_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: numberValue(preview.summary?.wouldImport),
    candidateRowIds: preview.candidateRowIds || [],
    candidateRows: preview.candidateRows || [],
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

export function nextBudgetStatus(currentStatus) {
  return currentStatus === 'active' ? 'inactive' : 'active';
}

export function categoryColor(key = '') {
  if (ENERGY_TYPE_COLORS[key]) return ENERGY_TYPE_COLORS[key];
  const text = String(key || 'other');
  const hash = [...text].reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
  return BUDGET_CATEGORY_COLORS[hash % BUDGET_CATEGORY_COLORS.length];
}
