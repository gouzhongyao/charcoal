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
  ['prediction:view', 'prediction:config:view', '/predictions']
];
const expectedPermissions = [
  ...legacyMappings.map(([, permissionCode]) => permissionCode),
  'carbon:emissions:view', 'carbon:factors:view', 'prediction:run:view', 'prediction:result:view',
  'energy:budget:view', 'ledger:production-unit:view', 'ledger:production-output:view',
  'ledger:generation:view', 'imports:view', 'dashboard:view', 'system:backup:view',
  'system:user:view', 'system:role:view', 'system:menu:view'
];
// 导入中心按钮权限用于验证旧库幂等补种和普通角色不自动扩权。
const importButtonPermissions = ['imports:create', 'imports:delete', 'imports:download'];
// 独立碳活动冻结的五个细分权限不得从历史碳查看角色自动扩权。
const carbonActivityPermissions = [
  'carbon:activities:view',
  'carbon:activities:import:preview',
  'carbon:activities:import:execute',
  'carbon:activities:calculate',
  'carbon:activities:export'
];
// 旧能耗结果导出继续使用独立旧权限，不能随查看权限自动扩权。
const carbonEmissionExportPermission = 'carbon:emissions:export';
// N7 温室气体报告四项独立权限不得从历史碳查看角色或独立碳活动角色自动扩权。
const ghgReportPermissions = [
  'carbon:ghg-reports:view',
  'carbon:ghg-reports:import:preview',
  'carbon:ghg-reports:import:execute',
  'carbon:ghg-reports:export'
];
// 四个能源页面及其按钮共用的三十个权限契约。
const energyModulePermissions = [
  'energy:analysis:view',
  'energy:analysis:config:view',
  'energy:analysis:shift:manage',
  'energy:analysis:tou:manage',
  'energy:strategy:rule:manage',
  'energy:strategy:evaluate',
  'energy:strategy:run',
  'energy:strategy:review',
  'energy:analysis:timeseries:preview',
  'energy:analysis:timeseries:execute',
  'energy:analysis:operations:preview',
  'energy:analysis:operations:execute',
  'energy:analysis:config:import:preview',
  'energy:analysis:config:import:execute',
  'energy:benchmarks:view',
  'energy:benchmarks:manage',
  'energy:benchmarks:analyze',
  'energy:benchmarks:export',
  'energy:benchmarks:import:preview',
  'energy:benchmarks:import:execute',
  'energy:flows:view',
  'energy:flows:manage',
  'energy:flows:import:preview',
  'energy:flows:import:execute',
  'energy:balance:view',
  'energy:balance:manage',
  'energy:balance:calculate',
  'energy:balance:suggestion:review',
  'energy:balance:import:preview',
  'energy:balance:import:execute'
];
// 四个页面菜单冻结的路由与组件映射。
const energyPageContracts = [
  ['/energy/analysis', 'energy/analysis/index', 'energy:analysis:view'],
  ['/energy/benchmarks', 'energy/benchmarks/index', 'energy:benchmarks:view'],
  ['/energy/flows', 'energy/flows/index', 'energy:flows:view'],
  ['/energy/balances', 'energy/balances/index', 'energy:balance:view']
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
  let energyUserId;
  let carbonActivityUserId;
  let legacyCarbonMenuId;
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
    const legacyCarbonMenu = db.prepare("SELECT id FROM sys_menus WHERE route_path = '/carbon' AND menu_type = 'menu'").get();
    assert(legacyCarbonMenu, '迁移前必须存在历史 /carbon 页面菜单。');
    legacyCarbonMenuId = Number(legacyCarbonMenu.id);
    db.prepare("UPDATE sys_menus SET permission_code = 'carbon:view' WHERE id = ?").run(legacyCarbonMenuId);
    grant.run(roleId, legacyCarbonMenuId, now);
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
    assert.strictEqual(migratedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = 'carbon:view'").get().total, 0);
    const carbonPageMenu = migratedDb.prepare(`SELECT id, permission_code AS permissionCode, menu_type AS menuType
      FROM sys_menus WHERE route_path = '/carbon'`).get();
    assert.strictEqual(Number(carbonPageMenu.id), legacyCarbonMenuId, '/carbon 必须保留历史 menu ID。');
    assert.strictEqual(carbonPageMenu.permissionCode, null, '/carbon 父页面不得再直接携带细分查看权限。');
    assert.strictEqual(carbonPageMenu.menuType, 'menu');
    const emissionsButton = migratedDb.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType
      FROM sys_menus WHERE permission_code = 'carbon:emissions:view'`).get();
    assert(emissionsButton, '必须建立独立 carbon:emissions:view 按钮。');
    assert.strictEqual(Number(emissionsButton.parentId), legacyCarbonMenuId);
    assert.strictEqual(emissionsButton.menuType, 'button');
    assert.strictEqual(migratedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus
      WHERE role_id = ? AND menu_id = ?`).get(roleId, emissionsButton.id).total, 1,
    '历史碳查看角色必须迁移获得 emissions 按钮。');
    const emissionsExportButton = migratedDb.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType
      FROM sys_menus WHERE permission_code = ?`).get(carbonEmissionExportPermission);
    assert(emissionsExportButton, '必须建立独立 carbon:emissions:export 按钮。');
    assert.strictEqual(Number(emissionsExportButton.parentId), legacyCarbonMenuId);
    assert.strictEqual(emissionsExportButton.menuType, 'button');
    assert.strictEqual(migratedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus
      WHERE role_id = ? AND menu_id = ?`).get(roleId, emissionsExportButton.id).total, 0,
    '历史碳查看角色不得自动获得旧能耗结果导出权限。');
    carbonActivityPermissions.forEach((permissionCode) => {
      const button = migratedDb.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType
        FROM sys_menus WHERE permission_code = ?`).get(permissionCode);
      assert(button, `缺少独立碳活动权限 ${permissionCode}。`);
      assert.strictEqual(Number(button.parentId), legacyCarbonMenuId, `${permissionCode} 必须挂载在原 /carbon 页面。`);
      assert.strictEqual(button.menuType, 'button');
      assert.strictEqual(migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1);
      assert.strictEqual(migratedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus
        WHERE role_id = ? AND menu_id = ?`).get(roleId, button.id).total, 0,
      `历史角色不得自动获得 ${permissionCode}。`);
    });
    ghgReportPermissions.forEach((permissionCode) => {
      const button = migratedDb.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType
        FROM sys_menus WHERE permission_code = ?`).get(permissionCode);
      assert(button, `缺少 N7 温室气体报告权限 ${permissionCode}。`);
      assert.strictEqual(Number(button.parentId), legacyCarbonMenuId, `${permissionCode} 必须挂载在原 /carbon 页面。`);
      assert.strictEqual(button.menuType, 'button');
      assert.strictEqual(migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1);
      assert.strictEqual(migratedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus
        WHERE role_id = ? AND menu_id = ?`).get(roleId, button.id).total, 0,
      `历史角色不得自动获得 ${permissionCode}。`);
    });
    const energyDirectory = migratedDb.prepare("SELECT id FROM sys_menus WHERE route_path = '/energy' AND menu_type = 'directory'").get();
    assert(energyDirectory, '能耗管理目录必须存在。');
    energyPageContracts.forEach(([routePath, component, permissionCode]) => {
      const pageMenu = migratedDb.prepare(`SELECT id, parent_id AS parentId, component, permission_code AS permissionCode,
          menu_type AS menuType, visible, status
        FROM sys_menus WHERE route_path = ?`).get(routePath);
      assert(pageMenu, `缺少页面菜单 ${routePath}。`);
      assert.strictEqual(pageMenu.parentId, energyDirectory.id, `${routePath} 必须位于能耗管理目录下。`);
      assert.strictEqual(pageMenu.component, component);
      assert.strictEqual(pageMenu.permissionCode, permissionCode);
      assert.strictEqual(pageMenu.menuType, 'menu');
      assert.strictEqual(pageMenu.visible, 1);
      assert.strictEqual(pageMenu.status, 'active');
    });
    energyModulePermissions.forEach((permissionCode) => {
      assert.strictEqual(
        migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total,
        1,
        `${permissionCode} 必须且只能种入一次。`
      );
    });
    // 导入页面菜单用于确认三个操作按钮都挂载在既有 /imports 页面下。
    const importPageMenu = migratedDb.prepare("SELECT id FROM sys_menus WHERE route_path = '/imports' AND menu_type = 'menu'").get();
    assert(importPageMenu, '导入页面菜单必须存在。');
    importButtonPermissions.forEach((permissionCode) => {
      // 当前按钮菜单用于验证唯一性、父级、类型和不可见导航属性。
      const importButtonMenu = migratedDb.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType, visible, status
        FROM sys_menus WHERE permission_code = ?`).get(permissionCode);
      assert(importButtonMenu, `缺少导入按钮权限 ${permissionCode}。`);
      assert.strictEqual(importButtonMenu.parentId, importPageMenu.id, `${permissionCode} 必须挂载在 /imports 页面下。`);
      assert.strictEqual(importButtonMenu.menuType, 'button');
      assert.strictEqual(importButtonMenu.visible, 1);
      assert.strictEqual(importButtonMenu.status, 'active');
      assert.strictEqual(
        migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total,
        1,
        `${permissionCode} 必须且只能种入一次。`
      );
    });
    const energyRoleId = migratedDb.prepare(`INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
      VALUES ('energy_module_operator', '能源四模块操作员', 'active', ?, ?)`).run(now, now).lastInsertRowid;
    energyUserId = migratedDb.prepare(`INSERT INTO sys_users (username, display_name, password_hash, status, created_at, updated_at)
      VALUES ('energy-operator', '能源四模块操作员', ?, 'active', ?, ?)`).run(passwordHash, now, now).lastInsertRowid;
    migratedDb.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(energyUserId, energyRoleId, now);
    const migratedGrant = migratedDb.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    migratedGrant.run(energyRoleId, energyDirectory.id, now);
    energyModulePermissions.forEach((permissionCode) => {
      const menu = migratedDb.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      migratedGrant.run(energyRoleId, menu.id, now);
    });
    const carbonActivityRoleId = migratedDb.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES ('carbon_activity_operator', '独立碳活动操作员', 'active', ?, ?)`).run(now, now).lastInsertRowid;
    carbonActivityUserId = migratedDb.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, created_at, updated_at)
      VALUES ('carbon-activity-operator', '独立碳活动操作员', ?, 'active', ?, ?)`)
      .run(passwordHash, now, now).lastInsertRowid;
    migratedDb.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(carbonActivityUserId, carbonActivityRoleId, now);
    migratedGrant.run(carbonActivityRoleId, legacyCarbonMenuId, now);
    carbonActivityPermissions.forEach((permissionCode) => {
      migratedGrant.run(
        carbonActivityRoleId,
        migratedDb.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode).id,
        now
      );
    });
    migratedDb.close();

    initDatabase();
    const repeatedDb = openDatabase();
    try {
      energyModulePermissions.forEach((permissionCode) => {
        assert.strictEqual(
          repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total,
          1,
          `重复初始化不得复制 ${permissionCode}。`
        );
      });
      importButtonPermissions.forEach((permissionCode) => {
        assert.strictEqual(
          repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total,
          1,
          `重复初始化不得复制 ${permissionCode}。`
        );
      });
      assert.strictEqual(repeatedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/carbon'").get().total, 1);
      assert.strictEqual(repeatedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = 'carbon:emissions:view'").get().total, 1);
      assert.strictEqual(repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?')
        .get(carbonEmissionExportPermission).total, 1,
      '重复初始化不得复制旧能耗结果导出权限。');
      carbonActivityPermissions.forEach((permissionCode) => {
        assert.strictEqual(repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1,
          `重复初始化不得复制 ${permissionCode}。`);
      });
      ghgReportPermissions.forEach((permissionCode) => {
        assert.strictEqual(repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1,
          `重复初始化不得复制 ${permissionCode}。`);
      });
      // 内置角色权限计数用于确认危险删除权限只自动授予超级管理员。
      const builtinImportPermissionCount = repeatedDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = ?
          AND menu.permission_code IN (${importButtonPermissions.map(() => '?').join(', ')})`);
      assert.strictEqual(
        builtinImportPermissionCount.get('super_admin', ...importButtonPermissions).total,
        importButtonPermissions.length,
        '超级管理员必须获得全部导入按钮权限。'
      );
      assert.strictEqual(
        builtinImportPermissionCount.get('user', ...importButtonPermissions).total,
        0,
        '普通内置 user 角色不得自动获得导入创建、删除或下载权限。'
      );
      assert.strictEqual(
        builtinImportPermissionCount.get('legacy_viewer', ...importButtonPermissions).total,
        0,
        '历史查看角色不得因旧库补种自动获得导入操作权限。'
      );
      const builtinActivityPermissionCount = repeatedDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = ?
          AND menu.permission_code IN (${carbonActivityPermissions.map(() => '?').join(', ')})`);
      assert.strictEqual(
        builtinActivityPermissionCount.get('super_admin', ...carbonActivityPermissions).total,
        carbonActivityPermissions.length,
        '超级管理员必须获得全部独立碳活动权限。'
      );
      assert.strictEqual(
        builtinActivityPermissionCount.get('user', ...carbonActivityPermissions).total,
        0,
        '普通内置 user 角色不得自动获得独立碳活动权限。'
      );
      assert.strictEqual(
        builtinActivityPermissionCount.get('legacy_viewer', ...carbonActivityPermissions).total,
        0,
        '历史碳查看角色不得自动扩权为独立碳活动角色。'
      );
      assert.strictEqual(
        builtinActivityPermissionCount.get('carbon_activity_operator', ...carbonActivityPermissions).total,
        carbonActivityPermissions.length,
        '独立碳活动角色的显式授权必须在重复初始化后保留。'
      );
      const builtinGhgReportPermissionCount = repeatedDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = ?
          AND menu.permission_code IN (${ghgReportPermissions.map(() => '?').join(', ')})`);
      assert.strictEqual(
        builtinGhgReportPermissionCount.get('super_admin', ...ghgReportPermissions).total,
        ghgReportPermissions.length,
        '超级管理员必须获得全部 N7 温室气体报告权限。'
      );
      assert.strictEqual(
        builtinGhgReportPermissionCount.get('user', ...ghgReportPermissions).total,
        0,
        '普通内置 user 角色不得自动获得 N7 温室气体报告权限。'
      );
      assert.strictEqual(
        builtinGhgReportPermissionCount.get('legacy_viewer', ...ghgReportPermissions).total,
        0,
        '历史碳查看角色不得自动扩权为 N7 温室气体报告角色。'
      );
      assert.strictEqual(
        builtinGhgReportPermissionCount.get('carbon_activity_operator', ...ghgReportPermissions).total,
        0,
        '独立碳活动角色不得自动获得 N7 温室气体报告权限。'
      );
      const emissionExportPermissionCount = repeatedDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = ? AND menu.permission_code = ?`);
      assert.strictEqual(emissionExportPermissionCount.get('super_admin', carbonEmissionExportPermission).total, 1,
        '超级管理员必须获得旧能耗结果导出权限。');
      assert.strictEqual(emissionExportPermissionCount.get('user', carbonEmissionExportPermission).total, 0,
        '普通内置 user 角色不得自动获得旧能耗结果导出权限。');
      assert.strictEqual(emissionExportPermissionCount.get('legacy_viewer', carbonEmissionExportPermission).total, 0,
        '历史碳查看角色不得自动扩成旧能耗结果导出权限。');
      assert.strictEqual(emissionExportPermissionCount.get('carbon_activity_operator', carbonEmissionExportPermission).total, 0,
        '独立碳活动角色不得自动获得旧能耗结果导出权限。');
      assert.strictEqual(
        repeatedDb.prepare(`SELECT COUNT(*) AS total
          FROM sys_role_menus AS role_menu
          JOIN sys_roles AS role ON role.id = role_menu.role_id
          JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
          WHERE role.role_code = 'energy_module_operator'
            AND menu.permission_code IN (${energyModulePermissions.map(() => '?').join(', ')})`)
          .get(...energyModulePermissions).total,
        energyModulePermissions.length,
        '重复初始化必须保留普通角色的全部能源模块授权。'
      );
    } finally {
      repeatedDb.close();
    }

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
    const energyProfile = getProfile(energyUserId);
    energyModulePermissions.forEach((permissionCode) => {
      assert(energyProfile.permissions.includes(permissionCode), `普通能源角色必须获得 ${permissionCode}。`);
    });
    const energyRoutes = flattenMenus(getUserMenus(energyUserId));
    energyPageContracts.forEach(([routePath, component]) => {
      const pageRoute = energyRoutes.find((menu) => menu.routePath === routePath);
      assert(pageRoute, `普通能源角色菜单缺少 ${routePath}。`);
      assert.strictEqual(pageRoute.component, component);
      assert.strictEqual(pageRoute.parentId, energyRoutes.find((menu) => menu.routePath === '/energy').id);
    });
    const carbonActivityProfile = getProfile(carbonActivityUserId);
    carbonActivityPermissions.forEach((permissionCode) => {
      assert(carbonActivityProfile.permissions.includes(permissionCode), `独立碳活动角色必须获得 ${permissionCode}。`);
    });
    assert(!carbonActivityProfile.permissions.includes('carbon:emissions:view'), 'activity-only 角色不得隐式获得旧排放结果查看权限。');
    const carbonActivityRoutes = flattenMenus(getUserMenus(carbonActivityUserId));
    const carbonActivityPage = carbonActivityRoutes.find((menu) => menu.routePath === '/carbon');
    assert(carbonActivityPage, 'activity-only 角色必须拥有 /carbon 父页面。');
    assert.strictEqual(Number(carbonActivityPage.id), legacyCarbonMenuId);

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
    const energyLogin = await request(server, 'POST', '/api/login', { username: 'energy-operator', password: 'Password123!' });
    assert.strictEqual(energyLogin.status, 200, '普通能源角色必须可登录。');
    const energyToken = energyLogin.body.data.token;
    for (const pathname of [
      '/api/energy-analysis/config/shifts',
      '/api/energy-benchmarks/definitions',
      '/api/energy-flows/models',
      '/api/energy-balances/contract'
    ]) {
      const result = await request(server, 'GET', pathname, null, energyToken);
      assert.strictEqual(result.status, 200, `${pathname} 必须接受普通能源角色授权。`);
    }
    const carbonActivityLogin = await request(server, 'POST', '/api/login', { username: 'carbon-activity-operator', password: 'Password123!' });
    assert.strictEqual(carbonActivityLogin.status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities', null, carbonActivityLogin.body.data.token)).status, 200,
      'activity-only 角色必须可访问独立碳活动列表。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emissions', null, carbonActivityLogin.body.data.token)).status, 403,
      'activity-only 角色不得访问旧碳排放结果。');
    const admin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    assert.strictEqual(admin.status, 200, '超级管理员登录不得回归');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emissions', null, admin.body.data.token)).status, 200, '超级管理员的查看权限不得回归');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities', null, admin.body.data.token)).status, 200, '超级管理员必须拥有独立碳活动查看权限。');

    const permissionSource = fs.readFileSync(path.join(__dirname, '../../../client/src/views/ledger/LedgerManagement.vue'), 'utf8');
    assert(permissionSource.includes("permission:'ledger:production-unit'"));
    assert(permissionSource.includes("permission:'ledger:production-output'"));
    console.log('rbac menu permission migration tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
