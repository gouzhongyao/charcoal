const crypto = require('crypto');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const backupService = require('./backupService');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssues,
  updateExecuteAuditResult
} = require('./importAuditService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const GENERATION_RECORD_STATUSES = Object.freeze(['active', 'void']);
const GENERATION_DATA_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);
const PHOTOVOLTAIC_ENERGY_TYPE_CODE = 'photovoltaic';
const ELECTRICITY_ENERGY_TYPE_CODE = 'electricity';
const UTF8_BOM = '﻿';
const MAX_GENERATION_RECORD_EXPORT_ROWS = 5000;
const GENERATION_RECORD_IMPORT_CONFIRM_TEXT = '确认导入发电自用记录';
const GENERATION_RECORD_IMPORT_BACKUP_REASON = 'generation-record-import';
const GENERATION_RECORD_IMPORT_SIGNATURE_VERSION = 'generation-record-import-preview:v1';
const GENERATION_RECORD_IMPORT_HMAC_ALGORITHM = 'sha256';
const GENERATION_RECORD_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v1';
const GENERATION_RECORD_IMPORT_AUDIT_DIGEST_PREFIX = 'hmac-sha256:v1:audit';
const GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY = 'generation_record_import_hmac_secret';
const GENERATION_RECORD_IMPORT_STATUSES = Object.freeze(['wouldImport', 'skipped', 'blocked']);
const GENERATION_RECORD_IMPORT_TEMPLATE_ID = 'generation-records';
const GENERATION_RECORD_IMPORT_HEADERS = Object.freeze(['用能单元编码', '用能单元名称', '月份', '发电量 kWh', '自发自用 kWh', '上网电量 kWh', '数据来源', '备注']);
const GENERATION_RECORD_EXPORT_FIELDS = Object.freeze([
  { key: 'organizationUnitCode', header: '用能单元编码' },
  { key: 'organizationUnitName', header: '用能单元名称' },
  { key: 'organizationUnitPath', header: '用能单元路径' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型' },
  { key: 'generationValueKwh', header: '发电量 kWh' },
  { key: 'selfUseValueKwh', header: '自发自用 kWh' },
  { key: 'gridExportValueKwh', header: '上网电量 kWh' },
  { key: 'selfUseRate', header: '自用率' },
  { key: 'gridExportRate', header: '上网率' },
  { key: 'dataSource', header: '数据来源' },
  { key: 'recordStatus', header: '状态' },
  { key: 'remark', header: '备注' },
  { key: 'createdAt', header: '创建时间' },
  { key: 'updatedAt', header: '更新时间' }
]);
const GENERATION_RECORD_IMPORT_ALIASES = Object.freeze({
  organizationUnitCode: ['organization_unit_code', 'organizationUnitCode', 'unit_code', 'unitCode', '用能单元编码', '组织单元编码'],
  organizationUnitName: ['organization_unit_name', 'organizationUnitName', 'unit_name', 'unitName', 'organization_unit', '用能单元名称', '用能单元', '组织单元名称'],
  normalizedMonth: ['normalized_month', 'normalizedMonth', 'month', 'period', '月份', '统计月份', '归属月份'],
  generationValueKwh: ['generation_value_kwh', 'generationValueKwh', 'generationValue', 'generation_value', '发电量 kWh', '发电量', '光伏发电量'],
  selfUseValueKwh: ['self_use_value_kwh', 'selfUseValueKwh', 'selfUseValue', 'self_use_value', '自发自用 kWh', '自发自用', '自用电量'],
  gridExportValueKwh: ['grid_export_value_kwh', 'gridExportValueKwh', 'gridExportValue', 'grid_export_value', '上网电量 kWh', '上网电量', '余电上网'],
  dataSource: ['data_source', 'dataSource', '数据来源', '来源'],
  remark: ['remark', '备注', '说明', 'note']
});

function getNow() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function getOrCreateGenerationRecordImportHmacSecret() {
  const db = openDatabase();
  try {
    const existing = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY);
    if (normalizeText(existing?.value)) {
      return existing.value;
    }

    const generatedSecret = crypto.randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO NOTHING`
    ).run(GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY, generatedSecret);
    const saved = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY);
    return normalizeText(saved?.value) || generatedSecret;
  } finally {
    db.close();
  }
}

function getGenerationRecordImportHmacSecret() {
  return normalizeText(process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET)
    || normalizeText(process.env.CHARCOAL_HMAC_SECRET)
    || normalizeText(process.env.APP_SECRET)
    || getOrCreateGenerationRecordImportHmacSecret();
}

function hmacJson(value) {
  return crypto
    .createHmac(GENERATION_RECORD_IMPORT_HMAC_ALGORITHM, getGenerationRecordImportHmacSecret())
    .update(stableStringify(value))
    .digest('hex');
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function assertWhitelist(value, fieldName, allowedValues, code = 'UNSUPPORTED_GENERATION_VALUE') {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, {
      code,
      fieldName,
      rawValue: value,
      allowedValues
    });
  }
}

function parsePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    if (options.required) {
      throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
    }
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parseNonNegativeNumber(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    if (options.required) {
      throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
    }
    return options.fallback;
  }
  const numberValue = Number(text.replace ? text.replace(/,/g, '') : text);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw badRequest(`${fieldName} 必须是大于等于 0 的数字。`, { code: 'INVALID_NON_NEGATIVE_NUMBER', fieldName, rawValue: text });
  }
  return numberValue;
}

function normalizeMonth(value, fieldName = 'normalizedMonth') {
  const text = normalizeText(value);
  if (!text) {
    throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
  }
  const normalized = text.replace(/[./]/g, '-');
  const month = /^\d{4}-\d{1,2}$/.test(normalized)
    ? normalized.replace(/^(\d{4})-(\d{1})$/, '$1-0$2')
    : normalized.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw badRequest(`${fieldName} 必须是 YYYY-MM 格式。`, { code: 'INVALID_MONTH', fieldName, rawValue: text });
  }
  return month;
}

function normalizeOptionalMonth(value, fieldName) {
  const text = normalizeText(value);
  return text ? normalizeMonth(text, fieldName) : null;
}

function normalizePagination(query = {}, defaults = {}) {
  const page = parsePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = parsePositiveInteger(query.pageSize, 'pageSize') || defaults.pageSize || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, defaults.maxPageSize || MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function getOrganizationUnitById(db, organizationUnitId) {
  const row = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units
     WHERE id = ?`
  ).get(organizationUnitId);
  if (!row) {
    throw notFound('用能单元不存在。', { id: organizationUnitId });
  }
  return row;
}

function ensureActiveOrganizationUnit(db, organizationUnitId) {
  const organizationUnit = getOrganizationUnitById(db, organizationUnitId);
  if (organizationUnit.status !== 'active') {
    throw badRequest('发电记录所属用能单元必须为 active 状态。', {
      code: 'INACTIVE_ORGANIZATION_UNIT',
      organizationUnitId
    });
  }
  return organizationUnit;
}

function getEnergyTypeById(db, energyTypeId) {
  const row = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE id = ?`
  ).get(energyTypeId);
  if (!row) {
    throw notFound('能源类型不存在。', { id: energyTypeId });
  }
  return row;
}

function getEnergyTypeByCode(db, code) {
  const row = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE code = ?`
  ).get(code);
  if (!row) {
    throw badRequest('未找到 photovoltaic / 光伏能源类型，请先初始化能源类型字典。', {
      code: 'PHOTOVOLTAIC_ENERGY_TYPE_MISSING',
      energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE
    });
  }
  return row;
}

function ensurePhotovoltaicEnergyType(db, input = {}, existing = {}) {
  const energyTypeIdRaw = firstDefined(input, ['energyTypeId', 'energy_type_id']);
  if (energyTypeIdRaw !== undefined && energyTypeIdRaw !== null && String(energyTypeIdRaw).trim() !== '') {
    const energyTypeId = parsePositiveInteger(energyTypeIdRaw, 'energyTypeId', { required: true });
    const energyType = getEnergyTypeById(db, energyTypeId);
    if (energyType.code !== PHOTOVOLTAIC_ENERGY_TYPE_CODE) {
      throw badRequest('发电记录首期仅支持 photovoltaic / 光伏能源类型。', {
        code: 'GENERATION_ENERGY_TYPE_PHOTOVOLTAIC_ONLY',
        energyTypeId,
        energyTypeCode: energyType.code
      });
    }
    if (Number(energyType.isActive) !== 1) {
      throw badRequest('photovoltaic / 光伏能源类型不是 active 状态。', {
        code: 'INACTIVE_PHOTOVOLTAIC_ENERGY_TYPE',
        energyTypeId
      });
    }
    return energyType;
  }

  const energyTypeCode = normalizeText(firstDefined(input, ['energyTypeCode', 'energy_type_code']));
  if (energyTypeCode && energyTypeCode !== PHOTOVOLTAIC_ENERGY_TYPE_CODE) {
    throw badRequest('发电记录首期仅支持 photovoltaic / 光伏能源类型。', {
      code: 'GENERATION_ENERGY_TYPE_PHOTOVOLTAIC_ONLY',
      energyTypeCode
    });
  }
  if (!energyTypeCode && existing.energyTypeId) {
    return ensurePhotovoltaicEnergyType(db, { energyTypeId: existing.energyTypeId });
  }
  const energyType = getEnergyTypeByCode(db, PHOTOVOLTAIC_ENERGY_TYPE_CODE);
  if (Number(energyType.isActive) !== 1) {
    throw badRequest('photovoltaic / 光伏能源类型不是 active 状态。', {
      code: 'INACTIVE_PHOTOVOLTAIC_ENERGY_TYPE',
      energyTypeId: energyType.id
    });
  }
  return energyType;
}

function validateGenerationBalance(payload) {
  if (payload.selfUseValueKwh + payload.gridExportValueKwh > payload.generationValueKwh + 0.000001) {
    throw badRequest('selfUseValueKwh + gridExportValueKwh 不能大于 generationValueKwh。', {
      code: 'GENERATION_BALANCE_EXCEEDED',
      generationValueKwh: payload.generationValueKwh,
      selfUseValueKwh: payload.selfUseValueKwh,
      gridExportValueKwh: payload.gridExportValueKwh
    });
  }
}

function normalizeGenerationPayload(input = {}, options = {}) {
  const existing = options.existing || {};
  const organizationUnitRaw = firstDefined(input, ['organizationUnitId', 'organization_unit_id']);
  const organizationUnitId = organizationUnitRaw === undefined || organizationUnitRaw === null || String(organizationUnitRaw).trim() === ''
    ? existing.organizationUnitId || null
    : parsePositiveInteger(organizationUnitRaw, 'organizationUnitId', { required: true });
  const monthRaw = firstDefined(input, ['normalizedMonth', 'normalized_month', 'month']);
  const normalizedMonth = monthRaw === undefined || monthRaw === null || String(monthRaw).trim() === ''
    ? existing.normalizedMonth || null
    : normalizeMonth(monthRaw, 'normalizedMonth');
  const generationRaw = firstDefined(input, ['generationValueKwh', 'generation_value_kwh', 'generationValue', 'generation_value']);
  const generationValueKwh = generationRaw === undefined || generationRaw === null || String(generationRaw).trim() === ''
    ? (existing.generationValueKwh ?? null)
    : parseNonNegativeNumber(generationRaw, 'generationValueKwh', { required: true });
  const selfUseRaw = firstDefined(input, ['selfUseValueKwh', 'self_use_value_kwh', 'selfUseValue', 'self_use_value']);
  const selfUseValueKwh = selfUseRaw === undefined || selfUseRaw === null || String(selfUseRaw).trim() === ''
    ? (existing.selfUseValueKwh ?? 0)
    : parseNonNegativeNumber(selfUseRaw, 'selfUseValueKwh', { required: true });
  const gridExportRaw = firstDefined(input, ['gridExportValueKwh', 'grid_export_value_kwh', 'gridExportValue', 'grid_export_value']);
  const gridExportValueKwh = gridExportRaw === undefined || gridExportRaw === null || String(gridExportRaw).trim() === ''
    ? (existing.gridExportValueKwh ?? 0)
    : parseNonNegativeNumber(gridExportRaw, 'gridExportValueKwh', { required: true });
  const dataSource = normalizeText(firstDefined(input, ['dataSource', 'data_source'])) || existing.dataSource || 'manual';
  const recordStatus = normalizeText(firstDefined(input, ['recordStatus', 'record_status', 'status'])) || existing.recordStatus || 'active';

  if (!organizationUnitId) throw badRequest('organizationUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'organizationUnitId' });
  if (!normalizedMonth) throw badRequest('normalizedMonth 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'normalizedMonth' });
  if (generationValueKwh === null || generationValueKwh === undefined) throw badRequest('generationValueKwh 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'generationValueKwh' });
  assertWhitelist(dataSource, 'dataSource', GENERATION_DATA_SOURCES);
  assertWhitelist(recordStatus, 'recordStatus', GENERATION_RECORD_STATUSES);

  const payload = {
    organizationUnitId,
    energyTypeId: existing.energyTypeId || null,
    normalizedMonth,
    generationValueKwh,
    selfUseValueKwh,
    gridExportValueKwh,
    dataSource,
    recordStatus,
    remark: Object.prototype.hasOwnProperty.call(input, 'remark') ? normalizeText(input.remark) : (existing.remark || null)
  };
  validateGenerationBalance(payload);
  return payload;
}

function mapGenerationRecordRow(row) {
  if (!row) return row;
  const generationValueKwh = Number(row.generationValueKwh || 0);
  const selfUseValueKwh = Number(row.selfUseValueKwh || 0);
  const gridExportValueKwh = Number(row.gridExportValueKwh || 0);
  return {
    id: row.id,
    organizationUnitId: row.organizationUnitId,
    organizationUnitCode: row.organizationUnitCode,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    normalizedMonth: row.normalizedMonth,
    generationValueKwh,
    selfUseValueKwh,
    gridExportValueKwh,
    selfUseRate: generationValueKwh > 0 ? selfUseValueKwh / generationValueKwh : null,
    gridExportRate: generationValueKwh > 0 ? gridExportValueKwh / generationValueKwh : null,
    dataSource: row.dataSource,
    recordStatus: row.recordStatus,
    remark: row.remark,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getGenerationRecordById(db, recordId) {
  const row = db.prepare(
    `SELECT
       gr.id,
       gr.organization_unit_id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       gr.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       gr.normalized_month AS normalizedMonth,
       gr.generation_value_kwh AS generationValueKwh,
       gr.self_use_value_kwh AS selfUseValueKwh,
       gr.grid_export_value_kwh AS gridExportValueKwh,
       gr.data_source AS dataSource,
       gr.record_status AS recordStatus,
       gr.remark,
       gr.void_reason AS voidReason,
       gr.voided_at AS voidedAt,
       gr.created_at AS createdAt,
       gr.updated_at AS updatedAt
     FROM generation_records gr
     JOIN organization_units ou ON ou.id = gr.organization_unit_id
     JOIN energy_types et ON et.id = gr.energy_type_id
     WHERE gr.id = ?`
  ).get(recordId);
  if (!row) {
    throw notFound('发电记录不存在。', { id: recordId });
  }
  return row;
}

function ensureActiveGenerationUnique(db, organizationUnitId, normalizedMonth, energyTypeId, excludeId) {
  const existing = db.prepare(
    `SELECT id
     FROM generation_records
     WHERE organization_unit_id = ?
       AND normalized_month = ?
       AND energy_type_id = ?
       AND record_status = 'active'
       AND (? IS NULL OR id <> ?)
     LIMIT 1`
  ).get(organizationUnitId, normalizedMonth, energyTypeId, excludeId || null, excludeId || null);
  if (existing) {
    throw badRequest('同一用能单元、同一月份、同一能源类型只能存在一条 active 发电记录。', {
      code: 'DUPLICATE_ACTIVE_GENERATION_RECORD',
      organizationUnitId,
      normalizedMonth,
      energyTypeId,
      existingId: existing.id
    });
  }
}

function normalizeGenerationRecordId(value) {
  return parsePositiveInteger(value, 'id', { required: true });
}

function isGenerationUniqueConstraintError(error) {
  return error && (
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || /ux_generation_records_active_org_month_energy|UNIQUE constraint failed/i.test(error.message || '')
  );
}

function throwGenerationUniqueConstraintError() {
  throw badRequest('同一用能单元、同一月份、同一能源类型只能存在一条 active 发电记录。', {
    code: 'DUPLICATE_ACTIVE_GENERATION_RECORD'
  });
}

function buildGenerationWhere(query = {}, db = null) {
  const where = [];
  const params = {};
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('gr.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const status = normalizeText(firstDefined(query, ['recordStatus', 'record_status', 'status']));
  if (status) {
    assertWhitelist(status, 'recordStatus', GENERATION_RECORD_STATUSES);
    where.push('gr.record_status = @recordStatus');
    params.recordStatus = status;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(ou.unit_code LIKE @keyword OR ou.unit_name LIKE @keyword OR ou.unit_path LIKE @keyword OR gr.remark LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'normalizedMonthStart', 'month_start']), 'monthStart');
  if (monthStart) {
    where.push('gr.normalized_month >= @monthStart');
    params.monthStart = monthStart;
  }
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'normalizedMonthEnd', 'month_end']), 'monthEnd');
  if (monthEnd) {
    where.push('gr.normalized_month <= @monthEnd');
    params.monthEnd = monthEnd;
  }
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  if (db) {
    const energyType = ensurePhotovoltaicEnergyType(db, query);
    where.push('gr.energy_type_id = @energyTypeId');
    params.energyTypeId = energyType.id;
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function selectGenerationRows(db, query = {}, limit = 500, offset = 0) {
  const { whereSql, params } = buildGenerationWhere(query, db);
  return db.prepare(
    `SELECT
       gr.id,
       gr.organization_unit_id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       gr.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       gr.normalized_month AS normalizedMonth,
       gr.generation_value_kwh AS generationValueKwh,
       gr.self_use_value_kwh AS selfUseValueKwh,
       gr.grid_export_value_kwh AS gridExportValueKwh,
       gr.data_source AS dataSource,
       gr.record_status AS recordStatus,
       gr.remark,
       gr.void_reason AS voidReason,
       gr.voided_at AS voidedAt,
       gr.created_at AS createdAt,
       gr.updated_at AS updatedAt
     FROM generation_records gr
     JOIN organization_units ou ON ou.id = gr.organization_unit_id
     JOIN energy_types et ON et.id = gr.energy_type_id
     ${whereSql}
     ORDER BY gr.normalized_month DESC, gr.id DESC
     LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map(mapGenerationRecordRow);
}

function listGenerationRecords(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 100, maxPageSize: 500 });
  const db = openDatabase();
  try {
    const { whereSql, params } = buildGenerationWhere(query, db);
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM generation_records gr
       JOIN organization_units ou ON ou.id = gr.organization_unit_id
       JOIN energy_types et ON et.id = gr.energy_type_id
       ${whereSql}`
    ).get(params).total;
    const rows = selectGenerationRows(db, query, pageSize, offset);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function buildGenerationRecordExportRows(rows = []) {
  return rows.map((row) => {
    const output = {};
    GENERATION_RECORD_EXPORT_FIELDS.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
}

function exportGenerationRecords(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const db = openDatabase();
  try {
    const rows = selectGenerationRows(db, query, MAX_GENERATION_RECORD_EXPORT_ROWS, 0);
    const exportRows = buildGenerationRecordExportRows(rows);
    const headers = GENERATION_RECORD_EXPORT_FIELDS.map((field) => field.header);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `发电自用记录导出-${date}.${format}`;
    if (format === 'csv') {
      const csvLines = [headers, ...exportRows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsvCell).join(','));
      return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${UTF8_BOM}${csvLines.join('\n')}\n`, 'utf8'), rowCount: rows.length, fields: headers, maxRows: MAX_GENERATION_RECORD_EXPORT_ROWS };
    }
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
    worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 12), 32) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, '发电自用记录');
    return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers, maxRows: MAX_GENERATION_RECORD_EXPORT_ROWS };
  } finally {
    db.close();
  }
}

function normalizeHeaderName(value) {
  return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase();
}

function canonicalGenerationRecordImportFieldName(header) {
  const normalized = normalizeHeaderName(header);
  for (const [field, aliases] of Object.entries(GENERATION_RECORD_IMPORT_ALIASES)) {
    if (aliases.map(normalizeHeaderName).includes(normalized)) return field;
  }
  return null;
}

function mapGenerationRecordImportFields(row = {}) {
  const mapped = {};
  const fieldMapping = {};
  Object.entries(row || {}).forEach(([header, value]) => {
    const field = canonicalGenerationRecordImportFieldName(header);
    if (!field) return;
    if (Object.prototype.hasOwnProperty.call(mapped, field) && normalizeText(mapped[field])) return;
    mapped[field] = value;
    fieldMapping[field] = header;
  });
  return { mapped, fieldMapping };
}

function createGenerationRecordImportIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return { rowNumber, fieldName, rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue), code, message, severity };
}

function summarizeGenerationRecordImportItems(items = []) {
  const summary = {
    totalRows: items.length,
    wouldImport: 0,
    skipped: 0,
    blocked: 0,
    warnings: 0,
    errors: 0
  };
  items.forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
      summary[item.status] += 1;
    }
    (item.reasons || []).forEach((reason) => {
      if (reason.severity === 'warning') summary.warnings += 1;
      else if (reason.severity === 'error') summary.errors += 1;
    });
  });
  return summary;
}

function normalizeGenerationRecordImportCandidateRow(row = {}) {
  const dataSource = normalizeText(row.dataSource) || 'upload';
  return {
    candidateRowId: normalizeText(row.candidateRowId) || `generation:${row.organizationUnitId}:${row.normalizedMonth}:${row.energyTypeCode || PHOTOVOLTAIC_ENERGY_TYPE_CODE}`,
    rowNumber: Number(row.rowNumber || row.rowId || 0),
    organizationUnitId: Number(row.organizationUnitId || 0),
    organizationUnitCode: normalizeText(row.organizationUnitCode),
    organizationUnitName: normalizeText(row.organizationUnitName),
    normalizedMonth: normalizeText(row.normalizedMonth),
    energyTypeCode: normalizeText(row.energyTypeCode) || PHOTOVOLTAIC_ENERGY_TYPE_CODE,
    generationValueKwh: Number(row.generationValueKwh || 0),
    selfUseValueKwh: Number(row.selfUseValueKwh || 0),
    gridExportValueKwh: Number(row.gridExportValueKwh || 0),
    dataSource,
    remark: normalizeText(row.remark)
  };
}

function buildGenerationRecordImportSignaturePayload(input = {}) {
  const candidateRows = (input.candidateRows || [])
    .map(normalizeGenerationRecordImportCandidateRow)
    .sort((left, right) => {
      if (left.rowNumber !== right.rowNumber) return left.rowNumber - right.rowNumber;
      return String(left.candidateRowId).localeCompare(String(right.candidateRowId));
    });
  const candidateRowIds = (input.candidateRowIds || candidateRows.map((row) => row.rowNumber))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    version: GENERATION_RECORD_IMPORT_SIGNATURE_VERSION,
    algorithm: `HMAC-${GENERATION_RECORD_IMPORT_HMAC_ALGORITHM}`,
    operation: 'generation-record-import',
    importType: GENERATION_RECORD_IMPORT_TEMPLATE_ID,
    duplicateStrategy: 'skip',
    targetTable: 'generation_records',
    energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE,
    defaultDataSource: 'upload',
    writesGenerationRecords: input.writesGenerationRecords === true,
    persistsImportBatch: input.persistsImportBatch === true,
    requireBackup: true,
    backupReason: normalizeText(input.backupReason) || GENERATION_RECORD_IMPORT_BACKUP_REASON,
    confirmText: normalizeText(input.confirmText) || GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
    candidateRowIds,
    candidateRows
  };
}

function buildGenerationRecordImportPreviewSignature(input = {}) {
  return `${GENERATION_RECORD_IMPORT_SIGNATURE_PREFIX}:${hmacJson(buildGenerationRecordImportSignaturePayload(input))}`;
}

function normalizeGenerationRecordImportPreviewAudit(input = {}) {
  const summary = input.summary || {};
  const items = Array.isArray(input.items) ? input.items : [];
  return {
    version: `${GENERATION_RECORD_IMPORT_SIGNATURE_VERSION}:audit`,
    operation: 'generation-record-import-audit',
    importType: GENERATION_RECORD_IMPORT_TEMPLATE_ID,
    summary: {
      totalRows: Number(summary.totalRows || 0),
      wouldImport: Number(summary.wouldImport || 0),
      skipped: Number(summary.skipped || 0),
      blocked: Number(summary.blocked || 0),
      warnings: Number(summary.warnings || 0),
      errors: Number(summary.errors || 0)
    },
    items: items.map((item) => ({
      rowNumber: Number(item.rowNumber || item.rowId || 0),
      rowId: Number(item.rowId || item.rowNumber || 0),
      status: normalizeText(item.status),
      wouldImport: item.wouldImport === true,
      organizationUnitId: item.organizationUnitId === undefined || item.organizationUnitId === null ? null : Number(item.organizationUnitId),
      organizationUnitCode: normalizeText(item.organizationUnitCode || item.values?.organizationUnitCode),
      organizationUnitName: normalizeText(item.organizationUnitName || item.values?.organizationUnitName),
      organizationUnitPath: normalizeText(item.organizationUnitPath || item.values?.organizationUnitPath),
      normalizedMonth: normalizeText(item.normalizedMonth || item.values?.normalizedMonth),
      energyTypeCode: normalizeText(item.energyTypeCode) || PHOTOVOLTAIC_ENERGY_TYPE_CODE,
      generationValueKwh: item.generationValueKwh === undefined || item.generationValueKwh === null ? null : Number(item.generationValueKwh),
      selfUseValueKwh: item.selfUseValueKwh === undefined || item.selfUseValueKwh === null ? null : Number(item.selfUseValueKwh),
      gridExportValueKwh: item.gridExportValueKwh === undefined || item.gridExportValueKwh === null ? null : Number(item.gridExportValueKwh),
      dataSource: normalizeText(item.dataSource || item.values?.dataSource) || 'upload',
      remark: normalizeText(item.remark || item.values?.remark),
      existingRecordId: item.existingRecordId || null,
      reasonCodes: normalizeText(item.reasonCodes),
      reasonText: normalizeText(item.reasonText),
      reasons: (item.reasons || []).map((reason) => ({
        rowNumber: Number(reason.rowNumber || item.rowNumber || 0),
        fieldName: normalizeText(reason.fieldName),
        rawValue: reason.rawValue === undefined || reason.rawValue === null ? null : String(reason.rawValue),
        code: normalizeText(reason.code),
        message: normalizeText(reason.message),
        severity: normalizeText(reason.severity) || 'error'
      }))
    })).sort((left, right) => {
      if (left.rowNumber !== right.rowNumber) return left.rowNumber - right.rowNumber;
      return String(left.status || '').localeCompare(String(right.status || ''));
    })
  };
}

function buildGenerationRecordImportPreviewAuditDigest(input = {}) {
  return `${GENERATION_RECORD_IMPORT_AUDIT_DIGEST_PREFIX}:${hmacJson(normalizeGenerationRecordImportPreviewAudit(input))}`;
}

function verifyGenerationRecordImportPreviewAuditDigest(previewAudit, digest) {
  return timingSafeEqualText(digest, buildGenerationRecordImportPreviewAuditDigest(previewAudit));
}

function timingSafeEqualText(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifyGenerationRecordImportPreviewSignature(preview, previewSignature) {
  return timingSafeEqualText(previewSignature, buildGenerationRecordImportPreviewSignature(preview));
}

function buildGenerationRecordImportIndexes(input = {}) {
  const unitsByCode = new Map();
  const unitsByName = new Map();
  (input.organizationUnits || []).forEach((unit) => {
    if (unit.unitCode) unitsByCode.set(String(unit.unitCode), unit);
    if (unit.unitName) {
      const list = unitsByName.get(String(unit.unitName)) || [];
      list.push(unit);
      unitsByName.set(String(unit.unitName), list);
    }
  });
  const activeRecordByUnitMonthEnergy = new Map();
  (input.activeRecords || []).forEach((record) => {
    activeRecordByUnitMonthEnergy.set(`${record.organizationUnitId} ${record.normalizedMonth} ${record.energyTypeId}`, record);
  });
  return { unitsByCode, unitsByName, activeRecordByUnitMonthEnergy };
}

function loadGenerationRecordImportIndexes(db) {
  const energyType = ensurePhotovoltaicEnergyType(db, {});
  return {
    energyType,
    ...buildGenerationRecordImportIndexes({
      organizationUnits: db.prepare(
        `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
         FROM organization_units`
      ).all(),
      activeRecords: db.prepare(
        `SELECT gr.id, gr.organization_unit_id AS organizationUnitId, gr.normalized_month AS normalizedMonth, gr.energy_type_id AS energyTypeId
         FROM generation_records gr
         JOIN energy_types et ON et.id = gr.energy_type_id
         WHERE gr.record_status = 'active' AND et.code = ?`
      ).all(PHOTOVOLTAIC_ENERGY_TYPE_CODE)
    })
  };
}

function readRequiredGenerationImportText(mapped, field, rowNumber, label, errors) {
  const value = normalizeText(mapped[field]);
  if (!value) {
    errors.push(createGenerationRecordImportIssue(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${label || field} 为空或未映射。`));
    return null;
  }
  return value;
}

function normalizeGenerationImportMonth(value, rowNumber, errors) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  try {
    return normalizeMonth(value, 'normalizedMonth');
  } catch (error) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'normalizedMonth', value, error?.details?.code || 'INVALID_MONTH', error.message || '月份必须是 YYYY-MM 格式。'));
    return null;
  }
}

function parseGenerationImportNonNegativeNumber(mapped, field, rowNumber, label, errors) {
  if (!normalizeText(mapped[field])) {
    errors.push(createGenerationRecordImportIssue(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${label || field} 为空或未映射。`));
    return null;
  }
  try {
    return parseNonNegativeNumber(mapped[field], field, { required: true });
  } catch (error) {
    errors.push(createGenerationRecordImportIssue(rowNumber, field, mapped[field], error?.details?.code || 'INVALID_NON_NEGATIVE_NUMBER', error.message || `${field} 必须大于等于 0。`));
    return null;
  }
}

function resolveGenerationImportOrganizationUnit(mapped, rowNumber, indexes, errors) {
  const unitCode = normalizeText(mapped.organizationUnitCode);
  const unitName = normalizeText(mapped.organizationUnitName);
  if (!unitCode) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'REQUIRED_FIELD_MISSING', '用能单元编码为必填项；用能单元名称仅用于辅助校验和展示，不能替代编码匹配。'));
    return null;
  }
  const organizationUnit = indexes.unitsByCode.get(unitCode) || null;
  if (!organizationUnit) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'organizationUnitCode', unitCode, 'UNKNOWN_ORGANIZATION_UNIT', '未找到匹配用能单元；发电导入不自动创建用能单元。'));
  }
  if (organizationUnit && organizationUnit.status !== 'active') {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'organizationUnitCode', unitCode, 'INACTIVE_ORGANIZATION_UNIT', '用能单元不是 active 状态，禁止导入 active 发电记录。'));
  }
  if (organizationUnit && unitName && unitName !== organizationUnit.unitName) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'organizationUnitName', unitName, 'ORGANIZATION_UNIT_NAME_MISMATCH', '填写的用能单元名称与编码匹配结果不一致。'));
  }
  return organizationUnit;
}

function validateAndNormalizeGenerationRecordImportRow(row, rowNumber, indexes, seenImportKeys = new Set()) {
  const { mapped, fieldMapping } = mapGenerationRecordImportFields(row);
  const errors = [];
  const organizationUnit = resolveGenerationImportOrganizationUnit(mapped, rowNumber, indexes, errors);
  const unitCode = normalizeText(mapped.organizationUnitCode);
  const unitName = normalizeText(mapped.organizationUnitName);
  let normalizedMonthValue = null;
  if (!normalizeText(mapped.normalizedMonth) && !(mapped.normalizedMonth instanceof Date)) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'normalizedMonth', mapped.normalizedMonth, 'REQUIRED_FIELD_MISSING', '必填字段 normalizedMonth 为空或未映射。'));
  } else {
    normalizedMonthValue = normalizeGenerationImportMonth(mapped.normalizedMonth, rowNumber, errors);
  }
  const generationValueKwh = parseGenerationImportNonNegativeNumber(mapped, 'generationValueKwh', rowNumber, 'generationValueKwh', errors);
  const selfUseValueKwh = parseGenerationImportNonNegativeNumber(mapped, 'selfUseValueKwh', rowNumber, 'selfUseValueKwh', errors);
  const gridExportValueKwh = parseGenerationImportNonNegativeNumber(mapped, 'gridExportValueKwh', rowNumber, 'gridExportValueKwh', errors);
  let dataSource = normalizeText(mapped.dataSource) || 'upload';
  if (!GENERATION_DATA_SOURCES.includes(dataSource)) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'dataSource', mapped.dataSource, 'UNSUPPORTED_GENERATION_DATA_SOURCE', 'dataSource 不在允许范围内：manual / upload / calculation。'));
    dataSource = 'upload';
  }
  const remark = normalizeText(mapped.remark);
  if (remark && remark.length > 1000) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'remark', remark, 'GENERATION_REMARK_TOO_LONG', '备注长度不能超过 1000 个字符。'));
  }
  if (generationValueKwh !== null && selfUseValueKwh !== null && gridExportValueKwh !== null && selfUseValueKwh + gridExportValueKwh > generationValueKwh + 0.000001) {
    errors.push(createGenerationRecordImportIssue(rowNumber, 'selfUseValueKwh+gridExportValueKwh', `${selfUseValueKwh}+${gridExportValueKwh}>${generationValueKwh}`, 'GENERATION_BALANCE_EXCEEDED', '自发自用 kWh + 上网电量 kWh 不能大于 发电量 kWh。'));
  }

  const record = organizationUnit && normalizedMonthValue && generationValueKwh !== null && selfUseValueKwh !== null && gridExportValueKwh !== null ? {
    rowNumber,
    organizationUnitId: organizationUnit.id,
    organizationUnitCode: organizationUnit.unitCode,
    organizationUnitName: organizationUnit.unitName,
    organizationUnitPath: organizationUnit.unitPath,
    normalizedMonth: normalizedMonthValue,
    energyTypeId: indexes.energyType.id,
    energyTypeCode: indexes.energyType.code,
    energyTypeName: indexes.energyType.name,
    generationValueKwh,
    selfUseValueKwh,
    gridExportValueKwh,
    dataSource,
    remark
  } : null;

  if (errors.length > 0) {
    return { fieldMapping, mapped, record, status: 'blocked', wouldImport: false, reasons: errors };
  }
  const importKey = `${record.organizationUnitId} ${record.normalizedMonth} ${record.energyTypeId}`;
  const existingRecord = indexes.activeRecordByUnitMonthEnergy.get(importKey);
  if (existingRecord) {
    return {
      fieldMapping,
      mapped,
      record,
      status: 'skipped',
      wouldImport: false,
      existingRecordId: existingRecord.id,
      reasons: [createGenerationRecordImportIssue(rowNumber, 'organizationUnitCode+normalizedMonth+energyTypeCode', `${record.organizationUnitCode}|${record.normalizedMonth}|${record.energyTypeCode}`, 'DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED', '同一用能单元、同一月份、photovoltaic 已有 active 发电记录，按策略跳过且不覆盖、不作废旧记录。', 'warning')]
    };
  }
  if (seenImportKeys.has(importKey)) {
    return {
      fieldMapping,
      mapped,
      record,
      status: 'skipped',
      wouldImport: false,
      reasons: [createGenerationRecordImportIssue(rowNumber, 'organizationUnitCode+normalizedMonth+energyTypeCode', `${record.organizationUnitCode}|${record.normalizedMonth}|${record.energyTypeCode}`, 'DUPLICATE_IMPORT_CANDIDATE_SKIPPED', '同一导入预演中已存在相同用能单元、月份、photovoltaic 候选，后续重复行跳过以保持 active 唯一。', 'warning')]
    };
  }
  seenImportKeys.add(importKey);
  return {
    fieldMapping,
    mapped,
    record,
    status: 'wouldImport',
    wouldImport: true,
    reasons: [createGenerationRecordImportIssue(rowNumber, 'row', record.rowNumber, 'READY_TO_IMPORT', '满足校验且无 active 发电记录冲突，可受控导入。', 'info')]
  };
}

function buildGenerationRecordImportPreviewWithDb(db, rows = []) {
  const indexes = loadGenerationRecordImportIndexes(db);
  const seenImportKeys = new Set();
  const fieldMapping = {};
  const items = rows.map((row, index) => {
    const rowNumber = Number(row.rowNumber || row.__rowNumber || index + 2);
    const result = validateAndNormalizeGenerationRecordImportRow(row, rowNumber, indexes, seenImportKeys);
    Object.assign(fieldMapping, result.fieldMapping || {});
    const record = result.record || {};
    const mapped = result.mapped || {};
    const item = {
      rowNumber,
      rowId: rowNumber,
      organizationUnitId: record.organizationUnitId || null,
      organizationUnitCode: record.organizationUnitCode || normalizeText(mapped.organizationUnitCode) || null,
      organizationUnitName: record.organizationUnitName || normalizeText(mapped.organizationUnitName) || null,
      organizationUnitPath: record.organizationUnitPath || null,
      energyTypeId: record.energyTypeId || indexes.energyType.id,
      energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE,
      energyTypeName: record.energyTypeName || indexes.energyType.name,
      normalizedMonth: record.normalizedMonth || normalizeText(mapped.normalizedMonth) || null,
      generationValueKwh: record.generationValueKwh ?? normalizeText(mapped.generationValueKwh),
      selfUseValueKwh: record.selfUseValueKwh ?? normalizeText(mapped.selfUseValueKwh),
      gridExportValueKwh: record.gridExportValueKwh ?? normalizeText(mapped.gridExportValueKwh),
      dataSource: record.dataSource || normalizeText(mapped.dataSource) || 'upload',
      remark: record.remark || normalizeText(mapped.remark) || null,
      status: result.status,
      wouldImport: result.wouldImport,
      existingRecordId: result.existingRecordId || null,
      values: {
        organizationUnitCode: record.organizationUnitCode || normalizeText(mapped.organizationUnitCode) || null,
        organizationUnitName: record.organizationUnitName || normalizeText(mapped.organizationUnitName) || null,
        organizationUnitPath: record.organizationUnitPath || null,
        normalizedMonth: record.normalizedMonth || normalizeText(mapped.normalizedMonth) || null,
        generationValueKwh: record.generationValueKwh ?? normalizeText(mapped.generationValueKwh),
        selfUseValueKwh: record.selfUseValueKwh ?? normalizeText(mapped.selfUseValueKwh),
        gridExportValueKwh: record.gridExportValueKwh ?? normalizeText(mapped.gridExportValueKwh),
        dataSource: record.dataSource || normalizeText(mapped.dataSource) || 'upload',
        remark: record.remark || normalizeText(mapped.remark) || null
      },
      reasons: result.reasons || []
    };
    item.errors = item.reasons.filter((reason) => reason.severity === 'error');
    item.warnings = item.reasons.filter((reason) => reason.severity === 'warning');
    item.reasonCodes = item.reasons.map((reason) => reason.code).join('|');
    item.reasonText = item.reasons.map((reason) => reason.message).join('；');
    return item;
  });
  const summary = summarizeGenerationRecordImportItems(items);
  const candidateRowIds = items.filter((item) => item.wouldImport).map((item) => item.rowNumber).sort((a, b) => a - b);
  const candidateRows = items.filter((item) => item.wouldImport).map((item) => ({
    candidateRowId: `generation:${item.organizationUnitId}:${item.normalizedMonth}:${item.energyTypeCode}`,
    rowNumber: item.rowNumber,
    organizationUnitId: item.organizationUnitId,
    organizationUnitCode: item.organizationUnitCode,
    organizationUnitName: item.organizationUnitName,
    normalizedMonth: item.normalizedMonth,
    energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE,
    generationValueKwh: item.generationValueKwh,
    selfUseValueKwh: item.selfUseValueKwh,
    gridExportValueKwh: item.gridExportValueKwh,
    dataSource: item.dataSource,
    remark: item.remark
  }));
  const preview = {
    dryRun: true,
    previewOnly: true,
    writesGenerationRecords: false,
    persistsImportBatch: true,
    confirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
    backupReason: GENERATION_RECORD_IMPORT_BACKUP_REASON,
    fieldMapping,
    summary,
    candidateRowIds,
    candidateRows,
    items,
    previewAudit: { summary, items },
    notices: [
      '本轮发电导入 preview 不写入 generation_records；原始文件元数据、previewAuditDigest、批次状态和 error/warning 明细会持久化到 import_batches/import_errors。',
      'execute 后续必须携带固定确认文本、previewSignature、expectedWouldImport、candidateRowIds、candidateRows、acknowledgeSkippedRisks=true、requireBackup=true，并在写入前重算 preview。',
      '同用能单元同月份 photovoltaic 已有 active 发电记录或同文件重复候选时跳过并警告；不覆盖、不作废旧记录，不自动创建用能单元。',
      '发电导入只面向 generation_records，不写 energy_records、carbon_emissions，也不影响单位产品能耗。'
    ]
  };
  preview.previewAuditDigest = buildGenerationRecordImportPreviewAuditDigest(preview.previewAudit);
  preview.previewSignature = buildGenerationRecordImportPreviewSignature(preview);
  return preview;
}

function buildGenerationRecordImportPreviewFromRows(rows = []) {
  const db = openDatabase();
  try {
    return buildGenerationRecordImportPreviewWithDb(db, rows);
  } finally {
    db.close();
  }
}

function buildGenerationRecordAuditBatchResponse(batch) {
  if (!batch) return null;
  return {
    id: batch.id,
    importType: batch.importType,
    status: batch.status,
    auditPhase: batch.auditPhase,
    originalFilename: batch.originalFilename,
    fileSha256: batch.fileSha256,
    fileSizeBytes: batch.fileSizeBytes,
    previewSignature: batch.previewSignature,
    previewAuditDigest: batch.previewAuditDigest,
    counts: batch.counts || {
      totalRows: batch.totalRows,
      successCount: batch.successCount,
      failureCount: batch.failureCount,
      skippedCount: batch.skippedCount
    },
    issueCounts: batch.issueCounts,
    hasBackup: Object.prototype.hasOwnProperty.call(batch, 'hasBackup') ? batch.hasBackup : Boolean(batch.backup),
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    completedAt: batch.completedAt
  };
}

function attachGenerationRecordAuditBatch(result, batch) {
  if (!batch) return result;
  const auditBatch = buildGenerationRecordAuditBatchResponse(batch);
  return {
    ...result,
    persistsImportBatch: true,
    batchId: batch.id,
    auditBatch
  };
}

function collectGenerationRecordImportAuditIssues(preview = {}) {
  return (preview.items || []).flatMap((item) => (item.reasons || [])
    .filter((reason) => ['error', 'warning'].includes(reason.severity))
    .map((reason) => ({
      rowNumber: item.rowNumber,
      fieldName: reason.fieldName,
      rawValue: reason.rawValue,
      code: reason.code,
      message: reason.message,
      severity: reason.severity
    })));
}

function buildGenerationRecordImportErrorSummary(summary = {}) {
  const parts = [];
  if (summary.blocked > 0) parts.push(`${summary.blocked} 行阻断`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} 行跳过`);
  if (summary.warnings > 0) parts.push(`${summary.warnings} 条警告`);
  if (summary.errors > 0) parts.push(`${summary.errors} 条错误`);
  return parts.length ? `发电导入存在 ${parts.join('、')}。` : null;
}

function createGenerationRecordImportAuditBatch(preview, file) {
  const auditBatch = createPreviewAuditBatch({
    importType: 'generation_record',
    originalFilename: file.originalname,
    storedFilename: file.filename || null,
    filePath: file.path,
    fileType: String(file.originalname || '').split('.').pop().toLowerCase(),
    fileSizeBytes: file.size,
    duplicateStrategy: 'skip',
    fieldMapping: preview.fieldMapping,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    auditContext: {
      confirmText: preview.confirmText,
      backupReason: preview.backupReason,
      summary: preview.summary,
      candidateRowIds: preview.candidateRowIds,
      candidateRows: preview.candidateRows,
      previewAudit: preview.previewAudit,
      previewAuditDigest: preview.previewAuditDigest,
      notices: preview.notices,
      nonLinkage: {
        writesEnergyRecords: false,
        writesCarbonEmissions: false,
        affectsProductionIntensity: false,
        targetTable: 'generation_records',
        energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE
      }
    },
    statistics: {
      totalRows: preview.summary.totalRows,
      successCount: preview.summary.wouldImport,
      failureCount: preview.summary.blocked,
      skippedCount: preview.summary.skipped
    },
    errorSummary: buildGenerationRecordImportErrorSummary(preview.summary)
  });
  const withIssues = replaceImportAuditIssues(auditBatch.id, collectGenerationRecordImportAuditIssues(preview));
  return getImportAuditSummary(withIssues.id);
}

function createGenerationRecordImportPreviewFromUpload(file) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的发电自用记录表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  assertSupportedImportFile(file.originalname);
  const parsed = parseImportFile(file.path, file.originalname);
  const preview = buildGenerationRecordImportPreviewFromRows(parsed.rows || []);
  const auditBatch = createGenerationRecordImportAuditBatch(preview, file);
  return attachGenerationRecordAuditBatch(preview, auditBatch);
}

function normalizeGenerationRecordImportCandidateRowIds(value) {
  if (!Array.isArray(value)) {
    throw badRequest('candidateRowIds 必须是数组。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ROW_IDS_REQUIRED' });
  }
  return value.map((id) => parsePositiveInteger(id, 'candidateRowIds', { required: true }));
}

function assertSameNumberArray(actual, expected, code, message) {
  if (actual.length !== expected.length || actual.some((value, index) => Number(value) !== Number(expected[index]))) {
    throw badRequest(message, { code, actual, expected });
  }
}

function assertSameCandidateRows(actualRows, expectedRows, code, message) {
  const actual = (actualRows || []).map(normalizeGenerationRecordImportCandidateRow);
  const expected = (expectedRows || []).map(normalizeGenerationRecordImportCandidateRow);
  if (actual.length !== expected.length || stableStringify(actual) !== stableStringify(expected)) {
    throw badRequest(message, { code, actual, expected });
  }
}

function assertExecutableGenerationRecordImportCandidateRows(candidateRows) {
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) {
    throw badRequest('candidateRows 为必填数组，必须来自最新导入预演响应且至少包含一条 wouldImport 候选。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_REQUIRED' });
  }
  candidateRows.forEach((row, index) => {
    const normalized = normalizeGenerationRecordImportCandidateRow(row);
    const rawCandidateRowId = normalizeText(row?.candidateRowId);
    if (!rawCandidateRowId || rawCandidateRowId !== normalized.candidateRowId || !/^generation:\d+:\d{4}-\d{2}:photovoltaic$/.test(rawCandidateRowId)) {
      throw badRequest('candidateRows 必须包含 preview 生成的 candidateRowId。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ROW_ID_INVALID', index, candidateRowId: row?.candidateRowId });
    }
    if (!Number.isSafeInteger(normalized.rowNumber) || normalized.rowNumber <= 0) {
      throw badRequest('candidateRows.rowNumber 必须为正整数。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ROW_NUMBER_INVALID', index, rowNumber: row?.rowNumber });
    }
    if (!Number.isSafeInteger(normalized.organizationUnitId) || normalized.organizationUnitId <= 0) {
      throw badRequest('candidateRows.organizationUnitId 必须为正整数。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ORGANIZATION_UNIT_INVALID', index, organizationUnitId: row?.organizationUnitId });
    }
    if (normalized.energyTypeCode !== PHOTOVOLTAIC_ENERGY_TYPE_CODE) {
      throw badRequest('candidateRows.energyTypeCode 必须固定为 photovoltaic。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_ENERGY_TYPE_INVALID', index, energyTypeCode: row?.energyTypeCode });
    }
    try {
      normalizeMonth(normalized.normalizedMonth, 'normalizedMonth');
    } catch (error) {
      throw badRequest('candidateRows.normalizedMonth 必须是 YYYY-MM。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_MONTH_INVALID', index, rawValue: row?.normalizedMonth });
    }
    ['generationValueKwh', 'selfUseValueKwh', 'gridExportValueKwh'].forEach((fieldName) => {
      if (!Number.isFinite(normalized[fieldName]) || normalized[fieldName] < 0) {
        throw badRequest(`candidateRows.${fieldName} 必须是大于等于 0 的数字。`, { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_VALUE_INVALID', index, fieldName, rawValue: row?.[fieldName] });
      }
    });
    validateGenerationBalance(normalized);
    assertWhitelist(normalized.dataSource, 'dataSource', GENERATION_DATA_SOURCES, 'UNSUPPORTED_GENERATION_DATA_SOURCE');
    if (normalizeText(row?.status) && normalizeText(row.status) !== 'wouldImport') {
      throw badRequest('candidateRows 只能包含 preview 的 wouldImport 候选，不接受 skipped/blocked 行。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_STATUS_INVALID', index, status: row.status });
    }
    if (Object.prototype.hasOwnProperty.call(row || {}, 'wouldImport') && row.wouldImport !== true) {
      throw badRequest('candidateRows 只能包含 wouldImport=true 的候选。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_WOULD_IMPORT_REQUIRED', index, wouldImport: row.wouldImport });
    }
    if (Array.isArray(row?.errors) || Array.isArray(row?.warnings) || Array.isArray(row?.reasons)) {
      throw badRequest('candidateRows 不接受带 errors/warnings/reasons 的展示行；请使用 preview 响应中的 candidateRows。', { code: 'GENERATION_RECORD_IMPORT_CANDIDATE_DISPLAY_ROW_REJECTED', index });
    }
  });
}

function resolveGenerationRecordImportPreviewAuditSnapshot(body = {}) {
  const previewAudit = body.previewAudit || (body.summary || body.items ? { summary: body.summary, items: body.items } : null);
  if (!previewAudit) {
    return null;
  }
  const normalizedAudit = normalizeGenerationRecordImportPreviewAudit(previewAudit);
  const digest = normalizeText(body.previewAuditDigest);
  if (!digest) {
    throw badRequest('携带 previewAudit 时必须同时携带 previewAuditDigest。', { code: 'GENERATION_RECORD_IMPORT_PREVIEW_AUDIT_DIGEST_REQUIRED' });
  }
  if (!verifyGenerationRecordImportPreviewAuditDigest(previewAudit, digest)) {
    throw badRequest('previewAuditDigest 与 previewAudit 摘要/行级明细不一致，已拒绝导入。', { code: 'GENERATION_RECORD_IMPORT_PREVIEW_AUDIT_DIGEST_MISMATCH' });
  }
  return {
    ...normalizedAudit,
    digest,
    source: 'preview-response-snapshot',
    preservedForAuditOnly: true
  };
}

function resolveGenerationRecordImportPersistedPreviewAuditSnapshot(auditBatchId) {
  if (!auditBatchId) {
    return null;
  }
  const batch = getImportAuditBatchDetail(auditBatchId, { includeIssues: false });
  const previewAudit = batch.auditContext?.previewAudit || null;
  if (!previewAudit) {
    return null;
  }
  const digest = normalizeText(batch.auditContext?.previewAuditDigest) || normalizeText(batch.previewAuditDigest);
  if (!digest) {
    return null;
  }
  if (!verifyGenerationRecordImportPreviewAuditDigest(previewAudit, digest)) {
    throw badRequest('持久化 previewAuditDigest 与批次 previewAudit 不一致，已拒绝导入。', { code: 'GENERATION_RECORD_IMPORT_PERSISTED_PREVIEW_AUDIT_DIGEST_MISMATCH', batchId: auditBatchId });
  }
  return {
    ...normalizeGenerationRecordImportPreviewAudit(previewAudit),
    digest,
    source: 'persisted-preview-audit-batch',
    auditBatchId,
    preservedForAuditOnly: true
  };
}

function normalizeOptionalGenerationRecordImportBatchId(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return parsePositiveInteger(value, 'batchId', { required: true });
}

function findGenerationRecordAuditBatchIdForExecute(previewSignature, requestedBatchId = null) {
  if (requestedBatchId) {
    const batch = getImportAuditBatchDetail(requestedBatchId, { includeIssues: false });
    if (batch.importType !== 'generation_record') {
      throw badRequest('batchId 不是发电导入审计批次。', { code: 'GENERATION_RECORD_IMPORT_AUDIT_BATCH_TYPE_MISMATCH', batchId: requestedBatchId, importType: batch.importType });
    }
    if (batch.previewSignature && !timingSafeEqualText(batch.previewSignature, previewSignature)) {
      throw badRequest('batchId 与 previewSignature 不匹配，已拒绝执行发电导入。', { code: 'GENERATION_RECORD_IMPORT_AUDIT_BATCH_SIGNATURE_MISMATCH', batchId: requestedBatchId });
    }
    return requestedBatchId;
  }
  const db = openDatabase();
  try {
    const row = db.prepare(
      `SELECT id
       FROM import_batches
       WHERE import_type = 'generation_record'
         AND preview_signature = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(previewSignature);
    return row ? Number(row.id) : null;
  } finally {
    db.close();
  }
}

function buildGenerationRecordAuditFailureStatistics(batch) {
  if (!batch) {
    return { totalRows: 0, successCount: 0, failureCount: 0, skippedCount: 0 };
  }
  return {
    totalRows: Number(batch.totalRows || 0),
    successCount: 0,
    failureCount: Number(batch.failureCount || 0),
    skippedCount: Number(batch.skippedCount || 0)
  };
}

function markGenerationRecordImportAuditFailure(body = {}, error) {
  try {
    const requestedBatchId = normalizeOptionalGenerationRecordImportBatchId(body.batchId);
    const previewSignature = normalizeText(body.previewSignature);
    const batchId = requestedBatchId || (previewSignature ? findGenerationRecordAuditBatchIdForExecute(previewSignature, null) : null);
    if (!batchId) return;
    const batch = getImportAuditBatchDetail(batchId, { includeIssues: false });
    if (batch.importType !== 'generation_record') return;
    if (batch.auditPhase === 'execute' && ['completed', 'completed_with_errors'].includes(batch.status)) return;
    updateExecuteAuditResult(batchId, {
      status: 'failed',
      statistics: buildGenerationRecordAuditFailureStatistics(batch),
      executeResult: {
        executed: false,
        writesGenerationRecords: false,
        errorCode: error?.details?.code || error?.code || 'GENERATION_RECORD_IMPORT_EXECUTE_FAILED',
        errorMessage: error?.message || '发电导入执行失败。',
        previewSignatureProvided: Boolean(body.previewSignature),
        expectedWouldImport: body.expectedWouldImport ?? null,
        candidateRowIds: Array.isArray(body.candidateRowIds) ? body.candidateRowIds : null,
        previewAuditDigest: body.previewAuditDigest || null,
        requireBackup: body.requireBackup === true,
        acknowledgeSkippedRisks: body.acknowledgeSkippedRisks === true,
        nonLinkage: {
          writesEnergyRecords: false,
          writesCarbonEmissions: false,
          affectsProductionIntensity: false
        }
      },
      backup: null,
      errorSummary: error?.message || '发电导入执行失败。'
    });
  } catch (_) {
    // 审计失败标记不能掩盖原始业务拒绝原因。
  }
}

async function executeGenerationRecordImportInternal(body = {}) {
  const confirmText = normalizeText(body.confirmText);
  if (confirmText !== GENERATION_RECORD_IMPORT_CONFIRM_TEXT) {
    throw badRequest('确认文本不匹配，已拒绝导入发电自用记录。', { code: 'GENERATION_RECORD_IMPORT_CONFIRM_TEXT_MISMATCH', requiredConfirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT });
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throw badRequest('必须确认已知晓冲突、重复、无效和阻断记录会被跳过。', { code: 'GENERATION_RECORD_IMPORT_SKIPPED_RISKS_ACK_REQUIRED' });
  }
  if (body.requireBackup !== true) {
    throw badRequest('执行前必须要求自动备份，requireBackup 必须显式为 true。', { code: 'GENERATION_RECORD_IMPORT_BACKUP_REQUIRED' });
  }
  const previewSignature = normalizeText(body.previewSignature);
  if (!previewSignature) {
    throw badRequest('previewSignature 为必填项。', { code: 'GENERATION_RECORD_IMPORT_PREVIEW_SIGNATURE_REQUIRED' });
  }
  const expectedWouldImport = parsePositiveInteger(body.expectedWouldImport, 'expectedWouldImport', { required: true });
  const requestedBatchId = normalizeOptionalGenerationRecordImportBatchId(body.batchId);
  const auditBatchId = findGenerationRecordAuditBatchIdForExecute(previewSignature, requestedBatchId);
  const previewAudit = resolveGenerationRecordImportPreviewAuditSnapshot(body) || resolveGenerationRecordImportPersistedPreviewAuditSnapshot(auditBatchId);
  assertExecutableGenerationRecordImportCandidateRows(body.candidateRows);
  const candidateRowIds = normalizeGenerationRecordImportCandidateRowIds(body.candidateRowIds);
  const candidateRowIdsFromRows = body.candidateRows.map((row) => normalizeGenerationRecordImportCandidateRow(row).rowNumber);
  assertSameNumberArray(candidateRowIds, candidateRowIdsFromRows, 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_IDS_MISMATCH', 'candidateRowIds 必须与 candidateRows 的 rowNumber 完全一致且顺序一致。');
  if (Number(expectedWouldImport) !== body.candidateRows.length) {
    throw badRequest('expectedWouldImport 必须与 candidateRows 数量一致。', { code: 'GENERATION_RECORD_IMPORT_EXPECTED_COUNT_MISMATCH', expected: body.candidateRows.length, actual: expectedWouldImport });
  }

  const db = openDatabase();
  let preview;
  try {
    preview = buildGenerationRecordImportPreviewWithDb(db, body.candidateRows);
  } finally {
    db.close();
  }
  if (!verifyGenerationRecordImportPreviewSignature(preview, previewSignature)) {
    throw badRequest('当前 previewSignature 与执行前重新计算结果不一致，请重新 preview 后再执行。', { code: 'GENERATION_RECORD_IMPORT_PREVIEW_SIGNATURE_MISMATCH' });
  }
  if (Number(preview.summary.wouldImport || 0) !== Number(expectedWouldImport || 0)) {
    throw badRequest('expectedWouldImport 与执行前重新计算结果不一致，请重新 preview 后再执行。', { code: 'GENERATION_RECORD_IMPORT_WOULD_IMPORT_MISMATCH', expected: preview.summary.wouldImport, actual: expectedWouldImport });
  }
  assertSameNumberArray(preview.candidateRowIds, candidateRowIds.slice().sort((a, b) => a - b), 'GENERATION_RECORD_IMPORT_CANDIDATE_ROW_IDS_MISMATCH', 'candidateRowIds 与执行前重新计算结果不一致，请重新 preview 后再执行。');
  assertSameCandidateRows(preview.candidateRows, body.candidateRows, 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_MISMATCH', 'candidateRows 与执行前重新计算结果不一致，请重新 preview 后再执行。');

  const backup = {
    ...(await backupService.createBackup({ reason: GENERATION_RECORD_IMPORT_BACKUP_REASON })),
    requestedReason: GENERATION_RECORD_IMPORT_BACKUP_REASON
  };
  const writeDb = openDatabase();
  try {
    const transaction = writeDb.transaction(() => {
      const latestPreview = buildGenerationRecordImportPreviewWithDb(writeDb, body.candidateRows);
      if (!verifyGenerationRecordImportPreviewSignature(latestPreview, previewSignature)) {
        throw badRequest('当前 previewSignature 与写入前重新计算结果不一致，请重新 preview 后再执行。', { code: 'GENERATION_RECORD_IMPORT_PREVIEW_SIGNATURE_MISMATCH' });
      }
      if (Number(latestPreview.summary.wouldImport || 0) !== Number(expectedWouldImport || 0)) {
        throw badRequest('expectedWouldImport 与写入前重新计算结果不一致，请重新 preview 后再执行。', { code: 'GENERATION_RECORD_IMPORT_WOULD_IMPORT_MISMATCH', expected: latestPreview.summary.wouldImport, actual: expectedWouldImport });
      }
      assertSameNumberArray(latestPreview.candidateRowIds, candidateRowIds.slice().sort((a, b) => a - b), 'GENERATION_RECORD_IMPORT_CANDIDATE_ROW_IDS_MISMATCH', 'candidateRowIds 与写入前重新计算结果不一致，请重新 preview 后再执行。');
      assertSameCandidateRows(latestPreview.candidateRows, body.candidateRows, 'GENERATION_RECORD_IMPORT_CANDIDATE_ROWS_MISMATCH', 'candidateRows 与写入前重新计算结果不一致，请重新 preview 后再执行。');

      const energyType = ensurePhotovoltaicEnergyType(writeDb, {});
      const insertRecord = writeDb.prepare(
        `INSERT INTO generation_records (
           source_batch_id,
           source_row_number,
           organization_unit_id,
           energy_type_id,
           normalized_month,
           generation_value_kwh,
           self_use_value_kwh,
           grid_export_value_kwh,
           data_source,
           record_status,
           remark,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      );
      const now = getNow();
      const items = [];
      const importedRecords = [];
      latestPreview.items.forEach((item) => {
        if (!item.wouldImport) {
          items.push({ rowNumber: item.rowNumber, status: 'skipped', previewStatus: item.status, organizationUnitId: item.organizationUnitId || null, organizationUnitCode: item.organizationUnitCode || item.values?.organizationUnitCode || null, organizationUnitName: item.organizationUnitName || item.values?.organizationUnitName || null, organizationUnitPath: item.organizationUnitPath || item.values?.organizationUnitPath || null, normalizedMonth: item.normalizedMonth || item.values?.normalizedMonth || null, energyTypeCode: item.energyTypeCode || PHOTOVOLTAIC_ENERGY_TYPE_CODE, reasonCodes: item.reasonCodes, reason: item.reasonText, existingRecordId: item.existingRecordId || null });
          return;
        }
        const sourceBatchId = auditBatchId || null;
        const insertResult = insertRecord.run(sourceBatchId, sourceBatchId ? item.rowNumber : null, item.organizationUnitId, energyType.id, item.normalizedMonth, item.generationValueKwh, item.selfUseValueKwh, item.gridExportValueKwh, item.dataSource || 'upload', item.remark || null, now, now);
        const importedRecord = mapGenerationRecordRow(getGenerationRecordById(writeDb, insertResult.lastInsertRowid));
        importedRecords.push(importedRecord);
        items.push({ rowNumber: item.rowNumber, status: 'imported', generationRecordId: importedRecord.id, organizationUnitId: importedRecord.organizationUnitId, organizationUnitCode: importedRecord.organizationUnitCode, organizationUnitName: importedRecord.organizationUnitName, organizationUnitPath: importedRecord.organizationUnitPath, normalizedMonth: importedRecord.normalizedMonth, energyTypeCode: importedRecord.energyTypeCode, generationValueKwh: importedRecord.generationValueKwh, selfUseValueKwh: importedRecord.selfUseValueKwh, gridExportValueKwh: importedRecord.gridExportValueKwh, dataSource: importedRecord.dataSource, sourceBatchId, sourceRowNumber: sourceBatchId ? item.rowNumber : null, reason: '已按受控导入写入 active 发电自用记录。' });
      });
      const imported = importedRecords.length;
      const skippedItems = items.filter((item) => item.status === 'skipped');
      const auditSnapshot = previewAudit || {
        ...normalizeGenerationRecordImportPreviewAudit(latestPreview.previewAudit),
        digest: latestPreview.previewAuditDigest,
        source: 'execute-recalculated-preview',
        preservedForAuditOnly: true
      };
      const importedItemsByRowNumber = new Map(items.filter((item) => item.status === 'imported').map((item) => [Number(item.rowNumber), item]));
      const displayItems = Array.isArray(auditSnapshot.items) && auditSnapshot.items.length > 0
        ? auditSnapshot.items.map((auditItem) => importedItemsByRowNumber.get(Number(auditItem.rowNumber)) || auditItem)
        : items;
      const displaySkippedItems = displayItems.filter((item) => item.status === 'skipped');
      const result = {
        executed: true,
        dryRun: false,
        writesGenerationRecords: true,
        persistsImportBatch: Boolean(auditBatchId),
        imported,
        skipped: Number(auditSnapshot.summary?.skipped ?? skippedItems.length),
        blocked: Number(auditSnapshot.summary?.blocked ?? latestPreview.summary.blocked ?? 0),
        warnings: Number(auditSnapshot.summary?.warnings ?? latestPreview.summary.warnings ?? 0),
        errors: Number(auditSnapshot.summary?.errors ?? latestPreview.summary.errors ?? 0),
        previewSignature: latestPreview.previewSignature,
        previewAuditDigest: latestPreview.previewAuditDigest,
        expectedWouldImport,
        candidateRowIds: latestPreview.candidateRowIds,
        backup,
        summary: { ...auditSnapshot.summary, imported },
        importedIds: importedRecords.map((record) => record.id),
        importedRecords,
        importedItems: items.filter((item) => item.status === 'imported'),
        skippedItems: displaySkippedItems,
        previewAudit: auditSnapshot,
        items: displayItems,
        meta: buildGenerationMeta({
          writesGenerationRecords: true,
          importExportIncluded: true,
          nonLinkage: {
            writesEnergyRecords: false,
            writesCarbonEmissions: false,
            affectsProductionIntensity: false,
            targetTable: 'generation_records',
            energyTypeCode: PHOTOVOLTAIC_ENERGY_TYPE_CODE,
            dataSource: 'upload-or-preview-candidate'
          }
        }),
        note: '已按最新 preview 的 wouldImport 候选受控导入；执行前已自动备份。冲突、重复、无效和阻断状态需重新 preview，不覆盖、不作废既有 active 发电记录。'
      };
      if (!auditBatchId) {
        return result;
      }
      const finalAuditSummary = auditSnapshot.summary || latestPreview.summary || {};
      const auditBatch = updateExecuteAuditResult(auditBatchId, {
        status: Number(finalAuditSummary.blocked || 0) > 0 || Number(finalAuditSummary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed',
        statistics: {
          totalRows: Number(finalAuditSummary.totalRows || latestPreview.summary.totalRows || 0),
          successCount: imported,
          failureCount: Number(finalAuditSummary.blocked || 0),
          skippedCount: Number(finalAuditSummary.skipped || 0)
        },
        executeResult: {
          executed: true,
          writesGenerationRecords: true,
          imported,
          skipped: result.skipped,
          blocked: result.blocked,
          warnings: result.warnings,
          errors: result.errors,
          previewSignature: latestPreview.previewSignature,
          previewAuditDigest: latestPreview.previewAuditDigest,
          expectedWouldImport,
          candidateRowIds: latestPreview.candidateRowIds,
          importedIds: result.importedIds,
          importedItems: result.importedItems,
          skippedItems: result.skippedItems,
          previewAudit: auditSnapshot,
          summary: result.summary,
          nonLinkage: result.meta.nonLinkage,
          note: result.note
        },
        backup,
        errorSummary: buildGenerationRecordImportErrorSummary(finalAuditSummary)
      }, { db: writeDb });
      return attachGenerationRecordAuditBatch(result, auditBatch);
    });
    return transaction();
  } catch (error) {
    if (isGenerationUniqueConstraintError(error)) {
      throw badRequest('写入前状态已变化，存在 active 发电记录冲突，请重新 preview 后再导入。', { code: 'GENERATION_RECORD_IMPORT_EXPIRED_PREVIEW' });
    }
    throw error;
  } finally {
    writeDb.close();
  }
}

async function executeGenerationRecordImport(body = {}) {
  try {
    return await executeGenerationRecordImportInternal(body);
  } catch (error) {
    markGenerationRecordImportAuditFailure(body, error);
    throw error;
  }
}

function createGenerationRecord(input = {}) {
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const energyType = ensurePhotovoltaicEnergyType(db, input);
      const payload = normalizeGenerationPayload(input);
      payload.energyTypeId = energyType.id;
      ensureActiveOrganizationUnit(db, payload.organizationUnitId);
      if (payload.recordStatus !== 'active') {
        throw badRequest('新增发电记录必须为 active 状态；作废请使用 DELETE 接口。', {
          code: 'GENERATION_CREATE_STATUS_MUST_BE_ACTIVE',
          recordStatus: payload.recordStatus
        });
      }
      ensureActiveGenerationUnique(db, payload.organizationUnitId, payload.normalizedMonth, payload.energyTypeId);
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO generation_records (
           organization_unit_id,
           energy_type_id,
           normalized_month,
           generation_value_kwh,
           self_use_value_kwh,
           grid_export_value_kwh,
           data_source,
           record_status,
           remark,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(payload.organizationUnitId, payload.energyTypeId, payload.normalizedMonth, payload.generationValueKwh, payload.selfUseValueKwh, payload.gridExportValueKwh, payload.dataSource, payload.remark, now, now);
      return mapGenerationRecordRow(getGenerationRecordById(db, result.lastInsertRowid));
    });
    return transaction();
  } catch (error) {
    if (isGenerationUniqueConstraintError(error)) {
      throwGenerationUniqueConstraintError();
    }
    throw error;
  } finally {
    db.close();
  }
}

function updateGenerationRecord(recordId, input = {}) {
  const id = normalizeGenerationRecordId(recordId);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = mapGenerationRecordRow(getGenerationRecordById(db, id));
      if (existing.recordStatus === 'void') {
        throw badRequest('已作废发电记录不能编辑。', { code: 'CANNOT_UPDATE_VOID_GENERATION_RECORD', id });
      }
      const energyType = ensurePhotovoltaicEnergyType(db, input, existing);
      const payload = normalizeGenerationPayload(input, { existing });
      payload.energyTypeId = energyType.id;
      ensureActiveOrganizationUnit(db, payload.organizationUnitId);
      if (payload.recordStatus !== 'active') {
        throw badRequest('编辑发电记录不能直接改为 void；作废请使用 DELETE 接口。', {
          code: 'GENERATION_UPDATE_STATUS_MUST_BE_ACTIVE',
          recordStatus: payload.recordStatus
        });
      }
      ensureActiveGenerationUnique(db, payload.organizationUnitId, payload.normalizedMonth, payload.energyTypeId, id);
      const now = getNow();
      db.prepare(
        `UPDATE generation_records
         SET organization_unit_id = ?,
             energy_type_id = ?,
             normalized_month = ?,
             generation_value_kwh = ?,
             self_use_value_kwh = ?,
             grid_export_value_kwh = ?,
             data_source = ?,
             remark = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(payload.organizationUnitId, payload.energyTypeId, payload.normalizedMonth, payload.generationValueKwh, payload.selfUseValueKwh, payload.gridExportValueKwh, payload.dataSource, payload.remark, now, id);
      return mapGenerationRecordRow(getGenerationRecordById(db, id));
    });
    return transaction();
  } catch (error) {
    if (isGenerationUniqueConstraintError(error)) {
      throwGenerationUniqueConstraintError();
    }
    throw error;
  } finally {
    db.close();
  }
}

function voidGenerationRecord(recordId, input = {}) {
  const id = normalizeGenerationRecordId(recordId);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = mapGenerationRecordRow(getGenerationRecordById(db, id));
      if (existing.recordStatus === 'void') {
        return {
          id,
          recordStatus: 'void',
          voided: false,
          note: '发电记录已处于 void 状态。'
        };
      }
      const now = getNow();
      const voidReason = normalizeText(firstDefined(input, ['voidReason', 'void_reason', 'reason'])) || normalizeText(input.remark) || '页面作废';
      db.prepare(
        `UPDATE generation_records
         SET record_status = 'void', void_reason = ?, voided_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(voidReason, now, now, id);
      return {
        id: existing.id,
        organizationUnitId: existing.organizationUnitId,
        energyTypeId: existing.energyTypeId,
        normalizedMonth: existing.normalizedMonth,
        recordStatus: 'void',
        voided: true,
        voidReason,
        voidedAt: now
      };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function buildReferenceKey(organizationUnitId, normalizedMonth) {
  return `${organizationUnitId} ${normalizedMonth}`;
}

function buildReferenceWhere(query = {}) {
  const where = ["er.record_status = 'active'", 'et.code = @electricityCode', 'er.organization_unit_id IS NOT NULL'];
  const params = { electricityCode: ELECTRICITY_ENERGY_TYPE_CODE };
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('er.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'normalizedMonthStart', 'month_start']), 'monthStart');
  if (monthStart) {
    where.push('er.normalized_month >= @monthStart');
    params.monthStart = monthStart;
  }
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'normalizedMonthEnd', 'month_end']), 'monthEnd');
  if (monthEnd) {
    where.push('er.normalized_month <= @monthEnd');
    params.monthEnd = monthEnd;
  }
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

function loadPurchasedElectricityReferences(db, query = {}) {
  const { whereSql, params } = buildReferenceWhere(query);
  const rows = db.prepare(
    `SELECT
       er.organization_unit_id AS organizationUnitId,
       er.normalized_month AS normalizedMonth,
       COUNT(er.id) AS recordCount,
       COALESCE(SUM(er.normalized_value), 0) AS purchasedElectricityReferenceKwh
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     ${whereSql}
     GROUP BY er.organization_unit_id, er.normalized_month`
  ).all(params);
  return new Map(rows.map((row) => [buildReferenceKey(row.organizationUnitId, row.normalizedMonth), {
    recordCount: Number(row.recordCount || 0),
    purchasedElectricityReferenceKwh: Number(row.purchasedElectricityReferenceKwh || 0),
    unit: 'kWh'
  }]));
}

function buildMonthlyStatisticsWhere(query = {}, db) {
  const where = ["gr.record_status = 'active'"];
  const params = {};
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('gr.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'normalizedMonthStart', 'month_start']), 'monthStart');
  if (monthStart) {
    where.push('gr.normalized_month >= @monthStart');
    params.monthStart = monthStart;
  }
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'normalizedMonthEnd', 'month_end']), 'monthEnd');
  if (monthEnd) {
    where.push('gr.normalized_month <= @monthEnd');
    params.monthEnd = monthEnd;
  }
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  const energyType = ensurePhotovoltaicEnergyType(db, query);
  where.push('gr.energy_type_id = @energyTypeId');
  params.energyTypeId = energyType.id;
  return { whereSql: `WHERE ${where.join(' AND ')}`, params, energyType };
}

function buildMonthlyStatisticsRow(row, reference) {
  const generationValueKwh = Number(row.generationValueKwh || 0);
  const selfUseValueKwh = Number(row.selfUseValueKwh || 0);
  const gridExportValueKwh = Number(row.gridExportValueKwh || 0);
  return {
    organizationUnitId: row.organizationUnitId,
    organizationUnitCode: row.organizationUnitCode,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    normalizedMonth: row.normalizedMonth,
    recordCount: Number(row.recordCount || 0),
    generationValueKwh,
    selfUseValueKwh,
    gridExportValueKwh,
    selfUseRate: generationValueKwh > 0 ? selfUseValueKwh / generationValueKwh : null,
    gridExportRate: generationValueKwh > 0 ? gridExportValueKwh / generationValueKwh : null,
    purchasedElectricityReferenceKwh: Number(reference?.purchasedElectricityReferenceKwh || 0),
    purchasedElectricityReferenceRecordCount: Number(reference?.recordCount || 0),
    purchasedElectricityReferenceUnit: reference?.unit || 'kWh',
    referenceOnly: true
  };
}

function summarizeMonthlyRows(rows) {
  const totals = rows.reduce((summary, row) => ({
    generationValueKwh: summary.generationValueKwh + row.generationValueKwh,
    selfUseValueKwh: summary.selfUseValueKwh + row.selfUseValueKwh,
    gridExportValueKwh: summary.gridExportValueKwh + row.gridExportValueKwh,
    purchasedElectricityReferenceKwh: summary.purchasedElectricityReferenceKwh + row.purchasedElectricityReferenceKwh,
    recordCount: summary.recordCount + row.recordCount
  }), {
    generationValueKwh: 0,
    selfUseValueKwh: 0,
    gridExportValueKwh: 0,
    purchasedElectricityReferenceKwh: 0,
    recordCount: 0
  });
  return {
    ...totals,
    selfUseRate: totals.generationValueKwh > 0 ? totals.selfUseValueKwh / totals.generationValueKwh : null,
    gridExportRate: totals.generationValueKwh > 0 ? totals.gridExportValueKwh / totals.generationValueKwh : null
  };
}

function getMonthlyGenerationStatistics(query = {}) {
  const db = openDatabase();
  try {
    const { whereSql, params, energyType } = buildMonthlyStatisticsWhere(query, db);
    const referenceByOrgMonth = loadPurchasedElectricityReferences(db, query);
    const rows = db.prepare(
      `SELECT
         gr.organization_unit_id AS organizationUnitId,
         ou.unit_code AS organizationUnitCode,
         ou.unit_name AS organizationUnitName,
         ou.unit_path AS organizationUnitPath,
         gr.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         gr.normalized_month AS normalizedMonth,
         COUNT(gr.id) AS recordCount,
         COALESCE(SUM(gr.generation_value_kwh), 0) AS generationValueKwh,
         COALESCE(SUM(gr.self_use_value_kwh), 0) AS selfUseValueKwh,
         COALESCE(SUM(gr.grid_export_value_kwh), 0) AS gridExportValueKwh
       FROM generation_records gr
       JOIN organization_units ou ON ou.id = gr.organization_unit_id
       JOIN energy_types et ON et.id = gr.energy_type_id
       ${whereSql}
       GROUP BY gr.organization_unit_id, ou.unit_code, ou.unit_name, ou.unit_path, gr.energy_type_id, et.code, et.name, gr.normalized_month
       ORDER BY gr.normalized_month DESC, ou.unit_path ASC, gr.energy_type_id ASC`
    ).all(params).map((row) => buildMonthlyStatisticsRow(row, referenceByOrgMonth.get(buildReferenceKey(row.organizationUnitId, row.normalizedMonth))));
    return {
      rows,
      summary: summarizeMonthlyRows(rows),
      meta: buildGenerationMeta({
        energyTypeId: energyType.id,
        energyTypeCode: energyType.code,
        referenceSource: 'active energy_records with electricity energy type, same organization unit and month'
      })
    };
  } finally {
    db.close();
  }
}

function getGenerationStats(query = {}) {
  const db = openDatabase();
  try {
    const scopedQuery = { ...query, status: undefined, recordStatus: undefined, record_status: undefined };
    const { whereSql, params } = buildGenerationWhere(scopedQuery, db);
    const totals = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN gr.record_status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN gr.record_status = 'void' THEN 1 ELSE 0 END), 0) AS void
      FROM generation_records gr JOIN organization_units ou ON ou.id = gr.organization_unit_id
      JOIN energy_types et ON et.id = gr.energy_type_id ${whereSql}`).get(params);
    const activeWhereSql = `${whereSql}${whereSql ? ' AND' : 'WHERE'} gr.record_status = 'active'`;
    const monthly = db.prepare(`SELECT gr.normalized_month AS normalizedMonth,
      COUNT(*) AS recordCount, COALESCE(SUM(gr.generation_value_kwh), 0) AS generationValueKwh,
      COALESCE(SUM(gr.self_use_value_kwh), 0) AS selfUseValueKwh,
      COALESCE(SUM(gr.grid_export_value_kwh), 0) AS gridExportValueKwh
      FROM generation_records gr JOIN organization_units ou ON ou.id = gr.organization_unit_id
      JOIN energy_types et ON et.id = gr.energy_type_id ${activeWhereSql}
      GROUP BY gr.normalized_month ORDER BY gr.normalized_month DESC`).all(params).map((row) => ({
      ...row,
      generationValueKwh: Number(row.generationValueKwh || 0),
      selfUseValueKwh: Number(row.selfUseValueKwh || 0),
      gridExportValueKwh: Number(row.gridExportValueKwh || 0),
      selfUseRate: Number(row.generationValueKwh || 0) > 0 ? Number(row.selfUseValueKwh || 0) / Number(row.generationValueKwh || 0) : null,
      gridExportRate: Number(row.generationValueKwh || 0) > 0 ? Number(row.gridExportValueKwh || 0) / Number(row.generationValueKwh || 0) : null
    }));
    return { total: Number(totals.total || 0), active: Number(totals.active || 0), void: Number(totals.void || 0), monthly, meta: buildGenerationMeta() };
  } finally {
    db.close();
  }
}

function buildGenerationMeta(extra = {}) {
  return {
    referenceOnly: true,
    writesEnergyRecords: false,
    writesCarbonEmissions: false,
    affectsProductionIntensity: false,
    importExportIncluded: true,
    importExportStatus: 'ready',
    importExportCapabilities: {
      contract: true,
      templateDownload: true,
      exportCurrentFilters: true,
      importPreview: true,
      importExecute: true,
      frontendPanel: true,
      persistsImportBatch: true
    },
    realtimeCollectionIncluded: false,
    allowedEnergyTypeCodes: [PHOTOVOLTAIC_ENERGY_TYPE_CODE],
    unit: 'kWh',
    ...extra
  };
}

function getGenerationImportExportContract() {
  return {
    status: 'execute-ready',
    table: 'generation_records',
    energyType: {
      code: PHOTOVOLTAIC_ENERGY_TYPE_CODE,
      label: '光伏',
      unit: 'kWh',
      fixedOnImport: true
    },
    routes: {
      contract: 'GET /api/generation/contract',
      list: 'GET /api/generation/records',
      statistics: 'GET /api/generation/statistics/monthly',
      export: 'GET /api/generation/records/export?format=xlsx|csv',
      importPreview: 'POST /api/generation/records/import/preview',
      importExecute: 'POST /api/generation/records/import/execute',
      templateXlsx: 'GET /api/templates/generation-records.xlsx',
      templateCsv: 'GET /api/templates/generation-records.csv'
    },
    template: {
      id: GENERATION_RECORD_IMPORT_TEMPLATE_ID,
      name: '发电自用记录导入模板',
      headers: [...GENERATION_RECORD_IMPORT_HEADERS],
      recommendedFormat: 'xlsx',
      csvEncoding: 'UTF-8 with BOM'
    },
    importFields: [
      { key: 'organizationUnitCode', header: '用能单元编码', required: true, match: '按编码精确匹配 active 用能单元；不自动创建台账。' },
      { key: 'organizationUnitName', header: '用能单元名称', required: false, match: '仅用于辅助校验和展示；编码匹配结果优先。' },
      { key: 'normalizedMonth', header: '月份', required: true, normalizedTo: 'YYYY-MM', examples: ['2026-01', '2026/01', '2026.01'] },
      { key: 'generationValueKwh', header: '发电量 kWh', required: true, type: 'number', min: 0, unit: 'kWh' },
      { key: 'selfUseValueKwh', header: '自发自用 kWh', required: true, type: 'number', min: 0, unit: 'kWh' },
      { key: 'gridExportValueKwh', header: '上网电量 kWh', required: true, type: 'number', min: 0, unit: 'kWh' },
      { key: 'dataSource', header: '数据来源', required: false, default: 'upload', allowedValues: [...GENERATION_DATA_SOURCES] },
      { key: 'remark', header: '备注', required: false }
    ],
    importAliases: GENERATION_RECORD_IMPORT_ALIASES,
    importValidation: {
      requiredFields: ['用能单元编码', '月份', '发电量 kWh', '自发自用 kWh', '上网电量 kWh'],
      month: '月份统一标准化为 YYYY-MM。',
      values: '发电量、自发自用、上网电量均为 kWh 且必须大于等于 0。',
      balance: '自发自用 kWh + 上网电量 kWh 不能大于 发电量 kWh。',
      organizationUnit: '用能单元编码必须匹配 active organization_units。',
      duplicateStrategy: '默认 skip；同一用能单元 + 同一月份 + photovoltaic 已有 active 记录或同文件重复候选均返回 warning，不覆盖、不作废旧记录。',
      importedRecordStatus: 'execute 仅创建 active 发电记录；不导入 void 历史。'
    },
    preview: {
      route: 'POST /api/generation/records/import/preview',
      dryRun: true,
      previewOnly: true,
      writesGenerationRecords: false,
      persistsImportBatch: true,
      responseShape: {
        summary: ['totalRows', 'wouldImport', 'skipped', 'blocked', 'warnings', 'errors'],
        items: ['rowNumber', 'rowId', 'organizationUnitCode', 'organizationUnitName', 'normalizedMonth', 'generationValueKwh', 'selfUseValueKwh', 'gridExportValueKwh', 'dataSource', 'remark', 'status', 'wouldImport', 'reasonCodes', 'reasonText', 'reasons'],
        candidateRows: ['candidateRowId', 'rowNumber', 'organizationUnitId', 'organizationUnitCode', 'organizationUnitName', 'normalizedMonth', 'energyTypeCode', 'generationValueKwh', 'selfUseValueKwh', 'gridExportValueKwh', 'dataSource', 'remark'],
        previewSignature: 'HMAC 签名；execute 前基于 candidateRows/candidateRowIds 与关键上下文重算并比对。summary/items 仅用于展示和风险确认，不进入签名载荷。',
        previewAudit: 'summary/items 的只读审计快照，覆盖 wouldImport/skipped/blocked 行级风险；execute 可携带 previewAuditDigest 用于审计展示防篡改，不作为候选写入授权。',
        signaturePayload: ['version', 'operation', 'importType', 'duplicateStrategy', 'targetTable', 'energyTypeCode', 'defaultDataSource', 'writesGenerationRecords', 'persistsImportBatch', 'requireBackup', 'backupReason', 'confirmText', 'candidateRowIds', 'candidateRows']
      }
    },
    execute: {
      route: 'POST /api/generation/records/import/execute',
      requiredFields: ['confirmText', 'previewSignature', 'expectedWouldImport', 'candidateRowIds', 'candidateRows', 'requireBackup', 'acknowledgeSkippedRisks'],
      optionalAuditFields: ['previewAudit', 'previewAuditDigest'],
      confirmText: GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
      expectedWouldImport: '必须等于执行前重算 preview.summary.wouldImport。',
      candidateRows: '必须来自最新 preview 响应；execute 使用 candidateRows/candidateRowIds 与关键上下文重算 previewSignature；summary/items 仅用于展示和 skipped/blocked 风险确认，不作为签名载荷。',
      previewAudit: '可携带 preview 返回的 summary/items 只读审计快照和 previewAuditDigest；execute 成功结果会保留原始 skipped/blocked 风险，且不影响候选写入授权。',
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      backupReason: GENERATION_RECORD_IMPORT_BACKUP_REASON,
      writesGenerationRecords: true,
      targetTable: 'generation_records',
      defaultDuplicateStrategy: 'skip',
      allowedDuplicateStrategies: ['skip'],
      rejectedDuplicateStrategies: ['overwrite', 'append']
    },
    export: {
      route: 'GET /api/generation/records/export?format=xlsx|csv',
      formats: ['xlsx', 'csv'],
      defaultFormat: 'xlsx',
      maxRows: MAX_GENERATION_RECORD_EXPORT_ROWS,
      sheetName: '发电自用记录',
      fields: GENERATION_RECORD_EXPORT_FIELDS.map((field) => ({ ...field })),
      filters: ['organizationUnitId', 'monthStart', 'monthEnd', 'recordStatus'],
      readOnly: true
    },
    boundaries: {
      targetTables: ['generation_records'],
      writesEnergyRecords: false,
      writesCarbonEmissions: false,
      affectsProductionIntensity: false,
      purchasedElectricityReference: '仅在统计接口按 active energy_records + electricity + 同用能单元 + 同月份只读汇总；导入/导出字段不包含外购电抵扣。',
      realtimeCollectionIncluded: false,
      autoCreateLedger: false
    },
    errorDetailShape: ['rowNumber', 'fieldName', 'rawValue', 'code', 'message', 'severity']
  };
}

module.exports = {
  ELECTRICITY_ENERGY_TYPE_CODE,
  GENERATION_DATA_SOURCES,
  GENERATION_RECORD_EXPORT_FIELDS,
  GENERATION_RECORD_IMPORT_ALIASES,
  GENERATION_RECORD_IMPORT_BACKUP_REASON,
  GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
  GENERATION_RECORD_IMPORT_HEADERS,
  GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY,
  GENERATION_RECORD_IMPORT_STATUSES,
  GENERATION_RECORD_IMPORT_TEMPLATE_ID,
  GENERATION_RECORD_STATUSES,
  MAX_GENERATION_RECORD_EXPORT_ROWS,
  PHOTOVOLTAIC_ENERGY_TYPE_CODE,
  buildGenerationMeta,
  buildGenerationRecordExportRows,
  buildGenerationRecordImportPreviewFromRows,
  buildGenerationRecordImportPreviewSignature,
  buildMonthlyStatisticsRow,
  createGenerationRecord,
  createGenerationRecordImportPreviewFromUpload,
  executeGenerationRecordImport,
  exportGenerationRecords,
  getGenerationImportExportContract,
  getGenerationRecordImportHmacSecret,
  getGenerationStats,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  normalizeGenerationPayload,
  normalizeMonth,
  summarizeMonthlyRows,
  updateGenerationRecord,
  voidGenerationRecord
};
