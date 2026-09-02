'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 专项测试只使用临时目录和隔离 SQLite，绝不接触默认正式数据库。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-prediction-ownership-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'bootstrap.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'PredictionOwner123!';

const { initDatabase, openDatabase } = require('../db/database');
const demoOwnershipService = require('../services/demoOwnershipService');
const predictionServicePath = require.resolve('../services/predictionService');
const predictionService = require(predictionServicePath);
const createDefinitionCapabilityAuthority = require(
  '../services/demoPostActionDefinitionCapabilityFactory'
);
const createPredictionPostActionProtocol = require(
  '../services/predictionPostActionProtocolFactory'
);
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_CLEANUP_ENTITY_ORDER,
  DEMO_OWNERSHIP_ENTITY_HANDLERS,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED
} = demoOwnershipService;
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');

// 私有协议只通过固定 Symbol 暴露，普通字符串 exports 必须为空。
const PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.prediction.exactInternal.v1');
const DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
const PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.predictionConfig.managedCore.v1');
const exactProtocol = predictionService[PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL];
let ownershipProtocol = null;
const canonicalProtocol =
  demoOwnershipService[DEMO_OWNERSHIP_CANONICAL_INTERNAL_PROTOCOL_SYMBOL];
const predictionManagedCore =
  predictionService[PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL];
const {
  buildPredictionConfidenceFacts,
  formatPredictionForecastMethodNote,
  parsePredictionForecastMethodNote
} = require('../services/predictionUtils');
const DEMO_MANIFEST_DIGEST = getDemoParkManifestDigest();
// Standalone P4 测试仅在 run() 创建平行 factory provenance；作为 P5 fixture 被 require 时不领取 canonical role。
let standaloneDefinitionCapabilityProtocols = null;
const STANDALONE_PREDICTION_REGISTRY_IDENTITY = Object.freeze({
  version: 'demo-post-actions:v7',
  digest: sha256('prediction-p4-standalone-definition-capability'),
  algorithm: 'sha256',
  canonicalization: 'json-sorted-keys-v1'
});
const STANDALONE_PREDICTION_DEFINITION = Object.freeze({
  actionKey: 'prediction-run',
  requiredArtifactBindings: Object.freeze([
    '07-monthly-energy',
    '12-prediction-configs'
  ]),
  resolverVersion: 'prediction-resolver:v1',
  executorVersion: 'prediction-executor:v1',
  implementationStatus: 'connected'
});

/** 生成固定 SHA-256 测试摘要。 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 为 standalone P4 回归创建平行 capability/P4 factory 图，不冒充 canonical service provenance。 */
function initializeStandaloneDefinitionCapabilityProtocols() {
  if (standaloneDefinitionCapabilityProtocols) return standaloneDefinitionCapabilityProtocols;
  const capabilityAuthority = createDefinitionCapabilityAuthority();
  const predictionP4CompletionProtocol = exactProtocol.bindP4CompletionVerifier(
    Object.freeze({})
  );
  ownershipProtocol = createPredictionPostActionProtocol({
    verifyDefinitionCapability: capabilityAuthority.verifyForP4,
    predictionP4CompletionProtocol
  });
  standaloneDefinitionCapabilityProtocols = Object.freeze({
    issuer: Object.freeze({
      issueDefinitionCapability: capabilityAuthority.issueForService
    }),
    adapterVerifier: Object.freeze({
      verifyAdapterDefinitionCapability: capabilityAuthority.verifyForAdapter
    })
  });
  return standaloneDefinitionCapabilityProtocols;
}

/** 为当前 P3 exact invocation 构造并由 adapter verifier 验证正式 execute capability。 */
function issueStandaloneExecuteDefinitionCapability(context) {
  const protocols = initializeStandaloneDefinitionCapabilityProtocols();
  const runtime = Object.freeze({ enabled: 1, runtimeEpoch: 1, revision: 1 });
  const common = {
    db: context.db,
    actionRunId: context.identities.actionRun.actionRunId,
    run: context.identities.demoRun,
    runtime,
    actor: context.identities.actor,
    definition: STANDALONE_PREDICTION_DEFINITION,
    registryIdentity: STANDALONE_PREDICTION_REGISTRY_IDENTITY
  };
  const previewedCapability = protocols.issuer.issueDefinitionCapability({
    ...common,
    stage: 'previewed-revalidate',
    actionStatus: 'previewed',
    parentCapability: null
  });
  protocols.adapterVerifier.verifyAdapterDefinitionCapability({
    capability: previewedCapability,
    db: context.db,
    stage: 'previewed-revalidate',
    actionRunId: common.actionRunId,
    actionStatus: 'previewed',
    run: common.run,
    runtime,
    actor: common.actor,
    parentCapability: null
  });
  const executingCapability = protocols.issuer.issueDefinitionCapability({
    ...common,
    stage: 'executing-revalidate',
    actionStatus: 'executing',
    parentCapability: previewedCapability
  });
  protocols.adapterVerifier.verifyAdapterDefinitionCapability({
    capability: executingCapability,
    db: context.db,
    stage: 'executing-revalidate',
    actionRunId: common.actionRunId,
    actionStatus: 'executing',
    run: common.run,
    runtime,
    actor: common.actor,
    parentCapability: previewedCapability
  });
  const executeCapability = protocols.issuer.issueDefinitionCapability({
    ...common,
    stage: 'execute',
    actionStatus: 'executing',
    parentCapability: executingCapability
  });
  protocols.adapterVerifier.verifyAdapterDefinitionCapability({
    capability: executeCapability,
    db: context.db,
    stage: 'execute',
    actionRunId: common.actionRunId,
    actionStatus: 'executing',
    run: common.run,
    runtime,
    actor: common.actor,
    parentCapability: executingCapability
  });
  return executeCapability;
}

/** 将严格 UTC 毫秒时间戳按固定毫秒数偏移，构造格式合法但事实不同的时间。 */
function shiftUtcMilliseconds(value, offsetMilliseconds = 1000) {
  return new Date(Date.parse(value) + offsetMilliseconds).toISOString();
}

/** 对齐 import audit：对象中的 undefined 必须稳定保存为 null。 */
function normalizeAuditValue(value) {
  if (Array.isArray(value)) return value.map(normalizeAuditValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = normalizeAuditValue(value[key]);
      return result;
    }, {});
  }
  return value === undefined ? null : value;
}

/** 断言错误命中任一稳定错误码。 */
function hasAnyErrorCode(expectedCodes) {
  return (error) => expectedCodes.includes(error?.code)
    || expectedCodes.includes(error?.details?.code);
}

/** 断言 scope/receipt 只是无公开字段的不可伪造空壳。 */
function assertOpaqueOwnershipValue(value, label) {
  assert(value && typeof value === 'object', `${label} 必须是对象。`);
  assert(Object.isFrozen(value), `${label} 必须冻结。`);
  assert.deepStrictEqual(Object.keys(value), [], `${label} 不得公开可枚举字段。`);
  assert.deepStrictEqual(Object.getOwnPropertyNames(value), [], `${label} 不得公开自有字段。`);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(value), [], `${label} 不得公开 Symbol。`);
  assert.strictEqual(JSON.stringify(value), '{}', `${label} 序列化不得泄露私有状态。`);
}

/** 创建带受控 retained upload 的 completed 导入批次。 */
function insertImportBatch(db, importType, suffix, buffer = Buffer.from('fixture\n', 'utf8')) {
  const originalFilename = `${suffix}.csv`;
  const storedFilename = `${suffix}-${crypto.randomUUID()}.csv`;
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, stored_filename, file_type, file_size_bytes,
     file_sha256, status, audit_phase, total_rows, success_count, failure_count, skipped_count)
    VALUES (?, ?, ?, 'csv', ?, ?, 'completed', 'execute', 0, 0, 0, 0)`).run(
    importType,
    originalFilename,
    storedFilename,
    buffer.length,
    sha256(buffer)
  ).lastInsertRowid);
}

/** 创建当前 canonical demo run 固定投影。 */
function insertDemoRun(db, runId, actorUserId) {
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
    runId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    DEMO_MANIFEST_DIGEST,
    actorUserId,
    createdAt
  );
  return {
    runId,
    datasetId: DEMO_DATASET_ID,
    manifestVersion: DEMO_MANIFEST_VERSION,
    manifestDigest: DEMO_MANIFEST_DIGEST,
    status: 'active',
    createdBy: actorUserId,
    createdAt
  };
}

/** 为测试 managed 批次构造与生产 terminal formatter 完全一致的冻结字段。 */
function buildFixtureContextTerminal(context, previewSignature = null) {
  return {
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
  };
}

/** 创建绑定 retained SHA、preview audit 与 actor/runtime 的 executed context。 */
function bindArtifactBatch(db, input) {
  const contextId = `context-${input.runId}-${input.artifactKey}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const batch = db.prepare('SELECT file_sha256 AS fileSha256 FROM import_batches WHERE id = ?')
    .get(input.batchId);
  const previewDigest = input.previewDigest
    || `hmac-sha256:v1:audit:${sha256(`preview-${contextId}`)}`;
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
     artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
     status, issued_at, expires_at, upload_file_sha256, preview_digest,
     previewed_at, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'executed', ?, ?, ?, ?, ?, ?)`).run(
    contextId,
    sha256(`token-${contextId}`),
    input.runId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    DEMO_MANIFEST_DIGEST,
    input.artifactKey,
    input.handlerKey,
    batch.fileSha256,
    input.actorUserId,
    now,
    expiresAt,
    batch.fileSha256,
    previewDigest,
    input.previewed === false ? null : now,
    now
  );
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, 'primary')`).run(
    input.runId,
    input.artifactKey,
    contextId,
    input.batchId
  );
  const context = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
    FROM demo_import_contexts WHERE context_id = ?`).get(contextId);
  const executeBatch = db.prepare(`SELECT preview_signature AS previewSignature,
      execute_result_json AS executeResultJson FROM import_batches WHERE id = ?`).get(input.batchId);
  const executeResult = JSON.parse(executeBatch.executeResultJson);
  executeResult.contextTerminal = buildFixtureContextTerminal(
    context,
    executeBatch.previewSignature
  );
  db.prepare(`UPDATE import_batches SET execute_result_json = ? WHERE id = ?`).run(
    JSON.stringify(executeResult),
    input.batchId
  );
  return { contextId, previewDigest };
}

/** 使用现有 canonical digest 登记 active imported ownership。 */
function registerImportedOwnership(db, input) {
  const handler = DEMO_OWNERSHIP_ENTITY_HANDLERS[input.entityType];
  const projection = handler.readProjection(db, input.entityPk);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)`).run(
    input.runId,
    input.artifactKey,
    input.entityType,
    String(input.entityPk),
    calculateDemoEntityIdentityDigest(input.entityType, String(input.entityPk)),
    calculateDemoEntitySnapshotDigest(input.entityType, String(input.entityPk), projection),
    input.sourceBatchId,
    input.sourceRowNumber,
    input.actorUserId
  );
}

/** 完成 Artifact 07 managed execute audit、ownership 摘要和 retained closure。 */
function finalizeManagedEnergyBatch(db, input) {
  const registryRows = db.prepare(`SELECT entity_pk AS entityPk,
      source_row_number AS sourceRowNumber, identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest
    FROM demo_data_registry WHERE run_id = ? AND artifact_key = '07-monthly-energy'
      AND entity_type = 'energy_record' AND ownership_kind = 'imported'
      AND source_batch_id = ? AND cleaned_at IS NULL
    ORDER BY source_row_number, entity_pk`).all(input.runId, input.batchId).map((row) => ({
    entityPk: String(row.entityPk),
    sourceRowNumber: Number(row.sourceRowNumber),
    identityDigest: row.identityDigest,
    snapshotDigest: row.snapshotDigest
  }));
  const previewDigest = `hmac-sha256:v1:audit:${sha256(`energy-preview-${input.runId}`)}`;
  const closureDigest = canonicalProtocol.sha256Stable({
    domain: 'artifact-07-managed-direct-ownership-closure:v1',
    runId: input.runId,
    artifactKey: '07-monthly-energy',
    batchId: input.batchId,
    records: registryRows
  });
  const statistics = {
    totalRows: registryRows.length,
    successCount: registryRows.length,
    failureCount: 0,
    skippedCount: 0
  };
  const executeResult = {
    executed: true,
    writesBusinessRecords: true,
    statistics,
    ownership: {
      applied: true,
      closureDigest,
      idempotentCount: 0,
      insertedCount: registryRows.length,
      mode: 'demo',
      noInsertedRecords: false,
      registrationCount: registryRows.length,
      relationCount: 0,
      skippedCount: 0
    }
  };
  db.prepare(`UPDATE import_batches SET status = 'completed', audit_phase = 'execute',
      preview_audit_digest = ?, execute_result_json = ?, total_rows = ?, success_count = ?,
      failure_count = 0, skipped_count = 0, finished_at = ?, updated_at = ?
    WHERE id = ?`).run(
    previewDigest,
    JSON.stringify(executeResult),
    statistics.totalRows,
    statistics.successCount,
    new Date().toISOString(),
    new Date().toISOString(),
    input.batchId
  );
  return previewDigest;
}

/** 完成 Artifact 12 retained/HMAC/audit/backup/business/ownership 终态闭包。 */
function finalizeManagedPredictionBatch(db, input) {
  const batch = db.prepare(`SELECT original_filename AS originalFilename,
      stored_filename AS storedFilename, file_size_bytes AS fileSizeBytes,
      file_sha256 AS fileSha256 FROM import_batches WHERE id = ?`).get(input.batchId);
  const buffer = fs.readFileSync(path.join(process.env.UPLOADS_DIR, batch.storedFilename));
  const safeFile = {
    buffer,
    sizeBytes: Number(batch.fileSizeBytes),
    fileSha256: batch.fileSha256
  };
  const preview = predictionManagedCore.rebuildPreview(
    db,
    safeFile,
    batch.originalFilename,
    [input.configId]
  );
  assert.strictEqual(
    preview.candidateRows.length,
    1,
    `Artifact 12 测试 retained 文件必须重建唯一候选：${JSON.stringify(preview.items)}`
  );
  const issues = predictionManagedCore.projectAuditIssues(preview);
  issues.forEach((issue) => {
    db.prepare(`INSERT INTO import_errors
      (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.batchId,
      issue.rowNumber,
      issue.fieldName,
      issue.rawValue,
      issue.errorCode,
      issue.errorReason,
      issue.severity
    );
  });
  const timestamp = new Date().toISOString();
  const backupName = `prediction-${input.runId}-${crypto.randomUUID()}.sqlite`;
  const backupBuffer = Buffer.from(`prediction-backup:${input.runId}`, 'utf8');
  fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.BACKUPS_DIR, backupName), backupBuffer);
  const backup = {
    backupName,
    reason: predictionManagedCore.backupReason,
    method: 'prediction-p4-fixture',
    sizeBytes: backupBuffer.length,
    createdAt: timestamp,
    updatedAt: timestamp,
    sha256: sha256(backupBuffer)
  };
  const registry = db.prepare(`SELECT identity_digest AS identityDigest,
      snapshot_digest AS snapshotDigest FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '12-prediction-configs'
      AND entity_type = 'prediction_config' AND entity_pk = ?
      AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
    input.runId,
    String(input.configId)
  );
  const closureDigest = canonicalProtocol.sha256Stable({
    domain: 'artifact-12-managed-retained-closure:v1',
    runId: input.runId,
    contextId: input.contextId,
    batchId: input.batchId,
    trainingBatchId: input.trainingBatchId,
    retainedFileSha256: batch.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    auditIssues: issues,
    backup,
    configId: input.configId,
    identityDigest: registry.identityDigest,
    snapshotDigest: registry.snapshotDigest
  });
  const statistics = {
    totalRows: preview.summary.totalRows,
    successCount: preview.summary.wouldImport,
    failureCount: preview.summary.blocked,
    skippedCount: preview.summary.skipped
  };
  const executeResult = {
    executed: true,
    imported: 1,
    sourceTrainingBatchId: input.trainingBatchId,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    importedIds: [input.configId],
    importedRecords: [{
      id: input.configId,
      sourceBatchId: input.batchId,
      sourceBatchFilterId: input.trainingBatchId,
      status: 'draft'
    }],
    backup,
    ownership: {
      applied: true,
      mode: 'demo',
      closureDigest,
      registrationCount: 1,
      insertedCount: 1,
      idempotentCount: 0,
      skippedCount: statistics.skippedCount,
      relationCount: 0
    }
  };
  db.prepare(`UPDATE import_batches SET status = ?, audit_phase = 'execute',
      preview_signature = ?, preview_audit_digest = ?, audit_context_json = ?,
      execute_result_json = ?, backup_json = ?, total_rows = ?, success_count = ?,
      failure_count = ?, skipped_count = ?, finished_at = ?, updated_at = ?
    WHERE id = ?`).run(
    statistics.failureCount > 0 || statistics.skippedCount > 0
      ? 'completed_with_errors'
      : 'completed',
    preview.previewSignature,
    preview.previewAuditDigest,
    JSON.stringify({
      summary: preview.summary,
      candidateRows: normalizeAuditValue(preview.candidateRows),
      candidateRowIds: preview.candidateRowIds,
      confirmText: preview.confirmText,
      backupReason: preview.backupReason,
      previewAuditDigest: preview.previewAuditDigest,
      notices: preview.notices
    }),
    JSON.stringify(executeResult),
    JSON.stringify(backup),
    statistics.totalRows,
    statistics.successCount,
    statistics.failureCount,
    statistics.skippedCount,
    timestamp,
    timestamp,
    input.batchId
  );
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip)
    VALUES (?, 'prediction.config.import.preview', 'prediction_config_import', ?, ?, '127.0.0.1')`).run(
    input.actorUserId,
    String(input.batchId),
    JSON.stringify({
      wouldImport: preview.summary.wouldImport,
      blocked: preview.summary.blocked
    })
  );
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip)
    VALUES (?, 'prediction.config.import.execute', 'prediction_config_import', ?, ?, '127.0.0.1')`).run(
    input.actorUserId,
    String(input.batchId),
    JSON.stringify({
      imported: 1,
      writesPredictionRuns: false,
      writesPredictionResults: false
    })
  );
  return preview.previewAuditDigest;
}

/** 创建 executing Prediction action run 固定投影。 */
function insertActionRun(db, demoRun, actorUserId, suffix) {
  const now = new Date().toISOString();
  const actionRun = {
    actionRunId: `prediction-action-${suffix}`,
    runId: demoRun.runId,
    datasetId: demoRun.datasetId,
    actionKey: 'prediction-run',
    requestedBy: actorUserId,
    status: 'executing'
  };
  db.prepare(`INSERT INTO demo_post_action_runs
    (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
     executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
     runtime_epoch, runtime_revision, input_digest, preview_digest, output_count,
     preview_expires_at, input_json, requested_by, status, created_at, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-registry:v6', 'test-resolver:v6',
      'prediction-executor:v1', ?, ?, ?, ?, 1, 1, ?, ?, 0,
      ?, '{}', ?, 'executing', ?, ?, ?)`).run(
    actionRun.actionRunId,
    demoRun.runId,
    demoRun.datasetId,
    actionRun.actionKey,
    `request-${suffix}`,
    demoRun.manifestVersion,
    demoRun.manifestDigest,
    sha256(`registry-${suffix}`),
    sha256(`input-${suffix}`),
    sha256(`preview-${suffix}`),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    actorUserId,
    now,
    now,
    now
  );
  return actionRun;
}

/** 插入一条完整来源身份能耗记录。 */
function insertEnergyRecord(db, input) {
  return Number(db.prepare(`INSERT INTO energy_records
    (source_batch_id, source_row_number, energy_type_id, organization_unit_id,
     meter_device_id, original_month, normalized_month, original_unit,
     original_value, normalized_unit, normalized_value, remark, duplicate_key, record_status)
    VALUES (@sourceBatchId, @sourceRowNumber, @energyTypeId, @organizationUnitId,
     @meterDeviceId, @month, @month, @unit, @value, @unit, @value,
     @remark, @duplicateKey, 'active')`).run({
    unit: 'kWh',
    ...input
  }).lastInsertRowid);
}

/** 创建 Artifact 07/12 managed source、普通哨兵和 action 身份夹具。 */
function seedFixture(db, suffix, algorithm, actorUserId, options = {}) {
  db.prepare(`UPDATE demo_runtime_settings SET enabled = 1, runtime_epoch = 1,
    revision = 1, updated_by = ?, updated_at = ?, change_reason = 'prediction-p4-test' WHERE id = 1`)
    .run(actorUserId, new Date().toISOString());
  const demoRun = insertDemoRun(db, `prediction-ownership-${suffix}`, actorUserId);
  const configName = `Prediction ownership ${suffix}`;
  const configNote = `Prediction ownership note ${suffix}`;
  const trainingMonths = ['2026-01', '2026-02', '2026-03', '2026-04'].slice(
    0,
    options.trainingMonthCount ?? 4
  );
  const energyBuffer = Buffer.from([
    '月份,能源类型编码,用量,单位,用能单元编码,计量器具编码,备注',
    ...trainingMonths.map((month, index) => (
      `${month},electricity,${100 + index * 10},kWh,PRED-${suffix},METER-${suffix},训练记录-${index + 1}`
    )),
    ...(options.includePartialGroup === true
      ? ['2026-01', '2026-02'].map((month, index) => (
          `${month},water,${20 + index * 5},m3,PRED-${suffix},WATER-${suffix},不足组记录-${index + 1}`
        ))
      : []),
    '2025-12,electricity,91,kWh,PRED-' + suffix + ',METER-' + suffix + ',训练月份外记录',
    '2026-02,electricity,92,kWh,OTHER-' + suffix + ',OTHER-METER-' + suffix + ',其他组织记录',
    `${options.includePartialGroup === true ? '2025-12' : '2026-02'},electricity,93,kWh,PRED-${suffix},ALT-METER-${suffix},其他仪表记录`,
    `${options.includePartialGroup === true ? '2025-12' : '2026-02'},water,94,m3,PRED-${suffix},EXTRA-WATER-${suffix},其他能源类型记录`
  ].join('\n'), 'utf8');
  const configEnergyTypeCode = options.includePartialGroup === true ? null : 'electricity';
  const configMeterCode = options.includePartialGroup === true ? null : `METER-${suffix}`;
  const configBuffer = Buffer.from((options.includePartialGroup === true
    ? [
        '配置名称,备注,用能单元编码,能耗批次ID,训练开始月份,训练结束月份,预测开始月份,预测结束月份,算法,状态',
        `${configName},${configNote},PRED-${suffix},,2026-01,2026-04,2026-05,2026-06,${algorithm},active`
      ]
    : [
        '配置名称,备注,能源类型编码,用能单元编码,计量器具编码,能耗批次ID,训练开始月份,训练结束月份,预测开始月份,预测结束月份,算法,状态',
        `${configName},${configNote},${configEnergyTypeCode},PRED-${suffix},${configMeterCode},,2026-01,2026-04,2026-05,2026-06,${algorithm},active`
      ]).join('\n'), 'utf8');
  const energyBatchId = insertImportBatch(db, 'energy_record', `${suffix}-energy`, energyBuffer);
  const otherEnergyBatchId = insertImportBatch(db, 'energy_record', `${suffix}-sentinel-energy`);
  const configBatchId = insertImportBatch(db, 'prediction_config', `${suffix}-config`, configBuffer);

  const electricityId = Number(db.prepare(
    "SELECT id FROM energy_types WHERE code = 'electricity'"
  ).get().id);
  const waterId = Number(db.prepare(
    "SELECT id FROM energy_types WHERE code = 'water'"
  ).get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, ?, ?, 'enterprise', 'active')`).run(
    `PRED-${suffix}`,
    `Prediction ${suffix}`,
    `/PRED-${suffix}`
  ).lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'other', ?, ?, 'active')`).run(
    `METER-${suffix}`,
    `Prediction meter ${suffix}`,
    electricityId,
    organizationUnitId
  ).lastInsertRowid);
  const waterMeterDeviceId = options.includePartialGroup === true
    ? Number(db.prepare(`INSERT INTO meter_devices
        (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
        VALUES (?, ?, 'other', ?, ?, 'active')`).run(
      `WATER-${suffix}`,
      `Prediction water meter ${suffix}`,
      waterId,
      organizationUnitId
    ).lastInsertRowid)
    : null;
  const otherOrganizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, ?, ?, 'enterprise', 'active')`).run(
    `OTHER-${suffix}`,
    `Other organization ${suffix}`,
    `/OTHER-${suffix}`
  ).lastInsertRowid);
  const otherOrganizationMeterId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'other', ?, ?, 'active')`).run(
    `OTHER-METER-${suffix}`,
    `Other organization meter ${suffix}`,
    electricityId,
    otherOrganizationUnitId
  ).lastInsertRowid);
  const alternateMeterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'other', ?, ?, 'active')`).run(
    `ALT-METER-${suffix}`,
    `Alternate meter ${suffix}`,
    electricityId,
    organizationUnitId
  ).lastInsertRowid);
  const extraWaterMeterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'other', ?, ?, 'active')`).run(
    `EXTRA-WATER-${suffix}`,
    `Extra water meter ${suffix}`,
    waterId,
    organizationUnitId
  ).lastInsertRowid);

  const electricityTrainingRecordIds = trainingMonths.map((month, index) => insertEnergyRecord(db, {
    sourceBatchId: energyBatchId,
    sourceRowNumber: index + 2,
    energyTypeId: electricityId,
    organizationUnitId,
    meterDeviceId,
    month,
    value: 100 + index * 10,
    remark: `训练记录-${index + 1}`,
    duplicateKey: `prediction-${suffix}-training-${index + 1}`
  }));
  const waterTrainingRecordIds = options.includePartialGroup === true
    ? ['2026-01', '2026-02'].map((month, index) => insertEnergyRecord(db, {
      sourceBatchId: energyBatchId,
      sourceRowNumber: trainingMonths.length + index + 2,
      energyTypeId: waterId,
      organizationUnitId,
      meterDeviceId: waterMeterDeviceId,
      month,
      unit: 'm3',
      value: 20 + index * 5,
      remark: `不足组记录-${index + 1}`,
      duplicateKey: `prediction-${suffix}-water-training-${index + 1}`
    }))
    : [];
  const trainingRecordIds = [
    ...electricityTrainingRecordIds,
    ...waterTrainingRecordIds
  ];
  const managedNonMatchingInputs = [
    {
      energyTypeId: electricityId,
      organizationUnitId,
      meterDeviceId,
      month: '2025-12',
      unit: 'kWh',
      value: 91,
      remark: '训练月份外记录',
      duplicateKey: `prediction-${suffix}-outside-month`
    },
    {
      energyTypeId: electricityId,
      organizationUnitId: otherOrganizationUnitId,
      meterDeviceId: otherOrganizationMeterId,
      month: '2026-02',
      unit: 'kWh',
      value: 92,
      remark: '其他组织记录',
      duplicateKey: `prediction-${suffix}-other-organization`
    },
    {
      energyTypeId: electricityId,
      organizationUnitId,
      meterDeviceId: alternateMeterDeviceId,
      month: options.includePartialGroup === true ? '2025-12' : '2026-02',
      unit: 'kWh',
      value: 93,
      remark: '其他仪表记录',
      duplicateKey: `prediction-${suffix}-other-meter`
    },
    {
      energyTypeId: waterId,
      organizationUnitId,
      meterDeviceId: extraWaterMeterDeviceId,
      month: options.includePartialGroup === true ? '2025-12' : '2026-02',
      unit: 'm3',
      value: 94,
      remark: '其他能源类型记录',
      duplicateKey: `prediction-${suffix}-other-energy-type`
    }
  ];
  const managedNonMatchingRecordIds = managedNonMatchingInputs.map((record, index) => (
    insertEnergyRecord(db, {
      ...record,
      sourceBatchId: energyBatchId,
      sourceRowNumber: trainingRecordIds.length + index + 2
    })
  ));
  const allManagedEnergyRecordIds = [...trainingRecordIds, ...managedNonMatchingRecordIds];
  allManagedEnergyRecordIds.forEach((entityPk, index) => registerImportedOwnership(db, {
    runId: demoRun.runId,
    artifactKey: '07-monthly-energy',
    entityType: 'energy_record',
    entityPk,
    sourceBatchId: energyBatchId,
    sourceRowNumber: index + 2,
    actorUserId
  }));
  const energyPreviewDigest = finalizeManagedEnergyBatch(db, {
    runId: demoRun.runId,
    batchId: energyBatchId
  });
  bindArtifactBatch(db, {
    runId: demoRun.runId,
    artifactKey: '07-monthly-energy',
    handlerKey: 'monthly-energy-import',
    batchId: energyBatchId,
    actorUserId,
    previewDigest: energyPreviewDigest,
    previewed: false
  });

  const sentinelRecordId = insertEnergyRecord(db, {
    sourceBatchId: otherEnergyBatchId,
    sourceRowNumber: 2,
    energyTypeId: electricityId,
    organizationUnitId,
    meterDeviceId,
    month: '2026-02',
    value: 999,
    remark: '普通正式能耗哨兵',
    duplicateKey: `prediction-${suffix}-record-sentinel`
  });
  const configId = Number(db.prepare(`INSERT INTO prediction_configs
    (source_batch_id, source_row_number, name, note, energy_type_id,
     organization_unit_id, meter_device_id, source_batch_filter_id,
     train_start_month, train_end_month, predict_start_month, predict_end_month,
     algorithm, window_size, status)
    VALUES (?, 2, ?, ?, ?, ?, ?, ?, '2026-01', '2026-04', '2026-05', '2026-06',
     ?, ?, 'draft')`).run(
    configBatchId,
    configName,
    configNote,
    options.includePartialGroup === true ? null : electricityId,
    organizationUnitId,
    options.includePartialGroup === true ? null : meterDeviceId,
    energyBatchId,
    algorithm,
    algorithm === 'moving_average' ? (options.windowSize ?? 3) : null
  ).lastInsertRowid);
  registerImportedOwnership(db, {
    runId: demoRun.runId,
    artifactKey: '12-prediction-configs',
    entityType: 'prediction_config',
    entityPk: configId,
    sourceBatchId: configBatchId,
    sourceRowNumber: 2,
    actorUserId
  });
  const predictionContextId = `context-${demoRun.runId}-12-prediction-configs`;
  const predictionPreviewDigest = finalizeManagedPredictionBatch(db, {
    runId: demoRun.runId,
    contextId: predictionContextId,
    batchId: configBatchId,
    trainingBatchId: energyBatchId,
    configId,
    actorUserId
  });
  bindArtifactBatch(db, {
    runId: demoRun.runId,
    artifactKey: '12-prediction-configs',
    handlerKey: 'prediction-configs-import',
    batchId: configBatchId,
    actorUserId,
    previewDigest: predictionPreviewDigest
  });
  const sentinelConfigId = Number(db.prepare(`INSERT INTO prediction_configs
    (name, note, train_start_month, train_end_month, predict_start_month,
     predict_end_month, algorithm, window_size, status)
    VALUES (?, '普通正式配置哨兵', '2025-01', '2025-04', '2025-05', '2025-06',
     'moving_average', 3, 'draft')`).run(
    `Prediction sentinel ${suffix}`
  ).lastInsertRowid);
  const actionRun = insertActionRun(db, demoRun, actorUserId, suffix);
  return {
    demoRun,
    actionRun,
    energyBatchId,
    configBatchId,
    electricityId,
    organizationUnitId,
    meterDeviceId,
    trainingRecordIds,
    managedNonMatchingRecordIds,
    sentinelRecordId,
    configId,
    sentinelConfigId,
    configName,
    configNote,
    configEnergyTypeCode: configEnergyTypeCode || null,
    configMeterCode: configMeterCode || null,
    electricityTrainingRecordIds,
    waterTrainingRecordIds,
    algorithm
  };
}

/** 创建一个独立临时 SQLite 夹具。 */
function createHarness(name, algorithm = 'moving_average', options = {}) {
  const databasePath = path.join(temporaryRoot, `${name}.sqlite`);
  initDatabase({ databasePath });
  const db = openDatabase({ databasePath });
  const actorRow = db.prepare(`SELECT id AS userId, username, display_name AS displayName
    FROM sys_users WHERE username = 'admin'`).get();
  const actor = { ...actorRow, ip: '127.0.0.1' };
  const fixture = seedFixture(db, name, algorithm, actor.userId, options);
  return { db, actor, fixture, databasePath };
}

/** 构造与唯一 Artifact 12 config 精确一致的 payload 与 config snapshot。 */
function buildPredictionInput(harness) {
  const { fixture } = harness;
  const organizationUnitCode = `PRED-${fixture.demoRun.runId.replace('prediction-ownership-', '')}`;
  const configSnapshot = {
    configId: fixture.configId,
    config: {
      name: fixture.configName,
      note: fixture.configNote,
      energyTypeCode: fixture.configEnergyTypeCode,
      organizationUnitId: fixture.organizationUnitId,
      organizationUnitCode,
      meterDeviceId: fixture.configMeterCode ? fixture.meterDeviceId : null,
      meterCode: fixture.configMeterCode,
      sourceBatchId: fixture.energyBatchId,
      trainStartMonth: '2026-01',
      trainEndMonth: '2026-04',
      predictStartMonth: '2026-05',
      predictEndMonth: '2026-06',
      algorithm: fixture.algorithm,
      windowSize: fixture.algorithm === 'moving_average' ? 3 : null
    }
  };
  const payload = {
    name: fixture.configName,
    note: fixture.configNote,
    ...(fixture.configEnergyTypeCode
      ? { energyTypeCode: fixture.configEnergyTypeCode }
      : {}),
    organizationUnitCode,
    organizationUnitId: fixture.organizationUnitId,
    ...(fixture.configMeterCode
      ? {
          meterCode: fixture.configMeterCode,
          meterDeviceId: fixture.meterDeviceId
        }
      : {}),
    sourceBatchId: fixture.energyBatchId,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-04',
    predictStartMonth: '2026-05',
    predictEndMonth: '2026-06',
    algorithm: fixture.algorithm,
    ...(fixture.algorithm === 'moving_average' ? { windowSize: 3 } : {})
  };
  return { payload, configSnapshot };
}

/** 在 caller-owned transaction 与 P3 exact scope 中执行一次协议场景。 */
function runExactScenario(harness, operation) {
  const { db, fixture, actor } = harness;
  const identities = {
    demoRun: fixture.demoRun,
    actionRun: fixture.actionRun,
    actor
  };
  const { payload, configSnapshot } = buildPredictionInput(harness);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = exactProtocol.withCallerTransactionScope(
      { db, ...identities },
      (transactionScope) => {
        const inspected = exactProtocol.inspectExact({
          db,
          transactionScope,
          payload,
          configSnapshot
        });
        const executed = exactProtocol.executeExact({
          db,
          transactionScope,
          exactCapability: inspected.exactCapability,
          ...identities
        });
        return operation({
          db,
          transactionScope,
          completionWitness: executed.completionWitness,
          identities,
          inspected,
          executed
        });
      }
    );
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.open && db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 在最外层 SAVEPOINT caller transaction 内执行 exact 场景，并由测试负责最终回滚。 */
function runOuterSavepointScenario(harness, operation) {
  const { db, fixture, actor } = harness;
  const identities = {
    demoRun: fixture.demoRun,
    actionRun: fixture.actionRun,
    actor
  };
  const { payload, configSnapshot } = buildPredictionInput(harness);
  const outerSavepoint = `caller_outer_${crypto.randomBytes(8).toString('hex')}`;
  db.exec(`SAVEPOINT ${outerSavepoint}`);
  const preparedOuterRelease = db.prepare(`RELEASE SAVEPOINT ${outerSavepoint}`);
  try {
    return exactProtocol.withCallerTransactionScope(
      { db, ...identities },
      (transactionScope) => {
        const inspected = exactProtocol.inspectExact({
          db,
          transactionScope,
          payload,
          configSnapshot
        });
        const executed = exactProtocol.executeExact({
          db,
          transactionScope,
          exactCapability: inspected.exactCapability,
          ...identities
        });
        return operation({
          db,
          transactionScope,
          completionWitness: executed.completionWitness,
          identities,
          inspected,
          executed,
          outerSavepoint,
          preparedOuterRelease
        });
      }
    );
  } finally {
    if (db.open && db.inTransaction) {
      db.exec(`ROLLBACK TO SAVEPOINT ${outerSavepoint}`);
      db.exec(`RELEASE SAVEPOINT ${outerSavepoint}`);
    }
  }
}

/** 读取当前 standalone 场景正式 execute capability，同一 P4 链保持原引用。 */
function requireStandaloneExecuteDefinitionCapability(context) {
  if (!context.definitionCapability) {
    context.definitionCapability = issueStandaloneExecuteDefinitionCapability(context);
  }
  return context.definitionCapability;
}

/** 签发 scope、登记 derived ownership并生成 receipt。 */
function registerPredictionOwnership(context) {
  const binding = {
    db: context.db,
    transactionScope: context.transactionScope,
    completionWitness: context.completionWitness,
    definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
    ...context.identities
  };
  const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
  const registrationReceipt = ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
    ...binding,
    registrationScope
  });
  return { binding, registrationScope, registrationReceipt };
}

/** 完成一次正常 one-shot receipt 验证。 */
function completePredictionOwnership(context) {
  const registration = registerPredictionOwnership(context);
  assertOpaqueOwnershipValue(registration.registrationScope, 'registration scope');
  assertOpaqueOwnershipValue(registration.registrationReceipt, 'registration receipt');
  assert.strictEqual(ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
    ...registration.binding,
    registrationScope: registration.registrationScope,
    registrationReceipt: registration.registrationReceipt
  }), true);
  return registration;
}

/** 读取当前夹具的 Prediction 域与 derived governance 计数。 */
function readDerivedCounts(harness, providedDb = harness.db) {
  const { fixture } = harness;
  const db = providedDb;
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_runs').get().count),
    results: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_results').get().count),
    derived: Number(db.prepare(`SELECT COUNT(*) AS count FROM demo_data_registry
      WHERE run_id = ? AND ownership_kind = 'derived'
        AND entity_type IN ('prediction_run', 'prediction_result')`).get(
      fixture.demoRun.runId
    ).count),
    relations: Number(db.prepare(
      'SELECT COUNT(*) AS count FROM demo_data_relations WHERE run_id = ?'
    ).get(fixture.demoRun.runId).count)
  };
}

/** 断言失败场景最终完整回滚 P3 域写入与 P4 governance 写入。 */
function assertScenarioRollsBack(harness, operation, expectedCodes = []) {
  assert.throws(
    () => runExactScenario(harness, operation),
    expectedCodes.length > 0 ? hasAnyErrorCode(expectedCodes) : undefined
  );
  const verificationDb = harness.db.open
    ? harness.db
    : openDatabase({ databasePath: harness.databasePath });
  try {
    assert.deepStrictEqual(readDerivedCounts(harness, verificationDb), {
      runs: 0,
      results: 0,
      derived: 0,
      relations: 0
    });
    assert.strictEqual(Number(verificationDb.prepare(
      'SELECT COUNT(*) AS count FROM demo_post_action_outputs'
    ).get().count), 0, '失败场景不得残留 post-action output。');
  } finally {
    if (verificationDb !== harness.db) verificationDb.close();
  }
}

/** 在隔离 caller-owned transaction 中直接复验 Artifact 07/12 managed exact 来源集合。 */
function verifyManagedSourceIds(harness, energyRecordEntityPks) {
  return harness.db.transaction(() => canonicalProtocol.verifyManagedImportedSourceExactClosure({
    actorUserId: harness.actor.userId,
    configEntityPk: harness.fixture.configId,
    db: harness.db,
    demoRunId: harness.fixture.demoRun.runId,
    energyRecordEntityPks
  })).immediate();
}

/** 验证正式 config 只吸收 Artifact 07 primary batch 的完整匹配子集并拒绝集合伪造。 */
function testManagedFilteredSourceSetContract() {
  const positiveHarness = createHarness('managed-filtered-positive');
  try {
    const closure = verifyManagedSourceIds(
      positiveHarness,
      positiveHarness.fixture.trainingRecordIds
    );
    const fullManagedCount = Number(positiveHarness.db.prepare(`SELECT COUNT(*) AS count
      FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '07-monthly-energy'
        AND entity_type = 'energy_record' AND ownership_kind = 'imported'
        AND source_batch_id = ? AND cleaned_at IS NULL`).get(
      positiveHarness.fixture.demoRun.runId,
      positiveHarness.fixture.energyBatchId
    ).count);
    assert.strictEqual(
      fullManagedCount,
      positiveHarness.fixture.trainingRecordIds.length
        + positiveHarness.fixture.managedNonMatchingRecordIds.length
    );
    assert.deepStrictEqual(
      closure.energyRecordEntityPks,
      positiveHarness.fixture.trainingRecordIds
    );
    assert.strictEqual(closure.energyBatchId, positiveHarness.fixture.energyBatchId);
    assert.strictEqual(typeof closure.energyOwnershipClosureDigest, 'string');
  } finally {
    positiveHarness.db.close();
  }

  const cases = [
    {
      name: 'missing-filtered-record',
      buildIds(fixture) {
        return fixture.trainingRecordIds.slice(1);
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INVALID']
    },
    {
      name: 'extra-same-batch-nonmatching-record',
      buildIds(fixture) {
        return [...fixture.trainingRecordIds, fixture.managedNonMatchingRecordIds[0]];
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INVALID']
    },
    {
      name: 'extra-other-batch-matching-record',
      buildIds(fixture) {
        return [...fixture.trainingRecordIds, fixture.sentinelRecordId];
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INVALID']
    },
    {
      name: 'empty-witness',
      buildIds() {
        return [];
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INPUT_INVALID']
    },
    {
      name: 'duplicate-witness',
      buildIds(fixture) {
        return [...fixture.trainingRecordIds, fixture.trainingRecordIds[0]];
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INPUT_INVALID']
    },
    {
      name: 'invalid-witness-id',
      buildIds(fixture) {
        return [...fixture.trainingRecordIds.slice(1), 0];
      },
      expectedCodes: ['DEMO_MANAGED_SOURCE_CLOSURE_INPUT_INVALID']
    }
  ];
  cases.forEach((testCase) => {
    const harness = createHarness(`managed-filtered-${testCase.name}`);
    try {
      assert.throws(
        () => verifyManagedSourceIds(harness, testCase.buildIds(harness.fixture)),
        hasAnyErrorCode(testCase.expectedCodes)
      );
      assert.deepStrictEqual(readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
      assert.strictEqual(Number(harness.db.prepare(
        'SELECT COUNT(*) AS count FROM demo_post_action_outputs'
      ).get().count), 0);
    } finally {
      harness.db.close();
    }
  });
}

/** 验证平行 P4 factory surface、废弃 capability 无 authority 入口和未连接能力边界。 */
function testPrivateProtocolSurface() {
  assert(ownershipProtocol && Object.isFrozen(ownershipProtocol));
  assert.deepStrictEqual(Object.keys(ownershipProtocol), [
    'issueRegistrationScopeInCallerTransaction',
    'registerDerivedOwnershipInCallerTransaction',
    'verifyRegistrationReceiptInCallerTransaction',
    'abortRegistrationScopeInCallerTransaction'
  ]);
  const deprecatedCapability = require('../services/demoPostActionDefinitionCapability');
  const deprecatedCapabilityKey = require('../services/demoPostActionDefinitionCapabilityKey');
  assert.deepStrictEqual(Object.keys(deprecatedCapability), []);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(deprecatedCapability), []);
  assert.strictEqual(Object.isFrozen(deprecatedCapability), true);
  assert.strictEqual(Symbol.keyFor(deprecatedCapabilityKey), undefined);
  assert.strictEqual(
    Object.getOwnPropertySymbols(deprecatedCapability).some((protocolSymbol) => {
      const value = deprecatedCapability[protocolSymbol];
      return value && ['bindIssuer', 'bindAdapter', 'bindAdapterVerifier', 'bindP4', 'bindP4Verifier']
        .some((fieldName) => typeof value[fieldName] === 'function');
    }),
    false
  );
  const factoryPath = require.resolve('../services/predictionPostActionProtocolFactory');
  const moduleDescriptor = Object.getOwnPropertyDescriptor(
    require.cache[factoryPath],
    'exports'
  );
  assert.strictEqual(moduleDescriptor.writable, false);
  assert.strictEqual(moduleDescriptor.configurable, false);
  assert.strictEqual(DEMO_OWNERSHIP_REGISTRATION_CONNECTED, false);
  assert.deepStrictEqual(DEMO_CLEANUP_ENTITY_ORDER, ['prediction_config', 'energy_record']);
}

/** 验证 moving average 与 linear trend 都登记完整实际训练集合的 run-level lineage。 */
function testSuccessfulAlgorithmsAndLineage() {
  ['moving_average', 'linear_trend'].forEach((algorithm) => {
    const harness = createHarness(`success-${algorithm}`, algorithm);
    try {
      const completed = runExactScenario(harness, (context) => {
        const registration = completePredictionOwnership(context);
        return {
          runId: context.executed.run.id,
          resultCount: context.executed.summary.resultCount,
          registration
        };
      });
      assert.deepStrictEqual(readDerivedCounts(harness), {
        runs: 1,
        results: 2,
        derived: 3,
        relations: 7
      });
      const registryRows = harness.db.prepare(`SELECT registry_id AS registryId,
          entity_type AS entityType, entity_pk AS entityPk, ownership_kind AS ownershipKind,
          artifact_key AS artifactKey, source_batch_id AS sourceBatchId,
          source_row_number AS sourceRowNumber, registered_by AS registeredBy
        FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'derived'
        ORDER BY entity_type, CAST(entity_pk AS INTEGER)`).all(harness.fixture.demoRun.runId);
      assert.deepStrictEqual(
        registryRows.map((row) => row.entityType),
        ['prediction_result', 'prediction_result', 'prediction_run']
      );
      assert(registryRows.every((row) => row.artifactKey === '12-prediction-configs'));
      assert(registryRows.every((row) => row.sourceBatchId === null && row.sourceRowNumber === null));
      assert(registryRows.every((row) => Number(row.registeredBy) === harness.actor.userId));

      const relations = harness.db.prepare(`SELECT rel.relation_type AS relationType,
          source.entity_type AS sourceType, source.entity_pk AS sourcePk,
          target.entity_type AS targetType, target.entity_pk AS targetPk
        FROM demo_data_relations rel
        JOIN demo_data_registry source ON source.registry_id = rel.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = rel.to_registry_id
        WHERE rel.run_id = ? ORDER BY rel.relation_type, CAST(target.entity_pk AS INTEGER)`).all(
        harness.fixture.demoRun.runId
      );
      assert.strictEqual(relations.filter((row) => row.relationType === 'contains').length, 2);
      assert.strictEqual(relations.filter((row) => row.relationType === 'uses_config').length, 1);
      assert.strictEqual(relations.filter((row) => row.relationType === 'generated_from').length, 4);
      assert(relations.every((row) => row.sourceType === 'prediction_run'));
      assert(relations.filter((row) => row.relationType === 'contains')
        .every((row) => row.targetType === 'prediction_result'));
      const generatedFromIds = relations.filter((row) => row.relationType === 'generated_from')
        .map((row) => Number(row.targetPk));
      assert.deepStrictEqual(generatedFromIds, harness.fixture.trainingRecordIds);
      assert.strictEqual(
        harness.fixture.managedNonMatchingRecordIds.some((entityPk) => generatedFromIds.includes(entityPk)),
        false,
        'generated_from 只能登记正式 filters 匹配的 exact 子集。'
      );
      assert.strictEqual(generatedFromIds.includes(harness.fixture.sentinelRecordId), false,
        '其他批次中即使符合业务 filters 的记录也不得被吸收。');
      assert.strictEqual(relations.some((row) => (
        row.relationType === 'generated_from' && row.sourceType === 'prediction_result'
      )), false, '不得创建 result × training records 笛卡尔积。');
      assert.strictEqual(harness.db.prepare(`SELECT COUNT(*) AS count FROM demo_data_registry
        WHERE entity_type = 'energy_record' AND entity_pk = ?`).get(
        String(harness.fixture.sentinelRecordId)
      ).count, 0);
      assert.strictEqual(harness.db.prepare(`SELECT COUNT(*) AS count FROM demo_data_registry
        WHERE entity_type = 'prediction_config' AND entity_pk = ?`).get(
        String(harness.fixture.sentinelConfigId)
      ).count, 0);
      assert.strictEqual(Number(completed.runId) > 0, true);
      assert.strictEqual(completed.resultCount, 2);
    } finally {
      harness.db.close();
    }
  });

  const partialHarness = createHarness(
    'success-partial-group-outer-rollback',
    'moving_average',
    { includePartialGroup: true }
  );
  try {
    runOuterSavepointScenario(partialHarness, (context) => {
      assert.strictEqual(context.inspected.summary.eligibleGroups.length, 1);
      assert.strictEqual(context.inspected.summary.skippedGroups.length, 1);
      assert.strictEqual(context.inspected.summary.exactTrainingRecords.length, 6);
      assert.deepStrictEqual(
        context.inspected.summary.exactTrainingRecords.map((record) => Number(record.id)).sort((a, b) => a - b),
        [...partialHarness.fixture.trainingRecordIds].sort((a, b) => a - b),
        '部分 group 不足时仍必须绑定正式 filters 匹配的全部记录。'
      );
      assert.strictEqual(context.executed.summary.resultCount, 2);
      completePredictionOwnership(context);
      assert.deepStrictEqual(readDerivedCounts(partialHarness), {
        runs: 1,
        results: 2,
        derived: 3,
        relations: 9
      });
      const generatedFromIds = context.db.prepare(`SELECT CAST(target.entity_pk AS INTEGER) AS entityPk
        FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE relation.run_id = ? AND relation.relation_type = 'generated_from'
          AND source.entity_type = 'prediction_run'
        ORDER BY CAST(target.entity_pk AS INTEGER)`).all(
        partialHarness.fixture.demoRun.runId
      ).map((row) => Number(row.entityPk));
      assert.deepStrictEqual(generatedFromIds, partialHarness.fixture.trainingRecordIds);
      assert.strictEqual(
        partialHarness.fixture.managedNonMatchingRecordIds
          .some((entityPk) => generatedFromIds.includes(entityPk)),
        false
      );
    });
    assert.deepStrictEqual(readDerivedCounts(partialHarness), {
      runs: 0,
      results: 0,
      derived: 0,
      relations: 0
    });
  } finally {
    partialHarness.db.close();
  }
}

/** 验证模块初始化后普通 exports 与 require.cache 替换不能接管已捕获协议。 */
function testPostInitializationMonkeypatchIsolation() {
  const harness = createHarness('post-init-monkeypatch');
  const ownershipServicePath = require.resolve('../services/demoOwnershipService');
  const originalOwnershipEntry = require.cache[ownershipServicePath];
  const originalPredictionEntry = require.cache[predictionServicePath];
  try {
    require.cache[ownershipServicePath] = { exports: { compromised: true } };
    require.cache[predictionServicePath] = { exports: { compromised: true } };
    runExactScenario(harness, (context) => completePredictionOwnership(context));
    assert.deepStrictEqual(readDerivedCounts(harness), {
      runs: 1,
      results: 2,
      derived: 3,
      relations: 7
    });
  } finally {
    require.cache[ownershipServicePath] = originalOwnershipEntry;
    require.cache[predictionServicePath] = originalPredictionEntry;
    harness.db.close();
  }
}

/** 验证 scope、receipt、DB、身份和生命周期错误即使被 caller 捕获也会 fail-closed。 */
function testOpaqueBindingAndReplayFailures() {
  const cases = [
    {
      name: 'direct-p4-missing-definition-capability',
      operation(context) {
        try {
          ownershipProtocol.issueRegistrationScopeInCallerTransaction({
            db: context.db,
            transactionScope: context.transactionScope,
            completionWitness: context.completionWitness,
            definitionCapability: null,
            ...context.identities
          });
        } catch (_error) {}
      }
    },
    {
      name: 'direct-p4-forged-definition-capability',
      operation(context) {
        try {
          ownershipProtocol.issueRegistrationScopeInCallerTransaction({
            db: context.db,
            transactionScope: context.transactionScope,
            completionWitness: context.completionWitness,
            definitionCapability: Object.freeze({}),
            ...context.identities
          });
        } catch (_error) {}
      }
    },
    {
      name: 'scope-spread-clone',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope: { ...registrationScope }
          });
        } catch (_error) {}
      }
    },
    {
      name: 'scope-json-clone',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope: JSON.parse(JSON.stringify(registrationScope))
          });
        } catch (_error) {}
      }
    },
    {
      name: 'receipt-clone',
      operation(context) {
        const registration = registerPredictionOwnership(context);
        try {
          ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
            ...registration.binding,
            registrationScope: registration.registrationScope,
            registrationReceipt: { ...registration.registrationReceipt }
          });
        } catch (_error) {}
      }
    },
    {
      name: 'transaction-scope-clone',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            transactionScope: { ...context.transactionScope },
            registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'wrong-demo-reference',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            demoRun: { ...context.identities.demoRun },
            registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'wrong-action-reference',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            actionRun: { ...context.identities.actionRun },
            registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'wrong-actor-reference',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            actor: { ...context.identities.actor },
            registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'wrong-witness',
      operation(context) {
        try {
          ownershipProtocol.issueRegistrationScopeInCallerTransaction({
            db: context.db,
            transactionScope: context.transactionScope,
            completionWitness: {},
            definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
            ...context.identities
          });
        } catch (_error) {}
      }
    },
    {
      name: 'duplicate-issue',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        } catch (_error) {}
      }
    },
    {
      name: 'identity-drift',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        context.identities.actor.displayName = `${context.identities.actor.displayName}-drift`;
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'receipt-abort',
      operation(context) {
        const registration = registerPredictionOwnership(context);
        try {
          ownershipProtocol.abortRegistrationScopeInCallerTransaction({
            ...registration.binding,
            registrationScope: registration.registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'receipt-replay',
      operation(context) {
        const registration = registerPredictionOwnership(context);
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
        try {
          ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
            ...registration.binding,
            registrationScope: registration.registrationScope,
            registrationReceipt: registration.registrationReceipt
          });
        } catch (_error) {}
      }
    },
    {
      name: 'scope-replay',
      operation(context) {
        const registration = registerPredictionOwnership(context);
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...registration.binding,
            registrationScope: registration.registrationScope
          });
        } catch (_error) {}
      }
    },
    {
      name: 'extra-input-field',
      operation(context) {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope,
            forged: true
          });
        } catch (_error) {}
      }
    }
  ];
  cases.forEach((testCase) => {
    const harness = createHarness(testCase.name);
    try {
      assertScenarioRollsBack(harness, testCase.operation, [
        'PREDICTION_EXACT_SCOPE_POISONED',
        'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED',
        'PREDICTION_EXACT_COMPLETION_WITNESS_NOT_CONSUMED'
      ]);
    } finally {
      if (harness.db.open) harness.db.close();
    }
  });
}

/** 验证错库、同物理库第二连接与 re-BEGIN marker 丢失全部 fail-closed。 */
function testDatabaseAndTransactionFailures() {
  ['same-physical-db', 'cross-db'].forEach((name) => {
    const harness = createHarness(name);
    const otherPath = name === 'same-physical-db'
      ? harness.databasePath
      : path.join(temporaryRoot, `${name}-other.sqlite`);
    if (name === 'cross-db') initDatabase({ databasePath: otherPath });
    const otherDb = openDatabase({ databasePath: otherPath });
    try {
      assertScenarioRollsBack(harness, (context) => {
        const binding = { db: context.db, transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
        const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            db: otherDb,
            registrationScope
          });
        } catch (_error) {}
      }, ['PREDICTION_EXACT_SCOPE_POISONED', 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED']);
    } finally {
      otherDb.close();
      if (harness.db.open) harness.db.close();
    }
  });

  const rebeginHarness = createHarness('rebegin-marker');
  try {
    assertScenarioRollsBack(rebeginHarness, (context) => {
      const binding = { db: context.db, transactionScope: context.transactionScope,
        completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
      const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
      context.db.exec('ROLLBACK');
      context.db.exec('BEGIN IMMEDIATE');
      try {
        ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
          ...binding,
          registrationScope
        });
      } catch (_error) {}
    }, [
      'DATABASE_TRANSACTION_OBLIGATION_PENDING',
      'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED',
      'PREDICTION_EXACT_SCOPE_POISONED'
    ]);
  } finally {
    if (rebeginHarness.db.open) rebeginHarness.db.close();
  }
}

/** 验证 pending P4 receipt obligation 阻止省略 verifier 与提前结束事务。 */
function testPendingReceiptObligationGuards() {
  const omittedVerifierHarness = createHarness('receipt-verifier-omitted');
  try {
    assertScenarioRollsBack(
      omittedVerifierHarness,
      (context) => registerPredictionOwnership(context),
      ['PREDICTION_EXACT_P4_OBLIGATION_PENDING']
    );
  } finally {
    omittedVerifierHarness.db.close();
  }

  ['COMMIT', 'ROLLBACK'].forEach((finalizationSql) => {
    const harness = createHarness(`pending-${finalizationSql.toLowerCase()}`);
    try {
      assertScenarioRollsBack(harness, (context) => {
        let finalizationError = null;
        try {
          context.db.exec(finalizationSql);
        } catch (error) {
          finalizationError = error;
        }
        assert(finalizationError, `${finalizationSql} 必须被 pending obligation 拒绝。`);
        assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(finalizationError));
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      harness.db.close();
    }
  });

  [
    {
      name: 'outer-release-pending-receipt',
      release(context) {
        registerPredictionOwnership(context);
        context.db.exec(`RELEASE SAVEPOINT ${context.outerSavepoint}`);
      }
    },
    {
      name: 'outer-release-after-verified-receipt',
      release(context) {
        completePredictionOwnership(context);
        context.db.exec(`RELEASE SAVEPOINT ${context.outerSavepoint}`);
      }
    },
    {
      name: 'prepared-outer-release-pending-receipt',
      release(context) {
        registerPredictionOwnership(context);
        context.preparedOuterRelease.run();
      }
    },
    {
      name: 'prepared-outer-release-after-verified-receipt',
      release(context) {
        completePredictionOwnership(context);
        context.preparedOuterRelease.run();
      }
    }
  ].forEach((testCase) => {
    const harness = createHarness(testCase.name);
    try {
      assert.throws(
        () => runOuterSavepointScenario(harness, (context) => {
          let releaseError = null;
          try {
            testCase.release(context);
          } catch (error) {
            releaseError = error;
          }
          assert(releaseError, `${testCase.name} 必须拒绝终结最外层 SAVEPOINT caller transaction。`);
          assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(releaseError));
        }),
        hasAnyErrorCode([
          'PREDICTION_EXACT_SCOPE_POISONED',
          'PREDICTION_EXACT_P4_OBLIGATION_PENDING'
        ])
      );
      assert.deepStrictEqual(readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
    } finally {
      harness.db.close();
    }
  });

  const safeNestedHarness = createHarness('safe-nested-caller-savepoint');
  try {
    runOuterSavepointScenario(safeNestedHarness, (context) => {
      context.db.exec('SAVEPOINT caller_safe_nested');
      context.db.exec('ROLLBACK TO SAVEPOINT caller_safe_nested');
      context.db.exec('RELEASE SAVEPOINT caller_safe_nested');
      completePredictionOwnership(context);
    });
    assert.deepStrictEqual(readDerivedCounts(safeNestedHarness), {
      runs: 0,
      results: 0,
      derived: 0,
      relations: 0
    });
  } finally {
    safeNestedHarness.db.close();
  }

  [
    { name: 'commit', triggerQualifier: 'TEMP', finalizationSql: 'COMMIT' },
    { name: 'rollback', triggerQualifier: 'TEMPORARY', finalizationSql: 'ROLLBACK' },
    { name: 'release', triggerQualifier: 'TEMP', finalizationSql: 'RELEASE SAVEPOINT missing_outer' }
  ].forEach((testCase) => {
    const sqlBoundaryHarness = createHarness(`transaction-sql-boundary-${testCase.name}`);
    try {
      assertScenarioRollsBack(sqlBoundaryHarness, (context) => {
        assert.doesNotThrow(() => context.db.exec(`-- 前置行注释；; COMMIT
          /* 前置块注释；; ROLLBACK */
          SELECT '字符串内; RELEASE SAVEPOINT forged';`));
        const triggerName = `prediction_scope_sql_boundary_${testCase.name}`;
        assert.doesNotThrow(() => context.db.exec(`/* trigger 前置注释；; COMMIT */
          CREATE ${testCase.triggerQualifier} TRIGGER ${triggerName}
          BEFORE UPDATE ON prediction_runs
          BEGIN
            SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'invalid; COMMIT text') END;
          END;`));
        let multiStatementError = null;
        try {
          context.db.exec(`DROP TRIGGER ${triggerName};
            CREATE ${testCase.triggerQualifier} TRIGGER ${triggerName}
            BEFORE UPDATE ON prediction_runs
            BEGIN
              SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'invalid; ROLLBACK text') END;
            END;
            ${testCase.finalizationSql};`);
        } catch (error) {
          multiStatementError = error;
        }
        assert(multiStatementError, `trigger 后 ${testCase.finalizationSql} 必须在执行前被门禁拒绝。`);
        assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(multiStatementError));
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      sqlBoundaryHarness.db.close();
    }
  });

  [
    { name: 'commit', finalizationSql: 'COMMIT' },
    { name: 'rollback', finalizationSql: 'ROLLBACK' },
    { name: 'release', finalizationSql: 'RELEASE SAVEPOINT missing_outer' }
  ].forEach((testCase) => {
    const quotedIdentifierHarness = createHarness(`quoted-identifier-${testCase.name}`);
    try {
      assertScenarioRollsBack(quotedIdentifierHarness, (context) => {
        assert.doesNotThrow(() => context.db.exec(`SELECT
          1 AS "double; COMMIT",
          2 AS \`backtick; ROLLBACK\`,
          3 AS [bracket; RELEASE SAVEPOINT forged]`));
        let finalizationError = null;
        try {
          context.db.exec(testCase.finalizationSql);
        } catch (error) {
          finalizationError = error;
        }
        assert(finalizationError, `${testCase.finalizationSql} 必须在引号标识符 SQL 后独立拒绝。`);
        assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(finalizationError));
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      quotedIdentifierHarness.db.close();
    }
  });

  ['COMMIT', 'ROLLBACK'].forEach((finalizationSql) => {
    const harness = createHarness(`verified-${finalizationSql.toLowerCase()}`);
    try {
      assertScenarioRollsBack(harness, (context) => {
        completePredictionOwnership(context);
        let finalizationError = null;
        try {
          context.db.exec(finalizationSql);
        } catch (error) {
          finalizationError = error;
        }
        assert(finalizationError, `receipt 验证后提前 ${finalizationSql} 仍必须被 exact scope 拒绝。`);
        assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(finalizationError));
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      harness.db.close();
    }
  });

  const caughtVerifierHarness = createHarness('caught-verifier-then-commit');
  try {
    assertScenarioRollsBack(caughtVerifierHarness, (context) => {
      const registration = registerPredictionOwnership(context);
      const relationId = Number(context.db.prepare(`SELECT relation_id AS relationId
        FROM demo_data_relations WHERE run_id = ? AND relation_type = 'contains'
        ORDER BY relation_id LIMIT 1`).get(
        caughtVerifierHarness.fixture.demoRun.runId
      ).relationId);
      context.db.prepare('DELETE FROM demo_data_relations WHERE relation_id = ?').run(relationId);

      let verifierError = null;
      try {
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
      } catch (error) {
        verifierError = error;
      }
      assert(verifierError, 'relation drift 必须使 receipt verifier 失败。');
      assert(hasAnyErrorCode([
        'PREDICTION_RECEIPT_RELATION_MISMATCH',
        'PREDICTION_RECEIPT_FACT_MISMATCH',
        'PREDICTION_RECEIPT_WRITE_GENERATION_MISMATCH'
      ])(verifierError));

      let commitError = null;
      try {
        context.db.exec('COMMIT');
      } catch (error) {
        commitError = error;
      }
      assert(commitError, 'caller 捕获 verifier 错误后仍不得提交。');
      assert(hasAnyErrorCode(['DATABASE_TRANSACTION_OBLIGATION_PENDING'])(commitError));
    }, ['PREDICTION_EXACT_SCOPE_POISONED']);
  } finally {
    caughtVerifierHarness.db.close();
  }
}

/** 验证 Artifact 07/12 managed provenance 任一冻结事实漂移都会阻断登记并回滚 P3。 */
function testManagedSourceProvenanceDriftFailures() {
  const cases = [
    {
      name: 'action-manifest-digest-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_post_action_runs SET manifest_digest = ?
          WHERE action_run_id = ?`).run(
          sha256('wrong-action-manifest'),
          harness.fixture.actionRun.actionRunId
        );
      }
    },
    {
      name: 'runtime-revision-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_runtime_settings SET revision = revision + 1
          WHERE id = 1`).run();
      }
    },
    {
      name: 'context-manifest-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts SET manifest_digest = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'`).run(
          sha256('wrong-context-manifest'),
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-actor-drift',
      mutate(harness) {
        const otherActorId = Number(harness.db.prepare(`INSERT INTO sys_users
          (username, display_name, password_hash, status)
          VALUES (?, 'Prediction drift actor', ?, 'active')`).run(
          `prediction-drift-${crypto.randomUUID()}`,
          sha256('prediction-drift-password')
        ).lastInsertRowid);
        harness.db.prepare(`UPDATE demo_import_contexts SET issued_to_user_id = ?
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          otherActorId,
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-handler-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts SET handler_key = 'wrong-handler'
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'`).run(
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-terminal-status-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts
          SET status = 'previewed', executed_at = NULL
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-upload-sha-drift',
      mutate(harness) {
        const wrongSha = sha256('wrong-context-upload');
        harness.db.prepare(`UPDATE demo_import_contexts
          SET artifact_file_sha256 = ?, upload_file_sha256 = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'`).run(
          wrongSha,
          wrongSha,
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-preview-digest-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts SET preview_digest = ?
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          `hmac-sha256:v1:audit:${sha256('wrong-preview-digest')}`,
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-issued-at-drift',
      mutate(harness) {
        const context = harness.db.prepare(`SELECT issued_at AS issuedAt
          FROM demo_import_contexts
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).get(
          harness.fixture.demoRun.runId
        );
        harness.db.prepare(`UPDATE demo_import_contexts SET issued_at = ?
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          shiftUtcMilliseconds(context.issuedAt, -1000),
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-expires-at-drift',
      mutate(harness) {
        const context = harness.db.prepare(`SELECT expires_at AS expiresAt
          FROM demo_import_contexts
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).get(
          harness.fixture.demoRun.runId
        );
        harness.db.prepare(`UPDATE demo_import_contexts SET expires_at = ?
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          shiftUtcMilliseconds(context.expiresAt),
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-previewed-at-null-drift',
      mutate(harness) {
        const context = harness.db.prepare(`SELECT previewed_at AS previewedAt
          FROM demo_import_contexts
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).get(
          harness.fixture.demoRun.runId
        );
        assert.strictEqual(typeof context.previewedAt, 'string', 'Artifact 12 context 必须已有 previewed_at。');
        harness.db.prepare(`UPDATE demo_import_contexts SET previewed_at = NULL
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-previewed-at-null-semantics-drift',
      mutate(harness) {
        const context = harness.db.prepare(`SELECT issued_at AS issuedAt,
            previewed_at AS previewedAt
          FROM demo_import_contexts
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'`).get(
          harness.fixture.demoRun.runId
        );
        assert.strictEqual(context.previewedAt, null, 'Artifact 07 direct context 必须保留 previewed_at=null。');
        harness.db.prepare(`UPDATE demo_import_contexts SET previewed_at = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'`).run(
          context.issuedAt,
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-executed-at-drift',
      mutate(harness) {
        const context = harness.db.prepare(`SELECT executed_at AS executedAt
          FROM demo_import_contexts
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).get(
          harness.fixture.demoRun.runId
        );
        harness.db.prepare(`UPDATE demo_import_contexts SET executed_at = ?
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          shiftUtcMilliseconds(context.executedAt),
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-manifest-version-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts SET manifest_version = '1.7.1'
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'context-current-runtime-epoch-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_import_contexts SET runtime_epoch = runtime_epoch + 1
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'`).run(
          harness.fixture.demoRun.runId
        );
      }
    },
    {
      name: 'artifact-12-preview-signature-drift',
      mutate(harness) {
        harness.db.prepare('UPDATE import_batches SET preview_signature = ? WHERE id = ?').run(
          `hmac-sha256:v1:${sha256('wrong-preview-signature')}`,
          harness.fixture.configBatchId
        );
      }
    },
    {
      name: 'context-terminal-issued-at-baseline-drift',
      mutate(harness) {
        const batch = harness.db.prepare(`SELECT execute_result_json AS executeResultJson
          FROM import_batches WHERE id = ?`).get(harness.fixture.configBatchId);
        const executeResult = JSON.parse(batch.executeResultJson);
        executeResult.contextTerminal.issuedAt = '2026-01-01T00:00:00.000Z';
        harness.db.prepare(`UPDATE import_batches SET execute_result_json = ? WHERE id = ?`).run(
          JSON.stringify(executeResult),
          harness.fixture.configBatchId
        );
      }
    },
    {
      name: 'context-terminal-null-semantics-drift',
      mutate(harness) {
        const batch = harness.db.prepare(`SELECT execute_result_json AS executeResultJson
          FROM import_batches WHERE id = ?`).get(harness.fixture.energyBatchId);
        const executeResult = JSON.parse(batch.executeResultJson);
        executeResult.contextTerminal.previewedAt = '2026-01-01T00:00:00.000Z';
        harness.db.prepare(`UPDATE import_batches SET execute_result_json = ? WHERE id = ?`).run(
          JSON.stringify(executeResult),
          harness.fixture.energyBatchId
        );
      }
    },
    {
      name: 'context-terminal-shape-drift',
      mutate(harness) {
        const batch = harness.db.prepare(`SELECT execute_result_json AS executeResultJson
          FROM import_batches WHERE id = ?`).get(harness.fixture.configBatchId);
        const executeResult = JSON.parse(batch.executeResultJson);
        executeResult.contextTerminal.forged = true;
        harness.db.prepare(`UPDATE import_batches SET execute_result_json = ? WHERE id = ?`).run(
          JSON.stringify(executeResult),
          harness.fixture.configBatchId
        );
      }
    },
    {
      name: 'batch-type-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE import_batches SET import_type = 'energy_record'
          WHERE id = ?`).run(harness.fixture.configBatchId);
      }
    },
    {
      name: 'batch-status-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE import_batches SET status = 'failed'
          WHERE id = ?`).run(harness.fixture.energyBatchId);
      }
    },
    {
      name: 'batch-audit-phase-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE import_batches SET audit_phase = 'preview'
          WHERE id = ?`).run(harness.fixture.configBatchId);
      }
    },
    {
      name: 'execute-result-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE import_batches SET execute_result_json = '{}'
          WHERE id = ?`).run(harness.fixture.configBatchId);
      }
    },
    {
      name: 'import-audit-drift',
      mutate(harness) {
        harness.db.prepare(`INSERT INTO import_errors
          (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
          VALUES (?, 99, 'algorithm', 'wrong', 'TEST_DRIFT', '测试审计漂移', 'warning')`).run(
          harness.fixture.configBatchId
        );
      }
    },
    {
      name: 'operation-log-drift',
      mutate(harness) {
        harness.db.prepare(`DELETE FROM sys_operation_logs
          WHERE operation = 'prediction.config.import.execute'
            AND target_type = 'prediction_config_import' AND target_id = ?`).run(
          String(harness.fixture.configBatchId)
        );
      }
    },
    {
      name: 'retained-file-drift',
      mutate(harness) {
        const batch = harness.db.prepare(`SELECT stored_filename AS storedFilename
          FROM import_batches WHERE id = ?`).get(harness.fixture.energyBatchId);
        fs.appendFileSync(path.join(process.env.UPLOADS_DIR, batch.storedFilename), '\n漂移');
      }
    },
    {
      name: 'backup-file-drift',
      mutate(harness) {
        const batch = harness.db.prepare(`SELECT backup_json AS backupJson
          FROM import_batches WHERE id = ?`).get(harness.fixture.configBatchId);
        const backup = JSON.parse(batch.backupJson);
        fs.appendFileSync(path.join(process.env.BACKUPS_DIR, backup.backupName), '\n漂移');
      }
    },
    {
      name: 'primary-binding-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_run_import_batches SET batch_role = 'secondary'
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'
            AND batch_role = 'primary'`).run(harness.fixture.demoRun.runId);
      }
    },
    {
      name: 'ownership-missing',
      mutate(harness) {
        harness.db.prepare(`DELETE FROM demo_data_registry
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND ownership_kind = 'imported'
            AND entity_pk = ?`).run(
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    },
    {
      name: 'ownership-cleaned',
      mutate(harness) {
        const cleanupRunId = `cleanup-${crypto.randomUUID()}`;
        const timestamp = new Date().toISOString();
        harness.db.prepare(`INSERT INTO demo_cleanup_runs
          (cleanup_run_id, run_id, client_request_id, preview_digest,
           preview_expires_at, runtime_revision, registry_watermark,
           requested_by, status, completed_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'succeeded', ?)`).run(
          cleanupRunId,
          harness.fixture.demoRun.runId,
          `cleanup-request-${crypto.randomUUID()}`,
          sha256('ownership-cleaned-preview'),
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          `watermark-${crypto.randomUUID()}`,
          harness.actor.userId,
          timestamp
        );
        harness.db.prepare(`UPDATE demo_data_registry
          SET cleaned_at = ?, cleanup_run_id = ?, cleanup_result = 'already_missing'
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND ownership_kind = 'imported'
            AND entity_pk = ?`).run(
          timestamp,
          cleanupRunId,
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    },
    {
      name: 'ownership-wrong-artifact',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_data_registry SET artifact_key = '08-meter-readings-2026-08'
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND ownership_kind = 'imported'
            AND entity_pk = ?`).run(
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    },
    {
      name: 'ownership-wrong-run',
      mutate(harness) {
        const otherRunId = `${harness.fixture.demoRun.runId}-other`;
        harness.db.prepare(`INSERT INTO demo_dataset_runs
          (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?)`).run(
          otherRunId,
          `${DEMO_DATASET_ID}-wrong-run-fixture`,
          DEMO_MANIFEST_VERSION,
          DEMO_MANIFEST_DIGEST,
          harness.actor.userId,
          new Date().toISOString()
        );
        harness.db.prepare(`UPDATE demo_data_registry SET run_id = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND ownership_kind = 'imported'
            AND entity_pk = ?`).run(
          otherRunId,
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    },
    {
      name: 'business-row-void',
      mutate(harness) {
        harness.db.prepare(`UPDATE energy_records SET record_status = 'void'
          WHERE id = ?`).run(harness.fixture.trainingRecordIds[0]);
      }
    },
    {
      name: 'business-row-missing',
      mutate(harness) {
        harness.db.prepare('DELETE FROM energy_records WHERE id = ?').run(
          harness.fixture.trainingRecordIds[0]
        );
      }
    },
    {
      name: 'config-provenance-batch-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE prediction_configs SET source_batch_id = ?
          WHERE id = ?`).run(harness.fixture.energyBatchId, harness.fixture.configId);
      }
    },
    {
      name: 'config-training-batch-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE prediction_configs SET source_batch_filter_id = ?
          WHERE id = ?`).run(harness.fixture.configBatchId, harness.fixture.configId);
      }
    },
    {
      name: 'ownership-snapshot-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND ownership_kind = 'imported'
            AND entity_pk = ?`).run(
          sha256('wrong-ownership-snapshot'),
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    }
  ];

  cases.forEach((testCase) => {
    const harness = createHarness(`managed-${testCase.name}`);
    try {
      assertScenarioRollsBack(harness, (context) => {
        const binding = {
          db: context.db,
          transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities
        };
        const registrationScope =
          ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        testCase.mutate(harness);
        let registrationError = null;
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope
          });
        } catch (error) {
          registrationError = error;
        }
        assert(registrationError, `${testCase.name} 必须使 managed source verifier 失败。`);
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      harness.db.close();
    }
  });
}

/** 验证 P4 严格绑定 P3 持久化前 forecast facts，任一 run/result 漂移都完整回滚。 */
function testForecastFactDriftFailures() {
  const cases = [
    {
      name: 'run-algorithm-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_runs SET algorithm = 'linear_trend'
          WHERE id = ?`).run(context.executed.run.id);
      }
    },
    {
      name: 'run-filter-drift',
      mutate(context) {
        const run = context.db.prepare(`SELECT parameters_json AS parametersJson
          FROM prediction_runs WHERE id = ?`).get(context.executed.run.id);
        const parameters = JSON.parse(run.parametersJson);
        parameters.filters.sourceBatchId += 1;
        context.db.prepare(`UPDATE prediction_runs SET parameters_json = ? WHERE id = ?`).run(
          JSON.stringify(parameters),
          context.executed.run.id
        );
      }
    },
    {
      name: 'run-config-drift',
      mutate(context) {
        const run = context.db.prepare(`SELECT parameters_json AS parametersJson
          FROM prediction_runs WHERE id = ?`).get(context.executed.run.id);
        const parameters = JSON.parse(run.parametersJson);
        parameters.configSnapshot.config.note = '漂移配置备注';
        context.db.prepare(`UPDATE prediction_runs SET parameters_json = ? WHERE id = ?`).run(
          JSON.stringify(parameters),
          context.executed.run.id
        );
      }
    },
    {
      name: 'run-warning-drift',
      mutate(context) {
        const run = context.db.prepare(`SELECT parameters_json AS parametersJson
          FROM prediction_runs WHERE id = ?`).get(context.executed.run.id);
        const parameters = JSON.parse(run.parametersJson);
        parameters.warnings = ['漂移告警'];
        context.db.prepare(`UPDATE prediction_runs SET parameters_json = ? WHERE id = ?`).run(
          JSON.stringify(parameters),
          context.executed.run.id
        );
      }
    },
    {
      name: 'missing-result',
      mutate(context) {
        context.db.prepare(`DELETE FROM prediction_results WHERE id = (
          SELECT id FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1
        )`).run(context.executed.run.id);
      }
    },
    {
      name: 'extra-result',
      mutate(context) {
        const result = context.db.prepare(`SELECT energy_type_id AS energyTypeId,
            predicted_value AS predictedValue, predicted_unit AS predictedUnit,
            confidence_low AS confidenceLow, confidence_high AS confidenceHigh,
            method_note AS methodNote
          FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1`).get(
          context.executed.run.id
        );
        context.db.prepare(`INSERT INTO prediction_results
          (prediction_run_id, energy_type_id, target_month, predicted_value,
           predicted_unit, confidence_low, confidence_high, method_note)
          VALUES (?, ?, '2026-07', ?, ?, ?, ?, ?)`).run(
          context.executed.run.id,
          result.energyTypeId,
          result.predictedValue,
          result.predictedUnit,
          result.confidenceLow,
          result.confidenceHigh,
          result.methodNote
        );
      }
    },
    {
      name: 'predicted-value-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results SET predicted_value = predicted_value + 1
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'six-digit-rounding-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results SET predicted_value = predicted_value + 0.0000001
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'confidence-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results SET confidence_low = confidence_low + 0.01
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'canonical-unit-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results SET predicted_unit = 'MWh'
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'target-month-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results SET target_month = '2026-07'
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'energy-code-note-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results
          SET method_note = replace(method_note, '能源类型=electricity', '能源类型=water')
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'moving-window-note-drift',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results
          SET method_note = replace(method_note, '最近 3 个', '最近 4 个')
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'algorithm-handler-valid-drift',
      expectedCodes: ['PREDICTION_RESULT_WITNESS_MISMATCH'],
      mutate(context) {
        const result = context.db.prepare(`SELECT pres.id,
            pres.predicted_value AS predictedValue,
            pres.predicted_unit AS predictedUnit,
            et.code AS energyTypeCode
          FROM prediction_results pres
          JOIN energy_types et ON et.id = pres.energy_type_id
          WHERE pres.prediction_run_id = ? ORDER BY pres.id LIMIT 1`).get(
          context.executed.run.id
        );
        const confidence = buildPredictionConfidenceFacts(
          'linear_trend',
          result.predictedValue
        );
        const methodNote = formatPredictionForecastMethodNote({
          algorithm: 'linear_trend',
          windowSize: null,
          sampleCount: 4,
          signedSlope: 10,
          clampedToZero: false
        }, {
          energyTypeCode: result.energyTypeCode,
          canonicalUnit: result.predictedUnit
        });
        context.db.prepare(`UPDATE prediction_results
          SET confidence_low = ?, confidence_high = ?, method_note = ?
          WHERE id = ?`).run(
          confidence.confidenceLow,
          confidence.confidenceHigh,
          methodNote,
          result.id
        );
      }
    },
    {
      name: 'linear-sample-count-drift',
      algorithm: 'linear_trend',
      mutate(context) {
        context.db.prepare(`UPDATE prediction_results
          SET method_note = replace(method_note, '基于 4 个', '基于 3 个')
          WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ?
            ORDER BY id LIMIT 1)`).run(context.executed.run.id);
      }
    },
    {
      name: 'linear-signed-slope-drift',
      algorithm: 'linear_trend',
      mutate(context) {
        const result = context.db.prepare(`SELECT id, method_note AS methodNote
          FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1`).get(
          context.executed.run.id
        );
        context.db.prepare('UPDATE prediction_results SET method_note = ? WHERE id = ?').run(
          result.methodNote.replace(/slope=-?\d+(?:\.\d+)?/u, 'slope=-10'),
          result.id
        );
      }
    },
    {
      name: 'linear-handler-valid-clamp-drift',
      algorithm: 'linear_trend',
      expectedCodes: ['PREDICTION_RESULT_WITNESS_MISMATCH'],
      mutate(context) {
        const result = context.db.prepare(`SELECT pres.id,
            pres.predicted_unit AS predictedUnit,
            pres.method_note AS methodNote,
            et.code AS energyTypeCode
          FROM prediction_results pres
          JOIN energy_types et ON et.id = pres.energy_type_id
          WHERE pres.prediction_run_id = ? ORDER BY pres.id LIMIT 1`).get(
          context.executed.run.id
        );
        const parsedMethod = parsePredictionForecastMethodNote(result.methodNote);
        const methodNote = formatPredictionForecastMethodNote({
          ...parsedMethod,
          clampedToZero: true
        }, {
          energyTypeCode: result.energyTypeCode,
          canonicalUnit: result.predictedUnit
        });
        context.db.prepare(`UPDATE prediction_results
          SET predicted_value = 0, confidence_low = 0, confidence_high = 0,
            method_note = ?
          WHERE id = ?`).run(methodNote, result.id);
      }
    }
  ];

  cases.forEach((testCase) => {
    const harness = createHarness(
      `forecast-${testCase.name}`,
      testCase.algorithm || 'moving_average'
    );
    try {
      assertScenarioRollsBack(harness, (context) => {
        const binding = {
          db: context.db,
          transactionScope: context.transactionScope,
          completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities
        };
        const registrationScope =
          ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
        testCase.mutate(context);
        let registrationError = null;
        try {
          ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
            ...binding,
            registrationScope
          });
        } catch (error) {
          registrationError = error;
        }
        assert(registrationError, `${testCase.name} 必须使 forecast fact verifier 失败。`);
        if (testCase.expectedCodes) {
          assert(
            hasAnyErrorCode(testCase.expectedCodes)(registrationError),
            `${testCase.name} 必须命中固定 P4 forecast/witness mismatch 错误码。`
          );
        }
      }, ['PREDICTION_EXACT_SCOPE_POISONED']);
    } finally {
      harness.db.close();
    }
  });
}

/** 验证 registry/relation/receipt 任一阶段失败后 future nested boundary 可完整回滚。 */
function testPartialWriteAndRereadFailures() {
  const registryHarness = createHarness('registry-partial');
  try {
    registryHarness.db.exec(`CREATE TEMP TRIGGER reject_prediction_result_registry
      BEFORE INSERT ON demo_data_registry
      WHEN NEW.ownership_kind = 'derived' AND NEW.entity_type = 'prediction_result'
      BEGIN SELECT RAISE(ABORT, 'reject prediction result registry'); END`);
    assertScenarioRollsBack(registryHarness, (context) => registerPredictionOwnership(context));
  } finally {
    registryHarness.db.close();
  }

  const relationHarness = createHarness('relation-partial');
  try {
    relationHarness.db.exec(`CREATE TEMP TRIGGER reject_prediction_generated_relation
      BEFORE INSERT ON demo_data_relations
      WHEN NEW.relation_type = 'generated_from'
      BEGIN SELECT RAISE(ABORT, 'reject prediction relation'); END`);
    assertScenarioRollsBack(relationHarness, (context) => registerPredictionOwnership(context));
  } finally {
    relationHarness.db.close();
  }

  const receiptHarness = createHarness('receipt-reread');
  try {
    assertScenarioRollsBack(receiptHarness, (context) => {
      const registration = registerPredictionOwnership(context);
      const relationId = Number(context.db.prepare(`SELECT relation_id AS relationId
        FROM demo_data_relations WHERE run_id = ? AND relation_type = 'contains'
        ORDER BY relation_id LIMIT 1`).get(receiptHarness.fixture.demoRun.runId).relationId);
      context.db.prepare('DELETE FROM demo_data_relations WHERE relation_id = ?').run(relationId);
      try {
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
      } catch (_error) {}
    }, ['PREDICTION_EXACT_SCOPE_POISONED', 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED']);
  } finally {
    receiptHarness.db.close();
  }

  const sameSnapshotReceiptHarness = createHarness('same-pk-snapshot-receipt-reread');
  try {
    assertScenarioRollsBack(sameSnapshotReceiptHarness, (context) => {
      const registration = registerPredictionOwnership(context);
      const result = context.db.prepare(`SELECT id, prediction_run_id AS predictionRunId,
          energy_type_id AS energyTypeId, target_month AS targetMonth,
          predicted_value AS predictedValue, predicted_unit AS predictedUnit,
          confidence_low AS confidenceLow, confidence_high AS confidenceHigh,
          method_note AS methodNote, created_at AS createdAt
        FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1`).get(
        context.executed.run.id
      );
      context.db.prepare('DELETE FROM prediction_results WHERE id = ?').run(result.id);
      context.db.prepare(`INSERT INTO prediction_results
        (id, prediction_run_id, energy_type_id, target_month, predicted_value,
         predicted_unit, confidence_low, confidence_high, method_note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        result.id,
        result.predictionRunId,
        result.energyTypeId,
        result.targetMonth,
        result.predictedValue,
        result.predictedUnit,
        result.confidenceLow,
        result.confidenceHigh,
        result.methodNote,
        result.createdAt
      );
      try {
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
      } catch (_error) {}
    }, ['PREDICTION_EXACT_SCOPE_POISONED', 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED']);
  } finally {
    sameSnapshotReceiptHarness.db.close();
  }

  const terminalReceiptHarness = createHarness('context-terminal-receipt-reread');
  try {
    assertScenarioRollsBack(terminalReceiptHarness, (context) => {
      const registration = registerPredictionOwnership(context);
      const batch = context.db.prepare(`SELECT execute_result_json AS executeResultJson
        FROM import_batches WHERE id = ?`).get(terminalReceiptHarness.fixture.configBatchId);
      const executeResult = JSON.parse(batch.executeResultJson);
      executeResult.contextTerminal.executedAt = '2026-01-01T00:00:00.000Z';
      context.db.prepare(`UPDATE import_batches SET execute_result_json = ? WHERE id = ?`).run(
        JSON.stringify(executeResult),
        terminalReceiptHarness.fixture.configBatchId
      );
      try {
        ownershipProtocol.verifyRegistrationReceiptInCallerTransaction({
          ...registration.binding,
          registrationScope: registration.registrationScope,
          registrationReceipt: registration.registrationReceipt
        });
      } catch (_error) {}
    }, ['PREDICTION_EXACT_SCOPE_POISONED', 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED']);
  } finally {
    terminalReceiptHarness.db.close();
  }

  const sourceHarness = createHarness('source-reread');
  try {
    assertScenarioRollsBack(sourceHarness, (context) => {
      const binding = { db: context.db, transactionScope: context.transactionScope,
        completionWitness: context.completionWitness,
          definitionCapability: requireStandaloneExecuteDefinitionCapability(context),
          ...context.identities };
      const registrationScope = ownershipProtocol.issueRegistrationScopeInCallerTransaction(binding);
      context.db.prepare(`UPDATE energy_types SET name = name || '-drift' WHERE id = ?`).run(
        sourceHarness.fixture.electricityId
      );
      try {
        ownershipProtocol.registerDerivedOwnershipInCallerTransaction({
          ...binding,
          registrationScope
        });
      } catch (_error) {}
    }, ['PREDICTION_EXACT_SCOPE_POISONED', 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED']);
  } finally {
    sourceHarness.db.close();
  }
}

/** 清理 Prediction P4/P5 共用的隔离临时根目录。 */
function cleanupPredictionFixtureRoot() {
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (_cleanupError) {
    // Windows 上 SQLite 句柄释放可能稍晚，临时目录清理不得覆盖测试主结论。
  }
}

/** 运行 Prediction P4 私有登记协议专项测试。 */
function run() {
  initializeStandaloneDefinitionCapabilityProtocols();
  testPrivateProtocolSurface();
  testManagedFilteredSourceSetContract();
  testSuccessfulAlgorithmsAndLineage();
  testPostInitializationMonkeypatchIsolation();
  testOpaqueBindingAndReplayFailures();
  testDatabaseAndTransactionFailures();
  testPendingReceiptObligationGuards();
  testManagedSourceProvenanceDriftFailures();
  testForecastFactDriftFailures();
  testPartialWriteAndRereadFailures();
  console.log('predictionPostActionProtocol tests passed');
}

// P5 adapter 专项复用已审查的隔离 managed source 夹具，不增加 production 测试后门。
module.exports = Object.freeze({
  cleanupPredictionFixtureRoot,
  createHarness,
  readDerivedCounts
});

if (require.main === module) {
  try {
    run();
  } finally {
    cleanupPredictionFixtureRoot();
  }
}
