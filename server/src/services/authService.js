const bcrypt = require('bcryptjs');
const { openDatabase } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const { createSession, recordOperation, revokeSessionByToken, revokeUserSessions } = require('./sessionService');

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const PASSWORD_MIN_LENGTH = 8;

function now() {
  return new Date().toISOString();
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeUsername(value) {
  const username = text(value);
  if (!USERNAME_PATTERN.test(username)) {
    throw badRequest('用户名应为 3-64 位字母、数字、点、下划线或连字符。', { code: 'INVALID_USERNAME' });
  }
  return username;
}

function validatePassword(password, fieldName = 'password') {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH || value.length > 128) {
    throw badRequest(`${fieldName} 长度应为 ${PASSWORD_MIN_LENGTH}-128 位。`, { code: 'INVALID_PASSWORD_LENGTH', fieldName });
  }
  return value;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    status: row.status,
    isBuiltin: Boolean(row.isBuiltin),
    lastLoginAt: row.lastLoginAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getRolesForUser(db, userId) {
  return db.prepare(`SELECT r.id, r.role_code AS roleCode, r.role_name AS roleName
    FROM sys_roles r JOIN sys_user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ? AND r.status = 'active' ORDER BY r.id`).all(userId);
}

function getUserPermissions(userId) {
  const db = openDatabase();
  try {
    return db.prepare(`SELECT DISTINCT m.permission_code AS permissionCode
      FROM sys_menus m
      JOIN sys_role_menus rm ON rm.menu_id = m.id
      JOIN sys_user_roles ur ON ur.role_id = rm.role_id
      JOIN sys_roles r ON r.id = ur.role_id
      JOIN sys_users u ON u.id = ur.user_id
      WHERE ur.user_id = ? AND u.status = 'active' AND r.status = 'active'
        AND m.status = 'active' AND m.permission_code IS NOT NULL
      ORDER BY m.permission_code`).all(userId).map((row) => row.permissionCode);
  } finally {
    db.close();
  }
}

function isSuperAdmin(userId) {
  const db = openDatabase();
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sys_user_roles ur JOIN sys_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.role_code = 'super_admin' AND r.status = 'active'`).get(userId));
  } finally {
    db.close();
  }
}

function getProfile(userId) {
  const db = openDatabase();
  try {
    const row = db.prepare(`SELECT id, username, display_name AS displayName, status,
      is_builtin AS isBuiltin, last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt
      FROM sys_users WHERE id = ?`).get(userId);
    if (!row || row.status !== 'active') throw new AppError('UNAUTHENTICATED', '账号不存在或已停用。', { statusCode: 401 });
    return { ...mapUser(row), roles: getRolesForUser(db, userId), permissions: getUserPermissions(userId) };
  } finally {
    db.close();
  }
}

function recordLogin({ username, userId = null, success, reason = null, context = {} }) {
  const db = openDatabase();
  try {
    db.prepare(`INSERT INTO sys_login_logs (username, user_id, success, reason, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(username || null, userId, success ? 1 : 0, reason, context.ip || null, context.userAgent || null, now());
  } finally {
    db.close();
  }
}

function login(input = {}, context = {}) {
  const username = text(input.username);
  const password = String(input.password || '');
  const db = openDatabase();
  let user;
  try {
    user = db.prepare(`SELECT id, username, display_name AS displayName, password_hash AS passwordHash, status,
      is_builtin AS isBuiltin, last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt
      FROM sys_users WHERE username = ?`).get(username);
  } finally {
    db.close();
  }
  const valid = user && user.status === 'active' && bcrypt.compareSync(password, user.passwordHash);
  if (!valid) {
    recordLogin({ username, userId: user ? user.id : null, success: false, reason: 'invalid_credentials_or_inactive', context });
    throw new AppError('INVALID_CREDENTIALS', '用户名或密码错误，或账号已停用。', { statusCode: 401 });
  }
  const session = createSession(user.id, context);
  const updateDb = openDatabase();
  try {
    updateDb.prepare('UPDATE sys_users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), user.id);
  } finally {
    updateDb.close();
  }
  recordLogin({ username: user.username, userId: user.id, success: true, context });
  recordOperation({ userId: user.id, operation: 'auth.login', targetType: 'user', targetId: user.id, ip: context.ip });
  return { token: session.token, expiresAt: session.expiresAt, user: getProfile(user.id) };
}

function register(input = {}, context = {}) {
  if (process.env.CHARCOAL_ALLOW_REGISTER !== 'true') {
    throw new AppError('REGISTRATION_DISABLED', '当前未开放注册。', { statusCode: 403 });
  }
  const username = normalizeUsername(input.username);
  const password = validatePassword(input.password);
  const displayName = text(input.displayName) || username;
  const db = openDatabase();
  try {
    const userRole = db.prepare("SELECT id FROM sys_roles WHERE role_code = 'user' AND status = 'active'").get();
    if (!userRole) throw new AppError('RBAC_SEED_MISSING', '普通用户角色未初始化。', { statusCode: 500 });
    const transaction = db.transaction(() => {
      const result = db.prepare(`INSERT INTO sys_users (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 0, ?, ?)`).run(username, displayName, bcrypt.hashSync(password, 12), now(), now());
      db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(result.lastInsertRowid, userRole.id, now());
      return result.lastInsertRowid;
    });
    const userId = transaction();
    recordOperation({ userId, operation: 'auth.register', targetType: 'user', targetId: userId, ip: context.ip });
    return getProfile(userId);
  } catch (error) {
    if (error && /UNIQUE constraint failed: sys_users.username/.test(error.message)) {
      throw badRequest('用户名已存在。', { code: 'DUPLICATE_USERNAME' });
    }
    throw error;
  } finally {
    db.close();
  }
}

function logout(token, actor = {}) {
  revokeSessionByToken(token);
  if (actor.userId) recordOperation({ userId: actor.userId, operation: 'auth.logout', targetType: 'user', targetId: actor.userId, ip: actor.ip });
}

function updateProfile(userId, input = {}, context = {}) {
  const displayName = text(input.displayName);
  if (!displayName || displayName.length > 64) throw badRequest('displayName 为 1-64 位文本。', { code: 'INVALID_DISPLAY_NAME' });
  const db = openDatabase();
  try {
    if (!db.prepare("SELECT 1 FROM sys_users WHERE id = ? AND status = 'active'").get(userId)) {
      throw new AppError('UNAUTHENTICATED', '账号不存在或已停用。', { statusCode: 401 });
    }
    db.prepare('UPDATE sys_users SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, now(), userId);
  } finally {
    db.close();
  }
  recordOperation({ userId, operation: 'auth.profile.update', targetType: 'user', targetId: userId, detail: { displayName }, ip: context.ip });
  return getProfile(userId);
}

function changePassword(userId, input = {}, context = {}) {
  const currentPassword = String(input.currentPassword || '');
  const newPassword = validatePassword(input.newPassword, 'newPassword');
  const db = openDatabase();
  try {
    const user = db.prepare('SELECT password_hash AS passwordHash, status FROM sys_users WHERE id = ?').get(userId);
    if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', '账号不存在或已停用。', { statusCode: 401 });
    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      throw new AppError('INVALID_CURRENT_PASSWORD', '当前密码不正确。', { statusCode: 400 });
    }
    db.prepare('UPDATE sys_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), now(), userId);
  } finally {
    db.close();
  }
  revokeUserSessions(userId, context.sessionId || null);
  recordOperation({ userId, operation: 'auth.password.change', targetType: 'user', targetId: userId, ip: context.ip });
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  getProfile,
  getUserPermissions,
  isSuperAdmin,
  login,
  logout,
  normalizeUsername,
  register,
  changePassword,
  updateProfile,
  validatePassword
};
