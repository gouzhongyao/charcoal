import { daysInGregorianMonth } from './dateTimeFields.js';
import { isLatestRequestGeneration, nextRequestGeneration } from './requestGeneration.js';

// 碳排放报告前端纯逻辑模块：冻结权限、筛选、分页、五部分公开投影、受控导入和导出响应头合同。

// 固定模板身份：与服务端 carbonEmissionReportContracts 保持一致。
export const CARBON_EMISSION_REPORT_TEMPLATE_ID = 'carbon-emission-report';
// 固定模板版本：模板升级前不得由页面猜测新版本。
export const CARBON_EMISSION_REPORT_TEMPLATE_VERSION = '1.0';
// 固定执行确认文本：execute 最小载荷只能使用此文本。
export const CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT = '确认导入碳排放报告';
// 固定导入类型：用于通用批次筛选和前端权限投影。
export const CARBON_EMISSION_REPORT_IMPORT_TYPE = 'carbon_emission_report';
// 固定五部分顺序：工作表、详情和导出均使用合法名称“组织与核算边界”。
export const CARBON_EMISSION_REPORT_SECTION_NAMES = Object.freeze([
  '报告信息',
  '组织与核算边界',
  '报告项目',
  '汇总',
  '证据说明'
]);

// 报告排放范围筛选选项：与服务端 scope 白名单一致。
export const CARBON_EMISSION_REPORT_SCOPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'scope_1', label: '范围一' }),
  Object.freeze({ value: 'scope_2', label: '范围二' }),
  Object.freeze({ value: 'scope_3', label: '范围三' })
]);

// 排放范围中文映射：未知服务端值保留原文以便发现合同漂移。
const CARBON_EMISSION_REPORT_SCOPE_LABELS = Object.freeze(Object.fromEntries(
  CARBON_EMISSION_REPORT_SCOPE_OPTIONS.map((option) => [option.value, option.label])
));
// 边界类型中文映射：数据库稳定枚举不得直接暴露为主要文案。
const CARBON_EMISSION_REPORT_BOUNDARY_LABELS = Object.freeze({
  organization: '组织边界',
  accounting: '核算边界'
});
// 汇总维度中文映射：未知维度保留原文以便排错。
const CARBON_EMISSION_REPORT_SUMMARY_LABELS = Object.freeze({
  total: '总计',
  scope: '排放范围',
  category: '类别'
});
// 内部字段集合：公开前端状态不得保留或展示这些服务端安全链字段。
// 预演汇总固定计数字段：HTTP 响应缺失、字符串化或超安全整数时均不得进入可执行状态。
const CARBON_EMISSION_REPORT_IMPORT_SUMMARY_FIELDS = Object.freeze([
  'totalRows', 'wouldImport', 'skipped', 'blocked', 'warnings', 'errors'
]);
// 预演项目固定状态：汇总计数必须与项目状态逐项一致。
const CARBON_EMISSION_REPORT_IMPORT_ITEM_STATUSES = Object.freeze([
  'wouldImport', 'skipped', 'blocked'
]);
// 内部字段集合：公开前端状态不得保留或展示这些服务端安全链字段。
export const CARBON_EMISSION_REPORT_INTERNAL_FIELDS = Object.freeze([
  'storedFilename',
  'fileSha256',
  'sourceFileSha256',
  'candidateRowId',
  'candidateRows',
  'candidateRowIds',
  'previewSignature',
  'previewAuditDigest',
  'previewAudit',
  'witness',
  'auditContext',
  'executeResult',
  'auditBatch'
]);

/** 判断值是否为普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 将可选文本规范为去除首尾空白的字符串。 */
function normalizeOptionalText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 校验并返回正安全整数。 */
function normalizePositiveSafeInteger(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new Error(`${fieldName} 必须是正安全整数。`);
  }
  return numberValue;
}

/** 校验并返回非负安全整数计数。 */
function normalizeNonNegativeSafeInteger(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`${fieldName} 必须是非负安全整数。`);
  }
  return numberValue;
}

/** 严格校验并返回服务端公共 DTO 的正安全整数，不接受字符串数字。 */
function projectPositiveSafeInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} 必须是正安全整数 number。`);
  }
  return value;
}

/** 严格校验并返回服务端公共 DTO 的非负安全整数，不接受字符串数字。 */
function projectNonNegativeSafeInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} 必须是非负安全整数 number。`);
  }
  return value;
}

/** 校验并返回有限数值，确保详情中的真实数值不被字符串化。 */
function normalizeFiniteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} 必须是有限数值。`);
  }
  return value;
}

/** 严格校验 YYYY-MM-DD 自然日，不经过 Date 或浏览器时区。 */
export function normalizeCarbonEmissionReportDate(value) {
  const text = normalizeOptionalText(value);
  if (!text) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('报告期间必须使用 YYYY-MM-DD 格式。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maximumDay = daysInGregorianMonth(year, month);
  if (maximumDay === null || day < 1 || day > maximumDay) {
    throw new Error('报告期间必须是有效的公历日期。');
  }
  return text;
}

/** 投影 N6 四项精确权限；旧 carbon:view 和其他碳权限不得扩张报告权限。 */
export function projectCarbonEmissionReportPermissions(checkPermission = () => false) {
  // 权限检查器：异常调用方统一按无权限处理。
  const hasPermission = typeof checkPermission === 'function' ? checkPermission : () => false;
  return {
    canView: hasPermission('carbon:emission-reports:view') === true,
    canImportPreview: hasPermission('carbon:emission-reports:import:preview') === true,
    canImportExecute: hasPermission('carbon:emission-reports:import:execute') === true,
    canExport: hasPermission('carbon:emission-reports:export') === true
  };
}

/** 构造报告列表安全筛选和分页参数，拒绝无效日期及不安全偏移量。 */
export function buildCarbonEmissionReportFilters(filters = {}, pagination = {}) {
  // 当前页和页大小：与服务端默认值保持一致，同时前端先行阻断不安全值。
  const page = pagination.page === undefined ? 1 : normalizePositiveSafeInteger(pagination.page, 'page');
  const pageSize = pagination.pageSize === undefined ? 20 : normalizePositiveSafeInteger(pagination.pageSize, 'pageSize');
  if (pageSize > 200) throw new Error('pageSize 不能超过 200。');
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new Error('分页偏移量超过安全整数范围。');

  // 报告期间：筛选语义为与输入期间重叠，开始不得晚于结束。
  const periodStart = normalizeCarbonEmissionReportDate(filters.periodStart);
  const periodEnd = normalizeCarbonEmissionReportDate(filters.periodEnd);
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new Error('报告期间筛选必须满足开始日期不晚于结束日期。');
  }

  // 排放范围：非空值必须属于服务端固定白名单，不能把任意客户端文本透传。
  const scope = normalizeOptionalText(filters.scope);
  if (scope && !CARBON_EMISSION_REPORT_SCOPE_OPTIONS.some((option) => option.value === scope)) {
    throw new Error('排放范围筛选不符合固定合同。');
  }
  // 来源批次：非空值必须是正安全整数，避免不安全 ID 进入查询状态。
  const sourceBatchId = filters.sourceBatchId === '' || filters.sourceBatchId === null || filters.sourceBatchId === undefined
    ? undefined
    : normalizePositiveSafeInteger(filters.sourceBatchId, '来源批次 ID');

  // 查询候选：空值统一移除，确保只发送服务端允许字段。
  const candidates = {
    keyword: normalizeOptionalText(filters.keyword),
    reportCode: normalizeOptionalText(filters.reportCode),
    organization: normalizeOptionalText(filters.organization),
    periodStart,
    periodEnd,
    scope,
    category: normalizeOptionalText(filters.category),
    sourceBatchId,
    page,
    pageSize
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => (
    value !== '' && value !== null && value !== undefined
  )));
}

/** 将服务端列表报告投影为不包含哈希、路径或见证字段的公开对象。 */
export function projectCarbonEmissionReportListRow(row) {
  if (!isPlainObject(row)) throw new Error('碳排放报告列表行不符合响应合同。');
  return {
    id: normalizePositiveSafeInteger(row.id, '报告 ID'),
    reportCode: String(row.reportCode || ''),
    reportName: String(row.reportName || ''),
    reportOrganization: String(row.reportOrganization || ''),
    periodStart: String(row.periodStart || ''),
    periodEnd: String(row.periodEnd || ''),
    templateId: String(row.templateId || ''),
    templateVersion: String(row.templateVersion || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceBatchId: normalizePositiveSafeInteger(row.sourceBatchId, '来源批次 ID'),
    sourceRowNumber: normalizePositiveSafeInteger(row.sourceRowNumber, '来源行号'),
    createdBy: row.createdBy === null || row.createdBy === undefined ? null : Number(row.createdBy),
    createdByName: row.createdByName === null || row.createdByName === undefined ? null : String(row.createdByName),
    createdAt: String(row.createdAt || ''),
    sourceOriginalFilename: String(row.sourceOriginalFilename || ''),
    sourceBatchStatus: String(row.sourceBatchStatus || ''),
    itemCount: normalizeNonNegativeSafeInteger(row.itemCount, '报告项目数'),
    summaryCount: normalizeNonNegativeSafeInteger(row.summaryCount, '汇总数'),
    evidenceCount: normalizeNonNegativeSafeInteger(row.evidenceCount, '证据数')
  };
}

/** 严格投影服务端分页，避免错误 total 或相邻页碰撞进入页面状态。 */
export function projectCarbonEmissionReportPagination(pagination = {}) {
  if (!isPlainObject(pagination)) throw new Error('碳排放报告分页不符合响应合同。');
  return {
    page: normalizePositiveSafeInteger(pagination.page, '分页 page'),
    pageSize: normalizePositiveSafeInteger(pagination.pageSize, '分页 pageSize'),
    total: normalizeNonNegativeSafeInteger(pagination.total, '分页 total'),
    totalPages: normalizeNonNegativeSafeInteger(pagination.totalPages, '分页 totalPages')
  };
}

/** 投影报告主信息，明确丢弃 sourceFileSha256 等内部字段。 */
function projectCarbonEmissionReportHeader(report) {
  return projectCarbonEmissionReportListRow(report);
}

/** 投影组织与核算边界行。 */
function projectCarbonEmissionReportBoundary(row) {
  if (!isPlainObject(row)) throw new Error('组织与核算边界不符合响应合同。');
  return {
    id: normalizePositiveSafeInteger(row.id, '边界 ID'),
    boundaryType: String(row.boundaryType || ''),
    boundaryName: String(row.boundaryName || ''),
    boundaryDescription: String(row.boundaryDescription || ''),
    sourceRowNumber: normalizePositiveSafeInteger(row.sourceRowNumber, '边界来源行号')
  };
}

/** 投影报告项目行，并保持活动量、因子和排放量为 number。 */
function projectCarbonEmissionReportItem(row) {
  if (!isPlainObject(row)) throw new Error('报告项目不符合响应合同。');
  return {
    id: normalizePositiveSafeInteger(row.id, '报告项目 ID'),
    itemCode: String(row.itemCode || ''),
    emissionScope: String(row.emissionScope || ''),
    category: String(row.category || ''),
    emissionSource: String(row.emissionSource || ''),
    activityValue: normalizeFiniteNumber(row.activityValue, '活动量'),
    activityUnit: String(row.activityUnit || ''),
    factorValue: normalizeFiniteNumber(row.factorValue, '排放因子'),
    factorUnit: String(row.factorUnit || ''),
    emissionValue: normalizeFiniteNumber(row.emissionValue, '排放量'),
    co2eUnit: String(row.co2eUnit || ''),
    evidenceCode: String(row.evidenceCode || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: normalizePositiveSafeInteger(row.sourceRowNumber, '项目来源行号')
  };
}

/** 投影汇总行，并保持汇总排放量为 number。 */
function projectCarbonEmissionReportSummary(row) {
  if (!isPlainObject(row)) throw new Error('碳排放报告汇总不符合响应合同。');
  return {
    id: normalizePositiveSafeInteger(row.id, '汇总 ID'),
    summaryCode: String(row.summaryCode || ''),
    summaryDimension: String(row.summaryDimension || ''),
    summaryValue: String(row.summaryValue || ''),
    emissionValue: normalizeFiniteNumber(row.emissionValue, '汇总排放量'),
    co2eUnit: String(row.co2eUnit || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: normalizePositiveSafeInteger(row.sourceRowNumber, '汇总来源行号')
  };
}

/** 投影证据说明行。 */
function projectCarbonEmissionReportEvidence(row) {
  if (!isPlainObject(row)) throw new Error('碳排放报告证据不符合响应合同。');
  return {
    id: normalizePositiveSafeInteger(row.id, '证据 ID'),
    evidenceCode: String(row.evidenceCode || ''),
    evidenceName: String(row.evidenceName || ''),
    evidenceType: String(row.evidenceType || ''),
    evidenceDescription: String(row.evidenceDescription || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: normalizePositiveSafeInteger(row.sourceRowNumber, '证据来源行号')
  };
}

/** 严格投影五部分报告详情，缺少任一部分时 fail-closed。 */
export function projectCarbonEmissionReportDetail(detail) {
  if (!isPlainObject(detail)
    || !isPlainObject(detail.report)
    || !Array.isArray(detail.boundaries)
    || !Array.isArray(detail.items)
    || !Array.isArray(detail.summaries)
    || !Array.isArray(detail.evidence)) {
    throw new Error('碳排放报告五部分详情不符合响应合同。');
  }
  return {
    report: projectCarbonEmissionReportHeader(detail.report),
    boundaries: detail.boundaries.map(projectCarbonEmissionReportBoundary),
    items: detail.items.map(projectCarbonEmissionReportItem),
    summaries: detail.summaries.map(projectCarbonEmissionReportSummary),
    evidence: detail.evidence.map(projectCarbonEmissionReportEvidence)
  };
}

/** 规范化导入预演汇总；缺失汇总用于空页面显示零，已提供字段必须是非负安全整数 number。 */
export function normalizeCarbonEmissionReportImportSummary(summary = {}) {
  const source = isPlainObject(summary) ? summary : {};
  return {
    totalRows: source.totalRows === undefined ? 0 : projectNonNegativeSafeInteger(source.totalRows, '预演 totalRows'),
    wouldImport: source.wouldImport === undefined ? 0 : projectNonNegativeSafeInteger(source.wouldImport, '预演 wouldImport'),
    skipped: source.skipped === undefined ? 0 : projectNonNegativeSafeInteger(source.skipped, '预演 skipped'),
    blocked: source.blocked === undefined ? 0 : projectNonNegativeSafeInteger(source.blocked, '预演 blocked'),
    warnings: source.warnings === undefined ? 0 : projectNonNegativeSafeInteger(source.warnings, '预演 warnings'),
    errors: source.errors === undefined ? 0 : projectNonNegativeSafeInteger(source.errors, '预演 errors')
  };
}

/** 将预演问题投影为页面所需的公开字段，不保留 rawValue 或安全链内部字段。 */
function projectCarbonEmissionReportPreviewIssue(issue = {}) {
  const severity = String(issue.severity || 'error');
  if (!['error', 'warning'].includes(severity)) throw new Error('预演问题 severity 不符合公共合同。');
  return {
    rowNumber: projectNonNegativeSafeInteger(issue.rowNumber ?? 0, '预演问题行号'),
    fieldName: String(issue.fieldName || ''),
    code: String(issue.code || ''),
    message: String(issue.message || ''),
    severity
  };
}

/** 将服务端预演投影为安全页面状态，主动丢弃候选、签名、摘要见证和审计上下文。 */
export function projectCarbonEmissionReportPreview(preview = {}) {
  if (!isPlainObject(preview) || !isPlainObject(preview.summary)
    || !CARBON_EMISSION_REPORT_IMPORT_SUMMARY_FIELDS.every((fieldName) => Object.hasOwn(preview.summary, fieldName))
    || !Array.isArray(preview.items)
    || !Array.isArray(preview.notices)) {
    throw new Error('碳排放报告预演不符合公共响应合同。');
  }
  if (preview.templateType !== CARBON_EMISSION_REPORT_TEMPLATE_ID
    || preview.templateVersion !== CARBON_EMISSION_REPORT_TEMPLATE_VERSION) {
    throw new Error('碳排放报告预演模板身份不符合固定合同。');
  }
  // 预演项目：碳排放报告固定为一份原子报告，仅展示代码、名称、计数、状态和问题。
  const items = preview.items.map((item) => {
    if (!isPlainObject(item) || !isPlainObject(item.counts) || !Array.isArray(item.issues)) {
      throw new Error('碳排放报告预演项目不符合公共响应合同。');
    }
    const status = String(item.status || '');
    if (!CARBON_EMISSION_REPORT_IMPORT_ITEM_STATUSES.includes(status)) {
      throw new Error('碳排放报告预演项目状态不符合固定合同。');
    }
    return {
      rowNumber: projectNonNegativeSafeInteger(item.rowNumber, '预演报告信息行'),
      reportCode: item.reportCode === null || item.reportCode === undefined ? '' : String(item.reportCode),
      reportName: item.reportName === null || item.reportName === undefined ? '' : String(item.reportName),
      status,
      counts: {
        boundaries: projectNonNegativeSafeInteger(item.counts.boundaries, '预演边界行数'),
        items: projectNonNegativeSafeInteger(item.counts.items, '预演项目行数'),
        summaries: projectNonNegativeSafeInteger(item.counts.summaries, '预演汇总行数'),
        evidence: projectNonNegativeSafeInteger(item.counts.evidence, '预演证据行数')
      },
      issues: item.issues.map(projectCarbonEmissionReportPreviewIssue)
    };
  });
  return {
    batchId: projectPositiveSafeInteger(preview.batchId, '预演批次 ID'),
    templateType: CARBON_EMISSION_REPORT_TEMPLATE_ID,
    templateVersion: CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    summary: normalizeCarbonEmissionReportImportSummary(preview.summary),
    notices: preview.notices.map((notice) => String(notice)),
    items
  };
}

/** 判断预演是否具备严格公共汇总和唯一一份可导入原子报告。 */
export function canExecuteCarbonEmissionReportImport(preview) {
  try {
    if (!isPlainObject(preview)
      || typeof preview.batchId !== 'number'
      || !Number.isSafeInteger(preview.batchId)
      || preview.batchId < 1
      || !isPlainObject(preview.summary)
      || !CARBON_EMISSION_REPORT_IMPORT_SUMMARY_FIELDS.every((fieldName) => Object.hasOwn(preview.summary, fieldName))
      || !Array.isArray(preview.items)
      || preview.items.length !== 1) return false;
    const summary = normalizeCarbonEmissionReportImportSummary(preview.summary);
    const statusCounts = { wouldImport: 0, skipped: 0, blocked: 0 };
    let warnings = 0;
    let errors = 0;
    for (const item of preview.items) {
      if (!isPlainObject(item)
        || !CARBON_EMISSION_REPORT_IMPORT_ITEM_STATUSES.includes(item.status)
        || !Array.isArray(item.issues)) return false;
      statusCounts[item.status] += 1;
      for (const issue of item.issues) {
        if (!isPlainObject(issue) || !['warning', 'error'].includes(issue.severity)) return false;
        if (issue.severity === 'warning') warnings += 1;
        if (issue.severity === 'error') errors += 1;
      }
    }
    return preview.items[0].status === 'wouldImport'
      && summary.totalRows === preview.items.length
      && summary.wouldImport === statusCounts.wouldImport
      && summary.skipped === statusCounts.skipped
      && summary.blocked === statusCounts.blocked
      && summary.warnings === warnings
      && summary.errors === errors
      && summary.wouldImport === 1
      && summary.blocked === 0;
  } catch (_error) {
    return false;
  }
}

/** 构造 execute 四字段最小载荷，禁止提交客户端候选、签名、摘要或见证。 */
export function buildCarbonEmissionReportImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 执行当前请求世代；旧成功、旧错误和旧 finally 均不得提交到新的页面意图。 */
export async function runLatestCarbonEmissionReportRequest(options = {}) {
  const requestGeneration = options.requestGeneration;
  const getCurrentGeneration = options.getCurrentGeneration;
  const request = options.request;
  if (!Number.isSafeInteger(requestGeneration)
    || typeof getCurrentGeneration !== 'function'
    || typeof request !== 'function') {
    throw new Error('碳排放报告请求世代执行参数无效。');
  }
  const isCurrentRequest = () => (
    isLatestRequestGeneration(requestGeneration, getCurrentGeneration())
    && (typeof options.isActive !== 'function' || options.isActive() === true)
    && (typeof options.canCommit !== 'function' || options.canCommit() === true)
  );
  try {
    const value = await request();
    if (!isCurrentRequest()) return { status: 'ignored', value };
    if (typeof options.onSuccess === 'function') options.onSuccess(value);
    return { status: 'succeeded', value };
  } catch (error) {
    if (!isCurrentRequest()) return { status: 'ignored', error };
    if (typeof options.onError === 'function') options.onError(error);
    return { status: 'failed', error };
  } finally {
    if (isLatestRequestGeneration(requestGeneration, getCurrentGeneration())
      && typeof options.onFinally === 'function') {
      options.onFinally();
    }
  }
}

/** 构造 execute 非取消失败后的 fail-closed 页面状态，禁止继续执行旧预演。 */
export function buildCarbonEmissionReportExecuteFailureState(message) {
  return {
    previewResult: null,
    committedPreviewGeneration: 0,
    canExecute: false,
    importError: String(message || '碳排放报告导入执行失败，报告事实未写入或已回滚。')
  };
}

/** 判断 execute 错误是否要求清空旧预演并重新预演。 */
export function isCarbonEmissionReportPreviewStaleError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.apiError?.code || error?.response?.data?.error?.code || '');
  const details = error?.apiError?.details || error?.response?.data?.error?.details;
  return status === 409
    && code === 'CARBON_EMISSION_REPORT_PREVIEW_STALE'
    && details?.requiresNewPreview === true;
}

/** 仅接受文件名以 .xlsx 结尾的文件，不允许 xls、csv 或伪装扩展名。 */
export function isCarbonEmissionReportXlsxFile(file) {
  return Boolean(file && typeof file.name === 'string' && /\.xlsx$/i.test(file.name.trim()));
}

/** 创建重复点击同一报告或批次也会变化的查看意图。 */
export function createCarbonEmissionReportViewIntent(targetType, targetId, currentIntent = 0) {
  return {
    targetType: targetType === 'batch' ? 'batch' : 'report',
    targetId: normalizePositiveSafeInteger(targetId, '查看目标 ID'),
    intent: nextRequestGeneration(currentIntent)
  };
}

/** 读取导出响应头中的安全行数；缺失或非法时返回 null。 */
export function getCarbonEmissionReportExportedRowCount(downloadResult = {}) {
  const rawValue = downloadResult.headers?.['x-exported-row-count']
    ?? downloadResult.headers?.get?.('x-exported-row-count');
  const numberValue = Number(rawValue);
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

/** 返回排放范围中文名称。 */
export function carbonEmissionReportScopeLabel(scope) {
  return CARBON_EMISSION_REPORT_SCOPE_LABELS[String(scope || '')] || String(scope || '未标注');
}

/** 返回边界类型中文名称。 */
export function carbonEmissionReportBoundaryLabel(boundaryType) {
  return CARBON_EMISSION_REPORT_BOUNDARY_LABELS[String(boundaryType || '')] || String(boundaryType || '未标注');
}

/** 返回汇总维度中文名称。 */
export function carbonEmissionReportSummaryLabel(summaryDimension) {
  return CARBON_EMISSION_REPORT_SUMMARY_LABELS[String(summaryDimension || '')] || String(summaryDimension || '未标注');
}

/** 格式化有限报告数值，真实零必须显示为 0。 */
export function formatCarbonEmissionReportNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
    : '—';
}
