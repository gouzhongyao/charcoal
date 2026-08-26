const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 菜单迁移测试使用独立 SQLite，验证旧菜单身份和普通角色授权不会丢失。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-dashboard-menu-migration-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'dashboard-menu.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');

// 读取中控菜单冻结字段，便于逐次初始化对比迁移副作用。
function getDashboardMenu(db) {
  return db.prepare(`SELECT
      id,
      menu_name AS menuName,
      route_path AS routePath,
      component,
      permission_code AS permissionCode,
      icon,
      sort_order AS sortOrder,
      visible,
      status
    FROM sys_menus
    WHERE route_path = '/dashboard'
    ORDER BY id`).get();
}

try {
  initDatabase();
  const setupDb = openDatabase();
  let dashboardMenuId;
  let roleId;
  let originalContract;
  try {
    const dashboardMenu = getDashboardMenu(setupDb);
    assert(dashboardMenu, '新库必须种入 /dashboard 菜单。');
    assert.strictEqual(dashboardMenu.menuName, '中控', '新库菜单名称必须直接使用“中控”。');
    assert.strictEqual(dashboardMenu.routePath, '/dashboard', '更名不得改变中控路由。');
    assert.strictEqual(dashboardMenu.component, 'dashboard/index', '更名不得改变中控组件标识。');
    assert.strictEqual(dashboardMenu.permissionCode, 'dashboard:view', '更名不得改变中控权限码。');
    assert.strictEqual(
      setupDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/dashboard'").get().total,
      1,
      '新库不得种入重复 /dashboard 菜单。'
    );
    dashboardMenuId = dashboardMenu.id;
    originalContract = {
      routePath: dashboardMenu.routePath,
      component: dashboardMenu.component,
      permissionCode: dashboardMenu.permissionCode,
      icon: dashboardMenu.icon,
      sortOrder: dashboardMenu.sortOrder,
      visible: dashboardMenu.visible,
      status: dashboardMenu.status
    };

    const now = new Date().toISOString();
    roleId = setupDb.prepare(`INSERT INTO sys_roles (
      role_code, role_name, status, created_at, updated_at
    ) VALUES ('dashboard_reader', '中控查看员', 'active', ?, ?)`).run(now, now).lastInsertRowid;
    setupDb.prepare(`INSERT INTO sys_role_menus (role_id, menu_id, created_at)
      VALUES (?, ?, ?)`).run(roleId, dashboardMenuId, now);
    setupDb.prepare("UPDATE sys_menus SET menu_name = '驾驶舱', updated_at = ? WHERE id = ?")
      .run(now, dashboardMenuId);
  } finally {
    setupDb.close();
  }

  initDatabase();
  const migratedDb = openDatabase();
  try {
    const migratedMenu = getDashboardMenu(migratedDb);
    assert.strictEqual(migratedMenu.id, dashboardMenuId, '旧库更名必须保留原 sys_menus ID。');
    assert.strictEqual(migratedMenu.menuName, '中控');
    assert.deepStrictEqual({
      routePath: migratedMenu.routePath,
      component: migratedMenu.component,
      permissionCode: migratedMenu.permissionCode,
      icon: migratedMenu.icon,
      sortOrder: migratedMenu.sortOrder,
      visible: migratedMenu.visible,
      status: migratedMenu.status
    }, originalContract, '更名不得改变组件、权限、排序、图标或状态。');
    assert.strictEqual(
      migratedDb.prepare('SELECT COUNT(*) AS total FROM sys_role_menus WHERE role_id = ? AND menu_id = ?')
        .get(roleId, dashboardMenuId).total,
      1,
      '旧角色的中控授权必须保留。'
    );
  } finally {
    migratedDb.close();
  }

  initDatabase();
  const repeatedDb = openDatabase();
  try {
    const repeatedMenu = getDashboardMenu(repeatedDb);
    assert.strictEqual(repeatedMenu.id, dashboardMenuId);
    assert.strictEqual(repeatedMenu.menuName, '中控');
    assert.deepStrictEqual({
      routePath: repeatedMenu.routePath,
      component: repeatedMenu.component,
      permissionCode: repeatedMenu.permissionCode,
      icon: repeatedMenu.icon,
      sortOrder: repeatedMenu.sortOrder,
      visible: repeatedMenu.visible,
      status: repeatedMenu.status
    }, originalContract, '重复初始化不得改变中控技术契约。');
    assert.strictEqual(
      repeatedDb.prepare("SELECT COUNT(*) AS total FROM sys_menus WHERE route_path = '/dashboard'").get().total,
      1,
      '重复初始化不得新增中控菜单。'
    );
    assert.strictEqual(
      repeatedDb.prepare('SELECT COUNT(*) AS total FROM sys_role_menus WHERE role_id = ? AND menu_id = ?')
        .get(roleId, dashboardMenuId).total,
      1,
      '重复初始化不得丢失或复制普通角色授权。'
    );
  } finally {
    repeatedDb.close();
  }

  console.log('dashboard menu migration tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
