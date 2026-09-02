'use strict';

const { types: utilTypes } = require('util');
const { AppError } = require('../utils/errors');
const { requireDemoDatasetRun } = require('./demoRunService');
const { stableDigest } = require('./demoPostActionServicePrimitives');
const demoOwnershipService = require('./demoOwnershipService');
const predictionService = require('./predictionService');
const {
  buildPredictionConfidenceFacts,
  isPredictionRoundedValue
} = require('./predictionUtils');

// P3、P4 与 canonical ownership 能力只在初始化期通过非枚举 Symbol 捕获。
const PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.prediction.exactInternal.v1');
const DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
const predictionExactProtocol = predictionService[PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL];
const predictionCanonicalProtocol =
  demoOwnershipService[DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL];

/** 创建绑定指定 stage verifier 与 P4 instance 的隔离 Prediction adapter。 */
function createDemoPostActionPredictionAdapter(options = {}) {
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
    || !optionDescriptors.predictionRegistrationProtocol
    || optionDescriptors.verifyDefinitionCapability.enumerable !== true
    || optionDescriptors.predictionRegistrationProtocol.enumerable !== true
    || typeof optionDescriptors.verifyDefinitionCapability.get === 'function'
    || typeof optionDescriptors.verifyDefinitionCapability.set === 'function'
    || typeof optionDescriptors.verifyDefinitionCapability.value !== 'function'
    || typeof optionDescriptors.predictionRegistrationProtocol.get === 'function'
    || typeof optionDescriptors.predictionRegistrationProtocol.set === 'function') {
    const initializationError = new Error('Prediction adapter factory 构造参数无效。');
    initializationError.code = 'DEMO_PREDICTION_ADAPTER_FACTORY_INPUT_INVALID';
    throw initializationError;
  }
  const verifyDefinitionCapability = optionDescriptors.verifyDefinitionCapability.value;
  const predictionRegistrationProtocol =
    optionDescriptors.predictionRegistrationProtocol.value;
  if (!predictionExactProtocol
    || typeof predictionExactProtocol.withCallerTransactionScope !== 'function'
    || typeof predictionExactProtocol.inspectExact !== 'function'
    || typeof predictionExactProtocol.executeExact !== 'function'
    || !predictionRegistrationProtocol
    || typeof predictionRegistrationProtocol !== 'object'
    || utilTypes.isProxy(predictionRegistrationProtocol)
    || typeof predictionRegistrationProtocol.issueRegistrationScopeInCallerTransaction !== 'function'
    || typeof predictionRegistrationProtocol.registerDerivedOwnershipInCallerTransaction !== 'function'
    || typeof predictionRegistrationProtocol.verifyRegistrationReceiptInCallerTransaction !== 'function'
    || typeof predictionRegistrationProtocol.abortRegistrationScopeInCallerTransaction !== 'function'
    || !predictionCanonicalProtocol
    || typeof predictionCanonicalProtocol.verifyManagedImportedSourceExactClosure !== 'function') {
    const initializationError = new Error('Prediction post-action 私有协议未完成初始化。');
    initializationError.code = 'DEMO_PREDICTION_PRIVATE_PROTOCOL_UNAVAILABLE';
    throw initializationError;
  }

  // 初始化完成后只调用以下闭包引用，不在运行期动态查找普通 exports。
  const capturedPredictionHandlers = Object.freeze({
    withExactScope: predictionExactProtocol.withCallerTransactionScope,
    inspectExact: predictionExactProtocol.inspectExact,
    executeExact: predictionExactProtocol.executeExact,
    issueRegistration:
      predictionRegistrationProtocol.issueRegistrationScopeInCallerTransaction,
    registerDerived:
      predictionRegistrationProtocol.registerDerivedOwnershipInCallerTransaction,
    verifyReceipt:
      predictionRegistrationProtocol.verifyRegistrationReceiptInCallerTransaction,
    abortRegistration:
      predictionRegistrationProtocol.abortRegistrationScopeInCallerTransaction,
    verifyManagedClosure:
      predictionCanonicalProtocol.verifyManagedImportedSourceExactClosure
  });

// Prediction staged adapter 固定使用 Artifact 07/12 与最终 v1 执行身份。
const PREDICTION_ENERGY_ARTIFACT_KEY = '07-monthly-energy';
const PREDICTION_CONFIG_ARTIFACT_KEY = '12-prediction-configs';
const PREDICTION_ACTION_KEY = 'prediction-run';
const PREDICTION_RESOLVER_VERSION = 'prediction-resolver:v1';
const PREDICTION_EXECUTOR_VERSION = 'prediction-executor:v1';
const PREDICTION_PUBLIC_PROJECTION_VERSION = 1;
const PREDICTION_COMPLETED_STATUS = 'completed';
const PREDICTION_ALGORITHMS = Object.freeze(new Set([
  'moving_average',
  'linear_trend'
]));
// 当前能耗导入 canonicalization 的稳定标准单位集合。
const PREDICTION_CANONICAL_UNITS = Object.freeze(new Set([
  'kWh',
  'm3',
  'L',
  't',
  'MJ'
]));
const PREDICTION_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PREDICTION_ENERGY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PREDICTION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
// Revalidate 返回的私有执行上下文只通过原对象身份绑定已验证 capability，不进入任何摘要或 JSON。
const PREDICTION_PRIVATE_CONTEXT_CAPABILITY_STATES = new WeakMap();
const PREDICTION_ACTOR_FIELDS = Object.freeze([
  'userId', 'username', 'displayName', 'ip'
]);

// 公共字段集合使用 exact schema，任何未知或附加字段都使整个投影不可用。
const PREDICTION_PUBLIC_INPUT_FIELDS = Object.freeze([
  'algorithm',
  'windowSize',
  'trainingMonthStart',
  'trainingMonthEnd',
  'predictionMonthStart',
  'predictionMonthEnd',
  'trainingRecordCount',
  'trainingMonthCount',
  'trainingGroupCount',
  'eligibleTrainingRecordCount',
  'minimumEligibleTrainingMonthCount',
  'eligibleGroupCount',
  'skippedGroupCount',
  'expectedResultCount'
]);
const PREDICTION_PUBLIC_RUN_FIELDS = Object.freeze([
  ...PREDICTION_PUBLIC_INPUT_FIELDS,
  'resultCount',
  'outputCount',
  'status'
]);
const PREDICTION_PUBLIC_RESULT_FIELDS = Object.freeze([
  ...PREDICTION_PUBLIC_RUN_FIELDS,
  'results'
]);
const PREDICTION_PUBLIC_RESULT_ITEM_FIELDS = Object.freeze([
  'energyTypeCode',
  'canonicalUnit',
  'targetMonth',
  'predictedValue',
  'confidenceLow',
  'confidenceHigh',
  'method'
]);
const PREDICTION_PERSISTED_INPUT_ENVELOPE_FIELDS = Object.freeze([
  'datasetId',
  'runId',
  'manifestVersion',
  'manifestDigest',
  'registryVersion',
  'registryDigest',
  'runtimeEpoch',
  'runtimeRevision',
  'actionKey',
  'publicProjectionActionKey',
  'publicProjectionResolverVersion',
  'publicProjectionExecutorVersion',
  'publicProjectionVersion',
  ...PREDICTION_PUBLIC_INPUT_FIELDS
]);

/** 构造不携带 SQL、路径、ID 或私有证据的 Prediction adapter 错误。 */
function createPredictionAdapterError(code, message, statusCode = 409) {
  return new AppError(code, message, { statusCode, details: null });
}

/** 递归冻结 adapter 保存的私有快照，避免调用链内原对象漂移。 */
function freezePredictionAdapterSnapshot(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezePredictionAdapterSnapshot));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, freezePredictionAdapterSnapshot(item)]
    ))));
  }
  return value;
}

// 公共 DTO 禁止把内部能力、摘要或持久化字段名伪装成业务字符串值。
const PREDICTION_FORBIDDEN_PUBLIC_TOKENS = Object.freeze(new Set([
  'adapter', 'adaptername', 'bindings', 'capability', 'completionwitness', 'contextid',
  'entityevidence', 'exactscope', 'handler', 'identitydigest', 'importbatchid',
  'inputdigest', 'internalid', 'manifestdigest', 'modulepath', 'outputentityid',
  'outputid', 'parameters_json', 'privatecontext', 'privatedigest', 'receipt',
  'registrationreceipt', 'registrationscope', 'registrydigest', 'registryid',
  'relationid', 'requestedby', 'resultdigest', 'runtimeepoch', 'runtimerevision',
  'snapshotdigest', 'sourcebatchid', 'sourcerownumber', 'sql'
]));

/** 严格判断普通无访问器对象是否只含指定字段，任何 Proxy 或反射异常均返回 false。 */
function hasExactPredictionFields(value, fields) {
  try {
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value)
      || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const expected = [...fields].sort();
    return keys.length === expected.length
      && keys.every((key, index) => key === expected[index])
      && keys.every((key) => (
        descriptors[key].enumerable === true
        && typeof descriptors[key].get !== 'function'
        && typeof descriptors[key].set !== 'function'
      ));
  } catch (_error) {
    return false;
  }
}

/** 严格判断数组仅含连续数据索引和内建 length，任何 Proxy 或反射异常均返回 false。 */
function isExactPredictionArray(value) {
  try {
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value)
      || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedFields = [
      ...Array.from({ length: value.length }, (_item, index) => String(index)),
      'length'
    ].sort();
    const actualFields = Object.keys(descriptors).sort();
    return actualFields.length === expectedFields.length
      && actualFields.every((fieldName, index) => fieldName === expectedFields[index])
      && actualFields.every((fieldName) => (
        typeof descriptors[fieldName].get !== 'function'
        && typeof descriptors[fieldName].set !== 'function'
        && (fieldName === 'length' || descriptors[fieldName].enumerable === true)
      ));
  } catch (_error) {
    return false;
  }
}

/** 递归拒绝内部字段名或值，循环、Proxy 和反射异常都按不可公开处理。 */
function containsForbiddenPredictionPublicToken(value, seen = new Set()) {
  try {
    if (typeof value === 'string') {
      return PREDICTION_FORBIDDEN_PUBLIC_TOKENS.has(value.toLowerCase());
    }
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)) {
      return Boolean(value && typeof value === 'object');
    }
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).some((fieldName) => {
      if (typeof fieldName !== 'string') return true;
      if (PREDICTION_FORBIDDEN_PUBLIC_TOKENS.has(fieldName.toLowerCase())) return true;
      const descriptor = descriptors[fieldName];
      if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') return true;
      return fieldName === 'length'
        ? false
        : containsForbiddenPredictionPublicToken(descriptor.value, seen);
    });
  } catch (_error) {
    return true;
  }
}

/** 将持久 demo run 重建为 P3/P4 要求的七字段冻结原对象。 */
function readPredictionActionDemoRun(db, requestedRun) {
  const persisted = requireDemoDatasetRun(db, requestedRun?.runId);
  const fields = [
    'runId', 'datasetId', 'manifestVersion', 'manifestDigest',
    'status', 'createdBy', 'createdAt'
  ];
  if (!requestedRun || fields.some((fieldName) => requestedRun[fieldName] !== persisted[fieldName])
    || !['active', 'completed'].includes(persisted.status)) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_RUN_STALE',
      'Prediction 后置动作 demo run 与当前持久化事实不一致。'
    );
  }
  return Object.freeze(Object.fromEntries(fields.map((fieldName) => (
    [fieldName, persisted[fieldName]]
  ))));
}

/** 复核通用 lifecycle 重建的 canonical actor 原对象并保持其对象身份。 */
function readPredictionActionActor(db, actor) {
  if (!hasExactPredictionFields(actor, PREDICTION_ACTOR_FIELDS)
    || !Object.isFrozen(actor)
    || !Number.isSafeInteger(actor.userId) || actor.userId < 1) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTOR_INVALID',
      'Prediction 后置动作操作者无效。',
      400
    );
  }
  const row = db.prepare(`SELECT id AS userId, username, display_name AS displayName, status
    FROM sys_users WHERE id = ?`).get(actor.userId) || null;
  if (!row || row.status !== 'active'
    || Number(row.userId) !== actor.userId
    || row.username !== actor.username
    || row.displayName !== actor.displayName) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTOR_UNAVAILABLE',
      'Prediction 后置动作操作者不存在、不可用或已漂移。'
    );
  }
  return actor;
}

/** 当前 run 任意 active Prediction derived 残片都会阻断第二套闭包。 */
function assertNoActivePredictionDerivedClosure(db, demoRun) {
  const state = db.prepare(`SELECT COUNT(*) AS total
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ?
      AND ownership_kind = 'derived' AND cleaned_at IS NULL
      AND entity_type IN ('prediction_run', 'prediction_result')`).get(
    demoRun.runId,
    PREDICTION_CONFIG_ARTIFACT_KEY
  );
  if (Number(state?.total || 0) > 0) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTIVE_DERIVED_CLOSURE_EXISTS',
      '当前 demo run 已存在 active derived Prediction 闭包，禁止创建第二套运行。'
    );
  }
}

/** 读取当前 run 唯一 active imported Prediction config，并重建正式 payload 与 snapshot。 */
function readPredictionConfigClosure(db, demoRun) {
  const rows = db.prepare(`SELECT registry.entity_pk AS entityPk,
      config.id, config.source_batch_id AS sourceBatchId,
      config.source_row_number AS sourceRowNumber, config.name, config.note,
      config.energy_type_id AS energyTypeId, energy.code AS energyTypeCode,
      config.organization_unit_id AS organizationUnitId,
      organization.unit_code AS organizationUnitCode,
      config.meter_device_id AS meterDeviceId, meter.meter_code AS meterCode,
      config.source_batch_filter_id AS sourceBatchFilterId,
      config.train_start_month AS trainStartMonth,
      config.train_end_month AS trainEndMonth,
      config.predict_start_month AS predictStartMonth,
      config.predict_end_month AS predictEndMonth,
      config.algorithm, config.window_size AS windowSize,
      config.status, config.archived_at AS archivedAt
    FROM demo_data_registry registry
    LEFT JOIN prediction_configs config
      ON config.id = CAST(registry.entity_pk AS INTEGER)
    LEFT JOIN energy_types energy ON energy.id = config.energy_type_id
    LEFT JOIN organization_units organization
      ON organization.id = config.organization_unit_id
    LEFT JOIN meter_devices meter ON meter.id = config.meter_device_id
    WHERE registry.run_id = ? AND registry.artifact_key = ?
      AND registry.entity_type = 'prediction_config'
      AND registry.ownership_kind = 'imported' AND registry.cleaned_at IS NULL
    ORDER BY registry.registry_id`).all(
    demoRun.runId,
    PREDICTION_CONFIG_ARTIFACT_KEY
  );
  if (rows.length !== 1) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_CONFIG_SOURCE_SET_INVALID',
      '当前 demo run 必须只有一个 active imported Prediction config。'
    );
  }
  const config = rows[0];
  if (!Number.isSafeInteger(Number(config.id)) || Number(config.id) < 1
    || String(Number(config.id)) !== String(config.entityPk)
    || !Number.isSafeInteger(Number(config.sourceBatchId)) || Number(config.sourceBatchId) < 1
    || !Number.isSafeInteger(Number(config.sourceBatchFilterId))
    || Number(config.sourceBatchFilterId) < 1
    || !['draft', 'active'].includes(config.status) || config.archivedAt !== null
    || !PREDICTION_ALGORITHMS.has(config.algorithm)
    || (config.algorithm === 'moving_average'
      && (!Number.isSafeInteger(Number(config.windowSize))
        || Number(config.windowSize) < 2 || Number(config.windowSize) > 12))
    || (config.algorithm === 'linear_trend' && config.windowSize !== null)) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_CONFIG_SOURCE_INVALID',
      '当前 demo run 的 Prediction config 状态、算法或来源批次无效。'
    );
  }
  const configSnapshot = freezePredictionAdapterSnapshot({
    configId: Number(config.id),
    config: {
      name: config.name,
      note: config.note,
      energyTypeCode: config.energyTypeCode,
      organizationUnitId: config.organizationUnitId === null
        ? null
        : Number(config.organizationUnitId),
      organizationUnitCode: config.organizationUnitCode,
      meterDeviceId: config.meterDeviceId === null ? null : Number(config.meterDeviceId),
      meterCode: config.meterCode,
      sourceBatchId: Number(config.sourceBatchFilterId),
      trainStartMonth: config.trainStartMonth,
      trainEndMonth: config.trainEndMonth,
      predictStartMonth: config.predictStartMonth,
      predictEndMonth: config.predictEndMonth,
      algorithm: config.algorithm,
      windowSize: config.windowSize === null ? null : Number(config.windowSize)
    }
  });
  const payload = freezePredictionAdapterSnapshot({
    name: config.name,
    note: config.note,
    ...(config.energyTypeCode ? { energyTypeCode: config.energyTypeCode } : {}),
    ...(config.organizationUnitCode
      ? { organizationUnitCode: config.organizationUnitCode }
      : {}),
    ...(config.organizationUnitId !== null
      ? { organizationUnitId: Number(config.organizationUnitId) }
      : {}),
    ...(config.meterCode ? { meterCode: config.meterCode } : {}),
    ...(config.meterDeviceId !== null
      ? { meterDeviceId: Number(config.meterDeviceId) }
      : {}),
    sourceBatchId: Number(config.sourceBatchFilterId),
    trainStartMonth: config.trainStartMonth,
    trainEndMonth: config.trainEndMonth,
    predictStartMonth: config.predictStartMonth,
    predictEndMonth: config.predictEndMonth,
    algorithm: config.algorithm,
    ...(config.algorithm === 'moving_average'
      ? { windowSize: Number(config.windowSize) }
      : {})
  });
  return Object.freeze({
    configId: Number(config.id),
    provenanceBatchId: Number(config.sourceBatchId),
    trainingBatchId: Number(config.sourceBatchFilterId),
    payload,
    configSnapshot
  });
}

/** 为只读 inspect 构造不落库的内部 action 身份。 */
function buildPredictionPreviewActionRun(demoRun, canonicalActor) {
  return Object.freeze({
    actionRunId: `prediction-preview:${demoRun.runId}`,
    runId: demoRun.runId,
    datasetId: demoRun.datasetId,
    actionKey: PREDICTION_ACTION_KEY,
    requestedBy: canonicalActor.userId,
    status: 'executing'
  });
}

/** 在 P3 caller-owned scope 中执行零写 exact inspect，并让 capability 在 callback 结束时失效。 */
function inspectPredictionExactClosure(db, identities, configClosure) {
  return capturedPredictionHandlers.withExactScope(
    { db, ...identities },
    (transactionScope) => capturedPredictionHandlers.inspectExact({
      db,
      transactionScope,
      payload: configClosure.payload,
      configSnapshot: configClosure.configSnapshot
    }).summary
  );
}

/** 将 P3 inspect 实际摘要映射为不含 ID、digest、filter 和 warning 原文的公共输入。 */
function buildPredictionPublicInput(inspection) {
  const payload = inspection.normalizedPayload;
  const eligibleTrainingRecordCount = inspection.eligibleGroups.reduce((total, group) => (
    total + group.records.length
  ), 0);
  const minimumEligibleTrainingMonthCount = inspection.eligibleGroups.reduce((minimum, group) => (
    Math.min(minimum, group.sufficiency.sampleMonths)
  ), Number.POSITIVE_INFINITY);
  return freezePredictionAdapterSnapshot({
    algorithm: payload.algorithm,
    windowSize: payload.windowSize ?? null,
    trainingMonthStart: payload.trainStartMonth,
    trainingMonthEnd: payload.trainEndMonth,
    predictionMonthStart: payload.predictStartMonth,
    predictionMonthEnd: payload.predictEndMonth,
    trainingRecordCount: inspection.exactTrainingRecords.length,
    trainingMonthCount: payload.trainMonths.length,
    trainingGroupCount: inspection.groups.length,
    eligibleTrainingRecordCount,
    minimumEligibleTrainingMonthCount: Number.isFinite(minimumEligibleTrainingMonthCount)
      ? minimumEligibleTrainingMonthCount
      : 0,
    eligibleGroupCount: inspection.eligibleGroups.length,
    skippedGroupCount: inspection.skippedGroups.length,
    expectedResultCount: inspection.expectedResultCount
  });
}

/** 从当前 SQLite 事实重建 P3 exact 与 Artifact 07/12 managed source 私有闭包。 */
function resolvePredictionActionInput(db, requestedRun, actor) {
  const demoRun = readPredictionActionDemoRun(db, requestedRun);
  assertNoActivePredictionDerivedClosure(db, demoRun);
  const canonicalActor = readPredictionActionActor(db, actor);
  const configClosure = readPredictionConfigClosure(db, demoRun);
  const previewActionRun = buildPredictionPreviewActionRun(demoRun, canonicalActor);
  const inspection = inspectPredictionExactClosure(db, {
    demoRun,
    actionRun: previewActionRun,
    actor: canonicalActor
  }, configClosure);
  const exactEnergyRecordIds = inspection.exactTrainingRecords.map((record) => Number(record.id));
  if (exactEnergyRecordIds.length === 0) {
    throw createPredictionAdapterError(
      inspection.blockers[0]?.code === 'PREDICTION_EXACT_NO_HISTORY'
        ? 'PREDICTION_EXACT_NO_HISTORY'
        : 'DEMO_PREDICTION_TRAINING_SOURCE_SET_INVALID',
      '当前 demo run 没有可证明的 Prediction exact 训练记录。'
    );
  }
  const managedClosure = capturedPredictionHandlers.verifyManagedClosure({
    db,
    demoRunId: demoRun.runId,
    actorUserId: canonicalActor.userId,
    configEntityPk: configClosure.configId,
    energyRecordEntityPks: exactEnergyRecordIds
  });
  if (Number(managedClosure.energyBatchId) !== configClosure.trainingBatchId
    || Number(managedClosure.predictionBatchId) !== configClosure.provenanceBatchId) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_MANAGED_SOURCE_BATCH_MISMATCH',
      'Prediction config provenance 与 Artifact 07/12 primary batch 闭包不一致。'
    );
  }
  if (!inspection.executable || inspection.expectedResultCount < 1) {
    const blockerCode = inspection.blockers[0]?.code === 'PREDICTION_EXACT_NO_ELIGIBLE_GROUPS'
      ? 'PREDICTION_EXACT_NO_ELIGIBLE_GROUPS'
      : 'DEMO_PREDICTION_INPUT_BLOCKED';
    throw createPredictionAdapterError(
      blockerCode,
      '当前 demo run 的 Prediction exact 历史样本不可执行。'
    );
  }
  const domainInput = buildPredictionPublicInput(inspection);
  const privateFacts = freezePredictionAdapterSnapshot({
    demoRun,
    actor: canonicalActor,
    configClosure,
    managedClosure,
    inspection
  });
  const privateDigest = stableDigest(privateFacts);
  return {
    domainInput,
    evidence: null,
    privateContext: Object.freeze({
      demoRun,
      actor: canonicalActor,
      configClosure,
      inspection,
      inspectionDigest: stableDigest(inspection),
      privateDigest
    }),
    privateDigest
  };
}

/** 拒绝 Proxy context 和重新出现的普通 definitionIdentity 控制字段。 */
function assertPredictionDefinitionCapabilityContext(context) {
  if (!context || typeof context !== 'object' || utilTypes.isProxy(context)
    || Object.prototype.hasOwnProperty.call(context, 'definitionIdentity')) {
    throw createPredictionAdapterError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_CONTEXT_INVALID',
      'Prediction adapter lifecycle context 无效。',
      400
    );
  }
}

/** 一次性验证当前 adapter 阶段 capability，并返回 authority 捕获的定义事实。 */
function verifyPredictionDefinitionCapability(context, stage) {
  assertPredictionDefinitionCapabilityContext(context);
  return verifyDefinitionCapability({
    capability: context.definitionCapability,
    db: context.db,
    stage,
    actionRunId: context.actionRunId,
    actionStatus: context.actionStatus,
    run: context.run,
    runtime: context.runtime,
    actor: context.actor,
    parentCapability: context.parentDefinitionCapability
  });
}

/** 将 resolver/revalidate 的原私有上下文绑定已验证 capability，不修改摘要对象。 */
function bindPredictionPrivateContext(resolved, definitionCapability, stage) {
  PREDICTION_PRIVATE_CONTEXT_CAPABILITY_STATES.set(resolved.privateContext, {
    definitionCapability,
    stage
  });
  return resolved;
}

/** 验证私有上下文仍是上一阶段返回的原对象，clone、spread 和 Proxy 均拒绝。 */
function assertPredictionPrivateContextCapability(
  privateContext,
  definitionCapability,
  stage
) {
  const state = privateContext && typeof privateContext === 'object'
    && !utilTypes.isProxy(privateContext)
    ? PREDICTION_PRIVATE_CONTEXT_CAPABILITY_STATES.get(privateContext)
    : null;
  if (!state || state.definitionCapability !== definitionCapability || state.stage !== stage) {
    throw createPredictionAdapterError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PRIVATE_CONTEXT_INVALID',
      'Prediction private execution context 未绑定正式 revalidate capability。'
    );
  }
}

/** 生成 Prediction staged adapter 服务端输入；首行验证 preview-resolve capability。 */
function resolve(
  db,
  demoRun,
  runtime,
  actorUserId,
  actorIp = null,
  definitionCapability = null,
  actor = null
) {
  const lifecycleContext = {
    definitionCapability,
    db,
    stage: 'preview-resolve',
    actionRunId: null,
    actionStatus: null,
    run: demoRun,
    runtime,
    actor,
    parentDefinitionCapability: null
  };
  verifyPredictionDefinitionCapability(lifecycleContext, 'preview-resolve');
  if (actor?.userId !== actorUserId || actor?.ip !== (actorIp || null)) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTOR_INVALID',
      'Prediction 后置动作操作者与 capability 不一致。',
      400
    );
  }
  return bindPredictionPrivateContext(
    resolvePredictionActionInput(db, demoRun, actor),
    definitionCapability,
    'preview-resolve'
  );
}

/** 预演先消费 preview-probe capability，再复核 P3 exact closure 且保持零领域写入。 */
function previewProbe(context) {
  verifyPredictionDefinitionCapability(context, 'preview-probe');
  assertPredictionPrivateContextCapability(
    context.privateContext,
    context.parentDefinitionCapability,
    'preview-resolve'
  );
  const current = resolvePredictionActionInput(context.db, context.run, context.actor);
  if (current.privateDigest !== context.privateContext.privateDigest) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_INPUT_STALE',
      'Prediction exact 输入在预演过程中发生变化。'
    );
  }
  return {
    result: current.domainInput,
    outputCount: 0,
    outputs: []
  };
}

/** 复核持久 action run 与 capability 捕获的 registry、definition、run、runtime 和 actor。 */
function assertPredictionActionRunBinding(context, capabilityFacts) {
  const row = context.db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
      action_key AS actionKey, registry_version AS registryVersion,
      registry_digest AS registryDigest, resolver_version AS resolverVersion,
      executor_version AS executorVersion, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, runtime_epoch AS runtimeEpoch,
      runtime_revision AS runtimeRevision, requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(context.actionRunId) || null;
  const runtime = context.runtime;
  const run = context.run;
  const definition = capabilityFacts.definition;
  const registryIdentity = capabilityFacts.registryIdentity;
  if (!row || !run || !runtime
    || definition.actionKey !== PREDICTION_ACTION_KEY
    || definition.resolverVersion !== PREDICTION_RESOLVER_VERSION
    || definition.executorVersion !== PREDICTION_EXECUTOR_VERSION
    || typeof registryIdentity.version !== 'string' || registryIdentity.version.length === 0
    || !PREDICTION_DIGEST_PATTERN.test(registryIdentity.digest)
    || !['previewed', 'executing'].includes(context.actionStatus)
    || row.status !== context.actionStatus
    || row.actionKey !== definition.actionKey
    || row.registryVersion !== registryIdentity.version
    || row.registryDigest !== registryIdentity.digest
    || row.resolverVersion !== definition.resolverVersion
    || row.executorVersion !== definition.executorVersion
    || row.runId !== run.runId || row.datasetId !== run.datasetId
    || row.manifestVersion !== run.manifestVersion
    || row.manifestDigest !== run.manifestDigest
    || Number(row.runtimeEpoch) !== Number(runtime.runtimeEpoch)
    || Number(row.runtimeRevision) !== Number(runtime.revision)
    || Number(runtime.enabled) !== 1
    || Number(row.requestedBy) !== context.actor.userId
    || context.actor.userId !== context.actorUserId
    || context.actor.ip !== (context.actorIp || null)) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTION_RUN_BINDING_INVALID',
      'Prediction 后置动作与当前 run、runtime、manifest、actor 或定义 capability 不一致。'
    );
  }
}

/** claim 前与 outer transaction 内先消费阶段 capability，再重建 exact closure。 */
function revalidate(context) {
  const stage = context.actionStatus === 'previewed'
    ? 'previewed-revalidate'
    : 'executing-revalidate';
  const capabilityFacts = verifyPredictionDefinitionCapability(context, stage);
  assertPredictionActionRunBinding(context, capabilityFacts);
  return bindPredictionPrivateContext(
    resolvePredictionActionInput(context.db, context.run, context.actor),
    context.definitionCapability,
    stage
  );
}

/** 重读并冻结 P3/P4 要求的当前 executing action run 六字段原对象。 */
function readExecutingPredictionActionRun(db, actionRunId) {
  const row = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      dataset_id AS datasetId, action_key AS actionKey,
      requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRunId) || null;
  if (!row || row.actionKey !== PREDICTION_ACTION_KEY || row.status !== 'executing') {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTION_RUN_INVALID',
      'Prediction 后置动作未绑定当前 executing action run。'
    );
  }
  return Object.freeze({
    actionRunId: row.actionRunId,
    runId: row.runId,
    datasetId: row.datasetId,
    actionKey: row.actionKey,
    requestedBy: Number(row.requestedBy),
    status: row.status
  });
}

/** 将月份转换为稳定整数索引，仅供 public schema 逻辑一致性校验。 */
function predictionMonthIndex(month) {
  if (typeof month !== 'string' || !PREDICTION_MONTH_PATTERN.test(month)) return null;
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** 校验 Prediction 公共计数为非负安全整数。 */
function isPredictionPublicCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 校验公共输入的 exact schema、月份、算法、样本充分性和计数闭包。 */
function validatePredictionPublicInput(value, acceptedFields = PREDICTION_PUBLIC_INPUT_FIELDS) {
  if (!hasExactPredictionFields(value, acceptedFields)
    || containsForbiddenPredictionPublicToken(value)) return null;
  const trainingStart = predictionMonthIndex(value.trainingMonthStart);
  const trainingEnd = predictionMonthIndex(value.trainingMonthEnd);
  const predictionStart = predictionMonthIndex(value.predictionMonthStart);
  const predictionEnd = predictionMonthIndex(value.predictionMonthEnd);
  const countFields = [
    'trainingRecordCount', 'trainingMonthCount', 'trainingGroupCount',
    'eligibleTrainingRecordCount', 'minimumEligibleTrainingMonthCount',
    'eligibleGroupCount', 'skippedGroupCount', 'expectedResultCount'
  ];
  const predictionMonthCount = predictionStart === null || predictionEnd === null
    ? 0
    : predictionEnd - predictionStart + 1;
  const requiredHistoryMonths = value.algorithm === 'moving_average'
    && Number.isSafeInteger(value.windowSize)
    ? Math.max(3, value.windowSize)
    : 3;
  const minimumEligibleRecordClosure = value.eligibleGroupCount
    * value.minimumEligibleTrainingMonthCount;
  const expectedResultClosure = value.eligibleGroupCount * predictionMonthCount;
  if (!PREDICTION_ALGORITHMS.has(value.algorithm)
    || (value.algorithm === 'moving_average'
      && (!Number.isSafeInteger(value.windowSize)
        || value.windowSize < 2 || value.windowSize > 12))
    || (value.algorithm === 'linear_trend' && value.windowSize !== null)
    || trainingStart === null || trainingEnd === null
    || predictionStart === null || predictionEnd === null
    || trainingStart > trainingEnd || predictionStart > predictionEnd
    || predictionStart <= trainingEnd
    || predictionMonthCount < 1 || predictionMonthCount > 24
    || countFields.some((fieldName) => !isPredictionPublicCount(value[fieldName]))
    || value.trainingMonthCount !== trainingEnd - trainingStart + 1
    || value.trainingGroupCount !== value.eligibleGroupCount + value.skippedGroupCount
    || value.trainingRecordCount < value.trainingGroupCount
    || value.eligibleGroupCount < 1
    || value.minimumEligibleTrainingMonthCount < requiredHistoryMonths
    || value.minimumEligibleTrainingMonthCount > value.trainingMonthCount
    || !Number.isSafeInteger(minimumEligibleRecordClosure)
    || value.eligibleTrainingRecordCount < minimumEligibleRecordClosure
    || value.eligibleTrainingRecordCount > value.trainingRecordCount
    || value.trainingRecordCount - value.eligibleTrainingRecordCount
      < value.skippedGroupCount
    || (value.skippedGroupCount === 0
      && value.eligibleTrainingRecordCount !== value.trainingRecordCount)
    || !Number.isSafeInteger(expectedResultClosure)
    || value.expectedResultCount !== expectedResultClosure
    || value.expectedResultCount < 1) {
    return null;
  }
  return Object.freeze(Object.fromEntries(PREDICTION_PUBLIC_INPUT_FIELDS.map((fieldName) => (
    [fieldName, value[fieldName]]
  ))));
}

/** 校验持久 input envelope 的固定 marker 和通用绑定，不向 public DTO 输出这些字段。 */
function validatePredictionPersistedInputEnvelope(value) {
  if (!hasExactPredictionFields(value, PREDICTION_PERSISTED_INPUT_ENVELOPE_FIELDS)
    || value.actionKey !== PREDICTION_ACTION_KEY
    || value.publicProjectionActionKey !== PREDICTION_ACTION_KEY
    || value.publicProjectionResolverVersion !== PREDICTION_RESOLVER_VERSION
    || value.publicProjectionExecutorVersion !== PREDICTION_EXECUTOR_VERSION
    || value.publicProjectionVersion !== PREDICTION_PUBLIC_PROJECTION_VERSION
    || typeof value.datasetId !== 'string' || value.datasetId.length === 0
    || typeof value.runId !== 'string' || value.runId.length === 0
    || typeof value.manifestVersion !== 'string' || value.manifestVersion.length === 0
    || !PREDICTION_DIGEST_PATTERN.test(value.manifestDigest)
    || typeof value.registryVersion !== 'string' || value.registryVersion.length === 0
    || !PREDICTION_DIGEST_PATTERN.test(value.registryDigest)
    || !Number.isSafeInteger(value.runtimeEpoch) || value.runtimeEpoch < 1
    || !Number.isSafeInteger(value.runtimeRevision) || value.runtimeRevision < 1) {
    return null;
  }
  const domainInput = Object.fromEntries(PREDICTION_PUBLIC_INPUT_FIELDS.map((fieldName) => (
    [fieldName, value[fieldName]]
  )));
  return validatePredictionPublicInput(domainInput);
}

/** Prediction public input 只接受 exact domain DTO 或完整持久 marker envelope，异常统一置空。 */
function projectPublicInput(input = {}) {
  try {
    return validatePredictionPublicInput(input)
      || validatePredictionPersistedInputEnvelope(input);
  } catch (_error) {
    return null;
  }
}

/** 校验单条 Prediction result 业务字段并按正式算法倍率重建 confidence。 */
function validatePredictionPublicResultItem(value) {
  try {
    if (!hasExactPredictionFields(value, PREDICTION_PUBLIC_RESULT_ITEM_FIELDS)
      || containsForbiddenPredictionPublicToken(value)
      || typeof value.energyTypeCode !== 'string'
      || !PREDICTION_ENERGY_CODE_PATTERN.test(value.energyTypeCode)
      || typeof value.canonicalUnit !== 'string'
      || !PREDICTION_CANONICAL_UNITS.has(value.canonicalUnit)
      || predictionMonthIndex(value.targetMonth) === null
      || !PREDICTION_ALGORITHMS.has(value.method)
      || !isPredictionRoundedValue(value.predictedValue, { nonNegative: true })
      || !isPredictionRoundedValue(value.confidenceLow, { nonNegative: true })
      || !isPredictionRoundedValue(value.confidenceHigh, { nonNegative: true })) {
      return null;
    }
    const confidence = buildPredictionConfidenceFacts(value.method, value.predictedValue);
    if (value.confidenceLow !== confidence.confidenceLow
      || value.confidenceHigh !== confidence.confidenceHigh
      || value.confidenceLow > value.predictedValue
      || value.predictedValue > value.confidenceHigh) {
      return null;
    }
    return Object.freeze(Object.fromEntries(PREDICTION_PUBLIC_RESULT_ITEM_FIELDS.map((fieldName) => (
      [fieldName, value[fieldName]]
    ))));
  } catch (_error) {
    return null;
  }
}

/** 校验 completed run 公共摘要，并复核 result/output 计数。 */
function validatePredictionPublicRun(value, expectedFields = PREDICTION_PUBLIC_RUN_FIELDS) {
  if (!hasExactPredictionFields(value, expectedFields)) return null;
  const inputValue = Object.fromEntries(PREDICTION_PUBLIC_INPUT_FIELDS.map((fieldName) => (
    [fieldName, value[fieldName]]
  )));
  const input = validatePredictionPublicInput(inputValue);
  if (!input || !isPredictionPublicCount(value.resultCount)
    || !isPredictionPublicCount(value.outputCount)
    || value.status !== PREDICTION_COMPLETED_STATUS
    || value.resultCount !== value.expectedResultCount
    || value.outputCount !== 1 + value.resultCount) {
    return null;
  }
  return Object.freeze({
    ...input,
    resultCount: value.resultCount,
    outputCount: value.outputCount,
    status: value.status
  });
}

/** 校验完整 Prediction public result 集合、排序、唯一 key 和 group×month 笛卡尔闭包。 */
function validatePredictionPublicResult(value) {
  if (!hasExactPredictionFields(value, PREDICTION_PUBLIC_RESULT_FIELDS)
    || !isExactPredictionArray(value.results)) {
    return null;
  }
  const runValue = Object.fromEntries(PREDICTION_PUBLIC_RUN_FIELDS.map((fieldName) => (
    [fieldName, value[fieldName]]
  )));
  const run = validatePredictionPublicRun(runValue);
  const results = value.results.map(validatePredictionPublicResultItem);
  if (!run || results.some((item) => item === null) || results.length !== run.resultCount) {
    return null;
  }
  const predictionStart = predictionMonthIndex(run.predictionMonthStart);
  const predictionEnd = predictionMonthIndex(run.predictionMonthEnd);
  const keys = results.map((item) => (
    `${item.energyTypeCode}\0${item.canonicalUnit}\0${item.targetMonth}`
  ));
  const sortedKeys = [...keys].sort();
  const groupMonths = new Map();
  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    const targetIndex = predictionMonthIndex(item.targetMonth);
    if (item.method !== run.algorithm || targetIndex < predictionStart
      || targetIndex > predictionEnd || keys[index] !== sortedKeys[index]) {
      return null;
    }
    const groupKey = `${item.energyTypeCode}\0${item.canonicalUnit}`;
    const months = groupMonths.get(groupKey) || new Set();
    months.add(item.targetMonth);
    groupMonths.set(groupKey, months);
  }
  const predictionMonthCount = predictionEnd - predictionStart + 1;
  if (new Set(keys).size !== keys.length || groupMonths.size !== run.eligibleGroupCount
    || [...groupMonths.values()].some((months) => months.size !== predictionMonthCount)) {
    return null;
  }
  return Object.freeze({ ...run, results: Object.freeze(results) });
}

/** 对 run/result outputRef 分别应用 exact schema；未知类型整体拒绝。 */
function projectPredictionPublicOutputRef(outputRef, outputEntityType) {
  if (outputEntityType === 'prediction_run') {
    return validatePredictionPublicRun(outputRef);
  }
  if (outputEntityType === 'prediction_result') {
    return validatePredictionPublicResultItem(outputRef);
  }
  return null;
}

/** Prediction public result 与 historical outputRef 只通过显式 exact projector，异常统一置空。 */
function projectPublicResult(result, projection = null) {
  try {
    if (projection !== null) {
      if (!hasExactPredictionFields(projection, ['kind', 'outputEntityType'])
        || projection.kind !== 'outputRef'
        || typeof projection.outputEntityType !== 'string') {
        return null;
      }
      return projectPredictionPublicOutputRef(result, projection.outputEntityType);
    }
    return validatePredictionPublicResult(result);
  } catch (_error) {
    return null;
  }
}

/** receipt 验证后只按 P3 返回的 run 主键重读本次 completed 输出，不查询“最新 run”。 */
function readPredictionActionOutputs(db, predictionRunId, inspectedSummary) {
  const run = db.prepare(`SELECT id, algorithm, status,
      train_start_month AS trainingMonthStart,
      train_end_month AS trainingMonthEnd,
      predict_start_month AS predictionMonthStart,
      predict_end_month AS predictionMonthEnd
    FROM prediction_runs WHERE id = ?`).get(predictionRunId) || null;
  const rows = db.prepare(`SELECT result.id, energy.code AS energyTypeCode,
      result.target_month AS targetMonth, result.predicted_value AS predictedValue,
      result.predicted_unit AS canonicalUnit, result.confidence_low AS confidenceLow,
      result.confidence_high AS confidenceHigh
    FROM prediction_results result
    JOIN energy_types energy ON energy.id = result.energy_type_id
    WHERE result.prediction_run_id = ?
    ORDER BY energy.code, result.predicted_unit, result.target_month, result.id`).all(
    predictionRunId
  );
  if (!run || run.status !== PREDICTION_COMPLETED_STATUS
    || rows.length < 1 || rows.length !== inspectedSummary.expectedResultCount) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_OUTPUT_FACTS_INVALID',
      'Prediction 后置动作完成事实与输出数量不一致。'
    );
  }
  const input = buildPredictionPublicInput(inspectedSummary);
  const results = rows.map((row) => ({
    energyTypeCode: row.energyTypeCode,
    canonicalUnit: row.canonicalUnit,
    targetMonth: row.targetMonth,
    predictedValue: row.predictedValue,
    confidenceLow: row.confidenceLow,
    confidenceHigh: row.confidenceHigh,
    method: run.algorithm
  }));
  const outputCount = 1 + results.length;
  const publicRun = {
    ...input,
    resultCount: results.length,
    outputCount,
    status: run.status
  };
  const result = { ...publicRun, results };
  const projectedResult = validatePredictionPublicResult(result);
  if (!projectedResult) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_PUBLIC_RESULT_INVALID',
      'Prediction 后置动作结果不满足严格公共投影合同。'
    );
  }
  return {
    result: projectedResult,
    outputCount,
    outputs: [
      {
        outputEntityType: 'prediction_run',
        outputEntityId: String(run.id),
        outputRef: validatePredictionPublicRun(publicRun)
      },
      ...rows.map((row, index) => ({
        outputEntityType: 'prediction_result',
        outputEntityId: String(row.id),
        outputRef: projectedResult.results[index]
      }))
    ]
  };
}

/** 在 nested business SAVEPOINT 内编排 P3 exact、P4 registrar、receipt 与严格输出。 */
function execute(context) {
  verifyPredictionDefinitionCapability(context, 'execute');
  assertPredictionPrivateContextCapability(
    context.privateContext,
    context.parentDefinitionCapability,
    'executing-revalidate'
  );
  const db = context.db;
  const demoRun = context.privateContext?.demoRun;
  const actor = context.privateContext?.actor;
  const configClosure = context.privateContext?.configClosure;
  const runFields = [
    'runId', 'datasetId', 'manifestVersion', 'manifestDigest',
    'status', 'createdBy', 'createdAt'
  ];
  if (!demoRun || !context.run
    || runFields.some((fieldName) => demoRun[fieldName] !== context.run[fieldName])
    || !actor || actor !== context.actor || actor.userId !== context.actorUserId
    || actor.ip !== (context.actorIp || null) || !configClosure) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_EXECUTION_BINDING_INVALID',
      'Prediction 后置动作执行对象身份与第二次复核结果不一致。'
    );
  }
  const actionRun = readExecutingPredictionActionRun(db, context.actionRunId);
  if (actionRun.runId !== demoRun.runId || actionRun.datasetId !== demoRun.datasetId
    || actionRun.requestedBy !== actor.userId) {
    throw createPredictionAdapterError(
      'DEMO_PREDICTION_ACTION_RUN_INVALID',
      'Prediction action run、demo run 与 actor 绑定不一致。'
    );
  }
  const identities = { demoRun, actionRun, actor };
  return capturedPredictionHandlers.withExactScope(
    { db, ...identities },
    (transactionScope) => {
      const inspected = capturedPredictionHandlers.inspectExact({
        db,
        transactionScope,
        payload: configClosure.payload,
        configSnapshot: configClosure.configSnapshot
      });
      if (stableDigest(inspected.summary) !== context.privateContext.inspectionDigest) {
        throw createPredictionAdapterError(
          'DEMO_PREDICTION_INPUT_STALE',
          'Prediction exact 输入在执行前发生变化。'
        );
      }
      const exactExecution = capturedPredictionHandlers.executeExact({
        db,
        transactionScope,
        exactCapability: inspected.exactCapability,
        ...identities
      });
      if (exactExecution.summary?.status !== PREDICTION_COMPLETED_STATUS
        || !Number.isSafeInteger(exactExecution.summary?.resultCount)
        || exactExecution.summary.resultCount < 1) {
        throw createPredictionAdapterError(
          'DEMO_PREDICTION_COMPLETION_INVARIANT_FAILED',
          'Prediction exact 执行未满足 completed 且结果非空的不变量。'
        );
      }
      const registrationBinding = {
        db,
        transactionScope,
        completionWitness: exactExecution.completionWitness,
        definitionCapability: context.definitionCapability,
        ...identities
      };
      const registrationScope = capturedPredictionHandlers.issueRegistration(
        registrationBinding
      );
      let registrationReceipt = null;
      try {
        registrationReceipt = capturedPredictionHandlers.registerDerived({
          ...registrationBinding,
          registrationScope
        });
      } catch (error) {
        if (db.open === true && db.inTransaction === true) {
          try {
            capturedPredictionHandlers.abortRegistration({
              ...registrationBinding,
              registrationScope
            });
          } catch (_abortError) {
            throw createPredictionAdapterError(
              'DEMO_PREDICTION_REGISTRATION_ABORT_FAILED',
              'Prediction registration 未能完成安全终止。',
              500
            );
          }
        }
        throw error;
      }
      if (!registrationReceipt || typeof registrationReceipt !== 'object'
        || Array.isArray(registrationReceipt)) {
        if (db.open === true && db.inTransaction === true) {
          try {
            capturedPredictionHandlers.abortRegistration({
              ...registrationBinding,
              registrationScope
            });
          } catch (_abortError) {
            throw createPredictionAdapterError(
              'DEMO_PREDICTION_REGISTRATION_ABORT_FAILED',
              'Prediction registration 未能完成安全终止。',
              500
            );
          }
        }
        throw createPredictionAdapterError(
          'DEMO_PREDICTION_REGISTRATION_RECEIPT_INVALID',
          'Prediction registration 未返回可验证 receipt。',
          500
        );
      }
      // receipt 产生后禁止 abort，只允许 P4 verifier 一次性验证并消费。
      if (capturedPredictionHandlers.verifyReceipt({
        ...registrationBinding,
        registrationScope,
        registrationReceipt
      }) !== true) {
        throw createPredictionAdapterError(
          'DEMO_PREDICTION_REGISTRATION_RECEIPT_INVALID',
          'Prediction registration receipt 验证未完成。',
          500
        );
      }
      return readPredictionActionOutputs(
        db,
        exactExecution.run.id,
        inspected.summary
      );
    }
  );
}

/** 将 resolver/exact/ownership 异常映射为固定、无内部详情的预演 blocker。 */
function mapPreviewBlocker(error) {
  const candidateCode = [error?.code, error?.details?.code].find((code) => (
    typeof code === 'string'
    && /^(?:DEMO_PREDICTION|PREDICTION_EXACT|DEMO_MANAGED_SOURCE)_[A-Z0-9_]{1,100}$/.test(code)
  ));
  const code = candidateCode || 'DEMO_PREDICTION_INPUT_BLOCKED';
  const messages = {
    DEMO_PREDICTION_ACTIVE_DERIVED_CLOSURE_EXISTS:
      '当前 demo run 已存在 active derived Prediction 闭包，已安全阻断。',
    PREDICTION_EXACT_NO_HISTORY:
      '当前 demo run 没有符合服务端 exact filter 的历史记录，已安全阻断。',
    PREDICTION_EXACT_NO_ELIGIBLE_GROUPS:
      '当前 demo run 的全部历史分组样本不足，已安全阻断。'
  };
  return {
    code,
    message: messages[code]
      || '服务端无法证明 artifact 07/12 的 Prediction exact 输入闭包，已安全阻断。'
  };
}

  return Object.freeze({
    resolve,
    previewProbe,
    revalidate,
    execute,
    projectPublicInput,
    projectPublicResult,
    mapPreviewBlocker
  });
}

Object.defineProperty(module, 'exports', {
  value: createDemoPostActionPredictionAdapter,
  enumerable: false,
  writable: false,
  configurable: false
});
