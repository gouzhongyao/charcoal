// 碳排放报告批次类型：通用批次列表的可见性和原文件下载必须叠加 N6 精确权限。
export const CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE = 'carbon_emission_report';
// 温室气体报告批次类型：通用批次列表的可见性和原文件下载必须叠加 N7 精确权限。
export const GHG_REPORT_IMPORT_BATCH_TYPE = 'ghg_report';

// 导入批次筛选值与服务端 importService 的支持类型保持一一对应，value 用于 query、label 仅用于展示。
export const IMPORT_BATCH_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'energy_record', label: '能耗数据导入' }),
  Object.freeze({ value: 'meter_reading', label: '计量抄表导入' }),
  Object.freeze({ value: 'organization_unit', label: '组织/用能单元导入' }),
  Object.freeze({ value: 'meter_device', label: '计量器具导入' }),
  Object.freeze({ value: 'production_output', label: '月度产量导入' }),
  Object.freeze({ value: 'generation_record', label: '发电记录导入' }),
  // 供应商批次可在审计中心筛选，但通用批次删除函数仍严格拒绝该类型。
  Object.freeze({ value: 'supplier', label: '供应商台账导入' }),
  // N6 报告批次仅向具备 carbon:emission-reports:view 的账号投影。
  Object.freeze({ value: CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE, label: '碳排放报告导入' }),
  // N7 报告批次仅向具备 carbon:ghg-reports:view 的账号投影。
  Object.freeze({ value: GHG_REPORT_IMPORT_BATCH_TYPE, label: '温室气体报告导入' })
]);

/** 按 N6、N7 各自精确查看权限投影导入类型选项。 */
export function availableImportBatchTypeOptions(
  canViewCarbonEmissionReports = false,
  canViewGhgReports = false
) {
  return IMPORT_BATCH_TYPE_OPTIONS.filter((option) => (
    (option.value !== CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE || canViewCarbonEmissionReports === true)
    && (option.value !== GHG_REPORT_IMPORT_BATCH_TYPE || canViewGhgReports === true)
  ));
}

/** 防御性过滤通用批次响应；N6、N7 报告查看权限不得互相放行。 */
export function filterVisibleImportBatches(
  rows = [],
  canViewCarbonEmissionReports = false,
  canViewGhgReports = false
) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    const importType = String(row?.importType || '');
    if (importType === CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE) {
      return canViewCarbonEmissionReports === true;
    }
    if (importType === GHG_REPORT_IMPORT_BATCH_TYPE) return canViewGhgReports === true;
    return true;
  });
}

/** 判断原文件按钮权限；两类报告批次除 imports:download 外还需各自 export。 */
export function canDownloadImportBatchSource(batch = {}, permissionState = {}) {
  if (permissionState.canDownload !== true) return false;
  const importType = String(batch.importType || '');
  if (importType === CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE) {
    return permissionState.canExportCarbonEmissionReports === true;
  }
  if (importType === GHG_REPORT_IMPORT_BATCH_TYPE) {
    return permissionState.canExportGhgReports === true;
  }
  return true;
}

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

/** 通用导入批次删除仅限明确标记的普通能耗批次，缺失或未知类型默认拒绝。 */
export function canUseGenericImportBatchDelete(batch = {}) {
  return String(batch.importType || '').trim() === 'energy_record';
}

/** 生成普通能耗批次删除确认内容，集中展示影响记录、备份和非联动边界。 */
export function buildImportBatchDeleteConfirmation(batch = {}) {
  // 批次标识用于在危险确认中锁定用户正在操作的对象。
  const batchId = batch.id === undefined || batch.id === null || batch.id === '' ? '未知' : String(batch.id);
  // 原文件名称优先使用服务端解码后的展示名称。
  const originalFilename = String(batch.displayFilename || batch.originalFilename || '未命名原文件');
  // 列表成功计数用于估算影响，最终删除数量仍以服务端事务结果为准。
  const rawExpectedCount = Number(batch.successCount);
  // 预计影响数量用于避免非法列表值显示为负数或小数。
  const expectedEnergyRecords = Number.isFinite(rawExpectedCount) && rawExpectedCount >= 0
    ? Math.trunc(rawExpectedCount)
    : 0;
  return [
    '即将删除普通能耗导入批次：',
    `批次 ID：#${batchId}`,
    `原文件名：${originalFilename}`,
    `预计影响能耗记录：${expectedEnergyRecords} 条（最终以服务端实际删除数量为准）`,
    '关联旧碳排结果将同步删除。',
    '既有预测运行和预测结果不会自动删除；如需反映最新数据，请重新创建预测运行。',
    '删除前系统将强制创建 SQLite 备份；备份失败会拒绝删除。',
    '上传原文件不会由本操作物理删除。'
  ].join('\n');
}

/** 生成批次删除成功提示，展示实际删除数量和可追溯备份标识。 */
export function buildImportBatchDeleteSuccessMessage(result = {}) {
  // 实际能耗删除数量用于替代列表中的预计值。
  const deletedEnergyRecords = Number.isFinite(Number(result.deletedEnergyRecords))
    ? Math.max(0, Math.trunc(Number(result.deletedEnergyRecords)))
    : 0;
  // 实际旧碳结果删除数量用于说明级联影响。
  const deletedCarbonEmissions = Number.isFinite(Number(result.deletedCarbonEmissions))
    ? Math.max(0, Math.trunc(Number(result.deletedCarbonEmissions)))
    : 0;
  // 安全备份名称用于恢复追溯，不展示本机绝对路径。
  const backupName = String(result.backup?.backupName || '未返回备份标识');
  return `普通能耗导入批次已删除：能耗记录 ${deletedEnergyRecords} 条，关联旧碳结果 ${deletedCarbonEmissions} 条；删除前备份：${backupName}。预测运行和结果未自动删除。`;
}

/** 生成仅含用户映射值的字段映射，避免向服务端传递空键值。 */
export function compactFieldMapping(mapping = {}) {
  return Object.fromEntries(Object.entries(mapping)
    .map(([field, sourceHeader]) => [String(field).trim(), String(sourceHeader || '').trim()])
    .filter(([field, sourceHeader]) => field && sourceHeader));
}

/** 根据响应类型生成包含批次编号和原文件扩展名的中文下载兜底名称。 */
export function buildImportOriginalFileFallbackName(batchId, contentType = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  const extension = normalizedType.includes('spreadsheetml')
    ? '.xlsx'
    : normalizedType.includes('ms-excel')
      ? '.xls'
      : normalizedType.includes('csv')
        ? '.csv'
        : '';
  return `导入批次原文件-${batchId}${extension}`;
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
