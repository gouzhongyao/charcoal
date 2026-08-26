'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');

// 单次独立碳活动计算最多锁内选择 5000 条，额外一条仅用于识别超限。
const CARBON_ACCOUNTING_ACTIVITY_LIMIT = 5000;
// 运行和结果快照使用固定版本，后续结构演进必须显式升级读取兼容。
const CARBON_ACCOUNTING_SNAPSHOT_VERSION = 1;
// 本节点冻结唯一计算方法与来源，禁止误读旧 energy_records 计算链路。
const CARBON_ACCOUNTING_CALCULATION_METHOD = 'standard-factor';
const CARBON_ACCOUNTING_SOURCE_TYPE = 'independent_activity';
// 缺因子原因使用稳定编码和文案，历史查询不得根据当前因子状态重新推导。
const CARBON_ACCOUNTING_MISSING_FACTOR_CODE = 'NO_ACTIVE_EXACT_UNIT_FACTOR';
const CARBON_ACCOUNTING_MISSING_FACTOR_MESSAGE = '未找到活动能源类型、活动单位、请求地区和来源墙钟年份对应的启用碳因子。';
// UTC 运行期间只接受秒精度或可显式规范化的零毫秒格式。
const STRICT_UTC_SECOND_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
// 运行历史列表仅接受固定分页和 UTC 区间字段。
const CARBON_ACCOUNTING_RUN_QUERY_FIELDS = Object.freeze(new Set([
  'page', 'pageSize', 'startUtc', 'endUtc'
]));
// 仅供隔离 HTTP 测试注入 N5-B 未知异常，生产运行默认始终为空。
let carbonAccountingFaultInjectorForTest = null;

/** 保留已知领域错误，并把 N5-B 未知异常转换为固定、无底层详情的公开错误。 */
function normalizeCarbonAccountingServiceError(error) {
  if (error instanceof AppError) return error;
  return new AppError('CARBON_ACCOUNTING_INTERNAL_ERROR', '独立碳核算服务内部错误。', {
    statusCode: 500,
    details: null
  });
}

/** 设置或清除隔离测试故障注入器，禁止由 HTTP 输入控制。 */
function setCarbonAccountingFaultInjectorForTest(faultInjector) {
  carbonAccountingFaultInjectorForTest = typeof faultInjector === 'function' ? faultInjector : null;
}

/** 在指定 N5-B 服务阶段触发隔离测试故障。 */
function invokeCarbonAccountingFaultInjectorForTest(stage, context = {}) {
  if (typeof carbonAccountingFaultInjectorForTest === 'function') {
    carbonAccountingFaultInjectorForTest(stage, context);
  }
}

// 计算输入固定投影全部活动事实及组织、能源类型当前值，随后写入不可变快照。
const CALCULATION_ACTIVITY_SELECT_SQL = `SELECT activity.id,
  activity.source_type AS sourceType,
  activity.source_batch_id AS sourceBatchId,
  activity.source_row_number AS sourceRowNumber,
  activity.energy_record_id AS energyRecordId,
  activity.activity_code AS activityCode,
  activity.activity_code_key AS activityCodeKey,
  activity.supersedes_activity_id AS supersedesActivityId,
  activity.superseded_by_activity_id AS supersededByActivityId,
  activity.emission_scope AS emissionScope,
  activity.activity_category AS activityCategory,
  activity.activity_category_key AS activityCategoryKey,
  activity.organization_unit_id AS organizationUnitId,
  organization.parent_id AS organizationParentId,
  organization.unit_code AS organizationUnitCode,
  organization.unit_name AS organizationUnitName,
  organization.unit_path AS organizationUnitPath,
  organization.unit_type AS organizationUnitType,
  organization.area AS organizationArea,
  organization.sort_order AS organizationSortOrder,
  organization.status AS organizationStatus,
  organization.remark AS organizationRemark,
  organization.created_at AS organizationCreatedAt,
  organization.updated_at AS organizationUpdatedAt,
  activity.energy_type_id AS energyTypeId,
  energy.code AS energyTypeCode,
  energy.name AS energyTypeName,
  energy.category AS energyTypeCategory,
  energy.default_unit AS energyTypeDefaultUnit,
  energy.standard_unit AS energyTypeStandardUnit,
  energy.carbon_factor_required AS energyTypeCarbonFactorRequired,
  energy.is_active AS energyTypeIsActive,
  energy.display_order AS energyTypeDisplayOrder,
  energy.created_at AS energyTypeCreatedAt,
  energy.updated_at AS energyTypeUpdatedAt,
  activity.start_wall_clock AS startWallClock,
  activity.end_wall_clock AS endWallClock,
  activity.source_timezone AS sourceTimezone,
  activity.start_utc AS startUtc,
  activity.end_utc AS endUtc,
  activity.activity_value AS activityValue,
  activity.activity_unit AS activityUnit,
  activity.factor_region AS factorRegion,
  activity.source_reference AS sourceReference,
  activity.evidence_reference AS evidenceReference,
  activity.note,
  activity.duplicate_key AS duplicateKey,
  activity.record_status AS recordStatus,
  activity.void_reason AS voidReason,
  activity.voided_at AS voidedAt,
  activity.voided_by AS voidedBy,
  activity.created_by AS activityCreatedBy,
  activity.created_at AS activityCreatedAt,
  activity.updated_at AS activityUpdatedAt
FROM carbon_activity_records activity
JOIN organization_units organization ON organization.id = activity.organization_unit_id
JOIN energy_types energy ON energy.id = activity.energy_type_id
WHERE activity.source_type = 'independent_activity'
  AND activity.record_status = 'active'
  AND unixepoch(activity.end_utc) > unixepoch(@startUtc)
  AND unixepoch(activity.start_utc) < unixepoch(@endUtc)
ORDER BY activity.start_utc ASC, activity.id ASC
LIMIT @selectionLimit`;

// 因子候选仅允许启用、同能源类型、单位精确相同及冻结四级地区/年份组合。
const MATCHING_FACTOR_SELECT_SQL = `SELECT factor.id,
  factor.source_batch_id AS sourceBatchId,
  factor.source_row_number AS sourceRowNumber,
  factor.energy_type_id AS energyTypeId,
  factor.region,
  factor.factor_year AS factorYear,
  factor.unit,
  factor.factor_value AS factorValue,
  factor.factor_unit AS factorUnit,
  factor.source,
  factor.source_url AS sourceUrl,
  factor.effective_from AS effectiveFrom,
  factor.effective_to AS effectiveTo,
  factor.is_active AS isActive,
  factor.created_at AS createdAt,
  factor.updated_at AS updatedAt,
  CASE
    WHEN factor.region = @requestedRegion AND factor.factor_year = @factorYear THEN 1
    WHEN factor.region = 'default' AND factor.factor_year = @factorYear THEN 2
    WHEN factor.region = @requestedRegion AND factor.factor_year IS NULL THEN 3
    WHEN factor.region = 'default' AND factor.factor_year IS NULL THEN 4
    ELSE 5
  END AS matchPriority
FROM carbon_factors factor
WHERE factor.is_active = 1
  AND factor.energy_type_id = @energyTypeId
  AND factor.unit = @activityUnit
  AND (factor.region = @requestedRegion OR factor.region = 'default')
  AND (factor.factor_year = @factorYear OR factor.factor_year IS NULL)
ORDER BY matchPriority ASC, factor.id DESC
LIMIT 1`;

/** 将任意 JSON 值按对象键排序，生成跨运行稳定的摘要输入。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 计算稳定 SHA-256 小写十六进制摘要。 */
function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** 校验严格 UTC 秒精度并把 .000Z 规范化为 Z。 */
function normalizeCarbonAccountingUtc(value, fieldName) {
  const text = String(value ?? '').trim();
  const match = STRICT_UTC_SECOND_PATTERN.exec(text);
  const milliseconds = match?.[7] || '';
  if (!match || (milliseconds && milliseconds !== '000')) {
    throw badRequest(`${fieldName} 必须是严格秒精度 UTC ISO 时间。`, {
      code: 'CARBON_ACCOUNTING_UTC_INVALID',
      fieldName
    });
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const normalizedDate = new Date(0);
  normalizedDate.setUTCFullYear(year, month - 1, day);
  normalizedDate.setUTCHours(hour, minute, second, 0);
  const calendarMatches = normalizedDate.getUTCFullYear() === year
    && normalizedDate.getUTCMonth() === month - 1
    && normalizedDate.getUTCDate() === day
    && normalizedDate.getUTCHours() === hour
    && normalizedDate.getUTCMinutes() === minute
    && normalizedDate.getUTCSeconds() === second;
  if (!calendarMatches) {
    throw badRequest(`${fieldName} 必须是有效的严格 UTC 日历时间。`, {
      code: 'CARBON_ACCOUNTING_UTC_INVALID',
      fieldName
    });
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/** 规范化创建运行输入并拒绝未知字段。 */
function normalizeCreateRunInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('独立碳核算运行请求体必须是 JSON 对象。', {
      code: 'CARBON_ACCOUNTING_PAYLOAD_INVALID'
    });
  }
  const allowedFields = new Set(['startUtc', 'endUtc']);
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('独立碳核算运行请求包含未知字段。', {
      code: 'CARBON_ACCOUNTING_UNKNOWN_FIELDS',
      unknownFields
    });
  }
  const startUtc = normalizeCarbonAccountingUtc(input.startUtc, 'startUtc');
  const endUtc = normalizeCarbonAccountingUtc(input.endUtc, 'endUtc');
  if (Date.parse(startUtc) >= Date.parse(endUtc)) {
    throw badRequest('运行期间必须满足 startUtc < endUtc。', {
      code: 'CARBON_ACCOUNTING_RANGE_INVALID'
    });
  }
  return { startUtc, endUtc };
}

/** 判断对象是否显式包含查询字段，用于区分缺省与空值。 */
function hasOwnQueryField(query, fieldName) {
  return Object.prototype.hasOwnProperty.call(query || {}, fieldName);
}

/** 按端点白名单拒绝未知字段以及重复、数组或对象查询值。 */
function assertCarbonAccountingQueryContract(query, allowedFields, endpointName) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw badRequest(`${endpointName} 查询参数格式无效。`, {
      code: 'CARBON_ACCOUNTING_QUERY_INVALID'
    });
  }
  const unknownFields = Object.keys(query).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest(`${endpointName} 查询包含未知字段。`, {
      code: 'CARBON_ACCOUNTING_QUERY_UNKNOWN_FIELDS',
      unknownFields
    });
  }
  const invalidFields = Object.keys(query).filter((fieldName) => (
    query[fieldName] === null
    || typeof query[fieldName] === 'object'
    || String(query[fieldName]).trim() === ''
  ));
  if (invalidFields.length > 0) {
    throw badRequest(`${endpointName} 查询字段不得重复或使用数组/对象值。`, {
      code: 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID',
      invalidFields
    });
  }
}

/** 规范化运行列表分页，超出页面或安全偏移范围时拒绝而非静默碰撞。 */
function normalizeRunPagination(query = {}) {
  const rawPage = query.page === undefined ? 1 : query.page;
  const rawPageSize = query.pageSize === undefined ? 20 : query.pageSize;
  if ((rawPage !== null && typeof rawPage === 'object')
    || (rawPageSize !== null && typeof rawPageSize === 'object')) {
    throw badRequest('分页参数不得重复或使用数组/对象值。', {
      code: 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID'
    });
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw badRequest('page 必须是正整数。', { code: 'CARBON_ACCOUNTING_PAGE_INVALID' });
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw badRequest('pageSize 必须是 1 到 200 的整数。', {
      code: 'CARBON_ACCOUNTING_PAGE_SIZE_INVALID',
      maxPageSize: 200
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

/** 从活动来源墙钟开始时间提取请求因子年份，合法范围保持为 0001—9999。 */
function extractFactorYear(activity) {
  const factorYear = Number(String(activity.startWallClock || '').slice(0, 4));
  if (!Number.isInteger(factorYear) || factorYear < 1 || factorYear > 9999) {
    throw new AppError('CARBON_ACCOUNTING_ACTIVITY_YEAR_INVALID', '活动来源墙钟年份无效，已拒绝计算。', {
      statusCode: 422,
      details: { activityRecordId: Number(activity.id) }
    });
  }
  return factorYear;
}

/** 以六位小数计算排放值，任何非有限中间值或结果均使整次运行回滚。 */
function calculateEmissionValue(activityValue, factorValue, activityRecordId) {
  const normalizedActivityValue = Number(activityValue);
  const normalizedFactorValue = Number(factorValue);
  const rawValue = normalizedActivityValue * normalizedFactorValue;
  const roundedValue = Math.round(rawValue * 1e6) / 1e6;
  if (![normalizedActivityValue, normalizedFactorValue, rawValue, roundedValue].every(Number.isFinite)) {
    throw new AppError('CARBON_ACCOUNTING_NON_FINITE_RESULT', '排放计算产生非有限数值，整次运行已回滚。', {
      statusCode: 422,
      details: { activityRecordId: Number(activityRecordId) }
    });
  }
  return roundedValue;
}

/** 构造活动、组织和能源类型三个独立快照。 */
function buildActivitySnapshots(activity) {
  const activitySnapshot = {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    activity: {
      id: Number(activity.id),
      sourceType: activity.sourceType,
      sourceBatchId: activity.sourceBatchId === null ? null : Number(activity.sourceBatchId),
      sourceRowNumber: activity.sourceRowNumber === null ? null : Number(activity.sourceRowNumber),
      energyRecordId: activity.energyRecordId === null ? null : Number(activity.energyRecordId),
      activityCode: activity.activityCode,
      activityCodeKey: activity.activityCodeKey,
      supersedesActivityId: activity.supersedesActivityId === null ? null : Number(activity.supersedesActivityId),
      supersededByActivityId: activity.supersededByActivityId === null ? null : Number(activity.supersededByActivityId),
      emissionScope: activity.emissionScope,
      activityCategory: activity.activityCategory,
      activityCategoryKey: activity.activityCategoryKey,
      organizationUnitId: Number(activity.organizationUnitId),
      energyTypeId: Number(activity.energyTypeId),
      startWallClock: activity.startWallClock,
      endWallClock: activity.endWallClock,
      sourceTimezone: activity.sourceTimezone,
      startUtc: activity.startUtc,
      endUtc: activity.endUtc,
      activityValue: Number(activity.activityValue),
      activityUnit: activity.activityUnit,
      factorRegion: activity.factorRegion,
      sourceReference: activity.sourceReference,
      evidenceReference: activity.evidenceReference,
      note: activity.note,
      duplicateKey: activity.duplicateKey,
      recordStatus: activity.recordStatus,
      voidReason: activity.voidReason,
      voidedAt: activity.voidedAt,
      voidedBy: activity.voidedBy === null ? null : Number(activity.voidedBy),
      createdBy: activity.activityCreatedBy === null ? null : Number(activity.activityCreatedBy),
      createdAt: activity.activityCreatedAt,
      updatedAt: activity.activityUpdatedAt
    }
  };
  const organizationSnapshot = {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    organization: {
      id: Number(activity.organizationUnitId),
      parentId: activity.organizationParentId === null ? null : Number(activity.organizationParentId),
      unitCode: activity.organizationUnitCode,
      unitName: activity.organizationUnitName,
      unitPath: activity.organizationUnitPath,
      unitType: activity.organizationUnitType,
      area: activity.organizationArea === null ? null : Number(activity.organizationArea),
      sortOrder: Number(activity.organizationSortOrder),
      status: activity.organizationStatus,
      remark: activity.organizationRemark,
      createdAt: activity.organizationCreatedAt,
      updatedAt: activity.organizationUpdatedAt
    }
  };
  const energyTypeSnapshot = {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    energyType: {
      id: Number(activity.energyTypeId),
      code: activity.energyTypeCode,
      name: activity.energyTypeName,
      category: activity.energyTypeCategory,
      defaultUnit: activity.energyTypeDefaultUnit,
      standardUnit: activity.energyTypeStandardUnit,
      carbonFactorRequired: Number(activity.energyTypeCarbonFactorRequired),
      isActive: Number(activity.energyTypeIsActive),
      displayOrder: Number(activity.energyTypeDisplayOrder),
      createdAt: activity.energyTypeCreatedAt,
      updatedAt: activity.energyTypeUpdatedAt
    }
  };
  return { activitySnapshot, organizationSnapshot, energyTypeSnapshot };
}

/** 构造命中因子的完整快照，effective 区间仅冻结而不参与本轮匹配。 */
function buildFactorSnapshot(factor) {
  if (!factor) return null;
  return {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    factor: {
      id: Number(factor.id),
      sourceBatchId: factor.sourceBatchId === null ? null : Number(factor.sourceBatchId),
      sourceRowNumber: factor.sourceRowNumber === null ? null : Number(factor.sourceRowNumber),
      energyTypeId: Number(factor.energyTypeId),
      region: factor.region,
      factorYear: factor.factorYear === null ? null : Number(factor.factorYear),
      unit: factor.unit,
      factorValue: Number(factor.factorValue),
      factorUnit: factor.factorUnit,
      source: factor.source,
      sourceUrl: factor.sourceUrl,
      effectiveFrom: factor.effectiveFrom,
      effectiveTo: factor.effectiveTo,
      isActive: Number(factor.isActive),
      createdAt: factor.createdAt,
      updatedAt: factor.updatedAt
    }
  };
}

/** 为单条活动生成不可变结果写入参数。 */
function buildCalculationResult(db, activity) {
  const factorYear = extractFactorYear(activity);
  const requestedRegion = String(activity.factorRegion || '').trim() || 'default';
  const factor = db.prepare(MATCHING_FACTOR_SELECT_SQL).get({
    requestedRegion,
    factorYear,
    energyTypeId: Number(activity.energyTypeId),
    activityUnit: activity.activityUnit
  }) || null;
  const snapshots = buildActivitySnapshots(activity);
  const factorSnapshot = buildFactorSnapshot(factor);
  const missingReason = factor ? null : CARBON_ACCOUNTING_MISSING_FACTOR_CODE;
  const matchingSnapshot = {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    policy: {
      activeOnly: true,
      exactEnergyType: true,
      exactActivityUnit: true,
      effectiveRangeParticipates: false,
      priority: [
        'requested_region+requested_year',
        'default_region+requested_year',
        'requested_region+generic_year',
        'default_region+generic_year'
      ],
      tieBreaker: 'factor_id_desc'
    },
    request: {
      requestedRegion,
      factorYear,
      energyTypeId: Number(activity.energyTypeId),
      activityUnit: activity.activityUnit
    },
    selected: factor ? { factorId: Number(factor.id), matchPriority: Number(factor.matchPriority) } : null,
    missing: factor ? null : {
      code: CARBON_ACCOUNTING_MISSING_FACTOR_CODE,
      message: CARBON_ACCOUNTING_MISSING_FACTOR_MESSAGE
    }
  };
  const emissionValue = factor
    ? calculateEmissionValue(activity.activityValue, factor.factorValue, activity.id)
    : null;
  const formulaSnapshot = {
    version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
    expression: 'round(activity_value * factor_value, 6)',
    usesFullActivityValue: true,
    overlapProration: false,
    activityValue: Number(activity.activityValue),
    activityUnit: activity.activityUnit,
    factorValue: factor ? Number(factor.factorValue) : null,
    factorUnit: factor?.factorUnit || null,
    emissionValue,
    emissionUnit: factor?.factorUnit || null,
    decimalPlaces: 6
  };
  return {
    activity,
    factor,
    factorYear,
    requestedRegion,
    emissionValue,
    missingReason,
    status: factor ? 'calculated' : 'factor_missing',
    matchPriority: factor ? Number(factor.matchPriority) : null,
    factorSnapshot,
    matchingSnapshot,
    formulaSnapshot,
    ...snapshots
  };
}

/** 将单条计算结果写入追加式结果表。 */
function insertCalculationResult(db, calculationRunId, result) {
  db.prepare(`INSERT INTO carbon_accounting_results
    (calculation_run_id, snapshot_schema_version, source_type, activity_record_id,
     carbon_factor_id, emission_scope, activity_category, organization_unit_id, energy_type_id,
     activity_start_wall_clock, activity_end_wall_clock, activity_start_utc, activity_end_utc,
     activity_value, activity_unit, requested_region, factor_year, factor_value, factor_unit,
     emission_value, emission_unit, status, missing_reason, calculation_basis, match_priority,
     activity_snapshot_json, organization_snapshot_json, energy_type_snapshot_json,
     factor_snapshot_json, matching_snapshot_json, formula_snapshot_json, created_at)
    VALUES (@calculationRunId, 1, 'independent_activity', @activityRecordId,
      @carbonFactorId, @emissionScope, @activityCategory, @organizationUnitId, @energyTypeId,
      @activityStartWallClock, @activityEndWallClock, @activityStartUtc, @activityEndUtc,
      @activityValue, @activityUnit, @requestedRegion, @factorYear, @factorValue, @factorUnit,
      @emissionValue, @emissionUnit, @status, @missingReason, 'activity_value * factor_value',
      @matchPriority, @activitySnapshotJson, @organizationSnapshotJson, @energyTypeSnapshotJson,
      @factorSnapshotJson, @matchingSnapshotJson, @formulaSnapshotJson, @createdAt)`)
    .run({
      calculationRunId,
      activityRecordId: Number(result.activity.id),
      carbonFactorId: result.factor ? Number(result.factor.id) : null,
      emissionScope: result.activity.emissionScope,
      activityCategory: result.activity.activityCategory,
      organizationUnitId: Number(result.activity.organizationUnitId),
      energyTypeId: Number(result.activity.energyTypeId),
      activityStartWallClock: result.activity.startWallClock,
      activityEndWallClock: result.activity.endWallClock,
      activityStartUtc: result.activity.startUtc,
      activityEndUtc: result.activity.endUtc,
      activityValue: Number(result.activity.activityValue),
      activityUnit: result.activity.activityUnit,
      requestedRegion: result.requestedRegion,
      factorYear: result.factorYear,
      factorValue: result.factor ? Number(result.factor.factorValue) : null,
      factorUnit: result.factor?.factorUnit || null,
      emissionValue: result.emissionValue,
      emissionUnit: result.factor?.factorUnit || null,
      status: result.status,
      missingReason: result.missingReason,
      matchPriority: result.matchPriority,
      activitySnapshotJson: JSON.stringify(result.activitySnapshot),
      organizationSnapshotJson: JSON.stringify(result.organizationSnapshot),
      energyTypeSnapshotJson: JSON.stringify(result.energyTypeSnapshot),
      factorSnapshotJson: result.factorSnapshot ? JSON.stringify(result.factorSnapshot) : null,
      matchingSnapshotJson: JSON.stringify(result.matchingSnapshot),
      formulaSnapshotJson: JSON.stringify(result.formulaSnapshot),
      createdAt: result.createdAt
    });
}

/** 按排放单位形成互不合并的运行总计。 */
function buildEmissionTotals(results) {
  const totalsByUnit = new Map();
  results.filter((result) => result.status === 'calculated').forEach((result) => {
    const emissionUnit = result.factor.factorUnit;
    const current = totalsByUnit.get(emissionUnit) || { emissionUnit, totalEmissionValue: 0, calculatedCount: 0 };
    const nextTotal = current.totalEmissionValue + result.emissionValue;
    const scaledTotal = nextTotal * 1e6;
    const roundedTotal = Math.round(scaledTotal) / 1e6;
    if (![nextTotal, scaledTotal, roundedTotal].every(Number.isFinite)) {
      throw new AppError('CARBON_ACCOUNTING_NON_FINITE_TOTAL', '排放汇总产生非有限数值，整次运行已回滚。', {
        statusCode: 422
      });
    }
    current.totalEmissionValue = roundedTotal;
    current.calculatedCount += 1;
    totalsByUnit.set(emissionUnit, current);
  });
  return [...totalsByUnit.values()].sort((left, right) => left.emissionUnit.localeCompare(right.emissionUnit));
}

/** 将内部 actor 快照投影为公开 DTO，IP 只保留在持久化快照和操作审计。 */
function projectPublicActorSnapshot(actorSnapshotJson) {
  const snapshot = JSON.parse(actorSnapshotJson);
  return {
    version: Number(snapshot.version),
    actor: {
      userId: snapshot.actor?.userId === null || snapshot.actor?.userId === undefined
        ? null
        : Number(snapshot.actor.userId),
      username: snapshot.actor?.username || null,
      displayName: snapshot.actor?.displayName || null
    }
  };
}

/** 将运行数据库行投影为不依赖当前主数据且不公开 actor IP 的稳定对象。 */
function mapCalculationRunRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    runCode: row.runCode,
    snapshotSchemaVersion: Number(row.snapshotSchemaVersion),
    sourceType: row.sourceType,
    status: row.status,
    calculationMethod: row.calculationMethod,
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    activityFilter: JSON.parse(row.activityFilterJson),
    actorSnapshot: projectPublicActorSnapshot(row.actorSnapshotJson),
    activitySnapshotDigest: row.activitySnapshotDigest,
    activityCount: Number(row.activityCount),
    resultCount: Number(row.resultCount),
    calculatedCount: Number(row.calculatedCount),
    factorMissingCount: Number(row.factorMissingCount),
    emissionTotals: JSON.parse(row.emissionTotalsJson),
    createdBy: row.createdBy === null ? null : Number(row.createdBy),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt
  };
}

// 历史运行查询只读取运行自身快照，不关联当前用户或其他主数据。
const CALCULATION_RUN_SELECT_SQL = `SELECT run.id,
  run.run_code AS runCode,
  run.snapshot_schema_version AS snapshotSchemaVersion,
  run.source_type AS sourceType,
  run.status,
  run.calculation_method AS calculationMethod,
  run.start_utc AS startUtc,
  run.end_utc AS endUtc,
  run.activity_filter_json AS activityFilterJson,
  run.actor_snapshot_json AS actorSnapshotJson,
  run.activity_snapshot_digest AS activitySnapshotDigest,
  run.activity_count AS activityCount,
  run.result_count AS resultCount,
  run.calculated_count AS calculatedCount,
  run.factor_missing_count AS factorMissingCount,
  run.emission_totals_json AS emissionTotalsJson,
  run.created_by AS createdBy,
  run.started_at AS startedAt,
  run.completed_at AS completedAt,
  run.created_at AS createdAt
FROM carbon_calculation_runs run`;

/** 创建一条追加式独立碳活动计算运行，并在 immediate 事务中写结果和成功审计。 */
function createCarbonCalculationRun(input = {}, actor = {}, options = {}) {
  const period = normalizeCreateRunInput(input);
  let db;
  try {
    db = openDatabase();
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
  const startedAt = new Date().toISOString();
  try {
    return db.transaction(() => {
      invokeCarbonAccountingFaultInjectorForTest('create-run', { db });
      const activities = db.prepare(CALCULATION_ACTIVITY_SELECT_SQL).all({
        ...period,
        selectionLimit: CARBON_ACCOUNTING_ACTIVITY_LIMIT + 1
      });
      if (activities.length > CARBON_ACCOUNTING_ACTIVITY_LIMIT) {
        throw new AppError('CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED', '匹配活动超过单次运行上限，整次运行已回滚。', {
          statusCode: 422,
          details: { maxActivities: CARBON_ACCOUNTING_ACTIVITY_LIMIT }
        });
      }
      const completedAt = new Date().toISOString();
      const results = activities.map((activity) => ({
        ...buildCalculationResult(db, activity),
        createdAt: completedAt
      }));
      const calculatedCount = results.filter((result) => result.status === 'calculated').length;
      const factorMissingCount = results.length - calculatedCount;
      const emissionTotals = buildEmissionTotals(results);
      const activityFilter = {
        version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
        sourceType: CARBON_ACCOUNTING_SOURCE_TYPE,
        recordStatus: 'active',
        interval: { ...period, semantics: '[startUtc,endUtc)', positiveOverlapOnly: true },
        usesFullActivityValue: true,
        overlapProration: false,
        maxActivities: CARBON_ACCOUNTING_ACTIVITY_LIMIT
      };
      const actorSnapshot = {
        version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
        actor: {
          userId: actor.userId || null,
          username: actor.username || null,
          displayName: actor.displayName || null,
          ip: actor.ip || null
        }
      };
      const snapshotDigestInput = results.map((result) => ({
        activity: result.activitySnapshot,
        organization: result.organizationSnapshot,
        energyType: result.energyTypeSnapshot,
        factor: result.factorSnapshot,
        matching: result.matchingSnapshot,
        formula: result.formulaSnapshot
      }));
      const runCode = `CAR-${completedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID()}`;
      const insertedRun = db.prepare(`INSERT INTO carbon_calculation_runs
        (run_code, snapshot_schema_version, source_type, status, calculation_method, start_utc,
         end_utc, activity_filter_json, actor_snapshot_json, activity_snapshot_digest,
         activity_count, result_count, calculated_count, factor_missing_count,
         emission_totals_json, created_by, started_at, completed_at, created_at)
        VALUES (@runCode, 1, 'independent_activity', 'completed', 'standard-factor', @startUtc,
          @endUtc, @activityFilterJson, @actorSnapshotJson, @activitySnapshotDigest,
          @activityCount, @resultCount, @calculatedCount, @factorMissingCount,
          @emissionTotalsJson, @createdBy, @startedAt, @completedAt, @createdAt)`)
        .run({
          runCode,
          ...period,
          activityFilterJson: JSON.stringify(activityFilter),
          actorSnapshotJson: JSON.stringify(actorSnapshot),
          activitySnapshotDigest: sha256Json(snapshotDigestInput),
          activityCount: activities.length,
          resultCount: results.length,
          calculatedCount,
          factorMissingCount,
          emissionTotalsJson: JSON.stringify({ version: CARBON_ACCOUNTING_SNAPSHOT_VERSION, totals: emissionTotals }),
          createdBy: actor.userId || null,
          startedAt,
          completedAt,
          createdAt: completedAt
        });
      if (typeof options.faultInjector === 'function') options.faultInjector('before-results', { db, runCode });
      results.forEach((result) => insertCalculationResult(db, insertedRun.lastInsertRowid, result));
      if (typeof options.faultInjector === 'function') options.faultInjector('before-audit', { db, runCode });
      db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, ip, created_at)
        VALUES (?, 'carbon.accounting.run.create', 'carbon_calculation_run', ?, ?, ?, ?)`)
        .run(actor.userId || null, runCode, JSON.stringify({
          version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
          sourceType: CARBON_ACCOUNTING_SOURCE_TYPE,
          startUtc: period.startUtc,
          endUtc: period.endUtc,
          activityCount: activities.length,
          calculatedCount,
          factorMissingCount
        }), actor.ip || null, completedAt);
      return mapCalculationRunRow(db.prepare(`${CALCULATION_RUN_SELECT_SQL} WHERE run.id = ?`)
        .get(insertedRun.lastInsertRowid));
    }).immediate();
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  } finally {
    db.close();
  }
}

/** 分页列出 completed 独立计算运行。 */
function listCarbonCalculationRuns(query = {}) {
  assertCarbonAccountingQueryContract(query, CARBON_ACCOUNTING_RUN_QUERY_FIELDS, '运行历史');
  const pagination = normalizeRunPagination(query);
  const clauses = ["run.source_type = 'independent_activity'", "run.status = 'completed'"];
  const params = {};
  if (hasOwnQueryField(query, 'startUtc')) {
    params.startUtc = normalizeCarbonAccountingUtc(query.startUtc, 'startUtc');
    clauses.push('unixepoch(run.end_utc) > unixepoch(@startUtc)');
  }
  if (hasOwnQueryField(query, 'endUtc')) {
    params.endUtc = normalizeCarbonAccountingUtc(query.endUtc, 'endUtc');
    clauses.push('unixepoch(run.start_utc) < unixepoch(@endUtc)');
  }
  if (params.startUtc && params.endUtc && Date.parse(params.startUtc) >= Date.parse(params.endUtc)) {
    throw badRequest('运行查询期间必须满足 startUtc < endUtc。', {
      code: 'CARBON_ACCOUNTING_RANGE_INVALID'
    });
  }
  const whereSql = `WHERE ${clauses.join(' AND ')}`;
  let db;
  try {
    db = openDatabase();
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
  try {
    invokeCarbonAccountingFaultInjectorForTest('list-runs', { db });
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM carbon_calculation_runs run ${whereSql}`)
      .get(params).total || 0);
    const rows = db.prepare(`${CALCULATION_RUN_SELECT_SQL} ${whereSql}
      ORDER BY run.completed_at DESC, run.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
      .map(mapCalculationRunRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total } };
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  } finally {
    db.close();
  }
}

/** 按稳定 runCode 查询 completed 历史运行。 */
function getCarbonCalculationRun(runCodeValue) {
  const runCode = String(runCodeValue || '').trim();
  if (!runCode || runCode.length > 128) {
    throw badRequest('runCode 格式无效。', { code: 'CARBON_ACCOUNTING_RUN_CODE_INVALID' });
  }
  let db;
  try {
    db = openDatabase();
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  }
  try {
    invokeCarbonAccountingFaultInjectorForTest('get-run', { db, runCode });
    const row = db.prepare(`${CALCULATION_RUN_SELECT_SQL}
      WHERE run.run_code = ? AND run.source_type = 'independent_activity' AND run.status = 'completed'`)
      .get(runCode);
    if (!row) throw notFound('独立碳核算运行不存在。', { runCode });
    return mapCalculationRunRow(row);
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  } finally {
    db.close();
  }
}

module.exports = {
  CARBON_ACCOUNTING_ACTIVITY_LIMIT,
  CARBON_ACCOUNTING_CALCULATION_METHOD,
  CARBON_ACCOUNTING_MISSING_FACTOR_CODE,
  CARBON_ACCOUNTING_MISSING_FACTOR_MESSAGE,
  CARBON_ACCOUNTING_SNAPSHOT_VERSION,
  CARBON_ACCOUNTING_SOURCE_TYPE,
  CALCULATION_ACTIVITY_SELECT_SQL,
  MATCHING_FACTOR_SELECT_SQL,
  assertCarbonAccountingQueryContract,
  calculateEmissionValue,
  createCarbonCalculationRun,
  getCarbonCalculationRun,
  hasOwnQueryField,
  invokeCarbonAccountingFaultInjectorForTest,
  listCarbonCalculationRuns,
  normalizeCarbonAccountingServiceError,
  normalizeCarbonAccountingUtc,
  normalizeCreateRunInput,
  setCarbonAccountingFaultInjectorForTest,
  stableStringify
};
