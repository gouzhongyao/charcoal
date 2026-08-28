'use strict';

const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest } = require('../utils/errors');
const { formatStrictUtcForUser } = require('../utils/userVisibleDateTime');
const { UTF8_BOM } = require('./templateService');
const {
  MAX_PAGE_SIZE,
  STATISTICS_MAX_PAGE_SIZE,
  buildEnergyRecordWhere,
  buildPaginationMeta,
  normalizeDetailSort,
  normalizeDimension,
  normalizeEnergyRecordFilters,
  normalizePagination,
  normalizePositiveInteger
} = require('./energyRecordQuery');

// 能耗明细导出字段只包含最终规范字段和通过 JOIN 派生的中文业务名称。
const ENERGY_RECORD_EXPORT_FIELDS = Object.freeze([
  { key: 'id', header: '能耗记录ID' },
  { key: 'sourceBatchId', header: '来源批次ID' },
  { key: 'sourceRowNumber', header: '来源行号' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型名称' },
  { key: 'originalValue', header: '原始值' },
  { key: 'originalUnit', header: '原始单位' },
  { key: 'normalizedValue', header: '标准化值' },
  { key: 'normalizedUnit', header: '标准化单位' },
  { key: 'organizationUnitCode', header: '用能单元编码' },
  { key: 'organizationUnitName', header: '用能单元名称' },
  { key: 'organizationUnitPath', header: '用能单元路径' },
  { key: 'meterCode', header: '计量器具编码' },
  { key: 'meterName', header: '计量器具名称' },
  { key: 'remark', header: '备注' },
  { key: 'createdAt', header: '创建时间' }
]);

// 驾驶舱月份参数只接受完整自然年内的 YYYY-MM 起止范围。
const DASHBOARD_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 规范化统计拆分条数上限。 */
function normalizeBreakdownLimit(query = {}, defaultLimit = 50, maxLimit = 200) {
  const requestedLimit = normalizePositiveInteger(query.limit, 'limit') || defaultLimit;
  return Math.min(requestedLimit, maxLimit);
}

/** 在统一能耗筛选合同下执行查询回调。 */
function withEnergyRecordFilter(query, callback) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  return callback({ filters, whereSql, params });
}

/** 构造最终规范能耗明细查询的公共 SELECT。 */
function buildEnergyRecordSelect() {
  return `SELECT
    er.id,
    er.source_batch_id AS sourceBatchId,
    er.source_row_number AS sourceRowNumber,
    et.code AS energyTypeCode,
    et.name AS energyTypeName,
    er.original_month AS originalMonth,
    er.normalized_month AS normalizedMonth,
    er.original_unit AS originalUnit,
    er.original_value AS originalValue,
    er.normalized_unit AS normalizedUnit,
    er.normalized_value AS normalizedValue,
    er.organization_unit_id AS organizationUnitId,
    ou.unit_code AS organizationUnitCode,
    ou.unit_name AS organizationUnitName,
    ou.unit_path AS organizationUnitPath,
    er.meter_device_id AS meterDeviceId,
    md.meter_code AS meterCode,
    md.meter_name AS meterName,
    er.remark,
    er.duplicate_key AS duplicateKey,
    er.created_at AS createdAt,
    er.updated_at AS updatedAt
  FROM energy_records er
  JOIN energy_types et ON et.id = er.energy_type_id
  JOIN organization_units ou ON ou.id = er.organization_unit_id
  LEFT JOIN meter_devices md ON md.id = er.meter_device_id`;
}

/** 分页查询最终规范能耗明细。 */
function listEnergyRecords(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: MAX_PAGE_SIZE });
  const sort = normalizeDetailSort(query);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const total = db.prepare(`SELECT COUNT(*) AS total
        FROM energy_records er
        JOIN energy_types et ON et.id = er.energy_type_id
        JOIN organization_units ou ON ou.id = er.organization_unit_id
        LEFT JOIN meter_devices md ON md.id = er.meter_device_id
        ${whereSql}`).get(params).total;
      const rows = db.prepare(`${buildEnergyRecordSelect()}
        ${whereSql}
        ORDER BY ${sort.orderSql}
        LIMIT @pageSize OFFSET @offset`).all({ ...params, pageSize, offset });
      return {
        rows,
        pagination: buildPaginationMeta(page, pageSize, total),
        sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder }
      };
    } finally {
      db.close();
    }
  });
}

/** 严格规范化能耗导出格式。 */
function normalizeEnergyRecordExportFormat(value) {
  const format = String(value || 'xlsx').trim().toLowerCase();
  if (!['xlsx', 'csv'].includes(format)) {
    throw badRequest('format 仅支持 xlsx 或 csv。', { code: 'UNSUPPORTED_ENERGY_RECORD_EXPORT_FORMAT', format });
  }
  return format;
}

/** 对 CSV 单元格执行稳定转义。 */
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 渲染能耗明细 CSV。 */
/** 构造能耗明细用户可见导出单元格，API 查询值不经过此投影。 */
function buildEnergyRecordExportValue(row, field) {
  if (field.key === 'createdAt') return formatStrictUtcForUser(row[field.key]);
  return row[field.key] ?? '';
}

function renderEnergyRecordCsv(rows) {
  const headers = ENERGY_RECORD_EXPORT_FIELDS.map((field) => field.header);
  const lines = [headers, ...rows.map((row) => ENERGY_RECORD_EXPORT_FIELDS.map((field) => buildEnergyRecordExportValue(row, field)))];
  return Buffer.from(`${UTF8_BOM}${lines.map((line) => line.map(escapeCsvCell).join(',')).join('\n')}\n`, 'utf8');
}

/** 渲染能耗明细 Excel。 */
function renderEnergyRecordXlsx(rows) {
  const outputRows = rows.map((row) => Object.fromEntries(
    ENERGY_RECORD_EXPORT_FIELDS.map((field) => [field.header, buildEnergyRecordExportValue(row, field)])
  ));
  const headers = ENERGY_RECORD_EXPORT_FIELDS.map((field) => field.header);
  const worksheet = XLSX.utils.json_to_sheet(outputRows, { header: headers });
  worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 14), 36) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '能耗明细');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 导出最终规范能耗明细。 */
function exportEnergyRecords(query = {}) {
  const format = normalizeEnergyRecordExportFormat(query.format);
  const sort = normalizeDetailSort(query);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const rows = db.prepare(`${buildEnergyRecordSelect()}
        ${whereSql}
        ORDER BY ${sort.orderSql}`).all(params);
      const generatedAt = new Date().toISOString();
      const date = generatedAt.slice(0, 10).replace(/-/g, '');
      const body = format === 'csv' ? renderEnergyRecordCsv(rows) : renderEnergyRecordXlsx(rows);
      return {
        fileName: `能耗明细-${date}.${format}`,
        format,
        contentType: format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body,
        rowCount: rows.length,
        fields: ENERGY_RECORD_EXPORT_FIELDS.map((field) => field.header)
      };
    } finally {
      db.close();
    }
  });
}

/** 返回能耗摘要，组织和计量器具数量均按规范外键统计。 */
function getEnergyRecordSummary(query = {}) {
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const summary = db.prepare(`SELECT
        COUNT(er.id) AS recordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
        COUNT(DISTINCT et.code) AS energyTypeCount,
        COUNT(DISTINCT er.source_batch_id) AS sourceBatchCount,
        COUNT(DISTINCT er.organization_unit_id) AS organizationUnitCount,
        COUNT(DISTINCT er.meter_device_id) AS meterDeviceCount,
        MIN(er.normalized_month) AS monthStart,
        MAX(er.normalized_month) AS monthEnd
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      JOIN organization_units ou ON ou.id = er.organization_unit_id
      LEFT JOIN meter_devices md ON md.id = er.meter_device_id
      ${whereSql}`).get(params);
      return {
        ...summary,
        totalNormalizedValue: Number(summary.totalNormalizedValue || 0),
        monthRange: { start: summary.monthStart, end: summary.monthEnd },
        mixedUnitNotice: summary.energyTypeCount > 1
          ? 'totalNormalizedValue 为跨能源类型标准化数值直接求和，仅用于快速摘要；精确对比请按能源类型查看。'
          : null
      };
    } finally {
      db.close();
    }
  });
}

/** 返回按月和能源类型分组的趋势。 */
function getMonthlyTrend(query = {}) {
  const limit = normalizeBreakdownLimit(query, STATISTICS_MAX_PAGE_SIZE, STATISTICS_MAX_PAGE_SIZE);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(`SELECT er.normalized_month AS month,
        et.code AS energyTypeCode, et.name AS energyTypeName,
        er.normalized_unit AS normalizedUnit,
        COUNT(er.id) AS recordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
        COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      JOIN organization_units ou ON ou.id = er.organization_unit_id
      LEFT JOIN meter_devices md ON md.id = er.meter_device_id
      ${whereSql}
      GROUP BY er.normalized_month, et.code, et.name, er.normalized_unit
      ORDER BY er.normalized_month ASC, et.display_order ASC, et.code ASC
      LIMIT @limit`).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

/** 返回按能源类型分组的能耗统计。 */
function getEnergyTypeBreakdown(query = {}) {
  const limit = normalizeBreakdownLimit(query, 100, 200);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(`SELECT et.code AS energyTypeCode, et.name AS energyTypeName,
        et.category AS category, er.normalized_unit AS normalizedUnit,
        COUNT(er.id) AS recordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
        COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue,
        COUNT(DISTINCT er.normalized_month) AS monthCount,
        MIN(er.normalized_month) AS monthStart,
        MAX(er.normalized_month) AS monthEnd
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      JOIN organization_units ou ON ou.id = er.organization_unit_id
      LEFT JOIN meter_devices md ON md.id = er.meter_device_id
      ${whereSql}
      GROUP BY et.code, et.name, et.category, er.normalized_unit, et.display_order
      ORDER BY totalNormalizedValue DESC, et.display_order ASC, et.code ASC
      LIMIT @limit`).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

/** 返回按规范用能单元或计量器具维度分组的统计。 */
function getDimensionBreakdown(query = {}) {
  const { dimension, columnSql } = normalizeDimension(query.dimension);
  const limit = normalizeBreakdownLimit(query, 100, 200);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const rows = db.prepare(`SELECT
        COALESCE(NULLIF(TRIM(${columnSql}), ''), '未关联计量器具') AS dimensionValue,
        COUNT(er.id) AS recordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
        COUNT(DISTINCT et.code) AS energyTypeCount,
        COUNT(DISTINCT er.normalized_month) AS monthCount,
        MIN(er.normalized_month) AS monthStart,
        MAX(er.normalized_month) AS monthEnd
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      JOIN organization_units ou ON ou.id = er.organization_unit_id
      LEFT JOIN meter_devices md ON md.id = er.meter_device_id
      ${whereSql}
      GROUP BY dimensionValue
      ORDER BY totalNormalizedValue DESC, recordCount DESC, dimensionValue ASC
      LIMIT @limit`).all({ ...params, limit });
      return { dimension, rows };
    } finally {
      db.close();
    }
  });
}

/** 规范化驾驶舱年度摘要范围。 */
function normalizeDashboardSummaryRange(query = {}) {
  const hasStart = Object.prototype.hasOwnProperty.call(query, 'normalizedMonthStart');
  const hasEnd = Object.prototype.hasOwnProperty.call(query, 'normalizedMonthEnd');
  if (!hasStart && !hasEnd) return { filteredByMonth: false, normalizedMonthStart: null, normalizedMonthEnd: null };
  if (!hasStart || !hasEnd) throw badRequest('normalizedMonthStart 与 normalizedMonthEnd 必须同时提供。', { code: 'DASHBOARD_MONTH_RANGE_REQUIRED' });
  const normalizedMonthStart = String(query.normalizedMonthStart ?? '').trim();
  const normalizedMonthEnd = String(query.normalizedMonthEnd ?? '').trim();
  [['normalizedMonthStart', normalizedMonthStart], ['normalizedMonthEnd', normalizedMonthEnd]].forEach(([fieldName, value]) => {
    if (!DASHBOARD_MONTH_PATTERN.test(value)) throw badRequest(`${fieldName} 必须使用 YYYY-MM 格式，且月份范围为 01-12。`, { code: 'INVALID_MONTH_FILTER', fieldName, rawValue: value });
  });
  if (normalizedMonthStart.slice(0, 4) !== normalizedMonthEnd.slice(0, 4)) throw badRequest('中控月份范围必须位于同一自然年。', { code: 'INVALID_DASHBOARD_YEAR_RANGE', normalizedMonthStart, normalizedMonthEnd });
  if (normalizedMonthStart > normalizedMonthEnd) throw badRequest('月份范围开始值不能晚于结束值。', { code: 'INVALID_MONTH_RANGE', normalizedMonthStart, normalizedMonthEnd });
  return { filteredByMonth: true, normalizedMonthStart, normalizedMonthEnd };
}

/** 构造无领域权限的明确状态。 */
function buildUnauthorizedDashboardDomain() {
  return { authorized: false, status: 'forbidden' };
}

/** 查询驾驶舱能耗与当前导入审计摘要。 */
function getDashboardSummary(query = {}, access = {}) {
  const range = normalizeDashboardSummaryRange(query);
  const energyAuthorized = access.energyAuthorized === true;
  const importsAuthorized = access.importsAuthorized === true;
  const energyRangeSql = range.filteredByMonth
    ? ' AND er.normalized_month >= @normalizedMonthStart AND er.normalized_month <= @normalizedMonthEnd'
    : '';
  const energyRangeParams = range.filteredByMonth ? {
    normalizedMonthStart: range.normalizedMonthStart,
    normalizedMonthEnd: range.normalizedMonthEnd
  } : {};
  const db = openDatabase();
  try {
    let energy = buildUnauthorizedDashboardDomain();
    if (energyAuthorized) {
      const energySummary = db.prepare(`SELECT COUNT(er.id) AS activeRecordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
        COUNT(DISTINCT et.code) AS energyTypeCount,
        MIN(er.normalized_month) AS monthStart,
        MAX(er.normalized_month) AS monthEnd,
        MAX(er.created_at) AS latestRecordAt
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      WHERE er.record_status = 'active'${energyRangeSql}`).get(energyRangeParams);
      const totals = db.prepare(`SELECT et.code AS energyTypeCode, et.name AS energyTypeName,
        er.normalized_unit AS normalizedUnit, COUNT(er.id) AS recordCount,
        COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      WHERE er.record_status = 'active'${energyRangeSql}
      GROUP BY et.code, et.name, er.normalized_unit, et.display_order
      ORDER BY et.display_order ASC, et.code ASC, er.normalized_unit ASC`).all(energyRangeParams).map((row) => ({
        ...row,
        recordCount: Number(row.recordCount || 0),
        totalNormalizedValue: Number(row.totalNormalizedValue || 0)
      }));
      energy = {
        authorized: true,
        status: Number(energySummary.activeRecordCount || 0) > 0 ? 'available' : 'empty',
        ...energySummary,
        totalNormalizedValue: Number(energySummary.totalNormalizedValue || 0),
        totals,
        authoritativeTotalField: 'totals',
        monthRange: { start: energySummary.monthStart, end: energySummary.monthEnd },
        scope: { ...range, recordStatus: 'active' }
      };
    }

    let imports = buildUnauthorizedDashboardDomain();
    let errors = buildUnauthorizedDashboardDomain();
    if (importsAuthorized) {
      const batches = db.prepare(`SELECT COUNT(*) AS batchCount,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedBatchCount,
        SUM(CASE WHEN status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completedWithErrorsBatchCount,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedBatchCount,
        COALESCE(SUM(success_count), 0) AS importedRowCount,
        COALESCE(SUM(failure_count), 0) AS failedRowCount,
        COALESCE(SUM(skipped_count), 0) AS skippedRowCount,
        MAX(created_at) AS latestBatchAt FROM import_batches`).get();
      const importErrors = db.prepare(`SELECT COUNT(*) AS importErrorCount,
        SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) AS blockingErrorCount,
        SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warningCount FROM import_errors`).get();
      imports = { authorized: true, status: Number(batches.batchCount || 0) > 0 ? 'available' : 'empty', ...batches };
      errors = { authorized: true, status: Number(importErrors.importErrorCount || 0) > 0 ? 'available' : 'empty', ...importErrors };
    }
    return {
      scope: 'energy-records-and-imports-only',
      excludes: ['carbon-accounting', 'prediction', 'energy-budget', 'meter-ledger'],
      energy,
      imports,
      errors,
      notices: ['能耗合计按能源类型和标准化单位分组；本接口不包含碳核算、预测或预算数据。']
    };
  } finally {
    db.close();
  }
}

module.exports = {
  ENERGY_RECORD_EXPORT_FIELDS,
  exportEnergyRecords,
  getDashboardSummary,
  getDimensionBreakdown,
  getEnergyRecordSummary,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords,
  normalizeBreakdownLimit,
  normalizeDashboardSummaryRange
};
