'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// API 测试根目录，确保上传、备份和 SQLite 全部隔离。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-routes-'));
// 隔离上传目录。
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
// 隔离备份目录。
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
// 隔离 SQLite 文件。
const temporaryDatabasePath = path.join(temporaryRoot, 'energy-flow-routes.sqlite');
process.env.DATA_DIR = temporaryRoot;
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowRoutes123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-flow-routes-test-secret-2026';

const { initDatabase, openDatabase, uploadsDir } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyFlowImportRouter = require('../routes/energyFlowImports');
const backupService = require('../services/backupService');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON
} = require('../services/energyAnalysisImportCore');
const { getEnergyAnalysisTemplateDefinition } = require('../services/energyAnalysisTemplateService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 能流模型固定测试数据。
const FLOW_MODEL = Object.freeze({
  modelCode: 'FLOW-ROUTE-001',
  modelName: '能流路由测试模型',
  modelSource: '隔离 API 测试',
  modelDocumentNo: 'FLOW-ROUTE-2026',
  modelVersion: 'energy-flow:v1',
  modelEffectiveStartUtc: '2026-01-01T00:00:00Z',
  modelEffectiveEndUtc: '2027-01-01T00:00:00Z',
  sourceTimeZone: 'Asia/Shanghai'
});
// API 挂载前缀；正式 index 本阶段保持不变。
const ROUTE_PREFIX = '/api/energy-flow-imports';
// 原始备份实现，测试结束时必须恢复。
const originalCreateBackup = backupService.createBackup;
// 记录最近一次能流路由请求收到的 context header，验证正式流程明确不携带 demo context。
let lastObservedDemoContextHeader = null;
// 备份桩调用计数。
const backupCounter = { count: 0 };

/**
 * 创建仅挂载待测 router 的隔离 Express 应用。
 * @returns {object} Express 应用。
 */
function createIsolatedApp() {
  const app = express();
  app.use((request, _response, next) => {
    if (request.path.startsWith(ROUTE_PREFIX)) {
      lastObservedDemoContextHeader = request.headers['x-demo-context'] ?? null;
    }
    next();
  });
  // 能流 router 必须先于应用级 JSON parser 挂载，确保匿名畸形/超限 execute 先走认证。
  app.use(ROUTE_PREFIX, energyFlowImportRouter);
  app.use(express.json({ limit: '1mb' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * 返回当前隔离上传目录内的普通文件名。
 * @returns {string[]} 上传文件名列表。
 */
function getUploadFiles() {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs.readdirSync(uploadsDir)
    .filter((name) => fs.statSync(path.join(uploadsDir, name)).isFile())
    .sort();
}

/**
 * 发送 JSON 请求并解析统一响应。
 * @param {object} server HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} requestPath 请求路径。
 * @param {object|undefined} body JSON 请求体。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} HTTP 响应。
 */
function requestJson(server, method, requestPath, body, token = null) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return requestRawJson(server, method, requestPath, raw, token);
}

/**
 * 发送原始 JSON 文本，用于验证畸形和超限请求的中间件顺序。
 * @param {object} server HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} requestPath 请求路径。
 * @param {string} rawBody 原始请求体。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} HTTP 响应。
 */
function requestRawJson(server, method, requestPath, rawBody, token = null) {
  const raw = String(rawBody || '');
  const requestHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  assert.strictEqual(Object.keys(requestHeaders).some((headerName) => headerName.toLowerCase() === 'x-demo-context'), false,
    '正式能流 JSON helper 不得携带 X-Demo-Context。');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: requestPath,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsedBody = null;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch (_error) {
          parsedBody = text;
        }
        resolve({ status: response.statusCode, headers: response.headers, body: parsedBody, text, requestHeaders });
      });
    });
    request.on('error', reject);
    request.end(raw);
  });
}

/**
 * 发送单文件 multipart 请求；file=null 时生成不含文件字段的表单。
 * @param {object} server HTTP 服务。
 * @param {string} requestPath 请求路径。
 * @param {object|null} file 文件定义。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} HTTP 响应。
 */
function requestMultipart(server, requestPath, file, token = null) {
  const boundary = `----energy-flow-route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts = [];
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName || 'file'}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`,
      'utf8'
    ));
    parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ''), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const requestBody = Buffer.concat(parts);
  const requestHeaders = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': requestBody.length,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  assert.strictEqual(Object.keys(requestHeaders).some((headerName) => headerName.toLowerCase() === 'x-demo-context'), false,
    '正式能流 multipart helper 不得携带 X-Demo-Context。');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: requestPath,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null, text, requestHeaders });
      });
    });
    request.on('error', reject);
    request.end(requestBody);
  });
}

/**
 * 将模板内部记录投影为中文表头数组。
 * @param {string} templateType 模板类型。
 * @param {string} sheetName 工作表名称。
 * @param {object} record 内部字段记录。
 * @returns {Array<*>} Excel 数据行。
 */
function projectTemplateRecord(templateType, sheetName, record) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  const sheet = definition.sheets.find((item) => item.name === sheetName);
  return sheet.columns.map((column) => record[column.key] ?? '');
}

/**
 * 创建 XLSX Buffer。
 * @param {Array<object>} sheets 工作表定义。
 * @returns {Buffer} XLSX 内容。
 */
function createWorkbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheetDefinition) => {
    const definition = getEnergyAnalysisTemplateDefinition(sheetDefinition.templateType);
    const sheet = definition.sheets.find((item) => item.name === sheetDefinition.sheetName);
    const rows = [sheet.columns.map((column) => column.name)];
    (sheetDefinition.rows || []).forEach((record) => rows.push(record === null
      ? []
      : projectTemplateRecord(sheetDefinition.templateType, sheetDefinition.sheetName, record)));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetDefinition.sheetName);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 构造合法能流模型导入记录。 */
function createModelRow(overrides = {}) {
  return {
    modelCode: 'FLOW-ROUTE-IMPORTED',
    modelName: '路由批量导入模型',
    source: '隔离 API 测试导入',
    documentNo: 'FLOW-ROUTE-IMPORT-2026',
    version: 'v1',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active',
    ...overrides
  };
}

/**
 * 构造合法能流节点记录。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 节点记录。
 */
function createNodeRow(overrides = {}) {
  return {
    ...FLOW_MODEL,
    nodeCode: 'PROCESS-ROUTE',
    nodeName: '路由导入加工节点',
    nodeType: 'process',
    organizationUnitCode: 'OU-FLOW-ROUTE',
    x: 80,
    y: 120,
    status: 'active',
    ...overrides
  };
}

/**
 * 构造合法能流边记录。
 * @param {string} edgeCode 边编码。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 边记录。
 */
function createEdgeRow(edgeCode, overrides = {}) {
  return {
    modelCode: FLOW_MODEL.modelCode,
    modelVersion: FLOW_MODEL.modelVersion,
    edgeCode,
    fromNodeCode: 'SOURCE-ROUTE',
    toNodeCode: 'SINK-ROUTE',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceReference: `explicit-edge:${edgeCode}`,
    status: 'active',
    ...overrides
  };
}

/**
 * 构造合法显式边值记录。
 * @param {string} edgeCode 边编码。
 * @param {string} startUtc 开始时间。
 * @param {string} endUtc 结束时间。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 显式边值记录。
 */
function createRecordRow(edgeCode, startUtc, endUtc, overrides = {}) {
  return {
    modelCode: FLOW_MODEL.modelCode,
    modelVersion: FLOW_MODEL.modelVersion,
    edgeCode,
    startUtc,
    endUtc,
    sourceTimeZone: 'Asia/Shanghai',
    originalUnit: 'kWh',
    originalValue: 1000,
    sourceReference: `upload:${edgeCode}`,
    formulaVersion: 'energy-flow:v1',
    recordStatus: 'active',
    ...overrides
  };
}

/**
 * 创建合法双工作表文件。
 * @param {string} edgeCode 边编码。
 * @param {string} startUtc 开始时间。
 * @param {string} endUtc 结束时间。
 * @param {object} options 可选行配置。
 * @returns {Buffer} XLSX 内容。
 */
function createBundleBuffer(edgeCode, startUtc, endUtc, options = {}) {
  return createWorkbookBuffer([
    {
      templateType: 'energy-flow-edges',
      sheetName: '能流边',
      rows: options.edgeRows || [createEdgeRow(edgeCode)]
    },
    {
      templateType: 'energy-flow-edges',
      sheetName: '显式边值',
      rows: options.recordRows || [createRecordRow(edgeCode, startUtc, endUtc)]
    }
  ]);
}

/**
 * 插入能流模型、组织和两个端点节点。
 * @returns {object} 主数据 ID。
 */
function seedFlowMasterData() {
  const database = openDatabase();
  try {
    const organizationId = Number(database.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('OU-FLOW-ROUTE', '能流路由测试单元', '/OU-FLOW-ROUTE', 'workshop', 'active')`
    ).run().lastInsertRowid);
    const modelId = Number(database.prepare(
      `INSERT INTO energy_flow_models (
         model_code, model_name, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).run(
      FLOW_MODEL.modelCode,
      FLOW_MODEL.modelName,
      FLOW_MODEL.modelSource,
      FLOW_MODEL.modelDocumentNo,
      FLOW_MODEL.modelVersion,
      FLOW_MODEL.modelEffectiveStartUtc,
      FLOW_MODEL.modelEffectiveEndUtc,
      FLOW_MODEL.sourceTimeZone
    ).lastInsertRowid);
    const insertNode = database.prepare(
      `INSERT INTO energy_flow_nodes (
         energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    );
    const sourceNodeId = Number(insertNode.run(modelId, 'SOURCE-ROUTE', '来源节点', 'source', organizationId, 10, 20).lastInsertRowid);
    const sinkNodeId = Number(insertNode.run(modelId, 'SINK-ROUTE', '去向节点', 'sink', organizationId, 200, 20).lastInsertRowid);
    return { organizationId, modelId, sourceNodeId, sinkNodeId };
  } finally {
    database.close();
  }
}

/**
 * 构造模型和节点 execute 客户端最小契约。
 * @param {object} preview 节点 preview。
 * @returns {object} execute 请求体。
 */
function buildNodeExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/**
 * 构造双批次客户端最小 execute 请求，不携带候选、摘要或签名。
 * @param {object} preview 双批次 preview。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 最小 execute 请求体。
 */
function buildBundleExecuteBody(preview, overrides = {}) {
  return {
    edgeBatchId: preview.edgeBatchId,
    recordBatchId: preview.recordBatchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    ...overrides
  };
}

/**
 * 断言 4xx 响应中的稳定领域错误码。
 * @param {object} response HTTP 响应。
 * @param {string} expectedCode 预期 details.code 或顶层错误码。
 */
function assertStableClientError(response, expectedCode) {
  assert(response.status >= 400 && response.status < 500, `预期稳定 4xx，实际 ${response.status}: ${response.text}`);
  assert.strictEqual(response.body?.error?.details?.code || response.body?.error?.code, expectedCode, response.text);
}

/**
 * 查询批次阶段和状态。
 * @param {number[]} batchIds 批次 ID。
 * @returns {object[]} 批次状态。
 */
function getBatchStates(batchIds) {
  const database = openDatabase();
  try {
    const placeholders = batchIds.map(() => '?').join(', ');
    return database.prepare(
      `SELECT id, audit_phase AS auditPhase, status, execute_result_json AS executeResultJson,
              backup_json AS backupJson, success_count AS successCount
       FROM import_batches WHERE id IN (${placeholders}) ORDER BY id`
    ).all(...batchIds);
  } finally {
    database.close();
  }
}

/**
 * 统计隔离数据库中的导入审计批次数量。
 * @returns {number} 批次数量。
 */
function countImportBatches() {
  const database = openDatabase();
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count);
  } finally {
    database.close();
  }
}

/** 返回正式 no-context 导入不得触碰的四张 demo 治理表完整快照。 */
function snapshotDemoGovernanceTables() {
  const database = openDatabase();
  try {
    return {
      registry: database.prepare('SELECT * FROM demo_data_registry ORDER BY registry_id').all(),
      relations: database.prepare('SELECT * FROM demo_data_relations ORDER BY relation_id').all(),
      batchLinks: database.prepare('SELECT * FROM demo_run_import_batches ORDER BY id').all(),
      contexts: database.prepare('SELECT * FROM demo_import_contexts ORDER BY context_id').all()
    };
  } finally {
    database.close();
  }
}

/**
 * 创建 bundle preview 请求。
 * @param {object} server HTTP 服务。
 * @param {string} token 管理员 Token。
 * @param {string} filename 文件名。
 * @param {string} edgeCode 边编码。
 * @param {string} startUtc 开始时间。
 * @param {string} endUtc 结束时间。
 * @param {object} options 文件行配置。
 * @returns {Promise<object>} preview 数据。
 */
async function createBundlePreview(server, token, filename, edgeCode, startUtc, endUtc, options = {}) {
  const response = await requestMultipart(server, `${ROUTE_PREFIX}/bundle/preview`, {
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: createBundleBuffer(edgeCode, startUtc, endUtc, options)
  }, token);
  assert.strictEqual(response.status, 200, response.text);
  assert.strictEqual(response.body.success, true);
  return response.body.data;
}

/**
 * 验证 router 只暴露六个 POST 路由且权限常量稳定。
 */
function assertRouteContract() {
  assert.strictEqual(energyFlowImportRouter.ENERGY_FLOW_IMPORT_PREVIEW_PERMISSION, 'energy:flows:import:preview');
  assert.strictEqual(energyFlowImportRouter.ENERGY_FLOW_IMPORT_EXECUTE_PERMISSION, 'energy:flows:import:execute');
  assert.deepStrictEqual(energyFlowImportRouter.ENERGY_FLOW_IMPORT_PERMISSIONS, {
    preview: 'energy:flows:import:preview',
    execute: 'energy:flows:import:execute'
  });
  const routeContracts = energyFlowImportRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).sort() }));
  assert.deepStrictEqual(routeContracts, [
    { path: '/models/preview', methods: ['post'] },
    { path: '/models/execute', methods: ['post'] },
    { path: '/nodes/preview', methods: ['post'] },
    { path: '/nodes/execute', methods: ['post'] },
    { path: '/bundle/preview', methods: ['post'] },
    { path: '/bundle/execute', methods: ['post'] },
    { path: '/workbook/preview', methods: ['post'] },
    { path: '/workbook/execute', methods: ['post'] }
  ]);
  assert(!routeContracts.some((item) => item.path.includes('template')), '本阶段不得新增模板路由。');
}

/**
 * 执行隔离 API 测试。
 */
async function run() {
  let server = null;
  try {
    initDatabase();
    assert.strictEqual(path.resolve(process.env.SQLITE_PATH), path.resolve(temporaryDatabasePath));
    assert.strictEqual(path.resolve(uploadsDir), path.resolve(temporaryUploadsDir));
    assertRouteContract();
    const master = seedFlowMasterData();
    register({ username: 'flow-route-reader', password: 'Password123!' });
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    const ordinaryToken = login({ username: 'flow-route-reader', password: 'Password123!' }).token;

    backupService.createBackup = async ({ reason, skipCheckpoint }) => {
      backupCounter.count += 1;
      assert.strictEqual(reason, ENERGY_ANALYSIS_IMPORT_BACKUP_REASON);
      assert.strictEqual(skipCheckpoint, true);
      return {
        backupName: `energy-flow-route-${backupCounter.count}.sqlite`,
        reason,
        sizeBytes: 1024,
        sha256: 'b'.repeat(64),
        method: 'api-test-stub',
        createdAt: '2026-08-06T00:00:00Z'
      };
    };

    const app = createIsolatedApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // execute 的 JSON 解析必须位于认证、权限和维护态之后，且解析错误保持稳定脱敏。
    const executePaths = [`${ROUTE_PREFIX}/models/execute`, `${ROUTE_PREFIX}/nodes/execute`, `${ROUTE_PREFIX}/bundle/execute`];
    const malformedMarker = 'route-parser-sensitive-malformed';
    const oversizedMarker = 'route-parser-sensitive-oversized';
    const malformedJson = `{"sensitive":"${malformedMarker}"`;
    const oversizedJson = JSON.stringify({ sensitive: oversizedMarker, padding: 'x'.repeat(70 * 1024) });
    for (const executePath of executePaths) {
      const anonymousLegal = await requestRawJson(server, 'POST', executePath, '{}');
      assert.strictEqual(anonymousLegal.status, 401, `${executePath} 匿名合法 JSON 必须先返回 401。`);
      assert.strictEqual(anonymousLegal.body.error.code, 'UNAUTHENTICATED');

      const anonymousMalformed = await requestRawJson(server, 'POST', executePath, malformedJson);
      assert.strictEqual(anonymousMalformed.status, 401, `${executePath} 匿名畸形 JSON 不得在认证前解析。`);
      assert.strictEqual(anonymousMalformed.body.error.code, 'UNAUTHENTICATED');
      assert(!anonymousMalformed.text.includes(malformedMarker));

      const anonymousOversized = await requestRawJson(server, 'POST', executePath, oversizedJson);
      assert.strictEqual(anonymousOversized.status, 401, `${executePath} 匿名超限 JSON 不得在认证前解析。`);
      assert.strictEqual(anonymousOversized.body.error.code, 'UNAUTHENTICATED');
      assert(!anonymousOversized.text.includes(oversizedMarker));

      const authorizedMalformed = await requestRawJson(server, 'POST', executePath, malformedJson, adminToken);
      assert.strictEqual(authorizedMalformed.status, 400, `${executePath} 已授权畸形 JSON 必须返回 400。`);
      assert.strictEqual(authorizedMalformed.body.error.code, 'INVALID_JSON_BODY');
      assert(!authorizedMalformed.text.includes(malformedMarker));
      assert(!authorizedMalformed.text.includes(temporaryRoot));
      assert(!authorizedMalformed.text.includes(process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET));
      assert(!authorizedMalformed.text.includes('SyntaxError'));
      assert(!authorizedMalformed.text.includes('stack'));

      const authorizedOversized = await requestRawJson(server, 'POST', executePath, oversizedJson, adminToken);
      assert.strictEqual(authorizedOversized.status, 413, `${executePath} 已授权超限 JSON 必须返回 413。`);
      assert.strictEqual(authorizedOversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');
      assert.strictEqual(authorizedOversized.body.error.details.maxBodyBytes, 64 * 1024);
      assert(!authorizedOversized.text.includes(oversizedMarker));
      assert(!authorizedOversized.text.includes(temporaryRoot));
      assert(!authorizedOversized.text.includes(process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET));
      assert(!authorizedOversized.text.includes('entity.too.large'));
      assert(!authorizedOversized.text.includes('stack'));
    }

    const modelRows = Array.from({ length: 200 }, (_unused, index) => createModelRow({
      modelCode: `FLOW-ROUTE-IMPORTED-${String(index + 1).padStart(3, '0')}`,
      modelName: `路由批量导入模型 ${index + 1}`,
      documentNo: `FLOW-ROUTE-IMPORT-2026-${String(index + 1).padStart(3, '0')}`,
      version: index === 199 ? `V${'1'.repeat(63)}` : 'v1'
    }));
    const validModelXlsx = createWorkbookBuffer([{
      templateType: 'energy-flow-models',
      sheetName: '能流模型',
      rows: modelRows
    }]);
    const anonymousModel = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'anonymous-model.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validModelXlsx
    });
    assert.strictEqual(anonymousModel.status, 401);
    const forbiddenModel = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'forbidden-model.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validModelXlsx
    }, ordinaryToken);
    assert.strictEqual(forbiddenModel.status, 403);
    assert.strictEqual(getUploadFiles().length, 0);
    const modelPreviewResponse = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'energy-flow-models.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validModelXlsx
    }, adminToken);
    assert.strictEqual(modelPreviewResponse.status, 200, modelPreviewResponse.text);
    const modelPreview = modelPreviewResponse.body.data;
    assert.strictEqual(modelPreview.confirmText, '确认导入能流模型');
    assert.strictEqual(modelPreview.auditBatch.importType, 'energy_flow_model');
    assert.strictEqual(modelPreview.expectedWouldImport, 200);
    const modelExecuteBody = buildNodeExecuteBody(modelPreview);
    assert(Buffer.byteLength(JSON.stringify(modelExecuteBody), 'utf8') < 64 * 1024, '200 行模型 execute 请求体必须小于 64 KiB。');
    assert(!Object.prototype.hasOwnProperty.call(modelExecuteBody, 'candidateRows'));
    assert(!Object.prototype.hasOwnProperty.call(modelExecuteBody, 'candidateRowIds'));
    const forbiddenModelExecute = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/execute`, modelExecuteBody, ordinaryToken);
    assert.strictEqual(forbiddenModelExecute.status, 403);
    await runWithMaintenance('energy-flow-model-execute-maintenance', async () => {
      const blockedModelExecute = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/execute`, modelExecuteBody, adminToken);
      assert.strictEqual(blockedModelExecute.status, 423);
    });
    const modelExecute = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/execute`, modelExecuteBody, adminToken);
    assert.strictEqual(modelExecute.status, 200, modelExecute.text);
    assert.strictEqual(modelExecute.body.data.imported, 200);
    const modelAuditDatabase = openDatabase();
    try {
      const audit = modelAuditDatabase.prepare("SELECT user_id AS userId, operation, ip FROM sys_operation_logs WHERE operation = 'energy-flow-model-import' ORDER BY id DESC LIMIT 1").get();
      assert(Number.isSafeInteger(audit.userId) && audit.userId > 0, '模型导入 actor 必须来自认证用户。');
      assert.strictEqual(audit.operation, 'energy-flow-model-import');
    } finally {
      modelAuditDatabase.close();
    }
    const canonicalModelPreviewResponse = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'energy-flow-models-canonical-skip.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createWorkbookBuffer([{
        templateType: 'energy-flow-models',
        sheetName: '能流模型',
        rows: [createModelRow({
          modelCode: modelRows[0].modelCode.toLowerCase(),
          modelName: modelRows[0].modelName,
          documentNo: modelRows[0].documentNo,
          version: 'V1'
        })]
      }])
    }, adminToken);
    assert.strictEqual(canonicalModelPreviewResponse.status, 200, canonicalModelPreviewResponse.text);
    assert.strictEqual(canonicalModelPreviewResponse.body.data.expectedWouldImport, 0);
    assert.strictEqual(canonicalModelPreviewResponse.body.data.summary.skipped, 1);
    assert(!/INTERNAL_ERROR|SQLITE|UNIQUE|ux_energy_flow/i.test(canonicalModelPreviewResponse.text));
    const invalidModelPreviewResponse = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'energy-flow-models-invalid-identity.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createWorkbookBuffer([{
        templateType: 'energy-flow-models',
        sheetName: '能流模型',
        rows: [createModelRow({ modelCode: 'ＦＬＯＷ-ROUTE-INVALID' })]
      }])
    }, adminToken);
    assert.strictEqual(invalidModelPreviewResponse.status, 200, invalidModelPreviewResponse.text);
    assert.strictEqual(invalidModelPreviewResponse.body.data.expectedWouldImport, 0);
    assert.strictEqual(invalidModelPreviewResponse.body.data.summary.blocked, 1);
    assert(invalidModelPreviewResponse.body.data.auditIssues.some(
      (issue) => issue.code === 'INVALID_ENERGY_FLOW_IDENTITY'
    ));

    const overLengthVersionPreviewResponse = await requestMultipart(server, `${ROUTE_PREFIX}/models/preview`, {
      filename: 'energy-flow-models-invalid-version-length.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createWorkbookBuffer([{
        templateType: 'energy-flow-models',
        sheetName: '能流模型',
        rows: [createModelRow({
          modelCode: 'FLOW-ROUTE-INVALID-VERSION',
          version: `V${'1'.repeat(64)}`
        })]
      }])
    }, adminToken);
    assert.strictEqual(overLengthVersionPreviewResponse.status, 200, overLengthVersionPreviewResponse.text);
    assert.strictEqual(overLengthVersionPreviewResponse.body.data.expectedWouldImport, 0);
    assert.strictEqual(overLengthVersionPreviewResponse.body.data.summary.blocked, 1);
    assert.strictEqual(overLengthVersionPreviewResponse.body.data.candidateRows.length, 0);
    assert(overLengthVersionPreviewResponse.body.data.auditIssues.some(
      (issue) => issue.code === 'INVALID_ENERGY_FLOW_MODEL_VERSION' && issue.fieldName === 'version'
    ));
    const modelBackupCountBeforeBlockedVersionExecute = backupCounter.count;
    const overLengthVersionExecuteResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_PREFIX}/models/execute`,
      buildNodeExecuteBody(overLengthVersionPreviewResponse.body.data),
      adminToken
    );
    assertStableClientError(overLengthVersionExecuteResponse, 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED');
    assert.strictEqual(backupCounter.count, modelBackupCountBeforeBlockedVersionExecute);

    const modelBackupCountBeforeBlockedExecute = backupCounter.count;
    const invalidModelExecuteResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_PREFIX}/models/execute`,
      buildNodeExecuteBody(invalidModelPreviewResponse.body.data),
      adminToken
    );
    assertStableClientError(invalidModelExecuteResponse, 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED');
    assert.strictEqual(backupCounter.count, modelBackupCountBeforeBlockedExecute);
    getUploadFiles().forEach((filename) => fs.unlinkSync(path.join(uploadsDir, filename)));

    const validNodeXlsx = createWorkbookBuffer([{
      templateType: 'energy-flow-nodes',
      sheetName: '能流节点',
      rows: [createNodeRow({ nodeCode: 'AUTH-NODE' })]
    }]);

    // 认证、权限和维护态必须全部发生在 Multer 落盘前。
    const anonymous = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      filename: 'anonymous.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validNodeXlsx
    });
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');
    assert.strictEqual(getUploadFiles().length, 0);

    const forbidden = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      filename: 'forbidden.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validNodeXlsx
    }, ordinaryToken);
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');
    assert.strictEqual(getUploadFiles().length, 0);

    await runWithMaintenance('energy-flow-route-maintenance', async () => {
      const blocked = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
        filename: 'maintenance.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: validNodeXlsx
      }, adminToken);
      assert.strictEqual(blocked.status, 423);
      assert.strictEqual(blocked.body.error.code, 'MAINTENANCE_IN_PROGRESS');
      assert.strictEqual(getUploadFiles().length, 0, '维护态拒绝时不得落盘。');
    });

    // Multer 缺文件、字段名错误、扩展名错误、伪装损坏和缺工作表均清理干净。
    const missingFile = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, null, adminToken);
    assertStableClientError(missingFile, 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED');
    assert.strictEqual(getUploadFiles().length, 0);

    const wrongField = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      fieldName: 'upload',
      filename: 'wrong-field.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: validNodeXlsx
    }, adminToken);
    assert.strictEqual(wrongField.status, 400);
    assert.strictEqual(wrongField.body.error.code, 'IMPORT_UPLOAD_FAILED');
    assert.strictEqual(getUploadFiles().length, 0);

    const wrongExtension = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      filename: 'wrong-extension.txt',
      mimeType: 'text/plain',
      content: 'not a table'
    }, adminToken);
    assert.strictEqual(wrongExtension.status, 400);
    assert.strictEqual(wrongExtension.body.error.code, 'UNSUPPORTED_IMPORT_FILE_TYPE');
    assert.strictEqual(getUploadFiles().length, 0);

    const damagedWorkbook = await requestMultipart(server, `${ROUTE_PREFIX}/bundle/preview`, {
      filename: 'damaged.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: 'not-an-xlsx'
    }, adminToken);
    assert.strictEqual(damagedWorkbook.status, 400);
    assert.strictEqual(getUploadFiles().length, 0, '损坏 XLSX 解析失败后必须清理。');

    const disguisedBundle = await requestMultipart(server, `${ROUTE_PREFIX}/bundle/preview`, {
      filename: 'bundle-disguised.xls',
      mimeType: 'application/vnd.ms-excel',
      content: '模型编码,模型版本\nFLOW-ROUTE-001,energy-flow:v1\n'
    }, adminToken);
    assertStableClientError(disguisedBundle, 'ENERGY_FLOW_BUNDLE_XLSX_REQUIRED');
    assert.strictEqual(getUploadFiles().length, 0, 'bundle 非 XLSX 文件必须清理。');

    const missingSheetBuffer = createWorkbookBuffer([{
      templateType: 'energy-flow-edges',
      sheetName: '能流边',
      rows: [createEdgeRow('EDGE-MISSING-SHEET')]
    }]);
    const batchCountBeforeMissingSheet = countImportBatches();
    const missingSheet = await requestMultipart(server, `${ROUTE_PREFIX}/bundle/preview`, {
      filename: 'missing-sheet.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: missingSheetBuffer
    }, adminToken);
    assertStableClientError(missingSheet, 'ENERGY_FLOW_BUNDLE_WORKBOOK_STRUCTURE_INVALID');
    assert.strictEqual(getUploadFiles().length, 0, '缺工作表失败后必须清理文件。');
    assert.strictEqual(countImportBatches(), batchCountBeforeMissingSheet, '缺工作表预检不得创建审计批次。');

    const invalidNodeIdentityResponse = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      filename: 'energy-flow-nodes-invalid-identity.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createWorkbookBuffer([{
        templateType: 'energy-flow-nodes',
        sheetName: '能流节点',
        rows: [createNodeRow({ nodeCode: 'ＮＯＤＥ-ROUTE' })]
      }])
    }, adminToken);
    assert.strictEqual(invalidNodeIdentityResponse.status, 200, invalidNodeIdentityResponse.text);
    assert.strictEqual(invalidNodeIdentityResponse.body.data.expectedWouldImport, 0);
    assert.strictEqual(invalidNodeIdentityResponse.body.data.summary.blocked, 1);
    assert(invalidNodeIdentityResponse.body.data.auditIssues.some(
      (issue) => issue.code === 'INVALID_ENERGY_FLOW_IDENTITY'
    ));
    getUploadFiles().forEach((filename) => fs.unlinkSync(path.join(uploadsDir, filename)));

    // 节点 CSV preview/execute 覆盖服务允许格式、成功保留和来源追溯。
    const nodeDefinition = getEnergyAnalysisTemplateDefinition('energy-flow-nodes').sheets[0];
    const nodeCsv = [
      nodeDefinition.columns.map((column) => column.name).join(','),
      nodeDefinition.columns.map((column) => createNodeRow()[column.key] ?? '').join(',')
    ].join('\n') + '\n';
    const nodePreviewResponse = await requestMultipart(server, `${ROUTE_PREFIX}/nodes/preview`, {
      filename: 'energy-flow-nodes.csv',
      mimeType: 'text/csv',
      content: nodeCsv
    }, adminToken);
    assert.strictEqual(nodePreviewResponse.status, 200, nodePreviewResponse.text);
    const nodePreview = nodePreviewResponse.body.data;
    assert.strictEqual(nodePreview.expectedWouldImport, 1);
    assert.strictEqual(nodePreview.auditBatch.importType, 'energy_flow_node');
    assert.strictEqual(getUploadFiles().length, 1, '节点 preview 成功后必须保留原文件。');

    const executeForbidden = await requestJson(server, 'POST', `${ROUTE_PREFIX}/nodes/execute`, buildNodeExecuteBody(nodePreview), ordinaryToken);
    assert.strictEqual(executeForbidden.status, 403);
    await runWithMaintenance('energy-flow-node-execute-maintenance', async () => {
      const blocked = await requestJson(server, 'POST', `${ROUTE_PREFIX}/nodes/execute`, buildNodeExecuteBody(nodePreview), adminToken);
      assert.strictEqual(blocked.status, 423);
    });
    const nodeExecute = await requestJson(server, 'POST', `${ROUTE_PREFIX}/nodes/execute`, buildNodeExecuteBody(nodePreview), adminToken);
    assert.strictEqual(nodeExecute.status, 200, nodeExecute.text);
    assert.strictEqual(nodeExecute.body.data.imported, 1);
    const nodeDatabase = openDatabase();
    try {
      const importedNode = nodeDatabase.prepare(
        `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
         FROM energy_flow_nodes WHERE node_code = 'PROCESS-ROUTE'`
      ).get();
      assert.strictEqual(importedNode.sourceBatchId, nodePreview.batchId);
      assert.strictEqual(importedNode.sourceRowNumber, 2);
    } finally {
      nodeDatabase.close();
    }

    const retainedUploadFilesBeforeInvalidEdge = new Set(getUploadFiles());
    const invalidEdgeCode = 'ＥＤＧＥ-ROUTE-INVALID';
    const invalidEdgeIdentityResponse = await requestMultipart(server, `${ROUTE_PREFIX}/bundle/preview`, {
      filename: 'energy-flow-bundle-invalid-identity.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: createBundleBuffer(
        invalidEdgeCode,
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:00Z'
      )
    }, adminToken);
    assert.strictEqual(invalidEdgeIdentityResponse.status, 200, invalidEdgeIdentityResponse.text);
    assert.strictEqual(invalidEdgeIdentityResponse.body.data.expectedWouldImport, 0);
    assert.strictEqual(invalidEdgeIdentityResponse.body.data.edgePreview.summary.blocked, 1);
    assert.strictEqual(invalidEdgeIdentityResponse.body.data.recordPreview.summary.blocked, 1);
    assert(invalidEdgeIdentityResponse.body.data.auditIssues.some(
      (issue) => issue.code === 'INVALID_ENERGY_FLOW_IDENTITY'
    ));
    const bundleBackupCountBeforeBlockedExecute = backupCounter.count;
    const invalidEdgeExecuteResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_PREFIX}/bundle/execute`,
      buildBundleExecuteBody(invalidEdgeIdentityResponse.body.data),
      adminToken
    );
    assertStableClientError(invalidEdgeExecuteResponse, 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED');
    assert.strictEqual(backupCounter.count, bundleBackupCountBeforeBlockedExecute);
    getUploadFiles()
      .filter((filename) => !retainedUploadFilesBeforeInvalidEdge.has(filename))
      .forEach((filename) => fs.unlinkSync(path.join(uploadsDir, filename)));

    // 正式 no-context bundle 必须保留全部 demo 治理快照，且 preview/execute 请求均不能携带 X-Demo-Context。
    const formalGovernanceBefore = snapshotDemoGovernanceTables();
    const bundlePreview = await createBundlePreview(
      server,
      adminToken,
      'bundle-success.xlsx',
      'EDGE-API-SUCCESS',
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z'
    );
    assert.strictEqual(lastObservedDemoContextHeader, null,
      '正式 bundle preview 必须明确不携带 X-Demo-Context。');
    assert.notStrictEqual(bundlePreview.edgeBatchId, bundlePreview.recordBatchId);
    assert.strictEqual(bundlePreview.expectedWouldImport, 2);
    assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].startUtc, '2026-01-01T00:00:00Z');
    assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].endUtc, '2026-02-01T00:00:00Z');
    assert.strictEqual(getUploadFiles().length, 2, 'bundle preview 成功后必须保留原文件。');
    const minimalBundleBody = buildBundleExecuteBody(bundlePreview, {
      candidateRows: [{ candidateRowId: 'forged', edgeCode: 'FORGED' }],
      candidateRowIds: ['forged'],
      expectedWouldImport: 999,
      fileSha256: '0'.repeat(64),
      previewSignature: 'forged'
    });
    const bundleExecute = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, minimalBundleBody, adminToken);
    assert.strictEqual(lastObservedDemoContextHeader, null,
      '正式 bundle execute 必须明确不携带 X-Demo-Context。');
    assert.strictEqual(bundleExecute.status, 200, bundleExecute.text);
    assert.strictEqual(bundleExecute.body.data.edge.imported, 1);
    assert.strictEqual(bundleExecute.body.data.record.imported, 1);
    assert.strictEqual(bundleExecute.body.data.edgeBatch.id, bundlePreview.edgeBatchId);
    assert.strictEqual(bundleExecute.body.data.recordBatch.id, bundlePreview.recordBatchId);
    const safeSuccessText = JSON.stringify(bundleExecute.body);
    assert(!safeSuccessText.includes(temporaryRoot), '成功响应不得包含临时目录或文件路径。');
    assert(!safeSuccessText.includes(process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET), '成功响应不得包含 HMAC 密钥。');
    assert(!safeSuccessText.includes('FORGED'), '客户端伪造候选不得进入执行结果。');

    const successDatabase = openDatabase();
    try {
      const audits = successDatabase.prepare(
        `SELECT id, import_type AS importType, audit_phase AS auditPhase, status,
                success_count AS successCount, execute_result_json AS executeResultJson,
                backup_json AS backupJson
         FROM import_batches WHERE id IN (?, ?) ORDER BY id`
      ).all(bundlePreview.edgeBatchId, bundlePreview.recordBatchId);
      assert.strictEqual(audits.length, 2);
      assert(audits.every((batch) => batch.auditPhase === 'execute'));
      assert(audits.every((batch) => ['completed', 'completed_with_errors'].includes(batch.status)));
      assert.deepStrictEqual(audits.map((batch) => batch.importType), ['energy_flow_edge', 'energy_flow_record']);
      assert.deepStrictEqual(audits.map((batch) => batch.successCount), [1, 1]);
      assert.strictEqual(audits[0].backupJson, audits[1].backupJson, '双批次必须记录同一备份摘要。');
      const executeResults = audits.map((batch) => JSON.parse(batch.executeResultJson));
      assert.strictEqual(executeResults[0].uploadGroupId, executeResults[1].uploadGroupId);
      const persistedRecordRange = successDatabase.prepare(`SELECT record.start_utc AS startUtc,
          record.end_utc AS endUtc
        FROM energy_flow_records record
        INNER JOIN energy_flow_edges edge ON edge.id = record.energy_flow_edge_id
        WHERE edge.edge_code = 'EDGE-API-SUCCESS'`).get();
      assert.strictEqual(persistedRecordRange.startUtc, '2026-01-01T00:00:00Z');
      assert.strictEqual(persistedRecordRange.endUtc, '2026-02-01T00:00:00Z');
      assert.deepStrictEqual(successDatabase.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      successDatabase.close();
    }
    assert.deepStrictEqual(snapshotDemoGovernanceTables(), formalGovernanceBefore,
      '正式 no-context bundle preview/execute 不得创建 registry、relation、batch link 或 demo context。');

    // 跨组和角色串换必须保持原 preview 批次不变，随后正确路由仍可执行。
    const pairA = await createBundlePreview(server, adminToken, 'pair-a.xlsx', 'EDGE-PAIR-A-API', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
    const pairB = await createBundlePreview(server, adminToken, 'pair-b.xlsx', 'EDGE-PAIR-B-API', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    const crossPair = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(pairA, {
      recordBatchId: pairB.recordBatchId
    }), adminToken);
    assertStableClientError(crossPair, 'ENERGY_FLOW_BUNDLE_STORED_FILE_MISMATCH');
    assert(getBatchStates([pairA.edgeBatchId, pairA.recordBatchId, pairB.edgeBatchId, pairB.recordBatchId])
      .every((batch) => batch.auditPhase === 'preview'));

    const swappedRoles = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(pairA, {
      edgeBatchId: pairA.recordBatchId,
      recordBatchId: pairA.edgeBatchId
    }), adminToken);
    assertStableClientError(swappedRoles, 'ENERGY_FLOW_BUNDLE_EDGE_OPERATION_MISMATCH');
    assert(getBatchStates([pairA.edgeBatchId, pairA.recordBatchId]).every((batch) => batch.auditPhase === 'preview'));
    assert.strictEqual((await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(pairA), adminToken)).status, 200);
    assert.strictEqual((await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(pairB), adminToken)).status, 200);

    // 错误确认在服务前拒绝，不污染批次；正确确认随后成功。
    const confirmPreview = await createBundlePreview(server, adminToken, 'wrong-confirm.xlsx', 'EDGE-CONFIRM-API', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z');
    const wrongConfirm = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(confirmPreview, {
      confirmText: '错误确认'
    }), adminToken);
    assertStableClientError(wrongConfirm, 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH');
    assert(getBatchStates([confirmPreview.edgeBatchId, confirmPreview.recordBatchId]).every((batch) => batch.auditPhase === 'preview'));
    assert.strictEqual((await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(confirmPreview), adminToken)).status, 200);

    // 原文件篡改在服务前拒绝并保留 preview；恢复原字节后正确执行。
    const tamperPreview = await createBundlePreview(server, adminToken, 'file-tamper.xlsx', 'EDGE-FILE-TAMPER-API', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
    const tamperBatch = getImportAuditBatchDetail(tamperPreview.edgeBatchId, { includeIssues: false });
    const tamperPath = path.join(uploadsDir, tamperBatch.storedFilename);
    const originalFileBuffer = fs.readFileSync(tamperPath);
    fs.appendFileSync(tamperPath, Buffer.from([0]));
    const tampered = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(tamperPreview), adminToken);
    assertStableClientError(tampered, 'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH');
    assert(getBatchStates([tamperPreview.edgeBatchId, tamperPreview.recordBatchId]).every((batch) => batch.auditPhase === 'preview'));
    fs.writeFileSync(tamperPath, originalFileBuffer);
    assert.strictEqual((await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(tamperPreview), adminToken)).status, 200);

    // stale 候选在服务前拒绝并保持 preview；移除并发事实后正确执行。
    const stalePreview = await createBundlePreview(server, adminToken, 'stale.xlsx', 'EDGE-STALE-API', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', {
      recordRows: []
    });
    const staleDatabase = openDatabase();
    let staleEdgeId;
    try {
      const energyTypeId = staleDatabase.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      staleEdgeId = Number(staleDatabase.prepare(
        `INSERT INTO energy_flow_edges (
           energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
           unit, source_type, source_mapping_json, status
         ) VALUES (?, 'edge-stale-api', ?, ?, ?, 'kWh', 'explicit_edge_value', ?, 'active')`
      ).run(master.modelId, master.sourceNodeId, master.sinkNodeId, energyTypeId, JSON.stringify({ reference: 'explicit-edge:EDGE-STALE-API' })).lastInsertRowid);
    } finally {
      staleDatabase.close();
    }
    const stale = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(stalePreview), adminToken);
    assertStableClientError(stale, 'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH');
    assert(getBatchStates([stalePreview.edgeBatchId, stalePreview.recordBatchId]).every((batch) => batch.auditPhase === 'preview'));
    const staleCleanupDatabase = openDatabase();
    try {
      staleCleanupDatabase.prepare('DELETE FROM energy_flow_edges WHERE id = ?').run(staleEdgeId);
    } finally {
      staleCleanupDatabase.close();
    }
    assert.strictEqual((await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(stalePreview), adminToken)).status, 200);

    // 备份 API 异常只返回稳定码，不泄露原始异常，并保持业务表不变、双审计一致失败。
    const backupFailurePreview = await createBundlePreview(server, adminToken, 'backup-failure.xlsx', 'EDGE-BACKUP-FAIL-API', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', {
      recordRows: []
    });
    const edgeCountBeforeBackupFailure = (() => {
      const database = openDatabase();
      try { return Number(database.prepare('SELECT COUNT(*) AS count FROM energy_flow_edges').get().count); } finally { database.close(); }
    })();
    backupService.createBackup = async () => {
      throw new Error(`backup raw failure ${temporaryRoot} ${process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET}`);
    };
    const backupFailure = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(backupFailurePreview), adminToken);
    assertStableClientError(backupFailure, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
    assert(!backupFailure.text.includes(temporaryRoot));
    assert(!backupFailure.text.includes(process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET));
    const backupFailureStates = getBatchStates([backupFailurePreview.edgeBatchId, backupFailurePreview.recordBatchId]);
    assert(backupFailureStates.every((batch) => batch.auditPhase === 'execute' && batch.status === 'failed'));
    assert(backupFailureStates.every((batch) => !String(batch.executeResultJson).includes(temporaryRoot)));
    const edgeCountAfterBackupFailure = (() => {
      const database = openDatabase();
      try { return Number(database.prepare('SELECT COUNT(*) AS count FROM energy_flow_edges').get().count); } finally { database.close(); }
    })();
    assert.strictEqual(edgeCountAfterBackupFailure, edgeCountBeforeBackupFailure);

    // 事务写入异常必须回滚边、记录并原子写入双失败审计，响应不得暴露 SQLite 原始异常。
    backupService.createBackup = async ({ reason }) => ({
      backupName: 'transaction-failure.sqlite',
      reason,
      sizeBytes: 1024,
      sha256: 'c'.repeat(64),
      method: 'api-test-stub',
      createdAt: '2026-08-06T00:00:00Z'
    });
    const transactionPreview = await createBundlePreview(server, adminToken, 'transaction-failure.xlsx', 'EDGE-TRANSACTION-FAIL-API', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
    const transactionDatabase = openDatabase();
    try {
      transactionDatabase.exec(
        `CREATE TRIGGER fail_energy_flow_record_insert
         BEFORE INSERT ON energy_flow_records
         BEGIN
           SELECT RAISE(ABORT, 'raw transaction failure with local path');
         END`
      );
    } finally {
      transactionDatabase.close();
    }
    const transactionFailure = await requestJson(server, 'POST', `${ROUTE_PREFIX}/bundle/execute`, buildBundleExecuteBody(transactionPreview), adminToken);
    assertStableClientError(transactionFailure, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
    assert(!transactionFailure.text.includes('raw transaction failure'));
    const transactionProbeDatabase = openDatabase();
    try {
      assert.strictEqual(transactionProbeDatabase.prepare("SELECT COUNT(*) AS count FROM energy_flow_edges WHERE edge_code = 'EDGE-TRANSACTION-FAIL-API'").get().count, 0);
      assert.strictEqual(transactionProbeDatabase.prepare(
        `SELECT COUNT(*) AS count FROM energy_flow_records AS record
         JOIN energy_flow_edges AS edge ON edge.id = record.energy_flow_edge_id
         WHERE edge.edge_code = 'EDGE-TRANSACTION-FAIL-API'`
      ).get().count, 0);
      transactionProbeDatabase.exec('DROP TRIGGER fail_energy_flow_record_insert');
      assert.deepStrictEqual(transactionProbeDatabase.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      transactionProbeDatabase.close();
    }
    const transactionStates = getBatchStates([transactionPreview.edgeBatchId, transactionPreview.recordBatchId]);
    assert(transactionStates.every((batch) => batch.auditPhase === 'execute' && batch.status === 'failed'));
    assert(transactionStates.every((batch) => !String(batch.executeResultJson).includes('raw transaction failure')));

    // 非零毫秒在 preview 阶段稳定阻断，不得落入 SQLite CHECK 异常或泄露数据库细节。
    const invalidMillisecondPreviewResponse = await requestMultipart(
      server,
      `${ROUTE_PREFIX}/bundle/preview`,
      {
        filename: 'invalid-millisecond.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: createBundleBuffer(
          'EDGE-INVALID-MILLISECOND-API',
          '2026-09-01T00:00:00.001Z',
          '2026-10-01T00:00:00Z'
        )
      },
      adminToken
    );
    assert.strictEqual(invalidMillisecondPreviewResponse.status, 200, invalidMillisecondPreviewResponse.text);
    assert.strictEqual(invalidMillisecondPreviewResponse.body.data.recordPreview.summary.blocked, 1);
    assert(invalidMillisecondPreviewResponse.body.data.recordPreview.auditIssues.some(
      (issue) => issue.code === 'INVALID_START_UTC'
    ));
    assert(!/INTERNAL_ERROR|SQLITE|CHECK constraint/i.test(invalidMillisecondPreviewResponse.text));

    console.log('energy flow import route API tests passed');
  } finally {
    backupService.createBackup = originalCreateBackup;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
