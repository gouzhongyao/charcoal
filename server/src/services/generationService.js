const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const GENERATION_RECORD_STATUSES = Object.freeze(['active', 'void']);
const GENERATION_DATA_SOURCES = Object.freeze(['manual', 'calculation']);
const PHOTOVOLTAIC_ENERGY_TYPE_CODE = 'photovoltaic';
const ELECTRICITY_ENERGY_TYPE_CODE = 'electricity';

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
    const rows = db.prepare(
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
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapGenerationRecordRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
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

function buildGenerationMeta(extra = {}) {
  return {
    referenceOnly: true,
    writesEnergyRecords: false,
    writesCarbonEmissions: false,
    affectsProductionIntensity: false,
    importExportIncluded: false,
    realtimeCollectionIncluded: false,
    allowedEnergyTypeCodes: [PHOTOVOLTAIC_ENERGY_TYPE_CODE],
    unit: 'kWh',
    ...extra
  };
}

module.exports = {
  ELECTRICITY_ENERGY_TYPE_CODE,
  GENERATION_DATA_SOURCES,
  GENERATION_RECORD_STATUSES,
  PHOTOVOLTAIC_ENERGY_TYPE_CODE,
  buildGenerationMeta,
  buildMonthlyStatisticsRow,
  createGenerationRecord,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  normalizeGenerationPayload,
  normalizeMonth,
  summarizeMonthlyRows,
  updateGenerationRecord,
  voidGenerationRecord
};
