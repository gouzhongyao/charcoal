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

/** 创建普通测试账号，并按正式 RBAC 权限编码精确授权。 */
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
      assert(menu, `正式 RBAC 种子缺少权限菜单 ${permissionCode}`);
      grant.run(roleId, menu.id, now);
    });
    return { username, password: 'Password123!', userId };
  } finally {
    db.close();
  }
}

/** 发起隔离 HTTP JSON 或二进制请求，并保留响应头供 managed context 验证。 */
function request(server, method, pathname, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { ...extraHeaders };
    if (rawBody.length > 0 && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (rawBody.length > 0) headers['Content-Length'] = String(rawBody.length);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        const responseBody = contentType.includes('application/json') && buffer.length > 0
          ? JSON.parse(buffer.toString('utf8'))
          : null;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          body: responseBody,
          text: buffer.toString('utf8')
        });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

/** 发起携带 X-Demo-Context 的单文件 multipart managed preview 请求。 */
function requestMultipart(server, pathname, token, demoContextToken, filename, buffer) {
  const boundary = `----demo-post-action-carbon-${crypto.randomUUID()}`;
  const rawBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Demo-Context': demoContextToken,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(rawBody.length)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const responseBuffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: responseBuffer,
          body: responseBuffer.length > 0 ? JSON.parse(responseBuffer.toString('utf8')) : null,
          text: responseBuffer.toString('utf8')
        });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
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

/** 为 HTTP production 策略链路建立 artifact 15/18 的真实 batch、context、ownership 与 uses_config 闭包。 */
function seedOwnedStrategy(run) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const windowStart = '2026-08-01T00:00:00.000Z';
    const windowEnd = '2026-08-01T01:00:00.000Z';
    const energyTypeId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
    const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
      VALUES ('STRATEGY-API-UNIT', '策略 API 测试单元', '/策略 API 测试单元', 'workshop', 'active', ?, ?)`)
      .run(now, now).lastInsertRowid);
    const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
      (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status, created_at, updated_at)
      VALUES ('STRATEGY-API-METER', '策略 API 测试表计', 'electricity', ?, ?, 'active', ?, ?)`)
      .run(energyTypeId, organizationUnitId, now, now).lastInsertRowid);
    const bindingDefinitions = [
      {
        artifactKey: '15-energy-timeseries',
        handlerKey: 'energy-timeseries-import',
        importType: 'energy_timeseries',
        rowCount: 4,
        fileSha256: crypto.createHash('sha256').update('api-strategy-timeseries', 'utf8').digest('hex')
      },
      {
        artifactKey: '18-strategy-rules',
        handlerKey: 'strategy-rules-import',
        importType: 'strategy_rule',
        rowCount: 1,
        fileSha256: crypto.createHash('sha256').update('api-strategy-rules', 'utf8').digest('hex')
      }
    ];
    const batchByArtifact = new Map();
    const contextByArtifact = new Map();
    bindingDefinitions.forEach((definition, index) => {
      const batchId = Number(db.prepare(`INSERT INTO import_batches
        (import_type, original_filename, file_type, file_size_bytes, file_sha256,
         status, audit_phase, total_rows, success_count, failure_count, skipped_count)
        VALUES (?, ?, 'xlsx', 128, ?, 'completed', 'execute', ?, ?, 0, 0)`).run(
        definition.importType,
        `${definition.artifactKey}.xlsx`,
        definition.fileSha256,
        definition.rowCount,
        definition.rowCount
      ).lastInsertRowid);
      const contextId = `post-action-api-strategy-context-${index + 1}`;
      db.prepare(`INSERT INTO demo_import_contexts
        (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
         artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
         status, issued_at, expires_at, upload_file_sha256, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'executed', ?, ?, ?, ?)`).run(
        contextId,
        crypto.createHash('sha256').update(contextId, 'utf8').digest('hex'),
        run.runId,
        run.datasetId,
        run.manifestVersion,
        run.manifestDigest,
        definition.artifactKey,
        definition.handlerKey,
        definition.fileSha256,
        run.runtimeEpoch,
        now,
        '2026-09-01T00:00:00.000Z',
        definition.fileSha256,
        now
      );
      db.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES (?, ?, ?, ?, 'primary')`).run(
        run.runId,
        definition.artifactKey,
        contextId,
        batchId
      );
      batchByArtifact.set(definition.artifactKey, batchId);
      contextByArtifact.set(definition.artifactKey, contextId);
    });
    const timeseriesBatchId = batchByArtifact.get('15-energy-timeseries');
    const insertTimeseries = db.prepare(`INSERT INTO energy_timeseries_records
      (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id,
       start_utc, end_utc, source_timezone, granularity_minutes, original_unit, original_value,
       normalized_unit, normalized_value, source_reference, data_source, record_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', ?, 'kWh', ?, ?, 'upload', 'active', ?, ?)`);
    const values = [120, 135, 320, 150];
    const timeseriesIds = values.map((value, index) => Number(insertTimeseries.run(
      timeseriesBatchId,
      index + 2,
      organizationUnitId,
      meterDeviceId,
      energyTypeId,
      new Date(Date.parse(windowStart) + index * 15 * 60 * 1000).toISOString(),
      new Date(Date.parse(windowStart) + (index + 1) * 15 * 60 * 1000).toISOString(),
      value,
      value,
      `api-strategy-timeseries-${index + 1}`,
      now,
      now
    ).lastInsertRowid));
    const ruleBatchId = batchByArtifact.get('18-strategy-rules');
    const ruleId = Number(db.prepare(`INSERT INTO strategy_rules
      (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
       metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
       evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
       source_timezone, status, created_at, updated_at)
      VALUES (?, 2, 'API-STRATEGY-PEAK', 'API 峰段能耗偏高提醒', 'strategy-rule:v1', 'load-analysis:v1',
        'peak_interval_energy', 'gt', 300, 'kWh/15min', 0.08, 'high', ?,
        '建议复核峰段设备错峰安排。', 'API 隔离测试', '2025-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z', 'Asia/Shanghai', 'active', ?, ?)`).run(
      ruleBatchId,
      JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
      now,
      now
    ).lastInsertRowid);
    const registryByEntity = new Map();
    [
      ...timeseriesIds.map((entityPk, index) => [
        '15-energy-timeseries', 'energy_timeseries', entityPk, timeseriesBatchId, index + 2
      ]),
      ['18-strategy-rules', 'strategy_rule', ruleId, ruleBatchId, 2]
    ].forEach(([artifactKey, entityType, entityPk, sourceBatchId, sourceRowNumber]) => {
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
    const ruleRegistryId = registryByEntity.get(`strategy_rule/${ruleId}`);
    timeseriesIds.forEach((timeseriesId) => db.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type)
      VALUES (?, ?, ?, 'uses_config')`).run(
      run.runId,
      registryByEntity.get(`energy_timeseries/${timeseriesId}`),
      ruleRegistryId
    ));
    return {
      meterDeviceId,
      timeseriesIds,
      ruleId,
      timeseriesBatchId,
      ruleBatchId,
      contextIds: [...contextByArtifact.values()],
      windowStart,
      windowEnd
    };
  } finally {
    db.close();
  }
}

/** 生成 Carbon HTTP fixture 使用的稳定 SHA-256。 */
function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Carbon managed 导入案例固定使用正式 artifact 下载、preview 与 execute 路由合同。
const CARBON_MANAGED_IMPORT_CASES = Object.freeze([
  Object.freeze({
    artifactKey: '11-carbon-factors',
    handlerKey: 'carbon-factors-import',
    previewPath: '/api/carbon/factors/import/preview',
    executePath: '/api/carbon/factors/import/execute',
    importType: 'carbon_factor',
    entityType: 'carbon_factor',
    businessTable: 'carbon_factors',
    expectedWouldImport: 1,
    expectedSkipped: 1
  }),
  Object.freeze({
    artifactKey: '27-carbon-activities',
    handlerKey: 'carbon-activity-import',
    previewPath: '/api/carbon/activities/imports/preview',
    executePath: '/api/carbon/activities/imports/execute',
    importType: 'carbon_activity',
    entityType: 'carbon_activity_record',
    businessTable: 'carbon_activity_records',
    expectedWouldImport: 2,
    expectedSkipped: 0
  })
]);

/** 只建立正式 HTTP 导入所需主数据和未归属 sentinel，不伪造 managed batch、context 或 registry。 */
function seedCarbonImportDependenciesAndSentinels() {
  const db = openDatabase();
  try {
    const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
    const naturalGas = db.prepare("SELECT id FROM energy_types WHERE code = 'natural_gas'").get();
    assert(electricity && naturalGas, '隔离库必须包含 electricity 与 natural_gas 能源类型。');
    const parkId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('QL-PARK', '天坤集团', '/QL-PARK', 'enterprise', 'active')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO organization_units
      (parent_id, unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, 'QL-UTILITY', '公辅动力站', '/QL-PARK/QL-UTILITY', 'department', 'active')`).run(parkId);

    // 与官方天然气因子唯一键相同的正式行使 artifact 11 保留一条 skip，从而继续覆盖 factor_missing 分支。
    const skippedFormalFactorId = Number(db.prepare(`INSERT INTO carbon_factors
      (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source,
       effective_from, effective_to, is_active)
      VALUES (?, 'default', 2026, 'm3', 999, 'kgCO2e', '天坤集团演示因子',
        '2026-01-01', '2026-12-31', 1)`).run(naturalGas.id).lastInsertRowid);
    const formalFactorId = Number(db.prepare(`INSERT INTO carbon_factors
      (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source,
       effective_from, effective_to, is_active)
      VALUES (?, 'default', 2026, 'kWh', 999, 'kgCO2e', 'carbon-api-formal-factor-sentinel',
        '2026-01-01', '2026-12-31', 1)`).run(electricity.id).lastInsertRowid);
    const formalActivityId = Number(db.prepare(`INSERT INTO carbon_activity_records
      (source_type, energy_record_id, activity_code, activity_code_key, emission_scope,
       activity_category, activity_category_key, organization_unit_id, energy_type_id,
       start_wall_clock, end_wall_clock, source_timezone, start_utc, end_utc,
       activity_value, activity_unit, factor_region, source_reference, duplicate_key, record_status)
      VALUES ('independent_activity', NULL, 'CARBON-API-FORMAL', 'carbon-api-formal', 'scope_2',
        'API 正式哨兵', 'api 正式哨兵', ?, ?, '2026-01-01T08:00', '2026-01-01T09:00',
        'Asia/Shanghai', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 999,
        'kWh', 'default', 'carbon-api-formal-activity-sentinel', ?, 'active')`).run(
      parkId,
      electricity.id,
      sha256Text('carbon-api-formal')
    ).lastInsertRowid);
    return { skippedFormalFactorId, formalFactorId, formalActivityId };
  } finally {
    db.close();
  }
}

/** 按一次性 token 从隔离库读取正式 context 主键与生命周期状态。 */
function readCarbonManagedContextByToken(token) {
  const db = openDatabase();
  try {
    const tokenHash = sha256Text(token);
    const context = db.prepare(`SELECT context_id AS contextId, run_id AS runId,
        dataset_id AS datasetId, manifest_version AS manifestVersion,
        manifest_digest AS manifestDigest, artifact_key AS artifactKey,
        handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
        upload_file_sha256 AS uploadFileSha256, issued_to_user_id AS issuedToUserId,
        status, preview_digest AS previewDigest, previewed_at AS previewedAt,
        executed_at AS executedAt
      FROM demo_import_contexts WHERE token_hash = ?`).get(tokenHash);
    assert(context, '正式 artifact 下载必须签发可反查的 demo context。');
    const bindings = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
      FROM demo_run_import_batches WHERE context_id = ? ORDER BY batch_role, import_batch_id`)
      .all(context.contextId);
    return { context, bindings };
  } finally {
    db.close();
  }
}

/** 通过正式下载签发、multipart preview 和 JSON execute 完成单个 Carbon managed artifact。 */
async function importManagedCarbonArtifact(server, token, run, importerUserId, definition) {
  const download = await request(
    server,
    'GET',
    `/api/templates/demo-park/${definition.artifactKey}.xlsx`,
    undefined,
    token
  );
  assert.strictEqual(download.status, 200, `${definition.artifactKey} 正式下载失败：${download.text}`);
  assert(download.buffer.length > 0, `${definition.artifactKey} 正式 artifact 不能为空。`);
  const contextToken = String(download.headers['x-demo-context'] || '');
  const artifactFileSha256 = crypto.createHash('sha256').update(download.buffer).digest('hex');
  assert(/^[A-Za-z0-9_-]{43}$/.test(contextToken), `${definition.artifactKey} 必须签发一次性 context token。`);
  assert.strictEqual(download.headers['x-demo-artifact-key'], definition.artifactKey);
  assert.strictEqual(download.headers['x-demo-handler-key'], definition.handlerKey);
  assert.strictEqual(download.headers['x-demo-artifact-sha256'], artifactFileSha256);
  const issued = readCarbonManagedContextByToken(contextToken);
  assert.deepStrictEqual({
    runId: issued.context.runId,
    datasetId: issued.context.datasetId,
    manifestVersion: issued.context.manifestVersion,
    manifestDigest: issued.context.manifestDigest,
    artifactKey: issued.context.artifactKey,
    handlerKey: issued.context.handlerKey,
    artifactFileSha256: issued.context.artifactFileSha256,
    issuedToUserId: Number(issued.context.issuedToUserId),
    status: issued.context.status,
    bindingCount: issued.bindings.length
  }, {
    runId: run.runId,
    datasetId: run.datasetId,
    manifestVersion: run.manifestVersion,
    manifestDigest: run.manifestDigest,
    artifactKey: definition.artifactKey,
    handlerKey: definition.handlerKey,
    artifactFileSha256,
    issuedToUserId: importerUserId,
    status: 'issued',
    bindingCount: 0
  });

  const previewResponse = await requestMultipart(
    server,
    definition.previewPath,
    token,
    contextToken,
    `${definition.artifactKey}.xlsx`,
    download.buffer
  );
  assertSuccessEnvelope(previewResponse);
  const preview = previewResponse.body.data;
  assert.strictEqual(preview.summary.wouldImport, definition.expectedWouldImport);
  assert.strictEqual(preview.summary.skipped, definition.expectedSkipped);
  assert(/^hmac-sha256:v1:audit:[a-f0-9]{64}$/.test(preview.previewAuditDigest));
  const previewed = readCarbonManagedContextByToken(contextToken);
  assert.strictEqual(previewed.context.status, 'previewed');
  assert.strictEqual(previewed.context.uploadFileSha256, artifactFileSha256);
  assert.strictEqual(previewed.context.previewDigest, preview.previewAuditDigest);
  assert(previewed.context.previewedAt);
  assert.deepStrictEqual(previewed.bindings, [{ batchId: preview.batchId, batchRole: 'primary' }]);

  const executeResponse = await request(
    server,
    'POST',
    definition.executePath,
    {
      batchId: preview.batchId,
      confirmText: preview.confirmText,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    },
    token,
    { 'X-Demo-Context': contextToken }
  );
  assertSuccessEnvelope(executeResponse);
  assert.strictEqual(executeResponse.body.data.executed, true);
  assert.strictEqual(executeResponse.body.data.imported, definition.expectedWouldImport);
  assert.strictEqual(executeResponse.body.data.ownership.applied, true);
  assert.strictEqual(
    executeResponse.body.data.ownership.registrationCount,
    definition.expectedWouldImport
  );
  assert.strictEqual(JSON.stringify(executeResponse.body.data).includes('rowWitness'), false);
  const executed = readCarbonManagedContextByToken(contextToken);
  assert.strictEqual(executed.context.status, 'executed');
  assert(executed.context.executedAt);
  assert.deepStrictEqual(executed.bindings, [{ batchId: preview.batchId, batchRole: 'primary' }]);
  return {
    ...definition,
    contextId: executed.context.contextId,
    contextToken,
    artifactFileSha256,
    batchId: preview.batchId
  };
}

/** 从隔离 SQLite 反向确认 artifact 11/27 context、batch、registry 与业务表集合闭包。 */
function assertManagedCarbonImportClosure(run, importerUserId, imports, sentinels) {
  const db = openDatabase();
  try {
    imports.forEach((item) => {
      const context = db.prepare(`SELECT run_id AS runId, dataset_id AS datasetId,
          manifest_version AS manifestVersion, manifest_digest AS manifestDigest,
          artifact_key AS artifactKey, handler_key AS handlerKey,
          artifact_file_sha256 AS artifactFileSha256, upload_file_sha256 AS uploadFileSha256,
          issued_to_user_id AS issuedToUserId, status
        FROM demo_import_contexts WHERE context_id = ?`).get(item.contextId);
      assert.deepStrictEqual({
        runId: context.runId,
        datasetId: context.datasetId,
        manifestVersion: context.manifestVersion,
        manifestDigest: context.manifestDigest,
        artifactKey: context.artifactKey,
        handlerKey: context.handlerKey,
        artifactFileSha256: context.artifactFileSha256,
        uploadFileSha256: context.uploadFileSha256,
        issuedToUserId: Number(context.issuedToUserId),
        status: context.status
      }, {
        runId: run.runId,
        datasetId: run.datasetId,
        manifestVersion: run.manifestVersion,
        manifestDigest: run.manifestDigest,
        artifactKey: item.artifactKey,
        handlerKey: item.handlerKey,
        artifactFileSha256: item.artifactFileSha256,
        uploadFileSha256: item.artifactFileSha256,
        issuedToUserId: importerUserId,
        status: 'executed'
      });
      const binding = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
        FROM demo_run_import_batches
        WHERE run_id = ? AND artifact_key = ? AND context_id = ?`).get(
        run.runId,
        item.artifactKey,
        item.contextId
      );
      assert.deepStrictEqual({ batchId: Number(binding.batchId), batchRole: binding.batchRole }, {
        batchId: item.batchId,
        batchRole: 'primary'
      });
      const batch = db.prepare(`SELECT import_type AS importType, status, audit_phase AS auditPhase,
          file_sha256 AS fileSha256, success_count AS successCount
        FROM import_batches WHERE id = ?`).get(item.batchId);
      assert.strictEqual(batch.importType, item.importType);
      assert(['completed', 'completed_with_errors'].includes(batch.status));
      assert.strictEqual(batch.auditPhase, 'execute');
      assert.strictEqual(batch.fileSha256, item.artifactFileSha256);
      assert.strictEqual(Number(batch.successCount), item.expectedWouldImport);
      const registryRows = db.prepare(`SELECT CAST(entity_pk AS INTEGER) AS entityPk,
          source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
          registered_by AS registeredBy
        FROM demo_data_registry
        WHERE run_id = ? AND artifact_key = ? AND entity_type = ?
          AND ownership_kind = 'imported' AND cleaned_at IS NULL
        ORDER BY CAST(entity_pk AS INTEGER)`).all(run.runId, item.artifactKey, item.entityType);
      const businessRows = db.prepare(`SELECT id, source_row_number AS sourceRowNumber
        FROM ${item.businessTable} WHERE source_batch_id = ? ORDER BY id`).all(item.batchId);
      assert.strictEqual(registryRows.length, item.expectedWouldImport);
      assert.deepStrictEqual(
        registryRows.map((row) => Number(row.entityPk)),
        businessRows.map((row) => Number(row.id))
      );
      registryRows.forEach((row, index) => {
        assert.strictEqual(Number(row.sourceBatchId), item.batchId);
        assert.strictEqual(Number(row.sourceRowNumber), Number(businessRows[index].sourceRowNumber));
        assert.strictEqual(Number(row.registeredBy), importerUserId);
      });
    });
    const factorImport = imports.find((item) => item.entityType === 'carbon_factor');
    const activityImport = imports.find((item) => item.entityType === 'carbon_activity_record');
    const factorId = Number(db.prepare(`SELECT id FROM carbon_factors
      WHERE source_batch_id = ? AND energy_type_id = (
        SELECT id FROM energy_types WHERE code = 'electricity'
      )`).get(factorImport.batchId).id);
    const activityRows = db.prepare(`SELECT id, activity_code AS activityCode
      FROM carbon_activity_records WHERE source_batch_id = ? ORDER BY id`).all(activityImport.batchId);
    const calculatedActivity = activityRows.find((row) => row.activityCode === 'QL-CA-ELECTRICITY-202608');
    const missingActivity = activityRows.find((row) => row.activityCode === 'QL-CA-GAS-202608');
    assert(calculatedActivity && missingActivity, 'artifact 27 必须导入电力与天然气两条官方活动事实。');
    const sentinelRegistryCount = db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE (entity_type = 'carbon_factor' AND entity_pk IN (?, ?))
        OR (entity_type = 'carbon_activity_record' AND entity_pk = ?)`).get(
      String(sentinels.skippedFormalFactorId),
      String(sentinels.formalFactorId),
      String(sentinels.formalActivityId)
    ).total;
    assert.strictEqual(Number(sentinelRegistryCount), 0, '未归属正式 sentinel 不得进入 managed registry。');
    return {
      factorBatchId: factorImport.batchId,
      activityBatchId: activityImport.batchId,
      contextIds: imports.map((item) => item.contextId),
      factorId,
      calculatedActivityId: Number(calculatedActivity.id),
      missingActivityId: Number(missingActivity.id),
      formalFactorId: sentinels.formalFactorId,
      formalActivityId: sentinels.formalActivityId
    };
  } finally {
    db.close();
  }
}

/** 完成真实 Carbon managed HTTP 导入链并返回 post-action exact 闭包主键。 */
async function importOwnedCarbonThroughHttp(server, token, run, importerUserId) {
  const sentinels = seedCarbonImportDependenciesAndSentinels();
  const imports = [];
  for (const definition of CARBON_MANAGED_IMPORT_CASES) {
    imports.push(await importManagedCarbonArtifact(server, token, run, importerUserId, definition));
  }
  return assertManagedCarbonImportClosure(run, importerUserId, imports, sentinels);
}

/** 读取 Carbon HTTP 生命周期涉及的业务、ownership、output 与审计计数。 */
function readCarbonWriteCounts(runId) {
  const db = openDatabase();
  try {
    return {
      runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
      results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
      domainAudits: Number(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'carbon.accounting.run.create'").get().total),
      importedOwnership: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'imported'").get(runId).total),
      derivedOwnership: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'derived'").get(runId).total),
      relations: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations WHERE run_id = ?').get(runId).total),
      outputs: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_post_action_outputs').get().total),
      actionRuns: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_post_action_runs WHERE action_key = 'carbon-accounting-run'").get().total),
      previewAudits: Number(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.post-action.preview' AND detail_json LIKE '%carbon-accounting-run%'").get().total),
      executeAudits: Number(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute' AND detail_json LIKE '%carbon-accounting-run%'").get().total)
    };
  } finally {
    db.close();
  }
}

/** 断言真实 HTTP 成功响应使用统一 envelope。 */
function assertSuccessEnvelope(response) {
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(Object.keys(response.body).sort(), ['data', 'meta', 'success']);
  assert.strictEqual(response.body.success, true);
  assert(response.body.data && typeof response.body.data === 'object');
  assert(response.body.meta && typeof response.body.meta === 'object');
  assert.strictEqual(typeof response.body.meta.timestamp, 'string');
}

/** 断言未知请求字段通过统一 400 envelope fail-closed。 */
function assertUnknownBodyFieldResponse(response, fieldName) {
  assert.strictEqual(response.status, 400);
  assert.deepStrictEqual(Object.keys(response.body).sort(), ['error', 'meta', 'success']);
  assert.strictEqual(response.body.success, false);
  assert.strictEqual(response.body.error.code, 'BAD_REQUEST');
  assert.strictEqual(response.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
  assert.deepStrictEqual(response.body.error.details.fields, [fieldName]);
  assert.strictEqual(typeof response.body.meta.timestamp, 'string');
}

/** 业务行变更后同步 imported ownership snapshot，用于 HTTP stale 合同。 */
function refreshImportedSnapshot(db, runId, entityType, entityPk) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE run_id = ? AND entity_type = ? AND entity_pk = ? AND ownership_kind = 'imported'`).run(
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    runId,
    entityType,
    String(entityPk)
  );
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
    'inputEntityIds', 'privateContext', 'exactScope', 'registrationScope', 'completionWitness',
    'registrarReceipt', 'privateDigest', 'capability', 'timeseriesRecordIds', 'strategyRuleIds'
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
    const carbonActorAccount = createPermissionAccount(
      'demo-post-action-carbon-actor',
      'demo-post-action-carbon-actor',
      ['system:demo:view', 'system:demo:download', 'carbon:activities:calculate']
    );
    const carbonActorLogin = await request(server, 'POST', '/api/login', {
      username: carbonActorAccount.username,
      password: carbonActorAccount.password
    });
    assert.strictEqual(carbonActorLogin.status, 200);
    const carbonActorToken = carbonActorLogin.body.data.token;
    const carbonImporterAccount = createPermissionAccount(
      'demo-post-action-carbon-importer',
      'demo-post-action-carbon-importer',
      [
        'system:demo:download',
        'carbon:factor:import',
        'carbon:activities:import:preview',
        'carbon:activities:import:execute'
      ]
    );
    const carbonImporterLogin = await request(server, 'POST', '/api/login', {
      username: carbonImporterAccount.username,
      password: carbonImporterAccount.password
    });
    assert.strictEqual(carbonImporterLogin.status, 200);
    const carbonImporterToken = carbonImporterLogin.body.data.token;
    const carbonDeniedAccount = createPermissionAccount(
      'demo-post-action-carbon-denied',
      'demo-post-action-carbon-denied',
      ['system:demo:view', 'system:demo:download']
    );
    const carbonDeniedLogin = await request(server, 'POST', '/api/login', {
      username: carbonDeniedAccount.username,
      password: carbonDeniedAccount.password
    });
    assert.strictEqual(carbonDeniedLogin.status, 200);
    const carbonDeniedToken = carbonDeniedLogin.body.data.token;
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
    const predictionNoDownloadAccount = createPermissionAccount(
      'demo-post-action-prediction-no-download',
      'demo-post-action-prediction-no-download',
      ['system:demo:view', 'prediction:run:view', 'prediction:run:create']
    );
    const predictionNoDownloadLogin = await request(server, 'POST', '/api/login', {
      username: predictionNoDownloadAccount.username,
      password: predictionNoDownloadAccount.password
    });
    assert.strictEqual(predictionNoDownloadLogin.status, 200);
    const predictionNoDownloadToken = predictionNoDownloadLogin.body.data.token;
    const strategyPreviewOnlyAccount = createPermissionAccount(
      'demo-post-action-strategy-preview-only',
      'demo-post-action-strategy-preview-only',
      ['system:demo:view', 'system:demo:download', 'energy:strategy:evaluate']
    );
    const strategyPreviewOnlyLogin = await request(server, 'POST', '/api/login', {
      username: strategyPreviewOnlyAccount.username,
      password: strategyPreviewOnlyAccount.password
    });
    assert.strictEqual(strategyPreviewOnlyLogin.status, 200);
    const strategyPreviewOnlyToken = strategyPreviewOnlyLogin.body.data.token;
    const registry = await request(server, 'GET', '/api/system/demo-data/post-actions', undefined, token);
    assert.strictEqual(registry.status, 200);
    assert.strictEqual(registry.body.data.actions.length, 8);
    assert.strictEqual(registry.body.data.identity.version, 'demo-post-actions:v7');
    assert.strictEqual(registry.body.data.identity.digest, '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a');
    assert.deepStrictEqual(
      registry.body.data.actions.filter((action) => action.implementationStatus === 'connected')
        .map((action) => action.actionKey),
      [
        'meter-readings-to-energy-records',
        'carbon-accounting-run',
        'prediction-run',
        'strategy-evaluation-run',
        'energy-flow-analysis'
      ]
    );
    assert.deepStrictEqual(
      registry.body.data.actions.filter((action) => action.implementationStatus === 'not-connected')
        .map((action) => action.actionKey),
      [
        'benchmark-evaluation',
        'energy-balance-snapshot',
        'dashboard-refresh-check'
      ]
    );
    registry.body.data.actions.forEach((action) => {
      assert.deepStrictEqual(action.dependencies, [], `${action.actionKey} 不得把产品推荐顺序暴露为领域 predecessor`);
    });
    assertSafePublicJson(registry.body.data);

    const carbonPermissionDb = openDatabase();
    try {
      const readPermissions = (userId) => carbonPermissionDb.prepare(`SELECT menu.permission_code AS permissionCode
        FROM sys_user_roles user_role
        JOIN sys_role_menus role_menu ON role_menu.role_id = user_role.role_id
        JOIN sys_menus menu ON menu.id = role_menu.menu_id
        WHERE user_role.user_id = ? AND menu.permission_code IS NOT NULL
        ORDER BY menu.permission_code`).all(userId).map((row) => row.permissionCode);
      assert.deepStrictEqual(readPermissions(carbonActorAccount.userId), [
        'carbon:activities:calculate',
        'system:demo:download',
        'system:demo:view'
      ]);
      assert.deepStrictEqual(readPermissions(carbonDeniedAccount.userId), [
        'system:demo:download',
        'system:demo:view'
      ]);
      assert.deepStrictEqual(readPermissions(carbonImporterAccount.userId), [
        'carbon:activities:import:execute',
        'carbon:activities:import:preview',
        'carbon:factor:import',
        'system:demo:download'
      ]);
    } finally {
      carbonPermissionDb.close();
    }

    // 只有系统下载权限而缺少正式碳因子导入权限时，artifact 11 下载、预演和执行必须全部 403。
    const deniedFactorDownload = await request(
      server,
      'GET',
      '/api/templates/demo-park/11-carbon-factors.xlsx',
      undefined,
      carbonDeniedToken
    );
    assert.strictEqual(deniedFactorDownload.status, 403);
    assert.strictEqual(deniedFactorDownload.body.error.code, 'FORBIDDEN');
    const deniedFactorPreview = await requestMultipart(
      server,
      '/api/carbon/factors/import/preview',
      carbonDeniedToken,
      'permission-denied-context',
      '11-carbon-factors.xlsx',
      Buffer.from('permission-denied', 'utf8')
    );
    assert.strictEqual(deniedFactorPreview.status, 403);
    assert.strictEqual(deniedFactorPreview.body.error.code, 'FORBIDDEN');
    const deniedFactorExecute = await request(
      server,
      'POST',
      '/api/carbon/factors/import/execute',
      {},
      carbonDeniedToken
    );
    assert.strictEqual(deniedFactorExecute.status, 403);
    assert.strictEqual(deniedFactorExecute.body.error.code, 'FORBIDDEN');

    const ownedCarbon = await importOwnedCarbonThroughHttp(
      server,
      carbonImporterToken,
      run,
      carbonImporterAccount.userId
    );
    const carbonPrivateFieldValues = {
      scope: { startUtc: '2026-01-01T00:00:00Z' },
      entity: { type: 'carbon_activity_record' },
      batch: { id: ownedCarbon.activityBatchId },
      context: { id: ownedCarbon.contextIds[1] },
      registry: { id: 1 },
      adapter: 'forbidden-carbon-adapter',
      sql: 'SELECT * FROM carbon_activity_records'
    };
    const carbonCountsBeforeRejectedPreview = readCarbonWriteCounts(run.runId);
    for (const [fieldName, fieldValue] of Object.entries(carbonPrivateFieldValues)) {
      const rejected = await request(
        server,
        'POST',
        `/api/system/demo-data/runs/${run.runId}/post-actions/carbon-accounting-run/preview`,
        {
          clientRequestId: `api-carbon-private-preview-${fieldName}`,
          [fieldName]: fieldValue
        },
        carbonActorToken
      );
      assertUnknownBodyFieldResponse(rejected, fieldName);
      assert.deepStrictEqual(
        readCarbonWriteCounts(run.runId),
        carbonCountsBeforeRejectedPreview,
        `Carbon preview 未知字段 ${fieldName} 返回 400 后不得产生任何写入。`
      );
    }
    const carbonPermissionDeniedPreview = await request(
      server,
      'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/carbon-accounting-run/preview`,
      { clientRequestId: 'api-carbon-permission-denied' },
      carbonDeniedToken
    );
    assert.strictEqual(carbonPermissionDeniedPreview.status, 403);
    assert.deepStrictEqual(
      readCarbonWriteCounts(run.runId),
      carbonCountsBeforeRejectedPreview,
      '缺少 carbon:activities:calculate 的账号不得触发 Carbon preview 写入。'
    );

    const carbonPreview = await request(
      server,
      'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/carbon-accounting-run/preview`,
      { clientRequestId: 'api-carbon-connected' },
      carbonActorToken
    );
    assertSuccessEnvelope(carbonPreview);
    assert.strictEqual(carbonPreview.body.data.actionKey, 'carbon-accounting-run');
    assert.strictEqual(carbonPreview.body.data.status, 'previewed');
    assert.strictEqual(carbonPreview.body.data.blocker, null);
    assert.strictEqual(carbonPreview.body.data.result, null);
    assert.strictEqual(carbonPreview.body.data.outputCount, 0);
    assert.deepStrictEqual(carbonPreview.body.data.outputs, []);
    assert.deepStrictEqual(carbonPreview.body.data.input.sources, [
      '11-carbon-factors',
      '27-carbon-activities'
    ]);
    assert.strictEqual(carbonPreview.body.data.input.activityCount, 2);
    assert.strictEqual(carbonPreview.body.data.input.factorCount, 1);
    assert.strictEqual(carbonPreview.body.data.input.expectedRunCount, 1);
    assert.strictEqual(carbonPreview.body.data.input.expectedResultCount, 2);
    assert.strictEqual(carbonPreview.body.data.input.expectedOutputCount, 3);
    assert.strictEqual(carbonPreview.body.data.input.calculatedCount, 1);
    assert.strictEqual(carbonPreview.body.data.input.factorMissingCount, 1);
    assertSafePublicJson(carbonPreview.body.data);
    const carbonCountsAfterPreview = readCarbonWriteCounts(run.runId);
    assert.deepStrictEqual(carbonCountsAfterPreview, {
      ...carbonCountsBeforeRejectedPreview,
      actionRuns: carbonCountsBeforeRejectedPreview.actionRuns + 1,
      previewAudits: carbonCountsBeforeRejectedPreview.previewAudits + 1
    });

    const carbonMarkerDb = openDatabase();
    try {
      const actionInput = JSON.parse(carbonMarkerDb.prepare(`SELECT input_json AS inputJson
        FROM demo_post_action_runs WHERE action_run_id = ?`)
        .get(carbonPreview.body.data.actionRunId).inputJson);
      assert.deepStrictEqual({
        actionKey: actionInput.publicProjectionActionKey,
        resolverVersion: actionInput.publicProjectionResolverVersion,
        executorVersion: actionInput.publicProjectionExecutorVersion,
        projectionVersion: actionInput.publicProjectionVersion
      }, {
        actionKey: 'carbon-accounting-run',
        resolverVersion: 'carbon-accounting-resolver:v1',
        executorVersion: 'carbon-accounting-executor:v1',
        projectionVersion: 1
      });
    } finally {
      carbonMarkerDb.close();
    }

    for (const [fieldName, fieldValue] of Object.entries(carbonPrivateFieldValues)) {
      const rejected = await request(
        server,
        'POST',
        `/api/system/demo-data/post-action-runs/${carbonPreview.body.data.actionRunId}/execute`,
        {
          clientRequestId: 'api-carbon-connected',
          previewDigest: carbonPreview.body.data.previewDigest,
          confirmationText: '确认执行碳核算运行',
          [fieldName]: fieldValue
        },
        carbonActorToken
      );
      assertUnknownBodyFieldResponse(rejected, fieldName);
      assert.deepStrictEqual(
        readCarbonWriteCounts(run.runId),
        carbonCountsAfterPreview,
        `Carbon execute 未知字段 ${fieldName} 返回 400 后不得产生任何写入。`
      );
    }

    const carbonCountsBeforeExecute = readCarbonWriteCounts(run.runId);
    const carbonExecute = await request(
      server,
      'POST',
      `/api/system/demo-data/post-action-runs/${carbonPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-carbon-connected',
        previewDigest: carbonPreview.body.data.previewDigest,
        confirmationText: '确认执行碳核算运行'
      },
      carbonActorToken
    );
    assertSuccessEnvelope(carbonExecute);
    assert.strictEqual(carbonExecute.body.data.status, 'succeeded');
    assert.strictEqual(carbonExecute.body.data.outputCount, 3);
    assert.strictEqual(carbonExecute.body.data.outputs.length, 3);
    assert.deepStrictEqual(
      carbonExecute.body.data.outputs.map((output) => output.outputEntityType).sort(),
      ['carbon_accounting_result', 'carbon_accounting_result', 'carbon_calculation_run']
    );
    assert.strictEqual(carbonExecute.body.data.result.runCount, 1);
    assert.strictEqual(carbonExecute.body.data.result.resultCount, 2);
    assert.strictEqual(carbonExecute.body.data.result.outputCount, 3);
    assert.strictEqual(carbonExecute.body.data.result.calculatedCount, 1);
    assert.strictEqual(carbonExecute.body.data.result.factorMissingCount, 1);
    assertSafePublicJson(carbonExecute.body.data);
    const carbonCountsAfterExecute = readCarbonWriteCounts(run.runId);
    assert.deepStrictEqual(carbonCountsAfterExecute, {
      ...carbonCountsBeforeExecute,
      runs: carbonCountsBeforeExecute.runs + 1,
      results: carbonCountsBeforeExecute.results + 2,
      domainAudits: carbonCountsBeforeExecute.domainAudits + 1,
      derivedOwnership: carbonCountsBeforeExecute.derivedOwnership + 3,
      relations: carbonCountsBeforeExecute.relations + 5,
      outputs: carbonCountsBeforeExecute.outputs + 3,
      executeAudits: carbonCountsBeforeExecute.executeAudits + 1
    });

    const carbonStatus = await request(
      server,
      'GET',
      `/api/system/demo-data/post-action-runs/${carbonPreview.body.data.actionRunId}`,
      undefined,
      carbonActorToken
    );
    assertSuccessEnvelope(carbonStatus);
    assert.deepStrictEqual(carbonStatus.body.data, carbonExecute.body.data);
    assertSafePublicJson(carbonStatus.body.data);

    const carbonCountsBeforeReplay = readCarbonWriteCounts(run.runId);
    const carbonReplay = await request(
      server,
      'POST',
      `/api/system/demo-data/post-action-runs/${carbonPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-carbon-connected',
        previewDigest: carbonPreview.body.data.previewDigest,
        confirmationText: '确认执行碳核算运行'
      },
      carbonActorToken
    );
    assertSuccessEnvelope(carbonReplay);
    assert.deepStrictEqual(carbonReplay.body.data, carbonExecute.body.data);
    assert.deepStrictEqual(
      readCarbonWriteCounts(run.runId),
      carbonCountsBeforeReplay,
      'Carbon terminal execute replay 不得重复写入业务、ownership、relation、output 或审计。'
    );

    const carbonPersistenceDb = openDatabase();
    try {
      const resultRows = carbonPersistenceDb.prepare(`SELECT activity_record_id AS activityRecordId,
          carbon_factor_id AS carbonFactorId, status
        FROM carbon_accounting_results ORDER BY id`).all();
      assert.strictEqual(resultRows.length, 2);
      assert.strictEqual(
        resultRows.some((row) => Number(row.activityRecordId) === ownedCarbon.formalActivityId),
        false,
        '未归属 formal activity sentinel 不得被 exact closure 吸收。'
      );
      const calculatedResult = resultRows.find((row) => row.status === 'calculated');
      const missingResult = resultRows.find((row) => row.status === 'factor_missing');
      assert(calculatedResult);
      assert(missingResult);
      assert.strictEqual(Number(calculatedResult.activityRecordId), ownedCarbon.calculatedActivityId);
      assert.strictEqual(Number(calculatedResult.carbonFactorId), ownedCarbon.factorId);
      assert.notStrictEqual(Number(calculatedResult.carbonFactorId), ownedCarbon.formalFactorId);
      assert.strictEqual(Number(missingResult.activityRecordId), ownedCarbon.missingActivityId);
      assert.strictEqual(missingResult.carbonFactorId, null);
      const outputFacts = carbonPersistenceDb.prepare(`SELECT output_entity_type AS entityType,
          output_entity_id AS entityId
        FROM demo_post_action_outputs WHERE action_run_id = ? ORDER BY output_id`)
        .all(carbonPreview.body.data.actionRunId)
        .map((row) => `${row.entityType}:${row.entityId}`)
        .sort();
      const derivedFacts = carbonPersistenceDb.prepare(`SELECT entity_type AS entityType,
          entity_pk AS entityId
        FROM demo_data_registry
        WHERE run_id = ? AND ownership_kind = 'derived' AND cleaned_at IS NULL
        ORDER BY registry_id`).all(run.runId)
        .map((row) => `${row.entityType}:${row.entityId}`)
        .sort();
      assert.deepStrictEqual(outputFacts, derivedFacts);
    } finally {
      carbonPersistenceDb.close();
    }

    const ownedStrategy = seedOwnedStrategy(run);
    const strategyPrivatePreviewFields = {
      privateContext: {},
      exactScope: {},
      meterDeviceId: ownedStrategy.meterDeviceId,
      timeseriesRecordIds: ownedStrategy.timeseriesIds,
      strategyRuleIds: [ownedStrategy.ruleId],
      importBatchId: ownedStrategy.timeseriesBatchId,
      manifestDigest: run.manifestDigest,
      registryDigest: registry.body.data.identity.digest,
      privateDigest: '0'.repeat(64),
      capability: {}
    };
    const strategyStrictPreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-private-preview', ...strategyPrivatePreviewFields }, token);
    assert.strictEqual(strategyStrictPreview.status, 400);
    assert.strictEqual(strategyStrictPreview.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    assert.deepStrictEqual(
      strategyStrictPreview.body.error.details.fields,
      Object.keys(strategyPrivatePreviewFields).sort()
    );
    const deniedStrategyPreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-permission-denied' }, deniedToken);
    assert.strictEqual(deniedStrategyPreview.status, 403);

    const strategyContextDb = openDatabase();
    try {
      strategyContextDb.prepare(`UPDATE demo_import_contexts SET issued_to_user_id = ?
        WHERE context_id IN (${ownedStrategy.contextIds.map(() => '?').join(', ')})`).run(
        strategyPreviewOnlyAccount.userId,
        ...ownedStrategy.contextIds
      );
    } finally {
      strategyContextDb.close();
    }
    const strategyPreviewOnly = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-preview-only' }, strategyPreviewOnlyToken);
    assert.strictEqual(strategyPreviewOnly.status, 200);
    assert.strictEqual(strategyPreviewOnly.body.data.status, 'previewed');
    assertSafePublicJson(strategyPreviewOnly.body.data);
    const strategyExecuteDenied = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyPreviewOnly.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-preview-only',
        previewDigest: strategyPreviewOnly.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行'
      }, strategyPreviewOnlyToken);
    assert.strictEqual(strategyExecuteDenied.status, 403);
    const restoreStrategyContextDb = openDatabase();
    try {
      restoreStrategyContextDb.prepare(`UPDATE demo_import_contexts SET issued_to_user_id = 1
        WHERE context_id IN (${ownedStrategy.contextIds.map(() => '?').join(', ')})`).run(
        ...ownedStrategy.contextIds
      );
    } finally {
      restoreStrategyContextDb.close();
    }

    const strategyPreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-connected' }, token);
    assert.strictEqual(strategyPreview.status, 200);
    assert.strictEqual(strategyPreview.body.data.status, 'previewed');
    assert.deepStrictEqual(Object.keys(strategyPreview.body.data.input).sort(), [
      'endUtc', 'sourceTimeZone', 'sources', 'startUtc', 'strategyRuleCount', 'timeseriesCount'
    ].sort());
    assert.deepStrictEqual(strategyPreview.body.data.input.sources, [
      '15-energy-timeseries', '18-strategy-rules'
    ]);
    assert.strictEqual(strategyPreview.body.data.input.timeseriesCount, 4);
    assert.strictEqual(strategyPreview.body.data.input.strategyRuleCount, 1);
    assertSafePublicJson(strategyPreview.body.data);
    const strategyPrivateExecuteFields = {
      privateContext: {},
      exactScope: {},
      strategyRuleIds: [ownedStrategy.ruleId],
      timeseriesRecordIds: ownedStrategy.timeseriesIds,
      importBatchId: ownedStrategy.ruleBatchId,
      privateDigest: '0'.repeat(64),
      capability: {}
    };
    const strategyStrictExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-connected',
        previewDigest: strategyPreview.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行',
        ...strategyPrivateExecuteFields
      }, token);
    assert.strictEqual(strategyStrictExecute.status, 400);
    assert.strictEqual(strategyStrictExecute.body.error.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
    assert.deepStrictEqual(
      strategyStrictExecute.body.error.details.fields,
      Object.keys(strategyPrivateExecuteFields).sort()
    );
    const strategyCountsBeforeExecuteDb = openDatabase();
    let strategyCountsBeforeExecute;
    try {
      strategyCountsBeforeExecute = {
        evaluationRuns: strategyCountsBeforeExecuteDb.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count,
        ruleHits: strategyCountsBeforeExecuteDb.prepare('SELECT COUNT(*) AS count FROM strategy_rule_hits').get().count,
        derivedRegistry: strategyCountsBeforeExecuteDb.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE ownership_kind = 'derived'").get().count
      };
    } finally {
      strategyCountsBeforeExecuteDb.close();
    }
    const strategyExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-connected',
        previewDigest: strategyPreview.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行'
      }, token);
    assert.strictEqual(strategyExecute.status, 200);
    assert.strictEqual(strategyExecute.body.data.status, 'succeeded');
    assert.strictEqual(strategyExecute.body.data.outputCount, 1);
    assert.deepStrictEqual(strategyExecute.body.data.outputs[0].outputRef, {
      ruleCode: 'API-STRATEGY-PEAK',
      matchStatus: 'matched',
      priority: 'high'
    });
    assertSafePublicJson(strategyExecute.body.data);
    const strategyReplay = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyPreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-connected',
        previewDigest: strategyPreview.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行'
      }, token);
    assert.strictEqual(strategyReplay.status, 200);
    assert.deepStrictEqual(strategyReplay.body.data.result, strategyExecute.body.data.result);
    assert.deepStrictEqual(strategyReplay.body.data.outputs, strategyExecute.body.data.outputs);
    const strategyStatus = await request(server, 'GET',
      `/api/system/demo-data/post-action-runs/${strategyPreview.body.data.actionRunId}`,
      undefined,
      token);
    assert.strictEqual(strategyStatus.status, 200);
    assert.strictEqual(strategyStatus.body.data.status, 'succeeded');
    assertSafePublicJson(strategyStatus.body.data);
    const strategyCountsAfterExecuteDb = openDatabase();
    try {
      assert.strictEqual(
        strategyCountsAfterExecuteDb.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count,
        strategyCountsBeforeExecute.evaluationRuns + 1
      );
      assert.strictEqual(
        strategyCountsAfterExecuteDb.prepare('SELECT COUNT(*) AS count FROM strategy_rule_hits').get().count,
        strategyCountsBeforeExecute.ruleHits + 1
      );
      assert.strictEqual(
        strategyCountsAfterExecuteDb.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE ownership_kind = 'derived'").get().count,
        strategyCountsBeforeExecute.derivedRegistry + 2
      );
      assert.strictEqual(strategyCountsAfterExecuteDb.prepare(`SELECT COUNT(*) AS count
        FROM demo_post_action_outputs WHERE action_run_id = ?`).get(strategyPreview.body.data.actionRunId).count, 1);
      assert.strictEqual(strategyCountsAfterExecuteDb.prepare(`SELECT COUNT(*) AS count
        FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute' AND target_id = ?`)
        .get(strategyPreview.body.data.actionRunId).count, 1);
    } finally {
      strategyCountsAfterExecuteDb.close();
    }

    const strategyStalePreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-stale' }, token);
    assert.strictEqual(strategyStalePreview.status, 200);
    assert.strictEqual(strategyStalePreview.body.data.status, 'previewed');
    const strategyStaleDb = openDatabase();
    try {
      strategyStaleDb.prepare(`UPDATE energy_timeseries_records
        SET original_value = original_value + 1, normalized_value = normalized_value + 1
        WHERE id = ?`).run(ownedStrategy.timeseriesIds[0]);
      refreshImportedSnapshot(
        strategyStaleDb,
        run.runId,
        'energy_timeseries',
        ownedStrategy.timeseriesIds[0]
      );
    } finally {
      strategyStaleDb.close();
    }
    const strategyStaleExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyStalePreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-stale',
        previewDigest: strategyStalePreview.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行'
      }, token);
    assert.strictEqual(strategyStaleExecute.status, 409);
    assert.strictEqual(strategyStaleExecute.body.error.code, 'DEMO_POST_ACTION_INPUT_STALE');
    const restoreStrategyStaleDb = openDatabase();
    try {
      restoreStrategyStaleDb.prepare(`UPDATE energy_timeseries_records
        SET original_value = original_value - 1, normalized_value = normalized_value - 1
        WHERE id = ?`).run(ownedStrategy.timeseriesIds[0]);
      refreshImportedSnapshot(
        restoreStrategyStaleDb,
        run.runId,
        'energy_timeseries',
        ownedStrategy.timeseriesIds[0]
      );
      assert.strictEqual(restoreStrategyStaleDb.prepare(`SELECT status FROM demo_post_action_runs
        WHERE action_run_id = ?`).get(strategyStalePreview.body.data.actionRunId).status, 'previewed');
    } finally {
      restoreStrategyStaleDb.close();
    }

    // 手工置为 executing 只验证 HTTP claim/state conflict；真实 CAS 竞态由通用双进程测试覆盖。
    const strategyStatePreview = await request(server, 'POST',
      `/api/system/demo-data/runs/${run.runId}/post-actions/strategy-evaluation-run/preview`,
      { clientRequestId: 'api-strategy-state-conflict' }, token);
    assert.strictEqual(strategyStatePreview.status, 200);
    assert.strictEqual(strategyStatePreview.body.data.status, 'previewed');
    const strategyStateDb = openDatabase();
    try {
      strategyStateDb.prepare(`UPDATE demo_post_action_runs SET status = 'executing', started_at = ?, updated_at = ?
        WHERE action_run_id = ?`).run(
        new Date().toISOString(),
        new Date().toISOString(),
        strategyStatePreview.body.data.actionRunId
      );
    } finally {
      strategyStateDb.close();
    }
    const strategyStateExecute = await request(server, 'POST',
      `/api/system/demo-data/post-action-runs/${strategyStatePreview.body.data.actionRunId}/execute`,
      {
        clientRequestId: 'api-strategy-state-conflict',
        previewDigest: strategyStatePreview.body.data.previewDigest,
        confirmationText: '确认执行策略评估运行'
      }, token);
    assert.strictEqual(strategyStateExecute.status, 409);
    assert.strictEqual(strategyStateExecute.body.error.code, 'DEMO_POST_ACTION_CLAIM_CONFLICT');
    const restoreStrategyStateDb = openDatabase();
    try {
      restoreStrategyStateDb.prepare(`UPDATE demo_post_action_runs
        SET status = 'failed', failure_reason = 'TEST_STATE_CONFLICT', completed_at = ?, updated_at = ?
        WHERE action_run_id = ?`).run(
        new Date().toISOString(),
        new Date().toISOString(),
        strategyStatePreview.body.data.actionRunId
      );
      assert.strictEqual(restoreStrategyStateDb.prepare('SELECT COUNT(*) AS count FROM strategy_evaluation_runs').get().count,
        strategyCountsBeforeExecute.evaluationRuns + 1);
    } finally {
      restoreStrategyStateDb.close();
    }

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
    const noDownloadPreview = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-no-download' }, predictionNoDownloadToken);
    assert.strictEqual(noDownloadPreview.status, 403);
    const deniedFlowPreview = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/energy-flow-analysis/preview`, { clientRequestId: 'api-flow-denied' }, deniedToken);
    assert.strictEqual(deniedFlowPreview.status, 403);
    const previewOnlyBlocked = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-preview-only' }, previewOnlyToken);
    assert.strictEqual(previewOnlyBlocked.status, 200);
    assert.strictEqual(previewOnlyBlocked.body.data.status, 'blocked');
    assert.notStrictEqual(previewOnlyBlocked.body.data.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
    const previewOnlyExecute = await request(server, 'POST', `/api/system/demo-data/post-action-runs/${previewOnlyBlocked.body.data.actionRunId}/execute`, {
      clientRequestId: 'api-preview-only', previewDigest: previewOnlyBlocked.body.data.previewDigest,
      confirmationText: '确认执行预测运行'
    }, previewOnlyToken);
    assert.strictEqual(previewOnlyExecute.status, 403);
    const blocked = await request(server, 'POST', `/api/system/demo-data/runs/${run.runId}/post-actions/prediction-run/preview`, { clientRequestId: 'api-blocked' }, token);
    assert.strictEqual(blocked.status, 200);
    assert.strictEqual(blocked.body.data.status, 'blocked');
    assert.notStrictEqual(blocked.body.data.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
    const status = await request(server, 'GET', `/api/system/demo-data/post-action-runs/${blocked.body.data.actionRunId}`, undefined, token);
    assert.strictEqual(status.status, 200);
    assert.deepStrictEqual(status.body.data, blocked.body.data);
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
    assert.strictEqual(executeBlocked.body.error.code, blocked.body.data.blocker.code);
    console.log('demoPostActionApi.test.js passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
