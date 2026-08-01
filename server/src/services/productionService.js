const crypto = require('crypto');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { createBackup } = require('./backupService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const PRODUCTION_UNIT_STATUSES = Object.freeze(['active', 'inactive']);
const PRODUCTION_OUTPUT_STATUSES = Object.freeze(['active', 'void']);
const PRODUCTION_OUTPUT_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);
const UTF8_BOM = '﻿';
const MAX_PRODUCTION_OUTPUT_EXPORT_ROWS = 5000;
const PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT = '确认导入月度产量记录';
const PRODUCTION_OUTPUT_IMPORT_SIGNATURE_VERSION = 'production-output-import-preview:v2';
const PRODUCTION_OUTPUT_IMPORT_HMAC_ALGORITHM = 'sha256';
const PRODUCTION_OUTPUT_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v2';
const DEFAULT_PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET = 'charcoal-local-development-production-output-import-hmac-secret';
const PRODUCTION_OUTPUT_IMPORT_BACKUP_REASON = 'production-output-import';
const PRODUCTION_OUTPUT_IMPORT_STATUSES = Object.freeze(['wouldImport', 'skipped', 'blocked']);
const PRODUCTION_OUTPUT_EXPORT_FIELDS = Object.freeze([
  { key: 'productionUnitCode', header: '产能单元编码' },
  { key: 'productionUnitName', header: '产能单元名称' },
  { key: 'organizationUnitPath', header: '所属用能单元' },
  { key: 'productName', header: '产品名称' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'outputValue', header: '产量值' },
  { key: 'outputUnit', header: '产量单位' },
  { key: 'dataSource', header: '数据来源' },
  { key: 'recordStatus', header: '状态' },
  { key: 'remark', header: '备注' }
]);
const PRODUCTION_OUTPUT_IMPORT_ALIASES = Object.freeze({
  unitCode: ['unit_code', 'unitCode', 'production_unit_code', 'productionUnitCode', '产能单元编码', '产线编码', '产量单元编码'],
  unitName: ['unit_name', 'unitName', 'production_unit_name', 'productionUnitName', '产能单元名称', '产线名称', '产量单元名称'],
  normalizedMonth: ['normalized_month', 'normalizedMonth', 'month', '月份', '归属月份'],
  outputValue: ['output_value', 'outputValue', '产量值', '产量', '月度产量'],
  outputUnit: ['output_unit', 'outputUnit', '产量单位', '单位'],
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

function getProductionOutputImportHmacSecret() {
  return normalizeText(process.env.PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET)
    || normalizeText(process.env.CHARCOAL_HMAC_SECRET)
    || normalizeText(process.env.APP_SECRET)
    || DEFAULT_PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET;
}

function buildProductionOutputImportSignaturePayload(preview) {
  return {
    version: PRODUCTION_OUTPUT_IMPORT_SIGNATURE_VERSION,
    algorithm: `HMAC-${PRODUCTION_OUTPUT_IMPORT_HMAC_ALGORITHM}`,
    dryRun: preview.dryRun === true,
    previewOnly: preview.previewOnly === true,
    writesProductionOutputs: preview.writesProductionOutputs === true,
    persistsImportBatch: preview.persistsImportBatch === true,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    summary: preview.summary,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows
  };
}

function hmacJson(value) {
  return crypto
    .createHmac(PRODUCTION_OUTPUT_IMPORT_HMAC_ALGORITHM, getProductionOutputImportHmacSecret())
    .update(stableStringify(value))
    .digest('hex');
}

function timingSafeEqualText(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifyProductionOutputImportPreviewSignature(preview, previewSignature) {
  return timingSafeEqualText(previewSignature, buildProductionOutputImportPreviewSignature(preview));
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function assertWhitelist(value, fieldName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, {
      code: 'UNSUPPORTED_PRODUCTION_VALUE',
      fieldName,
      rawValue: value,
      allowedValues
    });
  }
}

function parsePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return options.required ? null : undefined;
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

function parsePositiveNumber(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return options.required ? null : options.fallback;
  }
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是大于 0 的数字。`, { code: 'INVALID_POSITIVE_NUMBER', fieldName, rawValue: text });
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

function addMonths(month, count) {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1 + count;
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildMonthRange(monthStart, monthEnd) {
  if (monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  const months = [];
  let current = monthStart;
  while (current <= monthEnd) {
    months.push(current);
    if (months.length > 120) {
      throw badRequest('月份范围不能超过 120 个月。', { code: 'MONTH_RANGE_TOO_LARGE', monthStart, monthEnd, maxMonths: 120 });
    }
    current = addMonths(current, 1);
  }
  return months;
}

function normalizePagination(query = {}, defaults = {}) {
  const page = parsePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = parsePositiveInteger(query.pageSize, 'pageSize') || defaults.pageSize || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, defaults.maxPageSize || MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function getOrganizationUnitById(db, organizationUnitId, options = {}) {
  const row = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units
     WHERE id = ?`
  ).get(organizationUnitId);
  if (!row && !options.optional) {
    throw notFound('用能单元不存在。', { id: organizationUnitId });
  }
  return row || null;
}

function getProductionUnitById(db, unitId, options = {}) {
  const row = db.prepare(
    `SELECT
       pu.id,
       pu.unit_code AS unitCode,
       pu.unit_name AS unitName,
       pu.organization_unit_id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       pu.product_name AS productName,
       pu.output_unit AS outputUnit,
       pu.status,
       pu.remark,
       pu.created_at AS createdAt,
       pu.updated_at AS updatedAt
     FROM production_units pu
     JOIN organization_units ou ON ou.id = pu.organization_unit_id
     WHERE pu.id = ?`
  ).get(unitId);
  if (!row && !options.optional) {
    throw notFound('产能单元不存在。', { id: unitId });
  }
  return row || null;
}

function getProductionOutputById(db, outputId, options = {}) {
  const row = db.prepare(
    `SELECT
       por.id,
       por.production_unit_id AS productionUnitId,
       pu.unit_code AS productionUnitCode,
       pu.unit_name AS productionUnitName,
       por.normalized_month AS normalizedMonth,
       por.output_value AS outputValue,
       por.output_unit AS outputUnit,
       por.data_source AS dataSource,
       por.record_status AS recordStatus,
       por.remark,
       por.created_at AS createdAt,
       por.updated_at AS updatedAt
     FROM production_output_records por
     JOIN production_units pu ON pu.id = por.production_unit_id
     WHERE por.id = ?`
  ).get(outputId);
  if (!row && !options.optional) {
    throw notFound('月度产量记录不存在。', { id: outputId });
  }
  return row || null;
}

function mapProductionUnitRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    unitCode: row.unitCode,
    unitName: row.unitName,
    organizationUnitId: row.organizationUnitId,
    organizationUnitCode: row.organizationUnitCode,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    productName: row.productName,
    outputUnit: row.outputUnit,
    status: row.status,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapProductionOutputRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    productionUnitId: row.productionUnitId,
    productionUnitCode: row.productionUnitCode,
    productionUnitName: row.productionUnitName,
    organizationUnitId: row.organizationUnitId,
    organizationUnitCode: row.organizationUnitCode,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    productName: row.productName,
    normalizedMonth: row.normalizedMonth,
    outputValue: row.outputValue,
    outputUnit: row.outputUnit,
    dataSource: row.dataSource,
    recordStatus: row.recordStatus,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function ensureProductionUnitCodeUnique(db, unitCode, excludeId) {
  const existing = db.prepare('SELECT id FROM production_units WHERE unit_code = ? AND (? IS NULL OR id <> ?) LIMIT 1').get(unitCode, excludeId || null, excludeId || null);
  if (existing) {
    throw badRequest('产能单元编码已存在。', { code: 'DUPLICATE_PRODUCTION_UNIT_CODE', fieldName: 'unitCode', unitCode });
  }
}

function ensureActiveOrganizationUnit(db, organizationUnitId) {
  const organizationUnit = getOrganizationUnitById(db, organizationUnitId);
  if (organizationUnit.status !== 'active') {
    throw badRequest('产能单元所属用能单元必须为 active 状态。', {
      code: 'INACTIVE_ORGANIZATION_UNIT',
      organizationUnitId
    });
  }
  return organizationUnit;
}

function ensureActiveProductionUnit(db, productionUnitId) {
  const productionUnit = getProductionUnitById(db, productionUnitId);
  if (productionUnit.status !== 'active') {
    throw badRequest('月度产量所属产能单元必须为 active 状态。', {
      code: 'INACTIVE_PRODUCTION_UNIT',
      productionUnitId
    });
  }
  return productionUnit;
}

function ensureActiveOutputUnique(db, productionUnitId, normalizedMonth, excludeId) {
  const existing = db.prepare(
    `SELECT id
     FROM production_output_records
     WHERE production_unit_id = ?
       AND normalized_month = ?
       AND record_status = 'active'
       AND (? IS NULL OR id <> ?)
     LIMIT 1`
  ).get(productionUnitId, normalizedMonth, excludeId || null, excludeId || null);
  if (existing) {
    throw badRequest('同一产能单元同一月份只能存在一条 active 产量记录。', {
      code: 'DUPLICATE_ACTIVE_PRODUCTION_OUTPUT',
      productionUnitId,
      normalizedMonth,
      existingId: existing.id
    });
  }
}

function normalizeProductionUnitPayload(input = {}, options = {}) {
  const existing = options.existing || {};
  const unitCode = normalizeText(firstDefined(input, ['unitCode', 'unit_code'])) || existing.unitCode || null;
  const unitName = normalizeText(firstDefined(input, ['unitName', 'unit_name'])) || existing.unitName || null;
  const productName = normalizeText(firstDefined(input, ['productName', 'product_name'])) || existing.productName || null;
  const outputUnit = normalizeText(firstDefined(input, ['outputUnit', 'output_unit'])) || existing.outputUnit || null;
  const organizationUnitRaw = firstDefined(input, ['organizationUnitId', 'organization_unit_id']);
  const organizationUnitId = organizationUnitRaw === undefined || organizationUnitRaw === null || String(organizationUnitRaw).trim() === ''
    ? existing.organizationUnitId || null
    : parsePositiveInteger(organizationUnitRaw, 'organizationUnitId', { required: true });
  const status = normalizeText(input.status) || existing.status || 'active';

  if (!unitCode) throw badRequest('unitCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unitCode' });
  if (!unitName) throw badRequest('unitName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unitName' });
  if (!organizationUnitId) throw badRequest('organizationUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'organizationUnitId' });
  if (!productName) throw badRequest('productName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'productName' });
  if (!outputUnit) throw badRequest('outputUnit 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'outputUnit' });
  assertWhitelist(status, 'status', PRODUCTION_UNIT_STATUSES);

  return {
    unitCode,
    unitName,
    organizationUnitId,
    productName,
    outputUnit,
    status,
    remark: Object.prototype.hasOwnProperty.call(input, 'remark') ? normalizeText(input.remark) : (existing.remark || null)
  };
}

function normalizeProductionOutputPayload(input = {}, options = {}) {
  const existing = options.existing || {};
  const productionUnitRaw = firstDefined(input, ['productionUnitId', 'production_unit_id']);
  const productionUnitId = productionUnitRaw === undefined || productionUnitRaw === null || String(productionUnitRaw).trim() === ''
    ? existing.productionUnitId || null
    : parsePositiveInteger(productionUnitRaw, 'productionUnitId', { required: true });
  const monthRaw = firstDefined(input, ['normalizedMonth', 'normalized_month', 'month']);
  const normalizedMonth = monthRaw === undefined || monthRaw === null || String(monthRaw).trim() === ''
    ? existing.normalizedMonth || null
    : normalizeMonth(monthRaw, 'normalizedMonth');
  const outputRaw = firstDefined(input, ['outputValue', 'output_value']);
  const outputValue = outputRaw === undefined || outputRaw === null || String(outputRaw).trim() === ''
    ? existing.outputValue || null
    : parsePositiveNumber(outputRaw, 'outputValue', { required: true });
  const outputUnit = normalizeText(firstDefined(input, ['outputUnit', 'output_unit'])) || existing.outputUnit || null;
  const dataSource = normalizeText(firstDefined(input, ['dataSource', 'data_source'])) || existing.dataSource || 'manual';
  const recordStatus = normalizeText(firstDefined(input, ['recordStatus', 'record_status'])) || existing.recordStatus || 'active';

  if (!productionUnitId) throw badRequest('productionUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'productionUnitId' });
  if (!normalizedMonth) throw badRequest('normalizedMonth 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'normalizedMonth' });
  if (!outputValue) throw badRequest('outputValue 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'outputValue' });
  if (!outputUnit) throw badRequest('outputUnit 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'outputUnit' });
  assertWhitelist(dataSource, 'dataSource', PRODUCTION_OUTPUT_SOURCES);
  assertWhitelist(recordStatus, 'recordStatus', PRODUCTION_OUTPUT_STATUSES);

  return {
    productionUnitId,
    normalizedMonth,
    outputValue,
    outputUnit,
    dataSource,
    recordStatus,
    remark: Object.prototype.hasOwnProperty.call(input, 'remark') ? normalizeText(input.remark) : (existing.remark || null)
  };
}

function listProductionUnits(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 100, maxPageSize: 500 });
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', PRODUCTION_UNIT_STATUSES);
    where.push('pu.status = @status');
    params.status = status;
  }
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('pu.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(pu.unit_code LIKE @keyword OR pu.unit_name LIKE @keyword OR pu.product_name LIKE @keyword OR ou.unit_path LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM production_units pu JOIN organization_units ou ON ou.id = pu.organization_unit_id ${whereSql}`).get(params).total;
    const rows = db.prepare(
      `SELECT
         pu.id,
         pu.unit_code AS unitCode,
         pu.unit_name AS unitName,
         pu.organization_unit_id AS organizationUnitId,
         ou.unit_code AS organizationUnitCode,
         ou.unit_name AS organizationUnitName,
         ou.unit_path AS organizationUnitPath,
         pu.product_name AS productName,
         pu.output_unit AS outputUnit,
         pu.status,
         pu.remark,
         pu.created_at AS createdAt,
         pu.updated_at AS updatedAt
       FROM production_units pu
       JOIN organization_units ou ON ou.id = pu.organization_unit_id
       ${whereSql}
       ORDER BY pu.status ASC, pu.unit_code ASC, pu.id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapProductionUnitRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function createProductionUnit(input = {}) {
  const payload = normalizeProductionUnitPayload(input);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      ensureProductionUnitCodeUnique(db, payload.unitCode);
      ensureActiveOrganizationUnit(db, payload.organizationUnitId);
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO production_units (
           unit_code, unit_name, organization_unit_id, product_name, output_unit, status, remark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.unitCode, payload.unitName, payload.organizationUnitId, payload.productName, payload.outputUnit, payload.status, payload.remark, now, now);
      return mapProductionUnitRow(getProductionUnitById(db, result.lastInsertRowid));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateProductionUnit(unitId, input = {}) {
  const id = parsePositiveInteger(unitId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getProductionUnitById(db, id);
      const payload = normalizeProductionUnitPayload(input, { existing });
      ensureProductionUnitCodeUnique(db, payload.unitCode, id);
      ensureActiveOrganizationUnit(db, payload.organizationUnitId);
      const now = getNow();
      db.prepare(
        `UPDATE production_units
         SET unit_code = ?, unit_name = ?, organization_unit_id = ?, product_name = ?, output_unit = ?, status = ?, remark = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload.unitCode, payload.unitName, payload.organizationUnitId, payload.productName, payload.outputUnit, payload.status, payload.remark, now, id);
      return mapProductionUnitRow(getProductionUnitById(db, id));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function deactivateProductionUnit(unitId) {
  const id = parsePositiveInteger(unitId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getProductionUnitById(db, id);
      const activeOutputs = db.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ? AND record_status = 'active'").get(id).total;
      const totalOutputs = db.prepare('SELECT COUNT(*) AS total FROM production_output_records WHERE production_unit_id = ?').get(id).total;
      db.prepare("UPDATE production_units SET status = 'inactive', updated_at = ? WHERE id = ?").run(getNow(), id);
      return {
        id: existing.id,
        status: 'inactive',
        deactivated: true,
        referenceCounts: {
          activeOutputs: Number(activeOutputs || 0),
          outputRecords: Number(totalOutputs || 0)
        }
      };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function buildProductionOutputWhere(query = {}) {
  const where = [];
  const params = {};
  const productionUnitId = parsePositiveInteger(firstDefined(query, ['productionUnitId', 'production_unit_id']), 'productionUnitId');
  if (productionUnitId) {
    where.push('por.production_unit_id = @productionUnitId');
    params.productionUnitId = productionUnitId;
  }
  const status = normalizeText(firstDefined(query, ['recordStatus', 'record_status', 'status']));
  if (status) {
    assertWhitelist(status, 'recordStatus', PRODUCTION_OUTPUT_STATUSES);
    where.push('por.record_status = @recordStatus');
    params.recordStatus = status;
  }
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'normalizedMonthStart', 'month_start']), 'monthStart');
  if (monthStart) {
    where.push('por.normalized_month >= @monthStart');
    params.monthStart = monthStart;
  }
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'normalizedMonthEnd', 'month_end']), 'monthEnd');
  if (monthEnd) {
    where.push('por.normalized_month <= @monthEnd');
    params.monthEnd = monthEnd;
  }
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function selectProductionOutputRows(db, query = {}, limit = 500, offset = 0) {
  const { whereSql, params } = buildProductionOutputWhere(query);
  return db.prepare(
    `SELECT
       por.id,
       por.production_unit_id AS productionUnitId,
       pu.unit_code AS productionUnitCode,
       pu.unit_name AS productionUnitName,
       pu.organization_unit_id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       pu.product_name AS productName,
       por.normalized_month AS normalizedMonth,
       por.output_value AS outputValue,
       por.output_unit AS outputUnit,
       por.data_source AS dataSource,
       por.record_status AS recordStatus,
       por.remark,
       por.created_at AS createdAt,
       por.updated_at AS updatedAt
     FROM production_output_records por
     JOIN production_units pu ON pu.id = por.production_unit_id
     JOIN organization_units ou ON ou.id = pu.organization_unit_id
     ${whereSql}
     ORDER BY por.normalized_month DESC, por.id DESC
     LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map(mapProductionOutputRow);
}

function listProductionOutputs(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 100, maxPageSize: 500 });
  const { whereSql, params } = buildProductionOutputWhere(query);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM production_output_records por
       JOIN production_units pu ON pu.id = por.production_unit_id
       JOIN organization_units ou ON ou.id = pu.organization_unit_id
       ${whereSql}`
    ).get(params).total;
    const rows = selectProductionOutputRows(db, query, pageSize, offset);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function buildProductionOutputExportRows(rows = []) {
  return rows.map((row) => {
    const output = {};
    PRODUCTION_OUTPUT_EXPORT_FIELDS.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
}

function exportProductionOutputs(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const db = openDatabase();
  try {
    const rows = selectProductionOutputRows(db, query, MAX_PRODUCTION_OUTPUT_EXPORT_ROWS, 0);
    const exportRows = buildProductionOutputExportRows(rows);
    const headers = PRODUCTION_OUTPUT_EXPORT_FIELDS.map((field) => field.header);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `月度产量导出-${date}.${format}`;
    if (format === 'csv') {
      const csvLines = [headers, ...exportRows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsvCell).join(','));
      return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${UTF8_BOM}${csvLines.join('\n')}\n`, 'utf8'), rowCount: rows.length, fields: headers };
    }
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
    worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 12), 32) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, '月度产量');
    return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers };
  } finally {
    db.close();
  }
}

function normalizeHeaderName(value) {
  return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase();
}

function canonicalProductionOutputImportFieldName(header) {
  const normalized = normalizeHeaderName(header);
  for (const [field, aliases] of Object.entries(PRODUCTION_OUTPUT_IMPORT_ALIASES)) {
    if (aliases.map(normalizeHeaderName).includes(normalized)) return field;
  }
  return null;
}

function mapProductionOutputImportFields(row = {}) {
  const mapped = {};
  const fieldMapping = {};
  Object.entries(row || {}).forEach(([header, value]) => {
    const field = canonicalProductionOutputImportFieldName(header);
    if (!field) return;
    if (Object.prototype.hasOwnProperty.call(mapped, field) && normalizeText(mapped[field])) return;
    mapped[field] = value;
    fieldMapping[field] = header;
  });
  return { mapped, fieldMapping };
}

function createProductionOutputImportIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return { rowNumber, fieldName, rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue), code, message, severity };
}

function summarizeProductionOutputImportItems(items = []) {
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

function buildProductionOutputImportPreviewSignature(preview) {
  return `${PRODUCTION_OUTPUT_IMPORT_SIGNATURE_PREFIX}:${hmacJson(buildProductionOutputImportSignaturePayload(preview))}`;
}

function buildProductionOutputImportIndexes(input = {}) {
  const unitsByCode = new Map();
  const unitsByName = new Map();
  (input.productionUnits || []).forEach((unit) => {
    if (unit.unitCode) unitsByCode.set(String(unit.unitCode), unit);
    if (unit.unitName) {
      const list = unitsByName.get(String(unit.unitName)) || [];
      list.push(unit);
      unitsByName.set(String(unit.unitName), list);
    }
  });
  const activeOutputByUnitMonth = new Map();
  (input.activeOutputs || []).forEach((output) => {
    activeOutputByUnitMonth.set(`${output.productionUnitId} ${output.normalizedMonth}`, output);
  });
  return { unitsByCode, unitsByName, activeOutputByUnitMonth };
}

function loadProductionOutputImportIndexes(db) {
  return buildProductionOutputImportIndexes({
    productionUnits: db.prepare(
      `SELECT
         pu.id,
         pu.unit_code AS unitCode,
         pu.unit_name AS unitName,
         pu.organization_unit_id AS organizationUnitId,
         ou.unit_path AS organizationUnitPath,
         pu.product_name AS productName,
         pu.output_unit AS outputUnit,
         pu.status
       FROM production_units pu
       JOIN organization_units ou ON ou.id = pu.organization_unit_id`
    ).all(),
    activeOutputs: db.prepare(
      `SELECT id, production_unit_id AS productionUnitId, normalized_month AS normalizedMonth
       FROM production_output_records
       WHERE record_status = 'active'`
    ).all()
  });
}

function readRequiredMappedText(mapped, field, rowNumber, label, errors) {
  const value = normalizeText(mapped[field]);
  if (!value) {
    errors.push(createProductionOutputImportIssue(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${label || field} 为空或未映射。`));
    return null;
  }
  return value;
}

function validateAndNormalizeProductionOutputImportRow(row, rowNumber, indexes, seenImportKeys = new Set()) {
  const { mapped, fieldMapping } = mapProductionOutputImportFields(row);
  const errors = [];
  const warnings = [];
  const unitCode = readRequiredMappedText(mapped, 'unitCode', rowNumber, 'unitCode', errors);
  const unitName = normalizeText(mapped.unitName);
  const outputUnit = readRequiredMappedText(mapped, 'outputUnit', rowNumber, 'outputUnit', errors);
  let normalizedMonthValue = null;
  let outputValue = null;
  let dataSource = normalizeText(mapped.dataSource) || 'upload';
  if (!normalizeText(mapped.normalizedMonth)) {
    errors.push(createProductionOutputImportIssue(rowNumber, 'normalizedMonth', mapped.normalizedMonth, 'REQUIRED_FIELD_MISSING', '必填字段 normalizedMonth 为空或未映射。'));
  } else {
    try {
      normalizedMonthValue = normalizeMonth(mapped.normalizedMonth, 'normalizedMonth');
    } catch (error) {
      errors.push(createProductionOutputImportIssue(rowNumber, 'normalizedMonth', mapped.normalizedMonth, error?.details?.code || 'INVALID_MONTH', error.message || '月份必须是 YYYY-MM 格式。'));
    }
  }
  if (!normalizeText(mapped.outputValue)) {
    errors.push(createProductionOutputImportIssue(rowNumber, 'outputValue', mapped.outputValue, 'REQUIRED_FIELD_MISSING', '必填字段 outputValue 为空或未映射。'));
  } else {
    try {
      outputValue = parsePositiveNumber(mapped.outputValue, 'outputValue', { required: true });
    } catch (error) {
      errors.push(createProductionOutputImportIssue(rowNumber, 'outputValue', mapped.outputValue, error?.details?.code || 'INVALID_POSITIVE_NUMBER', error.message || 'outputValue 必须大于 0。'));
    }
  }
  if (!PRODUCTION_OUTPUT_SOURCES.includes(dataSource)) {
    errors.push(createProductionOutputImportIssue(rowNumber, 'dataSource', mapped.dataSource, 'UNSUPPORTED_PRODUCTION_OUTPUT_SOURCE', 'dataSource 不在允许范围内：manual / upload / calculation。'));
    dataSource = 'upload';
  }

  const productionUnit = unitCode ? indexes.unitsByCode.get(unitCode) || null : null;
  if (unitCode && !productionUnit) {
    errors.push(createProductionOutputImportIssue(rowNumber, 'unitCode', unitCode, 'UNKNOWN_PRODUCTION_UNIT', '未找到匹配产能单元；产量导入不自动创建产能单元。'));
  } else if (productionUnit && productionUnit.status !== 'active') {
    errors.push(createProductionOutputImportIssue(rowNumber, 'unitCode', unitCode, 'INACTIVE_PRODUCTION_UNIT', '产能单元不是 active 状态，禁止导入 active 月度产量。'));
  }
  if (unitName) {
    const nameMatches = indexes.unitsByName.get(unitName) || [];
    if (nameMatches.length > 1) {
      errors.push(createProductionOutputImportIssue(rowNumber, 'unitName', unitName, 'AMBIGUOUS_PRODUCTION_UNIT_NAME', '产能单元名称匹配多条记录；请以唯一编码为准并修正名称歧义。'));
    } else if (productionUnit && unitName !== productionUnit.unitName) {
      errors.push(createProductionOutputImportIssue(rowNumber, 'unitName', unitName, 'PRODUCTION_UNIT_NAME_MISMATCH', '填写的产能单元名称与编码匹配结果不一致。'));
    }
  }
  if (productionUnit && outputUnit && outputUnit !== productionUnit.outputUnit) {
    warnings.push(createProductionOutputImportIssue(rowNumber, 'outputUnit', outputUnit, 'OUTPUT_UNIT_MISMATCH', `导入产量单位 ${outputUnit} 与产能单元产量单位 ${productionUnit.outputUnit} 不一致；本轮不静默改单位。`, 'warning'));
  }

  const record = productionUnit && normalizedMonthValue && outputValue && outputUnit ? {
    rowNumber,
    unitCode,
    unitName: unitName || null,
    productionUnitId: productionUnit.id,
    productionUnitCode: productionUnit.unitCode,
    productionUnitName: productionUnit.unitName,
    organizationUnitId: productionUnit.organizationUnitId,
    organizationUnitPath: productionUnit.organizationUnitPath,
    productName: productionUnit.productName,
    normalizedMonth: normalizedMonthValue,
    outputValue,
    outputUnit,
    expectedOutputUnit: productionUnit.outputUnit,
    dataSource,
    remark: normalizeText(mapped.remark)
  } : null;

  if (errors.length > 0 || warnings.length > 0) {
    return { fieldMapping, mapped, record, status: 'blocked', wouldImport: false, reasons: errors.concat(warnings) };
  }
  const importKey = `${record.productionUnitId} ${record.normalizedMonth}`;
  const existingOutput = indexes.activeOutputByUnitMonth.get(importKey);
  if (existingOutput) {
    return {
      fieldMapping,
      record,
      status: 'skipped',
      wouldImport: false,
      existingOutputId: existingOutput.id,
      reasons: [createProductionOutputImportIssue(rowNumber, 'unitCode+normalizedMonth', `${record.unitCode}|${record.normalizedMonth}`, 'DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED', '同一产能单元同月份已有 active 产量，按策略跳过且不覆盖、不作废旧记录。', 'warning')]
    };
  }
  if (seenImportKeys.has(importKey)) {
    return {
      fieldMapping,
      record,
      status: 'skipped',
      wouldImport: false,
      reasons: [createProductionOutputImportIssue(rowNumber, 'unitCode+normalizedMonth', `${record.unitCode}|${record.normalizedMonth}`, 'DUPLICATE_IMPORT_CANDIDATE_SKIPPED', '同一导入预演中已存在相同产能单元同月份候选，后续重复行跳过以保持 active 月度唯一。', 'warning')]
    };
  }
  seenImportKeys.add(importKey);
  return {
    fieldMapping,
    record,
    status: 'wouldImport',
    wouldImport: true,
    reasons: [createProductionOutputImportIssue(rowNumber, 'row', record.rowNumber, 'READY_TO_IMPORT', '满足校验且无 active 月度产量冲突，可受控导入。', 'info')]
  };
}

function buildProductionOutputImportPreviewWithDb(db, rows = []) {
  const indexes = loadProductionOutputImportIndexes(db);
  const seenImportKeys = new Set();
  const fieldMapping = {};
  const items = rows.map((row, index) => {
      const rowNumber = Number(row.rowNumber || row.__rowNumber || index + 2);
      const result = validateAndNormalizeProductionOutputImportRow(row, rowNumber, indexes, seenImportKeys);
      Object.assign(fieldMapping, result.fieldMapping || {});
      const record = result.record || {};
      const mapped = result.mapped || {};
      const item = {
        rowNumber,
        rowId: rowNumber,
        unitCode: record.unitCode || normalizeText(mapped.unitCode) || null,
        unitName: record.unitName || normalizeText(mapped.unitName) || null,
        productionUnitId: record.productionUnitId || null,
        productionUnitCode: record.productionUnitCode || null,
        productionUnitName: record.productionUnitName || null,
        organizationUnitPath: record.organizationUnitPath || null,
        productName: record.productName || null,
        normalizedMonth: record.normalizedMonth || normalizeText(mapped.normalizedMonth) || null,
        outputValue: record.outputValue ?? normalizeText(mapped.outputValue),
        outputUnit: record.outputUnit || normalizeText(mapped.outputUnit) || null,
        expectedOutputUnit: record.expectedOutputUnit || null,
        dataSource: record.dataSource || normalizeText(mapped.dataSource) || 'upload',
        remark: record.remark || normalizeText(mapped.remark) || null,
        status: result.status,
        wouldImport: result.wouldImport,
        existingOutputId: result.existingOutputId || null,
        reasons: result.reasons || []
      };
      item.reasonCodes = item.reasons.map((reason) => reason.code).join('|');
      item.reasonText = item.reasons.map((reason) => reason.message).join('；');
      return item;
    });
    const summary = summarizeProductionOutputImportItems(items);
    const candidateRowIds = items.filter((item) => item.wouldImport).map((item) => item.rowNumber).sort((a, b) => a - b);
    const candidateRows = items.map((item) => ({
      rowNumber: item.rowNumber,
      unitCode: item.unitCode,
      unitName: item.unitName,
      normalizedMonth: item.normalizedMonth,
      outputValue: item.outputValue,
      outputUnit: item.outputUnit,
      dataSource: item.dataSource,
      remark: item.remark
    }));
    const preview = {
      dryRun: true,
      previewOnly: true,
      writesProductionOutputs: false,
      persistsImportBatch: false,
      confirmText: PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT,
      backupReason: PRODUCTION_OUTPUT_IMPORT_BACKUP_REASON,
      fieldMapping,
      summary,
      candidateRowIds,
      candidateRows,
      items,
      notices: [
        '本轮产量导入 preview 不写入 production_output_records，也不持久化 import_batches/import_errors；审计明细随响应返回。',
        'execute 必须携带固定确认文本、previewSignature、expectedWouldImport、candidateRowIds、candidateRows、acknowledgeSkippedRisks=true、requireBackup=true。',
        '同产能单元同月份已有 active 产量时跳过并警告；不覆盖、不作废旧记录，不自动创建产能单元。'
      ]
    };
  preview.previewSignature = buildProductionOutputImportPreviewSignature(preview);
  return preview;
}

function buildProductionOutputImportPreviewFromRows(rows = []) {
  const db = openDatabase();
  try {
    return buildProductionOutputImportPreviewWithDb(db, rows);
  } finally {
    db.close();
  }
}

function createProductionOutputImportPreviewFromUpload(file) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的月度产量表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  assertSupportedImportFile(file.originalname);
  const parsed = parseImportFile(file.path, file.originalname);
  return buildProductionOutputImportPreviewFromRows(parsed.rows || []);
}

function normalizeCandidateRowIds(value) {
  if (!Array.isArray(value)) {
    throw badRequest('candidateRowIds 必须是数组。', { code: 'PRODUCTION_OUTPUT_IMPORT_CANDIDATE_ROW_IDS_REQUIRED' });
  }
  return value.map((id) => parsePositiveInteger(id, 'candidateRowIds', { required: true })).sort((a, b) => a - b);
}

function assertSameArray(actual, expected, code, message) {
  if (actual.length !== expected.length || actual.some((value, index) => Number(value) !== Number(expected[index]))) {
    throw badRequest(message, { code, actual, expected });
  }
}

async function executeProductionOutputImport(body = {}) {
  const confirmText = normalizeText(body.confirmText);
  if (confirmText !== PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT) {
    throw badRequest('确认文本不匹配，已拒绝导入月度产量记录。', { code: 'PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT_MISMATCH', requiredConfirmText: PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT });
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throw badRequest('必须确认已知晓冲突、重复、无效和阻断记录会被跳过。', { code: 'PRODUCTION_OUTPUT_IMPORT_SKIPPED_RISKS_ACK_REQUIRED' });
  }
  if (body.requireBackup !== true) {
    throw badRequest('执行前必须要求自动备份，requireBackup 必须显式为 true。', { code: 'PRODUCTION_OUTPUT_IMPORT_BACKUP_REQUIRED' });
  }
  const previewSignature = normalizeText(body.previewSignature);
  if (!previewSignature) {
    throw badRequest('previewSignature 为必填项。', { code: 'PRODUCTION_OUTPUT_IMPORT_PREVIEW_SIGNATURE_REQUIRED' });
  }
  const expectedWouldImport = parsePositiveInteger(body.expectedWouldImport, 'expectedWouldImport', { required: true });
  const candidateRowIds = normalizeCandidateRowIds(body.candidateRowIds);
  if (!Array.isArray(body.candidateRows) || body.candidateRows.length === 0) {
    throw badRequest('candidateRows 为必填数组，必须来自最新导入预演响应。', { code: 'PRODUCTION_OUTPUT_IMPORT_CANDIDATE_ROWS_REQUIRED' });
  }
  const db = openDatabase();
  let preview;
  try {
    preview = buildProductionOutputImportPreviewWithDb(db, body.candidateRows);
  } finally {
    db.close();
  }
  if (!verifyProductionOutputImportPreviewSignature(preview, previewSignature)) {
    throw badRequest('当前 previewSignature 与执行前重新计算结果不一致，已拒绝执行。', { code: 'PRODUCTION_OUTPUT_IMPORT_PREVIEW_SIGNATURE_MISMATCH' });
  }
  if (Number(preview.summary.wouldImport || 0) !== Number(expectedWouldImport || 0)) {
    throw badRequest('expectedWouldImport 与执行前重新计算结果不一致，已拒绝执行。', { code: 'PRODUCTION_OUTPUT_IMPORT_WOULD_IMPORT_MISMATCH', expected: preview.summary.wouldImport, actual: expectedWouldImport });
  }
  assertSameArray(preview.candidateRowIds, candidateRowIds, 'PRODUCTION_OUTPUT_IMPORT_CANDIDATE_ROW_IDS_MISMATCH', 'candidateRowIds 与执行前重新计算结果不一致，已拒绝执行。');

  const backup = await createBackup({ reason: PRODUCTION_OUTPUT_IMPORT_BACKUP_REASON });
  const writeDb = openDatabase();
  try {
    const transaction = writeDb.transaction(() => {
      const latestPreview = buildProductionOutputImportPreviewWithDb(writeDb, body.candidateRows);
      if (!verifyProductionOutputImportPreviewSignature(latestPreview, previewSignature)) {
        throw badRequest('当前 previewSignature 与写入前重新计算结果不一致，已拒绝执行。', { code: 'PRODUCTION_OUTPUT_IMPORT_PREVIEW_SIGNATURE_MISMATCH' });
      }
      const insertOutput = writeDb.prepare(
        `INSERT INTO production_output_records (
           production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, remark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      );
      const now = getNow();
      const items = [];
      let imported = 0;
      latestPreview.items.forEach((item) => {
        if (!item.wouldImport) {
          items.push({ rowNumber: item.rowNumber, status: 'skipped', previewStatus: item.status, reasonCodes: item.reasonCodes, reason: item.reasonText, existingOutputId: item.existingOutputId || null });
          return;
        }
        const insertResult = insertOutput.run(item.productionUnitId, item.normalizedMonth, item.outputValue, item.outputUnit, item.dataSource || 'upload', item.remark || null, now, now);
        imported += 1;
        items.push({ rowNumber: item.rowNumber, status: 'imported', outputRecordId: Number(insertResult.lastInsertRowid), productionUnitId: item.productionUnitId, normalizedMonth: item.normalizedMonth, outputValue: item.outputValue, outputUnit: item.outputUnit, reason: '已按受控导入写入 active 月度产量记录。' });
      });
      return {
        executed: true,
        dryRun: false,
        writesProductionOutputs: true,
        persistsImportBatch: false,
        imported,
        skipped: items.filter((item) => item.status === 'skipped').length,
        previewSignature: latestPreview.previewSignature,
        expectedWouldImport,
        candidateRowIds: latestPreview.candidateRowIds,
        backup,
        summary: { ...latestPreview.summary, imported },
        importedItems: items.filter((item) => item.status === 'imported'),
        skippedItems: items.filter((item) => item.status === 'skipped'),
        items,
        note: '已按最新 preview 的 wouldImport 候选受控导入；冲突、重复、无效和阻断状态均跳过，不覆盖、不作废既有 active 产量。'
      };
    });
    return transaction();
  } finally {
    writeDb.close();
  }
}

function createProductionOutput(input = {}) {
  const payload = normalizeProductionOutputPayload(input);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const productionUnit = ensureActiveProductionUnit(db, payload.productionUnitId);
      if (!normalizeText(firstDefined(input, ['outputUnit', 'output_unit']))) {
        payload.outputUnit = productionUnit.outputUnit;
      }
      if (payload.recordStatus === 'active') {
        ensureActiveOutputUnique(db, payload.productionUnitId, payload.normalizedMonth);
      }
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO production_output_records (
           production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, remark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.productionUnitId, payload.normalizedMonth, payload.outputValue, payload.outputUnit, payload.dataSource, payload.recordStatus, payload.remark, now, now);
      return mapProductionOutputRow(getProductionOutputById(db, result.lastInsertRowid));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateProductionOutput(outputId, input = {}) {
  const id = parsePositiveInteger(outputId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getProductionOutputById(db, id);
      const payload = normalizeProductionOutputPayload(input, { existing });
      ensureActiveProductionUnit(db, payload.productionUnitId);
      if (payload.recordStatus === 'active') {
        ensureActiveOutputUnique(db, payload.productionUnitId, payload.normalizedMonth, id);
      }
      const now = getNow();
      db.prepare(
        `UPDATE production_output_records
         SET production_unit_id = ?, normalized_month = ?, output_value = ?, output_unit = ?, data_source = ?, record_status = ?, remark = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload.productionUnitId, payload.normalizedMonth, payload.outputValue, payload.outputUnit, payload.dataSource, payload.recordStatus, payload.remark, now, id);
      return mapProductionOutputRow(getProductionOutputById(db, id));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function voidProductionOutput(outputId) {
  const id = parsePositiveInteger(outputId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getProductionOutputById(db, id);
      db.prepare("UPDATE production_output_records SET record_status = 'void', updated_at = ? WHERE id = ?").run(getNow(), id);
      return {
        id: existing.id,
        productionUnitId: existing.productionUnitId,
        recordStatus: 'void',
        voided: true
      };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function loadActiveOutputByMonth(db, productionUnitId, months) {
  if (!months.length) return new Map();
  const placeholders = months.map((_, index) => `@month${index}`).join(', ');
  const params = { productionUnitId };
  months.forEach((month, index) => {
    params[`month${index}`] = month;
  });
  const rows = db.prepare(
    `SELECT
       id,
       production_unit_id AS productionUnitId,
       normalized_month AS normalizedMonth,
       output_value AS outputValue,
       output_unit AS outputUnit,
       data_source AS dataSource,
       record_status AS recordStatus
     FROM production_output_records
     WHERE production_unit_id = @productionUnitId
       AND record_status = 'active'
       AND normalized_month IN (${placeholders})`
  ).all(params);
  return new Map(rows.map((row) => [row.normalizedMonth, row]));
}

function loadEnergyByMonth(db, organizationUnitId, months) {
  if (!months.length) return new Map();
  const placeholders = months.map((_, index) => `@month${index}`).join(', ');
  const params = { organizationUnitId };
  months.forEach((month, index) => {
    params[`month${index}`] = month;
  });
  const rows = db.prepare(
    `SELECT
       er.normalized_month AS normalizedMonth,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       er.normalized_unit AS normalizedUnit,
       COUNT(er.id) AS recordCount,
       COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     WHERE er.record_status = 'active'
       AND er.organization_unit_id = @organizationUnitId
       AND er.normalized_month IN (${placeholders})
     GROUP BY er.normalized_month, et.code, et.name, er.normalized_unit
     ORDER BY er.normalized_month ASC, et.display_order ASC, et.code ASC, er.normalized_unit ASC`
  ).all(params);
  const byMonth = new Map();
  rows.forEach((row) => {
    const list = byMonth.get(row.normalizedMonth) || [];
    list.push({
      energyTypeCode: row.energyTypeCode,
      energyTypeName: row.energyTypeName,
      normalizedUnit: row.normalizedUnit,
      recordCount: row.recordCount,
      totalNormalizedValue: Number(row.totalNormalizedValue || 0)
    });
    byMonth.set(row.normalizedMonth, list);
  });
  return byMonth;
}

function resolveIntensityMonths(db, productionUnitId, query = {}) {
  const start = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'normalizedMonthStart', 'month_start']), 'monthStart');
  const end = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'normalizedMonthEnd', 'month_end']), 'monthEnd');
  if (start || end) {
    const monthStart = start || end;
    const monthEnd = end || start;
    return buildMonthRange(monthStart, monthEnd);
  }
  return db.prepare(
    `SELECT normalized_month AS normalizedMonth
     FROM production_output_records
     WHERE production_unit_id = ?
       AND record_status = 'active'
     ORDER BY normalized_month ASC`
  ).all(productionUnitId).map((row) => row.normalizedMonth);
}

function buildEnergyIntensityRow(productionUnit, month, output, energyRows) {
  const energyByType = energyRows || [];
  const energyTotal = energyByType.reduce((sum, row) => sum + Number(row.totalNormalizedValue || 0), 0);
  const energyUnits = [...new Set(energyByType.map((row) => row.normalizedUnit).filter(Boolean))];
  const energyTypeCodes = [...new Set(energyByType.map((row) => row.energyTypeCode).filter(Boolean))];
  const mixedEnergyNotice = energyTypeCodes.length > 1 || energyUnits.length > 1
    ? 'energyTotal 为不同能源类型或不同标准单位的 normalized_value 直接求和，仅用于首期粗略口径；请结合 energyByType 明细谨慎解读，不做跨能源等价换算。'
    : null;

  if (!output) {
    return {
      productionUnitId: productionUnit.id,
      productionUnitCode: productionUnit.unitCode,
      productionUnitName: productionUnit.unitName,
      organizationUnitId: productionUnit.organizationUnitId,
      organizationUnitPath: productionUnit.organizationUnitPath,
      productName: productionUnit.productName,
      normalizedMonth: month,
      outputValue: null,
      outputUnit: productionUnit.outputUnit,
      energyTotal,
      energyUnit: energyUnits.length === 1 ? energyUnits[0] : (energyUnits.length > 1 ? 'mixed' : null),
      energyUnits,
      energyByType,
      energyIntensity: null,
      status: 'no-output',
      notice: '未找到该产能单元当月 active 月度产量，单位产品能耗不可计算。'
    };
  }

  const outputValue = Number(output.outputValue || 0);
  if (outputValue <= 0) {
    return {
      productionUnitId: productionUnit.id,
      productionUnitCode: productionUnit.unitCode,
      productionUnitName: productionUnit.unitName,
      organizationUnitId: productionUnit.organizationUnitId,
      organizationUnitPath: productionUnit.organizationUnitPath,
      productName: productionUnit.productName,
      normalizedMonth: month,
      outputValue,
      outputUnit: output.outputUnit || productionUnit.outputUnit,
      energyTotal,
      energyUnit: energyUnits.length === 1 ? energyUnits[0] : (energyUnits.length > 1 ? 'mixed' : null),
      energyUnits,
      energyByType,
      energyIntensity: null,
      status: 'zero-output',
      notice: '当月 active 产量为 0，单位产品能耗不可计算。'
    };
  }

  if (energyByType.length === 0 || energyTotal <= 0) {
    return {
      productionUnitId: productionUnit.id,
      productionUnitCode: productionUnit.unitCode,
      productionUnitName: productionUnit.unitName,
      organizationUnitId: productionUnit.organizationUnitId,
      organizationUnitPath: productionUnit.organizationUnitPath,
      productName: productionUnit.productName,
      normalizedMonth: month,
      outputValue,
      outputUnit: output.outputUnit || productionUnit.outputUnit,
      energyTotal: 0,
      energyUnit: null,
      energyUnits: [],
      energyByType: [],
      energyIntensity: null,
      status: 'no-energy',
      notice: '所属用能单元当月未找到 active energy_records，单位产品能耗不可计算。'
    };
  }

  return {
    productionUnitId: productionUnit.id,
    productionUnitCode: productionUnit.unitCode,
    productionUnitName: productionUnit.unitName,
    organizationUnitId: productionUnit.organizationUnitId,
    organizationUnitPath: productionUnit.organizationUnitPath,
    productName: productionUnit.productName,
    normalizedMonth: month,
    outputValue,
    outputUnit: output.outputUnit || productionUnit.outputUnit,
    energyTotal,
    energyUnit: energyUnits.length === 1 ? energyUnits[0] : 'mixed',
    energyUnits,
    energyByType,
    energyIntensity: energyTotal / outputValue,
    status: 'calculable',
    notice: mixedEnergyNotice
  };
}

function getUnitEnergyIntensity(query = {}) {
  const productionUnitId = parsePositiveInteger(firstDefined(query, ['productionUnitId', 'production_unit_id']), 'productionUnitId', { required: true });
  if (!productionUnitId) {
    throw badRequest('productionUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'productionUnitId' });
  }
  const db = openDatabase();
  try {
    const productionUnit = mapProductionUnitRow(getProductionUnitById(db, productionUnitId));
    const months = resolveIntensityMonths(db, productionUnitId, query);
    const outputByMonth = loadActiveOutputByMonth(db, productionUnitId, months);
    const energyByMonth = loadEnergyByMonth(db, productionUnit.organizationUnitId, months);
    const rows = months.map((month) => buildEnergyIntensityRow(
      productionUnit,
      month,
      outputByMonth.get(month) || null,
      energyByMonth.get(month) || []
    ));
    return {
      rows,
      meta: {
        productionUnitId,
        organizationUnitId: productionUnit.organizationUnitId,
        monthStart: months[0] || null,
        monthEnd: months[months.length - 1] || null,
        formula: '单位产品能耗 = 产能单元所属用能单元当月 active energy_records.normalized_value 汇总 / 产能单元当月 active output_value',
        generationIncluded: false,
        selfUseIncluded: false,
        carbonAccountingIncluded: false
      }
    };
  } finally {
    db.close();
  }
}

module.exports = {
  PRODUCTION_OUTPUT_EXPORT_FIELDS,
  PRODUCTION_OUTPUT_IMPORT_BACKUP_REASON,
  PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT,
  PRODUCTION_OUTPUT_IMPORT_STATUSES,
  PRODUCTION_OUTPUT_SOURCES,
  PRODUCTION_OUTPUT_STATUSES,
  PRODUCTION_UNIT_STATUSES,
  buildEnergyIntensityRow,
  buildProductionOutputExportRows,
  buildProductionOutputImportIndexes,
  buildProductionOutputImportPreviewFromRows,
  createProductionOutput,
  createProductionOutputImportPreviewFromUpload,
  createProductionUnit,
  deactivateProductionUnit,
  executeProductionOutputImport,
  exportProductionOutputs,
  getUnitEnergyIntensity,
  listProductionOutputs,
  listProductionUnits,
  mapProductionOutputImportFields,
  normalizeMonth,
  normalizeProductionOutputPayload,
  normalizeProductionUnitPayload,
  updateProductionOutput,
  updateProductionUnit,
  validateAndNormalizeProductionOutputImportRow,
  voidProductionOutput
};
