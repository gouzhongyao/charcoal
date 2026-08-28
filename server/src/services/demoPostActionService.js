'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const { assertDemoRuntimeEnabled, requireDemoDatasetRun } = require('./demoRunService');
const { getDemoParkManifestDigest, DEMO_MANIFEST_VERSION } = require('./demoParkDatasetService');
const { getDemoArtifactRegistration } = require('./demoArtifactRegistry');
const { analyzeEnergyFlow } = require('./energyFlowService');
const { ENERGY_ANALYSIS_VERSIONS, ENERGY_FLOW_SOURCE_TYPES } = require('./energyAnalysisContracts');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  registerDerivedMeterEnergyRecordsInTransaction
} = require('./demoOwnershipService');
const {
  buildMeterReadingEnergyRecordGenerationExactPreviewWithDb,
  executeMeterReadingEnergyRecordGenerationExact,
  prepareMeterReadingGenerationBackupEvidence
} = require('./meterReadingService');
const { insertOperationLogWithDb } = require('./energyStrategyEvaluationService');
const {
  getDemoPostActionRegistryIdentity,
  listDemoPostActions,
  requireDemoPostAction
} = require('./demoPostActionRegistry');

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
  'resultdigest', 'revision', 'runtimeepoch', 'runtimerevision', 'snapshotdigest', 'sourcebatchid',
  'sourcerownumber', 'sql', 'toregistryid'
]));

// 服务端私有 action adapter 表；选择只接受 registry 已校验的 actionKey，不接受客户端注入。
// adapter 同时封装输入解析、预演校验和正式执行，通用生命周期不依赖具体领域字段。
const PRIVATE_ACTION_ADAPTERS = Object.freeze({
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
    mapPreviewBlocker: mapEnergyFlowPreviewBlocker
  })
});

/** 对 JSON 值按键排序，计算服务端稳定 SHA-256 摘要。 */
function stableDigest(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    return item;
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalize(value)), 'utf8').digest('hex');
}

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

/** 校验请求正文是普通 JSON object 且只含允许字段。 */
function assertStrictBody(body, allowedFields, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest(`${operation} 请求正文必须是 JSON object。`, { code: 'DEMO_POST_ACTION_BODY_INVALID' });
  }
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.includes(field));
  if (unknownFields.length > 0) {
    throw badRequest(`${operation} 请求正文包含未知字段。`, {
      code: 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN',
      fields: unknownFields.sort()
    });
  }
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

/** 递归生成动作运行的安全 JSON，避免把 ownership/provenance 或实现细节返回给客户端。 */
function sanitizePublicActionValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicActionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((result, [key, item]) => {
    if (PRIVATE_PUBLIC_FIELD_NAMES.has(key.toLowerCase())) return result;
    result[key] = sanitizePublicActionValue(item);
    return result;
  }, {});
}

/** 按服务端 registry 选中的私有 adapter 投影公开输入，不按动作字段或客户端载荷猜测。 */
function mapPublicActionInput(row) {
  const input = parseJsonObject(row.inputJson) || {};
  let definition;
  try {
    definition = requireDemoPostAction(row.actionKey);
  } catch (_error) {
    return {};
  }
  const adapter = getPrivateActionAdapter(definition);
  if (adapter && typeof adapter.projectPublicInput === 'function') {
    return sanitizePublicActionValue(adapter.projectPublicInput(input));
  }
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

/** 将数据库动作运行行映射为显式安全 API 白名单。 */
function mapActionRun(row, outputs = []) {
  if (!row) return null;
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
    input: mapPublicActionInput(row),
    blocker: mapPublicActionBlocker(row),
    result: (() => {
      const result = parseNullableJsonObject(row.resultJson);
      try {
        const definition = requireDemoPostAction(row.actionKey);
        const adapter = getPrivateActionAdapter(definition);
        if (adapter && typeof adapter.projectPublicResult === 'function') {
          return sanitizePublicActionValue(adapter.projectPublicResult(result));
        }
      } catch (_error) {
        // 历史未知动作只返回通用安全投影。
      }
      return sanitizePublicActionValue(result);
    })(),
    status: row.status,
    retryCount: row.retryCount,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    outputs: outputs.map((output) => ({
      outputEntityType: output.outputEntityType,
      outputRef: sanitizePublicActionValue(output.outputRef),
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

/** 生成安全失败原因；不把异常 message、路径或 SQL 写入审计。 */
function safeFailureReason(error) {
  if (error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,128}$/.test(error.code)) return error.code;
  return 'DEMO_POST_ACTION_EXECUTION_FAILED';
}

/** 生成运行期、manifest 与 registry 的绑定输入。 */
function buildRunBinding(run, runtime) {
  const registry = getDemoPostActionRegistryIdentity();
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

/** 组合 adapter 返回的 domain input 与 evidence，作为服务端输入摘要，不猜测具体字段。 */
function buildActionInput(binding, actionKey, resolved) {
  return {
    ...binding,
    actionKey,
    ...(resolved.domainInput || {}),
    ...(resolved.evidence || {})
  };
}

/** 解析当前动作输入；未连接动作统一生成稳定 blocker，connected 动作只通过私有 adapter。 */
function resolveActionInput(db, definition, run, runtime, actorUserId) {
  const adapter = getPrivateActionAdapter(definition);
  if (!adapter) {
    return {
      domainInput: { requiredArtifactBindings: [...definition.requiredArtifactBindings] },
      evidence: null,
      blocker: { code: 'ACTION_HANDLER_NOT_CONNECTED', message: '该演示后置动作尚未连接服务端 handler/executor。' }
    };
  }
  const resolved = adapter.resolve(db, run, runtime, actorUserId);
  return {
    adapter,
    domainInput: resolved.domainInput,
    evidence: resolved.evidence,
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

/** 预演后置动作，所有输入均由服务端从当前 run 解析并持久化。 */
function previewDemoPostAction(options = {}) {
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
      const binding = buildRunBinding(run, runtime);
      const existing = readIdempotentPreview(db, options.runId, actionKey, clientRequestId, actorUserId);
      if (existing) return mapActionRun(existing, readActionOutputs(db, existing.actionRunId));
      const adapter = getPrivateActionAdapter(definition);
      let resolved;
      try {
        resolved = resolveActionInput(db, definition, run, runtime, actorUserId);
        if (!resolved.blocker) {
          // preview 必须通过私有 adapter 调用正式领域入口，但不持久化预演结果全文。
          resolved.result = resolved.adapter.previewProbe({
            db,
            run,
            runtime,
            domainInput: resolved.domainInput,
            evidence: resolved.evidence,
            actorUserId,
            actorIp: options.actorIp || null
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
      const input = buildActionInput(binding, actionKey, resolved);
      const blocker = resolved.blocker || null;
      const status = blocker ? 'blocked' : 'previewed';
      const inputDigest = stableDigest(input);
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

/** 读取 terminal 状态，重复 execute 直接返回原结果实现幂等。 */
function readTerminalActionRun(db, row) {
  return TERMINAL_ACTION_RUN_STATUSES.includes(row.status) ? mapActionRun(row, readActionOutputs(db, row.actionRunId)) : null;
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

/** 执行已预演动作：CAS 领取、事务外备份、outer transaction 与业务 savepoint 分层原子提交。 */
function executeDemoPostAction(options = {}) {
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
  if (db.inTransaction) {
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
      const binding = buildRunBinding(run, runtime);
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
      const adapter = getPrivateActionAdapter(definition);
      if (!adapter) {
        throw new AppError('ACTION_HANDLER_NOT_CONNECTED', '该演示后置动作尚未连接服务端 handler/executor。', { statusCode: 409 });
      }
      let preflightResolved;
      try {
        preflightResolved = adapter.revalidate({
          db, run, runtime, actionRunId: row.actionRunId, actorUserId, actorIp: options.actorIp || null
        });
      } catch (_error) {
        throw new AppError('DEMO_POST_ACTION_INPUT_STALE', '后置动作输入证据已不可复核，必须重新预演。', { statusCode: 409 });
      }
      const inputDigest = stableDigest(buildActionInput(binding, row.actionKey, preflightResolved));
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
        runtime,
        run,
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

    const outerTransaction = db.transaction(() => {
      const currentRow = readActionRunRow(db, claimed.actionRunId);
      let currentBinding = claimed.binding;
      try {
        const runtime = assertDemoRuntimeEnabled({ db });
        const run = requireWritableRun(db, claimed.runId);
        currentBinding = buildRunBinding(run, runtime);
        assertClaimedActionBinding(currentRow, currentBinding, runtime, actorUserId);
        const resolved = claimed.adapter.revalidate({
          db,
          run,
          runtime,
          actionRunId: claimed.actionRunId,
          actorUserId,
          actorIp: options.actorIp || null
        });
        const inputDigest = stableDigest(buildActionInput(currentBinding, claimed.actionKey, resolved));
        if (inputDigest !== currentRow.inputDigest) {
          throw new AppError('DEMO_POST_ACTION_INPUT_STALE', '后置动作输入已发生变化。', { statusCode: 409 });
        }
        const businessSavepoint = db.transaction(() => {
          const rawExecution = claimed.adapter.execute({
            db,
            run,
            runtime,
            domainInput: resolved.domainInput,
            evidence: resolved.evidence,
            backupEvidence,
            actionRunId: claimed.actionRunId,
            actorUserId,
            actorIp: options.actorIp || null
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
        markExecutingActionFailed(db, {
          actionRunId: claimed.actionRunId,
          actionKey: claimed.actionKey,
          actorUserId,
          actorIp: options.actorIp || null,
          registryDigest: currentBinding.registryDigest
        }, error);
      }
      return mapActionRun(readActionRunRow(db, claimed.actionRunId), readActionOutputs(db, claimed.actionRunId));
    });
    return outerTransaction.immediate();
  } finally {
    if (ownedDb) db.close();
  }
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

module.exports = {
  executeDemoPostAction,
  getDemoPostActionRegistry,
  getDemoPostActionStatus,
  previewDemoPostAction,
  _test: {
    assertStrictBody,
    stableDigest,
    resolveEnergyFlowInput,
    readActionRunRow
  }
};
