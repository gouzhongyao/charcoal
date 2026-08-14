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

/** 创建或复用固定 Dataset 的 active run，并拒绝相同 Dataset 身份下 manifest 漂移。 */
function getOrCreateActiveDemoDatasetRun(input = {}) {
  const actorUserId = validateRunActorUserId(input.actorUserId);
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const runtime = assertDemoRuntimeEnabled({ db });
    const expectedDigest = getDemoParkManifestDigest();
    const execute = db.transaction(() => {
      const current = readActiveDemoDatasetRun(db);
      if (current) {
        if (current.manifestVersion !== DEMO_MANIFEST_VERSION || current.manifestDigest !== expectedDigest) {
          throw new AppError('DEMO_ACTIVE_RUN_MANIFEST_CONFLICT', '现有演示 run 与当前 manifest 不一致，必须先完成清理或人工处置。', {
            statusCode: 409,
            details: {
              runId: current.runId,
              datasetId: current.datasetId,
              expectedManifestVersion: DEMO_MANIFEST_VERSION,
              actualManifestVersion: current.manifestVersion
            }
          });
        }
        return { ...current, reused: true, runtimeEpoch: runtime.runtimeEpoch };
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
    return execute.immediate();
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
  assertDemoRuntimeEnabled,
  getOrCreateActiveDemoDatasetRun,
  mapDemoDatasetRun,
  readActiveDemoDatasetRun,
  requireDemoDatasetRun,
  validateRunActorUserId
};
