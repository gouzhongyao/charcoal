'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 中央集成测试只使用系统临时目录和隔离 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-central-integration-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'central-integration.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { runWithMaintenance } = require('../services/maintenanceState');

// 四个前置 Router 的写入口、请求体上限和权限契约。
const PRE_PARSER_ROUTE_CASES = [
  {
    pathname: '/api/energy-analysis/imports/timeseries/execute',
    oversizedBytes: (2 * 1024 * 1024) + 1024
  },
  {
    pathname: '/api/energy-benchmarks/imports/definitions/execute',
    oversizedBytes: (64 * 1024) + 1024
  },
  {
    pathname: '/api/energy-flow-imports/nodes/execute',
    oversizedBytes: (64 * 1024) + 1024
  },
  {
    pathname: '/api/energy-benchmarks/definitions',
    oversizedBytes: (256 * 1024) + 1024
  }
];

/**
 * 发起原始 HTTP 请求并解析统一 JSON 响应。
 * @param {object} server HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname 请求路径。
 * @param {string|Buffer|null} rawBody 原始请求体。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} 状态码和响应体。
 */
function requestRaw(server, method, pathname, rawBody = null, token = null) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = rawBody === null ? Buffer.alloc(0) : Buffer.from(rawBody);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
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
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (_error) {
          body = { raw: text };
        }
        resolve({ status: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.end(bodyBuffer);
  });
}

/**
 * 发起 JSON 请求。
 * @param {object} server HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname 请求路径。
 * @param {*} body JSON 正文。
 * @param {string|null} token Bearer Token。
 * @returns {Promise<object>} 状态码和响应体。
 */
function requestJson(server, method, pathname, body, token = null) {
  return requestRaw(
    server,
    method,
    pathname,
    body === undefined ? null : JSON.stringify(body),
    token
  );
}

/**
 * 创建没有任何菜单权限的普通测试用户。
 */
function seedDeniedUser() {
  const db = openDatabase();
  try {
    const nowUtc = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES ('central_denied', '中央集成无权限角色', 'active', ?, ?)`).run(nowUtc, nowUtc).lastInsertRowid);
    const userId = Number(db.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, created_at, updated_at)
      VALUES ('central-denied', '中央集成无权限用户', ?, 'active', ?, ?)`).run(
      bcrypt.hashSync('Password123!', 10),
      nowUtc,
      nowUtc
    ).lastInsertRowid);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, nowUtc);
    db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('CENTRAL-OU', '中央集成组织', '/中央集成组织', 'enterprise', 'active')`).run();
  } finally {
    db.close();
  }
}

/**
 * 登录并返回会话令牌。
 * @param {object} server HTTP 服务。
 * @param {string} username 用户名。
 * @param {string} password 密码。
 * @returns {Promise<string>} 会话令牌。
 */
async function login(server, username, password) {
  const response = await requestJson(server, 'POST', '/api/login', { username, password });
  assert.strictEqual(response.status, 200, `${username} 必须登录成功。`);
  return response.body.data.token;
}

/**
 * 验证中央挂载后的四个只读业务 API 认证、授权和成功链路。
 * @param {object} server HTTP 服务。
 * @param {string} adminToken 超级管理员令牌。
 * @param {string} deniedToken 无权限用户令牌。
 */
async function testCentralReadRoutes(server, adminToken, deniedToken) {
  const readPaths = [
    '/api/energy-analysis/config/shifts',
    '/api/energy-benchmarks/definitions',
    '/api/energy-flows/models',
    '/api/energy-balances/contract'
  ];
  for (const pathname of readPaths) {
    assert.strictEqual((await requestJson(server, 'GET', pathname, undefined)).status, 401, `${pathname} 匿名访问必须返回 401。`);
    assert.strictEqual((await requestJson(server, 'GET', pathname, undefined, deniedToken)).status, 403, `${pathname} 无权限访问必须返回 403。`);
    assert.strictEqual((await requestJson(server, 'GET', pathname, undefined, adminToken)).status, 200, `${pathname} 授权访问不得返回 404。`);
  }
  await runWithMaintenance('central-read-route-test', async () => {
    assert.strictEqual(
      (await requestJson(server, 'GET', '/api/energy-balances/contract', undefined, adminToken)).status,
      200,
      '维护态不得阻断平衡只读契约。'
    );
  });
}

/**
 * 验证认证、权限和维护态均先于前置 Router 的 JSON 解析器。
 * @param {object} server HTTP 服务。
 * @param {string} adminToken 超级管理员令牌。
 * @param {string} deniedToken 无权限用户令牌。
 */
async function testPreParserRouteOrder(server, adminToken, deniedToken) {
  const malformedJson = '{"invalid":';
  for (const routeCase of PRE_PARSER_ROUTE_CASES) {
    const oversizedJson = JSON.stringify({ padding: 'x'.repeat(routeCase.oversizedBytes) });
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, malformedJson)).status,
      401,
      `${routeCase.pathname} 匿名畸形 JSON 必须先返回 401。`
    );
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, oversizedJson)).status,
      401,
      `${routeCase.pathname} 匿名超限 JSON 必须先返回 401。`
    );
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, malformedJson, deniedToken)).status,
      403,
      `${routeCase.pathname} 无权限畸形 JSON 必须先返回 403。`
    );
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, oversizedJson, deniedToken)).status,
      403,
      `${routeCase.pathname} 无权限超限 JSON 必须先返回 403。`
    );
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, malformedJson, adminToken)).status,
      400,
      `${routeCase.pathname} 授权畸形 JSON 必须返回 400。`
    );
    assert.strictEqual(
      (await requestRaw(server, 'POST', routeCase.pathname, oversizedJson, adminToken)).status,
      413,
      `${routeCase.pathname} 授权超限 JSON 必须返回 413。`
    );
    await runWithMaintenance(`central-parser-order:${routeCase.pathname}`, async () => {
      assert.strictEqual(
        (await requestRaw(server, 'POST', routeCase.pathname, malformedJson, adminToken)).status,
        423,
        `${routeCase.pathname} 维护态必须在 JSON 解析前返回 423。`
      );
    });
  }
}

/**
 * 验证正常业务写入及操作审计均通过中央应用完成。
 * @param {object} server HTTP 服务。
 * @param {string} adminToken 超级管理员令牌。
 */
async function testCentralBusinessWrite(server, adminToken) {
  const response = await requestJson(server, 'POST', '/api/energy-benchmarks/definitions', {
    benchmarkCode: 'CENTRAL-BENCHMARK',
    benchmarkName: '中央集成企业能效目标',
    benchmarkType: 'manual_benchmark',
    metricCode: 'energy_intensity',
    unit: 'kgce/t',
    periodType: 'month',
    scopeType: 'organization',
    scopeReference: 'CENTRAL-OU',
    direction: 'lower_better',
    source: '中央集成测试',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active'
  }, adminToken);
  assert.strictEqual(response.status, 200, `中央对标写接口必须成功：${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.success, true);
  const db = openDatabase();
  try {
    const audit = db.prepare(`SELECT user_id AS userId
      FROM sys_operation_logs
      WHERE operation = 'energy.benchmark.definition.create'
      ORDER BY id DESC LIMIT 1`).get();
    assert(audit && Number(audit.userId) > 0, '中央业务写必须记录有效操作者。');
  } finally {
    db.close();
  }
}

/**
 * 验证具体前缀优先且父 Router 不会误吞导入子路径。
 * @param {object} server HTTP 服务。
 * @param {string} adminToken 超级管理员令牌。
 */
async function testPrefixIsolation(server, adminToken) {
  for (const pathname of [
    '/api/energy-analysis/imports/not-a-route',
    '/api/energy-benchmarks/imports/not-a-route',
    '/api/energy-flow-imports/not-a-route'
  ]) {
    assert.strictEqual(
      (await requestJson(server, 'GET', pathname, undefined, adminToken)).status,
      404,
      `${pathname} 不得误路由到父级业务 Router。`
    );
  }
}

/**
 * 执行中央 Express 集成测试。
 */
async function run() {
  let server = null;
  try {
    initDatabase();
    seedDeniedUser();
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const adminToken = await login(server, 'admin', 'AdminPassword123!');
    const deniedToken = await login(server, 'central-denied', 'Password123!');
    await testCentralReadRoutes(server, adminToken, deniedToken);
    await testPreParserRouteOrder(server, adminToken, deniedToken);
    await testCentralBusinessWrite(server, adminToken);
    await testPrefixIsolation(server, adminToken);
    console.log('energy analysis central integration tests passed');
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
