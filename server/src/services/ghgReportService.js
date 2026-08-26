'use strict';

const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const {
  buildGhgReportCodeKey,
  normalizeGhgReportDate,
  normalizeGhgReportRecordType,
  normalizeGhgReportScope,
  normalizeGhgReportText
} = require('./ghgReportContracts');

// 温室气体报告查询参数属于后端冻结合同，拒绝未知参数避免形成未审计筛选语义。
const GHG_REPORT_QUERY_FIELDS = Object.freeze(new Set([
  'page', 'pageSize', 'keyword', 'reportCode', 'organization', 'periodStart', 'periodEnd',
  'recordType', 'scope', 'category', 'greenhouseGas', 'sourceBatchId'
]));
const GHG_REPORT_MAX_PAGE_SIZE = 200;
const LIKE_ESCAPE_CHARACTER = '!';

/** 将任意 ID 规范化为正安全整数。 */
function normalizeGhgReportId(value, fieldName = 'reportId') {
  const text = String(value ?? '').trim();
  const numberValue = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'GHG_REPORT_ID_INVALID', fieldName });
  }
  return numberValue;
}

/** 严格校验列表查询字段。 */
function assertGhgReportQueryFields(query = {}) {
  const unknownFields = Object.keys(query).filter((fieldName) => !GHG_REPORT_QUERY_FIELDS.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('温室气体报告查询包含不受支持的字段。', {
      code: 'GHG_REPORT_QUERY_FIELDS_INVALID', unknownFields
    });
  }
}

/** 将分页参数冻结在本地列表上限和 JavaScript 安全整数内。 */
function normalizeGhgReportPagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1) throw badRequest('page 必须是正整数。', { code: 'GHG_REPORT_PAGE_INVALID' });
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GHG_REPORT_MAX_PAGE_SIZE) {
    throw badRequest(`pageSize 必须是 1 到 ${GHG_REPORT_MAX_PAGE_SIZE} 的整数。`, { code: 'GHG_REPORT_PAGE_SIZE_INVALID' });
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw badRequest('page 与 pageSize 计算得到的分页偏移量超过安全整数范围。', { code: 'GHG_REPORT_PAGE_OFFSET_INVALID' });
  }
  return { page, pageSize, offset };
}

/** 转义 SQLite LIKE 元字符。 */
function escapeLikePattern(value) {
  return String(value)
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);
}

/** 规范化可选查询日期。 */
function normalizeOptionalReportDate(value, fieldName) {
  const text = normalizeGhgReportText(value);
  if (!text) return null;
  const normalized = normalizeGhgReportDate(text);
  if (!normalized) throw badRequest(`${fieldName} 必须是有效的 YYYY-MM-DD 日历日期。`, { code: 'GHG_REPORT_FILTER_DATE_INVALID', fieldName });
  return normalized;
}

/** 构造报告列表的固定筛选 SQL。 */
function buildGhgReportWhere(query = {}) {
  assertGhgReportQueryFields(query);
  const clauses = [];
  const params = {};
  const keyword = normalizeGhgReportText(query.keyword);
  if (keyword) {
    params.keyword = `%${escapeLikePattern(keyword)}%`;
    params.keywordCodeKey = `%${escapeLikePattern(buildGhgReportCodeKey(keyword))}%`;
    clauses.push(`(report.report_code_key LIKE @keywordCodeKey ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_organization LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.note LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}')`);
  }
  const reportCode = normalizeGhgReportText(query.reportCode);
  if (reportCode) {
    params.reportCodeKey = buildGhgReportCodeKey(reportCode);
    clauses.push('report.report_code_key = @reportCodeKey');
  }
  const organization = normalizeGhgReportText(query.organization);
  if (organization) {
    params.organization = `%${escapeLikePattern(organization)}%`;
    clauses.push(`report.report_organization LIKE @organization ESCAPE '${LIKE_ESCAPE_CHARACTER}'`);
  }
  const periodStart = normalizeOptionalReportDate(query.periodStart, 'periodStart');
  const periodEnd = normalizeOptionalReportDate(query.periodEnd, 'periodEnd');
  if (periodStart && periodEnd && periodStart > periodEnd) throw badRequest('报告期间筛选必须满足 periodStart 不晚于 periodEnd。', { code: 'GHG_REPORT_FILTER_PERIOD_INVALID' });
  if (periodStart) { params.periodStart = periodStart; clauses.push('report.period_end >= @periodStart'); }
  if (periodEnd) { params.periodEnd = periodEnd; clauses.push('report.period_start <= @periodEnd'); }
  const rawRecordType = normalizeGhgReportText(query.recordType);
  if (rawRecordType) {
    const recordType = normalizeGhgReportRecordType(rawRecordType);
    if (!recordType) throw badRequest('recordType 筛选无效。', { code: 'GHG_REPORT_FILTER_RECORD_TYPE_INVALID' });
    params.recordType = recordType;
    clauses.push('EXISTS (SELECT 1 FROM ghg_report_items item_type WHERE item_type.report_id = report.id AND item_type.record_type = @recordType)');
  }
  const rawScope = normalizeGhgReportText(query.scope);
  if (rawScope) {
    const scope = normalizeGhgReportScope(rawScope);
    if (!scope) throw badRequest('scope 筛选无效。', { code: 'GHG_REPORT_FILTER_SCOPE_INVALID' });
    params.scope = scope;
    clauses.push('EXISTS (SELECT 1 FROM ghg_report_items item_scope WHERE item_scope.report_id = report.id AND item_scope.emission_scope = @scope)');
  }
  const category = normalizeGhgReportText(query.category);
  if (category) {
    params.category = category;
    clauses.push('EXISTS (SELECT 1 FROM ghg_report_items item_category WHERE item_category.report_id = report.id AND item_category.category = @category)');
  }
  const greenhouseGas = normalizeGhgReportText(query.greenhouseGas);
  if (greenhouseGas) {
    params.greenhouseGas = greenhouseGas;
    clauses.push('EXISTS (SELECT 1 FROM ghg_report_items item_gas WHERE item_gas.report_id = report.id AND item_gas.greenhouse_gas = @greenhouseGas)');
  }
  if (query.sourceBatchId !== undefined && normalizeGhgReportText(query.sourceBatchId)) {
    params.sourceBatchId = normalizeGhgReportId(query.sourceBatchId, 'sourceBatchId');
    clauses.push('report.source_batch_id = @sourceBatchId');
  }
  return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// 列表和详情共享主表投影，报告事实与来源批次信息始终成对返回。
const GHG_REPORT_SELECT_SQL = `SELECT report.id,
  report.report_code AS reportCode,
  report.report_name AS reportName,
  report.report_organization AS reportOrganization,
  report.period_start AS periodStart,
  report.period_end AS periodEnd,
  report.template_id AS templateId,
  report.template_version AS templateVersion,
  report.note,
  report.source_batch_id AS sourceBatchId,
  report.source_row_number AS sourceRowNumber,
  report.created_by AS createdBy,
  creator.display_name AS createdByName,
  report.created_at AS createdAt,
  batch.original_filename AS sourceOriginalFilename,
  batch.status AS sourceBatchStatus,
  (SELECT COUNT(*) FROM ghg_report_organization_boundaries row_count WHERE row_count.report_id = report.id) AS organizationBoundaryCount,
  (SELECT COUNT(*) FROM ghg_report_operational_boundaries row_count WHERE row_count.report_id = report.id) AS operationalBoundaryCount,
  (SELECT COUNT(*) FROM ghg_report_items row_count WHERE row_count.report_id = report.id) AS itemCount,
  (SELECT COUNT(*) FROM ghg_report_summaries row_count WHERE row_count.report_id = report.id) AS summaryCount,
  (SELECT COUNT(*) FROM ghg_report_evidence row_count WHERE row_count.report_id = report.id) AS evidenceCount
FROM ghg_reports report
JOIN import_batches batch ON batch.id = report.source_batch_id
LEFT JOIN sys_users creator ON creator.id = report.created_by`;

/** 将主表 SQLite 行显式投影为稳定公共报告对象。 */
function mapGhgReportRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reportCode: row.reportCode,
    reportName: row.reportName,
    reportOrganization: row.reportOrganization,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    note: row.note,
    sourceBatchId: Number(row.sourceBatchId),
    sourceRowNumber: Number(row.sourceRowNumber),
    createdBy: row.createdBy === null || row.createdBy === undefined ? null : Number(row.createdBy),
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    sourceOriginalFilename: row.sourceOriginalFilename,
    sourceBatchStatus: row.sourceBatchStatus,
    organizationBoundaryCount: Number(row.organizationBoundaryCount || 0),
    operationalBoundaryCount: Number(row.operationalBoundaryCount || 0),
    itemCount: Number(row.itemCount || 0),
    summaryCount: Number(row.summaryCount || 0),
    evidenceCount: Number(row.evidenceCount || 0)
  };
}

/** 分页查询温室气体报告。 */
function listGhgReports(query = {}) {
  const pagination = normalizeGhgReportPagination(query);
  const { whereSql, params } = buildGhgReportWhere(query);
  const db = openDatabase();
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM ghg_reports report ${whereSql}`).get(params).total || 0);
    const rows = db.prepare(`${GHG_REPORT_SELECT_SQL} ${whereSql}
      ORDER BY report.created_at DESC, report.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
      .map(mapGhgReportRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total, totalPages: Math.ceil(total / pagination.pageSize) } };
  } finally {
    db.close();
  }
}

/** 使用既有连接读取报告及来源批次主信息。 */
function getGhgReportHeader(db, clause, value, notFoundDetail) {
  const row = db.prepare(`${GHG_REPORT_SELECT_SQL} WHERE ${clause}`).get(value);
  if (!row) throw notFound('温室气体报告不存在。', notFoundDetail);
  return mapGhgReportRow(row);
}

/** 使用既有连接读取报告固定六部分结构。 */
function hydrateGhgReportDetail(db, report) {
  const reportId = report.id;
  const organizationBoundaries = db.prepare(`SELECT id, boundary_code AS boundaryCode,
    organization_unit AS organizationUnit, inclusion_method AS inclusionMethod,
    boundary_description AS boundaryDescription, source_row_number AS sourceRowNumber
    FROM ghg_report_organization_boundaries WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({ id: Number(row.id), boundaryCode: row.boundaryCode, organizationUnit: row.organizationUnit, inclusionMethod: row.inclusionMethod, boundaryDescription: row.boundaryDescription, sourceRowNumber: Number(row.sourceRowNumber) }));
  const operationalBoundaries = db.prepare(`SELECT id, emission_scope AS emissionScope, category,
    boundary_description AS boundaryDescription, source_row_number AS sourceRowNumber
    FROM ghg_report_operational_boundaries WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({ id: Number(row.id), emissionScope: row.emissionScope, category: row.category, boundaryDescription: row.boundaryDescription, sourceRowNumber: Number(row.sourceRowNumber) }));
  const evidence = db.prepare(`SELECT id, evidence_code AS evidenceCode, evidence_name AS evidenceName,
    evidence_type AS evidenceType, evidence_description AS evidenceDescription, note,
    source_row_number AS sourceRowNumber FROM ghg_report_evidence WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({ id: Number(row.id), evidenceCode: row.evidenceCode, evidenceName: row.evidenceName, evidenceType: row.evidenceType, evidenceDescription: row.evidenceDescription, note: row.note, sourceRowNumber: Number(row.sourceRowNumber) }));
  const items = db.prepare(`SELECT item.id, item.item_code AS itemCode, item.record_type AS recordType,
    item.emission_scope AS emissionScope, item.category, item.greenhouse_gas AS greenhouseGas,
    item.source_or_sink AS sourceOrSink, item.activity_value AS activityValue, item.activity_unit AS activityUnit,
    item.gas_amount AS gasAmount, item.gwp, item.co2e_value AS co2eValue, item.co2e_unit AS co2eUnit,
    item.accounting_method AS accountingMethod, evidence.evidence_code AS evidenceCode,
    item.note, item.source_row_number AS sourceRowNumber
    FROM ghg_report_items item
    JOIN ghg_report_evidence evidence ON evidence.report_id = item.report_id AND evidence.id = item.evidence_id
    WHERE item.report_id = ? ORDER BY item.id`).all(reportId)
    .map((row) => ({ id: Number(row.id), itemCode: row.itemCode, recordType: row.recordType, emissionScope: row.emissionScope, category: row.category, greenhouseGas: row.greenhouseGas, sourceOrSink: row.sourceOrSink, activityValue: Number(row.activityValue), activityUnit: row.activityUnit, gasAmount: Number(row.gasAmount), gwp: Number(row.gwp), co2eValue: Number(row.co2eValue), co2eUnit: row.co2eUnit, accountingMethod: row.accountingMethod, evidenceCode: row.evidenceCode, note: row.note, sourceRowNumber: Number(row.sourceRowNumber) }));
  const summaries = db.prepare(`SELECT id, summary_code AS summaryCode, summary_dimension AS summaryDimension,
    summary_value AS summaryValue, emission_co2e AS emissionCo2e, removal_co2e AS removalCo2e,
    net_co2e AS netCo2e, co2e_unit AS co2eUnit, note, source_row_number AS sourceRowNumber
    FROM ghg_report_summaries WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({ id: Number(row.id), summaryCode: row.summaryCode, summaryDimension: row.summaryDimension, summaryValue: row.summaryValue, emissionCo2e: Number(row.emissionCo2e), removalCo2e: Number(row.removalCo2e), netCo2e: Number(row.netCo2e), co2eUnit: row.co2eUnit, note: row.note, sourceRowNumber: Number(row.sourceRowNumber) }));
  return { report, organizationBoundaries, operationalBoundaries, items, summaries, evidence };
}

/** 按报告 ID 返回固定六部分结构化详情。 */
function getGhgReport(reportIdValue) {
  const reportId = normalizeGhgReportId(reportIdValue);
  const db = openDatabase();
  try {
    return hydrateGhgReportDetail(db, getGhgReportHeader(db, 'report.id = ?', reportId, { id: reportId }));
  } finally { db.close(); }
}

/** 按来源导入批次返回固定六部分结构化追溯结果。 */
function getGhgReportByBatch(sourceBatchIdValue) {
  const sourceBatchId = normalizeGhgReportId(sourceBatchIdValue, 'sourceBatchId');
  const db = openDatabase();
  try {
    return hydrateGhgReportDetail(db, getGhgReportHeader(db, 'report.source_batch_id = ?', sourceBatchId, { sourceBatchId }));
  } finally { db.close(); }
}

/** 仅防护危险字符串首字符，number 保持数值单元格。 */
function escapeGhgReportSpreadsheetFormula(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** 将二维数据安全写入一个合法命名的工作表。 */
function appendGhgReportWorksheet(workbook, sheetName, headers, rows) {
  const safeRows = rows.map((row) => row.map(escapeGhgReportSpreadsheetFormula));
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...safeRows]);
  worksheet['!cols'] = headers.map((_header, index) => ({
    wch: Math.min(48, Math.max(12, ...safeRows.map((row) => String(row[index] ?? '').length + 2)))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/** 将单份报告导出为与领域结构一致的六工作表 XLSX。 */
function exportGhgReport(reportIdValue) {
  const detail = getGhgReport(reportIdValue);
  const { report, organizationBoundaries, operationalBoundaries, items, summaries, evidence } = detail;
  const workbook = XLSX.utils.book_new();
  appendGhgReportWorksheet(workbook, '报告信息',
    ['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注', '来源批次ID', '来源行号', '创建者', '创建时间'], [[
      report.reportCode, report.reportName, report.reportOrganization, report.periodStart, report.periodEnd,
      report.templateId, report.templateVersion, report.note, report.sourceBatchId, report.sourceRowNumber,
      report.createdByName, report.createdAt
    ]]);
  appendGhgReportWorksheet(workbook, '组织边界',
    ['边界编码', '组织单元', '纳入方式', '边界说明', '来源行号'], organizationBoundaries.map((row) => [
      row.boundaryCode, row.organizationUnit, row.inclusionMethod, row.boundaryDescription, row.sourceRowNumber
    ]));
  appendGhgReportWorksheet(workbook, '运行边界',
    ['排放范围', '类别', '边界说明', '来源行号'], operationalBoundaries.map((row) => [
      row.emissionScope, row.category, row.boundaryDescription, row.sourceRowNumber
    ]));
  appendGhgReportWorksheet(workbook, '报告项目',
    ['项目编码', '记录类型', '排放范围', '类别', '温室气体种类', '排放源或汇', '活动数据', '活动数据单位', '排放量或清除量', 'GWP', 'CO2e', 'CO2e单位', '核算方法', '证据编号', '备注', '来源行号'], items.map((row) => [
      row.itemCode, row.recordType, row.emissionScope, row.category, row.greenhouseGas, row.sourceOrSink,
      row.activityValue, row.activityUnit, row.gasAmount, row.gwp, row.co2eValue, row.co2eUnit,
      row.accountingMethod, row.evidenceCode, row.note, row.sourceRowNumber
    ]));
  appendGhgReportWorksheet(workbook, '汇总',
    ['汇总编码', '汇总维度', '汇总值', '排放CO2e', '清除CO2e', '净CO2e', 'CO2e单位', '备注', '来源行号'], summaries.map((row) => [
      row.summaryCode, row.summaryDimension, row.summaryValue, row.emissionCo2e, row.removalCo2e,
      row.netCo2e, row.co2eUnit, row.note, row.sourceRowNumber
    ]));
  appendGhgReportWorksheet(workbook, '证据说明',
    ['证据编号', '证据名称', '证据类型', '证据说明', '备注', '来源行号'], evidence.map((row) => [
      row.evidenceCode, row.evidenceName, row.evidenceType, row.evidenceDescription, row.note, row.sourceRowNumber
    ]));
  return {
    body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `${escapeGhgReportSpreadsheetFormula(report.reportCode)}-温室气体报告.xlsx`,
    asciiFileName: `ghg-report-${report.id}.xlsx`,
    rowCount: 1 + organizationBoundaries.length + operationalBoundaries.length + items.length + summaries.length + evidence.length
  };
}

module.exports = {
  GHG_REPORT_QUERY_FIELDS,
  buildGhgReportWhere,
  escapeGhgReportSpreadsheetFormula,
  exportGhgReport,
  getGhgReport,
  getGhgReportByBatch,
  listGhgReports,
  normalizeGhgReportId,
  normalizeGhgReportPagination
};
