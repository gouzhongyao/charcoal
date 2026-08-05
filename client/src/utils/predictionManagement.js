import { ENERGY_TYPE_COLORS } from './energyStatistics.js';

/** 预测配置导入执行必须匹配的固定确认文本。 */
export const PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT = '确认导入预测配置草稿';
/** 图表实体色固定顺序；状态色不作为系列色使用。 */
export const PREDICTION_CATEGORY_COLORS = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']);
/** 预测结果不允许人工写入的前端边界。 */
export const PREDICTION_RESULTS_READ_ONLY = true;

/** 将值转换为安全有限数。 */
export function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** 构造配置列表与配置导出共用筛选参数。 */
export function buildPredictionConfigFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    status: filters.status,
    energyTypeCode: filters.energyTypeCode,
    algorithm: filters.algorithm,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 构造运行列表和真实运行统计共用筛选参数。 */
export function buildPredictionRunFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    status: filters.status,
    algorithm: filters.algorithm,
    energyTypeCode: filters.energyTypeCode,
    targetMonth: filters.targetMonth,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 构造只读结果列表和结果导出共用筛选参数。 */
export function buildPredictionResultFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    runId: filters.runId,
    energyTypeCode: filters.energyTypeCode,
    targetMonthStart: filters.targetMonthStart,
    targetMonthEnd: filters.targetMonthEnd,
    runStatus: filters.runStatus,
    keyword: filters.keyword,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 原样构造签名预演的受控执行载荷，不能人为生成候选。 */
export function buildPredictionConfigImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText || PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
    previewSignature: preview.previewSignature,
    expectedWouldImport: numberValue(preview.summary?.wouldImport),
    candidateRowIds: preview.candidateRowIds || [],
    candidateRows: preview.candidateRows || [],
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 归档配置可以恢复为 draft，其他配置仅可以归档。 */
export function nextPredictionConfigStatus(status) {
  return status === 'archived' ? 'draft' : 'archived';
}

/** 只有服务端尚处于 pending/running 的运行才可能取消。 */
export function canCancelPredictionRun(status) {
  return ['pending', 'running'].includes(status);
}

/** 只有服务端终态运行才允许归档。 */
export function canArchivePredictionRun(status) {
  return ['completed', 'failed', 'cancelled', 'archived'].includes(status);
}

/** 用固定实体键分配分类颜色，能源类型优先沿用全局固定色。 */
export function predictionCategoryColor(key = '') {
  if (ENERGY_TYPE_COLORS[key]) return ENERGY_TYPE_COLORS[key];
  const text = String(key || 'other');
  const hash = [...text].reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
  return PREDICTION_CATEGORY_COLORS[hash % PREDICTION_CATEGORY_COLORS.length];
}

/** 仅返回同一预测单位下的真实结果，禁止跨单位前端合计。 */
export function rowsForPredictionUnit(rows = [], unit = '') {
  return rows.filter((row) => String(row?.predictedUnit || '') === String(unit || ''));
}

/** 按能源类型与月份汇总同一单位的实际服务端结果。 */
export function buildPredictionTrendRows(rows = [], unit = '') {
  const grouped = new Map();
  rowsForPredictionUnit(rows, unit).forEach((row) => {
    const energyTypeCode = String(row.energyTypeCode || 'other');
    const targetMonth = String(row.targetMonth || '');
    if (!targetMonth) return;
    const key = `${energyTypeCode}:${targetMonth}`;
    const current = grouped.get(key) || { energyTypeCode, energyTypeName: row.energyTypeName || energyTypeCode, targetMonth, predictedUnit: unit, predictedValue: 0, resultCount: 0 };
    current.predictedValue += numberValue(row.predictedValue);
    current.resultCount += 1;
    grouped.set(key, current);
  });
  return [...grouped.values()].sort((left, right) => left.targetMonth.localeCompare(right.targetMonth) || left.energyTypeCode.localeCompare(right.energyTypeCode));
}

/** 汇总卡按预测单位并列展示，不能构造跨单位结果总量。 */
export function predictionTotalsByUnitLabel(rows = []) {
  const totals = new Map();
  rows.forEach((row) => {
    const unit = row?.predictedUnit || '未标注单位';
    totals.set(unit, numberValue(totals.get(unit)) + numberValue(row?.predictedValue));
  });
  return [...totals.entries()].map(([unit, value]) => `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`).join('；') || '暂无服务端预测结果';
}
