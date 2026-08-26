'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('./demoParkDatasetService');
const { readCanonicalDemoRuntime } = require('./demoRuntimeService');

// 数据集 active 身份覆盖后续 cleanup 中间态，避免并行创建相同 Dataset run。
const ACTIVE_RUN_STATUSES = Object.freeze(['active', 'completed', 'cleanup_pending', 'cleaning']);
// 只有从未进入完成或清理流程的 active run 才允许自动退役，其他状态一律 fail-closed。
const AUTO_RETIREABLE_CONFLICT_STATUSES = Object.freeze(['active']);
// 无关联 manifest 冲突 run 使用稳定原因写入终止字段与操作审计。
const MANIFEST_CONFLICT_AUTO_RETIRE_REASON = 'manifest_conflict_auto_retired_no_associations';
// 自动退役操作使用独立审计事件，避免与正式清理流程混淆。
const MANIFEST_CONFLICT_AUTO_RETIRE_OPERATION = 'system.demo.run.manifest-conflict-retire';

/** 严格校验正整数用户主键。 */
function validateRunActorUserId(userId) {
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw badRequest('演示 run 用户主键无效。', { code: 'INVALID_DEMO_RUN_USER_ID' });
  }
  return userId;
}

/** 系统开关属于业务安全边界，即使超级管理员也不能绕过。 */
function assertDemoRuntimeEnabled(options = {}) {
  const runtime = readCanonicalDemoRuntime(options);
  if (runtime.enabled !== 1) {
    throw new AppError('DEMO_RUNTIME_DISABLED', '演示数据功能当前未开启。', {
      statusCode: 409,
      details: { enabled: false }
    });
  }
  return runtime;
}

/** 将数据库 run 行映射为 API 使用的稳定字段。 */
function mapDemoDatasetRun(row) {
  if (!row) return null;
  return {
    runId: row.runId,
    datasetId: row.datasetId,
    manifestVersion: row.manifestVersion,
    manifestDigest: row.manifestDigest,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  };
}

/** 从指定连接读取当前 Dataset active run。 */
function readActiveDemoDatasetRun(db) {
  return mapDemoDatasetRun(db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      status, created_by AS createdBy, created_at AS createdAt
    FROM demo_dataset_runs
    WHERE dataset_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')
    ORDER BY created_at DESC LIMIT 1`).get(DEMO_DATASET_ID));
}

/** 读取固定 Dataset 中不属于已知状态集合的异常 run，异常状态必须阻断创建。 */
function readUnknownDemoDatasetRun(db) {
  const knownStatuses = [...ACTIVE_RUN_STATUSES, 'cleaned', 'failed'];
  const placeholders = knownStatuses.map(() => '?').join(', ');
  return mapDemoDatasetRun(db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      status, created_by AS createdBy, created_at AS createdAt
    FROM demo_dataset_runs
    WHERE dataset_id = ? AND (status IS NULL OR status NOT IN (${placeholders}))
    ORDER BY created_at DESC LIMIT 1`).get(DEMO_DATASET_ID, ...knownStatuses));
}

/** 读取 run 是否存在 context、ownership、关系或真实导入批次等可证明关联。 */
function readDemoRunAssociationEvidence(db, runId) {
  try {
    return {
      context: Boolean(db.prepare('SELECT 1 FROM demo_import_contexts WHERE run_id = ? LIMIT 1').get(runId)),
      ownership: Boolean(db.prepare('SELECT 1 FROM demo_data_registry WHERE run_id = ? LIMIT 1').get(runId)),
      relation: Boolean(db.prepare('SELECT 1 FROM demo_data_relations WHERE run_id = ? LIMIT 1').get(runId)),
      businessRecord: Boolean(db.prepare('SELECT 1 FROM demo_run_import_batches WHERE run_id = ? LIMIT 1').get(runId))
    };
  } catch (_error) {
    // 关联证据无法完整读取时不得把未知状态当成“无关联”继续执行。
    throw new AppError('DEMO_RUN_RETIREMENT_UNCONFIRMED', '无法确认演示 run 是否存在关联或已消费数据，已拒绝自动退役。', {
      statusCode: 409,
      details: { runId, reason: 'association_evidence_unavailable' }
    });
  }
}

/** 判断关联证据是否显示任何 context、ownership、关系或业务记录。 */
function hasDemoRunAssociation(evidence) {
  return Object.values(evidence).some(Boolean);
}

/** 构造 manifest 冲突错误，统一保留旧 run 身份和 fail-closed 细节。 */
function createManifestConflictError(current, extraDetails = {}) {
  return new AppError('DEMO_ACTIVE_RUN_MANIFEST_CONFLICT', '现有演示 run 与当前 manifest 不一致，且无法证明其可安全退役，必须保留并人工处置。', {
    statusCode: 409,
    details: {
      runId: current.runId,
      datasetId: current.datasetId,
      expectedManifestVersion: DEMO_MANIFEST_VERSION,
      actualManifestVersion: current.manifestVersion,
      ...extraDetails
    }
  });
}

/** 在当前事务内仅退役明确无关联且尚未进入完成/清理流程的旧 run。 */
function retireUnassociatedManifestConflictRun(db, current, actorUserId, actorIp = null) {
  if (!AUTO_RETIREABLE_CONFLICT_STATUSES.includes(current.status)) {
    throw createManifestConflictError(current, {
      retirement: 'blocked_status',
      status: current.status
    });
  }
  let associationEvidence;
  try {
    associationEvidence = readDemoRunAssociationEvidence(db, current.runId);
  } catch (_error) {
    throw createManifestConflictError(current, {
      retirement: 'blocked_association_evidence_unavailable'
    });
  }
  if (hasDemoRunAssociation(associationEvidence)) {
    throw createManifestConflictError(current, {
      retirement: 'blocked_associations',
      associationEvidence
    });
  }

  const retiredAt = new Date().toISOString();
  const updateResult = db.prepare(`UPDATE demo_dataset_runs
    SET status = 'cleaned', cleanup_started_at = ?, cleaned_at = ?, failure_reason = ?
    WHERE run_id = ? AND dataset_id = ? AND status = ?
      AND manifest_version = ? AND manifest_digest = ?
      AND NOT EXISTS (SELECT 1 FROM demo_import_contexts WHERE run_id = ?)
      AND NOT EXISTS (SELECT 1 FROM demo_data_registry WHERE run_id = ?)
      AND NOT EXISTS (SELECT 1 FROM demo_data_relations WHERE run_id = ?)
      AND NOT EXISTS (SELECT 1 FROM demo_run_import_batches WHERE run_id = ?)`).run(
    retiredAt,
    retiredAt,
    MANIFEST_CONFLICT_AUTO_RETIRE_REASON,
    current.runId,
    current.datasetId,
    current.status,
    current.manifestVersion,
    current.manifestDigest,
    current.runId,
    current.runId,
    current.runId,
    current.runId
  );
  if (updateResult.changes !== 1) {
    throw createManifestConflictError(current, {
      retirement: 'blocked_state_changed'
    });
  }

  try {
    db.prepare(`INSERT INTO sys_operation_logs
      (user_id, operation, target_type, target_id, detail_json, ip, created_at)
      VALUES (?, ?, 'demo_dataset_runs', ?, ?, ?, ?)`).run(
      actorUserId,
      MANIFEST_CONFLICT_AUTO_RETIRE_OPERATION,
      current.runId,
      JSON.stringify({
        reason: MANIFEST_CONFLICT_AUTO_RETIRE_REASON,
        previousStatus: current.status,
        previousManifestVersion: current.manifestVersion,
        previousManifestDigest: current.manifestDigest,
        associationEvidence,
        retiredAt
      }),
      actorIp,
      retiredAt
    );
  } catch (_error) {
    // 审计写入失败必须回滚同一事务，避免出现无审计的自动退役。
    throw new AppError('DEMO_RUN_RETIREMENT_AUDIT_FAILED', '演示 run 退役审计写入失败，已拒绝自动退役。', {
      statusCode: 409,
      details: { runId: current.runId, reason: 'audit_write_failed' }
    });
  }

  return {
    ...current,
    status: 'cleaned',
    cleanedAt: retiredAt,
    failureReason: MANIFEST_CONFLICT_AUTO_RETIRE_REASON,
    retired: true,
    associationEvidence
  };
}

/** 创建或复用固定 Dataset 的 active run，并拒绝相同 Dataset 身份下 manifest 漂移。 */
function getOrCreateActiveDemoDatasetRun(input = {}) {
  const actorUserId = validateRunActorUserId(input.actorUserId);
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    if (!ownedDb && db.inTransaction !== true) {
      throw new AppError('DEMO_RUN_TRANSACTION_REQUIRED', '复用数据库连接创建演示 run 时必须位于调用方事务内。', {
        statusCode: 500
      });
    }
    const expectedDigest = getDemoParkManifestDigest();
    const execute = db.transaction(() => {
      const runtime = assertDemoRuntimeEnabled({ db });
      const unknownRun = readUnknownDemoDatasetRun(db);
      if (unknownRun) {
        throw createManifestConflictError(unknownRun, {
          retirement: 'blocked_unknown_status',
          status: unknownRun.status
        });
      }
      const current = readActiveDemoDatasetRun(db);
      if (current) {
        if (current.manifestVersion !== DEMO_MANIFEST_VERSION || current.manifestDigest !== expectedDigest) {
          retireUnassociatedManifestConflictRun(db, current, actorUserId, input.actorIp || null);
        } else {
          return { ...current, reused: true, runtimeEpoch: runtime.runtimeEpoch };
        }
      }
      const runId = `demo-run-${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
        runId,
        DEMO_DATASET_ID,
        DEMO_MANIFEST_VERSION,
        expectedDigest,
        actorUserId,
        createdAt
      );
      return { ...readActiveDemoDatasetRun(db), reused: false, runtimeEpoch: runtime.runtimeEpoch };
    });
    return ownedDb ? execute.immediate() : execute();
  } catch (error) {
    if (error && /UNIQUE constraint failed: demo_dataset_runs\.dataset_id/.test(error.message)) {
      const current = readActiveDemoDatasetRun(db);
      if (current && current.manifestVersion === DEMO_MANIFEST_VERSION && current.manifestDigest === getDemoParkManifestDigest()) {
        return { ...current, reused: true, runtimeEpoch: readCanonicalDemoRuntime({ db }).runtimeEpoch };
      }
    }
    throw error;
  } finally {
    if (ownedDb) db.close();
  }
}

/** 按 run 主键读取并严格验证固定 Dataset manifest 绑定。 */
function requireDemoDatasetRun(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  const row = mapDemoDatasetRun(db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      status, created_by AS createdBy, created_at AS createdAt
    FROM demo_dataset_runs WHERE run_id = ?`).get(normalizedRunId));
  if (!row || row.datasetId !== DEMO_DATASET_ID
    || row.manifestVersion !== DEMO_MANIFEST_VERSION
    || row.manifestDigest !== getDemoParkManifestDigest()
    || !ACTIVE_RUN_STATUSES.includes(row.status)) {
    throw new AppError('DEMO_RUN_INVALID', '演示数据 run 不存在、已结束或 manifest 不匹配。', {
      statusCode: 409,
      details: { runId: normalizedRunId || null }
    });
  }
  return row;
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  AUTO_RETIREABLE_CONFLICT_STATUSES,
  MANIFEST_CONFLICT_AUTO_RETIRE_OPERATION,
  MANIFEST_CONFLICT_AUTO_RETIRE_REASON,
  assertDemoRuntimeEnabled,
  getOrCreateActiveDemoDatasetRun,
  mapDemoDatasetRun,
  readActiveDemoDatasetRun,
  requireDemoDatasetRun,
  validateRunActorUserId,
  _test: {
    createManifestConflictError,
    hasDemoRunAssociation,
    readDemoRunAssociationEvidence,
    readUnknownDemoDatasetRun,
    retireUnassociatedManifestConflictRun
  }
};
