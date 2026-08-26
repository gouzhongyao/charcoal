import { daysInGregorianMonth } from './dateTimeFields.js';
import { isLatestRequestGeneration, nextRequestGeneration } from './requestGeneration.js';

// 温室气体报告前端纯逻辑模块：冻结 N7 身份、精确权限、筛选分页、六部分公共 DTO、受控导入和请求世代合同。

// 固定模板身份：不得与 N6 carbon-emission-report 模板互相替代。
export const GHG_REPORT_TEMPLATE_ID = 'ghg-report';
// 固定模板版本：模板升级前页面不得猜测其他版本。
export const GHG_REPORT_TEMPLATE_VERSION = '1.0';
// 固定导入类型：通用批次中心只可按 N7 权限投影此类型。
export const GHG_REPORT_IMPORT_TYPE = 'ghg_report';
// 固定执行确认文本：execute 最小载荷只能使用此文本。
export const GHG_REPORT_IMPORT_CONFIRM_TEXT = '确认导入温室气体报告';
// 固定六部分顺序：与固定工作表和单份导出顺序一致。
export const GHG_REPORT_SECTION_NAMES = Object.freeze([
  '报告信息',
  '组织边界',
  '运行边界',
  '报告项目',
  '汇总',
  '证据说明'
]);
// 报告项目记录类型：清除必须显式使用 removal，禁止通过负 emission 表达。
export const GHG_REPORT_RECORD_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'emission', label: '排放' }),
  Object.freeze({ value: 'removal', label: '清除' })
]);
// 排放范围筛选选项：与服务端筛选白名单保持一致。
export const GHG_REPORT_SCOPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'scope_1', label: '范围一' }),
  Object.freeze({ value: 'scope_2', label: '范围二' }),
  Object.freeze({ value: 'scope_3', label: '范围三' })
]);
// 公共数值绝对上限：与服务端固定 XLSX v1 资源和业务合同一致。
const GHG_REPORT_ABSOLUTE_NUMBER_LIMIT = 1e15;
// 预演汇总固定计数字段：缺失、字符串化、负数或超安全整数时不得执行。
const GHG_REPORT_IMPORT_SUMMARY_FIELDS = Object.freeze([
  'totalRows', 'wouldImport', 'skipped', 'blocked', 'warnings', 'errors'
]);
// 预演项目固定状态：汇总必须与每项状态逐项一致。
const GHG_REPORT_IMPORT_ITEM_STATUSES = Object.freeze([
  'wouldImport', 'skipped', 'blocked'
]);
// 排放范围中文映射：未知公共值保留原文以提示合同漂移。
const GHG_REPORT_SCOPE_LABELS = Object.freeze(Object.fromEntries(
  GHG_REPORT_SCOPE_OPTIONS.map((option) => [option.value, option.label])
));
// 记录类型中文映射：页面显式区分排放和清除。
const GHG_REPORT_RECORD_TYPE_LABELS = Object.freeze(Object.fromEntries(
  GHG_REPORT_RECORD_TYPE_OPTIONS.map((option) => [option.value, option.label])
));
// 汇总维度中文映射：未知服务端值保留原文。
const GHG_REPORT_SUMMARY_LABELS = Object.freeze({
  total: '总计',
  scope: '排放范围',
  category: '类别',
  gas: '温室气体',
  record_type: '记录类型'
});
// 公共前端状态禁止保留的内部安全链字段：投影函数全部采用白名单重建对象。
export const GHG_REPORT_INTERNAL_FIELDS = Object.freeze([
  'storedFilename',
  'fileSha256',
  'sourceFileSha256',
  'candidateRowId',
  'candidateRows',
  'candidateRowIds',
  'previewSignature',
  'previewAuditDigest',
  'previewAudit',
  'auditContext',
  'executeResult',
  'auditBatch',
  'witness'
]);

/** 判断输入是否为普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 将可选文本规范为去除首尾空白的字符串。 */
function normalizeOptionalText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 校验查询输入并返回正安全整数，允许输入组件提供数字字符串。 */
function normalizePositiveSafeInteger(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new Error(`${fieldName} 必须是正安全整数。`);
  }
  return numberValue;
}

/** 严格投影服务端公共 DTO 正安全整数，不接受字符串数字。 */
function projectPositiveSafeInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} 必须是正安全整数 number。`);
  }
  return value;
}

/** 严格投影服务端公共 DTO 非负安全整数，不接受字符串数字。 */
function projectNonNegativeSafeInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} 必须是非负安全整数 number。`);
  }
  return value;
}

/** 投影公共 DTO 有限数值，并校验绝对上限。 */
function projectFiniteNumber(value, fieldName) {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || Math.abs(value) > GHG_REPORT_ABSOLUTE_NUMBER_LIMIT) {
    throw new Error(`${fieldName} 必须是绝对值不超过 ${GHG_REPORT_ABSOLUTE_NUMBER_LIMIT} 的有限 number。`);
  }
  return value;
}

/** 投影公共 DTO 非负有限数值；排放量和清除量均不得用负数表达。 */
function projectNonNegativeNumber(value, fieldName) {
  const numberValue = projectFiniteNumber(value, fieldName);
  if (numberValue < 0) throw new Error(`${fieldName} 必须是非负数。`);
  return numberValue;
}

/** 投影公共 DTO 严格正有限数值，GWP 不允许为零或负数。 */
function projectPositiveNumber(value, fieldName) {
  const numberValue = projectFiniteNumber(value, fieldName);
  if (numberValue <= 0) throw new Error(`${fieldName} 必须大于 0。`);
  return numberValue;
}

/** 严格校验 YYYY-MM-DD 自然日，不通过 Date 对象推断时区。 */
export function normalizeGhgReportDate(value) {
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

/** 投影 N7 四项精确权限；N6 权限和旧 carbon:view 均不得兜底。 */
export function projectGhgReportPermissions(checkPermission = () => false) {
  const hasPermission = typeof checkPermission === 'function' ? checkPermission : () => false;
  return {
    canView: hasPermission('carbon:ghg-reports:view') === true,
    canImportPreview: hasPermission('carbon:ghg-reports:import:preview') === true,
    canImportExecute: hasPermission('carbon:ghg-reports:import:execute') === true,
    canExport: hasPermission('carbon:ghg-reports:export') === true
  };
}

/** 构造温室气体报告列表安全筛选和分页参数。 */
export function buildGhgReportFilters(filters = {}, pagination = {}) {
  const page = pagination.page === undefined ? 1 : normalizePositiveSafeInteger(pagination.page, 'page');
  const pageSize = pagination.pageSize === undefined ? 20 : normalizePositiveSafeInteger(pagination.pageSize, 'pageSize');
  if (pageSize > 200) throw new Error('pageSize 不能超过 200。');
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new Error('分页偏移量超过安全整数范围。');

  const periodStart = normalizeGhgReportDate(filters.periodStart);
  const periodEnd = normalizeGhgReportDate(filters.periodEnd);
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new Error('报告期间筛选必须满足开始日期不晚于结束日期。');
  }
  const scope = normalizeOptionalText(filters.scope);
  if (scope && !GHG_REPORT_SCOPE_OPTIONS.some((option) => option.value === scope)) {
    throw new Error('排放范围筛选不符合固定合同。');
  }
  const recordType = normalizeOptionalText(filters.recordType);
  if (recordType && !GHG_REPORT_RECORD_TYPE_OPTIONS.some((option) => option.value === recordType)) {
    throw new Error('记录类型筛选不符合固定合同。');
  }
  const sourceBatchId = filters.sourceBatchId === '' || filters.sourceBatchId === null || filters.sourceBatchId === undefined
    ? undefined
    : normalizePositiveSafeInteger(filters.sourceBatchId, '来源批次 ID');
  const candidates = {
    keyword: normalizeOptionalText(filters.keyword),
    reportCode: normalizeOptionalText(filters.reportCode),
    organization: normalizeOptionalText(filters.organization),
    periodStart,
    periodEnd,
    recordType,
    scope,
    category: normalizeOptionalText(filters.category),
    greenhouseGas: normalizeOptionalText(filters.greenhouseGas),
    sourceBatchId,
    page,
    pageSize
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => (
    value !== '' && value !== null && value !== undefined
  )));
}

/** 白名单投影温室气体报告列表行。 */
export function projectGhgReportListRow(row) {
  if (!isPlainObject(row)) throw new Error('温室气体报告列表行不符合响应合同。');
  return {
    id: projectPositiveSafeInteger(row.id, '报告 ID'),
    reportCode: String(row.reportCode || ''),
    reportName: String(row.reportName || ''),
    reportOrganization: String(row.reportOrganization || ''),
    periodStart: String(row.periodStart || ''),
    periodEnd: String(row.periodEnd || ''),
    templateId: String(row.templateId || ''),
    templateVersion: String(row.templateVersion || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceBatchId: projectPositiveSafeInteger(row.sourceBatchId, '来源批次 ID'),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '来源行号'),
    createdBy: row.createdBy === null || row.createdBy === undefined
      ? null
      : projectPositiveSafeInteger(row.createdBy, '创建人 ID'),
    createdByName: row.createdByName === null || row.createdByName === undefined ? null : String(row.createdByName),
    createdAt: String(row.createdAt || ''),
    sourceOriginalFilename: String(row.sourceOriginalFilename || ''),
    sourceBatchStatus: String(row.sourceBatchStatus || ''),
    organizationBoundaryCount: projectNonNegativeSafeInteger(row.organizationBoundaryCount, '组织边界数'),
    operationalBoundaryCount: projectNonNegativeSafeInteger(row.operationalBoundaryCount, '运行边界数'),
    itemCount: projectNonNegativeSafeInteger(row.itemCount, '报告项目数'),
    summaryCount: projectNonNegativeSafeInteger(row.summaryCount, '汇总数'),
    evidenceCount: projectNonNegativeSafeInteger(row.evidenceCount, '证据数')
  };
}

/** 严格投影服务端安全分页。 */
export function projectGhgReportPagination(pagination = {}) {
  if (!isPlainObject(pagination)) throw new Error('温室气体报告分页不符合响应合同。');
  return {
    page: projectPositiveSafeInteger(pagination.page, '分页 page'),
    pageSize: projectPositiveSafeInteger(pagination.pageSize, '分页 pageSize'),
    total: projectNonNegativeSafeInteger(pagination.total, '分页 total'),
    totalPages: projectNonNegativeSafeInteger(pagination.totalPages, '分页 totalPages')
  };
}

/** 白名单投影组织边界行。 */
function projectGhgReportOrganizationBoundary(row) {
  if (!isPlainObject(row)) throw new Error('组织边界不符合响应合同。');
  return {
    id: projectPositiveSafeInteger(row.id, '组织边界 ID'),
    boundaryCode: String(row.boundaryCode || ''),
    organizationUnit: String(row.organizationUnit || ''),
    inclusionMethod: String(row.inclusionMethod || ''),
    boundaryDescription: String(row.boundaryDescription || ''),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '组织边界来源行号')
  };
}

/** 白名单投影运行边界行。 */
function projectGhgReportOperationalBoundary(row) {
  if (!isPlainObject(row)) throw new Error('运行边界不符合响应合同。');
  return {
    id: projectPositiveSafeInteger(row.id, '运行边界 ID'),
    emissionScope: String(row.emissionScope || ''),
    category: String(row.category || ''),
    boundaryDescription: String(row.boundaryDescription || ''),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '运行边界来源行号')
  };
}

/** 白名单投影报告项目，并冻结排放、清除和数值符号合同。 */
function projectGhgReportItem(row) {
  if (!isPlainObject(row)) throw new Error('温室气体报告项目不符合响应合同。');
  const recordType = String(row.recordType || '');
  if (!GHG_REPORT_RECORD_TYPE_OPTIONS.some((option) => option.value === recordType)) {
    throw new Error('报告项目记录类型必须是 emission 或 removal。');
  }
  return {
    id: projectPositiveSafeInteger(row.id, '报告项目 ID'),
    itemCode: String(row.itemCode || ''),
    recordType,
    emissionScope: String(row.emissionScope || ''),
    category: String(row.category || ''),
    greenhouseGas: String(row.greenhouseGas || ''),
    sourceOrSink: String(row.sourceOrSink || ''),
    activityValue: projectNonNegativeNumber(row.activityValue, '活动数据'),
    activityUnit: String(row.activityUnit || ''),
    gasAmount: projectNonNegativeNumber(row.gasAmount, '气体数量'),
    gwp: projectPositiveNumber(row.gwp, 'GWP'),
    co2eValue: projectNonNegativeNumber(row.co2eValue, '项目 CO2e'),
    co2eUnit: String(row.co2eUnit || ''),
    accountingMethod: String(row.accountingMethod || ''),
    evidenceCode: String(row.evidenceCode || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '项目来源行号')
  };
}

/** 白名单投影汇总；排放和清除非负，净 CO2e 允许为负。 */
function projectGhgReportSummary(row) {
  if (!isPlainObject(row)) throw new Error('温室气体报告汇总不符合响应合同。');
  return {
    id: projectPositiveSafeInteger(row.id, '汇总 ID'),
    summaryCode: String(row.summaryCode || ''),
    summaryDimension: String(row.summaryDimension || ''),
    summaryValue: String(row.summaryValue || ''),
    emissionCo2e: projectNonNegativeNumber(row.emissionCo2e, '汇总排放 CO2e'),
    removalCo2e: projectNonNegativeNumber(row.removalCo2e, '汇总清除 CO2e'),
    netCo2e: projectFiniteNumber(row.netCo2e, '汇总净 CO2e'),
    co2eUnit: String(row.co2eUnit || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '汇总来源行号')
  };
}

/** 白名单投影证据说明行。 */
function projectGhgReportEvidence(row) {
  if (!isPlainObject(row)) throw new Error('温室气体报告证据不符合响应合同。');
  return {
    id: projectPositiveSafeInteger(row.id, '证据 ID'),
    evidenceCode: String(row.evidenceCode || ''),
    evidenceName: String(row.evidenceName || ''),
    evidenceType: String(row.evidenceType || ''),
    evidenceDescription: String(row.evidenceDescription || ''),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    sourceRowNumber: projectPositiveSafeInteger(row.sourceRowNumber, '证据来源行号')
  };
}

/** 严格投影六部分详情，任一部分缺失时 fail-closed。 */
export function projectGhgReportDetail(detail) {
  if (!isPlainObject(detail)
    || !isPlainObject(detail.report)
    || !Array.isArray(detail.organizationBoundaries)
    || !Array.isArray(detail.operationalBoundaries)
    || !Array.isArray(detail.items)
    || !Array.isArray(detail.summaries)
    || !Array.isArray(detail.evidence)) {
    throw new Error('温室气体报告六部分详情不符合响应合同。');
  }
  return {
    report: projectGhgReportListRow(detail.report),
    organizationBoundaries: detail.organizationBoundaries.map(projectGhgReportOrganizationBoundary),
    operationalBoundaries: detail.operationalBoundaries.map(projectGhgReportOperationalBoundary),
    items: detail.items.map(projectGhgReportItem),
    summaries: detail.summaries.map(projectGhgReportSummary),
    evidence: detail.evidence.map(projectGhgReportEvidence)
  };
}

/** 规范化预演汇总；已提供字段必须是非负安全整数 number。 */
export function normalizeGhgReportImportSummary(summary = {}) {
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

/** 白名单投影预演问题。 */
function projectGhgReportPreviewIssue(issue = {}) {
  if (!isPlainObject(issue)) throw new Error('预演问题不符合公共合同。');
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

/** 白名单投影服务端预演，主动丢弃候选、签名、摘要、见证和内部审计字段。 */
export function projectGhgReportPreview(preview = {}) {
  if (!isPlainObject(preview)
    || !isPlainObject(preview.summary)
    || !GHG_REPORT_IMPORT_SUMMARY_FIELDS.every((fieldName) => Object.hasOwn(preview.summary, fieldName))
    || !Array.isArray(preview.items)
    || !Array.isArray(preview.notices)) {
    throw new Error('温室气体报告预演不符合公共响应合同。');
  }
  if (preview.templateType !== GHG_REPORT_TEMPLATE_ID
    || preview.templateVersion !== GHG_REPORT_TEMPLATE_VERSION) {
    throw new Error('温室气体报告预演模板身份不符合固定合同。');
  }
  const items = preview.items.map((item) => {
    if (!isPlainObject(item) || !isPlainObject(item.counts) || !Array.isArray(item.issues)) {
      throw new Error('温室气体报告预演项目不符合公共响应合同。');
    }
    const status = String(item.status || '');
    if (!GHG_REPORT_IMPORT_ITEM_STATUSES.includes(status)) {
      throw new Error('温室气体报告预演项目状态不符合固定合同。');
    }
    return {
      rowNumber: projectNonNegativeSafeInteger(item.rowNumber, '预演报告信息行'),
      reportCode: item.reportCode === null || item.reportCode === undefined ? '' : String(item.reportCode),
      reportName: item.reportName === null || item.reportName === undefined ? '' : String(item.reportName),
      status,
      counts: {
        organizationBoundaries: projectNonNegativeSafeInteger(item.counts.organizationBoundaries, '预演组织边界行数'),
        operationalBoundaries: projectNonNegativeSafeInteger(item.counts.operationalBoundaries, '预演运行边界行数'),
        items: projectNonNegativeSafeInteger(item.counts.items, '预演项目行数'),
        summaries: projectNonNegativeSafeInteger(item.counts.summaries, '预演汇总行数'),
        evidence: projectNonNegativeSafeInteger(item.counts.evidence, '预演证据行数')
      },
      issues: item.issues.map(projectGhgReportPreviewIssue)
    };
  });
  return {
    batchId: projectPositiveSafeInteger(preview.batchId, '预演批次 ID'),
    templateType: GHG_REPORT_TEMPLATE_ID,
    templateVersion: GHG_REPORT_TEMPLATE_VERSION,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    summary: normalizeGhgReportImportSummary(preview.summary),
    notices: preview.notices.map((notice) => String(notice)),
    items
  };
}

/** 判断预演是否满足唯一 wouldImport 项和全部计数一致性。 */
export function canExecuteGhgReportImport(preview) {
  try {
    if (!isPlainObject(preview)
      || typeof preview.batchId !== 'number'
      || !Number.isSafeInteger(preview.batchId)
      || preview.batchId < 1
      || !isPlainObject(preview.summary)
      || !GHG_REPORT_IMPORT_SUMMARY_FIELDS.every((fieldName) => Object.hasOwn(preview.summary, fieldName))
      || !Array.isArray(preview.items)
      || preview.items.length !== 1) return false;
    const summary = normalizeGhgReportImportSummary(preview.summary);
    const statusCounts = { wouldImport: 0, skipped: 0, blocked: 0 };
    let warnings = 0;
    let errors = 0;
    for (const item of preview.items) {
      if (!isPlainObject(item)
        || !GHG_REPORT_IMPORT_ITEM_STATUSES.includes(item.status)
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
      && summary.skipped === 0
      && summary.blocked === 0
      && summary.errors === 0;
  } catch (_error) {
    return false;
  }
}

/** 构造 execute 四字段最小载荷。 */
export function buildGhgReportImportExecutePayload(preview = {}) {
  return {
    batchId: preview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 执行当前请求世代；旧成功、旧错误和旧 finally 均不得提交到新意图。 */
export async function runLatestGhgReportRequest(options = {}) {
  const requestGeneration = options.requestGeneration;
  const getCurrentGeneration = options.getCurrentGeneration;
  const request = options.request;
  if (!Number.isSafeInteger(requestGeneration)
    || typeof getCurrentGeneration !== 'function'
    || typeof request !== 'function') {
    throw new Error('温室气体报告请求世代执行参数无效。');
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

/** 构造当前 execute 非取消失败后的 fail-closed 状态。 */
export function buildGhgReportExecuteFailureState(message) {
  return {
    previewResult: null,
    committedPreviewGeneration: 0,
    canExecute: false,
    importError: String(message || '温室气体报告导入执行失败，报告事实未写入或已回滚。')
  };
}

/** 精确判断服务端 stale 409；其他 409 不得冒充要求重新预演。 */
export function isGhgReportPreviewStaleError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.apiError?.code || error?.response?.data?.error?.code || '');
  const details = error?.apiError?.details || error?.response?.data?.error?.details;
  return status === 409
    && code === 'GHG_REPORT_PREVIEW_STALE'
    && details?.requiresNewPreview === true;
}

/** 仅接受文件名以 .xlsx 结尾的文件。 */
export function isGhgReportXlsxFile(file) {
  return Boolean(file && typeof file.name === 'string' && /\.xlsx$/i.test(file.name.trim()));
}

/** 创建重复点击同一报告或批次也会递增的查看意图。 */
export function createGhgReportViewIntent(targetType, targetId, currentIntent = 0) {
  return {
    targetType: targetType === 'batch' ? 'batch' : 'report',
    targetId: normalizePositiveSafeInteger(targetId, '查看目标 ID'),
    intent: nextRequestGeneration(currentIntent)
  };
}

/** 读取导出响应头中的安全行数；缺失或非法时返回 null。 */
export function getGhgReportExportedRowCount(downloadResult = {}) {
  const rawValue = downloadResult.headers?.['x-exported-row-count']
    ?? downloadResult.headers?.get?.('x-exported-row-count');
  const numberValue = Number(rawValue);
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

/** 返回排放范围中文名称。 */
export function ghgReportScopeLabel(scope) {
  return GHG_REPORT_SCOPE_LABELS[String(scope || '')] || String(scope || '未标注');
}

/** 返回记录类型中文名称。 */
export function ghgReportRecordTypeLabel(recordType) {
  return GHG_REPORT_RECORD_TYPE_LABELS[String(recordType || '')] || String(recordType || '未标注');
}

/** 返回汇总维度中文名称。 */
export function ghgReportSummaryLabel(summaryDimension) {
  return GHG_REPORT_SUMMARY_LABELS[String(summaryDimension || '')] || String(summaryDimension || '未标注');
}

/** 格式化有限报告数值，真实零和负净 CO2e 必须按值显示。 */
export function formatGhgReportNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
    : '—';
}
