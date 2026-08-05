const { AppError, badRequest } = require('../utils/errors');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');

function assertAuthenticated(req) {
  if (!req.user || !req.user.id) throw new AppError('UNAUTHENTICATED', '请先登录。', { statusCode: 401 });
}

function checkPermission(req, permissions, mode) {
  assertAuthenticated(req);
  const expected = (Array.isArray(permissions) ? permissions : [permissions]).filter(Boolean);
  if (!expected.length) throw badRequest('权限编码不能为空。', { code: 'INVALID_PERMISSION_REQUIREMENT' });
  if (isSuperAdmin(req.user.id)) return;
  const granted = new Set(getUserPermissions(req.user.id));
  const allowed = mode === 'all' ? expected.every((item) => granted.has(item)) : expected.some((item) => granted.has(item));
  if (!allowed) {
    throw new AppError('FORBIDDEN', '当前账号没有执行此操作的权限。', { statusCode: 403, details: { requiredPermissions: expected, mode } });
  }
}

function requirePermission(...permissions) {
  return (req, res, next) => { try { checkPermission(req, permissions, 'all'); next(); } catch (error) { next(error); } };
}

function requireAnyPermission(...permissions) {
  return (req, res, next) => { try { checkPermission(req, permissions, 'any'); next(); } catch (error) { next(error); } };
}

module.exports = { requireAnyPermission, requirePermission };
