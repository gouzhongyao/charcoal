const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { recordOperation } = require('../services/sessionService');
const { assignUserRoles, createUser, deleteUser, getUser, listUsers, resetUserPassword, setUserStatus, updateUser } = require('../services/userService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
router.use(authenticate);
function audit(req, operation, targetId, detail) { recordOperation({ userId: req.user.id, operation, targetType: 'user', targetId, detail, ip: req.ip }); }
router.get('/', requirePermission('system:user:view'), asyncHandler((req, res) => { const result = listUsers(req.query); sendSuccess(res, result.rows, { meta: { pagination: result.pagination } }); }));
router.get('/:id', requirePermission('system:user:view'), asyncHandler((req, res) => sendSuccess(res, getUser(req.params.id))));
router.post('/', requirePermission('system:user:create'), requireWritable('system:user:create'), asyncHandler((req, res) => { const user = createUser(req.body || {}); audit(req, 'system.user.create', user.id, req.body); sendSuccess(res, user, { statusCode: 201 }); }));
router.put('/:id', requirePermission('system:user:update'), requireWritable('system:user:update'), asyncHandler((req, res) => { const user = updateUser(req.params.id, req.body || {}); audit(req, 'system.user.update', user.id, req.body); sendSuccess(res, user); }));
router.patch('/:id/status', requirePermission('system:user:status'), requireWritable('system:user:status'), asyncHandler((req, res) => { const user = setUserStatus(req.params.id, (req.body || {}).status); audit(req, 'system.user.status', user.id, { status: user.status }); sendSuccess(res, user); }));
router.put('/:id/reset-password', requirePermission('system:user:reset-password'), requireWritable('system:user:reset-password'), asyncHandler((req, res) => { const result = resetUserPassword(req.params.id, req.body || {}); audit(req, 'system.user.reset-password', result.user.id, { revokedSessionCount: result.revokedSessionCount }); sendSuccess(res, { user: result.user, revokedSessionCount: result.revokedSessionCount }); }));
router.put('/:id/roles', requirePermission('system:user:assign-role'), requireWritable('system:user:assign-role'), asyncHandler((req, res) => { const user = assignUserRoles(req.params.id, (req.body || {}).roleIds); audit(req, 'system.user.assign-role', user.id, { roleIds: (req.body || {}).roleIds }); sendSuccess(res, user); }));
router.delete('/:id', requirePermission('system:user:delete'), requireWritable('system:user:delete'), asyncHandler((req, res) => { deleteUser(req.params.id); audit(req, 'system.user.delete', req.params.id); sendSuccess(res, { deleted: true }); }));
module.exports = router;
