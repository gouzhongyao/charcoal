'use strict';

const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { formatStrictUtcForUser } = require('../utils/userVisibleDateTime');
const {
  buildCarbonEmissionReportCodeKey,
  normalizeCarbonEmissionReportDate,
  normalizeCarbonEmissionReportScope,
  normalizeCarbonEmissionReportText
} = require('./carbonEmissionReportContracts');

// 报告查询参数属于后端冻结合同，拒绝未知参数避免静默形成未审计筛选语义。
const CARBON_EMISSION_REPORT_QUERY_FIELDS = Object.freeze(new Set([
  'page', 'pageSize', 'keyword', 'reportCode', 'organization', 'periodStart', 'periodEnd',
  'scope', 'category', 'sourceBatchId'
]));
const CARBON_EMISSION_REPORT_MAX_PAGE_SIZE = 200;
const LIKE_ESCAPE_CHARACTER = '!';

/** 将任意 ID 规范化为正安全整数。 */
function normalizeCarbonEmissionReportId(value, fieldName = 'reportId') {
  const text = String(value ?? '').trim();
  const numberValue = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code: 'CARBON_EMISSION_REPORT_ID_INVALID', fieldName
    });
  }
  return numberValue;
}

/** 严格校验列表查询字段。 */
function assertCarbonEmissionReportQueryFields(query = {}) {
  const unknownFields = Object.keys(query).filter((fieldName) => !CARBON_EMISSION_REPORT_QUERY_FIELDS.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('碳排放报告查询包含不受支持的字段。', {
      code: 'CARBON_EMISSION_REPORT_QUERY_FIELDS_INVALID', unknownFields
    });
  }
}

/** 将分页参数冻结在本地列表上限内。 */
function normalizeCarbonEmissionReportPagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw badRequest('page 必须是正整数。', { code: 'CARBON_EMISSION_REPORT_PAGE_INVALID' });
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CARBON_EMISSION_REPORT_MAX_PAGE_SIZE) {
    throw badRequest(`pageSize 必须是 1 到 ${CARBON_EMISSION_REPORT_MAX_PAGE_SIZE} 的整数。`, {
      code: 'CARBON_EMISSION_REPORT_PAGE_SIZE_INVALID'
    });
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw badRequest('page 与 pageSize 计算得到的分页偏移量超过安全整数范围。', {
      code: 'CARBON_EMISSION_REPORT_PAGE_OFFSET_INVALID'
    });
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
  const text = normalizeCarbonEmissionReportText(value);
  if (!text) return null;
  const normalized = normalizeCarbonEmissionReportDate(text);
  if (!normalized) {
    throw badRequest(`${fieldName} 必须是有效的 YYYY-MM-DD 日历日期。`, {
      code: 'CARBON_EMISSION_REPORT_FILTER_DATE_INVALID', fieldName
    });
  }
  return normalized;
}

/** 构造报告列表的固定筛选 SQL。 */
function buildCarbonEmissionReportWhere(query = {}) {
  assertCarbonEmissionReportQueryFields(query);
  const clauses = [];
  const params = {};
  const keyword = normalizeCarbonEmissionReportText(query.keyword);
  if (keyword) {
    params.keyword = `%${escapeLikePattern(keyword)}%`;
    params.keywordCodeKey = `%${escapeLikePattern(buildCarbonEmissionReportCodeKey(keyword))}%`;
    clauses.push(`(report.report_code_key LIKE @keywordCodeKey ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.report_organization LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR report.note LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}')`);
  }
  const reportCode = normalizeCarbonEmissionReportText(query.reportCode);
  if (reportCode) {
    params.reportCodeKey = buildCarbonEmissionReportCodeKey(reportCode);
    clauses.push('report.report_code_key = @reportCodeKey');
  }
  const organization = normalizeCarbonEmissionReportText(query.organization);
  if (organization) {
    params.organization = `%${escapeLikePattern(organization)}%`;
    clauses.push(`report.report_organization LIKE @organization ESCAPE '${LIKE_ESCAPE_CHARACTER}'`);
  }
  const periodStart = normalizeOptionalReportDate(query.periodStart, 'periodStart');
  const periodEnd = normalizeOptionalReportDate(query.periodEnd, 'periodEnd');
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw badRequest('报告期间筛选必须满足 periodStart 不晚于 periodEnd。', {
      code: 'CARBON_EMISSION_REPORT_FILTER_PERIOD_INVALID'
    });
  }
  if (periodStart) {
    params.periodStart = periodStart;
    clauses.push('report.period_end >= @periodStart');
  }
  if (periodEnd) {
    params.periodEnd = periodEnd;
    clauses.push('report.period_start <= @periodEnd');
  }
  const rawScope = normalizeCarbonEmissionReportText(query.scope);
  if (rawScope) {
    const scope = normalizeCarbonEmissionReportScope(rawScope);
    if (!scope) {
      throw badRequest('scope 筛选无效。', {
        code: 'CARBON_EMISSION_REPORT_FILTER_SCOPE_INVALID', scope: rawScope
      });
    }
    params.scope = scope;
    clauses.push('EXISTS (SELECT 1 FROM carbon_emission_report_items item_scope WHERE item_scope.report_id = report.id AND item_scope.emission_scope = @scope)');
  }
  const category = normalizeCarbonEmissionReportText(query.category);
  if (category) {
    params.category = category;
    clauses.push('EXISTS (SELECT 1 FROM carbon_emission_report_items item_category WHERE item_category.report_id = report.id AND item_category.category = @category)');
  }
  if (query.sourceBatchId !== undefined && normalizeCarbonEmissionReportText(query.sourceBatchId)) {
    params.sourceBatchId = normalizeCarbonEmissionReportId(query.sourceBatchId, 'sourceBatchId');
    clauses.push('report.source_batch_id = @sourceBatchId');
  }
  return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// 列表和详情共享主表投影，报告事实与来源批次信息始终成对返回。
const CARBON_EMISSION_REPORT_SELECT_SQL = `SELECT report.id,
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
  (SELECT COUNT(*) FROM carbon_emission_report_items item_count WHERE item_count.report_id = report.id) AS itemCount,
  (SELECT COUNT(*) FROM carbon_emission_report_summaries summary_count WHERE summary_count.report_id = report.id) AS summaryCount,
  (SELECT COUNT(*) FROM carbon_emission_report_evidence evidence_count WHERE evidence_count.report_id = report.id) AS evidenceCount
FROM carbon_emission_reports report
JOIN import_batches batch ON batch.id = report.source_batch_id
LEFT JOIN sys_users creator ON creator.id = report.created_by`;

/** 将主表 SQLite 行显式投影为稳定公共报告对象，禁止未来查询字段自动扩散。 */
function mapCarbonEmissionReportRow(row) {
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
    itemCount: Number(row.itemCount || 0),
    summaryCount: Number(row.summaryCount || 0),
    evidenceCount: Number(row.evidenceCount || 0)
  };
}

/** 分页查询碳排放报告。 */
function listCarbonEmissionReports(query = {}) {
  const pagination = normalizeCarbonEmissionReportPagination(query);
  const { whereSql, params } = buildCarbonEmissionReportWhere(query);
  const db = openDatabase();
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM carbon_emission_reports report ${whereSql}`)
      .get(params).total || 0);
    const rows = db.prepare(`${CARBON_EMISSION_REPORT_SELECT_SQL} ${whereSql}
      ORDER BY report.created_at DESC, report.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
      .map(mapCarbonEmissionReportRow);
    return {
      rows,
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages: Math.ceil(total / pagination.pageSize)
      }
    };
  } finally {
    db.close();
  }
}

/** 使用既有连接读取报告及来源批次主信息。 */
function getCarbonEmissionReportHeader(db, clause, value, notFoundDetail) {
  const row = db.prepare(`${CARBON_EMISSION_REPORT_SELECT_SQL} WHERE ${clause}`).get(value);
  if (!row) throw notFound('碳排放报告不存在。', notFoundDetail);
  return mapCarbonEmissionReportRow(row);
}

/** 使用既有连接读取报告五部分结构。 */
function hydrateCarbonEmissionReportDetail(db, report) {
  const reportId = report.id;
  const boundaries = db.prepare(`SELECT id, boundary_type AS boundaryType, boundary_name AS boundaryName,
    boundary_description AS boundaryDescription, source_row_number AS sourceRowNumber
    FROM carbon_emission_report_boundaries WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({
      id: Number(row.id),
      boundaryType: row.boundaryType,
      boundaryName: row.boundaryName,
      boundaryDescription: row.boundaryDescription,
      sourceRowNumber: Number(row.sourceRowNumber)
    }));
  const evidence = db.prepare(`SELECT id, evidence_code AS evidenceCode, evidence_name AS evidenceName,
    evidence_type AS evidenceType, evidence_description AS evidenceDescription, note,
    source_row_number AS sourceRowNumber
    FROM carbon_emission_report_evidence WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({
      id: Number(row.id),
      evidenceCode: row.evidenceCode,
      evidenceName: row.evidenceName,
      evidenceType: row.evidenceType,
      evidenceDescription: row.evidenceDescription,
      note: row.note,
      sourceRowNumber: Number(row.sourceRowNumber)
    }));
  const items = db.prepare(`SELECT item.id, item.item_code AS itemCode, item.emission_scope AS emissionScope,
    item.category, item.emission_source AS emissionSource, item.activity_value AS activityValue,
    item.activity_unit AS activityUnit, item.factor_value AS factorValue, item.factor_unit AS factorUnit,
    item.emission_value AS emissionValue, item.co2e_unit AS co2eUnit,
    evidence.evidence_code AS evidenceCode, item.note, item.source_row_number AS sourceRowNumber
    FROM carbon_emission_report_items item
    JOIN carbon_emission_report_evidence evidence ON evidence.id = item.evidence_id
    WHERE item.report_id = ? ORDER BY item.id`).all(reportId)
    .map((row) => ({
      id: Number(row.id),
      itemCode: row.itemCode,
      emissionScope: row.emissionScope,
      category: row.category,
      emissionSource: row.emissionSource,
      activityValue: Number(row.activityValue),
      activityUnit: row.activityUnit,
      factorValue: Number(row.factorValue),
      factorUnit: row.factorUnit,
      emissionValue: Number(row.emissionValue),
      co2eUnit: row.co2eUnit,
      evidenceCode: row.evidenceCode,
      note: row.note,
      sourceRowNumber: Number(row.sourceRowNumber)
    }));
  const summaries = db.prepare(`SELECT id, summary_code AS summaryCode, summary_dimension AS summaryDimension,
    summary_value AS summaryValue, emission_value AS emissionValue, co2e_unit AS co2eUnit,
    note, source_row_number AS sourceRowNumber
    FROM carbon_emission_report_summaries WHERE report_id = ? ORDER BY id`).all(reportId)
    .map((row) => ({
      id: Number(row.id),
      summaryCode: row.summaryCode,
      summaryDimension: row.summaryDimension,
      summaryValue: row.summaryValue,
      emissionValue: Number(row.emissionValue),
      co2eUnit: row.co2eUnit,
      note: row.note,
      sourceRowNumber: Number(row.sourceRowNumber)
    }));
  return { report, boundaries, items, summaries, evidence };
}

/** 按报告 ID 返回五部分结构化详情。 */
function getCarbonEmissionReport(reportIdValue) {
  const reportId = normalizeCarbonEmissionReportId(reportIdValue);
  const db = openDatabase();
  try {
    return hydrateCarbonEmissionReportDetail(db,
      getCarbonEmissionReportHeader(db, 'report.id = ?', reportId, { id: reportId }));
  } finally {
    db.close();
  }
}

/** 按来源导入批次返回五部分结构化追溯结果。 */
function getCarbonEmissionReportByBatch(sourceBatchIdValue) {
  const sourceBatchId = normalizeCarbonEmissionReportId(sourceBatchIdValue, 'sourceBatchId');
  const db = openDatabase();
  try {
    return hydrateCarbonEmissionReportDetail(db,
      getCarbonEmissionReportHeader(db, 'report.source_batch_id = ?', sourceBatchId, { sourceBatchId }));
  } finally {
    db.close();
  }
}

/** 仅防护危险字符串首字符，数值保持 number 以保留结构化导出类型。 */
function escapeCarbonEmissionReportSpreadsheetFormula(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** 将二维数据安全写入一个合法命名的工作表。 */
function appendCarbonEmissionReportWorksheet(workbook, sheetName, headers, rows) {
  const safeRows = rows.map((row) => row.map(escapeCarbonEmissionReportSpreadsheetFormula));
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...safeRows]);
  worksheet['!cols'] = headers.map((_header, index) => ({
    wch: Math.min(48, Math.max(12, ...safeRows.map((row) => String(row[index] ?? '').length + 2)))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/** 将单份报告导出为与领域结构一致的五工作表 XLSX。 */
function exportCarbonEmissionReport(reportIdValue) {
  const detail = getCarbonEmissionReport(reportIdValue);
  const { report, boundaries, items, summaries, evidence } = detail;
  const workbook = XLSX.utils.book_new();
  appendCarbonEmissionReportWorksheet(workbook, '报告信息',
    ['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注', '来源批次ID', '来源行号', '创建者', '创建时间'], [[
      report.reportCode, report.reportName, report.reportOrganization, report.periodStart, report.periodEnd,
      report.templateId, report.templateVersion, report.note, report.sourceBatchId, report.sourceRowNumber,
      report.createdByName, formatStrictUtcForUser(report.createdAt)
    ]]);
  appendCarbonEmissionReportWorksheet(workbook, '组织与核算边界',
    ['边界类型', '边界名称', '边界说明', '来源行号'], boundaries.map((row) => [
      row.boundaryType, row.boundaryName, row.boundaryDescription, row.sourceRowNumber
    ]));
  appendCarbonEmissionReportWorksheet(workbook, '报告项目',
    ['项目编码', '排放范围', '类别', '排放源或能源类型', '活动量', '活动量单位', '排放因子', '因子单位', '排放量', 'CO2e单位', '证据编号', '备注', '来源行号'], items.map((row) => [
      row.itemCode, row.emissionScope, row.category, row.emissionSource, row.activityValue,
      row.activityUnit, row.factorValue, row.factorUnit, row.emissionValue, row.co2eUnit,
      row.evidenceCode, row.note, row.sourceRowNumber
    ]));
  appendCarbonEmissionReportWorksheet(workbook, '汇总',
    ['汇总编码', '汇总维度', '汇总值', '排放量', 'CO2e单位', '备注', '来源行号'], summaries.map((row) => [
      row.summaryCode, row.summaryDimension, row.summaryValue, row.emissionValue, row.co2eUnit,
      row.note, row.sourceRowNumber
    ]));
  appendCarbonEmissionReportWorksheet(workbook, '证据说明',
    ['证据编号', '证据名称', '证据类型', '证据说明', '备注', '来源行号'], evidence.map((row) => [
      row.evidenceCode, row.evidenceName, row.evidenceType, row.evidenceDescription, row.note,
      row.sourceRowNumber
    ]));
  return {
    body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `${escapeCarbonEmissionReportSpreadsheetFormula(report.reportCode)}-碳排放报告.xlsx`,
    asciiFileName: `carbon-emission-report-${report.id}.xlsx`,
    rowCount: 1 + boundaries.length + items.length + summaries.length + evidence.length
  };
}

module.exports = {
  CARBON_EMISSION_REPORT_QUERY_FIELDS,
  buildCarbonEmissionReportWhere,
  escapeCarbonEmissionReportSpreadsheetFormula,
  exportCarbonEmissionReport,
  getCarbonEmissionReport,
  getCarbonEmissionReportByBatch,
  listCarbonEmissionReports,
  normalizeCarbonEmissionReportId,
  normalizeCarbonEmissionReportPagination
};
