const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 中控 API 测试使用独立临时目录和 SQLite，避免影响本地业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-dashboard-summary-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'dashboard-summary.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');
const { assignRoleMenus, createRole } = require('../services/roleService');
const { createUser } = require('../services/userService');

// 权限矩阵测试账号统一使用隔离环境密码。
const TEST_PASSWORD = 'DashboardPassword123!';
// 能耗查看权限兼容集合与正式能耗记录路由保持一致。
const ENERGY_VIEW_PERMISSIONS = Object.freeze(['energy:records:view', 'energy-records:view', 'energy:statistics:view']);

// 通过真实 HTTP 链路验证中控认证、权限裁剪、参数校验和响应契约。
function request(server, method, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.body === undefined ? '' : JSON.stringify(options.body);
    const requestInstance = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody)
        })
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          json: body ? JSON.parse(body) : null
        });
      });
    });
    requestInstance.on('error', reject);
    requestInstance.end(rawBody);
  });
}

// 准备跨年、跨单位和作废记录，验证年度边界与 active 统计口径。
function seedDashboardFixtures() {
  const db = openDatabase();
  try {
    const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const heatId = db.prepare("SELECT id FROM energy_types WHERE code = 'heat'").get().id;
    const insertEnergyRecord = db.prepare(`INSERT INTO energy_records (
      energy_type_id, original_month, normalized_month, original_unit, original_value,
      normalized_unit, normalized_value, duplicate_key, record_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);
    insertEnergyRecord.run(electricityId, '2024-12', '2024-12', 'kWh', 50, 'kWh', 50, 'dashboard-2024-electricity', 'active');
    insertEnergyRecord.run(electricityId, '2025-01', '2025-01', 'kWh', 100, 'kWh', 100, 'dashboard-2025-electricity-kwh', 'active');
    insertEnergyRecord.run(electricityId, '2025-06', '2025-06', 'MWh', 2, 'MWh', 2, 'dashboard-2025-electricity-mwh', 'active');
    insertEnergyRecord.run(heatId, '2025-12', '2025-12', 'MJ', 300, 'MJ', 300, 'dashboard-2025-heat', 'active');
    insertEnergyRecord.run(electricityId, '2025-08', '2025-08', 'kWh', 999, 'kWh', 999, 'dashboard-2025-void', 'void');
    insertEnergyRecord.run(electricityId, '2026-01', '2026-01', 'kWh', 70, 'kWh', 70, 'dashboard-2026-electricity', 'active');

    const batchId = db.prepare(`INSERT INTO import_batches (
      import_type, original_filename, file_type, status, total_rows,
      success_count, failure_count, skipped_count, duplicate_strategy
    ) VALUES ('energy_record', '中控审计.csv', 'csv', 'completed_with_errors', 3, 1, 1, 1, 'skip')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO import_errors (
      batch_id, row_number, field_name, raw_value, error_code, error_reason, severity
    ) VALUES (?, 2, 'value', 'bad', 'DASHBOARD_TEST_ERROR', '中控测试错误', 'error')`).run(batchId);
    db.prepare(`INSERT INTO import_errors (
      batch_id, row_number, field_name, raw_value, error_code, error_reason, severity
    ) VALUES (?, 3, 'duplicate', 'same', 'DASHBOARD_TEST_WARNING', '中控测试警告', 'warning')`).run(batchId);
  } finally {
    db.close();
  }
}

// 获取或创建权限菜单，兼容测试历史能耗查看权限编码。
function ensurePermissionMenu(permissionCode) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sys_menus (
      menu_type, menu_name, permission_code, sort_order, visible,
      status, is_builtin, created_at, updated_at
    ) VALUES ('button', ?, ?, 0, 0, 'active', 0, ?, ?)
    ON CONFLICT(permission_code) DO NOTHING`).run(permissionCode, permissionCode, now, now);
    return Number(db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode).id);
  } finally {
    db.close();
  }
}

// 创建真实普通角色与账号，并按权限编码授予菜单。
function createPermissionAccount(accountKey, permissionCodes) {
  const role = createRole({
    roleCode: `dashboard-${accountKey}`,
    roleName: `中控权限测试-${accountKey}`
  });
  const menuIds = permissionCodes.map(ensurePermissionMenu);
  assignRoleMenus(role.id, menuIds);
  const user = createUser({
    username: `dashboard_${accountKey}`,
    displayName: `中控测试-${accountKey}`,
    password: TEST_PASSWORD,
    roleIds: [role.id]
  });
  return { username: user.username, userId: Number(user.id), permissionCodes: [...permissionCodes].sort() };
}

// 建立要求覆盖的五种非管理员角色权限组合。
function createPermissionMatrixAccounts() {
  return {
    dashboardOnly: createPermissionAccount('only', ['dashboard:view']),
    dashboardEnergy: createPermissionAccount('energy', ['dashboard:view', 'energy-records:view']),
    dashboardImports: createPermissionAccount('imports', ['dashboard:view', 'imports:view']),
    dashboardBoth: createPermissionAccount('both', ['dashboard:view', 'energy:records:view', 'imports:view']),
    noDashboard: createPermissionAccount('no-dashboard', ['energy:records:view', 'imports:view'])
  };
}

// 读取账号真实权限快照，验证重复初始化不会改变普通角色授权。
function snapshotPermissionMatrix(accounts) {
  return Object.fromEntries(Object.entries(accounts).map(([accountKey, account]) => [
    accountKey,
    getUserPermissions(account.userId)
  ]));
}

// 通过登录 API 获取真实普通账号会话令牌。
async function loginAccount(server, username, password = TEST_PASSWORD) {
  const login = await request(server, 'POST', '/api/login', {
    body: { username, password }
  });
  assert.strictEqual(login.status, 200, `${username} 必须登录成功。`);
  return login.json.data.token;
}

// 断言领域返回明确无权限状态且不包含受保护统计字段。
function assertForbiddenDomain(domain, protectedFields) {
  assert.deepStrictEqual(domain, { authorized: false, status: 'forbidden' });
  protectedFields.forEach((fieldName) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(domain, fieldName), false, `无权限领域不得返回 ${fieldName}。`);
  });
}

// 按能源类型和单位定位 totals 分组，避免依赖展示排序断言业务结果。
function findTotal(totals, energyTypeCode, normalizedUnit) {
  return totals.find((item) => item.energyTypeCode === energyTypeCode && item.normalizedUnit === normalizedUnit);
}

(async () => {
  let server;
  try {
    initDatabase();
    seedDashboardFixtures();
    const accounts = createPermissionMatrixAccounts();
    const permissionsBeforeReinitialize = snapshotPermissionMatrix(accounts);

    // 重复权限初始化必须保持菜单与普通角色授权幂等，不得丢失或扩大权限。
    initDatabase();
    initDatabase();
    assert.deepStrictEqual(snapshotPermissionMatrix(accounts), permissionsBeforeReinitialize);
    Object.values(accounts).forEach((account) => {
      assert.strictEqual(isSuperAdmin(account.userId), false, `${account.username} 必须保持非管理员身份。`);
      assert.deepStrictEqual(getUserPermissions(account.userId), account.permissionCodes);
    });

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const adminToken = await loginAccount(server, 'admin', process.env.CHARCOAL_ADMIN_PASSWORD);
    const compatible = await request(server, 'GET', '/api/dashboard/summary', { token: adminToken });
    assert.strictEqual(compatible.status, 200);
    assert.strictEqual(compatible.json.data.scope, 'energy-records-and-imports-only');
    assert.strictEqual(compatible.json.data.energy.authorized, true);
    assert.strictEqual(compatible.json.data.energy.status, 'available');
    assert.strictEqual(compatible.json.data.energy.activeRecordCount, 5, '无参数时必须兼容统计全部月份 active 能耗。');
    assert.strictEqual(compatible.json.data.energy.totalNormalizedValue, 522, '旧 totalNormalizedValue 字段必须保留。');
    assert.strictEqual(compatible.json.data.energy.scope.filteredByMonth, false);
    assert.strictEqual(compatible.json.data.imports.authorized, true);
    assert.strictEqual(compatible.json.data.imports.status, 'available');
    assert.strictEqual(compatible.json.data.imports.batchCount, 1);
    assert.strictEqual(compatible.json.data.errors.authorized, true);
    assert.strictEqual(compatible.json.data.errors.importErrorCount, 2);

    const annualPath = '/api/dashboard/summary?normalizedMonthStart=2025-01&normalizedMonthEnd=2025-12';
    const annual = await request(server, 'GET', annualPath, { token: adminToken });
    assert.strictEqual(annual.status, 200);
    assert.strictEqual(annual.json.data.energy.activeRecordCount, 3, '年度摘要只统计所选范围内 active 能耗。');
    assert.strictEqual(annual.json.data.energy.totalNormalizedValue, 402, '兼容字段仍按旧口径直接求和。');
    assert.deepStrictEqual(annual.json.data.energy.monthRange, { start: '2025-01', end: '2025-12' });
    assert.deepStrictEqual(annual.json.data.energy.scope, {
      filteredByMonth: true,
      normalizedMonthStart: '2025-01',
      normalizedMonthEnd: '2025-12',
      recordStatus: 'active'
    });
    assert.strictEqual(annual.json.data.energy.authoritativeTotalField, 'totals');
    assert.strictEqual(annual.json.data.energy.totals.length, 3, '同一能源类型的不同单位必须拆分 totals。');
    assert.deepStrictEqual(findTotal(annual.json.data.energy.totals, 'electricity', 'kWh'), {
      energyTypeCode: 'electricity',
      energyTypeName: '电力',
      normalizedUnit: 'kWh',
      recordCount: 1,
      totalNormalizedValue: 100
    });
    assert.deepStrictEqual(findTotal(annual.json.data.energy.totals, 'electricity', 'MWh'), {
      energyTypeCode: 'electricity',
      energyTypeName: '电力',
      normalizedUnit: 'MWh',
      recordCount: 1,
      totalNormalizedValue: 2
    });
    assert.deepStrictEqual(findTotal(annual.json.data.energy.totals, 'heat', 'MJ'), {
      energyTypeCode: 'heat',
      energyTypeName: '热力',
      normalizedUnit: 'MJ',
      recordCount: 1,
      totalNormalizedValue: 300
    });
    assert.strictEqual(annual.json.data.imports.batchCount, compatible.json.data.imports.batchCount, '导入批次不按能耗年份过滤。');
    assert.strictEqual(annual.json.data.errors.importErrorCount, compatible.json.data.errors.importErrorCount, '导入错误不按能耗年份过滤。');
    assert(annual.json.data.notices.some((notice) => notice.includes('不随该月份范围过滤')));
    assert(annual.json.data.notices.some((notice) => notice.includes('energy.totals')));

    const dashboardOnlyToken = await loginAccount(server, accounts.dashboardOnly.username);
    const dashboardOnly = await request(server, 'GET', annualPath, { token: dashboardOnlyToken });
    assert.strictEqual(dashboardOnly.status, 200);
    assertForbiddenDomain(dashboardOnly.json.data.energy, ['activeRecordCount', 'totals', 'totalNormalizedValue']);
    assertForbiddenDomain(dashboardOnly.json.data.imports, ['batchCount', 'importedRowCount']);
    assertForbiddenDomain(dashboardOnly.json.data.errors, ['importErrorCount', 'blockingErrorCount']);

    const dashboardEnergyToken = await loginAccount(server, accounts.dashboardEnergy.username);
    const dashboardEnergy = await request(server, 'GET', annualPath, { token: dashboardEnergyToken });
    assert.strictEqual(dashboardEnergy.status, 200);
    assert.strictEqual(dashboardEnergy.json.data.energy.authorized, true, '兼容 energy-records:view 必须允许读取能耗摘要。');
    assert.strictEqual(dashboardEnergy.json.data.energy.activeRecordCount, 3);
    assert.strictEqual(dashboardEnergy.json.data.energy.totals.length, 3);
    assertForbiddenDomain(dashboardEnergy.json.data.imports, ['batchCount', 'importedRowCount']);
    assertForbiddenDomain(dashboardEnergy.json.data.errors, ['importErrorCount', 'blockingErrorCount']);

    const dashboardImportsToken = await loginAccount(server, accounts.dashboardImports.username);
    const dashboardImports = await request(server, 'GET', annualPath, { token: dashboardImportsToken });
    assert.strictEqual(dashboardImports.status, 200);
    assertForbiddenDomain(dashboardImports.json.data.energy, ['activeRecordCount', 'totals', 'totalNormalizedValue']);
    assert.strictEqual(dashboardImports.json.data.imports.authorized, true);
    assert.strictEqual(dashboardImports.json.data.imports.batchCount, 1);
    assert.strictEqual(dashboardImports.json.data.errors.authorized, true);
    assert.strictEqual(dashboardImports.json.data.errors.importErrorCount, 2);

    const dashboardBothToken = await loginAccount(server, accounts.dashboardBoth.username);
    const dashboardBoth = await request(server, 'GET', annualPath, { token: dashboardBothToken });
    assert.strictEqual(dashboardBoth.status, 200);
    assert.strictEqual(dashboardBoth.json.data.energy.authorized, true);
    assert.strictEqual(dashboardBoth.json.data.energy.activeRecordCount, 3);
    assert.strictEqual(dashboardBoth.json.data.imports.authorized, true);
    assert.strictEqual(dashboardBoth.json.data.imports.batchCount, 1);
    assert.strictEqual(dashboardBoth.json.data.errors.authorized, true);
    assert.strictEqual(dashboardBoth.json.data.errors.importErrorCount, 2);

    const noDashboardToken = await loginAccount(server, accounts.noDashboard.username);
    const noDashboard = await request(server, 'GET', '/api/dashboard/summary', { token: noDashboardToken });
    assert.strictEqual(noDashboard.status, 403, '缺少 dashboard:view 时即使拥有两个领域权限也必须拒绝。');
    assert.strictEqual(noDashboard.json.error.code, 'FORBIDDEN');
    assert.deepStrictEqual(noDashboard.json.error.details.requiredPermissions, ['dashboard:view']);

    const invalidCases = [
      ['/api/dashboard/summary?normalizedMonthStart=2025-1&normalizedMonthEnd=2025-12', 'INVALID_MONTH_FILTER', null],
      ['/api/dashboard/summary?normalizedMonthStart=2025-01&normalizedMonthEnd=2026-01', 'INVALID_DASHBOARD_YEAR_RANGE', '中控月份范围必须位于同一自然年。'],
      ['/api/dashboard/summary?normalizedMonthStart=2025-12&normalizedMonthEnd=2025-01', 'INVALID_MONTH_RANGE', null],
      ['/api/dashboard/summary?normalizedMonthStart=2025-01', 'DASHBOARD_MONTH_RANGE_REQUIRED', null]
    ];
    for (const [requestPath, detailCode, expectedMessage] of invalidCases) {
      const response = await request(server, 'GET', requestPath, { token: dashboardOnlyToken });
      assert.strictEqual(response.status, 400, `${requestPath} 必须返回 400。`);
      assert.strictEqual(response.json.error.code, 'BAD_REQUEST');
      assert.strictEqual(response.json.error.details.code, detailCode);
      if (expectedMessage) assert.strictEqual(response.json.error.message, expectedMessage);
    }

    // 测试中使用一个历史兼容能耗权限，同时确认集合仍包含正式路由支持的全部编码。
    assert.deepStrictEqual(ENERGY_VIEW_PERMISSIONS, ['energy:records:view', 'energy-records:view', 'energy:statistics:view']);
    console.log('dashboard summary route tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
