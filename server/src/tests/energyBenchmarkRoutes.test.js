'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

// 路由测试仅使用系统临时目录、隔离 SQLite 和随机端口。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-benchmark-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-benchmark-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyBenchmarkRoutes = require('../routes/energyBenchmarks');
const {
  ENERGY_BENCHMARK_JSON_LIMIT,
  ENERGY_BENCHMARK_PERMISSIONS,
  ENERGY_BENCHMARK_ROUTER_MOUNT_REQUIREMENT
} = energyBenchmarkRoutes;
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 独立路由拟挂载路径，正式 server/src/index.js 本轮保持不修改。
const ROUTE_BASE = '/api/energy-benchmarks';

/**
 * 发起 JSON 请求并解析统一响应。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname 请求路径。
 * @param {*} body JSON 请求体。
 * @param {string|null} token 会话令牌。
 * @returns {Promise<object>} 响应对象。
 */
function requestJson(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    const request = http.request({
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
        resolve({
          status: response.statusCode,
          body: buffer.length > 0 ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    request.on('error', reject);
    if (rawBody !== null) request.write(rawBody);
    request.end();
  });
}

/**
 * 发起原始 JSON 请求，验证认证和请求体解析顺序。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} pathname 请求路径。
 * @param {string|Buffer} rawBody 原始请求体。
 * @param {string|null} token 会话令牌。
 * @returns {Promise<object>} 响应对象。
 */
function requestRawJson(server, pathname, rawBody, token) {
  return new Promise((resolve, reject) => {
    const requestBody = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': requestBody.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
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
          body: buffer.length > 0 ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    request.on('error', reject);
    request.end(requestBody);
  });
}

/**
 * 向隔离库插入权限菜单并授予测试账号。
 * @param {string} username 用户名。
 * @param {string[]} permissionCodes 权限编码。
 */
function grantPermissions(username, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    assert(user, `测试账号 ${username} 必须存在。`);
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(`energy-benchmark-${username}`, `${username} 能效对标角色`, now, now).lastInsertRowid);
    const insertMenu = db.prepare(`INSERT INTO sys_menus
      (menu_type, menu_name, permission_code, sort_order, visible, status, is_builtin, created_at, updated_at)
      VALUES ('button', ?, ?, 0, 0, 'active', 0, ?, ?)
      ON CONFLICT(permission_code) DO NOTHING`);
    permissionCodes.forEach((permissionCode) => {
      insertMenu.run(permissionCode, permissionCode, now, now);
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)').run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

/**
 * 初始化路由 CRUD 使用的组织主数据。
 */
function seedMasterData() {
  const db = openDatabase();
  try {
    const organizationId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('OU-ROUTE-BENCH', '路由对标车间', '/OU-ROUTE-BENCH', 'workshop', 'active')`).run().lastInsertRowid);
    const productionUnitId = Number(db.prepare(`INSERT INTO production_units
      (unit_code, unit_name, organization_unit_id, product_name, output_unit, status)
      VALUES ('PU-ROUTE-BENCH', '路由产品线', ?, '路由产品', 't', 'active')`).run(organizationId).lastInsertRowid);
    const energyType = db.prepare(`SELECT id, standard_unit AS standardUnit FROM energy_types
      WHERE code = 'electricity'`).get();
    const insertOutput = db.prepare(`INSERT INTO production_output_records
      (production_unit_id, normalized_month, output_value, output_unit, data_source, record_status)
      VALUES (?, ?, ?, 't', 'manual', 'active')`);
    insertOutput.run(productionUnitId, '2025-01', 10);
    insertOutput.run(productionUnitId, '2025-02', 20);
    const insertEnergy = db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
    insertEnergy.run(energyType.id, organizationId, '2025-01', '2025-01', energyType.standardUnit,
      100, energyType.standardUnit, 100, 'route-benchmark-history-2025-01');
    insertEnergy.run(energyType.id, organizationId, '2025-02', '2025-02', energyType.standardUnit,
      120, energyType.standardUnit, 120, 'route-benchmark-history-2025-02');
  } finally {
    db.close();
  }
}

/**
 * 创建并启动仅挂载当前独立路由的 Express 应用。
 * @returns {Promise<object>} HTTP 服务。
 */
function startIsolatedServer() {
  const app = express();
  // 独立路由必须在全局 JSON 解析器之前挂载，避免匿名畸形 JSON 抢先解析。
  app.use(ROUTE_BASE, energyBenchmarkRoutes);
  app.use(express.json({ limit: '2mb' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 创建合法定义请求体。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 定义请求体。
 */
function createDefinitionBody(overrides = {}) {
  return {
    benchmarkCode: 'ROUTE-BENCHMARK',
    benchmarkName: '路由企业能耗目标',
    benchmarkType: 'manual_benchmark',
    metricCode: 'energy_intensity',
    unit: 'kgce/t',
    periodType: 'month',
    scopeType: 'organization',
    scopeReference: 'OU-ROUTE-BENCH',
    direction: 'lower_better',
    source: '企业自定义目标',
    documentNo: null,
    version: 'route-definition:v1',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active',
    ...overrides
  };
}

/**
 * 创建合法实际值。
 * @param {number} actualValue 实际值。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 实际值上下文。
 */
function createActual(actualValue, overrides = {}) {
  return {
    objectId: 'ROUTE-OBJECT-1',
    objectName: '路由车间一',
    objectLevel: 'workshop',
    actualValue,
    metricCode: 'energy_intensity',
    unit: 'kgce/t',
    periodType: 'month',
    periodStartUtc: '2026-06-01T00:00:00Z',
    periodEndUtc: '2026-07-01T00:00:00Z',
    scopeType: 'organization',
    scopeReference: 'ROUTE-OBJECT-1',
    benchmarkScopeReference: 'OU-ROUTE-BENCH',
    energyTypeCode: 'electricity',
    ...overrides
  };
}

/**
 * 验证权限拆分、认证优先和维护态只阻断写操作。
 * @param {object} server 隔离服务。
 * @param {object} tokens 会话令牌。
 * @param {number} definitionId 定义主键。
 * @param {number} targetId 目标主键。
 */
async function testPermissionAndMaintenance(server, tokens, definitionId, targetId) {
  const anonymousRead = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions`, undefined, null);
  assert.strictEqual(anonymousRead.status, 401);
  assert.strictEqual(anonymousRead.body.error.code, 'UNAUTHENTICATED');

  const deniedRead = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions`, undefined, tokens.denied);
  assert.strictEqual(deniedRead.status, 403);
  assert.strictEqual(deniedRead.body.error.code, 'FORBIDDEN');

  const viewRead = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions`, undefined, tokens.view);
  assert.strictEqual(viewRead.status, 200);
  assert.strictEqual(viewRead.body.success, true);
  assert.strictEqual(viewRead.body.meta.total, 1);

  const viewWrite = await requestJson(server, 'POST', `${ROUTE_BASE}/definitions`, createDefinitionBody(), tokens.view);
  assert.strictEqual(viewWrite.status, 403);

  const analyzeRead = await requestJson(server, 'POST', `${ROUTE_BASE}/evaluate`, {
    definitionId,
    targetId,
    actual: createActual(120)
  }, tokens.analyze);
  assert.strictEqual(analyzeRead.status, 200);
  assert.strictEqual(analyzeRead.body.data.result.met, false);

  const analyzeExport = await requestJson(server, 'POST', `${ROUTE_BASE}/export-rows`, {
    definitionId,
    targetId,
    actuals: [createActual(100)]
  }, tokens.analyze);
  assert.strictEqual(analyzeExport.status, 403, '分析权限不得替代导出权限。');

  await runWithMaintenance('energy-benchmark-route-test', async () => {
    const maintenanceRead = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions/${definitionId}`, undefined, tokens.view);
    assert.strictEqual(maintenanceRead.status, 200, '维护态不得禁用只读详情。');

    const maintenanceAnalysis = await requestJson(server, 'POST', `${ROUTE_BASE}/evaluate`, {
      definitionId,
      targetId,
      actual: createActual(80)
    }, tokens.analyze);
    assert.strictEqual(maintenanceAnalysis.status, 200, '维护态不得禁用不写库分析。');

    const maintenanceWrite = await requestJson(server, 'PATCH', `${ROUTE_BASE}/definitions/${definitionId}/status`, {
      status: 'inactive'
    }, tokens.manage);
    assert.strictEqual(maintenanceWrite.status, 423);
    assert.strictEqual(maintenanceWrite.body.error.code, 'MAINTENANCE_IN_PROGRESS');

    const maintenanceMalformed = await requestRawJson(server, `${ROUTE_BASE}/definitions`, '{"benchmarkCode":', tokens.manage);
    assert.strictEqual(maintenanceMalformed.status, 423, '维护态必须先于写请求 JSON 解析。');
    assert.strictEqual(maintenanceMalformed.body.error.code, 'MAINTENANCE_IN_PROGRESS');
  });
}

/**
 * 验证认证、权限、维护态都先于受限 JSON 解析器。
 * @param {object} server 隔离服务。
 * @param {object} tokens 会话令牌。
 */
async function testJsonParserOrder(server, tokens) {
  const malformed = '{"benchmarkCode":';
  const oversized = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });

  const anonymousMalformed = await requestRawJson(server, `${ROUTE_BASE}/definitions`, malformed, null);
  assert.strictEqual(anonymousMalformed.status, 401);
  assert.strictEqual(anonymousMalformed.body.error.code, 'UNAUTHENTICATED');

  const anonymousOversized = await requestRawJson(server, `${ROUTE_BASE}/definitions`, oversized, null);
  assert.strictEqual(anonymousOversized.status, 401);
  assert.strictEqual(anonymousOversized.body.error.code, 'UNAUTHENTICATED');

  const deniedMalformed = await requestRawJson(server, `${ROUTE_BASE}/definitions`, malformed, tokens.denied);
  assert.strictEqual(deniedMalformed.status, 403);
  assert.strictEqual(deniedMalformed.body.error.code, 'FORBIDDEN');
  const deniedOversized = await requestRawJson(server, `${ROUTE_BASE}/definitions`, oversized, tokens.denied);
  assert.strictEqual(deniedOversized.status, 403);
  assert.strictEqual(deniedOversized.body.error.code, 'FORBIDDEN');

  const authorizedMalformed = await requestRawJson(server, `${ROUTE_BASE}/definitions`, malformed, tokens.manage);
  assert.strictEqual(authorizedMalformed.status, 400);

  const authorizedOversized = await requestRawJson(server, `${ROUTE_BASE}/definitions`, oversized, tokens.manage);
  assert.strictEqual(authorizedOversized.status, 413);
}

/**
 * 验证路由 CRUD、状态语义、三方向分析入口和白名单。
 * @param {object} server 隔离服务。
 * @param {string} adminToken 管理员令牌。
 * @returns {Promise<{definitionId:number,targetId:number}>} 基础记录主键。
 */
async function testCrudAndAnalysisRoutes(server, adminToken) {
  const createDefinition = await requestJson(server, 'POST', `${ROUTE_BASE}/definitions`, createDefinitionBody(), adminToken);
  assert.strictEqual(createDefinition.status, 200);
  assert.strictEqual(createDefinition.body.success, true);
  assert.strictEqual(createDefinition.body.meta.created, true);
  const definitionId = createDefinition.body.data.id;

  const unknownQuery = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions?unknown=1`, undefined, adminToken);
  assert.strictEqual(unknownQuery.status, 400);
  assert.strictEqual(unknownQuery.body.error.details.code, 'ENERGY_BENCHMARK_UNKNOWN_FIELDS');

  const unknownBody = await requestJson(server, 'POST', `${ROUTE_BASE}/targets`, {
    benchmarkDefinitionId: definitionId,
    targetValue: 100,
    version: 'route-target:v1',
    status: 'active',
    forgedField: true
  }, adminToken);
  assert.strictEqual(unknownBody.status, 400);
  assert.strictEqual(unknownBody.body.error.details.code, 'ENERGY_BENCHMARK_UNKNOWN_FIELDS');

  const createTarget = await requestJson(server, 'POST', `${ROUTE_BASE}/targets`, {
    benchmarkDefinitionId: definitionId,
    targetValue: 100,
    lowerBound: null,
    upperBound: null,
    version: 'route-target:v1',
    status: 'active'
  }, adminToken);
  assert.strictEqual(createTarget.status, 200);
  let targetId = createTarget.body.data.id;

  const detail = await requestJson(server, 'GET', `${ROUTE_BASE}/definitions/${definitionId}`, undefined, adminToken);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.data.targets.length, 1);

  const updateDefinition = await requestJson(server, 'PUT', `${ROUTE_BASE}/definitions/${definitionId}`,
    createDefinitionBody({ benchmarkName: '路由更新后的目标' }), adminToken);
  assert.strictEqual(updateDefinition.status, 200);
  assert.strictEqual(updateDefinition.body.data.benchmarkName, '路由更新后的目标');

  const predecessorTargetId = targetId;
  const updateTarget = await requestJson(server, 'PUT', `${ROUTE_BASE}/targets/${targetId}`, {
    targetValue: 90,
    lowerBound: null,
    upperBound: null,
    version: 'route-target-next:v1',
    status: 'active'
  }, adminToken);
  assert.strictEqual(updateTarget.status, 200);
  assert.strictEqual(updateTarget.body.data.targetValue, 90);
  assert.strictEqual(updateTarget.body.data.predecessorTargetId, predecessorTargetId);
  targetId = updateTarget.body.data.id;

  const evaluation = await requestJson(server, 'POST', `${ROUTE_BASE}/evaluate`, {
    definitionId,
    targetId,
    actual: createActual(120)
  }, adminToken);
  assert.strictEqual(evaluation.status, 200);
  assert.strictEqual(evaluation.body.data.result.absoluteDifference, 30);
  assert.strictEqual(evaluation.body.data.result.status, 'not_met');

  const ranking = await requestJson(server, 'POST', `${ROUTE_BASE}/rankings`, {
    definitionId,
    targetId,
    actuals: [
      createActual(80, { objectId: 'A' }),
      createActual(80, { objectId: 'B' }),
      createActual(120, { objectId: 'C' }),
      createActual(70, { objectId: 'X', unit: 'kWh' })
    ]
  }, adminToken);
  assert.strictEqual(ranking.status, 200);
  assert.deepStrictEqual(ranking.body.data.ranked.map((item) => item.rank), [1, 1, 3]);
  assert.strictEqual(ranking.body.data.excluded.length, 1);

  const qualification = await requestJson(server, 'POST', `${ROUTE_BASE}/qualification-rate`, {
    definitionId,
    targetId,
    actuals: [createActual(80), createActual(120, { objectId: 'B' })]
  }, adminToken);
  assert.strictEqual(qualification.status, 200);
  assert.strictEqual(qualification.body.data.qualificationRate, 0.5);

  const exported = await requestJson(server, 'POST', `${ROUTE_BASE}/export-rows`, {
    definitionId,
    targetId,
    actuals: [createActual(80)]
  }, adminToken);
  assert.strictEqual(exported.status, 200);
  assert.strictEqual(exported.body.data.meta.generatedFromExplicitActuals, true);

  const inactiveTarget = await requestJson(server, 'PATCH', `${ROUTE_BASE}/targets/${targetId}/status`, {
    status: 'inactive'
  }, adminToken);
  assert.strictEqual(inactiveTarget.status, 200);
  assert.strictEqual(inactiveTarget.body.data.status, 'inactive');
  const activeTarget = await requestJson(server, 'PATCH', `${ROUTE_BASE}/targets/${targetId}/status`, {
    status: 'active'
  }, adminToken);
  assert.strictEqual(activeTarget.body.data.status, 'active');

  return { definitionId, targetId };
}

/**
 * 验证内部历史路由原子固化且普通定义接口拒绝内部类型。
 * @param {object} server 隔离服务。
 * @param {string} adminToken 管理员令牌。
 */
async function testInternalHistoryRoute(server, adminToken) {
  const ordinaryInternal = await requestJson(server, 'POST', `${ROUTE_BASE}/definitions`, createDefinitionBody({
    benchmarkCode: 'ROUTE-INTERNAL-ORDINARY',
    benchmarkType: 'internal_history_baseline',
    version: 'route-internal-ordinary:v1'
  }), adminToken);
  assert.strictEqual(ordinaryInternal.status, 400);
  assert.strictEqual(ordinaryInternal.body.error.details.code, 'INTERNAL_HISTORY_BENCHMARK_REQUIRES_SNAPSHOT');

  const derivedFields = ['frozenValue', 'sampleCount', 'productionSummary', 'sourceDataDigest', 'frozenAt'];
  for (const fieldName of derivedFields) {
    const rejected = await requestJson(server, 'POST', `${ROUTE_BASE}/internal-history`, {
      definition: createDefinitionBody({
        benchmarkCode: `ROUTE-FORBIDDEN-${fieldName.toUpperCase()}`,
        benchmarkType: 'internal_history_baseline',
        unit: 'kWh/t',
        version: `route-forbidden-${fieldName.toLowerCase()}:v1`
      }),
      referencePeriod: {
        startUtc: '2025-01-01T00:00:00Z',
        endUtc: '2025-03-01T00:00:00Z'
      },
      calculationScope: { productionUnitId: 1, energyTypeCode: 'electricity' },
      [fieldName]: fieldName === 'sampleCount' ? 2 : 'client-derived'
    }, adminToken);
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(rejected.body.error.details.code, 'INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN');
  }

  const rejectedSnapshot = await requestJson(server, 'POST', `${ROUTE_BASE}/internal-history`, {
    definition: createDefinitionBody({
      benchmarkCode: 'ROUTE-INTERNAL-SNAPSHOT',
      benchmarkType: 'internal_history_baseline',
      unit: 'kWh/t',
      version: 'route-internal-snapshot:v1'
    }),
    snapshot: { frozenValue: 85 }
  }, adminToken);
  assert.strictEqual(rejectedSnapshot.status, 400);
  assert.strictEqual(rejectedSnapshot.body.error.details.code, 'INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN');

  const internal = await requestJson(server, 'POST', `${ROUTE_BASE}/internal-history`, {
    definition: createDefinitionBody({
      benchmarkCode: 'ROUTE-INTERNAL',
      benchmarkName: '路由内部历史基准',
      benchmarkType: 'internal_history_baseline',
      unit: 'kWh/t',
      source: '历史数据固化',
      version: 'route-internal:v1'
    }),
    referencePeriod: {
      startUtc: '2025-01-01T00:00:00Z',
      endUtc: '2025-03-01T00:00:00Z'
    },
    calculationScope: {
      productionUnitId: 1,
      energyTypeCode: 'electricity'
    }
  }, adminToken);
  assert.strictEqual(internal.status, 200);
  assert.strictEqual(internal.body.data.target.isFrozen, true);
  assert.strictEqual(internal.body.data.target.autoRefresh, false);
  assert.strictEqual(internal.body.data.target.frozenValue, 7.333333333333);
  assert.strictEqual(internal.body.data.target.sampleCount, 2);
  assert.strictEqual(internal.body.data.target.productionSummary.totalEnergy, 220);
  assert.strictEqual(internal.body.data.target.productionSummary.totalOutput, 30);
  assert.match(internal.body.data.target.sourceDataDigest, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(internal.body.meta.frozen, true);

  const db = openDatabase();
  try {
    const admin = db.prepare(`SELECT id FROM sys_users WHERE username = 'admin'`).get();
    const audit = db.prepare(`SELECT user_id AS userId, detail_json AS detailJson FROM sys_operation_logs
      WHERE operation = 'energy.benchmark.internal-history.create' ORDER BY id DESC LIMIT 1`).get();
    assert.strictEqual(audit.userId, admin.id, '路由必须把认证操作者传入事务审计。');
    const detail = JSON.parse(audit.detailJson);
    assert.strictEqual(detail.after.target.id, internal.body.data.target.id);
  } finally {
    db.close();
  }
}

(async () => {
  let server;
  try {
    assert.strictEqual(ENERGY_BENCHMARK_JSON_LIMIT, '256kb');
    assert.deepStrictEqual(ENERGY_BENCHMARK_ROUTER_MOUNT_REQUIREMENT, {
      beforeGlobalJsonParser: true,
      recommendedBasePath: '/api/energy-benchmarks'
    });
    assert.deepStrictEqual(ENERGY_BENCHMARK_PERMISSIONS, {
      view: 'energy:benchmarks:view',
      manage: 'energy:benchmarks:manage',
      analyze: 'energy:benchmarks:analyze',
      export: 'energy:benchmarks:export'
    });

    initDatabase();
    seedMasterData();
    register({ username: 'energy-benchmark-denied', password: 'Password123!' });
    register({ username: 'energy-benchmark-view', password: 'Password123!' });
    register({ username: 'energy-benchmark-manage', password: 'Password123!' });
    register({ username: 'energy-benchmark-analyze', password: 'Password123!' });
    register({ username: 'energy-benchmark-export', password: 'Password123!' });
    grantPermissions('energy-benchmark-view', [ENERGY_BENCHMARK_PERMISSIONS.view]);
    grantPermissions('energy-benchmark-manage', [ENERGY_BENCHMARK_PERMISSIONS.manage]);
    grantPermissions('energy-benchmark-analyze', [ENERGY_BENCHMARK_PERMISSIONS.analyze]);
    grantPermissions('energy-benchmark-export', [ENERGY_BENCHMARK_PERMISSIONS.export]);

    const tokens = {
      admin: login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token,
      denied: login({ username: 'energy-benchmark-denied', password: 'Password123!' }).token,
      view: login({ username: 'energy-benchmark-view', password: 'Password123!' }).token,
      manage: login({ username: 'energy-benchmark-manage', password: 'Password123!' }).token,
      analyze: login({ username: 'energy-benchmark-analyze', password: 'Password123!' }).token,
      export: login({ username: 'energy-benchmark-export', password: 'Password123!' }).token
    };
    server = await startIsolatedServer();

    await testJsonParserOrder(server, tokens);
    const created = await testCrudAndAnalysisRoutes(server, tokens.admin);
    await testPermissionAndMaintenance(server, tokens, created.definitionId, created.targetId);
    await testInternalHistoryRoute(server, tokens.admin);

    const unknown = await requestJson(server, 'GET', `${ROUTE_BASE}/unknown`, undefined, tokens.admin);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body.error.code, 'NOT_FOUND');

    const db = openDatabase();
    try {
      assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
    console.log('energyBenchmarkRoutes tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
