const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 本测试只使用隔离临时目录，覆盖恢复切换故障，不触碰项目真实数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-restore-safety-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'restore-safety.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const {
  getDatabaseAdmissionState,
  initDatabase,
  openDatabase,
  poisonDatabaseAdmission
} = require('../db/database');
const { createBackup, restoreBackup } = require('../services/backupService');
const { getDemoRuntimeStatus, toggleDemoRuntime } = require('../services/demoRuntimeService');
const { login } = require('../services/authService');
const { app } = require('../index');

const RESTORE_MARKER_SCHEMA = 'charcoal-database-restore-marker';
const RESTORE_MARKER_VERSION = 1;
const RESTORE_MARKER_PHASE = 'prepared';
const VALID_OPERATION_ID = '12345678-1234-4123-8123-123456789abc';

/** 通过真实 HTTP 链路验证数据库不可用错误不会被认证中间件改写。 */
function request(server, method, requestPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          body: JSON.parse(rawBody)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 计算隔离正式库文件摘要。 */
function databaseSha256() {
  return crypto.createHash('sha256').update(fs.readFileSync(process.env.SQLITE_PATH)).digest('hex');
}

/** 构造只拦截恢复切换操作的文件系统代理。 */
function createFileOperations(handlers = {}) {
  return {
    renameSync(source, target) {
      if (handlers.renameSync) return handlers.renameSync(source, target);
      return fs.renameSync(source, target);
    },
    rmSync(target, options) {
      if (handlers.rmSync) return handlers.rmSync(target, options);
      return fs.rmSync(target, options);
    },
    statSync(target) {
      if (handlers.statSync) return handlers.statSync(target);
      return fs.statSync(target);
    }
  };
}

/** 使用独立进程复现启动 marker，避免 poison latch 污染当前测试进程。 */
function runMarkerReconcileProbe(caseName, marker, options = {}) {
  const caseDir = path.join(tmpDir, `marker-${caseName}`);
  const dataDir = path.join(caseDir, 'data');
  const officialPath = path.join(dataDir, 'official.sqlite');
  const markerPath = path.join(dataDir, '.restore-in-progress.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (options.officialMissing !== true) {
    fs.copyFileSync(process.env.SQLITE_PATH, officialPath);
  }
  const beforeSha = fs.existsSync(officialPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(officialPath)).digest('hex') : null;
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const beforeFiles = fs.readdirSync(dataDir).sort();
  const probeScript = `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.SQLITE_PATH = ${JSON.stringify(officialPath)};
    process.env.UPLOADS_DIR = ${JSON.stringify(path.join(caseDir, 'uploads'))};
    process.env.BACKUPS_DIR = ${JSON.stringify(path.join(caseDir, 'backups'))};
    process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
    const crypto = require('crypto');
    const fs = require('fs');
    const db = require(${JSON.stringify(path.join(__dirname, '../db/database.js'))});
    let rejected = false;
    try { db.initDatabase(); } catch (_error) { rejected = true; }
    let openRejected = false;
    try { db.openDatabase(); } catch (_error) { openRejected = true; }
    process.stdout.write(JSON.stringify({
      rejected,
      openRejected,
      state: db.getDatabaseAdmissionState(),
      sha: fs.existsSync(process.env.SQLITE_PATH)
        ? crypto.createHash('sha256').update(fs.readFileSync(process.env.SQLITE_PATH)).digest('hex') : null,
      files: fs.readdirSync(${JSON.stringify(dataDir)}).sort()
    }));`;
  const result = JSON.parse(childProcess.execFileSync(process.execPath, ['-e', probeScript], { encoding: 'utf8' }));
  assert.strictEqual(result.rejected, true, `${caseName} 必须拒绝初始化。`);
  assert.strictEqual(result.openRejected, true, `${caseName} 必须 poison 后拒绝打开正式库。`);
  assert.deepStrictEqual(result.state, { blocked: true, poisoned: true, activeConnections: 0 });
  assert.strictEqual(result.sha, beforeSha, `${caseName} 不得改动正式库摘要。`);
  assert.deepStrictEqual(result.files, beforeFiles, `${caseName} 不得删除或 rename 任何文件。`);
}

(async () => {
  let server;
  try {
    initDatabase();
    const initialJournalDb = openDatabase();
    try {
      assert.strictEqual(initialJournalDb.pragma('journal_mode', { simple: true }), 'wal', '新库必须显式使用 WAL。');
    } finally {
      initialJournalDb.close();
    }
    const adminToken = login({
      username: 'admin',
      password: process.env.CHARCOAL_ADMIN_PASSWORD
    }).token;
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const backup = await createBackup({ reason: 'manual' });
    const officialPath = path.resolve(process.env.SQLITE_PATH);
    const markerPath = path.join(path.dirname(officialPath), '.restore-in-progress.json');

    const markerBase = {
      schema: RESTORE_MARKER_SCHEMA,
      version: RESTORE_MARKER_VERSION,
      phase: RESTORE_MARKER_PHASE,
      operationId: VALID_OPERATION_ID,
      candidate: `.restore-candidate-${VALID_OPERATION_ID}.sqlite`,
      old: `.restore-old-${VALID_OPERATION_ID}.sqlite`
    };
    runMarkerReconcileProbe('old-official', { ...markerBase, old: path.basename(officialPath) });
    runMarkerReconcileProbe('candidate-official', { ...markerBase, candidate: path.basename(officialPath) });
    runMarkerReconcileProbe('same-path', { ...markerBase, old: markerBase.candidate });
    runMarkerReconcileProbe('path-traversal', { ...markerBase, old: `../${markerBase.old}` });
    runMarkerReconcileProbe('absolute-path', { ...markerBase, candidate: path.join(path.dirname(officialPath), markerBase.candidate) });
    runMarkerReconcileProbe('marker-name', { ...markerBase, old: '.restore-in-progress.json' });
    runMarkerReconcileProbe('directory-name', { ...markerBase, candidate: '.' });
    runMarkerReconcileProbe('unknown-phase', { ...markerBase, phase: 'switched' });
    runMarkerReconcileProbe('unknown-version', { ...markerBase, version: 2 });
    runMarkerReconcileProbe('unknown-schema', { ...markerBase, schema: 'unknown' });
    runMarkerReconcileProbe('missing-operation-id', { ...markerBase, operationId: undefined });
    runMarkerReconcileProbe('invalid-operation-id', { ...markerBase, operationId: 'not-a-uuid' });
    runMarkerReconcileProbe('mismatched-operation-id', { ...markerBase, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    runMarkerReconcileProbe('missing-official-invalid-marker', { ...markerBase, old: path.basename(officialPath) }, { officialMissing: true });

    let lateWriteRejected = false;
    let barrierHttpStatus = null;
    const lateWriterRestore = await restoreBackup(backup.backupName, {}, {
      async onAdmissionBlocked(...hookArguments) {
        assert.strictEqual(hookArguments.length, 0, '测试 hook 不得获得 admission permit。');
        barrierHttpStatus = await request(server, 'GET', '/api/system/demo-data/status', adminToken);
        assert.strictEqual(barrierHttpStatus.status, 423, 'restore barrier 期间有效 token 不得被误判为 401。');
        assert.strictEqual(barrierHttpStatus.body.error.code, 'DATABASE_ADMISSION_BLOCKED');
        assert.deepStrictEqual(barrierHttpStatus.body.error.details, { retryable: true });
        assert(!JSON.stringify(barrierHttpStatus.body).includes(tmpDir), 'restore barrier 响应不得泄露本地路径。');
        assert(!JSON.stringify(barrierHttpStatus.body).toLowerCase().includes('permit'), 'restore barrier 响应不得泄露内部 permit。');
        try {
          const lateDb = openDatabase();
          try {
            lateDb.prepare("INSERT INTO app_meta (key, value) VALUES ('late-write-after-check', 'must-not-commit')").run();
          } finally {
            lateDb.close();
          }
        } catch (error) {
          lateWriteRejected = /正在切换/.test(String(error.message));
        }
      }
    });
    assert.strictEqual(lateWriteRejected, true, '已通过维护态检查但尚未开库的在途写请求必须被 admission barrier 拒绝。');
    assert(barrierHttpStatus, '恢复 barrier 测试必须完成真实 HTTP 请求。');
    const statusAfterRestore = await request(server, 'GET', '/api/system/demo-data/status', adminToken);
    assert.strictEqual(statusAfterRestore.status, 200, '恢复完成后同一有效 token 必须继续可用。');
    const lateWriteResultDb = openDatabase();
    try {
      assert.strictEqual(lateWriteResultDb.prepare("SELECT COUNT(*) AS total FROM app_meta WHERE key = 'late-write-after-check'").get().total, 0,
        '恢复成功后不得出现先返回成功再被切换丢失的写入。');
    } finally {
      lateWriteResultDb.close();
    }
    assert(lateWriterRestore.preRestoreBackup.backupName, 'barrier 后应正常创建 pre-restore 备份。');

    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      onAdmissionBlocked() {
        assert.throws(() => openDatabase({ admissionPermit: {} }), /正在切换/, '伪造 permit 不得绕过 barrier。');
        assert.throws(() => openDatabase({ allowBlocked: true }), /正在切换/, '旧 allowBlocked 不得绕过 barrier。');
        throw new Error('injected admission hook failure');
      }
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      return true;
    });
    assert.strictEqual(getDatabaseAdmissionState().blocked, false, 'barrier 后 hook 异常必须安全解锁。');
    const postHookFailureDb = openDatabase();
    postHookFailureDb.close();

    const delayedWriteDb = openDatabase();
    delayedWriteDb.exec('BEGIN IMMEDIATE');
    delayedWriteDb.prepare("INSERT INTO app_meta (key, value) VALUES ('drain-before-pre-restore', 'committed-before-snapshot')").run();
    let delayedCommitCompleted = false;
    let preRestoreObservedAfterCommit = false;
    const delayedCommitTimer = setTimeout(() => {
      try {
        delayedWriteDb.exec('COMMIT');
        delayedCommitCompleted = true;
      } finally {
        delayedWriteDb.close();
      }
    }, 60);
    let delayedWriterRestore;
    let preRestoreCallbackCount = 0;
    try {
      delayedWriterRestore = await restoreBackup(backup.backupName, {}, {
        drainTimeoutMs: 500,
        async onPreRestoreBackupCreated(preRestoreBackup) {
          preRestoreCallbackCount += 1;
          preRestoreObservedAfterCommit = delayedCommitCompleted;
          const snapshotDb = require('better-sqlite3')(preRestoreBackup.path, { readonly: true });
          try {
            assert.strictEqual(snapshotDb.prepare("SELECT value FROM app_meta WHERE key = 'drain-before-pre-restore'").get().value,
              'committed-before-snapshot', 'pre-restore 必须包含 barrier 前已打开连接的最终提交。');
          } finally {
            snapshotDb.close();
          }
        }
      });
    } finally {
      clearTimeout(delayedCommitTimer);
      try {
        delayedWriteDb.close();
      } catch (_error) {
        // 定时提交已关闭连接时重复 close 无副作用。
      }
    }
    assert.strictEqual(preRestoreObservedAfterCommit, true, 'restore 必须等待既有连接提交并关闭后才创建 pre-restore。');
    assert.strictEqual(preRestoreCallbackCount, 1, '每次恢复只应在单一 barrier 下创建一次 pre-restore。');
    assert(delayedWriterRestore.preRestoreBackup.backupName);
    const restoredTargetDb = openDatabase();
    try {
      assert.strictEqual(restoredTargetDb.prepare("SELECT COUNT(*) AS total FROM app_meta WHERE key = 'drain-before-pre-restore'").get().total, 0,
        '恢复目标备份语义保持不变，barrier 前提交仅保证进入 pre-restore 快照。');
    } finally {
      restoredTargetDb.close();
    }

    const initialLiveRuntime = getDemoRuntimeStatus();
    let candidateJournalMode = null;
    let candidateWindowToggleRejected = false;
    const raceRestore = await restoreBackup(backup.backupName, {}, {
      async onCandidatePrepared(candidate) {
        candidateJournalMode = candidate.db.pragma('journal_mode', { simple: true });
        try {
          toggleDemoRuntime({ enabled: true, actorUserId: 1 });
        } catch (error) {
          candidateWindowToggleRejected = /正在切换/.test(String(error.message));
        }
      }
    });
    assert.strictEqual(candidateWindowToggleRejected, true, '候选准备窗口普通 toggle 必须被持续 barrier 拒绝。');
    assert(
      raceRestore.demoRuntimeSafetyReset.runtimeEpoch > initialLiveRuntime.runtimeEpoch,
      '恢复 epoch 必须基于 barrier 后冻结的 live 值递增。'
    );
    assert(
      raceRestore.demoRuntimeSafetyReset.revision > initialLiveRuntime.revision,
      '恢复 revision 必须基于 barrier 后冻结的 live 值递增。'
    );
    assert.strictEqual(raceRestore.demoRuntimeSafetyReset.enabled, false);
    assert.strictEqual(candidateJournalMode, 'wal', '恢复候选完成初始化后必须为 WAL。');
    const restoredJournalDb = openDatabase();
    try {
      assert.strictEqual(restoredJournalDb.pragma('journal_mode', { simple: true }), 'wal', '切换后的正式库必须保持 WAL。');
    } finally {
      restoredJournalDb.close();
    }

    const canonicalBackup = await createBackup({ reason: 'manual' });
    const weakActorRestore = await restoreBackup(canonicalBackup.backupName, {
      userId: true,
      username: 'admin',
      displayName: '弱类型 actor 不得归属',
      ip: '127.0.0.1'
    });
    assert.strictEqual(weakActorRestore.demoRuntimeSafetyReset.updatedBy, null, '恢复 actor 布尔值不得归属 user 1。');
    const weakActorAuditDb = openDatabase();
    try {
      for (const operation of ['system.demo.runtime.restore-safety-reset', 'system.backup.restore']) {
        const audit = weakActorAuditDb.prepare(`SELECT user_id AS userId, detail_json AS detailJson
          FROM sys_operation_logs WHERE operation = ? ORDER BY id DESC LIMIT 1`).get(operation);
        const detail = JSON.parse(audit.detailJson);
        assert.strictEqual(audit.userId, null);
        assert.strictEqual(detail.requestActorSnapshot.userId, null);
        assert.strictEqual(detail.actorResolvedInRestoredDatabase, false);
      }
    } finally {
      weakActorAuditDb.close();
    }

    const invalidBackupName = 'valid-name-invalid-content.sqlite';
    const invalidBackupPath = path.join(process.env.BACKUPS_DIR, invalidBackupName);
    fs.writeFileSync(invalidBackupPath, 'not a sqlite database');
    await assert.rejects(() => restoreBackup(invalidBackupName), (error) => {
      assert.strictEqual(error.code, 'INVALID_BACKUP_FILE');
      assert.strictEqual(error.statusCode, 400);
      assert.deepStrictEqual(error.details, { code: 'BACKUP_SQLITE_OPEN_OR_READ_FAILED' });
      assert(!JSON.stringify(error).includes(tmpDir));
      assert(!JSON.stringify(error).includes('file is not a database'));
      assert(!JSON.stringify(error).includes('stack'));
      return true;
    });
    fs.rmSync(invalidBackupPath, { force: true });

    const invalidRuntimeDb = openDatabase();
    try {
      invalidRuntimeDb.exec(`DROP TABLE demo_runtime_settings;
        CREATE TABLE demo_runtime_settings (
          id INTEGER PRIMARY KEY,
          enabled TEXT,
          runtime_epoch TEXT,
          revision TEXT,
          updated_by TEXT,
          updated_at TEXT,
          change_reason TEXT
        );
        INSERT INTO demo_runtime_settings VALUES
          (1, '1', '9', '9', NULL, '2026-08-13T00:00:00.000Z', 'invalid-official-runtime');`);
      invalidRuntimeDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      invalidRuntimeDb.close();
    }
    const invalidRuntimeOfficialSha = databaseSha256();
    await assert.rejects(() => restoreBackup(canonicalBackup.backupName), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.phase, 'candidate_prepare');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), invalidRuntimeOfficialSha, '正式 runtime 非 canonical 时恢复必须拒绝且 official 不变。');
    fs.copyFileSync(canonicalBackup.path, process.env.SQLITE_PATH);
    initDatabase();

    const beforeCandidateCheckpointSha = databaseSha256();
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      checkpointCandidate() {
        return [{ busy: 0, log: 5, checkpointed: 3 }];
      }
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.phase, 'candidate_prepare');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert.strictEqual(error.details.code, 'RESTORE_CANDIDATE_REJECTED');
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), beforeCandidateCheckpointSha, '候选 checkpoint 未完整写回不得改动正式库。');
    assert.strictEqual(getDatabaseAdmissionState().blocked, false);

    const beforeStatFailureSha = databaseSha256();
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      fileOperations: createFileOperations({
        statSync() {
          const error = new Error(`EPERM stat ${tmpDir}`);
          error.code = 'EPERM';
          throw error;
        }
      })
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.deepStrictEqual(Object.keys(error.details).sort(), [
        'backupName', 'phase', 'rollbackStatus', 'retryable', 'code'
      ].sort());
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert(!JSON.stringify(error.details).includes('EPERM'));
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), beforeStatFailureSha, 'pre-restore stat 失败不得改动 official。');

    const beforeCleanupFailureSha = databaseSha256();
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      checkpointCandidate() {
        throw new Error(`primary candidate failure ${tmpDir}`);
      },
      fileOperations: createFileOperations({
        rmSync(target, options) {
          if (String(target).includes('.restore-candidate-')) {
            const error = new Error(`EPERM rm ${target}`);
            error.code = 'EPERM';
            throw error;
          }
          return fs.rmSync(target, options);
        }
      })
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.code, 'RESTORE_CANDIDATE_REJECTED');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert(!JSON.stringify(error.details).includes('EPERM'));
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), beforeCleanupFailureSha, '候选清理次生失败不得改动 official。');

    const beforeRollbackSha = databaseSha256();
    let rollbackRenameCount = 0;
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      fileOperations: createFileOperations({
        renameSync(source, target) {
          const resolvedSource = path.resolve(source);
          const resolvedTarget = path.resolve(target);
          if (resolvedTarget === officialPath && resolvedSource.includes('.restore-candidate-')) {
            throw new Error('injected candidate rename failure');
          }
          rollbackRenameCount += resolvedTarget === officialPath && resolvedSource.includes('.restore-old-') ? 1 : 0;
          return fs.renameSync(source, target);
        }
      })
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.rollbackStatus, 'restored');
      assert.strictEqual(error.details.retryable, true);
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(rollbackRenameCount, 1, '第二次 rename 失败后必须执行 old staging 回滚。');
    assert.strictEqual(databaseSha256(), beforeRollbackSha, '安全回滚后正式库文件必须保持不变。');
    assert.deepStrictEqual(getDatabaseAdmissionState(), {
      blocked: false,
      poisoned: false,
      activeConnections: 0
    });

    const heldConnection = openDatabase();
    const beforeDrainTimeoutSha = databaseSha256();
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      drainTimeoutMs: 40
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.phase, 'candidate_prepare');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), beforeDrainTimeoutSha, 'drain 超时不得改动正式库。');
    assert.strictEqual(getDatabaseAdmissionState().blocked, false, 'drain 超时必须解除 admission barrier。');
    heldConnection.close();

    const officialCheckpointBeforeSha = databaseSha256();
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      checkpointOfficial() {
        return [{ busy: 0, log: 9, checkpointed: 4 }];
      }
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.phase, 'candidate_prepare');
      assert.strictEqual(error.details.rollbackStatus, 'official_unchanged');
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(databaseSha256(), officialCheckpointBeforeSha, '正式库 checkpoint frame 未完整写回不得进入文件切换。');
    assert.strictEqual(getDatabaseAdmissionState().blocked, false);

    const cleanupResult = await restoreBackup(backup.backupName, {}, {
      fileOperations: createFileOperations({
        rmSync(target, options) {
          if (path.resolve(target) === path.resolve(markerPath)) {
            throw new Error('injected marker cleanup failure');
          }
          return fs.rmSync(target, options);
        }
      })
    });
    assert.deepStrictEqual(cleanupResult.cleanupWarnings, ['RESTORE_SWITCH_CLEANUP_PENDING']);
    const { toPublicRestoreResult } = require('../routes/backups');
    assert.deepStrictEqual(
      toPublicRestoreResult(cleanupResult).cleanupWarnings,
      ['RESTORE_SWITCH_CLEANUP_PENDING'],
      '恢复成功但残留待清理时必须向客户端投影稳定警告。'
    );
    assert(fs.existsSync(markerPath), 'post-switch 清理失败必须保留 durable marker。');
    assert.strictEqual(getDatabaseAdmissionState().blocked, false, 'post-switch 清理待处理不得永久阻塞。');
    initDatabase();
    assert(!fs.existsSync(markerPath), '下次初始化必须幂等清理 durable marker。');
    initDatabase();

    let candidateFailureInjected = false;
    await assert.rejects(() => restoreBackup(backup.backupName, {}, {
      fileOperations: createFileOperations({
        renameSync(source, target) {
          const resolvedSource = path.resolve(source);
          const resolvedTarget = path.resolve(target);
          if (resolvedTarget === officialPath && resolvedSource.includes('.restore-candidate-')) {
            candidateFailureInjected = true;
            throw new Error('injected candidate rename failure');
          }
          if (resolvedTarget === officialPath && resolvedSource.includes('.restore-old-')) {
            throw new Error('injected rollback rename failure');
          }
          return fs.renameSync(source, target);
        }
      })
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.strictEqual(error.details.rollbackStatus, 'failed_poisoned');
      assert.strictEqual(error.details.retryable, false);
      assert.strictEqual(error.details.code, 'DATABASE_POISONED');
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    assert.strictEqual(candidateFailureInjected, true);
    assert.deepStrictEqual(getDatabaseAdmissionState(), {
      blocked: true,
      poisoned: true,
      activeConnections: 0
    });
    const poisonedStatus = await request(server, 'GET', '/api/system/demo-data/status', adminToken);
    assert.strictEqual(poisonedStatus.status, 503, 'poison 状态下有效 token 不得被认证链路改写为 401。');
    assert.strictEqual(poisonedStatus.body.error.code, 'DATABASE_POISONED');
    assert.deepStrictEqual(poisonedStatus.body.error.details, {
      retryable: false,
      operationalActionRequired: true
    });
    assert(!JSON.stringify(poisonedStatus.body).includes(tmpDir), 'poison 响应不得泄露本地路径。');
    assert(!JSON.stringify(poisonedStatus.body).toLowerCase().includes('permit'), 'poison 响应不得泄露内部 permit。');
    const invalidTokenDuringPoison = await request(server, 'GET', '/api/system/demo-data/status', 'invalid-token');
    assert.strictEqual(invalidTokenDuringPoison.status, 503, '数据库 poison 优先于 token 查询，认证链路仍不得伪造 401。');
    assert.strictEqual(invalidTokenDuringPoison.body.error.code, 'DATABASE_POISONED');
    assert.throws(() => openDatabase(), /安全锁定/);
    assert.throws(() => openDatabase({ allowBlocked: true }), /安全锁定/);
    assert.throws(() => initDatabase(), /安全锁定/);
    poisonDatabaseAdmission();

    console.log('demo restore safety fault tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows SQLite 句柄释放可能略晚于 close；临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
