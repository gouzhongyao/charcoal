const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-auth-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'auth.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
delete process.env.CHARCOAL_ALLOW_REGISTER;
const { initDatabase, openDatabase } = require('../db/database');
const { getProfile, login, register } = require('../services/authService');
const { getUserMenus } = require('../services/menuService');
try {
  initDatabase();
  const db = openDatabase();
  const stored = db.prepare("SELECT password_hash AS passwordHash FROM sys_users WHERE username = 'admin'").get();
  const sessionCount = db.prepare('SELECT COUNT(*) AS total FROM sys_sessions').get().total;
  db.close();
  assert(stored.passwordHash.startsWith('$2'), '管理员密码必须以 bcrypt hash 保存');
  assert.strictEqual(sessionCount, 0);
  const signedIn = login({ username: 'admin', password: 'AdminPassword123!' }, { ip: '127.0.0.1' });
  assert(signedIn.token.length >= 40);
  const sessionDb = openDatabase();
  const session = sessionDb.prepare('SELECT token_hash AS tokenHash FROM sys_sessions').get();
  sessionDb.close();
  assert.notStrictEqual(session.tokenHash, signedIn.token, '会话表不得保存明文 bearer token');
  assert.throws(() => register({ username: 'reader1', password: 'Password123!' }), (error) => error.code === 'REGISTRATION_DISABLED');
  process.env.CHARCOAL_ALLOW_REGISTER = 'true';
  const registered = register({ username: 'reader1', password: 'Password123!', displayName: '读取用户' });
  assert.strictEqual(registered.roles[0].roleCode, 'user');
  assert(registered.permissions.includes('system:profile:update'), '普通 user 必须保留个人资料权限。');
  assert.deepStrictEqual(getUserMenus(registered.id).map((menu) => menu.routePath), [], '个人中心隐藏后，普通 user 不应获得左侧菜单项。');
  const profileGrantDb = openDatabase();
  const profileGrantCount = profileGrantDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
    JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
    WHERE r.role_code = 'user' AND m.permission_code IN ('system:profile:update', 'system:profile:change-password')`).get().total;
  profileGrantDb.close();
  assert.strictEqual(profileGrantCount, 2, '隐藏个人中心不得移除普通 user 的个人资料和改密授权。');
  const adminProfile = getProfile(signedIn.user.id);
  assert.strictEqual(adminProfile.username, 'admin');
  [
    'dashboard:view', 'imports:view', 'energy:records:view', 'energy:budget:view',
    'ledger:units:view', 'ledger:meters:view', 'ledger:readings:view',
    'ledger:production-unit:view', 'ledger:production-output:view', 'ledger:generation:view',
    'carbon:emissions:view', 'carbon:factors:view', 'prediction:config:view', 'prediction:run:view', 'prediction:result:view', 'system:backup:view'
  ].forEach((permissionCode) => assert(adminProfile.permissions.includes(permissionCode), `超级管理员应拥有 ${permissionCode}`));
  const adminMenus = getUserMenus(signedIn.user.id);
  const menuByPath = new Map(adminMenus.map((menu) => [menu.routePath, menu]));
  assert.strictEqual(menuByPath.get('/dashboard').component, 'dashboard/index');
  assert.strictEqual(menuByPath.has('/profile'), false, '个人中心不应出现在动态菜单树。');
  const energyMenus = menuByPath.get('/energy').children;
  const importMenu = energyMenus.find((menu) => menu.routePath === '/imports');
  assert.strictEqual(importMenu.component, 'imports/index');
  assert.strictEqual(importMenu.menuName, '能耗数据导入');
  assert.strictEqual(importMenu.permissionCode, 'imports:view');
  assert.strictEqual(menuByPath.has('/imports'), false, '能耗数据导入不得保留顶层菜单。');
  assert.strictEqual(energyMenus.find((menu) => menu.routePath === '/energy/statistics').permissionCode, 'energy:records:view');
  assert.strictEqual(menuByPath.get('/ledger').children.length, 6, '基础台账应包含五个既有台账二级菜单和发电自用菜单。');
  const generationMenu = menuByPath.get('/ledger').children.find((menu) => menu.routePath === '/ledger/generation');
  assert.strictEqual(generationMenu.component, 'ledger/generation/index');
  assert.strictEqual(generationMenu.permissionCode, 'ledger:generation:view');
  assert.strictEqual(menuByPath.get('/system').children.find((menu) => menu.routePath === '/system/backups').component, 'system/backups/index');
  const legacyDb = openDatabase();
  const importMenuBeforeMigration = legacyDb.prepare("SELECT id FROM sys_menus WHERE permission_code = 'imports:view'").get();
  legacyDb.prepare("UPDATE sys_menus SET permission_code = 'import:view', parent_id = NULL, menu_name = '数据导入' WHERE id = ?").run(importMenuBeforeMigration.id);
  legacyDb.prepare("UPDATE sys_menus SET visible = 1 WHERE route_path = '/profile'").run();
  const duplicateEnergyDirectoryId = legacyDb.prepare(`INSERT INTO sys_menus
    (menu_type, menu_name, route_path, icon, sort_order, visible, status, is_builtin)
    VALUES ('directory', '能耗管理', '/energy', 'TrendCharts', 40, 1, 'active', 1)`).run().lastInsertRowid;
  legacyDb.prepare("UPDATE sys_menus SET parent_id = ? WHERE route_path = '/energy/statistics'").run(duplicateEnergyDirectoryId);
  legacyDb.close();
  initDatabase();
  const seedDb = openDatabase();
  const dashboardMenus = seedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/dashboard'").get().total;
  const directoryMenus = seedDb.prepare(`SELECT route_path AS routePath, COUNT(*) AS total FROM sys_menus
    WHERE menu_type = 'directory' AND route_path IN ('/system', '/energy', '/ledger') GROUP BY route_path`).all();
  const adminDashboardGrants = seedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
    JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
    WHERE r.role_code = 'super_admin' AND m.permission_code = 'dashboard:view'`).get().total;
  const energyMenu = seedDb.prepare("SELECT id FROM sys_menus WHERE route_path = '/energy'").get();
  const canonicalStatisticMenu = seedDb.prepare("SELECT parent_id AS parentId FROM sys_menus WHERE route_path = '/energy/statistics'").get();
  const canonicalImportMenu = seedDb.prepare("SELECT id, parent_id AS parentId, menu_name AS menuName, component, permission_code AS permissionCode FROM sys_menus WHERE route_path = '/imports'").get();
  const importRouteCount = seedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/imports'").get().total;
  const profileVisible = seedDb.prepare("SELECT visible FROM sys_menus WHERE route_path = '/profile'").get().visible;
  const adminImportGrants = seedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
    JOIN sys_roles r ON r.id = rm.role_id WHERE r.role_code = 'super_admin' AND rm.menu_id = ?`).get(canonicalImportMenu.id).total;
  const legacyImportMenuCount = seedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = 'import:view'").get().total;
  seedDb.close();
  assert.strictEqual(dashboardMenus, 1, '重复初始化不得重复创建业务菜单。');
  assert.deepStrictEqual(directoryMenus, [
    { routePath: '/energy', total: 1 },
    { routePath: '/ledger', total: 1 },
    { routePath: '/system', total: 1 }
  ], '重复初始化不得重复创建内置目录。');
  const flattenedAdminMenus = (menus = []) => menus.flatMap((menu) => [menu, ...flattenedAdminMenus(menu.children || [])]);
  const finalAdminRoutes = flattenedAdminMenus(getUserMenus(signedIn.user.id)).map((menu) => menu.routePath).filter(Boolean);
  assert.strictEqual(new Set(finalAdminRoutes).size, finalAdminRoutes.length, '授权菜单树不得向前端下发重复路由。');
  assert.strictEqual(adminDashboardGrants, 1, '重复初始化不得重复创建管理员菜单授权。');
  assert.strictEqual(canonicalImportMenu.id, importMenuBeforeMigration.id, '旧导入菜单升级必须保留既有菜单 ID 与角色关联。');
  assert.strictEqual(canonicalStatisticMenu.parentId, energyMenu.id, '重复目录中的既有子菜单必须迁回保留目录。');
  assert.strictEqual(canonicalImportMenu.parentId, energyMenu.id, '旧导入菜单必须迁移到能耗管理目录。');
  assert.strictEqual(canonicalImportMenu.menuName, '能耗数据导入');
  assert.strictEqual(canonicalImportMenu.component, 'imports/index');
  assert.strictEqual(canonicalImportMenu.permissionCode, 'imports:view');
  assert.strictEqual(importRouteCount, 1, '迁移后不得同时保留旧、新导入菜单层级。');
  assert.strictEqual(profileVisible, 0, '旧库迁移必须隐藏个人中心菜单。');
  assert.strictEqual(adminImportGrants, 1, '旧导入菜单升级不得丢失超管角色授权。');
  assert.strictEqual(legacyImportMenuCount, 0, '升级后不应遗留旧 import:view 权限键。');
  console.log('auth service tests passed');
} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
