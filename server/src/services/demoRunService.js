'use strict';

const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('./demoParkDatasetService');
const {
  advanceDemoRuntimeForManifestTurnover,
  readCanonicalDemoRuntime
} = require('./demoRuntimeService');

// active identity 覆盖 cleanup 执行中状态，用于唯一身份读取和并发占位。
const ACTIVE_IDENTITY_RUN_STATUSES = Object.freeze(['active', 'completed', 'cleanup_pending', 'cleaning']);
// 通用业务写入口只接受尚未进入实际 cleanup 执行的生命周期。
const BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES = Object.freeze(['active', 'completed', 'cleanup_pending']);
// manifest 自动换代与普通业务写共享同一未 cleaning 状态边界。
const TURNOVER_ELIGIBLE_RUN_STATUSES = BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES;
// 只读历史汇总允许读取已结束和已换代 run；未知状态仍不得被解释为可读或可执行。
const READABLE_DEMO_RUN_STATUSES = Object.freeze([
  ...ACTIVE_IDENTITY_RUN_STATUSES,
  'cleaned',
  'failed',
  'superseded'
]);
// manifest 自动换代的稳定业务原因和失效原因必须保持一致。
const MANIFEST_TURNOVER_REASON = 'manifest_identity_changed';
const MANIFEST_SUPERSEDE_REASON = 'manifest_run_superseded';

/** 严格校验正整数用户主键。 */
function validateRunActorUserId(userId) {
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw badRequest('演示 run 用户主键无效。', { code: 'INVALID_DEMO_RUN_USER_ID' });
  }
  return userId;
}

/** 校验并返回稳定换代触发入口。 */
function normalizeRunTrigger(trigger) {
  const normalizedTrigger = String(trigger || 'service-run-prepare').trim();
  if (!normalizedTrigger || normalizedTrigger.length > 128) {
    throw badRequest('演示 run 换代触发入口无效。', { code: 'INVALID_DEMO_RUN_TRIGGER' });
  }
  return normalizedTrigger;
}

/** 校验可选 managed artifact 标识，不允许审计载荷携带任意大字符串。 */
function normalizeOptionalArtifactKey(artifactKey) {
  if (artifactKey === undefined || artifactKey === null || artifactKey === '') return null;
  const normalizedArtifactKey = String(artifactKey).trim();
  if (!normalizedArtifactKey || normalizedArtifactKey.length > 128) {
    throw badRequest('演示 artifactKey 无效。', { code: 'INVALID_DEMO_RUN_ARTIFACT_KEY' });
  }
  return normalizedArtifactKey;
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
    createdAt: row.createdAt,
    supersededAt: row.supersededAt || null,
    successorRunId: row.successorRunId || null,
    supersededBy: row.supersededBy || null,
    supersedeReason: row.supersedeReason || null,
    supersedeTrigger: row.supersedeTrigger || null
  };
}

/** 生成 run 查询共用字段，避免 active 与历史投影发生字段漂移。 */
function getDemoRunSelectSql() {
  return `run_id AS runId, dataset_id AS datasetId,
    manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
    status, created_by AS createdBy, created_at AS createdAt,
    superseded_at AS supersededAt, successor_run_id AS successorRunId,
    superseded_by AS supersededBy, supersede_reason AS supersedeReason,
    supersede_trigger AS supersedeTrigger`;
}

/** 从指定连接读取当前 Dataset active run。 */
function readActiveDemoDatasetRun(db) {
  return mapDemoDatasetRun(db.prepare(`SELECT ${getDemoRunSelectSql()}
    FROM demo_dataset_runs
    WHERE dataset_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')
    ORDER BY created_at DESC LIMIT 1`).get(DEMO_DATASET_ID));
}

/** 读取指定 run 的只读投影，不触发 runtime、run 或审计写入。 */
function readDemoDatasetRunRow(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) return null;
  return mapDemoDatasetRun(db.prepare(`SELECT ${getDemoRunSelectSql()}
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
      turnoverEligible: false,
      retryable: false,
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
  const active = ACTIVE_IDENTITY_RUN_STATUSES.includes(run.status);
  const businessWriteEligible = BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES.includes(run.status);
  const historical = ['cleaned', 'failed', 'superseded'].includes(run.status);
  const turnoverEligible = datasetCompatible && !manifestCompatible
    && TURNOVER_ELIGIBLE_RUN_STATUSES.includes(run.status);
  const retryable = datasetCompatible && run.status === 'cleaning';
  let state = 'readable';
  let code = 'DEMO_RUN_READABLE';
  if (!datasetCompatible) {
    state = 'dataset-mismatch';
    code = 'DEMO_RUN_DATASET_MISMATCH';
  } else if (!statusReadable) {
    state = 'unknown-status';
    code = 'DEMO_RUN_STATUS_UNREADABLE';
  } else if (run.status === 'superseded') {
    state = 'historical-superseded';
    code = 'DEMO_RUN_HISTORICAL_SUPERSEDED';
  } else if (run.status === 'cleaning') {
    state = 'cleanup-in-progress-blocked';
    code = 'DEMO_RUN_CLEANUP_IN_PROGRESS';
  } else if (!manifestCompatible && TURNOVER_ELIGIBLE_RUN_STATUSES.includes(run.status)) {
    state = 'manifest-turnover-pending';
    code = 'DEMO_RUN_MANIFEST_TURNOVER_PENDING';
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
    writeEligible: datasetCompatible && statusReadable && businessWriteEligible && manifestCompatible,
    turnoverEligible,
    retryable,
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

/** 返回指定 run 的无副作用投影，供历史和待换代 run 只读查询使用。 */
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
  const knownStatuses = [...READABLE_DEMO_RUN_STATUSES];
  const placeholders = knownStatuses.map(() => '?').join(', ');
  return mapDemoDatasetRun(db.prepare(`SELECT ${getDemoRunSelectSql()}
    FROM demo_dataset_runs
    WHERE dataset_id = ? AND (status IS NULL OR status NOT IN (${placeholders}))
    ORDER BY created_at DESC LIMIT 1`).get(DEMO_DATASET_ID, ...knownStatuses));
}

/** 构造未知生命周期错误，禁止误归类为普通 manifest 漂移。 */
function createUnsupportedRunStateError(run) {
  return new AppError('DEMO_RUN_STATE_UNSUPPORTED', '演示 run 处于服务端不支持的生命周期状态。', {
    statusCode: 409,
    details: {
      runId: run.runId,
      status: run.status,
      retryable: false
    }
  });
}

/** 构造清理执行中错误，调用方可在清理事务完成后稳定重试。 */
function createCleanupInProgressError(run) {
  return new AppError('DEMO_RUN_CLEANUP_IN_PROGRESS', '演示 run 正在执行清理，请稍后重试。', {
    statusCode: 409,
    details: {
      runId: run.runId,
      status: run.status,
      retryable: true
    }
  });
}

/** 将 runtime canonical 行映射为固定 generation 快照。 */
function mapRuntimeGeneration(runtime) {
  return {
    enabled: runtime.enabled === 1 || runtime.enabled === true,
    runtimeEpoch: runtime.runtimeEpoch,
    revision: runtime.revision
  };
}

/** 将 run 投影为 turnover 中不含无关字段的稳定身份快照。 */
function mapTurnoverRun(run) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    manifestVersion: run.manifestVersion,
    manifestDigest: run.manifestDigest
  };
}

/** 生成未发生换代时的统一 metadata。 */
function buildNoTurnover(trigger) {
  return {
    performed: false,
    reason: null,
    trigger,
    previousRun: null,
    successorRun: null,
    revokedContextCount: 0,
    supersededCleanupPreviewCount: 0,
    runtimeBefore: null,
    runtimeAfter: null
  };
}

/** 将 current run 与 runtime 组合为 POST 和 managed 下载共享的稳定返回合同。 */
function buildCurrentRunResult(run, runtime, reused, turnover) {
  return {
    runId: run.runId,
    datasetId: run.datasetId,
    manifestVersion: run.manifestVersion,
    manifestDigest: run.manifestDigest,
    status: run.status,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    reused,
    runtimeEpoch: runtime.runtimeEpoch,
    runtimeRevision: runtime.revision,
    turnover
  };
}

/** 写入首次创建审计，detail 仅包含治理身份，不包含 token 或文件内容。 */
function writeDemoRunCreateAudit(db, input) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, 'system.demo.run.create', 'demo_dataset_runs', ?, ?, ?, ?)`).run(
    input.actorUserId,
    input.run.runId,
    JSON.stringify({
      runId: input.run.runId,
      datasetId: input.run.datasetId,
      manifestVersion: input.run.manifestVersion,
      manifestDigest: input.run.manifestDigest,
      trigger: input.trigger,
      artifactKey: input.artifactKey,
      runtime: mapRuntimeGeneration(input.runtime)
    }),
    input.actorIp,
    input.createdAt
  );
}

/** 在同一事务内完成旧 run 失效、runtime 提升、successor 创建和审计。 */
function supersedeDemoDatasetRun(db, input) {
  const successorRunId = `demo-run-${crypto.randomUUID()}`;
  const supersededAt = new Date().toISOString();
  const cleanupResult = db.prepare(`UPDATE demo_cleanup_runs
    SET status = 'superseded', completed_at = ?, failure_reason = ?
    WHERE run_id = ? AND status = 'previewed'`).run(
    supersededAt,
    MANIFEST_SUPERSEDE_REASON,
    input.current.runId
  );
  const contextResult = db.prepare(`UPDATE demo_import_contexts
    SET status = 'revoked', revoked_at = ?, revoke_reason = ?
    WHERE run_id = ? AND status IN ('issued', 'previewed')`).run(
    supersededAt,
    MANIFEST_SUPERSEDE_REASON,
    input.current.runId
  );
  const runtimeChange = advanceDemoRuntimeForManifestTurnover({
    db,
    actorUserId: input.actorUserId,
    actorIp: input.actorIp,
    previousRunId: input.current.runId,
    successorRunId
  });
  const supersedeResult = db.prepare(`UPDATE demo_dataset_runs
    SET status = 'superseded', superseded_at = ?, successor_run_id = ?, superseded_by = ?,
      supersede_reason = ?, supersede_trigger = ?
    WHERE run_id = ? AND status = ?`).run(
    supersededAt,
    successorRunId,
    input.actorUserId,
    MANIFEST_SUPERSEDE_REASON,
    input.trigger,
    input.current.runId,
    input.current.status
  );
  if (supersedeResult.changes !== 1) {
    throw new Error('旧演示 run 在换代事务内发生并发状态漂移。');
  }
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
    successorRunId,
    DEMO_DATASET_ID,
    DEMO_MANIFEST_VERSION,
    input.expectedDigest,
    input.actorUserId,
    supersededAt
  );
  const successor = readActiveDemoDatasetRun(db);
  const turnover = {
    performed: true,
    reason: MANIFEST_TURNOVER_REASON,
    trigger: input.trigger,
    previousRun: mapTurnoverRun(input.current),
    successorRun: mapTurnoverRun(successor),
    revokedContextCount: contextResult.changes,
    supersededCleanupPreviewCount: cleanupResult.changes,
    runtimeBefore: runtimeChange.before,
    runtimeAfter: runtimeChange.after
  };
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, 'system.demo.run.auto-supersede', 'demo_dataset_runs', ?, ?, ?, ?)`).run(
    input.actorUserId,
    input.current.runId,
    JSON.stringify({
      oldRunId: input.current.runId,
      newRunId: successor.runId,
      datasetId: DEMO_DATASET_ID,
      oldStatus: input.current.status,
      oldManifestVersion: input.current.manifestVersion,
      oldManifestDigest: input.current.manifestDigest,
      newManifestVersion: successor.manifestVersion,
      newManifestDigest: successor.manifestDigest,
      trigger: input.trigger,
      artifactKey: input.artifactKey,
      revokedContextCount: contextResult.changes,
      supersededCleanupPreviewCount: cleanupResult.changes,
      runtimeBefore: runtimeChange.before,
      runtimeAfter: runtimeChange.after
    }),
    input.actorIp,
    supersededAt
  );
  return buildCurrentRunResult(successor, runtimeChange.after, false, turnover);
}

/** 创建、复用或原子换代固定 Dataset 的 active run。 */
function getOrCreateActiveDemoDatasetRun(input = {}) {
  const actorUserId = validateRunActorUserId(input.actorUserId);
  const actorIp = input.actorIp ? String(input.actorIp) : null;
  const trigger = normalizeRunTrigger(input.trigger);
  const artifactKey = normalizeOptionalArtifactKey(input.artifactKey);
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
      if (unknownRun) throw createUnsupportedRunStateError(unknownRun);
      const current = readActiveDemoDatasetRun(db);
      if (current) {
        const manifestCompatible = current.manifestVersion === DEMO_MANIFEST_VERSION
          && current.manifestDigest === expectedDigest;
        if (current.status === 'cleaning') throw createCleanupInProgressError(current);
        if (manifestCompatible) {
          return buildCurrentRunResult(current, runtime, true, buildNoTurnover(trigger));
        }
        if (!TURNOVER_ELIGIBLE_RUN_STATUSES.includes(current.status)) {
          throw createUnsupportedRunStateError(current);
        }
        return supersedeDemoDatasetRun(db, {
          actorUserId,
          actorIp,
          trigger,
          artifactKey,
          current,
          expectedDigest
        });
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
      const createdRun = readActiveDemoDatasetRun(db);
      writeDemoRunCreateAudit(db, {
        actorUserId,
        actorIp,
        trigger,
        artifactKey,
        run: createdRun,
        runtime,
        createdAt
      });
      return buildCurrentRunResult(createdRun, runtime, false, buildNoTurnover(trigger));
    });
    return ownedDb ? execute.immediate() : execute();
  } catch (error) {
    if (error && /UNIQUE constraint failed: demo_dataset_runs\.dataset_id/.test(error.message)) {
      const current = readActiveDemoDatasetRun(db);
      const runtime = readCanonicalDemoRuntime({ db });
      if (current?.status === 'cleaning') throw createCleanupInProgressError(current);
      if (current && current.manifestVersion === DEMO_MANIFEST_VERSION
        && current.manifestDigest === getDemoParkManifestDigest()
        && BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES.includes(current.status)) {
        return buildCurrentRunResult(current, runtime, true, buildNoTurnover(trigger));
      }
      throw new AppError('DEMO_RUN_CONCURRENT_TURNOVER_FAILED', '演示 run 并发换代未能收敛到唯一 successor。', {
        statusCode: 409,
        details: { retryable: true }
      });
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

/** 返回历史或待换代 run 的只读 ownership 汇总，写路径仍使用严格校验。 */
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

/** 按 run 主键读取并严格验证固定 Dataset 当前 manifest 与通用业务可写生命周期。 */
function requireDemoDatasetRun(db, runId) {
  const normalizedRunId = String(runId || '').trim();
  const row = readDemoDatasetRunRow(db, normalizedRunId);
  if (row?.datasetId === DEMO_DATASET_ID && row.status === 'cleaning') {
    throw createCleanupInProgressError(row);
  }
  if (!row || row.datasetId !== DEMO_DATASET_ID
    || row.manifestVersion !== DEMO_MANIFEST_VERSION
    || row.manifestDigest !== getDemoParkManifestDigest()
    || !BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES.includes(row.status)) {
    throw new AppError('DEMO_RUN_INVALID', '演示数据 run 不存在、已结束、不可写或 manifest 不匹配。', {
      statusCode: 409,
      details: { runId: normalizedRunId || null }
    });
  }
  return row;
}

module.exports = {
  ACTIVE_IDENTITY_RUN_STATUSES,
  BUSINESS_WRITE_ELIGIBLE_RUN_STATUSES,
  READABLE_DEMO_RUN_STATUSES,
  TURNOVER_ELIGIBLE_RUN_STATUSES,
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
    buildNoTurnover,
    createCleanupInProgressError,
    createUnsupportedRunStateError,
    getDemoDatasetRunReadCompatibility,
    readUnknownDemoDatasetRun
  }
};
