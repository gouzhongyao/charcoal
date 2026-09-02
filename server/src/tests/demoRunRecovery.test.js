'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

// 本测试只使用隔离临时目录，不读取或修改项目真实 data、uploads 与 backups。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-run-recovery-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-run-recovery.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoRunRecovery123!';
process.env.NODE_ENV = 'test';

const {
  CANONICAL_SCHEMA_PREDECESSOR_VERSION,
  CANONICAL_SCHEMA_VERSION,
  buildDemoRunTurnoverPredecessorSqlOverrides,
  calculateSchemaFingerprint,
  initDatabase,
  openDatabase
} = require('../db/database');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');
const { createDemoContext } = require('../services/demoContextService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const {
  getOrCreateActiveDemoDatasetRun,
  getReadableDemoOwnershipSummary,
  readActiveDemoDatasetRunProjection,
  readDemoDatasetRunProjection,
  requireDemoDatasetRun,
  requireReadableDemoDatasetRun
} = require('../services/demoRunService');

/** 插入指定 manifest 身份和生命周期的演示 run。 */
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
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    run.status,
    run.createdBy,
    run.createdAt,
    run.status === 'completed' ? createdAt : null
  );
  return run;
}

/** 将当前 successor 结束为 cleaned，以隔离构造下一个 active 身份。 */
function markRunCleaned(db, runId) {
  db.prepare(`UPDATE demo_dataset_runs SET status = 'cleaned', cleaned_at = ?
    WHERE run_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')`)
    .run(new Date().toISOString(), runId);
}

/** 为旧 run 写入 context、ownership、关系和批次消费证据。 */
function attachGovernanceEvidence(db, run, suffix) {
  const contextId = `recovery-context-${suffix}`;
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const runtimeEpoch = db.prepare('SELECT runtime_epoch AS runtimeEpoch FROM demo_runtime_settings WHERE id = 1').get().runtimeEpoch;
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
      artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
      status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
    contextId,
    crypto.createHash('sha256').update(`token-${suffix}`).digest('hex'),
    run.runId,
    run.datasetId,
    run.manifestVersion,
    run.manifestDigest,
    '13-shift-definitions',
    'shift-definitions-import',
    crypto.createHash('sha256').update(`artifact-${suffix}`).digest('hex'),
    1,
    runtimeEpoch,
    issuedAt,
    expiresAt
  );
  const importBatchId = db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
    VALUES ('shift_definition', ?, 'xlsx', 'completed', 1, 1, 0, 0)`).run(`${suffix}.xlsx`).lastInsertRowid;
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, '13-shift-definitions', ?, ?, 'primary')`).run(run.runId, contextId, importBatchId);
  const insertRegistry = db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest)
    VALUES (?, '13-shift-definitions', ?, ?, 'imported', ?, ?)`);
  const firstRegistryId = insertRegistry.run(run.runId, `recovery_entity_${suffix}`, 'one', 'd'.repeat(64), 'e'.repeat(64)).lastInsertRowid;
  const secondRegistryId = insertRegistry.run(run.runId, `recovery_entity_${suffix}`, 'two', 'f'.repeat(64), '0'.repeat(64)).lastInsertRowid;
  db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type)
    VALUES (?, ?, ?, 'generated_from')`).run(run.runId, firstRegistryId, secondRegistryId);
  return { contextId, importBatchId, firstRegistryId, secondRegistryId };
}

/** 在 cleanup_pending run 下创建仍可执行的预演记录。 */
function insertCleanupPreview(db, runId, suffix) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const runtimeRevision = db.prepare('SELECT revision FROM demo_runtime_settings WHERE id = 1').get().revision;
  const cleanupRunId = `cleanup-preview-${suffix}`;
  db.prepare(`INSERT INTO demo_cleanup_runs
    (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
      runtime_revision, registry_watermark, candidate_count, blocker_count, requested_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 'previewed', ?)`).run(
    cleanupRunId,
    runId,
    `cleanup-request-${suffix}`,
    '9'.repeat(64),
    expiresAt,
    runtimeRevision,
    `watermark-${suffix}`,
    now
  );
  return cleanupRunId;
}

/** 验证 canonical v3 predecessor 经 initDatabase 原子升级到 v4 且不改变历史归属。 */
function assertV3ToV4Migration() {
  const migrationPath = path.join(temporaryRoot, 'migration', 'v3-to-v4.sqlite');
  fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
  initDatabase({ databasePath: migrationPath });
  const predecessorOverrides = buildDemoRunTurnoverPredecessorSqlOverrides();
  const db = openDatabase({ databasePath: migrationPath });
  const migrationRun = insertRun(db, {
    runId: 'migration-preserved-run',
    manifestVersion: '1.0.0',
    manifestDigest: '7'.repeat(64),
    status: 'completed',
    createdAt: '2026-08-19T00:00:00.000Z'
  });
  const migrationEvidence = attachGovernanceEvidence(db, migrationRun, 'migration');
  const migrationCleanupRunId = insertCleanupPreview(db, migrationRun.runId, 'migration');
  const attachedRunTriggers = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'demo_dataset_runs' AND sql IS NOT NULL ORDER BY name`)
    .all().map((row) => row.sql);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TEMP TABLE demo_dataset_runs_v4_backup AS SELECT * FROM demo_dataset_runs ORDER BY run_id;
        CREATE TEMP TABLE demo_cleanup_runs_v4_backup AS SELECT * FROM demo_cleanup_runs ORDER BY cleanup_run_id;
        DROP TABLE demo_cleanup_runs;
        DROP TABLE demo_dataset_runs;`);
      db.exec(predecessorOverrides.get('table:demo_dataset_runs:demo_dataset_runs'));
      db.exec(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
          completed_at, cleanup_started_at, cleaned_at, failure_reason)
        SELECT run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
          completed_at, cleanup_started_at, cleaned_at, failure_reason
        FROM temp.demo_dataset_runs_v4_backup ORDER BY run_id`);
      db.exec(predecessorOverrides.get('table:demo_cleanup_runs:demo_cleanup_runs'));
      db.exec(`INSERT INTO demo_cleanup_runs
        (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
          runtime_revision, registry_watermark, candidate_count, blocker_count, summary_json,
          confirmation_text, requested_by, status, backup_metadata_json, deleted_count,
          already_missing_count, created_at, started_at, completed_at, failure_reason)
        SELECT cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
          runtime_revision, registry_watermark, candidate_count, blocker_count, summary_json,
          confirmation_text, requested_by, status, backup_metadata_json, deleted_count,
          already_missing_count, created_at, started_at, completed_at, failure_reason
        FROM temp.demo_cleanup_runs_v4_backup ORDER BY cleanup_run_id;
        DROP TABLE temp.demo_cleanup_runs_v4_backup;
        DROP TABLE temp.demo_dataset_runs_v4_backup;
        CREATE UNIQUE INDEX ux_demo_dataset_runs_active_dataset ON demo_dataset_runs(dataset_id)
          WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning');
        CREATE INDEX idx_demo_dataset_runs_status_created ON demo_dataset_runs(status, created_at DESC);
        CREATE INDEX idx_demo_cleanup_runs_status_created ON demo_cleanup_runs(status, created_at DESC);`);
      attachedRunTriggers.forEach((sql) => db.exec(sql));
      const predecessorFingerprint = calculateSchemaFingerprint(db);
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'")
        .run(CANONICAL_SCHEMA_PREDECESSOR_VERSION);
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'")
        .run(predecessorFingerprint);
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }

  initDatabase({ databasePath: migrationPath });
  const migratedDb = openDatabase({ databasePath: migrationPath });
  try {
    assert.strictEqual(
      migratedDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      CANONICAL_SCHEMA_VERSION
    );
    const columns = migratedDb.prepare('PRAGMA table_info(demo_dataset_runs)').all().map((column) => column.name);
    ['superseded_at', 'successor_run_id', 'superseded_by', 'supersede_reason', 'supersede_trigger']
      .forEach((columnName) => assert(columns.includes(columnName), `v4 必须包含 ${columnName}。`));
    const migratedRun = migratedDb.prepare(`SELECT status, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, successor_run_id AS successorRunId,
      superseded_at AS supersededAt FROM demo_dataset_runs WHERE run_id = ?`).get(migrationRun.runId);
    assert.deepStrictEqual(migratedRun, {
      status: migrationRun.status,
      manifestVersion: migrationRun.manifestVersion,
      manifestDigest: migrationRun.manifestDigest,
      successorRunId: null,
      supersededAt: null
    });
    assert.strictEqual(migratedDb.prepare('SELECT status FROM demo_cleanup_runs WHERE cleanup_run_id = ?').get(migrationCleanupRunId).status, 'previewed');
    assert.strictEqual(migratedDb.prepare('SELECT run_id AS runId FROM demo_import_contexts WHERE context_id = ?').get(migrationEvidence.contextId).runId, migrationRun.runId);
    assert.strictEqual(migratedDb.prepare('SELECT run_id AS runId FROM demo_run_import_batches WHERE import_batch_id = ?').get(migrationEvidence.importBatchId).runId, migrationRun.runId);
    assert.strictEqual(migratedDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE run_id = ?').get(migrationRun.runId).total, 2);
    assert.deepStrictEqual(migratedDb.pragma('foreign_key_check'), []);
  } finally {
    migratedDb.close();
  }
}

/** 在独立线程中并发触发同一隔离 SQLite 的 manifest run 自动换代。 */
function supersedeRunInWorker(actorUserId) {
  return new Promise((resolve, reject) => {
    const workerSource = `
      const { parentPort, workerData } = require('worker_threads');
      process.env.DATA_DIR = workerData.dataDir;
      process.env.SQLITE_PATH = workerData.sqlitePath;
      process.env.UPLOADS_DIR = workerData.uploadsDir;
      process.env.BACKUPS_DIR = workerData.backupsDir;
      process.env.CHARCOAL_ADMIN_PASSWORD = workerData.adminPassword;
      process.env.NODE_ENV = 'test';
      const { getOrCreateActiveDemoDatasetRun } = require(workerData.servicePath);
      try {
        const result = getOrCreateActiveDemoDatasetRun({
          actorUserId: workerData.actorUserId,
          trigger: 'concurrent-turnover-test'
        });
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          code: error.code || null,
          message: error.message,
          details: error.details || null
        });
      }
    `;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        actorUserId,
        dataDir: process.env.DATA_DIR,
        sqlitePath: process.env.SQLITE_PATH,
        uploadsDir: process.env.UPLOADS_DIR,
        backupsDir: process.env.BACKUPS_DIR,
        adminPassword: process.env.CHARCOAL_ADMIN_PASSWORD,
        servicePath: require.resolve('../services/demoRunService')
      }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

/** 断言成功换代的固定返回合同和运行时单次提升。 */
function assertTurnoverResult(result, previousRun, runtimeBefore, trigger) {
  assert.strictEqual(result.reused, false);
  assert.strictEqual(result.runId, result.turnover.successorRun.runId);
  assert.strictEqual(result.status, 'active');
  assert.strictEqual(result.manifestVersion, DEMO_MANIFEST_VERSION);
  assert.strictEqual(result.manifestDigest, getDemoParkManifestDigest());
  assert.strictEqual(result.runtimeEpoch, runtimeBefore.runtimeEpoch + 1);
  assert.strictEqual(result.runtimeRevision, runtimeBefore.revision + 1);
  assert.deepStrictEqual(result.turnover, {
    performed: true,
    reason: 'manifest_identity_changed',
    trigger,
    previousRun: {
      runId: previousRun.runId,
      status: previousRun.status,
      manifestVersion: previousRun.manifestVersion,
      manifestDigest: previousRun.manifestDigest
    },
    successorRun: {
      runId: result.runId,
      status: 'active',
      manifestVersion: DEMO_MANIFEST_VERSION,
      manifestDigest: getDemoParkManifestDigest()
    },
    revokedContextCount: result.turnover.revokedContextCount,
    supersededCleanupPreviewCount: result.turnover.supersededCleanupPreviewCount,
    runtimeBefore: { enabled: true, ...runtimeBefore },
    runtimeAfter: {
      enabled: true,
      runtimeEpoch: runtimeBefore.runtimeEpoch + 1,
      revision: runtimeBefore.revision + 1
    }
  });
}

(async () => {
  try {
    assert.notStrictEqual(
      path.resolve(process.env.SQLITE_PATH),
      path.resolve(__dirname, '../../../data/energy-carbon.sqlite'),
      '测试 SQLite 绝不能指向工作区真实数据库。'
    );
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
    assertV3ToV4Migration();
    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });

    let concurrentPredecessor;
    let runtimeBeforeConcurrent;
    let turnoverAuditBeforeConcurrent;
    const db = openDatabase();
    try {
      const runtimeBeforeVersion = db.prepare('SELECT runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const versionMismatch = insertRun(db, {
        runId: 'legacy-version-mismatch',
        manifestVersion: '1.0.0',
        manifestDigest: getDemoParkManifestDigest(),
        createdAt: '2026-08-20T00:00:00.000Z'
      });
      const pendingProjection = readActiveDemoDatasetRunProjection({ db });
      assert.strictEqual(pendingProjection.compatibility.state, 'manifest-turnover-pending');
      assert.strictEqual(pendingProjection.compatibility.turnoverEligible, true);
      const versionResult = db.transaction(() => getOrCreateActiveDemoDatasetRun({
        actorUserId: 1,
        actorIp: '127.0.0.1',
        trigger: 'explicit-run-prepare',
        db
      })).immediate();
      assertTurnoverResult(versionResult, versionMismatch, runtimeBeforeVersion, 'explicit-run-prepare');
      assert.strictEqual(versionResult.turnover.revokedContextCount, 0);
      assert.strictEqual(versionResult.turnover.supersededCleanupPreviewCount, 0);
      const oldVersionRow = db.prepare(`SELECT status, successor_run_id AS successorRunId,
        supersede_reason AS supersedeReason, supersede_trigger AS supersedeTrigger
        FROM demo_dataset_runs WHERE run_id = ?`).get(versionMismatch.runId);
      assert.deepStrictEqual(oldVersionRow, {
        status: 'superseded',
        successorRunId: versionResult.runId,
        supersedeReason: 'manifest_run_superseded',
        supersedeTrigger: 'explicit-run-prepare'
      });
      const historicalProjection = readDemoDatasetRunProjection({ db, runId: versionMismatch.runId });
      assert.strictEqual(historicalProjection.compatibility.state, 'historical-superseded');
      assert.strictEqual(requireReadableDemoDatasetRun(db, versionMismatch.runId).successorRunId, versionResult.runId);
      assert.throws(() => requireDemoDatasetRun(db, versionMismatch.runId), (error) => error.code === 'DEMO_RUN_INVALID');
      assert.strictEqual(getReadableDemoOwnershipSummary({ db, runId: versionMismatch.runId }).cleanupWriteEligible, false);

      const reuseResult = db.transaction(() => getOrCreateActiveDemoDatasetRun({
        actorUserId: 1,
        trigger: 'explicit-run-prepare',
        db
      })).immediate();
      assert.strictEqual(reuseResult.runId, versionResult.runId);
      assert.strictEqual(reuseResult.reused, true);
      assert.deepStrictEqual(reuseResult.turnover, {
        performed: false,
        reason: null,
        trigger: 'explicit-run-prepare',
        previousRun: null,
        successorRun: null,
        revokedContextCount: 0,
        supersededCleanupPreviewCount: 0,
        runtimeBefore: null,
        runtimeAfter: null
      });

      markRunCleaned(db, versionResult.runId);
      const runtimeBeforeDigest = db.prepare('SELECT runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const digestMismatch = insertRun(db, {
        runId: 'legacy-digest-mismatch',
        manifestVersion: DEMO_MANIFEST_VERSION,
        manifestDigest: '1'.repeat(64),
        status: 'completed'
      });
      const digestResult = db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate();
      assertTurnoverResult(digestResult, digestMismatch, runtimeBeforeDigest, 'service-run-prepare');

      markRunCleaned(db, digestResult.runId);
      const runtimeBeforeEvidence = db.prepare('SELECT runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const evidenceRun = insertRun(db, { runId: 'legacy-evidence-run', manifestDigest: '2'.repeat(64) });
      const evidence = attachGovernanceEvidence(db, evidenceRun, 'evidence');
      const evidenceResult = db.transaction(() => getOrCreateActiveDemoDatasetRun({
        actorUserId: 1,
        actorIp: '127.0.0.1',
        trigger: 'managed-artifact-download',
        artifactKey: '13-shift-definitions',
        db
      })).immediate();
      assertTurnoverResult(evidenceResult, evidenceRun, runtimeBeforeEvidence, 'managed-artifact-download');
      assert.strictEqual(evidenceResult.turnover.revokedContextCount, 1);
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(evidence.contextId).status, 'revoked');
      assert.strictEqual(db.prepare('SELECT run_id AS runId FROM demo_run_import_batches WHERE import_batch_id = ?').get(evidence.importBatchId).runId, evidenceRun.runId);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE run_id = ?').get(evidenceRun.runId).total, 2);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations WHERE run_id = ?').get(evidenceRun.runId).total, 1);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE run_id = ?').get(evidenceResult.runId).total, 0);

      markRunCleaned(db, evidenceResult.runId);
      const runtimeBeforeCleanup = db.prepare('SELECT runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const cleanupPendingRun = insertRun(db, {
        runId: 'legacy-cleanup-pending',
        manifestDigest: '3'.repeat(64),
        status: 'cleanup_pending'
      });
      const cleanupRunId = insertCleanupPreview(db, cleanupPendingRun.runId, 'pending');
      const cleanupResult = db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate();
      assertTurnoverResult(cleanupResult, cleanupPendingRun, runtimeBeforeCleanup, 'service-run-prepare');
      assert.strictEqual(cleanupResult.turnover.supersededCleanupPreviewCount, 1);
      assert.deepStrictEqual(db.prepare(`SELECT status, failure_reason AS failureReason,
        completed_at AS completedAt FROM demo_cleanup_runs WHERE cleanup_run_id = ?`).get(cleanupRunId), {
        status: 'superseded',
        failureReason: 'manifest_run_superseded',
        completedAt: db.prepare('SELECT completed_at AS completedAt FROM demo_cleanup_runs WHERE cleanup_run_id = ?').get(cleanupRunId).completedAt
      });
      assert(db.prepare('SELECT completed_at AS completedAt FROM demo_cleanup_runs WHERE cleanup_run_id = ?').get(cleanupRunId).completedAt);

      markRunCleaned(db, cleanupResult.runId);
      const cleaningRun = insertRun(db, {
        runId: 'legacy-cleaning-run',
        manifestVersion: DEMO_MANIFEST_VERSION,
        manifestDigest: getDemoParkManifestDigest(),
        status: 'cleaning'
      });
      const runtimeBeforeBlocked = db.prepare('SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const auditCountBeforeBlocked = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      const contextCountBeforeBlocked = db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total;
      const runCountBeforeBlocked = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      const cleaningProjection = readActiveDemoDatasetRunProjection({ db });
      assert.strictEqual(cleaningProjection.compatibility.state, 'cleanup-in-progress-blocked');
      assert.strictEqual(cleaningProjection.compatibility.code, 'DEMO_RUN_CLEANUP_IN_PROGRESS');
      assert.strictEqual(cleaningProjection.compatibility.manifestCompatible, true);
      assert.strictEqual(cleaningProjection.compatibility.turnoverEligible, false);
      assert.strictEqual(cleaningProjection.compatibility.writeEligible, false);
      assert.strictEqual(cleaningProjection.compatibility.retryable, true);
      assert.throws(
        () => requireDemoDatasetRun(db, cleaningRun.runId),
        (error) => error.code === 'DEMO_RUN_CLEANUP_IN_PROGRESS'
          && error.statusCode === 409
          && error.details.retryable === true
      );
      assert.throws(
        () => createDemoContext({
          userId: 1,
          runId: cleaningRun.runId,
          artifactKey: '13-shift-definitions',
          handlerKey: 'shift-definitions-import',
          artifactFileSha256: '4'.repeat(64),
          db
        }),
        (error) => error.code === 'DEMO_RUN_CLEANUP_IN_PROGRESS'
      );
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        (error) => error.code === 'DEMO_RUN_CLEANUP_IN_PROGRESS'
          && error.statusCode === 409
          && error.details.retryable === true
      );
      assert.deepStrictEqual(db.prepare('SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get(), runtimeBeforeBlocked);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total, auditCountBeforeBlocked);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total,
        contextCountBeforeBlocked);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
        runCountBeforeBlocked);
      assert.strictEqual(db.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?').get(cleaningRun.runId).status, 'cleaning');
      db.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
        .run('4'.repeat(64), cleaningRun.runId);
      const driftedCleaningProjection = readActiveDemoDatasetRunProjection({ db });
      assert.strictEqual(driftedCleaningProjection.compatibility.state, 'cleanup-in-progress-blocked');
      assert.strictEqual(driftedCleaningProjection.compatibility.manifestCompatible, false);
      assert.strictEqual(driftedCleaningProjection.compatibility.turnoverEligible, false);
      assert.strictEqual(driftedCleaningProjection.compatibility.writeEligible, false);
      assert.strictEqual(driftedCleaningProjection.compatibility.retryable, true);
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        (error) => error.code === 'DEMO_RUN_CLEANUP_IN_PROGRESS'
      );

      // 未知生命周期即使来自受损库也必须 fail-closed，不能被误判为无 active run 后创建新 run。
      markRunCleaned(db, cleaningRun.runId);
      const unsupportedRun = insertRun(db, {
        runId: 'legacy-unsupported-state-run',
        manifestDigest: '5'.repeat(64)
      });
      db.pragma('ignore_check_constraints = ON');
      db.prepare("UPDATE demo_dataset_runs SET status = 'future_state' WHERE run_id = ?")
        .run(unsupportedRun.runId);
      const unsupportedRuntimeBefore = db.prepare(`SELECT enabled,
        runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1`).get();
      const unsupportedAuditBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      const unsupportedRunCountBefore = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        (error) => error.code === 'DEMO_RUN_STATE_UNSUPPORTED'
          && error.statusCode === 409
          && error.details.retryable === false
      );
      assert.deepStrictEqual(db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
        revision FROM demo_runtime_settings WHERE id = 1`).get(), unsupportedRuntimeBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
        unsupportedAuditBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
        unsupportedRunCountBefore);
      db.prepare("UPDATE demo_dataset_runs SET status = 'active' WHERE run_id = ?").run(unsupportedRun.runId);
      db.pragma('ignore_check_constraints = OFF');

      markRunCleaned(db, unsupportedRun.runId);
      const rollbackRun = insertRun(db, {
        runId: 'legacy-rollback-run',
        manifestDigest: '5'.repeat(64),
        status: 'cleanup_pending'
      });
      const rollbackEvidence = attachGovernanceEvidence(db, rollbackRun, 'rollback');
      const rollbackCleanupRunId = insertCleanupPreview(db, rollbackRun.runId, 'rollback');
      const rollbackRuntimeBefore = db.prepare('SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get();
      const rollbackAuditBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      db.exec(`CREATE TRIGGER force_successor_insert_failure BEFORE INSERT ON demo_dataset_runs
        WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'forced_successor_insert_failure'); END;`);
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        /forced_successor_insert_failure/
      );
      db.exec('DROP TRIGGER force_successor_insert_failure');
      assert.strictEqual(db.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?').get(rollbackRun.runId).status, 'cleanup_pending');
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(rollbackEvidence.contextId).status, 'issued');
      assert.deepStrictEqual(db.prepare(`SELECT status, completed_at AS completedAt,
        failure_reason AS failureReason FROM demo_cleanup_runs WHERE cleanup_run_id = ?`)
        .get(rollbackCleanupRunId), {
        status: 'previewed',
        completedAt: null,
        failureReason: null
      });
      assert.deepStrictEqual(db.prepare('SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get(), rollbackRuntimeBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total, rollbackAuditBefore);

      // context 撤销失败发生在 cleanup preview 已更新之后，必须回滚旧 run、preview、runtime 和审计。
      markRunCleaned(db, rollbackRun.runId);
      const contextRollbackRun = insertRun(db, {
        runId: 'legacy-context-rollback-run',
        manifestDigest: '6'.repeat(64),
        status: 'cleanup_pending'
      });
      const contextRollbackEvidence = attachGovernanceEvidence(db, contextRollbackRun, 'context-rollback');
      const contextRollbackCleanupRunId = insertCleanupPreview(
        db,
        contextRollbackRun.runId,
        'context-rollback'
      );
      const contextRollbackRuntimeBefore = db.prepare(`SELECT enabled,
        runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1`).get();
      const contextRollbackAuditBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      const contextRollbackRunCountBefore = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      db.exec(`CREATE TRIGGER force_context_revoke_failure BEFORE UPDATE OF status ON demo_import_contexts
        WHEN OLD.context_id = '${contextRollbackEvidence.contextId}' AND NEW.status = 'revoked'
        BEGIN SELECT RAISE(ABORT, 'forced_context_revoke_failure'); END;`);
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        /forced_context_revoke_failure/
      );
      db.exec('DROP TRIGGER force_context_revoke_failure');
      assert.strictEqual(db.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?')
        .get(contextRollbackRun.runId).status, 'cleanup_pending');
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
        .get(contextRollbackEvidence.contextId).status, 'issued');
      assert.deepStrictEqual(db.prepare(`SELECT status, completed_at AS completedAt,
        failure_reason AS failureReason FROM demo_cleanup_runs WHERE cleanup_run_id = ?`)
        .get(contextRollbackCleanupRunId), {
        status: 'previewed',
        completedAt: null,
        failureReason: null
      });
      assert.deepStrictEqual(db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
        revision FROM demo_runtime_settings WHERE id = 1`).get(), contextRollbackRuntimeBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
        contextRollbackAuditBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
        contextRollbackRunCountBefore);

      // 最终 run 审计失败时，前序 context、cleanup、runtime、旧 run 和 successor 写入也必须整体回滚。
      markRunCleaned(db, contextRollbackRun.runId);
      const auditRollbackRun = insertRun(db, {
        runId: 'legacy-audit-rollback-run',
        manifestDigest: '7'.repeat(64),
        status: 'cleanup_pending'
      });
      const auditRollbackEvidence = attachGovernanceEvidence(db, auditRollbackRun, 'audit-rollback');
      const auditRollbackCleanupRunId = insertCleanupPreview(db, auditRollbackRun.runId, 'audit-rollback');
      const auditRollbackRuntimeBefore = db.prepare(`SELECT enabled,
        runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1`).get();
      const auditRollbackCountBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      const auditRollbackRunCountBefore = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      db.exec(`CREATE TRIGGER force_turnover_audit_failure BEFORE INSERT ON sys_operation_logs
        WHEN NEW.operation = 'system.demo.run.auto-supersede'
        BEGIN SELECT RAISE(ABORT, 'forced_turnover_audit_failure'); END;`);
      assert.throws(
        () => db.transaction(() => getOrCreateActiveDemoDatasetRun({ actorUserId: 1, db })).immediate(),
        /forced_turnover_audit_failure/
      );
      db.exec('DROP TRIGGER force_turnover_audit_failure');
      assert.strictEqual(db.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?')
        .get(auditRollbackRun.runId).status, 'cleanup_pending');
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
        .get(auditRollbackEvidence.contextId).status, 'issued');
      assert.deepStrictEqual(db.prepare(`SELECT status, completed_at AS completedAt,
        failure_reason AS failureReason FROM demo_cleanup_runs WHERE cleanup_run_id = ?`)
        .get(auditRollbackCleanupRunId), {
        status: 'previewed',
        completedAt: null,
        failureReason: null
      });
      assert.deepStrictEqual(db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
        revision FROM demo_runtime_settings WHERE id = 1`).get(), auditRollbackRuntimeBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
        auditRollbackCountBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
        auditRollbackRunCountBefore);

      // managed 下载在 successor 创建后签发 context；签发失败必须连同换代事务一起回滚。
      markRunCleaned(db, auditRollbackRun.runId);
      const issuanceRollbackRun = insertRun(db, {
        runId: 'legacy-issuance-rollback-run',
        manifestDigest: '8'.repeat(64),
        status: 'cleanup_pending'
      });
      const issuanceRollbackEvidence = attachGovernanceEvidence(db, issuanceRollbackRun, 'issuance-rollback');
      const issuanceRollbackCleanupRunId = insertCleanupPreview(
        db,
        issuanceRollbackRun.runId,
        'issuance-rollback'
      );
      const issuanceRollbackRuntimeBefore = db.prepare(`SELECT enabled,
        runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1`).get();
      const issuanceRollbackAuditBefore = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
      const issuanceRollbackRunCountBefore = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      const issuanceRollbackContextCountBefore = db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total;
      db.exec(`CREATE TRIGGER force_context_issuance_failure BEFORE INSERT ON demo_import_contexts
        BEGIN SELECT RAISE(ABORT, 'forced_context_issuance_failure'); END;`);
      assert.throws(
        () => db.transaction(() => {
          const successor = getOrCreateActiveDemoDatasetRun({
            actorUserId: 1,
            actorIp: '127.0.0.1',
            trigger: 'managed-artifact-download',
            artifactKey: '13-shift-definitions',
            db
          });
          return createDemoContext({
            userId: 1,
            runId: successor.runId,
            artifactKey: '13-shift-definitions',
            handlerKey: 'shift-definitions-import',
            artifactFileSha256: '8'.repeat(64),
            db
          });
        }).immediate(),
        /forced_context_issuance_failure/
      );
      db.exec('DROP TRIGGER force_context_issuance_failure');
      assert.strictEqual(db.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?')
        .get(issuanceRollbackRun.runId).status, 'cleanup_pending');
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
        .get(issuanceRollbackEvidence.contextId).status, 'issued');
      assert.deepStrictEqual(db.prepare(`SELECT status, completed_at AS completedAt,
        failure_reason AS failureReason FROM demo_cleanup_runs WHERE cleanup_run_id = ?`)
        .get(issuanceRollbackCleanupRunId), {
        status: 'previewed',
        completedAt: null,
        failureReason: null
      });
      assert.deepStrictEqual(db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
        revision FROM demo_runtime_settings WHERE id = 1`).get(), issuanceRollbackRuntimeBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
        issuanceRollbackAuditBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
        issuanceRollbackRunCountBefore);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total,
        issuanceRollbackContextCountBefore);

      markRunCleaned(db, issuanceRollbackRun.runId);
      const createAuditBefore = db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.run.create'").get().total;
      const created = db.transaction(() => getOrCreateActiveDemoDatasetRun({
        actorUserId: 1,
        actorIp: '127.0.0.1',
        trigger: 'explicit-run-prepare',
        db
      })).immediate();
      assert.strictEqual(created.reused, false);
      assert.strictEqual(created.turnover.performed, false);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.run.create'").get().total, createAuditBefore + 1);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.manifest-supersede'").get().total, 4);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.run.auto-supersede'").get().total, 4);

      const concurrentManifestDigest = '6'.repeat(64);
      db.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
        .run(concurrentManifestDigest, created.runId);
      concurrentPredecessor = {
        runId: created.runId,
        status: 'active',
        manifestVersion: created.manifestVersion,
        manifestDigest: concurrentManifestDigest
      };
      runtimeBeforeConcurrent = db.prepare(`SELECT runtime_epoch AS runtimeEpoch, revision
        FROM demo_runtime_settings WHERE id = 1`).get();
      turnoverAuditBeforeConcurrent = db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
        WHERE operation = 'system.demo.run.auto-supersede'`).get().total;
    } finally {
      db.close();
    }

    const concurrentResults = await Promise.all([
      supersedeRunInWorker(1),
      supersedeRunInWorker(1)
    ]);
    assert(concurrentResults.every((entry) => entry.ok), JSON.stringify(concurrentResults));
    const concurrentRunIds = new Set(concurrentResults.map((entry) => entry.result.runId));
    assert.strictEqual(concurrentRunIds.size, 1, '并发换代必须收敛到唯一 successor。');
    assert.strictEqual(concurrentResults.filter((entry) => entry.result.turnover.performed).length, 1,
      '并发换代只能由一个请求执行 successor 写入。');
    assert.strictEqual(concurrentResults.filter((entry) => entry.result.reused).length, 1,
      '并发中的另一请求必须幂等复用同一 successor。');
    assert(!JSON.stringify(concurrentResults).includes('UNIQUE constraint failed'),
      '并发换代不得向外泄漏 SQLite UNIQUE 原始错误。');
    const concurrentSuccessorRunId = [...concurrentRunIds][0];
    const concurrentDb = openDatabase();
    try {
      assert.deepStrictEqual(concurrentDb.prepare(`SELECT status, successor_run_id AS successorRunId
        FROM demo_dataset_runs WHERE run_id = ?`).get(concurrentPredecessor.runId), {
        status: 'superseded',
        successorRunId: concurrentSuccessorRunId
      });
      assert.strictEqual(concurrentDb.prepare(`SELECT COUNT(*) AS total FROM demo_dataset_runs
        WHERE dataset_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')`)
        .get(DEMO_DATASET_ID).total, 1);
      assert.deepStrictEqual(concurrentDb.prepare(`SELECT runtime_epoch AS runtimeEpoch, revision
        FROM demo_runtime_settings WHERE id = 1`).get(), {
        runtimeEpoch: runtimeBeforeConcurrent.runtimeEpoch + 1,
        revision: runtimeBeforeConcurrent.revision + 1
      });
      assert.strictEqual(concurrentDb.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
        WHERE operation = 'system.demo.run.auto-supersede'`).get().total,
      turnoverAuditBeforeConcurrent + 1);
    } finally {
      concurrentDb.close();
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
