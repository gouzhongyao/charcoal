'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const {
  CLEANUP_CONFIRMATION_TEXT,
  disableDemoRuntimeAfterCleanup,
  readCanonicalDemoRuntime
} = require('./demoRuntimeService');
const { assertDemoRuntimeEnabled, requireDemoDatasetRun } = require('./demoRunService');
const {
  buildDemoOwnershipPlan,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_REGISTRATION_CONNECTED,
  getDemoCleanupEntityHandler
} = require('./demoOwnershipService');

// 清理预演固定十分钟有效，执行时还必须重新核对 revision、watermark 和实体快照。
const DEMO_CLEANUP_PREVIEW_TTL_MS = 10 * 60 * 1000;

/** 严格校验清理请求用户主键。 */
function validateCleanupActorUserId(actorUserId) {
  if (typeof actorUserId !== 'number' || !Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw badRequest('清理请求用户主键无效。', { code: 'INVALID_DEMO_CLEANUP_ACTOR' });
  }
  return actorUserId;
}

/** 严格校验客户端幂等请求 ID。 */
function validateClientRequestId(value) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw badRequest('clientRequestId 格式无效。', { code: 'INVALID_DEMO_CLEANUP_CLIENT_REQUEST_ID' });
  }
  return normalized;
}

/** 严格校验 cleanup run 主键。 */
function validateCleanupRunId(value) {
  const normalized = String(value || '').trim();
  if (!/^demo-cleanup-[0-9a-f-]{36}$/.test(normalized)) {
    throw badRequest('cleanupRunId 格式无效。', { code: 'INVALID_DEMO_CLEANUP_RUN_ID' });
  }
  return normalized;
}

/** 计算绑定 run、revision、watermark、候选、blocker 和过期时间的 preview digest。 */
function calculateCleanupPreviewDigest(input) {
  return crypto.createHash('sha256').update(JSON.stringify({
    domain: 'demo-cleanup-preview:v1',
    cleanupRunId: input.cleanupRunId,
    runId: input.runId,
    runtimeRevision: input.runtimeRevision,
    registryWatermark: input.registryWatermark,
    previewExpiresAt: input.previewExpiresAt,
    candidates: input.candidates,
    blockers: input.blockers
  }), 'utf8').digest('hex');
}

/** 将 cleanup 数据库行映射为稳定状态响应。 */
function mapCleanupRunRow(row) {
  if (!row) return null;
  let summary = null;
  try {
    summary = row.summaryJson ? JSON.parse(row.summaryJson) : null;
  } catch (_error) {
    summary = null;
  }
  const candidateCount = Number(row.candidateCount);
  const blockerCount = Number(row.blockerCount);
  const status = row.status;
  return {
    cleanupRunId: row.cleanupRunId,
    runId: row.runId,
    clientRequestId: row.clientRequestId,
    previewDigest: row.previewDigest,
    previewExpiresAt: row.previewExpiresAt,
    runtimeRevision: Number(row.runtimeRevision),
    registryWatermark: row.registryWatermark,
    candidateCount,
    blockerCount,
    blocked: status === 'blocked' || blockerCount > 0,
    executable: status === 'previewed' && blockerCount === 0,
    summary,
    confirmationText: row.confirmationText,
    requestedBy: row.requestedBy === null ? null : Number(row.requestedBy),
    status,
    deletedCount: Number(row.deletedCount),
    alreadyMissingCount: Number(row.alreadyMissingCount),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    failureReason: row.failureReason
  };
}

/** 按 cleanup run ID 读取状态行。 */
function readCleanupRun(db, cleanupRunId) {
  return mapCleanupRunRow(db.prepare(`SELECT cleanup_run_id AS cleanupRunId, run_id AS runId,
      client_request_id AS clientRequestId, preview_digest AS previewDigest,
      preview_expires_at AS previewExpiresAt, runtime_revision AS runtimeRevision,
      registry_watermark AS registryWatermark, candidate_count AS candidateCount,
      blocker_count AS blockerCount, summary_json AS summaryJson,
      confirmation_text AS confirmationText, requested_by AS requestedBy,
      status, deleted_count AS deletedCount, already_missing_count AS alreadyMissingCount,
      created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt,
      failure_reason AS failureReason
    FROM demo_cleanup_runs WHERE cleanup_run_id = ?`).get(cleanupRunId));
}

/** 按 clientRequestId 读取已存在预演，提供服务端幂等。 */
function readCleanupRunByClientRequestId(db, clientRequestId) {
  const row = db.prepare('SELECT cleanup_run_id AS cleanupRunId FROM demo_cleanup_runs WHERE client_request_id = ?')
    .get(clientRequestId);
  return row ? readCleanupRun(db, row.cleanupRunId) : null;
}

/** 构造对外 summary，保留候选主键和 blocker 代码但不暴露业务整行。 */
function buildCleanupSummary(runId, plan) {
  return {
    version: 1,
    runId,
    registryCount: plan.registryCount,
    candidates: plan.candidates,
    blockers: plan.blockers,
    uploadsDeleted: false,
    importBatchesDeleted: false,
    registrationConnected: plan.registrationConnected,
    derivedOwnershipConnected: false
  };
}

/** 创建当前 run 清理预演；同 clientRequestId 只返回原结果。 */
function previewDemoCleanup(input = {}) {
  const actorUserId = validateCleanupActorUserId(input.actorUserId);
  const clientRequestId = validateClientRequestId(input.clientRequestId);
  const actorIp = input.actorIp ? String(input.actorIp) : null;
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const existing = readCleanupRunByClientRequestId(db, clientRequestId);
      if (existing) {
        if (existing.requestedBy !== actorUserId || existing.runId !== String(input.runId || '').trim()) {
          throw new AppError('DEMO_CLEANUP_IDEMPOTENCY_CONFLICT', 'clientRequestId 已绑定其他清理请求。', { statusCode: 409 });
        }
        return { ...existing, idempotent: true };
      }
      const runtime = assertDemoRuntimeEnabled({ db });
      const run = requireDemoDatasetRun(db, input.runId);
      const plan = buildDemoOwnershipPlan(db, run.runId);
      const cleanupRunId = `demo-cleanup-${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const previewExpiresAt = new Date(Date.parse(createdAt) + DEMO_CLEANUP_PREVIEW_TTL_MS).toISOString();
      const summary = buildCleanupSummary(run.runId, plan);
      const previewDigest = calculateCleanupPreviewDigest({
        cleanupRunId,
        runId: run.runId,
        runtimeRevision: runtime.revision,
        registryWatermark: plan.registryWatermark,
        previewExpiresAt,
        candidates: plan.candidates,
        blockers: plan.blockers
      });
      const status = plan.blockerCount > 0 ? 'blocked' : 'previewed';
      db.prepare(`INSERT INTO demo_cleanup_runs
        (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
          runtime_revision, registry_watermark, candidate_count, blocker_count,
          summary_json, confirmation_text, requested_by, status, created_at,
          completed_at, failure_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cleanupRunId,
        run.runId,
        clientRequestId,
        previewDigest,
        previewExpiresAt,
        runtime.revision,
        plan.registryWatermark,
        plan.candidateCount,
        plan.blockerCount,
        JSON.stringify(summary),
        CLEANUP_CONFIRMATION_TEXT,
        actorUserId,
        status,
        createdAt,
        status === 'blocked' ? createdAt : null,
        status === 'blocked' ? 'cleanup_preview_blocked' : null
      );
      if (status === 'previewed') {
        db.prepare(`UPDATE demo_dataset_runs SET status = 'cleanup_pending'
          WHERE run_id = ? AND status IN ('active', 'completed')`).run(run.runId);
      }
      db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, ip, created_at)
        VALUES (?, 'system.demo.cleanup.preview', 'demo_cleanup_runs', ?, ?, ?, ?)`).run(
        actorUserId,
        cleanupRunId,
        JSON.stringify({
          runId: run.runId,
          clientRequestId,
          candidateCount: plan.candidateCount,
          blockerCount: plan.blockerCount,
          runtimeRevision: runtime.revision,
          registryWatermark: plan.registryWatermark,
          status
        }),
        actorIp,
        createdAt
      );
      return { ...readCleanupRun(db, cleanupRunId), idempotent: false };
    }).immediate();
  } finally {
    db.close();
  }
}

/** 将执行期陈旧或阻塞结果持久化后返回给调用方抛错。 */
function failCleanupRun(db, cleanupRun, reason, errorCode, message) {
  const completedAt = new Date().toISOString();
  db.prepare(`UPDATE demo_cleanup_runs SET status = 'failed', completed_at = ?, failure_reason = ?
    WHERE cleanup_run_id = ? AND status = 'previewed'`).run(completedAt, reason, cleanupRun.cleanupRunId);
  db.prepare(`UPDATE demo_dataset_runs SET status = 'cleanup_pending', failure_reason = ?
    WHERE run_id = ? AND status IN ('cleanup_pending', 'cleaning')`).run(reason, cleanupRun.runId);
  return new AppError(errorCode, message, {
    statusCode: 409,
    details: { cleanupRunId: cleanupRun.cleanupRunId, reason }
  });
}

/** 执行静态白名单清理，并在同一 IMMEDIATE 事务内写 tombstone、撤销 context 和关闭 runtime。 */
function executeDemoCleanup(input = {}) {
  const actorUserId = validateCleanupActorUserId(input.actorUserId);
  const cleanupRunId = validateCleanupRunId(input.cleanupRunId);
  const clientRequestId = validateClientRequestId(input.clientRequestId);
  const confirmationText = String(input.confirmationText || '');
  const previewDigest = String(input.previewDigest || '').trim();
  const actorIp = input.actorIp ? String(input.actorIp) : null;
  if (confirmationText !== CLEANUP_CONFIRMATION_TEXT) {
    throw badRequest('清理确认文本不匹配。', { code: 'DEMO_CLEANUP_CONFIRMATION_MISMATCH' });
  }
  if (!/^[a-f0-9]{64}$/.test(previewDigest)) {
    throw badRequest('previewDigest 格式无效。', { code: 'INVALID_DEMO_CLEANUP_PREVIEW_DIGEST' });
  }
  const db = openDatabase();
  let deferredError = null;
  try {
    const result = db.transaction(() => {
      const cleanupRun = readCleanupRun(db, cleanupRunId);
      if (!cleanupRun) throw new AppError('DEMO_CLEANUP_RUN_NOT_FOUND', '清理运行不存在。', { statusCode: 404 });
      if (cleanupRun.requestedBy !== actorUserId || cleanupRun.clientRequestId !== clientRequestId) {
        throw new AppError('DEMO_CLEANUP_REQUEST_BINDING_MISMATCH', '清理执行与预演请求绑定不一致。', { statusCode: 409 });
      }
      // 已完成运行只读幂等重放，不重复检查或执行任何删除副作用。
      if (['succeeded', 'noop'].includes(cleanupRun.status)) return { ...cleanupRun, idempotent: true };
      if (cleanupRun.blocked) {
        throw new AppError('DEMO_CLEANUP_BLOCKED', '清理预演存在 blocker，禁止执行。', {
          statusCode: 409,
          details: { cleanupRunId, blockers: cleanupRun.summary?.blockers || [] }
        });
      }
      if (!DEMO_OWNERSHIP_REGISTRATION_CONNECTED) {
        throw new AppError('DEMO_CLEANUP_BLOCKED', 'ownership registration 尚未接入，禁止执行演示清理。', {
          statusCode: 409,
          details: {
            cleanupRunId,
            blockers: [{ code: 'OWNERSHIP_REGISTRATION_NOT_CONNECTED' }]
          }
        });
      }
      if (!cleanupRun.executable) {
        throw new AppError('DEMO_CLEANUP_STATE_INVALID', '只有 previewed 且 blockerCount=0 的清理运行允许执行。', { statusCode: 409 });
      }
      if (cleanupRun.previewDigest !== previewDigest) {
        throw new AppError('DEMO_CLEANUP_PREVIEW_DIGEST_MISMATCH', '清理执行摘要与预演不一致。', { statusCode: 409 });
      }
      if (Date.parse(cleanupRun.previewExpiresAt) <= Date.now()) {
        const expiredAt = new Date().toISOString();
        db.prepare(`UPDATE demo_cleanup_runs SET status = 'expired', completed_at = ?, failure_reason = 'preview_expired'
          WHERE cleanup_run_id = ? AND status = 'previewed'`).run(expiredAt, cleanupRunId);
        deferredError = new AppError('DEMO_CLEANUP_PREVIEW_EXPIRED', '清理预演已过期。', { statusCode: 410 });
        return null;
      }
      const runtime = readCanonicalDemoRuntime({ db });
      if (runtime.enabled !== 1 || runtime.revision !== cleanupRun.runtimeRevision) {
        deferredError = failCleanupRun(db, cleanupRun, 'runtime_revision_changed',
          'DEMO_CLEANUP_RUNTIME_STALE', '演示运行期 revision 已变化，必须重新预演。');
        return null;
      }
      const run = requireDemoDatasetRun(db, cleanupRun.runId);
      const plan = buildDemoOwnershipPlan(db, run.runId);
      const recomputedDigest = calculateCleanupPreviewDigest({
        cleanupRunId,
        runId: run.runId,
        runtimeRevision: runtime.revision,
        registryWatermark: plan.registryWatermark,
        previewExpiresAt: cleanupRun.previewExpiresAt,
        candidates: plan.candidates,
        blockers: plan.blockers
      });
      if (plan.registryWatermark !== cleanupRun.registryWatermark || recomputedDigest !== cleanupRun.previewDigest) {
        deferredError = failCleanupRun(db, cleanupRun, 'registry_or_snapshot_changed',
          'DEMO_CLEANUP_PREVIEW_STALE', 'ownership registry 或实体快照已变化，必须重新预演。');
        return null;
      }
      if (plan.blockerCount > 0) {
        deferredError = failCleanupRun(db, cleanupRun, 'execution_blocker_detected',
          'DEMO_CLEANUP_BLOCKED', '执行前检测到正式数据引用或未支持 ownership。');
        return null;
      }
      const startedAt = new Date().toISOString();
      db.prepare(`UPDATE demo_cleanup_runs SET status = 'executing', started_at = ?
        WHERE cleanup_run_id = ? AND status = 'previewed'`).run(startedAt, cleanupRunId);
      db.prepare(`UPDATE demo_dataset_runs SET status = 'cleaning', cleanup_started_at = ?, failure_reason = NULL
        WHERE run_id = ? AND status IN ('active', 'completed', 'cleanup_pending')`).run(startedAt, run.runId);
      let deletedCount = 0;
      let alreadyMissingCount = 0;
      plan.candidates.forEach((candidate) => {
        const handler = getDemoCleanupEntityHandler(candidate.entityType);
        if (!handler) throw new Error(`静态清理 handler 丢失：${candidate.entityType}`);
        const currentRow = handler.read(db, candidate.entityPkValue);
        let cleanupResult = 'already_missing';
        if (currentRow) {
          const currentDigest = calculateDemoEntitySnapshotDigest(candidate.entityType, candidate.entityPk, currentRow);
          if (currentDigest !== candidate.expectedSnapshotDigest || handler.readReferenceBlockers(db, candidate.entityPkValue).length > 0) {
            throw new Error(`清理执行期实体状态漂移：${candidate.registryId}`);
          }
          if (handler.remove(db, candidate.entityPkValue) !== 1) throw new Error(`清理实体删除计数异常：${candidate.registryId}`);
          cleanupResult = 'deleted';
          deletedCount += 1;
        } else {
          alreadyMissingCount += 1;
        }
        const tombstone = db.prepare(`UPDATE demo_data_registry
          SET cleaned_at = ?, cleanup_run_id = ?, cleanup_result = ?
          WHERE registry_id = ? AND run_id = ? AND cleaned_at IS NULL`).run(
          startedAt,
          cleanupRunId,
          cleanupResult,
          candidate.registryId,
          run.runId
        );
        if (tombstone.changes !== 1) throw new Error(`ownership tombstone 状态冲突：${candidate.registryId}`);
      });
      db.prepare(`UPDATE demo_import_contexts
        SET status = 'revoked', revoked_at = ?, revoke_reason = 'cleanup_executed'
        WHERE run_id = ? AND status IN ('issued', 'previewed', 'executed')`).run(startedAt, run.runId);
      const completedAt = new Date().toISOString();
      const status = plan.candidateCount === 0 ? 'noop' : 'succeeded';
      db.prepare(`UPDATE demo_dataset_runs
        SET status = 'cleaned', cleaned_at = ?, failure_reason = NULL
        WHERE run_id = ? AND status = 'cleaning'`).run(completedAt, run.runId);
      db.prepare(`UPDATE demo_cleanup_runs
        SET status = ?, deleted_count = ?, already_missing_count = ?, completed_at = ?, failure_reason = NULL
        WHERE cleanup_run_id = ? AND status = 'executing'`).run(
        status,
        deletedCount,
        alreadyMissingCount,
        completedAt,
        cleanupRunId
      );
      const nextRuntime = disableDemoRuntimeAfterCleanup({ db, actorUserId, actorIp });
      db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, ip, created_at)
        VALUES (?, 'system.demo.cleanup.execute', 'demo_cleanup_runs', ?, ?, ?, ?)`).run(
        actorUserId,
        cleanupRunId,
        JSON.stringify({
          runId: run.runId,
          clientRequestId,
          status,
          deletedCount,
          alreadyMissingCount,
          runtimeEpoch: nextRuntime.runtimeEpoch,
          runtimeRevision: nextRuntime.revision,
          uploadsDeleted: false,
          importBatchesDeleted: false
        }),
        actorIp,
        completedAt
      );
      return { ...readCleanupRun(db, cleanupRunId), runtime: nextRuntime, idempotent: false };
    }).immediate();
    if (deferredError) throw deferredError;
    return result;
  } finally {
    db.close();
  }
}

/** 查询 cleanup run 状态；不存在时返回稳定 404。 */
function getDemoCleanupRunStatus(input = {}) {
  const cleanupRunId = validateCleanupRunId(input.cleanupRunId);
  const db = openDatabase();
  try {
    const cleanupRun = readCleanupRun(db, cleanupRunId);
    if (!cleanupRun) throw new AppError('DEMO_CLEANUP_RUN_NOT_FOUND', '清理运行不存在。', { statusCode: 404 });
    return cleanupRun;
  } finally {
    db.close();
  }
}

module.exports = {
  DEMO_CLEANUP_PREVIEW_TTL_MS,
  calculateCleanupPreviewDigest,
  executeDemoCleanup,
  getDemoCleanupRunStatus,
  previewDemoCleanup,
  _test: {
    buildCleanupSummary,
    mapCleanupRunRow,
    validateCleanupActorUserId,
    validateCleanupRunId,
    validateClientRequestId
  }
};
