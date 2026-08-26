const crypto = require('crypto');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const {
  buildEnergyRecordLedgerBackfillPreview,
  loadLedgerBackfillPreviewIndexes
} = require('./ledgerService');
const { badRequest } = require('../utils/errors');
const { assertWritableAllowed } = require('./maintenanceState');
const { createBackup } = require('./backupService');
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

function normalizeBreakdownLimit(query = {}, defaultLimit = 50, maxLimit = 200) {
  const requestedLimit = normalizePositiveInteger(query.limit, 'limit') || defaultLimit;
  return Math.min(requestedLimit, maxLimit);
}

function withEnergyRecordFilter(query, callback) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  return callback({ filters, whereSql, params });
}

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
  { key: 'organization', header: '组织' },
  { key: 'site', header: '地点' },
  { key: 'department', header: '部门' },
  { key: 'productionLine', header: '产线' },
  { key: 'meterCode', header: '原始仪表编码' },
  { key: 'ledgerMeterCode', header: '关联仪表编码' },
  { key: 'meterDeviceName', header: '关联仪表名称' },
  { key: 'organizationUnitCode', header: '关联用能单元编码' },
  { key: 'organizationUnitName', header: '关联用能单元名称' },
  { key: 'organizationUnitPath', header: '关联用能单元路径' },
  { key: 'businessDimension', header: '业务维度' },
  { key: 'remark', header: '备注' },
  { key: 'createdAt', header: '创建时间' }
]);

function normalizeEnergyRecordExportFormat(value) {
  const format = String(value || 'xlsx').trim().toLowerCase();
  if (!['xlsx', 'csv'].includes(format)) {
    throw badRequest('format 仅支持 xlsx 或 csv。', { code: 'UNSUPPORTED_ENERGY_RECORD_EXPORT_FORMAT', format });
  }
  return format;
}

function listEnergyRecords(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: MAX_PAGE_SIZE });
  const sort = normalizeDetailSort(query);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const total = db.prepare(
        `SELECT COUNT(*) AS total
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}`
      ).get(params).total;
      const rows = db.prepare(
        `SELECT
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
           md.meter_code AS ledgerMeterCode,
           md.meter_name AS meterDeviceName,
           er.organization,
           er.site,
           er.department,
           er.production_line AS productionLine,
           er.meter_code AS meterCode,
           er.business_dimension AS businessDimension,
           er.remark,
           er.duplicate_key AS duplicateKey,
           er.created_at AS createdAt,
           er.updated_at AS updatedAt,
           CASE
             WHEN er.meter_device_id IS NOT NULL THEN 'meter-linked'
             WHEN er.organization_unit_id IS NOT NULL THEN 'organization-linked'
             ELSE 'unlinked'
           END AS ledgerAssociationStatus
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         ORDER BY ${sort.orderSql}
         LIMIT @pageSize OFFSET @offset`
      ).all({ ...params, pageSize, offset });

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

function buildEnergyRecordExportRows(rows = []) {
  return rows.map((row) => {
    const output = {};
    ENERGY_RECORD_EXPORT_FIELDS.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
}

function renderEnergyRecordCsv(rows = []) {
  const headers = ENERGY_RECORD_EXPORT_FIELDS.map((field) => field.header);
  const lines = [headers, ...rows.map((row) => ENERGY_RECORD_EXPORT_FIELDS.map((field) => row[field.key] ?? ''))];
  return Buffer.from(`${UTF8_BOM}${lines.map((line) => line.map(escapeCsvCell).join(',')).join('\n')}\n`, 'utf8');
}

function renderEnergyRecordXlsx(rows = []) {
  const headers = ENERGY_RECORD_EXPORT_FIELDS.map((field) => field.header);
  const worksheet = XLSX.utils.json_to_sheet(buildEnergyRecordExportRows(rows), { header: headers });
  worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 14), 36) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '能耗明细');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function exportEnergyRecords(query = {}) {
  const format = normalizeEnergyRecordExportFormat(query.format);
  const sort = normalizeDetailSort(query);
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const rows = db.prepare(
        `SELECT
           er.id,
           er.source_batch_id AS sourceBatchId,
           er.source_row_number AS sourceRowNumber,
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.normalized_month AS normalizedMonth,
           er.original_unit AS originalUnit,
           er.original_value AS originalValue,
           er.normalized_unit AS normalizedUnit,
           er.normalized_value AS normalizedValue,
           ou.unit_code AS organizationUnitCode,
           ou.unit_name AS organizationUnitName,
           ou.unit_path AS organizationUnitPath,
           md.meter_code AS ledgerMeterCode,
           md.meter_name AS meterDeviceName,
           er.organization,
           er.site,
           er.department,
           er.production_line AS productionLine,
           er.meter_code AS meterCode,
           er.business_dimension AS businessDimension,
           er.remark,
           er.created_at AS createdAt
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         ORDER BY ${sort.orderSql}`
      ).all(params);
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

function getEnergyRecordSummary(query = {}) {
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const summary = db.prepare(
        `SELECT
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COUNT(DISTINCT et.code) AS energyTypeCount,
           COUNT(DISTINCT er.source_batch_id) AS sourceBatchCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.organization, '')), '')) AS organizationCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.site, '')), '')) AS siteCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.department, '')), '')) AS departmentCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}`
      ).get(params);

      return {
        ...summary,
        totalNormalizedValue: Number(summary.totalNormalizedValue || 0),
        monthRange: {
          start: summary.monthStart,
          end: summary.monthEnd
        },
        mixedUnitNotice: summary.energyTypeCount > 1
          ? 'totalNormalizedValue 为跨能源类型标准化数值直接求和，仅用于工作台快速摘要；精确对比请按能源类型查看。'
          : null
      };
    } finally {
      db.close();
    }
  });
}

function getMonthlyTrend(query = {}) {
  const limit = normalizeBreakdownLimit(query, STATISTICS_MAX_PAGE_SIZE, STATISTICS_MAX_PAGE_SIZE);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(
        `SELECT
           er.normalized_month AS month,
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.normalized_unit AS normalizedUnit,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         GROUP BY er.normalized_month, et.code, et.name, er.normalized_unit
         ORDER BY er.normalized_month ASC, et.display_order ASC, et.code ASC
         LIMIT @limit`
      ).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

function getEnergyTypeBreakdown(query = {}) {
  const limit = normalizeBreakdownLimit(query, 100, 200);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(
        `SELECT
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           et.category AS category,
           er.normalized_unit AS normalizedUnit,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue,
           COUNT(DISTINCT er.normalized_month) AS monthCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         GROUP BY et.code, et.name, et.category, er.normalized_unit, et.display_order
         ORDER BY totalNormalizedValue DESC, et.display_order ASC, et.code ASC
         LIMIT @limit`
      ).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

function getDimensionBreakdown(query = {}) {
  const { dimension, columnSql } = normalizeDimension(query.dimension);
  const limit = normalizeBreakdownLimit(query, 100, 200);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const rows = db.prepare(
        `SELECT
           COALESCE(NULLIF(TRIM(${columnSql}), ''), '未填写') AS dimensionValue,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COUNT(DISTINCT et.code) AS energyTypeCount,
           COUNT(DISTINCT er.normalized_month) AS monthCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         GROUP BY dimensionValue
         ORDER BY totalNormalizedValue DESC, recordCount DESC, dimensionValue ASC
         LIMIT @limit`
      ).all({ ...params, limit });

      return { dimension, rows };
    } finally {
      db.close();
    }
  });
}

function normalizePreviewDetailLimit(query = {}) {
  const requestedLimit = normalizePositiveInteger(query.limit || query.detailLimit, 'limit') || 100;
  return Math.min(requestedLimit, 500);
}

function normalizePreviewExportDetailLimit(query = {}) {
  const requestedLimit = normalizePositiveInteger(query.detailLimit || query.limit, 'detailLimit') || 500;
  return Math.min(requestedLimit, 500);
}

const LEDGER_BACKFILL_CONFIRM_TEXT = '确认执行历史能耗台账回填';
const LEDGER_BACKFILL_EXECUTABLE_STATUSES = new Set(['candidate-by-meter', 'candidate-by-organization']);
const LEDGER_BACKFILL_SIGNATURE_VERSION = 'energy-record-ledger-backfill-preview:v1';

const LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS = Object.freeze([
  { key: 'recordId', header: '能耗记录ID' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型名称' },
  { key: 'originalOrganization', header: '原始组织' },
  { key: 'originalSite', header: '原始地点' },
  { key: 'originalDepartment', header: '原始部门' },
  { key: 'originalMeterCode', header: '原始仪表字段' },
  { key: 'status', header: '预演状态' },
  { key: 'wouldUpdate', header: '是否可作为回填候选' },
  { key: 'reasonCodes', header: '原因编码' },
  { key: 'reasons', header: '原因说明' },
  { key: 'existingOrganizationUnitId', header: '原用能单元ID' },
  { key: 'existingMeterDeviceId', header: '原计量器具ID' },
  { key: 'candidateOrganizationUnitId', header: '候选用能单元ID' },
  { key: 'candidateOrganizationUnitCode', header: '候选用能单元编码' },
  { key: 'candidateOrganizationUnitName', header: '候选用能单元名称' },
  { key: 'candidateOrganizationUnitPath', header: '候选用能单元路径' },
  { key: 'candidateMeterDeviceId', header: '候选计量器具ID' },
  { key: 'candidateMeterCode', header: '候选计量器具编码' },
  { key: 'candidateMeterName', header: '候选计量器具名称' },
  { key: 'candidateMeterEnergyTypeCode', header: '候选计量器具能源类型' },
  { key: 'candidateMeterOrganizationUnitId', header: '候选计量器具所属用能单元ID' },
  { key: 'candidateMeterOrganizationUnitCode', header: '候选计量器具所属用能单元编码' },
  { key: 'candidateMeterOrganizationUnitName', header: '候选计量器具所属用能单元名称' },
  { key: 'candidateMeterOrganizationUnitPath', header: '候选计量器具所属用能单元路径' },
  { key: 'dryRunNotice', header: '只读审计说明' }
]);

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function normalizeEnergyRecordLedgerBackfillPreviewItem(item = {}) {
  const existingOrganizationUnitId = item.existing?.organizationUnitId || null;
  const existingMeterDeviceId = item.existing?.meterDeviceId || null;
  if ((existingOrganizationUnitId && !existingMeterDeviceId) || (!existingOrganizationUnitId && existingMeterDeviceId)) {
    return {
      ...item,
      status: 'already-partial',
      wouldUpdate: false,
      candidate: { organizationUnitId: null, meterDeviceId: null },
      reasons: [
        ...(Array.isArray(item.reasons) ? item.reasons : []),
        { code: 'ALREADY_PARTIAL_SKIPPED', message: '已有部分台账 ID，本轮受控回填按防覆盖策略跳过 alreadyPartial 记录。' }
      ]
    };
  }
  return item;
}

function getExecutableLedgerBackfillItems(items = []) {
  return items.filter((item) => item && item.wouldUpdate === true && LEDGER_BACKFILL_EXECUTABLE_STATUSES.has(item.status));
}

function buildLedgerBackfillCandidateRecordIds(items = []) {
  return getExecutableLedgerBackfillItems(items).map((item) => Number(item.recordId)).sort((a, b) => a - b);
}

function buildLedgerBackfillPreviewSignature({ filters = {}, summary = {}, candidateRecordIds = [] } = {}) {
  const payload = {
    version: LEDGER_BACKFILL_SIGNATURE_VERSION,
    filters,
    summary: {
      totalScanned: Number(summary.totalScanned || 0),
      alreadyLinked: Number(summary.alreadyLinked || 0),
      alreadyPartial: Number(summary.alreadyPartial || 0),
      candidateByMeter: Number(summary.candidateByMeter || 0),
      candidateByOrganization: Number(summary.candidateByOrganization || 0),
      ambiguous: Number(summary.ambiguous || 0),
      missing: Number(summary.missing || 0),
      blocked: Number(summary.blocked || 0),
      wouldUpdate: Number(summary.wouldUpdate || 0)
    },
    candidateRecordIds: candidateRecordIds.map(Number).sort((a, b) => a - b)
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function normalizeRecordIds(value, fieldName = 'candidateRecordIds') {
  if (!Array.isArray(value)) {
    throw badRequest(`${fieldName} 必须是数组。`, { code: 'INVALID_LEDGER_BACKFILL_RECORD_IDS', fieldName });
  }
  const ids = value.map((raw) => {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text)) {
      throw badRequest(`${fieldName} 只能包含正整数 recordId。`, { code: 'INVALID_LEDGER_BACKFILL_RECORD_ID', fieldName, rawValue: raw });
    }
    const id = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw badRequest(`${fieldName} 只能包含正整数 recordId。`, { code: 'INVALID_LEDGER_BACKFILL_RECORD_ID', fieldName, rawValue: raw });
    }
    return id;
  }).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) {
    throw badRequest(`${fieldName} 不允许包含重复 recordId。`, { code: 'DUPLICATE_LEDGER_BACKFILL_RECORD_ID', fieldName });
  }
  return ids;
}

function assertSameRecordIds(actual = [], expected = [], code, message) {
  if (actual.length !== expected.length || actual.some((id, index) => Number(id) !== Number(expected[index]))) {
    throw badRequest(message, { code, expectedRecordIds: expected, actualRecordIds: actual });
  }
}

function summarizeLedgerBackfillPreview(items = []) {
  const summary = {
    totalScanned: items.length,
    alreadyLinked: 0,
    alreadyPartial: 0,
    candidateByMeter: 0,
    candidateByOrganization: 0,
    ambiguous: 0,
    missing: 0,
    blocked: 0,
    wouldUpdate: 0
  };

  items.forEach((item) => {
    if (item.status === 'already-linked') summary.alreadyLinked += 1;
    else if (item.status === 'already-partial') summary.alreadyPartial += 1;
    else if (item.status === 'candidate-by-meter') summary.candidateByMeter += 1;
    else if (item.status === 'candidate-by-organization') summary.candidateByOrganization += 1;
    else if (item.status === 'ambiguous') summary.ambiguous += 1;
    else if (item.status === 'blocked') summary.blocked += 1;
    else summary.missing += 1;
    if (item.wouldUpdate) summary.wouldUpdate += 1;
  });

  return summary;
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildLedgerBackfillPreviewExportRows(items = []) {
  return items.map((item) => {
    const source = item.source || {};
    const matchedOrganization = item.matched?.organizationUnit || {};
    const matchedMeter = item.matched?.meterDevice || {};
    const reasons = Array.isArray(item.reasons) ? item.reasons : [];
    return {
      recordId: item.recordId,
      normalizedMonth: source.normalizedMonth || '',
      energyTypeCode: source.energyTypeCode || '',
      energyTypeName: source.energyTypeName || '',
      originalOrganization: source.organization || '',
      originalSite: source.site || '',
      originalDepartment: source.department || '',
      originalMeterCode: source.meterCode || '',
      status: item.status || '',
      wouldUpdate: item.wouldUpdate ? '是' : '否',
      reasonCodes: reasons.map((reason) => reason.code).filter(Boolean).join('; '),
      reasons: reasons.map((reason) => reason.message).filter(Boolean).join('; '),
      existingOrganizationUnitId: item.existing?.organizationUnitId || '',
      existingMeterDeviceId: item.existing?.meterDeviceId || '',
      candidateOrganizationUnitId: item.candidate?.organizationUnitId || '',
      candidateOrganizationUnitCode: matchedOrganization.unitCode || '',
      candidateOrganizationUnitName: matchedOrganization.unitName || '',
      candidateOrganizationUnitPath: matchedOrganization.unitPath || '',
      candidateMeterDeviceId: item.candidate?.meterDeviceId || '',
      candidateMeterCode: matchedMeter.meterCode || '',
      candidateMeterName: matchedMeter.meterName || '',
      candidateMeterEnergyTypeCode: matchedMeter.energyTypeCode || '',
      candidateMeterOrganizationUnitId: matchedMeter.organizationUnitId || '',
      candidateMeterOrganizationUnitCode: matchedMeter.organizationUnitCode || '',
      candidateMeterOrganizationUnitName: matchedMeter.organizationUnitName || '',
      candidateMeterOrganizationUnitPath: matchedMeter.organizationUnitPath || '',
      dryRunNotice: '本文件仅为历史能耗记录台账回填预演审计预案，不代表已执行回填，不会写入能耗记录。'
    };
  });
}

// 将内部筛选对象转换为审计文件中的中文展示文本，API JSON 字段保持不变。
function formatLedgerBackfillExportFilters(filters = {}) {
  const labels = {
    normalizedMonthStart: '开始月份',
    normalizedMonthEnd: '结束月份',
    energyTypeCode: '能源类型编码',
    organization: '组织',
    keyword: '关键词',
    site: '地点',
    department: '部门',
    organizationUnitId: '用能单元ID',
    meterDeviceId: '计量器具ID',
    sourceBatchId: '来源批次ID'
  };
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${labels[key] || '其他条件'}=${value}`);
  return entries.length ? entries.join('；') : '无筛选条件';
}

// 清理审计文件说明中的内部表名，仅影响文件展示层。
function formatLedgerBackfillExportNotices(notices = []) {
  return notices.map((notice) => String(notice || '').replaceAll('energy_records', '能耗记录')).join('；');
}

function buildLedgerBackfillPreviewExportMeta(preview, generatedAt) {
  return [
    { field: '文件类型', value: '历史能耗记录台账回填预演审计预案' },
    { field: '是否仅预演', value: preview.dryRun === true ? '是' : '否' },
    { field: '是否只读预览', value: preview.previewOnly === true ? '是' : '否' },
    { field: '是否写入能耗记录', value: preview.writesEnergyRecords === true ? '是' : '否' },
    { field: '只读说明', value: '本文件仅用于人工审计，不执行真实回填，不更新能耗记录。' },
    { field: '操作类型', value: '历史能耗记录台账关联回填预演' },
    { field: '数据范围', value: '仅启用状态能耗记录' },
    { field: '生成时间', value: generatedAt },
    { field: '明细数量上限', value: preview.detailLimit },
    { field: '导出明细数量', value: Array.isArray(preview.items) ? preview.items.length : 0 },
    { field: '扫描总数', value: preview.summary?.totalScanned || 0 },
    { field: '可回填数量', value: preview.summary?.wouldUpdate || 0 },
    { field: '按计量器具匹配数量', value: preview.summary?.candidateByMeter || 0 },
    { field: '按组织匹配数量', value: preview.summary?.candidateByOrganization || 0 },
    { field: '多候选数量', value: preview.summary?.ambiguous || 0 },
    { field: '缺失候选数量', value: preview.summary?.missing || 0 },
    { field: '阻断数量', value: preview.summary?.blocked || 0 },
    { field: '已完整关联数量', value: preview.summary?.alreadyLinked || 0 },
    { field: '已部分关联数量', value: preview.summary?.alreadyPartial || 0 },
    { field: '筛选条件', value: formatLedgerBackfillExportFilters(preview.filters) },
    { field: '注意事项', value: formatLedgerBackfillExportNotices(preview.notices) }
  ];
}

function renderLedgerBackfillPreviewCsv(metaRows, detailRows) {
  const detailHeaders = LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.map((field) => field.header);
  const lines = [
    ['历史能耗记录台账回填预演审计预案（仅预演、不写入）'],
    [],
    ['元信息字段', '值'],
    ...metaRows.map((row) => [row.field, row.value]),
    [],
    ['明细'],
    detailHeaders,
    ...detailRows.map((row) => LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.map((field) => row[field.key] ?? ''))
  ];
  return Buffer.from(`${UTF8_BOM}${lines.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`, 'utf8');
}

function renderLedgerBackfillPreviewXlsx(metaRows, detailRows) {
  const workbook = XLSX.utils.book_new();
  const metaSheet = XLSX.utils.aoa_to_sheet([
    ['历史能耗记录台账回填预演审计预案（仅预演、不写入）'],
    ['字段', '值'],
    ...metaRows.map((row) => [row.field, row.value])
  ]);
  metaSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  metaSheet['!cols'] = [{ wch: 28 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(workbook, metaSheet, '预案元信息');

  const detailHeaders = LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.map((field) => field.header);
  const detailObjects = detailRows.map((row) => {
    const output = {};
    LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
  const detailSheet = XLSX.utils.json_to_sheet(detailObjects, { header: detailHeaders });
  detailSheet['!cols'] = detailHeaders.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 14), 40) }));
  XLSX.utils.book_append_sheet(workbook, detailSheet, '预演明细');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function renderLedgerBackfillPreviewExport(preview, format) {
  const normalizedFormat = String(format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10).replace(/-/g, '');
  const detailRows = buildLedgerBackfillPreviewExportRows(preview.items || []);
  const metaRows = buildLedgerBackfillPreviewExportMeta(preview, generatedAt);
  const fileName = `能耗记录-台账回填预演审计预案-${date}.${normalizedFormat}`;
  if (normalizedFormat === 'csv') {
    return {
      fileName,
      format: normalizedFormat,
      contentType: 'text/csv; charset=utf-8',
      body: renderLedgerBackfillPreviewCsv(metaRows, detailRows),
      rowCount: detailRows.length,
      fields: LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.map((field) => field.header)
    };
  }
  return {
    fileName,
    format: normalizedFormat,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: renderLedgerBackfillPreviewXlsx(metaRows, detailRows),
    rowCount: detailRows.length,
    fields: LEDGER_BACKFILL_PREVIEW_EXPORT_FIELDS.map((field) => field.header)
  };
}

function getEnergyRecordLedgerBackfillPreview(query = {}) {
  return withEnergyRecordFilter(query, ({ whereSql, params, filters }) => {
    const db = openDatabase();
    try {
      const indexes = loadLedgerBackfillPreviewIndexes(db);
      const records = db.prepare(
        `SELECT
           er.id,
           er.energy_type_id AS energyTypeId,
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.organization_unit_id AS organizationUnitId,
           er.meter_device_id AS meterDeviceId,
           er.organization,
           er.site,
           er.department,
           er.meter_code AS meterCode,
           er.normalized_month AS normalizedMonth
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         ORDER BY er.id ASC`
      ).all(params);
      const items = records.map((record) => normalizeEnergyRecordLedgerBackfillPreviewItem(buildEnergyRecordLedgerBackfillPreview(record, indexes)));
      const summary = summarizeLedgerBackfillPreview(items);
      const candidateRecordIds = buildLedgerBackfillCandidateRecordIds(items);
      const previewSignature = buildLedgerBackfillPreviewSignature({ filters, summary, candidateRecordIds });
      const detailLimit = normalizePreviewDetailLimit(query);
      return {
        dryRun: true,
        previewOnly: true,
        writesEnergyRecords: false,
        operation: 'energy-record-ledger-backfill-preview',
        scope: 'active-energy-records-only',
        filters,
        summary,
        previewSignature,
        signatureVersion: LEDGER_BACKFILL_SIGNATURE_VERSION,
        candidateRecordIds,
        detailLimit,
        items: items.slice(0, detailLimit),
        _allItems: query.__includeAllItems === true ? items : undefined,
        notices: [
          '本接口仅预演历史 energy_records 台账关联候选，不写入、不回填、不更新 energy_records。',
          '计量器具候选必须与能耗记录能源类型一致；同时存在组织候选时还必须满足计量器具归属组织一致。',
          '原始字段不足、多匹配或组织/仪表归属冲突时只返回原因，不给出确定回填。'
        ]
      };
    } finally {
      db.close();
    }
  });
}

function exportEnergyRecordLedgerBackfillPreview(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const detailLimit = normalizePreviewExportDetailLimit(query);
  const preview = getEnergyRecordLedgerBackfillPreview({ ...query, detailLimit, limit: detailLimit });
  return renderLedgerBackfillPreviewExport(preview, format);
}

function countEnergyRecordLedgerBackfillState(db) {
  return db.prepare(
    `SELECT
       COUNT(*) AS totalActive,
       SUM(CASE WHEN organization_unit_id IS NULL THEN 1 ELSE 0 END) AS missingOrganizationUnit,
       SUM(CASE WHEN meter_device_id IS NULL THEN 1 ELSE 0 END) AS missingMeterDevice,
       SUM(CASE WHEN organization_unit_id IS NOT NULL THEN 1 ELSE 0 END) AS linkedOrganizationUnit,
       SUM(CASE WHEN meter_device_id IS NOT NULL THEN 1 ELSE 0 END) AS linkedMeterDevice
     FROM energy_records
     WHERE record_status = 'active'`
  ).get();
}

function buildLedgerBackfillAuditBeforeAfter(before, after, item, status, reason) {
  return {
    recordId: item.recordId,
    status,
    reason,
    previewStatus: item.status,
    before: {
      organizationUnitId: before ? before.organizationUnitId : null,
      meterDeviceId: before ? before.meterDeviceId : null
    },
    after: {
      organizationUnitId: after ? after.organizationUnitId : null,
      meterDeviceId: after ? after.meterDeviceId : null
    },
    candidate: {
      organizationUnitId: item.candidate?.organizationUnitId || null,
      meterDeviceId: item.candidate?.meterDeviceId || null
    }
  };
}

function validateLedgerBackfillExecuteRequest(body = {}) {
  if (body.confirmText !== LEDGER_BACKFILL_CONFIRM_TEXT) {
    throw badRequest('confirmText 不匹配，必须输入固定确认文本后才能执行。', {
      code: 'LEDGER_BACKFILL_CONFIRM_TEXT_MISMATCH',
      requiredConfirmText: LEDGER_BACKFILL_CONFIRM_TEXT
    });
  }
  if (!body.previewSignature || typeof body.previewSignature !== 'string') {
    throw badRequest('previewSignature 为必填项。', { code: 'LEDGER_BACKFILL_PREVIEW_SIGNATURE_REQUIRED' });
  }
  const expectedWouldUpdate = normalizePositiveInteger(body.expectedWouldUpdate, 'expectedWouldUpdate');
  if (expectedWouldUpdate === undefined || expectedWouldUpdate === null) {
    throw badRequest('expectedWouldUpdate 为必填项。', { code: 'LEDGER_BACKFILL_EXPECTED_WOULD_UPDATE_REQUIRED' });
  }
  const candidateRecordIds = normalizeRecordIds(body.candidateRecordIds, 'candidateRecordIds');
  if (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters)) {
    throw badRequest('filters 为必填对象，必须与 preview 使用的筛选条件一致。', { code: 'LEDGER_BACKFILL_FILTERS_REQUIRED' });
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throw badRequest('必须确认 acknowledgeSkippedRisks=true，理解 ambiguous/missing/blocked/alreadyLinked/alreadyPartial 将被跳过。', {
      code: 'LEDGER_BACKFILL_SKIPPED_RISKS_ACK_REQUIRED'
    });
  }
  if (body.requireBackup !== true) {
    throw badRequest('受控执行必须显式确认 requireBackup=true，并在执行前创建备份。', { code: 'LEDGER_BACKFILL_BACKUP_REQUIRED' });
  }
  return {
    previewSignature: body.previewSignature,
    expectedWouldUpdate,
    candidateRecordIds,
    filters: body.filters
  };
}

function loadEnergyRecordLedgerBackfillRowsByIds(db, ids = []) {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT
       id,
       organization_unit_id AS organizationUnitId,
       meter_device_id AS meterDeviceId,
       record_status AS recordStatus
     FROM energy_records
     WHERE id IN (${placeholders})`
  ).all(...ids);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

async function executeEnergyRecordLedgerBackfill(body = {}) {
  assertWritableAllowed('energy-records:ledger-backfill:execute');
  const request = validateLedgerBackfillExecuteRequest(body);
  const preview = getEnergyRecordLedgerBackfillPreview({ ...request.filters, detailLimit: 500, limit: 500, __includeAllItems: true });
  const allPreviewItems = preview._allItems || preview.items || [];
  const executableItems = getExecutableLedgerBackfillItems(allPreviewItems);
  const executableRecordIds = new Set(executableItems.map((item) => Number(item.recordId)));
  const actualCandidateRecordIds = buildLedgerBackfillCandidateRecordIds(executableItems);
  const actualWouldUpdate = Number(preview.summary?.wouldUpdate || 0);

  if (preview.previewSignature !== request.previewSignature) {
    throw badRequest('previewSignature 与最新预演结果不一致，请重新运行预演后再执行。', {
      code: 'LEDGER_BACKFILL_PREVIEW_SIGNATURE_MISMATCH',
      expectedSignature: request.previewSignature,
      actualSignature: preview.previewSignature
    });
  }
  if (actualWouldUpdate !== request.expectedWouldUpdate) {
    throw badRequest('wouldUpdate 数量与最新预演结果不一致，请重新运行预演后再执行。', {
      code: 'LEDGER_BACKFILL_WOULD_UPDATE_MISMATCH',
      expectedWouldUpdate: request.expectedWouldUpdate,
      actualWouldUpdate
    });
  }
  assertSameRecordIds(
    actualCandidateRecordIds,
    request.candidateRecordIds,
    'LEDGER_BACKFILL_CANDIDATE_RECORD_IDS_MISMATCH',
    'candidateRecordIds 与最新预演结果不一致，请重新运行预演后再执行。'
  );

  const backup = await createBackup({ reason: 'ledger-backfill' });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const countsBefore = countEnergyRecordLedgerBackfillState(db);
      const previewRecordIds = allPreviewItems.map((item) => Number(item.recordId)).filter((id) => Number.isSafeInteger(id) && id > 0);
      const beforeRows = loadEnergyRecordLedgerBackfillRowsByIds(db, previewRecordIds);
      const now = new Date().toISOString();
      const updateBoth = db.prepare(
        `UPDATE energy_records
         SET organization_unit_id = COALESCE(organization_unit_id, @organizationUnitId),
             meter_device_id = COALESCE(meter_device_id, @meterDeviceId),
             updated_at = @updatedAt
         WHERE id = @recordId
           AND record_status = 'active'
           AND organization_unit_id IS NULL
           AND meter_device_id IS NULL`
      );
      const updateOrganizationOnly = db.prepare(
        `UPDATE energy_records
         SET organization_unit_id = COALESCE(organization_unit_id, @organizationUnitId),
             updated_at = @updatedAt
         WHERE id = @recordId
           AND record_status = 'active'
           AND organization_unit_id IS NULL`
      );
      const updateMeterOnly = db.prepare(
        `UPDATE energy_records
         SET meter_device_id = COALESCE(meter_device_id, @meterDeviceId),
             updated_at = @updatedAt
         WHERE id = @recordId
           AND record_status = 'active'
           AND meter_device_id IS NULL`
      );

      let updatedRecords = 0;
      let updatedOrganizationUnitId = 0;
      let updatedMeterDeviceId = 0;
      const items = [];
      executableItems.forEach((item) => {
        const candidateOrganizationUnitId = item.candidate?.organizationUnitId || null;
        const candidateMeterDeviceId = item.candidate?.meterDeviceId || null;
        const before = beforeRows.get(Number(item.recordId)) || null;
        let result;
        if (candidateOrganizationUnitId && candidateMeterDeviceId) {
          result = updateBoth.run({ recordId: item.recordId, organizationUnitId: candidateOrganizationUnitId, meterDeviceId: candidateMeterDeviceId, updatedAt: now });
        } else if (candidateOrganizationUnitId) {
          result = updateOrganizationOnly.run({ recordId: item.recordId, organizationUnitId: candidateOrganizationUnitId, updatedAt: now });
        } else if (candidateMeterDeviceId) {
          result = updateMeterOnly.run({ recordId: item.recordId, meterDeviceId: candidateMeterDeviceId, updatedAt: now });
        } else {
          result = { changes: 0 };
        }
        const after = loadEnergyRecordLedgerBackfillRowsByIds(db, [Number(item.recordId)]).get(Number(item.recordId)) || null;
        const changed = Number(result.changes || 0) > 0;
        if (changed) {
          updatedRecords += 1;
          if ((before?.organizationUnitId || null) !== (after?.organizationUnitId || null)) updatedOrganizationUnitId += 1;
          if ((before?.meterDeviceId || null) !== (after?.meterDeviceId || null)) updatedMeterDeviceId += 1;
        }
        items.push(buildLedgerBackfillAuditBeforeAfter(before, after, item, changed ? 'updated' : 'skipped', changed ? 'updated-null-ledger-fields-only' : 'skipped-by-defensive-null-condition'));
      });
      const afterRows = loadEnergyRecordLedgerBackfillRowsByIds(db, previewRecordIds);
      allPreviewItems.forEach((item) => {
        if (executableRecordIds.has(Number(item.recordId))) return;
        const reasonText = Array.isArray(item.reasons) && item.reasons.length > 0
          ? item.reasons.map((reason) => reason.message || reason.code).filter(Boolean).join('；')
          : `skipped-preview-status-${item.status || 'unknown'}`;
        items.push(buildLedgerBackfillAuditBeforeAfter(
          beforeRows.get(Number(item.recordId)) || null,
          afterRows.get(Number(item.recordId)) || null,
          item,
          'skipped',
          reasonText
        ));
      });
      const countsAfter = countEnergyRecordLedgerBackfillState(db);
      return {
        executed: true,
        dryRun: false,
        previewOnly: false,
        writesEnergyRecords: true,
        operation: 'energy-record-ledger-backfill-execute',
        backup,
        previewSignature: preview.previewSignature,
        signatureVersion: preview.signatureVersion,
        filters: preview.filters,
        countsBefore,
        countsAfter,
        updatedRecords,
        updatedOrganizationUnitId,
        updatedMeterDeviceId,
        skippedDefensiveNoop: executableItems.length - updatedRecords,
        skippedAmbiguous: Number(preview.summary?.ambiguous || 0),
        skippedMissing: Number(preview.summary?.missing || 0),
        skippedBlocked: Number(preview.summary?.blocked || 0),
        skippedAlreadyLinked: Number(preview.summary?.alreadyLinked || 0),
        skippedAlreadyPartial: Number(preview.summary?.alreadyPartial || 0),
        summaryBeforeExecute: preview.summary,
        candidateRecordIds: actualCandidateRecordIds,
        items,
        notices: [
          '本次执行只处理最新 preview 中 wouldUpdate=true 且状态为 candidate-by-meter/candidate-by-organization 的 active 记录。',
          'UPDATE 语句包含 NULL 防覆盖条件，已有非空 organization_unit_id / meter_device_id 不会被覆盖。',
          'ambiguous/missing/blocked/alreadyLinked/alreadyPartial 均只统计跳过，不会更新。'
        ]
      };
    });
    return transaction();
  } finally {
    db.close();
  }
}

// 驾驶舱月份参数只接受完整自然年内的 YYYY-MM 起止范围。
const DASHBOARD_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

// 规范化驾驶舱年度摘要范围；无参数时保留原有全月份统计口径。
function normalizeDashboardSummaryRange(query = {}) {
  // 通过属性存在性区分“未传参数”和“传入空值”，避免空参数被静默当成兼容模式。
  const hasStart = Object.prototype.hasOwnProperty.call(query, 'normalizedMonthStart');
  const hasEnd = Object.prototype.hasOwnProperty.call(query, 'normalizedMonthEnd');
  if (!hasStart && !hasEnd) {
    return {
      filteredByMonth: false,
      normalizedMonthStart: null,
      normalizedMonthEnd: null
    };
  }
  if (!hasStart || !hasEnd) {
    throw badRequest('normalizedMonthStart 与 normalizedMonthEnd 必须同时提供。', {
      code: 'DASHBOARD_MONTH_RANGE_REQUIRED'
    });
  }

  // 起止月份统一去除首尾空白后再执行严格格式校验。
  const normalizedMonthStart = String(query.normalizedMonthStart ?? '').trim();
  const normalizedMonthEnd = String(query.normalizedMonthEnd ?? '').trim();
  [
    ['normalizedMonthStart', normalizedMonthStart],
    ['normalizedMonthEnd', normalizedMonthEnd]
  ].forEach(([fieldName, value]) => {
    if (!DASHBOARD_MONTH_PATTERN.test(value)) {
      throw badRequest(`${fieldName} 必须使用 YYYY-MM 格式，且月份范围为 01-12。`, {
        code: 'INVALID_MONTH_FILTER',
        fieldName,
        rawValue: value
      });
    }
  });

  // 驾驶舱年度摘要禁止跨自然年，确保前端年度选择与统计口径一致。
  if (normalizedMonthStart.slice(0, 4) !== normalizedMonthEnd.slice(0, 4)) {
    throw badRequest('中控月份范围必须位于同一自然年。', {
      code: 'INVALID_DASHBOARD_YEAR_RANGE',
      normalizedMonthStart,
      normalizedMonthEnd
    });
  }
  if (normalizedMonthStart > normalizedMonthEnd) {
    throw badRequest('月份范围开始值不能晚于结束值。', {
      code: 'INVALID_MONTH_RANGE',
      normalizedMonthStart,
      normalizedMonthEnd
    });
  }

  return {
    filteredByMonth: true,
    normalizedMonthStart,
    normalizedMonthEnd
  };
}

// 构造无领域权限的明确状态，禁止用空对象伪装成功响应。
function buildUnauthorizedDashboardDomain() {
  return { authorized: false, status: 'forbidden' };
}

// 查询驾驶舱能耗与当前导入审计摘要；月份范围只作用于已授权的 active 能耗记录。
function getDashboardSummary(query = {}, access = {}) {
  // 即使当前账号无能耗权限，也保留原有月份参数校验契约。
  const range = normalizeDashboardSummaryRange(query);
  const energyAuthorized = access.energyAuthorized === true;
  const importsAuthorized = access.importsAuthorized === true;
  const energyRangeSql = range.filteredByMonth
    ? ' AND er.normalized_month >= @normalizedMonthStart AND er.normalized_month <= @normalizedMonthEnd'
    : '';
  const energyRangeParams = range.filteredByMonth
    ? {
        normalizedMonthStart: range.normalizedMonthStart,
        normalizedMonthEnd: range.normalizedMonthEnd
      }
    : {};
  const db = openDatabase();
  try {
    let energy = buildUnauthorizedDashboardDomain();
    if (energyAuthorized) {
      // 兼容总量保留旧有跨单位直接求和口径，新页面不得将其作为权威总量展示。
      const energySummary = db.prepare(
        `SELECT
           COUNT(er.id) AS activeRecordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COUNT(DISTINCT et.code) AS energyTypeCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd,
           MAX(er.created_at) AS latestRecordAt
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         WHERE er.record_status = 'active'${energyRangeSql}`
      ).get(energyRangeParams);
      // 单位安全总量按能源类型编码与标准化单位分组，是驾驶舱能耗合计的权威字段。
      const totals = db.prepare(
        `SELECT
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.normalized_unit AS normalizedUnit,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         WHERE er.record_status = 'active'${energyRangeSql}
         GROUP BY et.code, et.name, er.normalized_unit, et.display_order
         ORDER BY et.display_order ASC, et.code ASC, er.normalized_unit ASC`
      ).all(energyRangeParams).map((row) => ({
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
        monthRange: {
          start: energySummary.monthStart,
          end: energySummary.monthEnd
        },
        scope: {
          filteredByMonth: range.filteredByMonth,
          normalizedMonthStart: range.normalizedMonthStart,
          normalizedMonthEnd: range.normalizedMonthEnd,
          recordStatus: 'active'
        }
      };
    }

    let imports = buildUnauthorizedDashboardDomain();
    let errors = buildUnauthorizedDashboardDomain();
    if (importsAuthorized) {
      // 导入批次始终表示当前全量审计摘要，不按驾驶舱能耗年份过滤。
      const batches = db.prepare(
        `SELECT
           COUNT(*) AS batchCount,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedBatchCount,
           SUM(CASE WHEN status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completedWithErrorsBatchCount,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedBatchCount,
           COALESCE(SUM(success_count), 0) AS importedRowCount,
           COALESCE(SUM(failure_count), 0) AS failedRowCount,
           COALESCE(SUM(skipped_count), 0) AS skippedRowCount,
           MAX(created_at) AS latestBatchAt
         FROM import_batches`
      ).get();
      // 导入错误同样保持全量审计口径，不受能耗月份范围影响。
      const importErrors = db.prepare(
        `SELECT
           COUNT(*) AS importErrorCount,
           SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) AS blockingErrorCount,
           SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warningCount
         FROM import_errors`
      ).get();
      imports = {
        authorized: true,
        status: Number(batches.batchCount || 0) > 0 ? 'available' : 'empty',
        ...batches,
        completedBatchCount: Number(batches.completedBatchCount || 0),
        completedWithErrorsBatchCount: Number(batches.completedWithErrorsBatchCount || 0),
        failedBatchCount: Number(batches.failedBatchCount || 0),
        importedRowCount: Number(batches.importedRowCount || 0),
        failedRowCount: Number(batches.failedRowCount || 0),
        skippedRowCount: Number(batches.skippedRowCount || 0),
        scope: 'all-import-audit-history'
      };
      errors = {
        authorized: true,
        status: Number(importErrors.importErrorCount || 0) > 0 ? 'available' : 'empty',
        ...importErrors,
        blockingErrorCount: Number(importErrors.blockingErrorCount || 0),
        warningCount: Number(importErrors.warningCount || 0),
        scope: 'all-import-audit-history'
      };
    }

    // 时间口径提示只描述当前账号已获授权的领域，避免把未授权数据伪装成空数据。
    const timeScopeNotices = [];
    if (energyAuthorized) {
      timeScopeNotices.push(range.filteredByMonth
        ? `中控能耗摘要仅统计 ${range.normalizedMonthStart} 至 ${range.normalizedMonthEnd} 的 active 能耗记录。`
        : '中控能耗摘要统计全部月份的 active 能耗记录。');
    }
    if (importsAuthorized) {
      timeScopeNotices.push(range.filteredByMonth
        ? '导入批次与导入错误为当前全量审计摘要，不随该月份范围过滤。'
        : '导入批次与导入错误为当前全量审计摘要。');
    }

    return {
      scope: 'energy-records-and-imports-only',
      excludes: ['carbon-accounting', 'prediction', 'energy-budget', 'meter-ledger'],
      energy,
      imports,
      errors,
      notices: [
        ...timeScopeNotices,
        ...(energyAuthorized ? ['energy.totals 按能源类型和标准化单位分组，是中控能耗合计的权威字段；totalNormalizedValue 仅为旧契约兼容字段，不用于混合单位展示。'] : []),
        '本接口不包含碳核算、预测、用能预算、计量器具聚合或伪造图表数据。'
      ]
    };
  } finally {
    db.close();
  }
}

module.exports = {
  executeEnergyRecordLedgerBackfill,
  exportEnergyRecords,
  exportEnergyRecordLedgerBackfillPreview,
  getDashboardSummary,
  getDimensionBreakdown,
  getEnergyRecordSummary,
  getEnergyRecordLedgerBackfillPreview,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords,
  normalizeBreakdownLimit
};
