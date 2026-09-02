'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 本测试只使用系统临时目录、隔离 SQLite 与随机本机端口，不读取或修改真实业务数据库。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-monthly-energy-managed-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'managed-direct.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { createDemoContext } = require('../services/demoContextService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { createImportBatchFromUpload } = require('../services/importService');
const demoOwnershipService = require('../services/demoOwnershipService');
const { runWithDemoOwnershipTransaction } = demoOwnershipService;
const { runWithMaintenance } = require('../services/maintenanceState');

// Artifact 07 服务端固定绑定，测试不得通过请求正文提交治理字段。
const MONTHLY_ENERGY_BINDING = Object.freeze({
  artifactKey: '07-monthly-energy',
  handlerKey: 'monthly-energy-import'
});

/** 生成可被正式能耗导入解析的 UTF-8 CSV。 */
function buildEnergyCsv(rows) {
  return Buffer.from([
    '月份,能源类型编码,用量,单位,用能单元编码,计量器具编码,备注',
    ...rows.map((row) => row.join(','))
  ].join('\n'), 'utf8');
}

/** 对内存字节计算 canonical SHA-256。 */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 构造单文件 multipart 请求体。 */
function createMultipart(buffer, filename = '07-monthly-energy.csv') {
  const boundary = `----charcoal-monthly-energy-${crypto.randomUUID()}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
  };
}

/** 发起本机 HTTP 请求并解析统一 JSON 响应。 */
function request(server, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : (options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8'));
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

/** 通过正式 multipart 路由提交能耗文件，可选携带唯一 demo context header。 */
function postEnergyImport(server, token, buffer, demoContextToken) {
  const multipart = createMultipart(buffer);
  const headers = { 'Content-Type': `multipart/form-data; boundary=${multipart.boundary}` };
  if (demoContextToken) headers['X-Demo-Context'] = demoContextToken;
  return request(server, 'POST', '/api/imports/batches', {
    token,
    headers,
    rawBody: multipart.body
  });
}

/** 读取隔离上传目录中的持久文件名，用于证明失败与 replay 不留下孤儿文件。 */
function listUploadedImportFiles() {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  return fs.readdirSync(process.env.UPLOADS_DIR).sort();
}

/** 断言批次持久引用的原上传文件仍存在。 */
function assertBatchStoredFileExists(batchId) {
  const db = openDatabase();
  try {
    const batch = db.prepare('SELECT stored_filename AS storedFilename FROM import_batches WHERE id = ?')
      .get(batchId);
    assert(batch?.storedFilename, `批次 ${batchId} 必须持久引用原上传文件。`);
    assert(fs.existsSync(path.join(process.env.UPLOADS_DIR, batch.storedFilename)),
      `批次 ${batchId} 的原上传文件必须保留。`);
  } finally {
    db.close();
  }
}

/** 读取治理闭包涉及的写表计数，证明 context 失败不会降级为正式导入。 */
function snapshotManagedWriteCounts() {
  const db = openDatabase();
  try {
    return {
      batches: Number(db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total),
      issues: Number(db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total),
      energyRecords: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total),
      batchBindings: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches').get().total),
      ownership: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total),
      executedContexts: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_import_contexts WHERE status = 'executed'").get().total)
    };
  } finally {
    db.close();
  }
}

/** 写入服务直接调用所需的受控临时上传文件描述。 */
function createServiceUpload(buffer, label) {
  const directory = path.join(temporaryRoot, 'service-uploads');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${label}.csv`;
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, buffer);
  return {
    path: filePath,
    originalname: filename,
    filename,
    size: buffer.length
  };
}

/** 签发绑定当前 active run、actor、manifest、epoch 与指定文件 SHA 的一次性 context。 */
function issueContext(actorUserId, runId, buffer, binding = MONTHLY_ENERGY_BINDING, ttlMs) {
  return createDemoContext({
    userId: actorUserId,
    runId,
    artifactKey: binding.artifactKey,
    handlerKey: binding.handlerKey,
    artifactFileSha256: sha256Buffer(buffer),
    ...(ttlMs === undefined ? {} : { ttlMs })
  });
}

/** 断言失败请求没有创建 batch、记录、绑定、ownership 或 executed 事实。 */
async function assertManagedFailureWithoutFallback(server, adminToken, buffer, contextToken, expectedCodes) {
  const before = snapshotManagedWriteCounts();
  const uploadedFilesBefore = listUploadedImportFiles();
  const response = await postEnergyImport(server, adminToken, buffer, contextToken);
  assert(expectedCodes.includes(response.body?.error?.code),
    `预期 ${expectedCodes.join('/')}，实际 ${JSON.stringify(response.body)}`);
  assert([400, 403, 409, 410, 423].includes(response.status), `managed 绑定失败必须返回明确 4xx，实际 ${response.status}`);
  assert.deepStrictEqual(snapshotManagedWriteCounts(), before, 'context 失败不得降级为普通导入或留下半套治理事实。');
  assert.deepStrictEqual(listUploadedImportFiles(), uploadedFilesBefore, 'managed 失败后上传目录不得留下孤立文件。');
  return response;
}

/** 先通过路由维护态门禁，再在 multipart 尚未结束时开启维护，稳定覆盖上传后第二门禁。 */
async function postEnergyImportDuringMaintenance(server, token, buffer, demoContextToken) {
  const multipart = createMultipart(buffer, '07-monthly-energy-maintenance.csv');
  const splitOffset = Math.max(1, multipart.body.length - 32);
  let clientRequest;
  const responsePromise = new Promise((resolve, reject) => {
    clientRequest = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/api/imports/batches',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Demo-Context': demoContextToken,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        'Content-Length': String(multipart.body.length)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseBuffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          body: responseBuffer.length > 0 ? JSON.parse(responseBuffer.toString('utf8')) : null
        });
      });
    });
    clientRequest.on('error', reject);
  });
  clientRequest.write(multipart.body.subarray(0, splitOffset));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return runWithMaintenance('test-managed-upload-race', async () => {
    clientRequest.end(multipart.body.subarray(splitOffset));
    return responsePromise;
  }, { source: 'isolated-test' });
}

/** 创建一份只含一条新业务行的完整 managed terminal fixture。 */
async function createManagedClosureFixture(server, adminToken, adminUserId, runId, sequence) {
  const year = 2040 + sequence;
  const buffer = buildEnergyCsv([
    [`${year}-01`, 'electricity', String(300 + sequence), 'kWh', 'DEMO-ORG', '', `closure-${sequence}`]
  ]);
  const context = issueContext(adminUserId, runId, buffer);
  const response = await postEnergyImport(server, adminToken, buffer, context.token);
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  assert.strictEqual(response.body.data.terminalReplay, false);
  return {
    buffer,
    context,
    batchId: Number(response.body.data.id)
  };
}

/** 篡改 terminal closure 后断言 replay 稳定 fail-closed 且新上传文件被清理。 */
async function assertTamperedReplayRejected(server, adminToken, fixture, mutateClosure) {
  const db = openDatabase();
  try {
    mutateClosure(db, fixture);
  } finally {
    db.close();
  }
  const countsAfterTamper = snapshotManagedWriteCounts();
  const uploadedFilesAfterTamper = listUploadedImportFiles();
  const response = await postEnergyImport(server, adminToken, fixture.buffer, fixture.context.token);
  assert.strictEqual(response.status, 409, JSON.stringify(response.body));
  assert.strictEqual(response.body?.error?.code, 'DEMO_MANAGED_DIRECT_CLOSURE_INVALID', JSON.stringify(response.body));
  assert.deepStrictEqual(snapshotManagedWriteCounts(), countsAfterTamper, 'replay 拒绝不得继续修改任何治理或业务事实。');
  assert.deepStrictEqual(listUploadedImportFiles(), uploadedFilesAfterTamper, 'replay 拒绝后本次新上传文件必须清理。');
}

(async () => {
  let server;
  try {
    initDatabase();
    const seedDb = openDatabase();
    const admin = seedDb.prepare("SELECT id, password_hash AS passwordHash FROM sys_users WHERE username = 'admin'").get();
    assert(admin && Number.isSafeInteger(Number(admin.id)), '隔离数据库必须初始化内置管理员。');
    const adminUserId = Number(admin.id);
    // Artifact 07 operation 字符串不得成为模块公共导出，通用 scope 也不得重新挂载 Symbol 写协议。
    assert.strictEqual(
      Object.values(demoOwnershipService).includes('artifact-07-managed-direct:v1'),
      false,
      'demoOwnershipService 不得公开导出 Artifact 07 operation 字符串。'
    );
    runWithDemoOwnershipTransaction(process.env.SQLITE_PATH, (transactionScope) => {
      assert.deepStrictEqual(Object.getOwnPropertySymbols(transactionScope), [], '通用 ownership scope 不得暴露 Symbol 写协议。');
      assert.deepStrictEqual(Object.keys(transactionScope).sort(), ['db', 'facade']);
    });
    // actor mismatch 必须引用真实 active 用户，避免外键先于 managed 校验截断测试语义。
    const actorMismatchUserId = Number(seedDb.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, is_builtin)
      VALUES ('managed-direct-other-actor', 'Managed Direct Other Actor', ?, 'active', 0)`)
      .run(admin.passwordHash).lastInsertRowid);
    seedDb.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('DEMO-ORG', '演示组织', '演示组织', 'enterprise', 'active')`).run();
    seedDb.close();

    toggleDemoRuntime({ enabled: true, actorUserId: adminUserId, actorIp: '127.0.0.1' });
    const run = getOrCreateActiveDemoDatasetRun({ actorUserId: adminUserId });
    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const loginResponse = await request(server, 'POST', '/api/login', {
      body: { username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }
    });
    assert.strictEqual(loginResponse.status, 200, JSON.stringify(loginResponse.body));
    const adminToken = loginResponse.body.data.token;

    // 普通无 context direct import 保持原响应、记录与无治理副作用语义。
    const formalBuffer = buildEnergyCsv([
      ['2026-01', 'electricity', '100', 'kWh', 'DEMO-ORG', '', 'formal baseline']
    ]);
    const formalResponse = await postEnergyImport(server, adminToken, formalBuffer, null);
    assert.strictEqual(formalResponse.status, 201, JSON.stringify(formalResponse.body));
    assert.strictEqual(formalResponse.body.data.status, 'completed');
    assert.strictEqual(formalResponse.body.data.summary.successCount, 1);
    assert.strictEqual(formalResponse.body.data.terminalReplay, undefined);
    assert.deepStrictEqual(snapshotManagedWriteCounts(), {
      batches: 1,
      issues: 0,
      energyRecords: 1,
      batchBindings: 0,
      ownership: 0,
      executedContexts: 0
    });
    assertBatchStoredFileExists(formalResponse.body.data.id);

    // 普通处理失败仍保留 failed batch 与 error 明细，不改写既有 wrapper 语义。
    const emptyBuffer = Buffer.from('月份,能源类型编码,用量,单位,用能单元编码,计量器具编码,备注\n', 'utf8');
    const failedFormalResponse = await postEnergyImport(server, adminToken, emptyBuffer, null);
    assert.strictEqual(failedFormalResponse.status, 201, JSON.stringify(failedFormalResponse.body));
    assert.strictEqual(failedFormalResponse.body.data.status, 'failed');
    assert.strictEqual(failedFormalResponse.body.data.summary.validationErrorCount, 1);
    const failedFormalDb = openDatabase();
    assert.strictEqual(
      failedFormalDb.prepare('SELECT status FROM import_batches WHERE id = ?').get(failedFormalResponse.body.data.id).status,
      'failed'
    );
    assert.strictEqual(
      failedFormalDb.prepare('SELECT error_code AS errorCode FROM import_errors WHERE batch_id = ?').get(failedFormalResponse.body.data.id).errorCode,
      'EMPTY_IMPORT_FILE'
    );
    failedFormalDb.close();
    assertBatchStoredFileExists(failedFormalResponse.body.data.id);

    // 合法 Artifact 07 managed direct 同时覆盖 inserted、skipped 与 failed 行，ownership 只登记实际插入行。
    const managedBuffer = buildEnergyCsv([
      ['2026-01', 'electricity', '100', 'kWh', 'DEMO-ORG', '', 'duplicate skipped'],
      ['2026-02', 'electricity', '220', 'kWh', 'DEMO-ORG', '', 'managed inserted'],
      ['2026-03', 'electricity', 'not-a-number', 'kWh', 'DEMO-ORG', '', 'validation failed']
    ]);
    const managedContext = issueContext(adminUserId, run.runId, managedBuffer);
    const managedResponse = await postEnergyImport(server, adminToken, managedBuffer, managedContext.token);
    assert.strictEqual(managedResponse.status, 201, JSON.stringify(managedResponse.body));
    const managedBatch = managedResponse.body.data;
    assert.strictEqual(managedBatch.status, 'completed_with_errors');
    assert.strictEqual(managedBatch.terminalReplay, false);
    assert.deepStrictEqual(managedBatch.summary, {
      batchId: managedBatch.id,
      status: 'completed_with_errors',
      totalRows: 3,
      successCount: 1,
      failureCount: 1,
      skippedCount: 1,
      validationErrorCount: 1
    });
    const managedDb = openDatabase();
    const managedAudit = managedDb.prepare(`SELECT audit_phase AS auditPhase,
        preview_audit_digest AS previewDigest, execute_result_json AS executeResultJson
      FROM import_batches WHERE id = ?`).get(managedBatch.id);
    assert.strictEqual(managedAudit.auditPhase, 'execute');
    assert(/^hmac-sha256:v1:audit:[a-f0-9]{64}$/.test(managedAudit.previewDigest));
    const executeResult = JSON.parse(managedAudit.executeResultJson);
    assert.strictEqual(executeResult.executed, true);
    assert.strictEqual(executeResult.writesBusinessRecords, true);
    assert.deepStrictEqual(executeResult.statistics, {
      totalRows: 3,
      successCount: 1,
      failureCount: 1,
      skippedCount: 1
    });
    const managedRecords = managedDb.prepare(`SELECT id, source_row_number AS sourceRowNumber
      FROM energy_records WHERE source_batch_id = ? ORDER BY id`).all(managedBatch.id);
    assert.strictEqual(managedRecords.length, 1, 'managed batch 只能包含本次真实插入的业务行。');
    assert.strictEqual(managedRecords[0].sourceRowNumber, 3);
    const managedBinding = managedDb.prepare(`SELECT run_id AS runId, artifact_key AS artifactKey,
        context_id AS contextId, batch_role AS batchRole
      FROM demo_run_import_batches WHERE import_batch_id = ?`).get(managedBatch.id);
    assert.deepStrictEqual(managedBinding, {
      runId: run.runId,
      artifactKey: MONTHLY_ENERGY_BINDING.artifactKey,
      contextId: managedContext.contextId,
      batchRole: 'primary'
    });
    const managedOwnership = managedDb.prepare(`SELECT run_id AS runId, artifact_key AS artifactKey,
        entity_type AS entityType, entity_pk AS entityPk, ownership_kind AS ownershipKind,
        source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
      FROM demo_data_registry WHERE source_batch_id = ?`).all(managedBatch.id);
    assert.deepStrictEqual(managedOwnership, [{
      runId: run.runId,
      artifactKey: MONTHLY_ENERGY_BINDING.artifactKey,
      entityType: 'energy_record',
      entityPk: String(managedRecords[0].id),
      ownershipKind: 'imported',
      sourceBatchId: managedBatch.id,
      sourceRowNumber: 3
    }]);
    assert.strictEqual(
      managedDb.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(managedContext.contextId).status,
      'executed'
    );
    assert.deepStrictEqual(
      managedDb.prepare(`SELECT severity, error_code AS errorCode, row_number AS rowNumber
        FROM import_errors WHERE batch_id = ? ORDER BY row_number`).all(managedBatch.id),
      [
        { severity: 'warning', errorCode: 'DUPLICATE_SKIPPED', rowNumber: 2 },
        { severity: 'error', errorCode: 'INVALID_VALUE', rowNumber: 4 }
      ]
    );
    managedDb.close();
    assertBatchStoredFileExists(managedBatch.id);

    // 相同 context 与文件只读回放原批次，不创建第二批记录、binding、ownership 或孤立上传。
    const replayBefore = snapshotManagedWriteCounts();
    const replayUploadedFilesBefore = listUploadedImportFiles();
    const replayResponse = await postEnergyImport(server, adminToken, managedBuffer, managedContext.token);
    assert.strictEqual(replayResponse.status, 201, JSON.stringify(replayResponse.body));
    assert.strictEqual(replayResponse.body.data.id, managedBatch.id);
    assert.strictEqual(replayResponse.body.data.terminalReplay, true);
    assert.deepStrictEqual(snapshotManagedWriteCounts(), replayBefore);
    assert.deepStrictEqual(listUploadedImportFiles(), replayUploadedFilesBefore, 'terminal replay 必须清理本次新上传文件。');

    // 全部重复 skip 是合法零新增闭包：执行 context、保留唯一 binding，但不创建业务行或 ownership。
    const noBusinessBuffer = buildEnergyCsv([
      ['2026-01', 'electricity', '100', 'kWh', 'DEMO-ORG', '', 'duplicate-only closure 1'],
      ['2026-01', 'electricity', '100', 'kWh', 'DEMO-ORG', '', 'duplicate-only closure 2']
    ]);
    const noBusinessContext = issueContext(adminUserId, run.runId, noBusinessBuffer);
    const noBusinessResponse = await postEnergyImport(server, adminToken, noBusinessBuffer, noBusinessContext.token);
    assert.strictEqual(noBusinessResponse.status, 201, JSON.stringify(noBusinessResponse.body));
    const noBusinessBatch = noBusinessResponse.body.data;
    assert.strictEqual(noBusinessBatch.status, 'completed_with_errors');
    assert.strictEqual(noBusinessBatch.terminalReplay, false);
    assert.deepStrictEqual(noBusinessBatch.summary, {
      batchId: noBusinessBatch.id,
      status: 'completed_with_errors',
      totalRows: 2,
      successCount: 0,
      failureCount: 0,
      skippedCount: 2,
      validationErrorCount: 0
    });
    const noBusinessDb = openDatabase();
    const noBusinessAudit = noBusinessDb.prepare(`SELECT execute_result_json AS executeResultJson
      FROM import_batches WHERE id = ?`).get(noBusinessBatch.id);
    const noBusinessExecuteResult = JSON.parse(noBusinessAudit.executeResultJson);
    assert.strictEqual(noBusinessExecuteResult.writesBusinessRecords, false);
    assert.deepStrictEqual(noBusinessExecuteResult.statistics, {
      totalRows: 2,
      successCount: 0,
      failureCount: 0,
      skippedCount: 2
    });
    assert.strictEqual(noBusinessExecuteResult.ownership.noInsertedRecords, true);
    assert.strictEqual(noBusinessExecuteResult.ownership.registrationCount, 0);
    assert.strictEqual(noBusinessExecuteResult.ownership.insertedCount, 0);
    assert.strictEqual(noBusinessExecuteResult.ownership.skippedCount, 2);
    assert(/^[a-f0-9]{64}$/.test(noBusinessExecuteResult.ownership.closureDigest));
    assert.strictEqual(
      noBusinessDb.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(noBusinessContext.contextId).status,
      'executed'
    );
    assert.strictEqual(
      noBusinessDb.prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches WHERE context_id = ?').get(noBusinessContext.contextId).total,
      1
    );
    assert.strictEqual(
      noBusinessDb.prepare('SELECT COUNT(*) AS total FROM energy_records WHERE source_batch_id = ?').get(noBusinessBatch.id).total,
      0
    );
    assert.strictEqual(
      noBusinessDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(noBusinessBatch.id).total,
      0
    );
    assert.deepStrictEqual(
      noBusinessDb.prepare(`SELECT row_number AS rowNumber, severity, error_code AS errorCode
        FROM import_errors WHERE batch_id = ? ORDER BY row_number`).all(noBusinessBatch.id),
      [
        { rowNumber: 2, severity: 'warning', errorCode: 'DUPLICATE_SKIPPED' },
        { rowNumber: 3, severity: 'warning', errorCode: 'DUPLICATE_SKIPPED' }
      ]
    );
    noBusinessDb.close();
    assertBatchStoredFileExists(noBusinessBatch.id);

    // 零新增 terminal 同 context replay 返回原批次，且清理本次新上传文件。
    const noBusinessReplayCountsBefore = snapshotManagedWriteCounts();
    const noBusinessReplayFilesBefore = listUploadedImportFiles();
    const noBusinessReplay = await postEnergyImport(server, adminToken, noBusinessBuffer, noBusinessContext.token);
    assert.strictEqual(noBusinessReplay.status, 201, JSON.stringify(noBusinessReplay.body));
    assert.strictEqual(noBusinessReplay.body.data.id, noBusinessBatch.id);
    assert.strictEqual(noBusinessReplay.body.data.terminalReplay, true);
    assert.deepStrictEqual(snapshotManagedWriteCounts(), noBusinessReplayCountsBefore);
    assert.deepStrictEqual(listUploadedImportFiles(), noBusinessReplayFilesBefore);

    // 空文件与全部 validation failed 均不得伪装成合法全 skip terminal。
    const managedEmptyContext = issueContext(adminUserId, run.runId, emptyBuffer);
    await assertManagedFailureWithoutFallback(server, adminToken, emptyBuffer, managedEmptyContext.token, [
      'DEMO_MANAGED_DIRECT_IMPORT_REJECTED'
    ]);
    const allValidationFailedBuffer = buildEnergyCsv([
      ['2026-07', 'electricity', 'not-a-number', 'kWh', 'DEMO-ORG', '', 'validation-only']
    ]);
    const allValidationFailedContext = issueContext(adminUserId, run.runId, allValidationFailedBuffer);
    await assertManagedFailureWithoutFallback(
      server,
      adminToken,
      allValidationFailedBuffer,
      allValidationFailedContext.token,
      ['DEMO_MANAGED_DIRECT_CLOSURE_INVALID']
    );

    // 错 artifact：其它 artifact 签发的 token 不得被 Artifact 07 路由吸收为普通导入。
    const wrongArtifactContext = issueContext(adminUserId, run.runId, managedBuffer, {
      artifactKey: '08-meter-readings-2026-08',
      handlerKey: 'meter-readings-import'
    });
    await assertManagedFailureWithoutFallback(server, adminToken, managedBuffer, wrongArtifactContext.token, [
      'DEMO_CONTEXT_BINDING_MISMATCH'
    ]);

    // 错 handler：即便 token 存在，持久 context handler 漂移也必须 fail-closed。
    const wrongHandlerContext = issueContext(adminUserId, run.runId, managedBuffer);
    const wrongHandlerDb = openDatabase();
    wrongHandlerDb.prepare("UPDATE demo_import_contexts SET handler_key = 'meter-readings-import' WHERE context_id = ?")
      .run(wrongHandlerContext.contextId);
    wrongHandlerDb.close();
    await assertManagedFailureWithoutFallback(server, adminToken, managedBuffer, wrongHandlerContext.token, [
      'DEMO_CONTEXT_BINDING_MISMATCH'
    ]);

    // 错 actor：路由固定使用当前登录用户，不能由请求正文覆盖为 context 原 actor。
    const wrongActorContext = issueContext(adminUserId, run.runId, managedBuffer);
    const wrongActorDb = openDatabase();
    wrongActorDb.prepare('UPDATE demo_import_contexts SET issued_to_user_id = ? WHERE context_id = ?')
      .run(actorMismatchUserId, wrongActorContext.contextId);
    wrongActorDb.close();
    await assertManagedFailureWithoutFallback(server, adminToken, managedBuffer, wrongActorContext.token, [
      'DEMO_CONTEXT_BINDING_MISMATCH'
    ]);

    // 错 runtime epoch：切换开关提升 epoch 后，旧 context 不得继续执行。
    const staleRuntimeContext = issueContext(adminUserId, run.runId, managedBuffer);
    toggleDemoRuntime({ enabled: false, actorUserId: adminUserId, actorIp: '127.0.0.1' });
    toggleDemoRuntime({ enabled: true, actorUserId: adminUserId, actorIp: '127.0.0.1' });
    await assertManagedFailureWithoutFallback(server, adminToken, managedBuffer, staleRuntimeContext.token, [
      'DEMO_CONTEXT_BINDING_MISMATCH'
    ]);

    // 错 manifest：context 持久摘要与当前 run 不一致时不得写入 batch。
    const wrongManifestContext = issueContext(adminUserId, run.runId, managedBuffer);
    const wrongManifestDb = openDatabase();
    wrongManifestDb.prepare('UPDATE demo_import_contexts SET manifest_digest = ? WHERE context_id = ?')
      .run('0'.repeat(64), wrongManifestContext.contextId);
    wrongManifestDb.close();
    await assertManagedFailureWithoutFallback(server, adminToken, managedBuffer, wrongManifestContext.token, [
      'DEMO_CONTEXT_BINDING_MISMATCH'
    ]);

    // 错 SHA：上传文件不是签发时下载原字节时不得降级为正式导入。
    const originalShaBuffer = buildEnergyCsv([
      ['2026-04', 'electricity', '240', 'kWh', 'DEMO-ORG', '', 'original sha']
    ]);
    const alteredShaBuffer = buildEnergyCsv([
      ['2026-04', 'electricity', '241', 'kWh', 'DEMO-ORG', '', 'altered sha']
    ]);
    const wrongShaContext = issueContext(adminUserId, run.runId, originalShaBuffer);
    await assertManagedFailureWithoutFallback(server, adminToken, alteredShaBuffer, wrongShaContext.token, [
      'DEMO_MANAGED_DIRECT_FILE_SHA256_MISMATCH'
    ]);

    // 过期 context 必须拒绝，且 caller-owned 事务不会留下 batch、binding、ownership 或 terminal 事实。
    const expiredContext = issueContext(adminUserId, run.runId, originalShaBuffer);
    const expiredDb = openDatabase();
    expiredDb.prepare(`UPDATE demo_import_contexts
      SET issued_at = ?, expires_at = ?
      WHERE context_id = ?`)
      .run('1999-12-31T23:59:00.000Z', '2000-01-01T00:00:00.000Z', expiredContext.contextId);
    expiredDb.close();
    await assertManagedFailureWithoutFallback(server, adminToken, originalShaBuffer, expiredContext.token, [
      'DEMO_CONTEXT_EXPIRED'
    ]);

    // multipart 开始后进入维护态时，上传后第二门禁必须拒绝并删除当前 managed 孤立文件。
    const maintenanceBuffer = buildEnergyCsv([
      ['2026-06', 'electricity', '260', 'kWh', 'DEMO-ORG', '', 'maintenance-after-upload']
    ]);
    const maintenanceContext = issueContext(adminUserId, run.runId, maintenanceBuffer);
    const maintenanceCountsBefore = snapshotManagedWriteCounts();
    const maintenanceFilesBefore = listUploadedImportFiles();
    const maintenanceResponse = await postEnergyImportDuringMaintenance(
      server,
      adminToken,
      maintenanceBuffer,
      maintenanceContext.token
    );
    assert.strictEqual(maintenanceResponse.status, 423, JSON.stringify(maintenanceResponse.body));
    assert.strictEqual(maintenanceResponse.body?.error?.code, 'MAINTENANCE_IN_PROGRESS');
    assert.deepStrictEqual(snapshotManagedWriteCounts(), maintenanceCountsBefore);
    assert.deepStrictEqual(listUploadedImportFiles(), maintenanceFilesBefore, '上传后维护态失败不得留下孤立文件。');

    // 伪造 consumed 状态但缺少可信批次绑定时，终态回放必须拒绝而不是重跑或降级。
    const consumedContext = issueContext(adminUserId, run.runId, originalShaBuffer);
    const consumedDb = openDatabase();
    consumedDb.prepare("UPDATE demo_import_contexts SET status = 'executed', executed_at = ? WHERE context_id = ?")
      .run(new Date().toISOString(), consumedContext.contextId);
    consumedDb.close();
    await assertManagedFailureWithoutFallback(server, adminToken, originalShaBuffer, consumedContext.token, [
      'DEMO_MANAGED_DIRECT_TERMINAL_BINDING_INVALID'
    ]);

    // ownership 后故障必须整体回滚；同一 issued context 随后可重试并形成唯一完整闭包。
    const faultBuffer = buildEnergyCsv([
      ['2026-05', 'electricity', '250', 'kWh', 'DEMO-ORG', '', 'transaction rollback']
    ]);
    const faultContext = issueContext(adminUserId, run.runId, faultBuffer);
    const faultUpload = createServiceUpload(faultBuffer, 'fault-after-ownership');
    const faultBefore = snapshotManagedWriteCounts();
    assert.throws(
      () => createImportBatchFromUpload(faultUpload, {
        duplicateStrategy: 'skip',
        demoContext: Object.freeze({
          token: faultContext.token,
          userId: adminUserId,
          artifactKey: MONTHLY_ENERGY_BINDING.artifactKey,
          handlerKey: MONTHLY_ENERGY_BINDING.handlerKey
        }),
        managedDirectFaultInjector(stage) {
          if (stage === 'after-ownership') throw new Error('TEST_MANAGED_DIRECT_FAULT');
        }
      }),
      /TEST_MANAGED_DIRECT_FAULT/
    );
    assert.deepStrictEqual(snapshotManagedWriteCounts(), faultBefore, '中途故障必须回滚 batch、记录、binding、ownership 与 executed 状态。');
    const faultStateDb = openDatabase();
    assert.strictEqual(
      faultStateDb.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(faultContext.contextId).status,
      'issued'
    );
    faultStateDb.close();
    const retried = createImportBatchFromUpload(faultUpload, {
      duplicateStrategy: 'skip',
      demoContext: Object.freeze({
        token: faultContext.token,
        userId: adminUserId,
        artifactKey: MONTHLY_ENERGY_BINDING.artifactKey,
        handlerKey: MONTHLY_ENERGY_BINDING.handlerKey
      })
    });
    assert.strictEqual(retried.status, 'completed');
    assert.strictEqual(retried.terminalReplay, false);
    const retryDb = openDatabase();
    assert.strictEqual(retryDb.prepare('SELECT COUNT(*) AS total FROM energy_records WHERE source_batch_id = ?').get(retried.id).total, 1);
    assert.strictEqual(retryDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(retried.id).total, 1);
    assert.strictEqual(retryDb.prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches WHERE import_batch_id = ?').get(retried.id).total, 1);
    assert.strictEqual(retryDb.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(faultContext.contextId).status, 'executed');
    retryDb.close();

    // terminal replay 必须逐项拒绝缺 ownership、缺业务行、悬空 registry、来源与摘要/统计漂移。
    const missingOwnershipFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 1);
    await assertTamperedReplayRejected(server, adminToken, missingOwnershipFixture, (db, fixture) => {
      db.prepare('DELETE FROM demo_data_registry WHERE source_batch_id = ?').run(fixture.batchId);
    });

    const missingBusinessFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 2);
    await assertTamperedReplayRejected(server, adminToken, missingBusinessFixture, (db, fixture) => {
      db.prepare('DELETE FROM energy_records WHERE source_batch_id = ?').run(fixture.batchId);
    });

    const danglingRegistryFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 3);
    await assertTamperedReplayRejected(server, adminToken, danglingRegistryFixture, (db, fixture) => {
      db.prepare("UPDATE demo_data_registry SET entity_pk = '999999999' WHERE source_batch_id = ?")
        .run(fixture.batchId);
    });

    const sourceBatchDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 4);
    await assertTamperedReplayRejected(server, adminToken, sourceBatchDriftFixture, (db, fixture) => {
      db.prepare('UPDATE demo_data_registry SET source_batch_id = ? WHERE source_batch_id = ?')
        .run(formalResponse.body.data.id, fixture.batchId);
    });

    const sourceRowDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 5);
    await assertTamperedReplayRejected(server, adminToken, sourceRowDriftFixture, (db, fixture) => {
      db.prepare('UPDATE demo_data_registry SET source_row_number = source_row_number + 1 WHERE source_batch_id = ?')
        .run(fixture.batchId);
    });

    const identityDigestDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 6);
    await assertTamperedReplayRejected(server, adminToken, identityDigestDriftFixture, (db, fixture) => {
      db.prepare('UPDATE demo_data_registry SET identity_digest = ? WHERE source_batch_id = ?')
        .run('0'.repeat(64), fixture.batchId);
    });

    const snapshotDigestDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 7);
    await assertTamperedReplayRejected(server, adminToken, snapshotDigestDriftFixture, (db, fixture) => {
      db.prepare('UPDATE demo_data_registry SET snapshot_digest = ? WHERE source_batch_id = ?')
        .run('0'.repeat(64), fixture.batchId);
    });

    const statisticsDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 8);
    await assertTamperedReplayRejected(server, adminToken, statisticsDriftFixture, (db, fixture) => {
      db.prepare('UPDATE import_batches SET success_count = 0 WHERE id = ?').run(fixture.batchId);
    });

    const ownershipSummaryDriftFixture = await createManagedClosureFixture(server, adminToken, adminUserId, run.runId, 9);
    await assertTamperedReplayRejected(server, adminToken, ownershipSummaryDriftFixture, (db, fixture) => {
      const batch = db.prepare('SELECT execute_result_json AS executeResultJson FROM import_batches WHERE id = ?')
        .get(fixture.batchId);
      const executeResult = JSON.parse(batch.executeResultJson);
      executeResult.ownership.closureDigest = '0'.repeat(64);
      db.prepare('UPDATE import_batches SET execute_result_json = ? WHERE id = ?')
        .run(JSON.stringify(executeResult), fixture.batchId);
    });

    console.log('demoMonthlyEnergyManagedDirectImport.test.js passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows 上 SQLite 句柄释放可能稍晚，临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
