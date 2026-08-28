'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// API 测试只启动隔离 Express 和临时 SQLite，不使用浏览器或真实 data 目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-post-action-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { runWithMaintenance } = require('../services/maintenanceState');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = require('../services/demoOwnershipService');

/** 创建普通测试账号，并按权限编码精确授权。 */
function createPermissionAccount(roleCode, username, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?)`).run(roleCode, roleCode, now, now).lastInsertRowid);
    const userId = Number(db.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?)`).run(
      username,
      username,
      bcrypt.hashSync('Password123!', 10),
      now,
      now
    ).lastInsertRowid);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
    const grant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `测试授权缺少权限菜单 ${permissionCode}`);
      grant.run(roleId, menu.id, now);
    });
    return { username, password: 'Password123!', userId };
  } finally {
    db.close();
  }
}

/** 发起隔离 HTTP JSON 请求。 */
function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, body: res.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

/** 为 HTTP connected 链路建立真实 22/23/24 batch、context、ownership 与 contains 关系。 */
function seedOwnedEnergyFlow(run) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const bindingDefinitions = [
      ['22-energy-flow-models', 'primary', 'energy_flow_model', 'energy-flow-models-import'],
      ['23-energy-flow-nodes', 'primary', 'energy_flow_node', 'energy-flow-nodes-import'],
      ['24-energy-flow-edges', 'edge', 'energy_flow_edge', 'energy-flow-bundle-import'],
      ['24-energy-flow-edges', 'record', 'energy_flow_record', 'energy-flow-bundle-import']
    ];
    const batchByRole = new Map();
    bindingDefinitions.forEach(([artifactKey, batchRole, importType, handlerKey], index) => {
      const fileSha = String(index + 1).repeat(64);
      const batchId = Number(db.prepare(`INSERT INTO import_batches
        (import_type, original_filename, file_type, file_size_bytes, file_sha256,
         status, audit_phase, total_rows, success_count, failure_count, skipped_count)
        VALUES (?, ?, 'xlsx', 128, ?, 'completed', 'execute', 4, 4, 0, 0)`).run(
        importType,
        `${artifactKey}-${batchRole}.xlsx`,
        fileSha
      ).lastInsertRowid);
      const contextId = `post-action-api-context-${index + 1}`;
      db.prepare(`INSERT INTO demo_import_contexts
        (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
         artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
         status, issued_at, expires_at, upload_file_sha256, preview_digest, previewed_at, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'executed', ?, ?, ?, ?, ?, ?)`).run(
        contextId,
        String.fromCharCode(97 + index).repeat(64),
        run.runId,
        run.datasetId,
        run.manifestVersion,
        run.manifestDigest,
        artifactKey,
        handlerKey,
        fileSha,
        run.runtimeEpoch,
        now,
        expiresAt,
        fileSha,
        `hmac-sha256:v1:audit:${['e', 'f', 'a', 'b'][index].repeat(64)}`,
        now,
        now
      );
      db.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES (?, ?, ?, ?, ?)`).run(run.runId, artifactKey, contextId, batchId, batchRole);
      batchByRole.set(`${artifactKey}/${batchRole}`, batchId);
    });
    const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const modelId = Number(db.prepare(`INSERT INTO energy_flow_models
      (source_batch_id, source_row_number, model_code, model_name, source, version,
       effective_start_wall_clock, effective_end_wall_clock, effective_start_utc,
       effective_end_utc, source_timezone, classification_status, source_mode, status)
      VALUES (?, 2, 'FLOW-API-X', 'API 隔离能流模型', '隔离测试', 'api-v1',
        '2026-08-01T00:00', '2026-09-01T00:00', '2026-07-31T16:00:00Z',
        '2026-08-31T16:00:00Z', 'Asia/Shanghai', 'legacy_unclassified',
        'legacy_explicit_sources', 'active')`).run(
      batchByRole.get('22-energy-flow-models/primary')
    ).lastInsertRowid);
    const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
      (source_batch_id, source_row_number, energy_flow_model_id, node_code, node_name, node_type, stage_code, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`);
    const nodeBatchId = batchByRole.get('23-energy-flow-nodes/primary');
    const sourceNodeId = Number(insertNode.run(nodeBatchId, 2, modelId, 'FLOW-API-SOURCE-X', 'API 源节点', 'source', 'plant_entry').lastInsertRowid);
    const sinkNodeId = Number(insertNode.run(nodeBatchId, 3, modelId, 'FLOW-API-SINK-X', 'API 汇节点', 'sink', 'boundary').lastInsertRowid);
    const edgeBatchId = batchByRole.get('24-energy-flow-edges/edge');
    const edgeId = Number(db.prepare(`INSERT INTO energy_flow_edges
      (source_batch_id, source_row_number, energy_flow_model_id, edge_code,
       from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json, status)
      VALUES (?, 2, ?, 'FLOW-API-EDGE-X', ?, ?, ?, 'kWh', 'explicit_edge_value',
        '{"reference":"API 显式边值"}', 'active')`).run(
      edgeBatchId,
      modelId,
      sourceNodeId,
      sinkNodeId,
      energyTypeId
    ).lastInsertRowid);
    const recordBatchId = batchByRole.get('24-energy-flow-edges/record');
    const recordId = Number(db.prepare(`INSERT INTO energy_flow_records
      (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_edge_id,
       start_utc, end_utc, source_timezone, original_unit, original_value,
       source_type, source_mapping_json, formula_version, record_status)
      VALUES (?, 2, ?, ?, '2026-07-31T16:00:00Z', '2026-08-31T16:00:00Z',
        'Asia/Shanghai', 'kWh', 88, 'explicit_edge_value',
        '{"reference":"API 显式记录"}', 'energy-flow:v1', 'active')`).run(
      recordBatchId,
      modelId,
      edgeId
    ).lastInsertRowid);
    const entityDefinitions = [
      ['22-energy-flow-models', 'energy_flow_model', modelId, batchByRole.get('22-energy-flow-models/primary'), 2],
      ['23-energy-flow-nodes', 'energy_flow_node', sourceNodeId, nodeBatchId, 2],
      ['23-energy-flow-nodes', 'energy_flow_node', sinkNodeId, nodeBatchId, 3],
      ['24-energy-flow-edges', 'energy_flow_edge', edgeId, edgeBatchId, 2],
      ['24-energy-flow-edges', 'energy_flow_record', recordId, recordBatchId, 2]
    ];
    const registryByEntity = new Map();
    entityDefinitions.forEach(([artifactKey, entityType, entityPk, sourceBatchId, sourceRowNumber]) => {
      const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
      const registryId = Number(db.prepare(`INSERT INTO demo_data_registry
        (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
         snapshot_digest, source_batch_id, source_row_number, registered_by)
        VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`).run(
        run.runId,
        artifactKey,
        entityType,
        String(entityPk),
        calculateDemoEntityIdentityDigest(entityType, String(entityPk)),
        calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
        sourceBatchId,
        sourceRowNumber
      ).lastInsertRowid);
      registryByEntity.set(`${entityType}/${entityPk}`, registryId);
    });
    const modelRegistryId = registryByEntity.get(`energy_flow_model/${modelId}`);
    [
      registryByEntity.get(`energy_flow_node/${sourceNodeId}`),
      registryByEntity.get(`energy_flow_node/${sinkNodeId}`),
      registryByEntity.get(`energy_flow_edge/${edgeId}`),
      registryByEntity.get(`energy_flow_record/${recordId}`)
    ].forEach((registryId) => db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type)
      VALUES (?, ?, ?, 'contains')`).run(run.runId, modelRegistryId, registryId));
    db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type)
      VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      registryByEntity.get(`energy_flow_edge/${edgeId}`),
      registryByEntity.get(`energy_flow_record/${recordId}`)
    );
    return { modelId, sourceNodeId, sinkNodeId, edgeId, recordId };
  } finally {
    db.close();
  }
}

/** 摘要 connected 动作可能误写的能流、能耗与碳事实表。 */
function snapshotBusinessTables() {
  const db = openDatabase();
  try {
    const tableNames = [
      'energy_flow_models', 'energy_flow_nodes', 'energy_flow_edges', 'energy_flow_records',
      'energy_records', 'carbon_activity_records', 'carbon_emissions', 'carbon_calculation_runs',
      'carbon_accounting_results'
    ];
    const payload = Object.fromEntries(tableNames.map((tableName) => [
      tableName,
      db.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all()
    ]));
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } finally {
    db.close();
  }
}

/** 断言 HTTP 公共 JSON 不泄漏内部摘要、ownership provenance 或执行实现。 */
function assertSafePublicJson(value) {
  const serialized = JSON.stringify(value);
  [
    'inputDigest', 'resultDigest', 'manifestDigest', 'registryDigest', 'runtimeEpoch',
    'runtimeRevision', 'revision', 'requestedBy', 'importBatchId', 'contextId', 'fileSha',
    'fileSha256', 'registryId', 'sourceBatchId', 'sourceRowNumber', 'identityDigest',
    'snapshotDigest', 'fromRegistryId', 'toRegistryId', 'relationId', 'entityEvidence',
    'bindings', 'handler', 'sql', 'modulePath', 'outputId', 'adapter', 'adapterName',
    'inputEntityIds'
  ].forEach((field) => assert.strictEqual(serialized.includes(`"${field}"`), false, `HTTP JSON 不得包含 ${field}`));
}

(async () => {
  let server;
  try {
    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const noAuth = await request(server, 'GET', '/api/system/demo-data/post-actions');
    assert.strictEqual(noAuth.status, 401);
    const login = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    assert.strictEqual(login.status, 200);
    const token = login.body.data.token;
    const deniedAccount = createPermissionAccount(
      'demo-post-action-denied',
      'demo-post-action-denied',
      ['system:demo:download']
    );
    const deniedLogin = await request(server, 'POST', '/api/login', {
      username: deniedAccount.username,
      password: deniedAccount.password
    });
    assert.strictEqual(deniedLogin.status, 200);
    const deniedToken = deniedLogin.body.data.token;
    const actorAccount = createPermissionAccount(
      'demo-post-action-actor',
      'demo-post-action-actor',
      ['system:demo:view']
    );
    const actorLogin = await request(server, 'POST', '/api/login', {
      username: actorAccount.username,
      password: actorAccount.password
    });
    assert.strictEqual(actorLogin.status, 200);
    const actorToken = actorLogin.body.data.token;
    const previewOnlyAccount = createPermissionAccount(
      'demo-post-action-preview-only',
      'demo-post-action-preview-only',
      ['system:demo:view', 'system:demo:download', 'prediction:run:view']
    );
    const previewOnlyLogin = await request(server, 'POST', '/api/login', {
      username: previewOnlyAccount.username,
      password: previewOnlyAccount.password
    });
    assert.strictEqual(previewOnlyLogin.status, 200);
    const previewOnlyToken = previewOnlyLogin.body.data.token;
    const registry = await request(server, 'GET', '/api/system/demo-data/post-actions', undefined, token);
    assert.strictEqual(registry.status, 200);
    assert.strictEqual(registry.body.data.actions.length, 8);
    assert.strictEqual(registry.body.data.actions.filter((action) => action.implementationStatus === 'connected').length, 2);
    registry.body.data.actions.forEach((action) => {
      assert.deepStrictEqual(action.dependencies, [], `${action.actionKey} 不得把产品推荐顺序暴露为领域 predecessor`);
    });
    assertSafePublicJson(registry.body.data);

    const ownedFlow = seedOwnedEnergyFlow(run);
    const businessBefore = snapshotBusinessTables();
    const flowStrictBody = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/energy-flow-analysis/preview`,
      {
        clientRequestId: 'api-flow-strict',
        modelId: ownedFlow.modelId,
        nodeId: ownedFlow.sourceNodeId,
        edgeId: ownedFlow.edgeId,
        recordId: ownedFlow.recordId,
        batchId: 1,
        importBatchId: 1,
        startUtc: '2026-07-31T16:00:00Z',
        endUtc: '2026-08-31T16:00:00Z',
        handler: 'forbidden',
        modulePath: '../services/unsafe-adapter',
        adapter: 'energy-flow-analysis',
        adapterName: 'energy-flow-analysis',
        inputEntityIds: ['1'],
        sql: 'SELECT 1',
        outputId: 'forbidden'
      }, token);
    assert.strictEqual(flowStrictBody.status, 400);
    assert.strictEqual(flowStrictBody.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    assert.deepStrictEqual(flowStrictBody.body.error.details.fields, [
      'adapter', 'adapterName', 'batchId', 'edgeId', 'endUtc', 'handler', 'importBatchId',
      'inputEntityIds', 'modelId', 'modulePath', 'nodeId', 'outputId', 'recordId',
      'sql', 'startUtc'
    ]);

    const flowPreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/energy-flow-analysis/preview`,
      { clientRequestId: 'api-flow-connected' }, token);
    assert.strictEqual(flowPreview.status, 200);
    assert.strictEqual(flowPreview.body.data.status, 'previewed');
    assert.deepStrictEqual(Object.keys(flowPreview.body.data.input).sort(), ['endUtc', 'modelId', 'startUtc']);
    assertSafePublicJson(flowPreview.body.data);
    const flowActorMismatch = await request(server, 'GET',
      `/api/system/demo-data/post-action-runs/${flowPreview.body.data.actionRunId}`,
      undefined,
      actorToken);
    assert.strictEqual(flowActorMismatch.status, 404);
    assert.strictEqual(flowActorMismatch.body.error.details.code, 'DEMO_POST_ACTION_RUN_NOT_FOUND');
    const flowStrictExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${flowPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-flow-connected',
        previewDigest: flowPreview.body.data.previewDigest,
        confirmationText: '确认执行能流分析',
        modelId: ownedFlow.modelId,
        recordId: ownedFlow.recordId
      }, token);
    assert.strictEqual(flowStrictExecute.status, 400);
    assert.strictEqual(flowStrictExecute.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    const flowExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${flowPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-flow-connected',
        previewDigest: flowPreview.body.data.previewDigest,
        confirmationText: '确认执行能流分析'
      }, token);
    assert.strictEqual(flowExecute.status, 200);
    assert.strictEqual(flowExecute.body.data.status, 'succeeded');
    assert.strictEqual(flowExecute.body.data.outputCount, 0);
    assertSafePublicJson(flowExecute.body.data);
    const flowStatus = await request(server, 'GET',
      `/api/system/demo-data/post-action-runs/${flowPreview.body.data.actionRunId}`,
      undefined,
      token);
    assert.strictEqual(flowStatus.status, 200);
    assert.strictEqual(flowStatus.body.data.status, 'succeeded');
    assertSafePublicJson(flowStatus.body.data);
    assert.strictEqual(snapshotBusinessTables(), businessBefore, 'HTTP connected 能流动作不得写入业务表');
    const flowReplay = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${flowPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-flow-connected',
        previewDigest: flowPreview.body.data.previewDigest,
        confirmationText: '确认执行能流分析'
      }, token);
    assert.strictEqual(flowReplay.status, 200);
    assert.strictEqual(flowReplay.body.data.status, 'succeeded');
    assert.deepStrictEqual(flowReplay.body.data.result, flowExecute.body.data.result);

    const flowMaintenance = await runWithMaintenance('demo-post-action-api-flow-maintenance', () => request(
      server,
      'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/energy-flow-analysis/preview`,
      { clientRequestId: 'api-flow-maintenance' },
      token
    ));
    assert.strictEqual(flowMaintenance.status, 423);
    assert.strictEqual(flowMaintenance.body.error.code, 'MAINTENANCE_IN_PROGRESS');

    const unknown = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/no-such-action/preview`, { clientRequestId: 'api-unknown' }, token);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body.error.code, 'DEMO_ACTION_UNKNOWN');
    const strictBody = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-strict', modelId: 1 }, token);
    assert.strictEqual(strictBody.status, 400);
    assert.strictEqual(strictBody.body.error.code, 'BAD_REQUEST');
    assert.strictEqual(strictBody.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    const deniedPreview = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-denied' }, deniedToken);
    assert.strictEqual(deniedPreview.status, 403);
    const deniedFlowPreview = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/energy-flow-analysis/preview`, { clientRequestId: 'api-flow-denied' }, deniedToken);
    assert.strictEqual(deniedFlowPreview.status, 403);
    const previewOnlyBlocked = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-preview-only' }, previewOnlyToken);
    assert.strictEqual(previewOnlyBlocked.status, 200);
    const previewOnlyExecute = await request(server, 'POST', `/api/system/demo-data/post-action-runs/${previewOnlyBlocked.body.data.actionRunId}/execute`, {
      clientRequestId: 'api-preview-only', previewDigest: previewOnlyBlocked.body.data.previewDigest,
      confirmationText: '确认执行预测运行'
    }, previewOnlyToken);
    assert.strictEqual(previewOnlyExecute.status, 403);
    const blocked = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-blocked' }, token);
    assert.strictEqual(blocked.status, 200);
    assert.strictEqual(blocked.body.data.status, 'blocked');
    assert.strictEqual(blocked.body.data.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
    const status = await request(server, 'GET', `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}`, undefined, token);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.data.actionRunId, blocked.body.data.actionRunId);
    const actorMismatch = await request(server, 'GET', `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}`, undefined, actorToken);
    assert.strictEqual(actorMismatch.status, 404);
    assert.strictEqual(actorMismatch.body.error.details.code, 'DEMO_POST_ACTION_RUN_NOT_FOUND');
    const strictExecute = await request(server, 'POST', `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}/execute`, {
      clientRequestId: 'api-blocked', previewDigest: blocked.body.data.previewDigest,
      confirmationText: '确认执行预测运行', outputIds: ['forbidden']
    }, token);
    assert.strictEqual(strictExecute.status, 400);
    assert.strictEqual(strictExecute.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    const maintenancePreview = await runWithMaintenance('demo-post-action-api-test', () => request(
      server,
      'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`,
      { clientRequestId: 'api-maintenance' },
      token
    ));
    assert.strictEqual(maintenancePreview.status, 423);
    assert.strictEqual(maintenancePreview.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    const maintenanceExecute = await runWithMaintenance('demo-post-action-api-execute-test', () => request(
      server,
      'POST',
      `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-blocked',
        previewDigest: blocked.body.data.previewDigest,
        confirmationText: '确认执行预测运行'
      },
      token
    ));
    assert.strictEqual(maintenanceExecute.status, 423);
    assert.strictEqual(maintenanceExecute.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    const executeBlocked = await request(server, 'POST', `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}/execute`, {
      clientRequestId: 'api-blocked', previewDigest: blocked.body.data.previewDigest, confirmationText: '确认执行预测运行'
    }, token);
    assert.strictEqual(executeBlocked.status, 409);
    assert.strictEqual(executeBlocked.body.error.code, 'ACTION_HANDLER_NOT_CONNECTED');
    console.log('demoPostActionApi.test.js passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
