const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

// 隔离环境模块：管理员初始化只使用系统临时目录和独立 SQLite。
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-admin-initialization-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
const databasePath = path.join(dataDirectory, 'admin-initialization.sqlite');
// 密码场景模块：分别验证首次初始化、active 保持和 inactive 恢复。
const initialPassword = 'InitialAdmin123!';
const recoveryPassword = 'RecoveredAdmin456!';
// 环境恢复模块：测试结束后恢复当前进程原有配置。
const managedEnvironmentKeys = ['DATA_DIR', 'SQLITE_PATH', 'UPLOADS_DIR', 'BACKUPS_DIR', 'CHARCOAL_ADMIN_PASSWORD'];
const originalEnvironment = Object.fromEntries(managedEnvironmentKeys.map((key) => [key, process.env[key]]));

// 环境恢复方法模块：删除测试新增值并还原测试前已存在的值。
function restoreEnvironment() {
  for (const environmentKey of managedEnvironmentKeys) {
    if (originalEnvironment[environmentKey] === undefined) {
      delete process.env[environmentKey];
    } else {
      process.env[environmentKey] = originalEnvironment[environmentKey];
    }
  }
}

process.env.DATA_DIR = dataDirectory;
process.env.SQLITE_PATH = databasePath;
process.env.UPLOADS_DIR = path.join(temporaryDirectory, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryDirectory, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = initialPassword;

// 数据库模块必须在隔离路径和测试密码设置后加载，避免接触真实 data/。
const { initDatabase, openDatabase } = require('../db/database');

try {
  // 首次初始化模块：固定用户名 admin，并且数据库中只能存在一个该用户名账号。
  initDatabase();
  const initialDatabase = openDatabase();
  const initialAdmin = initialDatabase.prepare("SELECT id, status, password_hash AS passwordHash FROM sys_users WHERE username = 'admin'").get();
  const initialAdminCount = initialDatabase.prepare("SELECT COUNT(*) AS total FROM sys_users WHERE username = 'admin'").get().total;
  initialDatabase.close();
  assert.strictEqual(initialAdmin.status, 'active');
  assert.strictEqual(initialAdminCount, 1);
  assert.strictEqual(bcrypt.compareSync(initialPassword, initialAdmin.passwordHash), true);

  // active 管理员模块：环境密码变化不得覆盖现有 active admin 的密码。
  process.env.CHARCOAL_ADMIN_PASSWORD = recoveryPassword;
  initDatabase();
  const activeDatabase = openDatabase();
  const activeAdmin = activeDatabase.prepare("SELECT id, status, password_hash AS passwordHash FROM sys_users WHERE username = 'admin'").get();
  const activeAdminCount = activeDatabase.prepare("SELECT COUNT(*) AS total FROM sys_users WHERE username = 'admin'").get().total;
  activeDatabase.close();
  assert.strictEqual(activeAdmin.id, initialAdmin.id);
  assert.strictEqual(activeAdmin.status, 'active');
  assert.strictEqual(activeAdminCount, 1);
  assert.strictEqual(activeAdmin.passwordHash, initialAdmin.passwordHash);
  assert.strictEqual(bcrypt.compareSync(initialPassword, activeAdmin.passwordHash), true);
  assert.strictEqual(bcrypt.compareSync(recoveryPassword, activeAdmin.passwordHash), false);

  // inactive 管理员恢复模块：重新初始化应恢复同一账号，并使用当前环境密码更新凭据。
  const inactiveDatabase = openDatabase();
  inactiveDatabase.prepare("UPDATE sys_users SET status = 'inactive' WHERE username = 'admin'").run();
  inactiveDatabase.close();
  initDatabase();
  const recoveredDatabase = openDatabase();
  const recoveredAdmin = recoveredDatabase.prepare("SELECT id, status, password_hash AS passwordHash FROM sys_users WHERE username = 'admin'").get();
  const recoveredAdminCount = recoveredDatabase.prepare("SELECT COUNT(*) AS total FROM sys_users WHERE username = 'admin'").get().total;
  const recoveredRoleCount = recoveredDatabase.prepare(`SELECT COUNT(*) AS total FROM sys_user_roles ur
    JOIN sys_users u ON u.id = ur.user_id
    JOIN sys_roles r ON r.id = ur.role_id
    WHERE u.username = 'admin' AND r.role_code = 'super_admin'`).get().total;
  recoveredDatabase.close();
  assert.strictEqual(recoveredAdmin.id, initialAdmin.id);
  assert.strictEqual(recoveredAdmin.status, 'active');
  assert.strictEqual(recoveredAdminCount, 1);
  assert.strictEqual(recoveredRoleCount, 1);
  assert.notStrictEqual(recoveredAdmin.passwordHash, initialAdmin.passwordHash);
  assert.strictEqual(bcrypt.compareSync(recoveryPassword, recoveredAdmin.passwordHash), true);

  console.log('admin initialization environment tests passed');
} finally {
  restoreEnvironment();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
