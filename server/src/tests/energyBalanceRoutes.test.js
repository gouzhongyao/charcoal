'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

// Router 测试仅使用系统临时目录、隔离 SQLite 和随机端口。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-balance-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-balance-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyBalanceRoutes = require('../routes/energyBalances');
const {
  BALANCE_CALCULATE_PERMISSION,
  BALANCE_MANAGE_PERMISSION,
  BALANCE_SUGGESTION_REVIEW_PERMISSION,
  BALANCE_VIEW_PERMISSION
} = energyBalanceRoutes;
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 独立 Router 测试挂载路径；中央 index.js 保持未修改。
const ROUTE_BASE = '/api/energy-balances';
// 测试平衡窗口开始时间。
const START_UTC = '2026-07-01T00:00:00.000Z';
// 测试平衡窗口结束时间。
const END_UTC = '2026-08-01T00:00:00.000Z';
// 测试边界有效期开始时间。
const EFFECTIVE_START_UTC = '2026-01-01T00:00:00.000Z';
// 测试边界有效期结束时间。
const EFFECTIVE_END_UTC = '2027-01-01T00:00:00.000Z';
// 收集响应以统一检查信封和脱敏。
const observedResponses = [];

/**
 * 发起真实 HTTP JSON 请求。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname 请求路径。
 * @param {*} body 可选正文。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} HTTP 响应。
 */
function requestJson(server, method, pathname, body, token = null) {
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
        const text = Buffer.concat(chunks).toString('utf8');
        const result = {
          status: response.statusCode,
          body: text ? JSON.parse(text) : null,
          text
        };
        observedResponses.push(result);
        resolve(result);
      });
    });
    request.on('error', reject);
    if (rawBody !== null) request.write(rawBody);
    request.end();
  });
}

/**
 * 断言统一成功或失败响应信封。
 * @param {object} response HTTP 响应。
 * @param {boolean} expectedSuccess 预期成功标记。
 */
function assertUnifiedEnvelope(response, expectedSuccess) {
  assert(response.body && typeof response.body === 'object');
  assert.strictEqual(response.body.success, expectedSuccess);
  assert(response.body.meta && typeof response.body.meta.timestamp === 'string');
  assert.strictEqual(new Date(response.body.meta.timestamp).toISOString(), response.body.meta.timestamp);
  if (expectedSuccess) {
    assert(Object.prototype.hasOwnProperty.call(response.body, 'data'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body, 'error'), false);
  } else {
    assert(response.body.error && typeof response.body.error.code === 'string');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body, 'data'), false);
  }
}

/**
 * 断言响应未泄露底层路径、SQLite 错误或堆栈。
 * @param {object} response HTTP 响应。
 */
function assertNoSensitiveData(response) {
  const serialized = JSON.stringify(response.body).replace(/\\/g, '/');
  assert(!serialized.includes(tmpDir.replace(/\\/g, '/')));
  assert(!serialized.includes(process.env.SQLITE_PATH.replace(/\\/g, '/')));
  assert(!serialized.includes(process.env.CHARCOAL_ADMIN_PASSWORD));
  assert(!serialized.includes('SqliteError'));
  assert(!serialized.includes('SQLITE_'));
  assert(!serialized.includes('node:internal'));
}

/**
 * 向普通账号授予隔离测试权限。
 * @param {string} username 用户名。
 * @param {string[]} permissionCodes 权限编码。
 */
function grantPermissions(username, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    assert(user);
    const roleId = Number(db.prepare(
      `INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`
    ).run(`balance-routes-${username}`, `${username} 平衡测试角色`, now, now).lastInsertRowid);
    const insertMenu = db.prepare(
      `INSERT INTO sys_menus (
         menu_type, menu_name, permission_code, sort_order, visible,
         status, is_builtin, created_at, updated_at
       ) VALUES ('button', ?, ?, 0, 0, 'active', 0, ?, ?)
       ON CONFLICT(permission_code) DO NOTHING`
    );
    permissionCodes.forEach((permissionCode) => {
      insertMenu.run(permissionCode, permissionCode, now, now);
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      db.prepare(
        'INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)'
      ).run(roleId, menu.id, now);
    });
    db.prepare(
      'INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)'
    ).run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

/**
 * 初始化 Router 成功链路使用的组织、能源和折标系数。
 * @returns {object} 主数据 ID 和单位。
 */
function seedBalanceData() {
  const db = openDatabase();
  try {
    const electricity = db.prepare(
      `SELECT id, standard_unit AS standardUnit FROM energy_types WHERE code = 'electricity'`
    ).get();
    const organizationUnitId = Number(db.prepare(
      `INSERT INTO organization_units (
         unit_code, unit_name, unit_path, unit_type, status
       ) VALUES ('BALANCE-ROUTES-ORG', '平衡路由测试组织', '/BALANCE-ROUTES-ORG', 'enterprise', 'active')`
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, target_unit,
         display_unit, display_divisor, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('BALANCE-ROUTES-FACTOR', ?, ?, 0.1229, 'kgce', 'tce', 1000,
                 'test', 'TEST-DOC', 'routes:v1', ?, ?, 'Asia/Shanghai', 'active')`
    ).run(electricity.id, electricity.standardUnit, EFFECTIVE_START_UTC, EFFECTIVE_END_UTC);
    return {
      electricityId: Number(electricity.id),
      electricityUnit: electricity.standardUnit,
      organizationUnitId
    };
  } finally {
    db.close();
  }
}

/**
 * 启动只挂载独立平衡 Router 的随机端口 Express 服务。
 * @returns {Promise<object>} HTTP 服务。
 */
function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(ROUTE_BASE, energyBalanceRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 运行独立 Router 权限、维护态、白名单和成功闭环测试。
 */
async function run() {
  initDatabase();
  register({ username: 'balance-denied', password: 'Password123!' });
  register({ username: 'balance-view', password: 'Password123!' });
  register({ username: 'balance-full', password: 'Password123!' });
  grantPermissions('balance-view', [BALANCE_VIEW_PERMISSION]);
  grantPermissions('balance-full', [
    BALANCE_VIEW_PERMISSION,
    BALANCE_MANAGE_PERMISSION,
    BALANCE_CALCULATE_PERMISSION,
    BALANCE_SUGGESTION_REVIEW_PERMISSION
  ]);
  const tokens = {
    denied: login({ username: 'balance-denied', password: 'Password123!' }).token,
    view: login({ username: 'balance-view', password: 'Password123!' }).token,
    full: login({ username: 'balance-full', password: 'Password123!' }).token
  };
  const ids = seedBalanceData();
  const server = await startServer();
  try {
    // 未登录、无权限和只读账号写操作均被既有中间件阻断。
    const unauthenticated = await requestJson(server, 'GET', `${ROUTE_BASE}/contract`, undefined);
    assert.strictEqual(unauthenticated.status, 401);
    const forbiddenView = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/boundaries`,
      undefined,
      tokens.denied
    );
    assert.strictEqual(forbiddenView.status, 403);
    const forbiddenWrite = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/boundaries`,
      {},
      tokens.view
    );
    assert.strictEqual(forbiddenWrite.status, 403);

    // Express JSON 正文超过 2MB 时统一返回稳定 413，不泄露正文、路径或解析器信息。
    const oversizedMarker = 'OVERSIZED-BALANCE-PAYLOAD-MARKER';
    const oversizedResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/boundaries/1/snapshots/calculate`,
      { payload: `${oversizedMarker}${'x'.repeat((2 * 1024 * 1024) + 1024)}` },
      tokens.full
    );
    assert.strictEqual(oversizedResponse.status, 413);
    assert.strictEqual(oversizedResponse.body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.strictEqual(oversizedResponse.body.error.message, '请求正文超过允许大小。');
    assert.strictEqual(oversizedResponse.body.error.details, null);
    assert(!oversizedResponse.text.includes(oversizedMarker));
    assert(!oversizedResponse.text.includes('entity.too.large'));

    // 查看权限可读取契约，独立 Router 不声明无法自证的中央挂载状态。
    const contract = await requestJson(server, 'GET', `${ROUTE_BASE}/contract`, undefined, tokens.view);
    assert.strictEqual(contract.status, 200);
    assert.strictEqual(contract.body.data.roles.length, 9);
    assert.strictEqual(contract.body.data.suggestions.usesAI, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(contract.body.meta, 'centrallyMounted'), false);

    // 边界创建使用白名单，额外 status 字段不得绕过默认启用状态。
    const boundaryResponse = await requestJson(server, 'POST', `${ROUTE_BASE}/boundaries`, {
      boundaryCode: 'BALANCE-ROUTES',
      boundaryName: '平衡路由测试边界',
      organizationUnitId: ids.organizationUnitId,
      source: '测试定义',
      documentNo: 'ROUTES-DOC',
      version: 'v1',
      effectiveStartUtc: EFFECTIVE_START_UTC,
      effectiveEndUtc: EFFECTIVE_END_UTC,
      sourceTimeZone: 'Asia/Shanghai',
      generationBoundaryConfirmed: false,
      status: 'inactive',
      unknownSql: 'DROP TABLE energy_balance_boundaries'
    }, tokens.full);
    assert.strictEqual(boundaryResponse.status, 201);
    assert.strictEqual(boundaryResponse.body.data.status, 'active');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(boundaryResponse.body.data, 'unknownSql'), false);
    const boundaryId = boundaryResponse.body.data.id;

    // 九角色项目维护和快照计算走独立权限及维护态保护。
    const itemResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/boundaries/${boundaryId}/items`,
      {
        itemCode: 'ROUTES-INPUT',
        itemName: '路由输入项目',
        role: 'input',
        energyTypeId: ids.electricityId,
        originalUnit: ids.electricityUnit,
        sourceType: 'explicit_balance_value',
        sourceMapping: { reference: 'routes:input', value: 100 },
        status: 'inactive'
      },
      tokens.full
    );
    assert.strictEqual(itemResponse.status, 201);
    assert.strictEqual(itemResponse.body.data.status, 'active');

    // 维护态允许 GET，只阻断采用 authenticate→permission→requireWritable 的写路由。
    await runWithMaintenance('energy-balance-routes-test', async () => {
      const readable = await requestJson(
        server,
        'GET',
        `${ROUTE_BASE}/boundaries`,
        undefined,
        tokens.view
      );
      assert.strictEqual(readable.status, 200);
      const lockedWrite = await requestJson(
        server,
        'PATCH',
        `${ROUTE_BASE}/boundaries/${boundaryId}/status`,
        { status: 'inactive' },
        tokens.full
      );
      assert.strictEqual(lockedWrite.status, 423);
      assert.strictEqual(lockedWrite.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    });

    const calculationResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/boundaries/${boundaryId}/snapshots/calculate`,
      { startUtc: START_UTC, endUtc: END_UTC, ignored: 'not-forwarded' },
      tokens.full
    );
    assert.strictEqual(calculationResponse.status, 201);
    assert.strictEqual(calculationResponse.body.data.originalFacets.length, 1);
    assert.strictEqual(calculationResponse.body.data.comprehensive.calculationStatus, 'available');
    assert.match(calculationResponse.body.data.calculationRunId, /^[0-9a-f-]{36}$/);
    assert(calculationResponse.body.data.suggestions.length >= 1);
    const snapshotId = calculationResponse.body.data.originalFacets[0].snapshotId;
    const suggestionId = calculationResponse.body.data.suggestions[0].id;

    // run 级分页以 calculationRunId 为单位，旧分面列表和按 run 完整读取继续兼容。
    const repeatedCalculationResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/boundaries/${boundaryId}/snapshots/calculate`,
      { startUtc: START_UTC, endUtc: END_UTC },
      tokens.full
    );
    assert.strictEqual(repeatedCalculationResponse.status, 201);
    const firstRunPage = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots?view=runs&boundaryId=${boundaryId}&page=1&pageSize=1`,
      undefined,
      tokens.view
    );
    const secondRunPage = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots?view=runs&boundaryId=${boundaryId}&page=2&pageSize=1`,
      undefined,
      tokens.view
    );
    assert.strictEqual(firstRunPage.status, 200);
    assert.strictEqual(firstRunPage.body.meta.paginationUnit, 'calculationRunId');
    assert.strictEqual(firstRunPage.body.meta.pagination.total, 2);
    assert.strictEqual(firstRunPage.body.data[0].facetCount, 1);
    assert(Number.isInteger(firstRunPage.body.data[0].representativeSnapshotId));
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(firstRunPage.body.data[0], 'snapshots'),
      false
    );
    assert.notStrictEqual(
      firstRunPage.body.data[0].calculationRunId,
      secondRunPage.body.data[0].calculationRunId
    );
    const fullRunResponse = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots/runs/${calculationResponse.body.data.calculationRunId}`,
      undefined,
      tokens.view
    );
    assert.strictEqual(fullRunResponse.status, 200);
    assert.strictEqual(fullRunResponse.body.data.snapshots.length, 1);
    const legacyFacetPage = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots?boundaryId=${boundaryId}&page=1&pageSize=1`,
      undefined,
      tokens.view
    );
    assert.strictEqual(legacyFacetPage.body.meta.paginationUnit, 'snapshotFacet');
    assert.strictEqual(legacyFacetPage.body.meta.pagination.total, 2);

    // 详情内嵌建议保留兼容首屏，但必须显式返回总数、分页元数据和 hasMore。
    const extraSuggestionCount = 205;
    const suggestionFixtureDb = openDatabase();
    try {
      const insertSuggestion = suggestionFixtureDb.prepare(`INSERT INTO energy_balance_suggestions (
        calculation_run_id, energy_balance_snapshot_id, suggestion_code, title,
        content, priority, evidence_json
      ) VALUES (?, ?, ?, ?, ?, 'low', ?)`);
      suggestionFixtureDb.transaction(() => {
        for (let index = 0; index < extraSuggestionCount; index += 1) {
          insertSuggestion.run(
            calculationResponse.body.data.calculationRunId,
            snapshotId,
            `ROUTES-EXTRA-${String(index).padStart(3, '0')}`,
            `额外建议 ${index}`,
            '用于验证详情建议分页元数据。',
            JSON.stringify({ source: 'route-test', index })
          );
        }
      })();
    } finally {
      suggestionFixtureDb.close();
    }
    const snapshotResponse = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots/${snapshotId}`,
      undefined,
      tokens.view
    );
    assert.strictEqual(snapshotResponse.status, 200);
    assert.strictEqual(snapshotResponse.body.data.items.length, 1);
    assert.strictEqual(snapshotResponse.body.data.calculationGroup.comprehensive.inputTotalKgce, 12.29);
    assert.strictEqual(snapshotResponse.body.data.suggestions.length, 100);
    assert.strictEqual(
      snapshotResponse.body.data.suggestionTotal,
      calculationResponse.body.data.suggestions.length + extraSuggestionCount
    );
    const suggestionContinuation = snapshotResponse.body.data.suggestionPagination;
    assert.strictEqual(suggestionContinuation.page, 1);
    assert.strictEqual(suggestionContinuation.pageSize, 100);
    assert.strictEqual(suggestionContinuation.hasMore, true);
    assert.strictEqual(suggestionContinuation.nextPage, 2);
    assert.strictEqual(snapshotResponse.body.data.suggestionsHasMore, suggestionContinuation.hasMore);
    const nextSuggestionPage = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/suggestions?calculationRunId=${encodeURIComponent(calculationResponse.body.data.calculationRunId)}`
        + `&page=${suggestionContinuation.nextPage}&pageSize=${suggestionContinuation.pageSize}`,
      undefined,
      tokens.view
    );
    assert.strictEqual(nextSuggestionPage.status, 200);
    assert.strictEqual(
      nextSuggestionPage.body.meta.pagination.total,
      snapshotResponse.body.data.suggestionTotal
    );
    assert.strictEqual(nextSuggestionPage.body.meta.pagination.page, suggestionContinuation.nextPage);
    assert.strictEqual(nextSuggestionPage.body.meta.pagination.pageSize, suggestionContinuation.pageSize);
    assert.strictEqual(nextSuggestionPage.body.meta.pagination.hasMore, true);
    assert.strictEqual(nextSuggestionPage.body.meta.pagination.nextPage, 3);
    assert.strictEqual(nextSuggestionPage.body.data.length, 100);

    // 建议仅支持人工状态更新，且无预计节能量和自动执行字段。
    const acceptedResponse = await requestJson(
      server,
      'PATCH',
      `${ROUTE_BASE}/suggestions/${suggestionId}/status`,
      { manualStatus: 'accepted', reviewNote: '人工接受', autoExecute: true },
      tokens.full
    );
    assert.strictEqual(acceptedResponse.status, 200);
    assert.strictEqual(acceptedResponse.body.data.manualStatus, 'accepted');
    assert.strictEqual(acceptedResponse.body.data.estimatedSaving, null);
    assert.strictEqual(acceptedResponse.body.data.automationBoundary.issuesControlCommand, false);
    const resolvedResponse = await requestJson(
      server,
      'PATCH',
      `${ROUTE_BASE}/suggestions/${suggestionId}/status`,
      { manualStatus: 'resolved', reviewNote: '人工核查完成' },
      tokens.full
    );
    assert.strictEqual(resolvedResponse.status, 200);
    assert.strictEqual(resolvedResponse.body.data.manualStatus, 'resolved');

    // 查询分页上限和未知路由必须返回稳定错误信封。
    const pageTooLarge = await requestJson(
      server,
      'GET',
      `${ROUTE_BASE}/snapshots?pageSize=101`,
      undefined,
      tokens.view
    );
    assert.strictEqual(pageTooLarge.status, 400);
    assert.strictEqual(pageTooLarge.body.error.details.code, 'BALANCE_PAGE_SIZE_EXCEEDED');
    const unknownRoute = await requestJson(
      server,
      'DELETE',
      `${ROUTE_BASE}/snapshots/${snapshotId}`,
      undefined,
      tokens.full
    );
    assert.strictEqual(unknownRoute.status, 404);

    // 所有响应统一包含 success/data|error/meta 且不泄露底层实现。
    observedResponses.forEach((response) => {
      assertUnifiedEnvelope(response, response.status >= 200 && response.status < 300);
      assertNoSensitiveData(response);
    });
    const db = openDatabase();
    try {
      const fullUser = db.prepare("SELECT id FROM sys_users WHERE username = 'balance-full'").get();
      const auditRows = db.prepare(`SELECT operation, target_type AS targetType,
          target_id AS targetId, detail_json AS detailJson, user_id AS userId
        FROM sys_operation_logs
        WHERE operation LIKE 'energy.balance.%'
        ORDER BY id`).all();
      assert.strictEqual(auditRows.length, 6, '边界、项目、两次计算和两次建议复核必须记录统一审计。');
      assert(auditRows.every((row) => Number(row.userId) === Number(fullUser.id)));
      assert(auditRows.every((row) => {
        const detail = JSON.parse(row.detailJson);
        return Object.prototype.hasOwnProperty.call(detail, 'before')
          && Object.prototype.hasOwnProperty.call(detail, 'after');
      }));
      assert(auditRows.some((row) => row.operation === 'energy.balance.snapshot.calculate'
        && row.targetId === calculationResponse.body.data.calculationRunId));
      assert.strictEqual(resolvedResponse.body.data.reviewedByUserId, Number(fullUser.id));
      assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
    console.log('energyBalanceRoutes tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
