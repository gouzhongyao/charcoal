'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  BALANCE_INPUT_ROLES,
  BALANCE_SOURCE_TYPES,
  ENERGY_ANALYSIS_REASON_CODES,
  ENERGY_ANALYSIS_VERSIONS,
  MANUAL_HANDLING_STATUSES,
  RULE_PRIORITIES,
  isIanaTimeZone,
  isStrictUtcIso
} = require('./energyAnalysisContracts');
const { calculateEnergyBalance, roundAnalysisValue } = require('./energyAnalysisUtils');
const { normalizeUnitAndValue } = require('./import/normalization');
const {
  createSuggestionsForSnapshots,
  listBalanceSuggestionsWithDb,
  updateBalanceSuggestionStatusWithDb
} = require('./energyBalanceSuggestionService');

// 平衡主数据状态白名单。
const MASTER_STATUSES = Object.freeze(['active', 'inactive']);
// 发电来源允许映射的角色白名单。
const GENERATION_ROLES = Object.freeze(['self_generation', 'output']);
// 发电来源允许读取的数值字段白名单。
const GENERATION_VALUE_FIELDS = Object.freeze([
  'generation_value_kwh',
  'self_use_value_kwh',
  'grid_export_value_kwh'
]);
// 单次来源映射最多允许显式引用的记录数。
const MAX_SOURCE_RECORD_IDS = 500;
// 单次计算最多读取的来源记录数。
const MAX_SOURCE_RECORDS = 5000;
// 单次平衡计算允许的最大自然日范围。
const MAX_CALCULATION_DAYS = 366;
// 分页查询默认页大小。
const DEFAULT_PAGE_SIZE = 20;
// 通用分页查询最大页大小。
const MAX_PAGE_SIZE = 100;
// 平衡项目分页查询最大页大小。
const MAX_ITEM_PAGE_SIZE = 200;
// 一天的毫秒数。
const DAY_MS = 24 * 60 * 60 * 1000;
// 综合折标统一使用的虚拟能源范围编码。
const STANDARD_COAL_SCOPE_CODE = 'STANDARD_COAL';
// 允许作为质量冻结原因的原因码集合。
const APPROVED_REASON_CODE_SET = new Set(ENERGY_ANALYSIS_REASON_CODES);

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 去重并仅保留共享契约批准的原因码。
 * @param {string[]} reasonCodes 原因码列表。
 * @returns {string[]} 稳定原因码列表。
 */
function normalizeReasonCodes(reasonCodes) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .filter((reasonCode) => APPROVED_REASON_CODE_SET.has(reasonCode)))];
}

/**
 * 安全解析数据库 JSON 字段。
 * @param {*} value JSON 文本。
 * @param {*} fallback 解析失败时的回退值。
 * @returns {*} 解析结果。
 */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

/**
 * 对对象键递归排序，确保摘要不受属性插入顺序影响。
 * @param {*} value 待规范值。
 * @returns {*} 可稳定序列化的值。
 */
function sortForDigest(value) {
  if (Array.isArray(value)) return value.map(sortForDigest);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForDigest(value[key])]));
}

/**
 * 生成平衡来源和计算输入的 SHA-256 摘要。
 * @param {*} value 待摘要值。
 * @returns {string} 十六进制摘要。
 */
function createDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortForDigest(value))).digest('hex');
}

/**
 * 规范必填短文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {number} maximumLength 最大长度。
 * @returns {string} 规范文本。
 */
function normalizeRequiredText(value, fieldName, maximumLength = 200) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} 不能为空。`, { code: 'BALANCE_REQUIRED_FIELD_MISSING', fieldName });
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length > maximumLength) {
    throw badRequest(`${fieldName} 最长 ${maximumLength} 个字符。`, {
      code: 'BALANCE_FIELD_TOO_LONG',
      fieldName,
      maximumLength
    });
  }
  return normalizedValue;
}

/**
 * 规范可选短文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {number} maximumLength 最大长度。
 * @returns {string|null} 规范文本。
 */
function normalizeOptionalText(value, fieldName, maximumLength = 500) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest(`${fieldName} 必须是字符串。`, { code: 'INVALID_BALANCE_TEXT_FIELD', fieldName });
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length > maximumLength) {
    throw badRequest(`${fieldName} 最长 ${maximumLength} 个字符。`, {
      code: 'BALANCE_FIELD_TOO_LONG',
      fieldName,
      maximumLength
    });
  }
  return normalizedValue || null;
}

/**
 * 规范正整数 ID。
 * @param {*} value 原始 ID。
 * @param {string} fieldName 字段名。
 * @returns {number} 正整数 ID。
 */
function normalizePositiveInteger(value, fieldName) {
  const numericValue = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_BALANCE_ID', fieldName });
  }
  return numericValue;
}

/**
 * 规范可选正整数 ID。
 * @param {*} value 原始 ID。
 * @param {string} fieldName 字段名。
 * @returns {number|null} 正整数或空值。
 */
function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return normalizePositiveInteger(value, fieldName);
}

/**
 * 规范非负有限数值。
 * @param {*} value 原始数值。
 * @param {string} fieldName 字段名。
 * @returns {number} 非负有限数值。
 */
function normalizeNonNegativeNumber(value, fieldName) {
  const numericValue = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw badRequest(`${fieldName} 必须是大于等于 0 的有限数值。`, {
      code: 'INVALID_BALANCE_NON_NEGATIVE_NUMBER',
      fieldName
    });
  }
  return numericValue;
}

/**
 * 规范布尔值，兼容 JSON 布尔值和 0/1。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @returns {boolean} 布尔值。
 */
function normalizeBoolean(value, fieldName) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw badRequest(`${fieldName} 必须是布尔值。`, { code: 'INVALID_BALANCE_BOOLEAN', fieldName });
}

/**
 * 规范主数据状态。
 * @param {*} value 原始状态。
 * @returns {string} 状态。
 */
function normalizeMasterStatus(value) {
  const status = typeof value === 'string' ? value.trim() : '';
  if (!MASTER_STATUSES.includes(status)) {
    throw badRequest('status 只允许 active 或 inactive。', {
      code: 'INVALID_BALANCE_MASTER_STATUS',
      allowedValues: MASTER_STATUSES
    });
  }
  return status;
}

/**
 * 规范严格 UTC 时间戳。
 * @param {*} value 原始时间戳。
 * @param {string} fieldName 字段名。
 * @returns {string} 严格 UTC 时间戳。
 */
function normalizeUtc(value, fieldName) {
  if (!isStrictUtcIso(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${fieldName} 必须是携带 Z 的严格 UTC ISO 时间。`, {
      code: 'INVALID_BALANCE_UTC',
      fieldName
    });
  }
  return value;
}

/**
 * 规范 IANA 来源时区。
 * @param {*} value 原始时区。
 * @returns {string} IANA 时区。
 */
function normalizeSourceTimeZone(value) {
  if (!isIanaTimeZone(value)) {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_BALANCE_SOURCE_TIME_ZONE'
    });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
  } catch (_error) {
    throw badRequest('sourceTimeZone 必须是当前运行环境支持的 IANA 时区。', {
      code: 'UNSUPPORTED_BALANCE_SOURCE_TIME_ZONE'
    });
  }
  return value;
}

/**
 * 规范分页参数并施加固定上限。
 * @param {*} query 原始查询参数。
 * @param {number} maximumPageSize 最大页大小。
 * @returns {{ page: number, pageSize: number, offset: number }} 分页参数。
 */
function normalizePagination(query, maximumPageSize = MAX_PAGE_SIZE) {
  const source = isPlainObject(query) ? query : {};
  const page = source.page === undefined ? 1 : normalizePositiveInteger(source.page, 'page');
  const pageSize = source.pageSize === undefined
    ? DEFAULT_PAGE_SIZE
    : normalizePositiveInteger(source.pageSize, 'pageSize');
  if (pageSize > maximumPageSize) {
    throw badRequest(`pageSize 不能大于 ${maximumPageSize}。`, {
      code: 'BALANCE_PAGE_SIZE_EXCEEDED',
      maximumPageSize
    });
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw badRequest('分页偏移量超出安全范围。', { code: 'BALANCE_PAGE_OFFSET_OVERFLOW' });
  }
  return { page, pageSize, offset };
}

/**
 * 将 SQLite 唯一约束错误转换为稳定冲突错误。
 * @param {Error} error SQLite 错误。
 * @param {string} message 对外消息。
 * @param {object} details 对外详情。
 * @returns {never} 始终抛错。
 */
function throwConflictForConstraint(error, message, details) {
  if (error && (error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || String(error.message || '').includes('UNIQUE constraint failed'))) {
    throw new AppError('ENERGY_BALANCE_CONFLICT', message, {
      statusCode: 409,
      details
    });
  }
  throw error;
}

/**
 * 在短连接或调用方连接中执行服务操作，并统一脱敏未知错误。
 * @param {Function} operation 数据库操作。
 * @param {object} options 可选调用方数据库连接。
 * @returns {*} 操作结果。
 */
function executeWithDatabase(operation, options = {}) {
  const externalDb = options && options.db;
  const db = externalDb || openDatabase();
  try {
    return operation(db);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('ENERGY_BALANCE_OPERATION_FAILED', '能效平衡操作失败。', {
      statusCode: 500,
      details: process.env.NODE_ENV === 'development' ? { message: error.message } : null
    });
  } finally {
    if (!externalDb) db.close();
  }
}

/**
 * 规范并校验平衡业务写操作的认证操作者。
 * @param {object} options 服务选项。
 * @returns {{userId:number,username:string|null,ip:string|null}} 操作者。
 */
function requireAuditActor(options) {
  const actor = options?.actor;
  if (!actor || !Number.isSafeInteger(Number(actor.userId)) || Number(actor.userId) <= 0) {
    throw badRequest('能效平衡写操作必须提供已认证操作者。', {
      code: 'ENERGY_BALANCE_AUDIT_ACTOR_REQUIRED'
    });
  }
  return {
    userId: Number(actor.userId),
    username: normalizeOptionalText(actor.username, 'actor.username', 100),
    ip: normalizeOptionalText(actor.ip, 'actor.ip', 100)
  };
}

/**
 * 在当前业务事务内写入统一操作日志，前后状态用于人工追溯。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项和测试钩子。
 * @param {string} operation 操作编码。
 * @param {string} targetType 目标类型。
 * @param {*} targetId 目标主键。
 * @param {*} beforeState 操作前状态。
 * @param {*} afterState 操作后状态。
 */
function insertTransactionalAudit(db, options, operation, targetType, targetId, beforeState, afterState) {
  const actor = requireAuditActor(options);
  const detail = {
    actorUsername: actor.username,
    before: beforeState ?? null,
    after: afterState ?? null
  };
  if (typeof options?.beforeAuditInsert === 'function') {
    options.beforeAuditInsert({ db, operation, targetType, targetId, detail });
  }
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    actor.userId,
    operation,
    targetType,
    targetId === null || targetId === undefined ? null : String(targetId),
    JSON.stringify(detail),
    actor.ip
  );
  if (typeof options?.afterAuditInsert === 'function') {
    options.afterAuditInsert({ db, operation, targetType, targetId, detail });
  }
}

/**
 * 在同一 SQLite 事务中执行业务写和审计，任一失败均整体回滚。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 * @param {string} operation 操作编码。
 * @param {string} targetType 目标类型。
 * @param {Function} action 返回结果及前后状态的业务写函数。
 * @returns {*} 业务结果。
 */
function executeAuditedWrite(db, options, operation, targetType, action) {
  requireAuditActor(options);
  return db.transaction(() => {
    const writeResult = action();
    insertTransactionalAudit(
      db,
      options,
      operation,
      targetType,
      writeResult.targetId,
      writeResult.beforeState,
      writeResult.afterState
    );
    return writeResult.result;
  })();
}

/**
 * 安全映射能源类型行。
 * @param {object|null} row 能源类型行。
 * @returns {object|null} 能源类型对象。
 */
function mapEnergyTypeRow(row) {
  if (!row) return null;
  return {
    id: Number(row.energyTypeId ?? row.id),
    code: row.energyTypeCode ?? row.code,
    name: row.energyTypeName ?? row.name,
    defaultUnit: row.defaultUnit ?? row.default_unit,
    standardUnit: row.standardUnit ?? row.standard_unit,
    active: Boolean(row.energyTypeActive ?? row.is_active)
  };
}

/**
 * 将边界数据库行映射为公开契约。
 * @param {object|null} row 边界行。
 * @returns {object|null} 边界对象。
 */
function mapBoundaryRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    boundaryCode: row.boundaryCode,
    boundaryName: row.boundaryName,
    organizationUnitId: row.organizationUnitId === null ? null : Number(row.organizationUnitId),
    organizationUnitCode: row.organizationUnitCode || null,
    organizationUnitName: row.organizationUnitName || null,
    source: row.source,
    documentNo: row.documentNo,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    sourceTimeZone: row.sourceTimeZone,
    generationBoundaryConfirmed: Boolean(row.generationBoundaryConfirmed),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 将项目数据库行映射为公开契约。
 * @param {object|null} row 项目行。
 * @returns {object|null} 项目对象。
 */
function mapItemRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    boundaryId: Number(row.boundaryId),
    itemCode: row.itemCode,
    itemName: row.itemName,
    role: row.role,
    energyType: mapEnergyTypeRow(row),
    originalUnit: row.originalUnit,
    sourceType: row.sourceType,
    sourceMapping: parseJson(row.sourceMappingJson, null),
    generationAntiDoubleCountKey: row.generationAntiDoubleCountKey,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 返回边界查询所需公共 SELECT 片段。
 * @returns {string} SQL SELECT。
 */
function boundarySelectSql() {
  return `SELECT boundary.id,
                 boundary.boundary_code AS boundaryCode,
                 boundary.boundary_name AS boundaryName,
                 boundary.organization_unit_id AS organizationUnitId,
                 organization.unit_code AS organizationUnitCode,
                 organization.unit_name AS organizationUnitName,
                 boundary.source,
                 boundary.document_no AS documentNo,
                 boundary.version,
                 boundary.effective_start_utc AS effectiveStartUtc,
                 boundary.effective_end_utc AS effectiveEndUtc,
                 boundary.source_timezone AS sourceTimeZone,
                 boundary.generation_boundary_confirmed AS generationBoundaryConfirmed,
                 boundary.status,
                 boundary.created_at AS createdAt,
                 boundary.updated_at AS updatedAt
          FROM energy_balance_boundaries AS boundary
          LEFT JOIN organization_units AS organization ON organization.id = boundary.organization_unit_id`;
}

/**
 * 返回项目查询所需公共 SELECT 片段。
 * @returns {string} SQL SELECT。
 */
function itemSelectSql() {
  return `SELECT item.id,
                 item.energy_balance_boundary_id AS boundaryId,
                 item.item_code AS itemCode,
                 item.item_name AS itemName,
                 item.role,
                 item.energy_type_id AS energyTypeId,
                 energy.code AS energyTypeCode,
                 energy.name AS energyTypeName,
                 energy.default_unit AS defaultUnit,
                 energy.standard_unit AS standardUnit,
                 energy.is_active AS energyTypeActive,
                 item.original_unit AS originalUnit,
                 item.source_type AS sourceType,
                 item.source_mapping_json AS sourceMappingJson,
                 item.generation_anti_double_count_key AS generationAntiDoubleCountKey,
                 item.status,
                 item.created_at AS createdAt,
                 item.updated_at AS updatedAt
          FROM energy_balance_items AS item
          JOIN energy_types AS energy ON energy.id = item.energy_type_id`;
}

/**
 * 读取边界，不存在时抛出 404。
 * @param {object} db SQLite 连接。
 * @param {number} boundaryId 边界 ID。
 * @returns {object} 边界行。
 */
function requireBoundaryRow(db, boundaryId) {
  const row = db.prepare(`${boundarySelectSql()} WHERE boundary.id = ?`).get(boundaryId);
  if (!row) throw notFound('平衡边界不存在。', { boundaryId });
  return row;
}

/**
 * 读取边界项目，不存在或不属于边界时抛出 404。
 * @param {object} db SQLite 连接。
 * @param {number} boundaryId 边界 ID。
 * @param {number} itemId 项目 ID。
 * @returns {object} 项目行。
 */
function requireItemRow(db, boundaryId, itemId) {
  const row = db.prepare(
    `${itemSelectSql()} WHERE item.id = ? AND item.energy_balance_boundary_id = ?`
  ).get(itemId, boundaryId);
  if (!row) throw notFound('平衡项目不存在或不属于指定边界。', { boundaryId, itemId });
  return row;
}

/**
 * 校验组织单元存在且启用。
 * @param {object} db SQLite 连接。
 * @param {number|null} organizationUnitId 组织单元 ID。
 * @returns {object|null} 组织单元行。
 */
function validateOrganizationUnit(db, organizationUnitId) {
  if (organizationUnitId === null) return null;
  const row = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units WHERE id = ?`
  ).get(organizationUnitId);
  if (!row) throw badRequest('organizationUnitId 对应的组织单元不存在。', { organizationUnitId });
  if (row.status !== 'active') {
    throw badRequest('organizationUnitId 对应的组织单元未启用。', { organizationUnitId });
  }
  return row;
}

/**
 * 校验并读取启用能源类型。
 * @param {object} db SQLite 连接。
 * @param {number} energyTypeId 能源类型 ID。
 * @returns {object} 能源类型行。
 */
function validateEnergyType(db, energyTypeId) {
  const row = db.prepare(
    `SELECT id, code, name, default_unit AS defaultUnit,
            standard_unit AS standardUnit, is_active AS active
     FROM energy_types WHERE id = ?`
  ).get(energyTypeId);
  if (!row) throw badRequest('energyTypeId 对应的能源类型不存在。', { energyTypeId });
  if (!row.active) throw badRequest('energyTypeId 对应的能源类型未启用。', { energyTypeId });
  return row;
}

/**
 * 校验能源类型与原单位具备明确兼容关系。
 * @param {object} energyType 能源类型。
 * @param {string} originalUnit 原单位。
 */
function validateEnergyUnit(energyType, originalUnit) {
  const normalized = normalizeUnitAndValue(energyType.code, originalUnit, 1);
  const directMatch = originalUnit === energyType.defaultUnit || originalUnit === energyType.standardUnit;
  if (!normalized && !directMatch) {
    throw badRequest('originalUnit 与能源类型不兼容。', {
      code: 'BALANCE_ENERGY_UNIT_NOT_COMPARABLE',
      energyTypeCode: energyType.code,
      originalUnit
    });
  }
}

/**
 * 规范来源记录 ID 数组，并拒绝重复引用和超限。
 * @param {*} value 原始记录 ID 数组。
 * @param {boolean} required 是否必填。
 * @returns {number[]|null} 记录 ID 数组。
 */
function normalizeRecordIds(value, required) {
  if (value === undefined || value === null) {
    if (required) {
      throw badRequest('该来源类型必须在 sourceMapping.recordIds 中显式选择记录。', {
        code: 'BALANCE_SOURCE_RECORD_IDS_REQUIRED'
      });
    }
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('sourceMapping.recordIds 必须是非空正整数数组。', {
      code: 'INVALID_BALANCE_SOURCE_RECORD_IDS'
    });
  }
  if (value.length > MAX_SOURCE_RECORD_IDS) {
    throw badRequest(`sourceMapping.recordIds 最多允许 ${MAX_SOURCE_RECORD_IDS} 条。`, {
      code: 'BALANCE_SOURCE_RECORD_IDS_EXCEEDED',
      maximum: MAX_SOURCE_RECORD_IDS
    });
  }
  const normalizedIds = value.map((recordId) => normalizePositiveInteger(recordId, 'sourceMapping.recordIds'));
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw badRequest('sourceMapping.recordIds 不允许重复。', {
      code: 'DUPLICATE_BALANCE_SOURCE_RECORD_ID'
    });
  }
  return normalizedIds;
}

/**
 * 按来源类型白名单规范来源映射。
 * @param {*} value 原始来源映射。
 * @param {string} sourceType 来源类型。
 * @param {string} role 平衡角色。
 * @returns {object} 规范来源映射。
 */
function normalizeSourceMapping(value, sourceType, role) {
  if (!isPlainObject(value)) {
    throw badRequest('sourceMapping 必须是对象。', { code: 'INVALID_BALANCE_SOURCE_MAPPING' });
  }
  const reference = normalizeRequiredText(value.reference, 'sourceMapping.reference', 300);
  if (value.type !== undefined && value.type !== sourceType) {
    throw badRequest('sourceMapping.type 必须与 sourceType 一致。', {
      code: 'BALANCE_SOURCE_TYPE_MISMATCH',
      sourceType,
      mappingType: value.type
    });
  }
  const mapping = { reference };
  if (sourceType === 'timeseries') {
    const recordIds = normalizeRecordIds(value.recordIds, false);
    const sourceReference = normalizeOptionalText(value.sourceReference, 'sourceMapping.sourceReference', 300);
    if (!recordIds && !sourceReference) {
      throw badRequest('timeseries 来源必须显式提供 recordIds 或 sourceReference。', {
        code: 'BALANCE_TIMESERIES_MAPPING_REQUIRED'
      });
    }
    if (recordIds) mapping.recordIds = recordIds;
    if (sourceReference) mapping.sourceReference = sourceReference;
  } else if (sourceType === 'explicit_balance_value') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      mapping.value = normalizeNonNegativeNumber(value.value, 'sourceMapping.value');
    }
  } else {
    mapping.recordIds = normalizeRecordIds(value.recordIds, true);
  }
  if (sourceType === 'generation') {
    if (!GENERATION_ROLES.includes(role)) {
      throw badRequest('generation 来源只能映射到 self_generation 或 output 角色。', {
        code: 'INVALID_GENERATION_BALANCE_ROLE',
        role
      });
    }
    const defaultField = role === 'self_generation' ? 'self_use_value_kwh' : 'grid_export_value_kwh';
    const valueField = value.valueField === undefined ? defaultField : value.valueField;
    if (!GENERATION_VALUE_FIELDS.includes(valueField)) {
      throw badRequest('generation valueField 不在允许白名单。', {
        code: 'INVALID_GENERATION_VALUE_FIELD',
        allowedValues: GENERATION_VALUE_FIELDS
      });
    }
    if (role === 'self_generation' && valueField !== 'self_use_value_kwh') {
      throw badRequest('self_generation 必须显式映射 self_use_value_kwh。', {
        code: 'GENERATION_ROLE_FIELD_MISMATCH'
      });
    }
    if (role === 'output' && valueField !== 'grid_export_value_kwh') {
      throw badRequest('generation output 必须显式映射 grid_export_value_kwh。', {
        code: 'GENERATION_ROLE_FIELD_MISMATCH'
      });
    }
    mapping.valueField = valueField;
  }
  return mapping;
}

/**
 * 规范边界创建或更新输入。
 * @param {*} input 原始输入。
 * @param {object|null} existing 已有边界。
 * @returns {object} 完整规范输入。
 */
function normalizeBoundaryInput(input, existing = null) {
  if (!isPlainObject(input)) {
    throw badRequest('平衡边界输入必须是对象。', { code: 'INVALID_BALANCE_BOUNDARY_INPUT' });
  }
  const read = (fieldName) => Object.prototype.hasOwnProperty.call(input, fieldName)
    ? input[fieldName]
    : existing?.[fieldName];
  const effectiveStartUtc = normalizeUtc(read('effectiveStartUtc'), 'effectiveStartUtc');
  const effectiveEndUtc = normalizeUtc(read('effectiveEndUtc'), 'effectiveEndUtc');
  if (Date.parse(effectiveStartUtc) >= Date.parse(effectiveEndUtc)) {
    throw badRequest('effectiveStartUtc 必须早于 effectiveEndUtc。', {
      code: 'INVALID_BALANCE_BOUNDARY_EFFECTIVE_RANGE'
    });
  }
  return {
    boundaryCode: normalizeRequiredText(read('boundaryCode'), 'boundaryCode', 100),
    boundaryName: normalizeRequiredText(read('boundaryName'), 'boundaryName', 200),
    organizationUnitId: normalizeOptionalPositiveInteger(read('organizationUnitId'), 'organizationUnitId'),
    source: normalizeRequiredText(read('source'), 'source', 200),
    documentNo: normalizeOptionalText(read('documentNo'), 'documentNo', 200),
    version: normalizeRequiredText(read('version'), 'version', 100),
    effectiveStartUtc,
    effectiveEndUtc,
    sourceTimeZone: normalizeSourceTimeZone(read('sourceTimeZone')),
    generationBoundaryConfirmed: normalizeBoolean(
      read('generationBoundaryConfirmed') ?? false,
      'generationBoundaryConfirmed'
    )
  };
}

/**
 * 规范项目创建或更新输入。
 * @param {*} input 原始输入。
 * @param {object|null} existing 已有项目。
 * @returns {object} 完整规范输入。
 */
function normalizeItemInput(input, existing = null) {
  if (!isPlainObject(input)) {
    throw badRequest('平衡项目输入必须是对象。', { code: 'INVALID_BALANCE_ITEM_INPUT' });
  }
  const read = (fieldName) => Object.prototype.hasOwnProperty.call(input, fieldName)
    ? input[fieldName]
    : existing?.[fieldName];
  const role = normalizeRequiredText(read('role'), 'role', 50);
  if (!BALANCE_INPUT_ROLES.includes(role)) {
    throw badRequest('role 不在九角色白名单。', {
      code: 'INVALID_BALANCE_ROLE',
      allowedValues: BALANCE_INPUT_ROLES
    });
  }
  const sourceType = normalizeRequiredText(read('sourceType'), 'sourceType', 50);
  if (!BALANCE_SOURCE_TYPES.includes(sourceType)) {
    throw badRequest('sourceType 不在平衡来源白名单。', {
      code: 'INVALID_BALANCE_SOURCE_TYPE',
      allowedValues: BALANCE_SOURCE_TYPES
    });
  }
  const generationKeyValue = read('generationAntiDoubleCountKey');
  const generationAntiDoubleCountKey = normalizeOptionalText(
    generationKeyValue,
    'generationAntiDoubleCountKey',
    200
  );
  if (sourceType === 'generation' && !generationAntiDoubleCountKey) {
    throw badRequest('generation 来源必须提供 generationAntiDoubleCountKey。', {
      code: 'GENERATION_ANTI_DOUBLE_COUNT_KEY_REQUIRED'
    });
  }
  if (sourceType !== 'generation' && generationAntiDoubleCountKey) {
    throw badRequest('非 generation 来源不得设置 generationAntiDoubleCountKey。', {
      code: 'UNEXPECTED_GENERATION_ANTI_DOUBLE_COUNT_KEY'
    });
  }
  return {
    itemCode: normalizeRequiredText(read('itemCode'), 'itemCode', 100),
    itemName: normalizeRequiredText(read('itemName'), 'itemName', 200),
    role,
    energyTypeId: normalizePositiveInteger(read('energyTypeId') ?? existing?.energyType?.id, 'energyTypeId'),
    originalUnit: normalizeRequiredText(read('originalUnit'), 'originalUnit', 50),
    sourceType,
    sourceMapping: normalizeSourceMapping(read('sourceMapping'), sourceType, role),
    generationAntiDoubleCountKey
  };
}

/**
 * 查询平衡边界列表。
 * @param {*} query 查询参数。
 * @param {object} options 可选数据库连接。
 * @returns {object} 列表和分页。
 */
function listBalanceBoundaries(query = {}, options = {}) {
  const pagination = normalizePagination(query);
  const status = query.status === undefined ? null : normalizeMasterStatus(query.status);
  const organizationUnitId = normalizeOptionalPositiveInteger(query.organizationUnitId, 'organizationUnitId');
  const keyword = normalizeOptionalText(query.keyword, 'keyword', 100);
  return executeWithDatabase((db) => {
    const where = [];
    const params = {};
    if (status) {
      where.push('boundary.status = @status');
      params.status = status;
    }
    if (organizationUnitId) {
      where.push('boundary.organization_unit_id = @organizationUnitId');
      params.organizationUnitId = organizationUnitId;
    }
    if (keyword) {
      where.push('(boundary.boundary_code LIKE @keyword OR boundary.boundary_name LIKE @keyword)');
      params.keyword = `%${keyword}%`;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(
      `SELECT COUNT(*) AS total FROM energy_balance_boundaries AS boundary ${whereSql}`
    ).get(params).total);
    const rows = db.prepare(
      `${boundarySelectSql()} ${whereSql}
       ORDER BY boundary.updated_at DESC, boundary.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize: pagination.pageSize, offset: pagination.offset }).map(mapBoundaryRow);
    return {
      rows,
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages: Math.ceil(total / pagination.pageSize)
      }
    };
  }, options);
}

/**
 * 查询单个平衡边界及项目统计。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {object} options 可选数据库连接。
 * @returns {object} 边界详情。
 */
function getBalanceBoundary(boundaryIdValue, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  return executeWithDatabase((db) => {
    const boundary = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
    const counts = db.prepare(
      `SELECT COUNT(*) AS itemCount,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeItemCount
       FROM energy_balance_items WHERE energy_balance_boundary_id = ?`
    ).get(boundaryId);
    return {
      ...boundary,
      itemCount: Number(counts.itemCount || 0),
      activeItemCount: Number(counts.activeItemCount || 0),
      roles: [...BALANCE_INPUT_ROLES]
    };
  }, options);
}

/**
 * 创建平衡边界。
 * @param {*} input 创建输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 新边界。
 */
function createBalanceBoundary(input, options = {}) {
  const normalized = normalizeBoundaryInput(input);
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.boundary.create',
    'energy_balance_boundary',
    () => {
      validateOrganizationUnit(db, normalized.organizationUnitId);
      const now = new Date().toISOString();
      try {
        const insertResult = db.prepare(
          `INSERT INTO energy_balance_boundaries (
             boundary_code, boundary_name, organization_unit_id, source, document_no,
             version, effective_start_utc, effective_end_utc, source_timezone,
             generation_boundary_confirmed, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        ).run(
          normalized.boundaryCode,
          normalized.boundaryName,
          normalized.organizationUnitId,
          normalized.source,
          normalized.documentNo,
          normalized.version,
          normalized.effectiveStartUtc,
          normalized.effectiveEndUtc,
          normalized.sourceTimeZone,
          normalized.generationBoundaryConfirmed ? 1 : 0,
          now,
          now
        );
        const boundary = mapBoundaryRow(requireBoundaryRow(db, Number(insertResult.lastInsertRowid)));
        return { result: boundary, targetId: boundary.id, beforeState: null, afterState: boundary };
      } catch (error) {
        throwConflictForConstraint(error, '相同 boundaryCode 和 version 的边界已存在。', {
          boundaryCode: normalized.boundaryCode,
          version: normalized.version
        });
      }
    }
  ), options);
}

/**
 * 更新平衡边界定义。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} input 更新输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 更新后边界。
 */
function updateBalanceBoundary(boundaryIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.boundary.update',
    'energy_balance_boundary',
    () => {
      const existing = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
      const normalized = normalizeBoundaryInput(input, existing);
      validateOrganizationUnit(db, normalized.organizationUnitId);
      const now = new Date().toISOString();
      try {
        db.prepare(
          `UPDATE energy_balance_boundaries
           SET boundary_code = ?, boundary_name = ?, organization_unit_id = ?,
               source = ?, document_no = ?, version = ?, effective_start_utc = ?,
               effective_end_utc = ?, source_timezone = ?, generation_boundary_confirmed = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(
          normalized.boundaryCode,
          normalized.boundaryName,
          normalized.organizationUnitId,
          normalized.source,
          normalized.documentNo,
          normalized.version,
          normalized.effectiveStartUtc,
          normalized.effectiveEndUtc,
          normalized.sourceTimeZone,
          normalized.generationBoundaryConfirmed ? 1 : 0,
          now,
          boundaryId
        );
        const updated = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
        return { result: updated, targetId: boundaryId, beforeState: existing, afterState: updated };
      } catch (error) {
        throwConflictForConstraint(error, '相同 boundaryCode 和 version 的边界已存在。', {
          boundaryCode: normalized.boundaryCode,
          version: normalized.version
        });
      }
    }
  ), options);
}

/**
 * 启用或停用平衡边界。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} input 状态输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 更新后边界。
 */
function setBalanceBoundaryStatus(boundaryIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  if (!isPlainObject(input)) throw badRequest('边界状态输入必须是对象。');
  const status = normalizeMasterStatus(input.status);
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.boundary.status',
    'energy_balance_boundary',
    () => {
      const existing = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE energy_balance_boundaries SET status = ?, updated_at = ? WHERE id = ?`
      ).run(status, now, boundaryId);
      const updated = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
      return { result: updated, targetId: boundaryId, beforeState: existing, afterState: updated };
    }
  ), options);
}

/**
 * 查询指定边界的平衡项目。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} query 查询参数。
 * @param {object} options 可选数据库连接。
 * @returns {object} 项目列表和分页。
 */
function listBalanceItems(boundaryIdValue, query = {}, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  const pagination = normalizePagination(query, MAX_ITEM_PAGE_SIZE);
  const status = query.status === undefined ? null : normalizeMasterStatus(query.status);
  const role = query.role === undefined ? null : normalizeRequiredText(query.role, 'role', 50);
  if (role && !BALANCE_INPUT_ROLES.includes(role)) {
    throw badRequest('role 不在九角色白名单。', { allowedValues: BALANCE_INPUT_ROLES });
  }
  return executeWithDatabase((db) => {
    requireBoundaryRow(db, boundaryId);
    const where = ['item.energy_balance_boundary_id = @boundaryId'];
    const params = { boundaryId };
    if (status) {
      where.push('item.status = @status');
      params.status = status;
    }
    if (role) {
      where.push('item.role = @role');
      params.role = role;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number(db.prepare(
      `SELECT COUNT(*) AS total FROM energy_balance_items AS item ${whereSql}`
    ).get(params).total);
    const rows = db.prepare(
      `${itemSelectSql()} ${whereSql}
       ORDER BY item.item_code ASC, item.id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize: pagination.pageSize, offset: pagination.offset }).map(mapItemRow);
    return {
      rows,
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages: Math.ceil(total / pagination.pageSize)
      }
    };
  }, options);
}

/**
 * 校验同边界发电防重复键未被其他启用或停用项目占用。
 * @param {object} db SQLite 连接。
 * @param {number} boundaryId 边界 ID。
 * @param {string|null} generationKey 防重复键。
 * @param {number|null} excludedItemId 排除项目 ID。
 */
function validateGenerationAntiDoubleCountKey(db, boundaryId, generationKey, excludedItemId = null) {
  if (!generationKey) return;
  const row = db.prepare(
    `SELECT id FROM energy_balance_items
     WHERE energy_balance_boundary_id = ?
       AND generation_anti_double_count_key = ?
       AND (? IS NULL OR id <> ?)
     LIMIT 1`
  ).get(boundaryId, generationKey, excludedItemId, excludedItemId);
  if (row) {
    throw new AppError('ENERGY_BALANCE_GENERATION_KEY_CONFLICT', '发电防重复计入键已被同边界其他项目使用。', {
      statusCode: 409,
      details: { boundaryId, generationAntiDoubleCountKey: generationKey, existingItemId: Number(row.id) }
    });
  }
}

/**
 * 创建平衡项目。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} input 创建输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 新项目。
 */
function createBalanceItem(boundaryIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  const normalized = normalizeItemInput(input);
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.item.create',
    'energy_balance_item',
    () => {
      requireBoundaryRow(db, boundaryId);
      const energyType = validateEnergyType(db, normalized.energyTypeId);
      validateEnergyUnit(energyType, normalized.originalUnit);
      validateGenerationAntiDoubleCountKey(
        db,
        boundaryId,
        normalized.generationAntiDoubleCountKey
      );
      const now = new Date().toISOString();
      try {
        const insertResult = db.prepare(
          `INSERT INTO energy_balance_items (
             energy_balance_boundary_id, item_code, item_name, role, energy_type_id,
             original_unit, source_type, source_mapping_json,
             generation_anti_double_count_key, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        ).run(
          boundaryId,
          normalized.itemCode,
          normalized.itemName,
          normalized.role,
          normalized.energyTypeId,
          normalized.originalUnit,
          normalized.sourceType,
          JSON.stringify(normalized.sourceMapping),
          normalized.generationAntiDoubleCountKey,
          now,
          now
        );
        const item = mapItemRow(requireItemRow(db, boundaryId, Number(insertResult.lastInsertRowid)));
        return { result: item, targetId: item.id, beforeState: null, afterState: item };
      } catch (error) {
        throwConflictForConstraint(error, '同一边界下 itemCode 已存在。', {
          boundaryId,
          itemCode: normalized.itemCode
        });
      }
    }
  ), options);
}

/**
 * 更新平衡项目。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} itemIdValue 项目 ID。
 * @param {*} input 更新输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 更新后项目。
 */
function updateBalanceItem(boundaryIdValue, itemIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  const itemId = normalizePositiveInteger(itemIdValue, 'itemId');
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.item.update',
    'energy_balance_item',
    () => {
      const existing = mapItemRow(requireItemRow(db, boundaryId, itemId));
      const normalized = normalizeItemInput(input, existing);
      const energyType = validateEnergyType(db, normalized.energyTypeId);
      validateEnergyUnit(energyType, normalized.originalUnit);
      validateGenerationAntiDoubleCountKey(
        db,
        boundaryId,
        normalized.generationAntiDoubleCountKey,
        itemId
      );
      const now = new Date().toISOString();
      try {
        db.prepare(
          `UPDATE energy_balance_items
           SET item_code = ?, item_name = ?, role = ?, energy_type_id = ?,
               original_unit = ?, source_type = ?, source_mapping_json = ?,
               generation_anti_double_count_key = ?, updated_at = ?
           WHERE id = ? AND energy_balance_boundary_id = ?`
        ).run(
          normalized.itemCode,
          normalized.itemName,
          normalized.role,
          normalized.energyTypeId,
          normalized.originalUnit,
          normalized.sourceType,
          JSON.stringify(normalized.sourceMapping),
          normalized.generationAntiDoubleCountKey,
          now,
          itemId,
          boundaryId
        );
        const updated = mapItemRow(requireItemRow(db, boundaryId, itemId));
        return { result: updated, targetId: itemId, beforeState: existing, afterState: updated };
      } catch (error) {
        throwConflictForConstraint(error, '同一边界下 itemCode 已存在。', {
          boundaryId,
          itemCode: normalized.itemCode
        });
      }
    }
  ), options);
}

/**
 * 启用或停用平衡项目。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} itemIdValue 项目 ID。
 * @param {*} input 状态输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 更新后项目。
 */
function setBalanceItemStatus(boundaryIdValue, itemIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  const itemId = normalizePositiveInteger(itemIdValue, 'itemId');
  if (!isPlainObject(input)) throw badRequest('项目状态输入必须是对象。');
  const status = normalizeMasterStatus(input.status);
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.item.status',
    'energy_balance_item',
    () => {
      const existing = mapItemRow(requireItemRow(db, boundaryId, itemId));
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE energy_balance_items SET status = ?, updated_at = ?
         WHERE id = ? AND energy_balance_boundary_id = ?`
      ).run(status, now, itemId, boundaryId);
      const updated = mapItemRow(requireItemRow(db, boundaryId, itemId));
      return { result: updated, targetId: itemId, beforeState: existing, afterState: updated };
    }
  ), options);
}

/**
 * 计算时间区间在窗口内的裁剪结果。
 * @param {string} startUtc 来源开始时间。
 * @param {string} endUtc 来源结束时间。
 * @param {number} windowStartMs 窗口开始毫秒。
 * @param {number} windowEndMs 窗口结束毫秒。
 * @returns {object|null} 裁剪区间。
 */
function clipInterval(startUtc, endUtc, windowStartMs, windowEndMs) {
  const sourceStartMs = Date.parse(startUtc);
  const sourceEndMs = Date.parse(endUtc);
  if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs) || sourceStartMs >= sourceEndMs) {
    return null;
  }
  const startMs = Math.max(sourceStartMs, windowStartMs);
  const endMs = Math.min(sourceEndMs, windowEndMs);
  if (startMs >= endMs) return null;
  return { startMs, endMs, sourceStartMs, sourceEndMs };
}

/**
 * 计算区间集合的去重覆盖毫秒数和重叠状态。
 * @param {object[]} intervals 已裁剪区间。
 * @returns {{ coveredMs: number, overlap: boolean }} 覆盖结果。
 */
function summarizeIntervals(intervals) {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let coveredMs = 0;
  let overlap = false;
  let currentStart = null;
  let currentEnd = null;
  sorted.forEach((interval) => {
    if (currentStart === null) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      return;
    }
    if (interval.startMs < currentEnd) {
      overlap = true;
      currentEnd = Math.max(currentEnd, interval.endMs);
      return;
    }
    coveredMs += currentEnd - currentStart;
    currentStart = interval.startMs;
    currentEnd = interval.endMs;
  });
  if (currentStart !== null) coveredMs += currentEnd - currentStart;
  return { coveredMs, overlap };
}

/**
 * 将 UTC 时刻格式化为来源时区的 YYYY-MM。
 * @param {number} timestampMs UTC 毫秒。
 * @param {string} sourceTimeZone 来源时区。
 * @returns {string} 月份。
 */
function formatMonthInTimeZone(timestampMs, sourceTimeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: sourceTimeZone,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date(timestampMs));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

/**
 * 读取 UTC 时刻在来源时区对应的日历字段。
 * @param {number} timestampMs UTC 毫秒。
 * @param {string} sourceTimeZone 来源时区。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}} 日历字段。
 */
function getZonedDateTimeParts(timestampMs, sourceTimeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: sourceTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestampMs));
  const readPart = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
    second: readPart('second')
  };
}

/**
 * 断言月度台账来源窗口按来源时区从自然月首零点到下一月首零点完整对齐。
 * @param {object} calculationWindow 计算窗口。
 */
function assertFullSourceMonthWindow(calculationWindow) {
  const startParts = getZonedDateTimeParts(calculationWindow.startMs, calculationWindow.sourceTimeZone);
  const endParts = getZonedDateTimeParts(calculationWindow.endMs, calculationWindow.sourceTimeZone);
  const isMonthBoundary = (parts, timestampMs) => parts.day === 1
    && parts.hour === 0
    && parts.minute === 0
    && parts.second === 0
    && timestampMs % 1000 === 0;
  if (!isMonthBoundary(startParts, calculationWindow.startMs)
    || !isMonthBoundary(endParts, calculationWindow.endMs)) {
    throw badRequest('月度能耗和发电来源仅允许按来源时区完整自然月对齐窗口。', {
      code: 'BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH',
      sourceTimeZone: calculationWindow.sourceTimeZone,
      startUtc: calculationWindow.startUtc,
      endUtc: calculationWindow.endUtc
    });
  }
}

/**
 * 列出左闭右开窗口覆盖的来源时区月份。
 * @param {number} startMs 开始毫秒。
 * @param {number} endMs 结束毫秒。
 * @param {string} sourceTimeZone 来源时区。
 * @returns {string[]} 月份列表。
 */
function listExpectedMonths(startMs, endMs, sourceTimeZone) {
  const startMonth = formatMonthInTimeZone(startMs, sourceTimeZone);
  const endMonth = formatMonthInTimeZone(endMs - 1, sourceTimeZone);
  const [startYear, startMonthNumber] = startMonth.split('-').map(Number);
  const [endYear, endMonthNumber] = endMonth.split('-').map(Number);
  const months = [];
  let year = startYear;
  let month = startMonthNumber;
  while (year < endYear || (year === endYear && month <= endMonthNumber)) {
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return months;
}

/**
 * 判断来源组织是否属于边界组织范围。
 * @param {object|null} boundaryOrganization 边界组织。
 * @param {string|null} sourceOrganizationPath 来源组织路径。
 * @returns {boolean} 是否属于范围。
 */
function isSourceInBoundary(boundaryOrganization, sourceOrganizationPath) {
  if (!boundaryOrganization) return true;
  if (typeof sourceOrganizationPath !== 'string' || sourceOrganizationPath.trim() === '') return false;
  const boundaryPath = boundaryOrganization.unitPath;
  return sourceOrganizationPath === boundaryPath
    || sourceOrganizationPath.startsWith(`${boundaryPath}/`);
}

/**
 * 判断显式边起止节点组织是否完整落在边界组织自身或后代范围。
 * @param {object|null} boundaryOrganization 边界组织。
 * @param {string|null} fromOrganizationPath 起点组织路径。
 * @param {string|null} toOrganizationPath 终点组织路径。
 * @returns {boolean} 是否完整位于边界内。
 */
function isExplicitEdgeInBoundary(boundaryOrganization, fromOrganizationPath, toOrganizationPath) {
  return Boolean(boundaryOrganization)
    && isSourceInBoundary(boundaryOrganization, fromOrganizationPath)
    && isSourceInBoundary(boundaryOrganization, toOrganizationPath);
}

/**
 * 将已规范能源值转换为项目原单位，无法比较时返回空值。
 * @param {string} energyTypeCode 能源类型编码。
 * @param {number} value 来源数值。
 * @param {string} sourceUnit 来源单位。
 * @param {string} itemUnit 项目单位。
 * @returns {number|null} 项目单位数值。
 */
function convertValueToItemUnit(energyTypeCode, value, sourceUnit, itemUnit) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (sourceUnit === itemUnit) return value;
  const sourceNormalized = normalizeUnitAndValue(energyTypeCode, sourceUnit, value);
  const itemUnitNormalized = normalizeUnitAndValue(energyTypeCode, itemUnit, 1);
  if (!sourceNormalized || !itemUnitNormalized
    || sourceNormalized.normalizedUnit !== itemUnitNormalized.normalizedUnit
    || !Number.isFinite(itemUnitNormalized.normalizedValue)
    || itemUnitNormalized.normalizedValue <= 0) {
    return null;
  }
  return sourceNormalized.normalizedValue / itemUnitNormalized.normalizedValue;
}

/**
 * 将 ID 列表构造为 SQLite 绑定占位符。
 * @param {number[]} ids ID 列表。
 * @returns {string} 占位符文本。
 */
function idPlaceholders(ids) {
  return ids.map(() => '?').join(', ');
}

/**
 * 解析显式值来源。
 * @param {object} item 平衡项目。
 * @param {object} mapping 来源映射。
 * @param {object} calculationInput 计算输入。
 * @returns {object} 来源解析结果。
 */
function resolveExplicitValue(item, mapping, calculationInput) {
  const explicitValues = isPlainObject(calculationInput.explicitValues)
    ? calculationInput.explicitValues
    : {};
  const overrideValue = Object.prototype.hasOwnProperty.call(explicitValues, String(item.id))
    ? explicitValues[String(item.id)]
    : explicitValues[item.itemCode];
  const rawValue = overrideValue === undefined ? mapping.value : overrideValue;
  if (rawValue === undefined) {
    return {
      value: 0,
      coverageRate: 0,
      sourceRows: [],
      sourceKeys: [],
      reasonCodes: ['BALANCE_ITEM_UNMAPPED'],
      sourceSnapshot: { ...mapping, value: null, valueProvided: false }
    };
  }
  const value = normalizeNonNegativeNumber(rawValue, `explicitValues.${item.itemCode}`);
  return {
    value,
    coverageRate: 1,
    sourceRows: [{ reference: mapping.reference, value }],
    sourceKeys: [`explicit_balance_value:${mapping.reference}`],
    reasonCodes: [],
    sourceSnapshot: { ...mapping, value, valueProvided: true }
  };
}

/**
 * 解析时序来源并按窗口重叠比例分配数值。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} mapping 来源映射。
 * @param {object} boundaryOrganization 边界组织。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 来源解析结果。
 */
function resolveTimeseriesSource(db, item, mapping, boundaryOrganization, calculationWindow) {
  const conditions = ['record.record_status = \'active\''];
  const params = [];
  if (mapping.recordIds) {
    conditions.push(`record.id IN (${idPlaceholders(mapping.recordIds)})`);
    params.push(...mapping.recordIds);
  } else {
    conditions.push('record.source_reference = ?');
    params.push(mapping.sourceReference);
  }
  conditions.push('unixepoch(record.start_utc) < unixepoch(?) AND unixepoch(record.end_utc) > unixepoch(?)');
  params.push(calculationWindow.endUtc, calculationWindow.startUtc);
  const rows = db.prepare(
    `SELECT record.id, record.energy_type_id AS energyTypeId,
            record.organization_unit_id AS organizationUnitId,
            organization.unit_path AS organizationUnitPath,
            record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.normalized_unit AS unit, record.normalized_value AS value,
            record.source_reference AS sourceReference
     FROM energy_timeseries_records AS record
     LEFT JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY record.start_utc ASC, record.id ASC
     LIMIT ?`
  ).all(...params, MAX_SOURCE_RECORDS + 1);
  if (rows.length > MAX_SOURCE_RECORDS) {
    throw badRequest('时序来源记录超过单次计算上限。', {
      code: 'BALANCE_SOURCE_RECORD_LIMIT_EXCEEDED',
      maximum: MAX_SOURCE_RECORDS
    });
  }
  const intervals = [];
  const sourceRows = [];
  const reasonCodes = [];
  let totalValue = 0;
  rows.forEach((row) => {
    const clipped = clipInterval(
      row.startUtc,
      row.endUtc,
      calculationWindow.startMs,
      calculationWindow.endMs
    );
    if (!clipped) return;
    if (Number(row.energyTypeId) !== item.energyType.id
      || !isSourceInBoundary(boundaryOrganization, row.organizationUnitPath)) {
      reasonCodes.push('BALANCE_ITEM_UNMAPPED');
      return;
    }
    const sourceValueInItemUnit = convertValueToItemUnit(
      item.energyType.code,
      Number(row.value),
      row.unit,
      item.originalUnit
    );
    if (sourceValueInItemUnit === null) {
      reasonCodes.push('UNIT_NOT_COMPARABLE');
      return;
    }
    const sourceDurationMs = clipped.sourceEndMs - clipped.sourceStartMs;
    const allocatedValue = sourceValueInItemUnit * (clipped.endMs - clipped.startMs) / sourceDurationMs;
    if (!Number.isFinite(allocatedValue) || !Number.isFinite(totalValue + allocatedValue)) {
      reasonCodes.push('UNIT_NOT_COMPARABLE');
      return;
    }
    totalValue += allocatedValue;
    intervals.push(clipped);
    sourceRows.push({
      id: Number(row.id),
      startUtc: row.startUtc,
      endUtc: row.endUtc,
      allocatedValue: roundAnalysisValue(allocatedValue),
      sourceReference: row.sourceReference
    });
  });
  const intervalSummary = summarizeIntervals(intervals);
  if (intervalSummary.overlap) reasonCodes.push('SOURCE_OVERLAP_OR_DUPLICATE');
  const coverageRate = roundAnalysisValue(
    intervalSummary.coveredMs / (calculationWindow.endMs - calculationWindow.startMs)
  ) ?? 0;
  if (coverageRate < 1) reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  if (sourceRows.length === 0) reasonCodes.push('NO_TIMESERIES_DATA');
  return {
    value: roundAnalysisValue(totalValue) ?? 0,
    coverageRate,
    sourceRows,
    sourceKeys: sourceRows.map((row) => `timeseries:${row.id}`),
    reasonCodes: normalizeReasonCodes(reasonCodes),
    sourceSnapshot: { ...mapping, resolvedRecordIds: sourceRows.map((row) => row.id) }
  };
}

/**
 * 解析月度能耗来源。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} mapping 来源映射。
 * @param {object} boundaryOrganization 边界组织。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 来源解析结果。
 */
function resolveMonthlySource(db, item, mapping, boundaryOrganization, calculationWindow) {
  assertFullSourceMonthWindow(calculationWindow);
  const expectedMonths = listExpectedMonths(
    calculationWindow.startMs,
    calculationWindow.endMs,
    calculationWindow.sourceTimeZone
  );
  const rows = db.prepare(
    `SELECT record.id, record.energy_type_id AS energyTypeId,
            record.organization_unit_id AS organizationUnitId,
            organization.unit_path AS organizationUnitPath,
            record.normalized_month AS normalizedMonth,
            record.normalized_unit AS unit, record.normalized_value AS value
     FROM energy_records AS record
     LEFT JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE record.id IN (${idPlaceholders(mapping.recordIds)})
       AND record.record_status = 'active'
     ORDER BY record.normalized_month ASC, record.id ASC
     LIMIT ?`
  ).all(...mapping.recordIds, MAX_SOURCE_RECORDS + 1);
  const sourceRows = [];
  const reasonCodes = [];
  let totalValue = 0;
  rows.forEach((row) => {
    if (!expectedMonths.includes(row.normalizedMonth)
      || Number(row.energyTypeId) !== item.energyType.id
      || !isSourceInBoundary(boundaryOrganization, row.organizationUnitPath)) {
      reasonCodes.push('BALANCE_ITEM_UNMAPPED');
      return;
    }
    const convertedValue = convertValueToItemUnit(
      item.energyType.code,
      Number(row.value),
      row.unit,
      item.originalUnit
    );
    if (convertedValue === null) {
      reasonCodes.push('UNIT_NOT_COMPARABLE');
      return;
    }
    totalValue += convertedValue;
    sourceRows.push({ id: Number(row.id), month: row.normalizedMonth, value: roundAnalysisValue(convertedValue) });
  });
  const coveredMonths = new Set(sourceRows.map((row) => row.month));
  const coverageRate = expectedMonths.length === 0
    ? 0
    : roundAnalysisValue(coveredMonths.size / expectedMonths.length);
  if (sourceRows.length === 0) reasonCodes.push('BALANCE_ITEM_UNMAPPED');
  if (coverageRate < 1) reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  return {
    value: roundAnalysisValue(totalValue) ?? 0,
    coverageRate: coverageRate ?? 0,
    sourceRows,
    sourceKeys: sourceRows.map((row) => `monthly_energy:${row.id}`),
    reasonCodes: normalizeReasonCodes(reasonCodes),
    sourceSnapshot: { ...mapping, expectedMonths, resolvedRecordIds: sourceRows.map((row) => row.id) }
  };
}

/**
 * 解析发电来源，只读取角色对应的显式字段。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} mapping 来源映射。
 * @param {object} boundaryOrganization 边界组织。
 * @param {object} calculationWindow 计算窗口。
 * @param {boolean} generationBoundaryConfirmed 发电边界是否确认。
 * @returns {object} 来源解析结果。
 */
function resolveGenerationSource(
  db,
  item,
  mapping,
  boundaryOrganization,
  calculationWindow,
  generationBoundaryConfirmed
) {
  assertFullSourceMonthWindow(calculationWindow);
  const reasonCodes = [];
  if (!generationBoundaryConfirmed) reasonCodes.push('GENERATION_BOUNDARY_UNCONFIRMED');
  const expectedMonths = listExpectedMonths(
    calculationWindow.startMs,
    calculationWindow.endMs,
    calculationWindow.sourceTimeZone
  );
  const valueColumn = mapping.valueField;
  const rows = db.prepare(
    `SELECT record.id, record.energy_type_id AS energyTypeId,
            record.organization_unit_id AS organizationUnitId,
            organization.unit_path AS organizationUnitPath,
            record.normalized_month AS normalizedMonth,
            record.${valueColumn} AS value
     FROM generation_records AS record
     JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE record.id IN (${idPlaceholders(mapping.recordIds)})
       AND record.record_status = 'active'
     ORDER BY record.normalized_month ASC, record.id ASC
     LIMIT ?`
  ).all(...mapping.recordIds, MAX_SOURCE_RECORDS + 1);
  const sourceRows = [];
  let totalValue = 0;
  rows.forEach((row) => {
    if (!expectedMonths.includes(row.normalizedMonth)
      || Number(row.energyTypeId) !== item.energyType.id
      || !isSourceInBoundary(boundaryOrganization, row.organizationUnitPath)) {
      reasonCodes.push('BALANCE_ITEM_UNMAPPED');
      return;
    }
    const convertedValue = convertValueToItemUnit(
      item.energyType.code,
      Number(row.value),
      'kWh',
      item.originalUnit
    );
    if (convertedValue === null) {
      reasonCodes.push('UNIT_NOT_COMPARABLE');
      return;
    }
    totalValue += convertedValue;
    sourceRows.push({ id: Number(row.id), month: row.normalizedMonth, value: roundAnalysisValue(convertedValue) });
  });
  const coveredMonths = new Set(sourceRows.map((row) => row.month));
  const coverageRate = expectedMonths.length === 0
    ? 0
    : roundAnalysisValue(coveredMonths.size / expectedMonths.length);
  if (sourceRows.length === 0) reasonCodes.push('BALANCE_ITEM_UNMAPPED');
  if (coverageRate < 1) reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  return {
    value: roundAnalysisValue(totalValue) ?? 0,
    coverageRate: coverageRate ?? 0,
    sourceRows,
    sourceKeys: sourceRows.map((row) => `generation:${row.id}:${valueColumn}`),
    reasonCodes: normalizeReasonCodes(reasonCodes),
    sourceSnapshot: {
      ...mapping,
      expectedMonths,
      resolvedRecordIds: sourceRows.map((row) => row.id),
      generationAntiDoubleCountKey: item.generationAntiDoubleCountKey
    }
  };
}

/**
 * 解析显式能流边值来源。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} mapping 来源映射。
 * @param {object|null} boundaryOrganization 边界组织。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 来源解析结果。
 */
function resolveExplicitEdgeSource(db, item, mapping, boundaryOrganization, calculationWindow) {
  const rows = db.prepare(
    `SELECT record.id, record.energy_flow_edge_id AS edgeId,
            record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.original_unit AS unit, record.original_value AS value,
            edge.energy_type_id AS energyTypeId, edge.source_type AS edgeSourceType,
            from_organization.unit_path AS fromOrganizationPath,
            to_organization.unit_path AS toOrganizationPath
     FROM energy_flow_records AS record
     JOIN energy_flow_edges AS edge ON edge.id = record.energy_flow_edge_id
     JOIN energy_flow_nodes AS from_node ON from_node.id = edge.from_node_id
       AND from_node.energy_flow_model_id = edge.energy_flow_model_id
     JOIN energy_flow_nodes AS to_node ON to_node.id = edge.to_node_id
       AND to_node.energy_flow_model_id = edge.energy_flow_model_id
     LEFT JOIN organization_units AS from_organization ON from_organization.id = from_node.organization_unit_id
     LEFT JOIN organization_units AS to_organization ON to_organization.id = to_node.organization_unit_id
     WHERE record.id IN (${idPlaceholders(mapping.recordIds)})
       AND record.record_status = 'active'
       AND record.source_type = 'explicit_edge_value'
       AND edge.source_type = 'explicit_edge_value'
       AND unixepoch(record.start_utc) < unixepoch(?)
       AND unixepoch(record.end_utc) > unixepoch(?)
     ORDER BY record.start_utc ASC, record.id ASC
     LIMIT ?`
  ).all(...mapping.recordIds, calculationWindow.endUtc, calculationWindow.startUtc, MAX_SOURCE_RECORDS + 1);
  const sourceRows = [];
  const intervals = [];
  const reasonCodes = [];
  let totalValue = 0;
  rows.forEach((row) => {
    const clipped = clipInterval(
      row.startUtc,
      row.endUtc,
      calculationWindow.startMs,
      calculationWindow.endMs
    );
    if (!clipped || Number(row.energyTypeId) !== item.energyType.id
      || !isExplicitEdgeInBoundary(
        boundaryOrganization,
        row.fromOrganizationPath,
        row.toOrganizationPath
      )) {
      reasonCodes.push('BALANCE_ITEM_UNMAPPED');
      return;
    }
    const convertedValue = convertValueToItemUnit(
      item.energyType.code,
      Number(row.value),
      row.unit,
      item.originalUnit
    );
    if (convertedValue === null) {
      reasonCodes.push('UNIT_NOT_COMPARABLE');
      return;
    }
    const allocatedValue = convertedValue
      * (clipped.endMs - clipped.startMs)
      / (clipped.sourceEndMs - clipped.sourceStartMs);
    totalValue += allocatedValue;
    intervals.push(clipped);
    sourceRows.push({
      id: Number(row.id),
      edgeId: Number(row.edgeId),
      startUtc: row.startUtc,
      endUtc: row.endUtc,
      allocatedValue: roundAnalysisValue(allocatedValue)
    });
  });
  const intervalSummary = summarizeIntervals(intervals);
  if (intervalSummary.overlap) reasonCodes.push('SOURCE_OVERLAP_OR_DUPLICATE');
  const coverageRate = roundAnalysisValue(
    intervalSummary.coveredMs / (calculationWindow.endMs - calculationWindow.startMs)
  ) ?? 0;
  if (sourceRows.length === 0) reasonCodes.push('BALANCE_ITEM_UNMAPPED');
  if (coverageRate < 1) reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
  return {
    value: roundAnalysisValue(totalValue) ?? 0,
    coverageRate,
    sourceRows,
    sourceKeys: sourceRows.map((row) => `explicit_edge_value:${row.id}`),
    reasonCodes: normalizeReasonCodes(reasonCodes),
    sourceSnapshot: { ...mapping, resolvedRecordIds: sourceRows.map((row) => row.id) }
  };
}

/**
 * 解析一个平衡项目的显式数据来源。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} boundary 边界。
 * @param {object|null} boundaryOrganization 边界组织。
 * @param {object} calculationInput 计算输入。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 来源解析结果。
 */
function resolveItemSource(db, item, boundary, boundaryOrganization, calculationInput, calculationWindow) {
  const mapping = item.sourceMapping;
  if (item.sourceType === 'explicit_balance_value') {
    return resolveExplicitValue(item, mapping, calculationInput);
  }
  if (item.sourceType === 'timeseries') {
    return resolveTimeseriesSource(db, item, mapping, boundaryOrganization, calculationWindow);
  }
  if (item.sourceType === 'monthly_energy') {
    return resolveMonthlySource(db, item, mapping, boundaryOrganization, calculationWindow);
  }
  if (item.sourceType === 'generation') {
    return resolveGenerationSource(
      db,
      item,
      mapping,
      boundaryOrganization,
      calculationWindow,
      boundary.generationBoundaryConfirmed
    );
  }
  return resolveExplicitEdgeSource(db, item, mapping, boundaryOrganization, calculationWindow);
}

/**
 * 读取和项目单位精确匹配的有效折标系数。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object[]} 折标系数列表。
 */
function loadConversionFactors(db, item, calculationWindow) {
  return db.prepare(
    `SELECT id, factor_code AS factorCode, factor_value AS factorValue,
            version, effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, source_timezone AS sourceTimeZone
     FROM energy_conversion_factors
     WHERE energy_type_id = ? AND source_unit = ? AND target_unit = 'kgce'
       AND status = 'active'
       AND unixepoch(effective_start_utc) < unixepoch(?)
       AND unixepoch(effective_end_utc) > unixepoch(?)
     ORDER BY effective_start_utc ASC, id ASC`
  ).all(item.energyType.id, item.originalUnit, calculationWindow.endUtc, calculationWindow.startUtc);
}

/**
 * 选择某一 UTC 片段唯一生效的折标系数。
 * @param {object[]} factors 系数列表。
 * @param {number} startMs 片段开始毫秒。
 * @param {number} endMs 片段结束毫秒。
 * @returns {{ factor: object|null, reasonCode: string|null }} 选择结果。
 */
function selectFactorForInterval(factors, startMs, endMs) {
  const matches = factors.filter((factor) => (
    Date.parse(factor.effectiveStartUtc) <= startMs
    && Date.parse(factor.effectiveEndUtc) >= endMs
  ));
  if (matches.length === 0) return { factor: null, reasonCode: 'MISSING_CONVERSION_FACTOR' };
  if (matches.length > 1) return { factor: null, reasonCode: 'FACTOR_PERIOD_AMBIGUOUS' };
  return { factor: matches[0], reasonCode: null };
}

/**
 * 将区间来源按 UTC 系数有效期精确分段折标。
 * @param {object} sourceResult 来源结果。
 * @param {object[]} factors 系数列表。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 折标结果。
 */
function convertIntervalSourceToKgce(sourceResult, factors, calculationWindow) {
  const boundaries = new Set([calculationWindow.startMs, calculationWindow.endMs]);
  factors.forEach((factor) => {
    const factorStartMs = Date.parse(factor.effectiveStartUtc);
    const factorEndMs = Date.parse(factor.effectiveEndUtc);
    if (factorStartMs > calculationWindow.startMs && factorStartMs < calculationWindow.endMs) {
      boundaries.add(factorStartMs);
    }
    if (factorEndMs > calculationWindow.startMs && factorEndMs < calculationWindow.endMs) {
      boundaries.add(factorEndMs);
    }
  });
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const applications = [];
  const reasonCodes = [];
  let kgce = 0;
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const segmentStartMs = sortedBoundaries[index];
    const segmentEndMs = sortedBoundaries[index + 1];
    const selection = selectFactorForInterval(factors, segmentStartMs, segmentEndMs);
    if (selection.reasonCode) {
      reasonCodes.push(selection.reasonCode);
      continue;
    }
    let segmentSourceValue = 0;
    sourceResult.sourceRows.forEach((row) => {
      if (!row.startUtc || !row.endUtc) return;
      const rowStartMs = Date.parse(row.startUtc);
      const rowEndMs = Date.parse(row.endUtc);
      const overlapStartMs = Math.max(segmentStartMs, rowStartMs, calculationWindow.startMs);
      const overlapEndMs = Math.min(segmentEndMs, rowEndMs, calculationWindow.endMs);
      if (overlapStartMs >= overlapEndMs) return;
      const allocatedBase = Number(row.allocatedValue);
      const clippedDurationMs = Math.min(rowEndMs, calculationWindow.endMs)
        - Math.max(rowStartMs, calculationWindow.startMs);
      if (Number.isFinite(allocatedBase) && clippedDurationMs > 0) {
        segmentSourceValue += allocatedBase * (overlapEndMs - overlapStartMs) / clippedDurationMs;
      }
    });
    const segmentKgce = segmentSourceValue * Number(selection.factor.factorValue);
    kgce += segmentKgce;
    applications.push({
      conversionFactorId: Number(selection.factor.id),
      factorCode: selection.factor.factorCode,
      version: selection.factor.version,
      factorValue: Number(selection.factor.factorValue),
      effectiveStartUtc: selection.factor.effectiveStartUtc,
      effectiveEndUtc: selection.factor.effectiveEndUtc,
      sourceValue: roundAnalysisValue(segmentSourceValue),
      kgce: roundAnalysisValue(segmentKgce)
    });
  }
  const normalizedReasons = normalizeReasonCodes(reasonCodes);
  if (normalizedReasons.length > 0) {
    return { kgce: null, tce: null, applications: [], reasonCodes: normalizedReasons };
  }
  return {
    kgce: roundAnalysisValue(kgce),
    tce: roundAnalysisValue(kgce / 1000),
    applications,
    reasonCodes: []
  };
}

/**
 * 将月度、发电或显式总量按整个统计期唯一系数折标。
 * @param {object} sourceResult 来源结果。
 * @param {object[]} factors 系数列表。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 折标结果。
 */
function convertAggregateSourceToKgce(sourceResult, factors, calculationWindow) {
  const selection = selectFactorForInterval(
    factors,
    calculationWindow.startMs,
    calculationWindow.endMs
  );
  if (selection.reasonCode) {
    const overlappingFactors = factors.filter((factor) => (
      Date.parse(factor.effectiveStartUtc) < calculationWindow.endMs
      && Date.parse(factor.effectiveEndUtc) > calculationWindow.startMs
    ));
    const reasonCode = overlappingFactors.length > 1
      ? 'FACTOR_PERIOD_AMBIGUOUS'
      : selection.reasonCode;
    return { kgce: null, tce: null, applications: [], reasonCodes: [reasonCode] };
  }
  const factor = selection.factor;
  const kgce = roundAnalysisValue(sourceResult.value * Number(factor.factorValue));
  return {
    kgce,
    tce: roundAnalysisValue(kgce / 1000),
    applications: [{
      conversionFactorId: Number(factor.id),
      factorCode: factor.factorCode,
      version: factor.version,
      factorValue: Number(factor.factorValue),
      effectiveStartUtc: factor.effectiveStartUtc,
      effectiveEndUtc: factor.effectiveEndUtc,
      sourceValue: sourceResult.value,
      kgce
    }],
    reasonCodes: []
  };
}

/**
 * 对项目来源结果执行折标；任何歧义或缺失均冻结该项目 kgce。
 * @param {object} db SQLite 连接。
 * @param {object} item 平衡项目。
 * @param {object} sourceResult 来源结果。
 * @param {object} calculationWindow 计算窗口。
 * @returns {object} 折标结果。
 */
function convertItemToKgce(db, item, sourceResult, calculationWindow) {
  if (sourceResult.reasonCodes.includes('UNIT_NOT_COMPARABLE')
    || sourceResult.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE')) {
    return { kgce: null, tce: null, applications: [], reasonCodes: sourceResult.reasonCodes };
  }
  const factors = loadConversionFactors(db, item, calculationWindow);
  const intervalSource = item.sourceType === 'timeseries' || item.sourceType === 'explicit_edge_value';
  return intervalSource
    ? convertIntervalSourceToKgce(sourceResult, factors, calculationWindow)
    : convertAggregateSourceToKgce(sourceResult, factors, calculationWindow);
}

/**
 * 汇总角色数值。
 * @param {object[]} items 已解析项目。
 * @param {string} role 角色。
 * @param {string} valueField 数值字段。
 * @returns {number} 汇总值。
 */
function sumRole(items, role, valueField) {
  return roundAnalysisValue(items
    .filter((item) => item.role === role && Number.isFinite(item[valueField]))
    .reduce((sum, item) => sum + item[valueField], 0)) ?? 0;
}

/**
 * 构造原单位分面计算结果。
 * @param {object[]} resolvedItems 已解析项目。
 * @param {object} boundary 边界。
 * @returns {object[]} 分面结果。
 */
function buildOriginalFacets(resolvedItems, boundary) {
  const facetMap = new Map();
  resolvedItems.forEach((item) => {
    const key = `${item.energyType.id}|${item.originalUnit}`;
    if (!facetMap.has(key)) facetMap.set(key, []);
    facetMap.get(key).push(item);
  });
  return [...facetMap.values()].map((facetItems) => {
    const first = facetItems[0];
    const algorithmItems = facetItems.map((item) => ({
      id: item.id,
      role: item.role,
      energyTypeCode: item.energyType.code,
      unit: item.originalUnit,
      value: item.originalValue,
      sourceMapping: { type: item.sourceType, reference: item.sourceMapping.reference },
      generationAntiDoubleCountKey: item.generationAntiDoubleCountKey
    }));
    const algorithmResult = calculateEnergyBalance(algorithmItems, {
      generationBoundaryConfirmed: boundary.generationBoundaryConfirmed
    });
    const sourceReasons = normalizeReasonCodes(facetItems.flatMap((item) => item.reasonCodes));
    const reasonCodes = normalizeReasonCodes([...algorithmResult.reasonCodes, ...sourceReasons]);
    const completenessRate = roundAnalysisValue(Math.min(...facetItems.map((item) => item.coverageRate))) ?? 0;
    if (completenessRate < 1 && !reasonCodes.includes('COVERAGE_BELOW_THRESHOLD')) {
      reasonCodes.push('COVERAGE_BELOW_THRESHOLD');
    }
    const inputTotalOriginal = algorithmResult.inputTotal ?? sumRole(facetItems, 'input', 'originalValue')
      + sumRole(facetItems, 'self_generation', 'originalValue')
      + sumRole(facetItems, 'inventory_decrease', 'originalValue')
      + sumRole(facetItems, 'adjustment_increase', 'originalValue');
    const outputTotalOriginal = algorithmResult.outputTotal ?? sumRole(facetItems, 'output', 'originalValue')
      + sumRole(facetItems, 'useful_utilization', 'originalValue')
      + sumRole(facetItems, 'known_loss', 'originalValue')
      + sumRole(facetItems, 'inventory_increase', 'originalValue')
      + sumRole(facetItems, 'adjustment_decrease', 'originalValue');
    const unexplainedOriginal = roundAnalysisValue(inputTotalOriginal - outputTotalOriginal) ?? 0;
    return {
      energyTypeId: first.energyType.id,
      energyTypeCode: first.energyType.code,
      energyTypeName: first.energyType.name,
      originalUnit: first.originalUnit,
      items: facetItems,
      inputTotalOriginal: roundAnalysisValue(inputTotalOriginal) ?? 0,
      outputTotalOriginal: roundAnalysisValue(outputTotalOriginal) ?? 0,
      unexplainedOriginal,
      storageChangeOriginal: roundAnalysisValue(
        sumRole(facetItems, 'inventory_increase', 'originalValue')
        - sumRole(facetItems, 'inventory_decrease', 'originalValue')
      ),
      knownLossOriginal: sumRole(facetItems, 'known_loss', 'originalValue'),
      utilizationRate: reasonCodes.length === 0 ? algorithmResult.utilizationRate : null,
      lossRate: reasonCodes.length === 0 ? algorithmResult.lossRate : null,
      imbalanceRate: reasonCodes.length === 0 ? algorithmResult.imbalanceRate : null,
      completenessRate,
      calculationStatus: reasonCodes.length === 0 ? 'available' : 'frozen',
      reasonCodes
    };
  });
}

/**
 * 计算单个分面的 kgce 汇总，任一项目折标失败时整体冻结。
 * @param {object} facet 原单位分面。
 * @returns {object} 分面折标汇总。
 */
function buildFacetStandardCoal(facet) {
  const conversionReasons = normalizeReasonCodes(facet.items.flatMap((item) => item.conversion.reasonCodes));
  const complete = conversionReasons.length === 0
    && facet.items.every((item) => Number.isFinite(item.kgceValue));
  if (!complete) {
    return {
      inputTotalKgce: null,
      outputTotalKgce: null,
      storageChangeKgce: null,
      unexplainedKgce: null,
      tce: null,
      factorVersions: null,
      reasonCodes: conversionReasons.length > 0 ? conversionReasons : ['MISSING_CONVERSION_FACTOR']
    };
  }
  const algorithmItems = facet.items.map((item) => ({
    role: item.role,
    energyTypeCode: STANDARD_COAL_SCOPE_CODE,
    unit: 'kgce',
    value: item.kgceValue,
    sourceMapping: { type: item.sourceType, reference: item.sourceMapping.reference },
    generationAntiDoubleCountKey: item.generationAntiDoubleCountKey
  }));
  const result = calculateEnergyBalance(algorithmItems, { generationBoundaryConfirmed: true });
  const factorVersionEntries = facet.items.flatMap((item) => item.conversion.applications)
    .map((application) => [
      `${application.factorCode}@${application.effectiveStartUtc}`,
      application.version
    ]);
  const factorVersions = Object.fromEntries(factorVersionEntries);
  return {
    inputTotalKgce: result.inputTotal,
    outputTotalKgce: result.outputTotal,
    storageChangeKgce: roundAnalysisValue(
      sumRole(facet.items, 'inventory_increase', 'kgceValue')
      - sumRole(facet.items, 'inventory_decrease', 'kgceValue')
    ),
    unexplainedKgce: result.unexplainedDifference,
    tce: result.value === null ? null : roundAnalysisValue(result.value / 1000),
    factorVersions,
    reasonCodes: result.reasonCodes
  };
}

/**
 * 构造跨能源类型综合 kgce/tce 结果。
 * @param {object[]} resolvedItems 已解析和折标项目。
 * @returns {object} 综合结果。
 */
function buildComprehensiveStandardCoal(resolvedItems) {
  const completenessRate = roundAnalysisValue(
    Math.min(...resolvedItems.map((item) => item.coverageRate))
  ) ?? 0;
  const reasonCodes = normalizeReasonCodes(resolvedItems.flatMap((item) => [
    ...item.reasonCodes,
    ...item.conversion.reasonCodes
  ]));
  const complete = reasonCodes.length === 0
    && resolvedItems.every((item) => Number.isFinite(item.kgceValue));
  if (!complete) {
    return {
      calculationStatus: 'frozen',
      unit: 'kgce',
      displayUnit: 'tce',
      inputTotalKgce: null,
      outputTotalKgce: null,
      storageChangeKgce: null,
      unexplainedKgce: null,
      inputTotalTce: null,
      outputTotalTce: null,
      unexplainedTce: null,
      utilizationRate: null,
      lossRate: null,
      imbalanceRate: null,
      completenessRate,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['MISSING_CONVERSION_FACTOR']
    };
  }
  const items = resolvedItems.map((item) => ({
    role: item.role,
    energyTypeCode: STANDARD_COAL_SCOPE_CODE,
    unit: 'kgce',
    value: item.kgceValue,
    sourceMapping: { type: item.sourceType, reference: item.sourceMapping.reference },
    generationAntiDoubleCountKey: item.generationAntiDoubleCountKey
  }));
  const result = calculateEnergyBalance(items, { generationBoundaryConfirmed: true });
  return {
    calculationStatus: result.reasonCodes.length === 0 ? 'available' : 'frozen',
    unit: 'kgce',
    displayUnit: 'tce',
    inputTotalKgce: result.inputTotal,
    outputTotalKgce: result.outputTotal,
    storageChangeKgce: roundAnalysisValue(
      sumRole(resolvedItems, 'inventory_increase', 'kgceValue')
      - sumRole(resolvedItems, 'inventory_decrease', 'kgceValue')
    ),
    unexplainedKgce: result.unexplainedDifference,
    inputTotalTce: result.inputTotal === null ? null : roundAnalysisValue(result.inputTotal / 1000),
    outputTotalTce: result.outputTotal === null ? null : roundAnalysisValue(result.outputTotal / 1000),
    unexplainedTce: result.unexplainedDifference === null
      ? null
      : roundAnalysisValue(result.unexplainedDifference / 1000),
    utilizationRate: result.utilizationRate,
    lossRate: result.lossRate,
    imbalanceRate: result.imbalanceRate,
    completenessRate,
    reasonCodes: result.reasonCodes
  };
}

/**
 * 规范计算输入和范围上限。
 * @param {*} input 原始计算输入。
 * @returns {object} 规范计算输入。
 */
function normalizeCalculationInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('平衡计算输入必须是对象。', { code: 'INVALID_BALANCE_CALCULATION_INPUT' });
  }
  const startUtc = normalizeUtc(input.startUtc, 'startUtc');
  const endUtc = normalizeUtc(input.endUtc, 'endUtc');
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('startUtc 必须早于 endUtc。', { code: 'INVALID_BALANCE_CALCULATION_RANGE' });
  }
  if (endMs - startMs > MAX_CALCULATION_DAYS * DAY_MS) {
    throw badRequest(`平衡计算范围不能超过 ${MAX_CALCULATION_DAYS} 天。`, {
      code: 'BALANCE_CALCULATION_RANGE_EXCEEDED',
      maximumDays: MAX_CALCULATION_DAYS
    });
  }
  if (input.explicitValues !== undefined && !isPlainObject(input.explicitValues)) {
    throw badRequest('explicitValues 必须是对象。', { code: 'INVALID_BALANCE_EXPLICIT_VALUES' });
  }
  return {
    startUtc,
    endUtc,
    startMs,
    endMs,
    explicitValues: input.explicitValues || {}
  };
}

/**
 * 将快照项目写入数据构造为可审计字段。
 * @param {object} item 已解析项目。
 * @returns {object} 写入数据。
 */
function buildSnapshotItemPersistence(item) {
  const applications = item.conversion.applications;
  const factorIds = [...new Set(applications.map((application) => application.conversionFactorId))];
  const factorVersions = [...new Set(applications.map((application) => application.version))];
  const effectiveFactorValue = item.originalValue > 0 && Number.isFinite(item.kgceValue)
    ? item.kgceValue / item.originalValue
    : applications.length === 1
      ? applications[0].factorValue
      : null;
  return {
    conversionFactorId: factorIds.length === 1 ? factorIds[0] : null,
    actualFactorVersion: factorVersions.length === 1
      ? factorVersions[0]
      : factorVersions.length > 1
        ? JSON.stringify(factorVersions)
        : null,
    actualFactorValue: effectiveFactorValue && effectiveFactorValue > 0
      ? roundAnalysisValue(effectiveFactorValue)
      : null,
    sourceMapping: {
      ...item.sourceSnapshot,
      _snapshot: {
        sourceRows: item.sourceRows,
        factorApplications: applications,
        formulaVersion: ENERGY_ANALYSIS_VERSIONS.balance,
        conversionFormulaVersion: ENERGY_ANALYSIS_VERSIONS.conversion
      }
    }
  };
}

/**
 * 在单个事务中计算、固化快照和生成建议。
 * @param {*} boundaryIdValue 边界 ID。
 * @param {*} input 计算输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 计算组结果。
 */
function calculateAndSaveBalanceSnapshots(boundaryIdValue, input, options = {}) {
  const boundaryId = normalizePositiveInteger(boundaryIdValue, 'boundaryId');
  const normalizedInput = normalizeCalculationInput(input);
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.snapshot.calculate',
    'energy_balance_calculation_run',
    () => {
      const actor = requireAuditActor(options);
      const boundary = mapBoundaryRow(requireBoundaryRow(db, boundaryId));
      if (boundary.status !== 'active') {
        throw new AppError('ENERGY_BALANCE_BOUNDARY_INACTIVE', '停用的平衡边界不能计算快照。', {
          statusCode: 409,
          details: { boundaryId }
        });
      }
      if (normalizedInput.startMs < Date.parse(boundary.effectiveStartUtc)
        || normalizedInput.endMs > Date.parse(boundary.effectiveEndUtc)) {
        throw badRequest('计算范围必须完全位于边界有效期内。', {
          code: 'BALANCE_WINDOW_OUTSIDE_BOUNDARY_EFFECTIVE_RANGE',
          boundaryId
        });
      }
      const calculationWindow = {
        ...normalizedInput,
        sourceTimeZone: boundary.sourceTimeZone
      };
      const boundaryOrganization = boundary.organizationUnitId === null
        ? null
        : validateOrganizationUnit(db, boundary.organizationUnitId);
      const itemRows = db.prepare(
        `${itemSelectSql()}
         WHERE item.energy_balance_boundary_id = ? AND item.status = 'active'
         ORDER BY item.id ASC
         LIMIT ?`
      ).all(boundaryId, MAX_SOURCE_RECORDS + 1).map(mapItemRow);
      if (itemRows.length === 0) {
        throw badRequest('边界下没有启用的平衡项目。', { code: 'MISSING_ACTIVE_BALANCE_ITEMS' });
      }
      if (itemRows.length > MAX_SOURCE_RECORDS) {
        throw badRequest('启用平衡项目超过单次计算上限。', {
          code: 'BALANCE_ITEM_LIMIT_EXCEEDED',
          maximum: MAX_SOURCE_RECORDS
        });
      }
      const sourceKeyOwners = new Map();
      const resolvedItems = itemRows.map((item) => {
        const sourceResult = resolveItemSource(
          db,
          item,
          boundary,
          boundaryOrganization,
          normalizedInput,
          calculationWindow
        );
        const duplicateReasons = [];
        sourceResult.sourceKeys.forEach((sourceKey) => {
          if (sourceKeyOwners.has(sourceKey)) {
            duplicateReasons.push('SOURCE_OVERLAP_OR_DUPLICATE');
          } else {
            sourceKeyOwners.set(sourceKey, item.id);
          }
        });
        const reasonCodes = normalizeReasonCodes([...sourceResult.reasonCodes, ...duplicateReasons]);
        const sourceWithReasons = { ...sourceResult, reasonCodes };
        const conversion = convertItemToKgce(db, item, sourceWithReasons, calculationWindow);
        return {
          ...item,
          originalValue: sourceResult.value,
          coverageRate: sourceResult.coverageRate,
          sourceRows: sourceResult.sourceRows,
          sourceSnapshot: sourceResult.sourceSnapshot,
          reasonCodes,
          conversion,
          kgceValue: conversion.kgce
        };
      });
      const originalFacets = buildOriginalFacets(resolvedItems, boundary);
      const sourceDataDigest = createDigest({
        boundary: {
          id: boundary.id,
          boundaryCode: boundary.boundaryCode,
          version: boundary.version,
          generationBoundaryConfirmed: boundary.generationBoundaryConfirmed
        },
        range: { startUtc: normalizedInput.startUtc, endUtc: normalizedInput.endUtc },
        items: resolvedItems.map((item) => ({
          id: item.id,
          role: item.role,
          energyTypeId: item.energyType.id,
          originalUnit: item.originalUnit,
          originalValue: item.originalValue,
          sourceType: item.sourceType,
          sourceSnapshot: item.sourceSnapshot,
          sourceRows: item.sourceRows,
          reasonCodes: item.reasonCodes,
          conversion: item.conversion
        })),
        formulaVersion: ENERGY_ANALYSIS_VERSIONS.balance,
        conversionFormulaVersion: ENERGY_ANALYSIS_VERSIONS.conversion
      });
      const calculationRunId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO energy_balance_calculation_runs (
        calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
        source_timezone, source_data_digest, formula_version,
        conversion_formula_version, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        calculationRunId,
        boundaryId,
        normalizedInput.startUtc,
        normalizedInput.endUtc,
        boundary.sourceTimeZone,
        sourceDataDigest,
        ENERGY_ANALYSIS_VERSIONS.balance,
        ENERGY_ANALYSIS_VERSIONS.conversion,
        actor.userId,
        now
      );
      const insertSnapshot = db.prepare(
        `INSERT INTO energy_balance_snapshots (
           calculation_run_id, energy_balance_boundary_id, energy_type_id, start_utc, end_utc,
           source_timezone, original_unit, input_total_original, output_total_original,
           unexplained_original, input_total_kgce, output_total_kgce, unexplained_kgce,
           actual_factor_versions_json, formula_version, utilization_rate, loss_rate,
           completeness_rate, confirmation_status, reason_codes_json,
           source_data_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?)`
      );
      const insertSnapshotItem = db.prepare(
        `INSERT INTO energy_balance_snapshot_items (
           calculation_run_id, energy_balance_snapshot_id, energy_balance_item_id, item_code, item_name,
           role, energy_type_id, original_unit, original_value, conversion_factor_id, actual_factor_version,
           actual_factor_value, kgce_value, formula_version, source_mapping_json,
           reason_codes_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const persistedFacets = originalFacets.map((facet) => {
        const standardCoal = buildFacetStandardCoal(facet);
        const combinedReasons = normalizeReasonCodes([...facet.reasonCodes, ...standardCoal.reasonCodes]);
        const result = insertSnapshot.run(
          calculationRunId,
          boundaryId,
          facet.energyTypeId,
          normalizedInput.startUtc,
          normalizedInput.endUtc,
          boundary.sourceTimeZone,
          facet.originalUnit,
          facet.inputTotalOriginal,
          facet.outputTotalOriginal,
          facet.unexplainedOriginal,
          standardCoal.inputTotalKgce,
          standardCoal.outputTotalKgce,
          standardCoal.unexplainedKgce,
          standardCoal.factorVersions ? JSON.stringify(standardCoal.factorVersions) : null,
          ENERGY_ANALYSIS_VERSIONS.balance,
          facet.utilizationRate,
          facet.lossRate,
          facet.completenessRate,
          combinedReasons.length > 0 ? JSON.stringify(combinedReasons) : null,
          sourceDataDigest,
          now,
          now
        );
        const snapshotId = Number(result.lastInsertRowid);
        facet.items.forEach((item) => {
          const persistence = buildSnapshotItemPersistence(item);
          insertSnapshotItem.run(
            calculationRunId,
            snapshotId,
            item.id,
            item.itemCode,
            item.itemName,
            item.role,
            item.energyType.id,
            item.originalUnit,
            item.originalValue,
            persistence.conversionFactorId,
            persistence.actualFactorVersion,
            persistence.actualFactorValue,
            item.kgceValue,
            ENERGY_ANALYSIS_VERSIONS.balance,
            JSON.stringify(persistence.sourceMapping),
            item.reasonCodes.length > 0 || item.conversion.reasonCodes.length > 0
              ? JSON.stringify(normalizeReasonCodes([
                ...item.reasonCodes,
                ...item.conversion.reasonCodes
              ]))
              : null,
            now
          );
        });
        return {
          snapshotId,
          energyTypeId: facet.energyTypeId,
          energyTypeCode: facet.energyTypeCode,
          energyTypeName: facet.energyTypeName,
          originalUnit: facet.originalUnit,
          inputTotalOriginal: facet.inputTotalOriginal,
          outputTotalOriginal: facet.outputTotalOriginal,
          storageChangeOriginal: facet.storageChangeOriginal,
          unexplainedOriginal: facet.unexplainedOriginal,
          knownLossOriginal: facet.knownLossOriginal,
          inputTotalKgce: standardCoal.inputTotalKgce,
          outputTotalKgce: standardCoal.outputTotalKgce,
          storageChangeKgce: standardCoal.storageChangeKgce,
          storageChangeTce: standardCoal.storageChangeKgce === null
            ? null
            : roundAnalysisValue(standardCoal.storageChangeKgce / 1000),
          unexplainedKgce: standardCoal.unexplainedKgce,
          inputTotalTce: standardCoal.inputTotalKgce === null
            ? null
            : roundAnalysisValue(standardCoal.inputTotalKgce / 1000),
          outputTotalTce: standardCoal.outputTotalKgce === null
            ? null
            : roundAnalysisValue(standardCoal.outputTotalKgce / 1000),
          unexplainedTce: standardCoal.unexplainedKgce === null
            ? null
            : roundAnalysisValue(standardCoal.unexplainedKgce / 1000),
          utilizationRate: facet.utilizationRate,
          lossRate: facet.lossRate,
          imbalanceRate: facet.imbalanceRate,
          completenessRate: facet.completenessRate,
          calculationStatus: combinedReasons.length === 0 ? 'available' : 'frozen',
          reasonCodes: combinedReasons
        };
      });
      const comprehensive = buildComprehensiveStandardCoal(resolvedItems);
      const suggestions = createSuggestionsForSnapshots(db, persistedFacets, {
        calculationRunId,
        boundaryId,
        boundaryCode: boundary.boundaryCode,
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceDataDigest
      });
      const calculation = {
        calculationRunId,
        sourceDataDigest,
        boundary,
        dataRange: {
          startUtc: normalizedInput.startUtc,
          endUtc: normalizedInput.endUtc,
          sourceTimeZone: boundary.sourceTimeZone,
          intervalBoundary: '[startUtc,endUtc)'
        },
        formulaVersion: ENERGY_ANALYSIS_VERSIONS.balance,
        conversionFormulaVersion: ENERGY_ANALYSIS_VERSIONS.conversion,
        originalFacets: persistedFacets,
        comprehensive,
        suggestions,
        automationBoundary: {
          usesAI: false,
          issuesControlCommand: false,
          changesDeviceState: false,
          changesBudgetOrLedger: false,
          requiresManualReview: true
        },
        persistenceDisclosure: {
          calculationGroupKey: 'calculationRunId',
          sourceDataDigestPurpose: 'contentFingerprint',
          comprehensivePersistedAsDedicatedRow: false,
          comprehensiveReconstructableFromSnapshotItems: true
        }
      };
      return {
        result: calculation,
        targetId: calculationRunId,
        beforeState: null,
        afterState: {
          calculationRunId,
          sourceDataDigest,
          boundaryId,
          startUtc: normalizedInput.startUtc,
          endUtc: normalizedInput.endUtc,
          snapshotIds: persistedFacets.map((facet) => facet.snapshotId),
          suggestionIds: suggestions.map((suggestion) => suggestion.id)
        }
      };
    }
  ), options);
}

/**
 * 将快照行映射为公开契约。
 * @param {object} row 快照行。
 * @returns {object} 快照对象。
 */
function mapSnapshotRow(row) {
  const reasonCodes = normalizeReasonCodes(parseJson(row.reasonCodesJson, []));
  return {
    id: Number(row.id),
    calculationRunId: row.calculationRunId,
    boundaryId: Number(row.boundaryId),
    boundaryCode: row.boundaryCode,
    boundaryName: row.boundaryName,
    energyType: {
      id: Number(row.energyTypeId),
      code: row.energyTypeCode,
      name: row.energyTypeName
    },
    dataRange: {
      startUtc: row.startUtc,
      endUtc: row.endUtc,
      sourceTimeZone: row.sourceTimeZone,
      intervalBoundary: '[startUtc,endUtc)'
    },
    originalUnit: row.originalUnit,
    inputTotalOriginal: Number(row.inputTotalOriginal),
    outputTotalOriginal: Number(row.outputTotalOriginal),
    unexplainedOriginal: Number(row.unexplainedOriginal),
    inputTotalKgce: row.inputTotalKgce === null ? null : Number(row.inputTotalKgce),
    outputTotalKgce: row.outputTotalKgce === null ? null : Number(row.outputTotalKgce),
    unexplainedKgce: row.unexplainedKgce === null ? null : Number(row.unexplainedKgce),
    actualFactorVersions: parseJson(row.actualFactorVersionsJson, null),
    formulaVersion: row.formulaVersion,
    utilizationRate: row.utilizationRate === null ? null : Number(row.utilizationRate),
    lossRate: row.lossRate === null ? null : Number(row.lossRate),
    imbalanceRate: reasonCodes.length === 0 && Number(row.inputTotalOriginal) !== 0
      ? roundAnalysisValue(Math.abs(Number(row.unexplainedOriginal)) / Math.abs(Number(row.inputTotalOriginal)))
      : null,
    completenessRate: Number(row.completenessRate),
    calculationStatus: reasonCodes.length === 0 ? 'available' : 'frozen',
    reasonCodes,
    sourceDataDigest: row.sourceDataDigest,
    confirmationStatus: row.confirmationStatus,
    confirmedAt: row.confirmedAt,
    confirmationNote: row.confirmationNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 返回快照公共 SELECT 片段。
 * @returns {string} 快照 SQL。
 */
function snapshotSelectSql() {
  return `SELECT snapshot.id,
                 snapshot.calculation_run_id AS calculationRunId,
                 snapshot.energy_balance_boundary_id AS boundaryId,
                 boundary.boundary_code AS boundaryCode,
                 boundary.boundary_name AS boundaryName,
                 snapshot.energy_type_id AS energyTypeId,
                 energy.code AS energyTypeCode,
                 energy.name AS energyTypeName,
                 snapshot.start_utc AS startUtc,
                 snapshot.end_utc AS endUtc,
                 snapshot.source_timezone AS sourceTimeZone,
                 snapshot.original_unit AS originalUnit,
                 snapshot.input_total_original AS inputTotalOriginal,
                 snapshot.output_total_original AS outputTotalOriginal,
                 snapshot.unexplained_original AS unexplainedOriginal,
                 snapshot.input_total_kgce AS inputTotalKgce,
                 snapshot.output_total_kgce AS outputTotalKgce,
                 snapshot.unexplained_kgce AS unexplainedKgce,
                 snapshot.actual_factor_versions_json AS actualFactorVersionsJson,
                 snapshot.formula_version AS formulaVersion,
                 snapshot.utilization_rate AS utilizationRate,
                 snapshot.loss_rate AS lossRate,
                 snapshot.completeness_rate AS completenessRate,
                 snapshot.confirmation_status AS confirmationStatus,
                 snapshot.reason_codes_json AS reasonCodesJson,
                 snapshot.source_data_digest AS sourceDataDigest,
                 snapshot.confirmed_at AS confirmedAt,
                 snapshot.confirmation_note AS confirmationNote,
                 snapshot.created_at AS createdAt,
                 snapshot.updated_at AS updatedAt
          FROM energy_balance_snapshots AS snapshot
          JOIN energy_balance_boundaries AS boundary ON boundary.id = snapshot.energy_balance_boundary_id
          JOIN energy_types AS energy ON energy.id = snapshot.energy_type_id`;
}

/**
 * 分页查询平衡快照。
 * @param {*} query 查询参数。
 * @param {object} options 可选数据库连接。
 * @returns {object} 快照列表和分页。
 */
function listBalanceSnapshots(query = {}, options = {}) {
  const pagination = normalizePagination(query);
  const boundaryId = normalizeOptionalPositiveInteger(query.boundaryId, 'boundaryId');
  const energyTypeId = normalizeOptionalPositiveInteger(query.energyTypeId, 'energyTypeId');
  const confirmationStatus = query.confirmationStatus === undefined
    ? null
    : normalizeRequiredText(query.confirmationStatus, 'confirmationStatus', 30);
  if (confirmationStatus && !MANUAL_HANDLING_STATUSES.includes(confirmationStatus)) {
    throw badRequest('confirmationStatus 不在允许白名单。', { allowedValues: MANUAL_HANDLING_STATUSES });
  }
  const sourceDataDigest = normalizeOptionalText(query.sourceDataDigest, 'sourceDataDigest', 64);
  const calculationRunId = normalizeOptionalText(query.calculationRunId, 'calculationRunId', 64);
  return executeWithDatabase((db) => {
    const where = [];
    const params = {};
    if (boundaryId) {
      where.push('snapshot.energy_balance_boundary_id = @boundaryId');
      params.boundaryId = boundaryId;
    }
    if (energyTypeId) {
      where.push('snapshot.energy_type_id = @energyTypeId');
      params.energyTypeId = energyTypeId;
    }
    if (confirmationStatus) {
      where.push('snapshot.confirmation_status = @confirmationStatus');
      params.confirmationStatus = confirmationStatus;
    }
    if (sourceDataDigest) {
      where.push('snapshot.source_data_digest = @sourceDataDigest');
      params.sourceDataDigest = sourceDataDigest;
    }
    if (calculationRunId) {
      where.push('snapshot.calculation_run_id = @calculationRunId');
      params.calculationRunId = calculationRunId;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(
      `SELECT COUNT(*) AS total FROM energy_balance_snapshots AS snapshot ${whereSql}`
    ).get(params).total);
    const rows = db.prepare(
      `${snapshotSelectSql()} ${whereSql}
       ORDER BY snapshot.created_at DESC, snapshot.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize: pagination.pageSize, offset: pagination.offset }).map(mapSnapshotRow);
    return {
      rows,
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages: Math.ceil(total / pagination.pageSize)
      }
    };
  }, options);
}

/**
 * 规范 run 级快照筛选，能源和确认状态只决定运行是否命中，不截断运行内分面。
 * @param {*} query 查询参数。
 * @returns {object} 规范筛选。
 */
function normalizeSnapshotRunFilters(query) {
  const boundaryId = normalizeOptionalPositiveInteger(query.boundaryId, 'boundaryId');
  const energyTypeId = normalizeOptionalPositiveInteger(query.energyTypeId, 'energyTypeId');
  const confirmationStatus = query.confirmationStatus === undefined
    ? null
    : normalizeRequiredText(query.confirmationStatus, 'confirmationStatus', 30);
  if (confirmationStatus && !MANUAL_HANDLING_STATUSES.includes(confirmationStatus)) {
    throw badRequest('confirmationStatus 不在允许白名单。', { allowedValues: MANUAL_HANDLING_STATUSES });
  }
  return {
    boundaryId,
    energyTypeId,
    confirmationStatus,
    sourceDataDigest: normalizeOptionalText(query.sourceDataDigest, 'sourceDataDigest', 64),
    calculationRunId: normalizeOptionalText(query.calculationRunId, 'calculationRunId', 64)
  };
}

/**
 * 构造 run 级筛选 SQL；分面筛选使用 EXISTS 保证后续仍读取完整运行。
 * @param {object} filters 规范筛选。
 * @returns {{whereSql:string,params:object}} SQL 条件和参数。
 */
function buildSnapshotRunWhere(filters) {
  const where = [];
  const params = {};
  if (filters.boundaryId) {
    where.push('run.energy_balance_boundary_id = @boundaryId');
    params.boundaryId = filters.boundaryId;
  }
  if (filters.sourceDataDigest) {
    where.push('run.source_data_digest = @sourceDataDigest');
    params.sourceDataDigest = filters.sourceDataDigest;
  }
  if (filters.calculationRunId) {
    where.push('run.calculation_run_id = @calculationRunId');
    params.calculationRunId = filters.calculationRunId;
  }
  if (filters.energyTypeId || filters.confirmationStatus) {
    const facetWhere = ['matched.calculation_run_id = run.calculation_run_id'];
    if (filters.energyTypeId) {
      facetWhere.push('matched.energy_type_id = @energyTypeId');
      params.energyTypeId = filters.energyTypeId;
    }
    if (filters.confirmationStatus) {
      facetWhere.push('matched.confirmation_status = @confirmationStatus');
      params.confirmationStatus = filters.confirmationStatus;
    }
    where.push(`EXISTS (SELECT 1 FROM energy_balance_snapshots AS matched WHERE ${facetWhere.join(' AND ')})`);
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

/**
 * 汇总单次运行的完整分面，仅供按运行读取详情时复用。
 * @param {object[]} facets 完整分面。
 * @returns {object} 运行质量汇总。
 */
function summarizeSnapshotRunFacets(facets) {
  const reasonCodes = normalizeReasonCodes(facets.flatMap((facet) => facet.reasonCodes));
  const sourceDataDigests = new Set(facets.map((facet) => facet.sourceDataDigest).filter(Boolean));
  return {
    representativeSnapshotId: facets.length > 0 ? Number(facets[0].id) : null,
    facetCount: facets.length,
    sourceDataDigestCount: sourceDataDigests.size,
    singleSourceDataDigest: sourceDataDigests.size === 1 ? [...sourceDataDigests][0] : null,
    calculationStatus: facets.length > 0
      && facets.every((facet) => facet.calculationStatus === 'available')
      ? 'available'
      : 'frozen',
    reasonCodes,
    confirmationStatuses: [...new Set(facets.map((facet) => facet.confirmationStatus))],
    latestCreatedAt: facets.reduce(
      (latest, facet) => latest === null || facet.createdAt > latest
        ? facet.createdAt
        : latest,
      null
    )
  };
}

/**
 * 将运行行和质量汇总映射为 run summary 契约。
 * @param {object} runRow 计算运行行。
 * @param {object} quality 运行质量汇总。
 * @param {object} options 映射选项。
 * @returns {object} 运行摘要。
 */
function mapSnapshotRunSummary(runRow, quality, options = {}) {
  const summary = {
    calculationRunId: runRow.calculationRunId,
    boundaryId: Number(runRow.boundaryId),
    boundaryCode: runRow.boundaryCode,
    boundaryName: runRow.boundaryName,
    dataRange: {
      startUtc: runRow.startUtc,
      endUtc: runRow.endUtc,
      sourceTimeZone: runRow.sourceTimeZone,
      intervalBoundary: '[startUtc,endUtc)'
    },
    sourceDataDigest: runRow.sourceDataDigest,
    digestIntegrityWarning: quality.sourceDataDigestCount !== 1
      || quality.singleSourceDataDigest !== runRow.sourceDataDigest,
    representativeSnapshotId: quality.representativeSnapshotId,
    facetCount: quality.facetCount,
    calculationStatus: quality.calculationStatus,
    reasonCodes: quality.reasonCodes,
    confirmationStatuses: quality.confirmationStatuses,
    createdAt: runRow.createdAt,
    latestCreatedAt: quality.latestCreatedAt || runRow.createdAt
  };
  if (options.snapshots) summary.snapshots = options.snapshots;
  return summary;
}

/**
 * 使用 SQL 聚合指定运行集合的质量信息，Node.js 仅接收每个运行一条汇总行。
 * @param {object} db SQLite 数据库连接。
 * @param {string[]} runIds 运行编号集合。
 * @returns {Map<string, object>} 按运行编号索引的质量汇总。
 */
function listSnapshotRunQualityAggregates(db, runIds) {
  const qualityByRun = new Map();
  if (!runIds.length) return qualityByRun;

  const aggregateRows = db.prepare(
    `SELECT snapshot.calculation_run_id AS calculationRunId,
            MIN(snapshot.id) AS representativeSnapshotId,
            COUNT(*) AS facetCount,
            COUNT(DISTINCT CASE
              WHEN trim(COALESCE(snapshot.source_data_digest, '')) <> ''
              THEN snapshot.source_data_digest
              ELSE NULL
            END) AS sourceDataDigestCount,
            MIN(CASE
              WHEN trim(COALESCE(snapshot.source_data_digest, '')) <> ''
              THEN snapshot.source_data_digest
              ELSE NULL
            END) AS singleSourceDataDigest,
            MAX(snapshot.created_at) AS latestCreatedAt
     FROM energy_balance_snapshots AS snapshot
     WHERE snapshot.calculation_run_id IN (${idPlaceholders(runIds)})
     GROUP BY snapshot.calculation_run_id`
  ).all(...runIds);

  aggregateRows.forEach((row) => {
    qualityByRun.set(row.calculationRunId, {
      representativeSnapshotId: Number(row.representativeSnapshotId),
      facetCount: Number(row.facetCount),
      sourceDataDigestCount: Number(row.sourceDataDigestCount),
      singleSourceDataDigest: row.singleSourceDataDigest || null,
      calculationStatus: 'available',
      reasonCodes: [],
      confirmationStatuses: [],
      latestCreatedAt: row.latestCreatedAt
    });
  });

  const approvedReasonCodes = [...APPROVED_REASON_CODE_SET];
  const reasonRows = db.prepare(
    `WITH approved_reason_occurrences AS (
       SELECT snapshot.calculation_run_id AS calculationRunId,
              reason.value AS reasonCode,
              snapshot.id AS snapshotId,
              CAST(reason.key AS INTEGER) AS reasonIndex,
              ROW_NUMBER() OVER (
                PARTITION BY snapshot.calculation_run_id, reason.value
                ORDER BY snapshot.id ASC, CAST(reason.key AS INTEGER) ASC
              ) AS reasonRank
       FROM energy_balance_snapshots AS snapshot
       JOIN json_each(
         CASE WHEN json_valid(snapshot.reason_codes_json) = 1
           THEN CASE WHEN json_type(snapshot.reason_codes_json) = 'array'
             THEN snapshot.reason_codes_json
             ELSE '[]'
           END
           ELSE '[]'
         END
       ) AS reason
       WHERE snapshot.calculation_run_id IN (${idPlaceholders(runIds)})
         AND reason.type = 'text'
         AND reason.value IN (${idPlaceholders(approvedReasonCodes)})
     )
     SELECT calculationRunId, reasonCode
     FROM approved_reason_occurrences
     WHERE reasonRank = 1
     ORDER BY calculationRunId ASC, snapshotId ASC, reasonIndex ASC`
  ).all(...runIds, ...approvedReasonCodes);

  reasonRows.forEach((row) => {
    const quality = qualityByRun.get(row.calculationRunId);
    if (!quality) return;
    quality.reasonCodes.push(row.reasonCode);
    quality.calculationStatus = 'frozen';
  });

  const confirmationRows = db.prepare(
    `SELECT snapshot.calculation_run_id AS calculationRunId,
            snapshot.confirmation_status AS confirmationStatus,
            MIN(snapshot.id) AS firstSnapshotId
     FROM energy_balance_snapshots AS snapshot
     WHERE snapshot.calculation_run_id IN (${idPlaceholders(runIds)})
     GROUP BY snapshot.calculation_run_id, snapshot.confirmation_status
     ORDER BY snapshot.calculation_run_id ASC, firstSnapshotId ASC`
  ).all(...runIds);

  confirmationRows.forEach((row) => {
    const quality = qualityByRun.get(row.calculationRunId);
    if (quality) quality.confirmationStatuses.push(row.confirmationStatus);
  });

  return qualityByRun;
}

/**
 * 按 calculationRunId 分页查询轻量运行摘要，完整分面仅由运行详情接口返回。
 * @param {*} query 查询参数。
 * @param {object} options 可选数据库连接。
 * @returns {object} 运行摘要和 run 级分页。
 */
function listBalanceSnapshotRuns(query = {}, options = {}) {
  const pagination = normalizePagination(query);
  const filters = normalizeSnapshotRunFilters(query);
  return executeWithDatabase((db) => {
    const { whereSql, params } = buildSnapshotRunWhere(filters);
    const total = Number(db.prepare(
      `SELECT COUNT(*) AS total FROM energy_balance_calculation_runs AS run ${whereSql}`
    ).get(params).total);
    const runRows = db.prepare(
      `SELECT run.calculation_run_id AS calculationRunId,
              run.energy_balance_boundary_id AS boundaryId,
              boundary.boundary_code AS boundaryCode,
              boundary.boundary_name AS boundaryName,
              run.start_utc AS startUtc,
              run.end_utc AS endUtc,
              run.source_timezone AS sourceTimeZone,
              run.source_data_digest AS sourceDataDigest,
              run.created_at AS createdAt
       FROM energy_balance_calculation_runs AS run
       JOIN energy_balance_boundaries AS boundary ON boundary.id = run.energy_balance_boundary_id
       ${whereSql}
       ORDER BY run.created_at DESC, run.calculation_run_id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize: pagination.pageSize, offset: pagination.offset });
    const runIds = runRows.map((row) => row.calculationRunId);
    const qualityByRun = listSnapshotRunQualityAggregates(db, runIds);
    return {
      rows: runRows.map((runRow) => mapSnapshotRunSummary(
        runRow,
        qualityByRun.get(runRow.calculationRunId) || {
          representativeSnapshotId: null,
          facetCount: 0,
          sourceDataDigestCount: 0,
          singleSourceDataDigest: null,
          calculationStatus: 'frozen',
          reasonCodes: [],
          confirmationStatuses: [],
          latestCreatedAt: null
        }
      )),
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages: Math.ceil(total / pagination.pageSize)
      }
    };
  }, options);
}

/**
 * 按 calculationRunId 读取单次运行及其全部分面。
 * @param {*} calculationRunIdValue 运行编号。
 * @param {object} options 可选数据库连接。
 * @returns {object} 完整运行摘要。
 */
function getBalanceSnapshotRun(calculationRunIdValue, options = {}) {
  const calculationRunId = normalizeRequiredText(
    calculationRunIdValue,
    'calculationRunId',
    64
  );
  return executeWithDatabase((db) => {
    const runRow = db.prepare(
      `SELECT run.calculation_run_id AS calculationRunId,
              run.energy_balance_boundary_id AS boundaryId,
              boundary.boundary_code AS boundaryCode,
              boundary.boundary_name AS boundaryName,
              run.start_utc AS startUtc,
              run.end_utc AS endUtc,
              run.source_timezone AS sourceTimeZone,
              run.source_data_digest AS sourceDataDigest,
              run.created_at AS createdAt
       FROM energy_balance_calculation_runs AS run
       JOIN energy_balance_boundaries AS boundary ON boundary.id = run.energy_balance_boundary_id
       WHERE run.calculation_run_id = ?`
    ).get(calculationRunId);
    if (!runRow) throw notFound('平衡计算运行不存在。', { calculationRunId });
    const facets = db.prepare(
      `${snapshotSelectSql()}
       WHERE snapshot.calculation_run_id = ?
       ORDER BY snapshot.id ASC`
    ).all(calculationRunId).map(mapSnapshotRow);
    return mapSnapshotRunSummary(
      runRow,
      summarizeSnapshotRunFacets(facets),
      { snapshots: facets }
    );
  }, options);
}

/**
 * 将快照项目行映射为公开契约。
 * @param {object} row 快照项目行。
 * @returns {object} 快照项目对象。
 */
function mapSnapshotItemRow(row) {
  const sourceMapping = parseJson(row.sourceMappingJson, null);
  return {
    id: Number(row.id),
    calculationRunId: row.calculationRunId,
    snapshotId: Number(row.snapshotId),
    balanceItemId: Number(row.balanceItemId),
    itemCode: row.itemCode,
    itemName: row.itemName,
    role: row.role,
    energyTypeId: Number(row.energyTypeId),
    originalUnit: row.originalUnit,
    originalValue: Number(row.originalValue),
    conversionFactorId: row.conversionFactorId === null ? null : Number(row.conversionFactorId),
    actualFactorVersion: row.actualFactorVersion,
    actualFactorValue: row.actualFactorValue === null ? null : Number(row.actualFactorValue),
    kgceValue: row.kgceValue === null ? null : Number(row.kgceValue),
    tceValue: row.kgceValue === null ? null : roundAnalysisValue(Number(row.kgceValue) / 1000),
    formulaVersion: row.formulaVersion,
    sourceMapping,
    reasonCodes: normalizeReasonCodes(parseJson(row.reasonCodesJson, [])),
    createdAt: row.createdAt
  };
}

/**
 * 从同一摘要组的快照项目重建综合 kgce/tce。
 * @param {object[]} snapshotItems 快照项目。
 * @param {number} completenessRate 计算组覆盖率。
 * @returns {object} 综合折标结果。
 */
function reconstructComprehensive(snapshotItems, completenessRate) {
  const reasonCodes = normalizeReasonCodes(snapshotItems.flatMap((item) => item.reasonCodes));
  if (reasonCodes.length > 0 || snapshotItems.some((item) => item.kgceValue === null)) {
    return {
      calculationStatus: 'frozen',
      unit: 'kgce',
      displayUnit: 'tce',
      inputTotalKgce: null,
      outputTotalKgce: null,
      storageChangeKgce: null,
      unexplainedKgce: null,
      inputTotalTce: null,
      outputTotalTce: null,
      unexplainedTce: null,
      utilizationRate: null,
      lossRate: null,
      imbalanceRate: null,
      completenessRate,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['MISSING_CONVERSION_FACTOR']
    };
  }
  const algorithmItems = snapshotItems.map((item) => ({
    role: item.role,
    energyTypeCode: STANDARD_COAL_SCOPE_CODE,
    unit: 'kgce',
    value: item.kgceValue,
    sourceMapping: {
      type: item.sourceMapping?._snapshot?.sourceRows?.length > 0
        ? item.sourceMapping?.type || 'explicit_balance_value'
        : 'explicit_balance_value',
      reference: item.sourceMapping?.reference || `snapshot-item:${item.id}`
    }
  }));
  const result = calculateEnergyBalance(algorithmItems, { generationBoundaryConfirmed: true });
  return {
    calculationStatus: result.reasonCodes.length === 0 ? 'available' : 'frozen',
    unit: 'kgce',
    displayUnit: 'tce',
    inputTotalKgce: result.inputTotal,
    outputTotalKgce: result.outputTotal,
    storageChangeKgce: roundAnalysisValue(
      sumRole(snapshotItems, 'inventory_increase', 'kgceValue')
      - sumRole(snapshotItems, 'inventory_decrease', 'kgceValue')
    ),
    unexplainedKgce: result.unexplainedDifference,
    inputTotalTce: result.inputTotal === null ? null : roundAnalysisValue(result.inputTotal / 1000),
    outputTotalTce: result.outputTotal === null ? null : roundAnalysisValue(result.outputTotal / 1000),
    unexplainedTce: result.unexplainedDifference === null
      ? null
      : roundAnalysisValue(result.unexplainedDifference / 1000),
    utilizationRate: result.utilizationRate,
    lossRate: result.lossRate,
    imbalanceRate: result.imbalanceRate,
    completenessRate,
    reasonCodes: result.reasonCodes
  };
}

/**
 * 查询单个快照及同次计算组、项目和建议首屏分页信息。
 * @param {*} snapshotIdValue 快照 ID。
 * @param {object} options 可选数据库连接。
 * @returns {object} 快照详情。
 */
function getBalanceSnapshot(snapshotIdValue, options = {}) {
  const snapshotId = normalizePositiveInteger(snapshotIdValue, 'snapshotId');
  return executeWithDatabase((db) => {
    const snapshotRow = db.prepare(`${snapshotSelectSql()} WHERE snapshot.id = ?`).get(snapshotId);
    if (!snapshotRow) throw notFound('平衡快照不存在。', { snapshotId });
    const snapshot = mapSnapshotRow(snapshotRow);
    const groupSnapshots = db.prepare(
      `${snapshotSelectSql()} WHERE snapshot.calculation_run_id = ? ORDER BY snapshot.id ASC`
    ).all(snapshot.calculationRunId).map(mapSnapshotRow);
    const snapshotItems = db.prepare(
      `SELECT snapshot_item.id,
              snapshot_item.calculation_run_id AS calculationRunId,
              snapshot_item.energy_balance_snapshot_id AS snapshotId,
              snapshot_item.energy_balance_item_id AS balanceItemId,
              snapshot_item.item_code AS itemCode,
              snapshot_item.item_name AS itemName,
              snapshot_item.role,
              snapshot_item.energy_type_id AS energyTypeId,
              snapshot_item.original_unit AS originalUnit,
              snapshot_item.original_value AS originalValue,
              snapshot_item.conversion_factor_id AS conversionFactorId,
              snapshot_item.actual_factor_version AS actualFactorVersion,
              snapshot_item.actual_factor_value AS actualFactorValue,
              snapshot_item.kgce_value AS kgceValue,
              snapshot_item.formula_version AS formulaVersion,
              snapshot_item.source_mapping_json AS sourceMappingJson,
              snapshot_item.reason_codes_json AS reasonCodesJson,
              snapshot_item.created_at AS createdAt
       FROM energy_balance_snapshot_items AS snapshot_item
       JOIN energy_balance_snapshots AS snapshot ON snapshot.id = snapshot_item.energy_balance_snapshot_id
       WHERE snapshot_item.calculation_run_id = ?
       ORDER BY snapshot_item.energy_balance_snapshot_id ASC, snapshot_item.id ASC`
    ).all(snapshot.calculationRunId).map(mapSnapshotItemRow);
    const selectedItems = snapshotItems.filter((item) => item.snapshotId === snapshotId);
    const suggestionResult = listBalanceSuggestionsWithDb(db, {
      calculationRunId: snapshot.calculationRunId,
      page: 1,
      pageSize: MAX_PAGE_SIZE,
      offset: 0
    });
    const storageChangeOriginal = roundAnalysisValue(
      sumRole(selectedItems, 'inventory_increase', 'originalValue')
      - sumRole(selectedItems, 'inventory_decrease', 'originalValue')
    );
    const storageChangeKgce = selectedItems.some((item) => item.kgceValue === null)
      ? null
      : roundAnalysisValue(
        sumRole(selectedItems, 'inventory_increase', 'kgceValue')
        - sumRole(selectedItems, 'inventory_decrease', 'kgceValue')
      );
    const groupCompletenessRate = roundAnalysisValue(
      Math.min(...groupSnapshots.map((groupSnapshot) => groupSnapshot.completenessRate))
    ) ?? 0;
    return {
      ...snapshot,
      storageChangeOriginal,
      storageChangeKgce,
      storageChangeTce: storageChangeKgce === null
        ? null
        : roundAnalysisValue(storageChangeKgce / 1000),
      items: selectedItems,
      calculationGroup: {
        calculationRunId: snapshot.calculationRunId,
        sourceDataDigest: snapshot.sourceDataDigest,
        facets: groupSnapshots,
        comprehensive: reconstructComprehensive(snapshotItems, groupCompletenessRate)
      },
      suggestions: suggestionResult.rows,
      suggestionTotal: suggestionResult.pagination.total,
      suggestionPagination: suggestionResult.pagination,
      suggestionsHasMore: suggestionResult.pagination.hasMore
    };
  }, options);
}

/**
 * 规范建议查询并分页读取。
 * @param {*} query 查询参数。
 * @param {object} options 可选数据库连接。
 * @returns {object} 建议列表和分页。
 */
function listBalanceSuggestions(query = {}, options = {}) {
  const pagination = normalizePagination(query);
  const snapshotId = normalizeOptionalPositiveInteger(query.snapshotId, 'snapshotId');
  const boundaryId = normalizeOptionalPositiveInteger(query.boundaryId, 'boundaryId');
  const sourceDataDigest = normalizeOptionalText(query.sourceDataDigest, 'sourceDataDigest', 64);
  const calculationRunId = normalizeOptionalText(query.calculationRunId, 'calculationRunId', 64);
  const manualStatus = query.manualStatus === undefined
    ? null
    : normalizeRequiredText(query.manualStatus, 'manualStatus', 30);
  if (manualStatus && !MANUAL_HANDLING_STATUSES.includes(manualStatus)) {
    throw badRequest('manualStatus 不在允许白名单。', { allowedValues: MANUAL_HANDLING_STATUSES });
  }
  const priority = query.priority === undefined
    ? null
    : normalizeRequiredText(query.priority, 'priority', 20);
  if (priority && !RULE_PRIORITIES.includes(priority)) {
    throw badRequest('priority 不在允许白名单。', { allowedValues: RULE_PRIORITIES });
  }
  return executeWithDatabase((db) => listBalanceSuggestionsWithDb(db, {
    ...pagination,
    snapshotId,
    boundaryId,
    calculationRunId,
    sourceDataDigest,
    manualStatus,
    priority
  }), options);
}

/**
 * 更新建议人工状态。
 * @param {*} suggestionIdValue 建议 ID。
 * @param {*} input 状态输入。
 * @param {object} options 可选数据库连接。
 * @returns {object} 更新后建议。
 */
function updateBalanceSuggestionStatus(suggestionIdValue, input, options = {}) {
  const suggestionId = normalizePositiveInteger(suggestionIdValue, 'suggestionId');
  return executeWithDatabase((db) => executeAuditedWrite(
    db,
    options,
    'energy.balance.suggestion.review',
    'energy_balance_suggestion',
    () => {
      const actor = requireAuditActor(options);
      const existing = db.prepare(`SELECT id,
        calculation_run_id AS calculationRunId,
        manual_status AS manualStatus,
        reviewed_at AS reviewedAt,
        reviewed_by_user_id AS reviewedByUserId,
        review_note AS reviewNote
        FROM energy_balance_suggestions WHERE id = ?`).get(suggestionId);
      const updated = updateBalanceSuggestionStatusWithDb(db, suggestionId, input, actor.userId);
      return {
        result: updated,
        targetId: suggestionId,
        beforeState: existing || null,
        afterState: updated
      };
    }
  ), options);
}

/**
 * 返回独立路由和调用方使用的稳定领域契约。
 * @returns {object} 平衡领域契约。
 */
function getEnergyBalanceContract() {
  return {
    contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
    balanceFormulaVersion: ENERGY_ANALYSIS_VERSIONS.balance,
    conversionFormulaVersion: ENERGY_ANALYSIS_VERSIONS.conversion,
    roles: [...BALANCE_INPUT_ROLES],
    sourceTypes: [...BALANCE_SOURCE_TYPES],
    generation: {
      permittedRoles: [...GENERATION_ROLES],
      valueFields: [...GENERATION_VALUE_FIELDS],
      explicitMappingRequired: true,
      antiDoubleCountingKeyRequired: true,
      automaticLedgerLink: false
    },
    calculation: {
      intervalBoundary: '[startUtc,endUtc)',
      maximumDays: MAX_CALCULATION_DAYS,
      originalFacets: true,
      standardCoalUnit: 'kgce',
      standardCoalDisplayUnit: 'tce',
      freezesOnReasonCodes: [
        'MISSING_CONVERSION_FACTOR',
        'FACTOR_PERIOD_AMBIGUOUS',
        'UNIT_NOT_COMPARABLE',
        'SOURCE_OVERLAP_OR_DUPLICATE',
        'GENERATION_BOUNDARY_UNCONFIRMED',
        'BALANCE_ITEM_UNMAPPED',
        'COVERAGE_BELOW_THRESHOLD'
      ]
    },
    suggestions: {
      deterministicLocalRules: true,
      estimatedSavingWithoutEvidence: false,
      manualStatuses: [...MANUAL_HANDLING_STATUSES],
      usesAI: false,
      automaticExecution: false,
      modifiesDeviceBudgetOrLedger: false
    }
  };
}

module.exports = {
  GENERATION_ROLES,
  GENERATION_VALUE_FIELDS,
  MAX_CALCULATION_DAYS,
  MAX_ITEM_PAGE_SIZE,
  MAX_PAGE_SIZE,
  calculateAndSaveBalanceSnapshots,
  createBalanceBoundary,
  createBalanceItem,
  getBalanceBoundary,
  getBalanceSnapshot,
  getBalanceSnapshotRun,
  getEnergyBalanceContract,
  listBalanceBoundaries,
  listBalanceItems,
  listBalanceSnapshotRuns,
  listBalanceSnapshots,
  listBalanceSuggestions,
  setBalanceBoundaryStatus,
  setBalanceItemStatus,
  updateBalanceBoundary,
  updateBalanceItem,
  updateBalanceSuggestionStatus
};
