const bcrypt = require('bcryptjs');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { normalizeUsername, validatePassword } = require('./authService');
const { revokeUserSessions } = require('./sessionService');

function now() { return new Date().toISOString(); }
function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function parseId(value, name = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw badRequest(`${name} 必须是正整数。`, { code: 'INVALID_ID', fieldName: name });
  return id;
}
function page(input = {}) {
  const current = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(input.pageSize, 10) || 20));
  return { current, pageSize, offset: (current - 1) * pageSize };
}
function normalizeStatus(value) {
  const status = text(value);
  if (!['active', 'inactive'].includes(status)) throw badRequest('status 仅支持 active 或 inactive。', { code: 'INVALID_STATUS' });
  return status;
}
function mapUser(row) {
  return {
    id: row.id, username: row.username, displayName: row.displayName, status: row.status,
    isBuiltin: Boolean(row.isBuiltin), lastLoginAt: row.lastLoginAt || null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    roles: row.roles ? JSON.parse(row.roles) : []
  };
}
function selectUser(db, id, options = {}) {
  const row = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.status,
    u.is_builtin AS isBuiltin, u.last_login_at AS lastLoginAt, u.created_at AS createdAt, u.updated_at AS updatedAt,
    COALESCE(json_group_array(CASE WHEN r.id IS NOT NULL THEN json_object('id', r.id, 'roleCode', r.role_code, 'roleName', r.role_name) END), '[]') AS roles
    FROM sys_users u LEFT JOIN sys_user_roles ur ON ur.user_id = u.id LEFT JOIN sys_roles r ON r.id = ur.role_id
    WHERE u.id = ? GROUP BY u.id`).get(id);
  if (!row && !options.optional) throw notFound('用户不存在。', { id });
  const user = row ? mapUser(row) : null;
  if (user) user.roles = user.roles.filter(Boolean);
  return user;
}
function validateRoleIds(db, roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) throw badRequest('roleIds 至少选择一个角色。', { code: 'REQUIRED_ROLE_IDS' });
  const ids = [...new Set(roleIds.map((id) => parseId(id, 'roleId')))];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM sys_roles WHERE id IN (${placeholders}) AND status = 'active'`).all(...ids);
  if (rows.length !== ids.length) throw badRequest('存在不存在或已停用的角色。', { code: 'INVALID_ROLE_IDS' });
  return ids;
}
function replaceRoles(db, userId, roleIds) {
  const ids = validateRoleIds(db, roleIds);
  db.prepare('DELETE FROM sys_user_roles WHERE user_id = ?').run(userId);
  const add = db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)');
  ids.forEach((roleId) => add.run(userId, roleId, now()));
}
function listUsers(query = {}) {
  const { current, pageSize, offset } = page(query);
  const keyword = text(query.keyword || query.search);
  const status = text(query.status);
  if (status) normalizeStatus(status);
  const filters = []; const params = { pageSize, offset };
  if (keyword) { filters.push('(u.username LIKE @keyword OR u.display_name LIKE @keyword)'); params.keyword = `%${keyword}%`; }
  if (status) { filters.push('u.status = @status'); params.status = status; }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM sys_users u ${where}`).get(params).total;
    const rows = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.status, u.is_builtin AS isBuiltin,
      u.last_login_at AS lastLoginAt, u.created_at AS createdAt, u.updated_at AS updatedAt,
      COALESCE(json_group_array(CASE WHEN r.id IS NOT NULL THEN json_object('id', r.id, 'roleCode', r.role_code, 'roleName', r.role_name) END), '[]') AS roles
      FROM sys_users u LEFT JOIN sys_user_roles ur ON ur.user_id = u.id LEFT JOIN sys_roles r ON r.id = ur.role_id
      ${where} GROUP BY u.id ORDER BY u.id DESC LIMIT @pageSize OFFSET @offset`).all(params).map(mapUser);
    rows.forEach((user) => { user.roles = user.roles.filter(Boolean); });
    return { rows, pagination: { page: current, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally { db.close(); }
}
function createUser(input = {}) {
  const username = normalizeUsername(input.username);
  const displayName = text(input.displayName) || username;
  if (displayName.length > 64) throw badRequest('displayName 最长 64 位。', { code: 'INVALID_DISPLAY_NAME' });
  const password = validatePassword(input.password);
  const status = input.status === undefined ? 'active' : normalizeStatus(input.status);
  const db = openDatabase();
  try {
    const tx = db.transaction(() => {
      const result = db.prepare(`INSERT INTO sys_users (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)`).run(username, displayName, bcrypt.hashSync(password, 12), status, now(), now());
      replaceRoles(db, result.lastInsertRowid, input.roleIds || []);
      return selectUser(db, result.lastInsertRowid);
    });
    return tx();
  } catch (error) {
    if (/UNIQUE constraint failed: sys_users.username/.test(error.message)) throw badRequest('用户名已存在。', { code: 'DUPLICATE_USERNAME' });
    throw error;
  } finally { db.close(); }
}
function updateUser(idInput, input = {}) {
  const id = parseId(idInput); const db = openDatabase();
  try {
    const existing = selectUser(db, id);
    const displayName = Object.prototype.hasOwnProperty.call(input, 'displayName') ? text(input.displayName) : existing.displayName;
    if (!displayName || displayName.length > 64) throw badRequest('displayName 为 1-64 位文本。', { code: 'INVALID_DISPLAY_NAME' });
    const status = input.status === undefined ? existing.status : normalizeStatus(input.status);
    db.prepare('UPDATE sys_users SET display_name = ?, status = ?, updated_at = ? WHERE id = ?').run(displayName, status, now(), id);
    if (status === 'inactive') revokeUserSessions(id);
    return selectUser(db, id);
  } finally { db.close(); }
}
function setUserStatus(id, status) { return updateUser(id, { status }); }
function resetUserPassword(idInput, input = {}) {
  const id = parseId(idInput);
  const password = validatePassword(input.newPassword, 'newPassword');
  const db = openDatabase();
  try {
    selectUser(db, id);
    db.prepare('UPDATE sys_users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(bcrypt.hashSync(password, 12), now(), id);
  } finally { db.close(); }
  const revokedSessionCount = revokeUserSessions(id);
  return { user: (() => { const readDb = openDatabase(); try { return selectUser(readDb, id); } finally { readDb.close(); } })(), revokedSessionCount };
}
function assignUserRoles(idInput, roleIds) {
  const id = parseId(idInput); const db = openDatabase();
  try {
    const tx = db.transaction(() => { selectUser(db, id); replaceRoles(db, id, roleIds); return selectUser(db, id); });
    return tx();
  } finally { db.close(); }
}
function deleteUser(idInput) {
  const id = parseId(idInput); const db = openDatabase();
  try {
    const user = selectUser(db, id);
    if (user.isBuiltin) throw badRequest('内置管理员不可删除，可按需停用其他用户。', { code: 'BUILTIN_USER_PROTECTED' });
    const roleCount = db.prepare('SELECT COUNT(*) AS total FROM sys_user_roles WHERE user_id = ?').get(id).total;
    const sessionCount = db.prepare('SELECT COUNT(*) AS total FROM sys_sessions WHERE user_id = ?').get(id).total;
    if (roleCount || sessionCount) throw badRequest('用户仍有关联角色或会话，不能物理删除；请使用停用。', { code: 'USER_HAS_ASSOCIATIONS', roleCount, sessionCount });
    db.prepare('DELETE FROM sys_users WHERE id = ?').run(id);
  } finally { db.close(); }
}
module.exports = { assignUserRoles, createUser, deleteUser, getUser: (id) => { const db = openDatabase(); try { return selectUser(db, parseId(id)); } finally { db.close(); } }, listUsers, resetUserPassword, setUserStatus, updateUser };
