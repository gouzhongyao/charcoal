'use strict';

const XLSX = require('xlsx');
const { AsyncLocalStorage } = require('async_hooks');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  formatStrictUtcForUser,
  formatWallClockMinuteForUser
} = require('../utils/userVisibleDateTime');
const { escapeSpreadsheetFormula } = require('./carbonActivityService');
const carbonCalculationRunService = require('./carbonCalculationRunService');
const {
  assertCarbonAccountingQueryContract,
  hasOwnQueryField,
  normalizeCarbonAccountingServiceError,
  normalizeCarbonAccountingUtc
} = carbonCalculationRunService;

// 查询故障作用域独立保存在本模块私有闭包中，正常 consumer 无法取得或安装 hook。
const CARBON_ACCOUNTING_RESULT_FAULT_SCOPE = new AsyncLocalStorage();

/** 在当前查询异步作用域触发固定阶段，只向 hook 提供冻结阶段和空安全摘要。 */
function invokeCarbonAccountingFaultStage(stage) {
  const faultInjector = CARBON_ACCOUNTING_RESULT_FAULT_SCOPE.getStore();
  if (typeof faultInjector === 'function') {
    faultInjector(Object.freeze({
      stage: String(stage),
      summary: Object.freeze({})
    }));
  }
}

// 新核算查询只接受三个显式来源投影，默认来源在服务边界固定为独立活动。
const CARBON_ACCOUNTING_RESULT_SOURCE_TYPES = Object.freeze([
  'independent_activity',
  'energy_record',
  'all'
]);
// 每个来源导出最多 5000 行，第 5001 行仅用于识别并拒绝超限。
const CARBON_ACCOUNTING_EXPORT_LIMIT = 5000;
// 结果列表分页在两个来源 facet 中独立执行，禁止合并后分页。
const CARBON_ACCOUNTING_RESULT_PAGE_SIZE_MAX = 200;
// SQLite LIKE 使用固定转义字符，确保用户输入的百分号和下划线按文本处理。
const LIKE_ESCAPE_CHARACTER = '!';
// 旧能耗来源月份筛选保持 YYYY-MM 合同。
const STRICT_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
// 两个来源的结果状态并集用于 all facet 筛选，来源不支持的状态自然返回空集合。
const ACCOUNTING_RESULT_STATUSES = Object.freeze([
  'calculated',
  'factor_missing',
  'invalid_record',
  'superseded'
]);
// 列表、统计与导出共享筛选字段，但各端点独立决定分页和格式字段。
const CARBON_ACCOUNTING_FILTER_QUERY_FIELDS = Object.freeze([
  'sourceType', 'source_type', 'runCode', 'run_code', 'status',
  'scope', 'emissionScope', 'emission_scope',
  'organizationUnitId', 'organization_unit_id', 'energyTypeId', 'energy_type_id',
  'energyTypeCode', 'energy_type_code', 'emissionUnit', 'emission_unit',
  'calculationMethod', 'calculation_method', 'keyword', 'search',
  'startUtc', 'start_utc', 'endUtc', 'end_utc',
  'monthStart', 'normalizedMonthStart', 'monthEnd', 'normalizedMonthEnd',
  'includeSuperseded'
]);
// 结果列表允许分页字段，且 all 将同一安全分页分别应用到两个 facet。
const CARBON_ACCOUNTING_RESULTS_QUERY_FIELDS = Object.freeze(new Set([
  ...CARBON_ACCOUNTING_FILTER_QUERY_FIELDS, 'page', 'pageSize'
]));
// 统计端点禁止无效分页和导出格式参数。
const CARBON_ACCOUNTING_STATISTICS_QUERY_FIELDS = Object.freeze(new Set([
  ...CARBON_ACCOUNTING_FILTER_QUERY_FIELDS
]));
// 导出端点允许格式参数，但禁止列表分页参数造成静默忽略。
const CARBON_ACCOUNTING_EXPORT_QUERY_FIELDS = Object.freeze(new Set([
  ...CARBON_ACCOUNTING_FILTER_QUERY_FIELDS, 'format'
]));

// 独立结果只关联 completed 运行自身，不关联当前活动、组织、能源类型或因子表。
const INDEPENDENT_RESULT_SELECT_SQL = `SELECT result.id,
  run.run_code AS runCode,
  result.source_type AS sourceType,
  result.activity_record_id AS activityRecordId,
  result.carbon_factor_id AS carbonFactorId,
  result.emission_scope AS emissionScope,
  result.activity_category AS activityCategory,
  result.organization_unit_id AS organizationUnitId,
  result.energy_type_id AS energyTypeId,
  result.activity_start_wall_clock AS activityStartWallClock,
  result.activity_end_wall_clock AS activityEndWallClock,
  result.activity_start_utc AS activityStartUtc,
  result.activity_end_utc AS activityEndUtc,
  result.activity_value AS activityValue,
  result.activity_unit AS activityUnit,
  result.requested_region AS requestedRegion,
  result.factor_year AS factorYear,
  result.factor_value AS factorValue,
  result.factor_unit AS factorUnit,
  result.emission_value AS emissionValue,
  result.emission_unit AS emissionUnit,
  result.status,
  result.missing_reason AS missingReason,
  result.calculation_basis AS calculationBasis,
  result.match_priority AS matchPriority,
  result.activity_snapshot_json AS activitySnapshotJson,
  result.organization_snapshot_json AS organizationSnapshotJson,
  result.energy_type_snapshot_json AS energyTypeSnapshotJson,
  result.factor_snapshot_json AS factorSnapshotJson,
  result.matching_snapshot_json AS matchingSnapshotJson,
  result.formula_snapshot_json AS formulaSnapshotJson,
  result.created_at AS createdAt
FROM carbon_accounting_results result
JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id`;

// 旧能耗来源投影保持 carbon_emissions 当前查询字段，不写入或修改旧结果。
const ENERGY_RESULT_SELECT_SQL = `SELECT emission.id,
  'energy_record' AS sourceType,
  emission.energy_record_id AS energyRecordId,
  emission.carbon_factor_id AS carbonFactorId,
  emission.calculation_method AS calculationMethod,
  emission.calculation_basis AS calculationBasis,
  emission.factor_value AS factorValue,
  emission.activity_value AS activityValue,
  emission.activity_unit AS activityUnit,
  emission.emission_value AS emissionValue,
  emission.emission_unit AS emissionUnit,
  emission.status,
  emission.calculated_at AS calculatedAt,
  emission.note,
  energy.code AS energyTypeCode,
  energy.name AS energyTypeName,
  record.energy_type_id AS energyTypeId,
  record.organization_unit_id AS organizationUnitId,
  organization.unit_code AS organizationUnitCode,
  organization.unit_name AS organizationUnitName,
  organization.unit_path AS organizationUnitPath,
  record.meter_device_id AS meterDeviceId,
  meter.meter_code AS meterCode,
  meter.meter_name AS meterName,
  record.normalized_month AS normalizedMonth,
  factor.region AS factorRegion,
  factor.factor_year AS factorYear,
  factor.source AS factorSource
FROM carbon_emissions emission
JOIN energy_records record ON record.id = emission.energy_record_id
JOIN energy_types energy ON energy.id = record.energy_type_id
JOIN organization_units organization ON organization.id = record.organization_unit_id
LEFT JOIN meter_devices meter ON meter.id = record.meter_device_id
LEFT JOIN carbon_factors factor ON factor.id = emission.carbon_factor_id`;

/** 读取同一语义的一组兼容查询字段，并拒绝同时提交多个别名。 */
function resolveAliasedQueryValue(query, fieldNames, publicFieldName) {
  const suppliedFields = fieldNames.filter((fieldName) => hasOwnQueryField(query, fieldName));
  if (suppliedFields.length > 1) {
    throw badRequest(`${publicFieldName} 不得通过多个别名重复提交。`, {
      code: 'CARBON_ACCOUNTING_QUERY_DUPLICATE_FIELDS',
      fieldName: publicFieldName,
      suppliedFields
    });
  }
  return suppliedFields.length === 0 ? undefined : query[suppliedFields[0]];
}

/** 规范化来源类型；仅真正缺省时返回 independent_activity，显式空值必须拒绝。 */
function normalizeAccountingSourceType(value) {
  if (value === undefined) return 'independent_activity';
  if (value === null || typeof value === 'object') {
    throw badRequest('sourceType 必须是单一字符串。', {
      code: 'CARBON_ACCOUNTING_SOURCE_TYPE_INVALID'
    });
  }
  const sourceType = String(value).trim();
  if (!sourceType || !CARBON_ACCOUNTING_RESULT_SOURCE_TYPES.includes(sourceType)) {
    throw badRequest('sourceType 仅支持 independent_activity、energy_record 或 all。', {
      code: 'CARBON_ACCOUNTING_SOURCE_TYPE_INVALID',
      sourceType
    });
  }
  return sourceType;
}

/** 从 Express 查询对象解析来源，供权限中间件和服务使用同一缺省/空值语义。 */
function resolveAccountingSourceTypeFromQuery(query = {}) {
  return normalizeAccountingSourceType(resolveAliasedQueryValue(
    query,
    ['sourceType', 'source_type'],
    'sourceType'
  ));
}

/** 将可选正整数筛选规范化为安全整数。 */
function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const numberValue = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code: 'CARBON_ACCOUNTING_FILTER_ID_INVALID',
      fieldName
    });
  }
  return numberValue;
}

/** 规范化可选 YYYY-MM 月份。 */
function normalizeOptionalMonth(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!STRICT_MONTH_PATTERN.test(text)) {
    throw badRequest(`${fieldName} 必须是 YYYY-MM。`, {
      code: 'CARBON_ACCOUNTING_MONTH_INVALID',
      fieldName
    });
  }
  return text;
}

/** 规范化列表分页，all 来源将同一安全分页参数分别应用到两个 facet。 */
function normalizeResultPagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw badRequest('page 必须是正整数。', { code: 'CARBON_ACCOUNTING_PAGE_INVALID' });
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CARBON_ACCOUNTING_RESULT_PAGE_SIZE_MAX) {
    throw badRequest(`pageSize 必须是 1 到 ${CARBON_ACCOUNTING_RESULT_PAGE_SIZE_MAX} 的整数。`, {
      code: 'CARBON_ACCOUNTING_PAGE_SIZE_INVALID',
      maxPageSize: CARBON_ACCOUNTING_RESULT_PAGE_SIZE_MAX
    });
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw badRequest('分页偏移超出安全整数范围。', {
      code: 'CARBON_ACCOUNTING_OFFSET_INVALID'
    });
  }
  return { page, pageSize, offset };
}

/** 转义 LIKE 元字符。 */
function escapeLikePattern(value) {
  return String(value)
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);
}

/** 将缺省查询文本规范化为 null，并拒绝数组、对象或显式空文本。 */
function normalizeOptionalQueryText(value, fieldName) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'object' || String(value).trim() === '') {
    throw badRequest(`${fieldName} 查询值无效。`, {
      code: 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID',
      fieldName
    });
  }
  return String(value).trim();
}

/** 统一规范化列表、统计与导出的公共筛选输入。 */
function normalizeAccountingResultFilters(query = {}) {
  const sourceType = resolveAccountingSourceTypeFromQuery(query);
  const runCode = normalizeOptionalQueryText(resolveAliasedQueryValue(
    query, ['runCode', 'run_code'], 'runCode'
  ), 'runCode');
  if (runCode && runCode.length > 128) {
    throw badRequest('runCode 格式无效。', { code: 'CARBON_ACCOUNTING_RUN_CODE_INVALID' });
  }
  if (sourceType === 'energy_record' && runCode) {
    throw badRequest('energy_record 来源不接受独立活动 runCode。', {
      code: 'CARBON_ACCOUNTING_RUN_CODE_SOURCE_MISMATCH'
    });
  }
  const status = normalizeOptionalQueryText(query.status, 'status');
  if (status && !ACCOUNTING_RESULT_STATUSES.includes(status)) {
    throw badRequest('status 不在核算结果状态白名单内。', {
      code: 'CARBON_ACCOUNTING_STATUS_INVALID',
      status,
      allowedStatuses: ACCOUNTING_RESULT_STATUSES
    });
  }
  const emissionScope = normalizeOptionalQueryText(resolveAliasedQueryValue(
    query, ['scope', 'emissionScope', 'emission_scope'], 'scope'
  ), 'scope');
  if (emissionScope && !['scope_1', 'scope_2', 'scope_3'].includes(emissionScope)) {
    throw badRequest('scope 筛选无效。', { code: 'CARBON_ACCOUNTING_SCOPE_INVALID' });
  }
  const startUtcValue = resolveAliasedQueryValue(query, ['startUtc', 'start_utc'], 'startUtc');
  const endUtcValue = resolveAliasedQueryValue(query, ['endUtc', 'end_utc'], 'endUtc');
  const startUtc = startUtcValue === undefined ? null : normalizeCarbonAccountingUtc(startUtcValue, 'startUtc');
  const endUtc = endUtcValue === undefined ? null : normalizeCarbonAccountingUtc(endUtcValue, 'endUtc');
  if (startUtc && endUtc && Date.parse(startUtc) >= Date.parse(endUtc)) {
    throw badRequest('筛选期间必须满足 startUtc < endUtc。', {
      code: 'CARBON_ACCOUNTING_RANGE_INVALID'
    });
  }
  const monthStart = normalizeOptionalMonth(resolveAliasedQueryValue(
    query, ['monthStart', 'normalizedMonthStart'], 'monthStart'
  ), 'monthStart');
  const monthEnd = normalizeOptionalMonth(resolveAliasedQueryValue(
    query, ['monthEnd', 'normalizedMonthEnd'], 'monthEnd'
  ), 'monthEnd');
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份筛选开始值不能晚于结束值。', {
      code: 'CARBON_ACCOUNTING_MONTH_RANGE_INVALID'
    });
  }
  const includeSupersededText = query.includeSuperseded;
  const includeSuperseded = includeSupersededText === true
    || includeSupersededText === 1
    || ['true', '1'].includes(String(includeSupersededText ?? '').trim().toLowerCase());
  if (includeSupersededText !== undefined
    && ![true, false, 1, 0, 'true', 'false', '1', '0'].includes(includeSupersededText)) {
    throw badRequest('includeSuperseded 必须是布尔值。', {
      code: 'CARBON_ACCOUNTING_BOOLEAN_INVALID'
    });
  }
  return {
    sourceType,
    runCode,
    status,
    emissionScope,
    organizationUnitId: normalizeOptionalPositiveInteger(resolveAliasedQueryValue(
      query, ['organizationUnitId', 'organization_unit_id'], 'organizationUnitId'
    ), 'organizationUnitId'),
    energyTypeId: normalizeOptionalPositiveInteger(resolveAliasedQueryValue(
      query, ['energyTypeId', 'energy_type_id'], 'energyTypeId'
    ), 'energyTypeId'),
    energyTypeCode: normalizeOptionalQueryText(resolveAliasedQueryValue(
      query, ['energyTypeCode', 'energy_type_code'], 'energyTypeCode'
    ), 'energyTypeCode'),
    emissionUnit: normalizeOptionalQueryText(resolveAliasedQueryValue(
      query, ['emissionUnit', 'emission_unit'], 'emissionUnit'
    ), 'emissionUnit'),
    calculationMethod: normalizeOptionalQueryText(resolveAliasedQueryValue(
      query, ['calculationMethod', 'calculation_method'], 'calculationMethod'
    ), 'calculationMethod'),
    keyword: normalizeOptionalQueryText(resolveAliasedQueryValue(
      query, ['keyword', 'search'], 'keyword'
    ), 'keyword'),
    startUtc,
    endUtc,
    monthStart,
    monthEnd,
    includeSuperseded
  };
}

/** 解析 canonical 快照 JSON。 */
function parseSnapshotJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

/** 投影独立活动历史结果。 */
function mapIndependentResultRow(row) {
  const activitySnapshot = parseSnapshotJson(row.activitySnapshotJson);
  const organizationSnapshot = parseSnapshotJson(row.organizationSnapshotJson);
  const energyTypeSnapshot = parseSnapshotJson(row.energyTypeSnapshotJson);
  const factorSnapshot = parseSnapshotJson(row.factorSnapshotJson);
  return {
    id: Number(row.id),
    runCode: row.runCode,
    sourceType: row.sourceType,
    activityRecordId: Number(row.activityRecordId),
    carbonFactorId: row.carbonFactorId === null ? null : Number(row.carbonFactorId),
    emissionScope: row.emissionScope,
    activityCategory: row.activityCategory,
    organizationUnitId: Number(row.organizationUnitId),
    organizationUnitCode: organizationSnapshot.organization.unitCode,
    organizationUnitName: organizationSnapshot.organization.unitName,
    energyTypeId: Number(row.energyTypeId),
    energyTypeCode: energyTypeSnapshot.energyType.code,
    energyTypeName: energyTypeSnapshot.energyType.name,
    activityCode: activitySnapshot.activity.activityCode,
    activityStartWallClock: row.activityStartWallClock,
    activityEndWallClock: row.activityEndWallClock,
    activityStartUtc: row.activityStartUtc,
    activityEndUtc: row.activityEndUtc,
    activityValue: Number(row.activityValue),
    activityUnit: row.activityUnit,
    requestedRegion: row.requestedRegion,
    factorYear: Number(row.factorYear),
    factorValue: row.factorValue === null ? null : Number(row.factorValue),
    factorUnit: row.factorUnit,
    factorRegion: factorSnapshot?.factor?.region || null,
    factorSource: factorSnapshot?.factor?.source || null,
    emissionValue: row.emissionValue === null ? null : Number(row.emissionValue),
    emissionUnit: row.emissionUnit,
    status: row.status,
    missingReason: row.missingReason,
    calculationBasis: row.calculationBasis,
    matchPriority: row.matchPriority === null ? null : Number(row.matchPriority),
    activitySnapshot,
    organizationSnapshot,
    energyTypeSnapshot,
    factorSnapshot,
    matchingSnapshot: parseSnapshotJson(row.matchingSnapshotJson),
    formulaSnapshot: parseSnapshotJson(row.formulaSnapshotJson),
    createdAt: row.createdAt
  };
}

/** 投影旧能耗碳排放结果并补充来源标记。 */
function mapEnergyResultRow(row) {
  return {
    ...row,
    id: Number(row.id),
    energyRecordId: Number(row.energyRecordId),
    carbonFactorId: row.carbonFactorId === null ? null : Number(row.carbonFactorId),
    energyTypeId: Number(row.energyTypeId),
    organizationUnitId: row.organizationUnitId === null ? null : Number(row.organizationUnitId),
    factorYear: row.factorYear === null ? null : Number(row.factorYear),
    factorValue: row.factorValue === null ? null : Number(row.factorValue),
    activityValue: Number(row.activityValue),
    emissionValue: row.emissionValue === null ? null : Number(row.emissionValue)
  };
}

/** 解析 completed 独立运行；未指定 runCode 时固定选择最新一条。 */
function resolveCompletedIndependentRun(db, runCode) {
  const row = runCode
    ? db.prepare(`SELECT id, run_code AS runCode, start_utc AS startUtc, end_utc AS endUtc,
        status, completed_at AS completedAt, activity_count AS activityCount,
        calculated_count AS calculatedCount, factor_missing_count AS factorMissingCount
      FROM carbon_calculation_runs
      WHERE run_code = ? AND source_type = 'independent_activity' AND status = 'completed'`).get(runCode)
    : db.prepare(`SELECT id, run_code AS runCode, start_utc AS startUtc, end_utc AS endUtc,
        status, completed_at AS completedAt, activity_count AS activityCount,
        calculated_count AS calculatedCount, factor_missing_count AS factorMissingCount
      FROM carbon_calculation_runs
      WHERE source_type = 'independent_activity' AND status = 'completed'
      ORDER BY completed_at DESC, id DESC LIMIT 1`).get();
  if (!row && runCode) throw notFound('独立碳核算运行不存在。', { runCode });
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    activityCount: Number(row.activityCount),
    calculatedCount: Number(row.calculatedCount),
    factorMissingCount: Number(row.factorMissingCount)
  };
}

/** 构造独立活动结果筛选，供列表、统计和导出共用。 */
function buildIndependentResultWhere(filters, runId) {
  const clauses = [
    "run.source_type = 'independent_activity'",
    "run.status = 'completed'",
    'run.id = @runId'
  ];
  const params = { runId };
  if (filters.status) {
    if (['calculated', 'factor_missing'].includes(filters.status)) {
      clauses.push('result.status = @status');
      params.status = filters.status;
    } else {
      clauses.push('1 = 0');
    }
  }
  if (filters.emissionScope) {
    clauses.push('result.emission_scope = @emissionScope');
    params.emissionScope = filters.emissionScope;
  }
  if (filters.organizationUnitId) {
    clauses.push('result.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = filters.organizationUnitId;
  }
  if (filters.energyTypeId) {
    clauses.push('result.energy_type_id = @energyTypeId');
    params.energyTypeId = filters.energyTypeId;
  }
  if (filters.energyTypeCode) {
    clauses.push("json_extract(result.energy_type_snapshot_json, '$.energyType.code') = @energyTypeCode");
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.emissionUnit) {
    clauses.push('result.emission_unit = @emissionUnit');
    params.emissionUnit = filters.emissionUnit;
  }
  if (filters.calculationMethod && filters.calculationMethod !== 'standard-factor') clauses.push('1 = 0');
  if (filters.startUtc) {
    clauses.push('unixepoch(result.activity_end_utc) > unixepoch(@startUtc)');
    params.startUtc = filters.startUtc;
  }
  if (filters.endUtc) {
    clauses.push('unixepoch(result.activity_start_utc) < unixepoch(@endUtc)');
    params.endUtc = filters.endUtc;
  }
  if (filters.keyword) {
    params.keyword = `%${escapeLikePattern(filters.keyword)}%`;
    clauses.push(`(json_extract(result.activity_snapshot_json, '$.activity.activityCode') LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR result.activity_category LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR json_extract(result.organization_snapshot_json, '$.organization.unitCode') LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR json_extract(result.organization_snapshot_json, '$.organization.unitName') LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR json_extract(result.energy_type_snapshot_json, '$.energyType.code') LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR json_extract(result.energy_type_snapshot_json, '$.energyType.name') LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}')`);
  }
  return { whereSql: `WHERE ${clauses.join(' AND ')}`, params };
}

/** 构造旧能耗结果筛选，供列表、统计和导出共用。 */
function buildEnergyResultWhere(filters) {
  const clauses = ["record.record_status = 'active'"];
  const params = {};
  if (filters.status) {
    clauses.push('emission.status = @status');
    params.status = filters.status;
  } else if (!filters.includeSuperseded) {
    clauses.push("emission.status <> 'superseded'");
  }
  if (filters.organizationUnitId) {
    clauses.push('record.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = filters.organizationUnitId;
  }
  if (filters.energyTypeId) {
    clauses.push('record.energy_type_id = @energyTypeId');
    params.energyTypeId = filters.energyTypeId;
  }
  if (filters.energyTypeCode) {
    clauses.push('energy.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.emissionUnit) {
    clauses.push('emission.emission_unit = @emissionUnit');
    params.emissionUnit = filters.emissionUnit;
  }
  if (filters.calculationMethod) {
    clauses.push('emission.calculation_method = @calculationMethod');
    params.calculationMethod = filters.calculationMethod;
  }
  if (filters.monthStart) {
    clauses.push('record.normalized_month >= @monthStart');
    params.monthStart = filters.monthStart;
  }
  if (filters.monthEnd) {
    clauses.push('record.normalized_month <= @monthEnd');
    params.monthEnd = filters.monthEnd;
  }
  if (filters.emissionScope || filters.startUtc || filters.endUtc) clauses.push('1 = 0');
  if (filters.keyword) {
    params.keyword = `%${escapeLikePattern(filters.keyword)}%`;
    clauses.push(`(energy.code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR energy.name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR organization.unit_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR organization.unit_name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR organization.unit_path LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR meter.meter_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR meter.meter_name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR emission.note LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}')`);
  }
  return { whereSql: `WHERE ${clauses.join(' AND ')}`, params };
}

/** 在已打开数据库上独立分页查询活动来源结果。 */
function listIndependentResultFacet(db, filters, pagination) {
  const run = resolveCompletedIndependentRun(db, filters.runCode);
  if (!run) {
    return {
      sourceType: 'independent_activity',
      run: null,
      rows: [],
      pagination: { page: pagination.page, pageSize: pagination.pageSize, total: 0 }
    };
  }
  const { whereSql, params } = buildIndependentResultWhere(filters, run.id);
  const total = Number(db.prepare(`SELECT COUNT(*) AS total
    FROM carbon_accounting_results result
    JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id ${whereSql}`)
    .get(params).total || 0);
  const rows = db.prepare(`${INDEPENDENT_RESULT_SELECT_SQL} ${whereSql}
    ORDER BY result.activity_start_utc ASC, result.id ASC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
    .map(mapIndependentResultRow);
  return {
    sourceType: 'independent_activity',
    run,
    rows,
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total }
  };
}

/** 在已打开数据库上独立分页查询旧能耗来源结果。 */
function listEnergyResultFacet(db, filters, pagination) {
  const { whereSql, params } = buildEnergyResultWhere(filters);
  const total = Number(db.prepare(`SELECT COUNT(*) AS total
    FROM carbon_emissions emission
    JOIN energy_records record ON record.id = emission.energy_record_id
    JOIN energy_types energy ON energy.id = record.energy_type_id
    JOIN organization_units organization ON organization.id = record.organization_unit_id
    LEFT JOIN meter_devices meter ON meter.id = record.meter_device_id
    LEFT JOIN carbon_factors factor ON factor.id = emission.carbon_factor_id ${whereSql}`)
    .get(params).total || 0);
  const rows = db.prepare(`${ENERGY_RESULT_SELECT_SQL} ${whereSql}
    ORDER BY emission.calculated_at DESC, emission.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
    .map(mapEnergyResultRow);
  return {
    sourceType: 'energy_record',
    rows,
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total }
  };
}

/** 查询单来源或双 facet 结果；all 永远不提供跨来源总计。 */
function listCarbonAccountingResults(query = {}) {
  try {
    assertCarbonAccountingQueryContract(query, CARBON_ACCOUNTING_RESULTS_QUERY_FIELDS, '核算结果');
    const filters = normalizeAccountingResultFilters(query);
    const pagination = normalizeResultPagination(query);
    const db = openDatabase();
    try {
      invokeCarbonAccountingFaultStage('list-results');
      if (filters.sourceType === 'independent_activity') {
        return listIndependentResultFacet(db, filters, pagination);
      }
      if (filters.sourceType === 'energy_record') {
        return listEnergyResultFacet(db, filters, pagination);
      }
      return {
        sourceType: 'all',
        facets: {
          independentActivity: listIndependentResultFacet(db, filters, pagination),
          energyRecord: listEnergyResultFacet(db, filters, pagination)
        },
        crossSourceTotal: null,
        aggregationPolicy: '两个来源分别分页且不合并；禁止跨来源和跨 emissionUnit 汇总。'
      };
    } finally {
      db.close();
    }
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
}

/** 将统计行数值字段投影为 Number。 */
function mapStatisticsSummary(row) {
  return {
    totalRecords: Number(row?.totalRecords || 0),
    calculatedCount: Number(row?.calculatedCount || 0),
    factorMissingCount: Number(row?.factorMissingCount || 0),
    invalidRecordCount: Number(row?.invalidRecordCount || 0),
    supersededCount: Number(row?.supersededCount || 0)
  };
}

/** 投影按单位统计总计，拒绝 SQLite 聚合产生的 null 或非有限数值。 */
function mapFiniteStatisticsTotal(row) {
  const totalEmissionValue = Number(row?.totalEmissionValue);
  if (row?.totalEmissionValue === null || !Number.isFinite(totalEmissionValue)) {
    throw new AppError(
      'CARBON_ACCOUNTING_NON_FINITE_STATISTICS_TOTAL',
      '排放统计汇总产生非有限数值，已拒绝返回。',
      { statusCode: 422, details: null }
    );
  }
  return {
    emissionUnit: row.emissionUnit,
    emissionRecordCount: Number(row.emissionRecordCount),
    totalEmissionValue
  };
}

/** 统计独立活动来源，排放总计严格按 emissionUnit 分列。 */
function buildIndependentStatisticsFacet(db, filters) {
  const run = resolveCompletedIndependentRun(db, filters.runCode);
  if (!run) {
    return {
      sourceType: 'independent_activity',
      run: null,
      summary: mapStatisticsSummary(null),
      totalsByEmissionUnit: []
    };
  }
  const { whereSql, params } = buildIndependentResultWhere(filters, run.id);
  const summary = db.prepare(`SELECT COUNT(*) AS totalRecords,
      SUM(CASE WHEN result.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount,
      SUM(CASE WHEN result.status = 'factor_missing' THEN 1 ELSE 0 END) AS factorMissingCount,
      0 AS invalidRecordCount,
      0 AS supersededCount
    FROM carbon_accounting_results result
    JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id ${whereSql}`).get(params);
  const totalsByEmissionUnit = db.prepare(`SELECT result.emission_unit AS emissionUnit,
      COUNT(*) AS emissionRecordCount,
      ROUND(SUM(result.emission_value), 6) AS totalEmissionValue
    FROM carbon_accounting_results result
    JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id ${whereSql}
      AND result.status = 'calculated' AND result.emission_unit IS NOT NULL
    GROUP BY result.emission_unit ORDER BY result.emission_unit`).all(params).map(mapFiniteStatisticsTotal);
  return {
    sourceType: 'independent_activity',
    run,
    summary: mapStatisticsSummary(summary),
    totalsByEmissionUnit
  };
}

/** 统计旧能耗来源，排放总计严格按 emissionUnit 分列。 */
function buildEnergyStatisticsFacet(db, filters) {
  const { whereSql, params } = buildEnergyResultWhere(filters);
  const fromSql = `FROM carbon_emissions emission
    JOIN energy_records record ON record.id = emission.energy_record_id
    JOIN energy_types energy ON energy.id = record.energy_type_id
    JOIN organization_units organization ON organization.id = record.organization_unit_id
    LEFT JOIN meter_devices meter ON meter.id = record.meter_device_id
    LEFT JOIN carbon_factors factor ON factor.id = emission.carbon_factor_id ${whereSql}`;
  const summary = db.prepare(`SELECT COUNT(*) AS totalRecords,
      SUM(CASE WHEN emission.status = 'calculated' THEN 1 ELSE 0 END) AS calculatedCount,
      SUM(CASE WHEN emission.status = 'factor_missing' THEN 1 ELSE 0 END) AS factorMissingCount,
      SUM(CASE WHEN emission.status = 'invalid_record' THEN 1 ELSE 0 END) AS invalidRecordCount,
      SUM(CASE WHEN emission.status = 'superseded' THEN 1 ELSE 0 END) AS supersededCount
    ${fromSql}`).get(params);
  const totalsByEmissionUnit = db.prepare(`SELECT emission.emission_unit AS emissionUnit,
      COUNT(*) AS emissionRecordCount,
      ROUND(SUM(emission.emission_value), 6) AS totalEmissionValue
    ${fromSql} AND emission.status = 'calculated' AND emission.emission_unit IS NOT NULL
    GROUP BY emission.emission_unit ORDER BY emission.emission_unit`).all(params).map(mapFiniteStatisticsTotal);
  return {
    sourceType: 'energy_record',
    summary: mapStatisticsSummary(summary),
    totalsByEmissionUnit
  };
}

/** 统计单来源或双 facet，all 的 crossSourceTotal 固定为 null。 */
function getCarbonAccountingStatistics(query = {}) {
  try {
    assertCarbonAccountingQueryContract(query, CARBON_ACCOUNTING_STATISTICS_QUERY_FIELDS, '核算统计');
    const filters = normalizeAccountingResultFilters(query);
    const db = openDatabase();
    try {
      invokeCarbonAccountingFaultStage('statistics');
      if (filters.sourceType === 'independent_activity') return buildIndependentStatisticsFacet(db, filters);
      if (filters.sourceType === 'energy_record') return buildEnergyStatisticsFacet(db, filters);
      return {
        sourceType: 'all',
        facets: {
          independentActivity: buildIndependentStatisticsFacet(db, filters),
          energyRecord: buildEnergyStatisticsFacet(db, filters)
        },
        crossSourceTotal: null,
        aggregationPolicy: '两个来源及各 emissionUnit 分别统计；禁止跨来源和跨单位总计。'
      };
    } finally {
      db.close();
    }
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
}

/** 读取独立来源全部导出候选并用 LIMIT 5001 识别超限。 */
function selectIndependentExportRows(db, filters) {
  const run = resolveCompletedIndependentRun(db, filters.runCode);
  if (!run) return { sourceType: 'independent_activity', run: null, rows: [] };
  const { whereSql, params } = buildIndependentResultWhere(filters, run.id);
  const rows = db.prepare(`${INDEPENDENT_RESULT_SELECT_SQL} ${whereSql}
    ORDER BY result.activity_start_utc ASC, result.id ASC LIMIT @limit`)
    .all({ ...params, limit: CARBON_ACCOUNTING_EXPORT_LIMIT + 1 })
    .map(mapIndependentResultRow);
  if (rows.length > CARBON_ACCOUNTING_EXPORT_LIMIT) {
    throw badRequest('独立活动来源导出超过 5000 行，请缩小筛选范围。', {
      code: 'CARBON_ACCOUNTING_EXPORT_LIMIT_EXCEEDED',
      sourceType: 'independent_activity',
      maxRows: CARBON_ACCOUNTING_EXPORT_LIMIT
    });
  }
  return { sourceType: 'independent_activity', run, rows };
}

/** 读取旧能耗来源全部导出候选并用 LIMIT 5001 识别超限。 */
function selectEnergyExportRows(db, filters) {
  const { whereSql, params } = buildEnergyResultWhere(filters);
  const rows = db.prepare(`${ENERGY_RESULT_SELECT_SQL} ${whereSql}
    ORDER BY emission.calculated_at DESC, emission.id DESC LIMIT @limit`)
    .all({ ...params, limit: CARBON_ACCOUNTING_EXPORT_LIMIT + 1 })
    .map(mapEnergyResultRow);
  if (rows.length > CARBON_ACCOUNTING_EXPORT_LIMIT) {
    throw badRequest('旧能耗来源导出超过 5000 行，请缩小筛选范围。', {
      code: 'CARBON_ACCOUNTING_EXPORT_LIMIT_EXCEEDED',
      sourceType: 'energy_record',
      maxRows: CARBON_ACCOUNTING_EXPORT_LIMIT
    });
  }
  return { sourceType: 'energy_record', rows };
}

// 独立来源导出字段完全来自冻结快照和结果筛选列。
const INDEPENDENT_EXPORT_FIELDS = Object.freeze([
  ['sourceType', '来源类型'], ['runCode', '运行编码'],
  ['activityRecordId', '活动记录ID'], ['activityCode', '活动记录编码'],
  ['emissionScope', '排放范围'], ['activityCategory', '活动类别'],
  ['organizationUnitCode', '用能单元编码'], ['organizationUnitName', '用能单元名称'],
  ['energyTypeCode', '能源类型编码'], ['energyTypeName', '能源类型名称'],
  ['activityStartWallClock', '活动开始墙钟'], ['activityEndWallClock', '活动结束墙钟'],
  ['activityStartUtc', '活动开始UTC'], ['activityEndUtc', '活动结束UTC'],
  ['activityValue', '活动数据值'], ['activityUnit', '活动数据单位'],
  ['requestedRegion', '请求因子地区'], ['factorYear', '因子年份'],
  ['carbonFactorId', '碳因子ID'], ['factorValue', '因子值'], ['factorUnit', '因子单位'],
  ['factorRegion', '命中因子地区'], ['factorSource', '因子来源'],
  ['emissionValue', '排放量'], ['emissionUnit', '排放单位'], ['status', '状态'],
  ['missingReason', '缺因子原因'], ['matchPriority', '匹配优先级'], ['createdAt', '核算时间']
]);
// 能耗来源导出字段只使用 canonical 外键及其 JOIN 派生名称。
const ENERGY_EXPORT_FIELDS = Object.freeze([
  ['sourceType', '来源类型'], ['id', '碳排放记录ID'], ['energyRecordId', '能耗记录ID'],
  ['normalizedMonth', '月份'], ['energyTypeCode', '能源类型编码'], ['energyTypeName', '能源类型名称'],
  ['organizationUnitId', '用能单元ID'], ['organizationUnitCode', '用能单元编码'],
  ['organizationUnitName', '用能单元名称'], ['organizationUnitPath', '用能单元路径'],
  ['meterDeviceId', '计量器具ID'], ['meterCode', '计量器具编码'], ['meterName', '计量器具名称'],
  ['calculationMethod', '核算方法'], ['activityValue', '活动数据值'], ['activityUnit', '活动数据单位'],
  ['carbonFactorId', '碳因子ID'], ['factorValue', '因子值'], ['factorRegion', '因子地区'],
  ['factorYear', '因子年份'], ['factorSource', '因子来源'], ['emissionValue', '排放量'],
  ['emissionUnit', '排放单位'], ['status', '状态'], ['calculatedAt', '核算时间'], ['note', '备注']
]);

// 核算导出中的来源墙钟和严格 UTC 字段使用固定字段语义，不按值形态猜测。
const USER_VISIBLE_WALL_CLOCK_EXPORT_FIELDS = new Set(['activityStartWallClock', 'activityEndWallClock']);
const USER_VISIBLE_UTC_EXPORT_FIELDS = new Set(['activityStartUtc', 'activityEndUtc', 'createdAt', 'calculatedAt']);

/** 将对象结果映射为经过时间展示和公式注入防护的二维表格。 */
function buildSafeExportMatrix(rows, fields) {
  const headers = fields.map(([, header]) => header);
  const values = rows.map((row) => fields.map(([fieldName]) => {
    let value = row[fieldName];
    if (USER_VISIBLE_WALL_CLOCK_EXPORT_FIELDS.has(fieldName)) value = formatWallClockMinuteForUser(value);
    if (USER_VISIBLE_UTC_EXPORT_FIELDS.has(fieldName)) value = formatStrictUtcForUser(value);
    return escapeSpreadsheetFormula(value);
  }));
  return { headers, values };
}

/** 将 CSV 单元格按 UTF-8 CSV 规则转义。 */
function escapeCsvCell(value) {
  return `"${escapeSpreadsheetFormula(value).replace(/"/g, '""')}"`;
}

/** 将单个 facet 追加到 XLSX 工作簿。 */
function appendFacetWorksheet(workbook, sheetName, matrix) {
  const worksheet = XLSX.utils.aoa_to_sheet([matrix.headers, ...matrix.values]);
  worksheet['!cols'] = matrix.headers.map((_header, index) => ({
    wch: Math.min(40, Math.max(12, ...matrix.values.map((row) => String(row[index] ?? '').length + 2)))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/** 导出单来源或双来源 facet；all 在 XLSX 中使用独立工作表，在 CSV 中使用独立分段。 */
function exportCarbonAccountingResults(query = {}) {
  try {
    assertCarbonAccountingQueryContract(query, CARBON_ACCOUNTING_EXPORT_QUERY_FIELDS, '核算导出');
    const filters = normalizeAccountingResultFilters(query);
    const format = query.format === undefined ? 'xlsx' : String(query.format).trim().toLowerCase();
    if (!['xlsx', 'csv'].includes(format)) {
      throw badRequest('format 仅支持 xlsx 或 csv。', {
        code: 'CARBON_ACCOUNTING_EXPORT_FORMAT_INVALID'
      });
    }
    const db = openDatabase();
    try {
      invokeCarbonAccountingFaultStage('export');
      const facets = [];
      if (filters.sourceType !== 'energy_record') facets.push(selectIndependentExportRows(db, filters));
      if (filters.sourceType !== 'independent_activity') facets.push(selectEnergyExportRows(db, filters));
      const matrices = facets.map((facet) => ({
        ...facet,
        matrix: buildSafeExportMatrix(
          facet.rows,
          facet.sourceType === 'independent_activity' ? INDEPENDENT_EXPORT_FIELDS : ENERGY_EXPORT_FIELDS
        )
      }));
      const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      if (format === 'csv') {
        const sections = matrices.map((facet) => {
          const sourceLabel = facet.sourceType === 'independent_activity' ? '独立碳活动' : '旧能耗记录';
          const csvRows = [facet.matrix.headers, ...facet.matrix.values]
            .map((row) => row.map(escapeCsvCell).join(','));
          return filters.sourceType === 'all'
            ? [escapeCsvCell(`来源：${sourceLabel}`), ...csvRows].join('\n')
            : csvRows.join('\n');
        });
        const body = Buffer.from(`﻿${sections.join('\n\n')}\n`, 'utf8');
        return {
          body,
          contentType: 'text/csv; charset=utf-8',
          fileName: `碳核算结果导出-${date}.csv`,
          asciiFileName: `carbon-accounting-results-${date}.csv`,
          format,
          sourceType: filters.sourceType,
          rowCounts: Object.fromEntries(facets.map((facet) => [facet.sourceType, facet.rows.length])),
          crossSourceTotal: null
        };
      }
      const workbook = XLSX.utils.book_new();
      matrices.forEach((facet) => appendFacetWorksheet(
        workbook,
        facet.sourceType === 'independent_activity' ? '独立碳活动结果' : '旧能耗结果',
        facet.matrix
      ));
      return {
        body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: `碳核算结果导出-${date}.xlsx`,
        asciiFileName: `carbon-accounting-results-${date}.xlsx`,
        format,
        sourceType: filters.sourceType,
        rowCounts: Object.fromEntries(facets.map((facet) => [facet.sourceType, facet.rows.length])),
        crossSourceTotal: null
      };
    } finally {
      db.close();
    }
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
}

module.exports = {
  ACCOUNTING_RESULT_STATUSES,
  CARBON_ACCOUNTING_EXPORT_LIMIT,
  CARBON_ACCOUNTING_EXPORT_QUERY_FIELDS,
  CARBON_ACCOUNTING_RESULTS_QUERY_FIELDS,
  CARBON_ACCOUNTING_RESULT_PAGE_SIZE_MAX,
  CARBON_ACCOUNTING_RESULT_SOURCE_TYPES,
  CARBON_ACCOUNTING_STATISTICS_QUERY_FIELDS,
  ENERGY_EXPORT_FIELDS,
  INDEPENDENT_EXPORT_FIELDS,
  buildEnergyResultWhere,
  buildIndependentResultWhere,
  exportCarbonAccountingResults,
  getCarbonAccountingStatistics,
  listCarbonAccountingResults,
  normalizeAccountingResultFilters,
  normalizeAccountingSourceType,
  normalizeResultPagination,
  resolveAccountingSourceTypeFromQuery
};
