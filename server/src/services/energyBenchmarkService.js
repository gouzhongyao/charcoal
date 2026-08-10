'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const {
  BENCHMARK_DIRECTIONS,
  BENCHMARK_TYPES,
  isIanaTimeZone,
  isStrictUtcIso
} = require('./energyAnalysisContracts');
const { evaluateBenchmark, roundAnalysisValue } = require('./energyAnalysisUtils');

// 对标记录仅使用启用和停用状态，禁止通过领域服务物理删除。
const BENCHMARK_STATUSES = Object.freeze(['active', 'inactive']);
// 当前 schema 可以解析的对标适用范围。
const BENCHMARK_SCOPE_TYPES = Object.freeze(['organization', 'energy', 'product']);
// 版本格式与现有对标导入契约保持一致。
const BENCHMARK_VERSION_PATTERN = /^[a-z][a-z0-9-]*:v1$/;
// 列表查询的缺省分页和数量上限。
const BENCHMARK_DEFAULT_PAGE_SIZE = 20;
const BENCHMARK_MAX_PAGE_SIZE = 100;
// 内部历史基准仅支持与现有严格强度分析一致的月度单位产品能耗口径。
const INTERNAL_BASELINE_SUPPORTED_METRIC = 'energy_intensity';
const INTERNAL_BASELINE_FORMULA_VERSION = 'energy-benchmark-internal-baseline:v1';
// 内部历史计算最多读取的单类权威事实数量，超限必须缩小参考期。
const INTERNAL_BASELINE_MAX_SOURCE_RECORDS = 50000;
// 领域写操作统一审计操作编码。
const ENERGY_BENCHMARK_AUDIT_OPERATIONS = Object.freeze({
  definitionCreate: 'energy.benchmark.definition.create',
  definitionUpdate: 'energy.benchmark.definition.update',
  definitionStatus: 'energy.benchmark.definition.status',
  targetCreate: 'energy.benchmark.target.create',
  targetVersion: 'energy.benchmark.target.version',
  targetStatus: 'energy.benchmark.target.status',
  internalHistoryCreate: 'energy.benchmark.internal-history.create'
});
// 领域专用原因码不修改公共冻结原因码集合。
const ENERGY_BENCHMARK_REASON_CODES = Object.freeze({
  definitionInactive: 'BENCHMARK_DEFINITION_INACTIVE',
  targetInactive: 'BENCHMARK_TARGET_INACTIVE',
  actualValueMissing: 'BENCHMARK_ACTUAL_VALUE_MISSING',
  metricMismatch: 'BENCHMARK_METRIC_MISMATCH',
  scopeTypeMismatch: 'BENCHMARK_SCOPE_TYPE_MISMATCH',
  scopeReferenceMismatch: 'BENCHMARK_SCOPE_REFERENCE_MISMATCH',
  objectLevelMismatch: 'BENCHMARK_OBJECT_LEVEL_MISMATCH',
  unitMismatch: 'BENCHMARK_UNIT_MISMATCH',
  energyTypeMismatch: 'BENCHMARK_ENERGY_TYPE_MISMATCH',
  periodTypeMismatch: 'BENCHMARK_PERIOD_TYPE_MISMATCH',
  periodRangeInvalid: 'BENCHMARK_PERIOD_RANGE_INVALID',
  outsideEffectivePeriod: 'BENCHMARK_OUTSIDE_EFFECTIVE_PERIOD',
  targetInvalid: 'BENCHMARK_TARGET_INVALID'
});

// 对标定义数据库字段投影，供详情和执行查询复用。
const DEFINITION_SELECT = `SELECT
  d.id,
  d.source_batch_id AS sourceBatchId,
  d.source_row_number AS sourceRowNumber,
  d.benchmark_code AS benchmarkCode,
  d.benchmark_name AS benchmarkName,
  d.benchmark_type AS benchmarkType,
  d.metric_code AS metricCode,
  d.unit,
  d.period_type AS periodType,
  d.scope_type AS scopeType,
  d.scope_reference AS scopeReference,
  d.direction,
  d.source,
  d.document_no AS documentNo,
  d.version,
  d.effective_start_utc AS effectiveStartUtc,
  d.effective_end_utc AS effectiveEndUtc,
  d.source_timezone AS sourceTimeZone,
  d.status,
  d.created_at AS createdAt,
  d.updated_at AS updatedAt
FROM benchmark_definitions d`;
// 对标目标数据库字段投影，保留内部历史快照追溯字段。
const TARGET_SELECT = `SELECT
  t.id,
  t.source_batch_id AS sourceBatchId,
  t.source_row_number AS sourceRowNumber,
  t.benchmark_definition_id AS benchmarkDefinitionId,
  t.target_value AS targetValue,
  t.lower_bound AS lowerBound,
  t.upper_bound AS upperBound,
  t.reference_start_utc AS referenceStartUtc,
  t.reference_end_utc AS referenceEndUtc,
  t.frozen_value AS frozenValue,
  t.frozen_at AS frozenAt,
  t.sample_count AS sampleCount,
  t.production_summary_json AS productionSummaryJson,
  t.source_data_digest AS sourceDataDigest,
  t.is_frozen AS isFrozen,
  t.auto_refresh AS autoRefresh,
  t.version,
  t.status,
  t.created_at AS createdAt,
  t.updated_at AS updatedAt
FROM benchmark_targets t`;

/**
 * 创建稳定领域错误。
 * @param {string} code 稳定错误码。
 * @param {string} message 中文错误信息。
 * @param {object} details 补充详情。
 * @returns {Error} 应用错误。
 */
function benchmarkError(code, message, details = {}) {
  return badRequest(message, { code, ...details });
}

/**
 * 规范化必填文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {number} maxLength 最大长度。
 * @returns {string} 规范化文本。
 */
function requireText(value, fieldName, maxLength = 200) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) throw benchmarkError('BENCHMARK_REQUIRED_FIELD_MISSING', `${fieldName} 不能为空。`, { field: fieldName });
  if (text.length > maxLength) throw benchmarkError('BENCHMARK_FIELD_TOO_LONG', `${fieldName} 长度不能超过 ${maxLength}。`, { field: fieldName, maxLength });
  return text;
}

/**
 * 规范化可选文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {number} maxLength 最大长度。
 * @returns {string|null} 规范化文本。
 */
function optionalText(value, fieldName, maxLength = 200) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return requireText(value, fieldName, maxLength);
}

/**
 * 规范化有限数字。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {boolean} optional 是否允许空值。
 * @returns {number|null} 有限数字。
 */
function finiteNumber(value, fieldName, optional = false) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw benchmarkError('BENCHMARK_REQUIRED_FIELD_MISSING', `${fieldName} 不能为空。`, { field: fieldName });
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw benchmarkError('BENCHMARK_INVALID_NUMBER', `${fieldName} 必须是有限数字。`, { field: fieldName });
  return numberValue;
}

/**
 * 校验正整数主键。
 * @param {*} value 原始主键。
 * @param {string} fieldName 字段名。
 * @returns {number} 正整数主键。
 */
function positiveInteger(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw benchmarkError('BENCHMARK_INVALID_ID', `${fieldName} 必须是正整数。`, { field: fieldName });
  }
  return numberValue;
}

/**
 * 规范化分页参数。
 * @param {object} query 查询参数。
 * @returns {{page:number,pageSize:number,offset:number}} 分页参数。
 */
function normalizePagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? BENCHMARK_DEFAULT_PAGE_SIZE : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page <= 0) throw benchmarkError('BENCHMARK_INVALID_PAGE', 'page 必须是正整数。');
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > BENCHMARK_MAX_PAGE_SIZE) {
    throw benchmarkError('BENCHMARK_INVALID_PAGE_SIZE', `pageSize 必须是 1 到 ${BENCHMARK_MAX_PAGE_SIZE} 的整数。`);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 使用调用方连接或短生命周期连接执行数据库操作。
 * @param {object} options 可选依赖。
 * @param {Function} operation 数据库操作。
 * @returns {*} 操作结果。
 */
function withDatabase(options, operation) {
  const externalDatabase = options?.db || null;
  const db = externalDatabase || openDatabase();
  try {
    return operation(db);
  } finally {
    if (!externalDatabase) db.close();
  }
}

/**
 * 规范并校验写操作审计操作者。
 * @param {object} options 服务选项。
 * @returns {{userId:number,username:string|null,ip:string|null}} 操作者。
 */
function requireAuditActor(options) {
  const actor = options?.actor;
  if (!actor || !Number.isSafeInteger(Number(actor.userId)) || Number(actor.userId) <= 0) {
    throw benchmarkError('ENERGY_BENCHMARK_AUDIT_ACTOR_REQUIRED', '能效对标写操作必须提供已认证操作者。');
  }
  return {
    userId: Number(actor.userId),
    username: optionalText(actor.username, 'actor.username', 100),
    ip: optionalText(actor.ip, 'actor.ip', 100)
  };
}

/**
 * 在当前业务事务内写入统一操作日志，审计失败必须让业务整体回滚。
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
 * 将 SQLite 整数布尔值和 JSON 快照投影为稳定对象。
 * @param {object} row 数据库行。
 * @returns {object|null} 目标对象。
 */
function mapTarget(row) {
  if (!row) return null;
  let productionSummary = null;
  if (row.productionSummaryJson) {
    try {
      productionSummary = JSON.parse(row.productionSummaryJson);
    } catch (error) {
      productionSummary = null;
    }
  }
  return {
    ...row,
    isFrozen: Number(row.isFrozen) === 1,
    autoRefresh: Number(row.autoRefresh) === 1,
    productionSummary
  };
}

/**
 * 查询并断言对标定义存在。
 * @param {object} db SQLite 连接。
 * @param {number} definitionId 定义主键。
 * @returns {object} 对标定义。
 */
function requireDefinition(db, definitionId) {
  const definition = db.prepare(`${DEFINITION_SELECT} WHERE d.id = ?`).get(positiveInteger(definitionId, 'definitionId'));
  if (!definition) throw notFound('对标定义不存在。', { code: 'BENCHMARK_DEFINITION_NOT_FOUND' });
  return definition;
}

/**
 * 查询并断言对标目标存在。
 * @param {object} db SQLite 连接。
 * @param {number} targetId 目标主键。
 * @returns {object} 对标目标。
 */
function requireTarget(db, targetId) {
  const target = db.prepare(`${TARGET_SELECT} WHERE t.id = ?`).get(positiveInteger(targetId, 'targetId'));
  if (!target) throw notFound('对标目标不存在。', { code: 'BENCHMARK_TARGET_NOT_FOUND' });
  return mapTarget(target);
}

/**
 * 校验版本格式。
 * @param {*} value 原始版本。
 * @param {string} fieldName 字段名。
 * @returns {string} 合法版本。
 */
function validateVersion(value, fieldName = 'version') {
  const version = requireText(value, fieldName, 80);
  if (!BENCHMARK_VERSION_PATTERN.test(version)) {
    throw benchmarkError('BENCHMARK_INVALID_VERSION', `${fieldName} 必须使用 name:v1 格式。`, { field: fieldName });
  }
  return version;
}

/**
 * 校验严格 UTC 左闭右开时间范围。
 * @param {*} startValue 开始时间。
 * @param {*} endValue 结束时间。
 * @param {string} prefix 字段前缀。
 * @returns {{startUtc:string,endUtc:string}} 时间范围。
 */
function validateUtcRange(startValue, endValue, prefix) {
  const startUtc = requireText(startValue, `${prefix}StartUtc`, 40);
  const endUtc = requireText(endValue, `${prefix}EndUtc`, 40);
  if (!isStrictUtcIso(startUtc) || !isStrictUtcIso(endUtc) || Date.parse(startUtc) >= Date.parse(endUtc)) {
    throw benchmarkError('BENCHMARK_INVALID_UTC_RANGE', `${prefix} 时间必须是合法严格 UTC Z 左闭右开区间。`, { startUtc, endUtc });
  }
  return { startUtc, endUtc };
}

/**
 * 校验对标范围引用存在且处于启用状态。
 * @param {object} db SQLite 连接。
 * @param {string} scopeType 范围类型。
 * @param {string} scopeReference 范围引用。
 * @returns {object} 范围元数据。
 */
function validateScopeReference(db, scopeType, scopeReference) {
  if (!BENCHMARK_SCOPE_TYPES.includes(scopeType)) {
    throw benchmarkError('UNSUPPORTED_BENCHMARK_SCOPE_TYPE', 'scopeType 仅支持 organization、energy 或 product。');
  }
  if (scopeType === 'organization') {
    const organization = db.prepare('SELECT unit_code AS reference, unit_type AS objectLevel, status FROM organization_units WHERE unit_code = ?').get(scopeReference);
    if (!organization) throw benchmarkError('BENCHMARK_ORGANIZATION_SCOPE_NOT_FOUND', '组织范围标识不存在。');
    if (organization.status !== 'active') throw benchmarkError('BENCHMARK_ORGANIZATION_SCOPE_INACTIVE', '组织范围已停用。');
    return organization;
  }
  if (scopeType === 'energy') {
    const energyType = db.prepare('SELECT code AS reference, is_active AS isActive FROM energy_types WHERE code = ?').get(scopeReference);
    if (!energyType) throw benchmarkError('BENCHMARK_ENERGY_SCOPE_NOT_FOUND', '能源范围编码不存在。');
    if (Number(energyType.isActive) !== 1) throw benchmarkError('BENCHMARK_ENERGY_SCOPE_INACTIVE', '能源范围已停用。');
    return { ...energyType, objectLevel: 'energy' };
  }
  const product = db.prepare(`SELECT unit_code AS reference, product_name AS productName, status
    FROM production_units WHERE unit_code = ? OR product_name = ? ORDER BY id LIMIT 1`).get(scopeReference, scopeReference);
  if (!product) throw benchmarkError('BENCHMARK_PRODUCT_SCOPE_NOT_FOUND', '产品范围标识无法由当前产能单元主数据解析。');
  if (product.status !== 'active') throw benchmarkError('BENCHMARK_PRODUCT_SCOPE_INACTIVE', '产品范围已停用。');
  return { ...product, objectLevel: 'product' };
}

/**
 * 规范化定义创建输入。
 * @param {object} db SQLite 连接。
 * @param {object} input 定义输入。
 * @param {boolean} allowInternal 是否允许内部历史类型。
 * @returns {object} 规范化定义。
 */
function normalizeDefinitionInput(db, input, allowInternal = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw benchmarkError('BENCHMARK_INVALID_INPUT', '定义输入必须是对象。');
  const benchmarkType = requireText(input.benchmarkType, 'benchmarkType', 60);
  if (!BENCHMARK_TYPES.includes(benchmarkType)) throw benchmarkError('INVALID_BENCHMARK_TYPE', 'benchmarkType 不受支持。');
  if (benchmarkType === 'internal_history_baseline' && !allowInternal) {
    throw benchmarkError('INTERNAL_HISTORY_BENCHMARK_REQUIRES_SNAPSHOT', '内部历史基准必须通过原子固化接口创建。');
  }
  const direction = requireText(input.direction, 'direction', 40);
  if (!BENCHMARK_DIRECTIONS.includes(direction)) throw benchmarkError('INVALID_BENCHMARK_DIRECTION', 'direction 不受支持。');
  const status = input.status === undefined ? 'active' : requireText(input.status, 'status', 20);
  if (!BENCHMARK_STATUSES.includes(status)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 仅支持 active 或 inactive。');
  const effectiveRange = validateUtcRange(input.effectiveStartUtc, input.effectiveEndUtc, 'effective');
  const sourceTimeZone = requireText(input.sourceTimeZone, 'sourceTimeZone', 100);
  if (!isIanaTimeZone(sourceTimeZone)) throw benchmarkError('INVALID_SOURCE_TIME_ZONE', 'sourceTimeZone 必须是有效 IANA 时区。');
  const scopeType = requireText(input.scopeType, 'scopeType', 40);
  const scopeReference = requireText(input.scopeReference, 'scopeReference', 200);
  const scopeMetadata = validateScopeReference(db, scopeType, scopeReference);
  const documentNo = optionalText(input.documentNo, 'documentNo', 200);
  if (benchmarkType === 'external_standard' && !documentNo) {
    throw benchmarkError('MISSING_BENCHMARK_DOCUMENT_NO', '外部标准必须填写 documentNo。');
  }
  return {
    benchmarkCode: requireText(input.benchmarkCode, 'benchmarkCode', 100),
    benchmarkName: requireText(input.benchmarkName, 'benchmarkName', 200),
    benchmarkType,
    metricCode: requireText(input.metricCode, 'metricCode', 120),
    unit: requireText(input.unit, 'unit', 80),
    periodType: requireText(input.periodType, 'periodType', 60),
    scopeType,
    scopeReference,
    direction,
    source: requireText(input.source, 'source', 300),
    documentNo,
    version: validateVersion(input.version),
    effectiveStartUtc: effectiveRange.startUtc,
    effectiveEndUtc: effectiveRange.endUtc,
    sourceTimeZone,
    status,
    objectLevel: scopeMetadata.objectLevel
  };
}

/**
 * 断言同编码 active 定义的有效期不重叠。
 * @param {object} db SQLite 连接。
 * @param {object} definition 定义候选。
 * @param {number|null} excludeId 排除主键。
 */
function assertDefinitionPeriodAvailable(db, definition, excludeId = null) {
  if (definition.status !== 'active') return;
  const existing = db.prepare(`SELECT id, effective_start_utc AS effectiveStartUtc,
    effective_end_utc AS effectiveEndUtc FROM benchmark_definitions
    WHERE benchmark_code = ? AND status = 'active' AND id <> COALESCE(?, -1)
    ORDER BY id`).all(definition.benchmarkCode, excludeId).find((item) => (
    Date.parse(item.effectiveStartUtc) < Date.parse(definition.effectiveEndUtc)
      && Date.parse(item.effectiveEndUtc) > Date.parse(definition.effectiveStartUtc)
  ));
  if (existing) {
    throw benchmarkError('BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP', '同一对标编码的 active 定义有效期重叠。', { conflictingDefinitionId: existing.id });
  }
}

/**
 * 将 SQLite 唯一约束错误转换为稳定版本冲突。
 * @param {Error} error 原始错误。
 */
function rethrowDefinitionWriteError(error) {
  if (String(error?.message || '').includes('benchmark_definitions.benchmark_code, benchmark_definitions.version')) {
    throw benchmarkError('BENCHMARK_DEFINITION_UNIQUE_KEY_CONFLICT', '同一对标编码和版本已存在。');
  }
  throw error;
}

/**
 * 查询对标定义列表。
 * @param {object} query 查询条件。
 * @param {object} options 可选依赖。
 * @returns {object} 分页结果。
 */
function listBenchmarkDefinitions(query = {}, options = {}) {
  return withDatabase(options, (db) => {
    const pagination = normalizePagination(query);
    const conditions = [];
    const parameters = [];
    if (query.status) {
      if (!BENCHMARK_STATUSES.includes(query.status)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 不受支持。');
      conditions.push('d.status = ?');
      parameters.push(query.status);
    }
    if (query.benchmarkType) {
      if (!BENCHMARK_TYPES.includes(query.benchmarkType)) throw benchmarkError('INVALID_BENCHMARK_TYPE', 'benchmarkType 不受支持。');
      conditions.push('d.benchmark_type = ?');
      parameters.push(query.benchmarkType);
    }
    ['benchmarkCode', 'metricCode', 'scopeType', 'scopeReference'].forEach((fieldName) => {
      if (query[fieldName] === undefined) return;
      const columnNames = {
        benchmarkCode: 'd.benchmark_code',
        metricCode: 'd.metric_code',
        scopeType: 'd.scope_type',
        scopeReference: 'd.scope_reference'
      };
      conditions.push(`${columnNames[fieldName]} = ?`);
      parameters.push(requireText(query[fieldName], fieldName, 200));
    });
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM benchmark_definitions d${whereClause}`).get(...parameters).count);
    const items = db.prepare(`${DEFINITION_SELECT}${whereClause}
      ORDER BY d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...parameters, pagination.pageSize, pagination.offset);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  });
}

/**
 * 查询对标定义详情及其目标版本。
 * @param {*} definitionId 定义主键。
 * @param {object} options 可选依赖。
 * @returns {object} 定义详情。
 */
function getBenchmarkDefinition(definitionId, options = {}) {
  return withDatabase(options, (db) => {
    const definition = requireDefinition(db, definitionId);
    const targets = db.prepare(`${TARGET_SELECT} WHERE t.benchmark_definition_id = ? ORDER BY t.created_at DESC, t.id DESC`)
      .all(definition.id).map(mapTarget);
    return { ...definition, targets };
  });
}

/**
 * 新增外部标准或人工标杆定义。
 * @param {object} input 定义输入。
 * @param {object} options 可选依赖。
 * @returns {object} 新定义。
 */
function createBenchmarkDefinition(input, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const definition = normalizeDefinitionInput(db, input, false);
      assertDefinitionPeriodAvailable(db, definition);
      try {
        const result = db.prepare(`INSERT INTO benchmark_definitions (
          benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
          scope_type, scope_reference, direction, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          definition.benchmarkCode, definition.benchmarkName, definition.benchmarkType,
          definition.metricCode, definition.unit, definition.periodType, definition.scopeType,
          definition.scopeReference, definition.direction, definition.source, definition.documentNo,
          definition.version, definition.effectiveStartUtc, definition.effectiveEndUtc,
          definition.sourceTimeZone, definition.status
        );
        const created = requireDefinition(db, Number(result.lastInsertRowid));
        insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.definitionCreate,
          'benchmark_definition', created.id, null, created);
        return created;
      } catch (error) {
        rethrowDefinitionWriteError(error);
      }
    });
    return transaction();
  });
}

/**
 * 修改对标定义；存在目标版本时禁止改变口径字段。
 * @param {*} definitionId 定义主键。
 * @param {object} input 完整定义输入。
 * @param {object} options 可选依赖。
 * @returns {object} 修改后定义。
 */
function updateBenchmarkDefinition(definitionId, input, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const current = requireDefinition(db, definitionId);
      if (current.benchmarkType === 'internal_history_baseline') {
        throw benchmarkError('INTERNAL_HISTORY_BENCHMARK_IMMUTABLE', '内部历史基准定义创建后不可修改，只能启用或停用。');
      }
      const definition = normalizeDefinitionInput(db, input, false);
      const targetCount = Number(db.prepare('SELECT COUNT(*) AS count FROM benchmark_targets WHERE benchmark_definition_id = ?').get(current.id).count);
      const immutableFields = [
        'benchmarkCode', 'benchmarkType', 'metricCode', 'unit', 'periodType', 'scopeType',
        'scopeReference', 'direction', 'source', 'documentNo', 'version', 'effectiveStartUtc',
        'effectiveEndUtc', 'sourceTimeZone'
      ];
      const changedImmutableFields = targetCount > 0
        ? immutableFields.filter((fieldName) => current[fieldName] !== definition[fieldName])
        : [];
      if (changedImmutableFields.length > 0) {
        throw benchmarkError('BENCHMARK_DEFINITION_VERSION_CONFLICT', '定义已有目标版本，不能直接修改对标口径；请创建新定义版本。', { fields: changedImmutableFields });
      }
      assertDefinitionPeriodAvailable(db, definition, current.id);
      try {
        db.prepare(`UPDATE benchmark_definitions SET
          benchmark_code = ?, benchmark_name = ?, benchmark_type = ?, metric_code = ?, unit = ?,
          period_type = ?, scope_type = ?, scope_reference = ?, direction = ?, source = ?, document_no = ?,
          version = ?, effective_start_utc = ?, effective_end_utc = ?, source_timezone = ?, status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(
          definition.benchmarkCode, definition.benchmarkName, definition.benchmarkType,
          definition.metricCode, definition.unit, definition.periodType, definition.scopeType,
          definition.scopeReference, definition.direction, definition.source, definition.documentNo,
          definition.version, definition.effectiveStartUtc, definition.effectiveEndUtc,
          definition.sourceTimeZone, definition.status, current.id
        );
        const updated = requireDefinition(db, current.id);
        insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.definitionUpdate,
          'benchmark_definition', updated.id, current, updated);
        return updated;
      } catch (error) {
        rethrowDefinitionWriteError(error);
      }
    });
    return transaction();
  });
}

/**
 * 启用或停用对标定义。
 * @param {*} definitionId 定义主键。
 * @param {*} status 目标状态。
 * @param {object} options 可选依赖。
 * @returns {object} 修改后定义。
 */
function setBenchmarkDefinitionStatus(definitionId, status, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const definition = requireDefinition(db, definitionId);
      const normalizedStatus = requireText(status, 'status', 20);
      if (!BENCHMARK_STATUSES.includes(normalizedStatus)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 仅支持 active 或 inactive。');
      assertDefinitionPeriodAvailable(db, { ...definition, status: normalizedStatus }, definition.id);
      db.prepare(`UPDATE benchmark_definitions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(normalizedStatus, definition.id);
      const updated = requireDefinition(db, definition.id);
      insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.definitionStatus,
        'benchmark_definition', updated.id, definition, updated);
      return updated;
    });
    return transaction();
  });
}

/**
 * 查询目标列表。
 * @param {object} query 查询条件。
 * @param {object} options 可选依赖。
 * @returns {object} 分页结果。
 */
function listBenchmarkTargets(query = {}, options = {}) {
  return withDatabase(options, (db) => {
    const pagination = normalizePagination(query);
    const conditions = [];
    const parameters = [];
    if (query.definitionId !== undefined) {
      conditions.push('t.benchmark_definition_id = ?');
      parameters.push(positiveInteger(query.definitionId, 'definitionId'));
    }
    if (query.status) {
      if (!BENCHMARK_STATUSES.includes(query.status)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 不受支持。');
      conditions.push('t.status = ?');
      parameters.push(query.status);
    }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM benchmark_targets t${whereClause}`).get(...parameters).count);
    const items = db.prepare(`${TARGET_SELECT}${whereClause} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, pagination.pageSize, pagination.offset).map(mapTarget);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  });
}

/**
 * 查询目标详情并附带定义摘要。
 * @param {*} targetId 目标主键。
 * @param {object} options 可选依赖。
 * @returns {object} 目标详情。
 */
function getBenchmarkTarget(targetId, options = {}) {
  return withDatabase(options, (db) => {
    const target = requireTarget(db, targetId);
    return { ...target, definition: requireDefinition(db, target.benchmarkDefinitionId) };
  });
}

/**
 * 按定义方向规范化普通目标值结构。
 * @param {object} definition 对标定义。
 * @param {object} input 目标输入。
 * @returns {object} 规范化目标。
 */
function normalizeTargetInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw benchmarkError('BENCHMARK_INVALID_INPUT', '目标输入必须是对象。');
  if (definition.benchmarkType === 'internal_history_baseline') {
    throw benchmarkError('INTERNAL_HISTORY_BENCHMARK_TARGET_IMMUTABLE', '内部历史基准目标只能由原子固化接口创建。');
  }
  const targetValue = finiteNumber(input.targetValue, 'targetValue', true);
  const lowerBound = finiteNumber(input.lowerBound, 'lowerBound', true);
  const upperBound = finiteNumber(input.upperBound, 'upperBound', true);
  if (definition.direction === 'range') {
    if (targetValue !== null || lowerBound === null || upperBound === null || lowerBound > upperBound) {
      throw benchmarkError('INVALID_BENCHMARK_TARGET_RANGE', 'range 方向必须只填写合法 lowerBound 和 upperBound。');
    }
  } else if (targetValue === null || lowerBound !== null || upperBound !== null) {
    throw benchmarkError('INVALID_BENCHMARK_TARGET_VALUE_STRUCTURE', `${definition.direction} 方向必须且只能填写 targetValue。`);
  }
  const status = input.status === undefined ? 'active' : requireText(input.status, 'status', 20);
  if (!BENCHMARK_STATUSES.includes(status)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 仅支持 active 或 inactive。');
  return {
    targetValue,
    lowerBound,
    upperBound,
    version: validateVersion(input.version),
    status
  };
}

/**
 * 断言同一定义只有一个 active 目标由维护接口选中。
 * @param {object} db SQLite 连接。
 * @param {number} definitionId 定义主键。
 * @param {string} status 候选状态。
 * @param {number|null} excludeId 排除目标主键。
 */
function assertActiveTargetAvailable(db, definitionId, status, excludeId = null) {
  if (status !== 'active') return;
  const existing = db.prepare(`SELECT id FROM benchmark_targets
    WHERE benchmark_definition_id = ? AND status = 'active' AND id <> COALESCE(?, -1) LIMIT 1`)
    .get(definitionId, excludeId);
  if (existing) throw benchmarkError('BENCHMARK_TARGET_ACTIVE_CONFLICT', '同一对标定义只能有一个由维护接口选中的 active 目标。', { conflictingTargetId: existing.id });
}

/**
 * 将目标唯一约束错误转换为稳定版本冲突。
 * @param {Error} error 原始错误。
 */
function rethrowTargetWriteError(error) {
  if (String(error?.message || '').includes('benchmark_targets.benchmark_definition_id, benchmark_targets.version')) {
    throw benchmarkError('BENCHMARK_TARGET_UNIQUE_KEY_CONFLICT', '同一对标定义和目标版本已存在。');
  }
  throw error;
}

/**
 * 新增普通对标目标版本。
 * @param {object} input 目标输入。
 * @param {object} options 可选依赖。
 * @returns {object} 新目标。
 */
function createBenchmarkTarget(input, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const definition = requireDefinition(db, input?.benchmarkDefinitionId);
      if (definition.status !== 'active') throw benchmarkError('BENCHMARK_DEFINITION_INACTIVE', '停用定义不能新增目标。');
      const target = normalizeTargetInput(definition, input);
      assertActiveTargetAvailable(db, definition.id, target.status);
      try {
        const result = db.prepare(`INSERT INTO benchmark_targets (
          benchmark_definition_id, target_value, lower_bound, upper_bound, is_frozen,
          auto_refresh, version, status
        ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`).run(
          definition.id, target.targetValue, target.lowerBound, target.upperBound, target.version, target.status
        );
        const created = requireTarget(db, Number(result.lastInsertRowid));
        insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.targetCreate,
          'benchmark_target', created.id, null, created);
        return created;
      } catch (error) {
        rethrowTargetWriteError(error);
      }
    });
    return transaction();
  });
}

/**
 * 通过新增后继版本修改普通目标，保留旧目标事实以满足版本追溯。
 * @param {*} targetId 前一目标主键。
 * @param {object} input 后继目标输入。
 * @param {object} options 可选依赖。
 * @returns {object} 新目标及前一版本主键。
 */
function updateBenchmarkTarget(targetId, input, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const current = requireTarget(db, targetId);
      const definition = requireDefinition(db, current.benchmarkDefinitionId);
      if (definition.benchmarkType === 'internal_history_baseline' || current.isFrozen) {
        throw benchmarkError('INTERNAL_HISTORY_BENCHMARK_TARGET_IMMUTABLE', '固化内部历史目标不可修改，只能启用或停用。');
      }
      const target = normalizeTargetInput(definition, input);
      if (target.version === current.version) {
        throw benchmarkError('BENCHMARK_TARGET_VERSION_CONFLICT', '修改目标必须提供新的版本；旧版本会保留用于追溯。');
      }
      assertActiveTargetAvailable(db, definition.id, target.status, current.id);
      if (target.status === 'active' && current.status === 'active') {
        db.prepare(`UPDATE benchmark_targets SET status = 'inactive',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(current.id);
      }
      try {
        const result = db.prepare(`INSERT INTO benchmark_targets (
          benchmark_definition_id, target_value, lower_bound, upper_bound, is_frozen,
          auto_refresh, version, status
        ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`).run(
          definition.id, target.targetValue, target.lowerBound, target.upperBound, target.version, target.status
        );
        const created = { ...requireTarget(db, Number(result.lastInsertRowid)), predecessorTargetId: current.id };
        const predecessorAfter = requireTarget(db, current.id);
        insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.targetVersion,
          'benchmark_target', created.id, current, { predecessor: predecessorAfter, successor: created });
        return created;
      } catch (error) {
        rethrowTargetWriteError(error);
      }
    });
    return transaction();
  });
}

/**
 * 启用或停用目标版本。
 * @param {*} targetId 目标主键。
 * @param {*} status 目标状态。
 * @param {object} options 可选依赖。
 * @returns {object} 修改后目标。
 */
function setBenchmarkTargetStatus(targetId, status, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      const target = requireTarget(db, targetId);
      const normalizedStatus = requireText(status, 'status', 20);
      if (!BENCHMARK_STATUSES.includes(normalizedStatus)) throw benchmarkError('INVALID_BENCHMARK_STATUS', 'status 仅支持 active 或 inactive。');
      assertActiveTargetAvailable(db, target.benchmarkDefinitionId, normalizedStatus, target.id);
      db.prepare(`UPDATE benchmark_targets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(normalizedStatus, target.id);
      const updated = requireTarget(db, target.id);
      insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.targetStatus,
        'benchmark_target', updated.id, target, updated);
      return updated;
    });
    return transaction();
  });
}

/**
 * 断言对象仅包含内部历史接口允许字段。
 * @param {*} input 输入对象。
 * @param {string[]} allowedFields 允许字段。
 * @param {string} fieldName 对象名称。
 */
function assertInternalBaselineAllowedFields(input, allowedFields, fieldName) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw benchmarkError('BENCHMARK_INVALID_INPUT', `${fieldName} 必须是对象。`);
  }
  const unsupportedFields = Object.keys(input).filter((key) => !allowedFields.includes(key));
  const derivedFields = ['snapshot', 'frozenValue', 'sampleCount', 'productionSummary',
    'productionSummaryJson', 'sourceDataDigest', 'frozenAt', 'targetValue', 'version', 'status'];
  const rejectedDerivedFields = unsupportedFields.filter((key) => derivedFields.includes(key));
  if (rejectedDerivedFields.length > 0) {
    throw benchmarkError('INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN', '内部历史派生事实必须由服务端从权威数据计算，客户端不得提交。', {
      fields: rejectedDerivedFields
    });
  }
  if (unsupportedFields.length > 0) {
    throw benchmarkError('INTERNAL_BASELINE_INPUT_FIELD_UNSUPPORTED', `${fieldName} 包含不支持字段。`, {
      fields: unsupportedFields
    });
  }
}

/**
 * 将月初 UTC 左闭右开参考期转换为月份列表。
 * @param {object} input 参考期输入。
 * @returns {{startUtc:string,endUtc:string,startMonth:string,endMonth:string,months:string[]}} 规范参考期。
 */
function normalizeInternalReferencePeriod(input) {
  assertInternalBaselineAllowedFields(input, ['startUtc', 'endUtc'], 'referencePeriod');
  const range = validateUtcRange(input.startUtc, input.endUtc, 'reference');
  const startDate = new Date(range.startUtc);
  const endDate = new Date(range.endUtc);
  const isMonthBoundary = (value) => value.getUTCDate() === 1
    && value.getUTCHours() === 0 && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
  if (!isMonthBoundary(startDate) || !isMonthBoundary(endDate)) {
    throw benchmarkError('INTERNAL_BASELINE_REFERENCE_PERIOD_NOT_MONTH_ALIGNED', '月度内部历史参考期必须按 UTC 月初左闭右开对齐。');
  }
  const months = [];
  const cursor = new Date(startDate.getTime());
  while (cursor < endDate && months.length <= 1200) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  if (months.length === 0 || months.length > 1200) {
    throw benchmarkError('INTERNAL_BASELINE_REFERENCE_PERIOD_UNSUPPORTED', '内部历史参考期月份数必须在 1 至 1200 之间。');
  }
  return {
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    startMonth: months[0],
    endMonth: months[months.length - 1],
    months
  };
}

/**
 * 解析内部历史显式产能和能源范围。
 * @param {object} db SQLite 连接。
 * @param {object} input 显式范围输入。
 * @returns {object} 权威范围元数据。
 */
function resolveInternalCalculationScope(db, input) {
  assertInternalBaselineAllowedFields(input, ['productionUnitId', 'energyTypeCode'], 'calculationScope');
  const productionUnitId = positiveInteger(input.productionUnitId, 'productionUnitId');
  const energyTypeCode = requireText(input.energyTypeCode, 'energyTypeCode', 100);
  const production = db.prepare(`SELECT production.id, production.unit_code AS unitCode,
    production.unit_name AS unitName, production.organization_unit_id AS organizationUnitId,
    production.product_name AS productName, production.output_unit AS outputUnit,
    production.status, organization.unit_code AS organizationUnitCode,
    organization.unit_name AS organizationUnitName, organization.status AS organizationStatus
    FROM production_units production JOIN organization_units organization
      ON organization.id = production.organization_unit_id WHERE production.id = ?`).get(productionUnitId);
  if (!production) throw benchmarkError('INTERNAL_BASELINE_PRODUCTION_UNIT_NOT_FOUND', '显式产能单元不存在。');
  if (production.status !== 'active' || production.organizationStatus !== 'active') {
    throw benchmarkError('INTERNAL_BASELINE_PRODUCTION_SCOPE_INACTIVE', '显式产能单元或所属组织已停用。');
  }
  const energy = db.prepare(`SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
    FROM energy_types WHERE code = ?`).get(energyTypeCode);
  if (!energy) throw benchmarkError('INTERNAL_BASELINE_ENERGY_TYPE_NOT_FOUND', '显式能源类型不存在。');
  if (Number(energy.isActive) !== 1) throw benchmarkError('INTERNAL_BASELINE_ENERGY_TYPE_INACTIVE', '显式能源类型已停用。');
  return { production, energy };
}

/**
 * 校验内部历史定义与服务端计算口径完全兼容。
 * @param {object} definition 对标定义。
 * @param {object} scope 显式范围。
 */
function assertInternalCalculationCompatibility(definition, scope) {
  if (definition.metricCode !== INTERNAL_BASELINE_SUPPORTED_METRIC) {
    throw benchmarkError('INTERNAL_BASELINE_METRIC_UNSUPPORTED', '当前只能从权威数据安全计算 energy_intensity 内部历史基准。', {
      metricCode: definition.metricCode
    });
  }
  if (definition.periodType !== 'month') {
    throw benchmarkError('INTERNAL_BASELINE_PERIOD_TYPE_UNSUPPORTED', '当前内部历史固化仅支持 month 周期。');
  }
  if (definition.direction === 'range') {
    throw benchmarkError('INTERNAL_HISTORY_RANGE_UNSUPPORTED', '当前 schema 的内部历史固化值仅支持单值方向。');
  }
  const expectedUnit = `${scope.energy.standardUnit}/${scope.production.outputUnit}`;
  if (definition.unit !== expectedUnit) {
    throw benchmarkError('INTERNAL_BASELINE_UNIT_INCOMPATIBLE', '定义单位与权威能源标准单位和产量单位不兼容。', {
      expectedUnit,
      actualUnit: definition.unit
    });
  }
  const scopeMatches = (definition.scopeType === 'organization'
    && definition.scopeReference === scope.production.organizationUnitCode)
    || (definition.scopeType === 'energy' && definition.scopeReference === scope.energy.code)
    || (definition.scopeType === 'product'
      && [scope.production.unitCode, scope.production.productName].includes(definition.scopeReference));
  if (!scopeMatches) {
    throw benchmarkError('INTERNAL_BASELINE_SCOPE_MISMATCH', '定义范围与显式产能、组织或能源范围不匹配。');
  }
}

/**
 * 从权威能耗和产量事实计算不可刷新的内部历史快照。
 * @param {object} db SQLite 连接。
 * @param {object} definition 对标定义。
 * @param {object} referencePeriod 规范参考期。
 * @param {object} scope 显式范围。
 * @param {object} options 服务选项。
 * @returns {object} 服务端派生固化事实。
 */
function calculateInternalHistorySnapshot(db, definition, referencePeriod, scope, options) {
  const outputRows = db.prepare(`SELECT id, normalized_month AS normalizedMonth,
    output_value AS outputValue, output_unit AS outputUnit, data_source AS dataSource
    FROM production_output_records WHERE production_unit_id = ? AND record_status = 'active'
      AND normalized_month BETWEEN ? AND ? ORDER BY normalized_month, id
    LIMIT ${INTERNAL_BASELINE_MAX_SOURCE_RECORDS + 1}`).all(
    scope.production.id, referencePeriod.startMonth, referencePeriod.endMonth
  );
  const energyRows = db.prepare(`SELECT record.id, record.normalized_month AS normalizedMonth,
    record.normalized_value AS normalizedValue, record.normalized_unit AS normalizedUnit,
    record.energy_type_id AS energyTypeId
    FROM energy_records record WHERE record.organization_unit_id = ?
      AND record.energy_type_id = ? AND record.record_status = 'active'
      AND record.normalized_month BETWEEN ? AND ? ORDER BY record.normalized_month, record.id
    LIMIT ${INTERNAL_BASELINE_MAX_SOURCE_RECORDS + 1}`).all(
    scope.production.organizationUnitId, scope.energy.id,
    referencePeriod.startMonth, referencePeriod.endMonth
  );
  if (outputRows.length > INTERNAL_BASELINE_MAX_SOURCE_RECORDS
    || energyRows.length > INTERNAL_BASELINE_MAX_SOURCE_RECORDS) {
    throw benchmarkError('INTERNAL_BASELINE_SOURCE_RECORD_LIMIT_EXCEEDED', '内部历史来源事实超过安全读取上限，请缩小参考期。', {
      maximumRecordsPerSource: INTERNAL_BASELINE_MAX_SOURCE_RECORDS
    });
  }
  const outputByMonth = new Map(referencePeriod.months.map((month) => [month, []]));
  const energyByMonth = new Map(referencePeriod.months.map((month) => [month, []]));
  outputRows.forEach((row) => outputByMonth.get(row.normalizedMonth)?.push(row));
  energyRows.forEach((row) => energyByMonth.get(row.normalizedMonth)?.push(row));
  let totalOutput = 0;
  let totalEnergy = 0;
  const monthly = referencePeriod.months.map((month) => {
    const monthOutputRows = outputByMonth.get(month);
    const monthEnergyRows = energyByMonth.get(month);
    if (monthEnergyRows.length === 0) {
      throw benchmarkError('INTERNAL_BASELINE_ENERGY_DATA_MISSING', '参考期存在缺失的 active 能耗事实，不能固化。', { month });
    }
    if (monthOutputRows.length === 0) {
      throw benchmarkError('INTERNAL_BASELINE_PRODUCTION_DATA_MISSING', '参考期存在缺失的 active 产量事实，不能固化。', { month });
    }
    if (monthEnergyRows.some((row) => row.normalizedUnit !== scope.energy.standardUnit)) {
      throw benchmarkError('INTERNAL_BASELINE_ENERGY_UNIT_INCOMPATIBLE', '参考期能耗 normalized_unit 与能源标准单位不一致。', { month });
    }
    if (monthOutputRows.some((row) => row.outputUnit !== scope.production.outputUnit)) {
      throw benchmarkError('INTERNAL_BASELINE_OUTPUT_UNIT_INCOMPATIBLE', '参考期产量单位与产能单元主数据不一致。', { month });
    }
    const energyValue = roundAnalysisValue(monthEnergyRows.reduce(
      (sum, row) => sum + Number(row.normalizedValue), 0
    ));
    const outputValue = roundAnalysisValue(monthOutputRows.reduce(
      (sum, row) => sum + Number(row.outputValue), 0
    ));
    if (!Number.isFinite(energyValue) || !Number.isFinite(outputValue)) {
      throw benchmarkError('INTERNAL_BASELINE_NUMERIC_OVERFLOW', '内部历史来源事实汇总发生数值溢出。', { month });
    }
    if (outputValue <= 0) {
      throw benchmarkError('INTERNAL_BASELINE_PRODUCTION_VALUE_ZERO', '参考期产量分母必须大于零。', { month });
    }
    totalEnergy += energyValue;
    totalOutput += outputValue;
    return {
      month,
      energyValue,
      outputValue,
      energyRecordCount: monthEnergyRows.length,
      outputRecordCount: monthOutputRows.length
    };
  });
  totalEnergy = roundAnalysisValue(totalEnergy);
  totalOutput = roundAnalysisValue(totalOutput);
  const frozenValue = roundAnalysisValue(totalEnergy / totalOutput);
  if (!Number.isFinite(frozenValue)) {
    throw benchmarkError('INTERNAL_BASELINE_NUMERIC_OVERFLOW', '内部历史固化值发生数值溢出。');
  }
  const digestPayload = {
    formulaVersion: INTERNAL_BASELINE_FORMULA_VERSION,
    definition: {
      metricCode: definition.metricCode,
      unit: definition.unit,
      periodType: definition.periodType,
      scopeType: definition.scopeType,
      scopeReference: definition.scopeReference,
      direction: definition.direction
    },
    referencePeriod: { startUtc: referencePeriod.startUtc, endUtc: referencePeriod.endUtc },
    calculationScope: {
      productionUnitId: scope.production.id,
      organizationUnitId: scope.production.organizationUnitId,
      energyTypeId: scope.energy.id,
      energyTypeCode: scope.energy.code
    },
    outputRows,
    energyRows
  };
  const sourceDataDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(digestPayload)).digest('hex')}`;
  const evidenceLimit = 100;
  const productionSummary = {
    formulaVersion: INTERNAL_BASELINE_FORMULA_VERSION,
    productionUnitId: scope.production.id,
    productionUnitCode: scope.production.unitCode,
    organizationUnitId: scope.production.organizationUnitId,
    organizationUnitCode: scope.production.organizationUnitCode,
    energyTypeId: scope.energy.id,
    energyTypeCode: scope.energy.code,
    energyUnit: scope.energy.standardUnit,
    outputUnit: scope.production.outputUnit,
    intensityUnit: definition.unit,
    totalEnergy,
    totalOutput,
    months: monthly,
    energyRecordCount: energyRows.length,
    outputRecordCount: outputRows.length,
    energyRecordIds: energyRows.slice(0, evidenceLimit).map((row) => Number(row.id)),
    outputRecordIds: outputRows.slice(0, evidenceLimit).map((row) => Number(row.id)),
    evidenceIdsTruncated: energyRows.length > evidenceLimit || outputRows.length > evidenceLimit
  };
  const nowValue = typeof options?.now === 'function' ? options.now() : new Date();
  const frozenAt = nowValue instanceof Date ? nowValue.toISOString() : new Date(nowValue).toISOString();
  return {
    referenceStartUtc: referencePeriod.startUtc,
    referenceEndUtc: referencePeriod.endUtc,
    frozenValue,
    frozenAt,
    sampleCount: referencePeriod.months.length,
    productionSummaryJson: JSON.stringify(productionSummary),
    sourceDataDigest,
    version: definition.version,
    status: definition.status
  };
}

/**
 * 原子创建内部历史定义和服务端计算的不可刷新固化目标。
 * @param {object} input 定义、参考期与显式计算范围。
 * @param {object} options 可选依赖和事务测试钩子。
 * @returns {object} 新建内部历史基准。
 */
function createInternalHistoryBenchmark(input, options = {}) {
  return withDatabase(options, (db) => {
    const transaction = db.transaction(() => {
      requireAuditActor(options);
      assertInternalBaselineAllowedFields(input, ['definition', 'referencePeriod', 'calculationScope'], 'internalHistory');
      assertInternalBaselineAllowedFields(input.definition, [
        'benchmarkCode', 'benchmarkName', 'benchmarkType', 'metricCode', 'unit', 'periodType',
        'scopeType', 'scopeReference', 'direction', 'source', 'documentNo', 'version',
        'effectiveStartUtc', 'effectiveEndUtc', 'sourceTimeZone', 'status'
      ], 'definition');
      const definition = normalizeDefinitionInput(db, input.definition, true);
      if (definition.benchmarkType !== 'internal_history_baseline') {
        throw benchmarkError('INVALID_BENCHMARK_TYPE', '原子固化接口仅支持 internal_history_baseline。');
      }
      const referencePeriod = normalizeInternalReferencePeriod(input.referencePeriod);
      const calculationScope = resolveInternalCalculationScope(db, input.calculationScope);
      assertInternalCalculationCompatibility(definition, calculationScope);
      const snapshot = calculateInternalHistorySnapshot(db, definition, referencePeriod, calculationScope, options);
      assertDefinitionPeriodAvailable(db, definition);
      let definitionResult;
      try {
        definitionResult = db.prepare(`INSERT INTO benchmark_definitions (
          benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
          scope_type, scope_reference, direction, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          definition.benchmarkCode, definition.benchmarkName, definition.benchmarkType,
          definition.metricCode, definition.unit, definition.periodType, definition.scopeType,
          definition.scopeReference, definition.direction, definition.source, definition.documentNo,
          definition.version, definition.effectiveStartUtc, definition.effectiveEndUtc,
          definition.sourceTimeZone, definition.status
        );
      } catch (error) {
        rethrowDefinitionWriteError(error);
      }
      const definitionId = Number(definitionResult.lastInsertRowid);
      if (typeof options.afterDefinitionInsert === 'function') options.afterDefinitionInsert({ db, definitionId });
      let targetResult;
      try {
        targetResult = db.prepare(`INSERT INTO benchmark_targets (
          benchmark_definition_id, target_value, lower_bound, upper_bound,
          reference_start_utc, reference_end_utc, frozen_value, frozen_at, sample_count,
          production_summary_json, source_data_digest, is_frozen, auto_refresh, version, status
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`).run(
          definitionId, snapshot.frozenValue, snapshot.referenceStartUtc, snapshot.referenceEndUtc,
          snapshot.frozenValue, snapshot.frozenAt, snapshot.sampleCount, snapshot.productionSummaryJson,
          snapshot.sourceDataDigest, snapshot.version, snapshot.status
        );
      } catch (error) {
        rethrowTargetWriteError(error);
      }
      const targetId = Number(targetResult.lastInsertRowid);
      if (typeof options.afterTargetInsert === 'function') options.afterTargetInsert({ db, definitionId, targetId });
      const result = {
        definition: requireDefinition(db, definitionId),
        target: requireTarget(db, targetId)
      };
      insertTransactionalAudit(db, options, ENERGY_BENCHMARK_AUDIT_OPERATIONS.internalHistoryCreate,
        'internal_history_benchmark', definitionId, null, result);
      return result;
    });
    return transaction();
  });
}

/**
 * 解析执行使用的唯一目标版本。
 * @param {object} db SQLite 连接。
 * @param {object} definition 对标定义。
 * @param {*} targetId 可选目标主键。
 * @returns {object} 目标。
 */
function resolveExecutionTarget(db, definition, targetId) {
  if (targetId !== undefined && targetId !== null && targetId !== '') {
    const target = requireTarget(db, targetId);
    if (target.benchmarkDefinitionId !== definition.id) {
      throw benchmarkError('BENCHMARK_TARGET_DEFINITION_MISMATCH', '目标不属于指定定义。');
    }
    return target;
  }
  const activeTargets = db.prepare(`${TARGET_SELECT} WHERE t.benchmark_definition_id = ? AND t.status = 'active' ORDER BY t.id`)
    .all(definition.id).map(mapTarget);
  if (activeTargets.length === 0) throw benchmarkError('BENCHMARK_ACTIVE_TARGET_NOT_FOUND', '定义没有 active 目标。');
  if (activeTargets.length > 1) throw benchmarkError('BENCHMARK_ACTIVE_TARGET_AMBIGUOUS', '定义存在多个 active 目标，必须显式指定 targetId。');
  return activeTargets[0];
}

/**
 * 读取定义范围的对象层级。
 * @param {object} db SQLite 连接。
 * @param {object} definition 对标定义。
 * @returns {string} 对象层级。
 */
function getDefinitionObjectLevel(db, definition) {
  if (definition.scopeType === 'organization') {
    const organization = db.prepare('SELECT unit_type AS objectLevel FROM organization_units WHERE unit_code = ?').get(definition.scopeReference);
    return organization?.objectLevel || 'organization';
  }
  return definition.scopeType;
}

/**
 * 判断实际值是否为显式有限数字，避免把空值改写为零。
 * @param {*} value 实际值。
 * @returns {boolean} 是否为显式有限数字。
 */
function hasFiniteActualValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验实际值与定义、目标的兼容性。
 * @param {object} db SQLite 连接。
 * @param {object} definition 对标定义。
 * @param {object} target 对标目标。
 * @param {object} actual 实际值上下文。
 * @param {object} groupContext 排名统一口径。
 * @returns {string[]} 不兼容原因码。
 */
function collectCompatibilityReasons(db, definition, target, actual, groupContext = {}) {
  const reasons = [];
  if (definition.status !== 'active') reasons.push(ENERGY_BENCHMARK_REASON_CODES.definitionInactive);
  if (target.status !== 'active') reasons.push(ENERGY_BENCHMARK_REASON_CODES.targetInactive);
  if (!hasFiniteActualValue(actual?.actualValue)) reasons.push(ENERGY_BENCHMARK_REASON_CODES.actualValueMissing);
  if (actual?.metricCode !== definition.metricCode) reasons.push(ENERGY_BENCHMARK_REASON_CODES.metricMismatch);
  if (actual?.unit !== definition.unit) reasons.push(ENERGY_BENCHMARK_REASON_CODES.unitMismatch);
  if (actual?.periodType !== definition.periodType) reasons.push(ENERGY_BENCHMARK_REASON_CODES.periodTypeMismatch);
  if (actual?.scopeType !== definition.scopeType) reasons.push(ENERGY_BENCHMARK_REASON_CODES.scopeTypeMismatch);
  const actualBenchmarkScope = actual?.benchmarkScopeReference ?? actual?.scopeReference;
  if (actualBenchmarkScope !== definition.scopeReference) reasons.push(ENERGY_BENCHMARK_REASON_CODES.scopeReferenceMismatch);
  const expectedObjectLevel = getDefinitionObjectLevel(db, definition);
  if (actual?.objectLevel !== expectedObjectLevel) reasons.push(ENERGY_BENCHMARK_REASON_CODES.objectLevelMismatch);
  if (groupContext.objectLevel && actual?.objectLevel !== groupContext.objectLevel) reasons.push(ENERGY_BENCHMARK_REASON_CODES.objectLevelMismatch);
  if (groupContext.metricCode && actual?.metricCode !== groupContext.metricCode) reasons.push(ENERGY_BENCHMARK_REASON_CODES.metricMismatch);
  if (groupContext.unit && actual?.unit !== groupContext.unit) reasons.push(ENERGY_BENCHMARK_REASON_CODES.unitMismatch);
  if (definition.scopeType === 'energy' && actual?.energyTypeCode !== definition.scopeReference) {
    reasons.push(ENERGY_BENCHMARK_REASON_CODES.energyTypeMismatch);
  }
  if (!isStrictUtcIso(actual?.periodStartUtc) || !isStrictUtcIso(actual?.periodEndUtc)
    || Date.parse(actual.periodStartUtc) >= Date.parse(actual.periodEndUtc)) {
    reasons.push(ENERGY_BENCHMARK_REASON_CODES.periodRangeInvalid);
  } else if (Date.parse(actual.periodStartUtc) < Date.parse(definition.effectiveStartUtc)
    || Date.parse(actual.periodEndUtc) > Date.parse(definition.effectiveEndUtc)) {
    reasons.push(ENERGY_BENCHMARK_REASON_CODES.outsideEffectivePeriod);
  }
  const validTarget = definition.direction === 'range'
    ? Number.isFinite(target.lowerBound) && Number.isFinite(target.upperBound) && target.lowerBound <= target.upperBound
    : Number.isFinite(target.targetValue);
  if (!validTarget) reasons.push(ENERGY_BENCHMARK_REASON_CODES.targetInvalid);
  return [...new Set(reasons)];
}

/**
 * 执行单个实际值对标，复用公共三方向算法。
 * @param {object} db SQLite 连接。
 * @param {object} definition 对标定义。
 * @param {object} target 对标目标。
 * @param {object} actual 实际值上下文。
 * @param {object} groupContext 排名统一口径。
 * @returns {object} 对标结果。
 */
function evaluateActual(db, definition, target, actual, groupContext = {}) {
  const reasonCodes = collectCompatibilityReasons(db, definition, target, actual, groupContext);
  const baseResult = {
    objectId: actual?.objectId ?? null,
    objectName: actual?.objectName ?? null,
    objectLevel: actual?.objectLevel ?? null,
    actualValue: hasFiniteActualValue(actual?.actualValue) ? Number(actual.actualValue) : null,
    direction: definition.direction,
    targetValue: target.targetValue,
    lowerBound: target.lowerBound,
    upperBound: target.upperBound,
    comparable: reasonCodes.length === 0,
    met: null,
    status: 'not_comparable',
    absoluteDifference: null,
    differenceRatio: null,
    reasonCodes
  };
  if (reasonCodes.length > 0) return baseResult;
  const scope = `${definition.scopeType}:${definition.scopeReference}`;
  const benchmark = {
    direction: definition.direction,
    metricCode: definition.metricCode,
    unit: definition.unit,
    periodType: definition.periodType,
    scope,
    targetValue: target.targetValue,
    lowerBound: target.lowerBound,
    upperBound: target.upperBound
  };
  const evaluation = evaluateBenchmark(Number(actual.actualValue), benchmark, {
    metricCode: actual.metricCode,
    unit: actual.unit,
    periodType: actual.periodType,
    scope,
    date: actual.periodStartUtc.slice(0, 10)
  });
  if (!evaluation.comparable) {
    return { ...baseResult, reasonCodes: [ENERGY_BENCHMARK_REASON_CODES.targetInvalid] };
  }
  return {
    ...baseResult,
    actualValue: evaluation.actualValue,
    targetValue: evaluation.targetValue,
    comparable: true,
    met: evaluation.met,
    status: evaluation.met ? 'met' : 'not_met',
    absoluteDifference: evaluation.absoluteDifference,
    differenceRatio: evaluation.differenceRatio,
    reasonCodes: []
  };
}

/**
 * 读取执行定义和目标并完成单值对标。
 * @param {object} input 执行输入。
 * @param {object} options 可选依赖。
 * @returns {object} 对标结果。
 */
function evaluateEnergyBenchmark(input, options = {}) {
  return withDatabase(options, (db) => {
    const definition = requireDefinition(db, input?.definitionId);
    const target = resolveExecutionTarget(db, definition, input?.targetId);
    return {
      definition: { id: definition.id, benchmarkCode: definition.benchmarkCode, version: definition.version },
      target: { id: target.id, version: target.version },
      result: evaluateActual(db, definition, target, input?.actual || {})
    };
  });
}

/**
 * 计算 range 方向排序使用的区间距离。
 * @param {object} item 已兼容结果。
 * @returns {number} 距离。
 */
function getRangeDistance(item) {
  if (item.actualValue < item.lowerBound) return item.lowerBound - item.actualValue;
  if (item.actualValue > item.upperBound) return item.actualValue - item.upperBound;
  return 0;
}

/**
 * 对兼容对象执行同口径排名，采用竞赛排名处理并列。
 * @param {object} input 排名输入。
 * @param {object} options 可选依赖。
 * @returns {object} 排名和排除结果。
 */
function rankEnergyBenchmark(input, options = {}) {
  return withDatabase(options, (db) => {
    const definition = requireDefinition(db, input?.definitionId);
    const target = resolveExecutionTarget(db, definition, input?.targetId);
    const actuals = Array.isArray(input?.actuals) ? input.actuals : [];
    if (actuals.length === 0) throw benchmarkError('BENCHMARK_ACTUALS_REQUIRED', 'actuals 至少包含一个对象。');
    if (actuals.length > BENCHMARK_MAX_PAGE_SIZE) throw benchmarkError('BENCHMARK_ACTUALS_LIMIT_EXCEEDED', `actuals 最多 ${BENCHMARK_MAX_PAGE_SIZE} 条。`);
    const groupContext = {
      objectLevel: getDefinitionObjectLevel(db, definition),
      metricCode: definition.metricCode,
      unit: definition.unit
    };
    const evaluations = actuals.map((actual) => evaluateActual(db, definition, target, actual, groupContext));
    const included = evaluations.filter((item) => item.comparable);
    included.sort((left, right) => {
      if (definition.direction === 'lower_better') return left.actualValue - right.actualValue;
      if (definition.direction === 'higher_better') return right.actualValue - left.actualValue;
      return getRangeDistance(left) - getRangeDistance(right) || left.actualValue - right.actualValue;
    });
    let previousScore = null;
    let previousRank = 0;
    const ranked = included.map((item, index) => {
      const score = definition.direction === 'range' ? getRangeDistance(item) : item.actualValue;
      const rank = previousScore !== null && score === previousScore ? previousRank : index + 1;
      previousScore = score;
      previousRank = rank;
      return { ...item, rank };
    });
    const excluded = evaluations.filter((item) => !item.comparable);
    return {
      definition: { id: definition.id, benchmarkCode: definition.benchmarkCode, version: definition.version },
      target: { id: target.id, version: target.version },
      ranked,
      excluded,
      summary: { inputCount: evaluations.length, rankedCount: ranked.length, excludedCount: excluded.length }
    };
  });
}

/**
 * 计算同口径兼容对象的达标率。
 * @param {object} input 合格率输入。
 * @param {object} options 可选依赖。
 * @returns {object} 达标率结果。
 */
function calculateBenchmarkQualificationRate(input, options = {}) {
  const ranking = rankEnergyBenchmark(input, options);
  const qualifiedCount = ranking.ranked.filter((item) => item.met).length;
  const denominator = ranking.ranked.length;
  return {
    definition: ranking.definition,
    target: ranking.target,
    qualifiedCount,
    denominator,
    qualificationRate: denominator === 0 ? null : qualifiedCount / denominator,
    excluded: ranking.excluded,
    reasonCodes: denominator === 0 ? ['BENCHMARK_NO_COMPARABLE_OBJECTS'] : []
  };
}

/**
 * 构建可供后续下载层使用的结构化导出行，不在领域服务虚构文件格式。
 * @param {object} input 导出输入。
 * @param {object} options 可选依赖。
 * @returns {object} 结构化导出结果。
 */
function buildBenchmarkExportRows(input, options = {}) {
  const ranking = rankEnergyBenchmark(input, options);
  const rows = [
    ...ranking.ranked.map((item) => ({ ...item, excluded: false })),
    ...ranking.excluded.map((item) => ({ ...item, rank: null, excluded: true }))
  ];
  return {
    columns: ['objectId', 'objectName', 'objectLevel', 'actualValue', 'targetValue', 'lowerBound', 'upperBound', 'absoluteDifference', 'differenceRatio', 'met', 'rank', 'excluded', 'reasonCodes'],
    rows,
    meta: { generatedFromExplicitActuals: true, rowCount: rows.length }
  };
}

module.exports = {
  BENCHMARK_DEFAULT_PAGE_SIZE,
  BENCHMARK_MAX_PAGE_SIZE,
  BENCHMARK_SCOPE_TYPES,
  BENCHMARK_STATUSES,
  ENERGY_BENCHMARK_REASON_CODES,
  buildBenchmarkExportRows,
  calculateBenchmarkQualificationRate,
  createBenchmarkDefinition,
  createBenchmarkTarget,
  createInternalHistoryBenchmark,
  evaluateEnergyBenchmark,
  getBenchmarkDefinition,
  getBenchmarkTarget,
  listBenchmarkDefinitions,
  listBenchmarkTargets,
  rankEnergyBenchmark,
  setBenchmarkDefinitionStatus,
  setBenchmarkTargetStatus,
  updateBenchmarkDefinition,
  updateBenchmarkTarget
};
