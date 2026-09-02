'use strict';

// 服务导出壳在依赖加载前固定，阻止循环初始化或 require.cache 替换整体接管内部协议。
const carbonCalculationRunServiceExports = {};
const carbonCalculationRunServiceExportsProxy = new Proxy(carbonCalculationRunServiceExports, {});
Object.defineProperty(module, 'exports', {
  value: carbonCalculationRunServiceExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { types: utilTypes } = require('util');
const databaseModule = require('../db/database');
const { openDatabase } = databaseModule;
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  normalizeCarbonEmissionUnit
} = require('./carbonEmissionUnitContract');
const { requireDemoDatasetRun } = require('./demoRunService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest
} = require('./demoOwnershipService');

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
// 故障作用域只保存在 production 模块私有闭包中，正常 consumer 无法安装或取得 hook。
const CARBON_ACCOUNTING_FAULT_SCOPE = new AsyncLocalStorage();
// exact scope 和 caller capability 的真实绑定只保存在模块私有 WeakMap，JSON clone 永远不能成为能力对象。
const CARBON_EXACT_SCOPE_STATE = new WeakMap();
const CARBON_EXACT_CAPABILITY_STATE = new WeakMap();
const CARBON_CALCULATION_WITNESS_STATE = new WeakMap();
// 内部协议只通过非枚举 Symbol 暴露固定 builder/executor/verifier，不向 route 或普通公共导出开放。
const CARBON_EXACT_INTERNAL_PROTOCOL_SYMBOL = Symbol.for('charcoal.carbonAccounting.exactInternal.v1');
// 原始 SQLite 连接身份由数据库抽象的非枚举内部协议确认，业务服务不直接加载 driver。
const DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.database.rawConnectionInternal.v1');
// 数据库连接内部协议在模块初始化时固定引用，后续不能由普通公开输入替换。
const databaseRawConnectionInternalProtocol =
  databaseModule[DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL];
// exact 输入固定绑定 artifact 11/27 的 primary managed import 和 ownership 实体。
const CARBON_EXACT_ARTIFACT_BINDINGS = Object.freeze([
  Object.freeze({
    artifactKey: '11-carbon-factors',
    entityType: 'carbon_factor',
    importType: 'carbon_factor',
    tableName: 'carbon_factors',
    readProjection: readCarbonExactFactorOwnershipProjection
  }),
  Object.freeze({
    artifactKey: '27-carbon-activities',
    entityType: 'carbon_activity_record',
    importType: 'carbon_activity',
    tableName: 'carbon_activity_records',
    readProjection: readCarbonExactActivityOwnershipProjection
  })
]);

/** 保留已知领域错误，并把 N5-B 未知异常转换为固定、无底层详情的公开错误。 */
function normalizeCarbonAccountingServiceError(error) {
  if (error instanceof AppError) return error;
  return new AppError('CARBON_ACCOUNTING_INTERNAL_ERROR', '独立碳核算服务内部错误。', {
    statusCode: 500,
    details: null
  });
}

/** 在当前异步隔离作用域触发固定测试阶段，hook 只能读取冻结 stage 与空安全摘要。 */
function invokeCarbonAccountingFaultStage(stage) {
  const faultInjector = CARBON_ACCOUNTING_FAULT_SCOPE.getStore();
  if (typeof faultInjector === 'function') {
    faultInjector(Object.freeze({
      stage: String(stage),
      summary: Object.freeze({})
    }));
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

// exact 内部读取沿用正式活动投影，但只接受已经由服务端 ownership scope 固定的单个主键。
const CALCULATION_ACTIVITY_BY_ID_SELECT_SQL = CALCULATION_ACTIVITY_SELECT_SQL.replace(
  /WHERE activity\.source_type[\s\S]*LIMIT @selectionLimit$/,
  'WHERE activity.id = @activityId'
);

/** 从当前连接读取单个完整活动计算投影。 */
function readCalculationActivityByIdWithDb(db, activityId) {
  return db.prepare(CALCULATION_ACTIVITY_BY_ID_SELECT_SQL).get({ activityId }) || null;
}

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

/** 按冻结四级地区/年份规则计算单个因子候选的优先级。 */
function getCarbonFactorMatchPriority(factor, request) {
  if (!factor || Number(factor.isActive) !== 1
    || Number(factor.energyTypeId) !== Number(request.energyTypeId)
    || factor.unit !== request.activityUnit) return null;
  const factorYear = factor.factorYear === null ? null : Number(factor.factorYear);
  if (factor.region === request.requestedRegion && factorYear === request.factorYear) return 1;
  if (factor.region === 'default' && factorYear === request.factorYear) return 2;
  if (factor.region === request.requestedRegion && factorYear === null) return 3;
  if (factor.region === 'default' && factorYear === null) return 4;
  return null;
}

/** 仅在调用方提供的候选集合内执行四级匹配，并以因子 ID 倒序打破同级并列。 */
function selectMatchingCarbonFactor(factors, request) {
  return (Array.isArray(factors) ? factors : [])
    .map((factor) => ({
      ...factor,
      matchPriority: getCarbonFactorMatchPriority(factor, request)
    }))
    .filter((factor) => factor.matchPriority !== null)
    .sort((left, right) => left.matchPriority - right.matchPriority || Number(right.id) - Number(left.id))[0]
    || null;
}

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

/** 规范化匹配因子的正式排放单位，非法历史值以 409 阻断整次运行。 */
function normalizeMatchedCarbonFactor(factor) {
  if (!factor) return null;
  const normalizedUnit = normalizeCarbonEmissionUnit(factor.factorUnit);
  if (!normalizedUnit.ok) {
    throw new AppError('CARBON_FACTOR_UNIT_INVALID', '已持久化碳因子的排放单位不符合正式合同。', {
      statusCode: 409,
      details: Number.isSafeInteger(Number(factor.id)) ? { factorId: Number(factor.id) } : null
    });
  }
  return { ...factor, factorUnit: normalizedUnit.value };
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

/** 使用正式宽范围 SQL 读取候选，并复用共享纯匹配器确认最终优先级。 */
function selectMatchingCarbonFactorWithDb(db, request) {
  const candidate = db.prepare(MATCHING_FACTOR_SELECT_SQL).get(request) || null;
  return selectMatchingCarbonFactor(candidate ? [candidate] : [], request);
}

/** 为单条活动生成不可变结果写入参数。 */
function buildCalculationResult(db, activity, options = {}) {
  const factorYear = extractFactorYear(activity);
  const requestedRegion = String(activity.factorRegion || '').trim() || 'default';
  const factorRequest = {
    requestedRegion,
    factorYear,
    energyTypeId: Number(activity.energyTypeId),
    activityUnit: activity.activityUnit
  };
  const selectedFactor = typeof options.factorSelector === 'function'
    ? options.factorSelector(factorRequest)
    : selectMatchingCarbonFactorWithDb(db, factorRequest);
  const factor = normalizeMatchedCarbonFactor(selectedFactor);
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
    emissionUnit: factor?.factorUnit || null,
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
  const insertedResult = db.prepare(`INSERT INTO carbon_accounting_results
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
      factorUnit: result.emissionUnit,
      emissionValue: result.emissionValue,
      emissionUnit: result.emissionUnit,
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
  return Number(insertedResult.lastInsertRowid);
}

/** 按排放单位形成互不合并的运行总计。 */
function buildEmissionTotals(results) {
  const totalsByUnit = new Map();
  results.filter((result) => result.status === 'calculated').forEach((result) => {
    const emissionUnit = result.emissionUnit;
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

/** 对正式舍入结果与排放汇总生成不包含内部实体标识的私有预演摘要。 */
function buildCarbonExactPreviewPrivateDigest(privateScopeDigest, results, emissionTotals) {
  return sha256Json({
    version: 1,
    privateScopeDigest,
    results: results.map((result) => ({
      status: result.status,
      emissionValue: result.emissionValue,
      emissionUnit: result.emissionUnit,
      missingReason: result.missingReason,
      matchPriority: result.matchPriority
    })),
    emissionTotals: {
      version: 1,
      totals: emissionTotals
    }
  });
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

/** 在当前连接和事务边界内写入一条完整核算运行，不管理连接或事务生命周期。 */
function executeCarbonCalculationRunWithDb(input) {
  const {
    db,
    period,
    activities,
    actor,
    activityFilter,
    factorSelector,
    startedAt,
    faultStagePrefix
  } = input;
  const completedAt = new Date().toISOString();
  const results = activities.map((activity) => ({
    ...buildCalculationResult(db, activity, { factorSelector }),
    createdAt: completedAt
  }));
  const calculatedCount = results.filter((result) => result.status === 'calculated').length;
  const factorMissingCount = results.length - calculatedCount;
  const emissionTotals = buildEmissionTotals(results);
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
  const activitySnapshotDigest = sha256Json(snapshotDigestInput);
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
      activitySnapshotDigest,
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
  const calculationRunId = Number(insertedRun.lastInsertRowid);
  invokeCarbonAccountingFaultStage(`${faultStagePrefix ? `${faultStagePrefix}-` : ''}before-results`);
  const resultIds = results.map((result) => insertCalculationResult(db, calculationRunId, result));
  invokeCarbonAccountingFaultStage(`${faultStagePrefix ? `${faultStagePrefix}-` : ''}before-audit`);
  const insertedAudit = db.prepare(`INSERT INTO sys_operation_logs
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
  const run = mapCalculationRunRow(db.prepare(`${CALCULATION_RUN_SELECT_SQL} WHERE run.id = ?`)
    .get(calculationRunId));
  return {
    run,
    facts: Object.freeze({
      calculationRunId,
      runCode,
      resultIds: Object.freeze(resultIds),
      activityRecordIds: Object.freeze(results.map((result) => Number(result.activity.id))),
      selectedFactorIds: Object.freeze(results.map((result) => (
        result.factor ? Number(result.factor.id) : null
      ))),
      operationLogId: Number(insertedAudit.lastInsertRowid),
      activitySnapshotDigest
    })
  };
}

/** 创建一条追加式独立碳活动计算运行，并在 immediate 事务中写结果和成功审计。 */
function createCarbonCalculationRun(input = {}, actor = {}) {
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
      invokeCarbonAccountingFaultStage('create-run');
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
      const activityFilter = {
        version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
        sourceType: CARBON_ACCOUNTING_SOURCE_TYPE,
        recordStatus: 'active',
        interval: { ...period, semantics: '[startUtc,endUtc)', positiveOverlapOnly: true },
        usesFullActivityValue: true,
        overlapProration: false,
        maxActivities: CARBON_ACCOUNTING_ACTIVITY_LIMIT
      };
      return executeCarbonCalculationRunWithDb({
        db,
        period,
        activities,
        actor,
        activityFilter,
        startedAt,
        faultStagePrefix: null
      }).run;
    }).immediate();
  } catch (error) {
    throw normalizeCarbonAccountingServiceError(error);
  } finally {
    db.close();
  }
}

/** 构造 exact 内部协议错误，固定使用 409 阻断陈旧或伪造能力。 */
function createCarbonExactError(code, message, details = null, statusCode = 409) {
  return new AppError(code, message, { statusCode, details });
}

/** 校验 exact 内部协议对象只能包含固定自有字段。 */
function assertCarbonExactProtocolFields(value, expectedFields, code, message) {
  // Proxy、非普通对象、访问器和 Symbol 字段必须在读取任何业务值前拒绝。
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createCarbonExactError(code, message, null, 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualFields = Object.keys(descriptors).sort();
  const normalizedExpectedFields = [...expectedFields].sort();
  const hasAccessor = actualFields.some((fieldName) => (
    typeof descriptors[fieldName].get === 'function' || typeof descriptors[fieldName].set === 'function'
  ));
  const hasSymbolFields = Object.getOwnPropertySymbols(value).length > 0;
  if (hasAccessor || hasSymbolFields || actualFields.length !== normalizedExpectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== normalizedExpectedFields[index])) {
    throw createCarbonExactError(code, message, {
      expectedFields: normalizedExpectedFields,
      actualFields,
      hasAccessor,
      hasSymbolFields
    }, 400);
  }
  return Object.fromEntries(actualFields.map((fieldName) => [fieldName, descriptors[fieldName].value]));
}

/** 确认 exact 调用使用原始、已打开的 better-sqlite3 连接对象。 */
function assertRawCarbonExactDatabase(db) {
  const isRawDatabase = databaseRawConnectionInternalProtocol
    && typeof databaseRawConnectionInternalProtocol.isOpenRawDatabaseConnection === 'function'
    && databaseRawConnectionInternalProtocol.isOpenRawDatabaseConnection(db);
  if (!isRawDatabase) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_DATABASE_REQUIRED',
      'exact 核算必须使用原始且已打开的 better-sqlite3 连接。',
      null,
      500
    );
  }
  return db;
}

/** 对 witness 和 exact state 私有快照执行递归冻结。 */
function freezeCarbonExactSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCarbonExactSnapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, freezeCarbonExactSnapshot(item)]
    ))));
  }
  return value;
}

/** 为 caller-owned exact 能力生成不含调用方输入的私有 SAVEPOINT 名称。 */
function createCarbonExactSavepointName(purpose) {
  return `carbon_accounting_${purpose}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 私有 SAVEPOINT 恢复异常时完整回滚，完整回滚仍失败则关闭连接。 */
function failClosedCarbonExactTransaction(db, stagePrefix) {
  let fullRollbackError = null;
  let closeError = null;
  try {
    invokeCarbonAccountingFaultStage(`${stagePrefix}-before-full-rollback`);
    if (db.inTransaction === true) db.exec('ROLLBACK');
  } catch (error) {
    fullRollbackError = error;
  }
  if (fullRollbackError) {
    try {
      db.close();
    } catch (error) {
      closeError = error;
    }
  }
  return { fullRollbackError, closeError };
}

/** 回滚 exact 私有 SAVEPOINT；ROLLBACK TO 成功后才允许 RELEASE，失败时完整回滚或关闭。 */
function recoverCarbonExactSavepoint(db, savepointName, stagePrefix) {
  let rollbackError = null;
  let releaseError = null;
  try {
    invokeCarbonAccountingFaultStage(`${stagePrefix}-before-recovery-rollback`);
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } catch (error) {
    rollbackError = error;
  }
  if (!rollbackError) {
    try {
      invokeCarbonAccountingFaultStage(`${stagePrefix}-before-recovery-release`);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (error) {
      releaseError = error;
    }
  }
  const failClosed = rollbackError || releaseError
    ? failClosedCarbonExactTransaction(db, stagePrefix)
    : { fullRollbackError: null, closeError: null };
  return { rollbackError, releaseError, ...failClosed };
}

/** 构造不泄露底层异常消息的 witness SAVEPOINT 恢复失败错误。 */
function createCarbonCalculationWitnessRecoveryError(originalError, recovery) {
  return createCarbonExactError(
    'CARBON_ACCOUNTING_CALCULATION_WITNESS_RECOVERY_FAILED',
    'calculation witness 私有 SAVEPOINT 恢复失败，禁止继续提交 caller transaction。',
    {
      originalCode: originalError?.code || originalError?.details?.code || null,
      rollbackCode: recovery.rollbackError?.code || null,
      releaseCode: recovery.releaseError?.code || null,
      fullRollbackCode: recovery.fullRollbackError?.code || null,
      closeCode: recovery.closeError?.code || null
    },
    500
  );
}

/** 构造不泄露底层异常消息的 executor SAVEPOINT 恢复失败错误。 */
function createCarbonExactExecutorRecoveryError(originalError, recovery) {
  return createCarbonExactError(
    'CARBON_ACCOUNTING_EXACT_EXECUTOR_RECOVERY_FAILED',
    'exact 核算 executor 私有 SAVEPOINT 恢复失败，禁止继续提交 caller transaction。',
    {
      originalCode: originalError?.code || originalError?.details?.code || null,
      rollbackCode: recovery.rollbackError?.code || null,
      releaseCode: recovery.releaseError?.code || null,
      fullRollbackCode: recovery.fullRollbackError?.code || null,
      closeCode: recovery.closeError?.code || null
    },
    500
  );
}

/** 校验调用方原始 demo run 对象与当前正式持久化 run 完全一致。 */
function requireBoundCarbonExactDemoRun(db, demoRun) {
  if (!demoRun || typeof demoRun !== 'object' || Array.isArray(demoRun)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_DEMO_RUN_REQUIRED',
      'exact 核算必须绑定服务端读取的原始 demo run 对象。',
      null,
      400
    );
  }
  const persisted = requireDemoDatasetRun(db, demoRun.runId);
  if (!['active', 'completed'].includes(persisted.status)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_DEMO_RUN_NOT_WRITABLE',
      '当前 demo run 不具备 exact 核算写入资格。',
      { runId: persisted.runId, status: persisted.status }
    );
  }
  const bindingFields = ['runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status'];
  if (bindingFields.some((fieldName) => demoRun[fieldName] !== persisted[fieldName])) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_DEMO_RUN_MISMATCH',
      'exact 核算 demo run 对象与当前持久化事实不一致。',
      { runId: persisted.runId }
    );
  }
  return persisted;
}

/** 从服务端用户事实规范化 exact actor 快照，并保留原始 actor 对象身份用于能力绑定。 */
function readBoundCarbonExactActor(db, actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
    || !Number.isSafeInteger(actor.userId) || actor.userId <= 0) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_ACTOR_REQUIRED',
      'exact 核算必须绑定有效的服务端 actor 对象。',
      null,
      400
    );
  }
  const user = db.prepare(`SELECT id, username, display_name AS displayName, status
    FROM sys_users WHERE id = ?`).get(actor.userId);
  if (!user || user.status !== 'active') {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_ACTOR_INVALID',
      'exact 核算 actor 不存在或当前不可用。',
      { userId: actor.userId }
    );
  }
  if ((actor.username !== undefined && actor.username !== null && actor.username !== user.username)
    || (actor.displayName !== undefined && actor.displayName !== null
      && actor.displayName !== user.displayName)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_ACTOR_MISMATCH',
      'exact 核算 actor 对象与当前服务端用户事实不一致。',
      { userId: actor.userId }
    );
  }
  return freezeCarbonExactSnapshot({
    userId: Number(user.id),
    username: user.username,
    displayName: user.displayName,
    ip: actor.ip || null
  });
}

/** 读取并严格校验 artifact primary batch、context 与正式导入审计绑定。 */
function readCarbonExactArtifactBatch(db, run, definition) {
  const rows = db.prepare(`SELECT link.import_batch_id AS importBatchId,
      link.context_id AS contextId, link.batch_role AS batchRole,
      context.status AS contextStatus, context.run_id AS contextRunId,
      context.dataset_id AS contextDatasetId,
      context.manifest_version AS contextManifestVersion,
      context.manifest_digest AS contextManifestDigest,
      batch.import_type AS importType, batch.status AS batchStatus,
      batch.audit_phase AS auditPhase
    FROM demo_run_import_batches link
    JOIN demo_import_contexts context ON context.context_id = link.context_id
      AND context.run_id = link.run_id AND context.artifact_key = link.artifact_key
    JOIN import_batches batch ON batch.id = link.import_batch_id
    WHERE link.run_id = ? AND link.artifact_key = ? AND link.batch_role = 'primary'
    ORDER BY link.import_batch_id`).all(run.runId, definition.artifactKey);
  if (rows.length !== 1) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_BATCH_MISMATCH',
      'exact 核算 artifact 必须且只能绑定一个 primary 导入批次。',
      { artifactKey: definition.artifactKey, bindingCount: rows.length }
    );
  }
  const row = rows[0];
  const validStatus = ['completed', 'completed_with_errors'].includes(row.batchStatus);
  if (row.batchRole !== 'primary' || row.importType !== definition.importType
    || row.auditPhase !== 'execute' || !validStatus || row.contextStatus !== 'executed'
    || row.contextRunId !== run.runId || row.contextDatasetId !== run.datasetId
    || row.contextManifestVersion !== run.manifestVersion
    || row.contextManifestDigest !== run.manifestDigest) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_BATCH_MISMATCH',
      'exact 核算 artifact 导入批次、context 或 manifest 绑定不兼容。',
      { artifactKey: definition.artifactKey }
    );
  }
  return freezeCarbonExactSnapshot({
    artifactKey: definition.artifactKey,
    entityType: definition.entityType,
    importType: definition.importType,
    importBatchId: Number(row.importBatchId),
    contextId: row.contextId
  });
}

/** 读取 artifact 11 因子的 ownership canonical projection。 */
function readCarbonExactFactorOwnershipProjection(db, entityPk) {
  return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_type_id,
      region, factor_year, unit, factor_value, factor_unit, source, source_url,
      effective_from, effective_to, is_active, created_at, updated_at
    FROM carbon_factors WHERE id = ?`).get(entityPk) || null;
}

/** 读取 artifact 27 活动的 ownership canonical projection。 */
function readCarbonExactActivityOwnershipProjection(db, entityPk) {
  return db.prepare(`SELECT id, source_type, source_batch_id, source_row_number, energy_record_id,
      activity_code, activity_code_key, supersedes_activity_id, superseded_by_activity_id,
      emission_scope, activity_category, activity_category_key, organization_unit_id,
      energy_type_id, start_wall_clock, end_wall_clock, source_timezone, start_utc, end_utc,
      activity_value, activity_unit, factor_region, source_reference, evidence_reference,
      note, duplicate_key, record_status, void_reason, voided_at, voided_by, created_by,
      created_at, updated_at
    FROM carbon_activity_records WHERE id = ?`).get(entityPk) || null;
}

/** 比较两个正整数主键集合是否完全一致。 */
function areCarbonExactEntitySetsEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/** 读取并双向校验单个 artifact 的 active imported ownership 与业务表集合。 */
function readCarbonExactArtifactOwnership(db, run, definition, batch) {
  const registryRows = db.prepare(`SELECT registry_id AS registryId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND cleaned_at IS NULL
    ORDER BY CAST(entity_pk AS INTEGER), registry_id`).all(run.runId, definition.artifactKey);
  if (registryRows.some((row) => row.entityType !== definition.entityType
    || row.ownershipKind !== 'imported')) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_OWNERSHIP_MISMATCH',
      'exact 核算只接受固定 artifact 的 active imported ownership。',
      { artifactKey: definition.artifactKey }
    );
  }
  const businessRows = db.prepare(`SELECT id, source_row_number AS sourceRowNumber
    FROM ${definition.tableName} WHERE source_batch_id = ? ORDER BY id`).all(batch.importBatchId);
  const businessIds = businessRows.map((row) => Number(row.id)).sort((left, right) => left - right);
  const registryIds = registryRows.map((row) => {
    const entityPk = Number(row.entityPk);
    if (!Number.isSafeInteger(entityPk) || entityPk <= 0) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_OWNERSHIP_MISMATCH',
        'exact 核算 ownership 主键不是正安全整数。',
        { artifactKey: definition.artifactKey }
      );
    }
    return entityPk;
  }).sort((left, right) => left - right);
  if (!areCarbonExactEntitySetsEqual(registryIds, businessIds)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_BUSINESS_SET_MISMATCH',
      'exact 核算 ownership 与来源批次业务表集合不满足双向相等。',
      { artifactKey: definition.artifactKey }
    );
  }
  const businessRowById = new Map(businessRows.map((row) => [Number(row.id), row]));
  return freezeCarbonExactSnapshot(registryRows.map((row) => {
    const entityPk = Number(row.entityPk);
    const projection = definition.readProjection(db, entityPk);
    const businessRow = businessRowById.get(entityPk);
    if (!projection || Number(row.sourceBatchId) !== batch.importBatchId
      || Number(projection.source_batch_id) !== batch.importBatchId
      || !Number.isSafeInteger(Number(row.sourceRowNumber))
      || Number(row.sourceRowNumber) !== Number(projection.source_row_number)
      || Number(row.sourceRowNumber) !== Number(businessRow?.sourceRowNumber)) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_BATCH_MISMATCH',
        'exact 核算 ownership、来源批次和来源行号不一致。',
        { artifactKey: definition.artifactKey, entityPk }
      );
    }
    if (row.identityDigest !== calculateDemoEntityIdentityDigest(definition.entityType, String(entityPk))) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_IDENTITY_DIGEST_MISMATCH',
        'exact 核算 ownership identity digest 不一致。',
        { artifactKey: definition.artifactKey, entityPk }
      );
    }
    if (row.snapshotDigest !== calculateDemoEntitySnapshotDigest(
      definition.entityType,
      String(entityPk),
      projection
    )) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_SNAPSHOT_DIGEST_MISMATCH',
        'exact 核算 ownership snapshot digest 不一致。',
        { artifactKey: definition.artifactKey, entityPk }
      );
    }
    if (definition.entityType === 'carbon_activity_record'
      && (projection.source_type !== CARBON_ACCOUNTING_SOURCE_TYPE
        || projection.record_status !== 'active'
        || projection.energy_record_id !== null)) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_ACTIVITY_INCOMPATIBLE',
        'exact 核算活动必须是 active independent_activity。',
        { entityPk }
      );
    }
    return {
      registryId: Number(row.registryId),
      entityPk,
      sourceBatchId: Number(row.sourceBatchId),
      sourceRowNumber: Number(row.sourceRowNumber),
      identityDigest: row.identityDigest,
      snapshotDigest: row.snapshotDigest,
      projection
    };
  }));
}

/** 从活动事实服务端派生 exact 运行时间窗，禁止接收客户端期间。 */
function deriveCarbonExactPeriod(activityOwnership) {
  if (activityOwnership.length < 1 || activityOwnership.length > CARBON_ACCOUNTING_ACTIVITY_LIMIT) {
    throw new AppError(
      activityOwnership.length < 1
        ? 'CARBON_ACCOUNTING_EXACT_ACTIVITY_REQUIRED'
        : 'CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED',
      activityOwnership.length < 1
        ? 'exact 核算至少需要一条 active independent_activity。'
        : 'exact 核算活动超过单次运行上限。',
      {
        statusCode: 422,
        details: { minActivities: 1, maxActivities: CARBON_ACCOUNTING_ACTIVITY_LIMIT }
      }
    );
  }
  const starts = activityOwnership.map((item) => item.projection.start_utc)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const ends = activityOwnership.map((item) => item.projection.end_utc)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return freezeCarbonExactSnapshot({
    startUtc: normalizeCarbonAccountingUtc(starts[0], 'derivedStartUtc'),
    endUtc: normalizeCarbonAccountingUtc(ends[0], 'derivedEndUtc')
  });
}

/** 读取并冻结当前 demo run 的完整 exact ownership state。 */
function readCarbonExactScopeState(db, demoRun) {
  const run = requireBoundCarbonExactDemoRun(db, demoRun);
  const bindings = CARBON_EXACT_ARTIFACT_BINDINGS.map((definition) => (
    readCarbonExactArtifactBatch(db, run, definition)
  ));
  const factorOwnership = readCarbonExactArtifactOwnership(
    db,
    run,
    CARBON_EXACT_ARTIFACT_BINDINGS[0],
    bindings[0]
  );
  const activityOwnership = readCarbonExactArtifactOwnership(
    db,
    run,
    CARBON_EXACT_ARTIFACT_BINDINGS[1],
    bindings[1]
  );
  const calculationActivities = readCarbonExactCalculationActivities(db, activityOwnership);
  const period = deriveCarbonExactPeriod(activityOwnership);
  const digestInput = {
    version: 2,
    run,
    bindings,
    factors: factorOwnership.map((item) => ({
      entityPk: item.entityPk,
      sourceBatchId: item.sourceBatchId,
      sourceRowNumber: item.sourceRowNumber,
      identityDigest: item.identityDigest,
      snapshotDigest: item.snapshotDigest
    })),
    activities: activityOwnership.map((item) => ({
      entityPk: item.entityPk,
      sourceBatchId: item.sourceBatchId,
      sourceRowNumber: item.sourceRowNumber,
      identityDigest: item.identityDigest,
      snapshotDigest: item.snapshotDigest
    })),
    // calculationActivities 是正式结果快照实际消费的完整 joined canonical projection。
    // 将组织与能源类型引用事实一并纳入 digest，避免仅活动 ownership 未变化时漏判 stale。
    calculationActivities,
    period
  };
  return freezeCarbonExactSnapshot({
    run,
    bindings,
    factorOwnership,
    activityOwnership,
    calculationActivities,
    period,
    scopeDigest: sha256Json(digestInput)
  });
}

/** 将 ownership 碳因子 projection 映射为共享计算器使用的冻结候选。 */
function mapCarbonExactFactorCandidate(item) {
  const factor = item.projection;
  return freezeCarbonExactSnapshot({
    id: Number(factor.id),
    sourceBatchId: Number(factor.source_batch_id),
    sourceRowNumber: Number(factor.source_row_number),
    energyTypeId: Number(factor.energy_type_id),
    region: factor.region,
    factorYear: factor.factor_year === null ? null : Number(factor.factor_year),
    unit: factor.unit,
    factorValue: Number(factor.factor_value),
    factorUnit: factor.factor_unit,
    source: factor.source,
    sourceUrl: factor.source_url,
    effectiveFrom: factor.effective_from,
    effectiveTo: factor.effective_to,
    isActive: Number(factor.is_active),
    createdAt: factor.created_at,
    updatedAt: factor.updated_at
  });
}

/** 按 exact ownership 主键读取完整活动、组织和能源类型投影。 */
function readCarbonExactCalculationActivities(db, activityOwnership) {
  const statement = db.prepare(CALCULATION_ACTIVITY_BY_ID_SELECT_SQL);
  return activityOwnership.map((item) => {
    const activity = statement.get({ activityId: item.entityPk }) || null;
    if (!activity || activity.sourceType !== CARBON_ACCOUNTING_SOURCE_TYPE
      || activity.recordStatus !== 'active') {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_ACTIVITY_SET_MISMATCH',
        'exact 核算活动完整投影与 ownership 集合不一致。',
        { activityRecordId: item.entityPk }
      );
    }
    return activity;
  }).sort((left, right) => (
    Date.parse(left.startUtc) - Date.parse(right.startUtc) || Number(left.id) - Number(right.id)
  ));
}

/** 在 caller-owned transaction 内执行 exact 只读预演，不签发任何 capability 或治理见证。 */
function previewCarbonCalculationExactInCallerTransaction(input = {}) {
  assertCarbonExactProtocolFields(
    input,
    ['db', 'demoRun', 'actor'],
    'CARBON_ACCOUNTING_EXACT_PREVIEW_INPUT_INVALID',
    'exact 核算预演只接受 db、demoRun 和 actor。'
  );
  const db = assertRawCarbonExactDatabase(input.db);
  if (db.inTransaction !== true) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_CALLER_TRANSACTION_REQUIRED',
      'exact 核算预演必须在调用方已有事务或 SAVEPOINT 中运行。',
      null,
      500
    );
  }
  const exactState = readCarbonExactScopeState(db, input.demoRun);
  readBoundCarbonExactActor(db, input.actor);
  const activities = exactState.calculationActivities;
  const exactFactors = exactState.factorOwnership.map(mapCarbonExactFactorCandidate);
  const results = activities.map((activity) => buildCalculationResult(db, activity, {
    factorSelector: (request) => selectMatchingCarbonFactor(exactFactors, request)
  }));
  const calculatedCount = results.filter((result) => result.status === 'calculated').length;
  const factorMissingCount = results.length - calculatedCount;
  // 私有摘要绑定正式六位舍入结果和排放汇总，但不包含因子、实体、批次或 context 标识。
  const emissionTotals = buildEmissionTotals(results);
  const privateDigest = buildCarbonExactPreviewPrivateDigest(
    exactState.scopeDigest,
    results,
    emissionTotals
  );
  const dependencies = factorMissingCount > 0
    ? [{
        code: CARBON_ACCOUNTING_MISSING_FACTOR_CODE,
        blocking: false,
        count: factorMissingCount
      }]
    : [];
  return freezeCarbonExactSnapshot({
    privateScopeDigest: exactState.scopeDigest,
    privateDigest,
    summary: {
      sources: exactState.bindings.map((binding) => binding.artifactKey),
      scope: {
        startUtc: exactState.period.startUtc,
        endUtc: exactState.period.endUtc,
        activityCount: activities.length,
        factorCount: exactFactors.length
      },
      expectedRunCount: 1,
      expectedResultCount: results.length,
      expectedOutputCount: results.length + 1,
      calculatedCount,
      factorMissingCount,
      dependencies
    }
  });
}

/** 构造 caller-owned exact scope 与一次性 capability，所有实体集合均由服务端 ownership 推导。 */
function buildCarbonCalculationExactScopeInCallerTransaction(input = {}) {
  assertCarbonExactProtocolFields(
    input,
    ['db', 'demoRun', 'actor'],
    'CARBON_ACCOUNTING_EXACT_BUILDER_INPUT_INVALID',
    'exact 核算 builder 只接受 db、demoRun 和 actor。'
  );
  const db = assertRawCarbonExactDatabase(input.db);
  if (db.inTransaction !== true) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_CALLER_TRANSACTION_REQUIRED',
      'exact 核算 builder 必须在调用方已有事务或 SAVEPOINT 中运行。',
      null,
      500
    );
  }
  const exactState = readCarbonExactScopeState(db, input.demoRun);
  const normalizedActor = readBoundCarbonExactActor(db, input.actor);
  const exactScope = Object.freeze({});
  const exactCapability = Object.freeze({});
  const transactionSavepoint = createCarbonExactSavepointName('capability');
  db.exec(`SAVEPOINT ${transactionSavepoint}`);
  CARBON_EXACT_SCOPE_STATE.set(exactScope, {
    db,
    demoRun: input.demoRun,
    actor: input.actor,
    normalizedActor,
    exactState
  });
  CARBON_EXACT_CAPABILITY_STATE.set(exactCapability, {
    db,
    demoRun: input.demoRun,
    actor: input.actor,
    exactScope,
    transactionSavepoint,
    status: 'issued'
  });
  return Object.freeze({ exactScope, exactCapability });
}

/** 在任何业务查询前验证原始 exact scope/capability/run/actor/DB 对象身份。 */
function requireCarbonCalculationExactCapability(input) {
  assertCarbonExactProtocolFields(
    input,
    ['db', 'demoRun', 'actor', 'exactScope', 'exactCapability'],
    'CARBON_ACCOUNTING_EXACT_EXECUTOR_INPUT_INVALID',
    'exact 核算 executor 只接受固定 caller-owned 协议字段。'
  );
  const db = assertRawCarbonExactDatabase(input.db);
  const capabilityState = input.exactCapability && typeof input.exactCapability === 'object'
    ? CARBON_EXACT_CAPABILITY_STATE.get(input.exactCapability)
    : null;
  const scopeState = input.exactScope && typeof input.exactScope === 'object'
    ? CARBON_EXACT_SCOPE_STATE.get(input.exactScope)
    : null;
  if (!capabilityState || !scopeState) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_CAPABILITY_REQUIRED',
      'exact 核算必须使用服务端 builder 生成的原始 scope 与 capability。',
      null,
      400
    );
  }
  if (capabilityState.status !== 'issued') {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_CAPABILITY_REPLAY',
      'exact 核算 capability 已被领取或失效。'
    );
  }
  if (capabilityState.db !== db || scopeState.db !== db) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_DATABASE_MISMATCH',
      'exact 核算 capability 与当前 SQLite 连接对象身份不一致。'
    );
  }
  if (capabilityState.exactScope !== input.exactScope
    || capabilityState.demoRun !== input.demoRun || scopeState.demoRun !== input.demoRun
    || capabilityState.actor !== input.actor || scopeState.actor !== input.actor) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_BINDING_MISMATCH',
      'exact 核算 capability 与 exact scope、demo run 或 actor 对象身份不一致。'
    );
  }
  if (db.inTransaction !== true) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_CALLER_TRANSACTION_REQUIRED',
      'exact 核算 executor 必须在 builder 所属 caller transaction 中运行。',
      null,
      500
    );
  }
  capabilityState.status = 'claimed';
  try {
    // RELEASE 只验证并关闭 builder 私有 marker，不提交或结束调用方外层事务。
    db.exec(`RELEASE SAVEPOINT ${capabilityState.transactionSavepoint}`);
  } catch (_error) {
    capabilityState.status = 'failed';
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_EXACT_TRANSACTION_MISMATCH',
      'exact 核算 capability 不属于当前 caller transaction。'
    );
  }
  return { db, capabilityState, scopeState };
}

/** 读取 calculation witness 需要冻结的 run/result/audit 持久事实。 */
function readCarbonCalculationWitnessFacts(db, executionFacts, exactState) {
  const run = db.prepare(`SELECT id, run_code AS runCode, start_utc AS startUtc, end_utc AS endUtc,
      activity_snapshot_digest AS activitySnapshotDigest, activity_count AS activityCount,
      result_count AS resultCount, calculated_count AS calculatedCount,
      factor_missing_count AS factorMissingCount, created_by AS createdBy,
      started_at AS startedAt, completed_at AS completedAt, created_at AS createdAt
    FROM carbon_calculation_runs WHERE id = ?`).get(executionFacts.calculationRunId);
  const results = db.prepare(`SELECT id, calculation_run_id AS calculationRunId,
      activity_record_id AS activityRecordId, carbon_factor_id AS carbonFactorId,
      status, emission_value AS emissionValue, emission_unit AS emissionUnit,
      match_priority AS matchPriority, created_at AS createdAt
    FROM carbon_accounting_results WHERE calculation_run_id = ? ORDER BY id`)
    .all(executionFacts.calculationRunId);
  const audit = db.prepare(`SELECT id, user_id AS userId, operation, target_type AS targetType,
      target_id AS targetId, detail_json AS detailJson, ip, created_at AS createdAt
    FROM sys_operation_logs WHERE id = ?`).get(executionFacts.operationLogId);
  if (!run || !audit || results.length !== Number(run.resultCount)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_INCOMPLETE',
      'exact 核算完成事实不足以生成 calculation witness。',
      null,
      500
    );
  }
  return freezeCarbonExactSnapshot({
    version: 1,
    demoRunId: exactState.run.runId,
    exactScopeDigest: exactState.scopeDigest,
    exactActivityRecordIds: exactState.activityOwnership.map((item) => item.entityPk),
    exactFactorIds: exactState.factorOwnership.map((item) => item.entityPk),
    run: {
      ...run,
      id: Number(run.id),
      activityCount: Number(run.activityCount),
      resultCount: Number(run.resultCount),
      calculatedCount: Number(run.calculatedCount),
      factorMissingCount: Number(run.factorMissingCount),
      createdBy: run.createdBy === null ? null : Number(run.createdBy)
    },
    results: results.map((result) => ({
      ...result,
      id: Number(result.id),
      calculationRunId: Number(result.calculationRunId),
      activityRecordId: Number(result.activityRecordId),
      carbonFactorId: result.carbonFactorId === null ? null : Number(result.carbonFactorId),
      emissionValue: result.emissionValue === null ? null : Number(result.emissionValue),
      matchPriority: result.matchPriority === null ? null : Number(result.matchPriority)
    })),
    audit: {
      ...audit,
      id: Number(audit.id),
      userId: audit.userId === null ? null : Number(audit.userId)
    }
  });
}

/** 在调用方已有事务内执行 exact 计算；仅使用 scope 内活动和因子且不管理外层事务或连接。 */
function executeCarbonCalculationExactInCallerTransaction(input = {}) {
  const controlled = requireCarbonCalculationExactCapability(input);
  const { db, capabilityState, scopeState } = controlled;
  let recoverySavepoint = null;
  let recoverySavepointActive = false;
  try {
    const currentState = readCarbonExactScopeState(db, input.demoRun);
    if (currentState.scopeDigest !== scopeState.exactState.scopeDigest) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_EXACT_SCOPE_STALE',
        'exact 核算 ownership、batch、digest 或业务集合已变化。'
      );
    }
    const activities = currentState.calculationActivities;
    const exactFactors = currentState.factorOwnership.map(mapCarbonExactFactorCandidate);
    const activityFilter = {
      version: CARBON_ACCOUNTING_SNAPSHOT_VERSION,
      sourceType: CARBON_ACCOUNTING_SOURCE_TYPE,
      recordStatus: 'active',
      interval: {
        ...currentState.period,
        semantics: 'server-derived-exact-activity-bounds',
        positiveOverlapOnly: false
      },
      selectionMode: 'server-owned-exact-demo-scope',
      usesFullActivityValue: true,
      overlapProration: false,
      maxActivities: CARBON_ACCOUNTING_ACTIVITY_LIMIT
    };
    recoverySavepoint = createCarbonExactSavepointName('recovery');
    db.exec(`SAVEPOINT ${recoverySavepoint}`);
    recoverySavepointActive = true;
    invokeCarbonAccountingFaultStage('exact-create-run');
    const execution = executeCarbonCalculationRunWithDb({
      db,
      period: currentState.period,
      activities,
      actor: scopeState.normalizedActor,
      activityFilter,
      factorSelector: (request) => selectMatchingCarbonFactor(exactFactors, request),
      startedAt: new Date().toISOString(),
      faultStagePrefix: 'exact'
    });
    const witnessFacts = readCarbonCalculationWitnessFacts(db, execution.facts, currentState);
    // 内层 marker 只识别原 caller transaction；外层 recovery SAVEPOINT 在 verifier 成功前持续保护业务写入。
    const transactionMarkerSavepoint = createCarbonExactSavepointName('witness_marker');
    db.exec(`SAVEPOINT ${transactionMarkerSavepoint}`);
    const calculationWitness = Object.freeze({});
    CARBON_CALCULATION_WITNESS_STATE.set(calculationWitness, {
      db,
      demoRun: input.demoRun,
      actor: input.actor,
      exactScope: input.exactScope,
      recoverySavepoint,
      transactionMarkerSavepoint,
      facts: witnessFacts,
      factsDigest: sha256Json(witnessFacts),
      status: 'issued'
    });
    // executor 成功后仍保留双层 SAVEPOINT，只有同事务 verifier 成功才释放外层恢复边界。
    recoverySavepointActive = false;
    capabilityState.status = 'completed';
    return Object.freeze({
      calculationRun: execution.run,
      calculationWitness
    });
  } catch (error) {
    capabilityState.status = 'failed';
    if (recoverySavepointActive) {
      const recovery = db.inTransaction === true
        ? recoverCarbonExactSavepoint(db, recoverySavepoint, 'exact-executor')
        : {
            rollbackError: createCarbonExactError(
              'CARBON_ACCOUNTING_EXACT_CALLER_TRANSACTION_REQUIRED',
              'exact 核算 executor 恢复边界已离开 caller transaction。'
            ),
            releaseError: null,
            ...failClosedCarbonExactTransaction(db, 'exact-executor')
          };
      recoverySavepointActive = false;
      if (recovery.rollbackError || recovery.releaseError
        || recovery.fullRollbackError || recovery.closeError) {
        throw createCarbonExactExecutorRecoveryError(error, recovery);
      }
    }
    throw normalizeCarbonAccountingServiceError(error);
  }
}

/** 验证并一次性消费 calculation witness，供下一阶段 registrar 复核而不执行任何 ownership 写入。 */
function consumeCarbonCalculationWitnessInCallerTransaction(input = {}) {
  assertCarbonExactProtocolFields(
    input,
    ['db', 'demoRun', 'actor', 'exactScope', 'calculationWitness'],
    'CARBON_ACCOUNTING_CALCULATION_WITNESS_INPUT_INVALID',
    'calculation witness verifier 只接受固定 caller-owned 协议字段。'
  );
  const db = assertRawCarbonExactDatabase(input.db);
  const witnessState = input.calculationWitness && typeof input.calculationWitness === 'object'
    ? CARBON_CALCULATION_WITNESS_STATE.get(input.calculationWitness)
    : null;
  if (!witnessState) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_REQUIRED',
      '必须使用 exact 计算器签发的原始 calculation witness。',
      null,
      400
    );
  }
  if (witnessState.status !== 'issued') {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_REPLAY',
      'calculation witness 已被消费或失效。'
    );
  }
  if (witnessState.db !== db || witnessState.demoRun !== input.demoRun
    || witnessState.actor !== input.actor || witnessState.exactScope !== input.exactScope) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_BINDING_MISMATCH',
      'calculation witness 与 DB、demo run、actor 或 exact scope 对象身份不一致。'
    );
  }
  if (db.inTransaction !== true) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_TRANSACTION_REQUIRED',
      'calculation witness 必须在原 caller transaction 中消费。',
      null,
      500
    );
  }
  witnessState.status = 'verifying';
  try {
    // 第一条 SQL 只释放内层 marker，以此在任何事实读取前识别跨事务消费。
    db.exec(`RELEASE SAVEPOINT ${witnessState.transactionMarkerSavepoint}`);
  } catch (error) {
    witnessState.status = 'failed';
    const failClosed = failClosedCarbonExactTransaction(db, 'exact-witness');
    if (failClosed.fullRollbackError || failClosed.closeError) {
      throw createCarbonCalculationWitnessRecoveryError(error, {
        rollbackError: null,
        releaseError: error,
        ...failClosed
      });
    }
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_CALCULATION_WITNESS_TRANSACTION_MISMATCH',
      'calculation witness 不属于当前 caller transaction。'
    );
  }
  try {
    invokeCarbonAccountingFaultStage('exact-witness-before-read');
    const currentFacts = readCarbonCalculationWitnessFacts(db, {
      calculationRunId: witnessState.facts.run.id,
      operationLogId: witnessState.facts.audit.id
    }, {
      run: { runId: witnessState.facts.demoRunId },
      scopeDigest: witnessState.facts.exactScopeDigest,
      activityOwnership: witnessState.facts.exactActivityRecordIds.map((entityPk) => ({ entityPk })),
      factorOwnership: witnessState.facts.exactFactorIds.map((entityPk) => ({ entityPk }))
    });
    if (sha256Json(currentFacts) !== witnessState.factsDigest) {
      throw createCarbonExactError(
        'CARBON_ACCOUNTING_CALCULATION_WITNESS_FACT_MISMATCH',
        'calculation witness 与当前 run/result/audit 持久事实不一致。'
      );
    }
    invokeCarbonAccountingFaultStage('exact-witness-before-success-release');
    db.exec(`RELEASE SAVEPOINT ${witnessState.recoverySavepoint}`);
    witnessState.status = 'consumed';
    return witnessState.facts;
  } catch (error) {
    witnessState.status = 'failed';
    const recovery = db.inTransaction === true
      ? recoverCarbonExactSavepoint(db, witnessState.recoverySavepoint, 'exact-witness')
      : {
          rollbackError: createCarbonExactError(
            'CARBON_ACCOUNTING_CALCULATION_WITNESS_TRANSACTION_MISMATCH',
            'calculation witness 恢复边界已离开原 caller transaction。'
          ),
          releaseError: null,
          ...failClosedCarbonExactTransaction(db, 'exact-witness')
        };
    if (recovery.rollbackError || recovery.releaseError
      || recovery.fullRollbackError || recovery.closeError) {
      throw createCarbonCalculationWitnessRecoveryError(error, recovery);
    }
    throw normalizeCarbonAccountingServiceError(error);
  }
}

/** 在 ownership 任何业务 SQL 前复核 registration；三字段只读形态复用同一 exact 计算链生成私有预演。 */
function inspectCarbonRegistrationContextInCallerTransaction(input = {}) {
  const inputFields = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).sort()
    : [];
  if (inputFields.length === 3
    && inputFields[0] === 'actor' && inputFields[1] === 'db' && inputFields[2] === 'demoRun') {
    return previewCarbonCalculationExactInCallerTransaction(input);
  }
  assertCarbonExactProtocolFields(
    input,
    ['db', 'demoRun', 'actionRun', 'actor', 'exactScope', 'calculationWitness'],
    'CARBON_ACCOUNTING_REGISTRATION_CONTEXT_INPUT_INVALID',
    '碳核算 registration context 只能接收固定 caller-owned 协议字段。'
  );
  const db = assertRawCarbonExactDatabase(input.db);
  if (db.inTransaction !== true) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_REGISTRATION_TRANSACTION_REQUIRED',
      '碳核算 registration 必须在 exact 计算所属 caller transaction 中运行。',
      null,
      500
    );
  }
  if (!input.demoRun || typeof input.demoRun !== 'object' || Array.isArray(input.demoRun)
    || utilTypes.isProxy(input.demoRun)
    || !input.actionRun || typeof input.actionRun !== 'object' || Array.isArray(input.actionRun)
    || utilTypes.isProxy(input.actionRun)
    || !input.actor || typeof input.actor !== 'object' || Array.isArray(input.actor)
    || utilTypes.isProxy(input.actor)) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_REGISTRATION_OBJECT_IDENTITY_REQUIRED',
      '碳核算 registration 必须绑定原始 demo run、action run 与 actor 对象。',
      null,
      400
    );
  }
  const scopeState = input.exactScope && typeof input.exactScope === 'object'
    && !utilTypes.isProxy(input.exactScope)
    ? CARBON_EXACT_SCOPE_STATE.get(input.exactScope)
    : null;
  const witnessState = input.calculationWitness && typeof input.calculationWitness === 'object'
    && !utilTypes.isProxy(input.calculationWitness)
    ? CARBON_CALCULATION_WITNESS_STATE.get(input.calculationWitness)
    : null;
  if (!scopeState || !witnessState) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_REGISTRATION_CAPABILITY_REQUIRED',
      '碳核算 registration 必须使用原始 exact scope 与 calculation witness。',
      null,
      400
    );
  }
  if (witnessState.status !== 'issued') {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_REGISTRATION_WITNESS_REPLAY',
      '碳核算 registration calculation witness 已消费或失效。'
    );
  }
  if (scopeState.db !== db || witnessState.db !== db
    || scopeState.demoRun !== input.demoRun || witnessState.demoRun !== input.demoRun
    || scopeState.actor !== input.actor || witnessState.actor !== input.actor
    || witnessState.exactScope !== input.exactScope) {
    throw createCarbonExactError(
      'CARBON_ACCOUNTING_REGISTRATION_BINDING_MISMATCH',
      '碳核算 registration 与 DB、demo run、actor、scope 或 witness 对象身份不一致。'
    );
  }
  return freezeCarbonExactSnapshot({
    exactState: scopeState.exactState,
    witnessFacts: witnessState.facts
  });
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
    invokeCarbonAccountingFaultStage('list-runs');
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
    invokeCarbonAccountingFaultStage('get-run');
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

Object.assign(carbonCalculationRunServiceExports, {
  CARBON_ACCOUNTING_ACTIVITY_LIMIT,
  CARBON_ACCOUNTING_CALCULATION_METHOD,
  CARBON_ACCOUNTING_MISSING_FACTOR_CODE,
  CARBON_ACCOUNTING_MISSING_FACTOR_MESSAGE,
  CARBON_ACCOUNTING_SNAPSHOT_VERSION,
  CARBON_ACCOUNTING_SOURCE_TYPE,
  assertCarbonAccountingQueryContract,
  calculateEmissionValue,
  createCarbonCalculationRun,
  getCarbonCalculationRun,
  hasOwnQueryField,
  listCarbonCalculationRuns,
  normalizeCarbonAccountingServiceError,
  normalizeCarbonAccountingUtc,
  normalizeCreateRunInput,
  stableStringify
});

Object.defineProperty(carbonCalculationRunServiceExports, CARBON_EXACT_INTERNAL_PROTOCOL_SYMBOL, {
  value: Object.freeze({
    buildExactScopeInCallerTransaction: buildCarbonCalculationExactScopeInCallerTransaction,
    executeExactInCallerTransaction: executeCarbonCalculationExactInCallerTransaction,
    inspectRegistrationContextInCallerTransaction: inspectCarbonRegistrationContextInCallerTransaction,
    consumeCalculationWitnessInCallerTransaction: consumeCarbonCalculationWitnessInCallerTransaction
  }),
  enumerable: false,
  writable: false,
  configurable: false
});

Object.freeze(carbonCalculationRunServiceExports);
