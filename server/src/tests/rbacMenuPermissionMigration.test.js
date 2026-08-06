const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-rbac-menu-migration-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'rbac.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { getProfile } = require('../services/authService');
const { getUserMenus } = require('../services/menuService');
const { app } = require('../index');

const legacyMappings = [
  ['energy:statistics:view', 'energy:records:view', '/energy/statistics'],
  ['ledger:organization:view', 'ledger:units:view', '/ledger/organization'],
  ['ledger:meter:view', 'ledger:meters:view', '/ledger/meters'],
  ['ledger:meter-reading:view', 'ledger:readings:view', '/ledger/meter-readings'],
  ['carbon:view', 'carbon:emissions:view', '/carbon'],
  ['prediction:view', 'prediction:config:view', '/predictions']
];
const expectedPermissions = [
  ...legacyMappings.map(([, permissionCode]) => permissionCode),
  'carbon:factors:view', 'prediction:run:view', 'prediction:result:view',
  'energy:budget:view', 'ledger:production-unit:view', 'ledger:production-output:view',
  'ledger:generation:view', 'imports:view', 'dashboard:view', 'system:backup:view',
  'system:user:view', 'system:role:view', 'system:menu:view'
];

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ port: server.address().port, host: '127.0.0.1', method, path: pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : null });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function flattenMenus(menus = []) { return menus.flatMap((menu) => [menu, ...flattenMenus(menu.children || [])]); }

(async () => {
  let server;
  let sampleFactorId;
  let sampleConfigId;
  let sampleRunId;
  try {
    initDatabase();
    const db = openDatabase();
    const now = new Date().toISOString();
    const roleId = db.prepare(`INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
      VALUES ('legacy_viewer', '历史页面查看者', 'active', ?, ?)`).run(now, now).lastInsertRowid;
    const passwordHash = require('bcryptjs').hashSync('Password123!', 10);
    const userId = db.prepare(`INSERT INTO sys_users (username, display_name, password_hash, status, created_at, updated_at)
      VALUES ('legacy-viewer', '历史查看用户', ?, 'active', ?, ?)`).run(passwordHash, now, now).lastInsertRowid;
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(userId, roleId, now);
    const grant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    ['/energy', '/ledger'].forEach((routePath) => grant.run(roleId, db.prepare('SELECT id FROM sys_menus WHERE route_path = ?').get(routePath).id, now));
    const legacyMenuIds = new Map();
    legacyMappings.forEach(([legacyPermissionCode, permissionCode, routePath]) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      legacyMenuIds.set(routePath, menu.id);
      db.prepare('UPDATE sys_menus SET permission_code = ? WHERE id = ?').run(legacyPermissionCode, menu.id);
      grant.run(roleId, menu.id, now);
    });
    ['energy:budget:view', 'ledger:production-unit:view', 'ledger:production-output:view', 'ledger:generation:view', 'imports:view', 'dashboard:view', 'system:backup:view', 'system:user:view', 'system:role:view', 'system:menu:view'].forEach((permissionCode) => {
      grant.run(roleId, db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode).id, now);
    });
    db.close();

    initDatabase();
    const migratedDb = openDatabase();
    legacyMappings.forEach(([, permissionCode, routePath]) => {
      const menu = migratedDb.prepare('SELECT id, permission_code AS permissionCode FROM sys_menus WHERE route_path = ?').get(routePath);
      assert.strictEqual(menu.id, legacyMenuIds.get(routePath), `${routePath} 必须保留原 sys_menus ID`);
      assert.strictEqual(menu.permissionCode, permissionCode, `${routePath} 必须升级为 canonical view permission`);
    });
    legacyMappings.forEach(([legacyPermissionCode]) => assert.strictEqual(migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(legacyPermissionCode).total, 0));
    migratedDb.close();

    const sampleDb = openDatabase();
    try {
      const electricityId = sampleDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      sampleFactorId = sampleDb.prepare(`INSERT INTO carbon_factors
        (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source)
        VALUES (?, 'default', 2030, 'kWh', 0.5, 'kgCO2e', 'RBAC 迁移测试')`).run(electricityId).lastInsertRowid;
      sampleConfigId = sampleDb.prepare(`INSERT INTO prediction_configs
        (name, train_start_month, train_end_month, predict_start_month, predict_end_month, algorithm)
        VALUES ('RBAC 迁移预测配置', '2029-01', '2029-03', '2029-04', '2029-05', 'moving_average')`).run().lastInsertRowid;
      sampleRunId = sampleDb.prepare(`INSERT INTO prediction_runs
        (name, algorithm, status, target_energy_type_id, predict_start_month, predict_end_month, completed_at)
        VALUES ('RBAC 迁移预测运行', 'moving_average', 'completed', ?, '2029-04', '2029-05', ?)`).run(electricityId, now).lastInsertRowid;
      sampleDb.prepare(`INSERT INTO prediction_results
        (prediction_run_id, energy_type_id, target_month, predicted_value, predicted_unit)
        VALUES (?, ?, '2029-04', 100, 'kWh')`).run(sampleRunId, electricityId);
    } finally {
      sampleDb.close();
    }

    const profile = getProfile(userId);
    expectedPermissions.forEach((permissionCode) => assert(profile.permissions.includes(permissionCode), `历史角色迁移后必须保留 ${permissionCode} 查看权限`));
    assert(!profile.permissions.some((permissionCode) => /:(create|update|delete|status|import|export|execute|restore|download)$/.test(permissionCode)), '迁移不得给历史查看角色新增操作权限');
    const routes = flattenMenus(getUserMenus(userId));
    assert.strictEqual(routes.some((menu) => menu.routePath === '/profile'), false, '个人中心不得进入动态菜单');
    assert.strictEqual(routes.find((menu) => menu.routePath === '/imports').parentId, routes.find((menu) => menu.routePath === '/energy').id, '导入菜单必须嵌套在能耗管理');

    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const login = await request(server, 'POST', '/api/login', { username: 'legacy-viewer', password: 'Password123!' });
    assert.strictEqual(login.status, 200);
    const token = login.body.data.token;
    const info = await request(server, 'GET', '/api/getInfo', null, token);
    assert.strictEqual(info.status, 200);
    expectedPermissions.forEach((permissionCode) => assert(info.body.data.permissions.includes(permissionCode), `/getInfo 必须返回 ${permissionCode}`));
    const routers = await request(server, 'GET', '/api/getRouters', null, token);
    assert.strictEqual(routers.status, 200);
    assert.strictEqual(flattenMenus(routers.body.data).some((menu) => menu.routePath === '/profile'), false);
    const importRoute = flattenMenus(routers.body.data).find((menu) => menu.routePath === '/imports');
    assert.strictEqual(importRoute.parentId, flattenMenus(routers.body.data).find((menu) => menu.routePath === '/energy').id);

    for (const pathname of [
      '/api/energy-records', '/api/energy-budgets', '/api/organization/units', '/api/meters', '/api/meter-readings',
      '/api/production/units', '/api/production/outputs', '/api/generation/records', '/api/carbon/factors',
      `/api/carbon/factors/${sampleFactorId}`, '/api/carbon/emissions', '/api/carbon/emissions/stats',
      '/api/carbon/emissions/statistics', '/api/carbon/emissions/missing-factors', '/api/predictions/configs',
      `/api/predictions/configs/${sampleConfigId}`, '/api/predictions/runs', '/api/predictions/runs/stats',
      `/api/predictions/runs/${sampleRunId}`, '/api/predictions/results', `/api/predictions/runs/${sampleRunId}/results`,
      '/api/imports/batches', '/api/dashboard/summary', '/api/system/backups', '/api/system/users', '/api/system/roles', '/api/system/menus'
    ]) {
      const result = await request(server, 'GET', pathname, null, token);
      assert.strictEqual(result.status, 200, `${pathname} 必须接受迁移后的查看权限`);
    }
    const admin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    assert.strictEqual(admin.status, 200, '超级管理员登录不得回归');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emissions', null, admin.body.data.token)).status, 200, '超级管理员的查看权限不得回归');

    const permissionSource = fs.readFileSync(path.join(__dirname, '../../../client/src/views/ledger/LedgerManagement.vue'), 'utf8');
    assert(permissionSource.includes("permission:'ledger:production-unit'"));
    assert(permissionSource.includes("permission:'ledger:production-output'"));
    console.log('rbac menu permission migration tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
