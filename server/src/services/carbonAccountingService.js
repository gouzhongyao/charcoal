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
const {
  buildEnergyRecordWhere,
  buildPaginationMeta,
  normalizeEnergyRecordFilters,
  normalizePagination,
  normalizePositiveInteger
} = require('./energyRecordQuery');
const {
  DEFAULT_CALCULATION_METHOD,
  DEFAULT_EMISSION_UNIT,
  DEFAULT_REGION,
  calculateEmissionValue,
  extractYearFromMonth,
  normalizeBooleanFlag,
  normalizeCalculationMethod,
  normalizeEmissionGroupBy,
  normalizeEmissionSort,
  normalizePositiveNumber,
  normalizeRegion,
  normalizeText,
  normalizeYear,
  selectBestCarbonFactor
} = require('./carbonAccountingUtils');

const FACTOR_PAGE_SIZE_MAX = 200;
const CALCULATION_LIMIT_MAX = 5000;
const MAX_CARBON_EXPORT_ROWS = 5000;
const EMISSION_STATUSES = Object.freeze(['calculated', 'factor_missing', 'invalid_record', 'superseded']);
const FACTOR_STATUSES = Object.freeze(['active', 'inactive']);
const CARBON_FACTOR_IMPORT_TYPE = 'carbon_factor';
const CARBON_FACTOR_IMPORT_TEMPLATE_ID = 'carbon-factors';
const CARBON_FACTOR_IMPORT_CONFIRM_TEXT = '确认导入碳因子';
const CARBON_FACTOR_IMPORT_BACKUP_REASON = 'carbon-factor-import';
const CARBON_FACTOR_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v1';
const CARBON_FACTOR_IMPORT_AUDIT_DIGEST_PREFIX = 'hmac-sha256:v1:audit';
const CARBON_FACTOR_IMPORT_HMAC_SECRET_META_KEY = 'carbon_factor_import_hmac_secret';
// 碳因子内部 API 契约字段保持稳定，不与用户可见模板标题混用。
const CARBON_FACTOR_FIELDS = Object.freeze(['energyTypeCode', 'region', 'factorYear', 'unit', 'factorValue', 'factorUnit', 'source', 'sourceUrl', 'effectiveFrom', 'effectiveTo', 'status']);
// 碳因子模板与文件导出使用中文用户标题。
const CARBON_FACTOR_IMPORT_HEADERS = Object.freeze(['能源类型编码', '地区', '因子年份', '活动数据单位', '因子值', '排放单位', '因子来源', '来源链接', '有效开始日期', '有效结束日期', '状态']);
const CARBON_FACTOR_EXPORT_FIELDS = Object.freeze([
  { key: 'energyTypeCode', header: '能源类型编码' }, { key: 'region', header: '地区' },
  { key: 'factorYear', header: '因子年份' }, { key: 'unit', header: '活动数据单位' },
  { key: 'factorValue', header: '因子值' }, { key: 'factorUnit', header: '排放单位' },
  { key: 'source', header: '因子来源' }, { key: 'sourceUrl', header: '来源链接' },
  { key: 'effectiveFrom', header: '有效开始日期' }, { key: 'effectiveTo', header: '有效结束日期' },
  { key: 'status', header: '状态' }
]);
const CARBON_FACTOR_IMPORT_ALIASES = Object.freeze({
  energyTypeCode: ['energyTypeCode', 'energy_type_code', 'energyType', '能源类型编码', '能源类型', '能源'],
  region: ['region', '地区', '区域'],
  factorYear: ['factorYear', 'factor_year', 'year', '年份', '因子年份'],
  unit: ['unit', 'activityUnit', '活动数据单位', '单位'],
  factorValue: ['factorValue', 'factor_value', 'value', '因子值', '排放因子'],
  factorUnit: ['factorUnit', 'factor_unit', 'emissionUnit', '排放单位', '排放单位'],
  source: ['source', '来源', '因子来源'],
  sourceUrl: ['sourceUrl', 'source_url', 'url', '来源链接', '来源网址'],
  effectiveFrom: ['effectiveFrom', 'effective_from', '有效开始日期', '生效开始日期'],
  effectiveTo: ['effectiveTo', 'effective_to', '有效结束日期', '生效结束日期'],
  status: ['status', '状态', '是否启用', 'isActive', 'is_active']
});
const CARBON_EMISSION_EXPORT_FIELDS = Object.freeze([
  { key: 'id', header: '碳排放记录ID' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型名称' },
  { key: 'organizationUnitId', header: '用能单元ID' },
  { key: 'organizationUnitCode', header: '用能单元编码' },
  { key: 'organizationUnitName', header: '用能单元名称' },
  { key: 'organizationUnitPath', header: '用能单元路径' },
  { key: 'meterDeviceId', header: '计量器具ID' },
  { key: 'meterCode', header: '计量器具编码' },
  { key: 'meterName', header: '计量器具名称' },
  { key: 'calculationMethod', header: '核算方法' },
  { key: 'activityValue', header: '活动数据值' },
  { key: 'activityUnit', header: '活动数据单位' },
  { key: 'factorValue', header: '因子值' },
  { key: 'emissionValue', header: '排放量' },
  { key: 'emissionUnit', header: '排放单位' },
  { key: 'status', header: '状态' },
  { key: 'factorRegion', header: '因子地区' },
  { key: 'factorYear', header: '因子年份' },
  { key: 'factorSource', header: '因子来源' },
  { key: 'calculatedAt', header: '核算时间' }
]);

function getNow() {
  return new Date().toISOString();
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function normalizeFactorYearFilter(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return normalizeYear(value, 'factorYear');
}

function normalizeFactorStatus(value) {
  const status = normalizeText(value);
  if (!status) return undefined;
  if (!FACTOR_STATUSES.includes(status)) {
    throw badRequest('status 仅支持 active 或 inactive。', { code: 'INVALID_FACTOR_STATUS', status, allowedStatuses: FACTOR_STATUSES });
  }
  return status;
}

function normalizeFactorPayload(payload = {}, options = {}) {
  const existing = options.existing || {};
  const status = normalizeFactorStatus(firstDefined(payload, ['status']));
  const suppliedIsActive = normalizeBooleanFlag(firstDefined(payload, ['isActive', 'is_active']), 'isActive');
  if (status && suppliedIsActive !== undefined && (status === 'active' ? 1 : 0) !== suppliedIsActive) {
    throw badRequest('status 与 isActive 不能相互矛盾。', { code: 'CONFLICTING_FACTOR_STATUS' });
  }
  const isActive = suppliedIsActive === undefined ? (status ? (status === 'active' ? 1 : 0) : (existing.isActive === undefined ? 1 : existing.isActive)) : suppliedIsActive;
  const rawYear = firstDefined(payload, ['factorYear', 'factor_year']);
  const factorYear = rawYear === undefined || rawYear === null || String(rawYear).trim() === ''
    ? (existing.factorYear === undefined ? null : existing.factorYear)
    : normalizeYear(rawYear, 'factorYear');
  const factorValueRaw = firstDefined(payload, ['factorValue', 'factor_value']);
  const factorValue = factorValueRaw === undefined || factorValueRaw === null || String(factorValueRaw).trim() === ''
    ? existing.factorValue
    : normalizePositiveNumber(factorValueRaw, 'factorValue');
  return {
    energyTypeCode: normalizeText(firstDefined(payload, ['energyTypeCode', 'energy_type_code'])) || existing.energyTypeCode,
    region: normalizeRegion(firstDefined(payload, ['region']) || existing.region),
    factorYear,
    unit: normalizeText(firstDefined(payload, ['unit'])) || existing.unit,
    factorValue,
    factorUnit: normalizeText(firstDefined(payload, ['factorUnit', 'factor_unit'])) || existing.factorUnit || DEFAULT_EMISSION_UNIT,
    source: normalizeText(firstDefined(payload, ['source'])) || existing.source,
    sourceUrl: Object.prototype.hasOwnProperty.call(payload, 'sourceUrl') || Object.prototype.hasOwnProperty.call(payload, 'source_url')
      ? normalizeText(firstDefined(payload, ['sourceUrl', 'source_url']))
      : (existing.sourceUrl || null),
    effectiveFrom: Object.prototype.hasOwnProperty.call(payload, 'effectiveFrom') || Object.prototype.hasOwnProperty.call(payload, 'effective_from')
      ? normalizeText(firstDefined(payload, ['effectiveFrom', 'effective_from']))
      : (existing.effectiveFrom || null),
    effectiveTo: Object.prototype.hasOwnProperty.call(payload, 'effectiveTo') || Object.prototype.hasOwnProperty.call(payload, 'effective_to')
      ? normalizeText(firstDefined(payload, ['effectiveTo', 'effective_to']))
      : (existing.effectiveTo || null),
    isActive
  };
}

function assertCompleteFactorPayload(payload) {
  ['energyTypeCode', 'unit', 'source'].forEach((fieldName) => {
    if (!payload[fieldName]) throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD', fieldName });
  });
  if (payload.factorValue === undefined || payload.factorValue === null) {
    throw badRequest('factorValue 为必填项。', { code: 'REQUIRED_FIELD', fieldName: 'factorValue' });
  }
}

function normalizeFactorStatusPayload(payload = {}) {
  const status = normalizeFactorStatus(payload.status);
  const isActive = normalizeBooleanFlag(payload.isActive, 'isActive');
  if (status && isActive !== undefined && (status === 'active' ? 1 : 0) !== isActive) {
    throw badRequest('status 与 isActive 不能相互矛盾。', { code: 'CONFLICTING_FACTOR_STATUS' });
  }
  if (status) return status === 'active' ? 1 : 0;
  if (isActive === undefined) throw badRequest('必须提供 status 或 isActive。', { code: 'REQUIRED_FIELD', fields: ['status', 'isActive'] });
  return isActive;
}

function normalizeEmissionStatus(value) {
  const status = normalizeText(value);
  if (!status) return undefined;
  if (!EMISSION_STATUSES.includes(status)) {
    throw badRequest('status 不在碳排放结果状态白名单内。', { code: 'UNSUPPORTED_EMISSION_STATUS', status, allowedStatuses: EMISSION_STATUSES });
  }
  return status;
}

function resolveEnergyType(db, energyTypeCode) {
  const energyType = db.prepare(`SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types WHERE code = @energyTypeCode`).get({ energyTypeCode });
  if (!energyType) throw badRequest('未找到 energyTypeCode 对应的能源类型。', { code: 'UNKNOWN_ENERGY_TYPE', energyTypeCode });
  if (energyType.isActive !== 1) throw badRequest('能源类型已停用，不能维护碳因子。', { code: 'INACTIVE_ENERGY_TYPE', energyTypeCode });
  return energyType;
}

function mapFactorRow(row) {
  if (!row) return null;
  return { ...row, factorYear: row.factorYear === null ? null : Number(row.factorYear), factorValue: Number(row.factorValue), isActive: Number(row.isActive), status: Number(row.isActive) === 1 ? 'active' : 'inactive' };
}

function getFactorById(db, factorId) {
  return mapFactorRow(db.prepare(`SELECT cf.id, et.code AS energyTypeCode, et.name AS energyTypeName, cf.region, cf.factor_year AS factorYear, cf.unit, cf.factor_value AS factorValue, cf.factor_unit AS factorUnit, cf.source, cf.source_url AS sourceUrl, cf.effective_from AS effectiveFrom, cf.effective_to AS effectiveTo, cf.is_active AS isActive, cf.source_batch_id AS sourceBatchId, cf.source_row_number AS sourceRowNumber, cf.created_at AS createdAt, cf.updated_at AS updatedAt FROM carbon_factors cf JOIN energy_types et ON et.id = cf.energy_type_id WHERE cf.id = @factorId`).get({ factorId }));
}

function getCarbonFactor(factorIdRaw) {
  const factorId = normalizePositiveInteger(factorIdRaw, 'factorId');
  const db = openDatabase();
  try {
    const factor = getFactorById(db, factorId);
    if (!factor) throw notFound('碳因子不存在。', { factorId });
    return factor;
  } finally { db.close(); }
}

function buildFactorWhere(query = {}) {
  const filters = {
    energyTypeCode: normalizeText(firstDefined(query, ['energyTypeCode', 'energy_type_code', 'energyType'])),
    region: normalizeText(query.region),
    factorYear: normalizeFactorYearFilter(firstDefined(query, ['factorYear', 'factor_year', 'year'])),
    unit: normalizeText(query.unit),
    status: normalizeFactorStatus(query.status),
    isActive: normalizeBooleanFlag(firstDefined(query, ['isActive', 'is_active']), 'isActive'),
    keyword: normalizeText(firstDefined(query, ['keyword', 'search']))
  };
  if (filters.status && filters.isActive !== undefined && (filters.status === 'active' ? 1 : 0) !== filters.isActive) {
    throw badRequest('status 与 isActive 筛选条件不能相互矛盾。', { code: 'CONFLICTING_FACTOR_STATUS' });
  }
  const where = []; const params = {};
  if (filters.energyTypeCode) { where.push('et.code = @energyTypeCode'); params.energyTypeCode = filters.energyTypeCode; }
  if (filters.region) { where.push('cf.region = @region'); params.region = filters.region; }
  if (filters.factorYear !== undefined) { where.push('cf.factor_year = @factorYear'); params.factorYear = filters.factorYear; }
  if (filters.unit) { where.push('cf.unit = @unit'); params.unit = filters.unit; }
  const isActive = filters.isActive === undefined ? (filters.status ? (filters.status === 'active' ? 1 : 0) : undefined) : filters.isActive;
  if (isActive !== undefined) { where.push('cf.is_active = @isActive'); params.isActive = isActive; }
  if (filters.keyword) {
    where.push(`(et.code LIKE @keyword ESCAPE '\\' OR et.name LIKE @keyword ESCAPE '\\' OR cf.region LIKE @keyword ESCAPE '\\' OR cf.unit LIKE @keyword ESCAPE '\\' OR cf.source LIKE @keyword ESCAPE '\\' OR cf.source_url LIKE @keyword ESCAPE '\\')`);
    params.keyword = `%${escapeLike(filters.keyword)}%`;
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params, filters: { ...filters, isActive } };
}

function selectCarbonFactorRows(db, query = {}, options = {}) {
  const { whereSql, params } = buildFactorWhere(query);
  const limit = options.limit || MAX_CARBON_EXPORT_ROWS;
  const offset = options.offset || 0;
  return db.prepare(`SELECT cf.id, et.code AS energyTypeCode, et.name AS energyTypeName, cf.region, cf.factor_year AS factorYear, cf.unit, cf.factor_value AS factorValue, cf.factor_unit AS factorUnit, cf.source, cf.source_url AS sourceUrl, cf.effective_from AS effectiveFrom, cf.effective_to AS effectiveTo, cf.is_active AS isActive, cf.source_batch_id AS sourceBatchId, cf.source_row_number AS sourceRowNumber, cf.created_at AS createdAt, cf.updated_at AS updatedAt FROM carbon_factors cf JOIN energy_types et ON et.id = cf.energy_type_id ${whereSql} ORDER BY et.display_order ASC, cf.region ASC, cf.factor_year DESC, cf.unit ASC, cf.updated_at DESC, cf.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }).map(mapFactorRow);
}

function listCarbonFactors(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: FACTOR_PAGE_SIZE_MAX });
  const db = openDatabase();
  try {
    const { whereSql, params } = buildFactorWhere(query);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM carbon_factors cf JOIN energy_types et ON et.id = cf.energy_type_id ${whereSql}`).get(params).total;
    return { rows: selectCarbonFactorRows(db, query, { limit: pageSize, offset }), pagination: buildPaginationMeta(page, pageSize, total) };
  } finally { db.close(); }
}

function findDuplicateFactor(db, payload, excludedFactorId = null) {
  return db.prepare(`SELECT id FROM carbon_factors WHERE energy_type_id = @energyTypeId AND region = @region AND unit = @unit AND source = @source AND ((factor_year IS NULL AND @factorYear IS NULL) OR factor_year = @factorYear) ${excludedFactorId ? 'AND id <> @excludedFactorId' : ''} LIMIT 1`).get({ ...payload, excludedFactorId });
}

function createCarbonFactor(payload = {}) {
  const normalized = normalizeFactorPayload(payload);
  assertCompleteFactorPayload(normalized);
  const db = openDatabase();
  try {
    const result = db.transaction(() => {
      const energyType = resolveEnergyType(db, normalized.energyTypeCode);
      const duplicate = findDuplicateFactor(db, { ...normalized, energyTypeId: energyType.id });
      if (duplicate) throw badRequest('相同能源类型、地区、年份、单位和来源的碳因子已存在；请编辑原记录。', { code: 'DUPLICATE_CARBON_FACTOR', existingId: duplicate.id });
      const inserted = db.prepare(`INSERT INTO carbon_factors (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, source_url, effective_from, effective_to, is_active) VALUES (@energyTypeId, @region, @factorYear, @unit, @factorValue, @factorUnit, @source, @sourceUrl, @effectiveFrom, @effectiveTo, @isActive)`).run({ ...normalized, energyTypeId: energyType.id });
      return getFactorById(db, inserted.lastInsertRowid);
    })();
    return { ...result, operation: 'created' };
  } finally { db.close(); }
}

function updateCarbonFactor(factorIdRaw, payload = {}) {
  const factorId = normalizePositiveInteger(factorIdRaw, 'factorId');
  const db = openDatabase();
  try {
    const result = db.transaction(() => {
      const existing = getFactorById(db, factorId);
      if (!existing) throw notFound('碳因子不存在。', { factorId });
      const normalized = normalizeFactorPayload(payload, { existing });
      assertCompleteFactorPayload(normalized);
      const energyType = resolveEnergyType(db, normalized.energyTypeCode);
      const duplicate = findDuplicateFactor(db, { ...normalized, energyTypeId: energyType.id }, factorId);
      if (duplicate) throw badRequest('更新后将与已有碳因子重复。', { code: 'DUPLICATE_CARBON_FACTOR', existingId: duplicate.id });
      db.prepare(`UPDATE carbon_factors SET energy_type_id = @energyTypeId, region = @region, factor_year = @factorYear, unit = @unit, factor_value = @factorValue, factor_unit = @factorUnit, source = @source, source_url = @sourceUrl, effective_from = @effectiveFrom, effective_to = @effectiveTo, is_active = @isActive, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @factorId`).run({ ...normalized, energyTypeId: energyType.id, factorId });
      return getFactorById(db, factorId);
    })();
    return { ...result, operation: 'updated' };
  } finally { db.close(); }
}

// 仅保留旧调用方的按唯一键更新兼容性；统一管理页面应使用 POST/PUT 分离接口。
function upsertCarbonFactor(payload = {}) {
  const normalized = normalizeFactorPayload(payload);
  assertCompleteFactorPayload(normalized);
  const db = openDatabase();
  try {
    const existing = db.transaction(() => {
      const energyType = resolveEnergyType(db, normalized.energyTypeCode);
      return findDuplicateFactor(db, { ...normalized, energyTypeId: energyType.id });
    })();
    return existing ? updateCarbonFactor(existing.id, payload) : createCarbonFactor(payload);
  } finally { db.close(); }
}

function setCarbonFactorStatus(factorIdRaw, payload = {}) {
  const factorId = normalizePositiveInteger(factorIdRaw, 'factorId');
  const isActive = normalizeFactorStatusPayload(payload);
  const db = openDatabase();
  try {
    const factor = db.transaction(() => {
      if (!getFactorById(db, factorId)) throw notFound('碳因子不存在。', { factorId });
      db.prepare(`UPDATE carbon_factors SET is_active = @isActive, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @factorId`).run({ factorId, isActive });
      return getFactorById(db, factorId);
    })();
    return factor;
  } finally { db.close(); }
}

function getCalculationRecords(db, query = {}) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || CALCULATION_LIMIT_MAX, CALCULATION_LIMIT_MAX);
  const rows = db.prepare(`SELECT er.id, et.code AS energyTypeCode, et.name AS energyTypeName, er.normalized_month AS normalizedMonth, er.normalized_unit AS normalizedUnit, er.normalized_value AS normalizedValue, er.organization_unit_id AS organizationUnitId, ou.unit_code AS organizationUnitCode, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath, er.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName FROM energy_records er JOIN energy_types et ON et.id = er.energy_type_id JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} ORDER BY er.normalized_month ASC, et.display_order ASC, er.id ASC LIMIT @limit`).all({ ...params, limit });
  return { rows, filters, limit };
}

function listCandidateFactors(db, record, region, factorYear) {
  return db.prepare(`SELECT cf.id, et.code AS energyTypeCode, et.name AS energyTypeName, cf.region, cf.factor_year AS factorYear, cf.unit, cf.factor_value AS factorValue, cf.factor_unit AS factorUnit, cf.source, cf.is_active AS isActive FROM carbon_factors cf JOIN energy_types et ON et.id = cf.energy_type_id WHERE et.code = @energyTypeCode AND cf.unit = @normalizedUnit AND cf.is_active = 1 AND (cf.region = @region OR cf.region = @defaultRegion) AND (cf.factor_year = @factorYear OR cf.factor_year IS NULL)`).all({ energyTypeCode: record.energyTypeCode, normalizedUnit: record.normalizedUnit, region, defaultRegion: DEFAULT_REGION, factorYear });
}

function buildMissingNote(missing) {
  return `缺少匹配碳因子：energyTypeCode=${missing.energyTypeCode}, region=${missing.requestedRegion}, factorYear=${missing.factorYear}, unit=${missing.normalizedUnit}`;
}

function calculateCarbonEmissions(payload = {}) {
  const region = normalizeRegion(payload.region);
  const calculationMethod = normalizeCalculationMethod(payload.calculationMethod);
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const selection = getCalculationRecords(db, payload); const calculated = []; const missingFactors = [];
      selection.rows.forEach((record) => {
        const factorYear = extractYearFromMonth(record.normalizedMonth);
        const match = selectBestCarbonFactor(record, listCandidateFactors(db, record, region, factorYear), { region, factorYear });
        db.prepare(`UPDATE carbon_emissions SET status = 'superseded', note = COALESCE(note || char(10), '') || @supersededNote WHERE energy_record_id = @energyRecordId AND calculation_method = @calculationMethod AND status <> 'superseded'`).run({ energyRecordId: record.id, calculationMethod, supersededNote: `由 ${getNow()} 重新计算标记为 superseded。` });
        if (!match.factor) {
          db.prepare(`INSERT INTO carbon_emissions (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value, activity_value, activity_unit, emission_value, emission_unit, status, note) VALUES (@energyRecordId, NULL, @calculationMethod, @calculationBasis, NULL, @activityValue, @activityUnit, NULL, @emissionUnit, 'factor_missing', @note)`).run({ energyRecordId: record.id, calculationMethod, calculationBasis: 'normalized_value * factor_value', activityValue: record.normalizedValue, activityUnit: record.normalizedUnit, emissionUnit: DEFAULT_EMISSION_UNIT, note: buildMissingNote(match.missing) });
          missingFactors.push(match.missing); return;
        }
        const emissionValue = calculateEmissionValue(record.normalizedValue, match.factor.factorValue);
        db.prepare(`INSERT INTO carbon_emissions (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value, activity_value, activity_unit, emission_value, emission_unit, status, note) VALUES (@energyRecordId, @carbonFactorId, @calculationMethod, @calculationBasis, @factorValue, @activityValue, @activityUnit, @emissionValue, @emissionUnit, 'calculated', @note)`).run({ energyRecordId: record.id, carbonFactorId: match.factor.id, calculationMethod, calculationBasis: `${record.normalizedValue} ${record.normalizedUnit} * ${match.factor.factorValue} ${match.factor.factorUnit}/${match.factor.unit}`, factorValue: match.factor.factorValue, activityValue: record.normalizedValue, activityUnit: record.normalizedUnit, emissionValue, emissionUnit: match.factor.factorUnit || DEFAULT_EMISSION_UNIT, note: `匹配碳因子：id=${match.factor.id}, region=${match.factor.region}, factorYear=${match.factor.factorYear || 'generic'}, source=${match.factor.source}` });
        calculated.push({ energyRecordId: record.id, carbonFactorId: match.factor.id, emissionValue, emissionUnit: match.factor.factorUnit || DEFAULT_EMISSION_UNIT });
      });
      return { calculationMethod, region, filters: selection.filters, limit: selection.limit, totalRecords: selection.rows.length, calculatedCount: calculated.length, missingFactorCount: missingFactors.length, calculated, missingFactors };
    })();
  } finally { db.close(); }
}

function normalizeEmissionQuery(query = {}) {
  const month = normalizeText(firstDefined(query, ['normalizedMonth', 'periodMonth', 'month']));
  if (!month) return query;
  return { ...query, normalizedMonthStart: month, normalizedMonthEnd: month };
}

function buildEmissionWhere(query = {}) {
  const normalizedQuery = normalizeEmissionQuery(query);
  const filters = normalizeEnergyRecordFilters(normalizedQuery);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  const conditions = [whereSql.replace(/^WHERE\s+/i, '')];
  const status = normalizeEmissionStatus(normalizedQuery.status);
  const includeSuperseded = normalizeBooleanFlag(normalizedQuery.includeSuperseded, 'includeSuperseded') === 1;
  const calculationMethod = normalizeText(normalizedQuery.calculationMethod);
  if (status) { conditions.push('ce.status = @status'); params.status = status; } else if (!includeSuperseded) conditions.push("ce.status <> 'superseded'");
  if (calculationMethod) { conditions.push('ce.calculation_method = @calculationMethod'); params.calculationMethod = calculationMethod; }
  return { whereSql: `WHERE ${conditions.filter(Boolean).join(' AND ')}`, params, filters, status, includeSuperseded, calculationMethod };
}

function selectCarbonEmissionRows(db, query = {}, options = {}) {
  const sort = normalizeEmissionSort(query); const { whereSql, params } = buildEmissionWhere(query);
  return db.prepare(`SELECT ce.id, ce.energy_record_id AS energyRecordId, ce.carbon_factor_id AS carbonFactorId, ce.calculation_method AS calculationMethod, ce.calculation_basis AS calculationBasis, ce.factor_value AS factorValue, ce.activity_value AS activityValue, ce.activity_unit AS activityUnit, ce.emission_value AS emissionValue, ce.emission_unit AS emissionUnit, ce.status, ce.calculated_at AS calculatedAt, ce.note, et.code AS energyTypeCode, et.name AS energyTypeName, er.normalized_month AS normalizedMonth, er.organization_unit_id AS organizationUnitId, ou.unit_code AS organizationUnitCode, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath, er.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName, cf.region AS factorRegion, cf.factor_year AS factorYear, cf.source AS factorSource FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} ORDER BY ${sort.orderSql} LIMIT @limit OFFSET @offset`).all({ ...params, limit: options.limit || MAX_CARBON_EXPORT_ROWS, offset: options.offset || 0 });
}

function listCarbonEmissions(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: 200 });
  const sort = normalizeEmissionSort(query); const { whereSql, params } = buildEmissionWhere(query); const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql}`).get(params).total;
    return { rows: selectCarbonEmissionRows(db, query, { limit: pageSize, offset }), pagination: buildPaginationMeta(page, pageSize, total), sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder } };
  } finally { db.close(); }
}

function getEmissionStatistics(query = {}) {
  const group = normalizeEmissionGroupBy(query.groupBy); const { whereSql, params } = buildEmissionWhere(query); const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || 100, 500); const db = openDatabase();
  try {
    const rows = db.prepare(`SELECT COALESCE(NULLIF(TRIM(${group.columnSql}), ''), '未填写') AS groupValue, ce.emission_unit AS emissionUnit, COUNT(ce.id) AS emissionRecordCount, SUM(CASE WHEN ce.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount, SUM(CASE WHEN ce.status = 'factor_missing' THEN 1 ELSE 0 END) AS missingFactorCount, COALESCE(SUM(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE 0 END), 0) AS totalEmissionValue, COALESCE(AVG(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE NULL END), 0) AS averageEmissionValue, MIN(er.normalized_month) AS monthStart, MAX(er.normalized_month) AS monthEnd FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} GROUP BY groupValue, ce.emission_unit ORDER BY totalEmissionValue DESC, emissionRecordCount DESC, groupValue ASC LIMIT @limit`).all({ ...params, limit });
    return { groupBy: group.groupBy, rows: rows.map((row) => ({ ...row, totalEmissionValue: Number(row.totalEmissionValue || 0), averageEmissionValue: Number(row.averageEmissionValue || 0) })) };
  } finally { db.close(); }
}

function buildCarbonEmissionStats(query = {}) {
  const db = openDatabase();
  try {
    const { whereSql, params } = buildEmissionWhere(query);
    const summary = db.prepare(`SELECT COUNT(*) AS totalRecords, SUM(CASE WHEN ce.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount, SUM(CASE WHEN ce.status = 'factor_missing' THEN 1 ELSE 0 END) AS missingFactorCount, SUM(CASE WHEN ce.status = 'invalid_record' THEN 1 ELSE 0 END) AS invalidRecordCount, SUM(CASE WHEN ce.status = 'superseded' THEN 1 ELSE 0 END) AS supersededCount FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql}`).get(params);
    const aggregate = (groupBy, columns) => db.prepare(`SELECT ${columns}, ce.emission_unit AS emissionUnit, COUNT(ce.id) AS emissionRecordCount, SUM(CASE WHEN ce.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount, SUM(CASE WHEN ce.status = 'factor_missing' THEN 1 ELSE 0 END) AS missingFactorCount, COALESCE(SUM(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE 0 END), 0) AS totalEmissionValue FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} GROUP BY ${groupBy}, ce.emission_unit ORDER BY ${groupBy} ASC, ce.emission_unit ASC`).all(params).map((row) => ({ ...row, totalEmissionValue: Number(row.totalEmissionValue || 0) }));
    const totalsByEmissionUnit = db.prepare(`SELECT ce.emission_unit AS emissionUnit, COUNT(ce.id) AS emissionRecordCount, COALESCE(SUM(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE 0 END), 0) AS totalEmissionValue FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} GROUP BY ce.emission_unit ORDER BY ce.emission_unit`).all(params).map((row) => ({ ...row, totalEmissionValue: Number(row.totalEmissionValue || 0) }));
    return { totalRecords: Number(summary.totalRecords || 0), calculatedCount: Number(summary.calculatedCount || 0), missingFactorCount: Number(summary.missingFactorCount || 0), invalidRecordCount: Number(summary.invalidRecordCount || 0), supersededCount: Number(summary.supersededCount || 0), totalsByEmissionUnit, byMonth: aggregate('er.normalized_month', 'er.normalized_month AS normalizedMonth'), byEnergyType: aggregate('et.code, et.name', 'et.code AS energyTypeCode, et.name AS energyTypeName'), byOrganizationUnit: aggregate('ou.id, ou.unit_code, ou.unit_name, ou.unit_path', 'ou.id AS organizationUnitId, ou.unit_code AS organizationUnitCode, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath'), meta: { filtersApplied: { ...query }, aggregationPolicy: '统计仅使用当前筛选命中的碳排放结果；各分组按 emissionUnit 分列，未进行无依据的跨单位换算；factor_missing 不伪造排放值。', noDataFabricated: true } };
  } finally { db.close(); }
}

function listMissingCarbonFactors(query = {}) {
  const normalizedQuery = { ...query, status: 'factor_missing' }; const { whereSql, params } = buildEmissionWhere(normalizedQuery); const region = normalizeRegion(query.region); const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || 100, 500); const db = openDatabase();
  try {
    const rows = db.prepare(`SELECT et.code AS energyTypeCode, et.name AS energyTypeName, er.normalized_unit AS unit, CAST(substr(er.normalized_month, 1, 4) AS INTEGER) AS factorYear, COUNT(ce.id) AS missingRecordCount, COALESCE(SUM(er.normalized_value), 0) AS affectedActivityValue, MIN(er.normalized_month) AS monthStart, MAX(er.normalized_month) AS monthEnd, MAX(ce.calculated_at) AS latestCalculatedAt FROM carbon_emissions ce JOIN energy_records er ON er.id = ce.energy_record_id JOIN energy_types et ON et.id = er.energy_type_id LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id LEFT JOIN meter_devices md ON md.id = er.meter_device_id ${whereSql} GROUP BY et.code, et.name, er.normalized_unit, factorYear ORDER BY missingRecordCount DESC, et.code ASC, factorYear DESC LIMIT @limit`).all({ ...params, limit });
    return rows.map((row) => ({ ...row, requestedRegion: region, suggestedFactorFields: { energyTypeCode: row.energyTypeCode, region, factorYear: row.factorYear, unit: row.unit, factorValue: '待维护', source: '待填写' } }));
  } finally { db.close(); }
}

function escapeCsvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function buildExportRows(rows, fields) { return rows.map((row) => fields.reduce((output, field) => { output[field.header] = row[field.key] ?? ''; return output; }, {})); }
function renderExport(rows, fields, sheetName, prefix, requestedFormat) {
  const format = String(requestedFormat || 'xlsx').trim().toLowerCase();
  if (!['xlsx', 'csv'].includes(format)) throw badRequest('format 仅支持 xlsx 或 csv。', { code: 'UNSUPPORTED_EXPORT_FORMAT', format });
  const headers = fields.map((field) => field.header); const exportRows = buildExportRows(rows, fields); const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); const fileName = `${prefix}-${date}.${format}`;
  if (format === 'csv') {
    const content = `﻿${[headers, ...exportRows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
    return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(content, 'utf8'), rowCount: rows.length, fields: headers, maxRows: MAX_CARBON_EXPORT_ROWS };
  }
  const workbook = XLSX.utils.book_new(); const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers }); worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 14), 32) })); XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers, maxRows: MAX_CARBON_EXPORT_ROWS };
}

function exportCarbonFactors(query = {}) { const db = openDatabase(); try { return renderExport(selectCarbonFactorRows(db, query), CARBON_FACTOR_EXPORT_FIELDS, '碳因子', '碳因子导出', query.format); } finally { db.close(); } }
function exportCarbonEmissions(query = {}) { const db = openDatabase(); try { return renderExport(selectCarbonEmissionRows(db, query), CARBON_EMISSION_EXPORT_FIELDS, '碳排放结果', '碳排放结果导出', query.format); } finally { db.close(); } }

function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function timingSafeEqualText(actual, expected) { const left = Buffer.from(String(actual || ''), 'utf8'); const right = Buffer.from(String(expected || ''), 'utf8'); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function projectBackupMetadata(backup = {}) { return ['backupName', 'reason', 'method', 'sizeBytes', 'createdAt', 'updatedAt', 'sha256', 'requestedReason'].reduce((result, key) => { if (backup[key] !== undefined) result[key] = backup[key]; return result; }, {}); }
function getCarbonFactorImportHmacSecret() {
  const configured = normalizeText(process.env.CARBON_FACTOR_IMPORT_HMAC_SECRET) || normalizeText(process.env.CHARCOAL_HMAC_SECRET) || normalizeText(process.env.APP_SECRET); if (configured) return configured;
  const db = openDatabase(); try { const saved = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CARBON_FACTOR_IMPORT_HMAC_SECRET_META_KEY); if (normalizeText(saved?.value)) return saved.value; const generated = crypto.randomBytes(32).toString('hex'); db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO NOTHING`).run(CARBON_FACTOR_IMPORT_HMAC_SECRET_META_KEY, generated); return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CARBON_FACTOR_IMPORT_HMAC_SECRET_META_KEY).value; } finally { db.close(); }
}
function hmacJson(value) { return crypto.createHmac('sha256', getCarbonFactorImportHmacSecret()).update(stableStringify(value)).digest('hex'); }
function normalizeHeaderName(value) { return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase(); }
function mapCarbonFactorImportFields(row = {}) { const mapped = {}; const fieldMapping = {}; Object.entries(row).forEach(([header, value]) => { const normalizedHeader = normalizeHeaderName(header); const field = Object.entries(CARBON_FACTOR_IMPORT_ALIASES).find(([, aliases]) => aliases.map(normalizeHeaderName).includes(normalizedHeader))?.[0]; if (field && (!Object.prototype.hasOwnProperty.call(mapped, field) || !normalizeText(mapped[field]))) { mapped[field] = value; fieldMapping[field] = header; } }); return { mapped, fieldMapping }; }
function createCarbonFactorImportIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') { return { rowNumber, fieldName, rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue), code, message, severity }; }

function normalizeCarbonFactorImportCandidate(row = {}) {
  const status = normalizeFactorStatus(row.status) || 'active';
  return { candidateRowId: normalizeText(row.candidateRowId), rowNumber: Number(row.rowNumber), energyTypeId: Number(row.energyTypeId), energyTypeCode: normalizeText(row.energyTypeCode), region: normalizeRegion(row.region), factorYear: row.factorYear === null || row.factorYear === undefined || row.factorYear === '' ? null : Number(row.factorYear), unit: normalizeText(row.unit), factorValue: Number(row.factorValue), factorUnit: normalizeText(row.factorUnit) || DEFAULT_EMISSION_UNIT, source: normalizeText(row.source), sourceUrl: normalizeText(row.sourceUrl), effectiveFrom: normalizeText(row.effectiveFrom), effectiveTo: normalizeText(row.effectiveTo), status };
}
function buildCarbonFactorImportSignaturePayload(input = {}) { const candidateRows = (input.candidateRows || []).map(normalizeCarbonFactorImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber); return { operation: 'carbon-factor-import', importType: CARBON_FACTOR_IMPORT_TYPE, duplicateStrategy: 'skip', targetTable: 'carbon_factors', confirmText: CARBON_FACTOR_IMPORT_CONFIRM_TEXT, requireBackup: true, candidateRowIds: candidateRows.map((row) => row.rowNumber), candidateRows }; }
function buildCarbonFactorImportPreviewSignature(input = {}) { return `${CARBON_FACTOR_IMPORT_SIGNATURE_PREFIX}:${hmacJson(buildCarbonFactorImportSignaturePayload(input))}`; }
function normalizeCarbonFactorImportAudit(preview = {}) { return { summary: preview.summary || {}, items: (preview.items || []).map((item) => ({ rowNumber: Number(item.rowNumber), status: item.status, reasonCodes: item.reasonCodes, reasonText: item.reasonText, reasons: item.reasons || [] })) }; }
function buildCarbonFactorImportPreviewAuditDigest(preview = {}) { return `${CARBON_FACTOR_IMPORT_AUDIT_DIGEST_PREFIX}:${hmacJson(normalizeCarbonFactorImportAudit(preview))}`; }
function factorImportKey(row) { return `${row.energyTypeId} ${row.region} ${row.factorYear === null ? '' : row.factorYear} ${row.unit} ${row.source}`; }

function buildCarbonFactorImportPreviewWithDb(db, rows = []) {
  const types = new Map(db.prepare('SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types').all().map((item) => [item.code, item]));
  const existing = new Set(db.prepare('SELECT energy_type_id AS energyTypeId, region, factor_year AS factorYear, unit, source FROM carbon_factors').all().map(factorImportKey));
  const seen = new Set(); const fieldMapping = {}; const items = [];
  rows.forEach((row, index) => {
    const rowNumber = Number(row.rowNumber || row.__rowNumber || index + 2); const { mapped, fieldMapping: currentMapping } = mapCarbonFactorImportFields(row); Object.assign(fieldMapping, currentMapping); const reasons = [];
    const energyTypeCode = normalizeText(mapped.energyTypeCode); let energyType = null; let factorYear = null; let factorValue = null;
    if (!energyTypeCode) reasons.push(createCarbonFactorImportIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'REQUIRED_FIELD_MISSING', 'energyTypeCode / 能源类型为必填项。'));
    else { energyType = types.get(energyTypeCode); if (!energyType) reasons.push(createCarbonFactorImportIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'UNKNOWN_ENERGY_TYPE', '未找到匹配能源类型，导入不会自动创建能源类型。')); else if (Number(energyType.isActive) !== 1) reasons.push(createCarbonFactorImportIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'INACTIVE_ENERGY_TYPE', '碳因子的能源类型必须为 active 状态。')); }
    try { factorYear = normalizeYear(mapped.factorYear, 'factorYear'); } catch (error) { reasons.push(createCarbonFactorImportIssue(rowNumber, 'factorYear', mapped.factorYear, error.details?.code || 'INVALID_YEAR', error.message)); }
    try { factorValue = normalizePositiveNumber(mapped.factorValue, 'factorValue'); } catch (error) { reasons.push(createCarbonFactorImportIssue(rowNumber, 'factorValue', mapped.factorValue, error.details?.code || 'INVALID_POSITIVE_NUMBER', error.message)); }
    const region = normalizeRegion(mapped.region); const unit = normalizeText(mapped.unit); const source = normalizeText(mapped.source); const factorUnit = normalizeText(mapped.factorUnit) || DEFAULT_EMISSION_UNIT; let status = normalizeText(mapped.status) || 'active';
    if (!unit) reasons.push(createCarbonFactorImportIssue(rowNumber, 'unit', mapped.unit, 'REQUIRED_FIELD_MISSING', 'unit / 单位为必填项。'));
    if (!source) reasons.push(createCarbonFactorImportIssue(rowNumber, 'source', mapped.source, 'REQUIRED_FIELD_MISSING', 'source / 来源为必填项。'));
    if (['true', '1'].includes(status)) status = 'active'; if (['false', '0'].includes(status)) status = 'inactive';
    if (!FACTOR_STATUSES.includes(status)) reasons.push(createCarbonFactorImportIssue(rowNumber, 'status', mapped.status, 'INVALID_FACTOR_STATUS', 'status 仅支持 active/inactive 或 true/false。'));
    const record = energyType && unit && source && factorValue !== null && reasons.length === 0 ? { rowNumber, energyTypeId: energyType.id, energyTypeCode: energyType.code, energyTypeName: energyType.name, region, factorYear, unit, factorValue, factorUnit, source, sourceUrl: normalizeText(mapped.sourceUrl), effectiveFrom: normalizeText(mapped.effectiveFrom), effectiveTo: normalizeText(mapped.effectiveTo), status } : null;
    let resultStatus = 'blocked';
    if (record) { const key = factorImportKey(record); if (existing.has(key)) { resultStatus = 'skipped'; reasons.push(createCarbonFactorImportIssue(rowNumber, 'energyTypeCode+region+factorYear+unit+source', `${record.energyTypeCode}|${record.region}|${record.factorYear || ''}|${record.unit}|${record.source}`, 'DUPLICATE_CARBON_FACTOR_SKIPPED', '已存在相同碳因子，按 skip 策略跳过，不覆盖既有因子。', 'warning')); } else if (seen.has(key)) { resultStatus = 'skipped'; reasons.push(createCarbonFactorImportIssue(rowNumber, 'energyTypeCode+region+factorYear+unit+source', `${record.energyTypeCode}|${record.region}|${record.factorYear || ''}|${record.unit}|${record.source}`, 'DUPLICATE_IMPORT_CANDIDATE_SKIPPED', '同一导入文件存在重复碳因子候选，后续行按 skip 策略跳过。', 'warning')); } else { resultStatus = 'wouldImport'; seen.add(key); } }
    const item = { rowNumber, rowId: rowNumber, energyTypeId: record?.energyTypeId || null, energyTypeCode: record?.energyTypeCode || energyTypeCode, energyTypeName: record?.energyTypeName || energyType?.name || null, region, factorYear, unit, factorValue: record?.factorValue ?? normalizeText(mapped.factorValue), factorUnit, source, sourceUrl: record?.sourceUrl ?? normalizeText(mapped.sourceUrl), effectiveFrom: record?.effectiveFrom ?? normalizeText(mapped.effectiveFrom), effectiveTo: record?.effectiveTo ?? normalizeText(mapped.effectiveTo), factorStatus: status, status: resultStatus, wouldImport: resultStatus === 'wouldImport', reasons };
    item.errors = reasons.filter((reason) => reason.severity === 'error'); item.warnings = reasons.filter((reason) => reason.severity === 'warning'); item.reasonCodes = reasons.map((reason) => reason.code).join('|'); item.reasonText = reasons.map((reason) => reason.message).join('；'); items.push(item);
  });
  const summary = { totalRows: items.length, wouldImport: items.filter((item) => item.status === 'wouldImport').length, skipped: items.filter((item) => item.status === 'skipped').length, blocked: items.filter((item) => item.status === 'blocked').length, warnings: items.reduce((count, item) => count + item.warnings.length, 0), errors: items.reduce((count, item) => count + item.errors.length, 0) };
  const candidateRows = items.filter((item) => item.wouldImport).map((item) => ({ candidateRowId: `carbon-factor:${item.rowNumber}`, rowNumber: item.rowNumber, energyTypeId: item.energyTypeId, energyTypeCode: item.energyTypeCode, region: item.region, factorYear: item.factorYear, unit: item.unit, factorValue: Number(item.factorValue), factorUnit: item.factorUnit, source: item.source, sourceUrl: item.sourceUrl, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.factorStatus }));
  const preview = { dryRun: true, previewOnly: true, writesCarbonFactors: false, writesCarbonEmissions: false, persistsImportBatch: true, duplicateStrategy: 'skip', confirmText: CARBON_FACTOR_IMPORT_CONFIRM_TEXT, backupReason: CARBON_FACTOR_IMPORT_BACKUP_REASON, fieldMapping, summary, candidateRowIds: candidateRows.map((item) => item.rowNumber), candidateRows, items, notices: ['preview 不写入 carbon_factors 或 carbon_emissions；上传 preview 仅持久化统一导入审计批次和行级 error/warning。', 'execute 必须提供固定确认文本、previewSignature、候选行、acknowledgeSkippedRisks=true 和 requireBackup=true；签名或数据变化时拒绝写入。', '重复碳因子默认 skip 并保留 warning，不覆盖、不删除既有因子；停用因子不改变历史排放记录。'] };
  preview.previewAudit = normalizeCarbonFactorImportAudit(preview); preview.previewAuditDigest = buildCarbonFactorImportPreviewAuditDigest(preview); preview.previewSignature = buildCarbonFactorImportPreviewSignature(preview); return preview;
}

function buildCarbonFactorImportPreviewFromRows(rows = []) { const db = openDatabase(); try { return buildCarbonFactorImportPreviewWithDb(db, rows); } finally { db.close(); } }
function collectCarbonFactorImportAuditIssues(preview) { return (preview.items || []).flatMap((item) => (item.reasons || []).filter((reason) => ['error', 'warning'].includes(reason.severity)).map((reason) => ({ ...reason, rowNumber: item.rowNumber }))); }
function createCarbonFactorImportPreviewFromUpload(file) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的碳因子表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  assertSupportedImportFile(file.originalname); const parsed = parseImportFile(file.path, file.originalname); const preview = buildCarbonFactorImportPreviewFromRows(parsed.rows || []);
  const audit = createPreviewAuditBatch({ importType: CARBON_FACTOR_IMPORT_TYPE, originalFilename: file.originalname, storedFilename: file.filename || null, filePath: file.path, fileType: String(file.originalname).split('.').pop().toLowerCase(), fileSizeBytes: file.size, duplicateStrategy: 'skip', fieldMapping: preview.fieldMapping, previewSignature: preview.previewSignature, previewAuditDigest: preview.previewAuditDigest, auditContext: { confirmText: preview.confirmText, backupReason: preview.backupReason, summary: preview.summary, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, previewAudit: preview.previewAudit, previewAuditDigest: preview.previewAuditDigest, notices: preview.notices }, statistics: { totalRows: preview.summary.totalRows, successCount: preview.summary.wouldImport, failureCount: preview.summary.blocked, skippedCount: preview.summary.skipped } });
  replaceImportAuditIssues(audit.id, collectCarbonFactorImportAuditIssues(preview)); const auditBatch = getImportAuditSummary(audit.id); return { ...preview, batchId: auditBatch.id, auditBatch, persistsImportBatch: true };
}
function assertSameCarbonFactorCandidates(actual, expected, code) { const left = (actual || []).map(normalizeCarbonFactorImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber); const right = (expected || []).map(normalizeCarbonFactorImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber); if (stableStringify(left) !== stableStringify(right)) throw badRequest('候选行与最新预演不一致，请重新 preview 后执行。', { code, actual: left, expected: right }); }

async function executeCarbonFactorImportInternal(body = {}) {
  const fail = (message, code) => { throw badRequest(message, { code }); };
  if (normalizeText(body.confirmText) !== CARBON_FACTOR_IMPORT_CONFIRM_TEXT) fail('确认文本不匹配，已拒绝导入碳因子。', 'CARBON_FACTOR_IMPORT_CONFIRM_TEXT_MISMATCH');
  if (body.acknowledgeSkippedRisks !== true) fail('必须确认已知晓重复、冲突和无效记录会被跳过。', 'CARBON_FACTOR_IMPORT_SKIPPED_RISKS_ACK_REQUIRED');
  if (body.requireBackup !== true) fail('执行前必须要求自动备份，requireBackup 必须显式为 true。', 'CARBON_FACTOR_IMPORT_BACKUP_REQUIRED');
  if (!Array.isArray(body.candidateRows) || !body.candidateRows.length) fail('candidateRows 必须是至少包含一条 wouldImport 候选的数组。', 'CARBON_FACTOR_IMPORT_CANDIDATE_ROWS_REQUIRED');
  if (!Array.isArray(body.candidateRowIds)) fail('candidateRowIds 必须是数组。', 'CARBON_FACTOR_IMPORT_CANDIDATE_ROW_IDS_REQUIRED');
  const candidateIds = body.candidateRowIds.map((value) => normalizePositiveInteger(value, 'candidateRowIds')); const candidates = body.candidateRows.map(normalizeCarbonFactorImportCandidate);
  if (candidates.some((row) => !row.candidateRowId || row.candidateRowId !== `carbon-factor:${row.rowNumber}`)) fail('candidateRows 必须包含 preview 生成的 candidateRowId。', 'CARBON_FACTOR_IMPORT_CANDIDATE_ROW_ID_INVALID');
  if (stableStringify(candidateIds) !== stableStringify(candidates.map((row) => row.rowNumber))) fail('candidateRowIds 必须与 candidateRows.rowNumber 完全一致且顺序一致。', 'CARBON_FACTOR_IMPORT_CANDIDATE_ROWS_IDS_MISMATCH');
  if (Number(body.expectedWouldImport) !== candidates.length) fail('expectedWouldImport 必须与 candidateRows 数量一致。', 'CARBON_FACTOR_IMPORT_EXPECTED_COUNT_MISMATCH');
  const db = openDatabase(); let preview; try { preview = buildCarbonFactorImportPreviewWithDb(db, body.candidateRows); } finally { db.close(); }
  if (!timingSafeEqualText(body.previewSignature, preview.previewSignature)) fail('当前 previewSignature 与重新计算结果不一致，请重新 preview 后执行。', 'CARBON_FACTOR_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
  if (preview.summary.wouldImport !== candidates.length) fail('执行前预演候选数量已变化，请重新 preview 后执行。', 'CARBON_FACTOR_IMPORT_WOULD_IMPORT_MISMATCH');
  assertSameCarbonFactorCandidates(preview.candidateRows, body.candidateRows, 'CARBON_FACTOR_IMPORT_CANDIDATE_ROWS_MISMATCH');
  const requestedBatchId = body.batchId ? normalizePositiveInteger(body.batchId, 'batchId') : null; let auditBatch = null;
  if (requestedBatchId) { auditBatch = getImportAuditBatchDetail(requestedBatchId, { includeIssues: false }); if (auditBatch.importType !== CARBON_FACTOR_IMPORT_TYPE || !timingSafeEqualText(auditBatch.previewSignature, body.previewSignature)) fail('batchId 与碳因子 previewSignature 不匹配。', 'CARBON_FACTOR_IMPORT_AUDIT_BATCH_MISMATCH'); }
  const backup = { ...(await backupService.createBackup({ reason: CARBON_FACTOR_IMPORT_BACKUP_REASON })), requestedReason: CARBON_FACTOR_IMPORT_BACKUP_REASON };
  const publicBackup = projectBackupMetadata(backup);
  const writeDb = openDatabase();
  try {
    return writeDb.transaction(() => {
      const latest = buildCarbonFactorImportPreviewWithDb(writeDb, body.candidateRows);
      if (!timingSafeEqualText(body.previewSignature, latest.previewSignature) || latest.summary.wouldImport !== candidates.length) fail('写入前碳因子数据已变化，请重新 preview 后执行。', 'CARBON_FACTOR_IMPORT_EXPIRED_PREVIEW');
      assertSameCarbonFactorCandidates(latest.candidateRows, body.candidateRows, 'CARBON_FACTOR_IMPORT_CANDIDATE_ROWS_MISMATCH');
      const insert = writeDb.prepare(`INSERT INTO carbon_factors (source_batch_id, source_row_number, energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, source_url, effective_from, effective_to, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const importedRecords = latest.candidateRows.map((row) => { const inserted = insert.run(auditBatch?.id || null, auditBatch ? row.rowNumber : null, row.energyTypeId, row.region, row.factorYear, row.unit, row.factorValue, row.factorUnit, row.source, row.sourceUrl, row.effectiveFrom, row.effectiveTo, row.status === 'active' ? 1 : 0); return getFactorById(writeDb, inserted.lastInsertRowid); });
      const resultData = { executed: true, dryRun: false, writesCarbonFactors: true, writesCarbonEmissions: false, persistsImportBatch: Boolean(auditBatch), imported: importedRecords.length, skipped: auditBatch?.auditContext?.summary?.skipped ?? 0, blocked: auditBatch?.auditContext?.summary?.blocked ?? 0, warnings: auditBatch?.auditContext?.summary?.warnings ?? 0, errors: auditBatch?.auditContext?.summary?.errors ?? 0, previewSignature: latest.previewSignature, previewAuditDigest: latest.previewAuditDigest, expectedWouldImport: candidates.length, candidateRowIds: latest.candidateRowIds, importedIds: importedRecords.map((row) => row.id), importedRecords, backup: publicBackup, note: '已按最新 preview 的 wouldImport 候选写入碳因子；重复、冲突和无效行保持 skip，不覆盖、不删除既有因子；不写入 carbon_emissions。' };
      if (!auditBatch) return resultData;
      const updated = updateExecuteAuditResult(auditBatch.id, { status: resultData.skipped || resultData.blocked ? 'completed_with_errors' : 'completed', statistics: { totalRows: auditBatch.totalRows, successCount: resultData.imported, failureCount: resultData.blocked, skippedCount: resultData.skipped }, executeResult: resultData, backup }, { db: writeDb });
      return { ...resultData, batchId: updated.id, auditBatch: getImportAuditSummary(updated.id, { db: writeDb }) };
    })();
  } finally { writeDb.close(); }
}
function markCarbonFactorImportAuditFailure(body = {}, error) { try { if (!body.batchId) return; const batchId = normalizePositiveInteger(body.batchId, 'batchId'); const batch = getImportAuditBatchDetail(batchId, { includeIssues: false }); if (batch.importType !== CARBON_FACTOR_IMPORT_TYPE || (batch.auditPhase === 'execute' && ['completed', 'completed_with_errors'].includes(batch.status))) return; updateExecuteAuditResult(batchId, { status: 'failed', statistics: { totalRows: Number(batch.totalRows || 0), successCount: 0, failureCount: Number(batch.failureCount || 0), skippedCount: Number(batch.skippedCount || 0) }, executeResult: { executed: false, writesCarbonFactors: false, writesCarbonEmissions: false, errorCode: error?.details?.code || error?.code || 'CARBON_FACTOR_IMPORT_EXECUTE_FAILED', errorMessage: error?.message || '碳因子导入执行失败。' }, backup: null, errorSummary: error?.message || '碳因子导入执行失败。' }); } catch (_) { /* 审计失败不得掩盖原始拒绝原因。 */ } }
async function executeCarbonFactorImport(body = {}) { try { return await executeCarbonFactorImportInternal(body); } catch (error) { markCarbonFactorImportAuditFailure(body, error); throw error; } }

function getCarbonManagementContract() {
  return {
    status: 'unified-management-api-ready', factorTable: 'carbon_factors', emissionTable: 'carbon_emissions', factorFields: CARBON_FACTOR_FIELDS, factorStatuses: FACTOR_STATUSES, emissionStatuses: EMISSION_STATUSES,
    deletionPolicy: '碳因子不提供物理删除；仅通过 PATCH /factors/:factorId/status 在 active/inactive 间启停。停用不会修改或删除既有 carbon_emissions，历史排放仍以已保存的因子值和活动数据追溯。',
    routes: { factorList: 'GET /api/carbon/factors', factorDetail: 'GET /api/carbon/factors/:factorId', factorCreate: 'POST /api/carbon/factors', factorUpdate: 'PUT /api/carbon/factors/:factorId', factorStatus: 'PATCH /api/carbon/factors/:factorId/status', factorExport: 'GET /api/carbon/factors/export?format=xlsx|csv', factorImportPreview: 'POST /api/carbon/factors/import/preview', factorImportExecute: 'POST /api/carbon/factors/import/execute', factorTemplate: 'GET /api/templates/carbon-factors.xlsx|csv', emissionList: 'GET /api/carbon/emissions', emissionStats: 'GET /api/carbon/emissions/stats', emissionStatistics: 'GET /api/carbon/emissions/statistics?groupBy=month|energyType|organization|site', emissionExport: 'GET /api/carbon/emissions/export?format=xlsx|csv', calculate: 'POST /api/carbon/emissions/calculate', missingFactors: 'GET /api/carbon/emissions/missing-factors' },
    permissions: { factorView: 'carbon:factors:view', factorCreate: 'carbon:factors:create', factorUpdate: 'carbon:factors:update', factorStatus: 'carbon:factors:status', factorExport: 'carbon:factors:export', factorTemplate: 'carbon:factor:template', factorImport: 'carbon:factor:import', emissionView: 'carbon:emissions:view', emissionCalculate: 'carbon:emissions:calculate', emissionExport: 'carbon:emissions:export' },
    factors: { filters: ['page', 'pageSize', 'keyword/search', 'energyTypeCode', 'region', 'factorYear', 'unit', 'status/isActive'], searchFields: ['energyTypeCode', 'energyTypeName', 'region', 'unit', 'source', 'sourceUrl'], export: { formats: ['xlsx', 'csv'], fields: CARBON_FACTOR_EXPORT_FIELDS, maxRows: MAX_CARBON_EXPORT_ROWS, appliesCurrentFilters: true }, template: { type: CARBON_FACTOR_IMPORT_TEMPLATE_ID, headers: CARBON_FACTOR_IMPORT_HEADERS, aliases: CARBON_FACTOR_IMPORT_ALIASES }, import: { duplicateStrategy: 'skip', previewWrites: '仅统一 import_batches/import_errors 审计，不写 carbon_factors 或 carbon_emissions。', executeRequiredFields: ['confirmText', 'previewSignature', 'expectedWouldImport', 'candidateRowIds', 'candidateRows', 'requireBackup', 'acknowledgeSkippedRisks'], confirmText: CARBON_FACTOR_IMPORT_CONFIRM_TEXT, executeWrites: '仅写 carbon_factors 并关联统一导入审计；不覆盖、不物理删除既有因子，不写 carbon_emissions。' } },
    emissions: { readOnly: true, filters: ['page', 'pageSize', 'keyword/search', 'normalizedMonth/periodMonth/month', 'monthStart', 'monthEnd', 'energyTypeCode', 'organization', 'site', 'department', 'status', 'calculationMethod', 'includeSuperseded'], export: { formats: ['xlsx', 'csv'], fields: CARBON_EMISSION_EXPORT_FIELDS, maxRows: MAX_CARBON_EXPORT_ROWS, appliesCurrentFilters: true }, stats: { appliesCurrentFilters: true, fields: ['totalRecords', 'calculatedCount', 'missingFactorCount', 'invalidRecordCount', 'supersededCount', 'totalsByEmissionUnit', 'byMonth', 'byEnergyType', 'byOrganization'], aggregationPolicy: '统计按 emissionUnit 分列；不进行无依据的跨单位换算，factor_missing 不估算排放。' }, calculationPolicy: '仅 calculate 服务基于 active energy_records 和 active 匹配碳因子写入结果；不提供人工新增、编辑或删除排放结果接口。' },
    matchingKeys: ['energyTypeCode', 'normalizedUnit', 'region', 'factorYear', 'isActive'], matchingPriority: ['指定 region + 记录年份', 'default region + 记录年份', '指定 region + 通用年份', 'default region + 通用年份'], calculationBasis: 'energy_records.normalized_value * carbon_factors.factor_value', recalculationPolicy: '同一 energyRecordId + calculationMethod 重新计算前会将旧结果标记为 superseded，默认查询不返回 superseded，避免重复有效结果。', missingFactorPolicy: '缺少匹配因子时写入 factor_missing 状态，emissionValue 保持 null，不伪造排放结果。'
  };
}

module.exports = {
  CARBON_FACTOR_EXPORT_FIELDS,
  CARBON_FACTOR_IMPORT_ALIASES,
  CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
  CARBON_FACTOR_IMPORT_HEADERS,
  CARBON_FACTOR_IMPORT_TEMPLATE_ID,
  CARBON_FACTOR_IMPORT_TYPE,
  CARBON_EMISSION_EXPORT_FIELDS,
  FACTOR_STATUSES,
  MAX_CARBON_EXPORT_ROWS,
  buildCarbonEmissionStats,
  buildCarbonFactorImportPreviewFromRows,
  calculateCarbonEmissions,
  createCarbonFactor,
  createCarbonFactorImportPreviewFromUpload,
  executeCarbonFactorImport,
  exportCarbonEmissions,
  exportCarbonFactors,
  getCarbonFactor,
  getCarbonManagementContract,
  getEmissionStatistics,
  listCarbonEmissions,
  listCarbonFactors,
  listMissingCarbonFactors,
  setCarbonFactorStatus,
  updateCarbonFactor,
  upsertCarbonFactor
};
