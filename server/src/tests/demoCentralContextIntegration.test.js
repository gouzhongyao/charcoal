'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 中央 context 集成测试只使用系统临时目录中的隔离 SQLite、上传和备份目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-central-context-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-central-context.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoCentralContext123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'demo-central-context-integration-secret-2026';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { login } = require('../services/authService');
const { sha256Buffer } = require('../services/demoContextService');
const { getDemoArtifactRegistration } = require('../services/demoArtifactRegistry');
const { getImportAuditBatchDetail } = require('../services/importAuditService');

// 四组中央 context 代表性测试定义。
const TEST_CASES = Object.freeze([
  Object.freeze({
    label: 'EnergyAnalysis 单批次',
    artifactKey: '13-shift-definitions',
    previewPath: '/api/energy-analysis/imports/shift-definitions/preview',
    executePath: '/api/energy-analysis/imports/shift-definitions/execute',
    expectedRoles: ['primary'],
    expectedImportTypes: ['shift_definition'],
    expectedBusinessTable: 'shift_definitions'
  }),
  Object.freeze({
    label: 'Benchmark 单批次',
    artifactKey: '19-conversion-factors',
    previewPath: '/api/energy-benchmarks/imports/conversion-factors/preview',
    executePath: '/api/energy-benchmarks/imports/conversion-factors/execute',
    expectedRoles: ['primary'],
    expectedImportTypes: ['energy_conversion_factor'],
    expectedBusinessTable: 'energy_conversion_factors'
  }),
  Object.freeze({
    label: 'Flow bundle',
    artifactKey: '24-energy-flow-edges',
    previewPath: '/api/energy-flow-imports/bundle/preview',
    executePath: '/api/energy-flow-imports/bundle/execute',
    expectedRoles: ['edge', 'record'],
    expectedImportTypes: ['energy_flow_edge', 'energy_flow_record'],
    expectedBusinessTable: null
  }),
  Object.freeze({
    label: 'Balance bundle',
    artifactKey: '25-energy-balance-configs',
    previewPath: '/api/energy-balance-imports/bundle/preview',
    executePath: '/api/energy-balance-imports/bundle/execute',
    expectedRoles: ['boundary', 'item'],
    expectedImportTypes: ['energy_balance_boundary', 'energy_balance_item'],
    expectedBusinessTable: null
  })
]);

/** 发送 JSON 或二进制 HTTP 请求，并按响应类型解析。 */
function request(server, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : (options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body)));
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (rawBody.length > 0 && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (rawBody.length > 0) headers['Content-Length'] = String(rawBody.length);
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
        let body = null;
        if (contentType.includes('application/json') && buffer.length > 0) body = JSON.parse(buffer.toString('utf8'));
        resolve({ status: response.statusCode, headers: response.headers, buffer, body, text: buffer.toString('utf8') });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(rawBody);
  });
}

/** 发送带 X-Demo-Context 的单文件 multipart 预演请求。 */
function requestMultipart(server, pathname, token, demoContextToken, filename, buffer) {
  const boundary = `----demo-central-context-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return request(server, 'POST', pathname, {
    token,
    headers: {
      'X-Demo-Context': demoContextToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    rawBody: body
  });
}

/** 创建具备四组下载、预演和执行权限的真实非超级管理员账号。 */
function createAuthorizedUser() {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const passwordHash = require('bcryptjs').hashSync('Password123!', 10);
    const userId = Number(db.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
      VALUES ('demo-central-context-user', '中央 context 测试用户', ?, 'active', 0, ?, ?)`)
      .run(passwordHash, now, now).lastInsertRowid);
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, is_builtin, created_at, updated_at)
      VALUES ('demo-central-context-role', '中央 context 集成角色', 'active', 0, ?, ?)`)
      .run(now, now).lastInsertRowid);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(userId, roleId, now);
    const permissionCodes = new Set(['system:demo:download']);
    TEST_CASES.forEach((testCase) => {
      const registration = getDemoArtifactRegistration(testCase.artifactKey);
      assert(registration, `缺少 artifact 注册 ${testCase.artifactKey}`);
      permissionCodes.add(registration.permissions.download);
      permissionCodes.add(registration.permissions.preview);
      permissionCodes.add(registration.permissions.execute);
    });
    const insertRoleMenu = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `隔离数据库缺少权限菜单 ${permissionCode}`);
      insertRoleMenu.run(roleId, menu.id, now);
    });
    return { userId, username: 'demo-central-context-user', password: 'Password123!' };
  } finally {
    db.close();
  }
}

/** 为 24、25 组插入最小真实依赖主数据。 */
function seedBundleDependencies() {
  const db = openDatabase();
  try {
    const parkId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('QL-PARK', '青岚智造园区', '/QL-PARK', 'enterprise', 'active')`).run().lastInsertRowid);
    const workshopId = Number(db.prepare(`INSERT INTO organization_units
      (parent_id, unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, 'QL-WORKSHOP-A', '精密制造一车间', '/QL-PARK/QL-WORKSHOP-A', 'workshop', 'active')`).run(parkId).lastInsertRowid);
    const modelId = Number(db.prepare(`INSERT INTO energy_flow_models
      (model_code, model_name, source, document_no, version, effective_start_utc,
       effective_end_utc, source_timezone, status)
      VALUES ('QL-FLOW-PARK', '青岚园区综合能流模型', '青岚园区能源审计', 'QL-FLOW-2026-01',
        'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run().lastInsertRowid);
    const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`);
    insertNode.run(modelId, 'QL-NODE-GRID', '电网输入', 'source', parkId, 80, 120);
    insertNode.run(modelId, 'QL-NODE-WSA', '一车间负荷', 'sink', workshopId, 360, 120);
  } finally {
    db.close();
  }
}

/** 从当前 context 查询状态、上传摘要和绑定批次角色。 */
function readContextState(contextId) {
  const db = openDatabase();
  try {
    const context = db.prepare(`SELECT status, artifact_file_sha256 AS artifactFileSha256,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt
      FROM demo_import_contexts WHERE context_id = ?`).get(contextId);
    const bindings = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
      FROM demo_run_import_batches WHERE context_id = ? ORDER BY batch_role, import_batch_id`).all(contextId);
    return { context, bindings };
  } finally {
    db.close();
  }
}

/** 根据下载响应中的一次性 token 读取隔离库 context 主键与状态。 */
function readContextStateByToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const db = openDatabase();
  let contextId;
  try {
    const row = db.prepare('SELECT context_id AS contextId FROM demo_import_contexts WHERE token_hash = ?').get(tokenHash);
    assert(row, '真实下载必须在隔离库签发可查询的 context。');
    contextId = row.contextId;
  } finally {
    db.close();
  }
  return { contextId, ...readContextState(contextId) };
}

/** 读取 managed 下载自动激活后的 runtime、run、context 与专用审计摘要。 */
function readManagedDownloadGovernance() {
  const db = openDatabase();
  try {
    return {
      runtime: db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch, revision, change_reason AS changeReason
        FROM demo_runtime_settings WHERE id = 1`).get(),
      runCount: db.prepare("SELECT COUNT(*) AS total FROM demo_dataset_runs WHERE status = 'active'").get().total,
      contextCount: db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total,
      autoEnableAuditCount: db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.auto-enable'").get().total
    };
  } finally {
    db.close();
  }
}

/** 为单批次或双批次预演结果构造真实最小 execute 请求。 */
function buildExecuteBody(testCase, preview) {
  if (testCase.artifactKey === '24-energy-flow-edges') {
    return {
      edgeBatchId: preview.edgeBatchId,
      recordBatchId: preview.recordBatchId,
      confirmText: preview.confirmText,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    };
  }
  if (testCase.artifactKey === '25-energy-balance-configs') {
    return {
      boundaryBatchId: preview.boundaryBatchId,
      itemBatchId: preview.itemBatchId,
      confirmText: preview.confirmText,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    };
  }
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 返回预演创建的全部批次 ID。 */
function getPreviewBatchIds(testCase, preview) {
  if (testCase.artifactKey === '24-energy-flow-edges') return [preview.edgeBatchId, preview.recordBatchId];
  if (testCase.artifactKey === '25-energy-balance-configs') return [preview.boundaryBatchId, preview.itemBatchId];
  return [preview.batchId];
}

/** 断言 execute 真实重读持久文件：篡改拒绝且 context 保持 previewed，恢复后可成功。 */
async function assertPersistentFileReread(server, token, demoContextToken, testCase, preview, contextId) {
  const batchId = getPreviewBatchIds(testCase, preview)[0];
  const batch = getImportAuditBatchDetail(batchId, { includeIssues: false });
  const retainedPath = path.join(process.env.UPLOADS_DIR, batch.storedFilename);
  const originalBuffer = fs.readFileSync(retainedPath);
  fs.appendFileSync(retainedPath, Buffer.from([0]));
  const rejected = await request(server, 'POST', testCase.executePath, {
    token,
    headers: { 'X-Demo-Context': demoContextToken },
    body: buildExecuteBody(testCase, preview)
  });
  assert(rejected.status >= 400 && rejected.status < 500, `${testCase.label} 持久文件篡改必须被 4xx 拒绝：${rejected.text}`);
  assert(['ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH', 'BAD_REQUEST'].includes(rejected.body?.error?.code), `${testCase.label} 篡改错误顶层码异常：${rejected.text}`);
  const afterReject = readContextState(contextId);
  assert.strictEqual(afterReject.context.status, 'previewed', `${testCase.label} 篡改拒绝后 context 必须保持 previewed。`);
  getPreviewBatchIds(testCase, preview).forEach((id) => {
    const audit = getImportAuditBatchDetail(id, { includeIssues: false });
    assert.strictEqual(audit.auditPhase, 'preview', `${testCase.label} 篡改拒绝不得污染批次 ${id}。`);
  });
  fs.writeFileSync(retainedPath, originalBuffer);
}

/** 断言业务表、统一审计和操作审计均反映真实执行。 */
function assertDatabaseEffects(testCase, preview, userId) {
  const batchIds = getPreviewBatchIds(testCase, preview);
  const db = openDatabase();
  try {
    const placeholders = batchIds.map(() => '?').join(', ');
    const audits = db.prepare(`SELECT id, import_type AS importType, audit_phase AS auditPhase,
      status, success_count AS successCount, execute_result_json AS executeResultJson
      FROM import_batches WHERE id IN (${placeholders}) ORDER BY id`).all(...batchIds);
    assert.strictEqual(audits.length, batchIds.length, `${testCase.label} 必须保留全部 import_batches。`);
    assert.deepStrictEqual(audits.map((row) => row.importType).sort(), [...testCase.expectedImportTypes].sort());
    assert(audits.every((row) => row.auditPhase === 'execute'), `${testCase.label} 批次必须进入 execute。`);
    assert(audits.every((row) => ['completed', 'completed_with_errors'].includes(row.status)), `${testCase.label} 批次必须成功完成。`);
    assert(audits.every((row) => Number(row.successCount) > 0), `${testCase.label} 每个角色必须写入业务记录。`);
    assert(audits.every((row) => JSON.parse(row.executeResultJson).executed === true), `${testCase.label} execute_result_json 必须记录 executed=true。`);

    if (testCase.expectedBusinessTable) {
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM ${testCase.expectedBusinessTable} WHERE source_batch_id = ?`).get(batchIds[0]).total > 0, true);
    } else if (testCase.artifactKey === '24-energy-flow-edges') {
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_edges WHERE source_batch_id = ?').get(preview.edgeBatchId).total, 1);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_records WHERE source_batch_id = ?').get(preview.recordBatchId).total, 1);
    } else {
      const boundary = db.prepare("SELECT id FROM energy_balance_boundaries WHERE boundary_code = 'QL-BAL-PARK' AND version = 'QL-BAL:v1'").get();
      assert(boundary, 'Balance bundle 必须写入稳定边界编码和版本。');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_balance_items WHERE energy_balance_boundary_id = ?').get(boundary.id).total > 0, true);
    }

    const auditOperations = db.prepare(`SELECT operation, user_id AS userId FROM sys_operation_logs
      WHERE user_id = ? ORDER BY id`).all(userId);
    assert(auditOperations.length > 0, `${testCase.label} 必须产生真实 sys_operation_logs 审计。`);
    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], `${testCase.label} 执行后外键检查必须为空。`);
  } finally {
    db.close();
  }
}

/** 从真实 managed 下载开始执行一组中央 context HTTP preview/execute 集成测试。 */
async function runCase(server, token, userId, testCase) {
  const registration = getDemoArtifactRegistration(testCase.artifactKey);
  assert(registration, `${testCase.label} 必须存在 artifact 注册。`);

  const downloadResponse = await request(
    server,
    'GET',
    `/api/templates/demo-park/${testCase.artifactKey}.xlsx`,
    { token }
  );
  assert.strictEqual(downloadResponse.status, 200, `${testCase.label} 下载失败：${downloadResponse.text}`);
  assert(downloadResponse.buffer.length > 0, `${testCase.label} 下载文件不能为空。`);
  const issuedToken = String(downloadResponse.headers['x-demo-context'] || '');
  const artifactSha = sha256Buffer(downloadResponse.buffer);
  assert(/^[A-Za-z0-9_-]{43}$/.test(issuedToken), `${testCase.label} 必须返回一次性 X-Demo-Context。`);
  assert.strictEqual(downloadResponse.headers['x-demo-artifact-key'], testCase.artifactKey);
  assert.strictEqual(downloadResponse.headers['x-demo-handler-key'], registration.handlerKey);
  assert.strictEqual(downloadResponse.headers['x-demo-artifact-sha256'], artifactSha);

  const issued = readContextStateByToken(issuedToken);
  assert.strictEqual(issued.context.status, 'issued');
  assert.strictEqual(issued.context.artifactFileSha256, artifactSha);

  const previewResponse = await requestMultipart(
    server,
    testCase.previewPath,
    token,
    issuedToken,
    `${testCase.artifactKey}.xlsx`,
    downloadResponse.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `${testCase.label} preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert(/^hmac-sha256:v1:audit:[a-f0-9]{64}$/.test(preview.previewAuditDigest), `${testCase.label} 必须返回完整 previewAuditDigest。`);
  assert(Number(preview.expectedWouldImport) > 0, `${testCase.label} preview 必须产生真实候选。`);

  const afterPreview = readContextState(issued.contextId);
  assert.strictEqual(afterPreview.context.status, 'previewed', `${testCase.label} context 必须 issued→previewed。`);
  assert.strictEqual(afterPreview.context.artifactFileSha256, artifactSha);
  assert.strictEqual(afterPreview.context.uploadFileSha256, artifactSha);
  assert.strictEqual(afterPreview.context.previewDigest, preview.previewAuditDigest);
  assert(afterPreview.context.previewedAt);
  assert.deepStrictEqual(afterPreview.bindings.map((binding) => binding.batchRole).sort(), [...testCase.expectedRoles].sort());
  assert.deepStrictEqual(afterPreview.bindings.map((binding) => binding.batchId).sort((a, b) => a - b), getPreviewBatchIds(testCase, preview).sort((a, b) => a - b));

  await assertPersistentFileReread(server, token, issuedToken, testCase, preview, issued.contextId);

  const executeResponse = await request(server, 'POST', testCase.executePath, {
    token,
    headers: { 'X-Demo-Context': issuedToken },
    body: buildExecuteBody(testCase, preview)
  });
  assert.strictEqual(executeResponse.status, 200, `${testCase.label} execute 失败：${executeResponse.text}`);
  assert.strictEqual(executeResponse.body.success, true);
  assert.strictEqual(executeResponse.body.data.executed, true);

  const afterExecute = readContextState(issued.contextId);
  assert.strictEqual(afterExecute.context.status, 'executed', `${testCase.label} context 必须 previewed→executed。`);
  assert(afterExecute.context.executedAt);
  assert.deepStrictEqual(afterExecute.bindings.map((binding) => binding.batchRole).sort(), [...testCase.expectedRoles].sort());
  assertDatabaseEffects(testCase, preview, userId);
}

(async () => {
  let server = null;
  try {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
    initDatabase();
    const authorizedUser = createAuthorizedUser();
    seedBundleDependencies();
    const initialGovernance = readManagedDownloadGovernance();
    assert.strictEqual(initialGovernance.runtime.enabled, 0, 'managed 下载前 runtime 必须保持初始关闭。');
    assert.strictEqual(initialGovernance.runCount, 0, 'managed 下载前不得预建 active run。');
    assert.strictEqual(initialGovernance.contextCount, 0, 'managed 下载前不得预签发 context。');
    assert.strictEqual(initialGovernance.autoEnableAuditCount, 0, 'managed 下载前不得存在自动激活审计。');

    const token = login({ username: authorizedUser.username, password: authorizedUser.password }).token;
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    for (const testCase of TEST_CASES) {
      await runCase(server, token, authorizedUser.userId, testCase);
    }

    const finalGovernance = readManagedDownloadGovernance();
    assert.strictEqual(finalGovernance.runtime.enabled, 1, '首个 managed 下载必须自动开启 runtime。');
    assert.strictEqual(finalGovernance.runtime.changeReason, 'managed_download_auto_enable');
    assert.strictEqual(finalGovernance.runtime.runtimeEpoch, initialGovernance.runtime.runtimeEpoch + 1);
    assert.strictEqual(finalGovernance.runtime.revision, initialGovernance.runtime.revision + 1);
    assert.strictEqual(finalGovernance.runCount, 1, '四次 managed 下载必须复用同一 active run。');
    assert.strictEqual(finalGovernance.contextCount, TEST_CASES.length, '每个真实下载必须只签发一个 context。');
    assert.strictEqual(finalGovernance.autoEnableAuditCount, 1, '重复 managed 下载不得重复自动激活或重复审计。');

    console.log('demo central context integration tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
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
