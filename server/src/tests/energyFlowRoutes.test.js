'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

// API 测试根目录，确保 SQLite 和本地目录全部隔离。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-domain-routes-'));
// 隔离 SQLite 文件。
const temporaryDatabasePath = path.join(temporaryRoot, 'energy-flow-domain-routes.sqlite');
process.env.DATA_DIR = temporaryRoot;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowRoutesTest123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyFlowRouter = require('../routes/energyFlows');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 独立 Router 测试挂载前缀；中央 index 不在本任务内修改。
const ROUTE_PREFIX = '/api/energy-flows';

/**
 * 创建仅挂载待测 Router 的隔离 Express 应用。
 * @returns {object} Express 应用。
 */
function createIsolatedApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(ROUTE_PREFIX, energyFlowRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * 发送 JSON 请求并解析统一响应。
 * @param {object} server HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} requestPath 请求路径。
 * @param {object|undefined} body JSON 正文。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} HTTP 响应。
 */
function requestJson(server, method, requestPath, body, token = null) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: requestPath,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null, text });
      });
    });
    request.on('error', reject);
    request.end(rawBody);
  });
}

/**
 * 断言成功响应遵循统一结构。
 * @param {object} response HTTP 响应。
 * @param {number} expectedStatus 预期状态码。
 */
function assertSuccess(response, expectedStatus = 200) {
  assert.strictEqual(response.status, expectedStatus, response.text);
  assert.strictEqual(response.body.success, true);
  assert(Object.prototype.hasOwnProperty.call(response.body, 'data'));
  assert(response.body.meta && typeof response.body.meta === 'object');
}

/**
 * 验证独立 Router 权限、字段和无物理删除契约。
 */
function assertRouterContract() {
  assert.strictEqual(energyFlowRouter.ENERGY_FLOW_VIEW_PERMISSION, 'energy:flows:view');
  assert.strictEqual(energyFlowRouter.ENERGY_FLOW_MANAGE_PERMISSION, 'energy:flows:manage');
  assert(energyFlowRouter.MODEL_WRITE_FIELDS.includes('modelCode'));
  assert(!energyFlowRouter.MODEL_WRITE_FIELDS.includes('db'));
  assert(!energyFlowRouter.ANALYSIS_INPUT_FIELDS.includes('includeDescendants'));
  const routeLayers = energyFlowRouter.stack.filter((layer) => layer.route);
  const methods = routeLayers.flatMap((layer) => Object.keys(layer.route.methods));
  assert(!methods.includes('delete'), '能流独立 Router 不得暴露无保护物理删除。');
  routeLayers.filter((layer) => ['post', 'put', 'patch'].some((method) => layer.route.methods[method]))
    .filter((layer) => !layer.route.path.endsWith('/analysis'))
    .forEach((layer) => {
      const handlerNames = layer.route.stack.map((item) => item.name);
      assert.strictEqual(handlerNames[0], 'authenticate');
      assert.strictEqual(handlerNames.length, 4, '写路由必须按认证、权限、维护态、handler 四层编排。');
    });
  const analysisLayer = routeLayers.find((layer) => layer.route.path.endsWith('/analysis'));
  assert.strictEqual(analysisLayer.route.stack[0].name, 'authenticate');
  assert.strictEqual(analysisLayer.route.stack.length, 3, '只读分析不得挂载维护态阻断。');
}

/**
 * 插入完整月份显式边值供分析路由读取。
 * @param {number} modelId 模型 ID。
 * @param {number} edgeId 边 ID。
 * @param {number} value 数值。
 */
function insertExplicitRecord(modelId, edgeId, value) {
  const db = openDatabase();
  try {
    db.prepare(
      `INSERT INTO energy_flow_records (
         energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
         original_unit, original_value, source_type, source_mapping_json, formula_version, record_status
       ) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'Asia/Shanghai',
         'kWh', ?, 'explicit_edge_value', ?, 'energy-flow:v1', 'active')`
    ).run(modelId, edgeId, value, JSON.stringify({ reference: `route-record:${edgeId}` }));
  } finally {
    db.close();
  }
}

/**
 * 执行隔离 API 测试。
 */
async function run() {
  let server = null;
  try {
    initDatabase();
    assertRouterContract();
    register({ username: 'energy-flow-reader', password: 'Password123!' });
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    const ordinaryToken = login({ username: 'energy-flow-reader', password: 'Password123!' }).token;
    const app = createIsolatedApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // 匿名读取和普通用户写入必须分别返回 401、403。
    const anonymous = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models`);
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');
    const forbidden = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {}, ordinaryToken);
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');

    // 审计写入失败时，模型业务写必须与同连接事务一起回滚。
    const auditFailureDb = openDatabase();
    try {
      auditFailureDb.exec(
        `CREATE TRIGGER fail_energy_flow_audit
         BEFORE INSERT ON sys_operation_logs
         BEGIN
           SELECT RAISE(ABORT, 'forced energy flow audit failure');
         END`
      );
    } finally {
      auditFailureDb.close();
    }
    const auditFailureResponse = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {
      modelCode: 'FLOW-ROUTE-AUDIT-ROLLBACK',
      modelName: '审计失败回滚模型',
      source: '隔离 API 测试',
      documentNo: 'FLOW-ROUTE-AUDIT-ROLLBACK-2026',
      version: 'v1',
      effectiveStartUtc: '2026-01-01T00:00:00Z',
      effectiveEndUtc: '2027-01-01T00:00:00Z',
      sourceTimeZone: 'Asia/Shanghai',
      status: 'active'
    }, adminToken);
    assert.strictEqual(auditFailureResponse.status, 500, auditFailureResponse.text);
    const auditRollbackDb = openDatabase();
    try {
      assert.strictEqual(
        Number(auditRollbackDb.prepare(
          `SELECT COUNT(*) FROM energy_flow_models WHERE model_code = 'FLOW-ROUTE-AUDIT-ROLLBACK'`
        ).pluck().get()),
        0,
        '审计失败后不得保留已提交的能流模型。'
      );
      auditRollbackDb.exec('DROP TRIGGER fail_energy_flow_audit');
    } finally {
      auditRollbackDb.close();
    }

    const modelResponse = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {
      modelCode: 'FLOW-ROUTE-DOMAIN',
      modelName: '能流领域路由模型',
      source: '隔离 API 测试',
      documentNo: 'FLOW-ROUTE-DOMAIN-2026',
      version: 'v1',
      effectiveStartUtc: '2026-01-01T00:00:00.000Z',
      effectiveEndUtc: '2027-01-01T00:00:00.000Z',
      sourceTimeZone: 'Asia/Shanghai',
      status: 'active',
      db: 'must-be-ignored',
      id: 999999
    }, adminToken);
    assertSuccess(modelResponse, 201);
    const model = modelResponse.body.data;
    assert.notStrictEqual(model.id, 999999);
    assert.strictEqual(model.effectiveStartUtc, '2026-01-01T00:00:00Z');
    assert.strictEqual(model.effectiveEndUtc, '2027-01-01T00:00:00Z');
    assert.strictEqual(modelResponse.body.meta.operation, 'energy-flow-model-create');
    const invalidMillisecondModel = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {
      modelCode: 'FLOW-ROUTE-INVALID-MILLISECOND',
      modelName: '非法毫秒路由模型',
      source: '隔离 API 测试',
      version: 'v1',
      effectiveStartUtc: '2026-01-01T00:00:00.001Z',
      effectiveEndUtc: '2027-01-01T00:00:00Z',
      sourceTimeZone: 'Asia/Shanghai',
      status: 'active'
    }, adminToken);
    assert.strictEqual(invalidMillisecondModel.status, 400, invalidMillisecondModel.text);
    assert.strictEqual(invalidMillisecondModel.body.error.details.code, 'INVALID_START_UTC');
    assert(!/INTERNAL_ERROR|SQLITE|CHECK constraint/i.test(invalidMillisecondModel.text));
    const invalidVersionModel = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {
      modelCode: 'FLOW-ROUTE-INVALID-VERSION',
      modelName: '非法版本路由模型',
      source: '隔离 API 测试',
      version: `V${'1'.repeat(64)}`,
      effectiveStartUtc: '2026-01-01T00:00:00Z',
      effectiveEndUtc: '2027-01-01T00:00:00Z',
      sourceTimeZone: 'Asia/Shanghai',
      status: 'active'
    }, adminToken);
    assert.strictEqual(invalidVersionModel.status, 400, invalidVersionModel.text);
    assert.strictEqual(invalidVersionModel.body.error.details.code, 'INVALID_ENERGY_FLOW_MODEL_VERSION');
    assert.strictEqual(invalidVersionModel.body.error.details.fieldName, 'version');
    assert(!/INTERNAL_ERROR|SQLITE|CHECK constraint/i.test(invalidVersionModel.text));
    const canonicalModelDuplicate = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models`, {
      modelCode: 'flow-route-domain',
      modelName: '规范等价重复模型',
      source: '隔离 API 测试',
      documentNo: 'FLOW-ROUTE-DOMAIN-DUPLICATE',
      version: 'V1',
      effectiveStartUtc: '2026-01-01T00:00:00Z',
      effectiveEndUtc: '2027-01-01T00:00:00Z',
      sourceTimeZone: 'Asia/Shanghai',
      status: 'active'
    }, adminToken);
    assert.strictEqual(canonicalModelDuplicate.status, 400, canonicalModelDuplicate.text);
    assert.strictEqual(canonicalModelDuplicate.body.error.details.code, 'DUPLICATE_ENERGY_FLOW_MODEL_VERSION');
    assert(!/INTERNAL_ERROR|SQLITE|UNIQUE|ux_energy_flow/i.test(canonicalModelDuplicate.text));

    const sourceResponse = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/nodes`, {
      nodeCode: 'SOURCE', nodeName: '来源节点', nodeType: 'source', x: 0, y: 0
    }, adminToken);
    const sinkResponse = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/nodes`, {
      nodeCode: 'SINK', nodeName: '去向节点', nodeType: 'sink', x: 100, y: 0
    }, adminToken);
    assertSuccess(sourceResponse, 201);
    assertSuccess(sinkResponse, 201);
    const source = sourceResponse.body.data;
    const sink = sinkResponse.body.data;
    const canonicalNodeDuplicate = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/nodes`, {
      nodeCode: 'source', nodeName: '规范等价重复来源节点', nodeType: 'source', x: 20, y: 0
    }, adminToken);
    assert.strictEqual(canonicalNodeDuplicate.status, 400, canonicalNodeDuplicate.text);
    assert.strictEqual(canonicalNodeDuplicate.body.error.details.code, 'DUPLICATE_ENERGY_FLOW_NODE_CODE');
    assert(!/INTERNAL_ERROR|SQLITE|UNIQUE|ux_energy_flow/i.test(canonicalNodeDuplicate.text));

    const edgeResponse = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/edges`, {
      edgeCode: 'EDGE-ROUTE',
      fromNodeId: source.id,
      toNodeId: sink.id,
      energyTypeCode: 'electricity',
      unit: 'kWh',
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'route:explicit-edge', password: 'must-not-persist-or-return' },
      status: 'active'
    }, adminToken);
    assertSuccess(edgeResponse, 201);
    const edge = edgeResponse.body.data;
    assert.deepStrictEqual(edge.sourceMapping, { reference: 'route:explicit-edge' });
    assert(!edgeResponse.text.includes('must-not-persist-or-return'));
    const canonicalEdgeDuplicate = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/edges`, {
      edgeCode: 'edge-route',
      fromNodeId: source.id,
      toNodeId: sink.id,
      energyTypeCode: 'electricity',
      unit: 'kWh',
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'route:canonical-duplicate' },
      status: 'active'
    }, adminToken);
    assert.strictEqual(canonicalEdgeDuplicate.status, 400, canonicalEdgeDuplicate.text);
    assert.strictEqual(canonicalEdgeDuplicate.body.error.details.code, 'DUPLICATE_ENERGY_FLOW_EDGE_CODE');
    assert(!/INTERNAL_ERROR|SQLITE|UNIQUE|ux_energy_flow/i.test(canonicalEdgeDuplicate.text));
    insertExplicitRecord(model.id, edge.id, 25);

    const models = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models?pageSize=999&ignoredField=secret`, undefined, adminToken);
    assertSuccess(models);
    assert.strictEqual(models.body.meta.pagination.pageSize, 200);
    assert.strictEqual(models.body.data.length, 1);
    const nodes = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models/${model.id}/nodes?pageSize=10`, undefined, adminToken);
    assertSuccess(nodes);
    assert.strictEqual(nodes.body.data.length, 2);
    const edges = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models/${model.id}/edges?pageSize=10`, undefined, adminToken);
    assertSuccess(edges);
    assert.strictEqual(edges.body.data.length, 1);

    const topology = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models/${model.id}/topology`, undefined, adminToken);
    assertSuccess(topology);
    assert.strictEqual(topology.body.data.contract.topologyMode, 'explicit_only');
    assert.strictEqual(topology.body.data.contract.infersOrganizationTree, false);
    assert.strictEqual(topology.body.meta.readOnly, true);
    assert.strictEqual(topology.body.meta.maintenanceAllowed, true);

    const analysis = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/analysis`, {
      startMonth: '2026-01',
      endMonth: '2026-01',
      includeDescendants: true,
      autoOffsetGeneration: true
    }, adminToken);
    assertSuccess(analysis);
    assert.strictEqual(analysis.body.data.edgeValues[0].value, 25);
    assert.strictEqual(analysis.body.data.contract.sourceMode, 'explicit_mapping_only');
    assert.strictEqual(analysis.body.data.contract.autoOffsetsGeneration, false);
    assert.strictEqual(analysis.body.meta.readOnly, true);
    assert.strictEqual(analysis.body.meta.maintenanceAllowed, true);

    // 维护态阻断写操作，但模型、拓扑和分析读取继续可用。
    await runWithMaintenance('energy-flow-domain-route-maintenance', async () => {
      const blockedWrite = await requestJson(server, 'PATCH', `${ROUTE_PREFIX}/models/${model.id}/status`, { status: 'inactive' }, adminToken);
      assert.strictEqual(blockedWrite.status, 423);
      assert.strictEqual(blockedWrite.body.error.code, 'MAINTENANCE_IN_PROGRESS');
      const readableModel = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models/${model.id}`, undefined, adminToken);
      assertSuccess(readableModel);
      const readableTopology = await requestJson(server, 'GET', `${ROUTE_PREFIX}/models/${model.id}/topology`, undefined, adminToken);
      assertSuccess(readableTopology);
      const readableAnalysis = await requestJson(server, 'POST', `${ROUTE_PREFIX}/models/${model.id}/analysis`, {
        startMonth: '2026-01', endMonth: '2026-01'
      }, adminToken);
      assertSuccess(readableAnalysis);
    });

    const edgeInactive = await requestJson(server, 'PATCH', `${ROUTE_PREFIX}/models/${model.id}/edges/${edge.id}/status`, { status: 'inactive' }, adminToken);
    assertSuccess(edgeInactive);
    assert.strictEqual(edgeInactive.body.data.status, 'inactive');
    const nodeInactive = await requestJson(server, 'PATCH', `${ROUTE_PREFIX}/models/${model.id}/nodes/${source.id}/status`, { status: 'inactive' }, adminToken);
    assertSuccess(nodeInactive);
    assert.strictEqual(nodeInactive.body.data.status, 'inactive');
    const modelInactive = await requestJson(server, 'PATCH', `${ROUTE_PREFIX}/models/${model.id}/status`, { status: 'inactive' }, adminToken);
    assertSuccess(modelInactive);
    assert.strictEqual(modelInactive.body.data.status, 'inactive');
    const auditDb = openDatabase();
    try {
      const statusLog = auditDb.prepare(
        `SELECT target_type AS targetType, target_id AS targetId, detail_json AS detailJson
         FROM sys_operation_logs WHERE operation = 'energy-flow-model-status'
         ORDER BY id DESC LIMIT 1`
      ).get();
      assert(statusLog, '模型状态切换必须写入操作日志。');
      assert.strictEqual(statusLog.targetType, 'energy_flow_model');
      assert.strictEqual(statusLog.targetId, String(model.id));
      assert.strictEqual(JSON.parse(statusLog.detailJson).status, 'inactive');
    } finally {
      auditDb.close();
    }

    const noDelete = await requestJson(server, 'DELETE', `${ROUTE_PREFIX}/models/${model.id}`, undefined, adminToken);
    assert.strictEqual(noDelete.status, 404);
    assert.strictEqual(noDelete.body.error.code, 'NOT_FOUND');
    console.log('energyFlowRoutes tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_error) {
      // Windows 下异常句柄由系统临时目录后续清理。
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
