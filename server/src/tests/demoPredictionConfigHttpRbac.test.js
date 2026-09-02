'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 正式 HTTP/RBAC 专项只使用系统临时目录、隔离 SQLite 和随机本机端口。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-prediction-http-rbac-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'prediction-http-rbac.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'PredictionHttpRbac123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.PREDICTION_IMPORT_HMAC_SECRET = 'prediction-http-rbac-hmac-secret';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { register } = require('../services/authService');
const {
  hashDemoContextToken,
  sha256Buffer
} = require('../services/demoContextService');
const {
  DEMO_MANIFEST_VERSION,
  getDemoParkManifestDigest
} = require('../services/demoParkDatasetService');
const {
  PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT
} = require('../services/predictionService');

// Artifact 07 与 Artifact 12 的正式下载和导入合同。
const ARTIFACT_CONTRACTS = Object.freeze({
  monthlyEnergy: Object.freeze({
    artifactKey: '07-monthly-energy',
    handlerKey: 'monthly-energy-import',
    downloadPath: '/api/templates/demo-park/07-monthly-energy.csv',
    importPath: '/api/imports/batches',
    permission: 'imports:create'
  }),
  predictionConfig: Object.freeze({
    artifactKey: '12-prediction-configs',
    handlerKey: 'prediction-configs-import',
    downloadPath: '/api/templates/demo-park/12-prediction-configs.csv',
    previewPath: '/api/predictions/configs/import/preview',
    executePath: '/api/predictions/configs/import/execute',
    permission: 'prediction:config:import'
  })
});

// 正式前置台账下载和导入合同，保证 Artifact 07 使用真实可解析组织与计量器具。
const PREREQUISITE_ARTIFACTS = Object.freeze([
  Object.freeze({
    artifactKey: '01-organization-root',
    downloadPath: '/api/templates/demo-park/01-organization-root.csv',
    importPath: '/api/organization/units/import'
  }),
  Object.freeze({
    artifactKey: '02-organization-departments',
    downloadPath: '/api/templates/demo-park/02-organization-departments.csv',
    importPath: '/api/organization/units/import'
  }),
  Object.freeze({
    artifactKey: '03-organization-process-equipment',
    downloadPath: '/api/templates/demo-park/03-organization-process-equipment.csv',
    importPath: '/api/organization/units/import'
  }),
  Object.freeze({
    artifactKey: '04-meters',
    downloadPath: '/api/templates/demo-park/04-meters.csv',
    importPath: '/api/meters/import'
  })
]);

// 用户 A/B 的完整测试权限；另两个账号分别移除系统下载或 Prediction 导入权限。
const FULL_IMPORT_PERMISSIONS = Object.freeze([
  'system:demo:download',
  'ledger:units:import',
  'ledger:meters:import',
  ARTIFACT_CONTRACTS.monthlyEnergy.permission,
  ARTIFACT_CONTRACTS.predictionConfig.permission
]);

/** 发起随机本机端口 HTTP 请求，并同时保留响应头、二进制字节和 JSON 正文。 */
function request(server, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : (options.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(options.body), 'utf8'));
    const headers = { ...(options.headers || {}) };
    if (rawBody.length > 0 && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
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

/** 将正式下载得到的原字节构造成单文件 multipart 请求体。 */
function createMultipart(buffer, filename, mimeType = 'text/csv') {
  const boundary = `----charcoal-prediction-http-rbac-${crypto.randomUUID()}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
  };
}

/** 上传正式下载文件，可选携带服务端签发的 X-Demo-Context。 */
function postMultipart(server, token, pathname, buffer, filename, demoContextToken = null) {
  const multipart = createMultipart(buffer, filename);
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`
  };
  if (demoContextToken) headers['X-Demo-Context'] = demoContextToken;
  return request(server, 'POST', pathname, {
    token,
    headers,
    rawBody: multipart.body
  });
}

/** 为普通测试用户创建角色并授予给定权限集合。 */
function grantUserPermissions(username, roleCode, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    assert(user, `缺少测试用户 ${username}`);
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?)`).run(roleCode, roleCode, now, now).lastInsertRowid);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(user.id, roleId, now);
    const insertRoleMenu = db.prepare(
      'INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)'
    );
    permissionCodes.forEach((permissionCode) => {
      let menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      if (!menu) {
        const menuId = Number(db.prepare(`INSERT INTO sys_menus
          (menu_type, menu_name, permission_code, visible, status, is_builtin, created_at, updated_at)
          VALUES ('button', ?, ?, 0, 'active', 0, ?, ?)`).run(
          `测试权限 ${permissionCode}`,
          permissionCode,
          now,
          now
        ).lastInsertRowid);
        menu = { id: menuId };
      }
      insertRoleMenu.run(roleId, menu.id, now);
    });
  } finally {
    db.close();
  }
}

/** 读取正式下载 token 对应的持久 context 投影，不返回 token_hash。 */
function readPersistedContext(token) {
  const db = openDatabase();
  try {
    return db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, upload_file_sha256 AS uploadFileSha256,
      preview_digest AS previewDigest
      FROM demo_import_contexts WHERE token_hash = ?`).get(hashDemoContextToken(token));
  } finally {
    db.close();
  }
}

/** 精确校验 managed 下载响应头、文件摘要和持久 context 一致。 */
function assertManagedDownloadClosure(response, expected, expectedUserId, expectedReused) {
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  assert(response.buffer.length > 0, `${expected.artifactKey} 下载字节不能为空。`);
  const token = response.headers['x-demo-context'];
  assert(/^[A-Za-z0-9_-]{43}$/.test(token || ''), `${expected.artifactKey} 必须签发合法 context。`);
  const context = readPersistedContext(token);
  assert(context, `${expected.artifactKey} context 必须持久化。`);
  const actualSha256 = sha256Buffer(response.buffer);
  assert.strictEqual(response.headers['x-demo-dataset-id'], context.datasetId);
  assert.strictEqual(response.headers['x-demo-run-id'], context.runId);
  assert.strictEqual(response.headers['x-demo-runtime-epoch'], String(context.runtimeEpoch));
  assert.strictEqual(response.headers['x-demo-artifact-key'], context.artifactKey);
  assert.strictEqual(response.headers['x-demo-handler-key'], context.handlerKey);
  assert.strictEqual(response.headers['x-demo-manifest-version'], context.manifestVersion);
  assert.strictEqual(response.headers['x-demo-manifest-digest'], context.manifestDigest);
  assert.strictEqual(response.headers['x-demo-artifact-sha256'], context.artifactFileSha256);
  assert.strictEqual(response.headers['x-demo-artifact-sha256'], actualSha256);
  assert.strictEqual(response.headers['x-demo-run-reused'], String(expectedReused));
  assert.strictEqual(response.headers['x-demo-run-auto-superseded'], 'false');
  assert.strictEqual(response.headers['x-demo-run-superseded-from'], undefined);
  assert.strictEqual(context.artifactKey, expected.artifactKey);
  assert.strictEqual(context.handlerKey, expected.handlerKey);
  assert.strictEqual(context.issuedToUserId, expectedUserId);
  assert.strictEqual(context.status, 'issued');
  assert.strictEqual(context.manifestVersion, DEMO_MANIFEST_VERSION);
  assert.strictEqual(context.manifestDigest, getDemoParkManifestDigest());
  return { token, context };
}

/** 通过正式无状态下载和导入路由准备 Artifact 07 所需台账。 */
async function importPrerequisiteArtifacts(server, token) {
  for (const artifact of PREREQUISITE_ARTIFACTS) {
    const downloadResponse = await request(server, 'GET', artifact.downloadPath, { token });
    assert.strictEqual(downloadResponse.status, 200, `${artifact.artifactKey} 下载失败。`);
    assert.strictEqual(downloadResponse.headers['x-demo-context'], undefined,
      `${artifact.artifactKey} 正式无状态下载不得签发 context。`);
    const importResponse = await postMultipart(
      server,
      token,
      artifact.importPath,
      downloadResponse.buffer,
      `${artifact.artifactKey}.csv`
    );
    assert.strictEqual(importResponse.status, 201,
      `${artifact.artifactKey} 正式导入失败：${JSON.stringify(importResponse.body)}`);
  }
}

/** 登录测试账号并返回 Bearer token。 */
async function login(server, username, password) {
  const response = await request(server, 'POST', '/api/login', {
    body: { username, password }
  });
  assert.strictEqual(response.status, 200, `${username} 登录失败：${JSON.stringify(response.body)}`);
  return response.body.data.token;
}

(async () => {
  let server = null;
  try {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
    initDatabase();

    register({ username: 'prediction-demo-user-a', password: 'Password123!' });
    register({ username: 'prediction-demo-user-b', password: 'Password123!' });
    register({ username: 'prediction-demo-no-system', password: 'Password123!' });
    register({ username: 'prediction-demo-no-prediction', password: 'Password123!' });
    grantUserPermissions('prediction-demo-user-a', 'prediction-demo-user-a-role', FULL_IMPORT_PERMISSIONS);
    grantUserPermissions('prediction-demo-user-b', 'prediction-demo-user-b-role', FULL_IMPORT_PERMISSIONS);
    grantUserPermissions(
      'prediction-demo-no-system',
      'prediction-demo-no-system-role',
      FULL_IMPORT_PERMISSIONS.filter((permission) => permission !== 'system:demo:download')
    );
    grantUserPermissions(
      'prediction-demo-no-prediction',
      'prediction-demo-no-prediction-role',
      FULL_IMPORT_PERMISSIONS.filter(
        (permission) => permission !== ARTIFACT_CONTRACTS.predictionConfig.permission
      )
    );

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const adminToken = await login(server, 'admin', process.env.CHARCOAL_ADMIN_PASSWORD);
    const userAToken = await login(server, 'prediction-demo-user-a', 'Password123!');
    const userBToken = await login(server, 'prediction-demo-user-b', 'Password123!');
    const noSystemToken = await login(server, 'prediction-demo-no-system', 'Password123!');
    const noPredictionToken = await login(server, 'prediction-demo-no-prediction', 'Password123!');

    const toggleResponse = await request(server, 'POST', '/api/system/demo-data/toggle', {
      token: adminToken,
      body: { enabled: true }
    });
    assert.strictEqual(toggleResponse.status, 200, JSON.stringify(toggleResponse.body));
    assert.strictEqual(toggleResponse.body.data.runtime.enabled, true);

    // 401、缺系统权限和缺 Prediction 权限必须由正式 RBAC 链路拒绝。
    assert.strictEqual((await request(server, 'GET', '/api/system/demo-data/catalog')).status, 401);
    assert.strictEqual((await request(
      server,
      'GET',
      ARTIFACT_CONTRACTS.predictionConfig.downloadPath
    )).status, 401);
    const noSystemCatalog = await request(server, 'GET', '/api/system/demo-data/catalog', {
      token: noSystemToken
    });
    assert.strictEqual(noSystemCatalog.status, 403);
    assert.strictEqual(noSystemCatalog.body.error.code, 'FORBIDDEN');
    const noSystemDownload = await request(
      server,
      'GET',
      ARTIFACT_CONTRACTS.predictionConfig.downloadPath,
      { token: noSystemToken }
    );
    assert.strictEqual(noSystemDownload.status, 403);
    assert.strictEqual(noSystemDownload.body.error.code, 'FORBIDDEN');
    const noPredictionCatalog = await request(server, 'GET', '/api/system/demo-data/catalog', {
      token: noPredictionToken
    });
    assert.strictEqual(noPredictionCatalog.status, 200);
    assert.strictEqual(
      noPredictionCatalog.body.data.artifacts.some(
        (artifact) => artifact.artifactKey === ARTIFACT_CONTRACTS.predictionConfig.artifactKey
      ),
      false,
      '缺 Prediction 权限的 catalog 不得暴露 Artifact 12。'
    );
    const noPredictionDownload = await request(
      server,
      'GET',
      ARTIFACT_CONTRACTS.predictionConfig.downloadPath,
      { token: noPredictionToken }
    );
    assert.strictEqual(noPredictionDownload.status, 403);
    assert.strictEqual(noPredictionDownload.body.error.code, 'FORBIDDEN');

    // 正式 catalog 必须提供当前 canonical manifest，并向用户 A 暴露 Artifact 07/12。
    const initialCatalog = await request(server, 'GET', '/api/system/demo-data/catalog', {
      token: userAToken
    });
    assert.strictEqual(initialCatalog.status, 200, JSON.stringify(initialCatalog.body));
    assert.strictEqual(initialCatalog.body.data.manifestVersion, DEMO_MANIFEST_VERSION);
    assert.strictEqual(initialCatalog.body.data.manifestDigest, getDemoParkManifestDigest());
    assert.strictEqual(initialCatalog.body.data.run, null);
    for (const contract of Object.values(ARTIFACT_CONTRACTS)) {
      assert(
        initialCatalog.body.data.artifacts.some(
          (artifact) => artifact.artifactKey === contract.artifactKey
        ),
        `${contract.artifactKey} 必须出现在用户 A 正式 catalog。`
      );
    }

    await importPrerequisiteArtifacts(server, userAToken);

    const userDb = openDatabase();
    const userA = userDb.prepare(
      "SELECT id FROM sys_users WHERE username = 'prediction-demo-user-a'"
    ).get();
    userDb.close();
    assert(userA, '缺少用户 A 主键。');
    const userAId = Number(userA.id);

    // Artifact 07 必须通过正式下载字节和正式 direct-upload 路由形成当前 run 训练闭包。
    const monthlyDownload = await request(
      server,
      'GET',
      ARTIFACT_CONTRACTS.monthlyEnergy.downloadPath,
      { token: userAToken }
    );
    const monthlyDownloadClosure = assertManagedDownloadClosure(
      monthlyDownload,
      ARTIFACT_CONTRACTS.monthlyEnergy,
      userAId,
      false
    );
    const monthlyImport = await postMultipart(
      server,
      userAToken,
      ARTIFACT_CONTRACTS.monthlyEnergy.importPath,
      monthlyDownload.buffer,
      '07-monthly-energy.csv',
      monthlyDownloadClosure.token
    );
    assert.strictEqual(monthlyImport.status, 201, JSON.stringify(monthlyImport.body));
    assert.strictEqual(monthlyImport.body.data.terminalReplay, false);
    const trainingBatchId = Number(monthlyImport.body.data.id);
    assert(Number.isSafeInteger(trainingBatchId) && trainingBatchId > 0);
    assert.strictEqual(readPersistedContext(monthlyDownloadClosure.token).status, 'executed');

    // Artifact 12 下载必须复用 Artifact 07 的 active run，且全部响应头与持久 context 对齐。
    const predictionDownload = await request(
      server,
      'GET',
      ARTIFACT_CONTRACTS.predictionConfig.downloadPath,
      { token: userAToken }
    );
    const predictionDownloadClosure = assertManagedDownloadClosure(
      predictionDownload,
      ARTIFACT_CONTRACTS.predictionConfig,
      userAId,
      true
    );
    assert.strictEqual(
      predictionDownloadClosure.context.runId,
      monthlyDownloadClosure.context.runId,
      'Artifact 07/12 必须绑定同一 active run。'
    );

    // 用户 B 即使拥有相同 RBAC 权限，也不得使用用户 A 正式下载签发的 context。
    const crossUserPreview = await postMultipart(
      server,
      userBToken,
      ARTIFACT_CONTRACTS.predictionConfig.previewPath,
      predictionDownload.buffer,
      '12-prediction-configs-cross-user.csv',
      predictionDownloadClosure.token
    );
    assert.strictEqual(crossUserPreview.status, 409, JSON.stringify(crossUserPreview.body));
    assert.strictEqual(crossUserPreview.body.error.code, 'DEMO_CONTEXT_BINDING_MISMATCH');
    assert.strictEqual(readPersistedContext(predictionDownloadClosure.token).status, 'issued');

    const predictionPreview = await postMultipart(
      server,
      userAToken,
      ARTIFACT_CONTRACTS.predictionConfig.previewPath,
      predictionDownload.buffer,
      '12-prediction-configs.csv',
      predictionDownloadClosure.token
    );
    assert.strictEqual(predictionPreview.status, 200, JSON.stringify(predictionPreview.body));
    const preview = predictionPreview.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.blocked, 0);
    assert.strictEqual(preview.candidateRows.length, 1);
    assert.strictEqual(preview.candidateRows[0].sourceBatchFilterId, null);
    assert.strictEqual(readPersistedContext(predictionDownloadClosure.token).status, 'previewed');

    const executeBody = {
      batchId: preview.batchId,
      confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    };
    const predictionExecute = await request(
      server,
      'POST',
      ARTIFACT_CONTRACTS.predictionConfig.executePath,
      {
        token: userAToken,
        headers: { 'X-Demo-Context': predictionDownloadClosure.token },
        body: executeBody
      }
    );
    assert.strictEqual(predictionExecute.status, 200, JSON.stringify(predictionExecute.body));
    assert.strictEqual(predictionExecute.body.data.imported, 1);
    assert.strictEqual(predictionExecute.body.data.sourceTrainingBatchId, trainingBatchId);
    assert.strictEqual(predictionExecute.body.data.importedRecords.length, 1);
    assert.strictEqual(predictionExecute.body.data.importedRecords[0].status, 'draft');
    assert.strictEqual(readPersistedContext(predictionDownloadClosure.token).status, 'executed');

    // 同一正式 execute 请求必须进入严格 terminal replay，并且不重复写业务、绑定或 ownership。
    const closureDb = openDatabase();
    const beforeReplay = {
      predictionConfigCount: Number(closureDb.prepare(
        'SELECT COUNT(*) AS total FROM prediction_configs WHERE source_batch_id = ?'
      ).get(preview.batchId).total),
      ownershipCount: Number(closureDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE run_id = ? AND artifact_key = '12-prediction-configs'
          AND entity_type = 'prediction_config' AND source_batch_id = ?
          AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
        predictionDownloadClosure.context.runId,
        preview.batchId
      ).total),
      bindingCount: Number(closureDb.prepare(`SELECT COUNT(*) AS total
        FROM demo_run_import_batches WHERE context_id = ? AND import_batch_id = ?`).get(
        predictionDownloadClosure.context.contextId,
        preview.batchId
      ).total)
    };
    closureDb.close();
    assert.deepStrictEqual(beforeReplay, {
      predictionConfigCount: 1,
      ownershipCount: 1,
      bindingCount: 1
    });

    const terminalReplay = await request(
      server,
      'POST',
      ARTIFACT_CONTRACTS.predictionConfig.executePath,
      {
        token: userAToken,
        headers: { 'X-Demo-Context': predictionDownloadClosure.token },
        body: executeBody
      }
    );
    assert.strictEqual(terminalReplay.status, 200, JSON.stringify(terminalReplay.body));
    assert.strictEqual(terminalReplay.body.data.terminalReplay, true);
    assert.strictEqual(terminalReplay.body.data.batchId, preview.batchId);
    assert.strictEqual(
      terminalReplay.body.data.importedRecords[0].id,
      predictionExecute.body.data.importedRecords[0].id
    );

    const afterReplayDb = openDatabase();
    const afterReplay = {
      predictionConfigCount: Number(afterReplayDb.prepare(
        'SELECT COUNT(*) AS total FROM prediction_configs WHERE source_batch_id = ?'
      ).get(preview.batchId).total),
      ownershipCount: Number(afterReplayDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE run_id = ? AND artifact_key = '12-prediction-configs'
          AND entity_type = 'prediction_config' AND source_batch_id = ?
          AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
        predictionDownloadClosure.context.runId,
        preview.batchId
      ).total),
      bindingCount: Number(afterReplayDb.prepare(`SELECT COUNT(*) AS total
        FROM demo_run_import_batches WHERE context_id = ? AND import_batch_id = ?`).get(
        predictionDownloadClosure.context.contextId,
        preview.batchId
      ).total)
    };
    afterReplayDb.close();
    assert.deepStrictEqual(afterReplay, beforeReplay);

    // 下载后的正式 catalog 必须投影同一 active run 和 canonical manifest 身份。
    const finalCatalog = await request(server, 'GET', '/api/system/demo-data/catalog', {
      token: userAToken
    });
    assert.strictEqual(finalCatalog.status, 200, JSON.stringify(finalCatalog.body));
    assert.strictEqual(finalCatalog.body.data.run.runId, predictionDownloadClosure.context.runId);
    assert.strictEqual(finalCatalog.body.data.run.datasetId, predictionDownloadClosure.context.datasetId);
    assert.strictEqual(finalCatalog.body.data.run.manifestVersion, predictionDownloadClosure.context.manifestVersion);
    assert.strictEqual(finalCatalog.body.data.run.manifestDigest, predictionDownloadClosure.context.manifestDigest);

    console.log(JSON.stringify({
      status: 'passed',
      manifestVersion: DEMO_MANIFEST_VERSION,
      manifestDigest: getDemoParkManifestDigest(),
      runId: predictionDownloadClosure.context.runId,
      trainingBatchId,
      predictionBatchId: preview.batchId,
      terminalReplay: true,
      rbacMatrix: true,
      crossUserRejected: true
    }));
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
