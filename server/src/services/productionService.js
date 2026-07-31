const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const PRODUCTION_UNIT_STATUSES = Object.freeze(['active', 'inactive']);
const PRODUCTION_OUTPUT_STATUSES = Object.freeze(['active', 'void']);
const PRODUCTION_OUTPUT_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);

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

function listProductionOutputs(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 100, maxPageSize: 500 });
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
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM production_output_records por JOIN production_units pu ON pu.id = por.production_unit_id ${whereSql}`).get(params).total;
    const rows = db.prepare(
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
       ${whereSql}
       ORDER BY por.normalized_month DESC, por.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapProductionOutputRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
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
  PRODUCTION_OUTPUT_SOURCES,
  PRODUCTION_OUTPUT_STATUSES,
  PRODUCTION_UNIT_STATUSES,
  buildEnergyIntensityRow,
  createProductionOutput,
  createProductionUnit,
  deactivateProductionUnit,
  getUnitEnergyIntensity,
  listProductionOutputs,
  listProductionUnits,
  normalizeMonth,
  normalizeProductionOutputPayload,
  normalizeProductionUnitPayload,
  updateProductionOutput,
  updateProductionUnit,
  voidProductionOutput
};
