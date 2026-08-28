'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

// 本测试只使用隔离临时目录，禁止读取或修改项目真实 data、uploads 与 backups。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-context-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-context.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const bcrypt = require('bcryptjs');
const {
  initDatabase,
  migrateDemoImportContextsV2,
  openDatabase
} = require('../db/database');
const { app } = require('../index');
const {
  getDemoArtifactRegistration,
  requireDemoArtifactHandler,
  requireDemoArtifactRegistration
} = require('../services/demoArtifactRegistry');
const {
  bindDemoContextPreview,
  createDemoContext,
  hashDemoContextToken,
  markDemoContextExecuted,
  reassociateDemoContext,
  revokeDemoContext,
  sha256Buffer,
  validateDemoContext,
  validateDemoContextReassociateUpload
} = require('../services/demoContextService');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  generateDemoParkArtifact,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');
const {
  getOrCreateActiveDemoDatasetRun
} = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { readRawDemoContextHeader } = require('../middleware/demoContext');

/** 创建普通测试用户和精确授权角色。 */
function createUserWithPermissions(roleCode, username, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?)`).run(roleCode, roleCode, now, now).lastInsertRowid;
    const userId = db.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?)`).run(
      username,
      username,
      bcrypt.hashSync('Password123!', 10),
      now,
      now
    ).lastInsertRowid;
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
    const grant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `测试授权缺少权限菜单 ${permissionCode}`);
      grant.run(roleId, menu.id, now);
    });
    return userId;
  } finally {
    db.close();
  }
}

/** 发起隔离 HTTP 请求，二进制下载保持 Buffer。 */
function request(server, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : (options.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body)));
    const headers = { ...(options.headers || {}) };
    if (rawBody.length > 0 && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (rawBody.length > 0) headers['Content-Length'] = String(rawBody.length);
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const clientRequest = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(response.headers['content-type'] || '');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          buffer,
          body: contentType.includes('application/json') && buffer.length > 0
            ? JSON.parse(buffer.toString('utf8'))
            : null
        });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(rawBody);
  });
}

/** 构造单文件 multipart 正文，供重新关联 HTTP 链路测试。 */
function createMultipartFileBody(fieldName, filename, buffer) {
  const boundary = `----charcoal-demo-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    Buffer.from(buffer),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { boundary, body };
}

/** 使用原始 socket 写入重复请求头，证明 Node 合并前的 rawHeaders 校验不可绕过。 */
function requestWithDuplicateDemoHeaders(server, pathname, token, demoContextToken) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port }, () => {
      socket.write([
        `POST ${pathname} HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${token}`,
        `X-Demo-Context: ${demoContextToken}`,
        `x-demo-context: ${demoContextToken}`,
        'Content-Length: 0',
        'Connection: close',
        '',
        ''
      ].join('\r\n'));
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('error', reject);
    socket.on('end', () => {
      const responseText = Buffer.concat(chunks).toString('utf8');
      const separator = responseText.indexOf('\r\n\r\n');
      const status = Number((responseText.match(/^HTTP\/1\.1 (\d{3})/m) || [])[1]);
      const bodyText = separator >= 0 ? responseText.slice(separator + 4) : '';
      resolve({ status, body: bodyText ? JSON.parse(bodyText) : null });
    });
  });
}

/** 在独立线程中并发调用 active run 服务，使用同一隔离 SQLite。 */
function createActiveRunInWorker(actorUserId) {
  return new Promise((resolve, reject) => {
    const workerSource = `
      const { parentPort, workerData } = require('worker_threads');
      process.env.DATA_DIR = workerData.dataDir;
      process.env.SQLITE_PATH = workerData.sqlitePath;
      process.env.UPLOADS_DIR = workerData.uploadsDir;
      process.env.BACKUPS_DIR = workerData.backupsDir;
      const { getOrCreateActiveDemoDatasetRun } = require(workerData.servicePath);
      try {
        parentPort.postMessage({ ok: true, result: getOrCreateActiveDemoDatasetRun({ actorUserId: workerData.actorUserId }) });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code || null, message: error.message });
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
        servicePath: require.resolve('../services/demoRunService')
      }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

/** 返回隔离上传目录当前文件数。 */
function countUploadFiles() {
  if (!fs.existsSync(process.env.UPLOADS_DIR)) return 0;
  return fs.readdirSync(process.env.UPLOADS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

/** 验证阶段 1 context v1 能安全迁移为全部撤销的 v2。 */
function assertLegacyContextMigration() {
  const migrationPath = path.join(tmpDir, 'legacy-context.sqlite');
  initDatabase({ databasePath: migrationPath });
  const db = openDatabase({ databasePath: migrationPath });
  try {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const tokenHash = '9'.repeat(64);
    const manifestDigest = getDemoParkManifestDigest();
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE demo_run_import_batches;
      DROP TABLE demo_import_contexts;
      CREATE TABLE demo_import_contexts (
        context_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        handler_key TEXT NOT NULL,
        issued_to_user_id INTEGER NOT NULL,
        runtime_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        upload_file_sha256 TEXT,
        preview_digest TEXT,
        previewed_at TEXT,
        executed_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE demo_run_import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        context_id TEXT NOT NULL,
        import_batch_id INTEGER NOT NULL,
        batch_role TEXT NOT NULL,
        linked_at TEXT NOT NULL
      );`);
    db.prepare(`INSERT INTO demo_dataset_runs
      (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
      VALUES ('legacy-run', ?, ?, ?, 'active', 1, ?)`).run(
      DEMO_DATASET_ID,
      DEMO_MANIFEST_VERSION,
      manifestDigest,
      now
    );
    db.prepare(`INSERT INTO demo_import_contexts
      (context_id, token_hash, run_id, artifact_key, handler_key, issued_to_user_id,
        runtime_epoch, status, issued_at, expires_at)
      VALUES ('legacy-context', ?, 'legacy-run', '13-shift-definitions',
        'shift-definitions-import', 1, 1, 'issued', ?, ?)`).run(tokenHash, now, expiresAt);
    const importBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('shift_definition', 'legacy.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO demo_run_import_batches
      (run_id, artifact_key, context_id, import_batch_id, batch_role, linked_at)
      VALUES ('legacy-run', '13-shift-definitions', 'legacy-context', ?, 'primary', ?)`).run(importBatchId, now);
    db.pragma('foreign_keys = ON');

    assert.strictEqual(migrateDemoImportContextsV2(db), true);
    const migrated = db.prepare(`SELECT token_hash AS tokenHash, dataset_id AS datasetId,
      manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
      artifact_file_sha256 AS artifactFileSha256, status, revoke_reason AS revokeReason
      FROM demo_import_contexts WHERE context_id = 'legacy-context'`).get();
    assert.deepStrictEqual(migrated, {
      tokenHash,
      datasetId: DEMO_DATASET_ID,
      manifestVersion: DEMO_MANIFEST_VERSION,
      manifestDigest,
      artifactFileSha256: tokenHash,
      status: 'revoked',
      revokeReason: 'legacy_context_v4_migration'
    });
    assert.strictEqual(db.prepare(`SELECT batch_role AS batchRole FROM demo_run_import_batches
      WHERE context_id = 'legacy-context'`).get().batchRole, 'primary');
    assert.strictEqual(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
}

(async () => {
  let server;
  try {
    initDatabase();
    assertLegacyContextMigration();

    const registration = getDemoArtifactRegistration('13-shift-definitions');
    assert(registration);
    assert.throws(
      () => requireDemoArtifactRegistration('missing-artifact'),
      (error) => error.code === 'DEMO_ARTIFACT_UNKNOWN'
    );
    assert.throws(
      () => requireDemoArtifactHandler('13-shift-definitions', 'energy-flow-models-import'),
      (error) => error.code === 'DEMO_HANDLER_MISMATCH'
    );

    const duplicateToken = 'a'.repeat(43);
    assert.throws(
      () => readRawDemoContextHeader({ rawHeaders: ['X-Demo-Context', duplicateToken, 'x-demo-context', duplicateToken] }),
      (error) => error.code === 'DEMO_CONTEXT_HEADER_DUPLICATE'
    );
    assert.throws(
      () => readRawDemoContextHeader({ rawHeaders: ['X-Demo-Context', 'x'.repeat(129)] }),
      (error) => error.code === 'DEMO_CONTEXT_HEADER_INVALID'
    );

    assert.throws(
      () => getOrCreateActiveDemoDatasetRun({ actorUserId: 1 }),
      (error) => error.code === 'DEMO_RUNTIME_DISABLED',
      'runtime disabled 时超级管理员也不得创建 run'
    );
    toggleDemoRuntime({ enabled: true, actorUserId: 1 });

    const domainPermissions = [
      'system:demo:download',
      registration.permissions.download,
      registration.permissions.preview,
      registration.permissions.execute
    ];
    const domainUserId = createUserWithPermissions('demo_context_domain', 'demo-context-domain', [...new Set(domainPermissions)]);
    createUserWithPermissions('demo_context_system_only', 'demo-context-system-only', ['system:demo:download']);

    const concurrentRuns = await Promise.all([
      createActiveRunInWorker(1),
      createActiveRunInWorker(domainUserId)
    ]);
    assert(concurrentRuns.every((entry) => entry.ok), JSON.stringify(concurrentRuns));
    assert.strictEqual(new Set(concurrentRuns.map((entry) => entry.result.runId)).size, 1, '首次并发只能创建或复用同一个 active run');
    const runCountDb = openDatabase();
    try {
      assert.strictEqual(runCountDb.prepare(`SELECT COUNT(*) AS total FROM demo_dataset_runs
        WHERE dataset_id = ? AND status IN ('active', 'completed', 'cleanup_pending', 'cleaning')`).get(DEMO_DATASET_ID).total, 1);
    } finally {
      runCountDb.close();
    }
    const firstRun = concurrentRuns[0].result;
    const reusedRun = getOrCreateActiveDemoDatasetRun({ actorUserId: domainUserId });
    assert.strictEqual(reusedRun.reused, true);
    assert.strictEqual(reusedRun.runId, firstRun.runId);
    assert.strictEqual(firstRun.datasetId, DEMO_DATASET_ID);

    const generated = generateDemoParkArtifact('13-shift-definitions', 'xlsx');
    const reassociateUploadPath = path.join(process.env.UPLOADS_DIR, 'reassociate-structure.xlsx');
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(reassociateUploadPath, generated.buffer);
    const initialPreflight = validateDemoContextReassociateUpload({
      artifactKey: '13-shift-definitions',
      handlerKey: 'shift-definitions-import',
      filePath: reassociateUploadPath,
      originalFilename: 'shift-definitions.xlsx'
    });
    assert.strictEqual(initialPreflight.valid, true);
    assert.strictEqual(initialPreflight.uploadFileSha256, sha256Buffer(generated.buffer));
    fs.writeFileSync(reassociateUploadPath, Buffer.from('not-an-xlsx'));
    assert.throws(() => validateDemoContextReassociateUpload({
      artifactKey: '13-shift-definitions',
      handlerKey: 'shift-definitions-import',
      filePath: reassociateUploadPath,
      originalFilename: 'shift-definitions.xlsx'
    }), (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_FILE_INVALID');
    fs.rmSync(reassociateUploadPath, { force: true });
    const artifactFileSha256 = sha256Buffer(generated.buffer);
    // 非 canonical SHA 输入固定覆盖大写、前后空白和非字符串。
    const invalidSha256Values = [
      'A'.repeat(64),
      ` ${artifactFileSha256}`,
      `${artifactFileSha256} `,
      123
    ];
    invalidSha256Values.forEach((invalidSha256Value) => {
      // 当前循环值必须由服务入口按原值拒绝，不能被静默修正。
      assert.throws(() => createDemoContext({
        userId: 1,
        runId: firstRun.runId,
        artifactKey: '13-shift-definitions',
        handlerKey: 'shift-definitions-import',
        artifactFileSha256: invalidSha256Value
      }), (error) => error.details?.code === 'INVALID_DEMO_CONTEXT_DIGEST');
    });
    const issued = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: '13-shift-definitions',
      handlerKey: 'shift-definitions-import',
      artifactFileSha256
    });
    assert.strictEqual(issued.token.length, 43);
    assert(/^[A-Za-z0-9_-]{43}$/.test(issued.token));
    const issuedDb = openDatabase();
    try {
      const row = issuedDb.prepare(`SELECT token_hash AS tokenHash, status FROM demo_import_contexts
        WHERE context_id = ?`).get(issued.contextId);
      assert.strictEqual(row.tokenHash, hashDemoContextToken(issued.token));
      assert.notStrictEqual(row.tokenHash, issued.token);
      assert.strictEqual(row.status, 'issued');
    } finally {
      issuedDb.close();
    }

    assert.strictEqual(validateDemoContext({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      phase: 'preview'
    }).contextId, issued.contextId, 'Multer 前必须完成不依赖上传文件的完整绑定校验');
    assert.throws(() => validateDemoContext({
      token: issued.token,
      userId: domainUserId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      phase: 'preview'
    }), (error) => error.code === 'DEMO_CONTEXT_BINDING_MISMATCH');
    assert.throws(() => validateDemoContext({
      token: issued.token,
      userId: 1,
      artifactKey: '14-shift-schedules',
      handlerKey: 'shift-schedules-import',
      phase: 'preview'
    }), (error) => error.code === 'DEMO_CONTEXT_BINDING_MISMATCH');
    assert.strictEqual(validateDemoContext({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      phase: 'preview',
      uploadFileSha256: '0'.repeat(64)
    }).contextId, issued.contextId, '本地修改文件只绑定独立上传 SHA，不要求等于下载 artifact SHA');

    const previewDigest = `hmac-sha256:v1:audit:${crypto.createHash('sha256').update('preview-digest').digest('hex')}`;
    invalidSha256Values.forEach((invalidSha256Value) => {
      // 当前循环值必须由服务入口按原值拒绝，不能被静默修正。
      assert.throws(() => bindDemoContextPreview({
        token: issued.token,
        userId: 1,
        artifactKey: issued.artifactKey,
        handlerKey: issued.handlerKey,
        uploadFileSha256: invalidSha256Value,
        previewDigest
      }), (error) => error.details?.code === 'INVALID_DEMO_CONTEXT_DIGEST');
    });
    bindDemoContextPreview({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      uploadFileSha256: artifactFileSha256,
      previewDigest
    });
    assert.throws(() => validateDemoContext({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      phase: 'execute',
      uploadFileSha256: artifactFileSha256,
      previewDigest: `hmac-sha256:v1:audit:${'1'.repeat(64)}`
    }), (error) => error.code === 'DEMO_CONTEXT_PREVIEW_MISMATCH');
    markDemoContextExecuted({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      uploadFileSha256: artifactFileSha256,
      previewDigest
    });
    assert.throws(() => validateDemoContext({
      token: issued.token,
      userId: 1,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      phase: 'execute',
      uploadFileSha256: artifactFileSha256,
      previewDigest
    }), (error) => error.code === 'DEMO_CONTEXT_BINDING_MISMATCH');

    const revoked = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    assert.strictEqual(revokeDemoContext({ token: revoked.token, reason: 'test_revoke' }).revoked, true);
    assert.throws(() => validateDemoContext({
      token: revoked.token,
      userId: 1,
      artifactKey: revoked.artifactKey,
      handlerKey: revoked.handlerKey,
      phase: 'preview'
    }), (error) => error.code === 'DEMO_CONTEXT_BINDING_MISMATCH');

    const reassociatedSource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const reassociateDb = openDatabase();
    try {
      reassociateDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        reassociatedSource.contextId
      );
    } finally {
      reassociateDb.close();
    }
    fs.writeFileSync(reassociateUploadPath, generated.buffer);
    const createReassociatePreflight = () => validateDemoContextReassociateUpload({
      artifactKey: reassociatedSource.artifactKey,
      handlerKey: reassociatedSource.handlerKey,
      filePath: reassociateUploadPath,
      originalFilename: 'shift-definitions.xlsx'
    });
    const retainedWitnessPreflight = createReassociatePreflight();
    const databaseFailureInput = {
      token: reassociatedSource.token,
      userId: 1,
      artifactKey: reassociatedSource.artifactKey,
      handlerKey: reassociatedSource.handlerKey,
      preflightWitness: retainedWitnessPreflight.witness
    };
    Object.defineProperty(databaseFailureInput, 'db', {
      get() {
        throw new Error('test database acquisition failure');
      }
    });
    assert.throws(
      () => reassociateDemoContext(databaseFailureInput),
      /test database acquisition failure/
    );
    const retainedWitnessResult = reassociateDemoContext({
      token: reassociatedSource.token,
      userId: 1,
      artifactKey: reassociatedSource.artifactKey,
      handlerKey: reassociatedSource.handlerKey,
      preflightWitness: retainedWitnessPreflight.witness
    });
    assert.notStrictEqual(retainedWitnessResult.token, reassociatedSource.token, '数据库打开异常后预检见证必须可安全重试');

    const reassociatedRetrySource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const reassociatedRetryDb = openDatabase();
    try {
      reassociatedRetryDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        reassociatedRetrySource.contextId
      );
    } finally {
      reassociatedRetryDb.close();
    }
    Object.assign(reassociatedSource, reassociatedRetrySource);
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: 1,
        artifactKey: reassociatedSource.artifactKey,
        handlerKey: reassociatedSource.handlerKey,
        uploadFileSha256: artifactFileSha256
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED',
      '直接调用 service 缺少进程内见证必须 fail-closed'
    );
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: 1,
        artifactKey: reassociatedSource.artifactKey,
        handlerKey: reassociatedSource.handlerKey,
        uploadFileSha256: artifactFileSha256,
        preflightWitness: {}
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED',
      '普通对象不得伪造预检见证'
    );
    const invalidSwapSource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const validSwapSource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const swapSourceDb = openDatabase();
    try {
      const issuedAt = new Date(Date.now() - 120_000).toISOString();
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      swapSourceDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id IN (?, ?)').run(
        issuedAt,
        expiresAt,
        invalidSwapSource.contextId,
        validSwapSource.contextId
      );
    } finally {
      swapSourceDb.close();
    }

    fs.writeFileSync(reassociateUploadPath, generated.buffer);
    const invalidSwapPreflight = createReassociatePreflight();
    fs.writeFileSync(reassociateUploadPath, Buffer.from('not-an-xlsx'));
    assert.throws(
      () => reassociateDemoContext({
        token: invalidSwapSource.token,
        userId: 1,
        artifactKey: invalidSwapSource.artifactKey,
        handlerKey: invalidSwapSource.handlerKey,
        preflightWitness: invalidSwapPreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_FILE_CHANGED',
      '预检后把同路径替换为非法结构文件必须拒绝'
    );

    const structurallyValidDifferentBuffer = Buffer.concat([generated.buffer, Buffer.from([0])]);
    fs.writeFileSync(reassociateUploadPath, structurallyValidDifferentBuffer);
    assert.strictEqual(createReassociatePreflight().valid, true, '追加 ZIP 尾随字节后的文件仍应通过模板结构解析');
    fs.writeFileSync(reassociateUploadPath, generated.buffer);
    const validSwapPreflight = createReassociatePreflight();
    fs.writeFileSync(reassociateUploadPath, structurallyValidDifferentBuffer);
    assert.throws(
      () => reassociateDemoContext({
        token: validSwapSource.token,
        userId: 1,
        artifactKey: validSwapSource.artifactKey,
        handlerKey: validSwapSource.handlerKey,
        uploadFileSha256: '0'.repeat(64),
        preflightWitness: validSwapPreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_FILE_CHANGED',
      '预检后把同路径替换为结构合法但不同字节的文件必须拒绝，且不得信任调用方 SHA'
    );
    const swapLineageDb = openDatabase();
    try {
      [invalidSwapSource, validSwapSource].forEach((source) => {
        const persisted = swapLineageDb.prepare(`SELECT status, replacement_context_id AS replacementContextId
          FROM demo_import_contexts WHERE context_id = ?`).get(source.contextId);
        assert.deepStrictEqual(persisted, { status: 'issued', replacementContextId: null });
        assert.strictEqual(swapLineageDb.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts
          WHERE reassociated_from_context_id = ?`).get(source.contextId).total, 0);
      });
    } finally {
      swapLineageDb.close();
    }
    fs.writeFileSync(reassociateUploadPath, generated.buffer);

    const artifactMismatchPreflight = createReassociatePreflight();
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: 1,
        artifactKey: '14-shift-schedules',
        handlerKey: 'shift-schedules-import',
        uploadFileSha256: artifactMismatchPreflight.uploadFileSha256,
        preflightWitness: artifactMismatchPreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_MISMATCH'
    );
    const handlerMismatchPreflight = createReassociatePreflight();
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: 1,
        artifactKey: reassociatedSource.artifactKey,
        handlerKey: 'shift-schedules-import',
        uploadFileSha256: handlerMismatchPreflight.uploadFileSha256,
        preflightWitness: handlerMismatchPreflight.witness
      }),
      (error) => error.code === 'DEMO_HANDLER_MISMATCH'
    );
    const crossUserPreflight = createReassociatePreflight();
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: domainUserId,
        artifactKey: reassociatedSource.artifactKey,
        handlerKey: reassociatedSource.handlerKey,
        uploadFileSha256: crossUserPreflight.uploadFileSha256,
        preflightWitness: crossUserPreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_USER_MISMATCH'
    );
    const reassociatePreflight = createReassociatePreflight();
    const reassociated = reassociateDemoContext({
      token: reassociatedSource.token,
      userId: 1,
      artifactKey: reassociatedSource.artifactKey,
      handlerKey: reassociatedSource.handlerKey,
      uploadFileSha256: '0'.repeat(64),
      preflightWitness: reassociatePreflight.witness
    });
    assert.notStrictEqual(reassociated.token, reassociatedSource.token);
    assert.strictEqual(reassociated.uploadFileSha256, sha256Buffer(generated.buffer), '最终 SHA 必须来自私有预检字节而非调用方参数');
    assert.throws(
      () => reassociateDemoContext({
        token: reassociatedSource.token,
        userId: 1,
        artifactKey: reassociatedSource.artifactKey,
        handlerKey: reassociatedSource.handlerKey,
        uploadFileSha256: reassociatePreflight.uploadFileSha256,
        preflightWitness: reassociatePreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED',
      '成功后见证必须一次性消费'
    );
    const reassociateLineageDb = openDatabase();
    try {
      const sourceLineage = reassociateLineageDb.prepare(`SELECT replacement_context_id AS replacementContextId,
        reassociated_at AS reassociatedAt FROM demo_import_contexts WHERE context_id = ?`).get(reassociatedSource.contextId);
      const replacementLineage = reassociateLineageDb.prepare(`SELECT reassociated_from_context_id AS reassociatedFromContextId,
        reassociated_at AS reassociatedAt FROM demo_import_contexts WHERE context_id = ?`).get(reassociated.contextId);
      assert.strictEqual(sourceLineage.replacementContextId, reassociated.contextId);
      assert.strictEqual(replacementLineage.reassociatedFromContextId, reassociatedSource.contextId);
      assert.strictEqual(sourceLineage.reassociatedAt, replacementLineage.reassociatedAt);
    } finally {
      reassociateLineageDb.close();
    }
    assert.strictEqual(validateDemoContext({
      token: reassociated.token,
      userId: 1,
      artifactKey: reassociated.artifactKey,
      handlerKey: reassociated.handlerKey,
      phase: 'preview'
    }).issuedToUserId, 1);

    const rollbackSource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const rollbackDb = openDatabase();
    try {
      rollbackDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        rollbackSource.contextId
      );
      const rollbackPreflight = createReassociatePreflight();
      const originalPrepare = rollbackDb.prepare.bind(rollbackDb);
      rollbackDb.prepare = (sql) => {
        const statement = originalPrepare(sql);
        if (String(sql).includes("SET status = 'revoked'") && String(sql).includes('replacement_context_id')) {
          return {
            run() {
              return { changes: 0 };
            }
          };
        }
        return statement;
      };
      assert.throws(
        () => reassociateDemoContext({
          db: rollbackDb,
          token: rollbackSource.token,
          userId: 1,
          artifactKey: rollbackSource.artifactKey,
          handlerKey: rollbackSource.handlerKey,
          uploadFileSha256: rollbackPreflight.uploadFileSha256,
          preflightWitness: rollbackPreflight.witness
        }),
        (error) => error.code === 'DEMO_CONTEXT_STATE_CONFLICT'
      );
      rollbackDb.prepare = originalPrepare;
      const rollbackLineage = rollbackDb.prepare(`SELECT status, replacement_context_id AS replacementContextId
        FROM demo_import_contexts WHERE context_id = ?`).get(rollbackSource.contextId);
      assert.deepStrictEqual(rollbackLineage, { status: 'issued', replacementContextId: null });
      assert.strictEqual(rollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts
        WHERE reassociated_from_context_id = ?`).get(rollbackSource.contextId).total, 0, 'CAS 故障时 replacement 插入必须整体回滚');
    } finally {
      rollbackDb.close();
    }

    assert.throws(() => validateDemoContext({
      token: reassociatedSource.token,
      userId: 1,
      artifactKey: reassociatedSource.artifactKey,
      handlerKey: reassociatedSource.handlerKey,
      phase: 'preview'
    }), (error) => ['DEMO_CONTEXT_EXPIRED', 'DEMO_CONTEXT_BINDING_MISMATCH'].includes(error.code));
    const alternateGenerated = generateDemoParkArtifact('14-shift-schedules', 'xlsx');
    const alternateUploadPath = path.join(process.env.UPLOADS_DIR, 'reassociate-alternate.xlsx');
    fs.writeFileSync(alternateUploadPath, alternateGenerated.buffer);
    const alternatePreflight = validateDemoContextReassociateUpload({
      artifactKey: '14-shift-schedules',
      handlerKey: 'shift-schedules-import',
      filePath: alternateUploadPath,
      originalFilename: 'shift-schedules.xlsx'
    });
    assert.throws(
      () => reassociateDemoContext({
        token: rollbackSource.token,
        userId: 1,
        artifactKey: '14-shift-schedules',
        handlerKey: 'shift-schedules-import',
        uploadFileSha256: alternatePreflight.uploadFileSha256,
        preflightWitness: alternatePreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_INVALID',
      '使用另一项合法 artifact 预检见证也不得改写旧 context 绑定'
    );
    fs.rmSync(alternateUploadPath, { force: true });

    const permissionSource = createDemoContext({
      userId: domainUserId,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const permissionDb = openDatabase();
    try {
      permissionDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        permissionSource.contextId
      );
      const domainRole = permissionDb.prepare(`SELECT r.id FROM sys_roles r
        JOIN sys_user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`).get(domainUserId);
      const downloadMenu = permissionDb.prepare('SELECT id FROM sys_menus WHERE permission_code = ?')
        .get(registration.permissions.download);
      permissionDb.prepare('DELETE FROM sys_role_menus WHERE role_id = ? AND menu_id = ?')
        .run(domainRole.id, downloadMenu.id);
    } finally {
      permissionDb.close();
    }
    const permissionPreflight = createReassociatePreflight();
    assert.throws(
      () => reassociateDemoContext({
        token: permissionSource.token,
        userId: domainUserId,
        artifactKey: permissionSource.artifactKey,
        handlerKey: permissionSource.handlerKey,
        uploadFileSha256: permissionPreflight.uploadFileSha256,
        preflightWitness: permissionPreflight.witness
      }),
      (error) => error.code === 'FORBIDDEN',
      '最终事务必须重新校验当前领域权限'
    );
    const permissionRestoreDb = openDatabase();
    try {
      const domainRole = permissionRestoreDb.prepare(`SELECT r.id FROM sys_roles r
        JOIN sys_user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`).get(domainUserId);
      const downloadMenu = permissionRestoreDb.prepare('SELECT id FROM sys_menus WHERE permission_code = ?')
        .get(registration.permissions.download);
      permissionRestoreDb.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)')
        .run(domainRole.id, downloadMenu.id, new Date().toISOString());
      assert.strictEqual(permissionRestoreDb.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts
        WHERE reassociated_from_context_id = ?`).get(permissionSource.contextId).total, 0);
    } finally {
      permissionRestoreDb.close();
    }

    const epochSource = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const epochDb = openDatabase();
    try {
      epochDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        epochSource.contextId
      );
    } finally {
      epochDb.close();
    }
    const epochPreflight = createReassociatePreflight();
    toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    assert.throws(
      () => reassociateDemoContext({
        token: epochSource.token,
        userId: 1,
        artifactKey: epochSource.artifactKey,
        handlerKey: epochSource.handlerKey,
        uploadFileSha256: epochPreflight.uploadFileSha256,
        preflightWitness: epochPreflight.witness
      }),
      (error) => error.code === 'DEMO_CONTEXT_REASSOCIATE_INVALID',
      '旧 runtime epoch 不得签发 replacement'
    );
    const epochVerifyDb = openDatabase();
    try {
      assert.strictEqual(epochVerifyDb.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts
        WHERE reassociated_from_context_id = ?`).get(epochSource.contextId).total, 0);
    } finally {
      epochVerifyDb.close();
    }
    fs.rmSync(reassociateUploadPath, { force: true });

    const expired = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    const expiryDb = openDatabase();
    try {
      expiryDb.prepare(`UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE context_id = ?`).run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        expired.contextId
      );
    } finally {
      expiryDb.close();
    }
    assert.throws(() => validateDemoContext({
      token: expired.token,
      userId: 1,
      artifactKey: expired.artifactKey,
      handlerKey: expired.handlerKey,
      phase: 'preview'
    }), (error) => error.code === 'DEMO_CONTEXT_EXPIRED');

    const staleEpoch = createDemoContext({
      userId: 1,
      runId: firstRun.runId,
      artifactKey: issued.artifactKey,
      handlerKey: issued.handlerKey,
      artifactFileSha256
    });
    toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    assert.throws(() => validateDemoContext({
      token: staleEpoch.token,
      userId: 1,
      artifactKey: staleEpoch.artifactKey,
      handlerKey: staleEpoch.handlerKey,
      phase: 'preview'
    }), (error) => error.code === 'DEMO_CONTEXT_BINDING_MISMATCH');

    const conflictDb = openDatabase();
    try {
      conflictDb.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
        .run('f'.repeat(64), firstRun.runId);
    } finally {
      conflictDb.close();
    }
    assert.throws(
      () => getOrCreateActiveDemoDatasetRun({ actorUserId: 1 }),
      (error) => error.code === 'DEMO_ACTIVE_RUN_MANIFEST_CONFLICT'
    );
    const repairDb = openDatabase();
    try {
      repairDb.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
        .run(getDemoParkManifestDigest(), firstRun.runId);
    } finally {
      repairDb.close();
    }

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const adminLogin = await request(server, 'POST', '/api/login', {
      body: { username: 'admin', password: 'AdminPassword123!' }
    });
    assert.strictEqual(adminLogin.status, 200);
    const adminToken = adminLogin.body.data.token;
    const domainLogin = await request(server, 'POST', '/api/login', {
      body: { username: 'demo-context-domain', password: 'Password123!' }
    });
    assert.strictEqual(domainLogin.status, 200);
    const domainToken = domainLogin.body.data.token;
    const systemOnlyLogin = await request(server, 'POST', '/api/login', {
      body: { username: 'demo-context-system-only', password: 'Password123!' }
    });
    const systemOnlyToken = systemOnlyLogin.body.data.token;

    const contextsBeforeManifest = openDatabase();
    let contextCountBeforeManifest;
    try {
      contextCountBeforeManifest = contextsBeforeManifest.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total;
    } finally {
      contextsBeforeManifest.close();
    }
    const manifestResponse = await request(server, 'GET', '/api/templates/demo-park/manifest', { token: adminToken });
    assert.strictEqual(manifestResponse.status, 200);
    assert.strictEqual(manifestResponse.body.data.datasetId, DEMO_DATASET_ID);
    assert.strictEqual(manifestResponse.headers['x-demo-context'], undefined, 'manifest 不得签发 context');
    const contextsAfterManifest = openDatabase();
    try {
      assert.strictEqual(contextsAfterManifest.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total, contextCountBeforeManifest);
    } finally {
      contextsAfterManifest.close();
    }

    const filteredManifest = await request(server, 'GET', '/api/templates/demo-park/manifest', { token: systemOnlyToken });
    assert.strictEqual(filteredManifest.status, 200);
    assert.strictEqual(filteredManifest.body.data.artifactCount, 0, 'manifest 必须按真实领域下载权限过滤');
    const deniedDownload = await request(server, 'GET', '/api/templates/demo-park/13-shift-definitions.xlsx', { token: systemOnlyToken });
    assert.strictEqual(deniedDownload.status, 403, '下载必须同时要求系统演示权限和 artifact 领域权限');

    const downloadResponse = await request(server, 'GET', '/api/templates/demo-park/13-shift-definitions.xlsx', { token: adminToken });
    assert.strictEqual(downloadResponse.status, 200);
    const headerNames = [
      'x-demo-dataset-id',
      'x-demo-run-id',
      'x-demo-artifact-key',
      'x-demo-handler-key',
      'x-demo-manifest-version',
      'x-demo-manifest-digest',
      'x-demo-artifact-sha256',
      'x-demo-context'
    ];
    headerNames.forEach((headerName) => assert(downloadResponse.headers[headerName], `下载缺少 ${headerName}`));
    assert.strictEqual(downloadResponse.headers['x-demo-artifact-sha256'], sha256Buffer(downloadResponse.buffer));
    const downloadedToken = downloadResponse.headers['x-demo-context'];
    const downloadContextDb = openDatabase();
    try {
      const row = downloadContextDb.prepare('SELECT token_hash AS tokenHash FROM demo_import_contexts WHERE token_hash = ?')
        .get(hashDemoContextToken(downloadedToken));
      assert(row);
      assert.notStrictEqual(row.tokenHash, downloadedToken);
      const auditText = JSON.stringify(downloadContextDb.prepare('SELECT detail_json AS detailJson FROM sys_operation_logs').all());
      assert(!auditText.includes(downloadedToken), 'context 明文不得进入审计 details');
    } finally {
      downloadContextDb.close();
    }

    const bodyReassociate = await request(server, 'POST', '/api/system/demo-data/contexts/reassociate', {
      token: adminToken,
      body: { contextToken: downloadedToken }
    });
    assert.strictEqual(bodyReassociate.status, 409, '旧无文件重新关联接口必须稳定要求受控文件预检');
    assert(!JSON.stringify(bodyReassociate.body).includes(downloadedToken));
    const headerReassociate = await request(server, 'POST', '/api/system/demo-data/contexts/reassociate', {
      token: adminToken,
      headers: { 'X-Demo-Context': downloadedToken }
    });
    assert.strictEqual(headerReassociate.status, 409);
    assert.strictEqual(headerReassociate.body.error.code, 'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED');

    const duplicateHeaderResponse = await requestWithDuplicateDemoHeaders(
      server,
      '/api/system/demo-data/contexts/reassociate/13-shift-definitions/shift-definitions-import',
      adminToken,
      downloadedToken
    );
    assert.strictEqual(duplicateHeaderResponse.status, 400);
    assert.strictEqual(duplicateHeaderResponse.body.error.code, 'DEMO_CONTEXT_HEADER_DUPLICATE');

    const httpReassociateDownload = await request(server, 'GET', '/api/templates/demo-park/13-shift-definitions.xlsx', { token: domainToken });
    assert.strictEqual(httpReassociateDownload.status, 200);
    const httpSourceToken = httpReassociateDownload.headers['x-demo-context'];
    const httpSourceDb = openDatabase();
    try {
      httpSourceDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE token_hash = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        hashDemoContextToken(httpSourceToken)
      );
    } finally {
      httpSourceDb.close();
    }
    const multipart = createMultipartFileBody('file', 'shift-definitions.xlsx', httpReassociateDownload.buffer);
    const httpReassociate = await request(
      server,
      'POST',
      '/api/system/demo-data/contexts/reassociate/13-shift-definitions/shift-definitions-import',
      {
        token: domainToken,
        headers: {
          'X-Demo-Context': httpSourceToken,
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`
        },
        rawBody: multipart.body
      }
    );
    assert.strictEqual(httpReassociate.status, 200, JSON.stringify(httpReassociate.body));
    assert(/^[A-Za-z0-9_-]{43}$/.test(httpReassociate.headers['x-demo-context'] || ''));
    assert(!JSON.stringify(httpReassociate.body).includes(httpReassociate.headers['x-demo-context']), '替换 token 不得进入响应 body');
    assert.strictEqual(httpReassociate.body.data.artifactKey, '13-shift-definitions');
    assert.strictEqual(httpReassociate.body.data.handlerKey, 'shift-definitions-import');

    const concurrentSourceDownload = await request(server, 'GET', '/api/templates/demo-park/13-shift-definitions.xlsx', { token: domainToken });
    assert.strictEqual(concurrentSourceDownload.status, 200);
    const concurrentSourceToken = concurrentSourceDownload.headers['x-demo-context'];
    const concurrentSourceDb = openDatabase();
    try {
      concurrentSourceDb.prepare('UPDATE demo_import_contexts SET issued_at = ?, expires_at = ? WHERE token_hash = ?').run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        hashDemoContextToken(concurrentSourceToken)
      );
    } finally {
      concurrentSourceDb.close();
    }
    const concurrentRequests = [0, 1].map(() => {
      const concurrentMultipart = createMultipartFileBody('file', 'shift-definitions.xlsx', concurrentSourceDownload.buffer);
      return request(
        server,
        'POST',
        '/api/system/demo-data/contexts/reassociate/13-shift-definitions/shift-definitions-import',
        {
          token: domainToken,
          headers: {
            'X-Demo-Context': concurrentSourceToken,
            'Content-Type': `multipart/form-data; boundary=${concurrentMultipart.boundary}`
          },
          rawBody: concurrentMultipart.body
        }
      );
    });
    const concurrentResults = await Promise.all(concurrentRequests);
    assert.strictEqual(concurrentResults.filter((response) => response.status === 200).length, 1, JSON.stringify(concurrentResults.map((response) => ({ status: response.status, body: response.body }))));
    assert.strictEqual(concurrentResults.filter((response) => response.status !== 200).length, 1);
    const concurrentLineageDb = openDatabase();
    try {
      const source = concurrentLineageDb.prepare(`SELECT context_id AS contextId, replacement_context_id AS replacementContextId
        FROM demo_import_contexts WHERE token_hash = ?`).get(hashDemoContextToken(concurrentSourceToken));
      assert(source.replacementContextId);
      assert.strictEqual(concurrentLineageDb.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts
        WHERE reassociated_from_context_id = ?`).get(source.contextId).total, 1, '重复并发后数据库只能存在一个 replacement');
    } finally {
      concurrentLineageDb.close();
    }

    const uploadCountBefore = countUploadFiles();
    const unconnectedRejected = await request(server, 'POST', '/api/organization/units/import', {
      token: adminToken,
      headers: { 'X-Demo-Context': downloadedToken }
    });
    assert.strictEqual(unconnectedRejected.status, 409);
    assert.strictEqual(unconnectedRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    assert.strictEqual(countUploadFiles(), uploadCountBefore, '未接入能力必须在 Multer 落盘前 fail-closed');

    const preflightRejected = await request(server, 'POST', '/api/energy-analysis/imports/shift-definitions/preview', {
      token: adminToken,
      headers: { 'X-Demo-Context': 'z'.repeat(43) }
    });
    assert.strictEqual(preflightRejected.status, 409);
    assert.strictEqual(preflightRejected.body.error.code, 'DEMO_CONTEXT_NOT_FOUND');
    assert.strictEqual(countUploadFiles(), uploadCountBefore, '完整 context 绑定失败必须发生在 Multer 落盘前');

    toggleDemoRuntime({ enabled: false, actorUserId: 1 });
    const disabledManifest = await request(server, 'GET', '/api/templates/demo-park/manifest', { token: adminToken });
    assert.strictEqual(disabledManifest.status, 409, 'runtime 开关对超级管理员同样不可绕过');
    assert.strictEqual(disabledManifest.body.error.code, 'DEMO_RUNTIME_DISABLED');

    console.log('demo context foundation tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows SQLite 句柄释放可能稍晚，临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
