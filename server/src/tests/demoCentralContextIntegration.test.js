'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

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
const {
  buildDemoOwnershipPlan,
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest
} = require('../services/demoOwnershipService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { normalizeUserVisibleStrictUtcInput } = require('../utils/userVisibleDateTime');

// 六组中央 context 代表性测试定义。
const TEST_CASES = Object.freeze([
  Object.freeze({
    label: 'EnergyAnalysis 班次单批次',
    artifactKey: '13-shift-definitions',
    previewPath: '/api/energy-analysis/imports/shift-definitions/preview',
    executePath: '/api/energy-analysis/imports/shift-definitions/execute',
    expectedRoles: ['primary'],
    expectedImportTypes: ['shift_definition'],
    expectedBusinessTable: 'shift_definitions'
  }),
  Object.freeze({
    label: 'EnergyAnalysis 时序单批次',
    artifactKey: '15-energy-timeseries',
    previewPath: '/api/energy-analysis/imports/timeseries/preview',
    executePath: '/api/energy-analysis/imports/timeseries/execute',
    expectedRoles: ['primary'],
    expectedImportTypes: ['energy_timeseries'],
    expectedBusinessTable: 'energy_timeseries_records'
  }),
  Object.freeze({
    label: 'EnergyAnalysis 策略单批次',
    artifactKey: '18-strategy-rules',
    previewPath: '/api/energy-analysis/imports/strategy-rules/preview',
    executePath: '/api/energy-analysis/imports/strategy-rules/execute',
    expectedRoles: ['primary'],
    expectedImportTypes: ['strategy_rule'],
    expectedBusinessTable: 'strategy_rules'
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

// managed 单批次 ownership 对外只允许返回状态和聚合计数，不允许逐行来源证据。
const MANAGED_OWNERSHIP_PUBLIC_FIELDS = Object.freeze([
  'applied',
  'mode',
  'noInsertedRecords',
  'registrationCount',
  'insertedCount',
  'idempotentCount',
  'skippedCount',
  'relationCount'
]);
// 以下 ownership 内部字段禁止出现在任意公开嵌套层级。
const FORBIDDEN_OWNERSHIP_PUBLIC_FIELDS = new Set([
  'context',
  'contextId',
  'runId',
  'datasetId',
  'manifestVersion',
  'manifestDigest',
  'batchBindings',
  'registrations',
  'relations',
  'registryId',
  'identityDigest',
  'snapshotDigest',
  'sourceBatchId',
  'sourceRowNumber',
  'rowWitness',
  'transactionScope',
  'facade',
  'handler',
  'sql',
  'modulePath'
]);

/** 递归断言 ownership 子树不包含内部字段。 */
function assertNoManagedOwnershipInternalFields(value, label, currentPath = 'ownership') {
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, nestedValue]) => {
    assert.strictEqual(FORBIDDEN_OWNERSHIP_PUBLIC_FIELDS.has(key), false,
      `${label} ${currentPath}.${key} 不得进入 HTTP 响应。`);
    assertNoManagedOwnershipInternalFields(nestedValue, label, `${currentPath}.${key}`);
  });
}

/** 断言 managed ownership HTTP DTO 只包含安全摘要字段和稳定类型。 */
function assertManagedOwnershipPublicProjection(ownership, label) {
  assert(ownership && typeof ownership === 'object' && !Array.isArray(ownership),
    `${label} execute 必须返回 ownership 公共摘要。`);
  assert.deepStrictEqual(Object.keys(ownership).sort(), [...MANAGED_OWNERSHIP_PUBLIC_FIELDS].sort(),
    `${label} ownership 只能包含固定公共摘要字段。`);
  assertNoManagedOwnershipInternalFields(ownership, label);
  assert.strictEqual(typeof ownership.applied, 'boolean');
  assert.strictEqual(ownership.mode, 'demo');
  assert.strictEqual(typeof ownership.noInsertedRecords, 'boolean');
  ['registrationCount', 'insertedCount', 'idempotentCount', 'skippedCount', 'relationCount'].forEach((field) => {
    assert(Number.isSafeInteger(ownership[field]) && ownership[field] >= 0,
      `${label} ownership.${field} 必须是非负安全整数。`);
  });
}

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
function requestMultipart(server, pathname, token, demoContextToken, filename, buffer, contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  const boundary = `----demo-central-context-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
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

/** 为 24、25 组插入组织、能流、月度能耗和发电最小真实依赖主数据。 */
function seedBundleDependencies() {
  const db = openDatabase();
  try {
    const parkId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('QL-PARK', '天坤集团', '/QL-PARK', 'enterprise', 'active')`).run().lastInsertRowid);
    const workshopId = Number(db.prepare(`INSERT INTO organization_units
      (parent_id, unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, 'QL-WORKSHOP-A', '精密制造一车间', '/QL-PARK/QL-WORKSHOP-A', 'workshop', 'active')`).run(parkId).lastInsertRowid);
    // artifact 15 真实时序模板引用的设备级用能单元主键。
    const cncEquipmentId = Number(db.prepare(`INSERT INTO organization_units
      (parent_id, unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, 'QL-EQ-CNC-01', '数控加工中心01', '/QL-PARK/QL-WORKSHOP-A/QL-EQ-CNC-01', 'equipment', 'active')`)
      .run(workshopId).lastInsertRowid);
    const modelId = Number(db.prepare(`INSERT INTO energy_flow_models
      (model_code, model_name, source, document_no, version, effective_start_utc,
       effective_end_utc, source_timezone, status)
      VALUES ('QL-FLOW-PARK', '天坤集团综合能流模型', '天坤集团能源审计', 'QL-FLOW-2026-01',
        'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run().lastInsertRowid);
    const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`);
    insertNode.run(modelId, 'QL-NODE-GRID', '电网输入', 'source', parkId, 80, 120);
    insertNode.run(modelId, 'QL-NODE-WSA', '一车间负荷', 'sink', workshopId, 360, 120);
    const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
    assert(electricity, '隔离库必须包含 electricity 能源类型。');
    db.prepare(`INSERT INTO meter_devices
      (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id,
        online_status, gateway_id, multiplier, allow_manual_reading, flow_direction,
        install_location, status, remark)
      VALUES ('QL-M-ELEC-CNC01', '数控中心电表', 'electricity', ?, ?,
        'online', 'QL-GW-02', 1, 1, 'input', '一车间配电柜', 'active', '设备分表')`)
      .run(electricity.id, cncEquipmentId);
    db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
        original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2026-07', '2026-07', 'kWh', 500000, 'kWh', 500000,
        'demo-central-context:energy:2026-07', 'active')`).run(electricity.id, parkId);
    db.prepare(`INSERT INTO generation_records
      (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh,
        self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark)
      VALUES (?, ?, '2026-07', 60000, 50000, 10000, 'upload', 'active', 'QL-GEN-PARK-202607')`).run(parkId, electricity.id);
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

/** 读取 managed 下载后的 runtime、run、context 与自动激活审计摘要。 */
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
      if (testCase.artifactKey === '13-shift-definitions') {
        const ownershipRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
            artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
            ownership_kind AS ownershipKind, identity_digest AS identityDigest,
            snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
            source_row_number AS sourceRowNumber, registered_by AS registeredBy
          FROM demo_data_registry WHERE source_batch_id = ? ORDER BY registry_id`).all(batchIds[0]);
        const shifts = db.prepare(`SELECT id, source_batch_id, source_row_number, shift_code, shift_name,
            start_minute, end_minute, crosses_midnight, source_timezone, source, version,
            effective_start_utc, effective_end_utc, status, created_at, updated_at
          FROM shift_definitions WHERE source_batch_id = ? ORDER BY id`).all(batchIds[0]);
        assert.strictEqual(ownershipRows.length, shifts.length,
          'artifact 13 每条真实班次 INSERT 必须同步登记 imported ownership。');
        assert(ownershipRows.length > 0, 'artifact 13 必须登记真实班次 ownership。');
        ownershipRows.forEach((ownershipRow) => {
          const shift = shifts.find((candidate) => String(candidate.id) === ownershipRow.entityPk);
          assert(shift, 'artifact 13 registry 必须指向同批次真实班次定义。');
          assert.strictEqual(ownershipRow.artifactKey, testCase.artifactKey);
          assert.strictEqual(ownershipRow.entityType, 'shift_definition');
          assert.strictEqual(ownershipRow.ownershipKind, 'imported');
          assert.strictEqual(Number(ownershipRow.sourceBatchId), Number(batchIds[0]));
          assert.strictEqual(Number(ownershipRow.sourceRowNumber), Number(shift.source_row_number));
          assert.strictEqual(Number(ownershipRow.registeredBy), Number(userId));
          assert.strictEqual(ownershipRow.identityDigest,
            calculateDemoEntityIdentityDigest('shift_definition', ownershipRow.entityPk));
          assert.strictEqual(ownershipRow.snapshotDigest,
            calculateDemoEntitySnapshotDigest('shift_definition', ownershipRow.entityPk, shift));
        });
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
          JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
          JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
          WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(testCase.artifactKey, testCase.artifactKey).total, 0,
        'artifact 13 没有真实 relation 语义，不得写 demo_data_relations。');
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
          WHERE operation = 'energy.shift.configuration.import' AND target_type = 'shift_definition'
            AND target_id IN (SELECT id FROM shift_definitions WHERE source_batch_id = ?)`).get(batchIds[0]).total,
        shifts.length, 'artifact 13 每条业务 INSERT 必须在同一事务写固定操作审计。');
      } else if (testCase.artifactKey === '15-energy-timeseries') {
        const timeseries = db.prepare(`SELECT id, source_batch_id, source_row_number,
            organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc,
            source_timezone, granularity_minutes, original_unit, original_value,
            normalized_unit, normalized_value, source_reference, data_source, record_status,
            void_reason, voided_at, created_at, updated_at
          FROM energy_timeseries_records WHERE source_batch_id = ? ORDER BY id`).all(batchIds[0]);
        const ownershipRows = db.prepare(`SELECT registry_id AS registryId, artifact_key AS artifactKey,
            entity_type AS entityType, entity_pk AS entityPk, ownership_kind AS ownershipKind,
            identity_digest AS identityDigest, snapshot_digest AS snapshotDigest,
            source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
            registered_by AS registeredBy
          FROM demo_data_registry WHERE artifact_key = ? AND source_batch_id = ? ORDER BY registry_id`).all(
          testCase.artifactKey, batchIds[0]);
        assert.strictEqual(timeseries.length, 16, 'artifact 15 固定演示时序必须写入 16 条业务记录。');
        assert.strictEqual(ownershipRows.length, timeseries.length,
          'artifact 15 每条时序 INSERT 必须同步登记 imported ownership。');
        ownershipRows.forEach((ownershipRow) => {
          const projection = timeseries.find((candidate) => String(candidate.id) === ownershipRow.entityPk);
          assert(projection, 'artifact 15 registry 必须指向同批次真实时序业务行。');
          assert.strictEqual(ownershipRow.artifactKey, testCase.artifactKey);
          assert.strictEqual(ownershipRow.entityType, 'energy_timeseries');
          assert.strictEqual(ownershipRow.ownershipKind, 'imported');
          assert.strictEqual(Number(ownershipRow.sourceBatchId), Number(batchIds[0]));
          assert.strictEqual(Number(ownershipRow.sourceRowNumber), Number(projection.source_row_number));
          assert.strictEqual(Number(ownershipRow.registeredBy), Number(userId));
          assert.strictEqual(ownershipRow.identityDigest,
            calculateDemoEntityIdentityDigest('energy_timeseries', ownershipRow.entityPk));
          assert.strictEqual(ownershipRow.snapshotDigest,
            calculateDemoEntitySnapshotDigest('energy_timeseries', ownershipRow.entityPk, projection));
        });
        assert(timeseries.every((row) => Number(row.source_batch_id) === Number(batchIds[0])
          && Number.isSafeInteger(Number(row.source_row_number)) && Number(row.source_row_number) > 0),
        'artifact 15 每条业务记录必须保留当前 managed batch 和物理行号。');
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
          JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
          JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
          WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(testCase.artifactKey, testCase.artifactKey).total, 0,
        'artifact 15 先导入且 artifact 18 尚未登记时不得提前创建不完整策略输入关系。');
      } else if (testCase.artifactKey === '18-strategy-rules') {
        const rules = db.prepare(`SELECT id, source_batch_id, source_row_number, rule_code,
            rule_name, rule_version, formula_version, metric_code, threshold_operator,
            threshold_value, threshold_min, threshold_max, threshold_unit, reduction_rate,
            priority, evidence_requirements_json, recommendation_text, source,
            effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
          FROM strategy_rules WHERE source_batch_id = ? ORDER BY id`).all(batchIds[0]);
        const ownershipRows = db.prepare(`SELECT registry_id AS registryId, artifact_key AS artifactKey,
            entity_type AS entityType, entity_pk AS entityPk, ownership_kind AS ownershipKind,
            identity_digest AS identityDigest, snapshot_digest AS snapshotDigest,
            source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
            registered_by AS registeredBy
          FROM demo_data_registry WHERE artifact_key = ? AND source_batch_id = ? ORDER BY registry_id`).all(
          testCase.artifactKey, batchIds[0]);
        assert.strictEqual(rules.length, 1, 'artifact 18 固定演示策略必须写入 1 条业务规则。');
        assert.strictEqual(ownershipRows.length, rules.length,
          'artifact 18 每条策略 INSERT 必须同步登记 imported ownership。');
        ownershipRows.forEach((ownershipRow) => {
          const projection = rules.find((candidate) => String(candidate.id) === ownershipRow.entityPk);
          assert(projection, 'artifact 18 registry 必须指向同批次真实策略业务行。');
          assert.strictEqual(ownershipRow.artifactKey, testCase.artifactKey);
          assert.strictEqual(ownershipRow.entityType, 'strategy_rule');
          assert.strictEqual(ownershipRow.ownershipKind, 'imported');
          assert.strictEqual(Number(ownershipRow.sourceBatchId), Number(batchIds[0]));
          assert.strictEqual(Number(ownershipRow.sourceRowNumber), Number(projection.source_row_number));
          assert.strictEqual(Number(ownershipRow.registeredBy), Number(userId));
          assert.strictEqual(ownershipRow.identityDigest,
            calculateDemoEntityIdentityDigest('strategy_rule', ownershipRow.entityPk));
          assert.strictEqual(ownershipRow.snapshotDigest,
            calculateDemoEntitySnapshotDigest('strategy_rule', ownershipRow.entityPk, projection));
        });
        const strategyInputRelations = db.prepare(`SELECT relation.relation_type AS relationType,
            source.run_id AS sourceRunId, source.entity_type AS sourceEntityType,
            source.entity_pk AS sourceEntityPk, source.ownership_kind AS sourceOwnershipKind,
            target.run_id AS targetRunId, target.entity_type AS targetEntityType,
            target.entity_pk AS targetEntityPk, target.ownership_kind AS targetOwnershipKind
          FROM demo_data_relations relation
          JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
          JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
          WHERE source.artifact_key = '15-energy-timeseries'
            AND target.artifact_key = '18-strategy-rules'
          ORDER BY relation.relation_id`).all();
        const timeseriesOwnershipCount = db.prepare(`SELECT COUNT(*) AS total
          FROM demo_data_registry WHERE artifact_key = '15-energy-timeseries'
            AND entity_type = 'energy_timeseries' AND ownership_kind = 'imported'
            AND cleaned_at IS NULL`).get().total;
        const expectedStrategyRelationCount = Number(timeseriesOwnershipCount) * ownershipRows.length;
        assert.strictEqual(strategyInputRelations.length, expectedStrategyRelationCount,
          'artifact 18 后导入时必须自动补齐当前 run 的时序×规则 imported uses_config 闭包。');
        assert(strategyInputRelations.every((relation) => (
          relation.relationType === 'uses_config'
          && relation.sourceRunId === relation.targetRunId
          && relation.sourceEntityType === 'energy_timeseries'
          && relation.targetEntityType === 'strategy_rule'
          && relation.sourceOwnershipKind === 'imported'
          && relation.targetOwnershipKind === 'imported'
        )), '策略输入关系必须保持固定方向、端点、类型和 imported ownership。');
        const persistedExecuteResult = JSON.parse(
          audits.find((audit) => audit.importType === 'strategy_rule').executeResultJson
        );
        assertManagedOwnershipPublicProjection(persistedExecuteResult.ownership, 'artifact 18 execute 审计');
        assert.strictEqual(
          persistedExecuteResult.ownership.relationCount,
          expectedStrategyRelationCount,
          'artifact 18 ownership 公共摘要必须反映自动准备的完整闭包基数。'
        );
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM strategy_evaluation_runs`).get().total, 0,
          'artifact 18 策略配置导入不得创建 evaluation run。');
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM strategy_rule_hits`).get().total, 0,
          'artifact 18 策略配置导入不得创建 rule hit。');
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
          WHERE operation = 'energy.strategy.rule.configuration.import' AND target_type = 'strategy_rule'
            AND target_id IN (SELECT id FROM strategy_rules WHERE source_batch_id = ?)`).get(batchIds[0]).total,
        rules.length, 'artifact 18 每条业务 INSERT 必须在同一事务写固定配置审计。');
      } else if (testCase.artifactKey === '19-conversion-factors') {
        const ownershipRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId,
            artifact_key AS artifactKey, entity_type AS entityType, entity_pk AS entityPk,
            ownership_kind AS ownershipKind, identity_digest AS identityDigest,
            snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
            source_row_number AS sourceRowNumber, registered_by AS registeredBy
          FROM demo_data_registry WHERE source_batch_id = ? ORDER BY registry_id`).all(batchIds[0]);
        assert(ownershipRows.length > 0, 'artifact 19 demo execute 必须同步登记 imported ownership。');
        assert(ownershipRows.every((row) => row.artifactKey === testCase.artifactKey
          && row.entityType === 'energy_conversion_factor'
          && row.ownershipKind === 'imported'
          && Number(row.sourceBatchId) === batchIds[0]
          && Number.isSafeInteger(Number(row.sourceRowNumber))
          && Number(row.sourceRowNumber) > 0
          && Number(row.registeredBy) === userId
          && /^[a-f0-9]{64}$/.test(row.identityDigest)
          && /^[a-f0-9]{64}$/.test(row.snapshotDigest)), 'artifact 19 ownership 必须保留固定实体、类型、操作者和来源 provenance。');
        const factorProjection = db.prepare(`SELECT id, source_batch_id, source_row_number, factor_code, energy_type_id,
            source_unit, factor_value, target_unit, display_unit, display_divisor, source, document_no, version,
            effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
          FROM energy_conversion_factors WHERE id = ?`).get(Number(ownershipRows[0].entityPk));
        assert(factorProjection, 'artifact 19 registry 必须指向真实折标系数业务行。');
        assert.strictEqual(ownershipRows[0].identityDigest,
          calculateDemoEntityIdentityDigest('energy_conversion_factor', ownershipRows[0].entityPk));
        assert.strictEqual(ownershipRows[0].snapshotDigest,
          calculateDemoEntitySnapshotDigest('energy_conversion_factor', ownershipRows[0].entityPk, factorProjection));
        const persistedExecuteResult = JSON.parse(audits.find((audit) => audit.importType === 'energy_conversion_factor').executeResultJson);
        assertManagedOwnershipPublicProjection(persistedExecuteResult.ownership, 'artifact 19 execute 审计');
        assert.strictEqual(persistedExecuteResult.ownership.applied, true);
        assert.strictEqual(persistedExecuteResult.ownership.noInsertedRecords, false);
        assert.strictEqual(persistedExecuteResult.ownership.registrationCount, ownershipRows.length);
        assert.strictEqual(persistedExecuteResult.ownership.insertedCount, ownershipRows.length);
        assert.strictEqual(persistedExecuteResult.ownership.idempotentCount, 0);
        assert.strictEqual(persistedExecuteResult.ownership.skippedCount, 0);
        assert.strictEqual(persistedExecuteResult.ownership.relationCount, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
          JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
          JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
          WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(testCase.artifactKey, testCase.artifactKey).total, 0,
        'artifact 19 没有真实 relation 语义，不得写 demo_data_relations。');
      }
    } else if (testCase.artifactKey === '24-energy-flow-edges') {
      const edge = db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id,
          energy_flow_path_id, path_sequence, edge_code, from_node_id, to_node_id,
          energy_type_id, unit, source_type, source_reference, source_mapping_json,
          status, created_at, updated_at
        FROM energy_flow_edges WHERE source_batch_id = ?`).get(preview.edgeBatchId);
      const record = db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id,
          record_code, record_role, energy_flow_edge_id, energy_flow_node_id,
          energy_flow_path_id, energy_flow_asset_id, stage_code, energy_type_id,
          start_wall_clock, end_wall_clock, start_utc, end_utc, source_timezone,
          original_unit, original_value, source_type, source_reference, source_mapping_json,
          formula_version, record_status, void_reason, voided_at, created_at, updated_at
        FROM energy_flow_records WHERE source_batch_id = ?`).get(preview.recordBatchId);
      assert(edge, 'artifact 24 必须写入能流边。');
      assert(record, 'artifact 24 必须写入显式边值。');
      assert.strictEqual(Number(record.energy_flow_edge_id), Number(edge.id));
      const ownershipRows = db.prepare(`SELECT registry_id AS registryId, entity_type AS entityType,
          entity_pk AS entityPk, ownership_kind AS ownershipKind, identity_digest AS identityDigest,
          snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
          source_row_number AS sourceRowNumber, registered_by AS registeredBy
        FROM demo_data_registry WHERE artifact_key = '24-energy-flow-edges' ORDER BY registry_id`).all();
      assert.strictEqual(ownershipRows.length, 2, 'artifact 24 必须原子登记 edge/record 两个角色。');
      ownershipRows.forEach((ownershipRow) => {
        const projection = ownershipRow.entityType === 'energy_flow_edge' ? edge : record;
        assert.strictEqual(ownershipRow.ownershipKind, 'imported');
        assert.strictEqual(Number(ownershipRow.registeredBy), userId);
        assert.strictEqual(Number(ownershipRow.sourceBatchId), ownershipRow.entityType === 'energy_flow_edge'
          ? Number(preview.edgeBatchId)
          : Number(preview.recordBatchId));
        assert.strictEqual(Number(ownershipRow.sourceRowNumber), Number(projection.source_row_number));
        assert.strictEqual(ownershipRow.identityDigest,
          calculateDemoEntityIdentityDigest(ownershipRow.entityType, ownershipRow.entityPk));
        assert.strictEqual(ownershipRow.snapshotDigest,
          calculateDemoEntitySnapshotDigest(ownershipRow.entityType, ownershipRow.entityPk, projection));
      });
      const relations = db.prepare(`SELECT relation.relation_type AS relationType,
          parent.entity_type AS fromEntityType, parent.entity_pk AS fromEntityPk,
          child.entity_type AS toEntityType, child.entity_pk AS toEntityPk
        FROM demo_data_relations relation
        JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
        JOIN demo_data_registry child ON child.registry_id = relation.to_registry_id
        WHERE parent.artifact_key = '24-energy-flow-edges'`).all();
      assert.deepStrictEqual(relations, [{
        relationType: 'contains',
        fromEntityType: 'energy_flow_edge',
        fromEntityPk: String(edge.id),
        toEntityType: 'energy_flow_record',
        toEntityPk: String(record.id)
      }], 'artifact 24 只允许本次新插入且同 run owned 的 edge→record contains relation。');
    } else {
      const boundaryBatchId = audits.find((row) => row.importType === 'energy_balance_boundary').id;
      const itemBatchId = audits.find((row) => row.importType === 'energy_balance_item').id;
      const boundary = db.prepare(`SELECT id, source_batch_id, source_row_number, boundary_code,
          boundary_name, organization_unit_id, source, document_no, version, effective_start_utc,
          effective_end_utc, source_timezone, generation_boundary_confirmed, status, created_at, updated_at
        FROM energy_balance_boundaries
        WHERE boundary_code = 'QL-BAL-PARK' AND version = 'QL-BAL:v1'`).get();
      assert(boundary, 'Balance bundle 必须写入稳定边界编码和版本。');
      assert.strictEqual(Number(boundary.source_batch_id), boundaryBatchId);
      assert(Number(boundary.source_row_number) >= 1, 'boundary 必须保存真实 source row。');
      const balanceItems = db.prepare(`SELECT id, source_batch_id, source_row_number, energy_balance_boundary_id,
          item_code, item_name, role, energy_type_id, original_unit, source_type, source_mapping_json,
          generation_anti_double_count_key, status, created_at, updated_at
        FROM energy_balance_items WHERE energy_balance_boundary_id = ? ORDER BY id`).all(boundary.id);
      assert.strictEqual(balanceItems.length > 0, true);
      assert(balanceItems.every((item) => Number(item.source_batch_id) === itemBatchId
        && Number(item.source_row_number) >= 1), 'item 必须保存自身批次和真实 source row。');
      const ownershipRows = db.prepare(`SELECT registry_id AS registryId, entity_type AS entityType,
          entity_pk AS entityPk, ownership_kind AS ownershipKind, identity_digest AS identityDigest,
          snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId,
          source_row_number AS sourceRowNumber, registered_by AS registeredBy
        FROM demo_data_registry WHERE artifact_key = '25-energy-balance-configs' ORDER BY registry_id`).all();
      assert.strictEqual(ownershipRows.length, balanceItems.length + 1,
        'artifact 25 demo execute 必须同步登记 boundary/item imported ownership。');
      const boundaryOwnership = ownershipRows.find((row) => row.entityType === 'energy_balance_boundary');
      assert(boundaryOwnership, 'artifact 25 必须登记 boundary ownership。');
      assert.strictEqual(Number(boundaryOwnership.sourceBatchId), boundaryBatchId);
      assert.strictEqual(Number(boundaryOwnership.sourceRowNumber), Number(boundary.source_row_number));
      assert.strictEqual(boundaryOwnership.ownershipKind, 'imported');
      assert.strictEqual(Number(boundaryOwnership.registeredBy), userId);
      assert.strictEqual(boundaryOwnership.identityDigest,
        calculateDemoEntityIdentityDigest('energy_balance_boundary', boundaryOwnership.entityPk));
      assert.strictEqual(boundaryOwnership.snapshotDigest,
        calculateDemoEntitySnapshotDigest('energy_balance_boundary', boundaryOwnership.entityPk, boundary));
      const itemOwnershipRows = ownershipRows.filter((row) => row.entityType === 'energy_balance_item');
      assert.strictEqual(itemOwnershipRows.length, balanceItems.length);
      itemOwnershipRows.forEach((ownershipRow) => {
        const item = balanceItems.find((candidate) => String(candidate.id) === ownershipRow.entityPk);
        assert(item, 'item registry 必须指向真实业务行。');
        assert.strictEqual(Number(ownershipRow.sourceBatchId), itemBatchId);
        assert.strictEqual(Number(ownershipRow.sourceRowNumber), Number(item.source_row_number));
        assert.strictEqual(ownershipRow.identityDigest,
          calculateDemoEntityIdentityDigest('energy_balance_item', ownershipRow.entityPk));
        assert.strictEqual(ownershipRow.snapshotDigest,
          calculateDemoEntitySnapshotDigest('energy_balance_item', ownershipRow.entityPk, item));
      });
      const relations = db.prepare(`SELECT relation.relation_type AS relationType,
          parent.entity_type AS fromEntityType, parent.entity_pk AS fromEntityPk,
          child.entity_type AS toEntityType, child.entity_pk AS toEntityPk
        FROM demo_data_relations relation
        JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
        JOIN demo_data_registry child ON child.registry_id = relation.to_registry_id
        WHERE parent.artifact_key = '25-energy-balance-configs'
        ORDER BY relation.relation_id`).all();
      assert.strictEqual(relations.length, balanceItems.length,
        '本次新 boundary 下的每个新 item 必须生成一条 contains relation。');
      assert(relations.every((relation) => relation.relationType === 'contains'
        && relation.fromEntityType === 'energy_balance_boundary'
        && relation.fromEntityPk === String(boundary.id)
        && relation.toEntityType === 'energy_balance_item'),
      'contains relation 必须只连接本 run 本次登记的 boundary/item。');
    }

    const auditOperations = db.prepare(`SELECT operation, user_id AS userId FROM sys_operation_logs
      WHERE user_id = ? ORDER BY id`).all(userId);
    assert(auditOperations.length > 0, `${testCase.label} 必须产生真实 sys_operation_logs 审计。`);
    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], `${testCase.label} 执行后外键检查必须为空。`);
  } finally {
    db.close();
  }
}

/** 按模板中文表头修改 artifact 25 XLSX 的指定数据行，保持真实工作簿结构不变。 */
function setBalanceWorkbookCell(workbook, sheetName, headerName, rowNumber, value) {
  const worksheet = workbook.Sheets[sheetName];
  assert(worksheet, `artifact 25 缺少工作表 ${sheetName}。`);
  const headerRow = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '' })[0] || [];
  const columnIndex = headerRow.findIndex((header) => String(header).trim() === headerName);
  assert(columnIndex >= 0, `artifact 25 工作表 ${sheetName} 缺少列 ${headerName}。`);
  const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: rowNumber });
  worksheet[cellAddress] = { t: 's', v: String(value) };
}

/** 从 managed 下载的真实 artifact 25 工作簿构造受控边界事实变体。 */
function createBalanceWorkbookVariant(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const boundaryCode = options.boundaryCode || 'QL-BAL-PARK';
  const boundaryVersion = options.boundaryVersion || 'QL-BAL:v1';
  const boundaryStatus = options.boundaryStatus || 'active';
  setBalanceWorkbookCell(workbook, '平衡边界', '边界编码', 1, boundaryCode);
  setBalanceWorkbookCell(workbook, '平衡边界', '版本', 1, boundaryVersion);
  setBalanceWorkbookCell(workbook, '平衡边界', '状态', 1, boundaryStatus);
  if (options.effectiveStartUtc !== undefined) {
    setBalanceWorkbookCell(workbook, '平衡边界', '生效开始时间（UTC）', 1, options.effectiveStartUtc);
  }
  if (options.effectiveEndUtc !== undefined) {
    setBalanceWorkbookCell(workbook, '平衡边界', '生效结束时间（UTC）', 1, options.effectiveEndUtc);
  }
  const itemWorksheet = workbook.Sheets['九角色项目'];
  const itemRows = XLSX.utils.sheet_to_json(itemWorksheet, { header: 1, raw: false, defval: '' });
  for (let rowNumber = 1; rowNumber < itemRows.length; rowNumber += 1) {
    setBalanceWorkbookCell(workbook, '九角色项目', '边界编码', rowNumber, boundaryCode);
    setBalanceWorkbookCell(workbook, '九角色项目', '边界版本', rowNumber, boundaryVersion);
    if (options.itemStatus !== undefined) {
      setBalanceWorkbookCell(workbook, '九角色项目', '状态', rowNumber, options.itemStatus);
    }
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 通过真实 managed 下载为 artifact 25 变体签发 context 并完成 HTTP preview。 */
async function previewBalanceVariant(server, token, suffix, variantBuffer, sourceDownloadResponse = null) {
  const artifactKey = '25-energy-balance-configs';
  const downloadResponse = sourceDownloadResponse || await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(downloadResponse.status, 200, `artifact 25 ${suffix} 下载失败：${downloadResponse.text}`);
  const issuedToken = String(downloadResponse.headers['x-demo-context'] || '');
  assert(/^[A-Za-z0-9_-]{43}$/.test(issuedToken), `artifact 25 ${suffix} 必须返回一次性 context。`);
  const issued = readContextStateByToken(issuedToken);
  assert.strictEqual(issued.context.status, 'issued', `artifact 25 ${suffix} context 初始状态异常。`);
  const previewResponse = await requestMultipart(
    server,
    '/api/energy-balance-imports/bundle/preview',
    token,
    issuedToken,
    `25-energy-balance-configs-${suffix}.xlsx`,
    variantBuffer
  );
  assert.strictEqual(previewResponse.status, 200, `artifact 25 ${suffix} preview 失败：${previewResponse.text}`);
  return {
    downloadResponse,
    issuedToken,
    issued,
    preview: previewResponse.body.data,
    variantBuffer
  };
}

/** 校验 artifact 25 两个角色审计中持久化的 candidate/source witness、文件摘要和 preview 摘要。 */
function assertBalanceAuditWitness(preview, variantBuffer, label) {
  const boundaryAudit = getImportAuditBatchDetail(preview.boundaryBatchId, { includeIssues: false });
  const itemAudit = getImportAuditBatchDetail(preview.itemBatchId, { includeIssues: false });
  const expectedFileSha256 = sha256Buffer(variantBuffer);
  [boundaryAudit, itemAudit].forEach((audit) => {
    assert.strictEqual(audit.fileSha256, expectedFileSha256, `${label} 审计批次必须保存实际上传文件 SHA。`);
    assert.strictEqual(audit.previewAuditDigest, preview.previewAuditDigest, `${label} 双批次必须共享 previewAuditDigest。`);
    assert.deepStrictEqual(audit.auditContext.combinedCandidateRows, preview.candidateRows,
      `${label} 审计必须持久化完整 combined candidate rows。`);
    assert.deepStrictEqual(audit.auditContext.combinedCandidateRowIds, preview.candidateRowIds,
      `${label} 审计必须持久化完整 candidate row IDs。`);
    assert.deepStrictEqual(audit.auditContext.previewAudit, preview.previewAudit,
      `${label} 审计必须持久化完整 preview audit。`);
  });
  assert.deepStrictEqual(boundaryAudit.auditContext.candidateRows, preview.boundaryPreview.candidateRows,
    `${label} boundary 批次必须持久化 boundary candidate rows。`);
  assert.deepStrictEqual(itemAudit.auditContext.candidateRows, preview.itemPreview.candidateRows,
    `${label} item 批次必须持久化 item candidate/source witness。`);
  return { boundaryAudit, itemAudit };
}

/** 校验 artifact 25 imported registry 与固定 ownership/cleanup projection 使用同一 snapshot digest。 */
function assertBalanceRegistryProjection(db, registryRows, label) {
  assert(registryRows.length > 0, `${label} 必须存在 imported ownership registry。`);
  registryRows.forEach((registryRow) => {
    assert(/^[a-f0-9]{64}$/.test(registryRow.identityDigest));
    assert(/^[a-f0-9]{64}$/.test(registryRow.snapshotDigest));
    assert.strictEqual(registryRow.identityDigest,
      calculateDemoEntityIdentityDigest(registryRow.entityType, registryRow.entityPk));
    const projection = registryRow.entityType === 'energy_balance_boundary'
      ? db.prepare(`SELECT id, source_batch_id, source_row_number, boundary_code,
          boundary_name, organization_unit_id, source, document_no, version, effective_start_utc,
          effective_end_utc, source_timezone, generation_boundary_confirmed, status, created_at, updated_at
        FROM energy_balance_boundaries WHERE id = ?`).get(Number(registryRow.entityPk))
      : db.prepare(`SELECT id, source_batch_id, source_row_number, energy_balance_boundary_id,
          item_code, item_name, role, energy_type_id, original_unit, source_type, source_mapping_json,
          generation_anti_double_count_key, status, created_at, updated_at
        FROM energy_balance_items WHERE id = ?`).get(Number(registryRow.entityPk));
    assert(projection, `${label} registry 必须指向真实业务 projection。`);
    assert.strictEqual(registryRow.snapshotDigest,
      calculateDemoEntitySnapshotDigest(registryRow.entityType, registryRow.entityPk, projection));
  });
  // artifact 25 当前仍未接入可删除 cleanup handler；验证 cleanup plan 仍以相同 registry snapshot 作为 fail-closed 预期。
  const cleanupPlan = buildDemoOwnershipPlan(db, registryRows[0].runId);
  registryRows.forEach((registryRow) => {
    const blocker = cleanupPlan.blockers.find((candidate) => Number(candidate.registryId) === Number(registryRow.registryId));
    assert(blocker, `${label} cleanup plan 必须保留 artifact 25 registry blocker。`);
    assert.strictEqual(blocker.code, 'CLEANUP_HANDLER_NOT_WHITELISTED',
      `${label} artifact 25 cleanup 必须保持 handler 白名单 fail-closed。`);
    assert.strictEqual(blocker.expectedSnapshotDigest, registryRow.snapshotDigest,
      `${label} cleanup blocker 必须复用 registry snapshot digest。`);
  });
}

/** 读取 artifact 25 业务、ownership 和 relation 全量快照及计数，排除 preview 审计表。 */
function readBalanceDatabaseSnapshot() {
  const db = openDatabase();
  try {
    const boundaries = db.prepare('SELECT * FROM energy_balance_boundaries ORDER BY id').all();
    const items = db.prepare('SELECT * FROM energy_balance_items ORDER BY id').all();
    const registry = db.prepare('SELECT * FROM demo_data_registry ORDER BY registry_id').all();
    const relations = db.prepare('SELECT * FROM demo_data_relations ORDER BY relation_id').all();
    return {
      counts: {
        boundary: boundaries.length,
        item: items.length,
        registry: registry.length,
        relation: relations.length
      },
      boundaries,
      items,
      registry,
      relations
    };
  } finally {
    db.close();
  }
}

/** 安装只针对本次唯一业务身份的 SQLite 触发器，禁止 inactive 事实先写 active 再更新。 */
function installInactiveDirectInsertGuards() {
  const db = openDatabase();
  try {
    db.exec(`CREATE TRIGGER test_balance_boundary_no_active_insert
      BEFORE INSERT ON energy_balance_boundaries
      FOR EACH ROW WHEN NEW.boundary_code = 'QL-BAL-INACTIVE-20260827'
        AND NEW.version = 'QL-BAL:inactive:v1' AND NEW.status = 'active'
      BEGIN SELECT RAISE(ABORT, 'inactive demo boundary inserted active'); END;
      CREATE TRIGGER test_balance_boundary_no_status_update
      BEFORE UPDATE OF status ON energy_balance_boundaries
      FOR EACH ROW WHEN OLD.boundary_code = 'QL-BAL-INACTIVE-20260827'
        AND OLD.version = 'QL-BAL:inactive:v1'
      BEGIN SELECT RAISE(ABORT, 'inactive demo boundary status updated'); END;
      CREATE TRIGGER test_balance_item_no_active_insert
      BEFORE INSERT ON energy_balance_items
      FOR EACH ROW WHEN NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM energy_balance_boundaries AS boundary
        WHERE boundary.id = NEW.energy_balance_boundary_id
          AND boundary.boundary_code = 'QL-BAL-INACTIVE-20260827'
          AND boundary.version = 'QL-BAL:inactive:v1'
      )
      BEGIN SELECT RAISE(ABORT, 'inactive demo item inserted active'); END;
      CREATE TRIGGER test_balance_item_no_status_update
      BEFORE UPDATE OF status ON energy_balance_items
      FOR EACH ROW WHEN EXISTS (
        SELECT 1 FROM energy_balance_boundaries AS boundary
        WHERE boundary.id = OLD.energy_balance_boundary_id
          AND boundary.boundary_code = 'QL-BAL-INACTIVE-20260827'
          AND boundary.version = 'QL-BAL:inactive:v1'
      )
      BEGIN SELECT RAISE(ABORT, 'inactive demo item status updated'); END`);
  } finally {
    db.close();
  }
}

/** 移除 inactive 直接最终状态写入专项触发器。 */
function removeInactiveDirectInsertGuards() {
  const db = openDatabase();
  try {
    db.exec(`DROP TRIGGER IF EXISTS test_balance_boundary_no_active_insert;
      DROP TRIGGER IF EXISTS test_balance_boundary_no_status_update;
      DROP TRIGGER IF EXISTS test_balance_item_no_active_insert;
      DROP TRIGGER IF EXISTS test_balance_item_no_status_update`);
  } finally {
    db.close();
  }
}

/** 验证 artifact 25 demo inactive 双角色在同一 ownership 事务中直接写入最终 inactive 状态。 */
async function assertArtifact25InactiveOwnership(server, token, userId) {
  const download = await request(server, 'GET', '/api/templates/demo-park/25-energy-balance-configs.xlsx', { token });
  assert.strictEqual(download.status, 200, `artifact 25 inactive 下载失败：${download.text}`);
  const inactiveBuffer = createBalanceWorkbookVariant(download.buffer, {
    boundaryCode: 'QL-BAL-INACTIVE-20260827',
    boundaryVersion: 'QL-BAL:inactive:v1',
    boundaryStatus: 'inactive',
    itemStatus: 'inactive'
  });
  const lifecycle = await previewBalanceVariant(server, token, 'inactive', inactiveBuffer, download);
  const { preview } = lifecycle;
  assert.strictEqual(Number(preview.expectedWouldImport), 4, 'artifact 25 inactive preview 必须产生 1 条 boundary 和 3 条 item 候选。');
  assert.strictEqual(preview.boundaryPreview.candidateRows.length, 1);
  assert.strictEqual(preview.boundaryPreview.candidateRows[0].status, 'inactive');
  assert.strictEqual(preview.itemPreview.candidateRows.length, 3);
  assert(preview.itemPreview.candidateRows.every((candidate) => candidate.status === 'inactive'));
  const { boundaryAudit, itemAudit } = assertBalanceAuditWitness(preview, inactiveBuffer, 'artifact 25 inactive');
  const issuedState = readContextState(lifecycle.issued.contextId);
  assert.strictEqual(issuedState.context.artifactFileSha256, sha256Buffer(download.buffer));
  assert.strictEqual(issuedState.context.uploadFileSha256, sha256Buffer(inactiveBuffer));
  assert.strictEqual(issuedState.context.previewDigest, preview.previewAuditDigest);
  const contextId = lifecycle.issued.contextId;
  installInactiveDirectInsertGuards();
  let executeResponse;
  try {
    executeResponse = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
      token,
      headers: { 'X-Demo-Context': lifecycle.issuedToken },
      body: buildExecuteBody({ artifactKey: '25-energy-balance-configs' }, preview)
    });
  } finally {
    removeInactiveDirectInsertGuards();
  }
  assert.strictEqual(executeResponse.status, 200, `artifact 25 inactive execute 失败：${executeResponse.text}`);
  const result = executeResponse.body.data;
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.imported, 4);
  assert.strictEqual(result.writesBusinessRecords, true);
  assert.strictEqual(result.boundary.previewAuditDigest, preview.previewAuditDigest);
  assert.strictEqual(result.item.previewAuditDigest, preview.previewAuditDigest);
  assert.strictEqual(result.boundary.ownership.registrationCount, 4);
  assert.strictEqual(result.boundary.ownership.insertedCount, 4);
  assert.strictEqual(result.boundary.ownership.skippedCount, 0);
  assert.strictEqual(result.boundary.ownership.relationCount, 3);
  const db = openDatabase();
  try {
    const boundary = db.prepare(`SELECT id, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
        boundary_code AS boundaryCode, version, status, effective_start_utc AS effectiveStartUtc,
        effective_end_utc AS effectiveEndUtc, created_at AS createdAt, updated_at AS updatedAt
      FROM energy_balance_boundaries WHERE boundary_code = 'QL-BAL-INACTIVE-20260827' AND version = 'QL-BAL:inactive:v1'`).get();
    assert(boundary, 'artifact 25 inactive 必须写入目标 boundary。');
    assert.strictEqual(boundary.status, 'inactive', 'artifact 25 inactive boundary 必须从 INSERT 起就是 inactive。');
    assert.strictEqual(Number(boundary.sourceBatchId), Number(preview.boundaryBatchId));
    assert(Number(boundary.sourceRowNumber) > 0);
    const items = db.prepare(`SELECT id, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
        energy_balance_boundary_id AS boundaryId, status, created_at AS createdAt, updated_at AS updatedAt
      FROM energy_balance_items WHERE energy_balance_boundary_id = ? ORDER BY id`).all(boundary.id);
    assert.strictEqual(items.length, 3);
    assert(items.every((item) => item.status === 'inactive'));
    assert(items.every((item) => Number(item.sourceBatchId) === Number(preview.itemBatchId)
      && Number(item.sourceRowNumber) > 0));
    const registryRows = db.prepare(`SELECT registry_id AS registryId, run_id AS runId, entity_type AS entityType,
        entity_pk AS entityPk, ownership_kind AS ownershipKind, identity_digest AS identityDigest,
        snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
        registered_by AS registeredBy
      FROM demo_data_registry WHERE artifact_key = '25-energy-balance-configs'
        AND source_batch_id IN (?, ?) ORDER BY registry_id`).all(preview.boundaryBatchId, preview.itemBatchId);
    assert.strictEqual(registryRows.length, 4);
    assert(registryRows.every((row) => row.ownershipKind === 'imported' && Number(row.registeredBy) === Number(userId)));
    assertBalanceRegistryProjection(db, registryRows, 'artifact 25 inactive');
    const relations = db.prepare(`SELECT relation_id FROM demo_data_relations
      WHERE from_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE source_batch_id = ?)
        AND to_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE source_batch_id = ?)`).all(
      preview.boundaryBatchId, preview.itemBatchId);
    assert.strictEqual(relations.length, 3);
    const executedBoundaryAudit = getImportAuditBatchDetail(preview.boundaryBatchId, { includeIssues: false });
    const executedItemAudit = getImportAuditBatchDetail(preview.itemBatchId, { includeIssues: false });
    assert.strictEqual(executedBoundaryAudit.fileSha256, sha256Buffer(inactiveBuffer));
    assert.strictEqual(executedItemAudit.fileSha256, sha256Buffer(inactiveBuffer));
    assert.deepStrictEqual(executedBoundaryAudit.executeResult.candidateRowIds, preview.boundaryPreview.candidateRows.map((row) => row.candidateRowId));
    assert.deepStrictEqual(executedItemAudit.executeResult.candidateRowIds, preview.itemPreview.candidateRows.map((row) => row.candidateRowId));
    assert.strictEqual(executedBoundaryAudit.executeResult.previewAuditDigest, preview.previewAuditDigest);
    assert.strictEqual(executedItemAudit.executeResult.previewAuditDigest, preview.previewAuditDigest);
  } finally {
    db.close();
  }
  assert.strictEqual(readContextState(contextId).context.status, 'executed');
  assert.strictEqual(Number(userId) > 0, true);
  assert(boundaryAudit.auditContext.candidateRows.length === 1);
  assert(itemAudit.auditContext.candidateRows.every((candidate) => candidate.status === 'inactive'));
}

/** 验证 artifact 25 合法秒精度 baseline、重复 skip 与非法非零毫秒精度的明确阻断。 */
async function assertArtifact25NonZeroMilliseconds(server, token) {
  const artifactKey = '25-energy-balance-configs';
  const baseDownload = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(baseDownload.status, 200, `artifact 25 precision 下载失败：${baseDownload.text}`);
  const baselineBuffer = createBalanceWorkbookVariant(baseDownload.buffer, {
    boundaryCode: 'QL-BAL-SECOND-20260827',
    boundaryVersion: 'QL-BAL:second:v1',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z'
  });
  const first = await previewBalanceVariant(server, token, 'second-first', baselineBuffer, baseDownload);
  const firstPreview = first.preview;
  assert.strictEqual(Number(firstPreview.expectedWouldImport), 4,
    '合法秒精度 baseline 必须保留 1 条 boundary 和 3 条 item 候选。');
  assert.strictEqual(firstPreview.boundaryPreview.candidateRows[0].input.effectiveStartUtc, '2026-01-01T00:00:00Z');
  assert.strictEqual(firstPreview.boundaryPreview.candidateRows[0].input.effectiveEndUtc, '2027-01-01T00:00:00Z');
  const firstAudits = assertBalanceAuditWitness(firstPreview, baselineBuffer, 'artifact 25 合法秒精度首次');
  const firstExecute = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': first.issuedToken },
    body: buildExecuteBody({ artifactKey }, firstPreview)
  });
  assert.strictEqual(firstExecute.status, 200, `artifact 25 合法秒精度首次 execute 失败：${firstExecute.text}`);
  assert.strictEqual(firstExecute.body.data.imported, 4);
  assert.strictEqual(firstExecute.body.data.boundary.ownership.registrationCount, 4);
  assert.strictEqual(firstExecute.body.data.boundary.previewAuditDigest, firstPreview.previewAuditDigest);
  const firstDb = openDatabase();
  let baselineBoundary;
  let firstRegistryRows;
  try {
    baselineBoundary = firstDb.prepare(`SELECT id, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
        boundary_code AS boundaryCode, version, effective_start_utc AS effectiveStartUtc,
        effective_end_utc AS effectiveEndUtc, status, created_at AS createdAt, updated_at AS updatedAt
      FROM energy_balance_boundaries WHERE boundary_code = 'QL-BAL-SECOND-20260827'
        AND version = 'QL-BAL:second:v1'`).get();
    assert(baselineBoundary);
    assert.strictEqual(normalizeUserVisibleStrictUtcInput(baselineBoundary.effectiveStartUtc), '2026-01-01T00:00:00Z');
    assert.strictEqual(normalizeUserVisibleStrictUtcInput(baselineBoundary.effectiveEndUtc), '2027-01-01T00:00:00Z');
    assert.strictEqual(Number(baselineBoundary.sourceBatchId), Number(firstPreview.boundaryBatchId));
    assert(Number(baselineBoundary.sourceRowNumber) > 0);
    firstRegistryRows = firstDb.prepare(`SELECT registry_id AS registryId, run_id AS runId, entity_type AS entityType,
        entity_pk AS entityPk, ownership_kind AS ownershipKind, identity_digest AS identityDigest,
        snapshot_digest AS snapshotDigest, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
        registered_by AS registeredBy
      FROM demo_data_registry WHERE artifact_key = ? AND source_batch_id IN (?, ?) ORDER BY registry_id`).all(
      artifactKey, firstPreview.boundaryBatchId, firstPreview.itemBatchId);
    assert.strictEqual(firstRegistryRows.length, 4);
    assertBalanceRegistryProjection(firstDb, firstRegistryRows, 'artifact 25 合法秒精度首次');
    const firstExecutedBoundaryAudit = getImportAuditBatchDetail(firstPreview.boundaryBatchId, { includeIssues: false });
    const firstExecutedItemAudit = getImportAuditBatchDetail(firstPreview.itemBatchId, { includeIssues: false });
    assert.strictEqual(firstExecutedBoundaryAudit.fileSha256, sha256Buffer(baselineBuffer));
    assert.strictEqual(firstExecutedItemAudit.fileSha256, sha256Buffer(baselineBuffer));
    assert.strictEqual(firstExecutedBoundaryAudit.previewAuditDigest, firstPreview.previewAuditDigest);
    assert.strictEqual(firstExecutedItemAudit.previewAuditDigest, firstPreview.previewAuditDigest);
    assert.deepStrictEqual(firstExecutedBoundaryAudit.executeResult.combinedCandidateRowIds, firstPreview.candidateRowIds);
    assert.deepStrictEqual(firstExecutedItemAudit.executeResult.combinedCandidateRowIds, firstPreview.candidateRowIds);
  } finally {
    firstDb.close();
  }
  assert.deepStrictEqual(firstAudits.itemAudit.auditContext.candidateRows, firstPreview.itemPreview.candidateRows);
  assert.strictEqual(readContextState(first.issued.contextId).context.status, 'executed');

  const duplicate = await previewBalanceVariant(server, token, 'second-duplicate', baselineBuffer);
  const duplicatePreview = duplicate.preview;
  assert.strictEqual(Number(duplicatePreview.expectedWouldImport), 0);
  assert.strictEqual(Number(duplicatePreview.boundaryPreview.summary.skipped), 1);
  assert.strictEqual(Number(duplicatePreview.itemPreview.summary.skipped), 3);
  assert(duplicatePreview.boundaryPreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_ENERGY_BALANCE_BOUNDARY_SKIPPED'));
  assert(duplicatePreview.itemPreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_ENERGY_BALANCE_ITEM_SKIPPED'));
  const duplicateExecute = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': duplicate.issuedToken },
    body: buildExecuteBody({ artifactKey }, duplicatePreview)
  });
  assert.strictEqual(duplicateExecute.status, 200, `artifact 25 合法秒精度 duplicate execute 失败：${duplicateExecute.text}`);
  assert.strictEqual(duplicateExecute.body.data.imported, 0);
  assert.strictEqual(duplicateExecute.body.data.writesBusinessRecords, false);
  assert.strictEqual(duplicateExecute.body.data.boundary.ownership.noInsertedRecords, true);
  assert.strictEqual(duplicateExecute.body.data.boundary.ownership.registrationCount, 0);
  assert.strictEqual(duplicateExecute.body.data.boundary.ownership.skippedCount, 4);
  assert.strictEqual(readContextState(duplicate.issued.contextId).context.status, 'executed');

  const databaseSnapshotBeforeInvalid = readBalanceDatabaseSnapshot();
  const invalidPrecisionBuffer = createBalanceWorkbookVariant(baseDownload.buffer, {
    boundaryCode: 'QL-BAL-MILLISECOND-20260827',
    boundaryVersion: 'QL-BAL:millisecond:v1',
    effectiveStartUtc: '2026-01-01T00:00:00.123Z',
    effectiveEndUtc: '2027-01-01T00:00:00.456Z'
  });
  const invalidPrecision = await previewBalanceVariant(server, token, 'millisecond-invalid', invalidPrecisionBuffer);
  const invalidPreview = invalidPrecision.preview;
  assert.strictEqual(Number(invalidPreview.expectedWouldImport), 0);
  assert.strictEqual(Number(invalidPreview.summary.wouldImport), 0);
  assert.strictEqual(Number(invalidPreview.summary.blocked), 4);
  assert.deepStrictEqual(invalidPreview.candidateRows, []);
  assert.deepStrictEqual(invalidPreview.boundaryPreview.candidateRows, []);
  assert.deepStrictEqual(invalidPreview.itemPreview.candidateRows, []);
  assert.strictEqual(Number(invalidPreview.boundaryPreview.summary.blocked), 1);
  assert.strictEqual(Number(invalidPreview.itemPreview.summary.blocked), 3);
  const invalidIssueCodes = new Set(invalidPreview.auditIssues.map((issue) => issue.code));
  assert(invalidIssueCodes.has('STRICT_UTC_INPUT_PRECISION_INVALID'));
  assert.strictEqual(invalidIssueCodes.has('INVALID_TEMPLATE_CELL_TYPE'), false, '非零毫秒必须投影明确 UTC 精度错误。');
  assert(invalidIssueCodes.has('ENERGY_BALANCE_IMPORT_REQUIRED_FIELD_MISSING'));
  assert(invalidIssueCodes.has('ENERGY_BALANCE_IMPORT_BOUNDARY_NOT_FOUND'));
  assert.throws(
    () => normalizeUserVisibleStrictUtcInput('2026-01-01T00:00:00.123Z'),
    (error) => error?.code === 'STRICT_UTC_INPUT_PRECISION_INVALID'
  );
  const invalidState = readContextState(invalidPrecision.issued.contextId);
  assert.strictEqual(invalidState.context.status, 'previewed');
  assert.strictEqual(invalidState.context.executedAt, null);
  const invalidBatchIds = [invalidPreview.boundaryBatchId, invalidPreview.itemBatchId];
  const invalidAuditsBeforeExecute = invalidBatchIds.map((batchId) => getImportAuditBatchDetail(batchId, { includeIssues: false }));
  invalidAuditsBeforeExecute.forEach((audit) => {
    assert.strictEqual(audit.status, 'completed_with_errors');
    assert.strictEqual(audit.auditPhase, 'preview');
    assert.strictEqual(audit.executeResult, null);
  });
  const invalidExecute = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': invalidPrecision.issuedToken },
    body: buildExecuteBody({ artifactKey }, invalidPreview)
  });
  assert.strictEqual(invalidExecute.status, 400, `artifact 25 非零毫秒 blocked preview execute 必须返回 400：${invalidExecute.text}`);
  assert.strictEqual(invalidExecute.body?.error?.code, 'BAD_REQUEST');
  assert.strictEqual(invalidExecute.body?.error?.details?.code, 'ENERGY_BALANCE_IMPORT_BLOCKED_PREVIEW_REJECTED');
  assert.strictEqual(Number(invalidExecute.body?.error?.details?.blocked), 4);
  const invalidStateAfterExecute = readContextState(invalidPrecision.issued.contextId);
  assert.strictEqual(invalidStateAfterExecute.context.status, 'previewed',
    'blocked preview execute 被拒绝后不得消费中央 context。');
  assert.strictEqual(invalidStateAfterExecute.context.executedAt, null);
  const invalidAuditsAfterExecute = invalidBatchIds.map((batchId) => getImportAuditBatchDetail(batchId, { includeIssues: false }));
  assert.deepStrictEqual(invalidAuditsAfterExecute, invalidAuditsBeforeExecute,
    'blocked preview execute 被拒绝后两个批次必须完整保持 preview 审计状态。');
  const databaseSnapshotAfterInvalid = readBalanceDatabaseSnapshot();
  assert.deepStrictEqual(databaseSnapshotAfterInvalid.counts, databaseSnapshotBeforeInvalid.counts,
    '非法精度 preview/execute 拒绝不得改变 boundary/item/registry/relation 计数。');
  assert.deepStrictEqual(databaseSnapshotAfterInvalid, databaseSnapshotBeforeInvalid,
    '非法精度 preview/execute 拒绝不得改变 boundary/item/registry/relation 业务快照。');
}

/** 验证 artifact 24 record-only 引用未 owned 正式 edge 时 fail-closed，不接管 edge 或留下孤立 ownership。 */
async function assertArtifact24RecordOnlyAgainstFormalEdge(server, token, userId) {
  const artifactKey = '24-energy-flow-edges';
  const fixtureDb = openDatabase();
  let formalEdgeId;
  try {
    fixtureDb.transaction(() => {
      const edge = fixtureDb.prepare(`SELECT id FROM energy_flow_edges
        WHERE edge_code = 'QL-EDGE-GRID-WSA'`).get();
      assert(edge, 'artifact 24 首次 execute 必须先写入可转换为正式对照的 edge。');
      formalEdgeId = Number(edge.id);
      fixtureDb.prepare(`DELETE FROM demo_data_relations
        WHERE from_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE artifact_key = ?)
          OR to_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE artifact_key = ?)`).run(artifactKey, artifactKey);
      fixtureDb.prepare('DELETE FROM demo_data_registry WHERE artifact_key = ?').run(artifactKey);
      fixtureDb.prepare(`UPDATE energy_flow_edges
        SET source_batch_id = NULL, source_row_number = NULL WHERE id = ?`).run(formalEdgeId);
      const removed = fixtureDb.prepare(`DELETE FROM energy_flow_records
        WHERE energy_flow_edge_id = ? AND source_type = 'explicit_edge_value'`).run(formalEdgeId);
      assert.strictEqual(removed.changes, 1, '正式 edge 对照必须移除原显式边值以形成 record-only candidate。');
    })();
  } finally {
    fixtureDb.close();
  }

  const download = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(download.status, 200, `artifact 24 record-only 下载失败：${download.text}`);
  const contextToken = String(download.headers['x-demo-context'] || '');
  assert(/^[A-Za-z0-9_-]{43}$/.test(contextToken), 'artifact 24 record-only 下载必须返回一次性 context。');
  const issued = readContextStateByToken(contextToken);
  assert.strictEqual(issued.context.status, 'issued', 'artifact 24 record-only context 必须从 issued 开始。');
  const previewResponse = await requestMultipart(
    server,
    '/api/energy-flow-imports/bundle/preview',
    token,
    contextToken,
    `${artifactKey}-record-only.xlsx`,
    download.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `artifact 24 record-only preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert.strictEqual(Number(preview.expectedWouldImport), 1);
  assert.strictEqual(Number(preview.edgePreview.summary.skipped), 1, '既有正式 edge 必须稳定判定为 skipped。');
  assert.strictEqual(preview.edgePreview.candidateRows.length, 0);
  assert.strictEqual(preview.recordPreview.candidateRows.length, 1);
  assert.strictEqual(Number(preview.recordPreview.summary.skipped), 0);
  const previewedState = readContextState(issued.contextId);
  assert.strictEqual(previewedState.context.status, 'previewed');
  assert.deepStrictEqual(previewedState.bindings.map((binding) => binding.batchRole).sort(), ['edge', 'record']);
  assert.deepStrictEqual(
    previewedState.bindings.map((binding) => Number(binding.batchId)).sort((left, right) => left - right),
    [Number(preview.edgeBatchId), Number(preview.recordBatchId)].sort((left, right) => left - right)
  );

  const beforeExecuteDb = openDatabase();
  let beforeExecute;
  try {
    beforeExecute = {
      records: Number(beforeExecuteDb.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total),
      registry: Number(beforeExecuteDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total),
      relations: Number(beforeExecuteDb.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total)
    };
  } finally {
    beforeExecuteDb.close();
  }

  const execute = await request(server, 'POST', '/api/energy-flow-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': contextToken },
    body: buildExecuteBody({ artifactKey }, preview)
  });
  assert.strictEqual(execute.status, 400, `artifact 24 record-only 必须 fail-closed：${execute.text}`);
  assert.strictEqual(execute.body?.success, false);
  assert.strictEqual(execute.body?.error?.code, 'BAD_REQUEST');
  assert.strictEqual(
    execute.body?.error?.details?.code,
    'ENERGY_FLOW_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED',
    '未 owned 正式 edge 必须返回稳定 ownership endpoint 错误码。'
  );

  const failedState = readContextState(issued.contextId);
  assert.strictEqual(failedState.context.status, 'previewed', 'ownership 端点失败不得消费 context。');
  assert.strictEqual(failedState.context.executedAt, null);
  assert.deepStrictEqual(failedState.bindings.map((binding) => binding.batchRole).sort(), ['edge', 'record']);
  const edgeAudit = getImportAuditBatchDetail(preview.edgeBatchId, { includeIssues: false });
  const recordAudit = getImportAuditBatchDetail(preview.recordBatchId, { includeIssues: false });
  [edgeAudit, recordAudit].forEach((audit) => {
    assert.strictEqual(audit.status, 'failed');
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.successCount, 0);
    assert.strictEqual(audit.executeResult.executed, false);
    assert.strictEqual(audit.executeResult.writesBusinessRecords, false);
    assert.strictEqual(
      audit.executeResult.errorCode,
      'ENERGY_FLOW_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED'
    );
    assert.strictEqual(audit.previewAuditDigest, preview.previewAuditDigest);
  });
  assert.strictEqual(edgeAudit.skippedCount, 1);
  assert.strictEqual(recordAudit.skippedCount, 0);

  const verifyDb = openDatabase();
  try {
    const formalEdge = verifyDb.prepare(`SELECT source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM energy_flow_edges WHERE id = ?`).get(formalEdgeId);
    assert.deepStrictEqual(formalEdge, { sourceBatchId: null, sourceRowNumber: null },
      'record-only 失败不得补写既有正式 edge provenance。');
    assert.deepStrictEqual({
      records: Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total),
      registry: Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total),
      relations: Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total)
    }, beforeExecute, 'ownership 端点失败后业务 record、registry 和 relation 必须整体回滚。');
    assert.strictEqual(verifyDb.prepare(`SELECT COUNT(*) AS total FROM energy_flow_records
      WHERE source_batch_id = ?`).get(preview.recordBatchId).total, 0,
    'record-only 失败不得留下本批次业务 record。');
    assert.strictEqual(verifyDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE artifact_key = ?`).get(artifactKey).total, 0,
    'record-only 失败不得接管正式 edge 或留下 record registry。');
    assert.deepStrictEqual(verifyDb.pragma('foreign_key_check'), []);
  } finally {
    verifyDb.close();
  }
  assert.strictEqual(Number(userId) > 0, true);
}

/** 验证 artifact 24 全部 duplicate skipped 时仍原子完成双 batch link、审计和 context CAS。 */
async function assertArtifact24AllSkipped(server, token) {
  const artifactKey = '24-energy-flow-edges';
  const download = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(download.status, 200, `artifact 24 duplicate 下载失败：${download.text}`);
  const contextToken = String(download.headers['x-demo-context'] || '');
  const issued = readContextStateByToken(contextToken);
  const previewResponse = await requestMultipart(
    server,
    '/api/energy-flow-imports/bundle/preview',
    token,
    contextToken,
    '24-energy-flow-edges-duplicate.xlsx',
    download.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `artifact 24 duplicate preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert.strictEqual(Number(preview.expectedWouldImport), 0);
  assert.strictEqual(Number(preview.edgePreview.summary.skipped), 1);
  assert.strictEqual(Number(preview.recordPreview.summary.skipped), 1);
  const db = openDatabase();
  let before;
  try {
    before = {
      edges: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_edges').get().total),
      records: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total),
      registry: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '24-energy-flow-edges'").get().total),
      relations: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
        WHERE parent.artifact_key = '24-energy-flow-edges'`).get().total)
    };
  } finally {
    db.close();
  }
  const execute = await request(server, 'POST', '/api/energy-flow-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': contextToken },
    body: buildExecuteBody({ artifactKey }, preview)
  });
  assert.strictEqual(execute.status, 200, `artifact 24 duplicate execute 失败：${execute.text}`);
  const result = execute.body.data;
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.writesBusinessRecords, false);
  assert.strictEqual(result.edge.ownership.noInsertedRecords, true);
  assert.strictEqual(result.edge.ownership.registrationCount, 0);
  assert.strictEqual(result.edge.ownership.insertedCount, 0);
  assert.strictEqual(result.edge.ownership.skippedCount, 2);
  assert.strictEqual(result.edge.ownership.relationCount, 0);
  assert(result.edge.ownership.skipped.every((record) => record.registration === 'not_registered'));
  const executedState = readContextState(issued.contextId);
  assert.strictEqual(executedState.context.status, 'executed');
  assert.deepStrictEqual(executedState.bindings.map((binding) => binding.batchRole).sort(), ['edge', 'record']);
  const afterDb = openDatabase();
  try {
    assert.deepStrictEqual({
      edges: Number(afterDb.prepare('SELECT COUNT(*) AS total FROM energy_flow_edges').get().total),
      records: Number(afterDb.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total),
      registry: Number(afterDb.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '24-energy-flow-edges'").get().total),
      relations: Number(afterDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
        WHERE parent.artifact_key = '24-energy-flow-edges'`).get().total)
    }, before);
  } finally {
    afterDb.close();
  }
}

/** 验证 artifact 13 全部 duplicate skipped 时只消费 context，不写班次业务行或 ownership registry。 */
async function assertArtifact13AllSkipped(server, token, userId) {
  const artifactKey = '13-shift-definitions';
  const registration = getDemoArtifactRegistration(artifactKey);
  assert(registration, 'artifact 13 必须存在静态注册。');
  const downloadResponse = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(downloadResponse.status, 200, `artifact 13 duplicate 下载失败：${downloadResponse.text}`);
  const issuedToken = String(downloadResponse.headers['x-demo-context'] || '');
  const issued = readContextStateByToken(issuedToken);
  const previewResponse = await requestMultipart(
    server,
    '/api/energy-analysis/imports/shift-definitions/preview',
    token,
    issuedToken,
    `${artifactKey}-duplicate.xlsx`,
    downloadResponse.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `artifact 13 duplicate preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert.strictEqual(Number(preview.expectedWouldImport), 0);
  assert.strictEqual(Number(preview.summary?.skipped), 2, 'artifact 13 全部既有班次必须稳定判定为 skipped。');
  assert.strictEqual(preview.candidateRows.length, 0);
  const db = openDatabase();
  let before;
  try {
    before = {
      shifts: Number(db.prepare('SELECT COUNT(*) AS total FROM shift_definitions').get().total),
      registry: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '13-shift-definitions'").get().total),
      relations: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE source.artifact_key = '13-shift-definitions' OR target.artifact_key = '13-shift-definitions'`).get().total)
    };
  } finally {
    db.close();
  }
  assert.strictEqual(readContextState(issued.contextId).context.status, 'previewed');
  const executeResponse = await request(server, 'POST', '/api/energy-analysis/imports/shift-definitions/execute', {
    token,
    headers: { 'X-Demo-Context': issuedToken },
    body: buildExecuteBody({ artifactKey }, preview)
  });
  assert.strictEqual(executeResponse.status, 200, `artifact 13 duplicate execute 失败：${executeResponse.text}`);
  const result = executeResponse.body.data;
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.writesBusinessRecords, false);
  assertManagedOwnershipPublicProjection(result.ownership, 'artifact 13 全 skipped');
  assert.strictEqual(result.ownership.applied, true);
  assert.strictEqual(result.ownership.noInsertedRecords, true);
  assert.strictEqual(result.ownership.registrationCount, 0);
  assert.strictEqual(result.ownership.insertedCount, 0);
  assert.strictEqual(result.ownership.idempotentCount, 0);
  assert.strictEqual(result.ownership.skippedCount, 2);
  assert.strictEqual(result.ownership.relationCount, 0);
  assert.strictEqual(readContextState(issued.contextId).context.status, 'executed');
  const verifyDb = openDatabase();
  try {
    assert.deepStrictEqual({
      shifts: Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM shift_definitions').get().total),
      registry: Number(verifyDb.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '13-shift-definitions'").get().total),
      relations: Number(verifyDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE source.artifact_key = '13-shift-definitions' OR target.artifact_key = '13-shift-definitions'`).get().total)
    }, before, 'artifact 13 全 skipped execute 不得新增班次、registry 或 relation。');
    const audit = getImportAuditBatchDetail(preview.batchId, { includeIssues: false });
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.successCount, 0);
    assert.strictEqual(audit.skippedCount, 2);
    assert.strictEqual(audit.executeResult.executed, true);
  } finally {
    verifyDb.close();
  }
  assert.strictEqual(registration.artifactKey, artifactKey);
  assert.strictEqual(Number(userId) > 0, true);
}

/** 验证 artifact 15/18 全部 duplicate skipped 时不创建虚假业务实体或 ownership。 */
async function assertManagedAnalysisAllSkipped(server, token, artifactKey, expectedSkipped) {
  const testCase = TEST_CASES.find((candidate) => candidate.artifactKey === artifactKey);
  assert(testCase, `${artifactKey} 必须存在中央 context 测试定义。`);
  assert(['energy_timeseries_records', 'strategy_rules'].includes(testCase.expectedBusinessTable),
    `${artifactKey} 必须绑定固定业务表。`);
  const downloadResponse = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(downloadResponse.status, 200, `${artifactKey} duplicate 下载失败：${downloadResponse.text}`);
  const issuedToken = String(downloadResponse.headers['x-demo-context'] || '');
  const issued = readContextStateByToken(issuedToken);
  const previewResponse = await requestMultipart(
    server,
    testCase.previewPath,
    token,
    issuedToken,
    `${artifactKey}-duplicate.xlsx`,
    downloadResponse.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `${artifactKey} duplicate preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert.strictEqual(Number(preview.expectedWouldImport), 0);
  assert.strictEqual(Number(preview.summary?.skipped), expectedSkipped);
  assert.deepStrictEqual(preview.candidateRows, [], `${artifactKey} duplicate 不得产生候选业务行。`);

  const db = openDatabase();
  let before;
  try {
    before = {
      business: Number(db.prepare(`SELECT COUNT(*) AS total FROM ${testCase.expectedBusinessTable}`).get().total),
      registry: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = ?').get(artifactKey).total),
      relations: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(artifactKey, artifactKey).total)
    };
  } finally {
    db.close();
  }

  const executeResponse = await request(server, 'POST', testCase.executePath, {
    token,
    headers: { 'X-Demo-Context': issuedToken },
    body: buildExecuteBody(testCase, preview)
  });
  assert.strictEqual(executeResponse.status, 200, `${artifactKey} duplicate execute 失败：${executeResponse.text}`);
  const result = executeResponse.body.data;
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.writesBusinessRecords, false);
  assertManagedOwnershipPublicProjection(result.ownership, `${artifactKey} 全 skipped`);
  assert.strictEqual(result.ownership.applied, true);
  assert.strictEqual(result.ownership.noInsertedRecords, true);
  assert.strictEqual(result.ownership.registrationCount, 0);
  assert.strictEqual(result.ownership.insertedCount, 0);
  assert.strictEqual(result.ownership.idempotentCount, 0);
  assert.strictEqual(result.ownership.skippedCount, expectedSkipped);
  assert.strictEqual(result.ownership.relationCount, before.relations,
    `${artifactKey} 全 skipped 重试必须幂等返回既有完整策略输入闭包。`);
  assert.strictEqual(JSON.stringify(result.ownership).includes('rowWitness'), false,
    `${artifactKey} duplicate ownership 公共结果不得泄漏 row witness。`);
  assert.strictEqual(readContextState(issued.contextId).context.status, 'executed');

  const verifyDb = openDatabase();
  try {
    const after = {
      business: Number(verifyDb.prepare(`SELECT COUNT(*) AS total FROM ${testCase.expectedBusinessTable}`).get().total),
      registry: Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = ?').get(artifactKey).total),
      relations: Number(verifyDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(artifactKey, artifactKey).total)
    };
    assert(before.registry > 0, `${artifactKey} 全 skipped execute 前必须存在真实 ownership registry。`);
    assert.deepStrictEqual(after, before, `${artifactKey} duplicate execute 不得新增业务行、ownership registry 或 relation。`);
    const audit = getImportAuditBatchDetail(preview.batchId, { includeIssues: false });
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.successCount, 0);
    assert.strictEqual(audit.skippedCount, expectedSkipped);
    assert.strictEqual(audit.executeResult.executed, true);
    assertManagedOwnershipPublicProjection(audit.executeResult.ownership, `${artifactKey} 全 skipped 审计`);
  } finally {
    verifyDb.close();
  }
}

/** 验证 artifact 19 全部 duplicate skipped 时只消费 context，不写业务行或 ownership registry。 */
async function assertArtifact19AllSkipped(server, token, userId) {
  const registration = getDemoArtifactRegistration('19-conversion-factors');
  const downloadResponse = await request(server, 'GET', '/api/templates/demo-park/19-conversion-factors.xlsx', { token });
  assert.strictEqual(downloadResponse.status, 200, `artifact 19 duplicate 下载失败：${downloadResponse.text}`);
  const issuedToken = String(downloadResponse.headers['x-demo-context'] || '');
  const issued = readContextStateByToken(issuedToken);
  const sourceDb = openDatabase();
  let existingFactor;
  try {
    existingFactor = sourceDb.prepare(`SELECT factor.factor_code AS factorCode, energy.code AS energyTypeCode,
        factor.source_unit AS sourceUnit, factor.factor_value AS factorValue, factor.target_unit AS targetUnit,
        factor.display_unit AS displayUnit, factor.display_divisor AS displayDivisor, factor.source,
        factor.document_no AS documentNo, factor.version, factor.effective_start_utc AS effectiveStartUtc,
        factor.effective_end_utc AS effectiveEndUtc, factor.source_timezone AS sourceTimezone, factor.status
      FROM energy_conversion_factors AS factor
      JOIN energy_types AS energy ON energy.id = factor.energy_type_id
      WHERE factor.source_batch_id IS NOT NULL ORDER BY factor.id DESC LIMIT 1`).get();
  } finally {
    sourceDb.close();
  }
  assert(existingFactor, 'artifact 19 首次 execute 必须先写入可复用的折标系数。');
  // managed context 必须上传下载时签发的原始字节；首次已导入同一 canonical artifact，因此原文件重放即为全 skipped。
  const previewResponse = await requestMultipart(
    server,
    '/api/energy-benchmarks/imports/conversion-factors/preview',
    token,
    issuedToken,
    '19-conversion-factors.xlsx',
    downloadResponse.buffer
  );
  assert.strictEqual(previewResponse.status, 200, `artifact 19 duplicate preview 失败：${previewResponse.text}`);
  const preview = previewResponse.body.data;
  assert.strictEqual(Number(preview.expectedWouldImport), 0);
  assert.strictEqual(Number(preview.summary?.skipped), 1);
  const db = openDatabase();
  let before;
  try {
    before = {
      factors: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total),
      registry: Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '19-conversion-factors'").get().total),
      relations: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
        JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
        JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
        WHERE source.artifact_key = '19-conversion-factors' OR target.artifact_key = '19-conversion-factors'`).get().total)
    };
  } finally {
    db.close();
  }
  const afterPreview = readContextState(issued.contextId);
  assert.strictEqual(afterPreview.context.status, 'previewed');
  assert.strictEqual(afterPreview.bindings.length, 1);
  const executeResponse = await request(server, 'POST', '/api/energy-benchmarks/imports/conversion-factors/execute', {
    token,
    headers: { 'X-Demo-Context': issuedToken },
    body: { batchId: preview.batchId, confirmText: preview.confirmText, requireBackup: true, acknowledgeSkippedRisks: true }
  });
  assert.strictEqual(executeResponse.status, 200, `artifact 19 duplicate execute 失败：${executeResponse.text}`);
  const result = executeResponse.body.data;
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.writesBusinessRecords, false);
  assert.strictEqual(result.batchId, preview.batchId);
  assert.strictEqual(result.previewSignature, preview.previewSignature);
  assert.strictEqual(result.previewAuditDigest, preview.previewAuditDigest);
  assert.deepStrictEqual(result.previewAudit, preview.previewAudit);
  assert.deepStrictEqual(result.candidateRows, preview.candidateRows);
  assert.deepStrictEqual(result.candidateRowIds, preview.candidateRowIds);
  assert.strictEqual(result.expectedWouldImport, preview.expectedWouldImport);
  assert.deepStrictEqual(result.importedIds, []);
  assert.deepStrictEqual(result.importedItems, []);
  assertManagedOwnershipPublicProjection(result.ownership, 'artifact 19 全 skipped');
  assert.strictEqual(result.ownership.applied, true);
  assert.strictEqual(result.ownership.noInsertedRecords, true);
  assert.strictEqual(result.ownership.insertedCount, 0);
  assert.strictEqual(result.ownership.registrationCount, 0);
  assert.strictEqual(result.ownership.idempotentCount, 0);
  assert.strictEqual(result.ownership.skippedCount, 1);
  assert.strictEqual(result.ownership.relationCount, 0);
  const afterExecute = readContextState(issued.contextId);
  assert.strictEqual(afterExecute.context.status, 'executed');
  assert.strictEqual(afterExecute.context.executedAt !== null, true);
  const verifyDb = openDatabase();
  try {
    assert.strictEqual(Number(verifyDb.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total), before.factors,
      '全部 skipped execute 不得新增正式折标系数。');
    assert.strictEqual(Number(verifyDb.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE artifact_key = '19-conversion-factors'").get().total), before.registry,
      '全部 skipped execute 不得新增 ownership registry。');
    const afterRelations = Number(verifyDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
      JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
      JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
      WHERE source.artifact_key = '19-conversion-factors' OR target.artifact_key = '19-conversion-factors'`).get().total);
    assert.strictEqual(before.relations, 0, 'artifact 19 没有真实 relation 语义，all-skipped 前不得存在 relation。');
    assert.strictEqual(afterRelations, before.relations,
      'artifact 19 all-skipped execute 不得新增或丢失 demo_data_relations。');
    const audit = getImportAuditBatchDetail(preview.batchId, { includeIssues: false });
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.successCount, 0);
    assert.strictEqual(audit.skippedCount, 1);
    assert.strictEqual(audit.executeResult.executed, true);
    assertManagedOwnershipPublicProjection(audit.executeResult.ownership, 'artifact 19 全 skipped 审计');
    assert.strictEqual(audit.executeResult.ownership.applied, true);
    assert.strictEqual(audit.executeResult.ownership.noInsertedRecords, true);
    assert.strictEqual(audit.executeResult.ownership.registrationCount, 0);
    assert.strictEqual(audit.executeResult.ownership.insertedCount, 0);
    assert.strictEqual(audit.executeResult.ownership.idempotentCount, 0);
    assert.strictEqual(audit.executeResult.ownership.skippedCount, 1);
    assert.strictEqual(audit.executeResult.ownership.relationCount, 0);
  } finally {
    verifyDb.close();
  }
  assert.strictEqual(registration.artifactKey, '19-conversion-factors');
  assert.strictEqual(Number(userId) > 0, true);
}

/** 验证 artifact 25 指向既有正式边界时只登记新 item，并验证双角色全 skipped 明确零登记。 */
async function assertArtifact25ExistingBoundaryAndAllSkipped(server, token) {
  const artifactKey = '25-energy-balance-configs';
  const registration = getDemoArtifactRegistration(artifactKey);
  assert(registration, 'artifact 25 必须存在静态注册。');

  const fixtureDb = openDatabase();
  let formalBoundaryId;
  try {
    fixtureDb.transaction(() => {
      const boundary = fixtureDb.prepare(`SELECT id FROM energy_balance_boundaries
        WHERE boundary_code = 'QL-BAL-PARK' AND version = 'QL-BAL:v1'`).get();
      assert(boundary, 'artifact 25 首次 execute 必须先写入可转换为正式对照的边界。');
      formalBoundaryId = Number(boundary.id);
      fixtureDb.prepare(`DELETE FROM demo_data_relations
        WHERE from_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE artifact_key = ?)
          OR to_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE artifact_key = ?)`).run(artifactKey, artifactKey);
      fixtureDb.prepare('DELETE FROM demo_data_registry WHERE artifact_key = ?').run(artifactKey);
      fixtureDb.prepare(`UPDATE energy_balance_boundaries
        SET source_batch_id = NULL, source_row_number = NULL WHERE id = ?`).run(formalBoundaryId);
      fixtureDb.prepare(`UPDATE energy_balance_items
        SET source_batch_id = NULL, source_row_number = NULL WHERE energy_balance_boundary_id = ?`).run(formalBoundaryId);
      const removed = fixtureDb.prepare(`DELETE FROM energy_balance_items
        WHERE energy_balance_boundary_id = ? AND item_code = 'QL-BAL-USE-E'`).run(formalBoundaryId);
      assert.strictEqual(removed.changes, 1, '正式边界对照必须移除一个项目以形成 item-only candidate。');
    })();
  } finally {
    fixtureDb.close();
  }

  const partialDownload = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(partialDownload.status, 200, `artifact 25 item-only 下载失败：${partialDownload.text}`);
  const partialToken = String(partialDownload.headers['x-demo-context'] || '');
  const partialIssued = readContextStateByToken(partialToken);
  const partialPreviewResponse = await requestMultipart(
    server,
    '/api/energy-balance-imports/bundle/preview',
    token,
    partialToken,
    `${artifactKey}-existing-boundary.xlsx`,
    partialDownload.buffer
  );
  assert.strictEqual(partialPreviewResponse.status, 200, `artifact 25 item-only preview 失败：${partialPreviewResponse.text}`);
  const partialPreview = partialPreviewResponse.body.data;
  assert.strictEqual(Number(partialPreview.expectedWouldImport), 1);
  assert.strictEqual(Number(partialPreview.boundaryPreview.summary.skipped), 1,
    '既有正式 boundary 必须按 skipped 处理。');
  assert.strictEqual(Number(partialPreview.itemPreview.summary.skipped), 2,
    '既有正式 item 必须按 skipped 处理。');
  const partialExecute = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': partialToken },
    body: buildExecuteBody({ artifactKey }, partialPreview)
  });
  assert.strictEqual(partialExecute.status, 200, `artifact 25 item-only execute 失败：${partialExecute.text}`);
  const partialResult = partialExecute.body.data;
  const partialOwnership = partialResult.item.ownership;
  assert.strictEqual(partialResult.imported, 1);
  assert.strictEqual(partialResult.writesBusinessRecords, true);
  assert.strictEqual(partialOwnership.noInsertedRecords, false);
  assert.strictEqual(partialOwnership.registrationCount, 1);
  assert.strictEqual(partialOwnership.skippedCount, 3);
  assert.strictEqual(partialOwnership.relationCount, 0,
    'item 指向既有正式 boundary 时不得创建包含未 owned boundary 的 relation。');
  assert.strictEqual(partialOwnership.registrations[0].entityType, 'energy_balance_item');
  assert(partialOwnership.skipped.every((record) => record.registration === 'not_registered'));
  assert(partialOwnership.skipped.some((record) => record.entityType === 'energy_balance_boundary'
    && record.batchRole === 'boundary'));
  assert.strictEqual(readContextState(partialIssued.contextId).context.status, 'executed');

  const partialDb = openDatabase();
  let partialCounts;
  try {
    const boundary = partialDb.prepare(`SELECT source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM energy_balance_boundaries WHERE id = ?`).get(formalBoundaryId);
    assert.deepStrictEqual(boundary, { sourceBatchId: null, sourceRowNumber: null },
      '既有正式 boundary 不得被补写导入 provenance。');
    const importedItem = partialDb.prepare(`SELECT id, source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber, energy_balance_boundary_id AS boundaryId
      FROM energy_balance_items WHERE energy_balance_boundary_id = ? AND item_code = 'QL-BAL-USE-E'`).get(formalBoundaryId);
    assert(importedItem, 'item-only execute 必须写入缺失项目。');
    assert.strictEqual(Number(importedItem.sourceBatchId), Number(partialPreview.itemBatchId));
    assert.strictEqual(Number(importedItem.sourceRowNumber) > 0, true);
    assert.strictEqual(Number(importedItem.boundaryId), formalBoundaryId);
    assert.strictEqual(partialDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE artifact_key = ? AND entity_type = 'energy_balance_boundary'`).get(artifactKey).total, 0,
    'item-only execute 不得伪造正式 boundary ownership。');
    assert.strictEqual(partialDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE artifact_key = ? AND entity_type = 'energy_balance_item'`).get(artifactKey).total, 1);
    assert.strictEqual(partialDb.prepare(`SELECT COUNT(*) AS total
      FROM demo_data_relations relation
      JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
      WHERE parent.artifact_key = '25-energy-balance-configs'`).get().total, 0);
    partialCounts = {
      boundaries: partialDb.prepare('SELECT COUNT(*) AS total FROM energy_balance_boundaries').get().total,
      items: partialDb.prepare('SELECT COUNT(*) AS total FROM energy_balance_items').get().total,
      registry: partialDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
      relations: partialDb.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total
    };
  } finally {
    partialDb.close();
  }

  const skippedDownload = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(skippedDownload.status, 200, `artifact 25 全 skipped 下载失败：${skippedDownload.text}`);
  const skippedToken = String(skippedDownload.headers['x-demo-context'] || '');
  const skippedIssued = readContextStateByToken(skippedToken);
  const skippedPreviewResponse = await requestMultipart(
    server,
    '/api/energy-balance-imports/bundle/preview',
    token,
    skippedToken,
    `${artifactKey}-all-skipped.xlsx`,
    skippedDownload.buffer
  );
  assert.strictEqual(skippedPreviewResponse.status, 200, `artifact 25 全 skipped preview 失败：${skippedPreviewResponse.text}`);
  const skippedPreview = skippedPreviewResponse.body.data;
  assert.strictEqual(Number(skippedPreview.expectedWouldImport), 0);
  assert.strictEqual(Number(skippedPreview.boundaryPreview.summary.skipped), 1);
  assert.strictEqual(Number(skippedPreview.itemPreview.summary.skipped), 3);
  const skippedExecute = await request(server, 'POST', '/api/energy-balance-imports/bundle/execute', {
    token,
    headers: { 'X-Demo-Context': skippedToken },
    body: buildExecuteBody({ artifactKey }, skippedPreview)
  });
  assert.strictEqual(skippedExecute.status, 200, `artifact 25 全 skipped execute 失败：${skippedExecute.text}`);
  const skippedResult = skippedExecute.body.data;
  const skippedOwnership = skippedResult.boundary.ownership;
  assert.strictEqual(skippedResult.imported, 0);
  assert.strictEqual(skippedResult.writesBusinessRecords, false);
  assert.strictEqual(skippedOwnership.noInsertedRecords, true);
  assert.strictEqual(skippedOwnership.registrationCount, 0);
  assert.strictEqual(skippedOwnership.skippedCount, 4);
  assert.strictEqual(skippedOwnership.relationCount, 0);
  assert(skippedOwnership.skipped.every((record) => record.registration === 'not_registered'));
  assert.deepStrictEqual(new Set(skippedOwnership.skipped.map((record) => record.batchRole)), new Set(['boundary', 'item']));
  assert.strictEqual(readContextState(skippedIssued.contextId).context.status, 'executed');

  const skippedDb = openDatabase();
  try {
    assert.deepStrictEqual({
      boundaries: skippedDb.prepare('SELECT COUNT(*) AS total FROM energy_balance_boundaries').get().total,
      items: skippedDb.prepare('SELECT COUNT(*) AS total FROM energy_balance_items').get().total,
      registry: skippedDb.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total,
      relations: skippedDb.prepare('SELECT COUNT(*) AS total FROM demo_data_relations').get().total
    }, partialCounts, 'artifact 25 全 skipped execute 不得新增业务、registry 或 relation。');
  } finally {
    skippedDb.close();
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
  assert.strictEqual(JSON.stringify(executeResponse.body.data).includes('rowWitness'), false,
    `${testCase.label} 私有 row witness 不得泄漏到公开 execute 结果。`);
  if (['15-energy-timeseries', '18-strategy-rules', '19-conversion-factors'].includes(testCase.artifactKey)) {
    const publicResult = executeResponse.body.data;
    const publicOwnership = publicResult.ownership;
    assert.strictEqual(publicResult.batchId, preview.batchId);
    assert.strictEqual(publicResult.previewSignature, preview.previewSignature);
    assert.strictEqual(publicResult.previewAuditDigest, preview.previewAuditDigest);
    assert.deepStrictEqual(publicResult.previewAudit, preview.previewAudit);
    assert.deepStrictEqual(publicResult.candidateRows, preview.candidateRows);
    assert.deepStrictEqual(publicResult.candidateRowIds, preview.candidateRowIds);
    assert.strictEqual(publicResult.expectedWouldImport, preview.expectedWouldImport);
    assert.strictEqual(publicResult.importedIds.length, publicResult.imported);
    assert.strictEqual(publicResult.importedItems.length, publicResult.imported);
    assert(publicResult.importedItems.every((item) => Number.isSafeInteger(Number(item.sourceRowNumber))
      && Number(item.sourceRowNumber) > 0), `${testCase.label} 顶层 importedItems.sourceRowNumber 必须继续保留。`);
    assertManagedOwnershipPublicProjection(publicOwnership, testCase.label);
    assert.strictEqual(publicOwnership.applied, true);
    assert.strictEqual(publicOwnership.noInsertedRecords, false);
    assert.strictEqual(publicOwnership.registrationCount, publicResult.imported);
    assert.strictEqual(publicOwnership.insertedCount, publicResult.imported);
    assert.strictEqual(publicOwnership.idempotentCount, 0);
    assert.strictEqual(publicOwnership.skippedCount, 0);
    if (testCase.artifactKey === '15-energy-timeseries') {
      assert.strictEqual(publicOwnership.relationCount, 0,
        'artifact 15 先导入时 counterpart 尚未存在，不得创建不完整策略关系。');
    } else if (testCase.artifactKey === '18-strategy-rules') {
      const relationDb = openDatabase();
      let relationCount;
      try {
        relationCount = Number(relationDb.prepare(`SELECT COUNT(*) AS total
          FROM demo_data_relations relation
          JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
          JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
          WHERE source.run_id = target.run_id
            AND source.artifact_key = '15-energy-timeseries'
            AND source.entity_type = 'energy_timeseries'
            AND source.ownership_kind = 'imported'
            AND target.artifact_key = '18-strategy-rules'
            AND target.entity_type = 'strategy_rule'
            AND target.ownership_kind = 'imported'
            AND relation.relation_type = 'uses_config'`).get().total);
      } finally {
        relationDb.close();
      }
      assert.strictEqual(publicOwnership.relationCount, relationCount,
        'artifact 18 ownership 公共摘要必须反映自动生成的完整策略输入闭包。');
      assert(relationCount > 0, 'artifact 18 后导入必须生成策略输入 relation。');
    } else {
      assert.strictEqual(publicOwnership.relationCount, 0);
    }
  }

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
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    // 普通账号拥有下载和领域权限但没有 toggle 权限，runtime 关闭时所有中央 managed 下载都必须无副作用地 fail-closed。
    for (const testCase of TEST_CASES) {
      const blocked = await request(server, 'GET', `/api/templates/demo-park/${testCase.artifactKey}.xlsx`, { token });
      assert.strictEqual(blocked.status, 409, `${testCase.label} runtime 关闭时必须拒绝下载：${blocked.text}`);
      assert.strictEqual(blocked.body?.error?.code, 'DEMO_RUNTIME_DISABLED');
      assert.deepStrictEqual(readManagedDownloadGovernance(), initialGovernance, `${testCase.label} 被拒绝时不得创建 run/context 或自动激活审计。`);
    }

    // runtime 只能由具备 system:demo:toggle 权限的显式接口开启，下载不得承担开关变更职责。
    const toggleResponse = await request(server, 'POST', '/api/system/demo-data/toggle', {
      token: adminToken,
      body: { enabled: true }
    });
    assert.strictEqual(toggleResponse.status, 200, `显式 toggle 开启 runtime 失败：${toggleResponse.text}`);
    assert.strictEqual(toggleResponse.body?.data?.runtime?.enabled, true);
    const enabledGovernance = readManagedDownloadGovernance();
    assert.strictEqual(enabledGovernance.runtime.runtimeEpoch, initialGovernance.runtime.runtimeEpoch + 1);
    assert.strictEqual(enabledGovernance.runtime.revision, initialGovernance.runtime.revision + 1);
    assert.strictEqual(enabledGovernance.runtime.changeReason, 'runtime_toggle_enabled');
    assert.strictEqual(enabledGovernance.runCount, 0);
    assert.strictEqual(enabledGovernance.contextCount, 0);
    assert.strictEqual(enabledGovernance.autoEnableAuditCount, 0);

    for (const testCase of TEST_CASES) {
      await runCase(server, token, authorizedUser.userId, testCase);
    }
    await assertArtifact13AllSkipped(server, token, authorizedUser.userId);
    await assertManagedAnalysisAllSkipped(server, token, '15-energy-timeseries', 16);
    await assertManagedAnalysisAllSkipped(server, token, '18-strategy-rules', 1);
    await assertArtifact19AllSkipped(server, token, authorizedUser.userId);
    await assertArtifact24AllSkipped(server, token);
    await assertArtifact24RecordOnlyAgainstFormalEdge(server, token, authorizedUser.userId);
    await assertArtifact25ExistingBoundaryAndAllSkipped(server, token);
    await assertArtifact25InactiveOwnership(server, token, authorizedUser.userId);
    await assertArtifact25NonZeroMilliseconds(server, token);

    const finalGovernance = readManagedDownloadGovernance();
    assert.strictEqual(finalGovernance.runtime.enabled, 1, '显式 toggle 后 managed 下载必须保持 runtime 开启。');
    assert.strictEqual(finalGovernance.runtime.changeReason, 'runtime_toggle_enabled');
    assert.strictEqual(finalGovernance.runtime.runtimeEpoch, enabledGovernance.runtime.runtimeEpoch, 'managed 下载不得提升 runtime epoch。');
    assert.strictEqual(finalGovernance.runtime.revision, enabledGovernance.runtime.revision, 'managed 下载不得提升 runtime revision。');
    assert.strictEqual(finalGovernance.runCount, 1, '全部 managed 下载必须复用同一 active run。');
    assert.strictEqual(finalGovernance.contextCount, TEST_CASES.length + 12, '每个真实下载必须只签发一个 context。');
    assert.strictEqual(finalGovernance.autoEnableAuditCount, 0, 'managed 下载不得自动激活或写自动激活审计。');

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
