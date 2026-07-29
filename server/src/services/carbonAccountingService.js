const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
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
const EMISSION_STATUSES = Object.freeze(['calculated', 'factor_missing', 'invalid_record', 'superseded']);

function normalizeFactorYearFilter(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  return normalizeYear(value, 'factorYear');
}

function normalizeFactorPayload(payload = {}) {
  const energyTypeCode = normalizeText(payload.energyTypeCode);
  const region = normalizeRegion(payload.region);
  const factorYear = normalizeYear(payload.factorYear, 'factorYear');
  const unit = normalizeText(payload.unit);
  const factorValue = normalizePositiveNumber(payload.factorValue, 'factorValue');
  const factorUnit = normalizeText(payload.factorUnit) || DEFAULT_EMISSION_UNIT;
  const source = normalizeText(payload.source);
  const sourceUrl = normalizeText(payload.sourceUrl);
  const effectiveFrom = normalizeText(payload.effectiveFrom);
  const effectiveTo = normalizeText(payload.effectiveTo);
  const isActive = normalizeBooleanFlag(payload.isActive, 'isActive');

  if (!energyTypeCode) {
    throw badRequest('energyTypeCode 为必填项。', { code: 'REQUIRED_FIELD', fieldName: 'energyTypeCode' });
  }
  if (!unit) {
    throw badRequest('unit 为必填项。', { code: 'REQUIRED_FIELD', fieldName: 'unit' });
  }
  if (!source) {
    throw badRequest('source 为必填项。', { code: 'REQUIRED_FIELD', fieldName: 'source' });
  }

  return {
    energyTypeCode,
    region,
    factorYear,
    unit,
    factorValue,
    factorUnit,
    source,
    sourceUrl: sourceUrl || null,
    effectiveFrom: effectiveFrom || null,
    effectiveTo: effectiveTo || null,
    isActive: isActive === undefined ? 1 : isActive
  };
}

function normalizeFactorStatusPayload(payload = {}) {
  const status = normalizeText(payload.status);
  if (status) {
    if (status === 'active') {
      return 1;
    }
    if (status === 'inactive') {
      return 0;
    }
    throw badRequest('status 仅支持 active 或 inactive。', {
      code: 'INVALID_FACTOR_STATUS',
      status,
      allowedStatuses: ['active', 'inactive']
    });
  }

  const isActive = normalizeBooleanFlag(payload.isActive, 'isActive');
  if (isActive === undefined) {
    throw badRequest('必须提供 status 或 isActive。', {
      code: 'REQUIRED_FIELD',
      fields: ['status', 'isActive']
    });
  }
  return isActive;
}

function normalizeEmissionStatus(value) {
  const status = normalizeText(value);
  if (!status) {
    return undefined;
  }
  if (!EMISSION_STATUSES.includes(status)) {
    throw badRequest('status 不在碳排放结果状态白名单内。', {
      code: 'UNSUPPORTED_EMISSION_STATUS',
      status,
      allowedStatuses: EMISSION_STATUSES
    });
  }
  return status;
}

function resolveEnergyType(db, energyTypeCode) {
  const energyType = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE code = @energyTypeCode`
  ).get({ energyTypeCode });

  if (!energyType) {
    throw badRequest('未找到 energyTypeCode 对应的能源类型。', {
      code: 'UNKNOWN_ENERGY_TYPE',
      energyTypeCode
    });
  }
  if (energyType.isActive !== 1) {
    throw badRequest('能源类型已停用，不能维护碳因子。', {
      code: 'INACTIVE_ENERGY_TYPE',
      energyTypeCode
    });
  }

  return energyType;
}

function getFactorById(db, factorId) {
  return db.prepare(
    `SELECT
       cf.id,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       cf.region,
       cf.factor_year AS factorYear,
       cf.unit,
       cf.factor_value AS factorValue,
       cf.factor_unit AS factorUnit,
       cf.source,
       cf.source_url AS sourceUrl,
       cf.effective_from AS effectiveFrom,
       cf.effective_to AS effectiveTo,
       cf.is_active AS isActive,
       CASE WHEN cf.is_active = 1 THEN 'active' ELSE 'inactive' END AS status,
       cf.created_at AS createdAt,
       cf.updated_at AS updatedAt
     FROM carbon_factors cf
     JOIN energy_types et ON et.id = cf.energy_type_id
     WHERE cf.id = @factorId`
  ).get({ factorId });
}

function listCarbonFactors(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: FACTOR_PAGE_SIZE_MAX });
  const filters = {
    energyTypeCode: normalizeText(query.energyTypeCode),
    region: normalizeText(query.region),
    factorYear: normalizeFactorYearFilter(query.factorYear),
    unit: normalizeText(query.unit),
    isActive: normalizeBooleanFlag(query.isActive, 'isActive')
  };

  const where = [];
  const params = { pageSize, offset };
  if (filters.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.region) {
    where.push('cf.region = @region');
    params.region = filters.region;
  }
  if (filters.factorYear !== undefined) {
    where.push('cf.factor_year = @factorYear');
    params.factorYear = filters.factorYear;
  }
  if (filters.unit) {
    where.push('cf.unit = @unit');
    params.unit = filters.unit;
  }
  if (filters.isActive !== undefined) {
    where.push('cf.is_active = @isActive');
    params.isActive = filters.isActive;
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM carbon_factors cf
       JOIN energy_types et ON et.id = cf.energy_type_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         cf.id,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         cf.region,
         cf.factor_year AS factorYear,
         cf.unit,
         cf.factor_value AS factorValue,
         cf.factor_unit AS factorUnit,
         cf.source,
         cf.source_url AS sourceUrl,
         cf.effective_from AS effectiveFrom,
         cf.effective_to AS effectiveTo,
         cf.is_active AS isActive,
         CASE WHEN cf.is_active = 1 THEN 'active' ELSE 'inactive' END AS status,
         cf.created_at AS createdAt,
         cf.updated_at AS updatedAt
       FROM carbon_factors cf
       JOIN energy_types et ON et.id = cf.energy_type_id
       ${whereSql}
       ORDER BY et.display_order ASC, cf.region ASC, cf.factor_year DESC, cf.unit ASC, cf.updated_at DESC
       LIMIT @pageSize OFFSET @offset`
    ).all(params);

    return { rows, pagination: buildPaginationMeta(page, pageSize, total) };
  } finally {
    db.close();
  }
}

function upsertCarbonFactor(payload = {}) {
  const normalizedPayload = normalizeFactorPayload(payload);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const energyType = resolveEnergyType(db, normalizedPayload.energyTypeCode);
      const existing = db.prepare(
        `SELECT id
         FROM carbon_factors
         WHERE energy_type_id = @energyTypeId
           AND region = @region
           AND unit = @unit
           AND source = @source
           AND (
             (factor_year IS NULL AND @factorYear IS NULL)
             OR factor_year = @factorYear
           )`
      ).get({ ...normalizedPayload, energyTypeId: energyType.id });

      if (existing) {
        db.prepare(
          `UPDATE carbon_factors
           SET factor_value = @factorValue,
               factor_unit = @factorUnit,
               source_url = @sourceUrl,
               effective_from = @effectiveFrom,
               effective_to = @effectiveTo,
               is_active = @isActive,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = @factorId`
        ).run({ ...normalizedPayload, factorId: existing.id });
        return { factorId: existing.id, operation: 'updated' };
      }

      const result = db.prepare(
        `INSERT INTO carbon_factors (
           energy_type_id, region, factor_year, unit, factor_value, factor_unit,
           source, source_url, effective_from, effective_to, is_active
         ) VALUES (
           @energyTypeId, @region, @factorYear, @unit, @factorValue, @factorUnit,
           @source, @sourceUrl, @effectiveFrom, @effectiveTo, @isActive
         )`
      ).run({ ...normalizedPayload, energyTypeId: energyType.id });
      return { factorId: result.lastInsertRowid, operation: 'created' };
    });

    const result = transaction();
    return { ...getFactorById(db, result.factorId), operation: result.operation };
  } finally {
    db.close();
  }
}

function setCarbonFactorStatus(factorIdRaw, payload = {}) {
  const factorId = normalizePositiveInteger(factorIdRaw, 'factorId');
  const isActive = normalizeFactorStatusPayload(payload);
  const db = openDatabase();
  try {
    const existing = getFactorById(db, factorId);
    if (!existing) {
      throw notFound('碳因子不存在。', { factorId });
    }

    db.prepare(
      `UPDATE carbon_factors
       SET is_active = @isActive,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @factorId`
    ).run({ factorId, isActive });

    return getFactorById(db, factorId);
  } finally {
    db.close();
  }
}

function getCalculationRecords(db, query = {}) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || CALCULATION_LIMIT_MAX, CALCULATION_LIMIT_MAX);

  const rows = db.prepare(
    `SELECT
       er.id,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       er.normalized_month AS normalizedMonth,
       er.normalized_unit AS normalizedUnit,
       er.normalized_value AS normalizedValue,
       er.organization,
       er.site,
       er.department
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     ${whereSql}
     ORDER BY er.normalized_month ASC, et.display_order ASC, er.id ASC
     LIMIT @limit`
  ).all({ ...params, limit });

  return { rows, filters, limit };
}

function listCandidateFactors(db, record, region, factorYear) {
  return db.prepare(
    `SELECT
       cf.id,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       cf.region,
       cf.factor_year AS factorYear,
       cf.unit,
       cf.factor_value AS factorValue,
       cf.factor_unit AS factorUnit,
       cf.source,
       cf.is_active AS isActive
     FROM carbon_factors cf
     JOIN energy_types et ON et.id = cf.energy_type_id
     WHERE et.code = @energyTypeCode
       AND cf.unit = @normalizedUnit
       AND cf.is_active = 1
       AND (cf.region = @region OR cf.region = @defaultRegion)
       AND (cf.factor_year = @factorYear OR cf.factor_year IS NULL)`
  ).all({
    energyTypeCode: record.energyTypeCode,
    normalizedUnit: record.normalizedUnit,
    region,
    defaultRegion: DEFAULT_REGION,
    factorYear
  });
}

function buildMissingNote(missing) {
  return `缺少匹配碳因子：energyTypeCode=${missing.energyTypeCode}, region=${missing.requestedRegion}, factorYear=${missing.factorYear}, unit=${missing.normalizedUnit}`;
}

function calculateCarbonEmissions(payload = {}) {
  const region = normalizeRegion(payload.region);
  const calculationMethod = normalizeCalculationMethod(payload.calculationMethod);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const selection = getCalculationRecords(db, payload);
      const calculated = [];
      const missingFactors = [];

      selection.rows.forEach((record) => {
        const factorYear = extractYearFromMonth(record.normalizedMonth);
        const candidates = listCandidateFactors(db, record, region, factorYear);
        const match = selectBestCarbonFactor(record, candidates, { region, factorYear });

        db.prepare(
          `UPDATE carbon_emissions
           SET status = 'superseded',
               note = COALESCE(note || char(10), '') || @supersededNote
           WHERE energy_record_id = @energyRecordId
             AND calculation_method = @calculationMethod
             AND status <> 'superseded'`
        ).run({
          energyRecordId: record.id,
          calculationMethod,
          supersededNote: `由 ${new Date().toISOString()} 重新计算标记为 superseded。`
        });

        if (!match.factor) {
          db.prepare(
            `INSERT INTO carbon_emissions (
               energy_record_id, carbon_factor_id, calculation_method, calculation_basis,
               factor_value, activity_value, activity_unit, emission_value, emission_unit, status, note
             ) VALUES (
               @energyRecordId, NULL, @calculationMethod, @calculationBasis,
               NULL, @activityValue, @activityUnit, NULL, @emissionUnit, 'factor_missing', @note
             )`
          ).run({
            energyRecordId: record.id,
            calculationMethod,
            calculationBasis: 'normalized_value * factor_value',
            activityValue: record.normalizedValue,
            activityUnit: record.normalizedUnit,
            emissionUnit: DEFAULT_EMISSION_UNIT,
            note: buildMissingNote(match.missing)
          });
          missingFactors.push(match.missing);
          return;
        }

        const emissionValue = calculateEmissionValue(record.normalizedValue, match.factor.factorValue);
        db.prepare(
          `INSERT INTO carbon_emissions (
             energy_record_id, carbon_factor_id, calculation_method, calculation_basis,
             factor_value, activity_value, activity_unit, emission_value, emission_unit, status, note
           ) VALUES (
             @energyRecordId, @carbonFactorId, @calculationMethod, @calculationBasis,
             @factorValue, @activityValue, @activityUnit, @emissionValue, @emissionUnit, 'calculated', @note
           )`
        ).run({
          energyRecordId: record.id,
          carbonFactorId: match.factor.id,
          calculationMethod,
          calculationBasis: `${record.normalizedValue} ${record.normalizedUnit} * ${match.factor.factorValue} ${match.factor.factorUnit}/${match.factor.unit}`,
          factorValue: match.factor.factorValue,
          activityValue: record.normalizedValue,
          activityUnit: record.normalizedUnit,
          emissionValue,
          emissionUnit: match.factor.factorUnit || DEFAULT_EMISSION_UNIT,
          note: `匹配碳因子：id=${match.factor.id}, region=${match.factor.region}, factorYear=${match.factor.factorYear || 'generic'}, source=${match.factor.source}`
        });
        calculated.push({
          energyRecordId: record.id,
          carbonFactorId: match.factor.id,
          emissionValue,
          emissionUnit: match.factor.factorUnit || DEFAULT_EMISSION_UNIT
        });
      });

      return {
        calculationMethod,
        region,
        filters: selection.filters,
        limit: selection.limit,
        totalRecords: selection.rows.length,
        calculatedCount: calculated.length,
        missingFactorCount: missingFactors.length,
        calculated,
        missingFactors
      };
    });

    return transaction();
  } finally {
    db.close();
  }
}

function buildEmissionWhere(query = {}) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  const conditions = [whereSql.replace(/^WHERE\s+/i, '')];
  const status = normalizeEmissionStatus(query.status);
  const includeSuperseded = normalizeBooleanFlag(query.includeSuperseded, 'includeSuperseded') === 1;
  const calculationMethod = normalizeText(query.calculationMethod);

  if (status) {
    conditions.push('ce.status = @status');
    params.status = status;
  } else if (!includeSuperseded) {
    conditions.push("ce.status <> 'superseded'");
  }
  if (calculationMethod) {
    conditions.push('ce.calculation_method = @calculationMethod');
    params.calculationMethod = calculationMethod;
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
    filters,
    status,
    includeSuperseded,
    calculationMethod
  };
}

function listCarbonEmissions(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: 200 });
  const sort = normalizeEmissionSort(query);
  const { whereSql, params } = buildEmissionWhere(query);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM carbon_emissions ce
       JOIN energy_records er ON er.id = ce.energy_record_id
       JOIN energy_types et ON et.id = er.energy_type_id
       LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         ce.id,
         ce.energy_record_id AS energyRecordId,
         ce.carbon_factor_id AS carbonFactorId,
         ce.calculation_method AS calculationMethod,
         ce.calculation_basis AS calculationBasis,
         ce.factor_value AS factorValue,
         ce.activity_value AS activityValue,
         ce.activity_unit AS activityUnit,
         ce.emission_value AS emissionValue,
         ce.emission_unit AS emissionUnit,
         ce.status,
         ce.calculated_at AS calculatedAt,
         ce.note,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         er.normalized_month AS normalizedMonth,
         er.organization,
         er.site,
         er.department,
         cf.region AS factorRegion,
         cf.factor_year AS factorYear,
         cf.source AS factorSource
       FROM carbon_emissions ce
       JOIN energy_records er ON er.id = ce.energy_record_id
       JOIN energy_types et ON et.id = er.energy_type_id
       LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id
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
}

function getEmissionStatistics(query = {}) {
  const group = normalizeEmissionGroupBy(query.groupBy);
  const { whereSql, params } = buildEmissionWhere(query);
  const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || 100, 500);
  const db = openDatabase();
  try {
    const rows = db.prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(${group.columnSql}), ''), '未填写') AS groupValue,
         COUNT(ce.id) AS emissionRecordCount,
         SUM(CASE WHEN ce.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount,
         SUM(CASE WHEN ce.status = 'factor_missing' THEN 1 ELSE 0 END) AS missingFactorCount,
         COALESCE(SUM(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE 0 END), 0) AS totalEmissionValue,
         COALESCE(AVG(CASE WHEN ce.status = 'calculated' THEN ce.emission_value ELSE NULL END), 0) AS averageEmissionValue,
         MIN(er.normalized_month) AS monthStart,
         MAX(er.normalized_month) AS monthEnd
       FROM carbon_emissions ce
       JOIN energy_records er ON er.id = ce.energy_record_id
       JOIN energy_types et ON et.id = er.energy_type_id
       LEFT JOIN carbon_factors cf ON cf.id = ce.carbon_factor_id
       ${whereSql}
       GROUP BY groupValue
       ORDER BY totalEmissionValue DESC, emissionRecordCount DESC, groupValue ASC
       LIMIT @limit`
    ).all({ ...params, limit });

    return { groupBy: group.groupBy, rows };
  } finally {
    db.close();
  }
}

function listMissingCarbonFactors(query = {}) {
  const normalizedQuery = { ...query, status: 'factor_missing' };
  const { whereSql, params } = buildEmissionWhere(normalizedQuery);
  const region = normalizeRegion(query.region);
  const limit = Math.min(normalizePositiveInteger(query.limit, 'limit') || 100, 500);
  const db = openDatabase();
  try {
    const rows = db.prepare(
      `SELECT
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         er.normalized_unit AS unit,
         CAST(substr(er.normalized_month, 1, 4) AS INTEGER) AS factorYear,
         COUNT(ce.id) AS missingRecordCount,
         COALESCE(SUM(er.normalized_value), 0) AS affectedActivityValue,
         MIN(er.normalized_month) AS monthStart,
         MAX(er.normalized_month) AS monthEnd,
         MAX(ce.calculated_at) AS latestCalculatedAt
       FROM carbon_emissions ce
       JOIN energy_records er ON er.id = ce.energy_record_id
       JOIN energy_types et ON et.id = er.energy_type_id
       ${whereSql}
       GROUP BY et.code, et.name, er.normalized_unit, factorYear
       ORDER BY missingRecordCount DESC, et.code ASC, factorYear DESC
       LIMIT @limit`
    ).all({ ...params, limit });

    return rows.map((row) => ({
      ...row,
      requestedRegion: region,
      suggestedFactorFields: {
        energyTypeCode: row.energyTypeCode,
        region,
        factorYear: row.factorYear,
        unit: row.unit,
        factorValue: '待维护',
        source: '待填写'
      }
    }));
  } finally {
    db.close();
  }
}

module.exports = {
  calculateCarbonEmissions,
  listCarbonEmissions,
  listCarbonFactors,
  listMissingCarbonFactors,
  getEmissionStatistics,
  setCarbonFactorStatus,
  upsertCarbonFactor
};
