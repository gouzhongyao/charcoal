'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 本测试只使用隔离临时 SQLite，不读取或删除正式 data、uploads 与 backups。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-cleanup-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-cleanup.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { CLEANUP_CONFIRMATION_TEXT, toggleDemoRuntime } = require('../services/demoRuntimeService');
const { _test: demoCleanupTest } = require('../services/demoCleanupService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest
} = require('../services/demoOwnershipService');

/** 发起隔离 HTTP JSON 请求。 */
function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = raw ? {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(raw)
    } : {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

/** 为静态 handler 支持的 prediction_config 写入测试 ownership。 */
function registerPredictionConfig(db, runId, configId) {
  const row = db.prepare('SELECT * FROM prediction_configs WHERE id = ?').get(configId);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
      identity_digest, snapshot_digest, registered_by)
    VALUES (?, '12-prediction-configs', 'prediction_config', ?, 'imported', ?, ?, 1)`).run(
    runId,
    String(configId),
    calculateDemoEntityIdentityDigest('prediction_config', String(configId)),
    calculateDemoEntitySnapshotDigest('prediction_config', String(configId), row)
  );
}

(async () => {
  let server;
  try {
    const cleanupDtoBase = {
      cleanupRunId: 'demo-cleanup-00000000-0000-4000-8000-000000000000',
      runId: 'demo-run-test',
      clientRequestId: 'cleanup-dto-test',
      previewDigest: 'a'.repeat(64),
      previewExpiresAt: '2026-08-27T12:00:00.000Z',
      runtimeRevision: 1,
      registryWatermark: 'b'.repeat(64),
      candidateCount: 1,
      blockerCount: 0,
      summaryJson: JSON.stringify({ blockers: [] }),
      confirmationText: CLEANUP_CONFIRMATION_TEXT,
      requestedBy: 1,
      status: 'previewed',
      deletedCount: 0,
      alreadyMissingCount: 0,
      createdAt: '2026-08-27T11:50:00.000Z',
      startedAt: null,
      completedAt: null,
      failureReason: null
    };
    assert.deepStrictEqual(
      { blocked: demoCleanupTest.mapCleanupRunRow(cleanupDtoBase).blocked, executable: demoCleanupTest.mapCleanupRunRow(cleanupDtoBase).executable },
      { blocked: false, executable: true },
      '只有 previewed 且 blockerCount=0 的 DTO 可以标记 executable。'
    );
    assert.deepStrictEqual(
      {
        blocked: demoCleanupTest.mapCleanupRunRow({ ...cleanupDtoBase, blockerCount: 1 }).blocked,
        executable: demoCleanupTest.mapCleanupRunRow({ ...cleanupDtoBase, blockerCount: 1 }).executable
      },
      { blocked: true, executable: false }
    );
    assert.deepStrictEqual(
      {
        blocked: demoCleanupTest.mapCleanupRunRow({ ...cleanupDtoBase, status: 'succeeded' }).blocked,
        executable: demoCleanupTest.mapCleanupRunRow({ ...cleanupDtoBase, status: 'succeeded' }).executable
      },
      { blocked: false, executable: false },
      '已完成幂等结果不得继续标记 executable。'
    );

    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });
    const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });

    const setupDb = openDatabase();
    let ownedConfigId;
    let otherConfigId;
    try {
      const energyTypeId = setupDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const insertConfig = setupDb.prepare(`INSERT INTO prediction_configs
        (name, energy_type_id, train_start_month, train_end_month,
          predict_start_month, predict_end_month, algorithm, status)
        VALUES (?, ?, '2026-01', '2026-03', '2026-04', '2026-05', 'moving_average', 'draft')`);
      ownedConfigId = insertConfig.run('当前 run 演示预测配置', energyTypeId).lastInsertRowid;
      otherConfigId = insertConfig.run('其他 run 正式保留配置', energyTypeId).lastInsertRowid;
      const now = new Date().toISOString();
      setupDb.prepare(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_at)
        VALUES ('other-dataset-run', 'other-dataset', 'v1', ?, 'failed', ?)`).run('f'.repeat(64), now);
      registerPredictionConfig(setupDb, run.runId, ownedConfigId);
      registerPredictionConfig(setupDb, 'other-dataset-run', otherConfigId);
      setupDb.prepare(`INSERT INTO demo_import_contexts
        (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
          artifact_key, handler_key, artifact_file_sha256, issued_to_user_id,
          runtime_epoch, status, issued_at, expires_at)
        VALUES ('cleanup-context', ?, ?, ?, ?, ?, '12-prediction-configs',
          'prediction-configs-import', ?, 1, ?, 'issued', ?, ?)`).run(
        'a'.repeat(64),
        run.runId,
        run.datasetId,
        run.manifestVersion,
        run.manifestDigest,
        'b'.repeat(64),
        run.runtimeEpoch,
        now,
        new Date(Date.now() + 600000).toISOString()
      );
      setupDb.prepare(`INSERT INTO demo_data_registry
        (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
          identity_digest, snapshot_digest, registered_by)
        VALUES (?, '01-organization-root', 'organization_unit', '999999',
          'imported', ?, ?, 1)`).run(run.runId, 'c'.repeat(64), 'd'.repeat(64));
    } finally {
      setupDb.close();
    }

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const login = await request(server, 'POST', '/api/login', {
      username: 'admin',
      password: 'AdminPassword123!'
    });
    const token = login.body.data.token;

    const governanceStatus = await request(server, 'GET', '/api/system/demo-data/status', undefined, token);
    assert.strictEqual(governanceStatus.status, 200);
    assert.strictEqual(governanceStatus.body.data.capabilities.ownershipSummary, true);
    assert.strictEqual(governanceStatus.body.data.capabilities.cleanupPreview, true);
    assert.strictEqual(governanceStatus.body.data.capabilities.cleanupExecute, false);
    assert.strictEqual(governanceStatus.body.data.allowedActions.previewCleanup, true);
    assert.strictEqual(governanceStatus.body.data.allowedActions.executeCleanup, true);
    assert.strictEqual(governanceStatus.body.data.activeRun.runId, run.runId);
    assert.strictEqual(governanceStatus.body.data.activeRunCompatibility.state, 'active');
    assert.strictEqual(governanceStatus.body.data.activeRunCompatibility.writeEligible, true);

    const summary = await request(server, 'GET', `/api/system/demo-data/runs/${run.runId}/ownership-summary`, undefined, token);
    assert.strictEqual(summary.status, 200);
    assert.strictEqual(summary.body.data.registrationConnected, false);
    assert.strictEqual(summary.body.data.activeCount, 2);
    assert.strictEqual(summary.body.data.cleanupBlockerCount, 2);
    assert(summary.body.data.blockers.some((blocker) => blocker.code === 'OWNERSHIP_REGISTRATION_NOT_CONNECTED'));
    assert(summary.body.data.blockers.some((blocker) => blocker.code === 'CLEANUP_HANDLER_NOT_WHITELISTED'));

    const blockedPreview = await request(server, 'POST', '/api/system/demo-data/cleanup/preview', {
      runId: run.runId,
      clientRequestId: 'cleanup-blocked-request'
    }, token);
    assert.strictEqual(blockedPreview.status, 200);
    assert.strictEqual(blockedPreview.body.data.status, 'blocked');
    assert.strictEqual(blockedPreview.body.data.blocked, true);
    assert.strictEqual(blockedPreview.body.data.executable, false);
    assert.strictEqual(blockedPreview.body.data.summary.registrationConnected, false);
    assert(blockedPreview.body.data.summary.blockers.some(
      (blocker) => blocker.code === 'OWNERSHIP_REGISTRATION_NOT_CONNECTED'
    ));

    const resetDb = openDatabase();
    try {
      resetDb.prepare('DELETE FROM demo_data_registry WHERE run_id = ?').run(run.runId);
    } finally {
      resetDb.close();
    }

    const emptySummary = await request(server, 'GET', `/api/system/demo-data/runs/${run.runId}/ownership-summary`, undefined, token);
    assert.strictEqual(emptySummary.status, 200);
    assert.strictEqual(emptySummary.body.data.activeCount, 0);
    assert.strictEqual(emptySummary.body.data.cleanupCandidateCount, 0);
    assert.strictEqual(emptySummary.body.data.cleanupBlockerCount, 1);
    assert.strictEqual(emptySummary.body.data.blockers[0].code, 'OWNERSHIP_REGISTRATION_NOT_CONNECTED');

    const previewBody = {
      runId: run.runId,
      clientRequestId: 'cleanup-empty-registry-request'
    };
    const preview = await request(server, 'POST', '/api/system/demo-data/cleanup/preview', previewBody, token);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.data.status, 'blocked');
    assert.strictEqual(preview.body.data.candidateCount, 0);
    assert.strictEqual(preview.body.data.blockerCount, 1);
    assert.strictEqual(preview.body.data.summary.blockers[0].code, 'OWNERSHIP_REGISTRATION_NOT_CONNECTED');
    const repeatedPreview = await request(server, 'POST', '/api/system/demo-data/cleanup/preview', previewBody, token);
    assert.strictEqual(repeatedPreview.status, 200);
    assert.strictEqual(repeatedPreview.body.data.cleanupRunId, preview.body.data.cleanupRunId);
    assert.strictEqual(repeatedPreview.body.data.idempotent, true);
    assert.strictEqual(repeatedPreview.body.data.blocked, true);
    assert.strictEqual(repeatedPreview.body.data.executable, false);

    const executeBody = {
      cleanupRunId: preview.body.data.cleanupRunId,
      clientRequestId: previewBody.clientRequestId,
      previewDigest: preview.body.data.previewDigest,
      confirmationText: CLEANUP_CONFIRMATION_TEXT
    };
    const executed = await request(server, 'POST', '/api/system/demo-data/cleanup/execute', executeBody, token);
    assert.strictEqual(executed.status, 409);
    assert.strictEqual(executed.body.error.code, 'DEMO_CLEANUP_BLOCKED');
    assert.strictEqual(executed.body.error.details.blockers[0].code, 'OWNERSHIP_REGISTRATION_NOT_CONNECTED');

    const status = await request(server, 'GET', `/api/system/demo-data/cleanup-runs/${preview.body.data.cleanupRunId}`, undefined, token);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.data.status, 'blocked');
    assert.strictEqual(status.body.data.blocked, true);
    assert.strictEqual(status.body.data.executable, false);

    const verifyDb = openDatabase();
    try {
      assert.strictEqual(verifyDb.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?').get(ownedConfigId).total, 1, '空 registry 预演不得删除业务数据。');
      assert.strictEqual(verifyDb.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE id = ?').get(otherConfigId).total, 1, '其他 run 实体不得删除。');
      assert.strictEqual(verifyDb.prepare("SELECT status FROM demo_import_contexts WHERE context_id = 'cleanup-context'").get().status, 'issued');
      assert.strictEqual(verifyDb.prepare('SELECT status FROM demo_dataset_runs WHERE run_id = ?').get(run.runId).status, 'active');
      assert.strictEqual(verifyDb.prepare('SELECT enabled FROM demo_runtime_settings WHERE id = 1').get().enabled, 1);
    } finally {
      verifyDb.close();
    }

    console.log('demo cleanup API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
