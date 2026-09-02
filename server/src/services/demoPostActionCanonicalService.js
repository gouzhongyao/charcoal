'use strict';

// Canonical core 顶层无条件构造唯一 service graph；CommonJS cache 是唯一 broker。
const crypto = require('crypto');
const path = require('path');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  assertStrictBody,
  stableDigest
} = require('./demoPostActionServicePrimitives');
const {
  getDemoPostActionRegistryIdentity,
  listDemoPostActions,
  requireDemoPostAction
} = require('./demoPostActionRegistry');
const createDefinitionCapabilityAuthority = require(
  './demoPostActionDefinitionCapabilityFactory'
);
const createPredictionPostActionProtocol = require(
  './predictionPostActionProtocolFactory'
);
const createPredictionActionAdapter = require(
  './demoPostActionPredictionAdapterFactory'
);
const predictionService = require('./predictionService');
// Canonical core 只在初始化期按固定完整方法面捕获既有 P3 协议，不创建或查询全局 Symbol。
const predictionExactProtocol = Object.getOwnPropertySymbols(predictionService)
  .map((protocolSymbol) => (
    Object.getOwnPropertyDescriptor(predictionService, protocolSymbol)?.value
  ))
  .find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && Object.isFrozen(candidate)
    && Reflect.ownKeys(candidate).length === 6
    && typeof candidate.withCallerTransactionScope === 'function'
    && typeof candidate.inspectExact === 'function'
    && typeof candidate.executeExact === 'function'
    && typeof candidate.readCompletionWitness === 'function'
    && typeof candidate.consumeCompletionWitness === 'function'
    && typeof candidate.bindP4CompletionVerifier === 'function'
  ));
if (!predictionExactProtocol) {
  const initializationError = new Error('Prediction exact P4 linker 不可用。');
  initializationError.code = 'PREDICTION_EXACT_P4_LINKER_UNAVAILABLE';
  throw initializationError;
}
// P3 one-shot linker 必须在创建第二套 definition authority 前先消费或稳定拒绝。
const predictionP4CompletionProtocol =
  predictionExactProtocol.bindP4CompletionVerifier(Object.freeze({}));
// Canonical service 自己持有唯一 capability provenance；任何普通 factory 调用只能创建平行 provenance。
const definitionCapabilityAuthority = createDefinitionCapabilityAuthority();
// 首次 core 构造无条件完成 P4 registrar 与 P3 verifier 绑定；registry 只控制业务入口是否 connected。
const predictionPostActionProtocol = createPredictionPostActionProtocol({
  verifyDefinitionCapability: definitionCapabilityAuthority.verifyForP4,
  predictionP4CompletionProtocol
});
const predictionActionAdapter = createPredictionActionAdapter({
  verifyDefinitionCapability: definitionCapabilityAuthority.verifyForAdapter,
  predictionRegistrationProtocol: predictionPostActionProtocol
});
const issueCanonicalPredictionDefinitionCapability =
  definitionCapabilityAuthority.issueForService;
const carbonAccountingActionAdapter = require('./demoPostActionCarbonAccountingAdapter');
const { assertDemoRuntimeEnabled, requireDemoDatasetRun } = require('./demoRunService');
const { getDemoParkManifestDigest, DEMO_MANIFEST_VERSION } = require('./demoParkDatasetService');
const { getDemoArtifactRegistration } = require('./demoArtifactRegistry');
const { analyzeEnergyFlow } = require('./energyFlowService');
const {
  ENERGY_ANALYSIS_VERSIONS,
  ENERGY_FLOW_SOURCE_TYPES,
  RULE_MATCH_STATUSES,
  RULE_PRIORITIES
} = require('./energyAnalysisContracts');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  issueStrategyEvaluationRegistrationScopeInTransaction,
  registerDerivedMeterEnergyRecordsInTransaction
} = require('./demoOwnershipService');
const {
  buildMeterReadingEnergyRecordGenerationExactPreviewWithDb,
  executeMeterReadingEnergyRecordGenerationExact,
  prepareMeterReadingGenerationBackupEvidence
} = require('./meterReadingService');
const {
  buildEnergyStrategyExactScope,
  insertOperationLogWithDb,
  parseEvidenceRequirements,
  previewEnergyStrategies,
  runEnergyStrategyEvaluation,
  SUPPORTED_FORMULA_VERSION,
  SUPPORTED_METRIC_CODES
} = require('./energyStrategyEvaluationService');
// 后置动作状态只允许由本服务推进，避免客户端伪造生命周期状态。
const TERMINAL_ACTION_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'expired']);
const WRITABLE_DEMO_RUN_STATUSES = Object.freeze(['active', 'completed']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CLIENT_REQUEST_ID_PATTERN = /^[\w:.\-/]{1,128}$/;
const REQUIRED_FLOW_BINDINGS = Object.freeze([
  { artifactKey: '22-energy-flow-models', batchRole: 'primary', importType: 'energy_flow_model', entityType: 'energy_flow_model' },
  { artifactKey: '23-energy-flow-nodes', batchRole: 'primary', importType: 'energy_flow_node', entityType: 'energy_flow_node' },
  { artifactKey: '24-energy-flow-edges', batchRole: 'edge', importType: 'energy_flow_edge', entityType: 'energy_flow_edge' },
  { artifactKey: '24-energy-flow-edges', batchRole: 'record', importType: 'energy_flow_record', entityType: 'energy_flow_record' }
]);
// 抄表动作只接受当前 run 的 artifact 08 primary meter_reading 真实治理绑定。
const REQUIRED_METER_BINDING = Object.freeze({
  artifactKey: '08-meter-readings-2026-08',
  batchRole: 'primary',
  handlerKey: 'meter-readings-import',
  importType: 'meter_reading',
  entityType: 'meter_reading'
});
// 策略动作固定读取 artifact 15 与 18 的 primary managed-context 绑定，不使用 descriptor 缩减输入范围。
const REQUIRED_STRATEGY_BINDINGS = Object.freeze([
  Object.freeze({
    artifactKey: '15-energy-timeseries',
    batchRole: 'primary',
    handlerKey: 'energy-timeseries-import',
    importType: 'energy_timeseries',
    entityType: 'energy_timeseries',
    tableName: 'energy_timeseries_records'
  }),
  Object.freeze({
    artifactKey: '18-strategy-rules',
    batchRole: 'primary',
    handlerKey: 'strategy-rules-import',
    importType: 'strategy_rule',
    entityType: 'strategy_rule',
    tableName: 'strategy_rules'
  })
]);
// 策略 resolver 的稳定输入版本只用于识别服务端已解析的安全公共投影。
const STRATEGY_SCOPE_INPUT_VERSION = 'demo-strategy-evaluation-scope:v1';
// strategy action outputRef 只允许公开的稳定业务字段，不得携带内部主键或证据详情。
const STRATEGY_OUTPUT_REF_FIELDS = Object.freeze(['ruleCode', 'matchStatus', 'priority']);
// strategy derived evidence 的自动化边界必须保持正式人工复核口径。
const STRATEGY_OUTPUT_AUTOMATION_BOUNDARY = Object.freeze({
  usesAI: false,
  issuesControlCommand: false,
  changesDeviceState: false,
  requiresManualReview: true
});
// connected 能流动作只接受正式领域白名单中的显式边值来源类型。
const EXPLICIT_EDGE_VALUE_SOURCE_TYPE = ENERGY_FLOW_SOURCE_TYPES.find((sourceType) => sourceType === 'explicit_edge_value');
// 显式边值必须沿用正式能流分析公式版本，避免手工拼装来源事实。
const ENERGY_FLOW_FORMULA_VERSION = ENERGY_ANALYSIS_VERSIONS.energyFlow;
// 四类能流实体表名来自服务端固定白名单，不接受请求或 registry 注入。
const FLOW_ENTITY_TABLES = Object.freeze({
  energy_flow_model: 'energy_flow_models',
  energy_flow_node: 'energy_flow_nodes',
  energy_flow_edge: 'energy_flow_edges',
  energy_flow_record: 'energy_flow_records'
});
// 公共动作运行投影递归剔除内部 provenance、摘要和执行实现字段。
const PRIVATE_PUBLIC_FIELD_NAMES = Object.freeze(new Set([
  'adapter', 'adaptername', 'bindings', 'contextid', 'entityevidence', 'filesha', 'filesha256', 'fromregistryid',
  'handler', 'identitydigest', 'importbatchid', 'inputdigest', 'inputentityids', 'internalbindings', 'manifestdigest',
  'modulepath', 'outputentityid', 'outputid', 'registrydigest', 'registryid', 'relationid', 'relations', 'requestedby',
  'privatecontext', 'resultdigest', 'revision', 'runtimeepoch', 'runtimerevision', 'snapshotdigest', 'sourcebatchid',
  'sourcerownumber', 'sql', 'toregistryid'
]));
// 私有 capability、P3/P4 与数据库事务协议错误统一映射，禁止进入持久 failure/audit/public DTO。
const PRIVATE_FAILURE_REASON_PREFIXES = Object.freeze([
  'DEMO_POST_ACTION_DEFINITION_CAPABILITY_',
  'DEMO_OWNERSHIP_',
  'PREDICTION_EXACT_',
  'PREDICTION_REGISTRATION_',
  'PREDICTION_COMPLETION_',
  'PREDICTION_OWNERSHIP_',
  'DATABASE_TRANSACTION_'
]);

// 服务端私有 action adapter 表；选择只接受 registry 已校验的 actionKey，不接受客户端注入。
// adapter 同时封装输入解析、预演校验和正式执行，通用生命周期不依赖具体领域字段。
const PRIVATE_ACTION_ADAPTERS = Object.freeze({
  'carbon-accounting-run': carbonAccountingActionAdapter,
  // Prediction adapter 已 staged，但 getPrivateActionAdapter 仍要求 registry connected。
  'prediction-run': predictionActionAdapter,
  'meter-readings-to-energy-records': Object.freeze({
    resolve: resolveMeterReadingActionAdapterInput,
    previewProbe: probeMeterReadingAction,
    revalidate: revalidateMeterReadingAction,
    execute: executeMeterReadingAction,
    prepareBackup: prepareMeterReadingActionBackup,
    projectPublicInput: projectMeterReadingPublicInput,
    projectPublicResult: projectMeterReadingPublicResult,
    mapPreviewBlocker: mapMeterReadingPreviewBlocker
  }),
  'energy-flow-analysis': Object.freeze({
    resolve: resolveEnergyFlowActionAdapterInput,
    previewProbe: executeEnergyFlowAnalysis,
    revalidate: revalidateEnergyFlowAction,
    execute: executeEnergyFlowAnalysis,
    projectPublicInput: projectEnergyFlowPublicInput,
    projectPublicResult: projectEnergyFlowPublicResult,
    mapPreviewBlocker: mapEnergyFlowPreviewBlocker
  }),
  'strategy-evaluation-run': Object.freeze({
    resolve: resolveStrategyEvaluationActionAdapterInput,
    previewProbe: probeStrategyEvaluationAction,
    revalidate: revalidateStrategyEvaluationAction,
    execute: executeStrategyEvaluationAction,
    projectPublicInput: projectStrategyEvaluationPublicInput,
    projectPublicResult: projectStrategyEvaluationPublicResult,
    mapPreviewBlocker: mapStrategyEvaluationPreviewBlocker
  })
});

/** 生成严格 UTC 毫秒时间，供运行记录写入。 */
function nowUtc() {
  return new Date().toISOString();
}

/** 校验服务调用者为正安全整数。 */
function assertActorUserId(actorUserId) {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw badRequest('后置动作必须提供有效操作者。', { code: 'DEMO_POST_ACTION_ACTOR_REQUIRED' });
  }
  return actorUserId;
}

/** 从当前连接重建冻结 canonical actor，capability 不信任调用方提交的身份对象。 */
function readDemoPostActionCanonicalActor(db, actorUserId, actorIp = null) {
  const row = db.prepare(`SELECT id AS userId, username, display_name AS displayName, status
    FROM sys_users WHERE id = ?`).get(actorUserId) || null;
  if (!row || row.status !== 'active' || Number(row.userId) !== actorUserId) {
    throw new AppError(
      'DEMO_POST_ACTION_ACTOR_UNAVAILABLE',
      '后置动作操作者不存在或不可用。',
      { statusCode: 409 }
    );
  }
  return Object.freeze({
    userId: Number(row.userId),
    username: row.username,
    displayName: row.displayName,
    ip: actorIp || null
  });
}

/** 校验客户端幂等请求标识，拒绝实体、时间范围等隐式输入。 */
function normalizeClientRequestId(value) {
  if (typeof value !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(value.trim())) {
    throw badRequest('clientRequestId 必须是 1-128 位安全文本。', { code: 'DEMO_POST_ACTION_CLIENT_REQUEST_ID_INVALID' });
  }
  return value.trim();
}

/** 校验正则限制的十六进制摘要。 */
function assertDigest(value, fieldName) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw badRequest(`${fieldName} 必须是 64 位小写 SHA-256 摘要。`, { code: 'DEMO_POST_ACTION_DIGEST_INVALID', field: fieldName });
  }
  return value;
}

/** 递归生成动作运行的最后一道安全 JSON，领域授权必须优先使用显式 projector。 */
function sanitizePublicActionValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicActionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((result, [key, item]) => {
    if (PRIVATE_PUBLIC_FIELD_NAMES.has(key.toLowerCase())) return result;
    result[key] = sanitizePublicActionValue(item);
    return result;
  }, {});
}

// 历史公开 projector 使用服务端持久化标记，不依赖当前 registry connected 状态或客户端数据形状。
const HISTORICAL_PUBLIC_PROJECTION_VERSION = 1;
const HISTORICAL_PUBLIC_PROJECTOR_ACTIONS = Object.freeze(new Set([
  'carbon-accounting-run',
  'prediction-run',
  'meter-readings-to-energy-records',
  'strategy-evaluation-run',
  'energy-flow-analysis'
]));
// 旧运行没有 projection marker 时，只允许固定已审查 resolver/executor 身份且非 blocked 的历史行。
const PREDICTION_HISTORICAL_PUBLIC_PROJECTOR_IDENTITY = Object.freeze({
  actionKey: 'prediction-run',
  resolverVersion: 'prediction-resolver:v1',
  executorVersion: 'prediction-executor:v1',
  projectionVersion: HISTORICAL_PUBLIC_PROJECTION_VERSION
});

/** 识别持久 Prediction 公共 envelope，防止同步伪造 row action 后落入其它 projector。 */
function isPredictionHistoricalProjectionCandidate(input) {
  return Boolean(input && typeof input === 'object'
    && ['algorithm', 'trainingMonthStart', 'predictionMonthStart',
      'eligibleGroupCount', 'expectedResultCount'].every((fieldName) => (
      Object.prototype.hasOwnProperty.call(input, fieldName)
    )));
}
const HISTORICAL_PUBLIC_PROJECTOR_IDENTITIES = Object.freeze({
  'carbon-accounting-run': Object.freeze({
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:not-connected'
  }),
  'meter-readings-to-energy-records': Object.freeze({
    resolverVersion: 'meter-readings-resolver:v1',
    executorVersion: 'meter-readings-executor:v1'
  }),
  'strategy-evaluation-run': Object.freeze({
    resolverVersion: 'strategy-evaluation-resolver:v1',
    executorVersion: 'strategy-evaluation-executor:v1'
  }),
  'energy-flow-analysis': Object.freeze({
    resolverVersion: 'energy-flow-resolver:v1',
    executorVersion: 'energy-flow-executor:v1'
  })
});

/** 根据持久化 action identity/version 和受控 actionKey 白名单选择历史只读 projector。 */
function getHistoricalPublicProjector(row, input) {
  const identity = row && Object.prototype.hasOwnProperty.call(
    HISTORICAL_PUBLIC_PROJECTOR_IDENTITIES,
    row.actionKey
  ) ? HISTORICAL_PUBLIC_PROJECTOR_IDENTITIES[row.actionKey] : null;
  if (!row || !input || !HISTORICAL_PUBLIC_PROJECTOR_ACTIONS.has(row.actionKey)
    || !Object.prototype.hasOwnProperty.call(PRIVATE_ACTION_ADAPTERS, row.actionKey)) {
    return null;
  }
  if (isPredictionHistoricalProjectionCandidate(input)
    && row.actionKey !== PREDICTION_HISTORICAL_PUBLIC_PROJECTOR_IDENTITY.actionKey) {
    return null;
  }
  const markerFields = [
    'publicProjectionActionKey',
    'publicProjectionResolverVersion',
    'publicProjectionExecutorVersion',
    'publicProjectionVersion'
  ];
  const presentMarkerFields = markerFields.filter((fieldName) => (
    Object.prototype.hasOwnProperty.call(input, fieldName)
  ));
  if (row.actionKey === PREDICTION_HISTORICAL_PUBLIC_PROJECTOR_IDENTITY.actionKey) {
    const predictionIdentity = PREDICTION_HISTORICAL_PUBLIC_PROJECTOR_IDENTITY;
    const predictionMarkerMatches = presentMarkerFields.length === markerFields.length
      && row.actionKey === predictionIdentity.actionKey
      && row.resolverVersion === predictionIdentity.resolverVersion
      && row.executorVersion === predictionIdentity.executorVersion
      && input.publicProjectionActionKey === predictionIdentity.actionKey
      && input.publicProjectionResolverVersion === predictionIdentity.resolverVersion
      && input.publicProjectionExecutorVersion === predictionIdentity.executorVersion
      && input.publicProjectionVersion === predictionIdentity.projectionVersion;
    return predictionMarkerMatches ? PRIVATE_ACTION_ADAPTERS[row.actionKey] : null;
  }
  const markerMatches = presentMarkerFields.length === markerFields.length
    && input.publicProjectionActionKey === row.actionKey
    && input.publicProjectionResolverVersion === row.resolverVersion
    && input.publicProjectionExecutorVersion === row.executorVersion
    && input.publicProjectionVersion === HISTORICAL_PUBLIC_PROJECTION_VERSION;
  const legacyStableIdentity = presentMarkerFields.length === 0 && identity
    && row.resolverVersion === identity.resolverVersion
    && row.executorVersion === identity.executorVersion
    && row.status !== 'blocked';
  return markerMatches || legacyStableIdentity
    ? PRIVATE_ACTION_ADAPTERS[row.actionKey]
    : null;
}

/** 安全调用领域 public projector；任何访问、执行或 sanitize 异常都独立置空。 */
function projectPublicActionValueSafely(projector, methodName, value, projection = undefined) {
  try {
    if (!projector || typeof projector[methodName] !== 'function') return null;
    const projected = projection === undefined
      ? projector[methodName](value)
      : projector[methodName](value, projection);
    return sanitizePublicActionValue(projected);
  } catch (_error) {
    return null;
  }
}

/** 历史 input 只由稳定 projector 显式投影；not-connected blocker 保留固定 artifact 列表。 */
function mapPublicActionInput(row, input, projector) {
  if (projector) {
    return projectPublicActionValueSafely(projector, 'projectPublicInput', input);
  }
  if ((row.actionKey === 'prediction-run' || isPredictionHistoricalProjectionCandidate(input))
    && row.status !== 'blocked') return null;
  if (Array.isArray(input.requiredArtifactBindings)) {
    return { requiredArtifactBindings: input.requiredArtifactBindings.map((binding) => String(binding)) };
  }
  return {};
}

/** 仅返回稳定 blocker 码、消息和固定所需 artifact 绑定，不暴露内部 details。 */
function mapPublicActionBlocker(row) {
  const blocker = parseNullableJsonObject(row.blockerJson);
  if (!blocker) return null;
  const safeBlocker = {
    code: typeof blocker.code === 'string' ? blocker.code : 'DEMO_POST_ACTION_BLOCKED',
    message: typeof blocker.message === 'string' ? blocker.message : '该演示后置动作已安全阻断。'
  };
  const input = parseJsonObject(row.inputJson);
  if (Array.isArray(input?.requiredArtifactBindings)) {
    safeBlocker.requiredArtifactBindings = input.requiredArtifactBindings.map((binding) => String(binding));
  }
  return safeBlocker;
}

/** 对已知 action outputRef 使用显式字段白名单；未知 projector 一律返回 null。 */
function projectHistoricalOutputRef(row, projector, output) {
  const outputRef = output?.outputRef;
  if (!projector || !outputRef || typeof outputRef !== 'object' || Array.isArray(outputRef)) return null;
  if (row.actionKey === 'carbon-accounting-run' || row.actionKey === 'prediction-run') {
    return projectPublicActionValueSafely(projector, 'projectPublicResult', outputRef, {
      kind: 'outputRef',
      outputEntityType: output.outputEntityType
    });
  }
  if (row.actionKey === 'meter-readings-to-energy-records'
    && output.outputEntityType === 'energy_record') {
    return sanitizePublicActionValue({
      month: typeof outputRef.month === 'string' ? outputRef.month : null,
      unit: typeof outputRef.unit === 'string' ? outputRef.unit : null,
      value: Number.isFinite(Number(outputRef.value)) ? Number(outputRef.value) : null
    });
  }
  if (row.actionKey === 'strategy-evaluation-run'
    && output.outputEntityType === 'strategy_rule_hit') {
    return sanitizePublicActionValue({
      ruleCode: typeof outputRef.ruleCode === 'string' ? outputRef.ruleCode : null,
      matchStatus: typeof outputRef.matchStatus === 'string' ? outputRef.matchStatus : null,
      priority: typeof outputRef.priority === 'string' ? outputRef.priority : null
    });
  }
  return null;
}

/** 将数据库动作运行行映射为历史稳定的显式安全 API 白名单。 */
function mapActionRun(row, outputs = []) {
  if (!row) return null;
  const input = parseJsonObject(row.inputJson) || {};
  const projector = getHistoricalPublicProjector(row, input);
  const result = parseNullableJsonObject(row.resultJson);
  const projectedResult = projector
    ? projectPublicActionValueSafely(projector, 'projectPublicResult', result)
    : null;
  return {
    actionRunId: row.actionRunId,
    runId: row.runId,
    datasetId: row.datasetId,
    actionKey: row.actionKey,
    clientRequestId: row.clientRequestId,
    manifestVersion: row.manifestVersion,
    previewDigest: row.previewDigest,
    outputCount: row.outputCount,
    previewExpiresAt: row.previewExpiresAt,
    input: mapPublicActionInput(row, input, projector),
    blocker: mapPublicActionBlocker(row),
    result: projectedResult,
    status: row.status,
    retryCount: row.retryCount,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    outputs: outputs.map((output) => ({
      outputEntityType: output.outputEntityType,
      outputRef: projectHistoricalOutputRef(row, projector, output),
      createdAt: output.createdAt
    }))
  };
}

/** 安全解析服务端保存的 JSON object；损坏记录直接视为不可读。 */
function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/** 解析可空的服务端结果或 blocker JSON。 */
function parseNullableJsonObject(value) {
  return value ? parseJsonObject(value) : null;
}

/** 从指定连接读取完整后置动作运行行。 */
function readActionRunRow(db, actionRunId) {
  return db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId, dataset_id AS datasetId,
      action_key AS actionKey, registry_version AS registryVersion, resolver_version AS resolverVersion,
      executor_version AS executorVersion, client_request_id AS clientRequestId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      registry_digest AS registryDigest, runtime_epoch AS runtimeEpoch, runtime_revision AS runtimeRevision,
      input_digest AS inputDigest, preview_digest AS previewDigest, output_count AS outputCount,
      result_digest AS resultDigest, preview_expires_at AS previewExpiresAt, input_json AS inputJson,
      blocker_json AS blockerJson, result_json AS resultJson, requested_by AS requestedBy,
      status, retry_count AS retryCount, failure_reason AS failureReason, created_at AS createdAt,
      started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRunId);
}

/** 读取动作输出引用，确保状态接口只返回真实服务端保存的引用。 */
function readActionOutputs(db, actionRunId) {
  return db.prepare(`SELECT output_id AS outputId, output_entity_type AS outputEntityType,
      output_entity_id AS outputEntityId, output_ref_json AS outputRefJson, created_at AS createdAt
    FROM demo_post_action_outputs WHERE action_run_id = ? ORDER BY output_id`).all(actionRunId).map((row) => ({
    outputId: row.outputId,
    outputEntityType: row.outputEntityType,
    outputEntityId: row.outputEntityId,
    outputRef: parseJsonObject(row.outputRefJson),
    createdAt: row.createdAt
  }));
}

/** 生成安全失败原因；private capability 错误和异常文本均不得写入 DTO、审计或日志。 */
function safeFailureReason(error) {
  if (error && typeof error.code === 'string'
    && !PRIVATE_FAILURE_REASON_PREFIXES.some((prefix) => error.code.startsWith(prefix))
    && /^[A-Z0-9_:-]{1,128}$/.test(error.code)) return error.code;
  return 'DEMO_POST_ACTION_EXECUTION_FAILED';
}

/** 生成运行期、manifest 与同一次读取的 registry 身份绑定输入。 */
function buildRunBinding(run, runtime, registry = getDemoPostActionRegistryIdentity()) {
  const manifestDigest = getDemoParkManifestDigest();
  if (run.datasetId === undefined || run.manifestVersion !== DEMO_MANIFEST_VERSION || run.manifestDigest !== manifestDigest) {
    throw new AppError('DEMO_POST_ACTION_MANIFEST_STALE', '演示 run 与当前 manifest 不一致。', { statusCode: 409 });
  }
  return {
    datasetId: run.datasetId,
    runId: run.runId,
    manifestVersion: DEMO_MANIFEST_VERSION,
    manifestDigest,
    registryVersion: registry.version,
    registryDigest: registry.digest,
    runtimeEpoch: runtime.runtimeEpoch,
    runtimeRevision: runtime.revision
  };
}

/** 校验动作执行只能作用于当前 writable demo run。 */
function requireWritableRun(db, runId) {
  const run = requireDemoDatasetRun(db, runId);
  if (!WRITABLE_DEMO_RUN_STATUSES.includes(run.status)) {
    throw new AppError('DEMO_RUN_NOT_WRITABLE', '当前演示 run 不具备后置动作写入资格。', {
      statusCode: 409,
      details: { runId: run.runId, status: run.status }
    });
  }
  return run;
}

/** 读取并严格校验单个后置动作的四元组批次绑定。 */
function readFlowBindings(db, run, runtime) {
  const bindings = [];
  REQUIRED_FLOW_BINDINGS.forEach((definition) => {
    const rows = db.prepare(`SELECT link.artifact_key AS artifactKey, link.batch_role AS batchRole,
        link.import_batch_id AS importBatchId, link.context_id AS contextId,
        context.status AS contextStatus, context.run_id AS contextRunId,
        context.dataset_id AS contextDatasetId, context.manifest_version AS contextManifestVersion,
        context.manifest_digest AS contextManifestDigest, context.runtime_epoch AS contextRuntimeEpoch,
        context.upload_file_sha256 AS uploadFileSha256, context.artifact_file_sha256 AS artifactFileSha256,
        batch.import_type AS importType, batch.status AS batchStatus, batch.audit_phase AS auditPhase,
        batch.file_sha256 AS batchFileSha256
      FROM demo_run_import_batches link
      JOIN demo_import_contexts context ON context.context_id = link.context_id
        AND context.run_id = link.run_id AND context.artifact_key = link.artifact_key
      JOIN import_batches batch ON batch.id = link.import_batch_id
      WHERE link.run_id = ? AND link.artifact_key = ? AND link.batch_role = ?`).all(
      run.runId, definition.artifactKey, definition.batchRole
    );
    if (rows.length !== 1) {
      throw createFlowBlocker('DEMO_FLOW_BINDING_NOT_UNIQUE', `${definition.artifactKey}/${definition.batchRole}`);
    }
    const binding = rows[0];
    const fileDigests = [
      binding.batchFileSha256,
      binding.uploadFileSha256,
      binding.artifactFileSha256
    ];
    if (fileDigests.some((digest) => !DIGEST_PATTERN.test(String(digest || '')))) {
      throw createFlowBlocker('DEMO_FLOW_FILE_SHA_MISSING', `${definition.artifactKey}/${definition.batchRole}`);
    }
    if (new Set(fileDigests).size !== 1) {
      throw createFlowBlocker('DEMO_FLOW_FILE_SHA_MISMATCH', `${definition.artifactKey}/${definition.batchRole}`);
    }
    const selectedSha = binding.batchFileSha256;
    if (binding.contextStatus !== 'executed' || binding.contextRunId !== run.runId
      || binding.contextDatasetId !== run.datasetId || binding.contextManifestVersion !== run.manifestVersion
      || binding.contextManifestDigest !== run.manifestDigest || binding.contextRuntimeEpoch !== runtime.runtimeEpoch
      || binding.importType !== definition.importType
      || !['completed', 'completed_with_errors'].includes(binding.batchStatus)
      || binding.auditPhase !== 'execute') {
      throw createFlowBlocker('DEMO_FLOW_BINDING_STALE', `${definition.artifactKey}/${definition.batchRole}`);
    }
    bindings.push({
      ...definition,
      importBatchId: binding.importBatchId,
      contextId: binding.contextId,
      fileSha256: selectedSha
    });
  });
  return bindings;
}

/** 生成内部 blocker 异常，preview 会持久化而不会猜测输入。 */
function createFlowBlocker(code, binding) {
  return new AppError(code, '能流动作输入绑定不足，后置动作已安全阻断。', {
    statusCode: 409,
    details: { binding }
  });
}

/** 将 ownership 文本主键规范为业务正整数；非规范文本不得被 Number 隐式折叠。 */
function parseOwnedEntityPk(entityPk, entityType) {
  const text = String(entityPk ?? '');
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed) || String(parsed) !== text) {
    throw createFlowBlocker('DEMO_FLOW_OWNERSHIP_EVIDENCE_INVALID', entityType);
  }
  return parsed;
}

/** 精确比较两个实体 ID 集合，任何缺失、额外或重复都安全阻断。 */
function assertExactEntityIdSet(actualRows, expectedRows, code, binding) {
  const actualIds = actualRows.map((row) => String(row.id));
  const expectedIds = expectedRows.map((row) => String(row.id));
  const actualSet = new Set(actualIds);
  const expectedSet = new Set(expectedIds);
  if (actualSet.size !== actualIds.length || expectedSet.size !== expectedIds.length
    || actualSet.size !== expectedSet.size || [...actualSet].some((id) => !expectedSet.has(id))) {
    throw createFlowBlocker(code, binding);
  }
}

/** 从当前 run 的 active registry 读取实体，并精确验证 batch 全集、来源行、身份和静态 snapshot。 */
function readOwnedEntityRows(db, run, binding) {
  const entityType = binding.entityType;
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType];
  const tableName = FLOW_ENTITY_TABLES[entityType];
  if (!handler || typeof handler.readProjection !== 'function' || !tableName) {
    throw createFlowBlocker('DEMO_FLOW_OWNERSHIP_HANDLER_UNAVAILABLE', entityType);
  }
  const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      identity_digest AS identityDigest, snapshot_digest AS snapshotDigest,
      source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ? AND cleaned_at IS NULL
    ORDER BY registry_id`).all(run.runId, binding.artifactKey, entityType);
  if (registryRows.length === 0) throw createFlowBlocker('DEMO_FLOW_ENTITY_MISSING', entityType);
  const entityPks = registryRows.map((row) => parseOwnedEntityPk(row.entityPk, entityType));
  if (new Set(entityPks).size !== entityPks.length) {
    throw createFlowBlocker('DEMO_FLOW_OWNERSHIP_SET_INVALID', entityType);
  }
  const rows = registryRows.map((ownership, index) => {
    const entityPk = entityPks[index];
    if (ownership.runId !== run.runId || ownership.artifactKey !== binding.artifactKey
      || ownership.entityType !== entityType || ownership.sourceBatchId !== binding.importBatchId
      || !Number.isSafeInteger(ownership.sourceRowNumber) || ownership.sourceRowNumber < 1
      || !DIGEST_PATTERN.test(String(ownership.identityDigest || ''))
      || !DIGEST_PATTERN.test(String(ownership.snapshotDigest || ''))) {
      throw createFlowBlocker('DEMO_FLOW_OWNERSHIP_EVIDENCE_INVALID', `${entityType}:${entityPk}`);
    }
    let projection;
    try {
      projection = handler.readProjection(db, entityPk);
    } catch (_error) {
      throw createFlowBlocker('DEMO_FLOW_SNAPSHOT_UNAVAILABLE', entityType);
    }
    if (!projection || Number(projection.id) !== entityPk
      || Number(projection.source_batch_id) !== binding.importBatchId
      || Number(projection.source_row_number) !== ownership.sourceRowNumber) {
      throw createFlowBlocker('DEMO_FLOW_OWNERSHIP_EVIDENCE_INVALID', `${entityType}:${entityPk}`);
    }
    if (calculateDemoEntityIdentityDigest(entityType, String(entityPk)) !== ownership.identityDigest) {
      throw createFlowBlocker('DEMO_FLOW_IDENTITY_DIGEST_MISMATCH', entityType);
    }
    try {
      if (calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection) !== ownership.snapshotDigest) {
        throw createFlowBlocker('DEMO_FLOW_SNAPSHOT_DIGEST_MISMATCH', entityType);
      }
    } catch (error) {
      if (error?.code?.startsWith('DEMO_FLOW_')) throw error;
      throw createFlowBlocker('DEMO_FLOW_SNAPSHOT_UNAVAILABLE', entityType);
    }
    return projection;
  });
  const batchRows = db.prepare(`SELECT id FROM ${tableName}
    WHERE source_batch_id = ? AND source_row_number IS NOT NULL ORDER BY id`).all(binding.importBatchId);
  assertExactEntityIdSet(batchRows, rows, 'DEMO_FLOW_OWNERSHIP_SET_INVALID', `${binding.artifactKey}/${binding.batchRole}`);
  return { rows, registryRows };
}

/** 精确证明当前 run owned registry 的 contains 关系全集与服务端 expected set 相等。 */
function proveEnergyFlowRelationClosure(db, run, ownership, records) {
  const modelOwnership = ownership.model.registryRows[0];
  const registryRows = [
    ...ownership.model.registryRows,
    ...ownership.node.registryRows,
    ...ownership.edge.registryRows,
    ...ownership.record.registryRows
  ];
  const registryByEntity = new Map(registryRows.map((row) => [`${row.entityType}\0${row.entityPk}`, row]));
  const expectedRelations = [];
  const appendExpected = (from, to) => expectedRelations.push({
    fromRegistryId: from.registryId,
    toRegistryId: to.registryId,
    relationType: 'contains',
    fromEntityType: from.entityType,
    fromEntityPk: String(from.entityPk),
    toEntityType: to.entityType,
    toEntityPk: String(to.entityPk)
  });
  [...ownership.node.registryRows, ...ownership.edge.registryRows, ...ownership.record.registryRows]
    .forEach((target) => appendExpected(modelOwnership, target));
  records.forEach((record) => {
    const edgeOwnership = registryByEntity.get(`energy_flow_edge\0${record.energy_flow_edge_id}`);
    const recordOwnership = registryByEntity.get(`energy_flow_record\0${record.id}`);
    if (!edgeOwnership || !recordOwnership) {
      throw createFlowBlocker('DEMO_FLOW_RELATION_CLOSURE_INVALID', 'energy-flow-owned-relations');
    }
    appendExpected(edgeOwnership, recordOwnership);
  });
  const ownedRegistryIds = registryRows.map((row) => Number(row.registryId));
  const placeholders = ownedRegistryIds.map(() => '?').join(', ');
  const relationRows = db.prepare(`SELECT relation.relation_id AS relationId,
      relation.run_id AS relationRunId, relation.from_registry_id AS fromRegistryId,
      relation.to_registry_id AS toRegistryId, relation.relation_type AS relationType,
      source.run_id AS fromRunId, source.entity_type AS fromEntityType, source.entity_pk AS fromEntityPk,
      target.run_id AS toRunId, target.entity_type AS toEntityType, target.entity_pk AS toEntityPk
    FROM demo_data_relations relation
    LEFT JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    LEFT JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.from_registry_id IN (${placeholders}) OR relation.to_registry_id IN (${placeholders})
    ORDER BY relation.relation_id`).all(...ownedRegistryIds, ...ownedRegistryIds);
  if (relationRows.some((relation) => relation.relationRunId !== run.runId
    || relation.fromRunId !== run.runId || relation.toRunId !== run.runId)) {
    throw createFlowBlocker('DEMO_FLOW_RELATION_CROSS_RUN', 'energy-flow-owned-relations');
  }
  const relationKey = (relation) => [
    relation.fromRegistryId,
    relation.toRegistryId,
    relation.relationType,
    relation.fromEntityType,
    String(relation.fromEntityPk),
    relation.toEntityType,
    String(relation.toEntityPk)
  ].join('\0');
  const expectedSet = new Set(expectedRelations.map(relationKey));
  const actualSet = new Set(relationRows.map(relationKey));
  if (expectedSet.size !== expectedRelations.length || actualSet.size !== relationRows.length
    || expectedSet.size !== actualSet.size || [...expectedSet].some((key) => !actualSet.has(key))) {
    throw createFlowBlocker('DEMO_FLOW_RELATION_CLOSURE_INVALID', 'energy-flow-owned-relations');
  }
  return relationRows;
}

/** 读取能流四类 ownership，并精确证明同模型 active topology、窗口事实和关系全集。 */
function resolveEnergyFlowInput(db, run, runtime) {
  if (!EXPLICIT_EDGE_VALUE_SOURCE_TYPE || !ENERGY_FLOW_FORMULA_VERSION) {
    throw createFlowBlocker('DEMO_FLOW_SOURCE_CONTRACT_UNAVAILABLE', 'explicit-edge-value');
  }
  const bindings = readFlowBindings(db, run, runtime);
  const byRole = new Map(bindings.map((binding) => [`${binding.batchRole}:${binding.artifactKey}`, binding]));
  const ownership = {
    model: readOwnedEntityRows(db, run, byRole.get('primary:22-energy-flow-models')),
    node: readOwnedEntityRows(db, run, byRole.get('primary:23-energy-flow-nodes')),
    edge: readOwnedEntityRows(db, run, byRole.get('edge:24-energy-flow-edges')),
    record: readOwnedEntityRows(db, run, byRole.get('record:24-energy-flow-edges'))
  };
  const models = ownership.model.rows;
  const nodes = ownership.node.rows;
  const edges = ownership.edge.rows;
  const records = ownership.record.rows;
  if (models.length !== 1) throw createFlowBlocker('DEMO_FLOW_MODEL_NOT_UNIQUE', '22-energy-flow-models/primary');
  const model = models[0];
  if (model.status !== 'active') throw createFlowBlocker('DEMO_FLOW_ENTITY_STATE_INVALID', 'energy_flow_model');
  if (nodes.some((node) => node.status !== 'active' || Number(node.energy_flow_model_id) !== Number(model.id))) {
    throw createFlowBlocker('DEMO_FLOW_MODEL_CLOSURE_INVALID', '23-energy-flow-nodes/primary');
  }
  const activeNodes = db.prepare(`SELECT id FROM energy_flow_nodes
    WHERE energy_flow_model_id = ? AND status = 'active' ORDER BY id`).all(model.id);
  assertExactEntityIdSet(activeNodes, nodes, 'DEMO_FLOW_TOPOLOGY_NODE_SET_INVALID', '23-energy-flow-nodes/primary');
  const ownedNodeIds = new Set(nodes.map((node) => Number(node.id)));
  if (edges.some((edge) => edge.source_type !== EXPLICIT_EDGE_VALUE_SOURCE_TYPE)) {
    throw createFlowBlocker('DEMO_FLOW_SOURCE_TYPE_INVALID', '24-energy-flow-edges/edge');
  }
  if (edges.some((edge) => edge.status !== 'active'
    || Number(edge.energy_flow_model_id) !== Number(model.id)
    || !ownedNodeIds.has(Number(edge.from_node_id)) || !ownedNodeIds.has(Number(edge.to_node_id)))) {
    throw createFlowBlocker('DEMO_FLOW_EDGE_NODE_CLOSURE_INVALID', '24-energy-flow-edges/edge');
  }
  const activeEdges = db.prepare(`SELECT id FROM energy_flow_edges
    WHERE energy_flow_model_id = ? AND status = 'active' ORDER BY id`).all(model.id);
  assertExactEntityIdSet(activeEdges, edges, 'DEMO_FLOW_TOPOLOGY_EDGE_SET_INVALID', '24-energy-flow-edges/edge');
  const ownedEdgeIds = new Set(edges.map((edge) => Number(edge.id)));
  if (records.length === 0) throw createFlowBlocker('DEMO_FLOW_RECORD_MISSING', '24-energy-flow-edges/record');
  if (records.some((record) => record.source_type !== EXPLICIT_EDGE_VALUE_SOURCE_TYPE
    || record.formula_version !== ENERGY_FLOW_FORMULA_VERSION)) {
    throw createFlowBlocker('DEMO_FLOW_SOURCE_TYPE_INVALID', '24-energy-flow-edges/record');
  }
  if (records.some((record) => record.record_status !== 'active'
    || Number(record.energy_flow_model_id) !== Number(model.id)
    || !ownedEdgeIds.has(Number(record.energy_flow_edge_id)))) {
    throw createFlowBlocker('DEMO_FLOW_RECORD_EDGE_CLOSURE_INVALID', '24-energy-flow-edges/record');
  }
  const startUtc = records.reduce((value, row) => (!value || row.start_utc < value ? row.start_utc : value), null);
  const endUtc = records.reduce((value, row) => (!value || row.end_utc > value ? row.end_utc : value), null);
  const overlappingRecords = db.prepare(`SELECT id FROM energy_flow_records
    WHERE energy_flow_model_id = ? AND record_status = 'active'
      AND start_utc < ? AND end_utc > ? ORDER BY id`).all(model.id, endUtc, startUtc);
  assertExactEntityIdSet(overlappingRecords, records, 'DEMO_FLOW_TOPOLOGY_RECORD_SET_INVALID', '24-energy-flow-edges/record');
  const recordsByEdge = new Map();
  records.forEach((record) => {
    const edgeId = Number(record.energy_flow_edge_id);
    if (!recordsByEdge.has(edgeId)) recordsByEdge.set(edgeId, []);
    recordsByEdge.get(edgeId).push(record);
  });
  recordsByEdge.forEach((edgeRecords) => {
    edgeRecords.sort((left, right) => left.start_utc.localeCompare(right.start_utc) || left.end_utc.localeCompare(right.end_utc));
    if (edgeRecords[0].start_utc !== startUtc || edgeRecords[edgeRecords.length - 1].end_utc !== endUtc
      || edgeRecords.some((record, index) => index > 0 && edgeRecords[index - 1].end_utc !== record.start_utc)) {
      throw createFlowBlocker('DEMO_FLOW_TIME_CLOSURE_INVALID', '24-energy-flow-edges/record');
    }
  });
  const relationRows = proveEnergyFlowRelationClosure(db, run, ownership, records);
  const registryRows = [
    ...ownership.model.registryRows,
    ...ownership.node.registryRows,
    ...ownership.edge.registryRows,
    ...ownership.record.registryRows
  ];
  const input = {
    modelId: Number(model.id),
    startUtc,
    endUtc,
    bindings: bindings.map(({ artifactKey, batchRole, importType, importBatchId, contextId, fileSha256 }) => ({ artifactKey, batchRole, importType, importBatchId, contextId, fileSha256 })),
    entityEvidence: registryRows.map((row) => ({
      entityType: row.entityType,
      entityPk: row.entityPk,
      registryId: row.registryId,
      sourceBatchId: row.sourceBatchId,
      sourceRowNumber: row.sourceRowNumber,
      identityDigest: row.identityDigest,
      snapshotDigest: row.snapshotDigest
    })),
    relations: relationRows
  };
  return { input, modelId: Number(model.id), startUtc, endUtc, bindings, model, nodes, edges, records };
}

/** 生成 meter resolver 的稳定 blocker，不返回数据库、文件或 ownership 详情。 */
function createMeterBlocker(code, binding = '08-meter-readings-2026-08/primary') {
  return new AppError(code, '抄表动作输入证据不足，后置动作已安全阻断。', {
    statusCode: 409,
    details: { binding }
  });
}

/** 将 meter ownership 主键解析为 canonical 正整数，拒绝隐式字符串折叠。 */
function parseMeterOwnedEntityPk(entityPk) {
  const text = String(entityPk ?? '');
  const value = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value) || String(value) !== text) {
    throw createMeterBlocker('DEMO_METER_OWNERSHIP_EVIDENCE_INVALID');
  }
  return value;
}

/** 读取当前 run artifact 08 的唯一 primary batch/context，并校验文件、运行期和审计绑定。 */
function readMeterReadingBinding(db, run, runtime, actorUserId) {
  const artifact = getDemoArtifactRegistration(REQUIRED_METER_BINDING.artifactKey);
  if (!artifact || artifact.handlerKey !== REQUIRED_METER_BINDING.handlerKey
    || !artifact.batchRoles.some((role) => role.role === 'primary' && role.entityType === 'meter_reading')) {
    throw createMeterBlocker('DEMO_METER_ARTIFACT_CONTRACT_UNAVAILABLE');
  }
  const rows = db.prepare(`SELECT link.artifact_key AS artifactKey, link.batch_role AS batchRole,
      link.import_batch_id AS importBatchId, link.context_id AS contextId,
      context.status AS contextStatus, context.run_id AS contextRunId,
      context.dataset_id AS contextDatasetId, context.manifest_version AS contextManifestVersion,
      context.manifest_digest AS contextManifestDigest, context.runtime_epoch AS contextRuntimeEpoch,
      context.upload_file_sha256 AS uploadFileSha256, context.artifact_file_sha256 AS artifactFileSha256,
      context.handler_key AS handlerKey, context.issued_to_user_id AS issuedToUserId,
      batch.import_type AS importType, batch.status AS batchStatus,
      batch.audit_phase AS auditPhase, batch.file_sha256 AS batchFileSha256
    FROM demo_run_import_batches link
    JOIN demo_import_contexts context ON context.context_id = link.context_id
      AND context.run_id = link.run_id AND context.artifact_key = link.artifact_key
    JOIN import_batches batch ON batch.id = link.import_batch_id
    WHERE link.run_id = ? AND link.artifact_key = ? AND link.batch_role = 'primary'`).all(
    run.runId, REQUIRED_METER_BINDING.artifactKey
  );
  if (rows.length !== 1) throw createMeterBlocker('DEMO_METER_BINDING_NOT_UNIQUE');
  const binding = rows[0];
  const digests = [binding.batchFileSha256, binding.uploadFileSha256, binding.artifactFileSha256];
  if (digests.some((digest) => !DIGEST_PATTERN.test(String(digest || '')))) {
    throw createMeterBlocker('DEMO_METER_FILE_SHA_MISSING');
  }
  if (new Set(digests).size !== 1) throw createMeterBlocker('DEMO_METER_FILE_SHA_MISMATCH');
  if (binding.artifactKey !== REQUIRED_METER_BINDING.artifactKey
    || binding.batchRole !== REQUIRED_METER_BINDING.batchRole
    || binding.handlerKey !== REQUIRED_METER_BINDING.handlerKey
    || binding.contextStatus !== 'executed'
    || binding.contextRunId !== run.runId
    || binding.contextDatasetId !== run.datasetId
    || binding.contextManifestVersion !== run.manifestVersion
    || binding.contextManifestDigest !== run.manifestDigest
    || (actorUserId !== undefined && Number(binding.issuedToUserId) !== Number(actorUserId))
    || Number(binding.contextRuntimeEpoch) !== Number(runtime.runtimeEpoch)
    || binding.importType !== REQUIRED_METER_BINDING.importType
    || !['completed', 'completed_with_errors'].includes(binding.batchStatus)
    || binding.auditPhase !== 'execute') {
    throw createMeterBlocker('DEMO_METER_BINDING_STALE');
  }
  return {
    artifactKey: binding.artifactKey,
    batchRole: binding.batchRole,
    importType: binding.importType,
    importBatchId: Number(binding.importBatchId),
    contextId: binding.contextId,
    fileSha256: binding.batchFileSha256
  };
}

/** 从当前 run 的 imported meter ownership 精确闭包解析 reading IDs，禁止按批次猜测或跨 run 取数。 */
function readMeterReadingOwnershipClosure(db, run, binding) {
  const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = 'meter_reading'
      AND cleaned_at IS NULL ORDER BY registry_id`).all(run.runId, binding.artifactKey);
  if (registryRows.length === 0) throw createMeterBlocker('DEMO_METER_OWNERSHIP_MISSING');
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS.meter_reading;
  const rows = registryRows.map((ownership) => {
    const entityPk = parseMeterOwnedEntityPk(ownership.entityPk);
    if (ownership.runId !== run.runId || ownership.artifactKey !== binding.artifactKey
      || ownership.entityType !== 'meter_reading' || ownership.ownershipKind !== 'imported'
      || Number(ownership.sourceBatchId) !== binding.importBatchId || ownership.sourceRowNumber !== null
      || ownership.identityDigest !== calculateDemoEntityIdentityDigest('meter_reading', String(entityPk))) {
      throw createMeterBlocker('DEMO_METER_OWNERSHIP_EVIDENCE_INVALID');
    }
    const projection = handler.readProjection(db, entityPk);
    if (!projection || Number(projection.id) !== entityPk
      || Number(projection.source_batch_id) !== binding.importBatchId) {
      throw createMeterBlocker('DEMO_METER_OWNERSHIP_EVIDENCE_INVALID');
    }
    try {
      if (calculateDemoEntitySnapshotDigest('meter_reading', String(entityPk), projection) !== ownership.snapshotDigest) {
        throw createMeterBlocker('DEMO_METER_SNAPSHOT_DIGEST_MISMATCH');
      }
    } catch (error) {
      if (error?.code?.startsWith('DEMO_METER_')) throw error;
      throw createMeterBlocker('DEMO_METER_SNAPSHOT_UNAVAILABLE');
    }
    return projection;
  });
  const batchRows = db.prepare(`SELECT id FROM meter_reading_records
    WHERE source_batch_id = ? ORDER BY id`).all(binding.importBatchId);
  const actualIds = batchRows.map((row) => String(row.id));
  const expectedIds = rows.map((row) => String(row.id));
  const actualSet = new Set(actualIds);
  const expectedSet = new Set(expectedIds);
  if (actualSet.size !== actualIds.length || expectedSet.size !== expectedIds.length
    || actualSet.size !== expectedSet.size || [...actualSet].some((id) => !expectedSet.has(id))) {
    throw createMeterBlocker('DEMO_METER_OWNERSHIP_SET_INVALID');
  }
  return { rows, registryRows };
}

/** 证明 meter imported ownership、已有 derived energy ownership 与 generated_from 关系形成精确闭包。 */
function proveMeterReadingRelationClosure(db, run, binding, ownership) {
  const readingRegistryByPk = new Map(ownership.registryRows.map((row) => [String(row.entityPk), row]));
  const generatedReadingRows = ownership.rows.filter((row) => row.generated_energy_record_id !== null);
  const expectedEnergyIds = generatedReadingRows.map((row) => String(row.generated_energy_record_id));
  const derivedRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = 'energy_record'
      AND ownership_kind = 'derived' AND cleaned_at IS NULL ORDER BY registry_id`).all(
    run.runId, binding.artifactKey
  );
  const actualEnergyIds = derivedRows.map((row) => String(row.entityPk));
  const actualEnergySet = new Set(actualEnergyIds);
  const expectedEnergySet = new Set(expectedEnergyIds);
  if (actualEnergySet.size !== actualEnergyIds.length || expectedEnergySet.size !== expectedEnergyIds.length
    || actualEnergySet.size !== expectedEnergySet.size
    || [...actualEnergySet].some((id) => !expectedEnergySet.has(id))) {
    throw createMeterBlocker('DEMO_METER_DERIVED_OWNERSHIP_SET_INVALID');
  }
  const derivedByPk = new Map();
  derivedRows.forEach((registry) => {
    const entityPk = parseMeterOwnedEntityPk(registry.entityPk);
    if (registry.runId !== run.runId || registry.artifactKey !== binding.artifactKey
      || registry.entityType !== 'energy_record' || registry.ownershipKind !== 'derived'
      || Number(registry.sourceBatchId) !== binding.importBatchId || registry.sourceRowNumber !== null
      || registry.identityDigest !== calculateDemoEntityIdentityDigest('energy_record', String(entityPk))) {
      throw createMeterBlocker('DEMO_METER_DERIVED_OWNERSHIP_INVALID');
    }
    const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_record.readProjection(db, entityPk);
    if (!projection || Number(projection.id) !== entityPk || projection.source_batch_id !== null
      || projection.source_row_number !== null) {
      throw createMeterBlocker('DEMO_METER_DERIVED_OUTPUT_INVALID');
    }
    try {
      if (calculateDemoEntitySnapshotDigest('energy_record', String(entityPk), projection) !== registry.snapshotDigest) {
        throw createMeterBlocker('DEMO_METER_DERIVED_SNAPSHOT_DIGEST_MISMATCH');
      }
    } catch (error) {
      if (error?.code?.startsWith('DEMO_METER_')) throw error;
      throw createMeterBlocker('DEMO_METER_DERIVED_SNAPSHOT_UNAVAILABLE');
    }
    derivedByPk.set(String(entityPk), { registry, projection });
  });
  const expectedRelations = generatedReadingRows.map((reading) => {
    const source = readingRegistryByPk.get(String(reading.id));
    const output = derivedByPk.get(String(reading.generated_energy_record_id));
    if (!source || !output || Number(output.projection.meter_device_id) !== Number(reading.meter_device_id)
      || Number(output.projection.energy_type_id) !== Number(reading.energy_type_id)
      || Number(output.projection.organization_unit_id) !== Number(reading.organization_unit_id)
      || output.projection.normalized_month !== reading.normalized_month
      || output.projection.normalized_unit !== reading.normalized_unit
      || Number(output.projection.normalized_value) !== Number(reading.normalized_usage_value)
      || typeof output.projection.remark !== 'string'
      || !output.projection.remark.includes(`meter_reading_record_id=${reading.id}`)) {
      throw createMeterBlocker('DEMO_METER_DERIVED_OUTPUT_SOURCE_MISMATCH');
    }
    return {
      fromRegistryId: Number(output.registry.registryId),
      toRegistryId: Number(source.registryId),
      relationType: 'generated_from'
    };
  });
  const registryIds = [
    ...ownership.registryRows.map((row) => Number(row.registryId)),
    ...derivedRows.map((row) => Number(row.registryId))
  ];
  const placeholders = registryIds.map(() => '?').join(', ');
  const relationRows = db.prepare(`SELECT relation.relation_id AS relationId,
      relation.run_id AS relationRunId, relation.from_registry_id AS fromRegistryId,
      relation.to_registry_id AS toRegistryId, relation.relation_type AS relationType,
      source.run_id AS fromRunId, target.run_id AS toRunId
    FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.from_registry_id IN (${placeholders}) OR relation.to_registry_id IN (${placeholders})
    ORDER BY relation.relation_id`).all(...registryIds, ...registryIds);
  const relationKey = (relation) => [
    Number(relation.fromRegistryId), Number(relation.toRegistryId), relation.relationType
  ].join('\0');
  const expectedSet = new Set(expectedRelations.map(relationKey));
  const actualSet = new Set(relationRows.map(relationKey));
  if (relationRows.some((relation) => relation.relationRunId !== run.runId
    || relation.fromRunId !== run.runId || relation.toRunId !== run.runId)
    || expectedSet.size !== expectedRelations.length || actualSet.size !== relationRows.length
    || expectedSet.size !== actualSet.size || [...expectedSet].some((key) => !actualSet.has(key))) {
    throw createMeterBlocker('DEMO_METER_RELATION_CLOSURE_INVALID');
  }
  return relationRows;
}

/** 由真实 batch/context/ownership 证据解析 meter 精确输入，并冻结领域 preview 摘要。 */
function resolveMeterReadingActionAdapterInput(db, run, runtime, actorUserId) {
  const binding = readMeterReadingBinding(db, run, runtime, actorUserId);
  const ownership = readMeterReadingOwnershipClosure(db, run, binding);
  const relationRows = proveMeterReadingRelationClosure(db, run, binding, ownership);
  const readingIds = ownership.rows.map((row) => Number(row.id)).sort((left, right) => left - right);
  const preview = buildMeterReadingEnergyRecordGenerationExactPreviewWithDb(db, readingIds);
  const months = [...new Set(ownership.rows.map((row) => row.normalized_month))].sort();
  return {
    domainInput: {
      readingIds,
      expectedExactScopeDigest: preview.exactScopeDigest,
      sourceArtifactKey: binding.artifactKey,
      sourceBatchRole: binding.batchRole,
      months
    },
    evidence: {
      sourceBinding: binding,
      sourceOwnership: ownership.registryRows.map((row) => ({
        registryId: row.registryId,
        entityPk: row.entityPk,
        identityDigest: row.identityDigest,
        snapshotDigest: row.snapshotDigest,
        sourceBatchId: row.sourceBatchId,
        sourceRowNumber: row.sourceRowNumber
      })),
      relations: relationRows.map((row) => ({
        relationId: row.relationId,
        fromRegistryId: row.fromRegistryId,
        toRegistryId: row.toRegistryId,
        relationType: row.relationType
      })),
      exactScopeDigest: preview.exactScopeDigest
    }
  };
}

/** 预演时重新调用正式 meter 分类算法，确保 resolver 摘要与领域状态一致。 */
function probeMeterReadingAction(context) {
  const preview = buildMeterReadingEnergyRecordGenerationExactPreviewWithDb(context.db, context.domainInput.readingIds);
  if (preview.exactScopeDigest !== context.domainInput.expectedExactScopeDigest) {
    throw new AppError('DEMO_METER_INPUT_STALE', '抄表输入在预演过程中发生变化。', { statusCode: 409 });
  }
  return {
    result: {
      source: { artifactKey: REQUIRED_METER_BINDING.artifactKey, batchRole: REQUIRED_METER_BINDING.batchRole },
      months: context.domainInput.months,
      summary: preview.summary,
      outputCount: 0
    },
    outputCount: 0,
    outputs: []
  };
}

/** execute 领取前后都重新解析完整 meter 证据，拒绝陈旧或跨 run 输入。 */
function revalidateMeterReadingAction(context) {
  const resolved = resolveMeterReadingActionAdapterInput(
    context.db,
    context.run,
    context.runtime,
    context.actorUserId
  );
  return resolved;
}

/** 只在领域预演确认存在可生成记录时，于 outer transaction 之外准备正式备份证据。 */
function prepareMeterReadingActionBackup(context) {
  const preview = buildMeterReadingEnergyRecordGenerationExactPreviewWithDb(context.db, context.domainInput.readingIds);
  if (preview.exactScopeDigest !== context.domainInput.expectedExactScopeDigest) {
    throw new AppError('DEMO_METER_INPUT_STALE', '抄表输入在备份准备前发生变化。', { statusCode: 409 });
  }
  return preview.summary.wouldGenerate > 0 ? prepareMeterReadingGenerationBackupEvidence() : null;
}

/** 在同一 outer transaction 内调用正式 meter service，并原子登记 derived ownership/relation。 */
function executeMeterReadingAction(context) {
  const execution = executeMeterReadingEnergyRecordGenerationExact({
    db: context.db,
    readingIds: context.domainInput.readingIds,
    expectedExactScopeDigest: context.domainInput.expectedExactScopeDigest,
    backupEvidence: context.backupEvidence,
    actorUserId: context.actorUserId,
    actorIp: context.actorIp,
    actionRunId: context.actionRunId
  });
  const ownership = registerDerivedMeterEnergyRecordsInTransaction({
    db: context.db,
    runId: context.run.runId,
    actionRunId: context.actionRunId,
    actorUserId: context.actorUserId,
    generatedPairs: execution.generatedPairs
  });
  if (ownership.registrationCount !== execution.generatedPairs.length
    || ownership.relationCount !== execution.generatedPairs.length) {
    throw new AppError('DEMO_METER_OWNERSHIP_RESULT_MISMATCH', '抄表派生 ownership 登记数量与领域生成结果不一致。', { statusCode: 409 });
  }
  return {
    result: {
      source: { artifactKey: REQUIRED_METER_BINDING.artifactKey, batchRole: REQUIRED_METER_BINDING.batchRole },
      months: context.domainInput.months,
      generated: execution.generated,
      updatedReadings: execution.updatedReadings,
      skipped: execution.skipped,
      summary: execution.summary
    },
    outputCount: execution.generatedPairs.length,
    outputs: execution.generatedPairs.map((pair) => ({
      outputEntityType: 'energy_record',
      outputEntityId: String(pair.energyRecordId),
      outputRef: { month: pair.normalizedMonth, unit: pair.normalizedUnit, value: pair.normalizedValue }
    }))
  };
}

/** meter public input 仅返回 artifact、批次角色、数量和月份摘要。 */
function projectMeterReadingPublicInput(input = {}) {
  return {
    source: { artifactKey: REQUIRED_METER_BINDING.artifactKey, batchRole: REQUIRED_METER_BINDING.batchRole },
    readingCount: Array.isArray(input.readingIds) ? input.readingIds.length : 0,
    months: Array.isArray(input.months) ? [...input.months] : []
  };
}

/** meter public result 仅保留安全统计和来源摘要，不返回任何实体主键或内部摘要。 */
function projectMeterReadingPublicResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    source: { artifactKey: REQUIRED_METER_BINDING.artifactKey, batchRole: REQUIRED_METER_BINDING.batchRole },
    months: Array.isArray(result.months) ? [...result.months] : [],
    generated: Number(result.generated || 0),
    updatedReadings: Number(result.updatedReadings || 0),
    skipped: Number(result.skipped || 0),
    summary: result.summary && typeof result.summary === 'object' ? {
      totalScanned: Number(result.summary.totalScanned || 0),
      wouldGenerate: Number(result.summary.wouldGenerate || 0),
      conflict: Number(result.summary.conflict || 0),
      void: Number(result.summary.void || 0),
      alreadyGenerated: Number(result.summary.alreadyGenerated || 0),
      missingLedger: Number(result.summary.missingLedger || 0),
      invalidUnit: Number(result.summary.invalidUnit || 0),
      blocked: Number(result.summary.blocked || 0),
      skipped: Number(result.summary.skipped || 0)
    } : null
  };
}

/** 将 meter resolver/领域异常映射为稳定 blocker，禁止向公共 DTO 暴露内部详情。 */
function mapMeterReadingPreviewBlocker(error) {
  const code = typeof error?.code === 'string' && /^DEMO_METER_[A-Z0-9_:-]{1,120}$/.test(error.code)
    ? error.code
    : 'DEMO_METER_INPUT_BLOCKED';
  return { code, message: '服务端无法证明当前 run 的 artifact 08 抄表输入闭包，已安全阻断。' };
}

/** 能流 adapter 的统一复核入口，保持通用 lifecycle 不含领域专用分支。 */
function revalidateEnergyFlowAction(context) {
  return resolveEnergyFlowActionAdapterInput(context.db, context.run, context.runtime);
}

/** 生成策略 adapter 的稳定内部 blocker，不返回 batch、ID 或 digest 细节。 */
function createStrategyBlocker(code, binding = 'strategy-evaluation') {
  return new AppError(code, '策略评价动作输入证据不足，后置动作已安全阻断。', {
    statusCode: 409,
    details: { binding }
  });
}

/** 将策略 ownership 主键规范为 canonical 正整数，拒绝隐式 Number 折叠。 */
function parseStrategyOwnedEntityPk(entityPk, entityType) {
  const text = String(entityPk ?? '');
  const value = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value) || String(value) !== text) {
    throw createStrategyBlocker('DEMO_STRATEGY_OWNERSHIP_EVIDENCE_INVALID', entityType);
  }
  return value;
}

/** 读取并校验策略动作的 artifact、context 和 import batch 唯一绑定。 */
function readStrategyBindings(db, run, runtime, actorUserId) {
  return REQUIRED_STRATEGY_BINDINGS.map((definition) => {
    const artifact = getDemoArtifactRegistration(definition.artifactKey);
    if (!artifact || artifact.handlerKey !== definition.handlerKey
      || !artifact.batchRoles.some((role) => role.role === definition.batchRole && role.entityType === definition.entityType)
      || artifact.downloadLifecycle !== 'managed-context-auto-runtime') {
      throw createStrategyBlocker('DEMO_STRATEGY_ARTIFACT_CONTRACT_UNAVAILABLE', definition.artifactKey);
    }
    const rows = db.prepare(`SELECT link.artifact_key AS artifactKey, link.batch_role AS batchRole,
        link.import_batch_id AS importBatchId, link.context_id AS contextId,
        context.status AS contextStatus, context.run_id AS contextRunId,
        context.dataset_id AS contextDatasetId, context.manifest_version AS contextManifestVersion,
        context.manifest_digest AS contextManifestDigest, context.runtime_epoch AS contextRuntimeEpoch,
        context.upload_file_sha256 AS uploadFileSha256, context.artifact_file_sha256 AS artifactFileSha256,
        context.handler_key AS contextHandlerKey, context.issued_to_user_id AS issuedToUserId,
        batch.import_type AS importType, batch.status AS batchStatus, batch.audit_phase AS auditPhase,
        batch.file_sha256 AS batchFileSha256
      FROM demo_run_import_batches link
      JOIN demo_import_contexts context ON context.context_id = link.context_id
        AND context.run_id = link.run_id AND context.artifact_key = link.artifact_key
      JOIN import_batches batch ON batch.id = link.import_batch_id
      WHERE link.run_id = ? AND link.artifact_key = ? AND link.batch_role = ?`).all(
      run.runId, definition.artifactKey, definition.batchRole
    );
    if (rows.length !== 1) throw createStrategyBlocker('DEMO_STRATEGY_BINDING_NOT_UNIQUE', definition.artifactKey);
    const binding = rows[0];
    const digests = [binding.batchFileSha256, binding.uploadFileSha256, binding.artifactFileSha256];
    if (digests.some((digest) => !DIGEST_PATTERN.test(String(digest || '')))) {
      throw createStrategyBlocker('DEMO_STRATEGY_FILE_SHA_MISSING', definition.artifactKey);
    }
    if (new Set(digests).size !== 1) throw createStrategyBlocker('DEMO_STRATEGY_FILE_SHA_MISMATCH', definition.artifactKey);
    if (binding.artifactKey !== definition.artifactKey || binding.batchRole !== definition.batchRole
      || binding.contextHandlerKey !== definition.handlerKey || binding.contextStatus !== 'executed'
      || binding.contextRunId !== run.runId || binding.contextDatasetId !== run.datasetId
      || binding.contextManifestVersion !== run.manifestVersion || binding.contextManifestDigest !== run.manifestDigest
      || Number(binding.contextRuntimeEpoch) !== Number(runtime.runtimeEpoch)
      || Number(binding.issuedToUserId) !== Number(actorUserId)
      || binding.importType !== definition.importType
      || !['completed', 'completed_with_errors'].includes(binding.batchStatus)
      || binding.auditPhase !== 'execute') {
      throw createStrategyBlocker('DEMO_STRATEGY_BINDING_STALE', definition.artifactKey);
    }
    return {
      artifactKey: definition.artifactKey,
      batchRole: definition.batchRole,
      handlerKey: definition.handlerKey,
      importType: definition.importType,
      entityType: definition.entityType,
      tableName: definition.tableName,
      importBatchId: Number(binding.importBatchId),
      contextId: binding.contextId,
      fileSha256: binding.batchFileSha256
    };
  });
}

/** 精确读取当前 run 的 imported ownership，并双向比对来源批次实体全集。 */
function readStrategyOwnershipClosure(db, run, binding) {
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[binding.entityType];
  if (!handler || typeof handler.readProjection !== 'function') {
    throw createStrategyBlocker('DEMO_STRATEGY_OWNERSHIP_HANDLER_UNAVAILABLE', binding.entityType);
  }
  const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = ? AND entity_type = ? AND cleaned_at IS NULL
    ORDER BY registry_id`).all(run.runId, binding.artifactKey, binding.entityType);
  if (registryRows.length === 0) throw createStrategyBlocker('DEMO_STRATEGY_OWNERSHIP_MISSING', binding.entityType);
  const rows = registryRows.map((ownership) => {
    const entityPk = parseStrategyOwnedEntityPk(ownership.entityPk, binding.entityType);
    if (ownership.runId !== run.runId || ownership.artifactKey !== binding.artifactKey
      || ownership.entityType !== binding.entityType || ownership.ownershipKind !== 'imported'
      || Number(ownership.sourceBatchId) !== binding.importBatchId
      || !Number.isSafeInteger(ownership.sourceRowNumber) || ownership.sourceRowNumber < 1
      || !DIGEST_PATTERN.test(String(ownership.identityDigest || ''))
      || !DIGEST_PATTERN.test(String(ownership.snapshotDigest || ''))
      || ownership.identityDigest !== calculateDemoEntityIdentityDigest(binding.entityType, String(entityPk))) {
      throw createStrategyBlocker('DEMO_STRATEGY_OWNERSHIP_EVIDENCE_INVALID', binding.entityType);
    }
    let projection;
    try {
      projection = handler.readProjection(db, entityPk);
      if (!projection || Number(projection.id) !== entityPk
        || Number(projection.source_batch_id) !== binding.importBatchId
        || Number(projection.source_row_number) !== ownership.sourceRowNumber
        || calculateDemoEntitySnapshotDigest(binding.entityType, String(entityPk), projection) !== ownership.snapshotDigest) {
        throw createStrategyBlocker('DEMO_STRATEGY_SNAPSHOT_DIGEST_MISMATCH', binding.entityType);
      }
    } catch (error) {
      if (error?.code?.startsWith('DEMO_STRATEGY_')) throw error;
      throw createStrategyBlocker('DEMO_STRATEGY_SNAPSHOT_UNAVAILABLE', binding.entityType);
    }
    return projection;
  });
  const batchRows = db.prepare(`SELECT id, source_row_number AS sourceRowNumber
    FROM ${binding.tableName} WHERE source_batch_id = ? ORDER BY id`).all(binding.importBatchId);
  const actualIds = batchRows.map((row) => String(row.id));
  const expectedIds = rows.map((row) => String(row.id));
  const actualSet = new Set(actualIds);
  const expectedSet = new Set(expectedIds);
  if (actualSet.size !== actualIds.length || expectedSet.size !== expectedIds.length
    || actualSet.size !== expectedSet.size || [...actualSet].some((id) => !expectedSet.has(id))) {
    throw createStrategyBlocker('DEMO_STRATEGY_OWNERSHIP_SET_INVALID', binding.entityType);
  }
  if (new Set(rows.map((row) => Number(row.source_row_number))).size !== rows.length) {
    throw createStrategyBlocker('DEMO_STRATEGY_SOURCE_ROWS_INVALID', binding.entityType);
  }
  return { rows, registryRows };
}

/** 验证当前 run 的 active derived registry 及其业务 projection 完全一致。 */
function readVerifiedStrategyDerivedProjection(db, run, registry) {
  if (!registry || registry.runId !== run.runId || registry.ownershipKind !== 'derived'
    || registry.artifactKey !== '18-strategy-rules' || registry.cleanedAt !== null
    || registry.sourceBatchId !== null || registry.sourceRowNumber !== null
    || !Number.isSafeInteger(Number(registry.registeredBy)) || Number(registry.registeredBy) < 1
    || !['strategy_evaluation_run', 'strategy_rule_hit'].includes(registry.entityType)) return null;
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[registry.entityType];
  if (!handler || typeof handler.readProjection !== 'function'
    || typeof handler.validateProjectionRow !== 'function') return null;
  let projection;
  try {
    projection = handler.readProjection(db, String(registry.entityPk));
    if (!projection || String(projection.id) !== String(registry.entityPk)) return null;
    handler.validateProjectionRow(projection);
    if (registry.identityDigest !== calculateDemoEntityIdentityDigest(
      registry.entityType,
      String(registry.entityPk)
    ) || registry.snapshotDigest !== calculateDemoEntitySnapshotDigest(
      registry.entityType,
      String(registry.entityPk),
      projection
    )) return null;
  } catch (_error) {
    return null;
  }
  return projection;
}

/** 生成持久 relation 的 registry 端点键。 */
function buildStrategyRegistryRelationKey(fromRegistryId, toRegistryId, relationType) {
  return `${Number(fromRegistryId)}\\0${Number(toRegistryId)}\\0${relationType}`;
}

/** 判断解析后的 JSON 是否为普通 object，拒绝数组和原型对象。 */
function isPlainJsonObject(value) {
  return value !== null && typeof value === 'object'
    && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 将已验证命中的 evidence 快照与当前 imported strategy rule 的正式配置绑定。 */
function isStrategyHitEvidenceBoundToRule(hit, rule) {
  if (!hit || !rule || String(rule.id) !== String(hit.strategy_rule_id)
    || rule.status !== 'active'
    || !RULE_MATCH_STATUSES.includes(hit.match_status)
    || !RULE_PRIORITIES.includes(hit.priority)
    || hit.priority !== rule.priority) return false;
  try {
    DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_rule.validateProjectionRow(rule);
    const evidenceSnapshot = JSON.parse(hit.evidence_json);
    const thresholdSnapshot = JSON.parse(hit.threshold_snapshot_json);
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
    if (!isPlainJsonObject(evidenceSnapshot)
      || !isPlainJsonObject(thresholdSnapshot)
      || stableDigest(thresholdSnapshot) !== stableDigest(expectedThreshold)
      || evidenceSnapshot.recommendation !== rule.recommendation_text
      || evidenceSnapshot.source !== rule.source
      || !isPlainJsonObject(evidenceSnapshot.effectiveRange)
      || evidenceSnapshot.effectiveRange.startUtc !== rule.effective_start_utc
      || evidenceSnapshot.effectiveRange.endUtc !== rule.effective_end_utc
      || evidenceSnapshot.effectiveRange.sourceTimeZone !== rule.source_timezone
      || !Array.isArray(evidenceSnapshot.evidence)
      || evidenceSnapshot.evidence[3] !== `metric:${rule.metric_code}`
      || !isPlainJsonObject(evidenceSnapshot.automationBoundary)
      || stableDigest(evidenceSnapshot.automationBoundary)
        !== stableDigest(STRATEGY_OUTPUT_AUTOMATION_BOUNDARY)) return false;
    const expectedEvidenceRequirements = parseEvidenceRequirements(
      rule.evidence_requirements_json
    );
    return expectedEvidenceRequirements.valid
      && stableDigest(evidenceSnapshot.evidenceRequirements)
        === stableDigest(expectedEvidenceRequirements.requirements);
  } catch (_error) {
    return false;
  }
}

/** 严格验证 strategy action outputRef 与已验证命中、规则身份和状态优先级的绑定。 */
function isValidStrategyActionOutputRef(outputRef, hit, rule) {
  const outputRefFields = isPlainJsonObject(outputRef)
    ? Object.keys(outputRef).sort()
    : [];
  const expectedOutputRefFields = [...STRATEGY_OUTPUT_REF_FIELDS].sort();
  if (!isPlainJsonObject(outputRef)
    || outputRefFields.length !== expectedOutputRefFields.length
    || outputRefFields.some((fieldName, index) => fieldName !== expectedOutputRefFields[index])
    || !hit || !rule
    || !RULE_MATCH_STATUSES.includes(hit.match_status)
    || !RULE_PRIORITIES.includes(hit.priority)
    || outputRef.ruleCode !== rule.rule_code
    || outputRef.matchStatus !== hit.match_status
    || outputRef.priority !== hit.priority
    || hit.priority !== rule.priority) return false;
  return true;
}

/** 证明一个 completed evaluation run 恰好属于当前 run 的 succeeded strategy action 完整输出闭包。 */
function verifyCompletedStrategyDerivedClosure(
  db,
  run,
  evaluationRunId,
  timeseriesOwnership,
  ruleOwnership
) {
  const evaluationRun = DEMO_OWNERSHIP_ENTITY_HANDLERS.strategy_evaluation_run
    .readProjection(db, String(evaluationRunId));
  if (!evaluationRun || String(evaluationRun.id) !== String(evaluationRunId)
    || evaluationRun.status !== 'completed') return null;
  const hitRows = db.prepare(`SELECT id, evaluation_run_id, strategy_rule_id, match_status,
      manual_status, actual_value, threshold_snapshot_json, evidence_json, reason_codes_json,
      coverage_rate, priority, estimated_saving, estimated_saving_unit, data_start_utc,
      data_end_utc, source_timezone, reviewed_at, review_note, created_at, updated_at
    FROM strategy_rule_hits WHERE evaluation_run_id = ? ORDER BY id`).all(evaluationRunId);
  if (hitRows.length === 0) return null;
  const hitIds = hitRows.map((row) => String(row.id));
  const hitIdSet = new Set(hitIds);
  const firstOutput = db.prepare(`SELECT action_run_id AS actionRunId
    FROM demo_post_action_outputs
    WHERE output_entity_type = 'strategy_rule_hit' AND output_entity_id = ?
    ORDER BY output_id`).all(hitIds[0]);
  if (firstOutput.length !== 1) return null;
  const actionRun = readActionRunRow(db, firstOutput[0].actionRunId);
  if (!actionRun || actionRun.runId !== run.runId || actionRun.datasetId !== run.datasetId
    || actionRun.actionKey !== 'strategy-evaluation-run' || actionRun.status !== 'succeeded'
    || !actionRun.completedAt || Number(actionRun.outputCount) !== hitRows.length) return null;
  const outputs = readActionOutputs(db, actionRun.actionRunId);
  const outputHitIds = outputs.map((output) => String(output.outputEntityId));
  const outputHitIdSet = new Set(outputHitIds);
  if (outputs.length !== hitRows.length || outputHitIdSet.size !== hitRows.length
    || [...hitIdSet].some((hitId) => !outputHitIdSet.has(hitId))
    || outputs.some((output) => (
      output.outputEntityType !== 'strategy_rule_hit'
      || !hitIdSet.has(String(output.outputEntityId))
    ))) return null;
  const ruleById = new Map(ruleOwnership.rows.map((rule) => [String(rule.id), rule]));
  const verifiedHitById = new Map();
  const expectedRuleIds = new Set(ruleOwnership.rows.map((row) => String(row.id)));
  const actualRuleIds = new Set(hitRows.map((row) => String(row.strategy_rule_id)));
  if (actualRuleIds.size !== expectedRuleIds.size
    || [...expectedRuleIds].some((ruleId) => !actualRuleIds.has(ruleId))) return null;
  const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
      artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
      ownership_kind AS ownershipKind, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber, registered_by AS registeredBy,
      cleaned_at AS cleanedAt
    FROM demo_data_registry
    WHERE run_id = ? AND ownership_kind = 'derived'
      AND ((entity_type = 'strategy_evaluation_run' AND entity_pk = ?)
        OR (entity_type = 'strategy_rule_hit' AND entity_pk IN (${hitIds.map(() => '?').join(', ')})))
    ORDER BY registry_id`).all(run.runId, String(evaluationRunId), ...hitIds);
  if (registryRows.length !== hitRows.length + 1) return null;
  const registryByEntity = new Map(registryRows.map((registry) => (
    [`${registry.entityType}\\0${registry.entityPk}`, registry]
  )));
  const evaluationRegistry = registryByEntity.get(`strategy_evaluation_run\\0${evaluationRunId}`);
  const verifiedEvaluation = readVerifiedStrategyDerivedProjection(db, run, evaluationRegistry);
  if (!verifiedEvaluation || Number(evaluationRegistry.registeredBy) !== Number(actionRun.requestedBy)) return null;
  for (const hitRow of hitRows) {
    const hitRegistry = registryByEntity.get(`strategy_rule_hit\\0${hitRow.id}`);
    const verifiedHit = readVerifiedStrategyDerivedProjection(db, run, hitRegistry);
    const rule = ruleById.get(String(hitRow.strategy_rule_id));
    if (!verifiedHit || Number(verifiedHit.evaluation_run_id) !== Number(evaluationRunId)
      || Number(hitRegistry.registeredBy) !== Number(actionRun.requestedBy)
      || !rule
      || !isStrategyHitEvidenceBoundToRule(verifiedHit, rule)) return null;
    verifiedHitById.set(String(hitRow.id), verifiedHit);
  }
  if (outputs.some((output) => {
    const outputEntityId = String(output.outputEntityId);
    const verifiedHit = verifiedHitById.get(outputEntityId);
    const rule = verifiedHit
      ? ruleById.get(String(verifiedHit.strategy_rule_id))
      : null;
    return !isValidStrategyActionOutputRef(output.outputRef, verifiedHit, rule);
  })) return null;
  const ruleRegistryByPk = new Map(ruleOwnership.registryRows.map((registry) => (
    [String(registry.entityPk), registry]
  )));
  const expectedRelationSet = new Set();
  hitRows.forEach((hitRow) => {
    const hitRegistry = registryByEntity.get(`strategy_rule_hit\\0${hitRow.id}`);
    const ruleRegistry = ruleRegistryByPk.get(String(hitRow.strategy_rule_id));
    if (!hitRegistry || !ruleRegistry) return;
    expectedRelationSet.add(buildStrategyRegistryRelationKey(
      evaluationRegistry.registryId,
      hitRegistry.registryId,
      'contains'
    ));
    expectedRelationSet.add(buildStrategyRegistryRelationKey(
      hitRegistry.registryId,
      ruleRegistry.registryId,
      'uses_config'
    ));
  });
  timeseriesOwnership.registryRows.forEach((timeseriesRegistry) => {
    expectedRelationSet.add(buildStrategyRegistryRelationKey(
      evaluationRegistry.registryId,
      timeseriesRegistry.registryId,
      'generated_from'
    ));
  });
  if (expectedRelationSet.size !== (hitRows.length * 2) + timeseriesOwnership.registryRows.length) return null;
  const derivedRegistryIds = registryRows.map((registry) => Number(registry.registryId));
  const relationPlaceholders = derivedRegistryIds.map(() => '?').join(', ');
  const derivedRelationRows = db.prepare(`SELECT relation_id AS relationId, run_id AS runId,
      from_registry_id AS fromRegistryId, to_registry_id AS toRegistryId,
      relation_type AS relationType
    FROM demo_data_relations
    WHERE from_registry_id IN (${relationPlaceholders}) OR to_registry_id IN (${relationPlaceholders})
    ORDER BY relation_id`).all(...derivedRegistryIds, ...derivedRegistryIds);
  const actualRelationSet = new Set(derivedRelationRows.map((relation) => (
    buildStrategyRegistryRelationKey(
      relation.fromRegistryId,
      relation.toRegistryId,
      relation.relationType
    )
  )));
  if (derivedRelationRows.some((relation) => relation.runId !== run.runId)
    || actualRelationSet.size !== expectedRelationSet.size
    || [...expectedRelationSet].some((key) => !actualRelationSet.has(key))) return null;
  return {
    actionRunId: actionRun.actionRunId,
    evaluationRunId: Number(evaluationRunId),
    allowedInputRelationSet: new Set([
      ...hitRows.map((hitRow) => buildStrategyRegistryRelationKey(
        registryByEntity.get(`strategy_rule_hit\\0${hitRow.id}`).registryId,
        ruleRegistryByPk.get(String(hitRow.strategy_rule_id)).registryId,
        'uses_config'
      )),
      ...timeseriesOwnership.registryRows.map((timeseriesRegistry) => (
        buildStrategyRegistryRelationKey(
          evaluationRegistry.registryId,
          timeseriesRegistry.registryId,
          'generated_from'
        )
      ))
    ])
  };
}

/** 精确验证 artifact 15/18 imported uses_config 闭包，并允许 succeeded action 的完整 derived 输出闭包。 */
function readStrategyInputRelationClosure(db, run, timeseriesOwnership, ruleOwnership) {
  const sourceRegistryRows = [
    ...timeseriesOwnership.registryRows,
    ...ruleOwnership.registryRows
  ];
  const sourceRegistryIds = sourceRegistryRows.map((row) => Number(row.registryId));
  if (sourceRegistryIds.length === 0 || new Set(sourceRegistryIds).size !== sourceRegistryIds.length) {
    throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
  }
  const timeseriesIds = new Set(timeseriesOwnership.registryRows.map((row) => Number(row.registryId)));
  const ruleIds = new Set(ruleOwnership.registryRows.map((row) => Number(row.registryId)));
  const expectedRelations = [];
  timeseriesOwnership.registryRows.forEach((timeseries) => {
    ruleOwnership.registryRows.forEach((rule) => {
      expectedRelations.push({
        fromRegistryId: Number(timeseries.registryId),
        toRegistryId: Number(rule.registryId),
        relationType: 'uses_config',
        fromEntityType: 'energy_timeseries',
        fromEntityPk: String(timeseries.entityPk),
        toEntityType: 'strategy_rule',
        toEntityPk: String(rule.entityPk)
      });
    });
  });
  const placeholders = sourceRegistryIds.map(() => '?').join(', ');
  const relationRows = db.prepare(`SELECT relation.relation_id AS relationId,
      relation.run_id AS relationRunId, relation.from_registry_id AS fromRegistryId,
      relation.to_registry_id AS toRegistryId, relation.relation_type AS relationType,
      source.run_id AS fromRunId, source.artifact_key AS fromArtifactKey,
      source.entity_type AS fromEntityType, source.entity_pk AS fromEntityPk,
      source.ownership_kind AS fromOwnershipKind, source.cleaned_at AS fromCleanedAt,
      source.identity_digest AS fromIdentityDigest, source.snapshot_digest AS fromSnapshotDigest,
      source.source_batch_id AS fromSourceBatchId, source.source_row_number AS fromSourceRowNumber,
      source.registered_by AS fromRegisteredBy,
      target.run_id AS toRunId, target.artifact_key AS toArtifactKey,
      target.entity_type AS toEntityType, target.entity_pk AS toEntityPk,
      target.ownership_kind AS toOwnershipKind, target.cleaned_at AS toCleanedAt,
      target.identity_digest AS toIdentityDigest, target.snapshot_digest AS toSnapshotDigest,
      target.source_batch_id AS toSourceBatchId, target.source_row_number AS toSourceRowNumber,
      target.registered_by AS toRegisteredBy
    FROM demo_data_relations relation
    LEFT JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    LEFT JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.from_registry_id IN (${placeholders}) OR relation.to_registry_id IN (${placeholders})
    ORDER BY relation.relation_id`).all(...sourceRegistryIds, ...sourceRegistryIds);
  const importedRelationKey = (relation) => [
    Number(relation.fromRegistryId), Number(relation.toRegistryId), relation.relationType,
    relation.fromEntityType, String(relation.fromEntityPk), relation.toEntityType,
    String(relation.toEntityPk)
  ].join('\\0');
  const expectedSet = new Set(expectedRelations.map(importedRelationKey));
  const actualImportedSet = new Set();
  const verifiedDerivedClosures = new Map();
  relationRows.forEach((relation) => {
    const source = relation.fromRegistryId === null || relation.fromRunId === null ? null : {
      registryId: Number(relation.fromRegistryId),
      runId: relation.fromRunId,
      artifactKey: relation.fromArtifactKey,
      entityType: relation.fromEntityType,
      entityPk: String(relation.fromEntityPk),
      ownershipKind: relation.fromOwnershipKind,
      cleanedAt: relation.fromCleanedAt,
      identityDigest: relation.fromIdentityDigest,
      snapshotDigest: relation.fromSnapshotDigest,
      sourceBatchId: relation.fromSourceBatchId,
      sourceRowNumber: relation.fromSourceRowNumber,
      registeredBy: relation.fromRegisteredBy
    };
    const target = relation.toRegistryId === null || relation.toRunId === null ? null : {
      registryId: Number(relation.toRegistryId),
      runId: relation.toRunId,
      artifactKey: relation.toArtifactKey,
      entityType: relation.toEntityType,
      entityPk: String(relation.toEntityPk),
      ownershipKind: relation.toOwnershipKind,
      cleanedAt: relation.toCleanedAt,
      identityDigest: relation.toIdentityDigest,
      snapshotDigest: relation.toSnapshotDigest,
      sourceBatchId: relation.toSourceBatchId,
      sourceRowNumber: relation.toSourceRowNumber,
      registeredBy: relation.toRegisteredBy
    };
    if (!source || !target || relation.relationRunId !== run.runId
      || source.runId !== run.runId || target.runId !== run.runId
      || source.cleanedAt !== null || target.cleanedAt !== null) {
      throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    }
    const importedKey = importedRelationKey(relation);
    if (timeseriesIds.has(source.registryId) && ruleIds.has(target.registryId)
      && source.ownershipKind === 'imported' && target.ownershipKind === 'imported'
      && source.artifactKey === '15-energy-timeseries'
      && target.artifactKey === '18-strategy-rules'
      && source.entityType === 'energy_timeseries'
      && target.entityType === 'strategy_rule'
      && relation.relationType === 'uses_config') {
      if (actualImportedSet.has(importedKey)) throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
      actualImportedSet.add(importedKey);
      return;
    }
    if (source.ownershipKind !== 'derived' || target.ownershipKind !== 'imported') {
      throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    }
    const projection = readVerifiedStrategyDerivedProjection(db, run, source);
    const evaluationRunId = source.entityType === 'strategy_evaluation_run'
      ? Number(source.entityPk)
      : source.entityType === 'strategy_rule_hit' && projection
        ? Number(projection.evaluation_run_id)
        : null;
    if (!Number.isSafeInteger(evaluationRunId) || evaluationRunId < 1) {
      throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    }
    if (!verifiedDerivedClosures.has(evaluationRunId)) {
      verifiedDerivedClosures.set(evaluationRunId, verifyCompletedStrategyDerivedClosure(
        db,
        run,
        evaluationRunId,
        timeseriesOwnership,
        ruleOwnership
      ));
    }
    const verifiedClosure = verifiedDerivedClosures.get(evaluationRunId);
    const derivedKey = buildStrategyRegistryRelationKey(
      relation.fromRegistryId,
      relation.toRegistryId,
      relation.relationType
    );
    if (!verifiedClosure || !verifiedClosure.allowedInputRelationSet.has(derivedKey)) {
      throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
    }
  });
  if (actualImportedSet.size !== expectedSet.size || [...expectedSet].some((key) => !actualImportedSet.has(key))) {
    throw createStrategyBlocker('DEMO_STRATEGY_RELATION_CLOSURE_INVALID');
  }
  return relationRows.map((relation) => ({
    relationId: Number(relation.relationId),
    runId: relation.relationRunId,
    fromRegistryId: Number(relation.fromRegistryId),
    toRegistryId: Number(relation.toRegistryId),
    relationType: relation.relationType,
    fromEntityType: relation.fromEntityType,
    fromEntityPk: String(relation.fromEntityPk),
    toEntityType: relation.toEntityType,
    toEntityPk: String(relation.toEntityPk)
  }));
}

/** 证明 artifact 15 只构成一个同表计、同能源、同单位、同源时区且连续的精确窗口。 */
function buildHomogeneousStrategyTimeseries(ownership) {
  const rows = [...ownership.rows].sort((left, right) => left.start_utc.localeCompare(right.start_utc) || Number(left.id) - Number(right.id));
  if (rows.length === 0 || rows.some((row) => row.record_status !== 'active'
    || !Number.isSafeInteger(Number(row.meter_device_id)) || Number(row.meter_device_id) < 1
    || !Number.isSafeInteger(Number(row.energy_type_id)) || Number(row.energy_type_id) < 1
    || typeof row.normalized_unit !== 'string' || row.normalized_unit.trim() === ''
    || typeof row.source_timezone !== 'string' || row.source_timezone.trim() === ''
    || row.granularity_minutes !== 15)) {
    throw createStrategyBlocker('DEMO_STRATEGY_TIMESERIES_NOT_ACTIVE');
  }
  const first = rows[0];
  const groupKey = [first.meter_device_id, first.energy_type_id, first.normalized_unit, first.source_timezone, first.granularity_minutes].join('\\0');
  if (rows.some((row) => [row.meter_device_id, row.energy_type_id, row.normalized_unit, row.source_timezone, row.granularity_minutes].join('\\0') !== groupKey)) {
    throw createStrategyBlocker('DEMO_STRATEGY_GROUP_NOT_HOMOGENEOUS');
  }
  const granularityMs = Number(first.granularity_minutes) * 60 * 1000;
  for (let index = 0; index < rows.length; index += 1) {
    const start = Date.parse(rows[index].start_utc);
    const end = Date.parse(rows[index].end_utc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== granularityMs
      || (index > 0 && Date.parse(rows[index - 1].end_utc) !== start)) {
      throw createStrategyBlocker('DEMO_STRATEGY_TIME_WINDOW_INVALID');
    }
  }
  return {
    rows,
    meterDeviceId: Number(first.meter_device_id),
    energyTypeId: Number(first.energy_type_id),
    normalizedUnit: first.normalized_unit,
    sourceTimeZone: first.source_timezone,
    granularityMinutes: Number(first.granularity_minutes),
    startUtc: rows[0].start_utc,
    endUtc: rows[rows.length - 1].end_utc
  };
}

/** 将 energy_type 外键解析成当前数据库的 canonical code，禁止从请求正文读取。 */
function readStrategyEnergyTypeCode(db, energyTypeId) {
  const row = db.prepare('SELECT code FROM energy_types WHERE id = ?').get(energyTypeId);
  if (!row || typeof row.code !== 'string' || row.code.trim() === '') {
    throw createStrategyBlocker('DEMO_STRATEGY_ENERGY_TYPE_UNAVAILABLE');
  }
  return row.code;
}

/** 从 artifact 15/18 的真实 ownership 证据生成 strategy exact scope 和领域输入。 */
function resolveStrategyEvaluationInput(db, run, runtime, actorUserId) {
  const bindings = readStrategyBindings(db, run, runtime, actorUserId);
  const byArtifact = new Map(bindings.map((binding) => [binding.artifactKey, binding]));
  const timeseriesOwnership = readStrategyOwnershipClosure(db, run, byArtifact.get('15-energy-timeseries'));
  const ruleOwnership = readStrategyOwnershipClosure(db, run, byArtifact.get('18-strategy-rules'));
  const group = buildHomogeneousStrategyTimeseries(timeseriesOwnership);
  const inputRelations = readStrategyInputRelationClosure(
    db,
    run,
    timeseriesOwnership,
    ruleOwnership
  );
  const energyTypeCode = readStrategyEnergyTypeCode(db, group.energyTypeId);
  const startUtc = new Date(group.startUtc).toISOString();
  const endUtc = new Date(group.endUtc).toISOString();
  if (ruleOwnership.rows.some((rule) => rule.status !== 'active'
    || rule.formula_version !== SUPPORTED_FORMULA_VERSION
    || !SUPPORTED_METRIC_CODES.includes(rule.metric_code)
    || rule.source_timezone !== group.sourceTimeZone
    || Date.parse(rule.effective_start_utc) > Date.parse(startUtc)
    || Date.parse(rule.effective_end_utc) < Date.parse(endUtc))) {
    throw createStrategyBlocker('DEMO_STRATEGY_RULE_NOT_APPLICABLE');
  }
  const strategyRuleIds = ruleOwnership.rows.map((row) => Number(row.id)).sort((left, right) => left - right);
  const exactScope = buildEnergyStrategyExactScope(db, {
    timeseriesRecordIds: group.rows.map((row) => Number(row.id)).sort((left, right) => left - right),
    timeseriesSourceBatchId: byArtifact.get('15-energy-timeseries').importBatchId,
    strategyRuleIds,
    strategyRuleSourceBatchId: byArtifact.get('18-strategy-rules').importBatchId
  });
  const domainInput = {
    meterDeviceId: group.meterDeviceId,
    energyTypeCode,
    unit: group.normalizedUnit,
    startUtc,
    endUtc,
    sourceTimeZone: group.sourceTimeZone
  };
  const privateClosureDigest = stableDigest({
    scopeVersion: STRATEGY_SCOPE_INPUT_VERSION,
    bindings: bindings.map((binding) => ({
      artifactKey: binding.artifactKey,
      batchRole: binding.batchRole,
      handlerKey: binding.handlerKey,
      importType: binding.importType,
      entityType: binding.entityType,
      importBatchId: binding.importBatchId,
      contextId: binding.contextId,
      fileSha256: binding.fileSha256
    })),
    ownership: [timeseriesOwnership, ruleOwnership].flatMap((ownership) => (
      ownership.registryRows.map((row) => ({
        registryId: Number(row.registryId),
        runId: row.runId,
        artifactKey: row.artifactKey,
        entityType: row.entityType,
        entityPk: String(row.entityPk),
        ownershipKind: row.ownershipKind,
        identityDigest: row.identityDigest,
        snapshotDigest: row.snapshotDigest,
        sourceBatchId: Number(row.sourceBatchId),
        sourceRowNumber: Number(row.sourceRowNumber)
      }))
    )),
    relations: inputRelations,
    exactScope: {
      timeseriesRecordIds: group.rows.map((row) => Number(row.id)).sort((left, right) => left - right),
      timeseriesSourceBatchId: byArtifact.get('15-energy-timeseries').importBatchId,
      strategyRuleIds,
      strategyRuleSourceBatchId: byArtifact.get('18-strategy-rules').importBatchId
    }
  });
  return {
    domainInput,
    evidence: {
      scopeVersion: STRATEGY_SCOPE_INPUT_VERSION,
      sourceBindings: bindings.map(({ artifactKey, batchRole, importType, contextId }) => ({ artifactKey, batchRole, importType, contextId })),
      timeseriesCount: group.rows.length,
      strategyRuleCount: strategyRuleIds.length
    },
    privateContext: { exactScope },
    privateDigest: privateClosureDigest
  };
}

/** 生成策略 adapter 的完整服务端输入；所有 ID、批次和时间均由当前 run 关系重建。 */
function resolveStrategyEvaluationActionAdapterInput(db, run, runtime, actorUserId) {
  return resolveStrategyEvaluationInput(db, run, runtime, actorUserId);
}

/** 预演正式 strategy evaluator，并拒绝规则集合未完整适用或不可评价的情况。 */
function probeStrategyEvaluationAction(context) {
  const exactScope = context.privateContext?.exactScope;
  if (!exactScope) throw createStrategyBlocker('DEMO_STRATEGY_EXACT_SCOPE_REQUIRED');
  const preview = previewEnergyStrategies(context.domainInput, { db: context.db, exactScope, exactRequired: true });
  const expectedRuleCount = Number(context.evidence?.strategyRuleCount || 0);
  if (preview.ruleSelection.selectedRuleCount !== expectedRuleCount
    || preview.evaluations.length !== expectedRuleCount
    || preview.evaluations.some((evaluation) => evaluation.configurationErrors?.length > 0
      || evaluation.errors?.length > 0
      || evaluation.matchStatus === 'not_evaluable')) {
    throw createStrategyBlocker('DEMO_STRATEGY_RULE_NOT_APPLICABLE');
  }
  return {
    result: {
      source: { timeseriesArtifactKey: '15-energy-timeseries', strategyRulesArtifactKey: '18-strategy-rules' },
      scope: { startUtc: preview.dataRange.startUtc, endUtc: preview.dataRange.endUtc, sourceTimeZone: preview.dataRange.sourceTimeZone },
      ruleCount: preview.ruleSelection.selectedRuleCount,
      matchedCount: preview.evaluations.filter((evaluation) => evaluation.matchStatus === 'matched').length,
      dataSummary: preview.dataSummary
    },
    outputCount: 0,
    outputs: []
  };
}

/** execute 领取前重新用当前 run 关系构造 exact scope，禁止从 input_json 恢复 capability。 */
function revalidateStrategyEvaluationAction(context) {
  return resolveStrategyEvaluationInput(context.db, context.run, context.runtime, context.actorUserId);
}

/** 在当前 outer transaction 内签发 registration scope，再调用 evaluator 固定 ownership/receipt 协议。 */
function executeStrategyEvaluationAction(context) {
  const registrationScope = issueStrategyEvaluationRegistrationScopeInTransaction({
    db: context.db,
    runId: context.run.runId,
    actionRunId: context.actionRunId,
    actorUserId: context.actorUserId,
    exactScope: context.privateContext.exactScope,
    domainBinding: { ...context.domainInput }
  });
  const evaluated = runEnergyStrategyEvaluation(context.domainInput, {
    db: context.db,
    actorUserId: context.actorUserId,
    exactRequired: true,
    exactScope: context.privateContext.exactScope,
    registrationScope
  });
  const hits = Array.isArray(evaluated.hits) ? evaluated.hits : [];
  return {
    result: {
      source: { timeseriesArtifactKey: '15-energy-timeseries', strategyRulesArtifactKey: '18-strategy-rules' },
      scope: { startUtc: evaluated.dataRange.startUtc, endUtc: evaluated.dataRange.endUtc, sourceTimeZone: evaluated.dataRange.sourceTimeZone },
      ruleCount: evaluated.ruleSelection.selectedRuleCount,
      matchedCount: hits.filter((hit) => hit.matchStatus === 'matched').length,
      notMatchedCount: hits.filter((hit) => hit.matchStatus === 'not_matched').length,
      notEvaluableCount: hits.filter((hit) => hit.matchStatus === 'not_evaluable').length
    },
    outputCount: hits.length,
    outputs: hits.map((hit) => ({
      outputEntityType: 'strategy_rule_hit',
      outputEntityId: String(hit.id),
      outputRef: { ruleCode: hit.ruleCode, matchStatus: hit.matchStatus, priority: hit.priority }
    }))
  };
}

/** strategy public input 只投影来源 artifact、窗口和数量，不公开 ID、批次、上下文或摘要。 */
function projectStrategyEvaluationPublicInput(input = {}) {
  return {
    sources: ['15-energy-timeseries', '18-strategy-rules'],
    timeseriesCount: Number(input.timeseriesCount || 0),
    strategyRuleCount: Number(input.strategyRuleCount || 0),
    startUtc: input.startUtc || null,
    endUtc: input.endUtc || null,
    sourceTimeZone: input.sourceTimeZone || null
  };
}

/** strategy public result 只保留确定性统计和安全窗口来源。 */
function projectStrategyEvaluationPublicResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    source: result.source ? { ...result.source } : null,
    scope: result.scope ? {
      startUtc: result.scope.startUtc || null,
      endUtc: result.scope.endUtc || null,
      sourceTimeZone: result.scope.sourceTimeZone || null
    } : null,
    ruleCount: Number(result.ruleCount || 0),
    matchedCount: Number(result.matchedCount || 0),
    notMatchedCount: Number(result.notMatchedCount || 0),
    notEvaluableCount: Number(result.notEvaluableCount || 0)
  };
}

/** 将策略 resolver/领域异常映射为不泄露内部证据的稳定 blocker。 */
function mapStrategyEvaluationPreviewBlocker(error) {
  return {
    code: error?.code?.startsWith('DEMO_STRATEGY_') ? error.code : 'DEMO_STRATEGY_INPUT_BLOCKED',
    message: '服务端无法证明 artifact 15/18 的策略评价输入闭包，已安全阻断。'
  };
}

/** 从服务端 registry 定义选择私有 adapter；未连接状态与缺失实现均不得由客户端绕过。 */
function getPrivateActionAdapter(definition) {
  if (!definition || definition.implementationStatus !== 'connected') return null;
  return Object.prototype.hasOwnProperty.call(PRIVATE_ACTION_ADAPTERS, definition.actionKey)
    ? PRIVATE_ACTION_ADAPTERS[definition.actionKey]
    : null;
}

/** 将能流 resolver 结果包装为通用 lifecycle 只消费的领域输入和私有执行证据。 */
function resolveEnergyFlowActionAdapterInput(db, run, runtime) {
  const resolved = resolveEnergyFlowInput(db, run, runtime);
  return {
    domainInput: {
      modelId: resolved.modelId,
      startUtc: resolved.startUtc,
      endUtc: resolved.endUtc
    },
    evidence: {
      bindings: resolved.input.bindings,
      entityEvidence: resolved.input.entityEvidence,
      relations: resolved.input.relations
    }
  };
}

/** 将能流 adapter 解析异常转换为稳定的 preview blocker，不泄露内部异常详情。 */
function mapEnergyFlowPreviewBlocker(error) {
  return {
    code: error?.code?.startsWith('DEMO_FLOW_') ? error.code : 'DEMO_FLOW_ANALYSIS_UNAVAILABLE',
    message: '服务端无法证明能流输入闭包，已安全阻断。'
  };
}

/** connected 能流公开输入只保留服务端解析出的模型和时间范围。 */
function projectEnergyFlowPublicInput(domainInput) {
  const safeInput = {};
  ['modelId', 'startUtc', 'endUtc'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(domainInput, field)) safeInput[field] = domainInput[field];
  });
  return safeInput;
}

/** 能流历史结果沿用既有递归安全投影，作为已识别 action 的最后一道防线。 */
function projectEnergyFlowPublicResult(result) {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? sanitizePublicActionValue(result)
    : null;
}

/** 调用正式能流分析入口；adapter 结果保持既有公共 DTO，且不写任何业务事实表。 */
function executeEnergyFlowAnalysis(context) {
  const request = context.domainInput;
  const analysis = analyzeEnergyFlow(
    request.modelId,
    { startUtc: request.startUtc, endUtc: request.endUtc },
    { db: context.db }
  );
  return {
    result: { analysis, outputCount: 0 },
    outputCount: 0,
    outputs: []
  };
}

/** 组合 adapter 返回的 domain input 与 evidence，作为允许持久化的服务端输入。 */
function buildActionInput(binding, definition, resolved) {
  const actionKey = definition?.actionKey;
  const projectionIdentity = !resolved?.blocker && HISTORICAL_PUBLIC_PROJECTOR_ACTIONS.has(actionKey)
    ? {
        publicProjectionActionKey: actionKey,
        publicProjectionResolverVersion: definition.resolverVersion,
        publicProjectionExecutorVersion: definition.executorVersion,
        publicProjectionVersion: HISTORICAL_PUBLIC_PROJECTION_VERSION
      }
    : {};
  return {
    ...binding,
    actionKey,
    ...projectionIdentity,
    ...(resolved.domainInput || {}),
    ...(resolved.evidence || {})
  };
}

/** 同一次读取 registry 完整身份与持久化 binding，避免 capability 与 action row 身份漂移。 */
function buildCurrentPostActionRegistryBinding(run, runtime) {
  const registryIdentity = getDemoPostActionRegistryIdentity();
  return {
    registryIdentity,
    binding: buildRunBinding(run, runtime, registryIdentity)
  };
}

/** 仅为正式 Prediction adapter 签发阶段绑定 definition capability。 */
function issuePredictionDefinitionCapability(options) {
  if (options.adapter !== predictionActionAdapter) return null;
  return issueCanonicalPredictionDefinitionCapability({
    db: options.db,
    stage: options.stage,
    actionRunId: options.actionRunId,
    actionStatus: options.actionStatus,
    run: options.run,
    runtime: options.runtime,
    actor: options.actor,
    definition: options.definition,
    registryIdentity: options.registryIdentity,
    parentCapability: options.parentCapability
  });
}

/** 计算动作输入身份；私有闭包摘要参与比较但不写入 input_json 或公共 DTO。 */
function calculateActionInputDigest(input, resolved) {
  const privateDigest = resolved?.privateDigest || null;
  return privateDigest ? stableDigest({ input, privateDigest }) : stableDigest(input);
}

/** 解析当前动作输入；未连接动作统一生成稳定 blocker，connected 动作只通过私有 adapter。 */
function resolveActionInput(
  db,
  definition,
  run,
  runtime,
  actorUserId,
  actorIp = null,
  adapterSelector = getPrivateActionAdapter,
  definitionCapability = null,
  actor = null
) {
  const adapter = adapterSelector(definition);
  if (!adapter) {
    return {
      domainInput: { requiredArtifactBindings: [...definition.requiredArtifactBindings] },
      evidence: null,
      blocker: { code: 'ACTION_HANDLER_NOT_CONNECTED', message: '该演示后置动作尚未连接服务端 handler/executor。' }
    };
  }
  const resolved = adapter.resolve(
    db,
    run,
    runtime,
    actorUserId,
    actorIp,
    definitionCapability,
    actor
  );
  return {
    adapter,
    domainInput: resolved.domainInput,
    evidence: resolved.evidence,
    privateContext: resolved.privateContext,
    privateDigest: resolved.privateDigest || null,
    blocker: null
  };
}

/** 在事务内记录 preview 审计；详情只包含固定摘要和状态信息。 */
function writePostActionAudit(db, operation, actorUserId, actionRunId, actionKey, detail, actorIp) {
  return insertOperationLogWithDb(db, {
    userId: actorUserId,
    operation,
    targetType: 'demo_post_action_run',
    targetId: actionRunId,
    detail: { actionKey, ...detail },
    ip: actorIp || null
  });
}

/** 返回 preview 的现有幂等运行，确保重复请求不重复创建审计记录。 */
function readIdempotentPreview(db, runId, actionKey, clientRequestId, actorUserId) {
  const identity = db.prepare(`SELECT action_run_id AS actionRunId FROM demo_post_action_runs
    WHERE run_id = ? AND action_key = ? AND client_request_id = ? AND requested_by = ?
    ORDER BY created_at DESC LIMIT 1`).get(runId, actionKey, clientRequestId, actorUserId);
  return identity ? readActionRunRow(db, identity.actionRunId) : null;
}

/** 兼容服务内部 direct call，同时保持 HTTP 路由通过 body 执行严格字段白名单。 */
function resolvePreviewBody(options) {
  return Object.prototype.hasOwnProperty.call(options, 'body')
    ? (options.body || {})
    : { clientRequestId: options.clientRequestId };
}

/** 执行通用预演生命周期；动作只能通过 registry connected 门禁选择私有 adapter。 */
function previewDemoPostActionInternal(options = {}) {
  const adapterSelector = getPrivateActionAdapter;
  const actorUserId = assertActorUserId(options.actorUserId);
  const actionKey = String(options.actionKey || '').trim();
  const definition = requireDemoPostAction(actionKey);
  const body = resolvePreviewBody(options);
  assertStrictBody(body, ['clientRequestId'], 'preview');
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);
  const ownedDb = !options.db;
  const db = options.db || openDatabase({ admissionPermit: options.admissionPermit });
  try {
    const execute = db.transaction(() => {
      const runtime = assertDemoRuntimeEnabled({ db });
      const run = requireWritableRun(db, options.runId);
      const { registryIdentity, binding } = buildCurrentPostActionRegistryBinding(
        run,
        runtime
      );
      const existing = readIdempotentPreview(db, options.runId, actionKey, clientRequestId, actorUserId);
      if (existing) return mapActionRun(existing, readActionOutputs(db, existing.actionRunId));
      const adapter = adapterSelector(definition);
      const actor = adapter === predictionActionAdapter
        ? readDemoPostActionCanonicalActor(db, actorUserId, options.actorIp || null)
        : null;
      let resolved;
      try {
        const resolveDefinitionCapability = issuePredictionDefinitionCapability({
          adapter,
          db,
          stage: 'preview-resolve',
          actionRunId: null,
          actionStatus: null,
          run,
          runtime,
          actor,
          definition,
          registryIdentity,
          parentCapability: null
        });
        resolved = resolveActionInput(
          db,
          definition,
          run,
          runtime,
          actorUserId,
          options.actorIp || null,
          adapterSelector,
          resolveDefinitionCapability,
          actor
        );
        if (!resolved.blocker) {
          const probeDefinitionCapability = issuePredictionDefinitionCapability({
            adapter,
            db,
            stage: 'preview-probe',
            actionRunId: null,
            actionStatus: null,
            run,
            runtime,
            actor,
            definition,
            registryIdentity,
            parentCapability: resolveDefinitionCapability
          });
          // preview 必须通过私有 adapter 调用正式领域入口，但不持久化预演结果全文。
          resolved.result = resolved.adapter.previewProbe({
            db,
            run,
            runtime,
            domainInput: resolved.domainInput,
            evidence: resolved.evidence,
            privateContext: resolved.privateContext,
            actorUserId,
            actorIp: options.actorIp || null,
            actor,
            definitionCapability: probeDefinitionCapability,
            parentDefinitionCapability: resolveDefinitionCapability,
            actionRunId: null,
            actionStatus: null
          });
        }
      } catch (error) {
        if (!adapter || typeof adapter.mapPreviewBlocker !== 'function') throw error;
        resolved = {
          domainInput: { requiredArtifactBindings: [...definition.requiredArtifactBindings] },
          evidence: null,
          blocker: adapter.mapPreviewBlocker(error)
        };
      }
      const input = buildActionInput(binding, definition, resolved);
      const blocker = resolved.blocker || null;
      const status = blocker ? 'blocked' : 'previewed';
      const inputDigest = calculateActionInputDigest(input, resolved);
      const previewDigest = stableDigest({ inputDigest, actionKey, status, blocker });
      const actionRunId = `demo-action-run-${crypto.randomUUID()}`;
      const createdAt = nowUtc();
      const previewExpiresAt = new Date(Date.now() + definition.previewTtlMs).toISOString();
      db.prepare(`INSERT INTO demo_post_action_runs
        (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
         executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
         runtime_epoch, runtime_revision, input_digest, preview_digest, output_count,
         preview_expires_at, input_json, blocker_json, requested_by, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(
        actionRunId, run.runId, run.datasetId, actionKey, binding.registryVersion,
        definition.resolverVersion, definition.executorVersion, clientRequestId,
        binding.manifestVersion, binding.manifestDigest, binding.registryDigest,
        runtime.runtimeEpoch, runtime.revision, inputDigest, previewDigest, previewExpiresAt,
        JSON.stringify(input), blocker ? JSON.stringify(blocker) : null, actorUserId, status,
        createdAt, createdAt
      );
      writePostActionAudit(db, 'system.demo.post-action.preview', actorUserId, actionRunId, actionKey, {
        status, inputDigest, previewDigest, registryDigest: binding.registryDigest, runtimeEpoch: runtime.runtimeEpoch, runtimeRevision: runtime.revision
      }, options.actorIp);
      return mapActionRun(readActionRunRow(db, actionRunId), []);
    });
    return ownedDb ? execute.immediate() : execute();
  } finally {
    if (ownedDb) db.close();
  }
}

/** 公开预演入口始终遵守 registry connected 门禁。 */
function previewDemoPostAction(options = {}) {
  return previewDemoPostActionInternal(options);
}

/** 读取 terminal 状态，重复 execute 使用持久化 projector identity 返回原安全结果。 */
function readTerminalActionRun(db, row) {
  return TERMINAL_ACTION_RUN_STATUSES.includes(row.status)
    ? mapActionRun(row, readActionOutputs(db, row.actionRunId))
    : null;
}

/** 兼容服务内部 direct call，同时保持 HTTP 路由通过 body 执行严格字段白名单。 */
function resolveExecuteBody(options) {
  return Object.prototype.hasOwnProperty.call(options, 'body')
    ? (options.body || {})
    : {
      clientRequestId: options.clientRequestId,
      previewDigest: options.previewDigest,
      confirmationText: options.confirmationText
    };
}

/** 校验 adapter 执行结果和真实输出引用，避免 output_count 与输出表漂移。 */
function normalizeAdapterExecutionResult(definition, execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || !execution.result || typeof execution.result !== 'object' || Array.isArray(execution.result)
    || !Array.isArray(execution.outputs) || !Number.isSafeInteger(execution.outputCount)
    || execution.outputCount < 0 || execution.outputCount !== execution.outputs.length) {
    throw new AppError('DEMO_POST_ACTION_RESULT_INVALID', '后置动作 adapter 返回了无效结果合同。', { statusCode: 409 });
  }
  const seenOutputs = new Set();
  const outputs = execution.outputs.map((output) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new AppError('DEMO_POST_ACTION_OUTPUT_INVALID', '后置动作输出引用无效。', { statusCode: 409 });
    }
    const outputEntityType = String(output.outputEntityType || '').trim();
    const outputEntityId = String(output.outputEntityId || '').trim();
    const outputRef = output.outputRef;
    if (!definition.outputEntityTypes.includes(outputEntityType)
      || outputEntityId.length < 1 || outputEntityId.length > 256
      || !outputRef || typeof outputRef !== 'object' || Array.isArray(outputRef)) {
      throw new AppError('DEMO_POST_ACTION_OUTPUT_INVALID', '后置动作输出类型、主键或公开引用无效。', { statusCode: 409 });
    }
    const safeOutputRef = sanitizePublicActionValue(outputRef);
    if (stableDigest(outputRef) !== stableDigest(safeOutputRef)) {
      throw new AppError('DEMO_POST_ACTION_OUTPUT_REF_UNSAFE', '后置动作公开输出引用包含内部字段。', { statusCode: 409 });
    }
    const outputKey = `${outputEntityType}\0${outputEntityId}`;
    if (seenOutputs.has(outputKey)) {
      throw new AppError('DEMO_POST_ACTION_OUTPUT_DUPLICATE', '后置动作输出引用重复。', { statusCode: 409 });
    }
    seenOutputs.add(outputKey);
    return { outputEntityType, outputEntityId, outputRef: safeOutputRef };
  });
  return { result: execution.result, outputCount: execution.outputCount, outputs };
}

/** 在 executing 状态下写入真实输出行，并复核父表自动计数。 */
function persistActionOutputs(db, actionRunId, outputs, createdAt) {
  const insertOutput = db.prepare(`INSERT INTO demo_post_action_outputs
    (action_run_id, output_entity_type, output_entity_id, output_ref_json, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  outputs.forEach((output) => insertOutput.run(
    actionRunId,
    output.outputEntityType,
    output.outputEntityId,
    JSON.stringify(output.outputRef),
    createdAt
  ));
  const state = db.prepare(`SELECT run.output_count AS outputCount,
      (SELECT COUNT(*) FROM demo_post_action_outputs output WHERE output.action_run_id = run.action_run_id) AS actualCount
    FROM demo_post_action_runs run WHERE run.action_run_id = ?`).get(actionRunId);
  if (!state || Number(state.outputCount) !== outputs.length || Number(state.actualCount) !== outputs.length) {
    throw new AppError('DEMO_POST_ACTION_OUTPUT_COUNT_MISMATCH', '后置动作输出计数与真实输出行不一致。', { statusCode: 409 });
  }
}

/** 在 outer transaction 中只写一次失败状态和失败审计；业务 savepoint 已先整体回滚。 */
function markExecutingActionFailed(db, context, error) {
  const completedAt = nowUtc();
  const failureReason = safeFailureReason(error);
  const outputState = db.prepare(`SELECT output_count AS outputCount,
      (SELECT COUNT(*) FROM demo_post_action_outputs WHERE action_run_id = ?) AS actualCount
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(context.actionRunId, context.actionRunId);
  if (!outputState || Number(outputState.outputCount) !== 0 || Number(outputState.actualCount) !== 0) {
    throw new AppError('DEMO_POST_ACTION_FAILURE_ROLLBACK_INCOMPLETE', '后置动作失败后的输出回滚不完整。', { statusCode: 500 });
  }
  const update = db.prepare(`UPDATE demo_post_action_runs SET status = 'failed', failure_reason = ?,
      completed_at = ?, updated_at = ? WHERE action_run_id = ? AND requested_by = ? AND status = 'executing'`).run(
    failureReason, completedAt, completedAt, context.actionRunId, context.actorUserId
  );
  if (update.changes !== 1) {
    throw new AppError('DEMO_POST_ACTION_FAILURE_STATE_CONFLICT', '后置动作失败状态写入发生冲突。', { statusCode: 409 });
  }
  writePostActionAudit(db, 'system.demo.post-action.execute', context.actorUserId,
    context.actionRunId, context.actionKey, {
      status: 'failed', failureReason, registryDigest: context.registryDigest
    }, context.actorIp);
}

/** 构造固定脱敏的通用生命周期恢复失败错误。 */
function createPostActionRecoveryFailedError() {
  return new AppError(
    'DEMO_POST_ACTION_RECOVERY_FAILED',
    '后置动作失败状态无法在已证明安全的事务边界内恢复。',
    { statusCode: 500 }
  );
}

/** 安全读取连接开关与事务状态，访问器异常视为无法证明。 */
function readPostActionConnectionState(db) {
  try {
    return {
      open: db?.open === true,
      inTransaction: db?.inTransaction === true
    };
  } catch (_error) {
    throw createPostActionRecoveryFailedError();
  }
}

/** 安全读取并规范化当前 SQLite 路径，访问器异常或空路径统一 fail-closed。 */
function readPostActionDatabasePath(db) {
  try {
    return typeof db?.name === 'string' && db.name.trim() !== ''
      ? path.resolve(db.name)
      : null;
  } catch (_error) {
    throw createPostActionRecoveryFailedError();
  }
}

/** 证明恢复连接仍指向原 SQLite 且处于可开启新事务的状态。 */
function assertPostActionRecoveryConnection(db, databasePath) {
  const state = readPostActionConnectionState(db);
  const currentDatabasePath = readPostActionDatabasePath(db);
  if (!state.open || state.inTransaction || !currentDatabasePath
    || !databasePath || currentDatabasePath !== path.resolve(databasePath)) {
    throw createPostActionRecoveryFailedError();
  }
}

/** 在无业务写入的新 immediate transaction 中安全记录 failed，并返回当前 terminal 投影。 */
function markExecutingActionFailedInNewTransaction(db, context, error) {
  const transaction = db.transaction(() => {
    const current = readActionRunRow(db, context.actionRunId);
    const terminal = current ? readTerminalActionRun(db, current) : null;
    if (terminal) return terminal;
    if (!current || current.status !== 'executing'
      || current.requestedBy !== context.actorUserId || current.actionKey !== context.actionKey) {
      throw createPostActionRecoveryFailedError();
    }
    markExecutingActionFailed(db, context, error);
    return mapActionRun(
      readActionRunRow(db, context.actionRunId),
      readActionOutputs(db, context.actionRunId)
    );
  });
  try {
    return transaction.immediate();
  } catch (_error) {
    throw createPostActionRecoveryFailedError();
  }
}

/** outer transaction 被私有协议完整回滚或关闭后，使用同一正式 admission permit 恢复 failed。 */
function recoverExecutingActionFailure(options) {
  const {
    db,
    databasePath,
    admissionPermit,
    context,
    error
  } = options;
  let recoveryDb = db;
  let closeRecoveryDb = false;
  let state = readPostActionConnectionState(db);
  if (state.open && state.inTransaction) {
    let rollbackProved = false;
    try {
      db.exec('ROLLBACK');
      rollbackProved = readPostActionConnectionState(db).inTransaction === false;
    } catch (_rollbackError) {
      rollbackProved = false;
    }
    if (!rollbackProved) {
      try {
        db.close();
      } catch (_closeError) {
        // close() 自身抛错不代表物理连接仍开启，必须随后独立读取状态证明。
      }
      let closeProved = false;
      try {
        closeProved = readPostActionConnectionState(db).open === false;
      } catch (_stateError) {
        closeProved = false;
      }
      if (!closeProved) throw createPostActionRecoveryFailedError();
    }
    state = readPostActionConnectionState(db);
  }
  if (!state.open) {
    if (typeof databasePath !== 'string' || databasePath.trim() === '') {
      throw createPostActionRecoveryFailedError();
    }
    try {
      recoveryDb = openDatabase({ databasePath, admissionPermit });
      closeRecoveryDb = true;
    } catch (_error) {
      throw createPostActionRecoveryFailedError();
    }
  } else if (state.inTransaction) {
    throw createPostActionRecoveryFailedError();
  }
  try {
    assertPostActionRecoveryConnection(recoveryDb, databasePath);
    return markExecutingActionFailedInNewTransaction(
      recoveryDb,
      context,
      error
    );
  } finally {
    if (closeRecoveryDb) {
      try {
        if (recoveryDb.open === true) recoveryDb.close();
      } catch (_error) {
        // failed 已原子提交后，关闭恢复连接失败不改变持久化 terminal 事实。
      }
    }
  }
}

/** 校验已领取 action run 仍绑定同一 runtime、manifest、registry 和 actor。 */
function assertClaimedActionBinding(row, binding, runtime, actorUserId) {
  if (!row || row.status !== 'executing' || row.requestedBy !== actorUserId
    || row.manifestVersion !== binding.manifestVersion || row.manifestDigest !== binding.manifestDigest
    || row.registryVersion !== binding.registryVersion || row.registryDigest !== binding.registryDigest
    || Number(row.runtimeEpoch) !== Number(runtime.runtimeEpoch)
    || Number(row.runtimeRevision) !== Number(runtime.revision)) {
    throw new AppError('DEMO_POST_ACTION_STALE', '后置动作运行绑定已陈旧，必须重新预演。', { statusCode: 409 });
  }
}

/** 执行通用后置动作生命周期；动作只能通过 registry connected 门禁选择私有 adapter。 */
function executeDemoPostActionInternal(options = {}) {
  const adapterSelector = getPrivateActionAdapter;
  const actorUserId = assertActorUserId(options.actorUserId);
  const body = resolveExecuteBody(options);
  assertStrictBody(body, ['clientRequestId', 'previewDigest', 'confirmationText'], 'execute');
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);
  const previewDigest = assertDigest(body.previewDigest, 'previewDigest');
  if (typeof body.confirmationText !== 'string') {
    throw badRequest('confirmationText 必须是文本。', { code: 'DEMO_POST_ACTION_CONFIRMATION_INVALID' });
  }
  const ownedDb = !options.db;
  const db = options.db || openDatabase({ admissionPermit: options.admissionPermit });
  const recoveryDatabasePath = readPostActionDatabasePath(db);
  if (readPostActionConnectionState(db).inTransaction) {
    if (ownedDb) db.close();
    throw new AppError('DEMO_POST_ACTION_CALLER_TRANSACTION_FORBIDDEN', '后置动作必须自行管理 CAS、事务外备份和 outer transaction。', { statusCode: 409 });
  }
  const actionRunId = String(options.actionRunId || '').trim();
  try {
    const claimTransaction = db.transaction(() => {
      let row = readActionRunRow(db, actionRunId);
      if (!row || row.requestedBy !== actorUserId) {
        throw notFound('后置动作运行不存在。', { code: 'DEMO_POST_ACTION_RUN_NOT_FOUND' });
      }
      const definition = requireDemoPostAction(row.actionKey);
      if (row.clientRequestId !== clientRequestId || row.previewDigest !== previewDigest) {
        throw new AppError('DEMO_POST_ACTION_REQUEST_MISMATCH', 'execute 请求与预演绑定不一致。', { statusCode: 409 });
      }
      if (body.confirmationText !== definition.confirmationText) {
        throw new AppError('DEMO_POST_ACTION_CONFIRMATION_MISMATCH', 'execute 确认文本不匹配服务端 registry。', { statusCode: 409 });
      }
      const terminal = readTerminalActionRun(db, row);
      if (terminal) return { terminal };
      if (row.status === 'blocked') {
        const blocker = parseNullableJsonObject(row.blockerJson);
        throw new AppError(blocker?.code || 'DEMO_POST_ACTION_BLOCKED', '该演示后置动作已安全阻断。', {
          statusCode: 409,
          details: { actionRunId: row.actionRunId, actionKey: row.actionKey }
        });
      }
      const runtime = assertDemoRuntimeEnabled({ db });
      const run = requireWritableRun(db, row.runId);
      const { registryIdentity, binding } = buildCurrentPostActionRegistryBinding(
        run,
        runtime
      );
      const now = nowUtc();
      if (Date.parse(row.previewExpiresAt) <= Date.now()) {
        const expiredUpdate = db.prepare(`UPDATE demo_post_action_runs SET status = 'expired', failure_reason = ?,
            completed_at = ?, updated_at = ?
          WHERE action_run_id = ? AND requested_by = ? AND status = 'previewed'`).run(
          'DEMO_POST_ACTION_PREVIEW_EXPIRED', now, now, row.actionRunId, actorUserId
        );
        if (expiredUpdate.changes === 1) {
          writePostActionAudit(db, 'system.demo.post-action.execute', actorUserId, row.actionRunId, row.actionKey, {
            status: 'expired', failureReason: 'DEMO_POST_ACTION_PREVIEW_EXPIRED', registryDigest: binding.registryDigest
          }, options.actorIp);
        }
        return {
          postCommitError: new AppError('DEMO_POST_ACTION_PREVIEW_EXPIRED', '后置动作预演已过期。', { statusCode: 409 })
        };
      }
      if (row.manifestVersion !== binding.manifestVersion || row.manifestDigest !== binding.manifestDigest
        || row.registryVersion !== binding.registryVersion || row.registryDigest !== binding.registryDigest
        || Number(row.runtimeEpoch) !== Number(runtime.runtimeEpoch)
        || Number(row.runtimeRevision) !== Number(runtime.revision)) {
        throw new AppError('DEMO_POST_ACTION_STALE', '后置动作预演已陈旧，必须重新预演。', { statusCode: 409 });
      }
      const adapter = adapterSelector(definition);
      if (!adapter) {
        throw new AppError('ACTION_HANDLER_NOT_CONNECTED', '该演示后置动作尚未连接服务端 handler/executor。', { statusCode: 409 });
      }
      const actor = adapter === predictionActionAdapter
        ? readDemoPostActionCanonicalActor(db, actorUserId, options.actorIp || null)
        : null;
      const preflightDefinitionCapability = issuePredictionDefinitionCapability({
        adapter,
        db,
        stage: 'previewed-revalidate',
        actionRunId: row.actionRunId,
        actionStatus: 'previewed',
        run,
        runtime,
        actor,
        definition,
        registryIdentity,
        parentCapability: null
      });
      let preflightResolved;
      try {
        preflightResolved = adapter.revalidate({
          db, run, runtime, actionRunId: row.actionRunId, actionStatus: 'previewed',
          actorUserId, actorIp: options.actorIp || null, actor,
          definitionCapability: preflightDefinitionCapability,
          parentDefinitionCapability: null
        });
      } catch (_error) {
        throw new AppError('DEMO_POST_ACTION_INPUT_STALE', '后置动作输入证据已不可复核，必须重新预演。', { statusCode: 409 });
      }
      const inputDigest = calculateActionInputDigest(
        buildActionInput(binding, definition, preflightResolved),
        preflightResolved
      );
      if (inputDigest !== row.inputDigest) {
        throw new AppError('DEMO_POST_ACTION_INPUT_STALE', '后置动作输入已发生变化。', { statusCode: 409 });
      }
      const claim = db.prepare(`UPDATE demo_post_action_runs
        SET status = 'executing', started_at = ?, updated_at = ?
        WHERE action_run_id = ? AND requested_by = ? AND status = 'previewed'
          AND client_request_id = ? AND preview_digest = ? AND manifest_version = ?
          AND manifest_digest = ? AND registry_digest = ? AND runtime_epoch = ? AND runtime_revision = ?
          AND preview_expires_at > ?`).run(
        now, now, row.actionRunId, actorUserId, clientRequestId, previewDigest,
        binding.manifestVersion, binding.manifestDigest, binding.registryDigest,
        runtime.runtimeEpoch, runtime.revision, now
      );
      if (claim.changes !== 1) {
        row = readActionRunRow(db, row.actionRunId);
        const claimedTerminal = readTerminalActionRun(db, row);
        if (claimedTerminal) return { terminal: claimedTerminal };
        throw new AppError('DEMO_POST_ACTION_CLAIM_CONFLICT', '后置动作已被其他请求领取或已陈旧。', { statusCode: 409 });
      }
      return {
        actionRunId: row.actionRunId,
        actionKey: row.actionKey,
        runId: row.runId,
        definition,
        adapter,
        binding,
        registryIdentity,
        runtime,
        run,
        actor,
        preflightDefinitionCapability,
        resolved: preflightResolved
      };
    });
    const claimed = claimTransaction.immediate();
    if (claimed.terminal) return claimed.terminal;
    if (claimed.postCommitError) throw claimed.postCommitError;

    let backupEvidence = null;
    try {
      if (typeof claimed.adapter.prepareBackup === 'function') {
        backupEvidence = claimed.adapter.prepareBackup({
          db,
          run: claimed.run,
          runtime: claimed.runtime,
          domainInput: claimed.resolved.domainInput,
          evidence: claimed.resolved.evidence,
          privateContext: claimed.resolved.privateContext,
          actionRunId: claimed.actionRunId,
          actorUserId,
          actorIp: options.actorIp || null
        });
      }
    } catch (error) {
      const failureTransaction = db.transaction(() => {
        markExecutingActionFailed(db, {
          actionRunId: claimed.actionRunId,
          actionKey: claimed.actionKey,
          actorUserId,
          actorIp: options.actorIp || null,
          registryDigest: claimed.binding.registryDigest
        }, error);
        return mapActionRun(readActionRunRow(db, claimed.actionRunId), readActionOutputs(db, claimed.actionRunId));
      });
      return failureTransaction.immediate();
    }

    const failureContext = {
      actionRunId: claimed.actionRunId,
      actionKey: claimed.actionKey,
      actorUserId,
      actorIp: options.actorIp || null,
      registryDigest: claimed.binding.registryDigest
    };
    const outerTransaction = db.transaction(() => {
      const currentRow = readActionRunRow(db, claimed.actionRunId);
      let currentBinding = claimed.binding;
      try {
        const runtime = assertDemoRuntimeEnabled({ db });
        const run = requireWritableRun(db, claimed.runId);
        const currentRegistryBinding = buildCurrentPostActionRegistryBinding(run, runtime);
        currentBinding = currentRegistryBinding.binding;
        assertClaimedActionBinding(currentRow, currentBinding, runtime, actorUserId);
        const executingDefinitionCapability = issuePredictionDefinitionCapability({
          adapter: claimed.adapter,
          db,
          stage: 'executing-revalidate',
          actionRunId: claimed.actionRunId,
          actionStatus: 'executing',
          run: claimed.run,
          runtime: claimed.runtime,
          actor: claimed.actor,
          definition: claimed.definition,
          registryIdentity: claimed.registryIdentity,
          parentCapability: claimed.preflightDefinitionCapability
        });
        const resolved = claimed.adapter.revalidate({
          db,
          run: claimed.run,
          runtime: claimed.runtime,
          actionRunId: claimed.actionRunId,
          actionStatus: 'executing',
          actorUserId,
          actorIp: options.actorIp || null,
          actor: claimed.actor,
          definitionCapability: executingDefinitionCapability,
          parentDefinitionCapability: claimed.preflightDefinitionCapability
        });
        const inputDigest = calculateActionInputDigest(
          buildActionInput(currentBinding, claimed.definition, resolved),
          resolved
        );
        if (inputDigest !== currentRow.inputDigest) {
          throw new AppError('DEMO_POST_ACTION_INPUT_STALE', '后置动作输入已发生变化。', { statusCode: 409 });
        }
        const businessSavepoint = db.transaction(() => {
          const executeDefinitionCapability = issuePredictionDefinitionCapability({
            adapter: claimed.adapter,
            db,
            stage: 'execute',
            actionRunId: claimed.actionRunId,
            actionStatus: 'executing',
            run: claimed.run,
            runtime: claimed.runtime,
            actor: claimed.actor,
            definition: claimed.definition,
            registryIdentity: claimed.registryIdentity,
            parentCapability: executingDefinitionCapability
          });
          const rawExecution = claimed.adapter.execute({
            db,
            run: claimed.run,
            runtime: claimed.runtime,
            domainInput: resolved.domainInput,
            evidence: resolved.evidence,
            privateContext: resolved.privateContext,
            backupEvidence,
            actionRunId: claimed.actionRunId,
            actionStatus: 'executing',
            actorUserId,
            actorIp: options.actorIp || null,
            actor: claimed.actor,
            definitionCapability: executeDefinitionCapability,
            parentDefinitionCapability: executingDefinitionCapability
          });
          const execution = normalizeAdapterExecutionResult(claimed.definition, rawExecution);
          const completedAt = nowUtc();
          persistActionOutputs(db, claimed.actionRunId, execution.outputs, completedAt);
          const resultDigest = stableDigest(execution.result);
          const successUpdate = db.prepare(`UPDATE demo_post_action_runs
            SET status = 'succeeded', result_digest = ?, result_json = ?, completed_at = ?, updated_at = ?
            WHERE action_run_id = ? AND requested_by = ? AND status = 'executing'`).run(
            resultDigest, JSON.stringify(execution.result), completedAt, completedAt,
            claimed.actionRunId, actorUserId
          );
          if (successUpdate.changes !== 1) {
            throw new AppError('DEMO_POST_ACTION_SUCCESS_STATE_CONFLICT', '后置动作成功状态写入发生冲突。', { statusCode: 409 });
          }
          writePostActionAudit(db, 'system.demo.post-action.execute', actorUserId,
            claimed.actionRunId, claimed.actionKey, {
              status: 'succeeded', inputDigest, resultDigest,
              outputCount: String(execution.outputCount), registryDigest: currentBinding.registryDigest
            }, options.actorIp);
        });
        businessSavepoint();
      } catch (error) {
        failureContext.registryDigest = currentBinding.registryDigest;
        const state = readPostActionConnectionState(db);
        if (!state.open || !state.inTransaction) throw error;
        markExecutingActionFailed(db, failureContext, error);
      }
      return mapActionRun(readActionRunRow(db, claimed.actionRunId), readActionOutputs(db, claimed.actionRunId));
    });
    try {
      return outerTransaction.immediate();
    } catch (error) {
      return recoverExecutingActionFailure({
        db,
        databasePath: recoveryDatabasePath,
        admissionPermit: options.admissionPermit,
        context: failureContext,
        error
      });
    }
  } finally {
    if (ownedDb) {
      try {
        if (db.open === true) db.close();
      } catch (_error) {
        // 私有协议已关闭连接或关闭失败时，不在 finally 覆盖稳定恢复结果。
      }
    }
  }
}

/** 公开执行入口始终遵守 registry connected 门禁。 */
function executeDemoPostAction(options = {}) {
  return executeDemoPostActionInternal(options);
}

/** 查询动作运行状态；actor 不匹配时统一伪装为不存在。 */
function getDemoPostActionStatus(options = {}) {
  const actorUserId = assertActorUserId(options.actorUserId);
  const actionRunId = String(options.actionRunId || '').trim();
  const ownedDb = !options.db;
  const db = options.db || openDatabase({ admissionPermit: options.admissionPermit });
  try {
    const row = readActionRunRow(db, actionRunId);
    if (!row || row.requestedBy !== actorUserId) throw notFound('后置动作运行不存在。', { code: 'DEMO_POST_ACTION_RUN_NOT_FOUND' });
    return mapActionRun(row, readActionOutputs(db, actionRunId));
  } finally {
    if (ownedDb) db.close();
  }
}

/** 返回安全 registry 与稳定身份摘要。 */
function getDemoPostActionRegistry() {
  return { identity: getDemoPostActionRegistryIdentity(), actions: listDemoPostActions() };
}

const demoPostActionServiceExports = {
  executeDemoPostAction,
  getDemoPostActionRegistry,
  getDemoPostActionStatus,
  previewDemoPostAction
};
// 可反射引用只返回 canonical adapter/P4 实例，不返回 issuer、verifier、secret 或 authority。
const CANONICAL_PREDICTION_INSTANCES_SYMBOL = Symbol(
  'charcoal.demoPostAction.canonicalPredictionInstances.v1'
);
const canonicalPredictionInstances = Object.freeze({
  adapter: predictionActionAdapter,
  p4: predictionPostActionProtocol
});
Object.defineProperty(
  demoPostActionServiceExports,
  CANONICAL_PREDICTION_INSTANCES_SYMBOL,
  {
    value: canonicalPredictionInstances,
    enumerable: false,
    writable: false,
    configurable: false
  }
);
Object.freeze(demoPostActionServiceExports);
Object.defineProperty(module, 'exports', {
  value: demoPostActionServiceExports,
  enumerable: true,
  writable: false,
  configurable: false
});
