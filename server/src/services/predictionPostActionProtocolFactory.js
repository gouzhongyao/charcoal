'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');
const databaseModule = require('../db/database');
const { AppError } = require('../utils/errors');
const { requireDemoDatasetRun } = require('./demoRunService');
const demoOwnershipService = require('./demoOwnershipService');
const predictionService = require('./predictionService');

// Prediction P4 仅通过以下三个初始化期捕获的非枚举 Symbol 协议协作。
const DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
const PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.prediction.exactInternal.v1');
const DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.database.rawConnectionInternal.v1');

// 协议能力在模块初始化期固定，后续普通 export 或 require.cache 替换不能接管已捕获函数。
const canonicalOwnershipProtocol =
  demoOwnershipService[DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL];
const predictionExactProtocol =
  predictionService[PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL];
const rawConnectionProtocol =
  databaseModule[DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL];

if (!canonicalOwnershipProtocol
  || typeof canonicalOwnershipProtocol.buildEntityRegistrationContract !== 'function'
  || typeof canonicalOwnershipProtocol.getEntityHandler !== 'function'
  || typeof canonicalOwnershipProtocol.sha256Stable !== 'function'
  || typeof canonicalOwnershipProtocol.verifyManagedImportedSourceExactClosure !== 'function') {
  const error = new Error('Prediction ownership canonical 协议未完成初始化。');
  error.code = 'PREDICTION_OWNERSHIP_CANONICAL_PROTOCOL_UNAVAILABLE';
  throw error;
}
if (!predictionExactProtocol
  || typeof predictionExactProtocol.readCompletionWitness !== 'function') {
  const error = new Error('Prediction exact completion witness 协议未完成初始化。');
  error.code = 'PREDICTION_EXACT_PROTOCOL_UNAVAILABLE';
  throw error;
}

/** 创建绑定指定 definition verifier 的隔离 P4 registrar；parallel instance 状态互不兼容。 */
function createPredictionPostActionProtocol(options = {}) {
  let optionDescriptors = null;
  try {
    optionDescriptors = Object.getOwnPropertyDescriptors(options);
  } catch (_error) {
    optionDescriptors = null;
  }
  if (!optionDescriptors || utilTypes.isProxy(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || Object.getOwnPropertySymbols(options).length !== 0
    || Object.keys(optionDescriptors).length !== 2
    || !optionDescriptors.verifyDefinitionCapability
    || !optionDescriptors.predictionP4CompletionProtocol
    || optionDescriptors.verifyDefinitionCapability.enumerable !== true
    || optionDescriptors.predictionP4CompletionProtocol.enumerable !== true
    || typeof optionDescriptors.verifyDefinitionCapability.get === 'function'
    || typeof optionDescriptors.verifyDefinitionCapability.set === 'function'
    || typeof optionDescriptors.verifyDefinitionCapability.value !== 'function'
    || typeof optionDescriptors.predictionP4CompletionProtocol.get === 'function'
    || typeof optionDescriptors.predictionP4CompletionProtocol.set === 'function') {
    const error = new Error('Prediction P4 factory 构造参数无效。');
    error.code = 'PREDICTION_POST_ACTION_PROTOCOL_FACTORY_INPUT_INVALID';
    throw error;
  }
  const verifyDefinitionCapability = optionDescriptors.verifyDefinitionCapability.value;
  const predictionP4CompletionProtocol =
    optionDescriptors.predictionP4CompletionProtocol.value;
  if (!predictionP4CompletionProtocol
    || typeof predictionP4CompletionProtocol !== 'object'
    || utilTypes.isProxy(predictionP4CompletionProtocol)
    || typeof predictionP4CompletionProtocol.bindCompletionWitness !== 'function'
    || typeof predictionP4CompletionProtocol.consumeCompletionWitness !== 'function'
    || typeof predictionP4CompletionProtocol.readTotalChanges !== 'function'
    || typeof predictionP4CompletionProtocol.releaseSavepoint !== 'function') {
    const error = new Error('Prediction P4 completion protocol 构造参数无效。');
    error.code = 'PREDICTION_POST_ACTION_COMPLETION_PROTOCOL_INVALID';
    throw error;
  }

// registrar authority、scope、receipt 和消费记录只存在于本次工厂调用的私有闭包。
const PREDICTION_REGISTRAR_AUTHORITY = Object.freeze({});
const PREDICTION_REGISTRATION_SCOPE_STATE = new WeakMap();
const PREDICTION_REGISTRATION_RECEIPT_STATE = new WeakMap();
const PREDICTION_REGISTRATION_RECEIPT_CONSUMED = new WeakSet();
// P4 固定以 Artifact 12 作为 derived registry anchor，不改变 cleanup capability。
const PREDICTION_DERIVED_ARTIFACT_KEY = '12-prediction-configs';
const PREDICTION_CONFIG_ARTIFACT_KEY = '12-prediction-configs';
const PREDICTION_ENERGY_ARTIFACT_KEY = '07-monthly-energy';
// 服务端身份对象只接受固定字段，不接收 adapter 之外的任意附加控制数据。
const PREDICTION_DEMO_RUN_FIELDS = Object.freeze([
  'runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status', 'createdBy', 'createdAt'
]);
const PREDICTION_ACTION_RUN_FIELDS = Object.freeze([
  'actionRunId', 'runId', 'datasetId', 'actionKey', 'requestedBy', 'status'
]);
const PREDICTION_ACTOR_FIELDS = Object.freeze(['userId', 'username', 'displayName', 'ip']);
const PREDICTION_BINDING_FIELDS = Object.freeze([
  'db', 'transactionScope', 'completionWitness', 'definitionCapability',
  'demoRun', 'actionRun', 'actor'
]);
const PREDICTION_SCOPE_FIELDS = Object.freeze([
  ...PREDICTION_BINDING_FIELDS,
  'registrationScope'
]);
const PREDICTION_RECEIPT_FIELDS = Object.freeze([
  ...PREDICTION_SCOPE_FIELDS,
  'registrationReceipt'
]);

/** 构造稳定、脱敏的 Prediction ownership 错误。 */
function createPredictionOwnershipError(code, message, details = null, statusCode = 409) {
  return new AppError(code, message, { statusCode, details });
}

/** 提取可公开的稳定错误码，避免 SQL 和对象内容泄露到恢复错误。 */
function readPredictionOwnershipSafeErrorCode(error) {
  const code = [error?.code, error?.details?.code]
    .find((value) => typeof value === 'string') || null;
  return code && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : null;
}

/** 递归冻结 registrar 保存的独立事实快照。 */
function freezePredictionOwnershipSnapshot(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezePredictionOwnershipSnapshot));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, freezePredictionOwnershipSnapshot(item)]
    ))));
  }
  return value;
}

/** 私有协议输入必须是无 Proxy、getter、Symbol 和附加字段的普通对象。 */
function assertPredictionOwnershipProtocolFields(value, expectedFields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createPredictionOwnershipError(code, message, null, 400);
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
    throw createPredictionOwnershipError(code, message, {
      expectedFields: normalizedExpectedFields,
      actualFields,
      hasAccessor
    }, 400);
  }
  return value;
}

/** 确认 registrar 使用数据库抽象创建的原始连接和 caller-owned transaction。 */
function assertPredictionOwnershipDatabase(db) {
  const valid = rawConnectionProtocol
    && typeof rawConnectionProtocol.isOpenRawDatabaseConnection === 'function'
    && rawConnectionProtocol.isOpenRawDatabaseConnection(db);
  if (!valid || db.inTransaction !== true) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_TRANSACTION_REQUIRED',
      'Prediction ownership 必须使用原始连接和 caller-owned transaction。',
      null,
      500
    );
  }
  return db;
}

/** 构造身份对象的冻结固定投影。 */
function createFrozenPredictionOwnershipProjection(source, fields) {
  return Object.freeze(Object.fromEntries(fields.map((fieldName) => [fieldName, source[fieldName]])));
}

/** 校验当前原始身份对象仍与 scope 签发时完全一致。 */
function assertPredictionOwnershipProjectionStable(current, snapshot, fields, code, message) {
  const invalidObject = !current || typeof current !== 'object' || Array.isArray(current)
    || utilTypes.isProxy(current) || Object.getPrototypeOf(current) !== Object.prototype;
  if (invalidObject) throw createPredictionOwnershipError(code, message);
  const descriptors = Object.getOwnPropertyDescriptors(current);
  const actualFields = Object.keys(descriptors).sort();
  const expectedFields = [...fields].sort();
  const drifted = Object.getOwnPropertySymbols(current).length > 0
    || actualFields.length !== expectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== expectedFields[index])
    || fields.some((fieldName) => {
      const descriptor = descriptors[fieldName];
      return !descriptor || typeof descriptor.get === 'function'
        || typeof descriptor.set === 'function' || descriptor.value !== snapshot[fieldName];
    });
  if (drifted) throw createPredictionOwnershipError(code, message);
  return current;
}

/** 校验 demo run、action run 和 actor 固定服务端投影的基础值域。 */
function assertPredictionInvocationObjects(input) {
  assertPredictionOwnershipProtocolFields(
    input.demoRun,
    PREDICTION_DEMO_RUN_FIELDS,
    'PREDICTION_OWNERSHIP_DEMO_RUN_OBJECT_INVALID',
    'Prediction ownership demo run 必须使用固定服务端投影原对象。'
  );
  assertPredictionOwnershipProtocolFields(
    input.actionRun,
    PREDICTION_ACTION_RUN_FIELDS,
    'PREDICTION_OWNERSHIP_ACTION_RUN_OBJECT_INVALID',
    'Prediction ownership action run 必须使用固定服务端投影原对象。'
  );
  assertPredictionOwnershipProtocolFields(
    input.actor,
    PREDICTION_ACTOR_FIELDS,
    'PREDICTION_OWNERSHIP_ACTOR_OBJECT_INVALID',
    'Prediction ownership actor 必须使用固定服务端投影原对象。'
  );
  const demoRun = input.demoRun;
  const actionRun = input.actionRun;
  const actor = input.actor;
  const validDigest = typeof demoRun.manifestDigest === 'string'
    && /^[a-f0-9]{64}$/.test(demoRun.manifestDigest);
  if (typeof demoRun.runId !== 'string' || demoRun.runId.trim() !== demoRun.runId
    || demoRun.runId.length === 0
    || typeof demoRun.datasetId !== 'string' || demoRun.datasetId.trim() !== demoRun.datasetId
    || demoRun.datasetId.length === 0
    || typeof demoRun.manifestVersion !== 'string'
    || demoRun.manifestVersion.trim() !== demoRun.manifestVersion
    || demoRun.manifestVersion.length === 0 || !validDigest
    || !['active', 'completed'].includes(demoRun.status)
    || (demoRun.createdBy !== null
      && (!Number.isSafeInteger(demoRun.createdBy) || demoRun.createdBy < 1))
    || typeof demoRun.createdAt !== 'string') {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_DEMO_RUN_OBJECT_INVALID',
      'Prediction ownership demo run 固定字段无效。',
      null,
      400
    );
  }
  if (typeof actionRun.actionRunId !== 'string'
    || actionRun.actionRunId.trim() !== actionRun.actionRunId
    || actionRun.actionRunId.length === 0
    || actionRun.runId !== demoRun.runId || actionRun.datasetId !== demoRun.datasetId
    || actionRun.actionKey !== 'prediction-run' || actionRun.status !== 'executing'
    || !Number.isSafeInteger(actionRun.requestedBy) || actionRun.requestedBy < 1) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_ACTION_RUN_OBJECT_INVALID',
      'Prediction ownership action run 固定字段无效。',
      null,
      400
    );
  }
  if (!Number.isSafeInteger(actor.userId) || actor.userId < 1
    || actor.userId !== actionRun.requestedBy
    || typeof actor.username !== 'string' || actor.username.trim() === ''
    || (actor.displayName !== null && typeof actor.displayName !== 'string')
    || (actor.ip !== null && typeof actor.ip !== 'string')) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_ACTOR_OBJECT_INVALID',
      'Prediction ownership actor 固定字段无效。',
      null,
      400
    );
  }
}

/** 重读并绑定 demo run 固定身份和生命周期投影。 */
function requirePersistedPredictionDemoRun(db, demoRun, code) {
  let persisted = null;
  try {
    persisted = requireDemoDatasetRun(db, demoRun.runId);
  } catch (_error) {
    throw createPredictionOwnershipError(code, 'Prediction ownership demo run 持久事实无效。');
  }
  if (PREDICTION_DEMO_RUN_FIELDS.some((fieldName) => persisted[fieldName] !== demoRun[fieldName])) {
    throw createPredictionOwnershipError(code, 'Prediction ownership demo run 持久事实已漂移。');
  }
  return persisted;
}

/** 重读并绑定当前 executing Prediction action run。 */
function requirePersistedPredictionActionRun(db, actionRun, demoRun, actor) {
  const persisted = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      dataset_id AS datasetId, action_key AS actionKey, requested_by AS requestedBy, status,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      runtime_epoch AS runtimeEpoch, runtime_revision AS runtimeRevision,
      executor_version AS executorVersion
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRun.actionRunId) || null;
  if (!persisted) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_ACTION_RUN_BINDING_INVALID',
      'Prediction ownership 找不到当前 executing action run。'
    );
  }
  persisted.requestedBy = Number(persisted.requestedBy);
  const runtime = db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
      revision AS runtimeRevision FROM demo_runtime_settings WHERE id = 1`).get() || null;
  if (PREDICTION_ACTION_RUN_FIELDS.some((fieldName) => persisted[fieldName] !== actionRun[fieldName])
    || persisted.runId !== demoRun.runId || persisted.datasetId !== demoRun.datasetId
    || persisted.manifestVersion !== demoRun.manifestVersion
    || persisted.manifestDigest !== demoRun.manifestDigest
    || !Number.isSafeInteger(Number(persisted.runtimeEpoch))
    || Number(persisted.runtimeEpoch) < 1
    || !Number.isSafeInteger(Number(persisted.runtimeRevision))
    || Number(persisted.runtimeRevision) < 1
    || persisted.executorVersion !== 'prediction-executor:v1'
    || !runtime || Number(runtime.enabled) !== 1
    || Number(runtime.runtimeEpoch) !== Number(persisted.runtimeEpoch)
    || Number(runtime.runtimeRevision) !== Number(persisted.runtimeRevision)
    || persisted.actionKey !== 'prediction-run' || persisted.status !== 'executing'
    || persisted.requestedBy !== actor.userId) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_ACTION_RUN_BINDING_INVALID',
      'Prediction ownership 与当前 action run、demo run 或 actor 不一致。'
    );
  }
  return persisted;
}

/** 为 scope、registrar 和 receipt 创建不可预测 SAVEPOINT 名称。 */
function createPredictionOwnershipSavepointName(purpose) {
  return `prediction_ownership_${purpose}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 通过初始化期捕获的 P3 linker 释放当前 P4 scope 自身的随机 SAVEPOINT。 */
function releasePredictionOwnershipSavepoint(state, savepointName) {
  return predictionP4CompletionProtocol.releaseSavepoint({
    db: state.db,
    transactionScope: state.transactionScope,
    completionWitness: state.completionWitness,
    demoRun: state.demoRunIdentity,
    actionRun: state.actionRunIdentity,
    actor: state.actorIdentity
  }, savepointName);
}

/** 通过初始化期 P3 linker 读取当前 witness 连接的累计写入代次。 */
function readPredictionOwnershipTotalChanges(state) {
  return predictionP4CompletionProtocol.readTotalChanges({
    db: state.db,
    transactionScope: state.transactionScope,
    completionWitness: state.completionWitness,
    demoRun: state.demoRunIdentity,
    actionRun: state.actionRunIdentity,
    actor: state.actorIdentity
  });
}

/** 私有恢复边界失效时完整回滚；完整回滚失败则关闭连接。 */
function failClosedPredictionOwnershipTransaction(db) {
  let fullRollbackError = null;
  let closeError = null;
  try {
    if (db.inTransaction === true) db.exec('ROLLBACK');
  } catch (error) {
    fullRollbackError = error;
  }
  if (fullRollbackError || db.inTransaction === true) {
    try {
      db.close();
    } catch (error) {
      closeError = error;
    }
  }
  return { fullRollbackError, closeError };
}

/** 回滚并释放 registrar SAVEPOINT；任一阶段失败即完整回滚。 */
function recoverPredictionOwnershipSavepoint(state, savepointName) {
  const db = state.db;
  let rollbackError = null;
  let releaseError = null;
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } catch (error) {
    rollbackError = error;
  }
  if (!rollbackError) {
    try {
      releasePredictionOwnershipSavepoint(state, savepointName);
    } catch (error) {
      releaseError = error;
    }
  }
  const failClosed = rollbackError || releaseError
    ? failClosedPredictionOwnershipTransaction(db)
    : { fullRollbackError: null, closeError: null };
  return { rollbackError, releaseError, ...failClosed };
}

/** 构造不泄露 SQL 的恢复失败错误。 */
function createPredictionOwnershipRecoveryError(code, message, originalError, recovery) {
  return createPredictionOwnershipError(code, message, {
    originalCode: readPredictionOwnershipSafeErrorCode(originalError),
    rollbackCode: readPredictionOwnershipSafeErrorCode(recovery.rollbackError),
    releaseCode: readPredictionOwnershipSafeErrorCode(recovery.releaseError),
    fullRollbackCode: readPredictionOwnershipSafeErrorCode(recovery.fullRollbackError),
    closeCode: readPredictionOwnershipSafeErrorCode(recovery.closeError)
  }, 500);
}

/** 通过故意错引用调用 P3 协议污染 exact scope，阻止被调用方捕获错误后提交领域写入。 */
function poisonPredictionExactInvocation(input) {
  if (!input || !input.db || input.db.inTransaction !== true) return false;
  try {
    predictionExactProtocol.readCompletionWitness({
      db: input.db,
      transactionScope: input.transactionScope,
      completionWitness: input.completionWitness,
      demoRun: input.demoRun && typeof input.demoRun === 'object'
        ? { ...input.demoRun }
        : {},
      actionRun: input.actionRun,
      actor: input.actor
    });
  } catch (_error) {
    return true;
  }
  return false;
}

/** 使用已签发 scope 的原始 P3 invocation 污染 exact scope。 */
function poisonPredictionExactScope(state) {
  return poisonPredictionExactInvocation({
    db: state?.db,
    transactionScope: state?.transactionScope,
    completionWitness: state?.completionWitness,
    demoRun: state?.demoRunIdentity,
    actionRun: state?.actionRunIdentity,
    actor: state?.actorIdentity
  });
}

/** 身份或 marker 失败时污染 P3 scope；事务边界已丢失时再完整回滚。 */
function poisonPredictionOwnershipBinding(state, db, code, message, originalError = null) {
  if (state) state.status = 'failed';
  if (poisonPredictionExactScope(state)) {
    throw createPredictionOwnershipError(code, message);
  }
  const failClosed = failClosedPredictionOwnershipTransaction(db);
  if (failClosed.fullRollbackError || failClosed.closeError) {
    throw createPredictionOwnershipRecoveryError(
      'PREDICTION_OWNERSHIP_FAIL_CLOSED_RECOVERY_FAILED',
      'Prediction ownership fail-closed 完整回滚失败。',
      originalError,
      { rollbackError: null, releaseError: originalError, ...failClosed }
    );
  }
  throw createPredictionOwnershipError(code, message);
}

/** 读取指定实体当前唯一 active registry。 */
function readActivePredictionRegistry(db, entityType, entityPk) {
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

/** 从 canonical handler 重读业务 projection 并构造 identity/snapshot 合同。 */
function readCanonicalPredictionProjection(db, entityType, entityPk) {
  const handler = canonicalOwnershipProtocol.getEntityHandler(entityType);
  const row = handler ? handler.readProjection(db, Number(entityPk)) : null;
  if (!handler || !row || row.id !== Number(entityPk)) {
    throw createPredictionOwnershipError(
      'PREDICTION_OWNERSHIP_ENTITY_MISSING',
      'Prediction ownership 目标业务事实不存在。',
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

/** 读取并验证 managed imported ownership 的批次、primary binding 和 executed context。 */
function requirePredictionManagedImportedEntity(db, definition) {
  const registry = readActivePredictionRegistry(db, definition.entityType, definition.entityPk);
  const canonical = readCanonicalPredictionProjection(db, definition.entityType, definition.entityPk);
  const bindings = registry?.sourceBatchId
    ? db.prepare(`SELECT rib.run_id AS runId, rib.artifact_key AS artifactKey,
          rib.import_batch_id AS importBatchId, rib.batch_role AS batchRole,
          dic.context_id AS contextId, dic.dataset_id AS datasetId,
          dic.handler_key AS handlerKey, dic.status AS contextStatus,
          dic.issued_to_user_id AS issuedToUserId, ib.import_type AS importType,
          ib.status AS batchStatus
        FROM demo_run_import_batches rib
        JOIN demo_import_contexts dic ON dic.context_id = rib.context_id
          AND dic.run_id = rib.run_id AND dic.artifact_key = rib.artifact_key
        JOIN import_batches ib ON ib.id = rib.import_batch_id
        WHERE rib.run_id = ? AND rib.artifact_key = ?
          AND rib.import_batch_id = ? AND rib.batch_role = 'primary'`).all(
      definition.demoRun.runId,
      definition.artifactKey,
      Number(registry.sourceBatchId)
    )
    : [];
  const binding = bindings.length === 1 ? bindings[0] : null;
  if (!registry || registry.runId !== definition.demoRun.runId
    || registry.artifactKey !== definition.artifactKey
    || registry.entityType !== definition.entityType
    || registry.entityPk !== String(definition.entityPk)
    || registry.ownershipKind !== 'imported'
    || registry.legacyClaimRunId !== null || registry.cleanedAt !== null
    || registry.cleanupRunId !== null || registry.cleanupResult !== null
    || !Number.isSafeInteger(Number(registry.sourceBatchId))
    || Number(registry.sourceBatchId) < 1
    || !Number.isSafeInteger(Number(registry.sourceRowNumber))
    || Number(registry.sourceRowNumber) < 1
    || canonical.row.source_batch_id !== Number(registry.sourceBatchId)
    || canonical.row.source_row_number !== Number(registry.sourceRowNumber)
    || canonical.contract.identityDigest !== registry.identityDigest
    || canonical.contract.snapshotDigest !== registry.snapshotDigest
    || !binding || binding.runId !== definition.demoRun.runId
    || binding.artifactKey !== definition.artifactKey
    || Number(binding.importBatchId) !== Number(registry.sourceBatchId)
    || binding.batchRole !== 'primary' || binding.datasetId !== definition.demoRun.datasetId
    || binding.handlerKey !== definition.handlerKey || binding.contextStatus !== 'executed'
    || binding.importType !== definition.importType || binding.batchStatus !== 'completed'
    || Number(binding.issuedToUserId) !== Number(registry.registeredBy)
    || Number(registry.registeredBy) !== Number(definition.registeredBy)) {
    throw createPredictionOwnershipError(
      'PREDICTION_SOURCE_OWNERSHIP_INVALID',
      'Prediction source ownership、provenance、binding 或 digest 无效。',
      { artifactKey: definition.artifactKey, entityType: definition.entityType }
    );
  }
  return { registry, row: canonical.row, contract: canonical.contract, binding };
}

/** 查询当前 run 指定 artifact/entity 的 active imported ownership 主键全集。 */
function readPredictionImportedEntityIds(db, runId, artifactKey, entityType) {
  return db.prepare(`SELECT entity_pk AS entityPk FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL
    ORDER BY CAST(entity_pk AS INTEGER), registry_id`).all(runId, artifactKey, entityType)
    .map((row) => Number(row.entityPk));
}

/** 构造 Artifact 12 配置在 Prediction run 中的固定 snapshot。 */
function buildPredictionConfigSnapshot(db, configRow) {
  const joined = db.prepare(`SELECT et.code AS energyTypeCode,
      ou.unit_code AS organizationUnitCode, md.meter_code AS meterCode
    FROM prediction_configs pc
    LEFT JOIN energy_types et ON et.id = pc.energy_type_id
    LEFT JOIN organization_units ou ON ou.id = pc.organization_unit_id
    LEFT JOIN meter_devices md ON md.id = pc.meter_device_id
    WHERE pc.id = ?`).get(configRow.id) || null;
  if (!joined) {
    throw createPredictionOwnershipError(
      'PREDICTION_CONFIG_BINDING_INVALID',
      'Prediction source config 关联事实不存在。'
    );
  }
  return {
    configId: configRow.id,
    config: {
      name: configRow.name,
      note: configRow.note,
      energyTypeCode: joined.energyTypeCode,
      organizationUnitId: configRow.organization_unit_id,
      organizationUnitCode: joined.organizationUnitCode,
      meterDeviceId: configRow.meter_device_id,
      meterCode: joined.meterCode,
      sourceBatchId: configRow.source_batch_filter_id,
      trainStartMonth: configRow.train_start_month,
      trainEndMonth: configRow.train_end_month,
      predictStartMonth: configRow.predict_start_month,
      predictEndMonth: configRow.predict_end_month,
      algorithm: configRow.algorithm,
      windowSize: configRow.window_size
    }
  };
}

/** 根据 config projection 构造正式 normalizePredictionPayload 的固定事实。 */
function buildPredictionNormalizedPayload(configRow, configSnapshot, witnessFacts) {
  const filters = {
    energyTypeCode: configSnapshot.config.energyTypeCode,
    organizationUnitCode: configSnapshot.config.organizationUnitCode,
    organizationUnitId: configSnapshot.config.organizationUnitId,
    meterCode: configSnapshot.config.meterCode,
    meterDeviceId: configSnapshot.config.meterDeviceId,
    sourceBatchId: configSnapshot.config.sourceBatchId
  };
  Object.keys(filters).forEach((fieldName) => {
    if (filters[fieldName] === null || filters[fieldName] === undefined) delete filters[fieldName];
  });
  return {
    name: configRow.name,
    note: configRow.note,
    algorithm: configRow.algorithm,
    trainStartMonth: configRow.train_start_month,
    trainEndMonth: configRow.train_end_month,
    predictStartMonth: configRow.predict_start_month,
    predictEndMonth: configRow.predict_end_month,
    trainMonths: witnessFacts.trainMonths,
    predictionMonths: witnessFacts.predictionMonths,
    ...(configRow.algorithm === 'moving_average' ? { windowSize: configRow.window_size } : {}),
    filters,
    requiredHistoryMonths: configRow.algorithm === 'moving_average'
      ? Math.max(3, configRow.window_size)
      : 3
  };
}

/** 重读 Artifact 12 唯一 config 与 Artifact 07 exact training ownership 全集。 */
function requirePredictionExactImportedSources(db, state, witnessFacts) {
  const configId = witnessFacts?.configSnapshot?.configId;
  if (!Number.isSafeInteger(configId) || configId < 1) {
    throw createPredictionOwnershipError(
      'PREDICTION_CONFIG_WITNESS_INVALID',
      'Prediction completion witness 未绑定有效 Artifact 12 config。'
    );
  }
  const configIds = readPredictionImportedEntityIds(
    db,
    state.demoRun.runId,
    PREDICTION_CONFIG_ARTIFACT_KEY,
    'prediction_config'
  );
  if (configIds.length !== 1 || configIds[0] !== configId) {
    throw createPredictionOwnershipError(
      'PREDICTION_CONFIG_SOURCE_SET_MISMATCH',
      '当前 demo run 的 Artifact 12 active imported config 必须唯一且等于 witness config。'
    );
  }
  const config = requirePredictionManagedImportedEntity(db, {
    demoRun: state.demoRun,
    artifactKey: PREDICTION_CONFIG_ARTIFACT_KEY,
    handlerKey: 'prediction-configs-import',
    importType: 'prediction_config',
    entityType: 'prediction_config',
    entityPk: configId,
    registeredBy: state.actor.userId
  });
  if (!['draft', 'active'].includes(config.row.status) || config.row.archived_at !== null
    || config.row.source_batch_filter_id === null) {
    throw createPredictionOwnershipError(
      'PREDICTION_CONFIG_SOURCE_INVALID',
      'Prediction source config 必须是未归档的 managed retained config，并绑定 Artifact 07 批次。'
    );
  }
  const configSnapshot = buildPredictionConfigSnapshot(db, config.row);
  if (canonicalOwnershipProtocol.sha256Stable(configSnapshot)
    !== canonicalOwnershipProtocol.sha256Stable(witnessFacts.configSnapshot)) {
    throw createPredictionOwnershipError(
      'PREDICTION_CONFIG_WITNESS_MISMATCH',
      'Prediction source config 与 completion witness 快照不一致。'
    );
  }
  const exactRecords = witnessFacts.exactTrainingRecords;
  const exactIds = Array.isArray(exactRecords)
    ? exactRecords.map((record) => record.id)
    : [];
  if (exactIds.length === 0 || exactIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    || new Set(exactIds).size !== exactIds.length) {
    throw createPredictionOwnershipError(
      'PREDICTION_TRAINING_WITNESS_INVALID',
      'Prediction exact training records 必须是非空唯一正整数主键集合。'
    );
  }
  // Artifact 07 是多用途 primary batch；exact 只要求是正式 config 筛选出的完整子集。
  const sortedExactIds = [...exactIds].sort((left, right) => left - right);
  const trainingById = new Map(exactRecords.map((record) => [record.id, record]));
  const records = sortedExactIds.map((entityPk) => {
    const source = requirePredictionManagedImportedEntity(db, {
      demoRun: state.demoRun,
      artifactKey: PREDICTION_ENERGY_ARTIFACT_KEY,
      handlerKey: 'monthly-energy-import',
      importType: 'energy_record',
      entityType: 'energy_record',
      entityPk,
      registeredBy: state.actor.userId
    });
    const witness = trainingById.get(entityPk);
    const joined = db.prepare(`SELECT et.code AS energyTypeCode, et.name AS energyTypeName,
        et.standard_unit AS standardUnit, ou.unit_code AS organizationUnitCode,
        ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath,
        md.meter_code AS meterCode, md.meter_name AS meterName
      FROM energy_records er
      JOIN energy_types et ON et.id = er.energy_type_id
      JOIN organization_units ou ON ou.id = er.organization_unit_id
      LEFT JOIN meter_devices md ON md.id = er.meter_device_id
      WHERE er.id = ?`).get(entityPk) || null;
    const expectedWitnessProjection = {
      id: source.row.id,
      sourceBatchId: source.row.source_batch_id,
      sourceRowNumber: source.row.source_row_number,
      energyTypeId: source.row.energy_type_id,
      energyTypeCode: joined?.energyTypeCode,
      energyTypeName: joined?.energyTypeName,
      organizationUnitId: source.row.organization_unit_id,
      organizationUnitCode: joined?.organizationUnitCode,
      organizationUnitName: joined?.organizationUnitName,
      organizationUnitPath: joined?.organizationUnitPath,
      meterDeviceId: source.row.meter_device_id,
      meterCode: joined?.meterCode,
      meterName: joined?.meterName,
      originalMonth: source.row.original_month,
      normalizedMonth: source.row.normalized_month,
      originalUnit: source.row.original_unit,
      originalValue: source.row.original_value,
      normalizedUnit: source.row.normalized_unit,
      normalizedValue: source.row.normalized_value,
      remark: source.row.remark,
      duplicateKey: source.row.duplicate_key,
      recordStatus: source.row.record_status,
      createdAt: source.row.created_at,
      updatedAt: source.row.updated_at
    };
    const currentWitnessProjection = Object.fromEntries(
      Object.keys(expectedWitnessProjection).map((fieldName) => [fieldName, witness[fieldName]])
    );
    if (!joined || joined.standardUnit !== source.row.normalized_unit
      || source.row.record_status !== 'active'
      || source.row.source_batch_id !== config.row.source_batch_filter_id
      || canonicalOwnershipProtocol.sha256Stable(expectedWitnessProjection)
        !== canonicalOwnershipProtocol.sha256Stable(currentWitnessProjection)) {
      throw createPredictionOwnershipError(
        'PREDICTION_TRAINING_SOURCE_INVALID',
        'Prediction exact training record 与 Artifact 07 ownership 或 witness 事实不一致。',
        { entityPk }
      );
    }
    return source;
  });
  const expectedNormalizedPayload = buildPredictionNormalizedPayload(
    config.row,
    configSnapshot,
    witnessFacts
  );
  if (canonicalOwnershipProtocol.sha256Stable(expectedNormalizedPayload)
    !== canonicalOwnershipProtocol.sha256Stable(witnessFacts.normalizedPayload)) {
    throw createPredictionOwnershipError(
      'PREDICTION_NORMALIZED_PAYLOAD_MISMATCH',
      'Prediction normalized payload 与唯一 Artifact 12 config 不一致。'
    );
  }
  const managedClosure = canonicalOwnershipProtocol.verifyManagedImportedSourceExactClosure({
    db,
    demoRunId: state.demoRun.runId,
    actorUserId: state.actor.userId,
    configEntityPk: configId,
    energyRecordEntityPks: sortedExactIds
  });
  if (managedClosure.energyBatchId !== config.row.source_batch_filter_id
    || managedClosure.predictionBatchId !== config.row.source_batch_id) {
    throw createPredictionOwnershipError(
      'PREDICTION_MANAGED_SOURCE_BATCH_MISMATCH',
      'Prediction completion witness 没有绑定 Artifact 07/12 managed primary batch closure。'
    );
  }
  return { config, configSnapshot, records, managedClosure };
}

/** 将 canonical run projection 映射为 completion witness 的公开持久事实形状。 */
function mapPredictionRunWitnessFact(db, row) {
  let parameters = null;
  try {
    parameters = JSON.parse(row.parameters_json);
  } catch (_error) {
    parameters = null;
  }
  const energyType = row.target_energy_type_id === null
    ? null
    : db.prepare('SELECT code, name FROM energy_types WHERE id = ?')
      .get(row.target_energy_type_id) || null;
  const resultCount = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM prediction_results WHERE prediction_run_id = ?'
  ).get(row.id).count);
  return {
    id: row.id,
    name: row.name,
    algorithm: row.algorithm,
    status: row.status,
    targetEnergyTypeId: row.target_energy_type_id,
    energyTypeCode: energyType?.code || null,
    energyTypeName: energyType?.name || null,
    trainStartMonth: row.train_start_month,
    trainEndMonth: row.train_end_month,
    predictStartMonth: row.predict_start_month,
    predictEndMonth: row.predict_end_month,
    parametersJson: row.parameters_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    note: row.note,
    resultCount,
    parameters
  };
}

/** 将 canonical result projection 映射为 completion witness 的公开持久事实形状。 */
function mapPredictionResultWitnessFact(db, row, runRow) {
  const energyType = db.prepare('SELECT code, name FROM energy_types WHERE id = ?')
    .get(row.energy_type_id) || null;
  return {
    id: row.id,
    predictionRunId: row.prediction_run_id,
    predictionRunName: runRow.name,
    algorithm: runRow.algorithm,
    runStatus: runRow.status,
    energyTypeId: row.energy_type_id,
    energyTypeCode: energyType?.code || null,
    energyTypeName: energyType?.name || null,
    targetMonth: row.target_month,
    predictedValue: row.predicted_value,
    predictedUnit: row.predicted_unit,
    confidenceLow: row.confidence_low,
    confidenceHigh: row.confidence_high,
    methodNote: row.method_note,
    createdAt: row.created_at
  };
}

/** 重读 completed run/results 并验证 witness、分组、单位和参数精确闭包。 */
function readAndValidatePredictionDomainFacts(db, state, witnessFacts, sources) {
  const runCanonical = readCanonicalPredictionProjection(db, 'prediction_run', witnessFacts.run.id);
  const run = runCanonical.row;
  const resultHandler = canonicalOwnershipProtocol.getEntityHandler('prediction_result');
  const resultRows = db.prepare(`SELECT id, prediction_run_id, energy_type_id, target_month,
      predicted_value, predicted_unit, confidence_low, confidence_high, method_note, created_at
    FROM prediction_results WHERE prediction_run_id = ? ORDER BY id`).all(run.id);
  if (!resultHandler || resultRows.length < 1
    || resultRows.length !== witnessFacts.resultCount
    || resultRows.length !== witnessFacts.expectedResultCount
    || resultRows.length !== witnessFacts.results.length) {
    throw createPredictionOwnershipError(
      'PREDICTION_RESULT_SET_MISMATCH',
      'Prediction result 集合与 completion witness 不一致。'
    );
  }
  const runWitnessFact = mapPredictionRunWitnessFact(db, run);
  if (canonicalOwnershipProtocol.sha256Stable(runWitnessFact)
    !== canonicalOwnershipProtocol.sha256Stable(witnessFacts.run)) {
    throw createPredictionOwnershipError(
      'PREDICTION_RUN_WITNESS_MISMATCH',
      'Prediction run 持久事实与 completion witness 不一致。'
    );
  }
  const expectedParameters = {
    algorithm: witnessFacts.algorithm,
    windowSize: witnessFacts.windowSize,
    filters: witnessFacts.normalizedPayload.filters,
    trainMonths: witnessFacts.trainMonths,
    predictionMonths: witnessFacts.predictionMonths,
    requiredHistoryMonths: witnessFacts.normalizedPayload.requiredHistoryMonths,
    configSnapshot: witnessFacts.configSnapshot,
    warnings: witnessFacts.warnings
  };
  if (canonicalOwnershipProtocol.sha256Stable(runWitnessFact.parameters)
      !== canonicalOwnershipProtocol.sha256Stable(expectedParameters)
    || run.status !== 'completed' || witnessFacts.status !== 'completed'
    || run.target_energy_type_id !== sources.config.row.energy_type_id) {
    throw createPredictionOwnershipError(
      'PREDICTION_RUN_FACTS_INVALID',
      'Prediction run 参数、状态或目标能源事实无效。'
    );
  }
  const witnessResultById = new Map(witnessFacts.results.map((result) => [result.id, result]));
  if (witnessResultById.size !== witnessFacts.results.length) {
    throw createPredictionOwnershipError(
      'PREDICTION_RESULT_SET_MISMATCH',
      'Prediction witness result 主键不得重复。'
    );
  }
  const expectedForecastFacts = Array.isArray(witnessFacts.expectedForecastFacts)
    ? witnessFacts.expectedForecastFacts
    : [];
  const expectedForecastKeyOf = (fact) => (
    `${fact.energyTypeId}:${fact.canonicalUnit}:${fact.targetMonth}`
  );
  const expectedForecastByKey = new Map(expectedForecastFacts.map((fact) => [
    expectedForecastKeyOf(fact),
    fact
  ]));
  if (expectedForecastFacts.length !== witnessFacts.expectedResultCount
    || expectedForecastByKey.size !== expectedForecastFacts.length) {
    throw createPredictionOwnershipError(
      'PREDICTION_FORECAST_FACT_SET_INVALID',
      'Prediction 持久化前 forecast facts 必须唯一且完整覆盖预期结果集合。'
    );
  }
  const eligibleGroupByKey = new Map(witnessFacts.eligibleGroups.map((group) => [
    `${group.energyTypeId}:${group.unit}`,
    group
  ]));
  const resultMonthsByGroup = new Map();
  const resultCanonicals = resultRows.map((row) => {
    resultHandler.validateProjectionRow(row);
    const witnessResult = witnessResultById.get(row.id);
    const currentWitnessFact = mapPredictionResultWitnessFact(db, row, run);
    if (!witnessResult || canonicalOwnershipProtocol.sha256Stable(currentWitnessFact)
      !== canonicalOwnershipProtocol.sha256Stable(witnessResult)) {
      throw createPredictionOwnershipError(
        'PREDICTION_RESULT_WITNESS_MISMATCH',
        'Prediction result 持久事实与 completion witness 不一致。',
        { resultId: row.id }
      );
    }
    const standardUnit = db.prepare('SELECT standard_unit AS standardUnit FROM energy_types WHERE id = ?')
      .get(row.energy_type_id)?.standardUnit;
    const groupKey = `${row.energy_type_id}:${row.predicted_unit}`;
    const group = eligibleGroupByKey.get(groupKey);
    if (!group || standardUnit !== row.predicted_unit || group.unit !== row.predicted_unit
      || group.energyTypeCode !== currentWitnessFact.energyTypeCode
      || !witnessFacts.predictionMonths.includes(row.target_month)) {
      throw createPredictionOwnershipError(
        'PREDICTION_RESULT_GROUP_INVALID',
        'Prediction result 能源类型、canonical unit、月份或 eligible group 无效。',
        { resultId: row.id }
      );
    }
    const forecastFact = expectedForecastByKey.get(
      `${row.energy_type_id}:${row.predicted_unit}:${row.target_month}`
    );
    const expectedResultFact = forecastFact ? {
      algorithm: forecastFact.algorithm,
      energyTypeId: forecastFact.energyTypeId,
      energyTypeCode: forecastFact.energyTypeCode,
      canonicalUnit: forecastFact.canonicalUnit,
      targetMonth: forecastFact.targetMonth,
      predictedValue: forecastFact.predictedValue,
      confidenceLow: forecastFact.confidenceLow,
      confidenceHigh: forecastFact.confidenceHigh,
      methodNote: forecastFact.methodNote
    } : null;
    const currentResultFact = {
      algorithm: run.algorithm,
      energyTypeId: row.energy_type_id,
      energyTypeCode: currentWitnessFact.energyTypeCode,
      canonicalUnit: row.predicted_unit,
      targetMonth: row.target_month,
      predictedValue: row.predicted_value,
      confidenceLow: row.confidence_low,
      confidenceHigh: row.confidence_high,
      methodNote: row.method_note
    };
    const algorithmFactsValid = forecastFact
      && forecastFact.algorithm === witnessFacts.algorithm
      && forecastFact.algorithm === run.algorithm
      && forecastFact.energyTypeCode === group.energyTypeCode
      && forecastFact.canonicalUnit === group.unit
      && forecastFact.roundingDigits === 6
      && (forecastFact.algorithm === 'moving_average'
        ? forecastFact.windowSize === witnessFacts.windowSize
          && forecastFact.sampleCount === null
          && forecastFact.signedSlope === null
          && forecastFact.clampedToZero === false
        : forecastFact.windowSize === null
          && forecastFact.sampleCount === group.sampleMonths
          && typeof forecastFact.signedSlope === 'number'
          && Number.isFinite(forecastFact.signedSlope)
          && typeof forecastFact.clampedToZero === 'boolean');
    if (!algorithmFactsValid || canonicalOwnershipProtocol.sha256Stable(currentResultFact)
      !== canonicalOwnershipProtocol.sha256Stable(expectedResultFact)) {
      throw createPredictionOwnershipError(
        'PREDICTION_RESULT_FORECAST_FACT_MISMATCH',
        'Prediction result 未精确绑定持久化前算法、舍入、confidence 与方法事实。',
        { resultId: row.id }
      );
    }
    const months = resultMonthsByGroup.get(groupKey) || [];
    months.push(row.target_month);
    resultMonthsByGroup.set(groupKey, months);
    return {
      row,
      contract: canonicalOwnershipProtocol.buildEntityRegistrationContract({
        entityType: 'prediction_result',
        entityPk: row.id,
        row
      })
    };
  });
  witnessFacts.eligibleGroups.forEach((group) => {
    const months = resultMonthsByGroup.get(`${group.energyTypeId}:${group.unit}`) || [];
    if (months.length !== group.resultCount
      || canonicalOwnershipProtocol.sha256Stable([...months].sort())
        !== canonicalOwnershipProtocol.sha256Stable([...witnessFacts.predictionMonths].sort())) {
      throw createPredictionOwnershipError(
        'PREDICTION_RESULT_GROUP_CLOSURE_INVALID',
        'Prediction result 未完整且唯一覆盖 eligible group 的预测月份。'
      );
    }
  });
  witnessFacts.skippedGroups.forEach((group) => {
    if (resultMonthsByGroup.has(group.groupKey)) {
      throw createPredictionOwnershipError(
        'PREDICTION_SKIPPED_GROUP_RESULT_INVALID',
        'Prediction skipped group 不得产生 result。'
      );
    }
  });
  const groupedTrainingIds = witnessFacts.groups.flatMap((group) => (
    group.trainingRecords.map((record) => record.id)
  )).sort((left, right) => left - right);
  const exactTrainingIds = witnessFacts.exactTrainingRecords.map((record) => record.id)
    .sort((left, right) => left - right);
  if (canonicalOwnershipProtocol.sha256Stable(groupedTrainingIds)
      !== canonicalOwnershipProtocol.sha256Stable(exactTrainingIds)
    || new Set(groupedTrainingIds).size !== groupedTrainingIds.length) {
    throw createPredictionOwnershipError(
      'PREDICTION_TRAINING_LINEAGE_CLOSURE_INVALID',
      'Prediction groups 必须精确覆盖全部 actual training records。'
    );
  }
  return { run, runContract: runCanonical.contract, resultRows, resultCanonicals };
}

/** 构造 derived registry canonical 实体键。 */
function buildPredictionDerivedEntityKey(entityType, entityPk) {
  return canonicalOwnershipProtocol.sha256Stable([String(entityType), String(entityPk)]);
}

/** 查询当前 run + Artifact 12 的全部 active Prediction derived registry。 */
function readActivePredictionDerivedRegistryFacts(db, runId) {
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
    ORDER BY entity_type, CAST(entity_pk AS INTEGER), registry_id`).all(
    runId,
    PREDICTION_DERIVED_ARTIFACT_KEY
  );
}

/** 构造 registrar 预期的完整 derived registry 事实。 */
function buildExpectedPredictionRegistryFact(registryId, state, registration, registeredAt) {
  return {
    registryId: Number(registryId),
    runId: state.demoRun.runId,
    artifactKey: PREDICTION_DERIVED_ARTIFACT_KEY,
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

/** 登记单个 Prediction derived entity，任何既有 active ownership 都视为冲突。 */
function insertPredictionDerivedRegistry(db, state, registration, registeredAt) {
  if (readActivePredictionRegistry(db, registration.entityType, registration.entityPk)) {
    throw createPredictionOwnershipError(
      'PREDICTION_DERIVED_REGISTRY_CONFLICT',
      'Prediction 派生实体已存在 active ownership。',
      { entityType: registration.entityType, entityPk: registration.entityPk }
    );
  }
  const inserted = db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number,
     registered_by, registered_at)
    VALUES (?, ?, ?, ?, 'derived', ?, ?, NULL, NULL, ?, ?)`).run(
    state.demoRun.runId,
    PREDICTION_DERIVED_ARTIFACT_KEY,
    registration.entityType,
    registration.entityPk,
    registration.identityDigest,
    registration.snapshotDigest,
    state.actor.userId,
    registeredAt
  );
  return buildExpectedPredictionRegistryFact(
    Number(inserted.lastInsertRowid),
    state,
    registration,
    registeredAt
  );
}

/** 双向校验 Prediction derived registry 数量、实体键和完整事实。 */
function requirePredictionDerivedRegistryClosure(db, state, expectedKeys, expectedFacts, code) {
  const actualFacts = readActivePredictionDerivedRegistryFacts(db, state.demoRun.runId);
  const keyOf = (item) => buildPredictionDerivedEntityKey(item.entityType, item.entityPk);
  const expectedKeyValues = expectedKeys.map(keyOf);
  const expectedFactKeys = expectedFacts.map(keyOf);
  const actualKeys = actualFacts.map(keyOf);
  const sorted = (items) => [...items].sort();
  if (new Set(expectedKeyValues).size !== expectedKeyValues.length
    || new Set(expectedFactKeys).size !== expectedFactKeys.length
    || new Set(actualKeys).size !== actualKeys.length
    || expectedKeys.length !== expectedFacts.length || expectedKeys.length !== actualFacts.length
    || canonicalOwnershipProtocol.sha256Stable(sorted(expectedKeyValues))
      !== canonicalOwnershipProtocol.sha256Stable(sorted(expectedFactKeys))
    || canonicalOwnershipProtocol.sha256Stable(sorted(expectedKeyValues))
      !== canonicalOwnershipProtocol.sha256Stable(sorted(actualKeys))) {
    throw createPredictionOwnershipError(
      code,
      'Prediction active derived registry 实体键或数量不符合 exact closure。'
    );
  }
  const expectedByKey = new Map(expectedFacts.map((fact) => [keyOf(fact), fact]));
  const actualByKey = new Map(actualFacts.map((fact) => [keyOf(fact), fact]));
  const orderedExpected = expectedKeyValues.map((key) => expectedByKey.get(key));
  const orderedActual = expectedKeyValues.map((key) => actualByKey.get(key));
  if (orderedExpected.some((fact) => !fact) || orderedActual.some((fact) => !fact)
    || canonicalOwnershipProtocol.sha256Stable(orderedExpected)
      !== canonicalOwnershipProtocol.sha256Stable(orderedActual)) {
    throw createPredictionOwnershipError(
      code,
      'Prediction active derived registry 完整事实与 canonical contract 不一致。'
    );
  }
  return orderedActual;
}

/** 插入一个固定 run-level relation 并返回完整预期事实。 */
function insertPredictionRelation(db, state, intent, createdAt) {
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

/** 查询所有 Prediction derived 端点关系并验证精确 relation closure。 */
function requirePredictionRelationClosure(db, derivedRegistryIds, expectedFacts, code) {
  const placeholders = derivedRegistryIds.map(() => '?').join(', ');
  const actualFacts = db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType, created_at AS createdAt
    FROM demo_data_relations
    WHERE from_registry_id IN (${placeholders}) OR to_registry_id IN (${placeholders})
    ORDER BY relation_id`).all(...derivedRegistryIds, ...derivedRegistryIds);
  const normalizedExpected = [...expectedFacts]
    .sort((left, right) => left.relationId - right.relationId);
  if (actualFacts.length !== normalizedExpected.length
    || canonicalOwnershipProtocol.sha256Stable(actualFacts)
      !== canonicalOwnershipProtocol.sha256Stable(normalizedExpected)) {
    throw createPredictionOwnershipError(
      code,
      'Prediction relation 精确闭包已缺失、增加、反向或改写。'
    );
  }
  return actualFacts;
}

/** 在任何 registrar SQL 前验证原始 scope 对象身份和生命周期状态。 */
function requirePredictionRegistrationScopeState(input, allowedStatuses) {
  const scope = input.registrationScope;
  const state = scope && typeof scope === 'object' && !utilTypes.isProxy(scope)
    ? PREDICTION_REGISTRATION_SCOPE_STATE.get(scope)
    : null;
  if (!state) {
    poisonPredictionExactInvocation(input);
    throw createPredictionOwnershipError(
      'PREDICTION_REGISTRATION_SCOPE_REQUIRED',
      'Prediction ownership 必须使用正式签发的原始 registration scope。',
      null,
      400
    );
  }
  if (!allowedStatuses.includes(state.status)) {
    poisonPredictionExactScope(state);
    throw createPredictionOwnershipError(
      state.status === 'consumed'
        ? 'PREDICTION_REGISTRATION_SCOPE_REPLAY'
        : 'PREDICTION_REGISTRATION_SCOPE_INVALID',
      'Prediction registration scope 已消费、失效或处于错误阶段。'
    );
  }
  if (input.registrarAuthority !== state.registrarAuthority
    || input.db !== state.db || input.transactionScope !== state.transactionScope
    || input.completionWitness !== state.completionWitness
    || input.definitionCapability !== state.definitionCapability
    || input.demoRun !== state.demoRunIdentity || input.actionRun !== state.actionRunIdentity
    || input.actor !== state.actorIdentity) {
    poisonPredictionOwnershipBinding(
      state,
      state.db,
      'PREDICTION_REGISTRATION_SCOPE_BINDING_MISMATCH',
      'Prediction registration scope 与 authority、DB、scope、witness 或身份对象不一致。'
    );
  }
  return state;
}

/** 对 scope 当前身份投影做稳定校验；漂移即完整回滚并 poison。 */
function assertPredictionScopeBindingsStableOrPoison(input, state, code) {
  try {
    assertPredictionOwnershipProjectionStable(
      input.demoRun,
      state.demoRun,
      PREDICTION_DEMO_RUN_FIELDS,
      code,
      'Prediction demo run caller 投影已漂移。'
    );
    assertPredictionOwnershipProjectionStable(
      input.actionRun,
      state.actionRun,
      PREDICTION_ACTION_RUN_FIELDS,
      code,
      'Prediction action run caller 投影已漂移。'
    );
    assertPredictionOwnershipProjectionStable(
      input.actor,
      state.actor,
      PREDICTION_ACTOR_FIELDS,
      code,
      'Prediction actor caller 投影已漂移。'
    );
  } catch (error) {
    poisonPredictionOwnershipBinding(
      state,
      state.db,
      code,
      'Prediction ownership 身份对象在 scope 生命周期内发生漂移。',
      error
    );
  }
}

/** 签发绑定 P3 completion witness、caller transaction 和身份对象的一次性 scope。 */
function issuePredictionRegistrationScopeInCallerTransaction(input = {}) {
  try {
    assertPredictionOwnershipProtocolFields(
      input,
      ['registrarAuthority', ...PREDICTION_BINDING_FIELDS],
      'PREDICTION_REGISTRATION_SCOPE_INPUT_INVALID',
      'Prediction registration scope 只能接收固定私有协议字段。'
    );
    // definition capability 必须先由 adapter execute 阶段验证，再由 P4 一次性消费。
    verifyDefinitionCapability({
      capability: input.definitionCapability,
      db: input.db,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor
    });
    const db = assertPredictionOwnershipDatabase(input.db);
    assertPredictionInvocationObjects(input);
    const witnessInput = {
      db,
      transactionScope: input.transactionScope,
      completionWitness: input.completionWitness,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor
    };
    const witnessFacts = predictionExactProtocol.readCompletionWitness(witnessInput);
    if (predictionP4CompletionProtocol.bindCompletionWitness(witnessInput) !== witnessFacts) {
      throw createPredictionOwnershipError(
        'PREDICTION_COMPLETION_WITNESS_BINDING_MISMATCH',
        'Prediction completion witness 无法绑定 P4 verifier。'
      );
    }
    const demoRun = requirePersistedPredictionDemoRun(
      db,
      input.demoRun,
      'PREDICTION_REGISTRATION_DEMO_RUN_MISMATCH'
    );
    requirePersistedPredictionActionRun(db, input.actionRun, demoRun, input.actor);
    const transactionMarkerSavepoint = createPredictionOwnershipSavepointName('scope_marker');
    db.exec(`SAVEPOINT ${transactionMarkerSavepoint}`);
    const registrationScope = Object.freeze({});
    PREDICTION_REGISTRATION_SCOPE_STATE.set(registrationScope, {
      registrarAuthority: input.registrarAuthority,
      db,
      transactionScope: input.transactionScope,
      completionWitness: input.completionWitness,
      definitionCapability: input.definitionCapability,
      demoRun: createFrozenPredictionOwnershipProjection(demoRun, PREDICTION_DEMO_RUN_FIELDS),
      demoRunIdentity: input.demoRun,
      actionRun: createFrozenPredictionOwnershipProjection(input.actionRun, PREDICTION_ACTION_RUN_FIELDS),
      actionRunIdentity: input.actionRun,
      actor: createFrozenPredictionOwnershipProjection(input.actor, PREDICTION_ACTOR_FIELDS),
      actorIdentity: input.actor,
      witnessFacts,
      witnessDigest: canonicalOwnershipProtocol.sha256Stable(witnessFacts),
      transactionMarkerSavepoint,
      receiptIssued: false,
      status: 'issued'
    });
    return registrationScope;
  } catch (error) {
    poisonPredictionExactInvocation(input);
    throw error;
  }
}

/** 登记 run、全部 results 及固定 run-level lineage，并返回 opaque one-shot receipt。 */
function registerPredictionDerivedOwnershipInCallerTransaction(input = {}) {
  assertPredictionOwnershipProtocolFields(
    input,
    ['registrarAuthority', ...PREDICTION_SCOPE_FIELDS],
    'PREDICTION_REGISTRAR_INPUT_INVALID',
    'Prediction registrar 只能接收固定私有协议字段。'
  );
  const state = requirePredictionRegistrationScopeState(input, ['issued']);
  const db = assertPredictionOwnershipDatabase(input.db);
  state.status = 'claiming';
  let recoverySavepoint = null;
  let recoverySavepointActive = false;
  try {
    // 先通过私有 authority 释放 transaction marker，再立即建立 registrar 恢复边界。
    releasePredictionOwnershipSavepoint(
      state,
      state.transactionMarkerSavepoint
    );
    recoverySavepoint = createPredictionOwnershipSavepointName('registrar_recovery');
    db.exec(`SAVEPOINT ${recoverySavepoint}`);
    recoverySavepointActive = true;
  } catch (error) {
    poisonPredictionOwnershipBinding(
      state,
      db,
      'PREDICTION_REGISTRATION_TRANSACTION_MISMATCH',
      'Prediction registration scope 不属于原 caller transaction。',
      error
    );
  }

  try {
    assertPredictionScopeBindingsStableOrPoison(
      input,
      state,
      'PREDICTION_REGISTRATION_IDENTITY_STALE'
    );
    requirePersistedPredictionDemoRun(
      db,
      state.demoRun,
      'PREDICTION_REGISTRATION_DEMO_RUN_STALE'
    );
    requirePersistedPredictionActionRun(db, state.actionRun, state.demoRun, state.actor);
    const witnessFacts = state.witnessFacts;
    if (canonicalOwnershipProtocol.sha256Stable(witnessFacts) !== state.witnessDigest) {
      throw createPredictionOwnershipError(
        'PREDICTION_COMPLETION_WITNESS_DRIFT',
        'Prediction completion witness 在 registration scope 生命周期内发生漂移。'
      );
    }
    state.status = 'registering';

    const sources = requirePredictionExactImportedSources(db, state, witnessFacts);
    const domain = readAndValidatePredictionDomainFacts(db, state, witnessFacts, sources);
    const expectedEntityKeys = [
      { entityType: domain.runContract.entityType, entityPk: domain.runContract.entityPk },
      ...domain.resultCanonicals.map((item) => ({
        entityType: item.contract.entityType,
        entityPk: item.contract.entityPk
      }))
    ];
    const registeredAt = new Date().toISOString();
    const registryIntents = [
      insertPredictionDerivedRegistry(db, state, domain.runContract, registeredAt),
      ...domain.resultCanonicals.map((item) => (
        insertPredictionDerivedRegistry(db, state, item.contract, registeredAt)
      ))
    ];
    let registryFacts = requirePredictionDerivedRegistryClosure(
      db,
      state,
      expectedEntityKeys,
      registryIntents,
      'PREDICTION_REGISTRY_CLOSURE_MISMATCH'
    );
    const derivedByEntity = new Map(registryFacts.map((fact) => (
      [`${fact.entityType}:${fact.entityPk}`, fact]
    )));
    const runRegistry = derivedByEntity.get(`prediction_run:${domain.run.id}`);
    const configRegistry = sources.config.registry;
    const energyRegistryById = new Map(sources.records.map((source) => (
      [source.row.id, source.registry]
    )));
    const relationIntents = [
      ...domain.resultRows.map((row) => ({
        fromRegistryId: runRegistry.registryId,
        toRegistryId: derivedByEntity.get(`prediction_result:${row.id}`).registryId,
        relationType: 'contains'
      })),
      {
        fromRegistryId: runRegistry.registryId,
        toRegistryId: configRegistry.registryId,
        relationType: 'uses_config'
      },
      ...witnessFacts.exactTrainingRecords.map((record) => ({
        fromRegistryId: runRegistry.registryId,
        toRegistryId: energyRegistryById.get(record.id).registryId,
        relationType: 'generated_from'
      }))
    ];
    const relationCreatedAt = new Date().toISOString();
    const relationFacts = relationIntents.map((intent) => (
      insertPredictionRelation(db, state, intent, relationCreatedAt)
    ));
    registryFacts = requirePredictionDerivedRegistryClosure(
      db,
      state,
      expectedEntityKeys,
      registryIntents,
      'PREDICTION_REGISTRY_CLOSURE_MISMATCH'
    );
    const derivedRegistryIds = registryFacts.map((fact) => fact.registryId);
    requirePredictionRelationClosure(
      db,
      derivedRegistryIds,
      relationFacts,
      'PREDICTION_RELATION_CLOSURE_MISMATCH'
    );

    const receiptMarkerSavepoint = createPredictionOwnershipSavepointName('receipt_marker');
    db.exec(`SAVEPOINT ${receiptMarkerSavepoint}`);
    const registrationReceipt = Object.freeze({});
    PREDICTION_REGISTRATION_RECEIPT_STATE.set(registrationReceipt, {
      registrarAuthority: state.registrarAuthority,
      db,
      transactionScope: state.transactionScope,
      completionWitness: state.completionWitness,
      definitionCapability: state.definitionCapability,
      registrationScope: input.registrationScope,
      demoRun: state.demoRun,
      actionRun: state.actionRun,
      actor: state.actor,
      witnessDigest: state.witnessDigest,
      expectedEntityKeys: freezePredictionOwnershipSnapshot(expectedEntityKeys),
      registryFacts: freezePredictionOwnershipSnapshot(registryFacts),
      relationFacts: freezePredictionOwnershipSnapshot(relationFacts),
      registryDigest: canonicalOwnershipProtocol.sha256Stable(registryFacts),
      relationDigest: canonicalOwnershipProtocol.sha256Stable(relationFacts),
      sourceDigest: canonicalOwnershipProtocol.sha256Stable({
        configRegistry: sources.config.registry,
        energyRegistries: sources.records.map((source) => source.registry),
        managedClosure: sources.managedClosure
      }),
      domainDigest: canonicalOwnershipProtocol.sha256Stable({
        run: domain.run,
        results: domain.resultRows
      }),
      totalChangesAtIssue: readPredictionOwnershipTotalChanges(state),
      recoverySavepoint,
      receiptMarkerSavepoint,
      status: 'issued'
    });
    state.receiptIssued = true;
    state.status = 'registered';
    recoverySavepointActive = false;
    return registrationReceipt;
  } catch (error) {
    state.status = 'failed';
    if (recoverySavepointActive) {
      const recovery = db.inTransaction === true
        ? recoverPredictionOwnershipSavepoint(state, recoverySavepoint)
        : {
            rollbackError: createPredictionOwnershipError(
              'PREDICTION_REGISTRAR_TRANSACTION_MISMATCH',
              'Prediction registrar 已离开 caller transaction。'
            ),
            releaseError: null,
            ...failClosedPredictionOwnershipTransaction(db)
          };
      if (recovery.rollbackError || recovery.releaseError
        || recovery.fullRollbackError || recovery.closeError) {
        throw createPredictionOwnershipRecoveryError(
          'PREDICTION_REGISTRAR_RECOVERY_FAILED',
          'Prediction registrar 私有 SAVEPOINT 恢复失败。',
          error,
          recovery
        );
      }
    }
    if (!poisonPredictionExactScope(state)) {
      const failClosed = failClosedPredictionOwnershipTransaction(db);
      if (failClosed.fullRollbackError || failClosed.closeError) {
        throw createPredictionOwnershipRecoveryError(
          'PREDICTION_REGISTRAR_POISON_FAILED',
          'Prediction registrar 失败后无法污染 exact scope。',
          error,
          { rollbackError: null, releaseError: null, ...failClosed }
        );
      }
    }
    throw error;
  }
}

/** 一次性验证 receipt 的 source/domain/registry/relation closure 后释放恢复边界。 */
function verifyPredictionRegistrationReceiptInCallerTransaction(input = {}) {
  assertPredictionOwnershipProtocolFields(
    input,
    ['registrarAuthority', ...PREDICTION_RECEIPT_FIELDS],
    'PREDICTION_RECEIPT_INPUT_INVALID',
    'Prediction receipt verifier 只能接收固定私有协议字段。'
  );
  const receipt = input.registrationReceipt;
  const receiptFacts = receipt && typeof receipt === 'object' && !utilTypes.isProxy(receipt)
    ? PREDICTION_REGISTRATION_RECEIPT_STATE.get(receipt)
    : null;
  if (!receiptFacts) {
    poisonPredictionExactInvocation(input);
    throw createPredictionOwnershipError(
      'PREDICTION_RECEIPT_REQUIRED',
      'Prediction ownership 必须使用 registrar 返回的原始 receipt。',
      null,
      400
    );
  }
  if (PREDICTION_REGISTRATION_RECEIPT_CONSUMED.has(receipt)
    || receiptFacts.status !== 'issued') {
    const replayState = PREDICTION_REGISTRATION_SCOPE_STATE.get(
      receiptFacts.registrationScope
    );
    poisonPredictionExactScope(replayState);
    throw createPredictionOwnershipError(
      'PREDICTION_RECEIPT_REPLAY',
      'Prediction registrar receipt 已消费或失效。'
    );
  }
  const state = requirePredictionRegistrationScopeState(input, ['registered']);
  const db = assertPredictionOwnershipDatabase(input.db);
  assertPredictionScopeBindingsStableOrPoison(
    input,
    state,
    'PREDICTION_RECEIPT_BINDING_MISMATCH'
  );
  if (input.registrarAuthority !== receiptFacts.registrarAuthority
    || input.db !== receiptFacts.db || input.transactionScope !== receiptFacts.transactionScope
    || input.completionWitness !== receiptFacts.completionWitness
    || input.definitionCapability !== receiptFacts.definitionCapability
    || input.registrationScope !== receiptFacts.registrationScope) {
    poisonPredictionOwnershipBinding(
      state,
      db,
      'PREDICTION_RECEIPT_BINDING_MISMATCH',
      'Prediction receipt 与 DB、scope 或 witness 对象身份不一致。'
    );
  }
  receiptFacts.status = 'verifying';
  let recoverySavepointActive = true;
  try {
    // 第一条 SQL 仅经私有 authority 释放 receipt marker，跨事务/re-BEGIN 验证必须在事实读取前失败。
    releasePredictionOwnershipSavepoint(
      state,
      receiptFacts.receiptMarkerSavepoint
    );
  } catch (error) {
    receiptFacts.status = 'failed';
    poisonPredictionOwnershipBinding(
      state,
      db,
      'PREDICTION_RECEIPT_TRANSACTION_MISMATCH',
      'Prediction receipt 不属于原 caller transaction。',
      error
    );
  }

  try {
    if (readPredictionOwnershipTotalChanges(state) !== receiptFacts.totalChangesAtIssue) {
      throw createPredictionOwnershipError(
        'PREDICTION_RECEIPT_WRITE_GENERATION_MISMATCH',
        'Prediction receipt 签发后的 SQLite 写入代次已变化。'
      );
    }
    requirePersistedPredictionDemoRun(
      db,
      state.demoRun,
      'PREDICTION_RECEIPT_DEMO_RUN_STALE'
    );
    requirePersistedPredictionActionRun(db, state.actionRun, state.demoRun, state.actor);
    const sources = requirePredictionExactImportedSources(db, state, state.witnessFacts);
    const domain = readAndValidatePredictionDomainFacts(
      db,
      state,
      state.witnessFacts,
      sources
    );
    const currentSourceDigest = canonicalOwnershipProtocol.sha256Stable({
      configRegistry: sources.config.registry,
      energyRegistries: sources.records.map((source) => source.registry),
      managedClosure: sources.managedClosure
    });
    const currentDomainDigest = canonicalOwnershipProtocol.sha256Stable({
      run: domain.run,
      results: domain.resultRows
    });
    if (state.witnessDigest !== receiptFacts.witnessDigest
      || currentSourceDigest !== receiptFacts.sourceDigest
      || currentDomainDigest !== receiptFacts.domainDigest) {
      throw createPredictionOwnershipError(
        'PREDICTION_RECEIPT_SOURCE_DOMAIN_MISMATCH',
        'Prediction receipt 绑定的 source 或 domain closure 已漂移。'
      );
    }
    const registryFacts = requirePredictionDerivedRegistryClosure(
      db,
      state,
      receiptFacts.expectedEntityKeys,
      receiptFacts.registryFacts,
      'PREDICTION_RECEIPT_REGISTRY_MISMATCH'
    );
    const derivedRegistryIds = registryFacts.map((fact) => fact.registryId);
    const relationFacts = requirePredictionRelationClosure(
      db,
      derivedRegistryIds,
      receiptFacts.relationFacts,
      'PREDICTION_RECEIPT_RELATION_MISMATCH'
    );
    if (canonicalOwnershipProtocol.sha256Stable(registryFacts) !== receiptFacts.registryDigest
      || canonicalOwnershipProtocol.sha256Stable(relationFacts) !== receiptFacts.relationDigest) {
      throw createPredictionOwnershipError(
        'PREDICTION_RECEIPT_FACT_MISMATCH',
        'Prediction receipt registry 或 relation 事实已改写。'
      );
    }
    releasePredictionOwnershipSavepoint(
      state,
      receiptFacts.recoverySavepoint
    );
    recoverySavepointActive = false;
    const consumedWitnessFacts = predictionP4CompletionProtocol.consumeCompletionWitness({
      db,
      transactionScope: input.transactionScope,
      completionWitness: input.completionWitness,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor
    });
    if (consumedWitnessFacts !== state.witnessFacts
      || canonicalOwnershipProtocol.sha256Stable(consumedWitnessFacts) !== state.witnessDigest) {
      throw createPredictionOwnershipError(
        'PREDICTION_COMPLETION_WITNESS_DRIFT',
        'Prediction completion witness 在 receipt verifier 终结阶段发生漂移。'
      );
    }
    receiptFacts.status = 'consumed';
    PREDICTION_REGISTRATION_RECEIPT_CONSUMED.add(receipt);
    state.status = 'consumed';
    return true;
  } catch (error) {
    receiptFacts.status = 'failed';
    state.status = 'failed';
    const recovery = recoverySavepointActive && db.inTransaction === true
      ? recoverPredictionOwnershipSavepoint(state, receiptFacts.recoverySavepoint)
      : recoverySavepointActive
        ? {
            rollbackError: createPredictionOwnershipError(
              'PREDICTION_RECEIPT_TRANSACTION_MISMATCH',
              'Prediction receipt 已离开原 caller transaction。'
            ),
            releaseError: null,
            ...failClosedPredictionOwnershipTransaction(db)
          }
        : { rollbackError: null, releaseError: null, fullRollbackError: null, closeError: null };
    if (recovery.rollbackError || recovery.releaseError
      || recovery.fullRollbackError || recovery.closeError) {
      throw createPredictionOwnershipRecoveryError(
        'PREDICTION_RECEIPT_RECOVERY_FAILED',
        'Prediction receipt 私有 SAVEPOINT 恢复失败。',
        error,
        recovery
      );
    }
    if (!poisonPredictionExactScope(state)) {
      const failClosed = failClosedPredictionOwnershipTransaction(db);
      if (failClosed.fullRollbackError || failClosed.closeError) {
        throw createPredictionOwnershipRecoveryError(
          'PREDICTION_RECEIPT_POISON_FAILED',
          'Prediction receipt 失败后无法污染 exact scope。',
          error,
          { rollbackError: null, releaseError: null, ...failClosed }
        );
      }
    }
    throw error;
  }
}

/** 终止尚未登记的 scope；receipt 产生后必须由 verifier 完成，不提供普通 abort。 */
function abortPredictionRegistrationScopeInCallerTransaction(input = {}) {
  assertPredictionOwnershipProtocolFields(
    input,
    ['registrarAuthority', ...PREDICTION_SCOPE_FIELDS],
    'PREDICTION_REGISTRATION_ABORT_INPUT_INVALID',
    'Prediction registration abort 只能接收固定私有协议字段。'
  );
  const state = requirePredictionRegistrationScopeState(input, ['issued', 'failed', 'registered']);
  const db = assertPredictionOwnershipDatabase(input.db);
  if (state.receiptIssued || state.status === 'registered') {
    poisonPredictionExactScope(state);
    throw createPredictionOwnershipError(
      'PREDICTION_REGISTRATION_ABORT_RECEIPT_REQUIRED',
      'Prediction receipt 产生后不允许绕过 verifier abort。'
    );
  }
  if (state.status === 'issued') {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${state.transactionMarkerSavepoint}`);
      releasePredictionOwnershipSavepoint(
        state,
        state.transactionMarkerSavepoint
      );
    } catch (error) {
      const failClosed = failClosedPredictionOwnershipTransaction(db);
      throw createPredictionOwnershipRecoveryError(
        'PREDICTION_REGISTRATION_ABORT_RECOVERY_FAILED',
        'Prediction registration abort 恢复失败。',
        error,
        { rollbackError: error, releaseError: null, ...failClosed }
      );
    }
  }
  state.status = 'failed';
  return true;
}

/** 内部 wrapper 固定注入闭包 authority，caller 无法自造 registrar authority。 */
function callWithPredictionRegistrarAuthority(handler, input, expectedFields) {
  try {
    assertPredictionOwnershipProtocolFields(
      input,
      expectedFields,
      'PREDICTION_OWNERSHIP_INTERNAL_INPUT_INVALID',
      'Prediction ownership 内部协议字段无效。'
    );
  } catch (error) {
    poisonPredictionExactInvocation(input);
    throw error;
  }
  return handler({ registrarAuthority: PREDICTION_REGISTRAR_AUTHORITY, ...input });
}

  return Object.freeze({
    issueRegistrationScopeInCallerTransaction: (input) => (
      callWithPredictionRegistrarAuthority(
        issuePredictionRegistrationScopeInCallerTransaction,
        input,
        PREDICTION_BINDING_FIELDS
      )
    ),
    registerDerivedOwnershipInCallerTransaction: (input) => (
      callWithPredictionRegistrarAuthority(
        registerPredictionDerivedOwnershipInCallerTransaction,
        input,
        PREDICTION_SCOPE_FIELDS
      )
    ),
    verifyRegistrationReceiptInCallerTransaction: (input) => (
      callWithPredictionRegistrarAuthority(
        verifyPredictionRegistrationReceiptInCallerTransaction,
        input,
        PREDICTION_RECEIPT_FIELDS
      )
    ),
    abortRegistrationScopeInCallerTransaction: (input) => (
      callWithPredictionRegistrarAuthority(
        abortPredictionRegistrationScopeInCallerTransaction,
        input,
        PREDICTION_SCOPE_FIELDS
      )
    )
  });
}

Object.defineProperty(module, 'exports', {
  value: createPredictionPostActionProtocol,
  enumerable: false,
  writable: false,
  configurable: false
});
