'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// API 专项测试只使用系统临时目录和隔离 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-workbook-routes-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-flow-workbook-routes.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowWorkbookRoutes123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-flow-workbook-routes-secret-2026';

const { initDatabase, openDatabase, uploadsDir } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyFlowImportRoutes = require('../routes/energyFlowImports');
const importRoutes = require('../routes/imports');
const templateRoutes = require('../routes/templates');
const { login, register } = require('../services/authService');
const backupService = require('../services/backupService');
const {
  ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
  ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS,
  ENERGY_FLOW_WORKBOOK_SHEETS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION
} = require('../services/energyFlowWorkbookContracts');
const { runWithMaintenance } = require('../services/maintenanceState');

// 固定工作簿 API 前缀。
const WORKBOOK_PREFIX = '/api/energy-flow-imports/workbook';
// 保存备份原实现，测试结束必须恢复。
const originalCreateBackup = backupService.createBackup;
// 记录路由成功执行时的备份次数。
const backupCounter = { count: 0 };

/** 构造可写入 canonical 九表的合法固定六表工作簿。 */
function createWorkbookXlsx(modelCode = 'FLOW-WORKBOOK-ROUTE') {
  const workbook = XLSX.utils.book_new();
  const rows = {
    models: [[ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION,
      modelCode, 'API 完整能流模型', '隔离 API 测试', 'FLOW-API-2026', 'v1',
      '2026-01-01T00:00', '2027-01-01T00:00', 'Asia/Shanghai',
      'workbook_facts', 'workbook_facts_only', 'active']],
    assetsNodes: [
      ['asset', modelCode, 'ASSET-API', 'API 设备', 'production_device', '', '', '', '', '', '', '', '', 'active'],
      ['node', modelCode, '', '', '', 'NODE-API-IN', 'API 入口', 'source', 'ASSET-API', 'plant_entry', '', 0, 0, 'active'],
      ['node', modelCode, '', '', '', 'NODE-API-OUT', 'API 出口', 'sink', 'ASSET-API', 'useful_output', '', 100, 0, 'active']
    ],
    edges: [[modelCode, 'PATH-API', 'API 主路径', 1, 'EDGE-API', 'NODE-API-IN', 'NODE-API-OUT',
      'electricity', 'kWh', 'workbook_fact', 'api:edge', 'active']],
    records: [
      ['REC-API-WASTE', modelCode, 'edge_flow', 'EDGE-API', '', 'PATH-API', 'ASSET-API', 'waste_heat',
        '2026-07-01T00:00', '2026-07-01T01:00', 'Asia/Shanghai', 'electricity', 10, 'kWh', 'api:waste-record'],
      ['REC-API-LOSS', modelCode, 'edge_flow', 'EDGE-API', '', 'PATH-API', 'ASSET-API', 'loss',
        '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', 'electricity', 1, 'kWh', 'api:loss-record']
    ],
    wasteHeat: [['WASTE-API', modelCode, 'REC-API-WASTE', 'generation', 'api:waste', 'active']],
    lossEvidence: [
      ['loss_fact', modelCode, 'LOSS-API', 'REC-API-LOSS', 'device_loss', '', '', '', '', '', '', '', '', '', '', 'active', ''],
      ['evidence', modelCode, 'LOSS-API', '', '', 'EVIDENCE-API', 'fact_evidence', 'API 损耗证据', 'meter_record', 'api:evidence',
        '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', '', '', 'active', '']
    ]
  };
  ENERGY_FLOW_WORKBOOK_SHEETS.forEach((contract) => {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([contract.headers, ...rows[contract.key]]),
      contract.name
    );
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 创建待测 Express 应用，execute 路由必须先于应用级 JSON parser。 */
function createIsolatedApp() {
  const app = express();
  app.use('/api/energy-flow-imports', energyFlowImportRoutes);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/imports', importRoutes);
  app.use('/api/templates', templateRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** 发送 JSON、原始 JSON 或二进制 GET 请求。 */
function request(server, method, pathname, body, token, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(String(options.rawBody), 'utf8')
      : body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = rawBody.length;
    }
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
          text: buffer.toString('utf8'),
          body: contentType.includes('application/json') && buffer.length
            ? JSON.parse(buffer.toString('utf8'))
            : null
        });
      });
    });
    clientRequest.on('error', reject);
    if (rawBody) clientRequest.write(rawBody);
    clientRequest.end();
  });
}

/** 发送只包含 file 字段的 multipart 请求。 */
function requestMultipart(server, pathname, file, token, options = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----energy-flow-workbook-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`, 'utf8'),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ''), 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };
    const clientRequest = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          buffer,
          text: buffer.toString('utf8'),
          body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(body);
  });
}

/** 为隔离用户创建角色并授予固定权限。 */
function grantPermissions(userId, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(
      `energy-flow-workbook-route-${userId}`,
      `完整能流工作簿路由角色 ${userId}`,
      now,
      now
    ).lastInsertRowid);
    const insertGrant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `权限 ${permissionCode} 必须已注册。`);
      insertGrant.run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
  } finally {
    db.close();
  }
}

/** 递归断言 HTTP DTO 未公开完整候选、安全链、路径或来源追溯字段。 */
function assertNoInternalFields(value, valuePath = 'response') {
  const forbidden = new Set([
    'workbook', 'candidateRows', 'candidateRowIds', 'candidateRowId', 'fileSha256',
    'previewSignature', 'previewAuditDigest', 'previewAudit', 'auditContext', 'witness',
    'storedFilename', 'filePath', 'sourceBatchId', 'sourceRowNumber', 'executeResult'
  ]);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInternalFields(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([fieldName, fieldValue]) => {
    assert(!forbidden.has(fieldName), `${valuePath}.${fieldName} 不得公开。`);
    assertNoInternalFields(fieldValue, `${valuePath}.${fieldName}`);
  });
}

/** 提取 HTTP 错误的稳定领域码，兼容统一 BAD_REQUEST 外壳。 */
function getErrorCode(response) {
  return response?.body?.error?.details?.code || response?.body?.error?.code || null;
}

/** 查询表行数。 */
function countRows(tableName) {
  const db = openDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
  } finally {
    db.close();
  }
}

/** 返回隔离上传目录内的文件名。 */
function listUploadFiles() {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs.readdirSync(uploadsDir).filter((name) => fs.statSync(path.join(uploadsDir, name)).isFile()).sort();
}

/** 构造固定 execute 请求体。 */
function buildExecuteBody(batchId) {
  return {
    batchId,
    confirmText: ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

(async () => {
  let server = null;
  try {
    initDatabase();
    const ordinaryUser = register({ username: 'flow-workbook-ordinary', password: 'WorkbookOrdinary123!' });
    const viewUser = register({ username: 'flow-workbook-view', password: 'WorkbookView123!' });
    const previewUser = register({ username: 'flow-workbook-preview', password: 'WorkbookPreview123!' });
    const importViewUser = register({ username: 'flow-workbook-import-view', password: 'WorkbookImportView123!' });
    const combinedViewUser = register({ username: 'flow-workbook-combined-view', password: 'WorkbookCombinedView123!' });
    const genericDownloadUser = register({ username: 'flow-workbook-download', password: 'WorkbookDownload123!' });
    const combinedDownloadUser = register({ username: 'flow-workbook-combined-download', password: 'WorkbookCombinedDownload123!' });
    grantPermissions(viewUser.id, ['energy:flows:view']);
    grantPermissions(previewUser.id, ['energy:flows:import:preview']);
    grantPermissions(importViewUser.id, ['imports:view']);
    grantPermissions(combinedViewUser.id, ['imports:view', 'energy:flows:view']);
    grantPermissions(genericDownloadUser.id, ['imports:view', 'imports:download']);
    grantPermissions(combinedDownloadUser.id, ['imports:view', 'imports:download', 'energy:flows:view']);

    const ordinaryToken = login({ username: ordinaryUser.username, password: 'WorkbookOrdinary123!' }).token;
    const viewToken = login({ username: viewUser.username, password: 'WorkbookView123!' }).token;
    const previewToken = login({ username: previewUser.username, password: 'WorkbookPreview123!' }).token;
    const importViewToken = login({ username: importViewUser.username, password: 'WorkbookImportView123!' }).token;
    const combinedViewToken = login({ username: combinedViewUser.username, password: 'WorkbookCombinedView123!' }).token;
    const genericDownloadToken = login({ username: genericDownloadUser.username, password: 'WorkbookDownload123!' }).token;
    const combinedDownloadToken = login({ username: combinedDownloadUser.username, password: 'WorkbookCombinedDownload123!' }).token;
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;

    backupService.createBackup = async ({ reason, skipCheckpoint }) => {
      backupCounter.count += 1;
      assert.strictEqual(reason, 'energy-flow-workbook-import');
      assert.strictEqual(skipCheckpoint, true);
      return {
        backupName: `energy-flow-workbook-route-${backupCounter.count}.sqlite`,
        reason,
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
        method: 'route-test-stub',
        createdAt: '2026-08-26T00:00:00Z'
      };
    };

    server = http.createServer(createIsolatedApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const workbookFile = {
      filename: 'energy-flow-workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createWorkbookXlsx()
    };

    // 模板下载固定使用 preview 权限，只提供真实 XLSX。
    assert.strictEqual((await request(server, 'GET', '/api/templates/energy-flow-workbook.xlsx')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/templates/energy-flow-workbook.xlsx', undefined, ordinaryToken)).status, 403);
    const templateResponse = await request(server, 'GET', '/api/templates/energy-flow-workbook.xlsx', undefined, previewToken);
    assert.strictEqual(templateResponse.status, 200, templateResponse.text);
    assert.strictEqual(templateResponse.headers['x-template-type'], ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE);
    assert.deepStrictEqual(XLSX.read(templateResponse.buffer, { type: 'buffer' }).SheetNames,
      ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.name));
    const templateCsv = await request(server, 'GET', '/api/templates/energy-flow-workbook.csv', undefined, previewToken);
    assert.strictEqual(templateCsv.status, 400);
    assert.strictEqual(getErrorCode(templateCsv), 'TEMPLATE_FORMAT_UNSUPPORTED');

    // 认证和领域权限必须位于 multipart/JSON 解析之前。
    assert.strictEqual((await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, workbookFile)).status, 401);
    assert.strictEqual((await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, workbookFile, viewToken)).status, 403);
    assert.strictEqual((await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, {}, viewToken)).status, 403);
    assert.strictEqual((await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, {}, previewToken)).status, 403);
    assert.strictEqual((await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, {})).status, 401);
    assert.deepStrictEqual(listUploadFiles(), []);

    // 完整工作簿尚未接入演示 context；携带 context 必须在上传和 JSON 解析前返回 409，不能静默降级正式导入。
    const unconnectedDemoPreview = await requestMultipart(
      server,
      `${WORKBOOK_PREFIX}/preview`,
      workbookFile,
      previewToken,
      { headers: { 'X-Demo-Context': 'z'.repeat(43) } }
    );
    assert.strictEqual(unconnectedDemoPreview.status, 409);
    assert.strictEqual(getErrorCode(unconnectedDemoPreview), 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    const unconnectedDemoExecute = await request(
      server,
      'POST',
      `${WORKBOOK_PREFIX}/execute`,
      undefined,
      adminToken,
      { rawBody: '{"batchId":', headers: { 'X-Demo-Context': 'z'.repeat(43) } }
    );
    assert.strictEqual(unconnectedDemoExecute.status, 409);
    assert.strictEqual(getErrorCode(unconnectedDemoExecute), 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    assert.deepStrictEqual(listUploadFiles(), []);

    // Preview 和 Execute 均受维护态保护，且应在上传或解析请求体前拒绝。
    const maintenancePreview = await runWithMaintenance('energy-flow-workbook-preview-test', async () => (
      requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, workbookFile, adminToken)
    ));
    assert.strictEqual(maintenancePreview.status, 423);
    const maintenanceExecute = await runWithMaintenance('energy-flow-workbook-execute-test', async () => (
      request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, {}, adminToken)
    ));
    assert.strictEqual(maintenanceExecute.status, 423);
    assert.deepStrictEqual(listUploadFiles(), []);

    // 文件类型和上传资源边界必须稳定拒绝并清理未持久化文件。
    for (const filename of ['energy-flow-workbook.csv', 'energy-flow-workbook.xls']) {
      const rejected = await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, {
        filename,
        content: Buffer.from('not-xlsx')
      }, previewToken);
      assert.strictEqual(rejected.status, 400);
      assert.strictEqual(getErrorCode(rejected), 'ENERGY_FLOW_WORKBOOK_XLSX_REQUIRED');
    }
    const batchCountBeforeOversized = countRows('import_batches');
    const issuesBeforeOversized = countRows('import_errors');
    const oversized = await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, {
      filename: 'oversized.xlsx',
      content: Buffer.alloc(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes + 1)
    }, previewToken);
    assert.strictEqual(oversized.status, 413);
    assert.strictEqual(getErrorCode(oversized), 'ENERGY_FLOW_WORKBOOK_UPLOAD_SIZE_EXCEEDED');
    assert.strictEqual(countRows('import_batches'), batchCountBeforeOversized);
    assert.strictEqual(countRows('import_errors'), issuesBeforeOversized);
    assert.deepStrictEqual(listUploadFiles(), []);

    // 伪装 XLSX 必须形成 failed preview、保留原文件并阻止 Execute。
    const failedPreviewResponse = await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, {
      filename: 'fake.xlsx',
      content: Buffer.from('not-an-ooxml-archive')
    }, previewToken);
    assert.strictEqual(failedPreviewResponse.status, 200, failedPreviewResponse.text);
    assert.strictEqual(failedPreviewResponse.body.data.summary.blocked, 1);
    assert.strictEqual(failedPreviewResponse.body.data.auditBatch.status, 'failed');
    assertNoInternalFields(failedPreviewResponse.body.data);
    assert.strictEqual(listUploadFiles().length, 1);
    const failedExecute = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`,
      buildExecuteBody(failedPreviewResponse.body.data.batchId), adminToken);
    assert.strictEqual(failedExecute.status, 400);
    assert.strictEqual(getErrorCode(failedExecute), 'ENERGY_FLOW_WORKBOOK_BATCH_NOT_EXECUTABLE');

    // 成功 Preview 只能产生一个批次且不得写入 canonical 九表。
    const successPreviewResponse = await requestMultipart(server, `${WORKBOOK_PREFIX}/preview`, workbookFile, previewToken);
    assert.strictEqual(successPreviewResponse.status, 200, successPreviewResponse.text);
    const preview = successPreviewResponse.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.auditBatch.importType, 'energy_flow_workbook');
    assertNoInternalFields(preview);
    ['energy_flow_models', 'energy_flow_assets', 'energy_flow_paths', 'energy_flow_nodes',
      'energy_flow_edges', 'energy_flow_records', 'energy_flow_waste_heat_facts',
      'energy_flow_loss_facts', 'energy_flow_loss_evidence'].forEach((tableName) => {
      assert.strictEqual(countRows(tableName), 0);
    });

    // Import Center 列表、详情和原文件下载必须执行二次领域授权。
    const hiddenList = await request(server, 'GET', '/api/imports/batches?page=1&pageSize=100', undefined, importViewToken);
    assert.strictEqual(hiddenList.status, 200);
    assert(!hiddenList.body.data.some((batch) => batch.id === preview.batchId));
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${preview.batchId}`, undefined, importViewToken)).status, 403);
    const visibleList = await request(server, 'GET', '/api/imports/batches?page=1&pageSize=100', undefined, combinedViewToken);
    assert.strictEqual(visibleList.status, 200);
    assert(visibleList.body.data.some((batch) => batch.id === preview.batchId));
    assertNoInternalFields(visibleList.body.data);
    const detail = await request(server, 'GET', `/api/imports/batches/${preview.batchId}`, undefined, combinedViewToken);
    assert.strictEqual(detail.status, 200, detail.text);
    assertNoInternalFields(detail.body.data);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${preview.batchId}/download`, undefined, genericDownloadToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${preview.batchId}/download`, undefined, viewToken)).status, 403);
    const download = await request(server, 'GET', `/api/imports/batches/${preview.batchId}/download`, undefined, combinedDownloadToken);
    assert.strictEqual(download.status, 200, download.text);
    assert.deepStrictEqual(download.buffer, workbookFile.content);

    // Execute JSON 解析上限和四字段白名单必须返回稳定脱敏错误。
    const malformedMarker = 'workbook-malformed-sensitive-marker';
    const malformed = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, undefined, adminToken, {
      rawBody: `{"marker":"${malformedMarker}"`
    });
    assert.strictEqual(malformed.status, 400);
    assert.strictEqual(getErrorCode(malformed), 'INVALID_JSON_BODY');
    assert(!malformed.text.includes(malformedMarker));
    const oversizedMarker = 'workbook-oversized-sensitive-marker';
    const oversizedJson = JSON.stringify({ marker: oversizedMarker, padding: 'x'.repeat(70 * 1024) });
    const oversizedExecute = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, undefined, adminToken, { rawBody: oversizedJson });
    assert.strictEqual(oversizedExecute.status, 413);
    assert.strictEqual(getErrorCode(oversizedExecute), 'REQUEST_BODY_TOO_LARGE');
    assert(!oversizedExecute.text.includes(oversizedMarker));
    const extraFieldExecute = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, {
      ...buildExecuteBody(preview.batchId),
      previewSignature: 'client-controlled'
    }, adminToken);
    assert.strictEqual(extraFieldExecute.status, 400);
    assert.strictEqual(getErrorCode(extraFieldExecute), 'ENERGY_FLOW_WORKBOOK_EXECUTE_EXTRA_FIELDS_REJECTED');

    // 成功 Execute 只能在线备份一次并写入九表；重复 Execute 稳定拒绝。
    const successExecute = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, buildExecuteBody(preview.batchId), adminToken);
    assert.strictEqual(successExecute.status, 200, successExecute.text);
    assert.strictEqual(successExecute.body.data.executed, true);
    assert.strictEqual(backupCounter.count, 1);
    assertNoInternalFields(successExecute.body.data);
    assert.deepStrictEqual(successExecute.body.data.importedFactCounts, {
      models: 1, assets: 1, nodes: 2, paths: 1, edges: 1,
      records: 2, wasteHeat: 1, lossFacts: 1, lossEvidence: 1
    });
    const duplicateExecute = await request(server, 'POST', `${WORKBOOK_PREFIX}/execute`, buildExecuteBody(preview.batchId), adminToken);
    assert.strictEqual(duplicateExecute.status, 400);
    assert.strictEqual(getErrorCode(duplicateExecute), 'ENERGY_FLOW_WORKBOOK_BATCH_NOT_EXECUTABLE');
    assert.strictEqual(backupCounter.count, 1);

    // 工作簿批次不得通过通用删除入口删除。
    const genericDelete = await request(server, 'DELETE', `/api/imports/batches/${preview.batchId}`, undefined, adminToken);
    assert.strictEqual(genericDelete.status, 400);
    assert.strictEqual(getErrorCode(genericDelete), 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');

    console.log('energyFlowWorkbookImportRoutes tests passed');
  } finally {
    backupService.createBackup = originalCreateBackup;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
