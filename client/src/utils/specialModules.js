/** 将导入筛选转换为服务端允许的批次查询参数。 */
export function buildImportBatchFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({
    importType: filters.importType,
    status: filters.status,
    fileType: filters.fileType,
    createdAtStart: filters.createdAtStart,
    createdAtEnd: filters.createdAtEnd,
    page: pagination.page,
    pageSize: pagination.pageSize
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/** 通用导入批次删除仅限普通能耗批次，保护领域维护的追溯链路。 */
export function canUseGenericImportBatchDelete(batch = {}) {
  return (batch.importType || 'energy_record') === 'energy_record';
}

/** 生成仅含用户映射值的字段映射，避免向服务端传递空键值。 */
export function compactFieldMapping(mapping = {}) {
  return Object.fromEntries(Object.entries(mapping)
    .map(([field, sourceHeader]) => [String(field).trim(), String(sourceHeader || '').trim()])
    .filter(([field, sourceHeader]) => field && sourceHeader));
}

/** 从 bootstrap 投影安全的本地部署信息，绝不把目录或数据库路径渲染到页面。 */
export function projectBootstrapInfo(bootstrap = {}) {
  const maintenance = bootstrap.maintenance || {};
  return {
    appName: String(bootstrap.appName || '本地轻量化能碳管理平台'),
    mode: String(bootstrap.database?.storage || bootstrap.mode || 'local-file'),
    maintenanceActive: maintenance.active === true,
    maintenanceReason: maintenance.reason ? String(maintenance.reason) : '',
    capabilities: Array.isArray(bootstrap.nextCapabilities) ? bootstrap.nextCapabilities.filter((value) => typeof value === 'string') : []
  };
}

/** 返回可显示的工作台数据范围，不将失败卡片伪装为零值。 */
export function dashboardScopeNotice(summary = {}) {
  const scope = String(summary.scope || '').trim();
  const excludes = Array.isArray(summary.excludes) ? summary.excludes.filter(Boolean) : [];
  if (!scope) return '各概览卡只展示其成功读取到的真实服务端数据；读取失败不会以 0 替代。';
  const excludedText = excludes.length ? `；当前摘要不包含 ${excludes.join('、')}` : '';
  return `当前摘要范围：${scope}${excludedText}。读取失败不会以 0 替代。`;
}

/** 将数值安全转换为非负图表比例，零值不伪造最小条形。 */
export function chartPercentage(value, maximum) {
  const number = Number(value);
  const max = Number(maximum);
  if (!Number.isFinite(number) || number <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, (number / max) * 100);
}
