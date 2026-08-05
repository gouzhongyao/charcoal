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
  assert(registered.permissions.includes('system:profile:update'));
  assert.deepStrictEqual(getUserMenus(registered.id).map((menu) => menu.routePath), ['/profile'], '普通 user 只能获得个人中心菜单。');
  const adminProfile = getProfile(signedIn.user.id);
  assert.strictEqual(adminProfile.username, 'admin');
  [
    'dashboard:view', 'imports:view', 'energy:statistics:view', 'energy:budget:view',
    'ledger:organization:view', 'ledger:meter:view', 'ledger:meter-reading:view',
    'ledger:production-unit:view', 'ledger:production-output:view', 'ledger:generation:view',
    'carbon:view', 'prediction:view', 'system:backup:view'
  ].forEach((permissionCode) => assert(adminProfile.permissions.includes(permissionCode), `超级管理员应拥有 ${permissionCode}`));
  const adminMenus = getUserMenus(signedIn.user.id);
  const menuByPath = new Map(adminMenus.map((menu) => [menu.routePath, menu]));
  assert.strictEqual(menuByPath.get('/dashboard').component, 'dashboard/index');
  assert.strictEqual(menuByPath.get('/imports').component, 'imports/index');
  assert.strictEqual(menuByPath.get('/energy').children.find((menu) => menu.routePath === '/energy/statistics').permissionCode, 'energy:statistics:view');
  assert.strictEqual(menuByPath.get('/ledger').children.length, 6, '基础台账应包含五个既有台账二级菜单和发电自用菜单。');
  const generationMenu = menuByPath.get('/ledger').children.find((menu) => menu.routePath === '/ledger/generation');
  assert.strictEqual(generationMenu.component, 'ledger/generation/index');
  assert.strictEqual(generationMenu.permissionCode, 'ledger:generation:view');
  assert.strictEqual(menuByPath.get('/system').children.find((menu) => menu.routePath === '/system/backups').component, 'system/backups/index');
  const legacyDb = openDatabase();
  const importMenuBeforeMigration = legacyDb.prepare("SELECT id FROM sys_menus WHERE permission_code = 'imports:view'").get();
  legacyDb.prepare("UPDATE sys_menus SET permission_code = 'import:view' WHERE id = ?").run(importMenuBeforeMigration.id);
  legacyDb.close();
  initDatabase();
  const seedDb = openDatabase();
  const dashboardMenus = seedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/dashboard'").get().total;
  const adminDashboardGrants = seedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
    JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
    WHERE r.role_code = 'super_admin' AND m.permission_code = 'dashboard:view'`).get().total;
  const canonicalImportMenu = seedDb.prepare("SELECT id, permission_code AS permissionCode FROM sys_menus WHERE route_path = '/imports'").get();
  const adminImportGrants = seedDb.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
    JOIN sys_roles r ON r.id = rm.role_id WHERE r.role_code = 'super_admin' AND rm.menu_id = ?`).get(canonicalImportMenu.id).total;
  const legacyImportMenuCount = seedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = 'import:view'").get().total;
  seedDb.close();
  assert.strictEqual(dashboardMenus, 1, '重复初始化不得重复创建业务菜单。');
  assert.strictEqual(adminDashboardGrants, 1, '重复初始化不得重复创建管理员菜单授权。');
  assert.strictEqual(canonicalImportMenu.id, importMenuBeforeMigration.id, '旧导入菜单升级必须保留既有菜单 ID 与角色关联。');
  assert.strictEqual(canonicalImportMenu.permissionCode, 'imports:view');
  assert.strictEqual(adminImportGrants, 1, '旧导入菜单升级不得丢失超管角色授权。');
  assert.strictEqual(legacyImportMenuCount, 0, '升级后不应遗留旧 import:view 权限键。');
  console.log('auth service tests passed');
} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
