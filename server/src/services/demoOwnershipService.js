'use strict';

const crypto = require('crypto');
const path = require('path');
const { types: utilTypes } = require('util');
const { openDatabase } = require('../db/database');
const { AppError } = require('../utils/errors');
const {
  getDemoArtifactRegistration,
  requireDemoArtifactHandler
} = require('./demoArtifactRegistry');
const {
  markDemoContextExecutedInTransaction,
  validateDemoContext
} = require('./demoContextService');
const {
  getImportAuditSummary,
  updateExecuteAuditResult
} = require('./importAuditService');
const { requireDemoDatasetRun } = require('./demoRunService');
const {
  SUPPORTED_FORMULA_VERSION,
  SUPPORTED_METRIC_CODES,
  assertEnergyStrategyExactScopeCapability,
  bindEnergyStrategyRegistrationScopeCapability,
  consumeEnergyStrategyEvaluationCompletionWitness,
  markEnergyStrategyRegistrationScopeActive,
  markEnergyStrategyRegistrationScopeFailed,
  getStrategyRuleHitWithDb,
  insertOperationLogWithDb,
  parseEvidenceRequirements
} = require('./energyStrategyEvaluationService');
const {
  ENERGY_ANALYSIS_REASON_CODES,
  RULE_THRESHOLD_OPERATORS,
  isIanaTimeZone
} = require('./energyAnalysisContracts');

// 当前清理阶段只开放已经逐项核对删除副作用的静态实体类型；未知类型必须阻断而不是动态拼表。
const DEMO_CLEANUP_ENTITY_ORDER = Object.freeze([
  'prediction_config',
  'energy_record'
]);

// 允许清理的登记类型不包含 derived；派生数据尚未接入完整所有权注册与逆依赖治理。
const CLEANABLE_OWNERSHIP_KINDS = new Set(['imported', 'legacy_claimed']);
// 真实导入事务尚未接入 ownership registration，清理能力必须保持 fail-closed。
const DEMO_OWNERSHIP_REGISTRATION_CONNECTED = false;
// 公共登记只接受 ownership 私有事务 scope 中由声明式 helper 插入并见证的 imported 记录。
const DEMO_IMPORTED_OWNERSHIP_KIND = 'imported';
// registry 关系类型由服务端固定，调用方不得传入动态 SQL 或未知关系。
const DEMO_RELATION_TYPES = new Set(['contains', 'generated_from', 'uses_config', 'uses_factor']);
// inserted 记录必须绑定正整数主键；清理 handler 当前也只接受此类主键。
const DEMO_ENTITY_PK_PATTERN = /^[1-9]\d*$/;
// ownership 固定投影中的审计时间必须是严格 UTC 毫秒格式，禁止秒精度或本地墙钟值混入摘要。
const DEMO_UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// 能流业务时间使用严格 UTC 秒格式，与 ownership 审计时间的毫秒语义明确分离。
const DEMO_UTC_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// 能流来源墙钟只允许不带时区的分钟精度文本，时区由独立 source_timezone 表达。
const DEMO_WALL_CLOCK_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// 行见证只保存在当前 Node.js 进程的私有 WeakMap 中，普通 JSON 或调用方自造对象无法伪造。
const DEMO_INSERTED_ROW_WITNESS_STATE = new WeakMap();
// ownership 事务 scope 及连接当前 scope 均为模块私有状态，callback 结束后立即失效。
const DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE = new WeakMap();
const DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB = new WeakMap();
// strategy derived registration scope 只接受一次 issue/activate/consume/abort 生命周期。
const DEMO_STRATEGY_REGISTRATION_SCOPE_STATE = new WeakMap();
// inserted/skipped/relation 元数据采用服务端白名单，额外字段一律 fail-closed。
const DEMO_INSERTED_RECORD_FIELDS = Object.freeze(['entityType', 'entityPk', 'batchRole', 'sourceRowNumber', 'rowWitness']);
const DEMO_SKIPPED_RECORD_FIELDS = Object.freeze(['entityType', 'entityPk', 'batchRole', 'sourceRowNumber', 'reason']);
const DEMO_RELATION_FIELDS = Object.freeze(['from', 'to', 'relationType']);
const DEMO_RELATION_ENDPOINT_FIELDS = Object.freeze(['entityType', 'entityPk']);
// 抄表派生能耗登记只接受正式 meter service 返回的固定生成对字段。
const DEMO_DERIVED_METER_GENERATION_FIELDS = Object.freeze([
  'readingId', 'energyRecordId', 'normalizedMonth', 'normalizedUnit', 'normalizedValue',
  'duplicateKey', 'previousUpdatedAt', 'updatedAt'
]);
// 策略运行 scope_reference 只接受正式 evaluator 固定写入的四个字段。
const DEMO_STRATEGY_SCOPE_REFERENCE_FIELDS = Object.freeze([
  'meterDeviceId', 'energyTypeCode', 'unit', 'sourceTimeZone'
]);
// registration scope 领域绑定额外固定评价窗口，禁止 scope 与 evaluator 替换来源时序。
const DEMO_STRATEGY_DOMAIN_BINDING_FIELDS = Object.freeze([
  'meterDeviceId', 'energyTypeCode', 'unit', 'startUtc', 'endUtc', 'sourceTimeZone'
]);
// 策略证据快照只接受正式 evaluator insertStrategyRuleHit 固定写入的字段。
const DEMO_STRATEGY_EVIDENCE_FIELDS = Object.freeze([
  'evidence', 'evidencePolicy', 'dataSummaryDigest', 'evaluationDigest',
  'configurationErrors', 'recommendation', 'source', 'effectiveRange',
  'evidenceRequirements', 'automationBoundary'
]);
// 策略证据数量策略使用固定字段，禁止新增隐式上限或截断语义。
const DEMO_STRATEGY_EVIDENCE_POLICY_FIELDS = Object.freeze([
  'maxEvidenceItemsSemantics', 'requiredEvidenceCount', 'detailEvidenceLimit',
  'availableDetailEvidenceCount', 'returnedDetailEvidenceCount', 'detailEvidenceTruncated'
]);
// 策略规则有效期与证据要求沿用正式 evaluator 的固定结构。
const DEMO_STRATEGY_EFFECTIVE_RANGE_FIELDS = Object.freeze(['startUtc', 'endUtc', 'sourceTimeZone']);
const DEMO_STRATEGY_EVIDENCE_REQUIREMENT_FIELDS = Object.freeze([
  'minimumCoverageRate', 'maxEvidenceItems', 'savingBasis'
]);
// 策略自动化边界必须保持纯本地确定性评价和人工复核语义。
const DEMO_STRATEGY_AUTOMATION_BOUNDARY_FIELDS = Object.freeze([
  'usesAI', 'issuesControlCommand', 'changesDeviceState', 'requiresManualReview'
]);
// configurationErrors 只接受正式 evaluator 当前能够生成的稳定配置错误码。
const DEMO_STRATEGY_CONFIGURATION_ERRORS = Object.freeze([
  'INVALID_EVIDENCE_REQUIREMENTS_JSON',
  'INVALID_EVIDENCE_REQUIREMENTS_OBJECT',
  'UNKNOWN_EVIDENCE_REQUIREMENT_FIELD',
  'INVALID_EVIDENCE_MINIMUM_COVERAGE_RATE',
  'INVALID_EVIDENCE_MAX_ITEMS',
  'INVALID_EVIDENCE_SAVING_BASIS',
  'UNSUPPORTED_STRATEGY_METRIC',
  'STRATEGY_THRESHOLD_UNIT_MISMATCH',
  'STRATEGY_METRIC_UNIT_UNAVAILABLE'
]);
// 只有证据要求解析错误会使正式 evaluator 的 evidenceRequirements 降级为 null。
const DEMO_STRATEGY_EVIDENCE_REQUIREMENT_ERRORS = Object.freeze([
  'INVALID_EVIDENCE_REQUIREMENTS_JSON',
  'INVALID_EVIDENCE_REQUIREMENTS_OBJECT',
  'UNKNOWN_EVIDENCE_REQUIREMENT_FIELD',
  'INVALID_EVIDENCE_MINIMUM_COVERAGE_RATE',
  'INVALID_EVIDENCE_MAX_ITEMS',
  'INVALID_EVIDENCE_SAVING_BASIS'
]);
// 正式 evaluator 摘要始终使用带 sha256: 前缀的小写十六进制文本。
const DEMO_STRATEGY_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
// 正式 evidence requirements 解析器对不可恢复 JSON/object/max 错误统一回退到默认明细上限。
const DEMO_STRATEGY_DEFAULT_DETAIL_EVIDENCE_LIMIT = parseEvidenceRequirements('{invalid-json').maxEvidenceItems;
const DEMO_STRATEGY_FORCED_DEFAULT_EVIDENCE_ERRORS = Object.freeze([
  'INVALID_EVIDENCE_REQUIREMENTS_JSON',
  'INVALID_EVIDENCE_REQUIREMENTS_OBJECT',
  'INVALID_EVIDENCE_MAX_ITEMS'
]);

/** 对普通 JSON 值做稳定键排序，确保摘要不依赖对象属性插入顺序。 */
function normalizeDigestValue(value) {
  if (Array.isArray(value)) return value.map(normalizeDigestValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeDigestValue(value[key])]));
  }
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

/** 计算稳定 JSON 的 SHA-256 十六进制摘要。 */
function sha256Stable(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeDigestValue(value)), 'utf8')
    .digest('hex');
}

/** 规范化静态 handler 使用的整数主键，拒绝数字字符串的容错重写。 */
function normalizeIntegerEntityPk(entityPk) {
  const raw = String(entityPk || '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** 计算 registry identity 摘要；登记方和清理方必须使用相同域分隔。 */
function calculateDemoEntityIdentityDigest(entityType, entityPk) {
  return sha256Stable({
    domain: 'demo-entity-identity:v1',
    entityType: String(entityType || ''),
    entityPk: String(entityPk || '')
  });
}

/** 抛出固定 projection 字段类型错误。 */
function throwDemoProjectionFieldTypeError(fieldName, expectedType, value) {
  throw createDemoOwnershipError(
    'DEMO_OWNERSHIP_SNAPSHOT_FIELD_TYPE_INVALID',
    `${fieldName} 不符合固定 projection 字段类型合同。`,
    { fieldName, expectedType, actualType: value === null ? 'null' : typeof value },
    400
  );
}

/** 校验 projection 字段为可选 null 的有限整数。 */
function assertDemoProjectionInteger(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (!Number.isSafeInteger(value)) throwDemoProjectionFieldTypeError(fieldName, 'safe_integer', value);
  if (options.min !== undefined && value < options.min) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 超出固定 projection 数值范围。`,
      { fieldName, min: options.min, value },
      400
    );
  }
}

/** 校验 projection 字段为可选 null 的有限 number。 */
function assertDemoProjectionFiniteNumber(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwDemoProjectionFieldTypeError(fieldName, 'finite_number', value);
  }
  if (options.min !== undefined && value < options.min) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 超出固定 projection 数值范围。`,
      { fieldName, min: options.min, value },
      400
    );
  }
}

/** 校验 projection 字段为可选 null 的字符串。 */
function assertDemoProjectionString(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (typeof value !== 'string') throwDemoProjectionFieldTypeError(fieldName, 'string', value);
  if (options.nonEmpty === true && value.trim().length === 0) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 不得为空字符串。`,
      { fieldName },
      400
    );
  }
}

/** 校验 projection 字段为静态枚举字符串。 */
function assertDemoProjectionEnum(value, fieldName, allowedValues) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  if (!allowedValues.includes(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 不属于固定 projection 枚举。`,
      { fieldName, allowedValues, value },
      400
    );
  }
}

/** 校验 YYYY-MM 月份字符串。 */
function assertDemoProjectionMonth(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 必须是严格 YYYY-MM 月份。`,
      { fieldName, value },
      400
    );
  }
}

/** 校验业务日期保持来源墙钟语义，禁止由 UTC 转换造成日期漂移。 */
function assertDemoProjectionDate(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 必须是严格 YYYY-MM-DD 日期。`,
      { fieldName, value },
      400
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 必须是有效 YYYY-MM-DD 日期。`,
      { fieldName, value },
      400
    );
  }
}

// 当前只声明已经有固定业务表、主键、导入类型和快照字段的 ownership handler；不代表开放 cleanup capability。
const DEMO_OWNERSHIP_ENTITY_HANDLERS = Object.freeze({
  meter_reading: Object.freeze({
    entityType: 'meter_reading',
    tableName: 'meter_reading_records',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['meter_reading']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'meter_device_id', 'organization_unit_id', 'energy_type_id',
      'reading_date', 'normalized_month', 'previous_value', 'current_value', 'multiplier',
      'usage_value', 'original_unit', 'normalized_unit', 'normalized_usage_value', 'data_source',
      'record_status', 'remark', 'generated_energy_record_id', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.meter_device_id, 'snapshot.meter_device_id', { min: 1 });
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionDate(row.reading_date, 'snapshot.reading_date');
      assertDemoProjectionMonth(row.normalized_month, 'snapshot.normalized_month');
      assertDemoProjectionFiniteNumber(row.previous_value, 'snapshot.previous_value', { min: 0 });
      assertDemoProjectionFiniteNumber(row.current_value, 'snapshot.current_value', { min: 0 });
      assertDemoProjectionFiniteNumber(row.multiplier, 'snapshot.multiplier', { min: Number.MIN_VALUE });
      assertDemoProjectionFiniteNumber(row.usage_value, 'snapshot.usage_value', { min: 0 });
      assertDemoProjectionString(row.original_unit, 'snapshot.original_unit', { nonEmpty: true });
      assertDemoProjectionString(row.normalized_unit, 'snapshot.normalized_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.normalized_usage_value, 'snapshot.normalized_usage_value', { min: 0 });
      assertDemoProjectionEnum(row.data_source, 'snapshot.data_source', ['manual', 'upload', 'calculation']);
      assertDemoProjectionEnum(row.record_status, 'snapshot.record_status', ['active', 'void']);
      assertDemoProjectionString(row.remark, 'snapshot.remark', { nullable: true });
      assertDemoProjectionInteger(row.generated_energy_record_id, 'snapshot.generated_energy_record_id', { nullable: true, min: 1 });
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, meter_device_id, organization_unit_id, energy_type_id,
          reading_date, normalized_month, previous_value, current_value, multiplier, usage_value,
          original_unit, normalized_unit, normalized_usage_value, data_source, record_status, remark,
          generated_energy_record_id, created_at, updated_at
        FROM meter_reading_records WHERE id = ?`).get(entityPk) || null;
    }
  }),
  prediction_config: Object.freeze({
    entityType: 'prediction_config',
    tableName: 'prediction_configs',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['prediction_config']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'name', 'note',
      'energy_type_id', 'organization_unit_id', 'meter_device_id', 'source_batch_filter_id',
      'train_start_month', 'train_end_month', 'predict_start_month', 'predict_end_month',
      'algorithm', 'window_size', 'status', 'created_at', 'updated_at', 'archived_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionString(row.name, 'snapshot.name', { nonEmpty: true });
      assertDemoProjectionString(row.note, 'snapshot.note', { nullable: true });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.meter_device_id, 'snapshot.meter_device_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_batch_filter_id, 'snapshot.source_batch_filter_id', { nullable: true, min: 1 });
      assertDemoProjectionMonth(row.train_start_month, 'snapshot.train_start_month');
      assertDemoProjectionMonth(row.train_end_month, 'snapshot.train_end_month');
      assertDemoProjectionMonth(row.predict_start_month, 'snapshot.predict_start_month');
      assertDemoProjectionMonth(row.predict_end_month, 'snapshot.predict_end_month');
      assertDemoProjectionEnum(row.algorithm, 'snapshot.algorithm', ['moving_average', 'linear_trend']);
      assertDemoProjectionInteger(row.window_size, 'snapshot.window_size', { nullable: true, min: 2 });
      if (row.window_size !== null && row.window_size > 12) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.window_size 超出固定 projection 数值范围。',
          { fieldName: 'snapshot.window_size', max: 12, value: row.window_size },
          400
        );
      }
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['draft', 'active', 'archived']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
      assertDemoProjectionUtcMilliseconds(row.archived_at, 'snapshot.archived_at', { nullable: true });
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, name, note,
          energy_type_id, organization_unit_id, meter_device_id, source_batch_filter_id,
          train_start_month, train_end_month, predict_start_month, predict_end_month,
          algorithm, window_size, status, created_at, updated_at, archived_at
        FROM prediction_configs WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_record: Object.freeze({
    entityType: 'energy_record',
    tableName: 'energy_records',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_record']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_type_id', 'organization_unit_id',
      'meter_device_id', 'original_month', 'normalized_month', 'original_unit', 'original_value',
      'normalized_unit', 'normalized_value', 'remark', 'duplicate_key', 'record_status',
      'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { min: 1 });
      assertDemoProjectionInteger(row.meter_device_id, 'snapshot.meter_device_id', { nullable: true, min: 1 });
      assertDemoProjectionString(row.original_month, 'snapshot.original_month', { nonEmpty: true });
      assertDemoProjectionMonth(row.normalized_month, 'snapshot.normalized_month');
      assertDemoProjectionString(row.original_unit, 'snapshot.original_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.original_value, 'snapshot.original_value', { min: 0 });
      assertDemoProjectionString(row.normalized_unit, 'snapshot.normalized_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.normalized_value, 'snapshot.normalized_value', { min: 0 });
      assertDemoProjectionString(row.remark, 'snapshot.remark', { nullable: true });
      assertDemoProjectionString(row.duplicate_key, 'snapshot.duplicate_key', { nonEmpty: true });
      assertDemoProjectionEnum(row.record_status, 'snapshot.record_status', ['active', 'void']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_type_id,
          organization_unit_id, meter_device_id, original_month, normalized_month,
          original_unit, original_value, normalized_unit, normalized_value, remark,
          duplicate_key, record_status, created_at, updated_at
        FROM energy_records WHERE id = ?`).get(entityPk) || null;
    }
  }),
  shift_definition: Object.freeze({
    entityType: 'shift_definition',
    tableName: 'shift_definitions',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['shift_definition']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'shift_code', 'shift_name',
      'start_minute', 'end_minute', 'crosses_midnight', 'source_timezone', 'source',
      'version', 'effective_start_utc', 'effective_end_utc', 'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionString(row.shift_code, 'snapshot.shift_code', { nonEmpty: true });
      assertDemoProjectionString(row.shift_name, 'snapshot.shift_name', { nonEmpty: true });
      assertDemoProjectionInteger(row.start_minute, 'snapshot.start_minute', { min: 0 });
      assertDemoProjectionInteger(row.end_minute, 'snapshot.end_minute', { min: 0 });
      if (row.start_minute > 1439 || row.end_minute > 1439) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '班次分钟必须位于 0 至 1439 范围内。',
          { fieldName: 'snapshot.start_minute/end_minute' },
          400
        );
      }
      assertDemoProjectionInteger(row.crosses_midnight, 'snapshot.crosses_midnight', { min: 0 });
      if (![0, 1].includes(row.crosses_midnight)
        || (row.crosses_midnight === 0 && row.start_minute >= row.end_minute)
        || (row.crosses_midnight === 1 && row.start_minute <= row.end_minute)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '班次跨日标记必须与起止分钟关系一致。',
          { fieldName: 'snapshot.crosses_midnight' },
          400
        );
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionString(row.version, 'snapshot.version', { nonEmpty: true });
      assertDemoProjectionUtcMilliseconds(row.effective_start_utc, 'snapshot.effective_start_utc');
      assertDemoProjectionUtcMilliseconds(row.effective_end_utc, 'snapshot.effective_end_utc');
      if (Date.parse(row.effective_start_utc) >= Date.parse(row.effective_end_utc)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '班次定义有效期必须满足开始时间早于结束时间。',
          { fieldName: 'snapshot.effective_start_utc' },
          400
        );
      }
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, shift_code, shift_name,
          start_minute, end_minute, crosses_midnight, source_timezone, source, version,
          effective_start_utc, effective_end_utc, status, created_at, updated_at
        FROM shift_definitions WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_conversion_factor: Object.freeze({
    entityType: 'energy_conversion_factor',
    tableName: 'energy_conversion_factors',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_conversion_factor']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'factor_code', 'energy_type_id',
      'source_unit', 'factor_value', 'target_unit', 'display_unit', 'display_divisor',
      'source', 'document_no', 'version', 'effective_start_utc', 'effective_end_utc',
      'source_timezone', 'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionString(row.factor_code, 'snapshot.factor_code', { nonEmpty: true });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionString(row.source_unit, 'snapshot.source_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.factor_value, 'snapshot.factor_value', { min: Number.MIN_VALUE });
      assertDemoProjectionEnum(row.target_unit, 'snapshot.target_unit', ['kgce']);
      assertDemoProjectionEnum(row.display_unit, 'snapshot.display_unit', ['tce']);
      assertDemoProjectionFiniteNumber(row.display_divisor, 'snapshot.display_divisor', { min: 1000 });
      if (row.display_divisor !== 1000) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.display_divisor 必须等于固定展示除数 1000。',
          { fieldName: 'snapshot.display_divisor', value: row.display_divisor },
          400
        );
      }
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionString(row.document_no, 'snapshot.document_no', { nonEmpty: true });
      assertDemoProjectionString(row.version, 'snapshot.version', { nonEmpty: true });
      assertDemoProjectionUtcMilliseconds(row.effective_start_utc, 'snapshot.effective_start_utc');
      assertDemoProjectionUtcMilliseconds(row.effective_end_utc, 'snapshot.effective_end_utc');
      if (Date.parse(row.effective_start_utc) >= Date.parse(row.effective_end_utc)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot 折标系数有效期必须满足开始时间早于结束时间。',
          { fieldName: 'snapshot.effective_start_utc' },
          400
        );
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, factor_code,
          energy_type_id, source_unit, factor_value, target_unit, display_unit,
          display_divisor, source, document_no, version, effective_start_utc,
          effective_end_utc, source_timezone, status, created_at, updated_at
        FROM energy_conversion_factors WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_balance_boundary: Object.freeze({
    entityType: 'energy_balance_boundary',
    tableName: 'energy_balance_boundaries',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_balance_boundary']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'boundary_code', 'boundary_name',
      'organization_unit_id', 'source', 'document_no', 'version', 'effective_start_utc',
      'effective_end_utc', 'source_timezone', 'generation_boundary_confirmed', 'status',
      'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionString(row.boundary_code, 'snapshot.boundary_code', { nonEmpty: true });
      assertDemoProjectionString(row.boundary_name, 'snapshot.boundary_name', { nonEmpty: true });
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { nullable: true, min: 1 });
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionString(row.document_no, 'snapshot.document_no', { nullable: true });
      assertDemoProjectionString(row.version, 'snapshot.version', { nonEmpty: true });
      assertDemoProjectionUtcMilliseconds(row.effective_start_utc, 'snapshot.effective_start_utc');
      assertDemoProjectionUtcMilliseconds(row.effective_end_utc, 'snapshot.effective_end_utc');
      if (Date.parse(row.effective_start_utc) >= Date.parse(row.effective_end_utc)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot 平衡边界有效期必须满足开始时间早于结束时间。',
          { fieldName: 'snapshot.effective_start_utc' },
          400
        );
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionInteger(row.generation_boundary_confirmed, 'snapshot.generation_boundary_confirmed', { min: 0 });
      if (![0, 1].includes(row.generation_boundary_confirmed)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.generation_boundary_confirmed 只能是 0 或 1。',
          { fieldName: 'snapshot.generation_boundary_confirmed', value: row.generation_boundary_confirmed },
          400
        );
      }
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, boundary_code,
          boundary_name, organization_unit_id, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone,
          generation_boundary_confirmed, status, created_at, updated_at
        FROM energy_balance_boundaries WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_balance_item: Object.freeze({
    entityType: 'energy_balance_item',
    tableName: 'energy_balance_items',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_balance_item']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_balance_boundary_id', 'item_code',
      'item_name', 'role', 'energy_type_id', 'original_unit', 'source_type',
      'source_mapping_json', 'generation_anti_double_count_key', 'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_balance_boundary_id, 'snapshot.energy_balance_boundary_id', { min: 1 });
      assertDemoProjectionString(row.item_code, 'snapshot.item_code', { nonEmpty: true });
      assertDemoProjectionString(row.item_name, 'snapshot.item_name', { nonEmpty: true });
      assertDemoProjectionEnum(row.role, 'snapshot.role', ['input', 'self_generation', 'inventory_decrease', 'adjustment_increase', 'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease']);
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionString(row.original_unit, 'snapshot.original_unit', { nonEmpty: true });
      assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'explicit_balance_value']);
      assertDemoProjectionString(row.source_mapping_json, 'snapshot.source_mapping_json', { nonEmpty: true });
      let mapping;
      try { mapping = JSON.parse(row.source_mapping_json); } catch (_error) { mapping = null; }
      if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object'
        || typeof mapping.reference !== 'string' || mapping.reference.trim() === '') {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.source_mapping_json 必须是带非空 reference 的 JSON object。',
          { fieldName: 'snapshot.source_mapping_json' },
          400
        );
      }
      assertDemoProjectionString(row.generation_anti_double_count_key, 'snapshot.generation_anti_double_count_key', { nullable: true });
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_balance_boundary_id,
          item_code, item_name, role, energy_type_id, original_unit, source_type,
          source_mapping_json, generation_anti_double_count_key, status, created_at, updated_at
        FROM energy_balance_items WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_flow_model: Object.freeze({
    entityType: 'energy_flow_model',
    tableName: 'energy_flow_models',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_flow_model']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'model_code', 'model_name', 'source', 'document_no',
      'version', 'effective_start_wall_clock', 'effective_end_wall_clock', 'effective_start_utc',
      'effective_end_utc', 'source_timezone', 'classification_status', 'source_mode', 'status',
      'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.source_batch_id 与 snapshot.source_row_number 必须成对出现。',
          { fieldName: 'snapshot.source_batch_id/source_row_number' },
          400
        );
      }
      assertDemoProjectionString(row.model_code, 'snapshot.model_code', { nonEmpty: true });
      assertDemoProjectionString(row.model_name, 'snapshot.model_name', { nonEmpty: true });
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionString(row.document_no, 'snapshot.document_no', { nullable: true });
      assertDemoProjectionString(row.version, 'snapshot.version', { nonEmpty: true });
      assertDemoProjectionWallClockMinute(row.effective_start_wall_clock, 'snapshot.effective_start_wall_clock', { nullable: true });
      assertDemoProjectionWallClockMinute(row.effective_end_wall_clock, 'snapshot.effective_end_wall_clock', { nullable: true });
      if ((row.effective_start_wall_clock === null) !== (row.effective_end_wall_clock === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '模型生效墙钟起止时间必须成对出现。',
          { fieldName: 'snapshot.effective_start_wall_clock/effective_end_wall_clock' },
          400
        );
      }
      assertDemoProjectionUtcSecond(row.effective_start_utc, 'snapshot.effective_start_utc');
      assertDemoProjectionUtcSecond(row.effective_end_utc, 'snapshot.effective_end_utc');
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionEnum(row.classification_status, 'snapshot.classification_status', ['legacy_unclassified', 'workbook_facts']);
      assertDemoProjectionEnum(row.source_mode, 'snapshot.source_mode', ['legacy_explicit_sources', 'workbook_facts_only']);
      if ((row.classification_status === 'legacy_unclassified') !== (row.source_mode === 'legacy_explicit_sources')) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '模型 classification_status 与 source_mode 必须保持配对。',
          { fieldName: 'snapshot.classification_status/source_mode' },
          400
        );
      }
      if (row.classification_status === 'workbook_facts'
        && (row.source_batch_id === null || row.source_row_number === null
          || row.effective_start_wall_clock === null || row.effective_end_wall_clock === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'workbook_facts 模型必须包含来源和墙钟生效区间。',
          { fieldName: 'snapshot.classification_status' },
          400
        );
      }
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, model_code, model_name, source,
          document_no, version, effective_start_wall_clock, effective_end_wall_clock,
          effective_start_utc, effective_end_utc, source_timezone, classification_status, source_mode,
          status, created_at, updated_at
        FROM energy_flow_models WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_flow_node: Object.freeze({
    entityType: 'energy_flow_node',
    tableName: 'energy_flow_nodes',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_flow_node']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'energy_flow_asset_id',
      'node_code', 'node_name', 'node_type', 'stage_code', 'organization_unit_id', 'x', 'y',
      'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.source_batch_id 与 snapshot.source_row_number 必须成对出现。',
          { fieldName: 'snapshot.source_batch_id/source_row_number' },
          400
        );
      }
      assertDemoProjectionInteger(row.energy_flow_model_id, 'snapshot.energy_flow_model_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_flow_asset_id, 'snapshot.energy_flow_asset_id', { nullable: true, min: 1 });
      assertDemoProjectionString(row.node_code, 'snapshot.node_code', { nonEmpty: true });
      assertDemoProjectionString(row.node_name, 'snapshot.node_name', { nonEmpty: true });
      assertDemoProjectionEnum(row.node_type, 'snapshot.node_type', ['source', 'process', 'storage', 'sink', 'loss', 'boundary']);
      if (row.stage_code !== null) {
        assertDemoProjectionEnum(row.stage_code, 'snapshot.stage_code', ['plant_entry', 'distribution', 'device_input', 'useful_output', 'waste_heat', 'loss', 'boundary']);
        if (row.source_batch_id === null || row.source_row_number === null) {
          throw createDemoOwnershipError(
            'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
            '带 stage_code 的节点必须包含来源批次和来源行号。',
            { fieldName: 'snapshot.stage_code' },
            400
          );
        }
      }
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { nullable: true, min: 1 });
      assertDemoProjectionFiniteNumber(row.x, 'snapshot.x', { nullable: true });
      assertDemoProjectionFiniteNumber(row.y, 'snapshot.y', { nullable: true });
      if ((row.x === null) !== (row.y === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '节点坐标 x 与 y 必须成对出现。',
          { fieldName: 'snapshot.x/y' },
          400
        );
      }
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id,
          energy_flow_asset_id, node_code, node_name, node_type, stage_code, organization_unit_id,
          x, y, status, created_at, updated_at
        FROM energy_flow_nodes WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_flow_edge: Object.freeze({
    entityType: 'energy_flow_edge',
    tableName: 'energy_flow_edges',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_flow_edge']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'energy_flow_path_id',
      'path_sequence', 'edge_code', 'from_node_id', 'to_node_id', 'energy_type_id', 'unit',
      'source_type', 'source_reference', 'source_mapping_json', 'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_flow_model_id, 'snapshot.energy_flow_model_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_flow_path_id, 'snapshot.energy_flow_path_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.path_sequence, 'snapshot.path_sequence', { nullable: true, min: 1 });
      assertDemoProjectionString(row.edge_code, 'snapshot.edge_code', { nonEmpty: true });
      assertDemoProjectionInteger(row.from_node_id, 'snapshot.from_node_id', { min: 1 });
      assertDemoProjectionInteger(row.to_node_id, 'snapshot.to_node_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionString(row.unit, 'snapshot.unit', { nonEmpty: true });
      assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'workbook_fact']);
      assertDemoProjectionString(row.source_reference, 'snapshot.source_reference', { nullable: true });
      assertDemoProjectionString(row.source_mapping_json, 'snapshot.source_mapping_json', { nullable: true });
      if (row.source_mapping_json !== null) assertEnergyFlowSourceMapping(row.source_mapping_json, 'snapshot.source_mapping_json');
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id,
          energy_flow_path_id, path_sequence, edge_code, from_node_id, to_node_id,
          energy_type_id, unit, source_type, source_reference, source_mapping_json,
          status, created_at, updated_at
        FROM energy_flow_edges WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_timeseries: Object.freeze({
    entityType: 'energy_timeseries',
    tableName: 'energy_timeseries_records',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_timeseries']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'organization_unit_id',
      'meter_device_id', 'energy_type_id', 'start_utc', 'end_utc',
      'source_timezone', 'granularity_minutes', 'original_unit', 'original_value',
      'normalized_unit', 'normalized_value', 'source_reference', 'data_source',
      'record_status', 'void_reason', 'voided_at', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.source_batch_id 与 snapshot.source_row_number 必须成对出现。',
          { fieldName: 'snapshot.source_batch_id/source_row_number' },
          400
        );
      }
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.meter_device_id, 'snapshot.meter_device_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionUtcIso(row.start_utc, 'snapshot.start_utc');
      assertDemoProjectionUtcIso(row.end_utc, 'snapshot.end_utc');
      if (Date.parse(row.start_utc) >= Date.parse(row.end_utc)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.start_utc 必须早于 snapshot.end_utc。',
          { fieldName: 'snapshot.start_utc/end_utc' },
          400
        );
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionInteger(row.granularity_minutes, 'snapshot.granularity_minutes');
      if (![15, 30, 60].includes(row.granularity_minutes)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.granularity_minutes 仅允许 15、30 或 60。',
          { fieldName: 'snapshot.granularity_minutes', value: row.granularity_minutes },
          400
        );
      }
      const startTimestamp = Date.parse(row.start_utc);
      const endTimestamp = Date.parse(row.end_utc);
      if (startTimestamp % 60000 !== 0 || endTimestamp % 60000 !== 0
        || endTimestamp - startTimestamp !== row.granularity_minutes * 60000) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '时序记录区间必须落在整分钟且持续时间与粒度一致。',
          { fieldName: 'snapshot.start_utc/end_utc/granularity_minutes' },
          400
        );
      }
      assertDemoProjectionString(row.original_unit, 'snapshot.original_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.original_value, 'snapshot.original_value', { min: 0 });
      assertDemoProjectionString(row.normalized_unit, 'snapshot.normalized_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.normalized_value, 'snapshot.normalized_value', { min: 0 });
      assertDemoProjectionString(row.source_reference, 'snapshot.source_reference', { nonEmpty: true });
      assertDemoProjectionEnum(row.data_source, 'snapshot.data_source', ['manual', 'upload', 'calculation']);
      assertDemoProjectionEnum(row.record_status, 'snapshot.record_status', ['active', 'void']);
      assertDemoProjectionString(row.void_reason, 'snapshot.void_reason', { nullable: true });
      assertDemoProjectionUtcIso(row.voided_at, 'snapshot.voided_at', { nullable: true });
      if ((row.record_status === 'active' && (row.void_reason !== null || row.voided_at !== null))
        || (row.record_status === 'void'
          && (typeof row.void_reason !== 'string' || row.void_reason.trim() === '' || row.voided_at === null))) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '时序记录状态必须与作废原因和作废时间保持配对。',
          { fieldName: 'snapshot.record_status/void_reason/voided_at' },
          400
        );
      }
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, organization_unit_id,
          meter_device_id, energy_type_id, start_utc, end_utc, source_timezone,
          granularity_minutes, original_unit, original_value, normalized_unit,
          normalized_value, source_reference, data_source, record_status, void_reason,
          voided_at, created_at, updated_at
        FROM energy_timeseries_records WHERE id = ?`).get(entityPk) || null;
    }
  }),
  strategy_rule: Object.freeze({
    entityType: 'strategy_rule',
    tableName: 'strategy_rules',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['strategy_rule']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'rule_code', 'rule_name',
      'rule_version', 'formula_version', 'metric_code', 'threshold_operator',
      'threshold_value', 'threshold_min', 'threshold_max', 'threshold_unit',
      'reduction_rate', 'priority', 'evidence_requirements_json', 'recommendation_text',
      'source', 'effective_start_utc', 'effective_end_utc', 'source_timezone',
      'status', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.source_batch_id 与 snapshot.source_row_number 必须成对出现。',
          { fieldName: 'snapshot.source_batch_id/source_row_number' },
          400
        );
      }
      assertDemoProjectionString(row.rule_code, 'snapshot.rule_code', { nonEmpty: true });
      assertDemoProjectionString(row.rule_name, 'snapshot.rule_name', { nonEmpty: true });
      assertDemoProjectionString(row.rule_version, 'snapshot.rule_version', { nonEmpty: true });
      assertDemoProjectionString(row.formula_version, 'snapshot.formula_version', { nonEmpty: true });
      if (row.formula_version !== SUPPORTED_FORMULA_VERSION
        || !SUPPORTED_METRIC_CODES.includes(row.metric_code)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '策略规则公式版本和指标必须属于固定白名单。',
          { fieldName: 'snapshot.formula_version/metric_code' },
          400
        );
      }
      assertDemoProjectionEnum(row.threshold_operator, 'snapshot.threshold_operator', ['gt', 'gte', 'lt', 'lte', 'between']);
      assertDemoProjectionFiniteNumber(row.threshold_value, 'snapshot.threshold_value', { nullable: true });
      assertDemoProjectionFiniteNumber(row.threshold_min, 'snapshot.threshold_min', { nullable: true });
      assertDemoProjectionFiniteNumber(row.threshold_max, 'snapshot.threshold_max', { nullable: true });
      if (row.threshold_operator === 'between'
        ? (row.threshold_value !== null || row.threshold_min === null || row.threshold_max === null
          || row.threshold_min > row.threshold_max)
        : (row.threshold_value === null || row.threshold_min !== null || row.threshold_max !== null)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '策略规则阈值字段必须与 threshold_operator 保持配对。',
          { fieldName: 'snapshot.threshold_operator/threshold_value/threshold_min/threshold_max' },
          400
        );
      }
      assertDemoProjectionString(row.threshold_unit, 'snapshot.threshold_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.reduction_rate, 'snapshot.reduction_rate', { nullable: true, min: Number.MIN_VALUE });
      if (row.reduction_rate !== null && row.reduction_rate > 1) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.reduction_rate 必须位于 (0, 1]。',
          { fieldName: 'snapshot.reduction_rate' },
          400
        );
      }
      assertDemoProjectionEnum(row.priority, 'snapshot.priority', ['low', 'medium', 'high']);
      assertDemoProjectionString(row.evidence_requirements_json, 'snapshot.evidence_requirements_json', { nonEmpty: true });
      const evidence = parseEvidenceRequirements(row.evidence_requirements_json);
      if (!evidence.valid) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'snapshot.evidence_requirements_json 不符合固定证据契约。',
          { fieldName: 'snapshot.evidence_requirements_json', errors: evidence.errors },
          400
        );
      }
      assertDemoProjectionString(row.recommendation_text, 'snapshot.recommendation_text', { nonEmpty: true });
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionUtcMilliseconds(row.effective_start_utc, 'snapshot.effective_start_utc');
      assertDemoProjectionUtcMilliseconds(row.effective_end_utc, 'snapshot.effective_end_utc');
      if (Date.parse(row.effective_start_utc) >= Date.parse(row.effective_end_utc)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '策略规则有效期必须满足开始时间早于结束时间。',
          { fieldName: 'snapshot.effective_start_utc/end_utc' },
          400
        );
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['active', 'inactive']);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, rule_code, rule_name,
          rule_version, formula_version, metric_code, threshold_operator, threshold_value,
          threshold_min, threshold_max, threshold_unit, reduction_rate, priority,
          evidence_requirements_json, recommendation_text, source, effective_start_utc,
          effective_end_utc, source_timezone, status, created_at, updated_at
        FROM strategy_rules WHERE id = ?`).get(entityPk) || null;
    }
  }),
  strategy_evaluation_run: Object.freeze({
    entityType: 'strategy_evaluation_run',
    tableName: 'strategy_evaluation_runs',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'run_code', 'scope_type', 'scope_reference', 'start_utc', 'end_utc',
      'source_timezone', 'formula_version', 'status', 'reason_codes_json', 'started_at',
      'completed_at', 'error_message', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      ['run_code', 'scope_type', 'scope_reference', 'formula_version'].forEach((fieldName) => {
        assertDemoProjectionString(row[fieldName], `snapshot.${fieldName}`, { nonEmpty: true });
      });
      if (row.scope_type !== 'meter_device' || row.formula_version !== SUPPORTED_FORMULA_VERSION) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '策略评价运行 scope_type 或 formula_version 不属于正式领域固定值。', { fieldName: 'snapshot.scope_type/formula_version' }, 400);
      }
      assertStrategyScopeReference(row.scope_reference, 'snapshot.scope_reference', row.source_timezone);
      assertDemoProjectionUtcIso(row.start_utc, 'snapshot.start_utc');
      assertDemoProjectionUtcIso(row.end_utc, 'snapshot.end_utc');
      if (Date.parse(row.start_utc) >= Date.parse(row.end_utc)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '策略评价运行时间窗口必须满足开始早于结束。', { fieldName: 'snapshot.start_utc/end_utc' }, 400);
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['pending', 'running', 'completed', 'failed', 'cancelled']);
      assertStrategyReasonCodes(row.reason_codes_json, 'snapshot.reason_codes_json', { nullable: true });
      assertDemoProjectionUtcIso(row.started_at, 'snapshot.started_at', { nullable: true });
      assertDemoProjectionUtcIso(row.completed_at, 'snapshot.completed_at', { nullable: true });
      assertDemoProjectionString(row.error_message, 'snapshot.error_message', { nullable: true });
      assertStrategyEvaluationRunLifecycle(row);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
      assertStrategyEvaluationRunAuditTimeline(row);
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, run_code, scope_type, scope_reference, start_utc, end_utc,
          source_timezone, formula_version, status, reason_codes_json, started_at,
          completed_at, error_message, created_at, updated_at
        FROM strategy_evaluation_runs WHERE id = ?`).get(entityPk) || null;
    }
  }),
  strategy_rule_hit: Object.freeze({
    entityType: 'strategy_rule_hit',
    tableName: 'strategy_rule_hits',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'evaluation_run_id', 'strategy_rule_id', 'match_status', 'manual_status',
      'actual_value', 'threshold_snapshot_json', 'evidence_json', 'reason_codes_json',
      'coverage_rate', 'priority', 'estimated_saving', 'estimated_saving_unit',
      'data_start_utc', 'data_end_utc', 'source_timezone', 'reviewed_at', 'review_note',
      'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.evaluation_run_id, 'snapshot.evaluation_run_id', { min: 1 });
      assertDemoProjectionInteger(row.strategy_rule_id, 'snapshot.strategy_rule_id', { min: 1 });
      assertDemoProjectionEnum(row.match_status, 'snapshot.match_status', ['matched', 'not_matched', 'not_evaluable']);
      assertDemoProjectionEnum(row.manual_status, 'snapshot.manual_status', ['unconfirmed', 'accepted', 'rejected', 'resolved']);
      assertDemoProjectionFiniteNumber(row.actual_value, 'snapshot.actual_value', { nullable: true });
      const thresholdSnapshot = assertStrategyThresholdSnapshot(
        row.threshold_snapshot_json,
        'snapshot.threshold_snapshot_json'
      );
      const evidenceSnapshot = assertStrategyEvidenceSnapshot(
        row.evidence_json,
        'snapshot.evidence_json',
        row
      );
      const hitReasonCodes = assertStrategyReasonCodes(row.reason_codes_json, 'snapshot.reason_codes_json', { nullable: true });
      assertDemoProjectionFiniteNumber(row.coverage_rate, 'snapshot.coverage_rate');
      if (row.coverage_rate < 0 || row.coverage_rate > 1) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '策略命中 coverage_rate 必须位于 [0, 1]。', { fieldName: 'snapshot.coverage_rate' }, 400);
      }
      assertDemoProjectionEnum(row.priority, 'snapshot.priority', ['low', 'medium', 'high']);
      assertDemoProjectionFiniteNumber(row.estimated_saving, 'snapshot.estimated_saving', { nullable: true, min: 0 });
      assertDemoProjectionString(row.estimated_saving_unit, 'snapshot.estimated_saving_unit', { nullable: true });
      assertDemoProjectionUtcIso(row.data_start_utc, 'snapshot.data_start_utc');
      assertDemoProjectionUtcIso(row.data_end_utc, 'snapshot.data_end_utc');
      if (Date.parse(row.data_start_utc) >= Date.parse(row.data_end_utc)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '策略命中数据窗口必须满足开始早于结束。', { fieldName: 'snapshot.data_start_utc/data_end_utc' }, 400);
      }
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionUtcIso(row.reviewed_at, 'snapshot.reviewed_at', { nullable: true });
      assertDemoProjectionString(row.review_note, 'snapshot.review_note', { nullable: true });
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
      if (Date.parse(row.created_at) > Date.parse(row.updated_at)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '策略命中 updated_at 不得早于 created_at。', { fieldName: 'snapshot.created_at/updated_at' }, 400);
      }
      if (row.match_status === 'not_evaluable') {
        if (row.actual_value !== null || row.estimated_saving !== null) {
          throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'not_evaluable 命中不得带实际值或节能估算。', { fieldName: 'snapshot.match_status/actual_value/estimated_saving' }, 400);
        }
      } else if (row.actual_value === null) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '可评价策略命中必须带有限 actual_value。', { fieldName: 'snapshot.match_status/actual_value' }, 400);
      }
      if (row.match_status === 'not_evaluable' && (!hitReasonCodes || hitReasonCodes.length === 0)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'not_evaluable 策略命中必须包含正式原因码。',
          { fieldName: 'snapshot.match_status/reason_codes_json' },
          400
        );
      }
      if (row.match_status !== 'not_evaluable' && hitReasonCodes !== null) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          '可评价策略命中不得包含原因码。',
          { fieldName: 'snapshot.match_status/reason_codes_json' },
          400
        );
      }
      if (row.estimated_saving === null && row.estimated_saving_unit !== null) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'estimated_saving_unit 必须与 estimated_saving 成对出现。', { fieldName: 'snapshot.estimated_saving/estimated_saving_unit' }, 400);
      }
      if (row.estimated_saving !== null && (typeof row.estimated_saving_unit !== 'string' || row.estimated_saving_unit.trim() === '')) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'estimated_saving_unit 必须与 estimated_saving 成对出现。', { fieldName: 'snapshot.estimated_saving/estimated_saving_unit' }, 400);
      }
      assertStrategyRuleHitEvaluationSemantics(
        row,
        thresholdSnapshot,
        evidenceSnapshot,
        hitReasonCodes
      );
      if (row.manual_status === 'unconfirmed' && (row.reviewed_at !== null || row.review_note !== null)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'unconfirmed 策略命中不得包含 review 字段。', { fieldName: 'snapshot.manual_status/reviewed_at/review_note' }, 400);
      }
      if (row.manual_status !== 'unconfirmed' && row.reviewed_at === null) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '已人工处理策略命中必须包含 reviewed_at。', { fieldName: 'snapshot.manual_status/reviewed_at' }, 400);
      }
      if ((row.manual_status === 'rejected' || row.manual_status === 'resolved')
        && (typeof row.review_note !== 'string' || row.review_note.trim() === '')) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'rejected/resolved 策略命中必须包含 review_note。', { fieldName: 'snapshot.manual_status/review_note' }, 400);
      }
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, evaluation_run_id, strategy_rule_id, match_status, manual_status,
          actual_value, threshold_snapshot_json, evidence_json, reason_codes_json, coverage_rate,
          priority, estimated_saving, estimated_saving_unit, data_start_utc, data_end_utc,
          source_timezone, reviewed_at, review_note, created_at, updated_at
        FROM strategy_rule_hits WHERE id = ?`).get(entityPk) || null;
    }
  }),
  energy_flow_record: Object.freeze({
    entityType: 'energy_flow_record',
    tableName: 'energy_flow_records',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['energy_flow_record']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'record_code',
      'record_role', 'energy_flow_edge_id', 'energy_flow_node_id', 'energy_flow_path_id',
      'energy_flow_asset_id', 'stage_code', 'energy_type_id', 'start_wall_clock', 'end_wall_clock',
      'start_utc', 'end_utc', 'source_timezone', 'original_unit', 'original_value', 'source_type',
      'source_reference', 'source_mapping_json', 'formula_version', 'record_status', 'void_reason',
      'voided_at', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_flow_model_id, 'snapshot.energy_flow_model_id', { min: 1 });
      assertDemoProjectionString(row.record_code, 'snapshot.record_code', { nullable: true });
      if (row.record_role !== null) assertDemoProjectionEnum(row.record_role, 'snapshot.record_role', ['edge_flow', 'storage_change']);
      assertDemoProjectionInteger(row.energy_flow_edge_id, 'snapshot.energy_flow_edge_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_flow_node_id, 'snapshot.energy_flow_node_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_flow_path_id, 'snapshot.energy_flow_path_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.energy_flow_asset_id, 'snapshot.energy_flow_asset_id', { nullable: true, min: 1 });
      if (row.stage_code !== null) assertDemoProjectionEnum(row.stage_code, 'snapshot.stage_code', ['plant_entry', 'distribution', 'device_input', 'useful_output', 'waste_heat', 'loss', 'boundary']);
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { nullable: true, min: 1 });
      assertDemoProjectionWallClockMinute(row.start_wall_clock, 'snapshot.start_wall_clock', { nullable: true });
      assertDemoProjectionWallClockMinute(row.end_wall_clock, 'snapshot.end_wall_clock', { nullable: true });
      assertDemoProjectionUtcSecond(row.start_utc, 'snapshot.start_utc');
      assertDemoProjectionUtcSecond(row.end_utc, 'snapshot.end_utc');
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionString(row.original_unit, 'snapshot.original_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.original_value, 'snapshot.original_value');
      assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'workbook_fact']);
      assertDemoProjectionString(row.source_reference, 'snapshot.source_reference', { nullable: true });
      assertDemoProjectionString(row.source_mapping_json, 'snapshot.source_mapping_json', { nullable: true });
      if (row.source_mapping_json !== null) assertEnergyFlowSourceMapping(row.source_mapping_json, 'snapshot.source_mapping_json');
      assertDemoProjectionString(row.formula_version, 'snapshot.formula_version', { nullable: true });
      assertDemoProjectionEnum(row.record_status, 'snapshot.record_status', ['active', 'void']);
      assertDemoProjectionString(row.void_reason, 'snapshot.void_reason', { nullable: true });
      assertDemoProjectionUtcSecond(row.voided_at, 'snapshot.voided_at', { nullable: true });
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id,
          record_code, record_role, energy_flow_edge_id, energy_flow_node_id,
          energy_flow_path_id, energy_flow_asset_id, stage_code, energy_type_id,
          start_wall_clock, end_wall_clock, start_utc, end_utc, source_timezone,
          original_unit, original_value, source_type, source_reference, source_mapping_json,
          formula_version, record_status, void_reason, voided_at, created_at, updated_at
        FROM energy_flow_records WHERE id = ?`).get(entityPk) || null;
    }
  })
});

/** 读取实体静态 ownership handler；未知实体不得猜测表名或主键。 */
function getDemoOwnershipEntityHandler(entityType) {
  const normalizedType = typeof entityType === 'string' ? entityType : '';
  return Object.prototype.hasOwnProperty.call(DEMO_OWNERSHIP_ENTITY_HANDLERS, normalizedType)
    ? DEMO_OWNERSHIP_ENTITY_HANDLERS[normalizedType]
    : null;
}

/** 校验固定投影中的 UTC 字段，拒绝非 UTC、非毫秒或无效日期。 */
function assertDemoProjectionUtcMilliseconds(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (typeof value !== 'string' || !DEMO_UTC_MILLISECOND_PATTERN.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID',
      `${fieldName} 必须是严格 UTC 毫秒时间。`,
      { fieldName, value: value ?? null }
    );
  }
}

/** 校验业务 UTC 时间，允许严格秒精度或毫秒精度且禁止无损之外的改写。 */
function assertDemoProjectionUtcIso(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  const isSecond = typeof value === 'string' && DEMO_UTC_SECOND_PATTERN.test(value);
  const isMillisecond = typeof value === 'string' && DEMO_UTC_MILLISECOND_PATTERN.test(value);
  const canonical = typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
  if ((!isSecond && !isMillisecond)
    || (isSecond ? canonical?.replace('.000Z', 'Z') !== value : canonical !== value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID',
      `${fieldName} 必须是严格 UTC 秒或毫秒时间。`,
      { fieldName, value: value ?? null }
    );
  }
}

/** 校验固定 projection 的来源时区，沿用正式 strict source timezone 合同。 */
function assertDemoProjectionTimeZone(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  if (!isIanaTimeZone(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 必须是有效 IANA 区域/地点时区。`,
      { fieldName, value },
      400
    );
  }
}

/** 校验能流业务 UTC 秒字段，禁止与 ownership 审计毫秒时间混用。 */
function assertDemoProjectionUtcSecond(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (typeof value !== 'string' || !DEMO_UTC_SECOND_PATTERN.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID',
      `${fieldName} 必须是严格 UTC 秒时间。`,
      { fieldName, value: value ?? null }
    );
  }
}

/** 校验固定 ownership projection 中的 JSON 对象字段，拒绝数组、null 和非法 JSON。 */
function assertDemoProjectionJsonObject(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  let parsed;
  try { parsed = JSON.parse(value); } catch (_error) { parsed = null; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是 JSON object。`,
      { fieldName },
      400
    );
  }
}

/** 校验固定 ownership projection 中可空的 JSON 字符串数组。 */
function assertDemoProjectionJsonStringArray(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  let parsed;
  try { parsed = JSON.parse(value); } catch (_error) { parsed = null; }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是 JSON string array。`,
      { fieldName },
      400
    );
  }
}

/** 解析严格 JSON object，并拒绝空值、数组、标量和非法文本。 */
function parseStrictDemoProjectionJsonObject(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    parsed = null;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是严格 JSON object。`,
      { fieldName },
      400
    );
  }
  return parsed;
}

/** 校验严格 JSON object 的字段集合，拒绝缺失字段和未知字段。 */
function assertStrictDemoProjectionJsonFields(value, fieldName, expectedFields) {
  const actualFields = Object.keys(value).sort();
  const expectedSortedFields = [...expectedFields].sort();
  if (actualFields.length !== expectedSortedFields.length
    || actualFields.some((key, index) => key !== expectedSortedFields[index])) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 只能包含正式 evaluator 固定字段。`,
      { fieldName, expectedFields: expectedSortedFields, actualFields },
      400
    );
  }
  return value;
}

/** 校验严格 JSON 文本中的非空字符串数组，并按需要拒绝重复值。 */
function assertStrictDemoProjectionJsonStringArray(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return null;
  const parsed = parseStrictDemoProjectionJsonArray(value, fieldName);
  if (parsed.some((item) => typeof item !== 'string' || item.trim() === '')
    || (options.unique === true && new Set(parsed).size !== parsed.length)
    || (options.nonEmpty === true && parsed.length === 0)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是符合固定值域的 JSON string array。`,
      { fieldName },
      400
    );
  }
  return parsed;
}

/** 解析严格 JSON array，避免数组字段被当作 object 或标量接受。 */
function parseStrictDemoProjectionJsonArray(value, fieldName) {
  assertDemoProjectionString(value, fieldName, { nonEmpty: true });
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是严格 JSON array。`,
      { fieldName },
      400
    );
  }
  return parsed;
}

/** 校验策略运行 scope_reference 与正式负荷 evaluator 的固定输入一致。 */
function assertStrategyScopeReference(value, fieldName, sourceTimeZone) {
  const scope = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(value, fieldName),
    fieldName,
    DEMO_STRATEGY_SCOPE_REFERENCE_FIELDS
  );
  assertDemoProjectionInteger(scope.meterDeviceId, `${fieldName}.meterDeviceId`, { min: 1 });
  assertDemoProjectionString(scope.energyTypeCode, `${fieldName}.energyTypeCode`, { nonEmpty: true });
  assertDemoProjectionString(scope.unit, `${fieldName}.unit`, { nonEmpty: true });
  assertDemoProjectionTimeZone(scope.sourceTimeZone, `${fieldName}.sourceTimeZone`);
  if (scope.sourceTimeZone !== sourceTimeZone) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.sourceTimeZone 必须与 snapshot.source_timezone 一致。`,
      { fieldName: `${fieldName}.sourceTimeZone` },
      400
    );
  }
  return scope;
}

/** 校验正式 evaluator 持久化的 threshold_snapshot_json 固定结构。 */
function assertStrategyThresholdSnapshot(value, fieldName) {
  const threshold = parseStrictDemoProjectionJsonObject(value, fieldName);
  assertDemoProjectionEnum(threshold.operator, `${fieldName}.operator`, RULE_THRESHOLD_OPERATORS);
  assertDemoProjectionString(threshold.unit, `${fieldName}.unit`, { nonEmpty: true });
  if (threshold.operator === 'between') {
    const expectedFields = Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')
      ? ['operator', 'min', 'max', 'unit', 'reductionRate']
      : ['operator', 'min', 'max', 'unit'];
    assertStrictDemoProjectionJsonFields(threshold, fieldName, expectedFields);
    assertDemoProjectionFiniteNumber(threshold.min, `${fieldName}.min`);
    assertDemoProjectionFiniteNumber(threshold.max, `${fieldName}.max`);
    if (threshold.min > threshold.max) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        `${fieldName}.min 不得大于 max。`,
        { fieldName },
        400
      );
    }
  } else {
    const expectedFields = Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')
      ? ['operator', 'value', 'unit', 'reductionRate']
      : ['operator', 'value', 'unit'];
    assertStrictDemoProjectionJsonFields(threshold, fieldName, expectedFields);
    assertDemoProjectionFiniteNumber(threshold.value, `${fieldName}.value`);
  }
  if (Object.prototype.hasOwnProperty.call(threshold, 'reductionRate')) {
    assertDemoProjectionFiniteNumber(threshold.reductionRate, `${fieldName}.reductionRate`, { min: Number.MIN_VALUE });
    if (threshold.reductionRate > 1) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        `${fieldName}.reductionRate 必须位于 (0, 1]。`,
        { fieldName },
        400
      );
    }
  }
  return threshold;
}

/** 按正式 evaluator 的五种 operator 重新计算阈值匹配结果。 */
function evaluateStrategyThresholdMatch(actualValue, threshold) {
  if (threshold.operator === 'gt') return actualValue > threshold.value;
  if (threshold.operator === 'gte') return actualValue >= threshold.value;
  if (threshold.operator === 'lt') return actualValue < threshold.value;
  if (threshold.operator === 'lte') return actualValue <= threshold.value;
  return actualValue >= threshold.min && actualValue <= threshold.max;
}

/** 校验正式 evaluator 持久化的 evidencePolicy 固定字段和值域。 */
function assertStrategyEvidencePolicy(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是 JSON object。`,
      { fieldName },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(value, fieldName, DEMO_STRATEGY_EVIDENCE_POLICY_FIELDS);
  if (value.maxEvidenceItemsSemantics !== 'timeseries_detail_limit_only') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.maxEvidenceItemsSemantics 不符合正式 evaluator 语义。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionInteger(value.requiredEvidenceCount, `${fieldName}.requiredEvidenceCount`, { min: 1 });
  assertDemoProjectionInteger(value.detailEvidenceLimit, `${fieldName}.detailEvidenceLimit`, { min: 1 });
  if (value.detailEvidenceLimit > 100) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.detailEvidenceLimit 超出正式证据上限。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionInteger(value.availableDetailEvidenceCount, `${fieldName}.availableDetailEvidenceCount`, { min: 0 });
  assertDemoProjectionInteger(value.returnedDetailEvidenceCount, `${fieldName}.returnedDetailEvidenceCount`, { min: 0 });
  if (value.returnedDetailEvidenceCount !== Math.min(
    value.availableDetailEvidenceCount,
    value.detailEvidenceLimit
  ) || value.detailEvidenceTruncated
    !== (value.availableDetailEvidenceCount > value.returnedDetailEvidenceCount)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 的证据数量和截断标记不一致。`,
      { fieldName },
      400
    );
  }
  return value;
}

/** 校验正式 evaluator 持久化的 evidenceRequirements 固定结构。 */
function assertStrategyEvidenceRequirements(value, fieldName) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 必须是 JSON object 或 null。`,
      { fieldName },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(value, fieldName, DEMO_STRATEGY_EVIDENCE_REQUIREMENT_FIELDS);
  assertDemoProjectionFiniteNumber(value.minimumCoverageRate, `${fieldName}.minimumCoverageRate`);
  if (value.minimumCoverageRate < 0 || value.minimumCoverageRate > 1) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.minimumCoverageRate 必须位于 [0, 1]。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionInteger(value.maxEvidenceItems, `${fieldName}.maxEvidenceItems`, { min: 1 });
  if (value.maxEvidenceItems > 100) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.maxEvidenceItems 超出正式证据上限。`,
      { fieldName },
      400
    );
  }
  if (value.savingBasis !== null && value.savingBasis !== 'window_total_energy') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.savingBasis 不符合正式 evaluator 取值。`,
      { fieldName },
      400
    );
  }
  return value;
}

/** 校验正式 evaluator 持久化的 evidence_json 完整嵌套结构。 */
function assertStrategyEvidenceSnapshot(value, fieldName, row) {
  const evidenceSnapshot = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(value, fieldName),
    fieldName,
    DEMO_STRATEGY_EVIDENCE_FIELDS
  );
  const evidence = evidenceSnapshot.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0
    || evidence.some((item) => typeof item !== 'string' || item.trim() === '')
    || new Set(evidence).size !== evidence.length) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName}.evidence 必须是无重复的非空 JSON string array。`,
      { fieldName },
      400
    );
  }
  const evidencePolicy = assertStrategyEvidencePolicy(evidenceSnapshot.evidencePolicy, `${fieldName}.evidencePolicy`);
  ['dataSummaryDigest', 'evaluationDigest'].forEach((key) => {
    assertDemoProjectionString(evidenceSnapshot[key], `${fieldName}.${key}`, { nonEmpty: true });
    if (!DEMO_STRATEGY_SHA256_PATTERN.test(evidenceSnapshot[key])) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        `${fieldName}.${key} 必须是 sha256 摘要。`,
        { fieldName },
        400
      );
    }
  });
  if (evidence.length !== evidencePolicy.requiredEvidenceCount + evidencePolicy.returnedDetailEvidenceCount) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidence 数量必须等于必备证据和详细证据数量之和。`,
      { fieldName },
      400
    );
  }
  const configurationErrors = evidenceSnapshot.configurationErrors;
  if (!Array.isArray(configurationErrors)
    || configurationErrors.some((item) => (
      typeof item !== 'string' || !DEMO_STRATEGY_CONFIGURATION_ERRORS.includes(item)
    ))
    || new Set(configurationErrors).size !== configurationErrors.length) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName}.configurationErrors 必须是无重复的正式配置错误码数组。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionString(evidenceSnapshot.recommendation, `${fieldName}.recommendation`, { nonEmpty: true });
  assertDemoProjectionString(evidenceSnapshot.source, `${fieldName}.source`, { nonEmpty: true });
  const effectiveRange = evidenceSnapshot.effectiveRange;
  if (!effectiveRange || typeof effectiveRange !== 'object' || Array.isArray(effectiveRange)
    || Object.getPrototypeOf(effectiveRange) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName}.effectiveRange 必须是 JSON object。`,
      { fieldName },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(effectiveRange, `${fieldName}.effectiveRange`, DEMO_STRATEGY_EFFECTIVE_RANGE_FIELDS);
  assertDemoProjectionUtcIso(effectiveRange.startUtc, `${fieldName}.effectiveRange.startUtc`);
  assertDemoProjectionUtcIso(effectiveRange.endUtc, `${fieldName}.effectiveRange.endUtc`);
  if (Date.parse(effectiveRange.startUtc) >= Date.parse(effectiveRange.endUtc)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.effectiveRange 必须满足开始时间早于结束时间。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionTimeZone(effectiveRange.sourceTimeZone, `${fieldName}.effectiveRange.sourceTimeZone`);
  if (Date.parse(effectiveRange.startUtc) > Date.parse(row.data_start_utc)
    || Date.parse(effectiveRange.endUtc) < Date.parse(row.data_end_utc)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.effectiveRange 必须覆盖策略命中数据窗口（左闭右开）。`,
      { fieldName: `${fieldName}.effectiveRange/data_start_utc/data_end_utc` },
      400
    );
  }
  const evidenceRequirements = assertStrategyEvidenceRequirements(
    evidenceSnapshot.evidenceRequirements,
    `${fieldName}.evidenceRequirements`
  );
  const hasEvidenceRequirementError = configurationErrors.some((code) => (
    DEMO_STRATEGY_EVIDENCE_REQUIREMENT_ERRORS.includes(code)
  ));
  if (hasEvidenceRequirementError !== (evidenceRequirements === null)
    || (evidenceRequirements !== null
      && evidencePolicy.detailEvidenceLimit !== evidenceRequirements.maxEvidenceItems)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidenceRequirements 与配置错误和证据上限不符合正式 evaluator 关系。`,
      { fieldName },
      400
    );
  }
  const hasForcedDefaultEvidenceError = configurationErrors.some((code) => (
    DEMO_STRATEGY_FORCED_DEFAULT_EVIDENCE_ERRORS.includes(code)
  ));
  if (evidenceRequirements === null && hasForcedDefaultEvidenceError
    && evidencePolicy.detailEvidenceLimit !== DEMO_STRATEGY_DEFAULT_DETAIL_EVIDENCE_LIMIT) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidencePolicy.detailEvidenceLimit 必须沿用正式 evidence requirements 默认值。`,
      { fieldName },
      400
    );
  }

  // 必备证据顺序和字符串格式严格复用正式 buildMetricEvidence 的固定排列。
  const mandatoryCount = evidencePolicy.requiredEvidenceCount;
  const mandatoryEvidence = evidence.slice(0, mandatoryCount);
  const windowMatch = /^window:(.+)\/(.+)$/.exec(mandatoryEvidence[0] || '');
  const meterMatch = /^meter:([1-9]\d*)$/.exec(mandatoryEvidence[1] || '');
  const scopeMatch = /^scope:energy-type=(.*);unit=(.*);source-timezone=([^;]+)$/.exec(mandatoryEvidence[2] || '');
  const recordCountMatch = /^record-count:(\d+)$/.exec(mandatoryEvidence[4] || '');
  const metricMatch = /^metric:(.+)$/.exec(mandatoryEvidence[3] || '');
  const meterDeviceId = meterMatch ? Number(meterMatch[1]) : null;
  const recordCount = recordCountMatch ? Number(recordCountMatch[1]) : null;
  const metricCode = metricMatch ? metricMatch[1] : null;
  if (!windowMatch || !meterMatch || !scopeMatch || !recordCountMatch || !metricMatch
    || !scopeMatch[1] || !scopeMatch[2]
    || !isIanaTimeZone(scopeMatch[3])
    || scopeMatch[3] !== row.source_timezone
    || windowMatch[1] !== row.data_start_utc
    || windowMatch[2] !== row.data_end_utc
    || !Number.isSafeInteger(meterDeviceId)
    || !Number.isSafeInteger(recordCount)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidence 不符合正式 mandatory evidence 顺序和格式。`,
      { fieldName },
      400
    );
  }
  assertDemoProjectionUtcIso(windowMatch[1], `${fieldName}.evidence[0].startUtc`);
  assertDemoProjectionUtcIso(windowMatch[2], `${fieldName}.evidence[0].endUtc`);
  if (Date.parse(windowMatch[1]) >= Date.parse(windowMatch[2])) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidence[0] 必须满足开始时间早于结束时间。`,
      { fieldName },
      400
    );
  }
  const expectedScope = `scope:energy-type=${scopeMatch[1]};unit=${scopeMatch[2]};source-timezone=${scopeMatch[3]}`;
  if (mandatoryEvidence[2] !== expectedScope
    || mandatoryEvidence[5] !== `data-summary-sha256:${evidenceSnapshot.dataSummaryDigest.slice(7)}`
    || mandatoryEvidence[6] !== `evaluation-sha256:${evidenceSnapshot.evaluationDigest.slice(7)}`) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidence 不符合正式 mandatory evidence 顺序和摘要绑定。`,
      { fieldName },
      400
    );
  }
  const hasPeakIntervalEvidence = typeof mandatoryEvidence[7] === 'string'
    && mandatoryEvidence[7].startsWith('peak-interval:');
  if (metricCode === 'peak_interval_energy' && hasPeakIntervalEvidence) {
    const peakRange = /^peak-interval:(.+Z)\/(.+Z)$/.exec(mandatoryEvidence[7]);
    if (mandatoryCount !== 8 || !peakRange) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        `${fieldName}.peak-interval 证据位置或 mandatory 数量无效。`,
        { fieldName },
        400
      );
    }
    assertDemoProjectionUtcIso(peakRange[1], `${fieldName}.evidence[7].startUtc`);
    assertDemoProjectionUtcIso(peakRange[2], `${fieldName}.evidence[7].endUtc`);
    const peakGranularityMinutes = (Date.parse(peakRange[2]) - Date.parse(peakRange[1])) / 60000;
    if (![15, 30, 60].includes(peakGranularityMinutes)
      || Date.parse(peakRange[1]) < Date.parse(windowMatch[1])
      || Date.parse(peakRange[2]) > Date.parse(windowMatch[2])) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        `${fieldName}.peak-interval 必须是数据窗口内开始早于结束的完整区间。`,
        { fieldName },
        400
      );
    }
  } else if (metricCode === 'load_rate' && mandatoryCount !== 7) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.load_rate mandatory evidence 数量无效。`,
      { fieldName },
      400
    );
  } else if (metricCode === 'peak_interval_energy' && mandatoryCount !== 7) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.peak_interval_energy mandatory evidence 数量无效。`,
      { fieldName },
      400
    );
  } else if (!SUPPORTED_METRIC_CODES.includes(metricCode) && mandatoryCount !== 7) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.unsupported metric mandatory evidence 数量无效。`,
      { fieldName },
      400
    );
  }
  const detailEvidence = evidence.slice(mandatoryCount);
  const sortedDetailEvidence = [...detailEvidence].sort((left, right) => left.localeCompare(right));
  if (detailEvidence.length !== evidencePolicy.returnedDetailEvidenceCount
    || evidencePolicy.availableDetailEvidenceCount > recordCount
    || detailEvidence.some((item, index) => {
      const match = /^timeseries:([1-9]\d*)$/.exec(item);
      return !match || !Number.isSafeInteger(Number(match[1]))
        || item !== sortedDetailEvidence[index];
    })) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidence 详细证据必须是正式 timeseries:<id> 形态。`,
      { fieldName },
      400
    );
  }
  if (evidenceSnapshot.evidenceRequirements !== null
    && evidencePolicy.detailEvidenceLimit !== evidenceSnapshot.evidenceRequirements.maxEvidenceItems) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.evidenceRequirements.maxEvidenceItems 必须与 evidencePolicy.detailEvidenceLimit 一致。`,
      { fieldName },
      400
    );
  }
  const automationBoundary = evidenceSnapshot.automationBoundary;
  if (!automationBoundary || typeof automationBoundary !== 'object' || Array.isArray(automationBoundary)
    || Object.getPrototypeOf(automationBoundary) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName}.automationBoundary 必须是 JSON object。`,
      { fieldName },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(automationBoundary, `${fieldName}.automationBoundary`, DEMO_STRATEGY_AUTOMATION_BOUNDARY_FIELDS);
  if (automationBoundary.usesAI !== false
    || automationBoundary.issuesControlCommand !== false
    || automationBoundary.changesDeviceState !== false
    || automationBoundary.requiresManualReview !== true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.automationBoundary 不符合正式人工复核边界。`,
      { fieldName },
      400
    );
  }
  return evidenceSnapshot;
}

/** 校验策略命中状态、阈值判断、配置错误和节能估算的正式组合。 */
function assertStrategyRuleHitEvaluationSemantics(row, threshold, evidenceSnapshot, reasonCodes) {
  const configurationErrors = evidenceSnapshot.configurationErrors;
  const metricCode = evidenceSnapshot.evidence[3].slice('metric:'.length);
  const scopeMatch = /^scope:energy-type=(.*);unit=(.*);source-timezone=([^;]+)$/
    .exec(evidenceSnapshot.evidence[2]);
  const hasConfigurationError = (code) => configurationErrors.includes(code);
  if (metricCode === 'load_rate') {
    const hasThresholdUnitMismatch = threshold.unit !== '%';
    if (hasConfigurationError('STRATEGY_THRESHOLD_UNIT_MISMATCH') !== hasThresholdUnitMismatch
      || hasConfigurationError('STRATEGY_METRIC_UNIT_UNAVAILABLE')
      || hasConfigurationError('UNSUPPORTED_STRATEGY_METRIC')) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        'load_rate 配置错误必须与正式指标单位和支持状态一致。',
        { fieldName: 'snapshot.threshold_snapshot_json/evidence_json.configurationErrors' },
        400
      );
    }
  } else if (metricCode === 'peak_interval_energy') {
    const peakRange = /^peak-interval:(.+Z)\/(.+Z)$/
      .exec(evidenceSnapshot.evidence[7] || '');
    if (hasConfigurationError('UNSUPPORTED_STRATEGY_METRIC')
      || (peakRange && hasConfigurationError('STRATEGY_METRIC_UNIT_UNAVAILABLE'))
      || (!peakRange
        && hasConfigurationError('STRATEGY_METRIC_UNIT_UNAVAILABLE')
        && hasConfigurationError('STRATEGY_THRESHOLD_UNIT_MISMATCH'))) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        'peak_interval_energy 配置错误必须与正式指标支持状态、峰值证据和单位降级语义一致。',
        { fieldName: 'snapshot.evidence_json.configurationErrors' },
        400
      );
    }
    if (peakRange) {
      const granularityMinutes = (Date.parse(peakRange[2]) - Date.parse(peakRange[1])) / 60000;
      const hasThresholdUnitMismatch = threshold.unit !== `${scopeMatch[2]}/${granularityMinutes}min`;
      if (hasConfigurationError('STRATEGY_THRESHOLD_UNIT_MISMATCH') !== hasThresholdUnitMismatch) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'peak_interval_energy 阈值单位错误必须与正式峰值区间粒度一致。',
          { fieldName: 'snapshot.threshold_snapshot_json/evidence_json.configurationErrors' },
          400
        );
      }
    }
  } else if (!hasConfigurationError('UNSUPPORTED_STRATEGY_METRIC')
    || hasConfigurationError('STRATEGY_THRESHOLD_UNIT_MISMATCH')
    || hasConfigurationError('STRATEGY_METRIC_UNIT_UNAVAILABLE')
    || !reasonCodes?.includes('UNIT_NOT_COMPARABLE')
    || !reasonCodes?.includes('NO_TIMESERIES_DATA')) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      '未知策略指标只能按正式 evaluator 的 unsupported not_evaluable 配置错误和原因码组合登记。',
      { fieldName: 'snapshot.evidence_json.configurationErrors/reason_codes_json' },
      400
    );
  }
  if (row.match_status === 'not_evaluable') {
    if (row.actual_value !== null || row.estimated_saving !== null
      || row.estimated_saving_unit !== null || !reasonCodes || reasonCodes.length === 0
      || (configurationErrors.length > 0 && !reasonCodes.includes('UNIT_NOT_COMPARABLE'))) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        'not_evaluable 策略命中必须使用空实际值、空节能估算和与配置错误一致的非空正式原因码。',
        { fieldName: 'snapshot.match_status/actual_value/estimated_saving/reason_codes_json' },
        400
      );
    }
    return;
  }
  if (configurationErrors.length > 0 || reasonCodes !== null) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'matched/not_matched 策略命中不得携带会降级为 not_evaluable 的配置错误或原因码。',
      { fieldName: 'snapshot.match_status/evidence_json.configurationErrors/reason_codes_json' },
      400
    );
  }
  if (metricCode === 'peak_interval_energy') {
    const peakRange = /^peak-interval:(.+Z)\/(.+Z)$/
      .exec(evidenceSnapshot.evidence[7] || '');
    const granularityMinutes = peakRange
      ? (Date.parse(peakRange[2]) - Date.parse(peakRange[1])) / 60000
      : null;
    if (!peakRange || ![15, 30, 60].includes(granularityMinutes)
      || threshold.unit !== `${scopeMatch[2]}/${granularityMinutes}min`) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        '可评价 peak_interval_energy 必须绑定正式峰值区间粒度和指标单位。',
        { fieldName: 'snapshot.threshold_snapshot_json/evidence_json.evidence' },
        400
      );
    }
  }
  const expectedMatch = evaluateStrategyThresholdMatch(row.actual_value, threshold);
  if ((row.match_status === 'matched') !== expectedMatch) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      '策略命中 match_status 与正式 operator/threshold 判断结果不一致。',
      { fieldName: 'snapshot.match_status/actual_value/threshold_snapshot_json' },
      400
    );
  }
  if (row.match_status === 'not_matched'
    && (row.estimated_saving !== null || row.estimated_saving_unit !== null)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'not_matched 策略命中不得包含节能估算。',
      { fieldName: 'snapshot.match_status/estimated_saving/estimated_saving_unit' },
      400
    );
  }
  if (row.estimated_saving !== null
    && (row.match_status !== 'matched'
      || row.coverage_rate !== 1
      || !Number.isFinite(threshold.reductionRate)
      || evidenceSnapshot.evidenceRequirements?.savingBasis !== 'window_total_energy'
      || row.estimated_saving_unit !== scopeMatch[2])) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      '策略命中节能估算不符合正式完整覆盖、降幅、单位和 savingBasis 前提。',
      { fieldName: 'snapshot.estimated_saving/coverage_rate/threshold_snapshot_json/evidence_json' },
      400
    );
  }
}

/** 校验策略评价运行审计时间的单调序列，允许 cancelled 缺少 started_at。 */
function assertStrategyEvaluationRunAuditTimeline(row) {
  const timestamps = [
    ['snapshot.created_at', row.created_at],
    ['snapshot.started_at', row.started_at],
    ['snapshot.completed_at', row.completed_at],
    ['snapshot.updated_at', row.updated_at]
  ].filter(([, value]) => value !== null);
  for (let index = 1; index < timestamps.length; index += 1) {
    if (Date.parse(timestamps[index - 1][1]) > Date.parse(timestamps[index][1])) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
        '策略评价运行审计时间必须满足 created_at <= started_at <= completed_at <= updated_at（缺失时间字段按生命周期允许为空）。',
        { fieldName: `${timestamps[index - 1][0]}/${timestamps[index][0]}` },
        400
      );
    }
  }
}

/** 校验策略评价运行状态与时间、错误、原因字段的固定生命周期矩阵。 */
function assertStrategyEvaluationRunLifecycle(row) {
  const hasStartedAt = row.started_at !== null;
  const hasCompletedAt = row.completed_at !== null;
  const hasErrorMessage = typeof row.error_message === 'string' && row.error_message.trim() !== '';
  const hasAnyErrorValue = row.error_message !== null;
  const hasReasonCodes = row.reason_codes_json !== null;
  if (hasStartedAt && hasCompletedAt && Date.parse(row.started_at) > Date.parse(row.completed_at)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      '策略评价运行 started_at 不得晚于 completed_at。',
      { fieldName: 'snapshot.started_at/completed_at' },
      400
    );
  }
  const valid = row.status === 'pending'
    ? !hasStartedAt && !hasCompletedAt && !hasAnyErrorValue && !hasReasonCodes
    : row.status === 'running'
      ? hasStartedAt && !hasCompletedAt && !hasAnyErrorValue && !hasReasonCodes
      : row.status === 'completed'
        ? hasStartedAt && hasCompletedAt && !hasAnyErrorValue
        : row.status === 'failed'
          ? hasStartedAt && hasCompletedAt && hasErrorMessage && !hasReasonCodes
          : row.status === 'cancelled'
            ? hasCompletedAt && !hasAnyErrorValue && !hasReasonCodes
            : false;
  if (!valid) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      '策略评价运行状态与时间、错误、原因字段不符合固定生命周期矩阵。',
      { fieldName: 'snapshot.status/started_at/completed_at/error_message/reason_codes_json' },
      400
    );
  }
}

/** 校验策略运行或命中使用的正式原因码 JSON，并拒绝未知、重复和空数组。 */
function assertStrategyReasonCodes(value, fieldName, options = {}) {
  const parsed = assertStrictDemoProjectionJsonStringArray(value, fieldName, {
    nullable: options.nullable === true,
    unique: true,
    nonEmpty: true
  });
  if (parsed && parsed.some((code) => !ENERGY_ANALYSIS_REASON_CODES.includes(code))) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName} 包含正式 evaluator 未定义的原因码。`,
      { fieldName },
      400
    );
  }
  return parsed;
}

/** 校验能流来源墙钟分钟字段。 */
function assertDemoProjectionWallClockMinute(value, fieldName, options = {}) {
  if (value === null && options.nullable === true) return;
  if (typeof value !== 'string' || !DEMO_WALL_CLOCK_MINUTE_PATTERN.test(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_TIME_INVALID',
      `${fieldName} 必须是严格来源墙钟分钟。`,
      { fieldName, value: value ?? null }
    );
  }
}

/** 校验能流来源映射为带非空 reference 的 JSON object。 */
function assertEnergyFlowSourceMapping(value, fieldName) {
  let mapping;
  try { mapping = JSON.parse(value); } catch (_error) { mapping = null; }
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object'
    || typeof mapping.reference !== 'string' || mapping.reference.trim() === '') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName} 必须是带非空 reference 的 JSON object。`,
      { fieldName },
      400
    );
  }
}

/** 从服务端读取的业务行生成固定字段投影，不接受调用方补充或替换字段。 */
function projectDemoOwnershipRow(handler, row, fieldName = 'snapshot') {
  // Proxy 必须在原型、键名和字段值读取前拒绝，避免任何 trap 执行。
  if (row === null || typeof row !== 'object' || utilTypes.isProxy(row) || Array.isArray(row)
    || Object.getPrototypeOf(row) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_INVALID',
      `${fieldName} 必须来自静态 handler 的业务行投影。`,
      { fieldName }
    );
  }
  const expectedFields = handler.projectionFields;
  // 描述符读取不会执行 getter/setter；后续只消费一次性复制的数据值。
  const descriptors = Object.getOwnPropertyDescriptors(row);
  const actualFields = Object.keys(descriptors).sort();
  const expectedSortedFields = [...expectedFields].sort();
  const hasSymbolFields = Object.getOwnPropertySymbols(descriptors).length > 0;
  const hasDynamicField = actualFields.some((key) => (
    !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
  ));
  if (hasSymbolFields || hasDynamicField || actualFields.length !== expectedSortedFields.length
    || actualFields.some((key, index) => key !== expectedSortedFields[index])) {
    throw createDemoOwnershipError(
      hasDynamicField ? 'DEMO_OWNERSHIP_SNAPSHOT_DYNAMIC_FIELD_INVALID' : 'DEMO_OWNERSHIP_SNAPSHOT_FIELDS_INVALID',
      `${fieldName} 只能包含静态 projection 数据字段。`,
      { fieldName, expectedFields: expectedSortedFields, actualFields, hasSymbolFields, hasDynamicField }
    );
  }
  const projectedRow = Object.fromEntries(expectedFields.map((key) => [key, descriptors[key].value]));
  expectedFields.forEach((key) => {
    if (['created_at', 'updated_at', 'archived_at'].includes(key)) assertDemoProjectionUtcMilliseconds(
      projectedRow[key],
      `${fieldName}.${key}`,
      { nullable: key === 'archived_at' }
    );
  });
  if (typeof handler.validateProjectionRow === 'function') handler.validateProjectionRow(projectedRow);
  return projectedRow;
}

/** 生成与 registrar、cleanup 共用的版本化 snapshot envelope。 */
function buildDemoEntitySnapshotProjection(entityType, entityPk, row) {
  const handler = getDemoOwnershipEntityHandler(entityType);
  if (!handler) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_PROJECTION_UNDEFINED',
      '演示 ownership 实体没有服务端固定 snapshot projection。',
      { entityType },
      400
    );
  }
  const projectedRow = projectDemoOwnershipRow(handler, row);
  const normalizedRow = normalizeStrictJsonValue(projectedRow, 'snapshot');
  const snapshotValue = {
    projectionVersion: handler.projectionVersion,
    entityType,
    entityPk: String(entityPk),
    fields: normalizedRow
  };
  return {
    value: snapshotValue,
    json: JSON.stringify(snapshotValue)
  };
}

/** 计算实体固定 projection 快照摘要，cleanup 必须复用同一 helper。 */
function calculateDemoEntitySnapshotDigest(entityType, entityPk, row) {
  const snapshot = buildDemoEntitySnapshotProjection(String(entityType || ''), String(entityPk || ''), row);
  return sha256Stable({
    domain: 'demo-entity-snapshot:v1',
    projectionVersion: snapshot.value.projectionVersion,
    entityType: snapshot.value.entityType,
    entityPk: snapshot.value.entityPk,
    fields: snapshot.value.fields
  });
}

/** 构造 ownership 公共登记的稳定应用错误。 */
function createDemoOwnershipError(code, message, details = null, statusCode = 500) {
  return new AppError(code, message, { statusCode, details });
}

/** 判断 SQL 是否包含事务生命周期控制语句；受控 facade 内统一禁止。 */
function containsDemoOwnershipTransactionControl(sql) {
  if (typeof sql !== 'string') return true;
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  return withoutComments.split(';').some((statement) => (
    /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)
  ));
}

/** 由外部连接或显式路径解析私有 ownership 事务的数据库文件路径。 */
function resolveDemoOwnershipDatabasePath(target) {
  const candidate = typeof target === 'string'
    ? target
    : target && typeof target === 'object'
      ? (target.databasePath || target.name)
      : null;
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate === ':memory:') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_DATABASE_PATH_INVALID',
      'ownership transaction 必须使用可由私有连接重新打开的 SQLite 文件路径或外部文件连接。',
      null,
      400
    );
  }
  return path.resolve(candidate);
}

/** 校验 demo ownership 调用使用当前 active scope，并从私有 WeakMap 取得真实连接。 */
function requireDemoOwnershipTransactionScope(transactionScope) {
  const state = transactionScope && typeof transactionScope === 'object'
    ? DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE.get(transactionScope)
    : null;
  if (!state || state.active !== true
    || DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB.get(state.privateDb) !== transactionScope
    || state.privateDb.inTransaction !== true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED',
      '演示 ownership 必须使用当前 runWithDemoOwnershipTransaction callback 的 active scope。',
      null,
      409
    );
  }
  if (state.poisoned === true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_POISONED',
      '演示 ownership 事务 scope 已因非法生命周期操作失效。',
      null,
      409
    );
  }
  return state;
}

/** 仅允许 active scope 内调用只读 facade，避免异步或 callback 外继续使用私有连接。 */
function requireActiveDemoOwnershipFacade(state) {
  if (!state || state.active !== true || !state.privateDb.open
    || state.privateDb.inTransaction !== true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_REQUIRED',
      'ownership transaction facade 仅能在 active scope callback 内使用。',
      null,
      409
    );
  }
  if (state.poisoned === true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_POISONED',
      'ownership transaction facade 已因非法 SQL 或生命周期操作失效。',
      null,
      409
    );
  }
}

/** 创建只暴露 get/all 的只读语句 facade，不暴露 better-sqlite3 raw statement。 */
function createDemoOwnershipStatementFacade(state, statement) {
  const statementFacade = Object.create(null);
  const get = (...parameters) => {
    requireActiveDemoOwnershipFacade(state);
    return statement.get(...parameters);
  };
  const all = (...parameters) => {
    requireActiveDemoOwnershipFacade(state);
    return statement.all(...parameters);
  };
  Object.defineProperties(statementFacade, {
    get: { value: get, enumerable: true },
    all: { value: all, enumerable: true }
  });
  return Object.freeze(statementFacade);
}

/** 将 facade 标记为 poisoned 并抛出固定安全错误，确保 wrapper 后续只执行回滚。 */
function poisonDemoOwnershipFacade(state, code, message) {
  state.poisoned = true;
  throw createDemoOwnershipError(code, message, null, 409);
}

/** 获取 SQL 首个关键字，供只读 facade 拒绝 PRAGMA 和事务控制语句。 */
function getDemoOwnershipSqlKeyword(sql) {
  if (typeof sql !== 'string') return null;
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
  const match = /^([A-Za-z]+)/.exec(withoutComments);
  return match ? match[1].toUpperCase() : null;
}

/** 创建严格只读数据库 facade；任何写 SQL、DDL、PRAGMA 或事务入口都会 poison scope。 */
function createDemoOwnershipDatabaseFacade(state) {
  const facade = Object.create(null);
  const prepare = (sql) => {
    requireActiveDemoOwnershipFacade(state);
    const keyword = getDemoOwnershipSqlKeyword(sql);
    if (containsDemoOwnershipTransactionControl(sql)) {
      poisonDemoOwnershipFacade(
        state,
        'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN',
        'ownership transaction facade 禁止通过 prepare 控制事务生命周期。'
      );
    }
    if (keyword === 'PRAGMA') {
      poisonDemoOwnershipFacade(
        state,
        'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN',
        'ownership transaction facade 禁止执行 PRAGMA。'
      );
    }
    let statement;
    try {
      statement = state.privateDb.prepare(sql);
    } catch (error) {
      state.poisoned = true;
      throw error;
    }
    if (statement.readonly !== true || statement.reader !== true) {
      poisonDemoOwnershipFacade(
        state,
        'DEMO_OWNERSHIP_READONLY_SQL_FORBIDDEN',
        'ownership transaction facade 只允许 SQLite readonly reader statement 的 get/all 操作。'
      );
    }
    return createDemoOwnershipStatementFacade(state, statement);
  };
  const exec = () => {
    requireActiveDemoOwnershipFacade(state);
    poisonDemoOwnershipFacade(
      state,
      'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN',
      'ownership transaction facade 不开放 exec。'
    );
  };
  const transaction = () => {
    requireActiveDemoOwnershipFacade(state);
    poisonDemoOwnershipFacade(
      state,
      'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN',
      'ownership transaction facade 禁止创建嵌套事务。'
    );
  };
  const close = () => {
    requireActiveDemoOwnershipFacade(state);
    poisonDemoOwnershipFacade(
      state,
      'DEMO_OWNERSHIP_TRANSACTION_CONTROL_FORBIDDEN',
      'ownership transaction facade 禁止关闭私有连接。'
    );
  };
  Object.defineProperties(facade, {
    prepare: { value: prepare, enumerable: true },
    exec: { value: exec, enumerable: true },
    transaction: { value: transaction, enumerable: true },
    close: { value: close, enumerable: true },
    inTransaction: {
      get: () => Boolean(state.active && state.privateDb.open && state.privateDb.inTransaction),
      enumerable: true
    }
  });
  return Object.freeze(facade);
}

/**
 * 使用独占私有 SQLite 连接创建 ownership scope；callback 只能通过 facade 只读查询，
 * 业务写入仅能调用声明式 witness helper，治理写入仅由 registrar 内部执行。
 * 外部连接或路径仅用于定位数据库，外部 raw exec/prototype 方法无法影响私有事务。
 */
function runWithDemoOwnershipTransaction(target, callback) {
  if (typeof callback !== 'function') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_INVALID',
      'ownership transaction wrapper callback 参数无效。',
      null,
      400
    );
  }
  const databasePath = resolveDemoOwnershipDatabasePath(target);
  const privateDb = openDatabase({ databasePath });
  try {
    privateDb.pragma('foreign_keys = ON');
    privateDb.pragma('busy_timeout = 5000');
    if (privateDb.pragma('foreign_keys', { simple: true }) !== 1) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_PRIVATE_DATABASE_PRAGMA_INVALID',
        'ownership 私有 SQLite 连接未启用 foreign_keys。'
      );
    }
  } catch (error) {
    privateDb.close();
    throw error;
  }
  const state = {
    privateDb,
    active: true,
    poisoned: false,
    witnesses: new Set(),
    pendingWitnesses: new Set(),
    facade: null
  };
  const transactionScope = Object.create(null);
  state.facade = createDemoOwnershipDatabaseFacade(state);
  Object.defineProperties(transactionScope, {
    db: { value: state.facade, enumerable: true },
    facade: { value: state.facade, enumerable: true }
  });
  Object.freeze(transactionScope);

  let result;
  let failure = null;
  try {
    privateDb.exec('BEGIN IMMEDIATE');
    DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE.set(transactionScope, state);
    DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB.set(privateDb, transactionScope);
    result = callback(transactionScope, state.facade);
    const then = result && result.then;
    if (typeof then === 'function') {
      // 先为原始 Promise/thenable 绑定 rejection 消费，再同步拒绝 callback，避免 unhandledRejection。
      try {
        const chained = then.call(result, undefined, () => undefined);
        if (chained && typeof chained.then === 'function') {
          Promise.resolve(chained).catch(() => undefined);
        }
      } catch (_error) {
        // thenable 自身异常不应覆盖固定的同步 callback 错误。
      }
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_TRANSACTION_SCOPE_ASYNC_FORBIDDEN',
        'ownership transaction scope callback 必须同步完成。',
        null,
        409
      );
    }
    if (state.poisoned || privateDb.inTransaction !== true) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN',
        'ownership transaction scope 生命周期已被破坏。',
        null,
        409
      );
    }
    if (state.pendingWitnesses.size > 0) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_WITNESS_NOT_REGISTERED',
        'ownership transaction scope 内存在未完成登记的 inserted witness。',
        { pendingCount: state.pendingWitnesses.size },
        409
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    state.active = false;
    DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB.delete(privateDb);
    state.witnesses.forEach((witness) => DEMO_INSERTED_ROW_WITNESS_STATE.delete(witness));
    DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE.delete(transactionScope);
  }

  try {
    if (failure) {
      if (privateDb.inTransaction) privateDb.exec('ROLLBACK');
    } else {
      privateDb.exec('COMMIT');
    }
  } catch (error) {
    failure = failure || error;
    if (privateDb.inTransaction) {
      try { privateDb.exec('ROLLBACK'); } catch (_rollbackError) { /* 连接关闭前无需继续传播回滚异常。 */ }
    }
  } finally {
    privateDb.close();
  }
  if (failure) throw failure;
  return result;
}

/**
 * 使用独占私有 SQLite 连接创建可等待的 ownership scope；供已固定绑定的 managed execute 使用，
 * 允许锁内等待在线备份，但仍不向消费者暴露 raw connection 或事务控制能力。
 */
async function runWithDemoOwnershipTransactionAsync(target, callback) {
  if (typeof callback !== 'function') {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_INVALID',
      'ownership transaction wrapper callback 参数无效。',
      null,
      400
    );
  }
  const databasePath = resolveDemoOwnershipDatabasePath(target);
  const privateDb = openDatabase({ databasePath });
  try {
    privateDb.pragma('foreign_keys = ON');
    privateDb.pragma('busy_timeout = 5000');
    if (privateDb.pragma('foreign_keys', { simple: true }) !== 1) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_PRIVATE_DATABASE_PRAGMA_INVALID',
        'ownership 私有 SQLite 连接未启用 foreign_keys。'
      );
    }
  } catch (error) {
    privateDb.close();
    throw error;
  }
  const state = {
    privateDb,
    active: true,
    poisoned: false,
    witnesses: new Set(),
    pendingWitnesses: new Set(),
    facade: null
  };
  const transactionScope = Object.create(null);
  state.facade = createDemoOwnershipDatabaseFacade(state);
  Object.defineProperties(transactionScope, {
    db: { value: state.facade, enumerable: true },
    facade: { value: state.facade, enumerable: true }
  });
  Object.freeze(transactionScope);

  let result;
  let failure = null;
  try {
    privateDb.exec('BEGIN IMMEDIATE');
    DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE.set(transactionScope, state);
    DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB.set(privateDb, transactionScope);
    result = await callback(transactionScope, state.facade);
    if (state.poisoned || privateDb.inTransaction !== true) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN',
        'ownership transaction scope 生命周期已被破坏。',
        null,
        409
      );
    }
    if (state.pendingWitnesses.size > 0) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_WITNESS_NOT_REGISTERED',
        'ownership transaction scope 内存在未完成登记的 inserted witness。',
        { pendingCount: state.pendingWitnesses.size },
        409
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    state.active = false;
    DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB.delete(privateDb);
    state.witnesses.forEach((witness) => DEMO_INSERTED_ROW_WITNESS_STATE.delete(witness));
    DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE.delete(transactionScope);
  }

  try {
    if (failure) {
      if (privateDb.inTransaction) privateDb.exec('ROLLBACK');
    } else {
      privateDb.exec('COMMIT');
    }
  } catch (error) {
    failure = failure || error;
    if (privateDb.inTransaction) {
      try { privateDb.exec('ROLLBACK'); } catch (_rollbackError) { /* 连接关闭前无需继续传播回滚异常。 */ }
    }
  } finally {
    privateDb.close();
  }
  if (failure) throw failure;
  return result;
}

/** 校验登记操作者为当前库中的 active 正整数用户。 */
function requireDemoOwnershipActor(db, input = {}) {
  const contextUserId = input.demoContext && input.demoContext.userId;
  const actorUserId = input.actorUserId === undefined ? contextUserId : input.actorUserId;
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ACTOR_INVALID',
      '演示 ownership 登记操作者无效。',
      { actorUserId: actorUserId ?? null },
      400
    );
  }
  if (contextUserId !== undefined && contextUserId !== actorUserId) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ACTOR_MISMATCH',
      '演示 ownership 登记操作者与 context 用户不一致。',
      { actorUserId },
      409
    );
  }
  const actor = db.prepare("SELECT id, status FROM sys_users WHERE id = ? AND status = 'active'").get(actorUserId);
  if (!actor) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ACTOR_INACTIVE',
      '演示 ownership 登记操作者不存在或已停用。',
      { actorUserId },
      403
    );
  }
  return actorUserId;
}

/** 规范化服务端静态实体类型，禁止大小写或空白容错掩盖 handler 配置错误。 */
function normalizeCanonicalEntityType(entityType) {
  if (typeof entityType !== 'string'
    || entityType !== entityType.trim()
    || !/^[a-z][a-z0-9_]{0,127}$/.test(entityType)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_TYPE_INVALID',
      '演示 ownership 实体类型必须为 canonical snake_case。',
      { entityType: typeof entityType === 'string' ? entityType : null }
    );
  }
  return entityType;
}

/** 规范化业务实体正整数主键并返回 registry 使用的 canonical 文本。 */
function normalizeCanonicalEntityPk(entityPk) {
  const rawEntityPk = typeof entityPk === 'number' ? String(entityPk) : entityPk;
  if (typeof rawEntityPk !== 'string'
    || rawEntityPk !== rawEntityPk.trim()
    || !DEMO_ENTITY_PK_PATTERN.test(rawEntityPk)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_PK_INVALID',
      '演示 ownership 实体主键必须为 canonical 正整数。',
      { entityPk: rawEntityPk ?? null }
    );
  }
  const numericEntityPk = Number(rawEntityPk);
  if (!Number.isSafeInteger(numericEntityPk)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_PK_INVALID',
      '演示 ownership 实体主键超出安全整数范围。',
      { entityPk: rawEntityPk }
    );
  }
  return rawEntityPk;
}

/** 递归规范化严格 JSON 投影，拒绝循环引用、稀疏数组和非 JSON 值。 */
function normalizeStrictJsonValue(value, fieldName, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_JSON_INVALID',
        `${fieldName} 包含非有限数值。`,
        { fieldName, path }
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_JSON_INVALID',
      `${fieldName} 必须只包含 JSON 值。`,
      { fieldName, path }
    );
  }
  if (ancestors.has(value)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_JSON_INVALID',
      `${fieldName} 不得包含循环引用。`,
      { fieldName, path }
    );
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_unused, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_JSON_INVALID',
          `${fieldName} 不得包含稀疏数组。`,
          { fieldName, path: `${path}[${index}]` }
        );
      }
      return normalizeStrictJsonValue(value[index], fieldName, `${path}[${index}]`, nextAncestors);
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_JSON_INVALID',
      `${fieldName} 必须为普通 JSON 对象。`,
      { fieldName, path }
    );
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    normalizeStrictJsonValue(value[key], fieldName, `${path}.${key}`, nextAncestors)
  ]));
}

/** 判断 identity 投影是否至少包含一个非空稳定值。 */
function hasMeaningfulIdentityValue(value) {
  if (value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulIdentityValue);
  if (value && typeof value === 'object') return Object.values(value).some(hasMeaningfulIdentityValue);
  return false;
}

/** 生成严格、键排序且无隐式类型转换的 canonical JSON 文本。 */
function canonicalizeDemoJsonProjection(value, fieldName, options = {}) {
  const normalizedValue = normalizeStrictJsonValue(value, fieldName);
  const requiresObject = options.requiresObject !== false;
  if (requiresObject && (!normalizedValue || Array.isArray(normalizedValue)
    || typeof normalizedValue !== 'object' || Object.keys(normalizedValue).length === 0)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_PROJECTION_EMPTY',
      `${fieldName} 必须为非空 JSON 对象。`,
      { fieldName }
    );
  }
  if (options.requiresMeaningfulValue === true && !hasMeaningfulIdentityValue(normalizedValue)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_IDENTITY_EMPTY',
      '演示 ownership identity 不得为空。',
      { fieldName }
    );
  }
  return {
    value: normalizedValue,
    json: JSON.stringify(normalizedValue)
  };
}

/** 校验对象原型、数据属性和字段白名单，拒绝 Proxy/getter 在安全检查期间重入。 */
function assertExactPlainObjectFields(value, allowedFields, code, message, details = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createDemoOwnershipError(code, message, details, 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualFields = Object.keys(descriptors).sort();
  const expectedFields = [...allowedFields].sort();
  const hasAccessor = actualFields.some((key) => (
    typeof descriptors[key].get === 'function' || typeof descriptors[key].set === 'function'
  ));
  if (hasAccessor || actualFields.length !== expectedFields.length
    || actualFields.some((key, index) => key !== expectedFields[index])) {
    throw createDemoOwnershipError(code, message, {
      ...details,
      expectedFields,
      actualFields,
      hasAccessor
    }, 400);
  }
  return value;
}

/** 计算与既有清理校验兼容的 canonical entity identity 摘要。 */
function calculateDemoEntityIdentityProjectionDigest(entityType, entityPk) {
  return calculateDemoEntityIdentityDigest(entityType, entityPk);
}

/** 构建 imported ownership 的 canonical identity 与服务端固定 snapshot projection 合同。 */
function buildDemoEntityRegistrationContract(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['entityType', 'entityPk', 'row'],
    'DEMO_OWNERSHIP_REGISTRATION_FIELDS_INVALID',
    'ownership registration contract 只能接收服务端实体、主键和业务行。'
  );
  const entityType = normalizeCanonicalEntityType(input.entityType);
  const entityPk = normalizeCanonicalEntityPk(input.entityPk);
  const handler = getDemoOwnershipEntityHandler(entityType);
  if (!handler) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_PROJECTION_UNDEFINED',
      '演示 ownership 实体没有服务端固定 snapshot projection。',
      { entityType },
      400
    );
  }
  const numericEntityPk = Number(entityPk);
  const projectedRow = projectDemoOwnershipRow(handler, input.row);
  if (Number(projectedRow.id) !== numericEntityPk) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_PK_ROW_MISMATCH',
      'ownership 主键与服务端业务行主键不一致。',
      { entityType, entityPk },
      409
    );
  }
  const identity = { entityType, entityPk };
  const snapshot = buildDemoEntitySnapshotProjection(entityType, entityPk, projectedRow);
  return {
    entityType,
    entityPk,
    identityJson: JSON.stringify(identity),
    identityDigest: calculateDemoEntityIdentityProjectionDigest(entityType, entityPk),
    projectionVersion: handler.projectionVersion,
    snapshotJson: snapshot.json,
    snapshotDigest: calculateDemoEntitySnapshotDigest(entityType, entityPk, projectedRow)
  };
}

/** 拆分 INSERT VALUES 表达式；只支持无嵌套括号的单条纯 VALUES 插入。 */
function splitDemoInsertList(source) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      current += character;
      if (quoted && source[index + 1] === "'") {
        current += source[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted) return null;
  values.push(current.trim());
  return values;
}

/** 校验声明式 INSERT SQL 只能写入当前静态 handler 的单表、白名单列和纯 VALUES。 */
function parseDemoOwnershipInsertSql(handler, sql, parameterCount) {
  if (typeof sql !== 'string' || sql.trim() !== sql || sql.length === 0
    || /[;]|\/\*|--/.test(sql)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_SQL_INVALID',
      'ownership 插入 SQL 必须是无注释、无分号的单条纯 INSERT。'
    );
  }
  const match = /^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s+VALUES\s*\(([^()]*)\)$/is.exec(sql);
  if (!match || match[1] !== handler.tableName) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_SQL_INVALID',
      'ownership 插入 SQL 必须精确写入当前实体 handler 表的 VALUES。',
      { expectedTable: handler.tableName }
    );
  }
  const columns = match[2].split(',').map((column) => column.trim());
  const values = splitDemoInsertList(match[3]);
  const allowedColumns = new Set(handler.projectionFields.filter((column) => column !== handler.primaryKeyColumn));
  if (!values || columns.length === 0 || columns.length !== values.length
    || new Set(columns).size !== columns.length
    || columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)
      || !allowedColumns.has(column))) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_SQL_INVALID',
      'ownership 插入 SQL 的列必须是当前 handler 的非主键白名单列。',
      { expectedTable: handler.tableName }
    );
  }
  const parameterTokens = values.filter((value) => value === '?');
  const supportedLiteral = /^(?:\?|NULL|[-+]?(?:\d+(?:\.\d*)?|\.\d+)|'(?:''|[^'])*')$/i;
  if (values.some((value) => !supportedLiteral.test(value))
    || parameterTokens.length !== parameterCount) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_SQL_INVALID',
      'ownership 插入 SQL 只能使用简单参数或 SQLite 字面量 VALUES，且参数数量必须匹配。',
      { expectedParameterCount: parameterTokens.length, actualParameterCount: parameterCount }
    );
  }
  return { columns, values };
}

/** 校验并复制声明式 INSERT 参数，防止 Proxy、getter、稀疏数组或可变引用重入。 */
function cloneDemoOwnershipInsertParams(insertParams) {
  if (!Array.isArray(insertParams) || utilTypes.isProxy(insertParams)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
      'ownership 插入参数必须是普通数组。'
    );
  }
  let names;
  try {
    names = Object.getOwnPropertyNames(insertParams);
  } catch (_error) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
      'ownership 插入参数数组不可读取。'
    );
  }
  if (names.some((name) => name !== 'length' && !/^\d+$/.test(name))) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
      'ownership 插入参数数组不得包含额外属性。'
    );
  }
  const copied = [];
  for (let index = 0; index < insertParams.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(insertParams, String(index));
    if (!descriptor || descriptor.get || descriptor.set) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
        'ownership 插入参数数组不得包含稀疏项或 getter。'
      );
    }
    const value = descriptor.value;
    if (utilTypes.isProxy(value)
      || (value !== null && typeof value !== 'string' && typeof value !== 'number'
        && typeof value !== 'bigint' && typeof value !== 'boolean' && !Buffer.isBuffer(value))) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
        'ownership 插入参数只能包含 SQLite 基础值。'
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_INSERT_PARAMS_INVALID',
        'ownership 插入参数不得包含非有限数值。'
      );
    }
    copied.push(Buffer.isBuffer(value) ? Buffer.from(value) : value);
  }
  return copied;
}

/** 在当前私有 SQLite 事务中执行声明式纯 INSERT，并生成不可 JSON 伪造的业务行见证。 */
function createDemoOwnershipInsertWitness(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'entityType', 'insertParams', 'insertSql', 'sourceBatchId', 'sourceRowNumber'],
    'DEMO_OWNERSHIP_ROW_WITNESS_INVALID',
    'ownership row witness 必须由服务端私有事务 scope 的声明式插入包装器生成。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  // helper 从校验开始暂时 poison；只有业务行、projection 与 pending witness 全部建立成功后才恢复。
  scopeState.poisoned = true;
  const db = scopeState.privateDb;
  const entityType = normalizeCanonicalEntityType(input.entityType);
  const sourceBatchId = input.sourceBatchId;
  const sourceRowNumber = input.sourceRowNumber;
  if (!Number.isSafeInteger(sourceBatchId) || sourceBatchId < 1
    || !Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_WITNESS_INVALID',
      'ownership 插入包装器必须提供正整数来源证据。'
    );
  }
  const handler = getDemoOwnershipEntityHandler(entityType);
  if (!handler) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_PROJECTION_UNDEFINED',
      '演示 ownership 实体没有服务端固定 snapshot projection。',
      { entityType },
      400
    );
  }
  const insertParams = cloneDemoOwnershipInsertParams(input.insertParams);
  parseDemoOwnershipInsertSql(handler, input.insertSql, insertParams.length);
  const importBatch = db.prepare('SELECT import_type AS importType FROM import_batches WHERE id = ?')
    .get(sourceBatchId);
  if (!importBatch || !handler.expectedImportTypes.includes(importBatch.importType)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH',
      'row witness 来源批次不存在或 import_type 与实体 handler 不一致。',
      { entityType, sourceBatchId, importType: importBatch ? importBatch.importType : null },
      409
    );
  }
  const before = db.prepare(`SELECT COALESCE(MAX(${handler.primaryKeyColumn}), 0) AS maxEntityPk,
      total_changes() AS totalChanges FROM ${handler.tableName}`).get();
  const rawStatement = db.prepare(input.insertSql);
  if (rawStatement.readonly === true) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERT_SQL_INVALID',
      'ownership 插入 SQL 必须是可写 INSERT。'
    );
  }
  const rawResult = rawStatement.run(...insertParams);
  const rawChanges = Number(rawResult.changes);
  const rawLastInsertRowid = Number(rawResult.lastInsertRowid);
  const after = db.prepare(`SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid,
      total_changes() AS totalChanges`).get();
  const entityPk = rawLastInsertRowid;
  const insertedIsProvable = rawChanges === 1
    && Number(after.changes) === rawChanges
    && Number(after.lastInsertRowid) === rawLastInsertRowid
    && Number(after.totalChanges) === Number(before.totalChanges) + 1
    && Number.isSafeInteger(entityPk)
    && entityPk > Number(before.maxEntityPk);
  if (!insertedIsProvable) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_NOT_NEW',
      '无法证明业务实体是当前事务包装器中新插入的自增主键行。',
      { entityType, entityPk: Number.isSafeInteger(entityPk) ? entityPk : null },
      409
    );
  }
  const row = handler.readProjection(db, entityPk);
  if (!row) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_NOT_FOUND',
      '插入回执对应的业务实体不存在。',
      { entityType, entityPk },
      409
    );
  }
  if (Number(row.source_batch_id) !== sourceBatchId
    || Number(row.source_row_number) !== sourceRowNumber) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH',
      '业务实体 source_batch_id/source_row_number 与插入包装器来源不一致。',
      { entityType, entityPk, sourceBatchId, sourceRowNumber },
      409
    );
  }
  const projectedRow = projectDemoOwnershipRow(handler, row, 'rowWitness.projectedRow');
  const witness = Object.freeze(Object.assign(Object.create(null), {
    changes: 1,
    lastInsertRowid: entityPk,
    sourceBatchId,
    sourceRowNumber,
    projectedRow: normalizeStrictJsonValue(projectedRow, 'rowWitness.projectedRow')
  }));
  DEMO_INSERTED_ROW_WITNESS_STATE.set(witness, Object.freeze({
    transactionScope: input.transactionScope,
    entityType,
    entityPk: String(entityPk),
    sourceBatchId,
    sourceRowNumber,
    projectedRowJson: JSON.stringify(witness.projectedRow)
  }));
  scopeState.witnesses.add(witness);
  scopeState.pendingWitnesses.add(witness);
  scopeState.poisoned = false;
  return witness;
}

/** 在 ownership 私有事务内停用同编码的既有 active 班次版本，不暴露写连接。 */
function deactivateShiftDefinitionSiblingsInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'shiftCode', 'updatedAt'],
    'DEMO_SHIFT_DEFINITION_DEACTIVATE_INTENT_INVALID',
    '班次定义版本停用 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  assertDemoProjectionString(input.shiftCode, 'shiftCode', { nonEmpty: true });
  if (input.shiftCode !== input.shiftCode.trim()) {
    throw createDemoOwnershipError(
      'DEMO_SHIFT_DEFINITION_DEACTIVATE_INTENT_INVALID',
      '班次编码必须是已规范化的非空文本。',
      null,
      400
    );
  }
  assertDemoProjectionUtcMilliseconds(input.updatedAt, 'updatedAt');
  return Number(scopeState.privateDb.prepare(`UPDATE shift_definitions
    SET status = 'inactive', updated_at = ?
    WHERE shift_code = ? AND status = 'active'`).run(input.updatedAt, input.shiftCode).changes);
}

/** 在 ownership 私有事务内写入固定班次配置操作审计，不接受动态 operation 或 SQL。 */
function writeShiftDefinitionImportAuditInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    [
      'transactionScope', 'actorUserId', 'actorIp', 'targetId', 'batchId',
      'sourceRowNumber', 'shiftCode', 'version', 'status', 'createdAt'
    ],
    'DEMO_SHIFT_DEFINITION_AUDIT_INTENT_INVALID',
    '班次定义导入审计 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  const db = scopeState.privateDb;
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: input.actorUserId });
  assertDemoProjectionInteger(input.targetId, 'targetId', { min: 1 });
  assertDemoProjectionInteger(input.batchId, 'batchId', { min: 1 });
  assertDemoProjectionInteger(input.sourceRowNumber, 'sourceRowNumber', { min: 1 });
  assertDemoProjectionString(input.shiftCode, 'shiftCode', { nonEmpty: true });
  assertDemoProjectionString(input.version, 'version', { nonEmpty: true });
  assertDemoProjectionEnum(input.status, 'status', ['active', 'inactive']);
  assertDemoProjectionString(input.actorIp, 'actorIp', { nullable: true });
  assertDemoProjectionUtcMilliseconds(input.createdAt, 'createdAt');
  const row = DEMO_OWNERSHIP_ENTITY_HANDLERS.shift_definition.readProjection(db, input.targetId);
  if (!row
    || Number(row.source_batch_id) !== input.batchId
    || Number(row.source_row_number) !== input.sourceRowNumber
    || row.shift_code !== input.shiftCode
    || row.version !== input.version
    || row.status !== input.status) {
    throw createDemoOwnershipError(
      'DEMO_SHIFT_DEFINITION_AUDIT_TARGET_MISMATCH',
      '班次定义操作审计目标与当前事务内业务行不一致。',
      { targetId: input.targetId, batchId: input.batchId, sourceRowNumber: input.sourceRowNumber },
      409
    );
  }
  return insertOperationLogWithDb(db, {
    userId: actorUserId,
    operation: 'energy.shift.configuration.import',
    targetType: 'shift_definition',
    targetId: input.targetId,
    detail: {
      batchId: input.batchId,
      sourceRowNumber: input.sourceRowNumber,
      shiftCode: input.shiftCode,
      version: input.version,
      status: input.status
    },
    ip: input.actorIp,
    createdAt: input.createdAt
  });
}

/** 在 ownership 私有事务内停用同编码既有 active 策略版本，不开放动态表或字段。 */
function deactivateStrategyRuleSiblingsInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'ruleCode', 'updatedAt'],
    'DEMO_STRATEGY_RULE_DEACTIVATE_INTENT_INVALID',
    '策略规则版本停用 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  assertDemoProjectionString(input.ruleCode, 'ruleCode', { nonEmpty: true });
  if (input.ruleCode !== input.ruleCode.trim()) {
    throw createDemoOwnershipError(
      'DEMO_STRATEGY_RULE_DEACTIVATE_INTENT_INVALID',
      '策略规则编码必须是已规范化的非空文本。',
      null,
      400
    );
  }
  assertDemoProjectionUtcMilliseconds(input.updatedAt, 'updatedAt');
  return Number(scopeState.privateDb.prepare(`UPDATE strategy_rules
    SET status = 'inactive', updated_at = ?
    WHERE rule_code = ? AND status = 'active'`).run(input.updatedAt, input.ruleCode).changes);
}

/** 在 ownership 私有事务内写入固定策略配置导入审计，不接受动态 operation 或 SQL。 */
function writeStrategyRuleImportAuditInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    [
      'transactionScope', 'actorUserId', 'actorIp', 'targetId', 'batchId',
      'sourceRowNumber', 'ruleCode', 'ruleVersion', 'formulaVersion',
      'metricCode', 'status', 'createdAt'
    ],
    'DEMO_STRATEGY_RULE_AUDIT_INTENT_INVALID',
    '策略规则导入审计 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  const db = scopeState.privateDb;
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: input.actorUserId });
  assertDemoProjectionInteger(input.targetId, 'targetId', { min: 1 });
  assertDemoProjectionInteger(input.batchId, 'batchId', { min: 1 });
  assertDemoProjectionInteger(input.sourceRowNumber, 'sourceRowNumber', { min: 1 });
  assertDemoProjectionString(input.ruleCode, 'ruleCode', { nonEmpty: true });
  assertDemoProjectionString(input.ruleVersion, 'ruleVersion', { nonEmpty: true });
  assertDemoProjectionString(input.formulaVersion, 'formulaVersion', { nonEmpty: true });
  assertDemoProjectionString(input.metricCode, 'metricCode', { nonEmpty: true });
  assertDemoProjectionEnum(input.status, 'status', ['active', 'inactive']);
  assertDemoProjectionString(input.actorIp, 'actorIp', { nullable: true });
  assertDemoProjectionUtcMilliseconds(input.createdAt, 'createdAt');
  const row = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule.readProjection(db, input.targetId);
  if (!row
    || Number(row.source_batch_id) !== input.batchId
    || Number(row.source_row_number) !== input.sourceRowNumber
    || row.rule_code !== input.ruleCode
    || row.rule_version !== input.ruleVersion
    || row.formula_version !== input.formulaVersion
    || row.metric_code !== input.metricCode
    || row.status !== input.status) {
    throw createDemoOwnershipError(
      'DEMO_STRATEGY_RULE_AUDIT_TARGET_MISMATCH',
      '策略规则操作审计目标与当前事务内业务行不一致。',
      { targetId: input.targetId, batchId: input.batchId, sourceRowNumber: input.sourceRowNumber },
      409
    );
  }
  return insertOperationLogWithDb(db, {
    userId: actorUserId,
    operation: 'energy.strategy.rule.configuration.import',
    targetType: 'strategy_rule',
    targetId: input.targetId,
    detail: {
      batchId: input.batchId,
      sourceRowNumber: input.sourceRowNumber,
      ruleCode: input.ruleCode,
      ruleVersion: input.ruleVersion,
      formulaVersion: input.formulaVersion,
      metricCode: input.metricCode,
      status: input.status
    },
    ip: input.actorIp,
    createdAt: input.createdAt
  });
}

/** 校验见证仍来自当前私有事务 scope、同一实体和未漂移的静态业务投影。 */
function requireDemoOwnershipInsertWitness(record, batchBinding, transactionScope) {
  const scopeState = requireDemoOwnershipTransactionScope(transactionScope);
  const db = scopeState.privateDb;
  const witness = record.rowWitness;
  const state = witness && typeof witness === 'object'
    ? DEMO_INSERTED_ROW_WITNESS_STATE.get(witness)
    : null;
  if (!state || state.transactionScope !== transactionScope
    || !scopeState.witnesses.has(witness)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_WITNESS_REQUIRED',
      '每条 inserted 记录必须提供同一 active transaction scope 内由插入器生成的 row witness。',
      { entityType: record.entityType, entityPk: record.entityPk },
      409
    );
  }
  const expectedWitnessFields = ['changes', 'lastInsertRowid', 'projectedRow', 'sourceBatchId', 'sourceRowNumber'];
  const actualWitnessFields = Object.keys(witness).sort();
  const expectedSortedFields = [...expectedWitnessFields].sort();
  if (actualWitnessFields.length !== expectedSortedFields.length
    || actualWitnessFields.some((key, index) => key !== expectedSortedFields[index])) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_WITNESS_INVALID',
      'row witness 字段不符合服务端固定合同。',
      { expectedFields: expectedSortedFields, actualFields: actualWitnessFields },
      400
    );
  }
  const entityPk = normalizeCanonicalEntityPk(record.entityPk);
  const stateMatches = state.entityType === record.entityType
    && state.entityPk === entityPk
    && state.sourceBatchId === batchBinding.batchId
    && state.sourceRowNumber === record.sourceRowNumber
    && witness.changes === 1
    && witness.lastInsertRowid === Number(entityPk)
    && witness.sourceBatchId === batchBinding.batchId
    && witness.sourceRowNumber === record.sourceRowNumber;
  if (!stateMatches) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_WITNESS_MISMATCH',
      'row witness 与实体、batch role 或 source row 不一致。',
      { entityType: record.entityType, entityPk },
      409
    );
  }
  const handler = getDemoOwnershipEntityHandler(record.entityType);
  const row = handler && handler.readProjection(db, Number(entityPk));
  if (!row) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ENTITY_NOT_FOUND',
      'ownership inserted 实体在当前事务中不存在。',
      { entityType: record.entityType, entityPk },
      409
    );
  }
  const projectedRow = projectDemoOwnershipRow(handler, row, 'rowWitness.projectedRow');
  const canonicalProjectedRowJson = JSON.stringify(normalizeStrictJsonValue(projectedRow, 'rowWitness.projectedRow'));
  if (canonicalProjectedRowJson !== state.projectedRowJson
    || canonicalProjectedRowJson !== JSON.stringify(witness.projectedRow)
    || Number(row.source_batch_id) !== batchBinding.batchId
    || Number(row.source_row_number) !== record.sourceRowNumber) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_ROW_WITNESS_MISMATCH',
      '当前业务行与插入时固定 projection 或 source provenance 不一致。',
      { entityType: record.entityType, entityPk },
      409
    );
  }
  return { row, projectedRow };
}

/** 校验 context 调用方显式提供的运行绑定没有与服务端记录漂移。 */
function assertDemoContextMetadataMatches(context, demoContext) {
  const metadataFields = [
    ['contextId', 'contextId'],
    ['runId', 'runId'],
    ['datasetId', 'datasetId'],
    ['manifestVersion', 'manifestVersion'],
    ['manifestDigest', 'manifestDigest']
  ];
  metadataFields.forEach(([inputField, contextField]) => {
    if (demoContext[inputField] !== undefined && demoContext[inputField] !== context[contextField]) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_CONTEXT_METADATA_MISMATCH',
        '演示 ownership context 元数据与服务端记录不一致。',
        { fieldName: inputField, contextId: context.contextId },
        409
      );
    }
  });
}

/** 规范化并校验 artifact 声明的完整 batch role 集合。 */
function normalizeDemoBatchBindings(artifact, batchBindings) {
  if (!Array.isArray(batchBindings)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_BATCH_BINDINGS_INVALID',
      '演示 ownership 登记必须提供完整批次角色绑定。'
    );
  }
  const declaredRoles = new Map(artifact.batchRoles.map((item) => [item.role, item.entityType]));
  const normalizedBindings = [];
  const seenRoles = new Set();
  batchBindings.forEach((binding) => {
    const batchRole = binding && binding.batchRole;
    const batchId = binding && binding.batchId;
    if (typeof batchRole !== 'string' || batchRole !== batchRole.trim()
      || !declaredRoles.has(batchRole) || seenRoles.has(batchRole)
      || !Number.isSafeInteger(batchId) || batchId < 1) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_BATCH_BINDINGS_INVALID',
        '演示 ownership 批次角色或批次主键无效。',
        { artifactKey: artifact.artifactKey, batchRole: batchRole ?? null, batchId: batchId ?? null }
      );
    }
    const entityType = declaredRoles.get(batchRole);
    if (binding.entityType !== undefined && binding.entityType !== entityType) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_BATCH_ROLE_ENTITY_MISMATCH',
        '演示 ownership 批次角色与实体类型不匹配。',
        { artifactKey: artifact.artifactKey, batchRole, entityType }
      );
    }
    seenRoles.add(batchRole);
    normalizedBindings.push({ batchId, batchRole, entityType });
  });
  if (seenRoles.size !== declaredRoles.size
    || [...declaredRoles.keys()].some((batchRole) => !seenRoles.has(batchRole))) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_BATCH_ROLE_SET_MISMATCH',
      '演示 ownership 批次角色集合与 artifact 静态声明不一致。',
      {
        artifactKey: artifact.artifactKey,
        expectedRoles: [...declaredRoles.keys()].sort(),
        actualRoles: [...seenRoles].sort()
      }
    );
  }
  return normalizedBindings.sort((left, right) => left.batchRole.localeCompare(right.batchRole));
}

/** 在当前事务内插入或核验 run—artifact—context—batch 关系。 */
function ensureDemoBatchLinksInTransaction(db, context, batchBindings) {
  const insertLink = db.prepare(`INSERT OR IGNORE INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, ?)`);
  batchBindings.forEach((binding) => {
    const importBatch = db.prepare('SELECT id, import_type AS importType FROM import_batches WHERE id = ?').get(binding.batchId);
    if (!importBatch) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_IMPORT_BATCH_NOT_FOUND',
        '演示 ownership 绑定的导入批次不存在。',
        { batchId: binding.batchId }
      );
    }
    const entityHandler = getDemoOwnershipEntityHandler(binding.entityType);
    if (!entityHandler || !entityHandler.expectedImportTypes.includes(importBatch.importType)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SOURCE_PROVENANCE_MISMATCH',
        '导入批次类型与静态 ownership 实体类型不一致。',
        { batchId: binding.batchId, entityType: binding.entityType, importType: importBatch.importType },
        409
      );
    }
    const conflictingLinks = db.prepare(`SELECT run_id AS runId, artifact_key AS artifactKey,
        context_id AS contextId, batch_role AS batchRole
      FROM demo_run_import_batches WHERE import_batch_id = ?`).all(binding.batchId)
      .filter((row) => row.runId !== context.runId
        || row.artifactKey !== context.artifactKey
        || row.contextId !== context.contextId
        || row.batchRole !== binding.batchRole);
    if (conflictingLinks.length > 0) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_IMPORT_BATCH_CONFLICT',
        '导入批次已绑定到其他演示 run、artifact、context 或 batch role。',
        { batchId: binding.batchId },
        409
      );
    }
    try {
      insertLink.run(
        context.runId,
        context.artifactKey,
        context.contextId,
        binding.batchId,
        binding.batchRole
      );
    } catch (error) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_IMPORT_BATCH_CONFLICT',
        '演示 ownership 批次关系写入冲突。',
        { batchId: binding.batchId, cause: error.code || null },
        409
      );
    }
  });
  const persistedBindings = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ? ORDER BY batch_role, import_batch_id`).all(context.contextId);
  const expectedKeys = batchBindings.map((binding) => `${binding.batchRole}\0${binding.batchId}`).sort();
  const actualKeys = persistedBindings.map((binding) => `${binding.batchRole}\0${binding.batchId}`).sort();
  if (expectedKeys.length !== actualKeys.length
    || expectedKeys.some((binding, index) => binding !== actualKeys[index])) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_CONTEXT_BATCH_MISMATCH',
      '演示 ownership 批次关系与 context 持久绑定不一致。',
      { contextId: context.contextId },
      409
    );
  }
  return persistedBindings;
}

/** 规范化 inserted 记录，并以同一 transaction scope 的私有 row witness 重读业务表固定 projection。 */
function normalizeInsertedDemoRecords(db, artifact, insertedRecords, batchBindings, transactionScope) {
  if (!Array.isArray(insertedRecords)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERTED_RECORDS_INVALID',
      '存在 demoContext 时 insertedRecords 必须显式提供数组。',
      { actualType: insertedRecords === null ? 'null' : typeof insertedRecords },
      400
    );
  }
  const batchByRole = new Map(batchBindings.map((binding) => [binding.batchRole, binding]));
  const seenEntityKeys = new Set();
  return insertedRecords.map((record, index) => {
    assertExactPlainObjectFields(
      record,
      DEMO_INSERTED_RECORD_FIELDS,
      'DEMO_OWNERSHIP_INSERTED_RECORD_FIELDS_INVALID',
      'inserted 记录只能包含固定 metadata 和 rowWitness。',
      { index }
    );
    const entityType = normalizeCanonicalEntityType(record.entityType);
    const entityPk = normalizeCanonicalEntityPk(record.entityPk);
    if (!artifact.ownershipTargets.includes(entityType)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_ARTIFACT_ENTITY_MISMATCH',
        'inserted 实体类型不属于当前 artifact ownership 白名单。',
        { artifactKey: artifact.artifactKey, entityType }
      );
    }
    const handler = getDemoOwnershipEntityHandler(entityType);
    if (!handler || !handler.expectedImportTypes.length) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_PROJECTION_UNDEFINED',
        'inserted 实体没有可登记的服务端固定 projection。',
        { artifactKey: artifact.artifactKey, entityType },
        400
      );
    }
    const batchRole = record.batchRole;
    const batchBinding = batchByRole.get(batchRole);
    if (!batchBinding || batchBinding.entityType !== entityType) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RECORD_BATCH_ROLE_MISMATCH',
        'inserted 记录的实体类型与 batch role 不匹配。',
        { artifactKey: artifact.artifactKey, entityType, batchRole: batchRole ?? null }
      );
    }
    const sourceRowNumber = record.sourceRowNumber;
    if (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SOURCE_ROW_INVALID',
        'inserted 记录来源行号必须为正整数。',
        { index, sourceRowNumber }
      );
    }
    const witnessed = requireDemoOwnershipInsertWitness({
      ...record,
      entityType,
      entityPk,
      sourceRowNumber
    }, batchBinding, transactionScope);
    const registration = buildDemoEntityRegistrationContract({
      entityType,
      entityPk,
      row: witnessed.projectedRow
    });
    const entityKey = `${registration.entityType}\0${registration.entityPk}`;
    if (seenEntityKeys.has(entityKey)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_INPUT_DUPLICATE',
        '同一次 ownership 登记不得重复声明相同 inserted 实体。',
        { entityType: registration.entityType, entityPk: registration.entityPk }
      );
    }
    seenEntityKeys.add(entityKey);
    return {
      ...registration,
      batchRole,
      sourceBatchId: batchBinding.batchId,
      sourceRowNumber
    };
  });
}

/** 规范化 skipped 记录；该集合只返回明确 no-registration 结果，绝不写 registry。 */
function normalizeSkippedDemoRecords(artifact, skippedRecords, batchBindings, insertedRecords) {
  if (skippedRecords === undefined) return [];
  if (!Array.isArray(skippedRecords)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SKIPPED_RECORDS_INVALID',
      '演示 ownership skippedRecords 必须为数组。'
    );
  }
  const batchByRole = new Map(batchBindings.map((binding) => [binding.batchRole, binding]));
  const insertedEntityKeys = new Set(insertedRecords.map((record) => `${record.entityType}\0${record.entityPk}`));
  return skippedRecords.map((record, index) => {
    assertExactPlainObjectFields(
      record,
      DEMO_SKIPPED_RECORD_FIELDS,
      'DEMO_OWNERSHIP_SKIPPED_RECORD_FIELDS_INVALID',
      'skipped 记录只能包含固定 metadata 字段。',
      { index }
    );
    const entityType = normalizeCanonicalEntityType(record.entityType);
    if (!artifact.ownershipTargets.includes(entityType)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_ARTIFACT_ENTITY_MISMATCH',
        'skipped 实体类型不属于当前 artifact ownership 白名单。',
        { artifactKey: artifact.artifactKey, entityType }
      );
    }
    const batchRole = record.batchRole;
    const batchBinding = batchByRole.get(batchRole);
    if (!batchBinding || batchBinding.entityType !== entityType) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RECORD_BATCH_ROLE_MISMATCH',
        'skipped 记录的实体类型与 batch role 不匹配。',
        { artifactKey: artifact.artifactKey, entityType, batchRole: batchRole ?? null }
      );
    }
    const reason = record.reason;
    if (typeof reason !== 'string' || reason !== reason.trim() || reason.length < 1 || reason.length > 256) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SKIP_REASON_INVALID',
        'skipped 记录必须提供非空稳定原因。',
        { index }
      );
    }
    const entityPk = record.entityPk === null || record.entityPk === undefined
      ? null
      : normalizeCanonicalEntityPk(record.entityPk);
    if (entityPk !== null && insertedEntityKeys.has(`${entityType}\0${entityPk}`)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_INSERTED_SKIPPED_CONFLICT',
        '同一实体不得同时声明为 inserted 和 skipped。',
        { entityType, entityPk }
      );
    }
    const sourceRowNumber = record.sourceRowNumber === null || record.sourceRowNumber === undefined
      ? null
      : record.sourceRowNumber;
    if (sourceRowNumber !== null && (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SOURCE_ROW_INVALID',
        'skipped 记录来源行号必须为正整数或 null。',
        { index, sourceRowNumber }
      );
    }
    return {
      entityType,
      entityPk,
      batchRole,
      sourceBatchId: batchBinding.batchId,
      sourceRowNumber,
      reason,
      registration: 'not_registered'
    };
  });
}

/** 读取活跃 registry 实体及幂等判断需要的全部字段。 */
function readActiveRegistryEntity(db, entityType, entityPk) {
  return db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, registered_by AS registeredBy
    FROM demo_data_registry
    WHERE entity_type = ? AND entity_pk = ? AND cleaned_at IS NULL`).get(entityType, entityPk) || null;
}

/** 判断已有 registry 是否与本次 imported 登记完全一致。 */
function registryEntityMatchesImportedRecord(existing, context, record, actorUserId) {
  return existing.runId === context.runId
    && existing.artifactKey === context.artifactKey
    && existing.ownershipKind === DEMO_IMPORTED_OWNERSHIP_KIND
    && existing.identityDigest === record.identityDigest
    && existing.snapshotDigest === record.snapshotDigest
    && Number(existing.sourceBatchId) === record.sourceBatchId
    && (existing.sourceRowNumber === null ? null : Number(existing.sourceRowNumber)) === record.sourceRowNumber
    && Number(existing.registeredBy) === actorUserId;
}

/** 在当前事务内插入 imported registry；完全相同的同 run 重试返回幂等结果。 */
function registerSingleImportedRecordInTransaction(db, context, record, actorUserId) {
  const existing = readActiveRegistryEntity(db, record.entityType, record.entityPk);
  if (existing) {
    if (existing.runId !== context.runId) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_ENTITY_CROSS_RUN_CONFLICT',
        '业务实体已属于其他未清理演示 run，禁止跨 run 接管。',
        { entityType: record.entityType, entityPk: record.entityPk, existingRunId: existing.runId },
        409
      );
    }
    if (!registryEntityMatchesImportedRecord(existing, context, record, actorUserId)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_DUPLICATE_CONFLICT',
        '业务实体已有不一致的 ownership 登记，禁止覆盖或猜测归属。',
        { entityType: record.entityType, entityPk: record.entityPk, registryId: existing.registryId },
        409
      );
    }
    return { ...existing, identityJson: record.identityJson, snapshotJson: record.snapshotJson, result: 'idempotent' };
  }
  try {
    const result = db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
        identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
      VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)`).run(
      context.runId,
      context.artifactKey,
      record.entityType,
      record.entityPk,
      record.identityDigest,
      record.snapshotDigest,
      record.sourceBatchId,
      record.sourceRowNumber,
      actorUserId
    );
    return {
      registryId: Number(result.lastInsertRowid),
      runId: context.runId,
      artifactKey: context.artifactKey,
      entityType: record.entityType,
      entityPk: record.entityPk,
      ownershipKind: DEMO_IMPORTED_OWNERSHIP_KIND,
      identityJson: record.identityJson,
      identityDigest: record.identityDigest,
      snapshotJson: record.snapshotJson,
      snapshotDigest: record.snapshotDigest,
      sourceBatchId: record.sourceBatchId,
      sourceRowNumber: record.sourceRowNumber,
      registeredBy: actorUserId,
      result: 'registered'
    };
  } catch (error) {
    const conflicting = readActiveRegistryEntity(db, record.entityType, record.entityPk);
    if (conflicting && conflicting.runId !== context.runId) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_ENTITY_CROSS_RUN_CONFLICT',
        '业务实体已属于其他未清理演示 run，禁止跨 run 接管。',
        { entityType: record.entityType, entityPk: record.entityPk, existingRunId: conflicting.runId },
        409
      );
    }
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_REGISTRY_WRITE_FAILED',
      '演示 ownership registry 写入失败。',
      { entityType: record.entityType, entityPk: record.entityPk, cause: error.code || null }
    );
  }
}

/** 规范化 relation 端点，并只允许通过 canonical entity identity 引用 registry。 */
function normalizeDemoRelationEndpoint(endpoint, fieldName) {
  assertExactPlainObjectFields(
    endpoint,
    DEMO_RELATION_ENDPOINT_FIELDS,
    'DEMO_OWNERSHIP_RELATION_ENDPOINT_INVALID',
    '演示 ownership relation 端点只能包含实体类型和主键。',
    { fieldName }
  );
  return {
    entityType: normalizeCanonicalEntityType(endpoint.entityType),
    entityPk: normalizeCanonicalEntityPk(endpoint.entityPk)
  };
}

/** 解析 relation 端点，正式记录、缺失 registry 或跨 run 端点统一 fail-closed。 */
function requireDemoRelationRegistryEndpoint(db, context, endpoint, fieldName) {
  const registry = readActiveRegistryEntity(db, endpoint.entityType, endpoint.entityPk);
  if (!registry) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED',
      'relation 端点不存在同 run 活跃 ownership，禁止把正式记录猜测为演示数据。',
      { fieldName, entityType: endpoint.entityType, entityPk: endpoint.entityPk },
      409
    );
  }
  if (registry.runId !== context.runId) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_RELATION_CROSS_RUN',
      'relation 两端必须属于当前同一演示 run。',
      { fieldName, entityType: endpoint.entityType, entityPk: endpoint.entityPk },
      409
    );
  }
  return registry;
}

/** 在当前事务内插入受控 registry relation；完全相同的关系返回幂等结果。 */
function registerDemoRelationsInTransaction(db, context, relations) {
  if (relations === undefined) return [];
  if (!Array.isArray(relations)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_RELATIONS_INVALID',
      '演示 ownership relations 必须为数组。'
    );
  }
  const seenRelationKeys = new Set();
  return relations.map((relation, index) => {
    assertExactPlainObjectFields(
      relation,
      DEMO_RELATION_FIELDS,
      'DEMO_OWNERSHIP_RELATION_FIELDS_INVALID',
      'ownership relation 只能包含 from、to 和 relationType。',
      { index }
    );
    if (!DEMO_RELATION_TYPES.has(relation.relationType)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RELATION_INVALID',
        '演示 ownership relation 类型或结构无效。',
        { index, relationType: relation.relationType }
      );
    }
    const from = normalizeDemoRelationEndpoint(relation.from, 'from');
    const to = normalizeDemoRelationEndpoint(relation.to, 'to');
    const fromRegistry = requireDemoRelationRegistryEndpoint(db, context, from, 'from');
    const toRegistry = requireDemoRelationRegistryEndpoint(db, context, to, 'to');
    if (fromRegistry.registryId === toRegistry.registryId) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RELATION_SELF_REFERENCE',
        '演示 ownership relation 不得自引用。',
        { registryId: fromRegistry.registryId }
      );
    }
    const relationKey = `${fromRegistry.registryId}\0${toRegistry.registryId}\0${relation.relationType}`;
    if (seenRelationKeys.has(relationKey)) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RELATION_INPUT_DUPLICATE',
        '同一次 ownership 登记不得重复声明相同 relation。',
        { index }
      );
    }
    seenRelationKeys.add(relationKey);
    const existing = db.prepare(`SELECT relation_id AS relationId FROM demo_data_relations
      WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?`).get(
      fromRegistry.registryId,
      toRegistry.registryId,
      relation.relationType
    );
    if (existing) {
      return {
        relationId: Number(existing.relationId),
        runId: context.runId,
        fromRegistryId: fromRegistry.registryId,
        toRegistryId: toRegistry.registryId,
        relationType: relation.relationType,
        result: 'idempotent'
      };
    }
    try {
      const result = db.prepare(`INSERT INTO demo_data_relations
        (run_id, from_registry_id, to_registry_id, relation_type)
        VALUES (?, ?, ?, ?)`).run(
        context.runId,
        fromRegistry.registryId,
        toRegistry.registryId,
        relation.relationType
      );
      return {
        relationId: Number(result.lastInsertRowid),
        runId: context.runId,
        fromRegistryId: fromRegistry.registryId,
        toRegistryId: toRegistry.registryId,
        relationType: relation.relationType,
        result: 'registered'
      };
    } catch (error) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_RELATION_WRITE_FAILED',
        '演示 ownership relation 写入失败。',
        { index, cause: error.code || null }
      );
    }
  });
}

/** 校验抄表派生登记只能绑定当前 executing 动作及其原操作者。 */
function requireMeterDerivedActionRun(db, input) {
  if (!db || db.inTransaction !== true) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED',
      '抄表派生 ownership 必须复用 post-action outer SQLite transaction。',
      null,
      409
    );
  }
  const actionRun = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      action_key AS actionKey, requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(input.actionRunId);
  if (!actionRun || actionRun.runId !== input.runId
    || actionRun.actionKey !== 'meter-readings-to-energy-records'
    || actionRun.status !== 'executing'
    || Number(actionRun.requestedBy) !== input.actorUserId) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_ACTION_BINDING_INVALID',
      '抄表派生 ownership 与当前 executing 后置动作不一致。',
      null,
      409
    );
  }
  return actionRun;
}

/** 校验正式 meter service 返回的单个生成对及其稳定字段。 */
function normalizeDerivedMeterGenerationPair(pair, index) {
  assertExactPlainObjectFields(
    pair,
    DEMO_DERIVED_METER_GENERATION_FIELDS,
    'DEMO_DERIVED_OWNERSHIP_PAIR_FIELDS_INVALID',
    '抄表派生生成对只能包含正式 meter service 固定字段。',
    { index }
  );
  assertDemoProjectionInteger(pair.readingId, 'generatedPair.readingId', { min: 1 });
  assertDemoProjectionInteger(pair.energyRecordId, 'generatedPair.energyRecordId', { min: 1 });
  assertDemoProjectionMonth(pair.normalizedMonth, 'generatedPair.normalizedMonth');
  assertDemoProjectionString(pair.normalizedUnit, 'generatedPair.normalizedUnit', { nonEmpty: true });
  assertDemoProjectionFiniteNumber(pair.normalizedValue, 'generatedPair.normalizedValue', { min: 0 });
  assertDemoProjectionString(pair.duplicateKey, 'generatedPair.duplicateKey', { nonEmpty: true });
  assertDemoProjectionUtcMilliseconds(pair.previousUpdatedAt, 'generatedPair.previousUpdatedAt');
  assertDemoProjectionUtcMilliseconds(pair.updatedAt, 'generatedPair.updatedAt');
  return pair;
}

/**
 * 在 post-action outer transaction 中登记实际生成的 energy_record，更新来源 reading snapshot，
 * 并建立 output -> reading 的 generated_from 关系；derived cleanup 能力仍保持未连接。
 */
function registerDerivedMeterEnergyRecordsInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'runId', 'actionRunId', 'actorUserId', 'generatedPairs'],
    'DEMO_DERIVED_OWNERSHIP_INPUT_INVALID',
    '抄表派生 ownership 只能接收固定服务端输入。'
  );
  const db = input.db;
  if (typeof input.runId !== 'string' || input.runId.trim() !== input.runId || input.runId.length === 0
    || typeof input.actionRunId !== 'string' || input.actionRunId.trim() !== input.actionRunId
    || input.actionRunId.length === 0 || !Array.isArray(input.generatedPairs)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_INPUT_INVALID',
      '抄表派生 ownership 运行标识或生成对无效。',
      null,
      400
    );
  }
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: input.actorUserId });
  requireMeterDerivedActionRun(db, { ...input, actorUserId });
  const run = requireDemoDatasetRun(db, input.runId);
  const seenReadingIds = new Set();
  const seenEnergyRecordIds = new Set();
  const registrations = [];
  const relationIntents = [];

  input.generatedPairs.forEach((rawPair, index) => {
    const pair = normalizeDerivedMeterGenerationPair(rawPair, index);
    if (seenReadingIds.has(pair.readingId) || seenEnergyRecordIds.has(pair.energyRecordId)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_PAIR_DUPLICATE',
        '抄表派生生成对包含重复来源或输出实体。',
        { index },
        409
      );
    }
    seenReadingIds.add(pair.readingId);
    seenEnergyRecordIds.add(pair.energyRecordId);

    const readingPk = String(pair.readingId);
    const readingRegistry = readActiveRegistryEntity(db, 'meter_reading', readingPk);
    if (!readingRegistry || readingRegistry.runId !== run.runId
      || readingRegistry.artifactKey !== '08-meter-readings-2026-08'
      || readingRegistry.ownershipKind !== DEMO_IMPORTED_OWNERSHIP_KIND
      || !Number.isSafeInteger(Number(readingRegistry.sourceBatchId))
      || Number(readingRegistry.sourceBatchId) < 1
      || readingRegistry.sourceRowNumber !== null
      || readingRegistry.identityDigest !== calculateDemoEntityIdentityDigest('meter_reading', readingPk)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_SOURCE_INVALID',
        '生成来源不是当前 run artifact 08 的 imported meter_reading ownership。',
        { index },
        409
      );
    }
    const readingRow = DEMO_OWNERSHIP_ENTITY_HANDLERS.meter_reading.readProjection(db, pair.readingId);
    if (!readingRow || Number(readingRow.source_batch_id) !== Number(readingRegistry.sourceBatchId)
      || Number(readingRow.generated_energy_record_id) !== pair.energyRecordId
      || readingRow.updated_at !== pair.updatedAt) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_SOURCE_BACK_REFERENCE_INVALID',
        '抄表来源当前投影与正式生成回写结果不一致。',
        { index },
        409
      );
    }
    const previousReadingRow = {
      ...readingRow,
      generated_energy_record_id: null,
      updated_at: pair.previousUpdatedAt
    };
    const previousSnapshotDigest = calculateDemoEntitySnapshotDigest('meter_reading', readingPk, previousReadingRow);
    if (previousSnapshotDigest !== readingRegistry.snapshotDigest) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_SOURCE_STALE',
        '抄表来源在正式生成前已发生变化。',
        { index },
        409
      );
    }

    const energyPk = String(pair.energyRecordId);
    if (readActiveRegistryEntity(db, 'energy_record', energyPk)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_OUTPUT_CONFLICT',
        '当前动作生成的能耗记录已有活跃 ownership。',
        { index },
        409
      );
    }
    const energyRow = DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_record.readProjection(db, pair.energyRecordId);
    if (!energyRow || energyRow.source_batch_id !== null || energyRow.source_row_number !== null
      || Number(energyRow.energy_type_id) !== Number(readingRow.energy_type_id)
      || Number(energyRow.organization_unit_id) !== Number(readingRow.organization_unit_id)
      || Number(energyRow.meter_device_id) !== Number(readingRow.meter_device_id)
      || energyRow.original_month !== readingRow.reading_date
      || energyRow.normalized_month !== pair.normalizedMonth
      || energyRow.original_unit !== readingRow.original_unit
      || Number(energyRow.original_value) !== Number(readingRow.usage_value)
      || energyRow.normalized_unit !== pair.normalizedUnit
      || Number(energyRow.normalized_value) !== Number(pair.normalizedValue)
      || energyRow.duplicate_key !== pair.duplicateKey
      || energyRow.record_status !== 'active'
      || typeof energyRow.remark !== 'string'
      || !energyRow.remark.includes(`meter_reading_record_id=${pair.readingId}`)
      || !energyRow.remark.includes(`action_run_id=${input.actionRunId}`)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_OUTPUT_INVALID',
        '当前动作输出 energy_record 与来源抄表固定投影不一致。',
        { index },
        409
      );
    }
    const energyContract = buildDemoEntityRegistrationContract({
      entityType: 'energy_record',
      entityPk: energyPk,
      row: energyRow
    });
    let insertResult;
    try {
      insertResult = db.prepare(`INSERT INTO demo_data_registry
        (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
         identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
        VALUES (?, '08-meter-readings-2026-08', 'energy_record', ?, 'derived', ?, ?, ?, ?, ?)`).run(
        run.runId,
        energyPk,
        energyContract.identityDigest,
        energyContract.snapshotDigest,
        Number(readingRegistry.sourceBatchId),
        null,
        actorUserId
      );
    } catch (error) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_REGISTRY_WRITE_FAILED',
        '抄表派生 energy_record ownership 写入失败。',
        { index, cause: error.code || null },
        409
      );
    }
    const currentReadingSnapshotDigest = calculateDemoEntitySnapshotDigest('meter_reading', readingPk, readingRow);
    const sourceUpdate = db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
      WHERE registry_id = ? AND run_id = ? AND snapshot_digest = ? AND cleaned_at IS NULL`).run(
      currentReadingSnapshotDigest,
      readingRegistry.registryId,
      run.runId,
      readingRegistry.snapshotDigest
    );
    if (sourceUpdate.changes !== 1) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_OWNERSHIP_SOURCE_SNAPSHOT_UPDATE_FAILED',
        '抄表来源 ownership 快照更新失败。',
        { index },
        409
      );
    }
    registrations.push({
      registryId: Number(insertResult.lastInsertRowid),
      entityType: 'energy_record',
      entityPk: energyPk,
      sourceRegistryId: Number(readingRegistry.registryId)
    });
    relationIntents.push({
      from: { entityType: 'energy_record', entityPk: energyPk },
      to: { entityType: 'meter_reading', entityPk: readingPk },
      relationType: 'generated_from'
    });
  });

  const relations = registerDemoRelationsInTransaction(db, { runId: run.runId }, relationIntents);
  return {
    registrationCount: registrations.length,
    relationCount: relations.length,
    registrations,
    relations
  };
}

/** 为 strategy registration scope 生成随机私有 SAVEPOINT 名称。 */
function createStrategyRegistrationSavepointName(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 规范 strategy evaluator 与 registration scope 共用的完整领域绑定。 */
function normalizeStrategyRegistrationDomainBinding(domainBinding) {
  assertExactPlainObjectFields(
    domainBinding,
    DEMO_STRATEGY_DOMAIN_BINDING_FIELDS,
    'DEMO_DERIVED_STRATEGY_DOMAIN_BINDING_INVALID',
    '策略评价 registration scope 领域绑定只能包含固定字段。'
  );
  const meterDeviceId = normalizeIntegerEntityPk(domainBinding.meterDeviceId);
  if (!meterDeviceId
    || typeof domainBinding.energyTypeCode !== 'string'
    || domainBinding.energyTypeCode.trim() !== domainBinding.energyTypeCode
    || domainBinding.energyTypeCode.length === 0
    || typeof domainBinding.unit !== 'string'
    || domainBinding.unit.trim() !== domainBinding.unit
    || domainBinding.unit.length === 0
    || typeof domainBinding.startUtc !== 'string'
    || !DEMO_UTC_MILLISECOND_PATTERN.test(domainBinding.startUtc)
    || typeof domainBinding.endUtc !== 'string'
    || !DEMO_UTC_MILLISECOND_PATTERN.test(domainBinding.endUtc)
    || Date.parse(domainBinding.startUtc) >= Date.parse(domainBinding.endUtc)
    || typeof domainBinding.sourceTimeZone !== 'string'
    || domainBinding.sourceTimeZone.trim() !== domainBinding.sourceTimeZone
    || !isIanaTimeZone(domainBinding.sourceTimeZone)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_DOMAIN_BINDING_INVALID',
      '策略评价 registration scope 领域绑定值无效。',
      null,
      400
    );
  }
  return Object.freeze({
    meterDeviceId,
    energyTypeCode: domainBinding.energyTypeCode,
    unit: domainBinding.unit,
    startUtc: domainBinding.startUtc,
    endUtc: domainBinding.endUtc,
    sourceTimeZone: domainBinding.sourceTimeZone
  });
}

/** 校验 strategy registration scope 是当前连接上的原始一次性 capability。 */
function requireStrategyRegistrationScopeState(db, registrationScope, allowedStatuses) {
  const state = registrationScope && typeof registrationScope === 'object'
    ? DEMO_STRATEGY_REGISTRATION_SCOPE_STATE.get(registrationScope)
    : null;
  if (!state) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_REQUIRED',
      '策略评价 derived ownership 必须使用原始 opaque registration scope。',
      null,
      409
    );
  }
  if (state.db !== db) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_DATABASE_MISMATCH',
      '策略评价 registration scope 与 SQLite 连接不一致。',
      null,
      409
    );
  }
  if (db.inTransaction !== true) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED',
      '策略评价 registration scope 必须保留原 caller transaction。',
      null,
      409
    );
  }
  if (!allowedStatuses.includes(state.status)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_REPLAY',
      '策略评价 registration scope 已消费、失败或状态无效。',
      { status: state.status },
      409
    );
  }
  return state;
}

/** 回滚并释放 registration guard；任一恢复失败均阻断外层提交。 */
function rollbackAndReleaseStrategyRegistrationGuard(state, originalError = null) {
  let rollbackError = null;
  let releaseError = null;
  try {
    state.db.exec(`ROLLBACK TO SAVEPOINT ${state.guardName}`);
  } catch (error) {
    rollbackError = error;
  }
  try {
    state.db.exec(`RELEASE SAVEPOINT ${state.guardName}`);
  } catch (error) {
    releaseError = error;
  }
  state.guardName = null;
  if (rollbackError || releaseError) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_RECOVERY_FAILED',
      '策略评价 registration scope guard 恢复失败，禁止继续提交外层事务。',
      {
        originalCode: originalError?.code || originalError?.details?.code || null,
        rollbackCode: rollbackError?.code || null,
        releaseCode: releaseError?.code || null
      },
      500
    );
  }
}

/** 按 scope 当前状态执行 fail-closed abort，不接管外层事务生命周期。 */
/** 在 evaluator 私有 SAVEPOINT 建立后创建事务 liveness marker。 */
function prepareStrategyRegistrationScopeLiveness(registrationScope, state) {
  if (state.status !== 'active' || state.livenessName) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_STATE_INVALID',
      '策略评价 registration scope 不能重复建立事务 marker。',
      null,
      409
    );
  }
  state.livenessName = createStrategyRegistrationSavepointName('demo_strategy_registration_live');
  try {
    state.db.exec(`SAVEPOINT ${state.livenessName}`);
  } catch (error) {
    state.livenessName = null;
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_LIVENESS_FAILED',
      '策略评价 registration scope 事务 marker 创建失败。',
      { cause: error.code || null },
      409
    );
  }
}

/** 激活回调返回后释放预写 marker；失败意味着 callback 已结束或替换 caller transaction。 */
function confirmStrategyRegistrationScopeActivation(registrationScope, state) {
  if (state.status !== 'active' || !state.livenessName) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
      '策略评价 registration scope 预写事务 marker 不存在。',
      null,
      409
    );
  }
  const livenessName = state.livenessName;
  try {
    state.db.exec(`RELEASE SAVEPOINT ${livenessName}`);
    state.livenessName = null;
  } catch (error) {
    state.livenessName = null;
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
      '策略评价 registration scope caller transaction 已在首次 evaluator 写入前结束或被替换。',
      { cause: error.code || null },
      409
    );
  }
}

/** 旋转事务 marker；释放失败意味着 caller transaction 已结束或被替换。 */
function rotateStrategyRegistrationScopeLiveness(registrationScope, state) {
  if (state.status !== 'active' || !state.livenessName) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
      '策略评价 registration scope 事务 marker 不存在。',
      null,
      409
    );
  }
  const previousName = state.livenessName;
  try {
    state.db.exec(`RELEASE SAVEPOINT ${previousName}`);
    state.livenessName = createStrategyRegistrationSavepointName('demo_strategy_registration_live');
    state.db.exec(`SAVEPOINT ${state.livenessName}`);
  } catch (error) {
    state.livenessName = null;
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
      '策略评价 registration scope caller transaction 已结束或被替换。',
      { cause: error.code || null },
      409
    );
  }
}

/** 在成功/失败时清理 marker 由 evaluator 外层 SAVEPOINT 统一管理。 */
function abortStrategyRegistrationScopeState(registrationScope, state) {
  if (state.status === 'issued' && state.guardName) {
    rollbackAndReleaseStrategyRegistrationGuard(state);
  }
  if (state.status !== 'consumed') state.status = 'failed';
  markEnergyStrategyRegistrationScopeFailed(registrationScope);
}

/**
 * 在 caller transaction 内签发一次性 strategy ownership registration scope。
 */
function issueStrategyEvaluationRegistrationScopeInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'runId', 'actionRunId', 'actorUserId', 'exactScope', 'domainBinding'],
    'DEMO_DERIVED_STRATEGY_SCOPE_INPUT_INVALID',
    '策略评价 registration scope issue 只能接收固定 capability 绑定字段。'
  );
  const db = input.db;
  if (!db || db.inTransaction !== true) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED',
      '策略评价 registration scope issue 必须复用 caller transaction。',
      null,
      409
    );
  }
  assertEnergyStrategyExactScopeCapability(input.exactScope, db);
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: input.actorUserId });
  const runId = typeof input.runId === 'string'
    && input.runId.trim() === input.runId && input.runId.length > 0
    ? input.runId
    : null;
  const actionRunId = typeof input.actionRunId === 'string'
    && input.actionRunId.trim() === input.actionRunId && input.actionRunId.length > 0
    ? input.actionRunId
    : null;
  if (!runId || !actionRunId) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_INPUT_INVALID',
      '策略评价 registration scope 运行标识无效。',
      null,
      400
    );
  }
  const domainBinding = normalizeStrategyRegistrationDomainBinding(input.domainBinding);
  const run = requireDemoDatasetRun(db, runId);
  requireStrategyDerivedActionRun(db, { actionRunId, actorUserId }, run);
  const guardName = createStrategyRegistrationSavepointName('demo_strategy_registration_issue');
  db.exec(`SAVEPOINT ${guardName}`);
  const registrationScope = Object.freeze({});
  const state = {
    db,
    runId: run.runId,
    actionRunId,
    actorUserId,
    datasetId: run.datasetId,
    exactScope: input.exactScope,
    domainBinding,
    domainBindingDigest: sha256Stable(domainBinding),
    guardName,
    status: 'issued'
  };
  DEMO_STRATEGY_REGISTRATION_SCOPE_STATE.set(registrationScope, state);
  try {
    bindEnergyStrategyRegistrationScopeCapability({
      db,
      registrationScope,
      exactScope: input.exactScope,
      domainBinding,
      confirmActive: () => confirmStrategyRegistrationScopeActivation(registrationScope, state),
      prepareRegistrar: () => prepareStrategyRegistrationScopeLiveness(registrationScope, state),
      abort: () => abortStrategyRegistrationScopeState(registrationScope, state)
    });
  } catch (error) {
    state.status = 'failed';
    rollbackAndReleaseStrategyRegistrationGuard(state, error);
    throw error;
  }
  return registrationScope;
}

/** 在 evaluator 首次业务写入前释放 issue guard 并激活原始 scope。 */
function activateStrategyEvaluationRegistrationScopeInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'registrationScope'],
    'DEMO_DERIVED_STRATEGY_SCOPE_ACTIVATE_INPUT_INVALID',
    '策略评价 registration scope activate 只能接收 db 和原始 scope。'
  );
  const state = requireStrategyRegistrationScopeState(
    input.db,
    input.registrationScope,
    ['issued']
  );
  const run = requireDemoDatasetRun(input.db, state.runId);
  requireDemoOwnershipActor(input.db, { actorUserId: state.actorUserId });
  requireStrategyDerivedActionRun(input.db, state, run);
  try {
    input.db.exec(`RELEASE SAVEPOINT ${state.guardName}`);
    state.guardName = null;
    markEnergyStrategyRegistrationScopeActive(input.registrationScope);
    state.status = 'active';
    // 预写 marker 在 beforeEvaluationWrite 返回后立即验证，阻止 callback 内替换 caller transaction。
    prepareStrategyRegistrationScopeLiveness(input.registrationScope, state);
    return input.registrationScope;
  } catch (error) {
    state.status = 'failed';
    markEnergyStrategyRegistrationScopeFailed(input.registrationScope);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_ACTIVATION_FAILED',
      '策略评价 registration scope guard 已失效或事务已被替换。',
      { cause: error.code || error.details?.code || null },
      409
    );
  }
}

/** 主动终止一次 registration scope；issued guard 只回滚到自身且不结束外层事务。 */
function abortStrategyEvaluationRegistrationScopeInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'registrationScope'],
    'DEMO_DERIVED_STRATEGY_SCOPE_ABORT_INPUT_INVALID',
    '策略评价 registration scope abort 只能接收 db 和原始 scope。'
  );
  const state = requireStrategyRegistrationScopeState(
    input.db,
    input.registrationScope,
    ['issued', 'active']
  );
  abortStrategyRegistrationScopeState(input.registrationScope, state);
  return input.registrationScope;
}

/** 校验 strategy evaluation derived registrar 只能绑定当前 executing 后置动作。 */
function requireStrategyDerivedActionRun(db, input, run) {
  const actionRun = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      dataset_id AS datasetId, action_key AS actionKey, requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(input.actionRunId);
  if (!actionRun || actionRun.runId !== run.runId || actionRun.datasetId !== run.datasetId
    || actionRun.actionKey !== 'strategy-evaluation-run' || actionRun.status !== 'executing'
    || Number(actionRun.requestedBy) !== input.actorUserId) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_ACTION_BINDING_INVALID',
      '策略评价 derived ownership 与当前 executing 后置动作不一致。',
      null,
      409
    );
  }
  return actionRun;
}

/** 规范化 strategy derived registrar 使用的固定实体 ID 集合。 */
function normalizeStrategyDerivedEntityIds(value, fieldName) {
  if (!Array.isArray(value)) {
    throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_IDS_INVALID', `${fieldName} 必须为数组。`, { fieldName }, 400);
  }
  const values = value.map((item, index) => {
    const entityPk = normalizeCanonicalEntityPk(item);
    if (entityPk === null) {
      throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_IDS_INVALID', `${fieldName} 含无效正整数 ID。`, { fieldName, index }, 400);
    }
    return Number(entityPk);
  });
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_IDS_DUPLICATE', `${fieldName} 不得包含重复 ID。`, { fieldName }, 409);
  }
  return [...unique].sort((left, right) => left - right);
}

/** 校验 strategy derived 来源 registry 属于当前 run 的固定 imported artifact。 */
function requireStrategyImportedSource(db, run, entityType, entityPk, artifactKey, expectedSource = null) {
  const canonicalPk = String(entityPk);
  const registry = readActiveRegistryEntity(db, entityType, canonicalPk);
  if (!registry || registry.runId !== run.runId || registry.artifactKey !== artifactKey
    || registry.ownershipKind !== DEMO_IMPORTED_OWNERSHIP_KIND
    || !Number.isSafeInteger(Number(registry.sourceBatchId)) || Number(registry.sourceBatchId) < 1
    || !Number.isSafeInteger(Number(registry.sourceRowNumber)) || Number(registry.sourceRowNumber) < 1
    || registry.identityDigest !== calculateDemoEntityIdentityDigest(entityType, canonicalPk)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
      '策略评价来源不是当前 run 固定 artifact 的 imported ownership。',
      { entityType, entityPk: canonicalPk, artifactKey },
      409
    );
  }
  const expectedImportType = entityType === 'energy_timeseries'
    ? 'energy_timeseries'
    : entityType === 'strategy_rule'
      ? 'strategy_rule'
      : null;
  const sourceBatch = expectedImportType
    ? db.prepare('SELECT import_type AS importType FROM import_batches WHERE id = ?')
      .get(Number(registry.sourceBatchId))
    : null;
  if (!sourceBatch || sourceBatch.importType !== expectedImportType) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_IMPORT_TYPE_INVALID',
      '策略评价 imported ownership 来源批次类型不匹配。',
      { entityType, entityPk: canonicalPk, sourceBatchId: Number(registry.sourceBatchId) },
      409
    );
  }
  const handler = getDemoOwnershipEntityHandler(entityType);
  const row = handler ? handler.readProjection(db, Number(entityPk)) : null;
  if (!row || Number(row.id) !== Number(entityPk)
    || Number(row.source_batch_id) !== Number(registry.sourceBatchId)
    || Number(row.source_row_number) !== Number(registry.sourceRowNumber)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_PROVENANCE_INVALID',
      '策略评价来源业务行与 imported ownership 来源 provenance 不一致。',
      { entityType, entityPk: canonicalPk },
      409
    );
  }
  const currentSnapshotDigest = calculateDemoEntitySnapshotDigest(entityType, canonicalPk, row);
  if (expectedSource && (Number(registry.sourceBatchId) !== expectedSource.sourceBatchId
    || registry.identityDigest !== expectedSource.identityDigest
    || registry.snapshotDigest !== expectedSource.snapshotDigest)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_EXACT_METADATA_MISMATCH',
      '策略评价 imported ownership 与 completion witness exact metadata 不一致。',
      { entityType, entityPk: canonicalPk },
      409
    );
  }
  if (currentSnapshotDigest !== registry.snapshotDigest) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_STALE',
      '策略评价来源 snapshot digest 已发生漂移。',
      { entityType, entityPk: canonicalPk },
      409
    );
  }
  return { registry, row };
}

/** 校验已有 derived registry 与本次固定 run/hit snapshot 完全一致，并支持稳定重试。 */
function registerSingleDerivedStrategyEntityInTransaction(db, run, actorUserId, registration) {
  const existing = readActiveRegistryEntity(db, registration.entityType, registration.entityPk);
  if (existing) {
    const matches = existing.runId === run.runId
      && existing.artifactKey === '18-strategy-rules'
      && existing.ownershipKind === 'derived'
      && existing.identityDigest === registration.identityDigest
      && existing.snapshotDigest === registration.snapshotDigest
      && existing.sourceBatchId === null
      && existing.sourceRowNumber === null
      && Number(existing.registeredBy) === actorUserId;
    if (!matches) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_REGISTRY_CONFLICT',
        '策略评价 derived ownership 已存在但与本次固定 snapshot 不一致。',
        { entityType: registration.entityType, entityPk: registration.entityPk },
        409
      );
    }
    return { ...existing, ...registration, result: 'idempotent' };
  }
  try {
    const result = db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
       identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
      VALUES (?, '18-strategy-rules', ?, ?, 'derived', ?, ?, NULL, NULL, ?)`).run(
      run.runId,
      registration.entityType,
      registration.entityPk,
      registration.identityDigest,
      registration.snapshotDigest,
      actorUserId
    );
    return {
      registryId: Number(result.lastInsertRowid),
      runId: run.runId,
      artifactKey: '18-strategy-rules',
      entityType: registration.entityType,
      entityPk: registration.entityPk,
      ownershipKind: 'derived',
      identityDigest: registration.identityDigest,
      snapshotDigest: registration.snapshotDigest,
      sourceBatchId: null,
      sourceRowNumber: null,
      registeredBy: actorUserId,
      result: 'registered'
    };
  } catch (error) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRY_WRITE_FAILED',
      '策略评价 derived ownership 写入失败。',
      { entityType: registration.entityType, entityPk: registration.entityPk, cause: error.code || null },
      409
    );
  }
}

/** 将命中 evidence 中的时序明细逐项绑定到调用方提供的完整源 ID 闭包。 */
function assertStrategyDerivedTimeseriesEvidenceBindings(hitRows, sourceTimeseriesIds) {
  const sourceIdSet = new Set(sourceTimeseriesIds);
  hitRows.forEach((row) => {
    const evidenceSnapshot = parseStrictDemoProjectionJsonObject(row.evidence_json, 'snapshot.evidence_json');
    const evidence = evidenceSnapshot.evidence;
    const evidencePolicy = evidenceSnapshot.evidencePolicy;
    const detailEvidence = evidence.slice(evidencePolicy.requiredEvidenceCount);
    if (evidencePolicy.availableDetailEvidenceCount > sourceTimeseriesIds.length
      || detailEvidence.some((item) => {
        const match = /^timeseries:([1-9]\d*)$/.exec(item);
        return !match || !sourceIdSet.has(Number(match[1]));
      })) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
        '策略命中详细时序 evidence 必须逐项属于调用方提供的完整 sourceTimeseriesIds 闭包。',
        { hitId: Number(row.id) },
        409
      );
    }
  });
}

/** 将命中快照与已证明的规则、运行范围和完整时序源 metadata 绑定。 */
function assertStrategyDerivedHitMetadataBindings(hitRows, evaluationRun, ruleSources, timeseriesSources) {
  const ruleById = new Map(ruleSources.map((source) => [Number(source.row.id), source.row]));
  const runScope = parseStrictDemoProjectionJsonObject(evaluationRun.scope_reference, 'snapshot.scope_reference');
  const sourceGranularities = [...new Set(timeseriesSources.map((source) => Number(source.row.granularity_minutes)))];
  const sourceUnits = [...new Set(timeseriesSources.map((source) => source.row.normalized_unit))];
  const peakMetricUnit = sourceGranularities.length === 1
    && [15, 30, 60].includes(sourceGranularities[0])
    && sourceUnits.length === 1
    && sourceUnits[0] === runScope.unit
    ? `${runScope.unit}/${sourceGranularities[0]}min`
    : null;
  hitRows.forEach((row) => {
    const rule = ruleById.get(Number(row.strategy_rule_id));
    const evidenceSnapshot = parseStrictDemoProjectionJsonObject(row.evidence_json, 'snapshot.evidence_json');
    const metricCode = evidenceSnapshot.evidence[3].slice('metric:'.length);
    const expectedScopeEvidence = `scope:energy-type=${runScope.energyTypeCode};unit=${runScope.unit};source-timezone=${runScope.sourceTimeZone}`;
    if (evidenceSnapshot.evidence[1] !== `meter:${runScope.meterDeviceId}`
      || evidenceSnapshot.evidence[2] !== expectedScopeEvidence
      || row.data_start_utc !== evaluationRun.start_utc
      || row.data_end_utc !== evaluationRun.end_utc
      || row.source_timezone !== evaluationRun.source_timezone) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
        '策略命中窗口和 mandatory scope 必须与已证明的评价运行 metadata 一致。',
        { hitId: Number(row.id), evaluationRunId: Number(evaluationRun.id) },
        409
      );
    }
    if (!rule) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
        '策略命中缺少已证明的策略规则 metadata。',
        { hitId: Number(row.id), strategyRuleId: Number(row.strategy_rule_id) },
        409
      );
    }
    const threshold = parseStrictDemoProjectionJsonObject(
      row.threshold_snapshot_json,
      'snapshot.threshold_snapshot_json'
    );
    const expectedThreshold = rule.threshold_operator === 'between'
      ? {
        operator: rule.threshold_operator,
        min: Number(rule.threshold_min),
        max: Number(rule.threshold_max),
        unit: rule.threshold_unit
      }
      : {
        operator: rule.threshold_operator,
        value: Number(rule.threshold_value),
        unit: rule.threshold_unit
      };
    if (rule.reduction_rate !== null) {
      expectedThreshold.reductionRate = Number(rule.reduction_rate);
    }
    if (metricCode !== rule.metric_code
      || sha256Stable(threshold) !== sha256Stable(expectedThreshold)
      || row.priority !== rule.priority
      || evidenceSnapshot.recommendation !== rule.recommendation_text
      || evidenceSnapshot.source !== rule.source
      || evidenceSnapshot.effectiveRange.startUtc !== rule.effective_start_utc
      || evidenceSnapshot.effectiveRange.endUtc !== rule.effective_end_utc
      || evidenceSnapshot.effectiveRange.sourceTimeZone !== rule.source_timezone) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
        '策略命中指标、阈值、优先级、文案和有效期必须与已证明的策略规则 metadata 一致。',
        { hitId: Number(row.id), strategyRuleId: Number(row.strategy_rule_id) },
        409
      );
    }
    const parsedRequirements = parseEvidenceRequirements(rule.evidence_requirements_json);
    const actualRequirementErrors = evidenceSnapshot.configurationErrors.filter((code) => (
      DEMO_STRATEGY_EVIDENCE_REQUIREMENT_ERRORS.includes(code)
    ));
    const expectedRequirements = parsedRequirements.valid ? parsedRequirements.requirements : null;
    if (evidenceSnapshot.evidencePolicy.detailEvidenceLimit !== parsedRequirements.maxEvidenceItems
      || sha256Stable(evidenceSnapshot.evidenceRequirements) !== sha256Stable(expectedRequirements)
      || sha256Stable(actualRequirementErrors) !== sha256Stable(parsedRequirements.errors)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
        '策略命中 evidence requirements 必须与已证明的规则配置及正式默认上限一致。',
        { hitId: Number(row.id), strategyRuleId: Number(row.strategy_rule_id) },
        409
      );
    }
    if (metricCode === 'peak_interval_energy'
      && evidenceSnapshot.evidencePolicy.requiredEvidenceCount === 7) {
      const threshold = parseStrictDemoProjectionJsonObject(
        row.threshold_snapshot_json,
        'snapshot.threshold_snapshot_json'
      );
      const hasUnitUnavailable = evidenceSnapshot.configurationErrors.includes(
        'STRATEGY_METRIC_UNIT_UNAVAILABLE'
      );
      const hasUnitMismatch = evidenceSnapshot.configurationErrors.includes(
        'STRATEGY_THRESHOLD_UNIT_MISMATCH'
      );
      if (hasUnitUnavailable !== (peakMetricUnit === null)
        || hasUnitMismatch !== (peakMetricUnit !== null && threshold.unit !== peakMetricUnit)) {
        throw createDemoOwnershipError(
          'DEMO_DERIVED_STRATEGY_SOURCE_INVALID',
          '缺少 peak interval evidence 时阈值单位必须与完整时序源 metadata 的正式降级语义一致。',
          { hitId: Number(row.id) },
          409
        );
      }
    }
  });
}

/** 确认 strategy derived 实体涉及的持久 relation 只包含固定最小集合。 */
function assertStrategyDerivedRelationsExact(db, relationIntents, registrations) {
  const registrationByKey = new Map(registrations.map((item) => [`${item.entityType}\\0${item.entityPk}`, item]));
  const expected = new Set();
  relationIntents.forEach((relation) => {
    const from = registrationByKey.get(`${relation.from.entityType}\\0${relation.from.entityPk}`)
      || readActiveRegistryEntity(db, relation.from.entityType, String(relation.from.entityPk));
    const to = registrationByKey.get(`${relation.to.entityType}\\0${relation.to.entityPk}`)
      || readActiveRegistryEntity(db, relation.to.entityType, String(relation.to.entityPk));
    if (from && to) expected.add(`${from.registryId}\\0${to.registryId}\\0${relation.relationType}`);
  });
  const derivedRegistryIds = registrations.map((item) => Number(item.registryId));
  if (derivedRegistryIds.length === 0) return;
  const placeholders = derivedRegistryIds.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT relation_id AS relationId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType FROM demo_data_relations
    WHERE from_registry_id IN (${placeholders}) OR to_registry_id IN (${placeholders})`)
    .all(...derivedRegistryIds, ...derivedRegistryIds);
  rows.forEach((row) => {
    const key = `${row.fromRegistryId}\\0${row.toRegistryId}\\0${row.relationType}`;
    if (!expected.has(key)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RELATIONS_MISMATCH',
        '策略评价 derived relation 集合包含未声明的持久关系。',
        { relationId: row.relationId || null },
        409
      );
    }
  });
}

/** 校验 witness ID 集合与持久事实双向完全相等且无重复。 */
function assertStrategyWitnessIdSet(actualIds, witnessIds, code, message, evaluationRunId) {
  const normalizedWitnessIds = normalizeStrategyDerivedEntityIds(witnessIds, 'evaluationWitnessIds');
  const normalizedActualIds = normalizeStrategyDerivedEntityIds(actualIds, 'persistedIds');
  if (normalizedActualIds.length !== normalizedWitnessIds.length
    || normalizedActualIds.some((id, index) => id !== normalizedWitnessIds[index])) {
    throw createDemoOwnershipError(code, message, { evaluationRunId }, 409);
  }
  return normalizedWitnessIds;
}

/** 将 exact scope 中的逐实体 expected digest 映射为 registrar 私有来源约束。 */
function buildStrategyExpectedSourceMap(snapshots, sourceBatchId, entityType) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_EXACT_METADATA_MISMATCH',
      '策略评价 exact scope 缺少完整来源 snapshot metadata。',
      { entityType },
      409
    );
  }
  const expectedById = new Map();
  snapshots.forEach((snapshot) => {
    const entityPk = normalizeIntegerEntityPk(snapshot?.id);
    if (!entityPk || expectedById.has(entityPk)
      || typeof snapshot.identityDigest !== 'string'
      || typeof snapshot.snapshotDigest !== 'string') {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_EXACT_METADATA_MISMATCH',
        '策略评价 exact scope 来源 snapshot metadata 无效或重复。',
        { entityType },
        409
      );
    }
    expectedById.set(entityPk, {
      sourceBatchId,
      identityDigest: snapshot.identityDigest,
      snapshotDigest: snapshot.snapshotDigest
    });
  });
  return expectedById;
}

/** 校验 witness 来源 metadata、exact scope 对象与 registration domain binding 完全一致。 */
function assertStrategyWitnessScopeBindings(scopeState, witnessState) {
  if (witnessState.registrationScope === null
    || witnessState.exactScope !== scopeState.exactScope
    || sha256Stable(witnessState.domainBinding) !== scopeState.domainBindingDigest) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_WITNESS_BINDING_MISMATCH',
      '策略评价 completion witness 与 registration scope 绑定不一致。',
      null,
      409
    );
  }
  const exactTimeseries = scopeState.exactScope.timeseries;
  const exactRules = scopeState.exactScope.strategyRules;
  const timeseriesIds = assertStrategyWitnessIdSet(
    exactTimeseries.timeseriesRecordIds,
    witnessState.sourceTimeseriesIds,
    'DEMO_DERIVED_STRATEGY_TIMESERIES_SET_MISMATCH',
    '策略评价 witness 时序集合与 exact scope 不一致。',
    witnessState.evaluationRunId
  );
  const strategyRuleIds = assertStrategyWitnessIdSet(
    exactRules.strategyRuleIds,
    witnessState.strategyRuleIds,
    'DEMO_DERIVED_STRATEGY_RULE_SET_MISMATCH',
    '策略评价 witness 规则集合与 exact scope 不一致。',
    witnessState.evaluationRunId
  );
  if (Number(witnessState.sourceBatchIds.timeseries) !== Number(exactTimeseries.timeseriesSourceBatchId)
    || Number(witnessState.sourceBatchIds.strategyRules) !== Number(exactRules.strategyRuleSourceBatchId)
    || witnessState.sourceDigests.timeseries !== exactTimeseries.timeseriesScopeDigest
    || witnessState.sourceDigests.strategyRules !== exactRules.strategyRuleScopeDigest) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SOURCE_EXACT_METADATA_MISMATCH',
      '策略评价 witness 来源批次或 digest 与 exact scope 不一致。',
      { evaluationRunId: witnessState.evaluationRunId },
      409
    );
  }
  return { timeseriesIds, strategyRuleIds };
}

/** 校验 evaluator 返回 run/hit 快照仍与 registrar 重读事实完全一致。 */
function assertStrategyWitnessReturnSnapshots(db, evaluationRun, hitIds, witnessState) {
  const runScope = parseStrictDemoProjectionJsonObject(
    evaluationRun.scope_reference,
    'snapshot.scope_reference'
  );
  const runSnapshot = {
    id: Number(evaluationRun.id),
    runCode: evaluationRun.run_code,
    scopeType: evaluationRun.scope_type,
    scopeReference: runScope,
    status: evaluationRun.status,
    reasonCodes: evaluationRun.reason_codes_json
      ? JSON.parse(evaluationRun.reason_codes_json)
      : [],
    startedAt: evaluationRun.started_at,
    completedAt: evaluationRun.completed_at
  };
  const hitSnapshots = hitIds.map((hitId) => getStrategyRuleHitWithDb(db, hitId));
  if (sha256Stable(runSnapshot) !== sha256Stable(witnessState.runSnapshot)
    || hitSnapshots.some((snapshot) => !snapshot)
    || sha256Stable(hitSnapshots) !== sha256Stable(witnessState.hitSnapshots)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_WITNESS_SNAPSHOT_MISMATCH',
      '策略评价 completion witness 返回快照与当前持久事实不一致。',
      { evaluationRunId: Number(evaluationRun.id) },
      409
    );
  }
}

/**
 * 在调用方事务中登记一次策略评价的 derived ownership 和固定 2H+T relation 集合。
 * 唯一输入来源是 opaque registration scope 与 evaluator completion witness。
 */
function registerDerivedStrategyEvaluationInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'registrationScope', 'evaluationWitness'],
    'DEMO_DERIVED_STRATEGY_INPUT_INVALID',
    '策略评价 derived ownership 只能接收 db、registrationScope 和 evaluationWitness。'
  );
  const db = input.db;
  if (!db || db.inTransaction !== true) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED',
      '策略评价 derived ownership 必须复用 caller transaction。',
      null,
      409
    );
  }
  const scopeState = requireStrategyRegistrationScopeState(
    db,
    input.registrationScope,
    ['active']
  );
  const run = requireDemoDatasetRun(db, scopeState.runId);
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: scopeState.actorUserId });
  requireStrategyDerivedActionRun(db, scopeState, run);
  rotateStrategyRegistrationScopeLiveness(input.registrationScope, scopeState);
  const savepointName = createStrategyRegistrationSavepointName('demo_strategy_registrar');
  db.exec(`SAVEPOINT ${savepointName}`);
  let savepointActive = true;
  try {
    const witnessState = consumeEnergyStrategyEvaluationCompletionWitness({
      db,
      registrationScope: input.registrationScope,
      exactScope: scopeState.exactScope,
      evaluationWitness: input.evaluationWitness
    });
    scopeState.status = 'consumed';
    if (witnessState.registrationScope !== input.registrationScope) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_WITNESS_BINDING_MISMATCH',
        '策略评价 completion witness 与 registration scope 对象身份不一致。',
        null,
        409
      );
    }
    const sourceSets = assertStrategyWitnessScopeBindings(scopeState, witnessState);
    const evaluationRunId = normalizeIntegerEntityPk(witnessState.evaluationRunId);
    if (!evaluationRunId) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_EVALUATION_RUN_INVALID',
        '策略评价 completion witness 缺少有效运行 ID。',
        null,
        409
      );
    }
    const evaluationRun = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_evaluation_run
      .readProjection(db, evaluationRunId);
    if (!evaluationRun || Number(evaluationRun.id) !== evaluationRunId
      || evaluationRun.status !== 'completed') {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_EVALUATION_RUN_INVALID',
        '策略评价 run 不存在或未完成。',
        { evaluationRunId },
        409
      );
    }
    DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_evaluation_run.validateProjectionRow(evaluationRun);
    const hitRows = db.prepare(
      'SELECT * FROM strategy_rule_hits WHERE evaluation_run_id = ? ORDER BY id'
    ).all(evaluationRunId);
    const hitIds = assertStrategyWitnessIdSet(
      hitRows.map((row) => Number(row.id)),
      witnessState.hitIds,
      'DEMO_DERIVED_STRATEGY_HIT_SET_MISMATCH',
      '策略评价命中集合与 completion witness 完整集合不一致。',
      evaluationRunId
    );
    const persistedRuleIds = [...new Set(hitRows.map((row) => Number(row.strategy_rule_id)))]
      .sort((left, right) => left - right);
    const strategyRuleIds = assertStrategyWitnessIdSet(
      persistedRuleIds,
      sourceSets.strategyRuleIds,
      'DEMO_DERIVED_STRATEGY_RULE_SET_MISMATCH',
      '策略评价命中规则集合与 completion witness 不一致。',
      evaluationRunId
    );
    assertStrategyWitnessReturnSnapshots(db, evaluationRun, hitIds, witnessState);
    const runScope = parseStrictDemoProjectionJsonObject(
      evaluationRun.scope_reference,
      'snapshot.scope_reference'
    );
    const persistedDomainBinding = {
      ...runScope,
      startUtc: evaluationRun.start_utc,
      endUtc: evaluationRun.end_utc
    };
    if (sha256Stable(persistedDomainBinding) !== scopeState.domainBindingDigest) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_DOMAIN_BINDING_INVALID',
        '策略评价 run 与 registration scope 领域绑定不一致。',
        { evaluationRunId },
        409
      );
    }
    const expectedRuleSources = buildStrategyExpectedSourceMap(
      scopeState.exactScope.strategyRules.expectedStrategyRuleSnapshots,
      witnessState.sourceBatchIds.strategyRules,
      'strategy_rule'
    );
    const expectedTimeseriesSources = buildStrategyExpectedSourceMap(
      scopeState.exactScope.timeseries.expectedTimeseriesSnapshots,
      witnessState.sourceBatchIds.timeseries,
      'energy_timeseries'
    );
    const ruleSources = strategyRuleIds.map((entityPk) => requireStrategyImportedSource(
      db,
      run,
      'strategy_rule',
      entityPk,
      '18-strategy-rules',
      expectedRuleSources.get(entityPk)
    ));
    const timeseriesSources = sourceSets.timeseriesIds.map((entityPk) => requireStrategyImportedSource(
      db,
      run,
      'energy_timeseries',
      entityPk,
      '15-energy-timeseries',
      expectedTimeseriesSources.get(entityPk)
    ));
    if (ruleSources.length !== expectedRuleSources.size
      || timeseriesSources.length !== expectedTimeseriesSources.size) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SOURCE_EXACT_METADATA_MISMATCH',
        '策略评价 imported ownership 来源集合与 exact metadata 不一致。',
        { evaluationRunId },
        409
      );
    }
    const hitContracts = hitRows.map((row) => {
      DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.validateProjectionRow(row);
      return buildDemoEntityRegistrationContract({
        entityType: 'strategy_rule_hit',
        entityPk: row.id,
        row
      });
    });
    assertStrategyDerivedTimeseriesEvidenceBindings(hitRows, sourceSets.timeseriesIds);
    assertStrategyDerivedHitMetadataBindings(
      hitRows,
      evaluationRun,
      ruleSources,
      timeseriesSources
    );
    const runContract = buildDemoEntityRegistrationContract({
      entityType: 'strategy_evaluation_run',
      entityPk: evaluationRunId,
      row: evaluationRun
    });
    const registrations = [
      registerSingleDerivedStrategyEntityInTransaction(db, run, actorUserId, runContract),
      ...hitContracts.map((contract) => registerSingleDerivedStrategyEntityInTransaction(
        db,
        run,
        actorUserId,
        contract
      ))
    ];
    const relationIntents = [];
    hitContracts.forEach((contract) => {
      relationIntents.push({
        from: { entityType: 'strategy_evaluation_run', entityPk: String(evaluationRunId) },
        to: { entityType: 'strategy_rule_hit', entityPk: contract.entityPk },
        relationType: 'contains'
      });
    });
    hitRows.forEach((row) => {
      relationIntents.push({
        from: { entityType: 'strategy_rule_hit', entityPk: String(row.id) },
        to: { entityType: 'strategy_rule', entityPk: String(row.strategy_rule_id) },
        relationType: 'uses_config'
      });
    });
    sourceSets.timeseriesIds.forEach((entityPk) => {
      relationIntents.push({
        from: { entityType: 'strategy_evaluation_run', entityPk: String(evaluationRunId) },
        to: { entityType: 'energy_timeseries', entityPk: String(entityPk) },
        relationType: 'generated_from'
      });
    });
    assertStrategyDerivedRelationsExact(db, relationIntents, registrations);
    const relations = registerDemoRelationsInTransaction(
      db,
      { runId: run.runId },
      relationIntents
    );
    if (relations.length !== (2 * hitRows.length) + sourceSets.timeseriesIds.length) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RELATIONS_MISMATCH',
        '策略评价固定 relation 数量不一致。',
        null,
        409
      );
    }
    db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    savepointActive = false;
    return {
      registrationCount: registrations.length,
      relationCount: relations.length,
      registrations,
      relations,
      evaluationRunId,
      hitIds,
      sourceTimeseriesIds: sourceSets.timeseriesIds,
      strategyRuleIds
    };
  } catch (error) {
    scopeState.status = scopeState.status === 'consumed' ? 'consumed' : 'failed';
    markEnergyStrategyRegistrationScopeFailed(input.registrationScope);
    if (savepointActive) {
      let rollbackError = null;
      let releaseError = null;
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } catch (recoveryError) {
        rollbackError = recoveryError;
      }
      try {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch (recoveryError) {
        releaseError = recoveryError;
      }
      savepointActive = false;
      if (rollbackError || releaseError) {
        throw createDemoOwnershipError(
          'DEMO_DERIVED_STRATEGY_REGISTRAR_RECOVERY_FAILED',
          '策略评价 registrar 私有 SAVEPOINT 恢复失败，禁止继续提交外层事务。',
          {
            originalCode: error.code || error.details?.code || null,
            rollbackCode: rollbackError?.code || null,
            releaseCode: releaseError?.code || null
          },
          500
        );
      }
    }
    throw error;
  }
}

/** 在人工 review 同一事务中刷新当前 active derived hit 的 snapshot digest。 */
function refreshDerivedStrategyRuleHitOwnershipInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'hitId'],
    'DEMO_DERIVED_STRATEGY_REFRESH_INPUT_INVALID',
    '策略命中 derived snapshot 刷新只能接收固定服务端字段。'
  );
  if (!input.db || input.db.inTransaction !== true) {
    throw createDemoOwnershipError('DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED', '策略命中 derived snapshot 刷新必须复用调用方事务。', null, 409);
  }
  const hitId = normalizeIntegerEntityPk(input.hitId);
  if (!hitId) throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_REFRESH_INPUT_INVALID', 'hitId 必须为正整数。', null, 400);
  const registry = readActiveRegistryEntity(input.db, 'strategy_rule_hit', String(hitId));
  if (!registry) return { refreshed: false, reason: 'no_active_ownership', registry: null };
  if (registry.ownershipKind !== 'derived') {
    return { refreshed: false, reason: 'non_derived_ownership', registryId: Number(registry.registryId) };
  }
  if (registry.artifactKey !== '18-strategy-rules'
    || registry.sourceBatchId !== null || registry.sourceRowNumber !== null) {
    throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_REFRESH_OWNERSHIP_INVALID', '策略命中 derived ownership 不符合固定 artifact 和 provenance 合同。', { hitId }, 409);
  }
  const row = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule_hit.readProjection(input.db, hitId);
  if (!row) throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_REFRESH_TARGET_MISSING', '策略命中不存在。', { hitId }, 409);
  const contract = buildDemoEntityRegistrationContract({ entityType: 'strategy_rule_hit', entityPk: hitId, row });
  if (registry.identityDigest !== contract.identityDigest) {
    throw createDemoOwnershipError('DEMO_DERIVED_STRATEGY_REFRESH_IDENTITY_MISMATCH', '策略命中 identity digest 不一致。', { hitId }, 409);
  }
  const result = input.db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE registry_id = ? AND entity_type = 'strategy_rule_hit' AND entity_pk = ?
      AND ownership_kind = 'derived' AND artifact_key = '18-strategy-rules'
      AND snapshot_digest <> ? AND cleaned_at IS NULL`).run(
    contract.snapshotDigest, registry.registryId, String(hitId), contract.snapshotDigest
  );
  return {
    refreshed: result.changes === 1,
    reason: result.changes === 1 ? 'snapshot_updated' : 'snapshot_unchanged',
    registryId: Number(registry.registryId),
    snapshotDigest: contract.snapshotDigest
  };
}

/**
 * 在当前 ownership 私有事务内登记本次 imported ownership、批次关系和必要 relation。
 * 无 demoContext 时明确返回正式导入 no-op；存在无效 context 时复用现有校验并 fail-closed。
 */
function registerImportedDemoOwnershipInTransaction(input = {}) {
  if (input.demoContext === null || input.demoContext === undefined) {
    return {
      applied: false,
      mode: 'formal',
      reason: 'demo_context_absent',
      registrations: [],
      skipped: [],
      relations: []
    };
  }
  const transactionScope = input.transactionScope;
  const scopeState = requireDemoOwnershipTransactionScope(transactionScope);
  const db = scopeState.privateDb;
  const actorUserId = requireDemoOwnershipActor(db, input);
  const demoContext = input.demoContext;
  const artifact = requireDemoArtifactHandler(demoContext.artifactKey, demoContext.handlerKey);
  const context = validateDemoContext({
    token: demoContext.token,
    userId: actorUserId,
    artifactKey: artifact.artifactKey,
    handlerKey: artifact.handlerKey,
    phase: 'execute',
    uploadFileSha256: demoContext.uploadFileSha256,
    previewDigest: demoContext.previewDigest,
    db
  });
  assertDemoContextMetadataMatches(context, demoContext);
  const run = requireDemoDatasetRun(db, context.runId);
  if (context.datasetId !== run.datasetId
    || context.manifestVersion !== run.manifestVersion
    || context.manifestDigest !== run.manifestDigest) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_RUN_BINDING_MISMATCH',
      '演示 ownership context 与 dataset run 绑定不一致。',
      { contextId: context.contextId, runId: context.runId },
      409
    );
  }
  const batchBindings = normalizeDemoBatchBindings(artifact, input.batchBindings);
  const hasInsertedRecordsField = Object.prototype.hasOwnProperty.call(input, 'insertedRecords');
  if (!hasInsertedRecordsField || !Array.isArray(input.insertedRecords)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_INSERTED_RECORDS_INVALID',
      '存在 demoContext 时 insertedRecords 必须显式提供数组；非法输入不得降级为空数组。',
      { actualType: hasInsertedRecordsField
        ? (input.insertedRecords === null ? 'null' : typeof input.insertedRecords)
        : 'missing' },
      400
    );
  }
  const noInsertedRecords = input.noInsertedRecords === true;
  if (input.insertedRecords.length === 0 && !noInsertedRecords) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_EMPTY_INSERTED_RECORDS_UNDECLARED',
      '空 insertedRecords 只有在调用方明确声明 noInsertedRecords=true 时才允许。',
      null,
      400
    );
  }
  if (input.insertedRecords.length > 0 && noInsertedRecords) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_EMPTY_INSERTED_RECORDS_DECLARATION_MISMATCH',
      'noInsertedRecords=true 时不得同时提供 inserted 记录。',
      null,
      400
    );
  }
  if (noInsertedRecords && Array.isArray(input.relations) && input.relations.length > 0) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_NO_INSERT_RELATIONS_INVALID',
      'noInsertedRecords=true 时本次无需登记，不得继续写入 relation。',
      null,
      400
    );
  }
  const insertedRecords = normalizeInsertedDemoRecords(
    db,
    artifact,
    input.insertedRecords,
    batchBindings,
    transactionScope
  );
  const skippedRecords = normalizeSkippedDemoRecords(
    artifact,
    input.skippedRecords,
    batchBindings,
    insertedRecords
  );
  ensureDemoBatchLinksInTransaction(db, context, batchBindings);
  const registrations = insertedRecords.map((record) => (
    registerSingleImportedRecordInTransaction(db, context, record, actorUserId)
  ));
  const relations = registerDemoRelationsInTransaction(db, context, input.relations);
  const activeScopeState = requireDemoOwnershipTransactionScope(transactionScope);
  input.insertedRecords.forEach((record) => activeScopeState.pendingWitnesses.delete(record.rowWitness));
  return {
    applied: true,
    mode: 'demo',
    context: {
      contextId: context.contextId,
      runId: context.runId,
      datasetId: context.datasetId,
      manifestVersion: context.manifestVersion,
      manifestDigest: context.manifestDigest,
      artifactKey: context.artifactKey,
      handlerKey: context.handlerKey
    },
    batchBindings,
    noInsertedRecords,
    registrationCount: registrations.length,
    insertedCount: registrations.filter((item) => item.result === 'registered').length,
    idempotentCount: registrations.filter((item) => item.result === 'idempotent').length,
    skippedCount: skippedRecords.length,
    relationCount: relations.length,
    registrations,
    skipped: skippedRecords,
    relations
  };
}

/** 在 ownership 私有事务内执行固定 execute 审计 intent，禁止调用方注入 SQL 或连接。 */
function updateDemoExecuteAuditInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'batchId', 'status', 'statistics', 'executeResult', 'backup', 'errorSummary'],
    'DEMO_OWNERSHIP_EXECUTE_AUDIT_INTENT_INVALID',
    'ownership execute 审计 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  updateExecuteAuditResult(input.batchId, {
    status: input.status,
    statistics: input.statistics,
    executeResult: input.executeResult,
    backup: input.backup,
    errorSummary: input.errorSummary
  }, { db: scopeState.privateDb });
  return getImportAuditSummary(input.batchId, { db: scopeState.privateDb });
}

/** 在 ownership 私有事务内执行固定 context CAS intent，不暴露 raw connection。 */
function markDemoContextExecutedWithOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'demoContext', 'uploadFileSha256', 'previewDigest', 'batchBindings'],
    'DEMO_OWNERSHIP_CONTEXT_CAS_INTENT_INVALID',
    'ownership context CAS intent 只能包含固定字段。'
  );
  assertExactPlainObjectFields(
    input.demoContext,
    ['artifactKey', 'handlerKey', 'token', 'userId'],
    'DEMO_OWNERSHIP_CONTEXT_CAS_INTENT_INVALID',
    'ownership context CAS 只能使用路由提供的固定 context 字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  return markDemoContextExecutedInTransaction({
    db: scopeState.privateDb,
    ...input.demoContext,
    uploadFileSha256: input.uploadFileSha256,
    previewDigest: input.previewDigest,
    batchBindings: input.batchBindings
  });
}

/** 构造只读引用检查器，存在任一正式引用时阻断能耗记录物理删除。 */
function readEnergyRecordReferenceBlockers(db, entityPk) {
  const checks = [
    {
      code: 'METER_READING_REFERENCE',
      table: 'meter_reading_records',
      count: db.prepare('SELECT COUNT(*) AS total FROM meter_reading_records WHERE generated_energy_record_id = ?').get(entityPk).total
    },
    {
      code: 'CARBON_EMISSION_REFERENCE',
      table: 'carbon_emissions',
      count: db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions WHERE energy_record_id = ?').get(entityPk).total
    },
    {
      code: 'CARBON_ACTIVITY_REFERENCE',
      table: 'carbon_activity_records',
      count: db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records WHERE energy_record_id = ?').get(entityPk).total
    }
  ];
  return checks.filter((item) => Number(item.count) > 0);
}

// 每个 handler 都固定查询、删除 SQL、artifact 绑定和逆依赖检查，客户端不能提供表名、列名或 SQL。
const DEMO_CLEANUP_ENTITY_HANDLERS = Object.freeze({
  prediction_config: Object.freeze({
    entityType: 'prediction_config',
    artifactKeys: Object.freeze(['12-prediction-configs']),
    order: DEMO_CLEANUP_ENTITY_ORDER.indexOf('prediction_config'),
    read(db, entityPk) {
      return DEMO_OWNERSHIP_ENTITY_HANDLERS.prediction_config.readProjection(db, entityPk);
    },
    readReferenceBlockers() {
      return [];
    },
    remove(db, entityPk) {
      return db.prepare('DELETE FROM prediction_configs WHERE id = ?').run(entityPk).changes;
    }
  }),
  energy_record: Object.freeze({
    entityType: 'energy_record',
    artifactKeys: Object.freeze(['07-monthly-energy']),
    order: DEMO_CLEANUP_ENTITY_ORDER.indexOf('energy_record'),
    read(db, entityPk) {
      return DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_record.readProjection(db, entityPk);
    },
    readReferenceBlockers(db, entityPk) {
      return readEnergyRecordReferenceBlockers(db, entityPk);
    },
    remove(db, entityPk) {
      return db.prepare('DELETE FROM energy_records WHERE id = ?').run(entityPk).changes;
    }
  })
});

/** 返回静态白名单 handler；未知类型统一返回 null 供上层生成 blocker。 */
function getDemoCleanupEntityHandler(entityType) {
  const normalizedType = String(entityType || '').trim();
  return Object.prototype.hasOwnProperty.call(DEMO_CLEANUP_ENTITY_HANDLERS, normalizedType)
    ? DEMO_CLEANUP_ENTITY_HANDLERS[normalizedType]
    : null;
}

/** 将 registry 数据库行映射为稳定内部结构。 */
function mapRegistryRow(row) {
  return {
    registryId: Number(row.registryId),
    runId: row.runId,
    artifactKey: row.artifactKey,
    entityType: row.entityType,
    entityPk: row.entityPk,
    ownershipKind: row.ownershipKind,
    identityDigest: row.identityDigest,
    snapshotDigest: row.snapshotDigest,
    sourceBatchId: row.sourceBatchId === null ? null : Number(row.sourceBatchId),
    sourceRowNumber: row.sourceRowNumber === null ? null : Number(row.sourceRowNumber),
    registeredAt: row.registeredAt,
    cleanedAt: row.cleanedAt,
    cleanupRunId: row.cleanupRunId,
    cleanupResult: row.cleanupResult
  };
}

/** 读取指定 run 的全部 ownership tombstone，排序稳定且不跨 run。 */
function readDemoRegistryRows(db, runId, options = {}) {
  const activeOnly = options.activeOnly === true;
  const where = activeOnly ? 'AND cleaned_at IS NULL' : '';
  return db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, registered_at AS registeredAt,
      cleaned_at AS cleanedAt, cleanup_run_id AS cleanupRunId, cleanup_result AS cleanupResult
    FROM demo_data_registry WHERE run_id = ? ${where}
    ORDER BY registry_id`).all(runId).map(mapRegistryRow);
}

/** 根据当前 run 的活跃 registry 计算防陈旧 watermark。 */
function calculateRegistryWatermark(registryRows) {
  return sha256Stable({
    domain: 'demo-registry-watermark:v1',
    rows: registryRows.map((row) => ({
      registryId: row.registryId,
      runId: row.runId,
      artifactKey: row.artifactKey,
      entityType: row.entityType,
      entityPk: row.entityPk,
      ownershipKind: row.ownershipKind,
      identityDigest: row.identityDigest,
      snapshotDigest: row.snapshotDigest,
      registeredAt: row.registeredAt
    }))
  });
}

/** 为单条 ownership 生成可删除候选或 fail-closed blocker。 */
function inspectRegistryOwnership(db, registryRow) {
  const base = {
    registryId: registryRow.registryId,
    artifactKey: registryRow.artifactKey,
    entityType: registryRow.entityType,
    entityPk: registryRow.entityPk,
    ownershipKind: registryRow.ownershipKind,
    expectedSnapshotDigest: registryRow.snapshotDigest
  };
  if (!CLEANABLE_OWNERSHIP_KINDS.has(registryRow.ownershipKind)) {
    return { blocker: { ...base, code: 'DERIVED_OWNERSHIP_NOT_CONNECTED' } };
  }
  const artifact = getDemoArtifactRegistration(registryRow.artifactKey);
  if (!artifact || !artifact.ownershipTargets.includes(registryRow.entityType)) {
    return { blocker: { ...base, code: 'ARTIFACT_OWNERSHIP_BINDING_MISMATCH' } };
  }
  const handler = getDemoCleanupEntityHandler(registryRow.entityType);
  if (!handler || !handler.artifactKeys.includes(registryRow.artifactKey)) {
    return { blocker: { ...base, code: 'CLEANUP_HANDLER_NOT_WHITELISTED' } };
  }
  const entityPk = normalizeIntegerEntityPk(registryRow.entityPk);
  if (entityPk === null) {
    return { blocker: { ...base, code: 'ENTITY_PK_INVALID' } };
  }
  const expectedIdentityDigest = calculateDemoEntityIdentityDigest(registryRow.entityType, registryRow.entityPk);
  if (registryRow.identityDigest !== expectedIdentityDigest) {
    return { blocker: { ...base, code: 'IDENTITY_DIGEST_MISMATCH' } };
  }
  const row = handler.read(db, entityPk);
  if (!row) {
    return {
      candidate: {
        ...base,
        entityPkValue: entityPk,
        order: handler.order,
        expectedOutcome: 'already_missing'
      }
    };
  }
  const currentSnapshotDigest = calculateDemoEntitySnapshotDigest(
    registryRow.entityType,
    registryRow.entityPk,
    row
  );
  if (currentSnapshotDigest !== registryRow.snapshotDigest) {
    return { blocker: { ...base, code: 'SNAPSHOT_DIGEST_MISMATCH' } };
  }
  const referenceBlockers = handler.readReferenceBlockers(db, entityPk);
  if (referenceBlockers.length > 0) {
    return {
      blocker: {
        ...base,
        code: 'FORMAL_DATA_REFERENCE_BLOCKED',
        references: referenceBlockers
      }
    };
  }
  return {
    candidate: {
      ...base,
      entityPkValue: entityPk,
      order: handler.order,
      expectedOutcome: 'deleted'
    }
  };
}

/** 构建当前 run 的静态清理计划；任何未知 ownership 都只进入 blocker。 */
function buildDemoOwnershipPlan(db, runId) {
  const registryRows = readDemoRegistryRows(db, runId, { activeOnly: true });
  const candidates = [];
  const blockers = [];
  registryRows.forEach((registryRow) => {
    const inspection = inspectRegistryOwnership(db, registryRow);
    if (inspection.candidate) candidates.push(inspection.candidate);
    if (inspection.blocker) blockers.push(inspection.blocker);
  });
  if (!DEMO_OWNERSHIP_REGISTRATION_CONNECTED) {
    blockers.push({
      code: 'OWNERSHIP_REGISTRATION_NOT_CONNECTED',
      reason: 'ownership_registration_not_connected'
    });
  }
  candidates.sort((left, right) => left.order - right.order || left.registryId - right.registryId);
  blockers.sort((left, right) => (
    Number(left.registryId || 0) - Number(right.registryId || 0)
      || String(left.code).localeCompare(String(right.code))
  ));
  return {
    registryWatermark: calculateRegistryWatermark(registryRows),
    registryCount: registryRows.length,
    registrationConnected: DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
    candidateCount: candidates.length,
    blockerCount: blockers.length,
    candidates,
    blockers
  };
}

/** 对 registry 行按字段分组，返回供 ownership summary 使用的稳定计数。 */
function groupRegistryCounts(rows, fieldName) {
  const counts = new Map();
  rows.forEach((row) => counts.set(row[fieldName], (counts.get(row[fieldName]) || 0) + 1));
  return [...counts.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, count]) => ({ key, count }));
}

/** 返回当前 run 的 ownership 汇总和 fail-closed 清理支持状态。 */
function getDemoOwnershipSummary(input = {}) {
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const run = requireDemoDatasetRun(db, input.runId);
    const rows = readDemoRegistryRows(db, run.runId);
    const activeRows = rows.filter((row) => row.cleanedAt === null);
    const cleanedRows = rows.filter((row) => row.cleanedAt !== null);
    const plan = buildDemoOwnershipPlan(db, run.runId);
    return {
      run,
      registrationConnected: plan.registrationConnected,
      derivedOwnershipConnected: false,
      staticCleanupEntityTypes: [...DEMO_CLEANUP_ENTITY_ORDER],
      totalCount: rows.length,
      activeCount: activeRows.length,
      cleanedCount: cleanedRows.length,
      activeByOwnershipKind: groupRegistryCounts(activeRows, 'ownershipKind'),
      activeByArtifact: groupRegistryCounts(activeRows, 'artifactKey'),
      activeByEntityType: groupRegistryCounts(activeRows, 'entityType'),
      cleanedByResult: groupRegistryCounts(cleanedRows, 'cleanupResult'),
      registryWatermark: plan.registryWatermark,
      cleanupCandidateCount: plan.candidateCount,
      cleanupBlockerCount: plan.blockerCount,
      blockers: plan.blockers
    };
  } finally {
    if (ownedDb) db.close();
  }
}

module.exports = {
  DEMO_CLEANUP_ENTITY_HANDLERS,
  DEMO_CLEANUP_ENTITY_ORDER,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
  DEMO_OWNERSHIP_SNAPSHOT_PROJECTION_VERSION: 'demo-entity-snapshot:v1',
  createDemoOwnershipInsertWitness,
  abortStrategyEvaluationRegistrationScopeInTransaction,
  activateStrategyEvaluationRegistrationScopeInTransaction,
  issueStrategyEvaluationRegistrationScopeInTransaction,
  deactivateShiftDefinitionSiblingsInOwnershipTransaction,
  deactivateStrategyRuleSiblingsInOwnershipTransaction,
  writeShiftDefinitionImportAuditInOwnershipTransaction,
  writeStrategyRuleImportAuditInOwnershipTransaction,
  runWithDemoOwnershipTransaction,
  runWithDemoOwnershipTransactionAsync,
  buildDemoOwnershipPlan,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  calculateRegistryWatermark,
  getDemoCleanupEntityHandler,
  getDemoOwnershipSummary,
  readDemoRegistryRows,
  registerImportedDemoOwnershipInTransaction,
  registerDerivedMeterEnergyRecordsInTransaction,
  registerDerivedStrategyEvaluationInTransaction,
  refreshDerivedStrategyRuleHitOwnershipInTransaction,
  updateDemoExecuteAuditInOwnershipTransaction,
  markDemoContextExecutedWithOwnershipTransaction,
  _test: {
    buildDemoEntityRegistrationContract,
    buildDemoEntitySnapshotProjection,
    calculateDemoEntityIdentityProjectionDigest,
    canonicalizeDemoJsonProjection,
    getDemoOwnershipEntityHandler,
    normalizeDigestValue,
    normalizeIntegerEntityPk,
    sha256Stable
  }
};
