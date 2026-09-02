'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 本测试只使用系统临时目录、隔离 SQLite 与随机本机端口，不接触真实业务数据库。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-prediction-config-managed-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'prediction-managed.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { MAX_IMPORT_FILE_SIZE_BYTES } = require('../middleware/upload');
const { createDemoContext } = require('../services/demoContextService');
const {
  markDemoContextExecutedWithOwnershipTransaction,
  runWithDemoOwnershipTransactionAsync,
  updateDemoExecuteAuditInOwnershipTransaction,
  validateDemoContextWithOwnershipTransaction
} = require('../services/demoOwnershipService');
const { readSafeUploadFile } = require('../services/energyAnalysisImportCore');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const {
  PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
  executePredictionConfigImport
} = require('../services/predictionService');
const responseUtils = require('../utils/response');
const originalSendSuccess = responseUtils.sendSuccess;
let failNextManagedPreviewResponse = false;
responseUtils.sendSuccess = function sendSuccessWithManagedPreviewFault(res, data, options) {
  if (failNextManagedPreviewResponse && data?.previewOnly === true && Number.isSafeInteger(Number(data.batchId))) {
    failNextManagedPreviewResponse = false;
    throw new Error('TEST_PREDICTION_PREVIEW_RESPONSE_FAULT');
  }
  return originalSendSuccess(res, data, options);
};

const MONTHLY_ENERGY_BINDING = Object.freeze({
  artifactKey: '07-monthly-energy',
  handlerKey: 'monthly-energy-import'
});
const PREDICTION_CONFIG_BINDING = Object.freeze({
  artifactKey: '12-prediction-configs',
  handlerKey: 'prediction-configs-import'
});

/** 对内存字节计算 canonical SHA-256。 */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 构造单文件 multipart 请求体。 */
function createMultipart(buffer, filename) {
  const boundary = `----charcoal-prediction-managed-${crypto.randomUUID()}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
  };
}

/** 发起随机本机端口 HTTP 请求并解析统一响应。 */
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
          body: contentType.includes('application/json') && buffer.length > 0
            ? JSON.parse(buffer.toString('utf8'))
            : buffer
        });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(rawBody);
  });
}

/** 通过固定路由上传 retained 文件，可选携带 demo context。 */
function postMultipart(server, token, pathname, buffer, filename, demoContextToken) {
  const multipart = createMultipart(buffer, filename);
  const headers = { 'Content-Type': `multipart/form-data; boundary=${multipart.boundary}` };
  if (demoContextToken) headers['X-Demo-Context'] = demoContextToken;
  return request(server, 'POST', pathname, {
    token,
    headers,
    rawBody: multipart.body
  });
}

/** 通过固定 prediction execute 路由提交 JSON。 */
function postPredictionExecute(server, token, demoContextToken, body) {
  return request(server, 'POST', '/api/predictions/configs/import/execute', {
    token,
    headers: { 'X-Demo-Context': demoContextToken },
    body
  });
}

/** 生成 Artifact 07 可解析的月度能耗 CSV。 */
function buildMonthlyEnergyCsv() {
  return Buffer.from([
    '月份,能源类型编码,用量,单位,用能单元编码,计量器具编码,备注',
    '2030-01,electricity,100,kWh,DEMO-PRED-ORG,DEMO-PRED-METER,预测训练历史',
    '2030-02,electricity,120,kWh,DEMO-PRED-ORG,DEMO-PRED-METER,预测训练历史',
    '2030-03,electricity,140,kWh,DEMO-PRED-ORG,DEMO-PRED-METER,预测训练历史'
  ].join('\n'), 'utf8');
}

/** 生成 Artifact 12 可解析的预测配置 CSV；来源训练批次列保持空白。 */
function buildPredictionConfigCsv(names) {
  return Buffer.from([
    '配置名称,备注,能源类型编码,用能单元编码,计量器具编码,能耗批次ID,训练开始月份,训练结束月份,预测开始月份,预测结束月份,算法,窗口大小,状态',
    ...names.map((name) => `${name},managed retained,electricity,DEMO-PRED-ORG,DEMO-PRED-METER,,2030-01,2030-03,2030-04,2030-05,moving_average,3,active`)
  ].join('\n'), 'utf8');
}

/** 创建绑定当前 run、actor、runtime、manifest 与原文件字节的 context。 */
function issueContext(db, actorUserId, runId, binding, buffer) {
  return createDemoContext({
    db,
    userId: actorUserId,
    runId,
    artifactKey: binding.artifactKey,
    handlerKey: binding.handlerKey,
    artifactFileSha256: sha256Buffer(buffer)
  });
}

/** 返回路由和服务只能使用的固定 context 投影。 */
function projectDemoContext(context, actorUserId, binding) {
  return Object.freeze({
    token: context.token,
    userId: actorUserId,
    artifactKey: binding.artifactKey,
    handlerKey: binding.handlerKey
  });
}

/** 读取 managed Artifact 12 原子闭包的稳定快照。 */
function snapshotPredictionClosure(db, contextId, batchId) {
  return {
    context: db.prepare(`SELECT status, upload_file_sha256 AS uploadFileSha256,
      preview_digest AS previewDigest, executed_at AS executedAt
      FROM demo_import_contexts WHERE context_id = ?`).get(contextId),
    batch: db.prepare(`SELECT status, audit_phase AS auditPhase, execute_result_json AS executeResultJson,
      backup_json AS backupJson, success_count AS successCount
      FROM import_batches WHERE id = ?`).get(batchId),
    configCount: Number(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE source_batch_id = ?').get(batchId).total),
    ownershipCount: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(batchId).total),
    bindingCount: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches WHERE context_id = ?').get(contextId).total),
    executeOperationLogCount: Number(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'prediction.config.import.execute'
        AND target_type = 'prediction_config_import' AND target_id = ?`).get(String(batchId)).total)
  };
}

/** 返回隔离上传目录内当前文件集合。 */
function listUploadFiles() {
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  return fs.readdirSync(process.env.UPLOADS_DIR).sort();
}

/** 返回隔离备份目录内当前文件集合，用于验证失败事务不遗留孤立备份。 */
function listBackupFiles() {
  fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
  return fs.readdirSync(process.env.BACKUPS_DIR).sort();
}

/** 创建真实隔离备份文件和与实际字节一致的 mandatory backup 元数据。 */
function createBackupFixture(label, reason) {
  const backupName = `prediction-${label}-${crypto.randomUUID()}.sqlite`;
  const buffer = Buffer.from(`isolated-backup:${label}`, 'utf8');
  const backupPath = path.join(process.env.BACKUPS_DIR, backupName);
  fs.writeFileSync(backupPath, buffer);
  const timestamp = '2030-01-01T00:00:00.000Z';
  return {
    metadata: {
      backupName,
      reason,
      method: 'test-double',
      sizeBytes: buffer.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      sha256: sha256Buffer(buffer)
    },
    backupPath,
    buffer
  };
}

/** 返回 managed execute 固定最小请求体。 */
function buildManagedExecuteBody(batchId) {
  return {
    batchId,
    confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 直接通过单一 ownership operation 执行或回放，绕过 HTTP preflight 以验证同一事务快照。 */
function executeManagedDirect(demoContext, actorUserId, batchId, options = {}) {
  return executePredictionConfigImport(buildManagedExecuteBody(batchId), {
    databasePath: process.env.SQLITE_PATH,
    uploadsDir: process.env.UPLOADS_DIR,
    backupsDir: process.env.BACKUPS_DIR,
    demoContext,
    actor: { userId: actorUserId, ip: '127.0.0.1' },
    ...options
  });
}

/** 断言终态回放拒绝任何 retained、HMAC、审计、备份或业务闭包漂移。 */
async function assertTerminalReplayRejected(demoContext, actorUserId, batchId, label) {
  await assert.rejects(
    () => executeManagedDirect(demoContext, actorUserId, batchId),
    (error) => {
      assert(error && typeof error.code === 'string', `${label} 必须返回稳定应用错误。`);
      return true;
    },
    `${label} 漂移必须拒绝 terminal replay。`
  );
}

(async () => {
  let server = null;
  let db = null;
  try {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });

    // retained 文件替换为超限字节时，必须在 afterFileOpen/readFileSync 前按 fstat 尺寸拒绝。
    const oversizedFileName = 'oversized-prediction-config.csv';
    const oversizedFilePath = path.join(process.env.UPLOADS_DIR, oversizedFileName);
    fs.writeFileSync(oversizedFilePath, Buffer.alloc(MAX_IMPORT_FILE_SIZE_BYTES + 1, 0x61));
    let oversizedAfterOpenCalled = false;
    assert.throws(
      () => readSafeUploadFile(process.env.UPLOADS_DIR, oversizedFileName, {
        expectedSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES + 1,
        maxSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES,
        afterFileOpen() {
          oversizedAfterOpenCalled = true;
        }
      }),
      (error) => error?.details?.code === 'ENERGY_ANALYSIS_UPLOAD_FILE_TOO_LARGE'
    );
    assert.strictEqual(oversizedAfterOpenCalled, false,
      '超限文件必须在任何读取前测试钩子执行前拒绝。');
    fs.rmSync(oversizedFilePath, { force: true });

    initDatabase();
    db = openDatabase();
    const actor = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get();
    assert(actor, '隔离库必须存在内置管理员。');
    const actorUserId = Number(actor.id);
    const energyTypeId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
    const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('DEMO-PRED-ORG', '预测演示组织', '/DEMO-PRED-ORG', 'enterprise', 'active')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO meter_devices
      (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
      VALUES ('DEMO-PRED-METER', '预测演示电表', 'electricity', ?, ?, 'active')`).run(
      energyTypeId,
      organizationUnitId
    );
    db.prepare(`INSERT INTO prediction_configs
      (name, note, train_start_month, train_end_month, predict_start_month, predict_end_month,
       algorithm, window_size, status)
      VALUES ('已存在预测配置', '零候选测试', '2029-01', '2029-03', '2029-04', '2029-05',
       'moving_average', 3, 'draft')`).run();
    toggleDemoRuntime({ enabled: true, actorUserId, actorIp: '127.0.0.1' });
    const demoRun = db.transaction(() => getOrCreateActiveDemoDatasetRun({
      db,
      actorUserId,
      actorIp: '127.0.0.1'
    })).immediate();

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const login = await request(server, 'POST', '/api/login', {
      body: { username: 'admin', password: 'AdminPassword123!' }
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const adminToken = login.body.data.token;

    // 先通过 Artifact 07 managed direct 形成当前 run 唯一可信训练批次闭包。
    const monthlyEnergyBuffer = buildMonthlyEnergyCsv();
    const monthlyEnergyContext = issueContext(
      db,
      actorUserId,
      demoRun.runId,
      MONTHLY_ENERGY_BINDING,
      monthlyEnergyBuffer
    );
    const monthlyEnergyResponse = await postMultipart(
      server,
      adminToken,
      '/api/imports/batches',
      monthlyEnergyBuffer,
      '07-monthly-energy.csv',
      monthlyEnergyContext.token
    );
    assert.strictEqual(monthlyEnergyResponse.status, 201, JSON.stringify(monthlyEnergyResponse.body));
    const trainingBatchId = Number(monthlyEnergyResponse.body.data.id);
    assert(Number.isSafeInteger(trainingBatchId) && trainingBatchId > 0);
    assert.strictEqual(monthlyEnergyResponse.body.data.terminalReplay, false);

    // 上传字节与 context 下载绑定不一致时，preview 必须 fail-closed 并清理无效上传。
    const originalWrongShaBuffer = buildPredictionConfigCsv(['SHA 原始预测配置']);
    const alteredWrongShaBuffer = buildPredictionConfigCsv(['SHA 篡改预测配置']);
    const wrongShaContext = issueContext(
      db,
      actorUserId,
      demoRun.runId,
      PREDICTION_CONFIG_BINDING,
      originalWrongShaBuffer
    );
    const wrongShaFilesBefore = listUploadFiles();
    const wrongShaResponse = await postMultipart(
      server,
      adminToken,
      '/api/predictions/configs/import/preview',
      alteredWrongShaBuffer,
      '12-prediction-configs-wrong-sha.csv',
      wrongShaContext.token
    );
    assert.strictEqual(wrongShaResponse.status, 409, JSON.stringify(wrongShaResponse.body));
    assert.strictEqual(wrongShaResponse.body.error.code, 'DEMO_CONTEXT_REASSOCIATED_FILE_MISMATCH');
    assert.deepStrictEqual(listUploadFiles(), wrongShaFilesBefore);
    assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(wrongShaContext.contextId).status, 'issued');

    // managed preview 操作日志故障必须与 batch/context/binding 同事务回滚并清理未接管上传。
    const previewAuditFaultBuffer = buildPredictionConfigCsv(['preview audit fault']);
    const previewAuditFaultContext = issueContext(
      db,
      actorUserId,
      demoRun.runId,
      PREDICTION_CONFIG_BINDING,
      previewAuditFaultBuffer
    );
    db.exec(`CREATE TRIGGER prediction_preview_operation_log_fault
      BEFORE INSERT ON sys_operation_logs
      WHEN NEW.operation = 'prediction.config.import.preview'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_PREDICTION_PREVIEW_OPERATION_LOG_FAULT');
      END`);
    const previewAuditFaultFilesBefore = listUploadFiles();
    const previewAuditFaultResponse = await postMultipart(
      server,
      adminToken,
      '/api/predictions/configs/import/preview',
      previewAuditFaultBuffer,
      '12-prediction-preview-audit-fault.csv',
      previewAuditFaultContext.token
    );
    db.exec('DROP TRIGGER prediction_preview_operation_log_fault');
    assert.strictEqual(previewAuditFaultResponse.status, 500, JSON.stringify(previewAuditFaultResponse.body));
    assert.deepStrictEqual(listUploadFiles(), previewAuditFaultFilesBefore);
    assert.strictEqual(
      db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
        .get(previewAuditFaultContext.contextId).status,
      'issued'
    );
    assert.strictEqual(
      db.prepare(`SELECT COUNT(*) AS total FROM import_batches
        WHERE original_filename = '12-prediction-preview-audit-fault.csv'`).get().total,
      0
    );

    // service 已提交 retained preview 后，response 阶段异常不得删除 batch/context 已引用的原文件。
    const responseFaultBuffer = buildPredictionConfigCsv(['preview response fault']);
    const responseFaultContext = issueContext(
      db,
      actorUserId,
      demoRun.runId,
      PREDICTION_CONFIG_BINDING,
      responseFaultBuffer
    );
    failNextManagedPreviewResponse = true;
    const responseFaultResult = await postMultipart(
      server,
      adminToken,
      '/api/predictions/configs/import/preview',
      responseFaultBuffer,
      '12-prediction-preview-response-fault.csv',
      responseFaultContext.token
    );
    assert.strictEqual(responseFaultResult.status, 500, JSON.stringify(responseFaultResult.body));
    const responseFaultBatch = db.prepare(`SELECT id, stored_filename AS storedFilename
      FROM import_batches WHERE original_filename = '12-prediction-preview-response-fault.csv'`).get();
    assert(responseFaultBatch, 'response 异常发生前 managed preview 批次必须已提交。');
    assert(fs.existsSync(path.join(process.env.UPLOADS_DIR, responseFaultBatch.storedFilename)),
      'response 异常不得删除已经被 batch/context 引用的 retained 文件。');
    assert.strictEqual(
      db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
        .get(responseFaultContext.contextId).status,
      'previewed'
    );

    // 零候选和多候选 preview 可以持久保留，但 execute 必须严格拒绝且不写业务行。
    for (const scenario of [
      { label: 'zero', names: ['已存在预测配置'], candidateCount: 0 },
      { label: 'multiple', names: ['多候选预测配置一', '多候选预测配置二'], candidateCount: 2 }
    ]) {
      const buffer = buildPredictionConfigCsv(scenario.names);
      const context = issueContext(db, actorUserId, demoRun.runId, PREDICTION_CONFIG_BINDING, buffer);
      const previewResponse = await postMultipart(
        server,
        adminToken,
        '/api/predictions/configs/import/preview',
        buffer,
        `12-prediction-configs-${scenario.label}.csv`,
        context.token
      );
      assert.strictEqual(previewResponse.status, 200, JSON.stringify(previewResponse.body));
      assert.strictEqual(previewResponse.body.data.summary.wouldImport, scenario.candidateCount);
      const executeResponse = await postPredictionExecute(server, adminToken, context.token, {
        batchId: previewResponse.body.data.batchId,
        confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      });
      assert.strictEqual(executeResponse.status, 400, JSON.stringify(executeResponse.body));
      assert.strictEqual(executeResponse.body.error.details?.code, 'PREDICTION_CONFIG_IMPORT_MANAGED_CANDIDATE_COUNT_INVALID', JSON.stringify(executeResponse.body));
      assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(context.contextId).status, 'previewed');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE source_batch_id = ?').get(previewResponse.body.data.batchId).total, 0);
    }

    // 合法 preview 只写 audit/context/binding，保留 retained 文件且不信任 execute override。
    const predictionBuffer = buildPredictionConfigCsv([
      '已存在预测配置',
      'Artifact 12 managed 预测配置'
    ]);
    const predictionContext = issueContext(
      db,
      actorUserId,
      demoRun.runId,
      PREDICTION_CONFIG_BINDING,
      predictionBuffer
    );
    const predictionPreviewResponse = await postMultipart(
      server,
      adminToken,
      '/api/predictions/configs/import/preview',
      predictionBuffer,
      '12-prediction-configs.csv',
      predictionContext.token
    );
    assert.strictEqual(predictionPreviewResponse.status, 200, JSON.stringify(predictionPreviewResponse.body));
    const preview = predictionPreviewResponse.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.writesPredictionConfigs, false);
    assert.strictEqual(preview.candidateRows[0].sourceBatchFilterId, null);
    const previewAudit = db.prepare(`SELECT stored_filename AS storedFilename,
      file_sha256 AS fileSha256, audit_phase AS auditPhase, status
      FROM import_batches WHERE id = ?`).get(preview.batchId);
    assert.strictEqual(previewAudit.auditPhase, 'preview');
    assert(['completed', 'completed_with_errors'].includes(previewAudit.status));
    assert.strictEqual(previewAudit.fileSha256, sha256Buffer(predictionBuffer));
    assert(fs.existsSync(path.join(process.env.UPLOADS_DIR, previewAudit.storedFilename)));
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM prediction_configs WHERE source_batch_id = ?').get(preview.batchId).total, 0);
    assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(predictionContext.contextId).status, 'previewed');

    const overrideResponse = await postPredictionExecute(server, adminToken, predictionContext.token, {
      batchId: preview.batchId,
      confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      candidateRows: preview.candidateRows,
      sourceBatchFilterId: 999999
    });
    assert.strictEqual(overrideResponse.status, 400, JSON.stringify(overrideResponse.body));
    assert.strictEqual(overrideResponse.body.error.details?.code, 'PREDICTION_CONFIG_IMPORT_EXECUTE_FIELDS_INVALID');

    // 单一 operation 每个原子阶段故障都必须回滚 config、audit、operation log、ownership 和 context CAS。
    const demoContext = projectDemoContext(predictionContext, actorUserId, PREDICTION_CONFIG_BINDING);
    const closureBeforeFault = snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId);
    const genericExecuteAuditIntent = (transactionScope) => ({
      transactionScope,
      batchId: preview.batchId,
      status: 'completed',
      statistics: {
        totalRows: 1,
        successCount: 1,
        failureCount: 0,
        skippedCount: 0
      },
      executeResult: { executed: true, imported: 1 },
      backup: null,
      errorSummary: null
    });
    const genericContextIntent = (transactionScope) => ({
      transactionScope,
      demoContext,
      uploadFileSha256: closureBeforeFault.context.uploadFileSha256,
      previewDigest: closureBeforeFault.context.previewDigest,
      batchBindings: [{ batchId: preview.batchId, batchRole: 'primary' }]
    });
    const assertGenericCallbackRejected = async (label, callback, expectedCodes) => {
      let rejection = null;
      try {
        await runWithDemoOwnershipTransactionAsync(process.env.SQLITE_PATH, callback);
      } catch (error) {
        rejection = error;
      }
      assert(rejection, `${label} 必须由 Artifact 12 managed authority fail-closed。`);
      assert(
        expectedCodes.includes(rejection?.details?.code || rejection?.code),
        `${label} 返回非预期错误：${rejection?.details?.code || rejection?.code || rejection?.message}`
      );
      assert.deepStrictEqual(
        snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId),
        closureBeforeFault,
        `${label} 不得推进 execute audit、context CAS 或其他 managed 闭包。`
      );
    };

    // 通用 async callback 不得通过字符串 exports 分步推进 Artifact 12 validate/audit/context terminal。
    await assertGenericCallbackRejected(
      'generic context validate',
      async (transactionScope) => validateDemoContextWithOwnershipTransaction({
        transactionScope,
        demoContext,
        uploadFileSha256: closureBeforeFault.context.uploadFileSha256,
        previewDigest: closureBeforeFault.context.previewDigest
      }),
      ['DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED']
    );
    await assertGenericCallbackRejected(
      'generic execute audit',
      async (transactionScope) => updateDemoExecuteAuditInOwnershipTransaction(
        genericExecuteAuditIntent(transactionScope)
      ),
      ['DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED']
    );
    await assertGenericCallbackRejected(
      'generic context CAS',
      async (transactionScope) => markDemoContextExecutedWithOwnershipTransaction(
        genericContextIntent(transactionScope)
      ),
      ['DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED']
    );
    await assertGenericCallbackRejected(
      'generic execute audit and context CAS combination',
      async (transactionScope) => {
        try {
          updateDemoExecuteAuditInOwnershipTransaction(genericExecuteAuditIntent(transactionScope));
        } catch (error) {
          assert.strictEqual(error?.details?.code || error?.code, 'DEMO_PREDICTION_CONFIG_OPERATION_REQUIRED');
        }
        try {
          markDemoContextExecutedWithOwnershipTransaction(genericContextIntent(transactionScope));
        } catch (error) {
          assert.strictEqual(error?.details?.code || error?.code, 'DEMO_OWNERSHIP_TRANSACTION_SCOPE_POISONED');
        }
      },
      ['DEMO_OWNERSHIP_TRANSACTION_SCOPE_BROKEN']
    );

    const managedOperationFaultStages = [
      'after-retained-rebuild',
      'after-training-closure',
      'after-backup',
      'after-config-insert',
      'after-ownership',
      'before-execute-audit',
      'before-operation-log',
      'after-operation-log',
      'before-context-cas',
      'after-context-executed',
      'after-final-closure'
    ];
    for (const faultStage of managedOperationFaultStages) {
      const backupFilesBeforeFault = listBackupFiles();
      let createdBackupFixture = null;
      await assert.rejects(
        () => executeManagedDirect(demoContext, actorUserId, preview.batchId, {
          createBackup: async ({ reason }) => {
            createdBackupFixture = createBackupFixture(faultStage, reason);
            return createdBackupFixture.metadata;
          },
          managedFaultInjector(stage) {
            if (stage === faultStage) throw new Error(`TEST_PREDICTION_OPERATION_FAULT:${stage}`);
          }
        }),
        (error) => {
          assert(
            String(error?.message || '').includes(`TEST_PREDICTION_OPERATION_FAULT:${faultStage}`),
            `${faultStage} 未到达故障点：${JSON.stringify(error?.details || null)}`
          );
          return true;
        }
      );
      assert.deepStrictEqual(
        snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId),
        closureBeforeFault,
        `${faultStage} 故障必须回滚完整 managed SQLite 闭包。`
      );
      assert.deepStrictEqual(
        listBackupFiles(),
        backupFilesBeforeFault,
        `${faultStage} 故障不得遗留本次 operation 新建的孤立备份。`
      );
      if (createdBackupFixture) {
        assert.strictEqual(
          fs.existsSync(createdBackupFixture.backupPath),
          false,
          `${faultStage} 回滚后必须删除 exact name/size/SHA 匹配的新建备份。`
        );
      }
    }

    // 备份文件在业务失败前漂移时不得误删，补偿失败审计也不得覆盖原业务错误。
    const backupFilesBeforeCompensationFailure = listBackupFiles();
    let compensationFailureBackup = null;
    await assert.rejects(
      () => executeManagedDirect(demoContext, actorUserId, preview.batchId, {
        createBackup: async ({ reason }) => {
          compensationFailureBackup = createBackupFixture('compensation-failure', reason);
          return compensationFailureBackup.metadata;
        },
        managedFaultInjector(stage) {
          if (stage === 'after-backup') {
            fs.writeFileSync(
              compensationFailureBackup.backupPath,
              Buffer.alloc(compensationFailureBackup.buffer.length, 0x78)
            );
          }
          if (stage === 'after-config-insert') {
            throw new Error('TEST_PREDICTION_ORIGINAL_BUSINESS_FAULT');
          }
        }
      }),
      /TEST_PREDICTION_ORIGINAL_BUSINESS_FAULT/
    );
    assert.deepStrictEqual(
      snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId),
      closureBeforeFault,
      '补偿清理失败不得阻止 managed SQLite 闭包回滚。'
    );
    assert.strictEqual(
      fs.existsSync(compensationFailureBackup.backupPath),
      true,
      'size/SHA 已漂移的备份不得被补偿逻辑误删。'
    );
    assert.deepStrictEqual(
      listBackupFiles(),
      [...backupFilesBeforeCompensationFailure, compensationFailureBackup.metadata.backupName].sort(),
      '补偿失败只能保留无法安全证明的漂移文件。'
    );
    const compensationFailureAudit = db.prepare(`SELECT user_id AS userId, target_id AS targetId,
      detail_json AS detailJson FROM sys_operation_logs
      WHERE operation = 'prediction.config.import.backup.compensation.failed'
      ORDER BY id DESC LIMIT 1`).get();
    assert(compensationFailureAudit, '补偿失败必须写入安全 operation audit。');
    assert.strictEqual(compensationFailureAudit.userId, actorUserId);
    assert.strictEqual(String(compensationFailureAudit.targetId), String(preview.batchId));
    assert.deepStrictEqual(JSON.parse(compensationFailureAudit.detailJson), {
      backupName: compensationFailureBackup.metadata.backupName,
      sizeBytes: compensationFailureBackup.metadata.sizeBytes,
      sha256: compensationFailureBackup.metadata.sha256,
      cleanupCode: 'DEMO_PREDICTION_CONFIG_CLOSURE_INVALID'
    });
    fs.rmSync(compensationFailureBackup.backupPath, { force: false });
    assert.deepStrictEqual(listBackupFiles(), backupFilesBeforeCompensationFailure);

    // execute operation-log 写入故障必须与业务写入共用 caller-owned transaction。
    db.exec(`CREATE TRIGGER prediction_execute_operation_log_fault
      BEFORE INSERT ON sys_operation_logs
      WHEN NEW.operation = 'prediction.config.import.execute'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_PREDICTION_EXECUTE_OPERATION_LOG_FAULT');
      END`);
    const backupFilesBeforeOperationLogFault = listBackupFiles();
    let operationLogFaultBackup = null;
    await assert.rejects(
      () => executeManagedDirect(demoContext, actorUserId, preview.batchId, {
        createBackup: async ({ reason }) => {
          operationLogFaultBackup = createBackupFixture('execute-operation-log', reason);
          return operationLogFaultBackup.metadata;
        }
      }),
      /TEST_PREDICTION_EXECUTE_OPERATION_LOG_FAULT/
    );
    db.exec('DROP TRIGGER prediction_execute_operation_log_fault');
    assert.deepStrictEqual(
      snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId),
      closureBeforeFault,
      'execute operation-log 故障必须回滚完整 managed SQLite 闭包。'
    );
    assert.deepStrictEqual(
      listBackupFiles(),
      backupFilesBeforeOperationLogFault,
      'execute operation-log 故障不得遗留本次 operation 新建的孤立备份。'
    );
    assert.strictEqual(fs.existsSync(operationLogFaultBackup.backupPath), false);

    const backupFilesBeforeSuccess = listBackupFiles();
    const executeResponse = await postPredictionExecute(server, adminToken, predictionContext.token, {
      batchId: preview.batchId,
      confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    });
    assert.strictEqual(executeResponse.status, 200, JSON.stringify(executeResponse.body));
    const executed = executeResponse.body.data;
    assert.strictEqual(executed.imported, 1);
    assert.strictEqual(executed.terminalReplay, undefined);
    assert.strictEqual(executed.sourceTrainingBatchId, trainingBatchId);
    assert.strictEqual(executed.importedRecords.length, 1);
    assert.strictEqual(executed.importedRecords[0].status, 'draft');
    assert.strictEqual(Number(executed.importedRecords[0].sourceBatchId), Number(preview.batchId));
    assert.strictEqual(Number(executed.importedRecords[0].sourceBatchFilterId), trainingBatchId);
    assert.strictEqual(executed.ownership.registrationCount, 1);
    assert.strictEqual(executed.ownership.insertedCount, 1);
    const persistedConfig = db.prepare(`SELECT id, source_batch_id AS sourceBatchId,
      source_batch_filter_id AS sourceBatchFilterId, status
      FROM prediction_configs WHERE source_batch_id = ?`).get(preview.batchId);
    assert.deepStrictEqual({
      sourceBatchId: Number(persistedConfig.sourceBatchId),
      sourceBatchFilterId: Number(persistedConfig.sourceBatchFilterId),
      status: persistedConfig.status
    }, {
      sourceBatchId: Number(preview.batchId),
      sourceBatchFilterId: trainingBatchId,
      status: 'draft'
    });
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '12-prediction-configs'
        AND entity_type = 'prediction_config' AND entity_pk = ?
        AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
      demoRun.runId,
      String(persistedConfig.id)
    ).total, 1);
    assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?').get(predictionContext.contextId).status, 'executed');
    const backupFilesAfterSuccess = listBackupFiles();
    assert.strictEqual(
      backupFilesAfterSuccess.length,
      backupFilesBeforeSuccess.length + 1,
      '正常提交必须保留本次 mandatory backup。'
    );

    // Terminal replay 返回原批次和配置，不重复写业务、ownership、binding 或 backup。
    const closureBeforeReplay = snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId);
    const replayResponse = await postPredictionExecute(server, adminToken, predictionContext.token, {
      batchId: preview.batchId,
      confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    });
    assert.strictEqual(replayResponse.status, 200, JSON.stringify(replayResponse.body));
    assert.strictEqual(replayResponse.body.data.terminalReplay, true);
    assert.strictEqual(replayResponse.body.data.batchId, preview.batchId);
    assert.strictEqual(replayResponse.body.data.importedRecords[0].id, persistedConfig.id);
    assert.deepStrictEqual(snapshotPredictionClosure(db, predictionContext.contextId, preview.batchId), closureBeforeReplay);
    assert.deepStrictEqual(
      listBackupFiles(),
      backupFilesAfterSuccess,
      'terminal replay 不得重复创建或清理已提交 backup。'
    );

    // Terminal replay 必须在同一事务快照重建 retained/HMAC/行审计/backup/业务/ownership 闭包。
    const retainedPath = path.join(process.env.UPLOADS_DIR, previewAudit.storedFilename);
    const retainedBuffer = fs.readFileSync(retainedPath);
    const persistedBatchFacts = db.prepare(`SELECT file_sha256 AS fileSha256,
      preview_signature AS previewSignature, preview_audit_digest AS previewAuditDigest,
      backup_json AS backupJson, execute_result_json AS executeResultJson
      FROM import_batches WHERE id = ?`).get(preview.batchId);
    const persistedContextFacts = db.prepare(`SELECT artifact_file_sha256 AS artifactFileSha256,
      upload_file_sha256 AS uploadFileSha256
      FROM demo_import_contexts WHERE context_id = ?`).get(predictionContext.contextId);
    const persistedHmacSecret = db.prepare(`SELECT value FROM app_meta
      WHERE key = 'prediction_config_import_hmac_secret'`).get().value;
    const persistedIssues = db.prepare(`SELECT id, batch_id AS batchId, row_number AS rowNumber,
      field_name AS fieldName, raw_value AS rawValue, error_code AS errorCode,
      error_reason AS errorReason, severity, created_at AS createdAt
      FROM import_errors WHERE batch_id = ? ORDER BY row_number, id`).all(preview.batchId);
    assert(persistedIssues.length > 0, '专项测试必须包含可删除和篡改的真实 import_errors warning。');
    const persistedBackup = JSON.parse(persistedBatchFacts.backupJson);
    assert.strictEqual(persistedBackup.reason, 'prediction-config-import');
    const persistedBackupPath = path.join(process.env.BACKUPS_DIR, persistedBackup.backupName);
    const persistedBackupBuffer = fs.readFileSync(persistedBackupPath);

    async function assertDriftRejected(label, tamper, restore) {
      tamper();
      try {
        await assertTerminalReplayRejected(demoContext, actorUserId, preview.batchId, label);
      } finally {
        restore();
      }
    }

    const changedRetainedBuffer = Buffer.alloc(retainedBuffer.length, 0x78);
    await assertDriftRejected(
      'retained actual SHA',
      () => fs.writeFileSync(retainedPath, changedRetainedBuffer),
      () => fs.writeFileSync(retainedPath, retainedBuffer)
    );
    await assertDriftRejected(
      'import_batches.file_sha256',
      () => db.prepare('UPDATE import_batches SET file_sha256 = ? WHERE id = ?')
        .run('1'.repeat(64), preview.batchId),
      () => db.prepare('UPDATE import_batches SET file_sha256 = ? WHERE id = ?')
        .run(persistedBatchFacts.fileSha256, preview.batchId)
    );
    await assertDriftRejected(
      'context upload SHA',
      () => db.prepare('UPDATE demo_import_contexts SET upload_file_sha256 = ? WHERE context_id = ?')
        .run('2'.repeat(64), predictionContext.contextId),
      () => db.prepare('UPDATE demo_import_contexts SET upload_file_sha256 = ? WHERE context_id = ?')
        .run(persistedContextFacts.uploadFileSha256, predictionContext.contextId)
    );
    await assertDriftRejected(
      'context artifact SHA',
      () => db.prepare('UPDATE demo_import_contexts SET artifact_file_sha256 = ? WHERE context_id = ?')
        .run('3'.repeat(64), predictionContext.contextId),
      () => db.prepare('UPDATE demo_import_contexts SET artifact_file_sha256 = ? WHERE context_id = ?')
        .run(persistedContextFacts.artifactFileSha256, predictionContext.contextId)
    );
    await assertDriftRejected(
      'preview HMAC signature',
      () => db.prepare('UPDATE import_batches SET preview_signature = ? WHERE id = ?')
        .run('hmac-sha256:v1:tampered', preview.batchId),
      () => db.prepare('UPDATE import_batches SET preview_signature = ? WHERE id = ?')
        .run(persistedBatchFacts.previewSignature, preview.batchId)
    );
    await assertDriftRejected(
      'preview HMAC audit digest',
      () => db.prepare('UPDATE import_batches SET preview_audit_digest = ? WHERE id = ?')
        .run('hmac-sha256:v1:audit:tampered', preview.batchId),
      () => db.prepare('UPDATE import_batches SET preview_audit_digest = ? WHERE id = ?')
        .run(persistedBatchFacts.previewAuditDigest, preview.batchId)
    );
    await assertDriftRejected(
      'HMAC secret',
      () => db.prepare(`UPDATE app_meta SET value = ?
        WHERE key = 'prediction_config_import_hmac_secret'`).run('tampered-secret'),
      () => db.prepare(`UPDATE app_meta SET value = ?
        WHERE key = 'prediction_config_import_hmac_secret'`).run(persistedHmacSecret)
    );
    await assertDriftRejected(
      'import_errors deletion',
      () => db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(preview.batchId),
      () => {
        const insertIssue = db.prepare(`INSERT INTO import_errors
          (id, batch_id, row_number, field_name, raw_value, error_code, error_reason, severity, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        persistedIssues.forEach((issue) => insertIssue.run(
          issue.id,
          issue.batchId,
          issue.rowNumber,
          issue.fieldName,
          issue.rawValue,
          issue.errorCode,
          issue.errorReason,
          issue.severity,
          issue.createdAt
        ));
      }
    );
    await assertDriftRejected(
      'import_errors tamper',
      () => db.prepare('UPDATE import_errors SET error_reason = ? WHERE id = ?')
        .run('tampered import issue', persistedIssues[0].id),
      () => db.prepare('UPDATE import_errors SET error_reason = ? WHERE id = ?')
        .run(persistedIssues[0].errorReason, persistedIssues[0].id)
    );
    await assertDriftRejected(
      'backup_json null',
      () => db.prepare('UPDATE import_batches SET backup_json = NULL WHERE id = ?').run(preview.batchId),
      () => db.prepare('UPDATE import_batches SET backup_json = ? WHERE id = ?')
        .run(persistedBatchFacts.backupJson, preview.batchId)
    );
    await assertDriftRejected(
      'backup_json invalid JSON',
      () => db.prepare('UPDATE import_batches SET backup_json = ? WHERE id = ?').run('{', preview.batchId),
      () => db.prepare('UPDATE import_batches SET backup_json = ? WHERE id = ?')
        .run(persistedBatchFacts.backupJson, preview.batchId)
    );
    await assertDriftRejected(
      'backup_json metadata',
      () => db.prepare('UPDATE import_batches SET backup_json = ? WHERE id = ?').run(
        JSON.stringify({ ...persistedBackup, createdAt: '2030-01-01T00:00:00.000Z' }),
        preview.batchId
      ),
      () => db.prepare('UPDATE import_batches SET backup_json = ? WHERE id = ?')
        .run(persistedBatchFacts.backupJson, preview.batchId)
    );
    await assertDriftRejected(
      'executeResult backup',
      () => {
        const executeResult = JSON.parse(persistedBatchFacts.executeResultJson);
        executeResult.backup = { ...executeResult.backup, updatedAt: '2030-01-01T00:00:00.000Z' };
        db.prepare('UPDATE import_batches SET execute_result_json = ? WHERE id = ?')
          .run(JSON.stringify(executeResult), preview.batchId);
      },
      () => db.prepare('UPDATE import_batches SET execute_result_json = ? WHERE id = ?')
        .run(persistedBatchFacts.executeResultJson, preview.batchId)
    );
    await assertDriftRejected(
      'backup file deletion',
      () => fs.rmSync(persistedBackupPath, { force: true }),
      () => fs.writeFileSync(persistedBackupPath, persistedBackupBuffer)
    );
    await assertDriftRejected(
      'backup file size',
      () => fs.writeFileSync(persistedBackupPath, Buffer.concat([
        persistedBackupBuffer,
        Buffer.from('size-drift', 'utf8')
      ])),
      () => fs.writeFileSync(persistedBackupPath, persistedBackupBuffer)
    );
    await assertDriftRejected(
      'backup file SHA',
      () => fs.writeFileSync(persistedBackupPath, Buffer.alloc(persistedBackupBuffer.length, 0x79)),
      () => fs.writeFileSync(persistedBackupPath, persistedBackupBuffer)
    );
    let duplicateConfigId = null;
    await assertDriftRejected(
      'other true duplicate config',
      () => {
        duplicateConfigId = Number(db.prepare(`INSERT INTO prediction_configs
          (name, train_start_month, train_end_month, predict_start_month, predict_end_month,
           algorithm, window_size, status)
          VALUES (?, '2030-01', '2030-03', '2030-04', '2030-05',
           'moving_average', 3, 'draft')`).run('Artifact 12 managed 预测配置').lastInsertRowid);
      },
      () => db.prepare('DELETE FROM prediction_configs WHERE id = ?').run(duplicateConfigId)
    );
    await assertDriftRejected(
      'prediction config business row',
      () => db.prepare("UPDATE prediction_configs SET status = 'active' WHERE id = ?").run(persistedConfig.id),
      () => db.prepare("UPDATE prediction_configs SET status = 'draft' WHERE id = ?").run(persistedConfig.id)
    );

    // 所有漂移恢复后仍必须能够通过同一严格 terminal replay，证明测试未留下伪损坏。
    const restoredReplay = await executeManagedDirect(demoContext, actorUserId, preview.batchId);
    assert.strictEqual(restoredReplay.terminalReplay, true);
    assert.strictEqual(restoredReplay.importedRecords[0].id, persistedConfig.id);

    console.log(JSON.stringify({
      status: 'passed',
      trainingBatchId,
      predictionBatchId: preview.batchId,
      predictionConfigId: persistedConfig.id,
      managedPreview: true,
      managedExecute: true,
      terminalReplay: true,
      rollbackRetry: true
    }));
  } finally {
    responseUtils.sendSuccess = originalSendSuccess;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
