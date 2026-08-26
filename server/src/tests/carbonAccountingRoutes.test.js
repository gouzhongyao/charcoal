'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// accounting 真实 HTTP 专项使用随机端口和隔离临时 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-accounting-routes-'));
// development 模式也必须由 N5-B 领域边界固定脱敏未知异常。
process.env.NODE_ENV = 'development';
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-accounting-routes.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonAccountingRoutes123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const carbonAccountingRoutes = require('../routes/carbonAccounting');
const { login, register } = require('../services/authService');
const {
  setCarbonAccountingFaultInjectorForTest
} = require('../services/carbonCalculationRunService');
const {
  getCarbonAccountingStatistics
} = require('../services/carbonAccountingResultService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 专项固定运行期间。
const RUN_PERIOD = Object.freeze({
  startUtc: '2026-08-24T00:00:00Z',
  endUtc: '2026-08-25T00:00:00Z'
});

/** 发起原始 HTTP 请求并按响应类型解析。 */
function requestRaw(server, method, pathname, rawBody, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = rawBody === undefined || rawBody === null
      ? null
      : Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const headers = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (bodyBuffer) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = bodyBuffer.length;
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
          body: contentType.includes('application/json') && buffer.length
            ? JSON.parse(buffer.toString('utf8'))
            : null
        });
      });
    });
    clientRequest.on('error', reject);
    if (bodyBuffer) clientRequest.write(bodyBuffer);
    clientRequest.end();
  });
}

/** 发起 JSON HTTP 请求。 */
function requestJson(server, method, pathname, body, token, extraHeaders = {}) {
  return requestRaw(
    server,
    method,
    pathname,
    body === undefined ? undefined : JSON.stringify(body),
    token,
    extraHeaders
  );
}

/** 为单个测试用户授予精确权限集合。 */
function grantPermissions(userId, permissionCodes, roleSuffix) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(
      `carbon-accounting-routes-${roleSuffix}`,
      `独立核算 HTTP 角色 ${roleSuffix}`,
      now,
      now
    ).lastInsertRowid);
    const insertGrant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      let menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      if (!menu && permissionCode === 'carbon:view') {
        const menuId = db.prepare(`INSERT INTO sys_menus
          (menu_type, menu_name, permission_code, status, is_builtin, created_at, updated_at)
          VALUES ('button', '旧碳查看兼容权限', 'carbon:view', 'active', 0, ?, ?)`)
          .run(now, now).lastInsertRowid;
        menu = { id: menuId };
      }
      assert(menu, `权限 ${permissionCode} 必须已注册。`);
      insertGrant.run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
  } finally {
    db.close();
  }
}

/** 注册一个拥有精确权限的测试账号并返回登录 token。 */
function createPermissionToken(username, permissionCodes) {
  const password = 'CarbonAccountingUser123!';
  const user = register({ username, password, displayName: `测试账号-${username}` });
  grantPermissions(user.id, permissionCodes, username);
  return login({ username, password }).token;
}

/** 插入 independent_activity 及旧 energy_record 两类测试事实。 */
function seedAccountingFacts() {
  const db = openDatabase();
  try {
    const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('ACCOUNTING-HTTP-OU', '=独立活动组织', '/ACCOUNTING-HTTP-OU', 'department', 'active')`)
      .run().lastInsertRowid);
    const energyTypeId = Number(db.prepare(`INSERT INTO energy_types
      (code, name, category, default_unit, standard_unit, carbon_factor_required, is_active, display_order)
      VALUES ('accounting-http-energy', '核算 HTTP 能源', 'other', 'unit', 'unit', 1, 1, 950)`)
      .run().lastInsertRowid);
    const carbonFactorId = Number(db.prepare(`INSERT INTO carbon_factors
      (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
      VALUES (?, 'cn-http', 2026, 'unit', 0.25, 'kgCO2e', '+HTTP因子来源', 1)`)
      .run(energyTypeId).lastInsertRowid);
    db.prepare(`INSERT INTO carbon_activity_records
      (source_type, activity_code, activity_code_key, emission_scope, activity_category,
       activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
       end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
       factor_region, source_reference, note, duplicate_key, record_status)
      VALUES ('independent_activity', 'ACCOUNTING-HTTP-ACT', 'accounting-http-act', 'scope_2',
       '@独立活动类别', '@独立活动类别', ?, ?, '2026-08-24T08:00', '2026-08-24T09:00',
       'Asia/Shanghai', '2026-08-24T00:00:00Z', '2026-08-24T01:00:00Z', 4, 'unit',
       'cn-http', '=活动来源引用', '-活动备注', ?, 'active')`)
      .run(organizationUnitId, energyTypeId, crypto.createHash('sha256').update('accounting-http-act').digest('hex'));
    const insertEnergyRecord = db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, organization, site, department,
       duplicate_key, record_status)
      VALUES (?, ?, '2026-08', '2026-08', 'unit', 8, 'unit', 8, '=旧能耗组织',
       '+旧能耗厂区', '@旧能耗部门', ?, 'active')`);
    const energyRecordId = Number(insertEnergyRecord
      .run(energyTypeId, organizationUnitId, 'accounting-http-energy-record-kg').lastInsertRowid);
    const secondEnergyRecordId = Number(insertEnergyRecord
      .run(energyTypeId, organizationUnitId, 'accounting-http-energy-record-t').lastInsertRowid);
    const insertEmission = db.prepare(`INSERT INTO carbon_emissions
      (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value,
       activity_value, activity_unit, emission_value, emission_unit, status, note)
      VALUES (?, ?, 'standard-factor', 'legacy-http', 0.25, 8, 'unit', ?, ?, 'calculated', ?)`);
    insertEmission.run(energyRecordId, carbonFactorId, 2, 'kgCO2e', '-旧结果备注');
    insertEmission.run(secondEnergyRecordId, carbonFactorId, 0.002, 'tCO2e', '=第二单位结果');
    return { organizationUnitId, energyTypeId, carbonFactorId, energyRecordId };
  } finally {
    db.close();
  }
}

/** 为两来源制造单行有限但同单位 SUM 溢出的隔离统计事实。 */
function seedNonFiniteStatisticsFacts(runCode, facts) {
  const db = openDatabase();
  try {
    const run = db.prepare('SELECT id FROM carbon_calculation_runs WHERE run_code = ?').get(runCode);
    const sourceResult = db.prepare(`SELECT * FROM carbon_accounting_results
      WHERE calculation_run_id = ? ORDER BY id LIMIT 1`).get(run.id);
    db.prepare('UPDATE carbon_accounting_results SET emission_value = ? WHERE id = ?')
      .run(1e308, sourceResult.id);
    db.prepare(`INSERT INTO carbon_accounting_results
      (calculation_run_id, snapshot_schema_version, source_type, activity_record_id, carbon_factor_id,
       emission_scope, activity_category, organization_unit_id, energy_type_id,
       activity_start_wall_clock, activity_end_wall_clock, activity_start_utc, activity_end_utc,
       activity_value, activity_unit, requested_region, factor_year, factor_value, factor_unit,
       emission_value, emission_unit, status, missing_reason, calculation_basis, match_priority,
       activity_snapshot_json, organization_snapshot_json, energy_type_snapshot_json,
       factor_snapshot_json, matching_snapshot_json, formula_snapshot_json, created_at)
      SELECT calculation_run_id, snapshot_schema_version, source_type, activity_record_id + 1000000,
       carbon_factor_id, emission_scope, activity_category, organization_unit_id, energy_type_id,
       activity_start_wall_clock, activity_end_wall_clock, activity_start_utc, activity_end_utc,
       activity_value, activity_unit, requested_region, factor_year, factor_value, factor_unit,
       ?, emission_unit, status, missing_reason, calculation_basis, match_priority,
       activity_snapshot_json, organization_snapshot_json, energy_type_snapshot_json,
       factor_snapshot_json, matching_snapshot_json, formula_snapshot_json, created_at
      FROM carbon_accounting_results WHERE id = ?`).run(1e308, sourceResult.id);
    db.prepare(`UPDATE carbon_calculation_runs SET activity_count = 2, result_count = 2,
      calculated_count = 2, factor_missing_count = 0 WHERE id = ?`).run(run.id);

    const energyRecordId = Number(db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2026-08', '2026-08', 'unit', 8, 'unit', 8, ?, 'active')`)
      .run(facts.energyTypeId, facts.organizationUnitId, 'accounting-statistics-infinity').lastInsertRowid);
    db.prepare(`UPDATE carbon_emissions SET emission_value = ?
      WHERE energy_record_id = ?`).run(1e308, facts.energyRecordId);
    db.prepare(`INSERT INTO carbon_emissions
      (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value,
       activity_value, activity_unit, emission_value, emission_unit, status, note)
      VALUES (?, ?, 'standard-factor', 'statistics-overflow', 0.25, 8, 'unit', ?, 'kgCO2e',
       'calculated', 'statistics-overflow')`).run(energyRecordId, facts.carbonFactorId, 1e308);
  } finally {
    db.close();
  }
}

/** 断言错误响应不泄漏本地路径、SQL 或凭证。 */
function assertRedactedError(response, token) {
  const serialized = JSON.stringify(response.body || {});
  assert(!serialized.includes(temporaryRoot));
  assert(!serialized.includes(process.env.SQLITE_PATH));
  assert(!serialized.toLowerCase().includes('select '));
  assert(!serialized.toLowerCase().includes('insert into'));
  assert(!serialized.includes(token));
}

/** 断言 N5-B 未知异常在 development 环境仍返回固定公开错误。 */
function assertFixedAccountingInternalError(response, token) {
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.body.error.code, 'CARBON_ACCOUNTING_INTERNAL_ERROR');
  assert.strictEqual(response.body.error.message, '独立碳核算服务内部错误。');
  assert.strictEqual(response.body.error.details, null);
  assert(!JSON.stringify(response.body).includes('sys_roles'));
  assertRedactedError(response, token);
}

/** 断言统计非有限总计通过稳定领域错误 fail-closed。 */
function assertNonFiniteStatisticsError(errorOrResponse) {
  const error = errorOrResponse?.body?.error || errorOrResponse;
  if (errorOrResponse?.body) assert.strictEqual(errorOrResponse.status, 422);
  assert.strictEqual(error.code, 'CARBON_ACCOUNTING_NON_FINITE_STATISTICS_TOTAL');
  assert.strictEqual(error.message, '排放统计汇总产生非有限数值，已拒绝返回。');
  assert.strictEqual(error.details, null);
  return true;
}

/** 断言公开运行 DTO 不包含内部 actor IP。 */
function assertPublicActorWithoutIp(run) {
  assert(run?.actorSnapshot?.actor);
  assert.strictEqual(Object.hasOwn(run.actorSnapshot.actor, 'ip'), false);
}

/** 将 CSV 内容拆成非空行，便于验证标题和业务行来源值。 */
function parseNonEmptyCsvLines(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
}

(async () => {
  let server;
  try {
    initDatabase();
    const facts = seedAccountingFacts();
    const ordinaryToken = createPermissionToken('accountingordinary', []);
    const activityViewToken = createPermissionToken('accountingactivityview', ['carbon:activities:view']);
    const activityCalculateToken = createPermissionToken('accountingactivitycalculate', ['carbon:activities:calculate']);
    const activityExportToken = createPermissionToken('accountingactivityexport', ['carbon:activities:export']);
    const energyViewToken = createPermissionToken('accountingenergyview', ['carbon:emissions:view']);
    const energyExportToken = createPermissionToken('accountingenergyexport', ['carbon:emissions:export']);
    const bothViewToken = createPermissionToken('accountingbothview', [
      'carbon:activities:view', 'carbon:emissions:view'
    ]);
    const bothExportToken = createPermissionToken('accountingbothexport', [
      'carbon:activities:export', 'carbon:emissions:export'
    ]);
    const legacyCarbonViewToken = createPermissionToken('accountinglegacyview', ['carbon:view']);
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;

    const app = express();
    // 使用 extended 查询解析器，把 bracket 语法固化为真实 object-valued HTTP 输入。
    app.set('query parser', 'extended');
    // 领域路由必须位于全局 2 MiB parser 前，验证前置安全检查和 64 KiB 限制。
    app.use('/api/carbon/accounting', carbonAccountingRoutes);
    app.use(express.json({ limit: '2mb' }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const malformedJson = '{"startUtc":';
    const oversizedJson = JSON.stringify({ padding: 'x'.repeat(70 * 1024) });
    assert.strictEqual((await requestRaw(server, 'POST', '/api/carbon/accounting/runs', malformedJson)).status, 401,
      '匿名请求必须在 JSON 解析前返回 401。');
    assert.strictEqual((await requestRaw(server, 'POST', '/api/carbon/accounting/runs', malformedJson, ordinaryToken)).status, 403,
      '无计算权限请求必须在 JSON 解析前返回 403。');
    const maintenanceRejected = await runWithMaintenance('carbon-accounting-http-test', () => (
      requestRaw(server, 'POST', '/api/carbon/accounting/runs', malformedJson, activityCalculateToken)
    ));
    assert.strictEqual(maintenanceRejected.status, 423, '维护态必须在 JSON 解析前返回 423。');
    assert.strictEqual(maintenanceRejected.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    const demoRejected = await requestRaw(
      server,
      'POST',
      '/api/carbon/accounting/runs',
      malformedJson,
      activityCalculateToken,
      { 'X-Demo-Context': 'z'.repeat(43) }
    );
    assert.strictEqual(demoRejected.status, 409, '未接入 demo context 必须在 JSON 解析前 fail-closed。');
    assert.strictEqual(demoRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    const invalidJson = await requestRaw(server, 'POST', '/api/carbon/accounting/runs', malformedJson, activityCalculateToken);
    assert.strictEqual(invalidJson.status, 400);
    assert.strictEqual(invalidJson.body.error.details.code, 'CARBON_ACCOUNTING_JSON_INVALID');
    const tooLarge = await requestRaw(server, 'POST', '/api/carbon/accounting/runs', oversizedJson, activityCalculateToken);
    assert.strictEqual(tooLarge.status, 413);
    assert.strictEqual(tooLarge.body.error.code, 'CARBON_ACCOUNTING_JSON_TOO_LARGE');
    assertRedactedError(tooLarge, activityCalculateToken);

    const unknownField = await requestJson(server, 'POST', '/api/carbon/accounting/runs', {
      ...RUN_PERIOD,
      calculationMethod: 'client-controlled'
    }, activityCalculateToken);
    assert.strictEqual(unknownField.status, 400);
    assert.strictEqual(unknownField.body.error.details.code, 'CARBON_ACCOUNTING_UNKNOWN_FIELDS');
    for (const invalidPeriod of [
      { startUtc: '2026-08-24T00:00Z', endUtc: RUN_PERIOD.endUtc },
      { startUtc: '2026-08-24T00:00:00.001Z', endUtc: RUN_PERIOD.endUtc },
      { startUtc: '2026-08-24T00:00:00+00:00', endUtc: RUN_PERIOD.endUtc },
      { startUtc: '2026-08-25T00:00:00Z', endUtc: '2026-08-24T00:00:00Z' }
    ]) {
      assert.strictEqual((await requestJson(
        server, 'POST', '/api/carbon/accounting/runs', invalidPeriod, activityCalculateToken
      )).status, 400);
    }

    const firstCreated = await requestJson(
      server,
      'POST',
      '/api/carbon/accounting/runs',
      { startUtc: '2026-08-24T00:00:00.000Z', endUtc: RUN_PERIOD.endUtc },
      activityCalculateToken
    );
    assert.strictEqual(firstCreated.status, 201);
    assert.strictEqual(firstCreated.body.success, true);
    assert.strictEqual(firstCreated.body.data.startUtc, RUN_PERIOD.startUtc);
    assert.strictEqual(firstCreated.body.data.activityCount, 1);
    assertPublicActorWithoutIp(firstCreated.body.data);
    const firstRunCode = firstCreated.body.data.runCode;
    const actorSnapshotDb = openDatabase();
    try {
      const persistedActorSnapshot = JSON.parse(actorSnapshotDb.prepare(`SELECT actor_snapshot_json AS actorSnapshotJson
        FROM carbon_calculation_runs WHERE run_code = ?`).get(firstRunCode).actorSnapshotJson);
      assert.strictEqual(Object.hasOwn(persistedActorSnapshot.actor, 'ip'), true,
        '内部冻结 actor 快照必须继续保留 IP。');
      assert(persistedActorSnapshot.actor.ip);
    } finally {
      actorSnapshotDb.close();
    }

    assert.strictEqual((await requestJson(
      server, 'POST', '/api/carbon/accounting/runs', RUN_PERIOD, activityViewToken
    )).status, 403, 'activity:view 不能替代 activity:calculate。');
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/runs', undefined, activityCalculateToken
    )).status, 403, 'activity:calculate 不能替代 activity:view。');
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/results'
    )).status, 401, '结果查询必须拒绝匿名访问。');
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/results', undefined, energyViewToken
    )).status, 403, '旧能耗查看权限不得读取默认独立活动来源。');
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/results', undefined, legacyCarbonViewToken
    )).status, 403, '旧 carbon:view 不得扩展给独立活动结果。');

    // 第二次运行必须追加，默认结果读取只解析最新 completed run。
    const secondCreated = await requestJson(
      server, 'POST', '/api/carbon/accounting/runs', RUN_PERIOD, activityCalculateToken
    );
    assert.strictEqual(secondCreated.status, 201);
    const secondRunCode = secondCreated.body.data.runCode;
    assert.notStrictEqual(secondRunCode, firstRunCode);

    const runHistory = await requestJson(server, 'GET', '/api/carbon/accounting/runs?pageSize=1', undefined, activityViewToken);
    assert.strictEqual(runHistory.status, 200);
    assert.strictEqual(runHistory.body.data.length, 1);
    assert.strictEqual(runHistory.body.meta.pagination.total, 2);
    assertPublicActorWithoutIp(runHistory.body.data[0]);
    const runDetail = await requestJson(
      server, 'GET', `/api/carbon/accounting/runs/${encodeURIComponent(firstRunCode)}`, undefined, activityViewToken
    );
    assert.strictEqual(runDetail.status, 200);
    assert.strictEqual(runDetail.body.data.runCode, firstRunCode);
    assertPublicActorWithoutIp(runDetail.body.data);

    // 每个 GET 端点都必须拒绝未知、重复、显式空值和拼写错误，禁止静默忽略。
    const failClosedQueries = [
      ['/api/carbon/accounting/runs?unknownField=1', activityViewToken, 'CARBON_ACCOUNTING_QUERY_UNKNOWN_FIELDS'],
      ['/api/carbon/accounting/results?unknownField=1', activityViewToken, 'CARBON_ACCOUNTING_QUERY_UNKNOWN_FIELDS'],
      ['/api/carbon/accounting/statistics?unknownField=1', activityViewToken, 'CARBON_ACCOUNTING_QUERY_UNKNOWN_FIELDS'],
      ['/api/carbon/accounting/export?unknownField=1', activityExportToken, 'CARBON_ACCOUNTING_QUERY_UNKNOWN_FIELDS'],
      ['/api/carbon/accounting/runs?page=1&page=2', activityViewToken, 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID'],
      ['/api/carbon/accounting/results?sourceType=independent_activity&sourceType=energy_record', activityViewToken,
        'CARBON_ACCOUNTING_SOURCE_TYPE_INVALID'],
      ['/api/carbon/accounting/results?sourceType=independent_activity&source_type=independent_activity', activityViewToken,
        'CARBON_ACCOUNTING_QUERY_DUPLICATE_FIELDS'],
      ['/api/carbon/accounting/results?sourceType=', activityViewToken, 'CARBON_ACCOUNTING_SOURCE_TYPE_INVALID'],
      ['/api/carbon/accounting/statistics?status=', activityViewToken, 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID'],
      ['/api/carbon/accounting/statistics?status=calcluated', activityViewToken, 'CARBON_ACCOUNTING_STATUS_INVALID'],
      ['/api/carbon/accounting/export?format=', activityExportToken, 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID'],
      ['/api/carbon/accounting/export?sourceType=independent-activity', activityExportToken,
        'CARBON_ACCOUNTING_SOURCE_TYPE_INVALID']
    ];
    for (const [pathname, token, expectedDetailsCode] of failClosedQueries) {
      const response = await requestJson(server, 'GET', pathname, undefined, token);
      assert.strictEqual(response.status, 400, `${pathname} 必须 fail-closed。`);
      assert.strictEqual(response.body.error.details.code, expectedDetailsCode);
    }

    // 四个 GET 端点必须通过真实 HTTP 拒绝 extended parser 生成的 object-valued 查询值。
    const objectValuedQueries = [
      ['/api/carbon/accounting/runs?page[value]=1', activityViewToken],
      ['/api/carbon/accounting/results?keyword[value]=x', activityViewToken],
      ['/api/carbon/accounting/statistics?status[value]=calculated', activityViewToken],
      ['/api/carbon/accounting/export?format[value]=csv', activityExportToken]
    ];
    for (const [pathname, token] of objectValuedQueries) {
      const response = await requestJson(server, 'GET', pathname, undefined, token);
      assert.strictEqual(response.status, 400, `${pathname} 必须拒绝 object-valued 查询。`);
      assert.strictEqual(response.body.error.details.code, 'CARBON_ACCOUNTING_QUERY_VALUE_INVALID');
    }

    // page 与 pageSize 单独安全时，乘积 offset 仍必须保持安全整数。
    const unsafeOffsetQueries = [
      ['/api/carbon/accounting/runs?page=9007199254740991&pageSize=200', activityViewToken],
      ['/api/carbon/accounting/results?page=9007199254740991&pageSize=200', activityViewToken],
      ['/api/carbon/accounting/results?sourceType=all&page=9007199254740991&pageSize=200', bothViewToken]
    ];
    for (const [pathname, token] of unsafeOffsetQueries) {
      const response = await requestJson(server, 'GET', pathname, undefined, token);
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body.error.details.code, 'CARBON_ACCOUNTING_OFFSET_INVALID');
    }

    const defaultIndependent = await requestJson(
      server, 'GET', '/api/carbon/accounting/results', undefined, activityViewToken
    );
    assert.strictEqual(defaultIndependent.status, 200);
    assert.strictEqual(defaultIndependent.body.data.sourceType, 'independent_activity');
    assert.strictEqual(defaultIndependent.body.data.run.runCode, secondRunCode);
    assert.strictEqual(defaultIndependent.body.data.pagination.total, 1);
    const historicalIndependent = await requestJson(
      server,
      'GET',
      `/api/carbon/accounting/results?runCode=${encodeURIComponent(firstRunCode)}`,
      undefined,
      activityViewToken
    );
    assert.strictEqual(historicalIndependent.status, 200);
    assert.strictEqual(historicalIndependent.body.data.run.runCode, firstRunCode);
    assert.strictEqual(historicalIndependent.body.data.rows[0].emissionValue, 1);
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/results?runCode=missing-run', undefined, activityViewToken
    )).status, 404);

    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/results?sourceType=energy_record', undefined, activityViewToken
    )).status, 403);
    const energyResults = await requestJson(
      server, 'GET', '/api/carbon/accounting/results?sourceType=energy_record', undefined, energyViewToken
    );
    assert.strictEqual(energyResults.status, 200);
    assert.strictEqual(energyResults.body.data.pagination.total, 2);
    const allWithOnePermission = await requestJson(
      server, 'GET', '/api/carbon/accounting/results?sourceType=all', undefined, activityViewToken
    );
    assert.strictEqual(allWithOnePermission.status, 403, 'all 读取必须同时具备两套查看权限。');
    const allResults = await requestJson(
      server, 'GET', '/api/carbon/accounting/results?sourceType=all&pageSize=1', undefined, bothViewToken
    );
    assert.strictEqual(allResults.status, 200);
    assert.strictEqual(allResults.body.data.crossSourceTotal, null);
    assert.strictEqual(allResults.body.data.facets.independentActivity.rows.length, 1);
    assert.strictEqual(allResults.body.data.facets.independentActivity.pagination.total, 1);
    assert.strictEqual(allResults.body.data.facets.energyRecord.rows.length, 1);
    assert.strictEqual(allResults.body.data.facets.energyRecord.pagination.total, 2);

    // 列表、统计和导出必须共享同一筛选合同。
    const encodedKeyword = encodeURIComponent('@独立活动类别');
    const filteredList = await requestJson(
      server, 'GET', `/api/carbon/accounting/results?keyword=${encodedKeyword}`, undefined, activityViewToken
    );
    const filteredStatistics = await requestJson(
      server, 'GET', `/api/carbon/accounting/statistics?keyword=${encodedKeyword}`, undefined, activityViewToken
    );
    const filteredExport = await requestJson(
      server, 'GET', `/api/carbon/accounting/export?format=csv&keyword=${encodedKeyword}`, undefined, activityExportToken
    );
    assert.strictEqual(filteredList.body.data.pagination.total, 1);
    assert.strictEqual(filteredStatistics.status, 200);
    assert.strictEqual(filteredStatistics.body.data.summary.totalRecords, 1);
    assert.strictEqual(filteredExport.status, 200);
    assert.strictEqual(filteredExport.headers['x-exported-row-count-independent-activity'], '1');
    const independentCsv = filteredExport.buffer.toString('utf8');
    assert(independentCsv.includes("'@独立活动类别"), 'CSV 必须防护 @ 公式前缀。');
    assert(independentCsv.includes("'=独立活动组织"), 'CSV 必须防护 = 公式前缀。');
    assert(independentCsv.includes("'+HTTP因子来源"), 'CSV 必须防护 + 公式前缀。');
    const independentCsvLines = parseNonEmptyCsvLines(filteredExport.buffer);
    assert(independentCsvLines[0].startsWith('"来源类型"'));
    assert(independentCsvLines[1].startsWith('"independent_activity"'));
    const independentXlsxExport = await requestJson(
      server, 'GET', `/api/carbon/accounting/export?format=xlsx&keyword=${encodedKeyword}`, undefined, activityExportToken
    );
    assert.strictEqual(independentXlsxExport.status, 200);
    const independentWorkbook = XLSX.read(independentXlsxExport.buffer, { type: 'buffer' });
    const independentOnlyRows = XLSX.utils.sheet_to_json(independentWorkbook.Sheets['独立碳活动结果'], {
      header: 1,
      raw: false
    });
    assert.strictEqual(independentOnlyRows[0][0], '来源类型');
    assert.strictEqual(independentOnlyRows[1][0], 'independent_activity');

    const energyStatistics = await requestJson(
      server, 'GET', '/api/carbon/accounting/statistics?sourceType=energy_record', undefined, energyViewToken
    );
    assert.strictEqual(energyStatistics.status, 200);
    assert.deepStrictEqual(
      energyStatistics.body.data.totalsByEmissionUnit.map((row) => row.emissionUnit),
      ['kgCO2e', 'tCO2e']
    );
    const allStatistics = await requestJson(
      server, 'GET', '/api/carbon/accounting/statistics?sourceType=all', undefined, bothViewToken
    );
    assert.strictEqual(allStatistics.status, 200);
    assert.strictEqual(allStatistics.body.data.crossSourceTotal, null);
    assert.strictEqual(Object.hasOwn(allStatistics.body.data, 'totalEmissionValue'), false);

    const energyCsvExport = await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=energy_record&format=csv', undefined, energyExportToken
    );
    assert.strictEqual(energyCsvExport.status, 200);
    const energyCsvLines = parseNonEmptyCsvLines(energyCsvExport.buffer);
    assert(energyCsvLines[0].startsWith('"来源类型"'));
    assert(energyCsvLines.slice(1).every((line) => line.startsWith('"energy_record"')));
    const energyXlsxExport = await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=energy_record&format=xlsx', undefined, energyExportToken
    );
    assert.strictEqual(energyXlsxExport.status, 200);
    const energyWorkbook = XLSX.read(energyXlsxExport.buffer, { type: 'buffer' });
    const energyOnlyRows = XLSX.utils.sheet_to_json(energyWorkbook.Sheets['旧能耗结果'], {
      header: 1,
      raw: false
    });
    assert.strictEqual(energyOnlyRows[0][0], '来源类型');
    assert(energyOnlyRows.slice(1).every((row) => row[0] === 'energy_record'));

    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=energy_record&format=csv', undefined, activityExportToken
    )).status, 403);
    assert.strictEqual((await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=all&format=csv', undefined, activityExportToken
    )).status, 403, 'all 导出必须同时具备两套导出权限。');
    const allExport = await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=all&format=csv', undefined, bothExportToken
    );
    assert.strictEqual(allExport.status, 200);
    const allCsv = allExport.buffer.toString('utf8');
    assert(allCsv.includes('来源：独立碳活动'));
    assert(allCsv.includes('来源：旧能耗记录'));
    assert(allCsv.includes("'-旧结果备注"), 'CSV 必须防护 - 公式前缀。');
    const allCsvLines = parseNonEmptyCsvLines(allExport.buffer);
    assert.strictEqual(allCsvLines.filter((line) => line.startsWith('"independent_activity"')).length, 1);
    assert.strictEqual(allCsvLines.filter((line) => line.startsWith('"energy_record"')).length, 2);
    assert.strictEqual(allExport.headers['x-exported-row-count-independent-activity'], '1');
    assert.strictEqual(allExport.headers['x-exported-row-count-energy-record'], '2');
    const allXlsxExport = await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=all&format=xlsx', undefined, bothExportToken
    );
    assert.strictEqual(allXlsxExport.status, 200);
    const workbook = XLSX.read(allXlsxExport.buffer, { type: 'buffer' });
    assert.deepStrictEqual(workbook.SheetNames, ['独立碳活动结果', '旧能耗结果']);
    const independentWorksheetRows = XLSX.utils.sheet_to_json(workbook.Sheets['独立碳活动结果'], {
      header: 1,
      raw: false
    });
    const energyWorksheetRows = XLSX.utils.sheet_to_json(workbook.Sheets['旧能耗结果'], {
      header: 1,
      raw: false
    });
    assert.strictEqual(independentWorksheetRows[0][0], '来源类型');
    assert.strictEqual(independentWorksheetRows[1][0], 'independent_activity');
    assert.strictEqual(energyWorksheetRows[0][0], '来源类型');
    assert(energyWorksheetRows.slice(1).every((row) => row[0] === 'energy_record'));
    assert(independentWorksheetRows.flat().some((value) => String(value).startsWith("'=")));
    assert(energyWorksheetRows.flat().some((value) => String(value).startsWith("'+")));

    // 破坏快照内部结构触发服务异常，HTTP 500 仍不得泄漏 SQL、路径或 token。
    const corruptionDb = openDatabase();
    let originalOrganizationSnapshot;
    try {
      const row = corruptionDb.prepare(`SELECT result.id, result.organization_snapshot_json AS snapshot
        FROM carbon_accounting_results result
        JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id
        WHERE run.run_code = ? LIMIT 1`).get(secondRunCode);
      originalOrganizationSnapshot = row.snapshot;
      corruptionDb.prepare(`UPDATE carbon_accounting_results
        SET organization_snapshot_json = '{"version":1}' WHERE id = ?`).run(row.id);
    } finally {
      corruptionDb.close();
    }
    const maskedInternalError = await requestJson(
      server, 'GET', '/api/carbon/accounting/results', undefined, activityViewToken
    );
    assertFixedAccountingInternalError(maskedInternalError, activityViewToken);
    const restoreDb = openDatabase();
    try {
      restoreDb.prepare(`UPDATE carbon_accounting_results SET organization_snapshot_json = ?
        WHERE calculation_run_id = (SELECT id FROM carbon_calculation_runs WHERE run_code = ?)`)
        .run(originalOrganizationSnapshot, secondRunCode);
    } finally {
      restoreDb.close();
    }

    // POST、运行 GET、结果 GET、统计和导出的未知异常在 development 下仍必须固定脱敏。
    const faultCases = [
      ['create-run', 'POST', '/api/carbon/accounting/runs', RUN_PERIOD, activityCalculateToken],
      ['list-runs', 'GET', '/api/carbon/accounting/runs', undefined, activityViewToken],
      ['get-run', 'GET', `/api/carbon/accounting/runs/${encodeURIComponent(firstRunCode)}`, undefined, activityViewToken],
      ['list-results', 'GET', '/api/carbon/accounting/results', undefined, activityViewToken],
      ['statistics', 'GET', '/api/carbon/accounting/statistics', undefined, activityViewToken],
      ['export', 'GET', '/api/carbon/accounting/export?format=csv', undefined, activityExportToken]
    ];
    for (const [faultStage, method, pathname, body, token] of faultCases) {
      setCarbonAccountingFaultInjectorForTest((stage) => {
        if (stage === faultStage) {
          throw new Error(`SELECT secret FROM ${process.env.SQLITE_PATH}; token=${token}`);
        }
      });
      const response = await requestJson(server, method, pathname, body, token);
      setCarbonAccountingFaultInjectorForTest(null);
      assertFixedAccountingInternalError(response, token);
    }

    // RBAC 前置中间件的原生 SQLite 异常也必须被 accounting router 领域边界固定脱敏。
    const rbacFaultCases = [
      ['POST', '/api/carbon/accounting/runs', RUN_PERIOD, activityCalculateToken],
      ['GET', '/api/carbon/accounting/runs', undefined, activityViewToken],
      ['GET', `/api/carbon/accounting/runs/${encodeURIComponent(firstRunCode)}`, undefined, activityViewToken],
      ['GET', '/api/carbon/accounting/results', undefined, activityViewToken],
      ['GET', '/api/carbon/accounting/statistics', undefined, activityViewToken],
      ['GET', '/api/carbon/accounting/export?format=csv', undefined, activityExportToken]
    ];
    const rbacFaultDb = openDatabase();
    try {
      rbacFaultDb.prepare('ALTER TABLE sys_roles RENAME TO sys_roles_accounting_fault').run();
    } finally {
      rbacFaultDb.close();
    }
    const rbacFaultResponses = [];
    try {
      for (const [method, pathname, body, token] of rbacFaultCases) {
        rbacFaultResponses.push({
          response: await requestJson(server, method, pathname, body, token),
          token
        });
      }
    } finally {
      const restoreRbacDb = openDatabase();
      try {
        restoreRbacDb.prepare('ALTER TABLE sys_roles_accounting_fault RENAME TO sys_roles').run();
      } finally {
        restoreRbacDb.close();
      }
    }
    rbacFaultResponses.forEach(({ response, token }) => {
      assertFixedAccountingInternalError(response, token);
    });

    // 两来源各以两个有限单值制造 SUM Infinity，service 与三条 HTTP 来源路径均必须 fail-closed。
    seedNonFiniteStatisticsFacts(secondRunCode, facts);
    for (const query of [
      { sourceType: 'independent_activity' },
      { sourceType: 'energy_record' },
      { sourceType: 'all' }
    ]) {
      assert.throws(
        () => getCarbonAccountingStatistics(query),
        assertNonFiniteStatisticsError
      );
    }
    const nonFiniteStatisticsHttpCases = [
      ['/api/carbon/accounting/statistics', activityViewToken],
      ['/api/carbon/accounting/statistics?sourceType=energy_record', energyViewToken],
      ['/api/carbon/accounting/statistics?sourceType=all', bothViewToken]
    ];
    for (const [pathname, token] of nonFiniteStatisticsHttpCases) {
      const response = await requestJson(server, 'GET', pathname, undefined, token);
      assertNonFiniteStatisticsError(response);
      assertRedactedError(response, token);
    }

    // 旧能耗来源用第 5001 行识别导出超限并拒绝，不允许静默截断。
    const limitDb = openDatabase();
    try {
      const insertOverflowEnergyRecord = limitDb.prepare(`INSERT INTO energy_records
        (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
         original_value, normalized_unit, normalized_value, duplicate_key, record_status)
        VALUES (?, ?, '2026-08', '2026-08', 'unit', 8, 'unit', 8, ?, 'active')`);
      const insertOverflowEmission = limitDb.prepare(`INSERT INTO carbon_emissions
        (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value,
         activity_value, activity_unit, emission_value, emission_unit, status, note)
        VALUES (?, ?, 'standard-factor', 'export-limit', 0.25, 8, 'unit', 2, 'kgCO2e',
         'calculated', 'export-limit')`);
      limitDb.transaction(() => {
        for (let index = 0; index < 4999; index += 1) {
          const energyRecordId = insertOverflowEnergyRecord
            .run(facts.energyTypeId, facts.organizationUnitId, `accounting-export-limit-${index}`)
            .lastInsertRowid;
          insertOverflowEmission.run(energyRecordId, facts.carbonFactorId);
        }
      })();
    } finally {
      limitDb.close();
    }
    const exportLimit = await requestJson(
      server, 'GET', '/api/carbon/accounting/export?sourceType=energy_record&format=csv', undefined, energyExportToken
    );
    assert.strictEqual(exportLimit.status, 400);
    assert.strictEqual(exportLimit.body.error.details.code, 'CARBON_ACCOUNTING_EXPORT_LIMIT_EXCEEDED');
    assertRedactedError(exportLimit, energyExportToken);

    console.log('carbonAccountingRoutes tests passed');
  } finally {
    setCarbonAccountingFaultInjectorForTest(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
