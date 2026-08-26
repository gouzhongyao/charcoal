// 独立碳活动管理纯逻辑模块：筛选、受控导入、状态和墙钟展示均不执行浏览器时区换算。

// 独立碳活动固定执行确认文本：与服务端冻结合同一致。
export const CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT = '确认导入独立碳活动';
// 独立碳活动来源类型：页面固定查询 independent_activity，避免与旧能耗事实混用。
export const INDEPENDENT_ACTIVITY_SOURCE_TYPE = 'independent_activity';
// 来源墙钟分钟精度格式：只用于展示合同说明，不把墙钟字符串直接追加 Z。
export const SOURCE_WALL_CLOCK_FORMAT = 'YYYY-MM-DDTHH:mm';

// 活动状态选项：与服务端列表白名单保持一致。
export const CARBON_ACTIVITY_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: 'active', label: '有效' }),
  Object.freeze({ value: 'superseded', label: '已替代' }),
  Object.freeze({ value: 'void', label: '已作废' })
]);
// 活动排放范围选项：页面使用服务端支持的稳定代码。
export const CARBON_ACTIVITY_SCOPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'scope_1', label: '范围一' }),
  Object.freeze({ value: 'scope_2', label: '范围二' }),
  Object.freeze({ value: 'scope_3', label: '范围三' })
]);

// 活动状态中文映射：未知状态保留原值便于排错。
const CARBON_ACTIVITY_STATUS_LABELS = Object.freeze(Object.fromEntries(
  CARBON_ACTIVITY_STATUS_OPTIONS.map((item) => [item.value, item.label])
));
// 活动排放范围中文映射：未知范围保留原值便于排错。
const CARBON_ACTIVITY_SCOPE_LABELS = Object.freeze(Object.fromEntries(
  CARBON_ACTIVITY_SCOPE_OPTIONS.map((item) => [item.value, item.label])
));

/** 返回独立碳活动状态中文名称。 */
export function carbonActivityStatusLabel(status) {
  return CARBON_ACTIVITY_STATUS_LABELS[String(status || '')] || String(status || '未知状态');
}

/** 返回独立碳活动排放范围中文名称。 */
export function carbonActivityScopeLabel(scope) {
  return CARBON_ACTIVITY_SCOPE_LABELS[String(scope || '')] || String(scope || '未标注');
}

/** 构造活动列表和导出共用筛选，固定显式 independent_activity 来源。 */
export function buildCarbonActivityFilters(filters = {}, pagination = {}) {
  // 候选参数：空文本由本函数移除，UTC 值保持调用方已经校验的严格字符串。
  const candidates = {
    keyword: String(filters.keyword || '').trim(),
    scope: filters.scope,
    organizationUnitId: filters.organizationUnitId,
    energyTypeId: filters.energyTypeId,
    status: filters.status,
    sourceType: INDEPENDENT_ACTIVITY_SOURCE_TYPE,
    sourceBatchId: filters.sourceBatchId,
    startUtc: filters.startUtc,
    endUtc: filters.endUtc,
    page: pagination.page,
    pageSize: pagination.pageSize
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => (
    value !== '' && value !== null && value !== undefined
  )));
}

/** 规范化活动导入预演汇总，真实零保持为 0。 */
export function normalizeCarbonActivityImportSummary(summary = {}) {
  return {
    totalRows: Number(summary.totalRows || 0),
    wouldImport: Number(summary.wouldImport || 0),
    skipped: Number(summary.skipped || 0),
    blocked: Number(summary.blocked || 0),
    warnings: Number(summary.warnings || 0),
    errors: Number(summary.errors || 0)
  };
}

/** 判断预演是否具备可执行的持久批次和至少一条候选。 */
export function canExecuteCarbonActivityImport(preview) {
  // 批次 ID：只接受正安全整数，不能以客户端候选数组替代服务端批次。
  const batchId = Number(preview?.batchId);
  // 预演汇总：可导入为 0 时禁止发起空执行。
  const summary = normalizeCarbonActivityImportSummary(preview?.summary);
  return Number.isSafeInteger(batchId) && batchId > 0 && summary.wouldImport > 0;
}

/** 构造独立活动 execute 四字段最小载荷，禁止提交候选、签名或 audit witness。 */
export function buildCarbonActivityImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText || CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 构造作废载荷，只提交原因与当前详情的 expectedUpdatedAt 乐观锁。 */
export function buildCarbonActivityVoidPayload(reason, activity = {}) {
  return {
    reason: String(reason || '').trim(),
    expectedUpdatedAt: activity.updatedAt
  };
}

/** 原样显示来源墙钟，绝不追加 Z 或通过 Date 转换。 */
export function formatSourceWallClock(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}
