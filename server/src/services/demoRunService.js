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
// 只读历史汇总允许读取已结束 run；未知状态仍不得被解释为可读或可执行。
const READABLE_DEMO_RUN_STATUSES = Object.freeze([...ACTIVE_RUN_STATUSES, 'cleaned', 'failed']);

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

/** 读取指定 run 的只读投影，不触发 runtime、run 或审计写入。 */
function readDemoDatasetRunRow(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) return null;
  return mapDemoDatasetRun(db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      status, created_by AS createdBy, created_at AS createdAt
    FROM demo_dataset_runs WHERE run_id = ?`).get(normalizedRunId));
}

/** 为只读查询标记 run 的 manifest、生命周期和可读性，不改变写路径严格校验。 */
function getDemoDatasetRunReadCompatibility(run) {
  const expectedManifestDigest = getDemoParkManifestDigest();
  if (!run) {
    return {
      readable: false,
      readOnly: true,
      writeEligible: false,
      state: 'missing',
      code: 'DEMO_RUN_NOT_FOUND',
      manifestCompatible: false,
      historical: false,
      active: false,
      expectedManifestVersion: DEMO_MANIFEST_VERSION,
      expectedManifestDigest,
      actualManifestVersion: null,
      actualManifestDigest: null
    };
  }
  const datasetCompatible = run.datasetId === DEMO_DATASET_ID;
  const statusReadable = READABLE_DEMO_RUN_STATUSES.includes(run.status);
  const manifestCompatible = datasetCompatible
    && run.manifestVersion === DEMO_MANIFEST_VERSION
    && run.manifestDigest === expectedManifestDigest;
  const active = ACTIVE_RUN_STATUSES.includes(run.status);
  const historical = ['cleaned', 'failed'].includes(run.status);
  let state = 'readable';
  let code = 'DEMO_RUN_READABLE';
  if (!datasetCompatible) {
    state = 'dataset-mismatch';
    code = 'DEMO_RUN_DATASET_MISMATCH';
  } else if (!statusReadable) {
    state = 'unknown-status';
    code = 'DEMO_RUN_STATUS_UNREADABLE';
  } else if (!manifestCompatible && active) {
    state = 'manifest-conflict';
    code = 'DEMO_RUN_MANIFEST_CONFLICT_READ_ONLY';
  } else if (!manifestCompatible && historical) {
    state = 'historical-manifest-conflict';
    code = 'DEMO_RUN_HISTORICAL_MANIFEST_CONFLICT';
  } else if (historical) {
    state = 'historical';
    code = 'DEMO_RUN_HISTORICAL_READ_ONLY';
  } else if (active) {
    state = 'active';
    code = 'DEMO_RUN_ACTIVE';
  }
  return {
    readable: datasetCompatible && statusReadable,
    readOnly: true,
    writeEligible: datasetCompatible && statusReadable && active && manifestCompatible,
    state,
    code,
    manifestCompatible,
    historical,
    active,
    expectedManifestVersion: DEMO_MANIFEST_VERSION,
    expectedManifestDigest,
    actualManifestVersion: run.manifestVersion,
    actualManifestDigest: run.manifestDigest
  };
}

/** 返回当前 active run 的无副作用投影，供目录和状态接口读取。 */
function readActiveDemoDatasetRunProjection(options = {}) {
  const ownedDb = !options.db;
  const db = options.db || openDatabase();
  try {
    const activeRun = readActiveDemoDatasetRun(db);
    return {
      activeRun,
      compatibility: getDemoDatasetRunReadCompatibility(activeRun)
    };
  } finally {
    if (ownedDb) db.close();
  }
}

/** 返回指定 run 的无副作用投影，供历史/manifest 冲突只读查询使用。 */
function readDemoDatasetRunProjection(options = {}) {
  const ownedDb = !options.db;
  const db = options.db || openDatabase();
  try {
    const run = readDemoDatasetRunRow(db, options.runId);
    return {
      run,
      compatibility: getDemoDatasetRunReadCompatibility(run)
    };
  } finally {
    if (ownedDb) db.close();
  }
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

/** 构造 manifest 冲突错误，统一保留旧 run 身份和 fail-closed 细节。 */
function createManifestConflictError(current, extraDetails = {}) {
  return new AppError('DEMO_ACTIVE_RUN_MANIFEST_CONFLICT', '现有演示 run 与当前 manifest 不一致，必须保留并人工处置。', {
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
          // 写路径遇到任何 manifest/digest 冲突都保持旧 run 不变并 fail-closed；只读接口另行使用 projection。
          throw createManifestConflictError(current, {
            retirement: 'blocked_manifest_conflict'
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

/** 对 ownership registry 行按指定字段生成稳定分组计数。 */
function groupDemoOwnershipCounts(rows, fieldName) {
  const counts = new Map();
  rows.forEach((row) => counts.set(row[fieldName], (counts.get(row[fieldName]) || 0) + 1));
  return [...counts.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, count]) => ({ key, count }));
}

/** 按 run 主键执行无副作用可读校验；只允许固定 Dataset 的已知生命周期状态。 */
function requireReadableDemoDatasetRun(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  const projection = readDemoDatasetRunProjection({ db, runId: normalizedRunId });
  if (!projection.run || !projection.compatibility.readable) {
    throw new AppError('DEMO_RUN_INVALID', '演示数据 run 不存在、Dataset 不匹配或状态不可读取。', {
      statusCode: 409,
      details: {
        runId: normalizedRunId || null,
        compatibility: projection.compatibility
      }
    });
  }
  return {
    ...projection.run,
    compatibility: projection.compatibility
  };
}

/** 返回历史或 manifest 冲突 run 的只读 ownership 汇总，写路径仍使用严格校验。 */
function getReadableDemoOwnershipSummary(input = {}) {
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const run = requireReadableDemoDatasetRun(db, input.runId);
    // 延迟加载避免 demoOwnershipService 初始化时反向引用本模块形成未完成导出。
    const ownershipService = require('./demoOwnershipService');
    const rows = ownershipService.readDemoRegistryRows(db, run.runId);
    const activeRows = rows.filter((row) => row.cleanedAt === null);
    const cleanedRows = rows.filter((row) => row.cleanedAt !== null);
    const plan = ownershipService.buildDemoOwnershipPlan(db, run.runId);
    return {
      run,
      compatibility: run.compatibility,
      cleanupWriteEligible: run.compatibility.writeEligible,
      registrationConnected: plan.registrationConnected,
      derivedOwnershipConnected: false,
      staticCleanupEntityTypes: [...ownershipService.DEMO_CLEANUP_ENTITY_ORDER],
      totalCount: rows.length,
      activeCount: activeRows.length,
      cleanedCount: cleanedRows.length,
      activeByOwnershipKind: groupDemoOwnershipCounts(activeRows, 'ownershipKind'),
      activeByArtifact: groupDemoOwnershipCounts(activeRows, 'artifactKey'),
      activeByEntityType: groupDemoOwnershipCounts(activeRows, 'entityType'),
      cleanedByResult: groupDemoOwnershipCounts(cleanedRows, 'cleanupResult'),
      registryWatermark: plan.registryWatermark,
      cleanupCandidateCount: plan.candidateCount,
      cleanupBlockerCount: plan.blockerCount,
      blockers: plan.blockers
    };
  } finally {
    if (ownedDb) db.close();
  }
}

/** 按 run 主键读取并严格验证固定 Dataset 当前 manifest 绑定。 */
function requireDemoDatasetRun(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  const row = readDemoDatasetRunRow(db, normalizedRunId);
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
  READABLE_DEMO_RUN_STATUSES,
  assertDemoRuntimeEnabled,
  getOrCreateActiveDemoDatasetRun,
  mapDemoDatasetRun,
  readActiveDemoDatasetRun,
  readActiveDemoDatasetRunProjection,
  readDemoDatasetRunProjection,
  requireReadableDemoDatasetRun,
  getReadableDemoOwnershipSummary,
  requireDemoDatasetRun,
  validateRunActorUserId,
  _test: {
    createManifestConflictError,
    getDemoDatasetRunReadCompatibility,
    readUnknownDemoDatasetRun
  }
};
