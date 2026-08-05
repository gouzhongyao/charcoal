const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');

function now() { return new Date().toISOString(); }
function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function id(value, name = 'id') { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw badRequest(`${name} 必须是正整数。`, { code: 'INVALID_ID', fieldName: name }); return parsed; }
function status(value) { const normalized = text(value); if (!['active', 'inactive'].includes(normalized)) throw badRequest('status 仅支持 active 或 inactive。', { code: 'INVALID_STATUS' }); return normalized; }
function map(row) { return row && ({ id: row.id, roleCode: row.roleCode, roleName: row.roleName, description: row.description, status: row.status, isBuiltin: Boolean(row.isBuiltin), createdAt: row.createdAt, updatedAt: row.updatedAt, menuIds: row.menuIds ? JSON.parse(row.menuIds).filter(Boolean) : [] }); }
function getRoleDb(db, roleId, options = {}) {
  const row = db.prepare(`SELECT r.id, r.role_code AS roleCode, r.role_name AS roleName, r.description, r.status, r.is_builtin AS isBuiltin,
    r.created_at AS createdAt, r.updated_at AS updatedAt, COALESCE(json_group_array(rm.menu_id), '[]') AS menuIds
    FROM sys_roles r LEFT JOIN sys_role_menus rm ON rm.role_id = r.id WHERE r.id = ? GROUP BY r.id`).get(roleId);
  if (!row && !options.optional) throw notFound('角色不存在。', { id: roleId });
  return map(row);
}
function listRoles(query = {}) {
  const keyword = text(query.keyword || query.search); const requestedStatus = text(query.status); if (requestedStatus) status(requestedStatus);
  const db = openDatabase();
  try {
    const rows = db.prepare(`SELECT r.id, r.role_code AS roleCode, r.role_name AS roleName, r.description, r.status,
      r.is_builtin AS isBuiltin, r.created_at AS createdAt, r.updated_at AS updatedAt, COALESCE(json_group_array(rm.menu_id), '[]') AS menuIds
      FROM sys_roles r LEFT JOIN sys_role_menus rm ON rm.role_id = r.id
      WHERE (@keyword = '' OR r.role_code LIKE @likeKeyword OR r.role_name LIKE @likeKeyword)
        AND (@status = '' OR r.status = @status)
      GROUP BY r.id ORDER BY r.is_builtin DESC, r.id ASC`).all({ keyword, likeKeyword: `%${keyword}%`, status: requestedStatus }).map(map);
    return { rows, pagination: { page: 1, pageSize: rows.length, total: rows.length, totalPages: 1 } };
  } finally { db.close(); }
}
function createRole(input = {}) {
  const roleCode = text(input.roleCode); const roleName = text(input.roleName);
  if (!/^[a-z][a-z0-9:_-]{2,63}$/.test(roleCode)) throw badRequest('roleCode 应为 3-64 位小写字母开头的标识。', { code: 'INVALID_ROLE_CODE' });
  if (!roleName || roleName.length > 64) throw badRequest('roleName 为 1-64 位文本。', { code: 'INVALID_ROLE_NAME' });
  const db = openDatabase();
  try {
    const result = db.prepare(`INSERT INTO sys_roles (role_code, role_name, description, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`).run(roleCode, roleName, text(input.description) || null, input.status === undefined ? 'active' : status(input.status), now(), now());
    return getRoleDb(db, result.lastInsertRowid);
  } catch (error) { if (/UNIQUE constraint failed: sys_roles.role_code/.test(error.message)) throw badRequest('角色编码已存在。', { code: 'DUPLICATE_ROLE_CODE' }); throw error; } finally { db.close(); }
}
function updateRole(roleId, input = {}) {
  const db = openDatabase();
  try {
    const existing = getRoleDb(db, id(roleId));
    const roleName = Object.prototype.hasOwnProperty.call(input, 'roleName') ? text(input.roleName) : existing.roleName;
    if (!roleName || roleName.length > 64) throw badRequest('roleName 为 1-64 位文本。', { code: 'INVALID_ROLE_NAME' });
    db.prepare('UPDATE sys_roles SET role_name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?').run(roleName, Object.prototype.hasOwnProperty.call(input, 'description') ? text(input.description) || null : existing.description, input.status === undefined ? existing.status : status(input.status), now(), existing.id);
    return getRoleDb(db, existing.id);
  } finally { db.close(); }
}
function setRoleStatus(roleId, nextStatus) { return updateRole(roleId, { status: nextStatus }); }
function assignRoleMenus(roleId, menuIds) {
  const db = openDatabase();
  try {
    const role = getRoleDb(db, id(roleId));
    if (!Array.isArray(menuIds)) throw badRequest('menuIds 必须为数组。', { code: 'INVALID_MENU_IDS' });
    const ids = [...new Set(menuIds.map((value) => id(value, 'menuId')))];
    if (ids.length) {
      const rows = db.prepare(`SELECT id FROM sys_menus WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`).all(...ids);
      if (rows.length !== ids.length) throw badRequest('存在不存在或已停用的菜单。', { code: 'INVALID_MENU_IDS' });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM sys_role_menus WHERE role_id = ?').run(role.id);
      const insert = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
      ids.forEach((menuId) => insert.run(role.id, menuId, now()));
    }); tx();
    return getRoleDb(db, role.id);
  } finally { db.close(); }
}
function deleteRole(roleId) {
  const role = id(roleId); const db = openDatabase();
  try {
    const existing = getRoleDb(db, role);
    if (existing.isBuiltin) throw badRequest('内置角色不可删除。', { code: 'BUILTIN_ROLE_PROTECTED' });
    const count = db.prepare('SELECT COUNT(*) AS total FROM sys_user_roles WHERE role_id = ?').get(role).total;
    if (count) throw badRequest('角色已分配给用户，不能物理删除；请先解除关联或停用。', { code: 'ROLE_HAS_USERS', userCount: count });
    db.prepare('DELETE FROM sys_role_menus WHERE role_id = ?').run(role);
    db.prepare('DELETE FROM sys_roles WHERE id = ?').run(role);
  } finally { db.close(); }
}
module.exports = { assignRoleMenus, createRole, deleteRole, getRole: (roleId) => { const db = openDatabase(); try { return getRoleDb(db, id(roleId)); } finally { db.close(); } }, listRoles, setRoleStatus, updateRole };
