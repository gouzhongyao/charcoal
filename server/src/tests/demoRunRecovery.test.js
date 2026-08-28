'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本测试只使用隔离临时目录，不读取或修改项目真实 data、uploads 与 backups。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-run-recovery-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-run-recovery.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoRunRecovery123!';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { DEMO_DATASET_ID } = require('../services/demoParkDatasetService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const {
  getOrCreateActiveDemoDatasetRun,
  getReadableDemoOwnershipSummary,
  readActiveDemoDatasetRunProjection,
  readDemoDatasetRunProjection,
  requireDemoDatasetRun,
  requireReadableDemoDatasetRun
} = require('../services/demoRunService');

/** 插入指定 manifest 身份的演示 run，供隔离安全边界测试使用。 */
function insertRun(db, input = {}) {
  const createdAt = input.createdAt || new Date().toISOString();
  const run = {
    runId: input.runId || `legacy-demo-run-${Date.now()}`,
    datasetId: input.datasetId || DEMO_DATASET_ID,
    manifestVersion: input.manifestVersion || '1.0.0',
    manifestDigest: input.manifestDigest || 'a'.repeat(64),
    status: input.status || 'active',
    createdBy: input.createdBy === undefined ? 1 : input.createdBy,
    createdAt
  };
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    run.status,
    run.createdBy,
    run.createdAt
  );
  return run;
}

/** 结束当前 active run，仅用于构造下一个独立隔离测试场景。 */
function markRunCleaned(db, runId) {
  const cleanedAt = new Date().toISOString();
  db.prepare(`UPDATE demo_dataset_runs
    SET status = 'cleaned', cleanup_started_at = ?, cleaned_at = ?
    WHERE run_id = ?`).run(cleanedAt, cleanedAt, runId);
}

/** 为冲突 run 写入 context、ownership、关系和批次消费证据。 */
function attachBlockingEvidence(db, run) {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
      artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
      status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
    'recovery-block-context',
    'b'.repeat(64),
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    '13-shift-definitions',
    'shift-definitions-import',
    'c'.repeat(64),
    1,
    2,
    issuedAt,
    expiresAt
  );

  const importBatchId = db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
    VALUES ('shift_definition', 'recovery.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, '13-shift-definitions', 'recovery-block-context', ?, 'primary')`).run(run.runId, importBatchId);

  const insertRegistry = db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest)
    VALUES (?, '13-shift-definitions', ?, ?, 'imported', ?, ?)`);
  const firstRegistryId = insertRegistry.run(run.runId, 'recovery_entity', 'one', 'd'.repeat(64), 'e'.repeat(64)).lastInsertRowid;
  const secondRegistryId = insertRegistry.run(run.runId, 'recovery_entity', 'two', 'f'.repeat(64), '0'.repeat(64)).lastInsertRowid;
  db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type)
    VALUES (?, ?, ?, 'generated_from')`).run(run.runId, firstRegistryId, secondRegistryId);
}

(async () => {
  try {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });

    const db = openDatabase();
    try {
      const runtimeBefore = db.prepare('SELECT runtime_epoch AS runtimeEpoch FROM demo_runtime_settings WHERE id = 1').get();
      const legacy = insertRun(db, {
        runId: 'legacy-unassociated-run',
        manifestVersion: '1.0.0',
        manifestDigest: 'a'.repeat(64),
        createdAt: '2026-08-20T00:00:00.000Z'
      });
      const auditCountBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, actorIp: '127.0.0.1', db })).immediate(),
        (error) => error.code === 'DEMO_ACTIVE_RUN_MANIFEST_CONFLICT'
          && error.statusCode === 409
          && error.details.retirement === 'blocked_manifest_conflict'
          && error.details.runId === legacy.runId,
        '无论旧 run 是否存在关联，manifest/digest 冲突都必须保持 409。'
      );
      const unchanged = db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
          manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
          status, created_by AS createdBy, created_at AS createdAt,
          cleanup_started_at AS cleanupStartedAt, cleaned_at AS cleanedAt,
          failure_reason AS failureReason
        FROM demo_dataset_runs WHERE run_id = ?`).get(legacy.runId);
      assert.deepStrictEqual(unchanged, {
        runId: legacy.runId,
        datasetId: legacy.datasetId,
        manifestVersion: legacy.manifestVersion,
        manifestDigest: legacy.manifestDigest,
        status: 'active',
        createdBy: legacy.createdBy,
        createdAt: legacy.createdAt,
        cleanupStartedAt: null,
        cleanedAt: null,
        failureReason: null
      }, 'manifest 冲突失败后旧 run 必须保持原样。');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total, auditCountBefore,
        'manifest 冲突不得写入自动退役审计。');
      assert.deepStrictEqual(db.prepare('SELECT runtime_epoch AS runtimeEpoch FROM demo_runtime_settings WHERE id = 1').get(), runtimeBefore,
        'manifest 冲突不得修改 runtime epoch。');
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_dataset_runs
        WHERE dataset_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')`).get(DEMO_DATASET_ID).total, 1,
      'manifest 冲突拒绝后不得创建第二个 active run。');

      const activeProjection = readActiveDemoDatasetRunProjection({ db });
      assert.strictEqual(activeProjection.activeRun.runId, legacy.runId);
      assert.strictEqual(activeProjection.compatibility.state, 'manifest-conflict');
      assert.strictEqual(activeProjection.compatibility.readable, true);
      assert.strictEqual(activeProjection.compatibility.writeEligible, false);
      const readableConflictRun = requireReadableDemoDatasetRun(db, legacy.runId);
      assert.strictEqual(readableConflictRun.compatibility.code, 'DEMO_RUN_MANIFEST_CONFLICT_READ_ONLY');
      assert.throws(
        () => requireDemoDatasetRun(db, legacy.runId),
        (error) => error.code === 'DEMO_RUN_INVALID',
        'manifest 冲突 run 只允许只读投影，context/import/cleanup 等严格写路径必须继续拒绝。'
      );
      const conflictOwnership = getReadableDemoOwnershipSummary({ db, runId: legacy.runId });
      assert.strictEqual(conflictOwnership.totalCount, 0);
      assert.strictEqual(conflictOwnership.compatibility.state, 'manifest-conflict');
      assert.strictEqual(conflictOwnership.cleanupWriteEligible, false);

      markRunCleaned(db, legacy.runId);
      const historicalProjection = readDemoDatasetRunProjection({ db, runId: legacy.runId });
      assert.strictEqual(historicalProjection.compatibility.state, 'historical-manifest-conflict');
      assert.strictEqual(historicalProjection.compatibility.readable, true);
      assert.strictEqual(historicalProjection.compatibility.historical, true);
      assert.strictEqual(historicalProjection.compatibility.writeEligible, false);
      assert.strictEqual(getReadableDemoOwnershipSummary({ db, runId: legacy.runId }).cleanupWriteEligible, false);

      const blocked = insertRun(db, {
        runId: 'legacy-associated-run',
        manifestVersion: '1.0.0',
        manifestDigest: '1'.repeat(64),
        createdAt: '2026-08-21T00:00:00.000Z'
      });
      attachBlockingEvidence(db, blocked);
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        (error) => error.code === 'DEMO_ACTIVE_RUN_MANIFEST_CONFLICT'
          && error.statusCode === 409
          && error.details.retirement === 'blocked_manifest_conflict',
        '存在 context、ownership、关系或业务批次关联时同样必须保留 409。'
      );
      const blockedAfter = db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
          manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
          status, created_by AS createdBy, created_at AS createdAt
        FROM demo_dataset_runs WHERE run_id = ?`).get(blocked.runId);
      assert.deepStrictEqual(blockedAfter, {
        runId: blocked.runId,
        datasetId: blocked.datasetId,
        manifestVersion: blocked.manifestVersion,
        manifestDigest: blocked.manifestDigest,
        status: 'active',
        createdBy: blocked.createdBy,
        createdAt: blocked.createdAt
      }, '有关联冲突 run 的身份和状态不得被篡改。');
    } finally {
      db.close();
    }
    console.log('demo run recovery tests passed');
  } finally {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows 句柄释放稍晚时，临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
