'use strict';

// 服务导出壳在任何依赖加载前绑定到当前 Module，阻止初始化窗口整体替换 require.cache exports。
const demoOwnershipServiceExports = {};
// 使用稳定 Proxy 壳绕开 Node 23 循环加载器对普通 exports 原型的临时改写。
const demoOwnershipServiceExportsProxy = new Proxy(demoOwnershipServiceExports, {});
Object.defineProperty(module, 'exports', {
  value: demoOwnershipServiceExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

// 协议依赖的函数声明在模块初始化首段固定，供协议 linker 在任一加载顺序下捕获同一函数对象。
Object.entries({
  abortStrategyEvaluationRegistrationScopeInTransaction,
  activateStrategyEvaluationRegistrationScopeInTransaction,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  refreshDerivedStrategyRuleHitOwnershipInTransaction,
  registerDerivedStrategyEvaluationInTransaction,
  verifyDerivedStrategyEvaluationReceiptInTransaction
}).forEach(([fieldName, handler]) => {
  Object.defineProperty(demoOwnershipServiceExports, fieldName, {
    value: handler,
    enumerable: true,
    writable: false,
    configurable: false
  });
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { types: utilTypes } = require('util');
const {
  backupsDir: defaultBackupsDir,
  openDatabase,
  openReadOnlyDatabase,
  uploadsDir: defaultUploadsDir
} = require('../db/database');
const { AppError } = require('../utils/errors');
const { MAX_IMPORT_FILE_SIZE_BYTES } = require('../middleware/upload');
const { readSafeUploadFile } = require('./energyAnalysisImportCore');
const { recordOperation } = require('./sessionService');
const {
  getDemoArtifactRegistration,
  requireDemoArtifactHandler
} = require('./demoArtifactRegistry');
const {
  hashDemoContextToken,
  markDemoContextExecutedInTransaction,
  validateDemoContext,
  validateDemoContextTerminalReplay,
  validateDemoContextToken,
  validatePreviewAuditDigest,
  validateSha256
} = require('./demoContextService');
const {
  getImportAuditSummary,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  assertDemoRuntimeEnabled,
  requireDemoDatasetRun
} = require('./demoRunService');
const {
  SUPPORTED_FORMULA_VERSION,
  SUPPORTED_METRIC_CODES,
  assertEnergyStrategyExactScopeCapability,
  bindEnergyStrategyRegistrationScopeCapability,
  consumeEnergyStrategyEvaluationWitnessForOwnership,
  getStrategyRuleHitWithDb,
  insertOperationLogWithDb,
  parseEvidenceRequirements
} = require('./energyStrategyEvaluationService');
const { energyStrategyEvaluatorProtocol } = require('./energyStrategyOwnershipProtocol');
const {
  ENERGY_ANALYSIS_REASON_CODES,
  RULE_THRESHOLD_OPERATORS,
  isIanaTimeZone
} = require('./energyAnalysisContracts');
const {
  buildPredictionConfidenceFacts,
  isPredictionRoundedValue,
  parsePredictionForecastMethodNote
} = require('./predictionUtils');

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
// 策略评价输入关系只在 artifact 15/18 的正式 managed ownership 事务中准备，不代表执行策略评价。
const DEMO_STRATEGY_INPUT_ARTIFACT_KEYS = new Set([
  '15-energy-timeseries',
  '18-strategy-rules'
]);
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
// 碳活动 managed 替代意图使用私有 WeakMap 绑定旧 ownership 快照和当前事务，JSON 无法伪造。
const DEMO_CARBON_ACTIVITY_SUPERSEDE_WITNESS_STATE = new WeakMap();
// ownership 事务 scope 及连接当前 scope 均为模块私有状态，callback 结束后立即失效。
const DEMO_OWNERSHIP_TRANSACTION_SCOPE_STATE = new WeakMap();
const DEMO_ACTIVE_OWNERSHIP_SCOPE_BY_DB = new WeakMap();
// strategy derived registration scope 只接受一次 issue/activate/consume/abort 生命周期。
const DEMO_STRATEGY_REGISTRATION_SCOPE_STATE = new WeakMap();
// strategy registrar receipt 只保存在本模块私有状态中，clone、JSON clone 和重放均拒绝。
const DEMO_STRATEGY_RECEIPT_STATE = new WeakMap();
// registration scope 使用未提交的内部审计 marker 证明仍处于 issue 时的原始事务。
const DEMO_STRATEGY_SCOPE_MARKER_OPERATION = '__charcoal_strategy_registration_scope_marker';
const DEMO_STRATEGY_RECEIPT_CONSUMED = new WeakSet();
// canonical ownership 构造器仅通过非枚举内部协议提供给固定派生 registrar。
const DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
// Artifact 12 单一 operation 仅通过非枚举内部协议签发，不向业务调用方暴露分步写能力。
const DEMO_PREDICTION_CONFIG_MANAGED_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.predictionConfigManaged.v1');
const PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.predictionConfig.managedCore.v1');
const DEMO_PREDICTION_CONFIG_MANAGED_OPERATION_AUTHORITY = Object.freeze({});
let predictionConfigManagedCoreProtocol = null;
// Artifact 07 通过通用事务 wrapper 的不可拆分 operation intent 执行，不向 scope 或模块导出分步写协议。
const DEMO_MANAGED_DIRECT_IMPORT_OPERATION = 'artifact-07-managed-direct:v1';
// managed direct import 固定绑定唯一 artifact、handler、批次角色和业务导入类型。
const DEMO_MANAGED_DIRECT_IMPORT_BINDING = Object.freeze({
  artifactKey: '07-monthly-energy',
  handlerKey: 'monthly-energy-import',
  batchRole: 'primary',
  importType: 'energy_record'
});
// Artifact 12 managed retained 导入固定绑定 prediction_config，并且训练批次只能来自同 run Artifact 07。
const DEMO_PREDICTION_CONFIG_IMPORT_BINDING = Object.freeze({
  artifactKey: '12-prediction-configs',
  handlerKey: 'prediction-configs-import',
  batchRole: 'primary',
  importType: 'prediction_config'
});
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

/** 深复制并冻结 strategy 私有协议快照，禁止返回 live metadata。 */
function cloneFrozenStrategyOwnershipSnapshot(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneFrozenStrategyOwnershipSnapshot));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, cloneFrozenStrategyOwnershipSnapshot(item)]
    ))));
  }
  return value;
}

/** 使用模块初始化期间已捕获的 evaluator 闭包协议，不再读取对端 require/cache exports。 */
function getEnergyStrategyEvaluatorProtocol() {
  return energyStrategyEvaluatorProtocol;
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

/** 校验 Prediction config snapshot 的固定 JSON 合同和可空关联字段一致性。 */
function assertPredictionConfigSnapshotProjection(configSnapshot, parameters) {
  if (configSnapshot === null) return;
  if (!configSnapshot || Array.isArray(configSnapshot)
    || typeof configSnapshot !== 'object'
    || Object.getPrototypeOf(configSnapshot) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      'snapshot.parameters_json.configSnapshot 必须是严格 JSON object 或 null。',
      { fieldName: 'snapshot.parameters_json.configSnapshot' },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(
    configSnapshot,
    'snapshot.parameters_json.configSnapshot',
    ['configId', 'config']
  );
  assertDemoProjectionInteger(
    configSnapshot.configId,
    'snapshot.parameters_json.configSnapshot.configId',
    { min: 1 }
  );
  const config = configSnapshot.config;
  if (!config || Array.isArray(config) || typeof config !== 'object'
    || Object.getPrototypeOf(config) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      'snapshot.parameters_json.configSnapshot.config 必须是严格 JSON object。',
      { fieldName: 'snapshot.parameters_json.configSnapshot.config' },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(
    config,
    'snapshot.parameters_json.configSnapshot.config',
    [
      'name', 'note', 'energyTypeCode', 'organizationUnitId', 'organizationUnitCode',
      'meterDeviceId', 'meterCode', 'sourceBatchId', 'trainStartMonth', 'trainEndMonth',
      'predictStartMonth', 'predictEndMonth', 'algorithm', 'windowSize'
    ]
  );
  assertDemoProjectionString(config.name, 'snapshot.parameters_json.configSnapshot.config.name', { nonEmpty: true });
  assertDemoProjectionString(config.note, 'snapshot.parameters_json.configSnapshot.config.note', { nullable: true });
  assertDemoProjectionString(config.energyTypeCode, 'snapshot.parameters_json.configSnapshot.config.energyTypeCode', { nullable: true, nonEmpty: true });
  assertDemoProjectionInteger(config.organizationUnitId, 'snapshot.parameters_json.configSnapshot.config.organizationUnitId', { nullable: true, min: 1 });
  assertDemoProjectionString(config.organizationUnitCode, 'snapshot.parameters_json.configSnapshot.config.organizationUnitCode', { nullable: true, nonEmpty: true });
  assertDemoProjectionInteger(config.meterDeviceId, 'snapshot.parameters_json.configSnapshot.config.meterDeviceId', { nullable: true, min: 1 });
  assertDemoProjectionString(config.meterCode, 'snapshot.parameters_json.configSnapshot.config.meterCode', { nullable: true, nonEmpty: true });
  assertDemoProjectionInteger(config.sourceBatchId, 'snapshot.parameters_json.configSnapshot.config.sourceBatchId', { min: 1 });
  ['trainStartMonth', 'trainEndMonth', 'predictStartMonth', 'predictEndMonth'].forEach((fieldName) => {
    assertDemoProjectionMonth(
      config[fieldName],
      `snapshot.parameters_json.configSnapshot.config.${fieldName}`
    );
  });
  assertDemoProjectionEnum(
    config.algorithm,
    'snapshot.parameters_json.configSnapshot.config.algorithm',
    ['moving_average', 'linear_trend']
  );
  assertDemoProjectionInteger(
    config.windowSize,
    'snapshot.parameters_json.configSnapshot.config.windowSize',
    { nullable: true, min: 2 }
  );
  if (config.windowSize !== null && config.windowSize > 12) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.configSnapshot.config.windowSize 超出固定范围。',
      { fieldName: 'snapshot.parameters_json.configSnapshot.config.windowSize', max: 12 },
      400
    );
  }
  const nullablePairsMatch = (left, right) => (left === null) === (right === null);
  if (!nullablePairsMatch(config.organizationUnitId, config.organizationUnitCode)
    || !nullablePairsMatch(config.meterDeviceId, config.meterCode)
    || config.algorithm !== parameters.algorithm
    || config.windowSize !== parameters.windowSize
    || config.trainStartMonth !== parameters.trainMonths[0]
    || config.trainEndMonth !== parameters.trainMonths.at(-1)
    || config.predictStartMonth !== parameters.predictionMonths[0]
    || config.predictEndMonth !== parameters.predictionMonths.at(-1)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.configSnapshot 与算法、月份或关联字段不一致。',
      { fieldName: 'snapshot.parameters_json.configSnapshot.config' },
      400
    );
  }
}

/** 校验 Prediction run parameters_json 的固定 JSON 合同，禁止隐式数值转换和未知字段。 */
function assertPredictionRunParametersProjection(value, row) {
  const parameters = parseStrictDemoProjectionJsonObject(value, 'snapshot.parameters_json');
  assertStrictDemoProjectionJsonFields(parameters, 'snapshot.parameters_json', [
    'algorithm', 'windowSize', 'filters', 'trainMonths', 'predictionMonths',
    'requiredHistoryMonths', 'configSnapshot', 'warnings'
  ]);
  assertDemoProjectionEnum(parameters.algorithm, 'snapshot.parameters_json.algorithm', [
    'moving_average', 'linear_trend'
  ]);
  if (parameters.algorithm !== row.algorithm) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.algorithm 必须与预测运行算法一致。',
      { fieldName: 'snapshot.parameters_json.algorithm' },
      400
    );
  }
  assertDemoProjectionInteger(
    parameters.windowSize,
    'snapshot.parameters_json.windowSize',
    { nullable: true, min: 2 }
  );
  if (parameters.windowSize !== null && parameters.windowSize > 12) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.windowSize 超出固定范围。',
      { fieldName: 'snapshot.parameters_json.windowSize', max: 12 },
      400
    );
  }
  if ((parameters.algorithm === 'moving_average' && parameters.windowSize === null)
    || (parameters.algorithm === 'linear_trend' && parameters.windowSize !== null)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.windowSize 与预测算法不一致。',
      { fieldName: 'snapshot.parameters_json.windowSize' },
      400
    );
  }
  const filters = parameters.filters;
  if (!filters || Array.isArray(filters) || typeof filters !== 'object'
    || Object.getPrototypeOf(filters) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      'snapshot.parameters_json.filters 必须是严格 JSON object。',
      { fieldName: 'snapshot.parameters_json.filters' },
      400
    );
  }
  const allowedFilterFields = [
    'energyTypeCode', 'organizationUnitCode', 'organizationUnitId',
    'meterCode', 'meterDeviceId', 'sourceBatchId'
  ];
  const filterFields = Object.keys(filters);
  if (filterFields.some((fieldName) => !allowedFilterFields.includes(fieldName))) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      'snapshot.parameters_json.filters 包含未知字段。',
      { fieldName: 'snapshot.parameters_json.filters', actualFields: filterFields },
      400
    );
  }
  ['energyTypeCode', 'organizationUnitCode', 'meterCode'].forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(filters, fieldName)) {
      assertDemoProjectionString(
        filters[fieldName],
        `snapshot.parameters_json.filters.${fieldName}`,
        { nonEmpty: true }
      );
    }
  });
  ['organizationUnitId', 'meterDeviceId', 'sourceBatchId'].forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(filters, fieldName)) {
      assertDemoProjectionInteger(
        filters[fieldName],
        `snapshot.parameters_json.filters.${fieldName}`,
        { min: 1 }
      );
    }
  });
  const assertMonthArray = (months, fieldName) => {
    const monthIndexes = Array.isArray(months) ? months.map((month) => {
      try {
        assertDemoProjectionMonth(month, fieldName);
        const [year, monthNumber] = month.split('-').map(Number);
        return year * 12 + monthNumber - 1;
      } catch (_error) {
        return null;
      }
    }) : [];
    const hasGapOrReorder = monthIndexes.some((monthIndex, index) => (
      monthIndex === null || (index > 0 && monthIndex !== monthIndexes[index - 1] + 1)
    ));
    if (!Array.isArray(months) || months.length === 0
      || hasGapOrReorder || new Set(months).size !== months.length) {
      throw createDemoOwnershipError(
        'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
        `${fieldName} 必须是非空、无重复的严格月份数组。`,
        { fieldName },
        400
      );
    }
  };
  assertMonthArray(parameters.trainMonths, 'snapshot.parameters_json.trainMonths');
  assertMonthArray(parameters.predictionMonths, 'snapshot.parameters_json.predictionMonths');
  assertDemoProjectionInteger(
    parameters.requiredHistoryMonths,
    'snapshot.parameters_json.requiredHistoryMonths',
    { min: 3 }
  );
  const expectedRequiredMonths = parameters.algorithm === 'moving_average'
    ? Math.max(3, parameters.windowSize)
    : 3;
  if (parameters.requiredHistoryMonths !== expectedRequiredMonths) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'snapshot.parameters_json.requiredHistoryMonths 与算法规则不一致。',
      { fieldName: 'snapshot.parameters_json.requiredHistoryMonths' },
      400
    );
  }
  assertPredictionConfigSnapshotProjection(parameters.configSnapshot, parameters);
  if (!Array.isArray(parameters.warnings)
    || parameters.warnings.some((warning) => typeof warning !== 'string')) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      'snapshot.parameters_json.warnings 必须是字符串数组。',
      { fieldName: 'snapshot.parameters_json.warnings' },
      400
    );
  }
  return parameters;
}

/** 校验 Prediction result 方法说明、六位舍入和算法固定 confidence 合同。 */
function assertPredictionResultMethodNote(value, row) {
  assertDemoProjectionString(value, 'snapshot.method_note', { nonEmpty: true });
  let methodFact = null;
  let confidence = null;
  try {
    methodFact = parsePredictionForecastMethodNote(value);
    confidence = methodFact
      ? buildPredictionConfidenceFacts(methodFact.algorithm, row.predicted_value)
      : null;
  } catch (_error) {
    methodFact = null;
    confidence = null;
  }
  const rounded = isPredictionRoundedValue(row.predicted_value, { nonNegative: true })
    && isPredictionRoundedValue(row.confidence_low, { nonNegative: true })
    && isPredictionRoundedValue(row.confidence_high, { nonNegative: true });
  if (!methodFact || !confidence || !rounded
    || methodFact.canonicalUnit !== row.predicted_unit
    || row.confidence_low !== confidence.confidenceLow
    || row.confidence_high !== confidence.confidenceHigh
    || (methodFact.clampedToZero && row.predicted_value !== 0)) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      'Prediction result 方法说明、算法 confidence 或六位舍入合同无效。',
      { fieldName: 'snapshot.method_note/confidence_low/confidence_high' },
      400
    );
  }
  return methodFact;
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
  prediction_run: Object.freeze({
    entityType: 'prediction_run',
    tableName: 'prediction_runs',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'name', 'algorithm', 'status', 'target_energy_type_id',
      'train_start_month', 'train_end_month', 'predict_start_month', 'predict_end_month',
      'parameters_json', 'created_at', 'completed_at', 'note'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionString(row.name, 'snapshot.name', { nonEmpty: true });
      assertDemoProjectionEnum(row.algorithm, 'snapshot.algorithm', ['moving_average', 'linear_trend']);
      assertDemoProjectionEnum(row.status, 'snapshot.status', ['completed']);
      assertDemoProjectionInteger(row.target_energy_type_id, 'snapshot.target_energy_type_id', { nullable: true, min: 1 });
      assertDemoProjectionMonth(row.train_start_month, 'snapshot.train_start_month');
      assertDemoProjectionMonth(row.train_end_month, 'snapshot.train_end_month');
      assertDemoProjectionMonth(row.predict_start_month, 'snapshot.predict_start_month');
      assertDemoProjectionMonth(row.predict_end_month, 'snapshot.predict_end_month');
      if (row.train_start_month > row.train_end_month
        || row.predict_start_month > row.predict_end_month
        || row.predict_start_month <= row.train_end_month) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'Prediction run 月份范围不符合训练早于预测的固定合同。',
          { fieldName: 'snapshot.train_start_month/predict_start_month' },
          400
        );
      }
      const parameters = assertPredictionRunParametersProjection(row.parameters_json, row);
      if (parameters.trainMonths[0] !== row.train_start_month
        || parameters.trainMonths.at(-1) !== row.train_end_month
        || parameters.predictionMonths[0] !== row.predict_start_month
        || parameters.predictionMonths.at(-1) !== row.predict_end_month) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'Prediction run parameters_json 月份边界与运行字段不一致。',
          { fieldName: 'snapshot.parameters_json.trainMonths/predictionMonths' },
          400
        );
      }
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.completed_at, 'snapshot.completed_at');
      if (Date.parse(row.completed_at) < Date.parse(row.created_at)) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'Prediction run 完成时间不能早于创建时间。',
          { fieldName: 'snapshot.completed_at' },
          400
        );
      }
      assertDemoProjectionString(row.note, 'snapshot.note', { nonEmpty: true });
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, name, algorithm, status, target_energy_type_id,
          train_start_month, train_end_month, predict_start_month, predict_end_month,
          parameters_json, created_at, completed_at, note
        FROM prediction_runs WHERE id = ?`).get(entityPk) || null;
    }
  }),
  prediction_result: Object.freeze({
    entityType: 'prediction_result',
    tableName: 'prediction_results',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'prediction_run_id', 'energy_type_id', 'target_month', 'predicted_value',
      'predicted_unit', 'confidence_low', 'confidence_high', 'method_note', 'created_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.prediction_run_id, 'snapshot.prediction_run_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionMonth(row.target_month, 'snapshot.target_month');
      assertDemoProjectionFiniteNumber(row.predicted_value, 'snapshot.predicted_value', { min: 0 });
      assertDemoProjectionString(row.predicted_unit, 'snapshot.predicted_unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.confidence_low, 'snapshot.confidence_low', { min: 0 });
      assertDemoProjectionFiniteNumber(row.confidence_high, 'snapshot.confidence_high', { min: 0 });
      if (row.confidence_low > row.predicted_value
        || row.predicted_value > row.confidence_high) {
        throw createDemoOwnershipError(
          'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
          'Prediction result 置信区间必须包含预测值。',
          { fieldName: 'snapshot.confidence_low/confidence_high' },
          400
        );
      }
      assertPredictionResultMethodNote(row.method_note, row);
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, prediction_run_id, energy_type_id, target_month,
          predicted_value, predicted_unit, confidence_low, confidence_high,
          method_note, created_at
        FROM prediction_results WHERE id = ?`).get(entityPk) || null;
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
  }),
  carbon_factor: Object.freeze({
    entityType: 'carbon_factor',
    tableName: 'carbon_factors',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['carbon_factor']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_batch_id', 'source_row_number', 'energy_type_id', 'region',
      'factor_year', 'unit', 'factor_value', 'factor_unit', 'source', 'source_url',
      'effective_from', 'effective_to', 'is_active', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳因子来源批次与行号必须成对出现。', { fieldName: 'snapshot.source_batch_id/source_row_number' }, 400);
      }
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionString(row.region, 'snapshot.region', { nonEmpty: true });
      assertDemoProjectionInteger(row.factor_year, 'snapshot.factor_year', { nullable: true, min: 1900 });
      if (row.factor_year !== null && row.factor_year > 2200) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳因子年份超出固定范围。', { fieldName: 'snapshot.factor_year' }, 400);
      }
      assertDemoProjectionString(row.unit, 'snapshot.unit', { nonEmpty: true });
      assertDemoProjectionFiniteNumber(row.factor_value, 'snapshot.factor_value', { min: Number.MIN_VALUE });
      assertDemoProjectionString(row.factor_unit, 'snapshot.factor_unit', { nonEmpty: true });
      assertDemoProjectionString(row.source, 'snapshot.source', { nonEmpty: true });
      assertDemoProjectionString(row.source_url, 'snapshot.source_url', { nullable: true });
      if (row.effective_from !== null) assertDemoProjectionDate(row.effective_from, 'snapshot.effective_from');
      if (row.effective_to !== null) assertDemoProjectionDate(row.effective_to, 'snapshot.effective_to');
      if (row.effective_from !== null && row.effective_to !== null && row.effective_from > row.effective_to) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳因子有效期起始日期不得晚于结束日期。', { fieldName: 'snapshot.effective_from/effective_to' }, 400);
      }
      assertDemoProjectionInteger(row.is_active, 'snapshot.is_active', { min: 0 });
      if (![0, 1].includes(row.is_active)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳因子启用状态只允许 0 或 1。', { fieldName: 'snapshot.is_active' }, 400);
      }
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_batch_id, source_row_number, energy_type_id,
          region, factor_year, unit, factor_value, factor_unit, source, source_url,
          effective_from, effective_to, is_active, created_at, updated_at
        FROM carbon_factors WHERE id = ?`).get(entityPk) || null;
    }
  }),
  carbon_activity_record: Object.freeze({
    entityType: 'carbon_activity_record',
    tableName: 'carbon_activity_records',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze(['carbon_activity']),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'source_type', 'source_batch_id', 'source_row_number', 'energy_record_id',
      'activity_code', 'activity_code_key', 'supersedes_activity_id', 'superseded_by_activity_id',
      'emission_scope', 'activity_category', 'activity_category_key', 'organization_unit_id',
      'energy_type_id', 'start_wall_clock', 'end_wall_clock', 'source_timezone', 'start_utc',
      'end_utc', 'activity_value', 'activity_unit', 'factor_region', 'source_reference',
      'evidence_reference', 'note', 'duplicate_key', 'record_status', 'void_reason',
      'voided_at', 'voided_by', 'created_by', 'created_at', 'updated_at'
    ]),
    validateProjectionRow(row) {
      assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
      assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['independent_activity', 'energy_record']);
      assertDemoProjectionInteger(row.source_batch_id, 'snapshot.source_batch_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.source_row_number, 'snapshot.source_row_number', { nullable: true, min: 1 });
      if ((row.source_batch_id === null) !== (row.source_row_number === null)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳活动来源批次与行号必须成对出现。', { fieldName: 'snapshot.source_batch_id/source_row_number' }, 400);
      }
      assertDemoProjectionInteger(row.energy_record_id, 'snapshot.energy_record_id', { nullable: true, min: 1 });
      if ((row.source_type === 'independent_activity') !== (row.energy_record_id === null)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳活动来源类型与能耗记录引用不一致。', { fieldName: 'snapshot.source_type/energy_record_id' }, 400);
      }
      ['activity_code', 'activity_code_key', 'activity_category', 'activity_category_key',
        'activity_unit', 'factor_region', 'source_reference'].forEach((fieldName) => {
        assertDemoProjectionString(row[fieldName], `snapshot.${fieldName}`, { nonEmpty: true });
      });
      assertDemoProjectionInteger(row.supersedes_activity_id, 'snapshot.supersedes_activity_id', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.superseded_by_activity_id, 'snapshot.superseded_by_activity_id', { nullable: true, min: 1 });
      assertDemoProjectionEnum(row.emission_scope, 'snapshot.emission_scope', ['scope_1', 'scope_2', 'scope_3']);
      assertDemoProjectionInteger(row.organization_unit_id, 'snapshot.organization_unit_id', { min: 1 });
      assertDemoProjectionInteger(row.energy_type_id, 'snapshot.energy_type_id', { min: 1 });
      assertDemoProjectionWallClockMinute(row.start_wall_clock, 'snapshot.start_wall_clock');
      assertDemoProjectionWallClockMinute(row.end_wall_clock, 'snapshot.end_wall_clock');
      assertDemoProjectionTimeZone(row.source_timezone, 'snapshot.source_timezone');
      assertDemoProjectionUtcIso(row.start_utc, 'snapshot.start_utc');
      assertDemoProjectionUtcIso(row.end_utc, 'snapshot.end_utc');
      if (Date.parse(row.start_utc) >= Date.parse(row.end_utc)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳活动开始时间必须早于结束时间。', { fieldName: 'snapshot.start_utc/end_utc' }, 400);
      }
      assertDemoProjectionFiniteNumber(row.activity_value, 'snapshot.activity_value', { min: 0 });
      assertDemoProjectionString(row.evidence_reference, 'snapshot.evidence_reference', { nullable: true });
      assertDemoProjectionString(row.note, 'snapshot.note', { nullable: true });
      if (typeof row.duplicate_key !== 'string' || !/^[a-f0-9]{64}$/.test(row.duplicate_key)) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳活动重复键必须是固定 SHA-256 文本。', { fieldName: 'snapshot.duplicate_key' }, 400);
      }
      assertDemoProjectionEnum(row.record_status, 'snapshot.record_status', ['active', 'superseded', 'void']);
      assertDemoProjectionString(row.void_reason, 'snapshot.void_reason', { nullable: true });
      assertDemoProjectionUtcIso(row.voided_at, 'snapshot.voided_at', { nullable: true });
      assertDemoProjectionInteger(row.voided_by, 'snapshot.voided_by', { nullable: true, min: 1 });
      assertDemoProjectionInteger(row.created_by, 'snapshot.created_by', { nullable: true, min: 1 });
      if ((row.record_status === 'active' && row.superseded_by_activity_id !== null)
        || (row.record_status === 'superseded' && row.superseded_by_activity_id === null)
        || (row.record_status !== 'void' && (row.void_reason !== null || row.voided_at !== null || row.voided_by !== null))) {
        throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳活动生命周期字段与状态不一致。', { fieldName: 'snapshot.record_status' }, 400);
      }
      assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
      assertDemoProjectionUtcMilliseconds(row.updated_at, 'snapshot.updated_at');
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, source_type, source_batch_id, source_row_number, energy_record_id,
          activity_code, activity_code_key, supersedes_activity_id, superseded_by_activity_id,
          emission_scope, activity_category, activity_category_key, organization_unit_id,
          energy_type_id, start_wall_clock, end_wall_clock, source_timezone, start_utc, end_utc,
          activity_value, activity_unit, factor_region, source_reference, evidence_reference,
          note, duplicate_key, record_status, void_reason, voided_at, voided_by, created_by,
          created_at, updated_at
        FROM carbon_activity_records WHERE id = ?`).get(entityPk) || null;
    }
  }),
  carbon_calculation_run: Object.freeze({
    entityType: 'carbon_calculation_run',
    tableName: 'carbon_calculation_runs',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'run_code', 'snapshot_schema_version', 'source_type', 'status',
      'calculation_method', 'start_utc', 'end_utc', 'activity_filter_json',
      'actor_snapshot_json', 'activity_snapshot_digest', 'activity_count', 'result_count',
      'calculated_count', 'factor_missing_count', 'emission_totals_json', 'created_by',
      'started_at', 'completed_at', 'created_at'
    ]),
    validateProjectionRow(row) {
      assertCarbonCalculationRunProjection(row);
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, run_code, snapshot_schema_version, source_type, status,
          calculation_method, start_utc, end_utc, activity_filter_json, actor_snapshot_json,
          activity_snapshot_digest, activity_count, result_count, calculated_count,
          factor_missing_count, emission_totals_json, created_by, started_at, completed_at,
          created_at
        FROM carbon_calculation_runs WHERE id = ?`).get(entityPk) || null;
    }
  }),
  carbon_accounting_result: Object.freeze({
    entityType: 'carbon_accounting_result',
    tableName: 'carbon_accounting_results',
    primaryKeyColumn: 'id',
    expectedImportTypes: Object.freeze([]),
    projectionVersion: 'demo-entity-snapshot:v1',
    projectionFields: Object.freeze([
      'id', 'calculation_run_id', 'snapshot_schema_version', 'source_type',
      'activity_record_id', 'carbon_factor_id', 'emission_scope', 'activity_category',
      'organization_unit_id', 'energy_type_id', 'activity_start_wall_clock',
      'activity_end_wall_clock', 'activity_start_utc', 'activity_end_utc', 'activity_value',
      'activity_unit', 'requested_region', 'factor_year', 'factor_value', 'factor_unit',
      'emission_value', 'emission_unit', 'status', 'missing_reason', 'calculation_basis',
      'match_priority', 'activity_snapshot_json', 'organization_snapshot_json',
      'energy_type_snapshot_json', 'factor_snapshot_json', 'matching_snapshot_json',
      'formula_snapshot_json', 'created_at'
    ]),
    validateProjectionRow(row) {
      assertCarbonAccountingResultProjection(row);
    },
    readProjection(db, entityPk) {
      return db.prepare(`SELECT id, calculation_run_id, snapshot_schema_version, source_type,
          activity_record_id, carbon_factor_id, emission_scope, activity_category,
          organization_unit_id, energy_type_id, activity_start_wall_clock,
          activity_end_wall_clock, activity_start_utc, activity_end_utc, activity_value,
          activity_unit, requested_region, factor_year, factor_value, factor_unit,
          emission_value, emission_unit, status, missing_reason, calculation_basis,
          match_priority, activity_snapshot_json, organization_snapshot_json,
          energy_type_snapshot_json, factor_snapshot_json, matching_snapshot_json,
          formula_snapshot_json, created_at
        FROM carbon_accounting_results WHERE id = ?`).get(entityPk) || null;
    }
  })
});

/** 解析碳核算版本化 JSON 快照，并固定 envelope 与 payload 字段集合。 */
function parseCarbonAccountingSnapshotEnvelope(value, fieldName, payloadName, payloadFields) {
  const envelope = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(value, fieldName),
    fieldName,
    ['version', payloadName]
  );
  assertDemoProjectionInteger(envelope.version, `${fieldName}.version`, { min: 1 });
  if (envelope.version !== 1) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID',
      `${fieldName}.version 必须是正式碳核算快照版本 1。`,
      { fieldName: `${fieldName}.version`, value: envelope.version },
      400
    );
  }
  if (!envelope[payloadName] || Array.isArray(envelope[payloadName])
    || typeof envelope[payloadName] !== 'object'
    || Object.getPrototypeOf(envelope[payloadName]) !== Object.prototype) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID',
      `${fieldName}.${payloadName} 必须是严格 JSON object。`,
      { fieldName: `${fieldName}.${payloadName}` },
      400
    );
  }
  assertStrictDemoProjectionJsonFields(
    envelope[payloadName],
    `${fieldName}.${payloadName}`,
    payloadFields
  );
  normalizeStrictJsonValue(envelope[payloadName], `${fieldName}.${payloadName}`);
  return envelope[payloadName];
}

/** 校验 exact 碳核算运行 projection 与服务端固定筛选、actor 和汇总结构。 */
function assertCarbonCalculationRunProjection(row) {
  assertDemoProjectionInteger(row.id, 'snapshot.id', { min: 1 });
  assertDemoProjectionString(row.run_code, 'snapshot.run_code', { nonEmpty: true });
  assertDemoProjectionInteger(row.snapshot_schema_version, 'snapshot.snapshot_schema_version', { min: 1 });
  if (row.snapshot_schema_version !== 1) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行快照版本无效。', { fieldName: 'snapshot.snapshot_schema_version' }, 400);
  }
  assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['independent_activity']);
  assertDemoProjectionEnum(row.status, 'snapshot.status', ['completed']);
  assertDemoProjectionEnum(row.calculation_method, 'snapshot.calculation_method', ['standard-factor']);
  assertDemoProjectionUtcSecond(row.start_utc, 'snapshot.start_utc');
  assertDemoProjectionUtcSecond(row.end_utc, 'snapshot.end_utc');
  if (Date.parse(row.start_utc) >= Date.parse(row.end_utc)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行开始时间必须早于结束时间。', { fieldName: 'snapshot.start_utc/end_utc' }, 400);
  }
  const filterEnvelope = parseStrictDemoProjectionJsonObject(
    row.activity_filter_json,
    'snapshot.activity_filter_json'
  );
  assertStrictDemoProjectionJsonFields(filterEnvelope, 'snapshot.activity_filter_json', [
    'version', 'sourceType', 'recordStatus', 'interval', 'selectionMode',
    'usesFullActivityValue', 'overlapProration', 'maxActivities'
  ]);
  if (!filterEnvelope.interval || Array.isArray(filterEnvelope.interval)
    || typeof filterEnvelope.interval !== 'object'
    || Object.getPrototypeOf(filterEnvelope.interval) !== Object.prototype) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID', '碳核算运行 interval 必须是严格 JSON object。', { fieldName: 'snapshot.activity_filter_json.interval' }, 400);
  }
  const filter = assertStrictDemoProjectionJsonFields(
    filterEnvelope.interval,
    'snapshot.activity_filter_json.interval',
    ['startUtc', 'endUtc', 'semantics', 'positiveOverlapOnly']
  );
  assertDemoProjectionInteger(filterEnvelope.version, 'snapshot.activity_filter_json.version', { min: 1 });
  if (filterEnvelope.version !== 1) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行 exact activity filter 版本无效。', { fieldName: 'snapshot.activity_filter_json.version' }, 400);
  }
  assertDemoProjectionEnum(filterEnvelope.sourceType, 'snapshot.activity_filter_json.sourceType', ['independent_activity']);
  assertDemoProjectionEnum(filterEnvelope.recordStatus, 'snapshot.activity_filter_json.recordStatus', ['active']);
  assertDemoProjectionEnum(filterEnvelope.selectionMode, 'snapshot.activity_filter_json.selectionMode', ['server-owned-exact-demo-scope']);
  if (filter.startUtc !== row.start_utc || filter.endUtc !== row.end_utc
    || filter.semantics !== 'server-derived-exact-activity-bounds'
    || filter.positiveOverlapOnly !== false
    || filterEnvelope.usesFullActivityValue !== true
    || filterEnvelope.overlapProration !== false
    || filterEnvelope.maxActivities !== 5000) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行 exact activity filter 与持久事实不一致。', { fieldName: 'snapshot.activity_filter_json' }, 400);
  }
  assertDemoProjectionUtcSecond(filter.startUtc, 'snapshot.activity_filter_json.interval.startUtc');
  assertDemoProjectionUtcSecond(filter.endUtc, 'snapshot.activity_filter_json.interval.endUtc');
  const actor = parseCarbonAccountingSnapshotEnvelope(
    row.actor_snapshot_json,
    'snapshot.actor_snapshot_json',
    'actor',
    ['userId', 'username', 'displayName', 'ip']
  );
  assertDemoProjectionInteger(actor.userId, 'snapshot.actor_snapshot_json.actor.userId', { nullable: true, min: 1 });
  ['username', 'displayName', 'ip'].forEach((fieldName) => {
    assertDemoProjectionString(actor[fieldName], `snapshot.actor_snapshot_json.actor.${fieldName}`, { nullable: true });
  });
  if (actor.userId !== row.created_by) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行 actor 与 created_by 不一致。', { fieldName: 'snapshot.actor_snapshot_json.actor.userId' }, 400);
  }
  if (typeof row.activity_snapshot_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.activity_snapshot_digest)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行活动摘要必须是小写 SHA-256。', { fieldName: 'snapshot.activity_snapshot_digest' }, 400);
  }
  ['activity_count', 'result_count', 'calculated_count', 'factor_missing_count'].forEach((fieldName) => {
    assertDemoProjectionInteger(row[fieldName], `snapshot.${fieldName}`, { min: 0 });
  });
  if (row.activity_count < 1 || row.activity_count > 5000
    || row.result_count !== row.activity_count
    || row.calculated_count + row.factor_missing_count !== row.result_count) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行计数不符合 exact 闭包。', { fieldName: 'snapshot.activity_count/result_count' }, 400);
  }
  const totalsEnvelope = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(row.emission_totals_json, 'snapshot.emission_totals_json'),
    'snapshot.emission_totals_json',
    ['version', 'totals']
  );
  if (totalsEnvelope.version !== 1 || !Array.isArray(totalsEnvelope.totals)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID', '碳核算汇总必须使用版本 1 的 totals 数组。', { fieldName: 'snapshot.emission_totals_json' }, 400);
  }
  let totalCalculatedCount = 0;
  const totalUnits = new Set();
  totalsEnvelope.totals.forEach((total, index) => {
    if (!total || Array.isArray(total) || typeof total !== 'object'
      || Object.getPrototypeOf(total) !== Object.prototype) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID', '碳核算汇总项必须是严格 JSON object。', { index }, 400);
    }
    assertStrictDemoProjectionJsonFields(total, `snapshot.emission_totals_json.totals[${index}]`, [
      'emissionUnit', 'totalEmissionValue', 'calculatedCount'
    ]);
    assertDemoProjectionString(total.emissionUnit, `snapshot.emission_totals_json.totals[${index}].emissionUnit`, { nonEmpty: true });
    assertDemoProjectionFiniteNumber(total.totalEmissionValue, `snapshot.emission_totals_json.totals[${index}].totalEmissionValue`, { min: 0 });
    assertDemoProjectionInteger(total.calculatedCount, `snapshot.emission_totals_json.totals[${index}].calculatedCount`, { min: 1 });
    if (totalUnits.has(total.emissionUnit)) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID', '碳核算汇总单位不得重复。', { emissionUnit: total.emissionUnit }, 400);
    }
    totalUnits.add(total.emissionUnit);
    totalCalculatedCount += total.calculatedCount;
  });
  if (totalCalculatedCount !== row.calculated_count) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算汇总计数与运行 calculated_count 不一致。', { fieldName: 'snapshot.emission_totals_json' }, 400);
  }
  assertDemoProjectionInteger(row.created_by, 'snapshot.created_by', { nullable: true, min: 1 });
  assertDemoProjectionUtcMilliseconds(row.started_at, 'snapshot.started_at');
  assertDemoProjectionUtcMilliseconds(row.completed_at, 'snapshot.completed_at');
  assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
  if (Date.parse(row.started_at) > Date.parse(row.completed_at)
    || row.completed_at !== row.created_at) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算运行审计时间线不一致。', { fieldName: 'snapshot.started_at/completed_at/created_at' }, 400);
  }
}

/** 校验碳核算活动快照全部字段类型和值域。 */
function assertCarbonActivitySnapshotFields(activity, fieldName) {
  ['id', 'sourceBatchId', 'sourceRowNumber', 'organizationUnitId', 'energyTypeId'].forEach((key) => {
    assertDemoProjectionInteger(activity[key], `${fieldName}.${key}`, { min: 1 });
  });
  ['energyRecordId', 'supersedesActivityId', 'supersededByActivityId', 'voidedBy', 'createdBy'].forEach((key) => {
    assertDemoProjectionInteger(activity[key], `${fieldName}.${key}`, { nullable: true, min: 1 });
  });
  assertDemoProjectionEnum(activity.sourceType, `${fieldName}.sourceType`, ['independent_activity']);
  if (activity.energyRecordId !== null) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'exact 活动快照不得引用 energy_record。', { fieldName: `${fieldName}.energyRecordId` }, 400);
  }
  ['activityCode', 'activityCodeKey', 'activityCategory', 'activityCategoryKey', 'activityUnit',
    'factorRegion', 'sourceReference', 'duplicateKey'].forEach((key) => {
    assertDemoProjectionString(activity[key], `${fieldName}.${key}`, { nonEmpty: true });
  });
  ['evidenceReference', 'note', 'voidReason'].forEach((key) => {
    assertDemoProjectionString(activity[key], `${fieldName}.${key}`, { nullable: true });
  });
  assertDemoProjectionEnum(activity.emissionScope, `${fieldName}.emissionScope`, ['scope_1', 'scope_2', 'scope_3']);
  assertDemoProjectionWallClockMinute(activity.startWallClock, `${fieldName}.startWallClock`);
  assertDemoProjectionWallClockMinute(activity.endWallClock, `${fieldName}.endWallClock`);
  assertDemoProjectionTimeZone(activity.sourceTimezone, `${fieldName}.sourceTimezone`);
  assertDemoProjectionUtcIso(activity.startUtc, `${fieldName}.startUtc`);
  assertDemoProjectionUtcIso(activity.endUtc, `${fieldName}.endUtc`);
  assertDemoProjectionFiniteNumber(activity.activityValue, `${fieldName}.activityValue`, { min: 0 });
  if (!/^[a-f0-9]{64}$/.test(activity.duplicateKey)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '活动快照 duplicateKey 必须是小写 SHA-256。', { fieldName: `${fieldName}.duplicateKey` }, 400);
  }
  assertDemoProjectionEnum(activity.recordStatus, `${fieldName}.recordStatus`, ['active']);
  if (activity.supersededByActivityId !== null || activity.voidReason !== null
    || activity.voidedAt !== null || activity.voidedBy !== null) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'active 活动快照生命周期字段无效。', { fieldName: `${fieldName}.recordStatus` }, 400);
  }
  assertDemoProjectionUtcIso(activity.voidedAt, `${fieldName}.voidedAt`, { nullable: true });
  assertDemoProjectionUtcMilliseconds(activity.createdAt, `${fieldName}.createdAt`);
  assertDemoProjectionUtcMilliseconds(activity.updatedAt, `${fieldName}.updatedAt`);
}

/** 校验碳核算组织快照全部字段类型。 */
function assertCarbonOrganizationSnapshotFields(organization, fieldName) {
  assertDemoProjectionInteger(organization.id, `${fieldName}.id`, { min: 1 });
  assertDemoProjectionInteger(organization.parentId, `${fieldName}.parentId`, { nullable: true, min: 1 });
  ['unitCode', 'unitName', 'unitPath', 'unitType', 'status'].forEach((key) => {
    assertDemoProjectionString(organization[key], `${fieldName}.${key}`, { nonEmpty: true });
  });
  assertDemoProjectionFiniteNumber(organization.area, `${fieldName}.area`, { nullable: true, min: 0 });
  assertDemoProjectionInteger(organization.sortOrder, `${fieldName}.sortOrder`);
  assertDemoProjectionString(organization.remark, `${fieldName}.remark`, { nullable: true });
  assertDemoProjectionUtcMilliseconds(organization.createdAt, `${fieldName}.createdAt`);
  assertDemoProjectionUtcMilliseconds(organization.updatedAt, `${fieldName}.updatedAt`);
}

/** 校验碳核算能源类型快照全部字段类型。 */
function assertCarbonEnergyTypeSnapshotFields(energyType, fieldName) {
  assertDemoProjectionInteger(energyType.id, `${fieldName}.id`, { min: 1 });
  ['code', 'name', 'category', 'defaultUnit', 'standardUnit'].forEach((key) => {
    assertDemoProjectionString(energyType[key], `${fieldName}.${key}`, { nonEmpty: true });
  });
  ['carbonFactorRequired', 'isActive'].forEach((key) => {
    assertDemoProjectionInteger(energyType[key], `${fieldName}.${key}`, { min: 0 });
    if (![0, 1].includes(energyType[key])) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '能源类型布尔整数只允许 0 或 1。', { fieldName: `${fieldName}.${key}` }, 400);
    }
  });
  assertDemoProjectionInteger(energyType.displayOrder, `${fieldName}.displayOrder`);
  assertDemoProjectionUtcMilliseconds(energyType.createdAt, `${fieldName}.createdAt`);
  assertDemoProjectionUtcMilliseconds(energyType.updatedAt, `${fieldName}.updatedAt`);
}

/** 校验碳核算因子快照全部字段类型。 */
function assertCarbonFactorSnapshotFields(factor, fieldName) {
  ['id', 'sourceBatchId', 'sourceRowNumber', 'energyTypeId'].forEach((key) => {
    assertDemoProjectionInteger(factor[key], `${fieldName}.${key}`, { min: 1 });
  });
  assertDemoProjectionInteger(factor.factorYear, `${fieldName}.factorYear`, { nullable: true, min: 1 });
  if (factor.factorYear !== null && factor.factorYear > 9999) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '因子快照年份超出固定范围。', { fieldName: `${fieldName}.factorYear` }, 400);
  }
  ['region', 'unit', 'factorUnit', 'source'].forEach((key) => {
    assertDemoProjectionString(factor[key], `${fieldName}.${key}`, { nonEmpty: true });
  });
  assertDemoProjectionString(factor.sourceUrl, `${fieldName}.sourceUrl`, { nullable: true });
  assertDemoProjectionFiniteNumber(factor.factorValue, `${fieldName}.factorValue`, { min: Number.MIN_VALUE });
  if (factor.effectiveFrom !== null) assertDemoProjectionDate(factor.effectiveFrom, `${fieldName}.effectiveFrom`);
  if (factor.effectiveTo !== null) assertDemoProjectionDate(factor.effectiveTo, `${fieldName}.effectiveTo`);
  assertDemoProjectionInteger(factor.isActive, `${fieldName}.isActive`, { min: 0 });
  if (factor.isActive !== 1) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'exact 因子快照必须处于启用状态。', { fieldName: `${fieldName}.isActive` }, 400);
  }
  assertDemoProjectionUtcMilliseconds(factor.createdAt, `${fieldName}.createdAt`);
  assertDemoProjectionUtcMilliseconds(factor.updatedAt, `${fieldName}.updatedAt`);
}

/** 校验 exact 碳核算结果 projection、快照字段和 calculated/missing 分支闭包。 */
function assertCarbonAccountingResultProjection(row) {
  ['id', 'calculation_run_id', 'activity_record_id', 'organization_unit_id', 'energy_type_id'].forEach((fieldName) => {
    assertDemoProjectionInteger(row[fieldName], `snapshot.${fieldName}`, { min: 1 });
  });
  assertDemoProjectionInteger(row.snapshot_schema_version, 'snapshot.snapshot_schema_version', { min: 1 });
  if (row.snapshot_schema_version !== 1) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果快照版本无效。', { fieldName: 'snapshot.snapshot_schema_version' }, 400);
  }
  assertDemoProjectionEnum(row.source_type, 'snapshot.source_type', ['independent_activity']);
  assertDemoProjectionInteger(row.carbon_factor_id, 'snapshot.carbon_factor_id', { nullable: true, min: 1 });
  assertDemoProjectionEnum(row.emission_scope, 'snapshot.emission_scope', ['scope_1', 'scope_2', 'scope_3']);
  ['activity_category', 'activity_unit', 'requested_region', 'calculation_basis'].forEach((fieldName) => {
    assertDemoProjectionString(row[fieldName], `snapshot.${fieldName}`, { nonEmpty: true });
  });
  if (row.calculation_basis !== 'activity_value * factor_value') {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果计算基础无效。', { fieldName: 'snapshot.calculation_basis' }, 400);
  }
  assertDemoProjectionWallClockMinute(row.activity_start_wall_clock, 'snapshot.activity_start_wall_clock');
  assertDemoProjectionWallClockMinute(row.activity_end_wall_clock, 'snapshot.activity_end_wall_clock');
  assertDemoProjectionUtcIso(row.activity_start_utc, 'snapshot.activity_start_utc');
  assertDemoProjectionUtcIso(row.activity_end_utc, 'snapshot.activity_end_utc');
  if (Date.parse(row.activity_start_utc) >= Date.parse(row.activity_end_utc)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果活动开始时间必须早于结束时间。', { fieldName: 'snapshot.activity_start_utc/activity_end_utc' }, 400);
  }
  assertDemoProjectionFiniteNumber(row.activity_value, 'snapshot.activity_value', { min: 0 });
  assertDemoProjectionInteger(row.factor_year, 'snapshot.factor_year', { min: 1 });
  if (row.factor_year > 9999) throwDemoProjectionFieldTypeError('snapshot.factor_year', 'integer_1_9999', row.factor_year);
  ['factor_value', 'emission_value'].forEach((fieldName) => {
    assertDemoProjectionFiniteNumber(row[fieldName], `snapshot.${fieldName}`, { nullable: true, min: 0 });
  });
  ['factor_unit', 'emission_unit', 'missing_reason'].forEach((fieldName) => {
    assertDemoProjectionString(row[fieldName], `snapshot.${fieldName}`, { nullable: true });
  });
  assertDemoProjectionInteger(row.match_priority, 'snapshot.match_priority', { nullable: true, min: 1 });
  if (row.match_priority !== null && row.match_priority > 4) throwDemoProjectionFieldTypeError('snapshot.match_priority', 'integer_1_4', row.match_priority);
  assertDemoProjectionEnum(row.status, 'snapshot.status', ['calculated', 'factor_missing']);
  const calculated = row.status === 'calculated';
  if (calculated !== (row.carbon_factor_id !== null)
    || calculated !== (row.factor_value !== null)
    || calculated !== (row.factor_unit !== null)
    || calculated !== (row.emission_value !== null)
    || calculated !== (row.emission_unit !== null)
    || calculated !== (row.match_priority !== null)
    || calculated !== (row.factor_snapshot_json !== null)
    || calculated === (row.missing_reason !== null)) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果 calculated/factor_missing 字段闭包不一致。', { fieldName: 'snapshot.status' }, 400);
  }
  if (!calculated && row.missing_reason !== 'NO_ACTIVE_EXACT_UNIT_FACTOR') {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '缺因子结果原因码无效。', { fieldName: 'snapshot.missing_reason' }, 400);
  }
  const activity = parseCarbonAccountingSnapshotEnvelope(row.activity_snapshot_json, 'snapshot.activity_snapshot_json', 'activity', [
    'id', 'sourceType', 'sourceBatchId', 'sourceRowNumber', 'energyRecordId', 'activityCode',
    'activityCodeKey', 'supersedesActivityId', 'supersededByActivityId', 'emissionScope',
    'activityCategory', 'activityCategoryKey', 'organizationUnitId', 'energyTypeId',
    'startWallClock', 'endWallClock', 'sourceTimezone', 'startUtc', 'endUtc', 'activityValue',
    'activityUnit', 'factorRegion', 'sourceReference', 'evidenceReference', 'note', 'duplicateKey',
    'recordStatus', 'voidReason', 'voidedAt', 'voidedBy', 'createdBy', 'createdAt', 'updatedAt'
  ]);
  assertCarbonActivitySnapshotFields(activity, 'snapshot.activity_snapshot_json.activity');
  if (activity.id !== row.activity_record_id || activity.sourceType !== row.source_type
    || activity.emissionScope !== row.emission_scope || activity.activityCategory !== row.activity_category
    || activity.organizationUnitId !== row.organization_unit_id || activity.energyTypeId !== row.energy_type_id
    || activity.startWallClock !== row.activity_start_wall_clock || activity.endWallClock !== row.activity_end_wall_clock
    || activity.startUtc !== row.activity_start_utc || activity.endUtc !== row.activity_end_utc
    || activity.activityValue !== row.activity_value || activity.activityUnit !== row.activity_unit
    || activity.factorRegion !== row.requested_region || activity.recordStatus !== 'active') {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果活动快照与筛选列不一致。', { fieldName: 'snapshot.activity_snapshot_json' }, 400);
  }
  const organization = parseCarbonAccountingSnapshotEnvelope(row.organization_snapshot_json, 'snapshot.organization_snapshot_json', 'organization', [
    'id', 'parentId', 'unitCode', 'unitName', 'unitPath', 'unitType', 'area', 'sortOrder',
    'status', 'remark', 'createdAt', 'updatedAt'
  ]);
  const energyType = parseCarbonAccountingSnapshotEnvelope(row.energy_type_snapshot_json, 'snapshot.energy_type_snapshot_json', 'energyType', [
    'id', 'code', 'name', 'category', 'defaultUnit', 'standardUnit', 'carbonFactorRequired',
    'isActive', 'displayOrder', 'createdAt', 'updatedAt'
  ]);
  assertCarbonOrganizationSnapshotFields(
    organization,
    'snapshot.organization_snapshot_json.organization'
  );
  assertCarbonEnergyTypeSnapshotFields(
    energyType,
    'snapshot.energy_type_snapshot_json.energyType'
  );
  if (organization.id !== row.organization_unit_id || energyType.id !== row.energy_type_id) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果组织或能源类型快照与筛选列不一致。', { fieldName: 'snapshot.organization_snapshot_json/energy_type_snapshot_json' }, 400);
  }
  if (calculated) {
    const factor = parseCarbonAccountingSnapshotEnvelope(row.factor_snapshot_json, 'snapshot.factor_snapshot_json', 'factor', [
      'id', 'sourceBatchId', 'sourceRowNumber', 'energyTypeId', 'region', 'factorYear', 'unit',
      'factorValue', 'factorUnit', 'source', 'sourceUrl', 'effectiveFrom', 'effectiveTo', 'isActive',
      'createdAt', 'updatedAt'
    ]);
    assertCarbonFactorSnapshotFields(factor, 'snapshot.factor_snapshot_json.factor');
    if (factor.id !== row.carbon_factor_id || factor.energyTypeId !== row.energy_type_id
      || factor.factorValue !== row.factor_value || factor.factorUnit !== row.factor_unit
      || factor.isActive !== 1) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果因子快照与筛选列不一致。', { fieldName: 'snapshot.factor_snapshot_json' }, 400);
    }
  }
  const matching = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(row.matching_snapshot_json, 'snapshot.matching_snapshot_json'),
    'snapshot.matching_snapshot_json',
    ['version', 'policy', 'request', 'selected', 'missing']
  );
  if (matching.version !== 1) throwDemoProjectionFieldTypeError('snapshot.matching_snapshot_json.version', 'integer_1', matching.version);
  if (!matching.policy || Array.isArray(matching.policy) || typeof matching.policy !== 'object'
    || Object.getPrototypeOf(matching.policy) !== Object.prototype
    || !matching.request || Array.isArray(matching.request) || typeof matching.request !== 'object'
    || Object.getPrototypeOf(matching.request) !== Object.prototype) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_JSON_INVALID', '碳核算匹配 policy/request 必须是严格 JSON object。', { fieldName: 'snapshot.matching_snapshot_json' }, 400);
  }
  assertStrictDemoProjectionJsonFields(matching.policy, 'snapshot.matching_snapshot_json.policy', [
    'activeOnly', 'exactEnergyType', 'exactActivityUnit', 'effectiveRangeParticipates',
    'priority', 'tieBreaker'
  ]);
  if (matching.policy.activeOnly !== true || matching.policy.exactEnergyType !== true
    || matching.policy.exactActivityUnit !== true
    || matching.policy.effectiveRangeParticipates !== false
    || matching.policy.tieBreaker !== 'factor_id_desc'
    || !Array.isArray(matching.policy.priority)
    || sha256Stable(matching.policy.priority) !== sha256Stable([
      'requested_region+requested_year',
      'default_region+requested_year',
      'requested_region+generic_year',
      'default_region+generic_year'
    ])) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算匹配 policy 与正式四级优先级不一致。', { fieldName: 'snapshot.matching_snapshot_json.policy' }, 400);
  }
  assertStrictDemoProjectionJsonFields(matching.request, 'snapshot.matching_snapshot_json.request', [
    'requestedRegion', 'factorYear', 'energyTypeId', 'activityUnit'
  ]);
  if (matching.request.requestedRegion !== row.requested_region
    || matching.request.factorYear !== row.factor_year
    || matching.request.energyTypeId !== row.energy_type_id
    || matching.request.activityUnit !== row.activity_unit) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算匹配 request 与结果筛选列不一致。', { fieldName: 'snapshot.matching_snapshot_json.request' }, 400);
  }
  if (calculated) {
    if (!matching.selected || Array.isArray(matching.selected)
      || typeof matching.selected !== 'object'
      || Object.getPrototypeOf(matching.selected) !== Object.prototype
      || matching.missing !== null) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'calculated 匹配快照必须只包含 selected。', { fieldName: 'snapshot.matching_snapshot_json' }, 400);
    }
    assertStrictDemoProjectionJsonFields(matching.selected, 'snapshot.matching_snapshot_json.selected', [
      'factorId', 'matchPriority'
    ]);
    if (matching.selected.factorId !== row.carbon_factor_id
      || matching.selected.matchPriority !== row.match_priority) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果匹配快照与 calculated 结果不一致。', { fieldName: 'snapshot.matching_snapshot_json' }, 400);
    }
  } else {
    if (matching.selected !== null || !matching.missing || Array.isArray(matching.missing)
      || typeof matching.missing !== 'object'
      || Object.getPrototypeOf(matching.missing) !== Object.prototype) {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', 'factor_missing 匹配快照必须只包含 missing。', { fieldName: 'snapshot.matching_snapshot_json' }, 400);
    }
    assertStrictDemoProjectionJsonFields(matching.missing, 'snapshot.matching_snapshot_json.missing', [
      'code', 'message'
    ]);
    if (matching.missing.code !== row.missing_reason
      || matching.missing.message !== '未找到活动能源类型、活动单位、请求地区和来源墙钟年份对应的启用碳因子。') {
      throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果匹配快照与缺因子结果不一致。', { fieldName: 'snapshot.matching_snapshot_json' }, 400);
    }
  }
  const formula = assertStrictDemoProjectionJsonFields(
    parseStrictDemoProjectionJsonObject(row.formula_snapshot_json, 'snapshot.formula_snapshot_json'),
    'snapshot.formula_snapshot_json',
    ['version', 'expression', 'usesFullActivityValue', 'overlapProration', 'activityValue',
      'activityUnit', 'factorValue', 'factorUnit', 'emissionValue', 'emissionUnit', 'decimalPlaces']
  );
  if (formula.version !== 1 || formula.expression !== 'round(activity_value * factor_value, 6)'
    || formula.usesFullActivityValue !== true || formula.overlapProration !== false
    || formula.activityValue !== row.activity_value || formula.activityUnit !== row.activity_unit
    || formula.factorValue !== row.factor_value || formula.factorUnit !== row.factor_unit
    || formula.emissionValue !== row.emission_value || formula.emissionUnit !== row.emission_unit
    || formula.decimalPlaces !== 6) {
    throw createDemoOwnershipError('DEMO_OWNERSHIP_SNAPSHOT_FIELD_VALUE_INVALID', '碳核算结果公式快照与筛选列不一致。', { fieldName: 'snapshot.formula_snapshot_json' }, 400);
  }
  assertDemoProjectionUtcMilliseconds(row.created_at, 'snapshot.created_at');
}

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

/** 校验 Artifact 07 managed direct intent 只能使用路由固定注入的 context 字段。 */
function requireManagedDirectImportContextIntent(demoContext) {
  assertExactPlainObjectFields(
    demoContext,
    ['artifactKey', 'handlerKey', 'token', 'userId'],
    'DEMO_MANAGED_DIRECT_CONTEXT_INTENT_INVALID',
    'Artifact 07 managed direct context 只能包含固定服务端字段。'
  );
  if (demoContext.artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
    || demoContext.handlerKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.handlerKey) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_CONTEXT_MISMATCH',
      'managed direct context 与 Artifact 07 固定 handler 不匹配。',
      { artifactKey: demoContext.artifactKey || null },
      409
    );
  }
  return demoContext;
}

/** 读取 Artifact 07 context 的固定内部字段，不返回 token hash。 */
function readManagedDirectContextByToken(state, token) {
  const tokenHash = hashDemoContextToken(validateDemoContextToken(token));
  return state.privateDb.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
    FROM demo_import_contexts WHERE token_hash = ?`).get(tokenHash) || null;
}

/** Artifact 07 没有公开 preview 权限，direct issued 校验固定使用 execute 权限。 */
function assertManagedDirectExecutePermission(state, userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError('UNAUTHENTICATED', '请先登录。', { statusCode: 401 });
  }
  const actor = state.privateDb.prepare("SELECT id FROM sys_users WHERE id = ? AND status = 'active'").get(userId);
  if (!actor) throw new AppError('UNAUTHENTICATED', '账号不存在或已停用。', { statusCode: 401 });
  const artifact = requireDemoArtifactHandler(
    DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey,
    DEMO_MANAGED_DIRECT_IMPORT_BINDING.handlerKey
  );
  const authorized = state.privateDb.prepare(`SELECT 1
    FROM sys_user_roles ur
    JOIN sys_roles r ON r.id = ur.role_id
    LEFT JOIN sys_role_menus rm ON rm.role_id = r.id
    LEFT JOIN sys_menus m ON m.id = rm.menu_id
    WHERE ur.user_id = ? AND r.status = 'active'
      AND (r.role_code = 'super_admin'
        OR (m.status = 'active' AND m.permission_code = ?))
    LIMIT 1`).get(userId, artifact.permissions.execute);
  if (!authorized) {
    throw new AppError('FORBIDDEN', '当前账号没有执行该演示数据操作的领域权限。', {
      statusCode: 403,
      details: { requiredPermissions: [artifact.permissions.execute], mode: 'all' }
    });
  }
  return artifact;
}

/** 在 active ownership scope 内验证 Artifact 07 issued context 及下载原字节 SHA。 */
function validateManagedDirectIssuedContext(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['demoContext', 'uploadFileSha256'],
    'DEMO_MANAGED_DIRECT_CONTEXT_INTENT_INVALID',
    'Artifact 07 managed direct issued 校验 intent 字段无效。'
  );
  const demoContext = requireManagedDirectImportContextIntent(intent.demoContext);
  const uploadFileSha256 = validateSha256(intent.uploadFileSha256, 'uploadFileSha256');
  const artifact = assertManagedDirectExecutePermission(state, demoContext.userId);
  const runtime = assertDemoRuntimeEnabled({ db: state.privateDb });
  const context = readManagedDirectContextByToken(state, demoContext.token);
  if (!context) {
    throw new AppError('DEMO_CONTEXT_NOT_FOUND', '演示 context 不存在或已失效。', { statusCode: 409 });
  }
  const expiryMs = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
    throw new AppError('DEMO_CONTEXT_EXPIRED', '演示 context 已过期。', { statusCode: 410 });
  }
  const run = requireDemoDatasetRun(state.privateDb, context.runId);
  const bindingsMatch = context.status === 'issued'
    && context.issuedToUserId === demoContext.userId
    && context.artifactKey === artifact.artifactKey
    && context.handlerKey === artifact.handlerKey
    && context.runtimeEpoch === runtime.runtimeEpoch
    && context.datasetId === run.datasetId
    && context.manifestVersion === run.manifestVersion
    && context.manifestDigest === run.manifestDigest
    && context.uploadFileSha256 === null
    && context.previewDigest === null;
  if (!bindingsMatch) {
    throw new AppError('DEMO_CONTEXT_BINDING_MISMATCH', '演示 context 与当前 direct execute 请求绑定不一致。', {
      statusCode: 409,
      details: { artifactKey: artifact.artifactKey, phase: 'direct-execute' }
    });
  }
  if (context.artifactFileSha256 !== uploadFileSha256) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_FILE_SHA256_MISMATCH',
      'Artifact 07 上传文件与服务端签发 context 的下载原字节不一致。',
      { artifactKey: context.artifactKey },
      409
    );
  }
  return context;
}

/** 对 executed Artifact 07 context 执行严格终态回放；非 executed 状态返回 null。 */
function readManagedDirectTerminalReplay(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['demoContext', 'uploadFileSha256'],
    'DEMO_MANAGED_DIRECT_REPLAY_INTENT_INVALID',
    'Artifact 07 managed direct replay intent 字段无效。'
  );
  const demoContext = requireManagedDirectImportContextIntent(intent.demoContext);
  const uploadFileSha256 = validateSha256(intent.uploadFileSha256, 'uploadFileSha256');
  const tokenHash = hashDemoContextToken(validateDemoContextToken(demoContext.token));
  const contextRow = state.privateDb.prepare(`SELECT context_id AS contextId, status,
      run_id AS runId, issued_to_user_id AS issuedToUserId,
      artifact_file_sha256 AS artifactFileSha256, upload_file_sha256 AS uploadFileSha256,
      preview_digest AS previewDigest
    FROM demo_import_contexts WHERE token_hash = ?`).get(tokenHash);
  if (!contextRow || contextRow.status !== 'executed') return null;
  const bindingRows = state.privateDb.prepare(`SELECT rib.import_batch_id AS batchId,
      rib.batch_role AS batchRole, ib.import_type AS importType
    FROM demo_run_import_batches rib
    JOIN import_batches ib ON ib.id = rib.import_batch_id
    WHERE rib.context_id = ?
    ORDER BY rib.batch_role, rib.import_batch_id`).all(contextRow.contextId);
  if (bindingRows.length !== 1
    || bindingRows[0].batchRole !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole
    || bindingRows[0].importType !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_TERMINAL_BINDING_INVALID',
      'Artifact 07 已执行 context 缺少唯一可信 primary 批次绑定。',
      { contextId: contextRow.contextId },
      409
    );
  }
  const replay = validateDemoContextTerminalReplay({
    db: state.privateDb,
    ...demoContext,
    uploadFileSha256,
    previewDigest: validatePreviewAuditDigest(contextRow.previewDigest),
    batchBindings: bindingRows.map((binding) => ({
      batchId: Number(binding.batchId),
      batchRole: binding.batchRole,
      importType: binding.importType
    }))
  });
  if (contextRow.artifactFileSha256 !== uploadFileSha256
    || contextRow.uploadFileSha256 !== uploadFileSha256) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_FILE_SHA256_MISMATCH',
      'Artifact 07 终态回放文件 SHA 与 context 原始绑定不一致。',
      { artifactKey: DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey },
      409
    );
  }
  const replayBatch = replay.batches[0];
  verifyManagedDirectCompletedClosure(state, {
    batchId: Number(replayBatch.batchId),
    contextId: contextRow.contextId,
    runId: contextRow.runId,
    actorUserId: Number(contextRow.issuedToUserId),
    previewDigest: validatePreviewAuditDigest(contextRow.previewDigest),
    expectedContextStatus: 'executed'
  });
  return replayBatch;
}

/** 在 active ownership scope 内创建 Artifact 07 唯一 energy_record execute 批次。 */
function insertManagedDirectImportBatch(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['fieldMapping', 'file'],
    'DEMO_MANAGED_DIRECT_BATCH_INTENT_INVALID',
    'Artifact 07 managed direct 批次 intent 字段无效。'
  );
  assertExactPlainObjectFields(
    intent.file,
    ['fileSha256', 'fileSizeBytes', 'fileType', 'originalFilename', 'storedFilename'],
    'DEMO_MANAGED_DIRECT_BATCH_INTENT_INVALID',
    'Artifact 07 managed direct 文件 metadata 字段无效。'
  );
  const originalFilename = String(intent.file.originalFilename || '').trim();
  const storedFilename = String(intent.file.storedFilename || '').trim();
  const fileType = String(intent.file.fileType || '').trim().toLowerCase();
  const fileSizeBytes = Number(intent.file.fileSizeBytes);
  const fileSha256 = validateSha256(intent.file.fileSha256, 'fileSha256');
  if (!originalFilename || originalFilename.length > 1024
    || !storedFilename || storedFilename !== path.basename(storedFilename)
    || !['xlsx', 'xls', 'csv'].includes(fileType)
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 0) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_BATCH_METADATA_INVALID',
      'Artifact 07 managed direct 文件 metadata 无效。',
      null,
      400
    );
  }
  const fieldMappingJson = JSON.stringify(normalizeStrictJsonValue(intent.fieldMapping || {}, 'fieldMapping'));
  const now = new Date().toISOString();
  const result = state.privateDb.prepare(`INSERT INTO import_batches
    (import_type, original_filename, stored_filename, file_type, file_size_bytes, file_sha256,
      status, audit_phase, duplicate_strategy, field_mapping_json, started_at, created_at, updated_at)
    VALUES ('energy_record', ?, ?, ?, ?, ?, 'processing', 'execute', 'skip', ?, ?, ?, ?)`).run(
    originalFilename,
    storedFilename,
    fileType,
    fileSizeBytes,
    fileSha256,
    fieldMappingJson,
    now,
    now,
    now
  );
  return Number(result.lastInsertRowid);
}

/** 在 active ownership scope 内写入 Artifact 07 当前批次的真实错误或 warning 明细。 */
function insertManagedDirectImportIssue(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['batchId', 'errorCode', 'errorReason', 'fieldName', 'rawValue', 'rowNumber', 'severity'],
    'DEMO_MANAGED_DIRECT_ISSUE_INTENT_INVALID',
    'Artifact 07 managed direct issue intent 字段无效。'
  );
  const batchId = Number(intent.batchId);
  const rowNumber = Number(intent.rowNumber);
  const severity = String(intent.severity || '').trim();
  const errorCode = String(intent.errorCode || '').trim();
  const errorReason = String(intent.errorReason || '').trim();
  if (!Number.isSafeInteger(batchId) || batchId < 1
    || !Number.isSafeInteger(rowNumber) || rowNumber < 1
    || !['error', 'warning'].includes(severity)
    || !errorCode || !errorReason) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_ISSUE_INVALID',
      'Artifact 07 managed direct issue 内容无效。',
      null,
      400
    );
  }
  return state.privateDb.prepare(`INSERT INTO import_errors
    (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    batchId,
    rowNumber,
    intent.fieldName === null || intent.fieldName === undefined ? null : String(intent.fieldName),
    intent.rawValue === null || intent.rawValue === undefined ? null : String(intent.rawValue),
    errorCode,
    errorReason,
    severity
  ).changes;
}

/** 在 active ownership scope 内二次校验并把 Artifact 07 context 绑定到唯一 primary 批次。 */
function bindManagedDirectImportContext(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['batchId', 'demoContext', 'previewDigest', 'uploadFileSha256'],
    'DEMO_MANAGED_DIRECT_BIND_INTENT_INVALID',
    'Artifact 07 managed direct binding intent 字段无效。'
  );
  const context = validateManagedDirectIssuedContext(state, {
    demoContext: intent.demoContext,
    uploadFileSha256: intent.uploadFileSha256
  });
  const batchId = Number(intent.batchId);
  if (!Number.isSafeInteger(batchId) || batchId < 1) {
    throw createDemoOwnershipError('DEMO_MANAGED_DIRECT_BATCH_ID_INVALID', 'Artifact 07 批次主键无效。', null, 400);
  }
  const uploadFileSha256 = validateSha256(intent.uploadFileSha256, 'uploadFileSha256');
  const previewDigest = validatePreviewAuditDigest(intent.previewDigest);
  const previewedAt = new Date().toISOString();
  const update = state.privateDb.prepare(`UPDATE demo_import_contexts
    SET status = 'previewed', upload_file_sha256 = ?, preview_digest = ?, previewed_at = ?
    WHERE context_id = ? AND issued_to_user_id = ? AND status = 'issued'
      AND runtime_epoch = ? AND expires_at = ? AND run_id = ? AND dataset_id = ?
      AND manifest_version = ? AND manifest_digest = ? AND artifact_key = ? AND handler_key = ?
      AND artifact_file_sha256 = ? AND upload_file_sha256 IS NULL AND preview_digest IS NULL`).run(
    uploadFileSha256,
    previewDigest,
    previewedAt,
    context.contextId,
    context.issuedToUserId,
    context.runtimeEpoch,
    context.expiresAt,
    context.runId,
    context.datasetId,
    context.manifestVersion,
    context.manifestDigest,
    context.artifactKey,
    context.handlerKey,
    uploadFileSha256
  );
  if (update.changes !== 1) {
    throw new AppError('DEMO_CONTEXT_STATE_CONFLICT', '演示 context 状态已变化。', { statusCode: 409 });
  }
  state.privateDb.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, ?)`).run(
    context.runId,
    context.artifactKey,
    context.contextId,
    batchId,
    DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole
  );
  return {
    ...context,
    status: 'previewed',
    uploadFileSha256,
    previewDigest,
    previewedAt
  };
}

/** 在 ownership 与批次绑定完成后写入 Artifact 07 最终 execute 审计。 */
function finalizeManagedDirectImportBatch(state, intent) {
  assertExactPlainObjectFields(
    intent,
    ['batchId', 'errorSummary', 'executeResult', 'fieldMapping', 'previewDigest', 'statistics', 'status'],
    'DEMO_MANAGED_DIRECT_FINALIZE_INTENT_INVALID',
    'Artifact 07 managed direct finalize intent 字段无效。'
  );
  assertExactPlainObjectFields(
    intent.statistics,
    ['failureCount', 'skippedCount', 'successCount', 'totalRows'],
    'DEMO_MANAGED_DIRECT_FINALIZE_INTENT_INVALID',
    'Artifact 07 managed direct statistics 字段无效。'
  );
  const batchId = Number(intent.batchId);
  const statistics = Object.fromEntries(Object.entries(intent.statistics).map(([key, value]) => [key, Number(value)]));
  const status = String(intent.status || '').trim();
  if (!Number.isSafeInteger(batchId) || batchId < 1
    || !['completed', 'completed_with_errors'].includes(status)
    || Object.values(statistics).some((value) => !Number.isSafeInteger(value) || value < 0)
    || statistics.successCount + statistics.failureCount + statistics.skippedCount > statistics.totalRows) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_FINALIZE_INVALID',
      'Artifact 07 managed direct 最终审计统计无效。',
      null,
      400
    );
  }
  const previewDigest = validatePreviewAuditDigest(intent.previewDigest);
  const fieldMappingJson = JSON.stringify(normalizeStrictJsonValue(intent.fieldMapping || {}, 'fieldMapping'));
  const executeResultJson = JSON.stringify(normalizeStrictJsonValue(intent.executeResult, 'executeResult'));
  const now = new Date().toISOString();
  const result = state.privateDb.prepare(`UPDATE import_batches
    SET status = ?, audit_phase = 'execute', preview_audit_digest = ?, execute_result_json = ?,
      total_rows = ?, success_count = ?, failure_count = ?, skipped_count = ?,
      field_mapping_json = ?, finished_at = ?, updated_at = ?, error_summary = ?
    WHERE id = ? AND import_type = 'energy_record' AND status = 'processing'`).run(
    status,
    previewDigest,
    executeResultJson,
    statistics.totalRows,
    statistics.successCount,
    statistics.failureCount,
    statistics.skippedCount,
    fieldMappingJson,
    now,
    now,
    intent.errorSummary === null || intent.errorSummary === undefined ? null : String(intent.errorSummary),
    batchId
  );
  if (result.changes !== 1) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_BATCH_STATE_CONFLICT',
      'Artifact 07 managed direct 批次状态已变化。',
      { batchId },
      409
    );
  }
  return true;
}

/** 抛出 Artifact 07 固定闭包损坏错误，所有 replay 漂移使用同一稳定 fail-closed 合同。 */
function throwManagedDirectClosureInvalid(reason, batchId, details = {}) {
  throw createDemoOwnershipError(
    'DEMO_MANAGED_DIRECT_CLOSURE_INVALID',
    'Artifact 07 managed direct 批次缺少可信业务记录与 ownership 闭包。',
    { reason, batchId: Number(batchId) || null, ...details },
    409
  );
}

/** 判断对象是否只包含指定数据字段，供持久 execute 摘要执行严格白名单复验。 */
function hasExactManagedDirectFields(value, expectedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualFields = Object.keys(descriptors).sort();
  const normalizedExpectedFields = [...expectedFields].sort();
  return actualFields.length === normalizedExpectedFields.length
    && actualFields.every((fieldName, index) => fieldName === normalizedExpectedFields[index]
      && !descriptors[fieldName].get && !descriptors[fieldName].set);
}

/** managed execute_result 中冻结的 context terminal 字段集合。 */
const DEMO_MANAGED_CONTEXT_TERMINAL_FIELDS = Object.freeze([
  'artifactFileSha256',
  'artifactKey',
  'contextId',
  'datasetId',
  'executedAt',
  'expiresAt',
  'handlerKey',
  'issuedAt',
  'issuedToUserId',
  'manifestDigest',
  'manifestVersion',
  'previewDigest',
  'previewSignature',
  'previewedAt',
  'runId',
  'runtimeEpoch',
  'status',
  'uploadFileSha256'
]);

/** 从 context CAS 返回值构造不可变 terminal closure，严格保留 previewedAt null 语义。 */
function buildManagedContextTerminalFacts(context, previewSignature = null) {
  const timestampFields = ['issuedAt', 'expiresAt', 'executedAt'];
  const validContext = context && typeof context === 'object'
    && context.status === 'executed'
    && timestampFields.every((fieldName) => (
      typeof context[fieldName] === 'string'
        && DEMO_UTC_MILLISECOND_PATTERN.test(context[fieldName])
    ))
    && (context.previewedAt === null
      || (typeof context.previewedAt === 'string'
        && DEMO_UTC_MILLISECOND_PATTERN.test(context.previewedAt)))
    && typeof context.artifactFileSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(context.artifactFileSha256)
    && context.uploadFileSha256 === context.artifactFileSha256
    && typeof context.previewDigest === 'string'
    && /^hmac-sha256:v1:audit:[0-9a-f]{64}$/u.test(context.previewDigest)
    && (previewSignature === null
      || (typeof previewSignature === 'string'
        && /^hmac-sha256:v1:[0-9a-f]{64}$/u.test(previewSignature)));
  if (!validContext) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_CONTEXT_TERMINAL_INVALID',
      'managed context terminal closure 字段无效。',
      { contextId: context?.contextId || null },
      409
    );
  }
  return Object.freeze({
    contextId: context.contextId,
    runId: context.runId,
    datasetId: context.datasetId,
    manifestVersion: context.manifestVersion,
    manifestDigest: context.manifestDigest,
    artifactKey: context.artifactKey,
    handlerKey: context.handlerKey,
    issuedToUserId: Number(context.issuedToUserId),
    runtimeEpoch: Number(context.runtimeEpoch),
    status: context.status,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    artifactFileSha256: context.artifactFileSha256,
    uploadFileSha256: context.uploadFileSha256,
    previewDigest: context.previewDigest,
    previewedAt: context.previewedAt,
    executedAt: context.executedAt,
    previewSignature
  });
}

/** 验证当前 context 与 execute-time durable terminal baseline 完全一致。 */
function isManagedContextTerminalClosureExact(context, terminal, previewSignature = null) {
  if (!hasExactManagedDirectFields(terminal, DEMO_MANAGED_CONTEXT_TERMINAL_FIELDS)) return false;
  try {
    return sha256Stable(terminal) === sha256Stable(
      buildManagedContextTerminalFacts(context, previewSignature)
    );
  } catch (_error) {
    return false;
  }
}

/** 将 CAS 后 terminal closure 追加到既有 execute_result_json，使用原 JSON 精确 CAS 防止覆盖漂移。 */
function persistManagedContextTerminalExecuteResult(db, batchId, terminalFacts) {
  const batch = db.prepare(`SELECT execute_result_json AS executeResultJson
    FROM import_batches WHERE id = ? AND audit_phase = 'execute'`).get(Number(batchId));
  let executeResult;
  try {
    executeResult = JSON.parse(batch?.executeResultJson);
  } catch (_error) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_CONTEXT_TERMINAL_PERSIST_CONFLICT',
      'managed execute_result 无法追加 context terminal closure。',
      { batchId: Number(batchId) },
      409
    );
  }
  if (!executeResult || typeof executeResult !== 'object' || Array.isArray(executeResult)
    || Object.prototype.hasOwnProperty.call(executeResult, 'contextTerminal')) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_CONTEXT_TERMINAL_PERSIST_CONFLICT',
      'managed execute_result context terminal closure 已存在或形状无效。',
      { batchId: Number(batchId) },
      409
    );
  }
  const finalizedExecuteResult = { ...executeResult, contextTerminal: terminalFacts };
  const finalizedJson = JSON.stringify(finalizedExecuteResult);
  const result = db.prepare(`UPDATE import_batches SET execute_result_json = ?, updated_at = ?
    WHERE id = ? AND audit_phase = 'execute' AND execute_result_json = ?`).run(
    finalizedJson,
    new Date().toISOString(),
    Number(batchId),
    batch.executeResultJson
  );
  if (result.changes !== 1) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_CONTEXT_TERMINAL_PERSIST_CONFLICT',
      'managed execute_result context terminal closure CAS 失败。',
      { batchId: Number(batchId) },
      409
    );
  }
  return finalizedExecuteResult;
}

/** 在不可拆分 operation 内调用测试故障钩子；生产 HTTP 不提供该函数。 */
function invokeManagedDirectOperationFault(intent, stage, summary = {}) {
  if (intent.faultInjector === null) return;
  if (typeof intent.faultInjector !== 'function') {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_FAULT_INJECTOR_INVALID',
      'Artifact 07 managed direct 故障注入器必须为服务端函数。'
    );
  }
  intent.faultInjector(stage, Object.freeze({ ...summary }));
}

/** 规范化业务回调结果，只接受批次统计和公开字段映射，不接受 witness、ownership 或 terminal 控制。 */
function normalizeManagedDirectBusinessResult(result) {
  assertExactPlainObjectFields(
    result,
    ['errorSummary', 'failureCount', 'fieldMapping', 'skippedCount', 'status', 'successCount', 'totalRows', 'validationErrorCount'],
    'DEMO_MANAGED_DIRECT_BUSINESS_RESULT_INVALID',
    'Artifact 07 managed direct 业务结果字段无效。'
  );
  const statistics = {
    totalRows: Number(result.totalRows),
    successCount: Number(result.successCount),
    failureCount: Number(result.failureCount),
    skippedCount: Number(result.skippedCount)
  };
  const validationErrorCount = Number(result.validationErrorCount);
  const status = String(result.status || '').trim();
  if (Object.values(statistics).some((value) => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(validationErrorCount) || validationErrorCount < 0
    || statistics.successCount + statistics.failureCount + statistics.skippedCount !== statistics.totalRows
    || !['completed', 'completed_with_errors', 'failed'].includes(status)) {
    throwManagedDirectClosureInvalid('business-result-statistics-invalid', null);
  }
  const expectedStatus = statistics.failureCount > 0 || statistics.skippedCount > 0
    ? 'completed_with_errors'
    : 'completed';
  if (status !== 'failed' && status !== expectedStatus) {
    throwManagedDirectClosureInvalid('business-result-status-invalid', null);
  }
  return {
    status,
    statistics,
    validationErrorCount,
    fieldMapping: normalizeStrictJsonValue(result.fieldMapping || {}, 'fieldMapping'),
    errorSummary: result.errorSummary === null || result.errorSummary === undefined
      ? null
      : String(result.errorSummary)
  };
}

/** 在 Artifact 07 operation 内执行固定 energy_record INSERT，并由 wrapper 私有持有 row witness。 */
function insertManagedDirectEnergyRecord(state, transactionScope, batchId, record) {
  assertExactPlainObjectFields(
    record,
    ['batchId', 'duplicateKey', 'energyTypeId', 'meterDeviceId', 'normalizedMonth', 'normalizedUnit',
      'normalizedValue', 'organizationUnitId', 'originalMonth', 'originalUnit', 'originalValue',
      'remark', 'sourceRowNumber'],
    'DEMO_MANAGED_DIRECT_ENERGY_RECORD_INVALID',
    'Artifact 07 managed direct 业务记录字段无效。'
  );
  if (Number(record.batchId) !== batchId) {
    throwManagedDirectClosureInvalid('business-record-batch-mismatch', batchId);
  }
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope,
    entityType: DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType,
    insertSql: `INSERT INTO energy_records (source_batch_id, source_row_number, energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, remark, duplicate_key, record_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    insertParams: [
      batchId,
      record.sourceRowNumber,
      record.energyTypeId,
      record.organizationUnitId,
      record.meterDeviceId,
      record.originalMonth,
      record.normalizedMonth,
      record.originalUnit,
      record.originalValue,
      record.normalizedUnit,
      record.normalizedValue,
      record.remark,
      record.duplicateKey
    ],
    sourceBatchId: batchId,
    sourceRowNumber: record.sourceRowNumber
  });
  return { entityPk: Number(rowWitness.lastInsertRowid), rowWitness };
}

/** 读取并严格验证 Artifact 07 业务行、错误分类与 active imported ownership 的 exact closure。 */
function readManagedDirectClosureFacts(state, input) {
  const db = state.privateDb;
  const batchId = Number(input.batchId);
  const businessRows = db.prepare(`SELECT id, source_row_number AS sourceRowNumber, record_status AS recordStatus
    FROM energy_records WHERE source_batch_id = ? ORDER BY source_row_number, id`).all(batchId);
  if (businessRows.some((row) => row.recordStatus !== 'active'
    || !Number.isSafeInteger(Number(row.sourceRowNumber)) || Number(row.sourceRowNumber) < 2)) {
    throwManagedDirectClosureInvalid('business-records-invalid', batchId);
  }
  const businessEntityIds = new Set();
  const businessRowNumbers = new Set();
  businessRows.forEach((row) => {
    const entityPk = String(Number(row.id));
    const rowNumber = Number(row.sourceRowNumber);
    if (businessEntityIds.has(entityPk) || businessRowNumbers.has(rowNumber)) {
      throwManagedDirectClosureInvalid('business-record-identity-duplicate', batchId);
    }
    businessEntityIds.add(entityPk);
    businessRowNumbers.add(rowNumber);
  });

  const issueRows = db.prepare(`SELECT row_number AS rowNumber, severity, error_code AS errorCode
    FROM import_errors WHERE batch_id = ? ORDER BY row_number, id`).all(batchId);
  const validationErrorRows = issueRows.filter((row) => row.severity === 'error');
  const duplicateSkippedRows = issueRows.filter((row) => (
    row.severity === 'warning' && row.errorCode === 'DUPLICATE_SKIPPED'
  ));
  if (issueRows.length !== validationErrorRows.length + duplicateSkippedRows.length) {
    throwManagedDirectClosureInvalid('import-issue-classification-invalid', batchId);
  }
  const failureRowNumbers = new Set(validationErrorRows.map((row) => Number(row.rowNumber)));
  const skippedRowNumbers = new Set(duplicateSkippedRows.map((row) => Number(row.rowNumber)));
  if (skippedRowNumbers.size !== duplicateSkippedRows.length
    || [...failureRowNumbers, ...skippedRowNumbers].some((rowNumber) => (
      !Number.isSafeInteger(rowNumber) || rowNumber < 2 || businessRowNumbers.has(rowNumber)
    ))
    || [...failureRowNumbers].some((rowNumber) => skippedRowNumbers.has(rowNumber))) {
    throwManagedDirectClosureInvalid('import-row-category-overlap', batchId);
  }
  const categoryRowNumbers = new Set([
    ...businessRowNumbers,
    ...failureRowNumbers,
    ...skippedRowNumbers
  ]);
  const statistics = {
    totalRows: categoryRowNumbers.size,
    successCount: businessRows.length,
    failureCount: failureRowNumbers.size,
    skippedCount: skippedRowNumbers.size
  };
  const expectedRowNumbers = Array.from({ length: statistics.totalRows }, (_item, index) => index + 2);
  if (expectedRowNumbers.some((rowNumber) => !categoryRowNumbers.has(rowNumber))) {
    throwManagedDirectClosureInvalid('import-row-sequence-invalid', batchId);
  }
  // 零新增 terminal 只允许非空文件全部唯一归类为 duplicate skipped；空文件和 validation failure 继续 fail-closed。
  const noInsertedRecords = statistics.successCount === 0;
  const isCompleteDuplicateSkipClosure = noInsertedRecords
    && statistics.totalRows > 0
    && statistics.failureCount === 0
    && statistics.skippedCount === statistics.totalRows;
  if (noInsertedRecords && !isCompleteDuplicateSkipClosure) {
    throwManagedDirectClosureInvalid('no-insert-classification-invalid', batchId, { statistics });
  }

  const registryRowsByBatch = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, registered_by AS registeredBy,
      cleaned_at AS cleanedAt
    FROM demo_data_registry WHERE source_batch_id = ? ORDER BY entity_type, entity_pk`).all(batchId);
  if (registryRowsByBatch.length !== businessRows.length) {
    throwManagedDirectClosureInvalid('ownership-count-mismatch', batchId, {
      businessCount: businessRows.length,
      ownershipCount: registryRowsByBatch.length
    });
  }
  const registryEntityIds = new Set(registryRowsByBatch.map((row) => String(row.entityPk)));
  if (registryEntityIds.size !== registryRowsByBatch.length
    || [...registryEntityIds].some((entityPk) => !businessEntityIds.has(entityPk))) {
    throwManagedDirectClosureInvalid('ownership-entity-set-mismatch', batchId);
  }

  const handler = getDemoOwnershipEntityHandler(DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType);
  const closureRecords = businessRows.map((businessRow) => {
    const entityPk = String(Number(businessRow.id));
    const projectedRow = handler.readProjection(db, Number(businessRow.id));
    const registry = readActiveRegistryEntity(db, DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType, entityPk);
    if (!projectedRow || !registry
      || registry.runId !== input.runId
      || registry.artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
      || registry.entityType !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType
      || registry.ownershipKind !== DEMO_IMPORTED_OWNERSHIP_KIND
      || Number(registry.sourceBatchId) !== batchId
      || Number(registry.sourceRowNumber) !== Number(businessRow.sourceRowNumber)
      || Number(registry.registeredBy) !== Number(input.actorUserId)
      || Number(projectedRow.source_batch_id) !== batchId
      || Number(projectedRow.source_row_number) !== Number(businessRow.sourceRowNumber)
      || projectedRow.record_status !== 'active') {
      throwManagedDirectClosureInvalid('ownership-provenance-mismatch', batchId, { entityPk });
    }
    const identityDigest = calculateDemoEntityIdentityDigest(
      DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType,
      entityPk
    );
    const snapshotDigest = calculateDemoEntitySnapshotDigest(
      DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType,
      entityPk,
      projectedRow
    );
    if (registry.identityDigest !== identityDigest || registry.snapshotDigest !== snapshotDigest) {
      throwManagedDirectClosureInvalid('ownership-digest-mismatch', batchId, { entityPk });
    }
    return {
      entityPk,
      sourceRowNumber: Number(businessRow.sourceRowNumber),
      identityDigest,
      snapshotDigest
    };
  }).sort((left, right) => left.sourceRowNumber - right.sourceRowNumber || left.entityPk.localeCompare(right.entityPk));

  return {
    statistics,
    noInsertedRecords,
    writesBusinessRecords: !noInsertedRecords,
    validationErrorCount: validationErrorRows.length,
    skippedRowNumbers: [...skippedRowNumbers].sort((left, right) => left - right),
    ownershipClosureDigest: sha256Stable({
      domain: 'artifact-07-managed-direct-ownership-closure:v1',
      runId: input.runId,
      artifactKey: DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey,
      batchId,
      records: closureRecords
    })
  };
}

/** 将业务回调声明的统计与 SQLite exact closure 比较，任何漂移都在 finalize 前回滚。 */
function assertManagedDirectBusinessResultMatchesClosure(result, facts, batchId) {
  const expectedStatistics = result.statistics;
  if (Object.keys(expectedStatistics).some((fieldName) => (
    Number(expectedStatistics[fieldName]) !== Number(facts.statistics[fieldName])
  )) || result.validationErrorCount !== facts.validationErrorCount) {
    throwManagedDirectClosureInvalid('business-statistics-drift', batchId, {
      expected: expectedStatistics,
      actual: facts.statistics
    });
  }
}

/** 复验已完成批次的 audit、binding、统计和 ownership closure；首次 terminal 与 replay 共用。 */
function verifyManagedDirectCompletedClosure(state, input) {
  const db = state.privateDb;
  const batchId = Number(input.batchId);
  const context = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
    FROM demo_import_contexts WHERE context_id = ?`).get(input.contextId);
  if (!context || context.status !== input.expectedContextStatus
    || context.runId !== input.runId
    || Number(context.issuedToUserId) !== Number(input.actorUserId)
    || context.artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
    || context.handlerKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.handlerKey
    || context.previewDigest !== input.previewDigest) {
    throwManagedDirectClosureInvalid('context-terminal-facts-invalid', batchId);
  }
  const bindings = db.prepare(`SELECT run_id AS runId, artifact_key AS artifactKey,
      context_id AS contextId, import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ? ORDER BY batch_role, import_batch_id`).all(input.contextId);
  if (bindings.length !== 1
    || bindings[0].runId !== input.runId
    || bindings[0].artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
    || bindings[0].contextId !== input.contextId
    || Number(bindings[0].batchId) !== batchId
    || bindings[0].batchRole !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole) {
    throwManagedDirectClosureInvalid('primary-binding-invalid', batchId);
  }
  const batch = db.prepare(`SELECT import_type AS importType, status, audit_phase AS auditPhase,
      preview_signature AS previewSignature, preview_audit_digest AS previewDigest,
      execute_result_json AS executeResultJson, total_rows AS totalRows,
      success_count AS successCount, failure_count AS failureCount,
      skipped_count AS skippedCount
    FROM import_batches WHERE id = ?`).get(batchId);
  if (!batch || batch.importType !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType
    || !['completed', 'completed_with_errors'].includes(batch.status)
    || batch.auditPhase !== 'execute' || batch.previewDigest !== input.previewDigest) {
    throwManagedDirectClosureInvalid('batch-audit-invalid', batchId);
  }
  let executeResult;
  try {
    executeResult = JSON.parse(batch.executeResultJson);
  } catch (_error) {
    throwManagedDirectClosureInvalid('execute-result-json-invalid', batchId);
  }
  const expectedExecuteResultFields = input.expectedContextStatus === 'executed'
    ? ['contextTerminal', 'executed', 'ownership', 'statistics', 'writesBusinessRecords']
    : ['executed', 'ownership', 'statistics', 'writesBusinessRecords'];
  if (!hasExactManagedDirectFields(executeResult, expectedExecuteResultFields)
    || executeResult.executed !== true || typeof executeResult.writesBusinessRecords !== 'boolean'
    || !hasExactManagedDirectFields(executeResult.statistics, ['failureCount', 'skippedCount', 'successCount', 'totalRows'])
    || !hasExactManagedDirectFields(executeResult.ownership, [
      'applied', 'closureDigest', 'idempotentCount', 'insertedCount', 'mode',
      'noInsertedRecords', 'registrationCount', 'relationCount', 'skippedCount'
    ])
    || (input.expectedContextStatus === 'executed'
      && !isManagedContextTerminalClosureExact(
        context,
        executeResult.contextTerminal,
        batch.previewSignature
      ))) {
    throwManagedDirectClosureInvalid('execute-result-shape-invalid', batchId);
  }
  const facts = readManagedDirectClosureFacts(state, input);
  const batchStatistics = {
    totalRows: Number(batch.totalRows),
    successCount: Number(batch.successCount),
    failureCount: Number(batch.failureCount),
    skippedCount: Number(batch.skippedCount)
  };
  const expectedStatus = facts.statistics.failureCount > 0 || facts.statistics.skippedCount > 0
    ? 'completed_with_errors'
    : 'completed';
  if (batch.status !== expectedStatus
    || executeResult.writesBusinessRecords !== facts.writesBusinessRecords
    || Object.keys(facts.statistics).some((fieldName) => (
      batchStatistics[fieldName] !== facts.statistics[fieldName]
      || Number(executeResult.statistics[fieldName]) !== facts.statistics[fieldName]
    ))) {
    throwManagedDirectClosureInvalid('batch-statistics-drift', batchId);
  }
  const ownership = executeResult.ownership;
  if (ownership.applied !== true || ownership.mode !== 'demo'
    || ownership.noInsertedRecords !== facts.noInsertedRecords
    || Number(ownership.registrationCount) !== facts.statistics.successCount
    || Number(ownership.insertedCount) !== facts.statistics.successCount
    || Number(ownership.idempotentCount) !== 0
    || Number(ownership.skippedCount) !== facts.statistics.skippedCount
    || Number(ownership.relationCount) !== 0
    || ownership.closureDigest !== facts.ownershipClosureDigest) {
    throwManagedDirectClosureInvalid('ownership-summary-drift', batchId);
  }
  if (state.pendingWitnesses.size !== 0) {
    throwManagedDirectClosureInvalid('ownership-witness-unconsumed', batchId, {
      pendingCount: state.pendingWitnesses.size
    });
  }
  return facts;
}

/** 执行 Artifact 07 唯一不可拆分 managed direct operation；调用方只能提供业务行处理回调。 */
function executeManagedDirectImportOperation(state, transactionScope, intent) {
  assertExactPlainObjectFields(
    intent,
    ['demoContext', 'executeBusinessRows', 'faultInjector', 'fieldMapping', 'file', 'operation', 'previewDigest', 'uploadFileSha256'],
    'DEMO_MANAGED_DIRECT_OPERATION_INTENT_INVALID',
    'Artifact 07 managed direct operation intent 字段无效。'
  );
  if (intent.operation !== DEMO_MANAGED_DIRECT_IMPORT_OPERATION
    || typeof intent.executeBusinessRows !== 'function') {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_OPERATION_INTENT_INVALID',
      'Artifact 07 managed direct operation 类型或业务执行器无效。',
      null,
      400
    );
  }
  const uploadFileSha256 = validateSha256(intent.uploadFileSha256, 'uploadFileSha256');
  const previewDigest = validatePreviewAuditDigest(intent.previewDigest);
  const replay = readManagedDirectTerminalReplay(state, {
    demoContext: intent.demoContext,
    uploadFileSha256
  });
  if (replay) return { batchId: Number(replay.batchId), terminalReplay: true };

  validateManagedDirectIssuedContext(state, {
    demoContext: intent.demoContext,
    uploadFileSha256
  });
  const batchId = insertManagedDirectImportBatch(state, {
    fieldMapping: intent.fieldMapping,
    file: intent.file
  });
  const boundContext = bindManagedDirectImportContext(state, {
    batchId,
    demoContext: intent.demoContext,
    uploadFileSha256,
    previewDigest
  });
  invokeManagedDirectOperationFault(intent, 'after-context-binding', { batchId });

  let writerActive = true;
  const insertedRecords = [];
  const writer = Object.freeze({
    insertIssue(issue) {
      if (!writerActive) throwManagedDirectClosureInvalid('business-writer-expired', batchId);
      return insertManagedDirectImportIssue(state, issue);
    },
    insertRecord(record) {
      if (!writerActive) throwManagedDirectClosureInvalid('business-writer-expired', batchId);
      const insertion = insertManagedDirectEnergyRecord(state, transactionScope, batchId, record);
      insertedRecords.push({
        entityType: DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType,
        entityPk: Number(insertion.entityPk),
        batchRole: DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole,
        sourceRowNumber: Number(record.sourceRowNumber),
        rowWitness: insertion.rowWitness
      });
      return insertion;
    }
  });
  let rawBusinessResult;
  try {
    rawBusinessResult = intent.executeBusinessRows(Object.freeze({
      batchId,
      db: state.facade,
      writer
    }));
  } finally {
    writerActive = false;
  }
  if (rawBusinessResult && typeof rawBusinessResult.then === 'function') {
    Promise.resolve(rawBusinessResult).catch(() => undefined);
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_BUSINESS_ASYNC_FORBIDDEN',
      'Artifact 07 managed direct 业务执行器必须同步完成。',
      null,
      409
    );
  }
  const businessResult = normalizeManagedDirectBusinessResult(rawBusinessResult);
  if (businessResult.status === 'failed') {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_DIRECT_IMPORT_REJECTED',
      businessResult.errorSummary || 'Artifact 07 managed direct 导入未通过校验。',
      null,
      400
    );
  }
  if (insertedRecords.length !== businessResult.statistics.successCount) {
    throwManagedDirectClosureInvalid('inserted-business-record-count-mismatch', batchId, {
      declaredSuccessCount: businessResult.statistics.successCount,
      witnessedInsertCount: insertedRecords.length
    });
  }
  const noInsertedRecords = insertedRecords.length === 0;
  if (noInsertedRecords && !(businessResult.statistics.totalRows > 0
    && businessResult.statistics.failureCount === 0
    && businessResult.statistics.skippedCount === businessResult.statistics.totalRows)) {
    throwManagedDirectClosureInvalid('no-insert-classification-invalid', batchId, {
      statistics: businessResult.statistics
    });
  }
  invokeManagedDirectOperationFault(intent, 'after-business-records', {
    batchId,
    insertedCount: insertedRecords.length,
    skippedCount: businessResult.statistics.skippedCount
  });

  const skippedRecords = state.privateDb.prepare(`SELECT row_number AS sourceRowNumber
    FROM import_errors
    WHERE batch_id = ? AND severity = 'warning' AND error_code = 'DUPLICATE_SKIPPED'
    ORDER BY row_number`).all(batchId).map((row) => ({
    entityType: DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType,
    entityPk: null,
    batchRole: DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole,
    sourceRowNumber: Number(row.sourceRowNumber),
    reason: 'duplicate_skipped'
  }));
  const ownership = registerImportedDemoOwnershipInTransaction({
    transactionScope,
    demoContext: {
      ...intent.demoContext,
      uploadFileSha256,
      previewDigest
    },
    actorUserId: intent.demoContext.userId,
    batchBindings: [{
      batchId,
      batchRole: DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole,
      entityType: DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType
    }],
    insertedRecords,
    skippedRecords,
    noInsertedRecords
  });
  invokeManagedDirectOperationFault(intent, 'after-ownership', {
    batchId,
    registrationCount: Number(ownership.registrationCount || 0)
  });
  if (state.pendingWitnesses.size !== 0
    || ownership.applied !== true || ownership.mode !== 'demo'
    || ownership.noInsertedRecords !== noInsertedRecords
    || Number(ownership.registrationCount) !== insertedRecords.length
    || Number(ownership.insertedCount) !== insertedRecords.length
    || Number(ownership.idempotentCount) !== 0
    || Number(ownership.skippedCount) !== skippedRecords.length
    || Number(ownership.relationCount) !== 0) {
    throwManagedDirectClosureInvalid('ownership-registration-incomplete', batchId);
  }
  const facts = readManagedDirectClosureFacts(state, {
    batchId,
    runId: boundContext.runId,
    actorUserId: boundContext.issuedToUserId
  });
  assertManagedDirectBusinessResultMatchesClosure(businessResult, facts, batchId);
  const executeResult = {
    executed: true,
    writesBusinessRecords: facts.writesBusinessRecords,
    statistics: facts.statistics,
    ownership: {
      applied: true,
      mode: 'demo',
      noInsertedRecords: facts.noInsertedRecords,
      registrationCount: insertedRecords.length,
      insertedCount: insertedRecords.length,
      idempotentCount: 0,
      skippedCount: facts.statistics.skippedCount,
      relationCount: 0,
      closureDigest: facts.ownershipClosureDigest
    }
  };
  finalizeManagedDirectImportBatch(state, {
    batchId,
    status: businessResult.status,
    statistics: facts.statistics,
    fieldMapping: businessResult.fieldMapping,
    previewDigest,
    executeResult,
    errorSummary: businessResult.errorSummary
  });
  verifyManagedDirectCompletedClosure(state, {
    batchId,
    contextId: boundContext.contextId,
    runId: boundContext.runId,
    actorUserId: boundContext.issuedToUserId,
    previewDigest,
    expectedContextStatus: 'previewed'
  });
  invokeManagedDirectOperationFault(intent, 'after-audit', { batchId });
  const executedContext = markDemoContextExecutedInTransaction({
    db: state.privateDb,
    ...intent.demoContext,
    uploadFileSha256,
    previewDigest,
    batchBindings: [{ batchId, batchRole: DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole }]
  });
  const contextTerminal = buildManagedContextTerminalFacts(executedContext, null);
  persistManagedContextTerminalExecuteResult(
    state.privateDb,
    batchId,
    contextTerminal
  );
  invokeManagedDirectOperationFault(intent, 'after-context-executed', { batchId });
  verifyManagedDirectCompletedClosure(state, {
    batchId,
    contextId: boundContext.contextId,
    runId: boundContext.runId,
    actorUserId: boundContext.issuedToUserId,
    previewDigest,
    expectedContextStatus: 'executed'
  });
  return { batchId, terminalReplay: false };
}

/**
 * 使用独占私有 SQLite 连接创建 ownership scope；普通 callback 仍只接收只读 facade。
 * Artifact 07 只能提交固定 operation intent，由 wrapper 在单次事务中不可拆分地执行完整闭包。
 * 外部连接或路径仅用于定位数据库，外部 raw exec/prototype 方法无法影响私有事务。
 */
function runWithDemoOwnershipTransaction(target, callbackOrOperation) {
  // operation 类型只从普通对象自有数据属性读取，拒绝 getter 或 Proxy 在事务前重入。
  const operationDescriptor = callbackOrOperation
    && typeof callbackOrOperation === 'object'
    && !Array.isArray(callbackOrOperation)
    && !utilTypes.isProxy(callbackOrOperation)
    && Object.getPrototypeOf(callbackOrOperation) === Object.prototype
    ? Object.getOwnPropertyDescriptor(callbackOrOperation, 'operation')
    : null;
  const isManagedDirectOperation = Boolean(operationDescriptor
    && !operationDescriptor.get && !operationDescriptor.set
    && operationDescriptor.value === DEMO_MANAGED_DIRECT_IMPORT_OPERATION);
  if (typeof callbackOrOperation !== 'function' && !isManagedDirectOperation) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_INVALID',
      'ownership transaction wrapper callback 或固定 operation 参数无效。',
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
    managedPredictionOperationActive: false,
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
    result = isManagedDirectOperation
      ? executeManagedDirectImportOperation(state, transactionScope, callbackOrOperation)
      : callbackOrOperation(transactionScope, state.facade);
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
async function runWithDemoOwnershipTransactionAsync(target, callbackOrOperation) {
  const operationDescriptor = callbackOrOperation
    && typeof callbackOrOperation === 'object'
    && !Array.isArray(callbackOrOperation)
    && !utilTypes.isProxy(callbackOrOperation)
    && Object.getPrototypeOf(callbackOrOperation) === Object.prototype
    ? Object.getOwnPropertyDescriptor(callbackOrOperation, 'authority')
    : null;
  const isManagedPredictionOperation = Boolean(
    operationDescriptor
    && !operationDescriptor.get
    && !operationDescriptor.set
    && operationDescriptor.value === DEMO_PREDICTION_CONFIG_MANAGED_OPERATION_AUTHORITY
  );
  if (typeof callbackOrOperation !== 'function' && !isManagedPredictionOperation) {
    throw createDemoOwnershipError(
      'DEMO_OWNERSHIP_TRANSACTION_SCOPE_INVALID',
      'ownership transaction wrapper callback 或固定 operation 参数无效。',
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
    managedPredictionOperationActive: false,
    managedPredictionBackupCompensation: null,
    managedPredictionBatchId: null,
    managedPredictionActorUserId: null,
    managedPredictionActorIp: null,
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
    result = isManagedPredictionOperation
      ? await executeManagedPredictionConfigImportOperation(
          state,
          transactionScope,
          callbackOrOperation
        )
      : await callbackOrOperation(transactionScope, state.facade);
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
  }
  if (failure && state.managedPredictionBackupCompensation) {
    try {
      compensateManagedPredictionBackupFile(state.managedPredictionBackupCompensation);
    } catch (cleanupError) {
      reportManagedPredictionBackupCompensationFailure(
        state,
        state.managedPredictionBackupCompensation,
        cleanupError
      );
    }
  }
  privateDb.close();
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
  if (entityType === DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
    && scopeState.managedPredictionOperationActive !== true) {
    throw createDemoOwnershipError(
      'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED',
      'Artifact 12 prediction_config 只能由单一 managed operation 插入。',
      null,
      409
    );
  }
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

/** 在 managed 碳活动导入中校验当前 run imported ownership，并原子锁定替代目标。 */
function beginCarbonActivitySupersedeInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'demoContext', 'targetActivityId', 'uploadFileSha256', 'previewDigest', 'updatedAt'],
    'DEMO_CARBON_ACTIVITY_SUPERSEDE_INTENT_INVALID',
    '碳活动替代 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  const db = scopeState.privateDb;
  const targetActivityId = Number(input.targetActivityId);
  assertDemoProjectionInteger(targetActivityId, 'targetActivityId', { min: 1 });
  assertDemoProjectionUtcMilliseconds(input.updatedAt, 'updatedAt');
  const demoContext = input.demoContext || {};
  const context = validateDemoContext({
    token: demoContext.token,
    userId: demoContext.userId,
    artifactKey: demoContext.artifactKey,
    handlerKey: demoContext.handlerKey,
    phase: 'execute',
    uploadFileSha256: input.uploadFileSha256,
    previewDigest: input.previewDigest,
    db
  });
  if (context.artifactKey !== '27-carbon-activities' || context.handlerKey !== 'carbon-activity-import') {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_CONTEXT_MISMATCH', '碳活动替代只允许 artifact 27 的 managed context。', null, 409);
  }
  assertDemoContextMetadataMatches(context, demoContext);
  const handler = getDemoOwnershipEntityHandler('carbon_activity_record');
  const targetRow = handler.readProjection(db, targetActivityId);
  const registry = db.prepare(`SELECT registry_id AS registryId, snapshot_digest AS snapshotDigest
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '27-carbon-activities'
      AND entity_type = 'carbon_activity_record' AND entity_pk = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(context.runId, String(targetActivityId));
  if (!targetRow || targetRow.source_type !== 'independent_activity' || targetRow.record_status !== 'active'
    || !registry) {
    throw createDemoOwnershipError(
      'DEMO_CARBON_ACTIVITY_SUPERSEDE_OWNERSHIP_REQUIRED',
      'managed 碳活动只能替代当前 run 已登记的 active imported 独立活动。',
      { targetActivityId },
      409
    );
  }
  const currentSnapshotDigest = calculateDemoEntitySnapshotDigest(
    'carbon_activity_record',
    String(targetActivityId),
    targetRow
  );
  if (registry.snapshotDigest !== currentSnapshotDigest) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_SNAPSHOT_STALE', '待替代碳活动 ownership 快照已变化。', { targetActivityId }, 409);
  }
  const result = db.prepare(`UPDATE carbon_activity_records
    SET record_status = 'superseded', superseded_by_activity_id = id, updated_at = ?
    WHERE id = ? AND source_type = 'independent_activity' AND record_status = 'active'
      AND superseded_by_activity_id IS NULL`).run(input.updatedAt, targetActivityId);
  if (result.changes !== 1) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_TARGET_STALE', '待替代碳活动已变化，请重新预演。', { targetActivityId }, 409);
  }
  const witness = Object.freeze(Object.assign(Object.create(null), { targetActivityId }));
  DEMO_CARBON_ACTIVITY_SUPERSEDE_WITNESS_STATE.set(witness, Object.freeze({
    transactionScope: input.transactionScope,
    contextId: context.contextId,
    registryId: Number(registry.registryId),
    targetActivityId,
    previousSnapshotDigest: registry.snapshotDigest
  }));
  return witness;
}

/** 完成 managed 碳活动替代，并以旧摘要 CAS 刷新目标 imported ownership 快照。 */
function finalizeCarbonActivitySupersedeInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'supersedeWitness', 'newActivityId', 'updatedAt'],
    'DEMO_CARBON_ACTIVITY_SUPERSEDE_FINALIZE_INVALID',
    '碳活动替代完成 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  const state = input.supersedeWitness && typeof input.supersedeWitness === 'object'
    ? DEMO_CARBON_ACTIVITY_SUPERSEDE_WITNESS_STATE.get(input.supersedeWitness)
    : null;
  const newActivityId = Number(input.newActivityId);
  assertDemoProjectionInteger(newActivityId, 'newActivityId', { min: 1 });
  assertDemoProjectionUtcMilliseconds(input.updatedAt, 'updatedAt');
  if (!state || state.transactionScope !== input.transactionScope) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_WITNESS_INVALID', '碳活动替代见证无效或不属于当前事务。', null, 409);
  }
  const db = scopeState.privateDb;
  const inserted = db.prepare(`SELECT id FROM carbon_activity_records
    WHERE id = ? AND source_type = 'independent_activity' AND record_status = 'active'
      AND supersedes_activity_id = ?`).get(newActivityId, state.targetActivityId);
  if (!inserted) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_NEW_ROW_MISMATCH', '新碳活动与替代目标绑定不一致。', null, 409);
  }
  const targetUpdate = db.prepare(`UPDATE carbon_activity_records
    SET superseded_by_activity_id = ?, updated_at = ?
    WHERE id = ? AND record_status = 'superseded' AND superseded_by_activity_id = id`).run(
    newActivityId,
    input.updatedAt,
    state.targetActivityId
  );
  if (targetUpdate.changes !== 1) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_TARGET_STALE', '待替代碳活动完成链接时已变化。', null, 409);
  }
  const handler = getDemoOwnershipEntityHandler('carbon_activity_record');
  const targetRow = handler.readProjection(db, state.targetActivityId);
  const nextSnapshotDigest = calculateDemoEntitySnapshotDigest(
    'carbon_activity_record',
    String(state.targetActivityId),
    targetRow
  );
  const registryUpdate = db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE registry_id = ? AND snapshot_digest = ? AND cleaned_at IS NULL`).run(
    nextSnapshotDigest,
    state.registryId,
    state.previousSnapshotDigest
  );
  if (registryUpdate.changes !== 1) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_SUPERSEDE_REGISTRY_STALE', '待替代碳活动 ownership 快照刷新失败。', null, 409);
  }
  DEMO_CARBON_ACTIVITY_SUPERSEDE_WITNESS_STATE.delete(input.supersedeWitness);
  return { targetActivityId: state.targetActivityId, newActivityId, snapshotDigest: nextSnapshotDigest };
}

/** 在 ownership 私有事务内写入固定碳活动导入 execute 操作审计。 */
function writeCarbonActivityExecuteAuditInOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'actorUserId', 'actorIp', 'batchId', 'activityIds', 'createdAt'],
    'DEMO_CARBON_ACTIVITY_AUDIT_INTENT_INVALID',
    '碳活动 execute 审计 intent 只能包含固定字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  const db = scopeState.privateDb;
  const actorUserId = requireDemoOwnershipActor(db, { actorUserId: input.actorUserId });
  assertDemoProjectionInteger(input.batchId, 'batchId', { min: 1 });
  if (!Array.isArray(input.activityIds) || input.activityIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw createDemoOwnershipError('DEMO_CARBON_ACTIVITY_AUDIT_INTENT_INVALID', '碳活动 execute 审计主键集合无效。', null, 400);
  }
  assertDemoProjectionString(input.actorIp, 'actorIp', { nullable: true });
  assertDemoProjectionUtcMilliseconds(input.createdAt, 'createdAt');
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, 'carbon.activity.import.execute', 'carbon_activity', ?, ?, ?, ?)`).run(
    actorUserId,
    String(input.batchId),
    JSON.stringify({ batchId: input.batchId, imported: input.activityIds.length, activityIds: input.activityIds }),
    input.actorIp,
    input.createdAt
  );
  return true;
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
      source_row_number AS sourceRowNumber, registered_by AS registeredBy,
      registered_at AS registeredAt
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
    const existing = db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
        from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
        relation_type AS relationType, created_at AS createdAt
      FROM demo_data_relations
      WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?`).get(
      fromRegistry.registryId,
      toRegistry.registryId,
      relation.relationType
    );
    if (existing) {
      return {
        relationId: Number(existing.relationId),
        runId: existing.runId,
        fromRegistryId: Number(existing.fromRegistryId),
        toRegistryId: Number(existing.toRegistryId),
        relationType: existing.relationType,
        createdAt: existing.createdAt,
        result: 'idempotent'
      };
    }
    try {
      const createdAt = typeof context.createdAt === 'string' ? context.createdAt : null;
      const result = createdAt
        ? db.prepare(`INSERT INTO demo_data_relations
          (run_id, from_registry_id, to_registry_id, relation_type, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(
          context.runId,
          fromRegistry.registryId,
          toRegistry.registryId,
          relation.relationType,
          createdAt
        )
        : db.prepare(`INSERT INTO demo_data_relations
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
        createdAt,
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

/** registrar 私有 SAVEPOINT 恢复异常时完整回滚，仍失败则关闭连接。 */
function failClosedStrategyRegistrarTransaction(db) {
  let fullRollbackError = null;
  let closeError = null;
  try {
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

/** 回滚 registrar 私有 SAVEPOINT；ROLLBACK TO 失败后严禁继续 RELEASE。 */
function recoverStrategyRegistrarSavepoint(db, savepointName) {
  let rollbackError = null;
  let releaseError = null;
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } catch (error) {
    rollbackError = error;
  }
  if (!rollbackError) {
    try {
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (error) {
      releaseError = error;
    }
  }
  const failClosed = rollbackError || releaseError
    ? failClosedStrategyRegistrarTransaction(db)
    : { fullRollbackError: null, closeError: null };
  return { rollbackError, releaseError, ...failClosed };
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

/** 将 strategy registration scope 同步标记为失败，阻止跨连接或失效事务后的重放。 */
function failStrategyRegistrationScopeState(registrationScope, state) {
  state.status = 'failed';
}

/** 读取 registration scope 内部未提交 marker 的固定 projection。 */
function readStrategyScopeMarker(db, markerId) {
  return db.prepare(`SELECT id AS id, user_id AS userId, operation AS operation,
      target_type AS targetType, target_id AS targetId, detail_json AS detailJson,
      ip AS ip, created_at AS createdAt
    FROM sys_operation_logs WHERE id = ?`).get(markerId) || null;
}

/** 证明 scope marker 仍只存在于 issue 时的 caller transaction，拒绝 COMMIT-BEGIN 重放。 */
function assertStrategyScopeTransactionContinuity(db, state) {
  const localMarker = readStrategyScopeMarker(db, state.markerId);
  if (!localMarker || localMarker.operation !== DEMO_STRATEGY_SCOPE_MARKER_OPERATION
    || Number(localMarker.userId) !== state.actorUserId
    || localMarker.targetType !== 'strategy-registration-scope'
    || localMarker.targetId !== state.markerTargetId
    || localMarker.detailJson !== state.markerDetailJson
    || localMarker.ip !== null
    || localMarker.createdAt !== state.markerCreatedAt) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
      '策略评价 registration scope marker 已缺失或被改写，禁止事务重放。',
      null,
      409
    );
  }
  if (!db.name || typeof db.name !== 'string' || db.name === ':memory:') {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_IDENTITY_UNAVAILABLE',
      '策略评价 registration scope 无法证明原始 SQLite 事务身份。',
      null,
      409
    );
  }
  let observer = null;
  try {
    observer = openReadOnlyDatabase({ databasePath: db.name });
    const committedMarker = observer.prepare(
      'SELECT id FROM sys_operation_logs WHERE id = ?'
    ).get(state.markerId);
    if (committedMarker) {
      // 原 marker 已随 caller COMMIT 落盘；先丢弃新事务，再用独立连接清理 marker，
      // 最后恢复一个空 caller transaction，避免调用方后续 COMMIT 交出半成品或内部 marker。
      try {
        if (db.inTransaction === true) db.exec('ROLLBACK');
        const cleanupDb = openDatabase({ databasePath: db.name });
        try {
          cleanupDb.exec('BEGIN IMMEDIATE');
          cleanupDb.prepare('DELETE FROM sys_operation_logs WHERE id = ?').run(state.markerId);
          cleanupDb.exec('COMMIT');
        } finally {
          cleanupDb.close();
        }
        db.exec('BEGIN IMMEDIATE');
        state.markerId = null;
      } catch (cleanupError) {
        try {
          db.close();
        } catch (_closeError) {
          // 原始连接已经不可安全复用时保持关闭。
        }
        throw createDemoOwnershipError(
          'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_RECOVERY_FAILED',
          '策略评价 registration scope 事务世代恢复失败，连接已关闭。',
          { cause: cleanupError.code || null },
          500
        );
      }
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH',
        '策略评价 registration scope 已跨越 COMMIT-BEGIN 事务边界，禁止重放。',
        null,
        409
      );
    }
  } catch (error) {
    if (error?.code === 'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_MISMATCH'
      || error?.code === 'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_RECOVERY_FAILED') throw error;
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_TRANSACTION_IDENTITY_UNAVAILABLE',
      '策略评价 registration scope 无法读取原始 SQLite 事务身份。',
      { cause: error.code || null },
      409
    );
  } finally {
    if (observer) observer.close();
  }
}

/** 删除 scope marker；失败路径不得把内部 marker 留给 caller 提交。 */
function cleanupStrategyScopeMarker(db, state) {
  if (!state.markerId || !db || typeof db.prepare !== 'function') return;
  const result = db.prepare(`DELETE FROM sys_operation_logs
    WHERE id = ? AND operation = ? AND target_type = ? AND target_id = ?`).run(
    state.markerId,
    DEMO_STRATEGY_SCOPE_MARKER_OPERATION,
    'strategy-registration-scope',
    state.markerTargetId
  );
  if (result.changes !== 1) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_SCOPE_MARKER_INVALID',
      '策略评价 registration scope marker 无法安全清理。',
      { markerId: state.markerId },
      409
    );
  }
  state.markerId = null;
}

/** 校验 strategy registration scope、exact scope 与当前连接均保持原始对象身份。 */
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
    failStrategyRegistrationScopeState(registrationScope, state);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_DATABASE_MISMATCH',
      '策略评价 registration scope 与 SQLite 连接不一致。',
      null,
      409
    );
  }
  try {
    getEnergyStrategyEvaluatorProtocol().assertExactScope(state.exactScope, db);
  } catch (error) {
    failStrategyRegistrationScopeState(registrationScope, state);
    throw error;
  }
  if (db.inTransaction !== true) {
    failStrategyRegistrationScopeState(registrationScope, state);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_OWNERSHIP_TRANSACTION_REQUIRED',
      '策略评价 registration scope 必须保留原 caller transaction。',
      null,
      409
    );
  }
  try {
    assertStrategyScopeTransactionContinuity(db, state);
  } catch (error) {
    failStrategyRegistrationScopeState(registrationScope, state);
    throw error;
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

/** 按 scope 当前状态执行 fail-closed abort，不接管外层事务或 SAVEPOINT 生命周期。 */
function abortStrategyRegistrationScopeState(registrationScope, state) {
  if (state.status !== 'consumed') state.status = 'failed';
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
  getEnergyStrategyEvaluatorProtocol().assertExactScope(input.exactScope, db);
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
  const markerTargetId = crypto.randomBytes(24).toString('hex');
  const markerCreatedAt = new Date().toISOString();
  const markerId = insertOperationLogWithDb(db, {
    userId: actorUserId,
    operation: DEMO_STRATEGY_SCOPE_MARKER_OPERATION,
    targetType: 'strategy-registration-scope',
    targetId: markerTargetId,
    detail: { actionRunId },
    ip: null,
    createdAt: markerCreatedAt
  });
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
    markerId,
    markerTargetId,
    markerDetailJson: JSON.stringify({ actionRunId }),
    markerCreatedAt,
    status: 'issued'
  };
  DEMO_STRATEGY_REGISTRATION_SCOPE_STATE.set(registrationScope, state);
  try {
    getEnergyStrategyEvaluatorProtocol().bindRegistrationScope({
      db,
      registrationScope,
      exactScope: input.exactScope,
      domainBinding
    });
  } catch (error) {
    state.status = 'failed';
    try {
      cleanupStrategyScopeMarker(db, state);
    } catch (_cleanupError) {
      // issue 失败时保留原始绑定错误，marker 仍随 caller transaction 回滚。
    }
    throw error;
  }
  return registrationScope;
}

/** 在 evaluator 首次业务写入前激活原始 scope。 */
function activateStrategyEvaluationRegistrationScopeInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'registrationScope', 'actorUserId'],
    'DEMO_DERIVED_STRATEGY_SCOPE_ACTIVATE_INPUT_INVALID',
    '策略评价 registration scope activate 只能接收 db、actorUserId 和原始 scope。'
  );
  const state = requireStrategyRegistrationScopeState(
    input.db,
    input.registrationScope,
    ['issued']
  );
  const actorUserId = requireDemoOwnershipActor(input.db, { actorUserId: input.actorUserId });
  if (actorUserId !== state.actorUserId) {
    failStrategyRegistrationScopeState(input.registrationScope, state);
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_ACTOR_MISMATCH',
      '策略评价 registration scope 与 evaluator actor 不一致。',
      null,
      409
    );
  }
  const run = requireDemoDatasetRun(input.db, state.runId);
  requireStrategyDerivedActionRun(input.db, state, run);
  state.status = 'active';
  return input.registrationScope;
}

/** 主动终止一次 registration scope；issued guard 只回滚到自身且不结束外层事务。 */
function abortStrategyEvaluationRegistrationScopeInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['db', 'registrationScope'],
    'DEMO_DERIVED_STRATEGY_SCOPE_ABORT_INPUT_INVALID',
    '策略评价 registration scope abort 只能接收 db 和原始 scope。'
  );
  const registrationScope = input.registrationScope;
  const state = registrationScope && typeof registrationScope === 'object'
    ? DEMO_STRATEGY_REGISTRATION_SCOPE_STATE.get(registrationScope)
    : null;
  if (!state || state.db !== input.db) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_REQUIRED',
      '策略评价 registration scope abort 必须使用原始 scope 和 SQLite 连接。',
      null,
      409
    );
  }
  if (state.status === 'consumed') {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_REGISTRATION_SCOPE_REPLAY',
      '策略评价 registration scope 已完成消费。',
      null,
      409
    );
  }
  if (input.db.inTransaction === true && state.markerId) {
    const marker = readStrategyScopeMarker(input.db, state.markerId);
    if (marker) cleanupStrategyScopeMarker(input.db, state);
    else state.markerId = null;
  }
  abortStrategyRegistrationScopeState(registrationScope, state);
  return registrationScope;
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

/** 构造 registrar 写入前固定的完整 derived registry 事实合同。 */
function buildExpectedStrategyRegistryFact(registryId, run, actorUserId, registration, registeredAt) {
  return {
    registryId: Number(registryId),
    runId: run.runId,
    artifactKey: '18-strategy-rules',
    entityType: registration.entityType,
    entityPk: registration.entityPk,
    ownershipKind: 'derived',
    identityDigest: registration.identityDigest,
    snapshotDigest: registration.snapshotDigest,
    sourceBatchId: null,
    sourceRowNumber: null,
    legacyClaimRunId: null,
    registeredBy: actorUserId,
    registeredAt,
    cleanedAt: null,
    cleanupRunId: null,
    cleanupResult: null
  };
}

/** 校验已有 derived registry 与本次固定 run/hit snapshot 完全一致，并支持稳定重试。 */
function registerSingleDerivedStrategyEntityInTransaction(
  db,
  run,
  actorUserId,
  registration,
  registeredAt
) {
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
  const effectiveRegisteredAt = registeredAt || new Date().toISOString();
  try {
    const result = db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
       identity_digest, snapshot_digest, source_batch_id, source_row_number,
       registered_by, registered_at)
      VALUES (?, '18-strategy-rules', ?, ?, 'derived', ?, ?, NULL, NULL, ?, ?)`).run(
      run.runId,
      registration.entityType,
      registration.entityPk,
      registration.identityDigest,
      registration.snapshotDigest,
      actorUserId,
      effectiveRegisteredAt
    );
    return {
      ...buildExpectedStrategyRegistryFact(
        Number(result.lastInsertRowid),
        run,
        actorUserId,
        registration,
        effectiveRegisteredAt
      ),
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
  if (sha256Stable(witnessState.domainBinding) !== scopeState.domainBindingDigest) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_WITNESS_BINDING_MISMATCH',
      '策略评价 completion witness 与 registration scope 领域绑定不一致。',
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
/** 校验 completion witness 中 operation audit 固定投影仍未被删除或改写。 */
function assertStrategyWitnessOperationAudit(db, witnessState) {
  const auditId = normalizeIntegerEntityPk(witnessState.operationAuditId);
  const expected = witnessState.operationAuditSnapshot;
  if (!auditId || !expected || typeof expected !== 'object') {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_OPERATION_AUDIT_INVALID',
      '策略评价 completion witness 缺少固定 operation audit 见证。',
      null,
      409
    );
  }
  const row = db.prepare(`SELECT id AS id, user_id AS userId, operation AS operation,
      target_type AS targetType, target_id AS targetId, detail_json AS detailJson,
      ip AS ip, created_at AS createdAt
    FROM sys_operation_logs WHERE id = ?`).get(auditId);
  if (!row) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_OPERATION_AUDIT_MISMATCH',
      '策略评价 operation audit 已缺失。',
      { operationLogId: auditId },
      409
    );
  }
  let detail;
  try {
    detail = row.detailJson === null ? null : JSON.parse(row.detailJson);
  } catch (_error) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_OPERATION_AUDIT_MISMATCH',
      '策略评价 operation audit detail_json 已被改写。',
      { operationLogId: auditId },
      409
    );
  }
  const actual = {
    id: Number(row.id),
    userId: row.userId === null ? null : Number(row.userId),
    operation: row.operation,
    targetType: row.targetType,
    targetId: row.targetId,
    detail,
    ip: row.ip,
    createdAt: row.createdAt
  };
  if (sha256Stable(actual) !== sha256Stable(expected)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_OPERATION_AUDIT_MISMATCH',
      '策略评价 operation audit 已缺失或被改写。',
      { operationLogId: auditId },
      409
    );
  }
  return actual;
}

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
  assertStrategyWitnessOperationAudit(db, witnessState);
}

/** 读取 registrar receipt 绑定的完整 registry 持久事实。 */
function readStrategyReceiptRegistryFact(db, registryId) {
  return db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, legacy_claim_run_id AS legacyClaimRunId,
      registered_by AS registeredBy, registered_at AS registeredAt,
      cleaned_at AS cleanedAt, cleanup_run_id AS cleanupRunId,
      cleanup_result AS cleanupResult
    FROM demo_data_registry WHERE registry_id = ?`).get(registryId) || null;
}

/** 读取 registrar receipt 绑定的完整 relation 持久事实。 */
function readStrategyReceiptRelationFact(db, relationId) {
  return db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType, created_at AS createdAt
    FROM demo_data_relations WHERE relation_id = ?`).get(relationId) || null;
}

/** 校验 registrar 预期 registry/relation 合同与写入后事实逐字段完全一致。 */
function assertStrategyRegistrarIntentFacts(expectedFacts, actualFacts, code, message) {
  if (!Array.isArray(expectedFacts) || !Array.isArray(actualFacts)
    || expectedFacts.length !== actualFacts.length
    || sha256Stable(expectedFacts) !== sha256Stable(actualFacts)) {
    throw createDemoOwnershipError(code, message, null, 409);
  }
}

/** 校验 receipt 中的 registry 完整集合仍与当前事务持久事实逐项一致。 */
function assertStrategyReceiptRegistryFacts(db, receiptFacts) {
  const expectedFacts = receiptFacts.registryFacts;
  if (!Array.isArray(expectedFacts) || expectedFacts.length === 0) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_REGISTRY_INVALID',
      '策略评价 registrar receipt 缺少完整 registry 事实。',
      null,
      409
    );
  }
  assertStrategyRegistrarIntentFacts(
    receiptFacts.registryIntents,
    expectedFacts,
    'DEMO_DERIVED_STRATEGY_RECEIPT_REGISTRY_INTENT_MISMATCH',
    '策略评价 registrar receipt registry 事实与写入前合同不一致。'
  );
  const registryIds = expectedFacts.map((item) => Number(item.registryId));
  if (new Set(registryIds).size !== registryIds.length) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_REGISTRY_INVALID',
      '策略评价 registrar receipt registry 集合包含重复项。',
      null,
      409
    );
  }
  expectedFacts.forEach((expectedFact) => {
    const currentFact = readStrategyReceiptRegistryFact(db, Number(expectedFact.registryId));
    if (!currentFact || sha256Stable(currentFact) !== sha256Stable(expectedFact)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_REGISTRY_MISMATCH',
        '策略评价 registrar receipt registry 事实已缺失或被改写。',
        { registryId: Number(expectedFact.registryId) || null },
        409
      );
    }
  });
  return registryIds;
}

/** 校验 receipt relation 完整集合及其所有 derived 端点关系均保持精确一致。 */
function assertStrategyReceiptRelationFacts(db, receiptFacts, registryIds) {
  const expectedFacts = receiptFacts.relationFacts;
  if (!Array.isArray(expectedFacts)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_RELATION_INVALID',
      '策略评价 registrar receipt 缺少完整 relation 事实。',
      null,
      409
    );
  }
  assertStrategyRegistrarIntentFacts(
    receiptFacts.relationIntents,
    expectedFacts,
    'DEMO_DERIVED_STRATEGY_RECEIPT_RELATION_INTENT_MISMATCH',
    '策略评价 registrar receipt relation 事实与写入前意图不一致。'
  );
  const relationIds = expectedFacts.map((item) => Number(item.relationId));
  if (new Set(relationIds).size !== relationIds.length) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_RELATION_INVALID',
      '策略评价 registrar receipt relation 集合包含重复项。',
      null,
      409
    );
  }
  const placeholders = registryIds.map(() => '?').join(', ');
  const currentFacts = db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType, created_at AS createdAt
    FROM demo_data_relations
    WHERE from_registry_id IN (${placeholders}) OR to_registry_id IN (${placeholders})
    ORDER BY relation_id`).all(...registryIds, ...registryIds);
  const normalizedExpectedFacts = [...expectedFacts]
    .sort((left, right) => Number(left.relationId) - Number(right.relationId));
  if (sha256Stable(currentFacts) !== sha256Stable(normalizedExpectedFacts)) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_RELATION_MISMATCH',
      '策略评价 registrar receipt relation 完整集合已缺失、增加或被改写。',
      null,
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
    ['registrarAuthority', 'db', 'registrationScope', 'evaluationWitness'],
    'DEMO_DERIVED_STRATEGY_INPUT_INVALID',
    '策略评价 derived ownership 只能接收 evaluator 固定私有协议字段。'
  );
  const db = input.db;
  const registrationScope = input.registrationScope;
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
    registrationScope,
    ['active']
  );
  let run = null;
  let actorUserId = null;
  let savepointName = null;
  let savepointActive = false;
  try {
    run = requireDemoDatasetRun(db, scopeState.runId);
    actorUserId = requireDemoOwnershipActor(db, { actorUserId: scopeState.actorUserId });
    requireStrategyDerivedActionRun(db, scopeState, run);
    savepointName = createStrategyRegistrationSavepointName('demo_strategy_registrar');
    db.exec(`SAVEPOINT ${savepointName}`);
    savepointActive = true;
  } catch (error) {
    scopeState.status = 'failed';
    throw error;
  }
  try {
    const witnessState = getEnergyStrategyEvaluatorProtocol().consumeWitness({
      registrarAuthority: input.registrarAuthority,
      db,
      registrationScope,
      evaluationWitness: input.evaluationWitness
    });
    scopeState.status = 'registering';
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
    const registryRegisteredAt = new Date().toISOString();
    const registrations = [
      registerSingleDerivedStrategyEntityInTransaction(
        db,
        run,
        actorUserId,
        runContract,
        registryRegisteredAt
      ),
      ...hitContracts.map((contract) => registerSingleDerivedStrategyEntityInTransaction(
        db,
        run,
        actorUserId,
        contract,
        registryRegisteredAt
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
    const relationCreatedAt = new Date().toISOString();
    const relations = registerDemoRelationsInTransaction(
      db,
      { runId: run.runId, createdAt: relationCreatedAt },
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
    const registryIntents = registrations.map((item) => (
      buildExpectedStrategyRegistryFact(
        item.registryId,
        run,
        actorUserId,
        item,
        item.registeredAt
      )
    ));
    const registryFacts = registrations.map((item) => (
      readStrategyReceiptRegistryFact(db, Number(item.registryId))
    ));
    const relationIntentsForReceipt = relationIntents.map((intent, index) => {
      const from = registrations.find((item) => (
        item.entityType === intent.from.entityType && item.entityPk === intent.from.entityPk
      )) || readActiveRegistryEntity(db, intent.from.entityType, intent.from.entityPk);
      const to = registrations.find((item) => (
        item.entityType === intent.to.entityType && item.entityPk === intent.to.entityPk
      )) || readActiveRegistryEntity(db, intent.to.entityType, intent.to.entityPk);
      const relation = relations[index];
      return {
        relationId: Number(relation.relationId),
        runId: run.runId,
        fromRegistryId: Number(from.registryId),
        toRegistryId: Number(to.registryId),
        relationType: intent.relationType,
        createdAt: relation.createdAt || relationCreatedAt
      };
    });
    const relationFacts = relations.map((item) => (
      readStrategyReceiptRelationFact(db, Number(item.relationId))
    ));
    if (registryFacts.some((item) => !item) || relationFacts.some((item) => !item)) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_FACTS_MISSING',
        '策略评价 registrar 写入后无法读取完整 registry/relation 事实。',
        null,
        409
      );
    }
    assertStrategyRegistrarIntentFacts(
      registryIntents,
      registryFacts,
      'DEMO_DERIVED_STRATEGY_REGISTRY_CONTRACT_MISMATCH',
      '策略评价 registry 持久事实与 registrar contract 不一致。'
    );
    assertStrategyRegistrarIntentFacts(
      relationIntentsForReceipt,
      relationFacts,
      'DEMO_DERIVED_STRATEGY_RELATION_INTENT_MISMATCH',
      '策略评价 relation 持久事实与 registrar intent 不一致。'
    );
    const operationAuditFact = assertStrategyWitnessOperationAudit(db, witnessState);
    const receipt = Object.freeze({});
    const receiptFacts = {
      registrarAuthority: input.registrarAuthority,
      db,
      registrationScope,
      evaluationWitness: input.evaluationWitness,
      runId: run.runId,
      evaluationRunId,
      operationAuditId: witnessState.operationAuditId,
      operationAuditFact: cloneFrozenStrategyOwnershipSnapshot(operationAuditFact),
      registryIntents: cloneFrozenStrategyOwnershipSnapshot(registryIntents),
      relationIntents: cloneFrozenStrategyOwnershipSnapshot(relationIntentsForReceipt),
      registryFacts: cloneFrozenStrategyOwnershipSnapshot(registryFacts),
      relationFacts: cloneFrozenStrategyOwnershipSnapshot(relationFacts),
      status: 'issued'
    };
    db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    savepointActive = false;
    scopeState.status = 'registered';
    DEMO_STRATEGY_RECEIPT_STATE.set(receipt, receiptFacts);
    return receipt;
  } catch (error) {
    scopeState.status = 'failed';
    if (savepointActive) {
      const recovery = db.inTransaction === true
        ? recoverStrategyRegistrarSavepoint(db, savepointName)
        : { rollbackError: null, releaseError: null, fullRollbackError: null, closeError: null };
      savepointActive = false;
      if (recovery.rollbackError || recovery.releaseError
        || recovery.fullRollbackError || recovery.closeError) {
        throw createDemoOwnershipError(
          'DEMO_DERIVED_STRATEGY_REGISTRAR_RECOVERY_FAILED',
          '策略评价 registrar 私有 SAVEPOINT 恢复失败，禁止继续提交外层事务。',
          {
            originalCode: error.code || error.details?.code || null,
            rollbackCode: recovery.rollbackError?.code || null,
            releaseCode: recovery.releaseError?.code || null,
            fullRollbackCode: recovery.fullRollbackError?.code || null,
            closeCode: recovery.closeError?.code || null
          },
          500
        );
      }
    }
    if (db.inTransaction === true && scopeState.markerId) {
      try {
        cleanupStrategyScopeMarker(db, scopeState);
      } catch (cleanupError) {
        const failClosed = failClosedStrategyRegistrarTransaction(db);
        throw createDemoOwnershipError(
          'DEMO_DERIVED_STRATEGY_REGISTRAR_RECOVERY_FAILED',
          '策略评价 registrar 失败后无法清理事务 marker，已完整回滚外层事务。',
          {
            originalCode: error.code || error.details?.code || null,
            cleanupCode: cleanupError.code || cleanupError.details?.code || null,
            fullRollbackCode: failClosed.fullRollbackError?.code || null,
            closeCode: failClosed.closeError?.code || null
          },
          500
        );
      }
    }
    throw error;
  }
}

/**
 * 在 evaluator 外层 SAVEPOINT 释放前一次性验证 registrar receipt 的原始身份和完整持久事实。
 * clone、JSON clone、错库、错 scope、错 witness 和重放均 fail-closed。
 */
function verifyDerivedStrategyEvaluationReceiptInTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['registrarAuthority', 'db', 'registrationScope', 'evaluationWitness', 'receipt'],
    'DEMO_DERIVED_STRATEGY_RECEIPT_INPUT_INVALID',
    '策略评价 registrar receipt verifier 只能接收固定私有协议字段。'
  );
  const receiptFacts = input.receipt && typeof input.receipt === 'object'
    ? DEMO_STRATEGY_RECEIPT_STATE.get(input.receipt)
    : null;
  if (!receiptFacts) {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_CAPABILITY_REQUIRED',
      '策略评价必须使用正式 registrar 返回的原始 receipt。',
      null,
      409
    );
  }
  if (DEMO_STRATEGY_RECEIPT_CONSUMED.has(input.receipt) || receiptFacts.status !== 'issued') {
    throw createDemoOwnershipError(
      'DEMO_DERIVED_STRATEGY_RECEIPT_REPLAY',
      '策略评价 registrar receipt 已消费或失效。',
      null,
      409
    );
  }
  let scopeState = null;
  try {
    if (input.registrarAuthority !== receiptFacts.registrarAuthority) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_AUTHORITY_MISMATCH',
        '策略评价 registrar receipt authority 对象身份不一致。',
        null,
        409
      );
    }
    if (input.db !== receiptFacts.db || input.db?.inTransaction !== true) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_TRANSACTION_MISMATCH',
        '策略评价 registrar receipt 必须在原 caller transaction 中验证。',
        null,
        409
      );
    }
    if (input.registrationScope !== receiptFacts.registrationScope
      || input.evaluationWitness !== receiptFacts.evaluationWitness) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_BINDING_MISMATCH',
        '策略评价 registrar receipt 与 registration scope 或 completion witness 不一致。',
        null,
        409
      );
    }
    scopeState = requireStrategyRegistrationScopeState(
      input.db,
      input.registrationScope,
      ['registered']
    );
    if (scopeState.runId !== receiptFacts.runId) {
      throw createDemoOwnershipError(
        'DEMO_DERIVED_STRATEGY_RECEIPT_RUN_MISMATCH',
        '策略评价 registrar receipt 与演示 run 绑定不一致。',
        null,
        409
      );
    }
    assertStrategyWitnessOperationAudit(input.db, {
      operationAuditId: receiptFacts.operationAuditId,
      operationAuditSnapshot: receiptFacts.operationAuditFact
    });
    const registryIds = assertStrategyReceiptRegistryFacts(input.db, receiptFacts);
    assertStrategyReceiptRelationFacts(input.db, receiptFacts, registryIds);
    cleanupStrategyScopeMarker(input.db, scopeState);
    receiptFacts.status = 'consumed';
    DEMO_STRATEGY_RECEIPT_CONSUMED.add(input.receipt);
    scopeState.status = 'consumed';
    return true;
  } catch (error) {
    receiptFacts.status = 'failed';
    if (scopeState && scopeState.status !== 'consumed') scopeState.status = 'failed';
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

/** 读取当前 run 中指定 artifact/entity 的 active imported registry，关系准备只使用服务端已登记事实。 */
function readActiveImportedStrategyInputRegistryRows(db, runId, artifactKey, entityType) {
  return db.prepare(`SELECT registry_id AS registryId, entity_pk AS entityPk
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(runId, artifactKey, entityType).map((row) => ({
    registryId: Number(row.registryId),
    entityPk: String(row.entityPk)
  }));
}

/** 构造 artifact 15 时序到 artifact 18 规则的 imported uses_config 笛卡尔闭包。 */
function buildStrategyInputRelationClosureInTransaction(db, context) {
  if (!context || !DEMO_STRATEGY_INPUT_ARTIFACT_KEYS.has(context.artifactKey)) return [];
  const timeseriesRows = readActiveImportedStrategyInputRegistryRows(
    db,
    context.runId,
    '15-energy-timeseries',
    'energy_timeseries'
  );
  const ruleRows = readActiveImportedStrategyInputRegistryRows(
    db,
    context.runId,
    '18-strategy-rules',
    'strategy_rule'
  );
  return timeseriesRows.flatMap((timeseries) => ruleRows.map((rule) => ({
    from: { entityType: 'energy_timeseries', entityPk: timeseries.entityPk },
    to: { entityType: 'strategy_rule', entityPk: rule.entityPk },
    relationType: 'uses_config'
  })));
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
  if (demoContext.artifactKey === DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey
    && scopeState.managedPredictionOperationActive !== true) {
    throw createDemoOwnershipError(
      'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED',
      'Artifact 12 ownership 只能由单一 managed operation 登记。',
      null,
      409
    );
  }
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
  // 调用方领域关系与固定 strategy 输入关系分别校验登记，避免相同合法关系在单次输入中被误判为重复。
  const requestedRelations = registerDemoRelationsInTransaction(db, context, input.relations);
  // strategy 输入关系由已完成 imported ownership 登记后的服务端事实构造，不接受 preview 或请求正文补写。
  const strategyInputRelations = registerDemoRelationsInTransaction(
    db,
    context,
    buildStrategyInputRelationClosureInTransaction(db, context)
  );
  const relationsById = new Map();
  [...requestedRelations, ...strategyInputRelations].forEach((relation) => {
    relationsById.set(Number(relation.relationId), relation);
  });
  const relations = [...relationsById.values()];
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

/** 一次性捕获 prediction service 的非枚举 managed core 协议。 */
function getPredictionConfigManagedCoreProtocol() {
  if (predictionConfigManagedCoreProtocol) return predictionConfigManagedCoreProtocol;
  const predictionService = require('./predictionService');
  const protocol = predictionService[PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL];
  const requiredHandlers = [
    'assertBatchMatches', 'getAuditSummary', 'getBatch', 'getConfigById',
    'projectAuditIssues', 'projectBackup', 'projectOwnership', 'rebuildPreview'
  ];
  if (!protocol || requiredHandlers.some((fieldName) => typeof protocol[fieldName] !== 'function')
    || typeof protocol.backupReason !== 'string') {
    throw createDemoOwnershipError(
      'DEMO_PREDICTION_CONFIG_CORE_PROTOCOL_UNAVAILABLE',
      'Artifact 12 prediction config managed core 协议未完成初始化。',
      null,
      500
    );
  }
  predictionConfigManagedCoreProtocol = Object.freeze({
    assertBatchMatches: protocol.assertBatchMatches,
    backupReason: protocol.backupReason,
    getAuditSummary: protocol.getAuditSummary,
    getBatch: protocol.getBatch,
    getConfigById: protocol.getConfigById,
    projectAuditIssues: protocol.projectAuditIssues,
    projectBackup: protocol.projectBackup,
    projectOwnership: protocol.projectOwnership,
    rebuildPreview: protocol.rebuildPreview
  });
  return predictionConfigManagedCoreProtocol;
}

/** 触发 Artifact 12 固定阶段故障注入，不向测试钩子暴露 SQLite 连接或事务 scope。 */
function invokeManagedPredictionOperationFault(intent, stage, facts = {}) {
  if (typeof intent.faultInjector === 'function') {
    intent.faultInjector(stage, Object.freeze({ ...facts }));
  }
}

/** 读取并投影 import_errors 的 exact canonical 集合。 */
function readManagedPredictionAuditIssues(db, batchId) {
  return db.prepare(`SELECT row_number AS rowNumber, field_name AS fieldName,
      raw_value AS rawValue, error_code AS errorCode,
      error_reason AS errorReason, severity
    FROM import_errors WHERE batch_id = ? ORDER BY row_number, id`).all(batchId).map((issue) => ({
    rowNumber: Number(issue.rowNumber),
    fieldName: issue.fieldName,
    rawValue: issue.rawValue,
    errorCode: issue.errorCode,
    errorReason: issue.errorReason,
    severity: issue.severity
  }));
}

/** 比较 retained 重建结果与持久行级审计的 exact canonical 集合。 */
function assertManagedPredictionAuditIssuesMatch(db, batchId, expectedIssues) {
  const actualIssues = readManagedPredictionAuditIssues(db, batchId);
  if (JSON.stringify(actualIssues) !== JSON.stringify(expectedIssues)) {
    throw createManagedPredictionClosureError('prediction-import-errors-drift', {
      batchId,
      expectedCount: expectedIssues.length,
      actualCount: actualIssues.length
    });
  }
  return actualIssues;
}

/** 快照受控备份目录中的既有文件名，用于证明补偿目标由当前 operation 新建。 */
function snapshotManagedPredictionBackupNames(backupRoot = defaultBackupsDir) {
  try {
    const rootPath = path.resolve(backupRoot);
    const rootStat = fs.lstatSync(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return new Set();
    return new Set(fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
}

/** 仅为当前 operation 新建且具备 exact name/size/SHA 的备份建立补偿删除凭据。 */
function buildManagedPredictionBackupCompensation(backupRoot, backup, existingNames) {
  const backupName = typeof backup?.backupName === 'string'
    ? backup.backupName
    : null;
  const sizeBytes = Number(backup?.sizeBytes);
  const sha256 = typeof backup?.sha256 === 'string'
    ? backup.sha256
    : null;
  const safeToDelete = Boolean(
    backup && typeof backup === 'object' && !Array.isArray(backup)
    && backupName && backupName === path.basename(backupName)
    && !existingNames.has(backupName)
    && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
    && sha256 && /^[0-9a-f]{64}$/.test(sha256)
  );
  return Object.freeze({
    backupRoot: path.resolve(backupRoot),
    backupName,
    sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : null,
    sha256,
    safeToDelete
  });
}

/** 回滚后按 exact name/size/SHA 删除当前 operation 新建的备份，任何漂移均拒绝删除。 */
function compensateManagedPredictionBackupFile(compensation) {
  if (!compensation) return { attempted: false, deleted: false };
  if (compensation.safeToDelete !== true) {
    throw createManagedPredictionClosureError('prediction-backup-compensation-credential-invalid', {
      backupName: compensation.backupName || null
    });
  }
  const safeBackup = readSafeUploadFile(
    compensation.backupRoot,
    compensation.backupName,
    { expectedSizeBytes: compensation.sizeBytes }
  );
  if (safeBackup.fileSha256 !== compensation.sha256) {
    throw createManagedPredictionClosureError('prediction-backup-compensation-sha256-mismatch', {
      backupName: compensation.backupName
    });
  }
  const quarantineName = `.prediction-backup-rollback-${crypto.randomUUID()}.tmp`;
  const quarantinePath = path.join(compensation.backupRoot, quarantineName);
  fs.renameSync(safeBackup.filePath, quarantinePath);
  try {
    const quarantinedBackup = readSafeUploadFile(
      compensation.backupRoot,
      quarantineName,
      { expectedSizeBytes: compensation.sizeBytes }
    );
    if (quarantinedBackup.fileSha256 !== compensation.sha256) {
      throw createManagedPredictionClosureError('prediction-backup-compensation-sha256-mismatch', {
        backupName: compensation.backupName
      });
    }
    fs.rmSync(quarantinedBackup.filePath, { force: false });
  } catch (error) {
    const originalPath = path.join(compensation.backupRoot, compensation.backupName);
    try {
      if (fs.existsSync(quarantinePath) && !fs.existsSync(originalPath)) {
        fs.renameSync(quarantinePath, originalPath);
      }
    } catch (_restoreError) {
      // 保留原 cleanup error；安全审计会记录补偿失败，且不得删除无法复验的文件。
    }
    throw error;
  }
  return { attempted: true, deleted: true };
}

/** 补偿清理失败时持久记录安全审计；审计失败则输出最小安全日志，均不得覆盖原业务错误。 */
function reportManagedPredictionBackupCompensationFailure(state, compensation, cleanupError) {
  const detail = {
    backupName: compensation?.backupName || null,
    sizeBytes: compensation?.sizeBytes || null,
    sha256: compensation?.sha256 || null,
    cleanupCode: cleanupError?.details?.code || cleanupError?.code || 'UNKNOWN'
  };
  try {
    recordOperation({
      userId: state.managedPredictionActorUserId || null,
      operation: 'prediction.config.import.backup.compensation.failed',
      targetType: 'prediction_config_import',
      targetId: state.managedPredictionBatchId || null,
      detail,
      ip: state.managedPredictionActorIp || null,
      db: state.privateDb
    });
  } catch (auditError) {
    console.error('[prediction-backup-compensation-failed]', JSON.stringify({
      batchId: state.managedPredictionBatchId || null,
      backupName: detail.backupName,
      cleanupCode: detail.cleanupCode,
      auditCode: auditError?.details?.code || auditError?.code || 'UNKNOWN'
    }));
  }
}

/** 校验 mandatory backup 元数据与受控目录中的实际文件 size/SHA。 */
function verifyManagedPredictionBackupFile(
  backup,
  backupRoot = defaultBackupsDir,
  expectedReason = null
) {
  const expectedFields = [
    'backupName', 'reason', 'method', 'sizeBytes',
    'createdAt', 'updatedAt', 'sha256'
  ].sort();
  const actualFields = backup && typeof backup === 'object' && !Array.isArray(backup)
    ? Object.keys(backup).sort()
    : [];
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)
    || actualFields.length !== expectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== expectedFields[index])
    || typeof backup.backupName !== 'string' || !backup.backupName
    || typeof backup.reason !== 'string' || !backup.reason
    || (expectedReason !== null && backup.reason !== expectedReason)
    || typeof backup.method !== 'string' || !backup.method
    || typeof backup.createdAt !== 'string' || !DEMO_UTC_MILLISECOND_PATTERN.test(backup.createdAt)
    || typeof backup.updatedAt !== 'string' || !DEMO_UTC_MILLISECOND_PATTERN.test(backup.updatedAt)
    || !Number.isSafeInteger(Number(backup.sizeBytes)) || Number(backup.sizeBytes) < 1
    || typeof backup.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(backup.sha256)) {
    throw createManagedPredictionClosureError('prediction-backup-metadata-invalid');
  }
  let safeBackup;
  try {
    safeBackup = readSafeUploadFile(backupRoot, backup.backupName, {
      expectedSizeBytes: Number(backup.sizeBytes)
    });
  } catch (error) {
    throw createManagedPredictionClosureError('prediction-backup-file-invalid', {
      backupName: backup.backupName,
      causeCode: error?.details?.code || error?.code || null
    });
  }
  if (safeBackup.fileSha256 !== backup.sha256) {
    throw createManagedPredictionClosureError('prediction-backup-file-sha256-invalid', {
      backupName: backup.backupName
    });
  }
  return safeBackup;
}

/** 计算 Artifact 12 retained/audit/backup/business/ownership 的 stable closure digest。 */
function calculateManagedPredictionConfigClosureDigest(input) {
  return sha256Stable({
    domain: 'artifact-12-managed-retained-closure:v1',
    runId: input.runId,
    contextId: input.contextId,
    batchId: Number(input.batchId),
    trainingBatchId: Number(input.trainingBatchId),
    retainedFileSha256: input.retainedFileSha256,
    previewSignature: input.previewSignature,
    previewAuditDigest: input.previewAuditDigest,
    auditIssues: input.auditIssues,
    backup: input.backup,
    configId: Number(input.configId),
    identityDigest: input.identityDigest,
    snapshotDigest: input.snapshotDigest
  });
}

/** 构造 Artifact 12 闭包校验的稳定冲突错误。 */
function createManagedPredictionClosureError(reason, details = null) {
  return createDemoOwnershipError(
    'DEMO_PREDICTION_CONFIG_CLOSURE_INVALID',
    'Artifact 12 预测配置 managed 闭包不完整或已漂移。',
    { reason, ...(details || {}) },
    409
  );
}

/** 读取 Artifact 12 context，并校验其仍属于固定 run、actor、runtime 和 manifest。 */
function readManagedPredictionContext(db, contextId) {
  const context = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
    FROM demo_import_contexts WHERE context_id = ?`).get(contextId);
  if (!context
    || context.artifactKey !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey
    || context.handlerKey !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.handlerKey
    || !['previewed', 'executed'].includes(context.status)) {
    throw createManagedPredictionClosureError('prediction-context-invalid', { contextId });
  }
  return context;
}

/** 从同一 run 重建并严格复验 Artifact 07 唯一 executed primary 训练批次。 */
function readManagedMonthlyEnergyPrimaryForPrediction(db, predictionContextId, state = null) {
  const predictionContext = readManagedPredictionContext(db, predictionContextId);
  const energyContexts = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, issued_to_user_id AS issuedToUserId,
      runtime_epoch AS runtimeEpoch, status, preview_digest AS previewDigest
    FROM demo_import_contexts
    WHERE run_id = ? AND artifact_key = ? AND handler_key = ? AND status = 'executed'
    ORDER BY context_id`).all(
    predictionContext.runId,
    DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey,
    DEMO_MANAGED_DIRECT_IMPORT_BINDING.handlerKey
  );
  if (energyContexts.length !== 1) {
    throw createManagedPredictionClosureError('monthly-energy-executed-context-count-invalid', {
      runId: predictionContext.runId,
      contextCount: energyContexts.length
    });
  }
  const energyContext = energyContexts[0];
  if (energyContext.runId !== predictionContext.runId
    || energyContext.datasetId !== predictionContext.datasetId
    || energyContext.manifestVersion !== predictionContext.manifestVersion
    || energyContext.manifestDigest !== predictionContext.manifestDigest
    || energyContext.runtimeEpoch !== predictionContext.runtimeEpoch
    || Number(energyContext.issuedToUserId) !== Number(predictionContext.issuedToUserId)
    || energyContext.artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
    || energyContext.handlerKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.handlerKey
    || !energyContext.previewDigest) {
    throw createManagedPredictionClosureError('monthly-energy-context-binding-invalid', {
      contextId: energyContext.contextId
    });
  }
  const bindings = db.prepare(`SELECT rib.run_id AS runId, rib.artifact_key AS artifactKey,
      rib.context_id AS contextId, rib.import_batch_id AS batchId,
      rib.batch_role AS batchRole, ib.import_type AS importType
    FROM demo_run_import_batches rib
    JOIN import_batches ib ON ib.id = rib.import_batch_id
    WHERE rib.context_id = ?
    ORDER BY rib.batch_role, rib.import_batch_id`).all(energyContext.contextId);
  if (bindings.length !== 1
    || bindings[0].runId !== predictionContext.runId
    || bindings[0].artifactKey !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.artifactKey
    || bindings[0].contextId !== energyContext.contextId
    || bindings[0].batchRole !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.batchRole
    || bindings[0].importType !== DEMO_MANAGED_DIRECT_IMPORT_BINDING.importType) {
    throw createManagedPredictionClosureError('monthly-energy-primary-binding-invalid', {
      contextId: energyContext.contextId
    });
  }
  const batchId = Number(bindings[0].batchId);
  const closureState = state || { privateDb: db, pendingWitnesses: new Set() };
  const facts = verifyManagedDirectCompletedClosure(closureState, {
    batchId,
    contextId: energyContext.contextId,
    runId: predictionContext.runId,
    actorUserId: Number(predictionContext.issuedToUserId),
    previewDigest: energyContext.previewDigest,
    expectedContextStatus: 'executed'
  });
  if (facts.writesBusinessRecords !== true || facts.statistics.successCount < 1) {
    throw createManagedPredictionClosureError('monthly-energy-business-rows-required', { batchId });
  }
  return {
    batchId,
    contextId: energyContext.contextId,
    runId: predictionContext.runId,
    recordCount: facts.statistics.successCount,
    ownershipClosureDigest: facts.ownershipClosureDigest
  };
}

/** 复验 Artifact 12 唯一 draft 配置、execute audit、binding 与 active imported ownership。 */
function readManagedPredictionConfigClosure(db, input) {
  const context = readManagedPredictionContext(db, input.contextId);
  if (context.status !== input.expectedContextStatus
    || context.runId !== input.runId
    || Number(context.issuedToUserId) !== Number(input.actorUserId)
    || context.artifactFileSha256 !== input.retainedFileSha256
    || context.uploadFileSha256 !== input.retainedFileSha256) {
    throw createManagedPredictionClosureError('prediction-context-terminal-facts-invalid', {
      contextId: input.contextId
    });
  }
  const bindings = db.prepare(`SELECT run_id AS runId, artifact_key AS artifactKey,
      context_id AS contextId, import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ?
    ORDER BY batch_role, import_batch_id`).all(input.contextId);
  if (bindings.length !== 1
    || bindings[0].runId !== context.runId
    || bindings[0].artifactKey !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey
    || bindings[0].contextId !== context.contextId
    || Number(bindings[0].batchId) !== Number(input.batchId)
    || bindings[0].batchRole !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole) {
    throw createManagedPredictionClosureError('prediction-primary-binding-invalid', {
      batchId: input.batchId
    });
  }
  const executedContexts = db.prepare(`SELECT context_id AS contextId
    FROM demo_import_contexts
    WHERE run_id = ? AND artifact_key = ? AND handler_key = ? AND status = 'executed'
    ORDER BY context_id`).all(
    context.runId,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.handlerKey
  );
  const executedContextValid = input.expectedContextStatus === 'previewed'
    ? executedContexts.length === 0
    : executedContexts.length === 1 && executedContexts[0].contextId === context.contextId;
  if (!executedContextValid) {
    throw createManagedPredictionClosureError('prediction-executed-context-count-invalid', {
      runId: context.runId,
      contextCount: executedContexts.length
    });
  }
  const batch = db.prepare(`SELECT import_type AS importType, status,
      audit_phase AS auditPhase, preview_signature AS previewSignature,
      preview_audit_digest AS previewDigest, execute_result_json AS executeResultJson,
      backup_json AS backupJson, file_sha256 AS fileSha256,
      total_rows AS totalRows, success_count AS successCount,
      failure_count AS failureCount, skipped_count AS skippedCount
    FROM import_batches WHERE id = ?`).get(input.batchId);
  const statistics = batch ? {
    totalRows: Number(batch.totalRows),
    successCount: Number(batch.successCount),
    failureCount: Number(batch.failureCount),
    skippedCount: Number(batch.skippedCount)
  } : null;
  if (!batch || batch.importType !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
    || !['completed', 'completed_with_errors'].includes(batch.status)
    || batch.auditPhase !== 'execute' || batch.previewDigest !== context.previewDigest
    || batch.previewDigest !== input.preview.previewAuditDigest
    || batch.previewSignature !== input.preview.previewSignature
    || batch.fileSha256 !== input.retainedFileSha256
    || !statistics || statistics.successCount !== 1
    || statistics.totalRows < 1
    || statistics.successCount + statistics.failureCount + statistics.skippedCount !== statistics.totalRows) {
    throw createManagedPredictionClosureError('prediction-execute-audit-invalid', {
      batchId: input.batchId
    });
  }
  const auditIssues = assertManagedPredictionAuditIssuesMatch(
    db,
    Number(input.batchId),
    input.expectedAuditIssues
  );
  let backup;
  try {
    backup = JSON.parse(batch.backupJson);
  } catch (_error) {
    throw createManagedPredictionClosureError('prediction-backup-json-invalid', {
      batchId: input.batchId
    });
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw createManagedPredictionClosureError('prediction-backup-json-invalid', {
      batchId: input.batchId
    });
  }
  verifyManagedPredictionBackupFile(
    backup,
    input.backupsDir,
    input.backupReason
  );
  const configs = db.prepare(`SELECT id, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, source_batch_filter_id AS sourceBatchFilterId,
      status FROM prediction_configs WHERE source_batch_id = ? ORDER BY id`).all(input.batchId);
  if (configs.length !== 1
    || Number(configs[0].sourceBatchId) !== Number(input.batchId)
    || !Number.isSafeInteger(Number(configs[0].sourceRowNumber))
    || Number(configs[0].sourceRowNumber) < 1
    || Number(configs[0].sourceBatchFilterId) !== Number(input.trainingBatchId)
    || configs[0].status !== 'draft') {
    throw createManagedPredictionClosureError('prediction-business-row-invalid', {
      batchId: input.batchId,
      configCount: configs.length
    });
  }
  const configId = Number(configs[0].id);
  const handler = getDemoOwnershipEntityHandler(DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType);
  const projectedRow = handler.readProjection(db, configId);
  const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, registered_by AS registeredBy,
      cleaned_at AS cleanedAt
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(
    context.runId,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
  );
  const registry = registryRows[0];
  if (!projectedRow || registryRows.length !== 1
    || String(registry.entityPk) !== String(configId)
    || registry.runId !== context.runId
    || registry.artifactKey !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey
    || registry.entityType !== DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
    || registry.ownershipKind !== DEMO_IMPORTED_OWNERSHIP_KIND
    || Number(registry.sourceBatchId) !== Number(input.batchId)
    || Number(registry.sourceRowNumber) !== Number(configs[0].sourceRowNumber)
    || Number(registry.registeredBy) !== Number(input.actorUserId)) {
    throw createManagedPredictionClosureError('prediction-ownership-provenance-invalid', {
      batchId: input.batchId
    });
  }
  const identityDigest = calculateDemoEntityIdentityDigest(
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
    String(configId)
  );
  const snapshotDigest = calculateDemoEntitySnapshotDigest(
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
    String(configId),
    projectedRow
  );
  if (registry.identityDigest !== identityDigest || registry.snapshotDigest !== snapshotDigest) {
    throw createManagedPredictionClosureError('prediction-ownership-digest-invalid', {
      configId
    });
  }
  let executeResult;
  try {
    executeResult = JSON.parse(batch.executeResultJson);
  } catch (_error) {
    throw createManagedPredictionClosureError('prediction-execute-result-json-invalid', {
      batchId: input.batchId
    });
  }
  const terminalClosureValid = input.expectedContextStatus === 'executed'
    ? isManagedContextTerminalClosureExact(
        context,
        executeResult?.contextTerminal,
        batch.previewSignature
      )
    : !Object.prototype.hasOwnProperty.call(executeResult || {}, 'contextTerminal');
  if (!terminalClosureValid) {
    throw createManagedPredictionClosureError('prediction-context-terminal-closure-drift', {
      contextId: input.contextId,
      batchId: input.batchId
    });
  }
  const importedIds = Array.isArray(executeResult?.importedIds)
    ? executeResult.importedIds.map(Number)
    : [];
  const importedRecords = Array.isArray(executeResult?.importedRecords)
    ? executeResult.importedRecords
    : [];
  const ownership = executeResult && executeResult.ownership;
  const closureDigest = calculateManagedPredictionConfigClosureDigest({
    runId: context.runId,
    contextId: context.contextId,
    batchId: input.batchId,
    trainingBatchId: input.trainingBatchId,
    retainedFileSha256: input.retainedFileSha256,
    previewSignature: input.preview.previewSignature,
    previewAuditDigest: input.preview.previewAuditDigest,
    auditIssues,
    backup,
    configId,
    identityDigest,
    snapshotDigest
  });
  if (executeResult?.executed !== true
    || Number(executeResult.imported) !== 1
    || Number(executeResult.sourceTrainingBatchId) !== Number(input.trainingBatchId)
    || executeResult.previewSignature !== batch.previewSignature
    || executeResult.previewAuditDigest !== batch.previewDigest
    || importedIds.length !== 1 || importedIds[0] !== configId
    || importedRecords.length !== 1 || Number(importedRecords[0]?.id) !== configId
    || Number(importedRecords[0]?.sourceBatchId) !== Number(input.batchId)
    || Number(importedRecords[0]?.sourceBatchFilterId) !== Number(input.trainingBatchId)
    || importedRecords[0]?.status !== 'draft'
    || sha256Stable(executeResult.backup) !== sha256Stable(backup)
    || ownership?.applied !== true || ownership.mode !== 'demo'
    || ownership.closureDigest !== closureDigest
    || Number(ownership.registrationCount) !== 1
    || Number(ownership.insertedCount) !== 1
    || Number(ownership.idempotentCount) !== 0
    || Number(ownership.skippedCount) !== statistics.skippedCount
    || Number(ownership.relationCount) !== 0) {
    throw createManagedPredictionClosureError('prediction-execute-result-drift', {
      batchId: input.batchId,
      configId
    });
  }
  const operationLogs = db.prepare(`SELECT operation, user_id AS userId, detail_json AS detailJson
    FROM sys_operation_logs
    WHERE operation IN (
        'prediction.config.import.preview',
        'prediction.config.import.execute'
      )
      AND target_type = 'prediction_config_import' AND target_id = ?
    ORDER BY id`).all(String(input.batchId));
  const previewOperationLogs = operationLogs.filter(
    (row) => row.operation === 'prediction.config.import.preview'
  );
  const executeOperationLogs = operationLogs.filter(
    (row) => row.operation === 'prediction.config.import.execute'
  );
  if (previewOperationLogs.length !== 1 || executeOperationLogs.length !== 1
    || Number(previewOperationLogs[0].userId) !== Number(input.actorUserId)
    || Number(executeOperationLogs[0].userId) !== Number(input.actorUserId)) {
    throw createManagedPredictionClosureError('prediction-operation-audit-invalid', {
      batchId: input.batchId,
      previewOperationCount: previewOperationLogs.length,
      executeOperationCount: executeOperationLogs.length
    });
  }
  let previewOperationDetail;
  let executeOperationDetail;
  try {
    previewOperationDetail = JSON.parse(previewOperationLogs[0].detailJson);
    executeOperationDetail = JSON.parse(executeOperationLogs[0].detailJson);
  } catch (_error) {
    throw createManagedPredictionClosureError('prediction-operation-audit-invalid', {
      batchId: input.batchId
    });
  }
  if (!hasExactManagedDirectFields(previewOperationDetail, ['blocked', 'wouldImport'])
    || Number(previewOperationDetail.wouldImport) !== Number(input.preview.summary.wouldImport)
    || Number(previewOperationDetail.blocked) !== Number(input.preview.summary.blocked)
    || !hasExactManagedDirectFields(executeOperationDetail, [
      'imported', 'writesPredictionRuns', 'writesPredictionResults'
    ])
    || Number(executeOperationDetail.imported) !== 1
    || executeOperationDetail.writesPredictionRuns !== false
    || executeOperationDetail.writesPredictionResults !== false) {
    throw createManagedPredictionClosureError('prediction-operation-audit-invalid', {
      batchId: input.batchId,
      previewOperationDetail,
      executeOperationDetail
    });
  }
  return {
    batchId: Number(input.batchId),
    configId,
    contextId: context.contextId,
    runId: context.runId,
    trainingBatchId: Number(input.trainingBatchId),
    identityDigest,
    snapshotDigest,
    closureDigest
  };
}

/** 读取并验证 managed source 唯一 executed context 与 primary batch 的冻结治理事实。 */
function readManagedSourceExecutedContext(db, input) {
  const contexts = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
    FROM demo_import_contexts
    WHERE run_id = ? AND artifact_key = ? AND handler_key = ? AND status = 'executed'
    ORDER BY context_id`).all(input.runId, input.artifactKey, input.handlerKey);
  if (contexts.length !== 1) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source 必须存在唯一正确 executed context。',
      { artifactKey: input.artifactKey, reason: 'executed-context-count', count: contexts.length },
      409
    );
  }
  const context = contexts[0];
  const timestampFields = ['issuedAt', 'expiresAt', 'executedAt'];
  const validContext = context.runId === input.runId
    && context.datasetId === input.demoRun.datasetId
    && context.manifestVersion === input.demoRun.manifestVersion
    && context.manifestDigest === input.demoRun.manifestDigest
    && context.artifactKey === input.artifactKey
    && context.handlerKey === input.handlerKey
    && Number(context.issuedToUserId) === input.actorUserId
    && Number(context.runtimeEpoch) === input.runtimeEpoch
    && context.status === 'executed'
    && timestampFields.every((fieldName) => (
      typeof context[fieldName] === 'string'
        && DEMO_UTC_MILLISECOND_PATTERN.test(context[fieldName])
    ))
    && (context.previewedAt === null
      || (typeof context.previewedAt === 'string'
        && DEMO_UTC_MILLISECOND_PATTERN.test(context.previewedAt)))
    && typeof context.artifactFileSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(context.artifactFileSha256)
    && context.uploadFileSha256 === context.artifactFileSha256
    && typeof context.previewDigest === 'string'
    && /^hmac-sha256:v1:audit:[0-9a-f]{64}$/.test(context.previewDigest);
  if (!validContext) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source context 的 manifest、runtime、actor、时间或摘要事实已漂移。',
      { artifactKey: input.artifactKey, reason: 'executed-context-facts' },
      409
    );
  }
  const primaryBindings = db.prepare(`SELECT rib.run_id AS runId,
      rib.artifact_key AS artifactKey, rib.context_id AS contextId,
      rib.import_batch_id AS batchId, rib.batch_role AS batchRole,
      ib.import_type AS importType, ib.preview_signature AS previewSignature,
      ib.execute_result_json AS executeResultJson
    FROM demo_run_import_batches rib
    JOIN demo_import_contexts dic ON dic.context_id = rib.context_id
    JOIN import_batches ib ON ib.id = rib.import_batch_id
    WHERE rib.run_id = ? AND rib.artifact_key = ? AND rib.batch_role = 'primary'
      AND dic.status = 'executed'
    ORDER BY rib.context_id, rib.import_batch_id`).all(input.runId, input.artifactKey);
  if (primaryBindings.length !== 1
    || primaryBindings[0].runId !== input.runId
    || primaryBindings[0].artifactKey !== input.artifactKey
    || primaryBindings[0].contextId !== context.contextId
    || primaryBindings[0].batchRole !== 'primary'
    || primaryBindings[0].importType !== input.importType) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source 缺少唯一 active primary batch binding。',
      { artifactKey: input.artifactKey, reason: 'primary-binding' },
      409
    );
  }
  const primaryBinding = primaryBindings[0];
  let executeResult;
  try {
    executeResult = JSON.parse(primaryBinding.executeResultJson);
  } catch (_error) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source execute_result terminal baseline 无法解析。',
      { artifactKey: input.artifactKey, reason: 'context-terminal-json' },
      409
    );
  }
  if (!isManagedContextTerminalClosureExact(
    context,
    executeResult?.contextTerminal,
    primaryBinding.previewSignature
  )) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source 当前 context 与 execute-time terminal baseline 不一致。',
      { artifactKey: input.artifactKey, reason: 'context-terminal-drift' },
      409
    );
  }
  return {
    context,
    batchId: Number(primaryBinding.batchId),
    contextTerminalDigest: sha256Stable(executeResult.contextTerminal)
  };
}

/** 验证 managed source retained upload 的名称、大小与实际 SHA 均未漂移。 */
function verifyManagedSourceRetainedFile(db, context, batchId, uploadsRoot = defaultUploadsDir) {
  const batch = db.prepare(`SELECT stored_filename AS storedFilename,
      file_size_bytes AS fileSizeBytes, file_sha256 AS fileSha256
    FROM import_batches WHERE id = ?`).get(batchId);
  if (!batch || typeof batch.storedFilename !== 'string' || !batch.storedFilename
    || !Number.isSafeInteger(Number(batch.fileSizeBytes)) || Number(batch.fileSizeBytes) < 1
    || typeof batch.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(batch.fileSha256)) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source retained upload metadata 无效。',
      { batchId, reason: 'retained-metadata' },
      409
    );
  }
  let safeFile;
  try {
    safeFile = readSafeUploadFile(uploadsRoot, batch.storedFilename, {
      expectedSizeBytes: Number(batch.fileSizeBytes),
      maxSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES
    });
  } catch (error) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source retained upload 无法安全复验。',
      { batchId, reason: error?.details?.code || error?.code || 'retained-read' },
      409
    );
  }
  if (safeFile.fileSha256 !== batch.fileSha256
    || safeFile.fileSha256 !== context.artifactFileSha256
    || safeFile.fileSha256 !== context.uploadFileSha256) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'managed source retained upload SHA 与 context/batch 冻结事实不一致。',
      { batchId, reason: 'retained-sha' },
      409
    );
  }
  return safeFile;
}

/** 使用已验证 Artifact 12 config 的固定列，在 Artifact 07 primary batch 内重建正式训练筛选全集。 */
function readManagedPredictionFilteredEnergyIds(db, energyBatchId, configRow) {
  const filterClauses = [
    "record_status = 'active'",
    'source_batch_id = @energyBatchId',
    'normalized_month >= @trainStartMonth',
    'normalized_month <= @trainEndMonth'
  ];
  const filterParams = {
    energyBatchId,
    trainStartMonth: configRow.train_start_month,
    trainEndMonth: configRow.train_end_month
  };
  const optionalFilters = [
    ['energy_type_id', 'energyTypeId', configRow.energy_type_id],
    ['organization_unit_id', 'organizationUnitId', configRow.organization_unit_id],
    ['meter_device_id', 'meterDeviceId', configRow.meter_device_id]
  ];
  optionalFilters.forEach(([columnName, parameterName, value]) => {
    if (value === null) return;
    filterClauses.push(`${columnName} = @${parameterName}`);
    filterParams[parameterName] = value;
  });
  return db.prepare(`SELECT id FROM energy_records
    WHERE ${filterClauses.join(' AND ')}
    ORDER BY id`).all(filterParams).map((row) => Number(row.id));
}

/**
 * 为固定派生 registrar 复验 Artifact 07/12 managed source exact closure。
 * 输入只包含 caller-owned DB、当前 demo/actor 和 P3 witness 精确实体集合，不接受摘要旁路。
 */
function verifyManagedImportedSourceExactClosure(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['actorUserId', 'configEntityPk', 'db', 'demoRunId', 'energyRecordEntityPks'],
    'DEMO_MANAGED_SOURCE_CLOSURE_INPUT_INVALID',
    'managed source closure verifier 只能接收固定私有字段。'
  );
  const db = input.db;
  const actorUserId = Number(input.actorUserId);
  const configEntityPk = Number(input.configEntityPk);
  const energyRecordEntityPks = input.energyRecordEntityPks;
  const validEnergyArray = Array.isArray(energyRecordEntityPks)
    && !utilTypes.isProxy(energyRecordEntityPks)
    && Object.getPrototypeOf(energyRecordEntityPks) === Array.prototype
    && Object.getOwnPropertySymbols(energyRecordEntityPks).length === 0
    && Object.keys(energyRecordEntityPks).length === energyRecordEntityPks.length
    && energyRecordEntityPks.length > 0
    && energyRecordEntityPks.every((entityPk) => Number.isSafeInteger(entityPk) && entityPk > 0)
    && new Set(energyRecordEntityPks).size === energyRecordEntityPks.length;
  if (!db || db.open !== true || db.inTransaction !== true
    || typeof input.demoRunId !== 'string' || !input.demoRunId
    || !Number.isSafeInteger(actorUserId) || actorUserId < 1
    || !Number.isSafeInteger(configEntityPk) || configEntityPk < 1
    || !validEnergyArray) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INPUT_INVALID',
      'managed source closure verifier 输入值域无效。',
      null,
      400
    );
  }
  const demoRun = requireDemoDatasetRun(db, input.demoRunId);
  const runtime = assertDemoRuntimeEnabled({ db });
  const energySource = readManagedSourceExecutedContext(db, {
    runId: demoRun.runId,
    demoRun,
    runtimeEpoch: Number(runtime.runtimeEpoch),
    actorUserId,
    ...DEMO_MANAGED_DIRECT_IMPORT_BINDING
  });
  const predictionSource = readManagedSourceExecutedContext(db, {
    runId: demoRun.runId,
    demoRun,
    runtimeEpoch: Number(runtime.runtimeEpoch),
    actorUserId,
    ...DEMO_PREDICTION_CONFIG_IMPORT_BINDING
  });

  const energyFile = verifyManagedSourceRetainedFile(
    db,
    energySource.context,
    energySource.batchId
  );
  const energyFacts = verifyManagedDirectCompletedClosure(
    { privateDb: db, pendingWitnesses: new Set() },
    {
      batchId: energySource.batchId,
      contextId: energySource.context.contextId,
      runId: demoRun.runId,
      actorUserId,
      previewDigest: energySource.context.previewDigest,
      expectedContextStatus: 'executed'
    }
  );
  const sortedWitnessEnergyIds = [...energyRecordEntityPks].sort((left, right) => left - right);

  const predictionFile = verifyManagedSourceRetainedFile(
    db,
    predictionSource.context,
    predictionSource.batchId
  );
  const core = getPredictionConfigManagedCoreProtocol();
  const predictionBatch = core.getBatch(predictionSource.batchId, {
    db,
    includeIssues: false
  });
  const preview = core.rebuildPreview(
    db,
    predictionFile,
    predictionBatch.originalFilename,
    [configEntityPk]
  );
  core.assertBatchMatches(predictionBatch, preview, predictionFile, {
    expectedAuditPhase: 'execute'
  });
  const expectedAuditIssues = core.projectAuditIssues(preview);
  const training = readManagedMonthlyEnergyPrimaryForPrediction(
    db,
    predictionSource.context.contextId
  );
  if (training.batchId !== energySource.batchId) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'Artifact 12 训练批次没有绑定当前 Artifact 07 exact primary closure。',
      { reason: 'training-batch-binding' },
      409
    );
  }
  const predictionFacts = readManagedPredictionConfigClosure(db, {
    contextId: predictionSource.context.contextId,
    runId: demoRun.runId,
    actorUserId,
    batchId: predictionSource.batchId,
    trainingBatchId: training.batchId,
    expectedContextStatus: 'executed',
    retainedFileSha256: predictionFile.fileSha256,
    preview,
    expectedAuditIssues,
    backupReason: core.backupReason,
    backupsDir: defaultBackupsDir
  });
  if (predictionFacts.configId !== configEntityPk) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'Artifact 12 managed config 与 P3 completion witness 不一致。',
      { reason: 'config-entity' },
      409
    );
  }
  const configHandler = getDemoOwnershipEntityHandler(
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
  );
  const configRow = configHandler.readProjection(db, configEntityPk);
  if (!configRow || Number(configRow.source_batch_id) !== predictionSource.batchId
    || Number(configRow.source_batch_filter_id) !== energySource.batchId
    || configRow.status !== 'draft' || configRow.archived_at !== null) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'Artifact 12 managed config 的正式 Prediction 筛选绑定已漂移。',
      { reason: 'config-filter-binding' },
      409
    );
  }
  const filteredEnergyIds = readManagedPredictionFilteredEnergyIds(
    db,
    energySource.batchId,
    configRow
  );
  if (filteredEnergyIds.length === 0
    || sha256Stable(filteredEnergyIds) !== sha256Stable(sortedWitnessEnergyIds)) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'P3 exact 训练集合与 Artifact 07 primary batch 的正式配置筛选全集不一致。',
      {
        batchId: energySource.batchId,
        reason: 'energy-filtered-entity-set',
        filteredCount: filteredEnergyIds.length,
        witnessCount: sortedWitnessEnergyIds.length
      },
      409
    );
  }
  if (Number(energyFacts.statistics.successCount) < filteredEnergyIds.length) {
    throw createDemoOwnershipError(
      'DEMO_MANAGED_SOURCE_CLOSURE_INVALID',
      'Artifact 07 完整 ownership closure 无法覆盖正式 Prediction 训练子集。',
      { batchId: energySource.batchId, reason: 'energy-filtered-ownership-coverage' },
      409
    );
  }
  return Object.freeze({
    runId: demoRun.runId,
    actorUserId,
    energyBatchId: energySource.batchId,
    energyContextId: energySource.context.contextId,
    energyRecordEntityPks: Object.freeze(sortedWitnessEnergyIds),
    energyFileSha256: energyFile.fileSha256,
    energyContextTerminalDigest: energySource.contextTerminalDigest,
    energyOwnershipClosureDigest: energyFacts.ownershipClosureDigest,
    predictionBatchId: predictionSource.batchId,
    predictionContextId: predictionSource.context.contextId,
    configEntityPk,
    predictionFileSha256: predictionFile.fileSha256,
    predictionContextTerminalDigest: predictionSource.contextTerminalDigest,
    predictionClosureDigest: predictionFacts.closureDigest
  });
}

/** 执行 Artifact 12 单一、不可拆分 managed retained operation。 */
async function executeManagedPredictionConfigImportOperation(state, transactionScope, intent) {
  if (!intent || intent.authority !== DEMO_PREDICTION_CONFIG_MANAGED_OPERATION_AUTHORITY) {
    throw createDemoOwnershipError(
      'DEMO_PREDICTION_CONFIG_OPERATION_INTENT_INVALID',
      'Artifact 12 managed operation intent 无效。',
      null,
      400
    );
  }
  state.managedPredictionOperationActive = true;
  state.managedPredictionBatchId = Number(intent.batchId);
  state.managedPredictionActorUserId = Number(intent.actor.userId);
  state.managedPredictionActorIp = intent.actor.ip || null;
  const core = getPredictionConfigManagedCoreProtocol();
  const db = state.privateDb;
  const batchId = Number(intent.batchId);
  const batch = core.getBatch(batchId, { db, includeIssues: false });
  if (!batch.storedFilename) {
    throw createDemoOwnershipError(
      'PREDICTION_CONFIG_IMPORT_STORED_FILE_REQUIRED',
      '预测配置批次缺少 retained upload。',
      null,
      400
    );
  }
  const safeFile = readSafeUploadFile(
    intent.uploadsDir || defaultUploadsDir,
    batch.storedFilename,
    {
      expectedSizeBytes: Number.isSafeInteger(batch.fileSizeBytes)
        ? batch.fileSizeBytes
        : undefined,
      maxSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES,
      afterFileOpen: intent.afterRetainedFileOpen
    }
  );
  if (safeFile.fileSha256 !== batch.fileSha256) {
    throw createDemoOwnershipError(
      'PREDICTION_CONFIG_IMPORT_CURRENT_FILE_SHA256_MISMATCH',
      '预测配置 retained upload SHA-256 与 preview 批次不一致。',
      null,
      400
    );
  }
  const importedConfigIds = db.prepare(`SELECT id FROM prediction_configs
    WHERE source_batch_id = ? ORDER BY id`).all(batchId).map((row) => Number(row.id));
  const terminalReplay = batch.auditPhase === 'execute'
    && ['completed', 'completed_with_errors'].includes(batch.status);
  const preview = core.rebuildPreview(
    db,
    safeFile,
    batch.originalFilename,
    terminalReplay ? importedConfigIds : []
  );
  core.assertBatchMatches(batch, preview, safeFile, {
    expectedAuditPhase: terminalReplay ? 'execute' : 'preview'
  });
  const expectedAuditIssues = core.projectAuditIssues(preview);
  invokeManagedPredictionOperationFault(intent, 'after-retained-rebuild', {
    batchId,
    terminalReplay,
    retainedFileSha256: safeFile.fileSha256
  });

  if (terminalReplay) {
    const replay = validateDemoContextTerminalReplay({
      db,
      token: intent.demoContext.token,
      userId: intent.demoContext.userId,
      artifactKey: intent.demoContext.artifactKey,
      handlerKey: intent.demoContext.handlerKey,
      uploadFileSha256: safeFile.fileSha256,
      previewDigest: preview.previewAuditDigest,
      batchBindings: [{
        batchId,
        batchRole: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole,
        importType: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
      }]
    });
    const training = readManagedMonthlyEnergyPrimaryForPrediction(
      db,
      replay.context.contextId,
      state
    );
    invokeManagedPredictionOperationFault(intent, 'after-training-closure', {
      batchId,
      trainingBatchId: training.batchId,
      terminalReplay: true
    });
    readManagedPredictionConfigClosure(db, {
      contextId: replay.context.contextId,
      runId: replay.context.runId,
      actorUserId: intent.actor.userId,
      batchId,
      trainingBatchId: training.batchId,
      expectedContextStatus: 'executed',
      retainedFileSha256: safeFile.fileSha256,
      preview,
      expectedAuditIssues,
      backupReason: core.backupReason,
      backupsDir: intent.backupsDir || defaultBackupsDir
    });
    invokeManagedPredictionOperationFault(intent, 'after-final-closure', {
      batchId,
      terminalReplay: true
    });
    const replayBatch = replay.batches[0];
    return {
      ...replayBatch.executeResult,
      batchId,
      auditBatch: replayBatch.auditBatch,
      terminalReplay: true
    };
  }

  const managedContext = validateDemoContext({
    ...intent.demoContext,
    phase: 'execute',
    uploadFileSha256: safeFile.fileSha256,
    previewDigest: preview.previewAuditDigest,
    db
  });
  const training = readManagedMonthlyEnergyPrimaryForPrediction(
    db,
    managedContext.contextId,
    state
  );
  invokeManagedPredictionOperationFault(intent, 'after-training-closure', {
    batchId,
    trainingBatchId: training.batchId,
    terminalReplay: false
  });
  const managedBackupRoot = intent.backupsDir || defaultBackupsDir;
  const existingBackupNames = snapshotManagedPredictionBackupNames(managedBackupRoot);
  const createdBackup = await intent.createBackup({
    reason: core.backupReason,
    skipCheckpoint: true
  });
  const backup = {
    ...createdBackup,
    requestedReason: core.backupReason
  };
  state.managedPredictionBackupCompensation = buildManagedPredictionBackupCompensation(
    managedBackupRoot,
    backup,
    existingBackupNames
  );
  const publicBackup = core.projectBackup(backup);
  if (publicBackup.reason !== core.backupReason) {
    throw createManagedPredictionClosureError('prediction-backup-reason-invalid', {
      expectedReason: core.backupReason,
      actualReason: publicBackup.reason || null
    });
  }
  verifyManagedPredictionBackupFile(
    publicBackup,
    intent.backupsDir || defaultBackupsDir,
    core.backupReason
  );
  invokeManagedPredictionOperationFault(intent, 'after-backup', {
    batchId,
    backupName: publicBackup.backupName
  });

  const candidate = preview.candidateRows[0];
  const rowWitness = createDemoOwnershipInsertWitness({
    transactionScope,
    entityType: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
    insertSql: `INSERT INTO prediction_configs
      (source_batch_id, source_row_number, name, note, energy_type_id,
       organization_unit_id, meter_device_id, source_batch_filter_id,
       train_start_month, train_end_month, predict_start_month, predict_end_month,
       algorithm, window_size, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    insertParams: [
      batchId,
      candidate.rowNumber,
      candidate.name,
      candidate.note ?? null,
      candidate.energyTypeId ?? null,
      candidate.organizationUnitId ?? null,
      candidate.meterDeviceId ?? null,
      training.batchId,
      candidate.trainStartMonth,
      candidate.trainEndMonth,
      candidate.predictStartMonth,
      candidate.predictEndMonth,
      candidate.algorithm,
      candidate.windowSize ?? null
    ],
    sourceBatchId: batchId,
    sourceRowNumber: candidate.rowNumber
  });
  const configId = Number(rowWitness.lastInsertRowid);
  invokeManagedPredictionOperationFault(intent, 'after-config-insert', {
    batchId,
    configId
  });
  const skippedRecords = preview.items
    .filter((item) => item.status === 'skipped')
    .map((item) => ({
      entityType: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
      entityPk: null,
      batchRole: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole,
      sourceRowNumber: item.rowNumber,
      reason: String(item.reasonCodes || 'duplicate_skipped').slice(0, 256)
    }));
  const ownership = registerImportedDemoOwnershipInTransaction({
    transactionScope,
    demoContext: {
      ...intent.demoContext,
      uploadFileSha256: safeFile.fileSha256,
      previewDigest: preview.previewAuditDigest
    },
    actorUserId: intent.actor.userId,
    batchBindings: [{
      batchId,
      batchRole: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole,
      entityType: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType
    }],
    insertedRecords: [{
      entityType: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
      entityPk: configId,
      batchRole: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole,
      sourceRowNumber: candidate.rowNumber,
      rowWitness
    }],
    skippedRecords,
    noInsertedRecords: false
  });
  if (ownership.applied !== true || ownership.mode !== 'demo'
    || Number(ownership.registrationCount) !== 1
    || Number(ownership.insertedCount) !== 1
    || Number(ownership.idempotentCount) !== 0
    || Number(ownership.relationCount) !== 0) {
    throw createManagedPredictionClosureError('prediction-ownership-registration-incomplete', {
      batchId
    });
  }
  invokeManagedPredictionOperationFault(intent, 'after-ownership', {
    batchId,
    configId,
    registrationCount: Number(ownership.registrationCount)
  });

  const importedRecord = core.getConfigById(db, configId);
  const registry = db.prepare(`SELECT identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
      AND entity_pk = ? AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
    managedContext.runId,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey,
    DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType,
    String(configId)
  );
  if (!registry) {
    throw createManagedPredictionClosureError('prediction-ownership-provenance-invalid', {
      batchId,
      configId
    });
  }
  const closureDigest = calculateManagedPredictionConfigClosureDigest({
    runId: managedContext.runId,
    contextId: managedContext.contextId,
    batchId,
    trainingBatchId: training.batchId,
    retainedFileSha256: safeFile.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    auditIssues: expectedAuditIssues,
    backup: publicBackup,
    configId,
    identityDigest: registry.identityDigest,
    snapshotDigest: registry.snapshotDigest
  });
  const ownershipSummary = {
    ...core.projectOwnership(ownership),
    closureDigest
  };
  const summary = preview.summary;
  const resultData = {
    executed: true,
    dryRun: false,
    imported: 1,
    skipped: summary.skipped,
    blocked: summary.blocked,
    warnings: summary.warnings,
    errors: summary.errors,
    writesPredictionConfigs: true,
    writesPredictionRuns: false,
    writesPredictionResults: false,
    writesEnergyRecords: false,
    writesCarbonEmissions: false,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    sourceTrainingBatchId: training.batchId,
    expectedWouldImport: 1,
    candidateRowIds: preview.candidateRowIds,
    importedIds: [configId],
    importedRecords: [importedRecord],
    ownership: ownershipSummary,
    backup: publicBackup,
    note: '已从 retained upload 重建并导入唯一 draft 预测配置；训练批次由当前 run Artifact 07 可信闭包确定，未运行预测。'
  };
  invokeManagedPredictionOperationFault(intent, 'before-execute-audit', {
    batchId,
    configId,
    resultData
  });
  updateExecuteAuditResult(batchId, {
    status: summary.skipped || summary.blocked ? 'completed_with_errors' : 'completed',
    statistics: {
      totalRows: summary.totalRows,
      successCount: 1,
      failureCount: summary.blocked,
      skippedCount: summary.skipped
    },
    executeResult: resultData,
    backup: publicBackup,
    errorSummary: summary.blocked ? '预测配置导入存在阻断记录。' : null
  }, { db });
  invokeManagedPredictionOperationFault(intent, 'before-operation-log', {
    batchId,
    configId
  });
  recordOperation({
    userId: intent.actor.userId,
    operation: 'prediction.config.import.execute',
    targetType: 'prediction_config_import',
    targetId: batchId,
    detail: {
      imported: 1,
      writesPredictionRuns: false,
      writesPredictionResults: false
    },
    ip: intent.actor.ip,
    db
  });
  invokeManagedPredictionOperationFault(intent, 'after-operation-log', {
    batchId,
    configId
  });
  readManagedPredictionConfigClosure(db, {
    contextId: managedContext.contextId,
    runId: managedContext.runId,
    actorUserId: intent.actor.userId,
    batchId,
    trainingBatchId: training.batchId,
    expectedContextStatus: 'previewed',
    retainedFileSha256: safeFile.fileSha256,
    preview,
    expectedAuditIssues,
    backupsDir: intent.backupsDir || defaultBackupsDir
  });
  invokeManagedPredictionOperationFault(intent, 'before-context-cas', {
    batchId,
    configId,
    resultData
  });
  const executedContext = markDemoContextExecutedInTransaction({
    db,
    ...intent.demoContext,
    uploadFileSha256: safeFile.fileSha256,
    previewDigest: preview.previewAuditDigest,
    batchBindings: [{
      batchId,
      batchRole: DEMO_PREDICTION_CONFIG_IMPORT_BINDING.batchRole
    }]
  });
  const contextTerminal = buildManagedContextTerminalFacts(
    executedContext,
    preview.previewSignature
  );
  persistManagedContextTerminalExecuteResult(db, batchId, contextTerminal);
  invokeManagedPredictionOperationFault(intent, 'after-context-executed', {
    batchId,
    configId
  });
  readManagedPredictionConfigClosure(db, {
    contextId: managedContext.contextId,
    runId: managedContext.runId,
    actorUserId: intent.actor.userId,
    batchId,
    trainingBatchId: training.batchId,
    expectedContextStatus: 'executed',
    retainedFileSha256: safeFile.fileSha256,
    preview,
    expectedAuditIssues,
    backupsDir: intent.backupsDir || defaultBackupsDir
  });
  invokeManagedPredictionOperationFault(intent, 'after-final-closure', {
    batchId,
    configId,
    terminalReplay: false
  });
  return {
    ...resultData,
    batchId,
    auditBatch: core.getAuditSummary(batchId, { db })
  };
}

/** 仅供 prediction service 通过非枚举协议提交 Artifact 12 完整 operation。 */
function executeManagedPredictionConfigImportThroughProtocol(target, input = {}) {
  assertExactPlainObjectFields(
    input,
    ['actor', 'backupsDir', 'batchId', 'createBackup', 'demoContext', 'faultInjector', 'uploadsDir'],
    'DEMO_PREDICTION_CONFIG_OPERATION_INTENT_INVALID',
    'Artifact 12 managed operation 只能包含固定字段。'
  );
  assertExactPlainObjectFields(
    input.actor,
    ['ip', 'userId'],
    'DEMO_PREDICTION_CONFIG_OPERATION_INTENT_INVALID',
    'Artifact 12 managed actor 字段无效。'
  );
  assertExactPlainObjectFields(
    input.demoContext,
    ['artifactKey', 'handlerKey', 'token', 'userId'],
    'DEMO_PREDICTION_CONFIG_OPERATION_INTENT_INVALID',
    'Artifact 12 managed context 字段无效。'
  );
  if (!Number.isSafeInteger(Number(input.batchId)) || Number(input.batchId) < 1
    || !Number.isSafeInteger(Number(input.actor.userId)) || Number(input.actor.userId) < 1
    || Number(input.actor.userId) !== Number(input.demoContext.userId)
    || typeof input.createBackup !== 'function'
    || (input.faultInjector !== undefined && typeof input.faultInjector !== 'function')) {
    throw createDemoOwnershipError(
      'DEMO_PREDICTION_CONFIG_OPERATION_INTENT_INVALID',
      'Artifact 12 managed operation 参数无效。',
      null,
      400
    );
  }
  return runWithDemoOwnershipTransactionAsync(target, {
    authority: DEMO_PREDICTION_CONFIG_MANAGED_OPERATION_AUTHORITY,
    actor: Object.freeze({
      userId: Number(input.actor.userId),
      ip: input.actor.ip || null
    }),
    afterRetainedFileOpen: undefined,
    backupsDir: input.backupsDir || defaultBackupsDir,
    batchId: Number(input.batchId),
    createBackup: input.createBackup,
    demoContext: Object.freeze({ ...input.demoContext }),
    faultInjector: input.faultInjector,
    uploadsDir: input.uploadsDir || defaultUploadsDir
  });
}

/** 判断批次是否使用 Artifact 12 固定 import type，绑定漂移时也必须 fail-closed。 */
function isManagedPredictionConfigBatch(db, batchId) {
  if (!Number.isSafeInteger(Number(batchId)) || Number(batchId) < 1) return false;
  const batch = db.prepare(`SELECT import_type AS importType
    FROM import_batches WHERE id = ?`).get(Number(batchId));
  return batch?.importType === DEMO_PREDICTION_CONFIG_IMPORT_BINDING.importType;
}

/** 判断 token 实际指向的持久 context 是否属于 Artifact 12。 */
function isManagedPredictionConfigContext(db, demoContext = {}) {
  if (typeof demoContext.token !== 'string' || !demoContext.token) return false;
  const context = db.prepare(`SELECT artifact_key AS artifactKey, handler_key AS handlerKey
    FROM demo_import_contexts WHERE token_hash = ?`).get(hashDemoContextToken(demoContext.token));
  return context?.artifactKey === DEMO_PREDICTION_CONFIG_IMPORT_BINDING.artifactKey
    && context?.handlerKey === DEMO_PREDICTION_CONFIG_IMPORT_BINDING.handlerKey;
}

/** Artifact 12 的 execute audit/CAS 只能在固定 managed operation authority 内推进。 */
function requireManagedPredictionOperationForGenericMutation(scopeState, targetMatched, action) {
  if (!targetMatched || scopeState.managedPredictionOperationActive === true) return;
  scopeState.poisoned = true;
  throw createDemoOwnershipError(
    'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED',
    'Artifact 12 execute audit 与 context terminal 只能由单一 managed operation 推进。',
    { action },
    409
  );
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
  requireManagedPredictionOperationForGenericMutation(
    scopeState,
    isManagedPredictionConfigBatch(scopeState.privateDb, input.batchId),
    'execute-audit'
  );
  updateExecuteAuditResult(input.batchId, {
    status: input.status,
    statistics: input.statistics,
    executeResult: input.executeResult,
    backup: input.backup,
    errorSummary: input.errorSummary
  }, { db: scopeState.privateDb });
  return getImportAuditSummary(input.batchId, { db: scopeState.privateDb });
}

/** 在 ownership 私有事务内执行固定 managed execute context 校验，不暴露 raw connection。 */
function validateDemoContextWithOwnershipTransaction(input = {}) {
  assertExactPlainObjectFields(
    input,
    ['transactionScope', 'demoContext', 'uploadFileSha256', 'previewDigest'],
    'DEMO_OWNERSHIP_CONTEXT_VALIDATE_INTENT_INVALID',
    'ownership context 校验 intent 只能包含固定字段。'
  );
  assertExactPlainObjectFields(
    input.demoContext,
    ['artifactKey', 'handlerKey', 'token', 'userId'],
    'DEMO_OWNERSHIP_CONTEXT_VALIDATE_INTENT_INVALID',
    'ownership context 校验只能使用路由提供的固定 context 字段。'
  );
  const scopeState = requireDemoOwnershipTransactionScope(input.transactionScope);
  requireManagedPredictionOperationForGenericMutation(
    scopeState,
    isManagedPredictionConfigContext(scopeState.privateDb, input.demoContext),
    'context-validate'
  );
  return validateDemoContext({
    ...input.demoContext,
    phase: 'execute',
    uploadFileSha256: input.uploadFileSha256,
    previewDigest: input.previewDigest,
    db: scopeState.privateDb
  });
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
  requireManagedPredictionOperationForGenericMutation(
    scopeState,
    isManagedPredictionConfigContext(scopeState.privateDb, input.demoContext),
    'context-executed-cas'
  );
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

Object.assign(demoOwnershipServiceExports, {
  DEMO_CLEANUP_ENTITY_HANDLERS,
  DEMO_CLEANUP_ENTITY_ORDER,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
  DEMO_OWNERSHIP_SNAPSHOT_PROJECTION_VERSION: 'demo-entity-snapshot:v1',
  createDemoOwnershipInsertWitness,
  beginCarbonActivitySupersedeInOwnershipTransaction,
  finalizeCarbonActivitySupersedeInOwnershipTransaction,
  writeCarbonActivityExecuteAuditInOwnershipTransaction,
  issueStrategyEvaluationRegistrationScopeInTransaction,
  deactivateShiftDefinitionSiblingsInOwnershipTransaction,
  deactivateStrategyRuleSiblingsInOwnershipTransaction,
  writeShiftDefinitionImportAuditInOwnershipTransaction,
  writeStrategyRuleImportAuditInOwnershipTransaction,
  runWithDemoOwnershipTransaction,
  runWithDemoOwnershipTransactionAsync,
  buildDemoOwnershipPlan,
  calculateRegistryWatermark,
  getDemoCleanupEntityHandler,
  getDemoOwnershipSummary,
  readDemoRegistryRows,
  registerImportedDemoOwnershipInTransaction,
  registerDerivedMeterEnergyRecordsInTransaction,
  updateDemoExecuteAuditInOwnershipTransaction,
  validateDemoContextWithOwnershipTransaction,
  markDemoContextExecutedWithOwnershipTransaction
});

Object.defineProperty(
  demoOwnershipServiceExports,
  DEMO_PREDICTION_CONFIG_MANAGED_PROTOCOL_SYMBOL,
  {
    value: Object.freeze({
      executeManagedImport: executeManagedPredictionConfigImportThroughProtocol
    }),
    enumerable: false,
    writable: false,
    configurable: false
  }
);

Object.defineProperty(
  demoOwnershipServiceExports,
  DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL,
  {
    value: Object.freeze({
      buildEntityRegistrationContract: buildDemoEntityRegistrationContract,
      calculateEntityIdentityDigest: calculateDemoEntityIdentityDigest,
      calculateEntitySnapshotDigest: calculateDemoEntitySnapshotDigest,
      getEntityHandler: getDemoOwnershipEntityHandler,
      sha256Stable,
      verifyManagedImportedSourceExactClosure
    }),
    enumerable: false,
    writable: false,
    configurable: false
  }
);

Object.freeze(demoOwnershipServiceExports);
