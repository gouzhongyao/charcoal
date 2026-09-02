'use strict';

// 服务导出壳在依赖加载前固定，阻止初始化窗口整体替换内部 registrar 协议。
const carbonAccountingOwnershipServiceExports = {};
const carbonAccountingOwnershipServiceExportsProxy = new Proxy(
  carbonAccountingOwnershipServiceExports,
  {}
);
Object.defineProperty(module, 'exports', {
  value: carbonAccountingOwnershipServiceExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { types: utilTypes } = require('util');
const databaseModule = require('../db/database');
const { AppError } = require('../utils/errors');
const { requireDemoDatasetRun } = require('./demoRunService');
const demoOwnershipService = require('./demoOwnershipService');
const carbonAccountingExactProtocol = require('./carbonAccountingExactProtocol');

const DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
const CARBON_OWNERSHIP_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.carbonAccounting.ownershipInternal.v1');
const DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.database.rawConnectionInternal.v1');

const canonicalOwnershipProtocol =
  demoOwnershipService[DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL];
const rawConnectionProtocol =
  databaseModule[DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL];

if (!canonicalOwnershipProtocol
  || typeof canonicalOwnershipProtocol.buildEntityRegistrationContract !== 'function'
  || typeof canonicalOwnershipProtocol.getEntityHandler !== 'function'
  || typeof canonicalOwnershipProtocol.sha256Stable !== 'function') {
  const error = new Error('碳核算 ownership canonical 协议未完成初始化。');
  error.code = 'CARBON_ACCOUNTING_OWNERSHIP_CANONICAL_PROTOCOL_UNAVAILABLE';
  throw error;
}

// registrar authority 仅存在于服务闭包，内部 Symbol handler 也不能由 caller 替换该对象身份。
const CARBON_REGISTRAR_AUTHORITY = Object.freeze({});
const CARBON_REGISTRATION_SCOPE_STATE = new WeakMap();
const CARBON_REGISTRATION_RECEIPT_STATE = new WeakMap();
const CARBON_REGISTRATION_RECEIPT_CONSUMED = new WeakSet();
// demo run scope 只绑定服务端固定身份与生命周期投影，不扩张到未签发字段。
const CARBON_DEMO_RUN_FIELDS = Object.freeze([
  'runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status', 'createdBy', 'createdAt'
]);
// action run 和 actor 同样只以冻结投影参与业务校验，原引用仅保留能力身份用途。
const CARBON_ACTION_RUN_FIELDS = Object.freeze([
  'actionRunId', 'runId', 'datasetId', 'actionKey', 'requestedBy', 'status'
]);
const CARBON_ACTOR_FIELDS = Object.freeze(['userId', 'username', 'displayName', 'ip']);
const CARBON_REGISTRY_ARTIFACT_KEY = '27-carbon-activities';
// ownership 故障作用域只保存在模块私有闭包中，避免模块级 setter 跨请求泄漏。
const CARBON_OWNERSHIP_FAULT_SCOPE = new AsyncLocalStorage();

/** 构造稳定、脱敏的碳核算 ownership 错误。 */
function createCarbonOwnershipError(code, message, details = null, statusCode = 409) {
  return new AppError(code, message, { statusCode, details });
}

/** 从内部异常提取稳定安全错误码，拒绝把消息、SQL 或对象写入公开 details。 */
function readCarbonOwnershipSafeErrorCode(error) {
  const candidates = [error?.code, error?.details?.code];
  const errorCode = candidates.find((value) => typeof value === 'string') || null;
  return errorCode && /^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode) ? errorCode : null;
}

/** 在当前 ownership 异步作用域触发固定阶段，只向 hook 提供冻结阶段和空安全摘要。 */
function invokeCarbonOwnershipFaultStage(stage) {
  const faultInjector = CARBON_OWNERSHIP_FAULT_SCOPE.getStore();
  if (typeof faultInjector === 'function') {
    faultInjector(Object.freeze({
      stage: String(stage),
      summary: Object.freeze({})
    }));
  }
}

/** 递归冻结 registrar 私有事实，禁止 receipt 暴露 live metadata。 */
function freezeCarbonOwnershipSnapshot(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeCarbonOwnershipSnapshot));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, freezeCarbonOwnershipSnapshot(item)]
    ))));
  }
  return value;
}

/** 校验私有协议输入只包含普通对象数据字段，拒绝 Proxy、getter 和 Symbol。 */
function assertCarbonOwnershipProtocolFields(value, expectedFields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createCarbonOwnershipError(code, message, null, 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualFields = Object.keys(descriptors).sort();
  const normalizedExpectedFields = [...expectedFields].sort();
  const hasAccessor = actualFields.some((fieldName) => (
    typeof descriptors[fieldName].get === 'function'
    || typeof descriptors[fieldName].set === 'function'
  ));
  if (hasAccessor || Object.getOwnPropertySymbols(value).length > 0
    || actualFields.length !== normalizedExpectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== normalizedExpectedFields[index])) {
    throw createCarbonOwnershipError(code, message, {
      expectedFields: normalizedExpectedFields,
      actualFields,
      hasAccessor
    }, 400);
  }
  return value;
}

/** 确认 registrar 使用原始、已打开且处于 caller transaction 的 SQLite 连接。 */
function assertCarbonOwnershipDatabase(db) {
  const valid = rawConnectionProtocol
    && typeof rawConnectionProtocol.isOpenRawDatabaseConnection === 'function'
    && rawConnectionProtocol.isOpenRawDatabaseConnection(db);
  if (!valid || db.inTransaction !== true) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_OWNERSHIP_TRANSACTION_REQUIRED',
      '碳核算 ownership 必须使用原始连接和 caller-owned transaction。',
      null,
      500
    );
  }
  return db;
}

/** 校验服务端绑定对象的固定数据字段，拒绝 getter、Proxy 和结构漂移。 */
function assertCarbonBoundDataObject(value, expectedFields, code, message) {
  assertCarbonOwnershipProtocolFields(value, expectedFields, code, message);
  return value;
}

/** 从已验证事实构造独立普通冻结投影，隔离 caller 对象后续原地修改。 */
function createFrozenCarbonOwnershipProjection(source, fields) {
  return Object.freeze(Object.fromEntries(fields.map((fieldName) => [fieldName, source[fieldName]])));
}

/** 逐字段确认 caller 当前对象仍等于 scope 签发时的冻结投影。 */
function assertCarbonOwnershipProjectionStable(current, snapshot, fields, code, message) {
  const invalidObject = !current || typeof current !== 'object' || Array.isArray(current)
    || utilTypes.isProxy(current) || Object.getPrototypeOf(current) !== Object.prototype;
  if (invalidObject) throw createCarbonOwnershipError(code, message);
  const descriptors = Object.getOwnPropertyDescriptors(current);
  const actualFields = Object.keys(descriptors).sort();
  const expectedFields = [...fields].sort();
  const hasDrift = Object.getOwnPropertySymbols(current).length > 0
    || actualFields.length !== expectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== expectedFields[index])
    || fields.some((fieldName) => {
      const descriptor = descriptors[fieldName];
      return !descriptor || typeof descriptor.get === 'function'
        || typeof descriptor.set === 'function' || descriptor.value !== snapshot[fieldName];
    });
  if (hasDrift) throw createCarbonOwnershipError(code, message);
  return current;
}

/** 重读并逐字段绑定 scope 签发时的 demo run 固定身份与生命周期投影。 */
function requirePersistedCarbonDemoRunBinding(db, demoRun, code, message) {
  let persisted = null;
  try {
    persisted = requireDemoDatasetRun(db, demoRun.runId);
  } catch (error) {
    if (readCarbonOwnershipSafeErrorCode(error) === 'DEMO_RUN_INVALID') {
      throw createCarbonOwnershipError(code, message);
    }
    throw error;
  }
  if (CARBON_DEMO_RUN_FIELDS.some((fieldName) => persisted[fieldName] !== demoRun[fieldName])) {
    throw createCarbonOwnershipError(code, message);
  }
  return persisted;
}

/** 校验 action run 原对象采用固定服务端投影，额外字段和动态字段一律拒绝。 */
function assertCarbonActionRunObject(actionRun) {
  assertCarbonOwnershipProtocolFields(
    actionRun,
    CARBON_ACTION_RUN_FIELDS,
    'CARBON_ACCOUNTING_ACTION_RUN_OBJECT_INVALID',
    '碳核算 ownership action run 必须使用固定服务端投影原对象。'
  );
  if (typeof actionRun.actionRunId !== 'string' || actionRun.actionRunId.trim() !== actionRun.actionRunId
    || actionRun.actionRunId.length === 0
    || typeof actionRun.runId !== 'string' || actionRun.runId.trim() !== actionRun.runId
    || actionRun.runId.length === 0
    || typeof actionRun.datasetId !== 'string' || actionRun.datasetId.trim() !== actionRun.datasetId
    || actionRun.datasetId.length === 0
    || actionRun.actionKey !== 'carbon-accounting-run'
    || actionRun.status !== 'executing'
    || !Number.isSafeInteger(actionRun.requestedBy) || actionRun.requestedBy < 1) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_ACTION_RUN_OBJECT_INVALID',
      '碳核算 ownership action run 固定字段无效。',
      null,
      400
    );
  }
  return actionRun;
}

/** 从数据库重读未来 adapter 创建的 executing action run 并逐字段绑定原对象。 */
function requirePersistedCarbonActionRun(db, actionRun, demoRun, actor) {
  const persisted = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      dataset_id AS datasetId, action_key AS actionKey, requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRun.actionRunId) || null;
  if (!persisted) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_ACTION_RUN_BINDING_INVALID',
      '碳核算 ownership 找不到当前 executing action run。'
    );
  }
  persisted.requestedBy = Number(persisted.requestedBy);
  if (CARBON_ACTION_RUN_FIELDS.some((fieldName) => persisted[fieldName] !== actionRun[fieldName])
    || persisted.runId !== demoRun.runId || persisted.datasetId !== demoRun.datasetId
    || persisted.actionKey !== 'carbon-accounting-run' || persisted.status !== 'executing'
    || persisted.requestedBy !== actor.userId) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_ACTION_RUN_BINDING_INVALID',
      '碳核算 ownership 与当前 executing action run、demo run 或 actor 不一致。'
    );
  }
  return persisted;
}

/** 为 scope、registrar 和 receipt 创建不可预测 SAVEPOINT 名称。 */
function createCarbonOwnershipSavepointName(purpose) {
  return `carbon_ownership_${purpose}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 私有恢复边界失败时完整回滚；完整回滚仍失败则关闭连接。 */
function failClosedCarbonOwnershipTransaction(db, stagePrefix) {
  let fullRollbackError = null;
  let closeError = null;
  try {
    invokeCarbonOwnershipFaultStage(`${stagePrefix}-before-full-rollback`);
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

/** 恢复 registrar SAVEPOINT；ROLLBACK TO 成功后才允许 RELEASE。 */
function recoverCarbonOwnershipSavepoint(db, savepointName, stagePrefix) {
  let rollbackError = null;
  let releaseError = null;
  try {
    invokeCarbonOwnershipFaultStage(`${stagePrefix}-before-recovery-rollback`);
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } catch (error) {
    rollbackError = error;
  }
  if (!rollbackError) {
    try {
      invokeCarbonOwnershipFaultStage(`${stagePrefix}-before-recovery-release`);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (error) {
      releaseError = error;
    }
  }
  const failClosed = rollbackError || releaseError
    ? failClosedCarbonOwnershipTransaction(db, stagePrefix)
    : { fullRollbackError: null, closeError: null };
  return { rollbackError, releaseError, ...failClosed };
}

/** 构造统一的 SAVEPOINT 恢复失败错误，只保留稳定错误码。 */
function createCarbonOwnershipRecoveryError(code, message, originalError, recovery) {
  return createCarbonOwnershipError(code, message, {
    originalCode: readCarbonOwnershipSafeErrorCode(originalError),
    rollbackCode: readCarbonOwnershipSafeErrorCode(recovery.rollbackError),
    releaseCode: readCarbonOwnershipSafeErrorCode(recovery.releaseError),
    fullRollbackCode: readCarbonOwnershipSafeErrorCode(recovery.fullRollbackError),
    closeCode: readCarbonOwnershipSafeErrorCode(recovery.closeError)
  }, 500);
}

/** 构造 marker 已释放但 registrar 恢复边界未建立时的稳定 fail-closed 错误。 */
function createCarbonRegistrarHandoffError(originalError, failClosed) {
  return createCarbonOwnershipError(
    'CARBON_ACCOUNTING_REGISTRAR_HANDOFF_FAILED',
    '碳核算 registrar 恢复边界建立失败，禁止继续提交 caller transaction。',
    {
      originalCode: readCarbonOwnershipSafeErrorCode(originalError),
      fullRollbackCode: readCarbonOwnershipSafeErrorCode(failClosed.fullRollbackError),
      closeCode: readCarbonOwnershipSafeErrorCode(failClosed.closeError)
    },
    500
  );
}

/** 读取指定实体当前 active registry。 */
function readActiveCarbonRegistry(db, entityType, entityPk) {
  return db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, legacy_claim_run_id AS legacyClaimRunId,
      registered_by AS registeredBy, registered_at AS registeredAt,
      cleaned_at AS cleanedAt, cleanup_run_id AS cleanupRunId,
      cleanup_result AS cleanupResult
    FROM demo_data_registry
    WHERE entity_type = ? AND entity_pk = ? AND cleaned_at IS NULL`).get(
    entityType,
    String(entityPk)
  ) || null;
}

/** 构造碳核算 derived registry canonical 实体键。 */
function buildCarbonDerivedRegistryEntityKey(entityType, entityPk) {
  return canonicalOwnershipProtocol.sha256Stable([
    String(entityType),
    String(entityPk)
  ]);
}

/** 从 calculation run 与全部 result canonical contract 构造预期实体全集。 */
function buildExpectedCarbonDerivedEntityKeys(domain) {
  return [domain.runContract, ...domain.resultCanonicals.map((item) => item.contract)]
    .map((contract) => ({
      entityType: contract.entityType,
      entityPk: String(contract.entityPk)
    }));
}

/** 查询当前 run 的 artifact27 全部 active derived registry 完整事实。 */
function readActiveCarbonDerivedRegistryFacts(db, runId) {
  return db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, legacy_claim_run_id AS legacyClaimRunId,
      registered_by AS registeredBy, registered_at AS registeredAt,
      cleaned_at AS cleanedAt, cleanup_run_id AS cleanupRunId,
      cleanup_result AS cleanupResult
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND ownership_kind = 'derived'
      AND cleaned_at IS NULL
    ORDER BY entity_type, entity_pk, registry_id`).all(runId, CARBON_REGISTRY_ARTIFACT_KEY);
}

/** 双向校验 canonical 实体键、数量与全部 registry 持久事实并返回确认后的全集。 */
function requireCarbonDerivedRegistryClosure(db, state, expectedEntityKeys, expectedFacts, codes) {
  const expectedKeyValues = expectedEntityKeys.map((item) => (
    buildCarbonDerivedRegistryEntityKey(item.entityType, item.entityPk)
  ));
  const expectedFactKeys = expectedFacts.map((item) => (
    buildCarbonDerivedRegistryEntityKey(item.entityType, item.entityPk)
  ));
  const actualFacts = readActiveCarbonDerivedRegistryFacts(db, state.demoRun.runId);
  const actualKeyValues = actualFacts.map((item) => (
    buildCarbonDerivedRegistryEntityKey(item.entityType, item.entityPk)
  ));
  const normalizeKeys = (values) => [...values].sort();
  const expectedKeyDigest = canonicalOwnershipProtocol.sha256Stable(
    normalizeKeys(expectedKeyValues)
  );
  if (new Set(expectedKeyValues).size !== expectedKeyValues.length
    || new Set(expectedFactKeys).size !== expectedFactKeys.length
    || new Set(actualKeyValues).size !== actualKeyValues.length
    || expectedEntityKeys.length !== expectedFacts.length
    || expectedEntityKeys.length !== actualFacts.length
    || canonicalOwnershipProtocol.sha256Stable(normalizeKeys(expectedFactKeys)) !== expectedKeyDigest
    || canonicalOwnershipProtocol.sha256Stable(normalizeKeys(actualKeyValues)) !== expectedKeyDigest) {
    throw createCarbonOwnershipError(
      codes.closureCode,
      '碳核算 active derived registry 实体键或数量不符合 canonical 全集。'
    );
  }
  const expectedFactByKey = new Map(expectedFacts.map((item) => (
    [buildCarbonDerivedRegistryEntityKey(item.entityType, item.entityPk), item]
  )));
  const actualFactByKey = new Map(actualFacts.map((item) => (
    [buildCarbonDerivedRegistryEntityKey(item.entityType, item.entityPk), item]
  )));
  const orderedActualFacts = expectedKeyValues.map((entityKey) => actualFactByKey.get(entityKey));
  const orderedExpectedFacts = expectedKeyValues.map((entityKey) => expectedFactByKey.get(entityKey));
  if (orderedExpectedFacts.some((item) => !item) || orderedActualFacts.some((item) => !item)
    || canonicalOwnershipProtocol.sha256Stable(orderedExpectedFacts)
      !== canonicalOwnershipProtocol.sha256Stable(orderedActualFacts)) {
    throw createCarbonOwnershipError(
      codes.factCode,
      '碳核算 active derived registry 完整事实或 digest 与 canonical contract 不一致。'
    );
  }
  return orderedActualFacts;
}

/** 读取完整 relation 持久事实。 */
function readCarbonRelationFact(db, relationId) {
  return db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType, created_at AS createdAt
    FROM demo_data_relations WHERE relation_id = ?`).get(relationId) || null;
}

/** 从 canonical handler 读取并验证业务行 projection。 */
function readCanonicalCarbonProjection(db, entityType, entityPk) {
  const handler = canonicalOwnershipProtocol.getEntityHandler(entityType);
  const row = handler ? handler.readProjection(db, Number(entityPk)) : null;
  if (!handler || !row || Number(row.id) !== Number(entityPk)) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_OWNERSHIP_ENTITY_MISSING',
      '碳核算 ownership 目标业务事实不存在。',
      { entityType, entityPk: String(entityPk) }
    );
  }
  const contract = canonicalOwnershipProtocol.buildEntityRegistrationContract({
    entityType,
    entityPk: Number(entityPk),
    row
  });
  return { row, contract };
}

/** 重读并校验 exact imported source ownership、provenance、digest 与业务集合。 */
function requireCarbonExactImportedSources(db, demoRun, exactState) {
  const definitions = [
    {
      artifactKey: '11-carbon-factors',
      entityType: 'carbon_factor',
      importType: 'carbon_factor',
      ownership: exactState.factorOwnership
    },
    {
      artifactKey: '27-carbon-activities',
      entityType: 'carbon_activity_record',
      importType: 'carbon_activity',
      ownership: exactState.activityOwnership
    }
  ];
  const result = {};
  definitions.forEach((definition) => {
    const expectedIds = definition.ownership.map((item) => Number(item.entityPk))
      .sort((left, right) => left - right);
    const activeRows = db.prepare(`SELECT entity_pk AS entityPk
      FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
        AND ownership_kind = 'imported' AND cleaned_at IS NULL
      ORDER BY CAST(entity_pk AS INTEGER)`).all(
      demoRun.runId,
      definition.artifactKey,
      definition.entityType
    );
    const currentIds = activeRows.map((row) => Number(row.entityPk));
    if (canonicalOwnershipProtocol.sha256Stable(currentIds)
      !== canonicalOwnershipProtocol.sha256Stable(expectedIds)) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_SOURCE_SET_MISMATCH',
        '碳核算 exact imported ownership 集合已漂移。',
        { artifactKey: definition.artifactKey }
      );
    }
    result[definition.entityType] = definition.ownership.map((expected) => {
      const entityPk = Number(expected.entityPk);
      const registry = readActiveCarbonRegistry(db, definition.entityType, entityPk);
      const canonical = readCanonicalCarbonProjection(db, definition.entityType, entityPk);
      const batch = registry?.sourceBatchId === null || registry?.sourceBatchId === undefined
        ? null
        : db.prepare('SELECT import_type AS importType FROM import_batches WHERE id = ?')
          .get(Number(registry.sourceBatchId));
      if (!registry || registry.runId !== demoRun.runId
        || registry.artifactKey !== definition.artifactKey
        || registry.ownershipKind !== 'imported'
        || Number(registry.sourceBatchId) !== Number(expected.sourceBatchId)
        || Number(registry.sourceRowNumber) !== Number(expected.sourceRowNumber)
        || registry.identityDigest !== expected.identityDigest
        || registry.snapshotDigest !== expected.snapshotDigest
        || canonical.contract.identityDigest !== expected.identityDigest
        || canonical.contract.snapshotDigest !== expected.snapshotDigest
        || Number(canonical.row.source_batch_id) !== Number(expected.sourceBatchId)
        || Number(canonical.row.source_row_number) !== Number(expected.sourceRowNumber)
        || !batch || batch.importType !== definition.importType) {
        throw createCarbonOwnershipError(
          'CARBON_ACCOUNTING_SOURCE_OWNERSHIP_INVALID',
          '碳核算 exact source ownership、provenance 或 digest 无效。',
          { entityType: definition.entityType, entityPk }
        );
      }
      return { registry, row: canonical.row, contract: canonical.contract };
    });
  });
  return result;
}

/** 读取并校验 calculation run 的领域成功审计。 */
function readCarbonDomainAuditFact(db, auditId, run, actor) {
  const audit = db.prepare(`SELECT id, user_id AS userId, operation, target_type AS targetType,
      target_id AS targetId, detail_json AS detailJson, ip, created_at AS createdAt
    FROM sys_operation_logs WHERE id = ?`).get(Number(auditId)) || null;
  let detail = null;
  try {
    detail = audit ? JSON.parse(audit.detailJson) : null;
  } catch (_error) {
    detail = null;
  }
  const expectedDetail = {
    version: 1,
    sourceType: 'independent_activity',
    startUtc: run.start_utc,
    endUtc: run.end_utc,
    activityCount: Number(run.activity_count),
    calculatedCount: Number(run.calculated_count),
    factorMissingCount: Number(run.factor_missing_count)
  };
  if (!audit || Number(audit.userId) !== actor.userId
    || audit.operation !== 'carbon.accounting.run.create'
    || audit.targetType !== 'carbon_calculation_run'
    || audit.targetId !== run.run_code
    || audit.ip !== (actor.ip || null)
    || audit.createdAt !== run.completed_at
    || canonicalOwnershipProtocol.sha256Stable(detail)
      !== canonicalOwnershipProtocol.sha256Stable(expectedDetail)) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_DOMAIN_AUDIT_INVALID',
      '碳核算运行领域审计已缺失或被改写。'
    );
  }
  return {
    ...audit,
    id: Number(audit.id),
    userId: Number(audit.userId)
  };
}

/** 从完整结果快照重算活动摘要、计数、期间和排放汇总。 */
function deriveCarbonCalculationFactsFromResults(results) {
  const snapshotInput = results.map((row) => ({
    activity: JSON.parse(row.activity_snapshot_json),
    organization: JSON.parse(row.organization_snapshot_json),
    energyType: JSON.parse(row.energy_type_snapshot_json),
    factor: row.factor_snapshot_json ? JSON.parse(row.factor_snapshot_json) : null,
    matching: JSON.parse(row.matching_snapshot_json),
    formula: JSON.parse(row.formula_snapshot_json)
  }));
  const totals = new Map();
  results.filter((row) => row.status === 'calculated').forEach((row) => {
    const current = totals.get(row.emission_unit) || {
      emissionUnit: row.emission_unit,
      totalEmissionValue: 0,
      calculatedCount: 0
    };
    current.totalEmissionValue = Math.round(
      (current.totalEmissionValue + Number(row.emission_value)) * 1e6
    ) / 1e6;
    if (!Number.isFinite(current.totalEmissionValue)) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_DOMAIN_TOTAL_NON_FINITE',
        '碳核算结果汇总产生非有限数值。'
      );
    }
    current.calculatedCount += 1;
    totals.set(row.emission_unit, current);
  });
  return {
    activitySnapshotDigest: canonicalOwnershipProtocol.sha256Stable(snapshotInput),
    startUtc: [...results].sort((left, right) => (
      Date.parse(left.activity_start_utc) - Date.parse(right.activity_start_utc)
    ))[0]?.activity_start_utc || null,
    endUtc: [...results].sort((left, right) => (
      Date.parse(right.activity_end_utc) - Date.parse(left.activity_end_utc)
    ))[0]?.activity_end_utc || null,
    calculatedCount: results.filter((row) => row.status === 'calculated').length,
    factorMissingCount: results.filter((row) => row.status === 'factor_missing').length,
    totals: [...totals.values()].sort((left, right) => (
      left.emissionUnit.localeCompare(right.emissionUnit)
    ))
  };
}

/** 重读 run/results/audit 并验证 exact 活动、因子、计数、期间、摘要和总计闭包。 */
function readAndValidateCarbonDomainFacts(db, state, witnessFacts) {
  const runCanonical = readCanonicalCarbonProjection(
    db,
    'carbon_calculation_run',
    witnessFacts.run.id
  );
  const run = runCanonical.row;
  const resultHandler = canonicalOwnershipProtocol.getEntityHandler('carbon_accounting_result');
  const results = db.prepare('SELECT * FROM carbon_accounting_results WHERE calculation_run_id = ? ORDER BY id')
    .all(Number(run.id));
  if (!resultHandler || results.length !== Number(run.result_count)
    || results.length !== state.exactContext.exactState.activityOwnership.length) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RESULT_SET_MISMATCH',
      '碳核算结果集合与运行或 exact activity 集合不一致。'
    );
  }
  const exactActivityIds = state.exactContext.exactState.activityOwnership
    .map((item) => Number(item.entityPk));
  const exactActivityIdSet = new Set(exactActivityIds);
  const exactFactorIdSet = new Set(state.exactContext.exactState.factorOwnership
    .map((item) => Number(item.entityPk)));
  const seenActivityIds = new Set();
  const resultCanonicals = results.map((row) => {
    resultHandler.validateProjectionRow(row);
    const activityId = Number(row.activity_record_id);
    if (!exactActivityIdSet.has(activityId) || seenActivityIds.has(activityId)) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RESULT_ACTIVITY_CLOSURE_INVALID',
        '每个 exact activity 必须且只能对应一个碳核算结果。',
        { activityRecordId: activityId }
      );
    }
    seenActivityIds.add(activityId);
    if (row.status === 'calculated' && !exactFactorIdSet.has(Number(row.carbon_factor_id))) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RESULT_FACTOR_CLOSURE_INVALID',
        'calculated 结果使用了 exact factor 集合之外的因子。',
        { resultId: Number(row.id) }
      );
    }
    if (row.status === 'factor_missing' && row.carbon_factor_id !== null) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RESULT_FACTOR_CLOSURE_INVALID',
        'factor_missing 结果不得引用因子。',
        { resultId: Number(row.id) }
      );
    }
    return {
      row,
      contract: canonicalOwnershipProtocol.buildEntityRegistrationContract({
        entityType: 'carbon_accounting_result',
        entityPk: Number(row.id),
        row
      })
    };
  });
  if (seenActivityIds.size !== exactActivityIdSet.size) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RESULT_ACTIVITY_CLOSURE_INVALID',
      '碳核算结果未完整覆盖 exact activity 集合。'
    );
  }
  const derived = deriveCarbonCalculationFactsFromResults(results);
  let persistedTotals = null;
  try {
    persistedTotals = JSON.parse(run.emission_totals_json);
  } catch (_error) {
    persistedTotals = null;
  }
  if (run.status !== 'completed' || run.source_type !== 'independent_activity'
    || run.calculation_method !== 'standard-factor'
    || run.start_utc !== state.exactContext.exactState.period.startUtc
    || run.end_utc !== state.exactContext.exactState.period.endUtc
    || run.start_utc !== derived.startUtc || run.end_utc !== derived.endUtc
    || Number(run.activity_count) !== results.length
    || Number(run.result_count) !== results.length
    || Number(run.calculated_count) !== derived.calculatedCount
    || Number(run.factor_missing_count) !== derived.factorMissingCount
    || run.activity_snapshot_digest !== derived.activitySnapshotDigest
    || !persistedTotals || persistedTotals.version !== 1
    || canonicalOwnershipProtocol.sha256Stable(persistedTotals.totals)
      !== canonicalOwnershipProtocol.sha256Stable(derived.totals)) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RUN_FACTS_INVALID',
      '碳核算运行期间、摘要、计数或排放汇总与结果事实不一致。'
    );
  }
  const witnessResultIds = witnessFacts.results.map((item) => Number(item.id));
  const persistedResultIds = results.map((item) => Number(item.id));
  if (Number(witnessFacts.run.id) !== Number(run.id)
    || witnessFacts.run.runCode !== run.run_code
    || witnessFacts.run.activitySnapshotDigest !== run.activity_snapshot_digest
    || canonicalOwnershipProtocol.sha256Stable(witnessResultIds)
      !== canonicalOwnershipProtocol.sha256Stable(persistedResultIds)) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_WITNESS_DOMAIN_MISMATCH',
      'calculation witness 与重读领域事实不一致。'
    );
  }
  const audit = readCarbonDomainAuditFact(db, witnessFacts.audit.id, run, state.actor);
  return {
    run,
    runContract: runCanonical.contract,
    results,
    resultCanonicals,
    audit
  };
}

/** 构造 registrar 预期的完整 derived registry 事实。 */
function buildExpectedCarbonRegistryFact(registryId, state, registration, registeredAt) {
  return {
    registryId: Number(registryId),
    runId: state.demoRun.runId,
    artifactKey: CARBON_REGISTRY_ARTIFACT_KEY,
    entityType: registration.entityType,
    entityPk: registration.entityPk,
    ownershipKind: 'derived',
    identityDigest: registration.identityDigest,
    snapshotDigest: registration.snapshotDigest,
    sourceBatchId: null,
    sourceRowNumber: null,
    legacyClaimRunId: null,
    registeredBy: state.actor.userId,
    registeredAt,
    cleanedAt: null,
    cleanupRunId: null,
    cleanupResult: null
  };
}

/** 登记单个碳核算 derived entity，任何既有 active ownership 都视为冲突。 */
function insertCarbonDerivedRegistry(db, state, registration, registeredAt) {
  if (readActiveCarbonRegistry(db, registration.entityType, registration.entityPk)) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_DERIVED_REGISTRY_CONFLICT',
      '碳核算派生实体已存在 active ownership。',
      { entityType: registration.entityType, entityPk: registration.entityPk }
    );
  }
  const inserted = db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number,
     registered_by, registered_at)
    VALUES (?, ?, ?, ?, 'derived', ?, ?, NULL, NULL, ?, ?)`).run(
    state.demoRun.runId,
    CARBON_REGISTRY_ARTIFACT_KEY,
    registration.entityType,
    registration.entityPk,
    registration.identityDigest,
    registration.snapshotDigest,
    state.actor.userId,
    registeredAt
  );
  return buildExpectedCarbonRegistryFact(
    Number(inserted.lastInsertRowid),
    state,
    registration,
    registeredAt
  );
}

/** 插入单个固定 relation 并返回预期完整事实。 */
function insertCarbonRelation(db, state, intent, createdAt) {
  const inserted = db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(
    state.demoRun.runId,
    intent.fromRegistryId,
    intent.toRegistryId,
    intent.relationType,
    createdAt
  );
  return {
    relationId: Number(inserted.lastInsertRowid),
    runId: state.demoRun.runId,
    fromRegistryId: Number(intent.fromRegistryId),
    toRegistryId: Number(intent.toRegistryId),
    relationType: intent.relationType,
    createdAt
  };
}

/** 校验实际事实数组与写入前意图完全一致。 */
function assertCarbonIntentFacts(expectedFacts, actualFacts, code, message) {
  if (!Array.isArray(expectedFacts) || !Array.isArray(actualFacts)
    || expectedFacts.length !== actualFacts.length
    || canonicalOwnershipProtocol.sha256Stable(expectedFacts)
      !== canonicalOwnershipProtocol.sha256Stable(actualFacts)) {
    throw createCarbonOwnershipError(code, message);
  }
}

/** 查询所有 derived 端点关系并校验 relation 精确闭包。 */
function assertCarbonRelationClosure(db, derivedRegistryIds, expectedFacts) {
  const placeholders = derivedRegistryIds.map(() => '?').join(', ');
  const actualFacts = db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType, created_at AS createdAt
    FROM demo_data_relations
    WHERE from_registry_id IN (${placeholders}) OR to_registry_id IN (${placeholders})
    ORDER BY relation_id`).all(...derivedRegistryIds, ...derivedRegistryIds);
  const normalizedExpected = [...expectedFacts]
    .sort((left, right) => Number(left.relationId) - Number(right.relationId));
  assertCarbonIntentFacts(
    normalizedExpected,
    actualFacts,
    'CARBON_ACCOUNTING_RELATION_CLOSURE_MISMATCH',
    '碳核算 relation 精确闭包已缺失、增加、反向或改写。'
  );
}

/** 在任何 registrar SQL 前验证 scope 原始身份、状态和全部绑定对象。 */
function requireCarbonRegistrationScopeState(input, allowedStatuses) {
  const scope = input.registrationScope;
  const state = scope && typeof scope === 'object' && !utilTypes.isProxy(scope)
    ? CARBON_REGISTRATION_SCOPE_STATE.get(scope)
    : null;
  if (!state) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_REGISTRATION_SCOPE_REQUIRED',
      '碳核算 ownership 必须使用正式签发的原始 registration scope。',
      null,
      400
    );
  }
  if (!allowedStatuses.includes(state.status)) {
    throw createCarbonOwnershipError(
      state.status === 'consumed'
        ? 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_REPLAY'
        : 'CARBON_ACCOUNTING_REGISTRATION_SCOPE_INVALID',
      '碳核算 registration scope 已消费、失效或处于错误阶段。'
    );
  }
  if (input.registrarAuthority !== state.registrarAuthority
    || input.db !== state.db || input.actionRun !== state.actionRunIdentity
    || input.actor !== state.actorIdentity || input.exactScope !== state.exactScope
    || input.calculationWitness !== state.calculationWitness) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_REGISTRATION_SCOPE_BINDING_MISMATCH',
      '碳核算 registration scope 与 authority、DB、run、actor、scope 或 witness 对象身份不一致。'
    );
  }
  return state;
}

/** 签发绑定 caller transaction 与全部原对象的一次性 registration scope。 */
function issueCarbonRegistrationScopeInCallerTransaction(input = {}) {
  assertCarbonOwnershipProtocolFields(
    input,
    ['registrarAuthority', 'db', 'demoRun', 'actionRun', 'actor', 'exactScope', 'calculationWitness'],
    'CARBON_ACCOUNTING_REGISTRATION_SCOPE_INPUT_INVALID',
    '碳核算 registration scope 只能接收固定私有协议字段。'
  );
  const db = assertCarbonOwnershipDatabase(input.db);
  assertCarbonBoundDataObject(
    input.demoRun,
    CARBON_DEMO_RUN_FIELDS,
    'CARBON_ACCOUNTING_DEMO_RUN_OBJECT_INVALID',
    '碳核算 ownership demo run 必须使用固定服务端投影原对象。'
  );
  assertCarbonBoundDataObject(
    input.actor,
    CARBON_ACTOR_FIELDS,
    'CARBON_ACCOUNTING_ACTOR_OBJECT_INVALID',
    '碳核算 ownership actor 必须使用固定服务端投影原对象。'
  );
  assertCarbonActionRunObject(input.actionRun);
  const exactContext = carbonAccountingExactProtocol
    .inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor,
      exactScope: input.exactScope,
      calculationWitness: input.calculationWitness
    });
  const demoRun = requirePersistedCarbonDemoRunBinding(
    db,
    input.demoRun,
    'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_MISMATCH',
    '碳核算 registration demo run 原对象与持久事实不一致。'
  );
  const actionRun = requirePersistedCarbonActionRun(db, input.actionRun, demoRun, input.actor);
  const demoRunSnapshot = createFrozenCarbonOwnershipProjection(demoRun, CARBON_DEMO_RUN_FIELDS);
  const actionRunSnapshot = createFrozenCarbonOwnershipProjection(
    actionRun,
    CARBON_ACTION_RUN_FIELDS
  );
  const actorSnapshot = createFrozenCarbonOwnershipProjection(input.actor, CARBON_ACTOR_FIELDS);
  const transactionMarkerSavepoint = createCarbonOwnershipSavepointName('scope_marker');
  db.exec(`SAVEPOINT ${transactionMarkerSavepoint}`);
  const registrationScope = Object.freeze({});
  CARBON_REGISTRATION_SCOPE_STATE.set(registrationScope, {
    registrarAuthority: input.registrarAuthority,
    db,
    demoRun: demoRunSnapshot,
    actionRun: actionRunSnapshot,
    actionRunIdentity: input.actionRun,
    actor: actorSnapshot,
    actorIdentity: input.actor,
    exactScope: input.exactScope,
    calculationWitness: input.calculationWitness,
    exactContext,
    transactionMarkerSavepoint,
    status: 'issued'
  });
  return registrationScope;
}

/** 在 caller transaction 中登记 run、N results 及固定 relation 闭包并返回 opaque receipt。 */
function registerCarbonDerivedOwnershipInCallerTransaction(input = {}) {
  assertCarbonOwnershipProtocolFields(
    input,
    ['registrarAuthority', 'db', 'demoRun', 'actionRun', 'actor', 'exactScope',
      'calculationWitness', 'registrationScope'],
    'CARBON_ACCOUNTING_REGISTRAR_INPUT_INVALID',
    '碳核算 registrar 只能接收固定私有协议字段。'
  );
  const state = requireCarbonRegistrationScopeState(input, ['issued']);
  const db = assertCarbonOwnershipDatabase(input.db);
  // 此处不得执行 SQL；先复核 exact capability，clone、Proxy、错库和重放在业务读取前拒绝。
  const currentContext = carbonAccountingExactProtocol
    .inspectRegistrationContextInCallerTransaction({
      db,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor,
      exactScope: input.exactScope,
      calculationWitness: input.calculationWitness
    });
  if (canonicalOwnershipProtocol.sha256Stable(currentContext)
    !== canonicalOwnershipProtocol.sha256Stable(state.exactContext)) {
    state.status = 'failed';
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_REGISTRATION_CONTEXT_MISMATCH',
      '碳核算 registration exact context 已漂移。'
    );
  }
  state.status = 'claiming';
  // marker 一旦成功释放，registrar SAVEPOINT 建立前的全部异常都必须完整回滚 caller transaction。
  let handoffWithoutRecoveryBoundary = false;
  try {
    // 第一条 SQL 只释放 scope marker，跨事务调用必须在任何新业务 SQL 前 fail-closed。
    db.exec(`RELEASE SAVEPOINT ${state.transactionMarkerSavepoint}`);
    handoffWithoutRecoveryBoundary = true;
  } catch (error) {
    state.status = 'failed';
    const failClosed = failClosedCarbonOwnershipTransaction(db, 'carbon-registration-marker');
    if (failClosed.fullRollbackError || failClosed.closeError) {
      throw createCarbonOwnershipRecoveryError(
        'CARBON_ACCOUNTING_REGISTRATION_MARKER_RECOVERY_FAILED',
        '碳核算 registration transaction marker 失效且完整回滚失败。',
        error,
        { rollbackError: null, releaseError: error, ...failClosed }
      );
    }
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_REGISTRATION_TRANSACTION_MISMATCH',
      '碳核算 registration scope 不属于当前 caller transaction。'
    );
  }

  let recoverySavepoint = null;
  let recoverySavepointActive = false;
  try {
    invokeCarbonOwnershipFaultStage('carbon-registrar-handoff-after-marker-release');
    assertCarbonOwnershipProjectionStable(
      input.demoRun,
      state.demoRun,
      CARBON_DEMO_RUN_FIELDS,
      'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      '碳核算 registration demo run caller 投影在 registrar 接管前已漂移。'
    );
    assertCarbonOwnershipProjectionStable(
      input.actionRun,
      state.actionRun,
      CARBON_ACTION_RUN_FIELDS,
      'CARBON_ACCOUNTING_ACTION_RUN_BINDING_INVALID',
      '碳核算 ownership action run caller 投影在 registrar 接管前已漂移。'
    );
    assertCarbonOwnershipProjectionStable(
      input.actor,
      state.actor,
      CARBON_ACTOR_FIELDS,
      'CARBON_ACCOUNTING_ACTOR_BINDING_INVALID',
      '碳核算 ownership actor caller 投影在 registrar 接管前已漂移。'
    );
    const demoRun = requirePersistedCarbonDemoRunBinding(
      db,
      state.demoRun,
      'CARBON_ACCOUNTING_REGISTRATION_DEMO_RUN_STALE',
      '碳核算 registration demo run 在 registrar 接管前已漂移。'
    );
    requirePersistedCarbonActionRun(db, state.actionRun, demoRun, state.actor);
    invokeCarbonOwnershipFaultStage('carbon-registrar-handoff-before-witness-consume');
    const witnessFacts = carbonAccountingExactProtocol
      .consumeCalculationWitnessInCallerTransaction({
        db,
        demoRun: input.demoRun,
        actor: input.actor,
        exactScope: state.exactScope,
        calculationWitness: state.calculationWitness
      });
    invokeCarbonOwnershipFaultStage('carbon-registrar-handoff-before-savepoint-name');
    recoverySavepoint = createCarbonOwnershipSavepointName('registrar_recovery');
    invokeCarbonOwnershipFaultStage('carbon-registrar-handoff-before-savepoint');
    db.exec(`SAVEPOINT ${recoverySavepoint}`);
    recoverySavepointActive = true;
    handoffWithoutRecoveryBoundary = false;
    state.status = 'registering';

    const sources = requireCarbonExactImportedSources(db, demoRun, state.exactContext.exactState);
    const domain = readAndValidateCarbonDomainFacts(db, state, witnessFacts);
    const expectedEntityKeys = buildExpectedCarbonDerivedEntityKeys(domain);
    const registeredAt = new Date().toISOString();
    const registryIntents = [
      insertCarbonDerivedRegistry(db, state, domain.runContract, registeredAt),
      ...domain.resultCanonicals.map((item) => (
        insertCarbonDerivedRegistry(db, state, item.contract, registeredAt)
      ))
    ];
    invokeCarbonOwnershipFaultStage('after-registry-write');
    let registryFacts = requireCarbonDerivedRegistryClosure(
      db,
      state,
      expectedEntityKeys,
      registryIntents,
      {
        closureCode: 'CARBON_ACCOUNTING_REGISTRY_CLOSURE_MISMATCH',
        factCode: 'CARBON_ACCOUNTING_REGISTRY_CONTRACT_MISMATCH'
      }
    );

    const derivedByEntity = new Map(registryFacts.map((item) => (
      [`${item.entityType}:${item.entityPk}`, item]
    )));
    const activitySourceById = new Map(sources.carbon_activity_record.map((item) => (
      [Number(item.row.id), item.registry]
    )));
    const factorSourceById = new Map(sources.carbon_factor.map((item) => (
      [Number(item.row.id), item.registry]
    )));
    const runRegistry = derivedByEntity.get(`carbon_calculation_run:${domain.run.id}`);
    const relationIntents = [];
    domain.results.forEach((row) => {
      const resultRegistry = derivedByEntity.get(`carbon_accounting_result:${row.id}`);
      const activityRegistry = activitySourceById.get(Number(row.activity_record_id));
      relationIntents.push({
        fromRegistryId: runRegistry.registryId,
        toRegistryId: resultRegistry.registryId,
        relationType: 'contains'
      });
      relationIntents.push({
        fromRegistryId: resultRegistry.registryId,
        toRegistryId: activityRegistry.registryId,
        relationType: 'generated_from'
      });
      if (row.status === 'calculated') {
        const factorRegistry = factorSourceById.get(Number(row.carbon_factor_id));
        relationIntents.push({
          fromRegistryId: resultRegistry.registryId,
          toRegistryId: factorRegistry.registryId,
          relationType: 'uses_factor'
        });
      }
    });
    const relationCreatedAt = new Date().toISOString();
    const relationExpectedFacts = relationIntents.map((intent) => (
      insertCarbonRelation(db, state, intent, relationCreatedAt)
    ));
    invokeCarbonOwnershipFaultStage('after-relation-write');
    const relationFacts = relationExpectedFacts.map((item) => (
      readCarbonRelationFact(db, item.relationId)
    ));
    assertCarbonIntentFacts(
      relationExpectedFacts,
      relationFacts,
      'CARBON_ACCOUNTING_RELATION_CONTRACT_MISMATCH',
      '碳核算 relation 持久事实与固定意图不一致。'
    );
    // relation trigger 也可能在 registry 首次闭包确认后插入额外实体，签发 receipt 前必须再次确认全集。
    registryFacts = requireCarbonDerivedRegistryClosure(
      db,
      state,
      expectedEntityKeys,
      registryIntents,
      {
        closureCode: 'CARBON_ACCOUNTING_REGISTRY_CLOSURE_MISMATCH',
        factCode: 'CARBON_ACCOUNTING_REGISTRY_CONTRACT_MISMATCH'
      }
    );
    const derivedRegistryIds = registryFacts.map((item) => Number(item.registryId));
    assertCarbonRelationClosure(db, derivedRegistryIds, relationFacts);

    const receiptMarkerSavepoint = createCarbonOwnershipSavepointName('receipt_marker');
    db.exec(`SAVEPOINT ${receiptMarkerSavepoint}`);
    const registrationReceipt = Object.freeze({});
    const receiptFacts = {
      registrarAuthority: state.registrarAuthority,
      db,
      demoRun: state.demoRun,
      actionRun: state.actionRun,
      actor: state.actor,
      exactScope: state.exactScope,
      calculationWitness: state.calculationWitness,
      registrationScope: input.registrationScope,
      exactContextDigest: canonicalOwnershipProtocol.sha256Stable(state.exactContext),
      calculationRunId: Number(domain.run.id),
      auditFact: freezeCarbonOwnershipSnapshot(domain.audit),
      expectedEntityKeys: freezeCarbonOwnershipSnapshot(expectedEntityKeys),
      expectedEntityKeyDigest: canonicalOwnershipProtocol.sha256Stable(expectedEntityKeys),
      registryFacts: freezeCarbonOwnershipSnapshot(registryFacts),
      relationFacts: freezeCarbonOwnershipSnapshot(relationFacts),
      registryDigest: canonicalOwnershipProtocol.sha256Stable(registryFacts),
      relationDigest: canonicalOwnershipProtocol.sha256Stable(relationFacts),
      recoverySavepoint,
      receiptMarkerSavepoint,
      status: 'issued'
    };
    CARBON_REGISTRATION_RECEIPT_STATE.set(registrationReceipt, receiptFacts);
    state.status = 'registered';
    recoverySavepointActive = false;
    return registrationReceipt;
  } catch (error) {
    state.status = 'failed';
    if (handoffWithoutRecoveryBoundary) {
      const failClosed = failClosedCarbonOwnershipTransaction(db, 'carbon-registrar-handoff');
      throw createCarbonRegistrarHandoffError(error, failClosed);
    }
    if (recoverySavepointActive) {
      const recovery = db.inTransaction === true
        ? recoverCarbonOwnershipSavepoint(db, recoverySavepoint, 'carbon-registrar')
        : {
            rollbackError: createCarbonOwnershipError(
              'CARBON_ACCOUNTING_REGISTRAR_TRANSACTION_MISMATCH',
              '碳核算 registrar 已离开 caller transaction。'
            ),
            releaseError: null,
            ...failClosedCarbonOwnershipTransaction(db, 'carbon-registrar')
          };
      if (recovery.rollbackError || recovery.releaseError
        || recovery.fullRollbackError || recovery.closeError) {
        throw createCarbonOwnershipRecoveryError(
          'CARBON_ACCOUNTING_REGISTRAR_RECOVERY_FAILED',
          '碳核算 registrar 私有 SAVEPOINT 恢复失败，禁止继续提交外层事务。',
          error,
          recovery
        );
      }
    }
    throw error;
  }
}

/** 一次性验证 receipt 及完整 domain/registry/relation 持久事实，成功后才释放恢复 SAVEPOINT。 */
function verifyCarbonRegistrationReceiptInCallerTransaction(input = {}) {
  assertCarbonOwnershipProtocolFields(
    input,
    ['registrarAuthority', 'db', 'demoRun', 'actionRun', 'actor', 'exactScope',
      'calculationWitness', 'registrationScope', 'registrationReceipt'],
    'CARBON_ACCOUNTING_RECEIPT_INPUT_INVALID',
    '碳核算 receipt verifier 只能接收固定私有协议字段。'
  );
  const receipt = input.registrationReceipt;
  const receiptFacts = receipt && typeof receipt === 'object' && !utilTypes.isProxy(receipt)
    ? CARBON_REGISTRATION_RECEIPT_STATE.get(receipt)
    : null;
  if (!receiptFacts) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RECEIPT_REQUIRED',
      '碳核算 ownership 必须使用 registrar 返回的原始 receipt。',
      null,
      400
    );
  }
  if (CARBON_REGISTRATION_RECEIPT_CONSUMED.has(receipt)
    || receiptFacts.status !== 'issued') {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RECEIPT_REPLAY',
      '碳核算 registrar receipt 已消费或失效。'
    );
  }
  const state = requireCarbonRegistrationScopeState(input, ['registered']);
  const db = assertCarbonOwnershipDatabase(input.db);
  assertCarbonOwnershipProjectionStable(
    input.demoRun,
    state.demoRun,
    CARBON_DEMO_RUN_FIELDS,
    'CARBON_ACCOUNTING_RECEIPT_BINDING_MISMATCH',
    '碳核算 receipt demo run caller 投影已漂移。'
  );
  assertCarbonOwnershipProjectionStable(
    input.actionRun,
    state.actionRun,
    CARBON_ACTION_RUN_FIELDS,
    'CARBON_ACCOUNTING_RECEIPT_BINDING_MISMATCH',
    '碳核算 receipt action run caller 投影已漂移。'
  );
  assertCarbonOwnershipProjectionStable(
    input.actor,
    state.actor,
    CARBON_ACTOR_FIELDS,
    'CARBON_ACCOUNTING_RECEIPT_BINDING_MISMATCH',
    '碳核算 receipt actor caller 投影已漂移。'
  );
  if (input.registrarAuthority !== receiptFacts.registrarAuthority
    || input.db !== receiptFacts.db || input.exactScope !== receiptFacts.exactScope
    || input.calculationWitness !== receiptFacts.calculationWitness
    || input.registrationScope !== receiptFacts.registrationScope) {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RECEIPT_BINDING_MISMATCH',
      '碳核算 receipt 与 DB、run、actor、scope 或 witness 对象身份不一致。'
    );
  }
  receiptFacts.status = 'verifying';
  try {
    // 第一条 SQL 仅释放 receipt marker，跨事务验证必须在任何事实读取前失败。
    db.exec(`RELEASE SAVEPOINT ${receiptFacts.receiptMarkerSavepoint}`);
  } catch (error) {
    receiptFacts.status = 'failed';
    state.status = 'failed';
    const failClosed = failClosedCarbonOwnershipTransaction(db, 'carbon-receipt-marker');
    if (failClosed.fullRollbackError || failClosed.closeError) {
      throw createCarbonOwnershipRecoveryError(
        'CARBON_ACCOUNTING_RECEIPT_RECOVERY_FAILED',
        '碳核算 receipt transaction marker 失效且完整回滚失败。',
        error,
        { rollbackError: null, releaseError: error, ...failClosed }
      );
    }
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_RECEIPT_TRANSACTION_MISMATCH',
      '碳核算 receipt 不属于原 caller transaction。'
    );
  }

  try {
    invokeCarbonOwnershipFaultStage('receipt-before-read');
    requirePersistedCarbonActionRun(db, state.actionRun, state.demoRun, state.actor);
    requireCarbonExactImportedSources(db, state.demoRun, state.exactContext.exactState);
    const domain = readAndValidateCarbonDomainFacts(
      db,
      state,
      state.exactContext.witnessFacts
    );
    const currentAudit = readCarbonDomainAuditFact(
      db,
      receiptFacts.auditFact.id,
      domain.run,
      state.actor
    );
    if (canonicalOwnershipProtocol.sha256Stable(currentAudit)
      !== canonicalOwnershipProtocol.sha256Stable(receiptFacts.auditFact)) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RECEIPT_AUDIT_MISMATCH',
        '碳核算 receipt 绑定的领域审计已改写。'
      );
    }
    const expectedEntityKeys = buildExpectedCarbonDerivedEntityKeys(domain);
    if (canonicalOwnershipProtocol.sha256Stable(expectedEntityKeys)
      !== receiptFacts.expectedEntityKeyDigest) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RECEIPT_REGISTRY_CLOSURE_MISMATCH',
        '碳核算 receipt canonical derived 实体全集已漂移。'
      );
    }
    const registryFacts = requireCarbonDerivedRegistryClosure(
      db,
      state,
      receiptFacts.expectedEntityKeys,
      receiptFacts.registryFacts,
      {
        closureCode: 'CARBON_ACCOUNTING_RECEIPT_REGISTRY_CLOSURE_MISMATCH',
        factCode: 'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH'
      }
    );
    const relationFacts = receiptFacts.relationFacts.map((item) => (
      readCarbonRelationFact(db, item.relationId)
    ));
    if (relationFacts.some((item) => !item)
      || canonicalOwnershipProtocol.sha256Stable(registryFacts) !== receiptFacts.registryDigest
      || canonicalOwnershipProtocol.sha256Stable(relationFacts) !== receiptFacts.relationDigest) {
      throw createCarbonOwnershipError(
        'CARBON_ACCOUNTING_RECEIPT_FACT_MISMATCH',
        '碳核算 receipt registry 或 relation 事实已缺失或改写。'
      );
    }
    const derivedRegistryIds = registryFacts.map((item) => Number(item.registryId));
    assertCarbonRelationClosure(db, derivedRegistryIds, relationFacts);
    invokeCarbonOwnershipFaultStage('receipt-before-success-release');
    db.exec(`RELEASE SAVEPOINT ${receiptFacts.recoverySavepoint}`);
    receiptFacts.status = 'consumed';
    CARBON_REGISTRATION_RECEIPT_CONSUMED.add(receipt);
    state.status = 'consumed';
    return true;
  } catch (error) {
    receiptFacts.status = 'failed';
    state.status = 'failed';
    const recovery = db.inTransaction === true
      ? recoverCarbonOwnershipSavepoint(db, receiptFacts.recoverySavepoint, 'carbon-receipt')
      : {
          rollbackError: createCarbonOwnershipError(
            'CARBON_ACCOUNTING_RECEIPT_TRANSACTION_MISMATCH',
            '碳核算 receipt 已离开原 caller transaction。'
          ),
          releaseError: null,
          ...failClosedCarbonOwnershipTransaction(db, 'carbon-receipt')
        };
    if (recovery.rollbackError || recovery.releaseError
      || recovery.fullRollbackError || recovery.closeError) {
      throw createCarbonOwnershipRecoveryError(
        'CARBON_ACCOUNTING_RECEIPT_RECOVERY_FAILED',
        '碳核算 receipt 私有 SAVEPOINT 恢复失败，禁止继续提交外层事务。',
        error,
        recovery
      );
    }
    throw error;
  }
}

/** 主动终止未登记 scope 或回滚尚未验证 receipt 的 derived 写入。 */
function abortCarbonRegistrationScopeInCallerTransaction(input = {}) {
  assertCarbonOwnershipProtocolFields(
    input,
    ['registrarAuthority', 'db', 'demoRun', 'actionRun', 'actor', 'exactScope',
      'calculationWitness', 'registrationScope'],
    'CARBON_ACCOUNTING_REGISTRATION_ABORT_INPUT_INVALID',
    '碳核算 registration abort 只能接收固定私有协议字段。'
  );
  const state = requireCarbonRegistrationScopeState(
    input,
    ['issued', 'registered', 'failed']
  );
  const db = assertCarbonOwnershipDatabase(input.db);
  if (state.status === 'registered') {
    throw createCarbonOwnershipError(
      'CARBON_ACCOUNTING_REGISTRATION_ABORT_RECEIPT_REQUIRED',
      '已登记 scope 必须由 receipt verifier 成功或失败恢复，不允许绕过 receipt abort。'
    );
  }
  if (state.status === 'issued') {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${state.transactionMarkerSavepoint}`);
      db.exec(`RELEASE SAVEPOINT ${state.transactionMarkerSavepoint}`);
    } catch (error) {
      const failClosed = failClosedCarbonOwnershipTransaction(db, 'carbon-registration-abort');
      throw createCarbonOwnershipRecoveryError(
        'CARBON_ACCOUNTING_REGISTRATION_ABORT_RECOVERY_FAILED',
        '碳核算 registration abort 恢复失败。',
        error,
        { rollbackError: error, releaseError: null, ...failClosed }
      );
    }
  }
  state.status = 'failed';
  return true;
}

/** 内部协议 wrapper 固定注入服务闭包 authority，拒绝 caller 自带 authority。 */
function callWithCarbonRegistrarAuthority(handler, input, expectedFields) {
  assertCarbonOwnershipProtocolFields(
    input,
    expectedFields,
    'CARBON_ACCOUNTING_OWNERSHIP_INTERNAL_INPUT_INVALID',
    '碳核算 ownership 内部协议字段无效。'
  );
  return handler({ registrarAuthority: CARBON_REGISTRAR_AUTHORITY, ...input });
}

const CARBON_REGISTRATION_BINDING_FIELDS = Object.freeze([
  'db', 'demoRun', 'actionRun', 'actor', 'exactScope', 'calculationWitness'
]);
const CARBON_REGISTRATION_SCOPE_FIELDS = Object.freeze([
  ...CARBON_REGISTRATION_BINDING_FIELDS,
  'registrationScope'
]);
const CARBON_REGISTRATION_RECEIPT_FIELDS = Object.freeze([
  ...CARBON_REGISTRATION_SCOPE_FIELDS,
  'registrationReceipt'
]);

Object.defineProperty(
  carbonAccountingOwnershipServiceExports,
  CARBON_OWNERSHIP_INTERNAL_PROTOCOL_SYMBOL,
  {
    value: Object.freeze({
      issueRegistrationScopeInCallerTransaction: (input) => (
        callWithCarbonRegistrarAuthority(
          issueCarbonRegistrationScopeInCallerTransaction,
          input,
          CARBON_REGISTRATION_BINDING_FIELDS
        )
      ),
      registerDerivedOwnershipInCallerTransaction: (input) => (
        callWithCarbonRegistrarAuthority(
          registerCarbonDerivedOwnershipInCallerTransaction,
          input,
          CARBON_REGISTRATION_SCOPE_FIELDS
        )
      ),
      verifyRegistrationReceiptInCallerTransaction: (input) => (
        callWithCarbonRegistrarAuthority(
          verifyCarbonRegistrationReceiptInCallerTransaction,
          input,
          CARBON_REGISTRATION_RECEIPT_FIELDS
        )
      ),
      abortRegistrationScopeInCallerTransaction: (input) => (
        callWithCarbonRegistrarAuthority(
          abortCarbonRegistrationScopeInCallerTransaction,
          input,
          CARBON_REGISTRATION_SCOPE_FIELDS
        )
      )
    }),
    enumerable: false,
    writable: false,
    configurable: false
  }
);

Object.freeze(carbonAccountingOwnershipServiceExports);
