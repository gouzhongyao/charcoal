const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { recordOperation } = require('../services/sessionService');
const { assignRoleMenus, createRole, deleteRole, getRole, listRoles, setRoleStatus, updateRole } = require('../services/roleService');
const { sendSuccess } = require('../utils/response');
const router = express.Router();
router.use(authenticate);
function audit(req, operation, targetId, detail) { recordOperation({ userId: req.user.id, operation, targetType: 'role', targetId, detail, ip: req.ip }); }
router.get('/', requirePermission('system:role:view'), asyncHandler((req, res) => { const result = listRoles(req.query); sendSuccess(res, result.rows, { meta: { pagination: result.pagination } }); }));
router.get('/:id', requirePermission('system:role:view'), asyncHandler((req, res) => sendSuccess(res, getRole(req.params.id))));
router.post('/', requirePermission('system:role:create'), requireWritable('system:role:create'), asyncHandler((req, res) => { const role = createRole(req.body || {}); audit(req, 'system.role.create', role.id, req.body); sendSuccess(res, role, { statusCode: 201 }); }));
router.put('/:id', requirePermission('system:role:update'), requireWritable('system:role:update'), asyncHandler((req, res) => { const role = updateRole(req.params.id, req.body || {}); audit(req, 'system.role.update', role.id, req.body); sendSuccess(res, role); }));
router.patch('/:id/status', requirePermission('system:role:status'), requireWritable('system:role:status'), asyncHandler((req, res) => { const role = setRoleStatus(req.params.id, (req.body || {}).status); audit(req, 'system.role.status', role.id, { status: role.status }); sendSuccess(res, role); }));
router.put('/:id/menus', requirePermission('system:role:assign-menu'), requireWritable('system:role:assign-menu'), asyncHandler((req, res) => { const role = assignRoleMenus(req.params.id, (req.body || {}).menuIds); audit(req, 'system.role.assign-menu', role.id, { menuIds: (req.body || {}).menuIds }); sendSuccess(res, role); }));
router.delete('/:id', requirePermission('system:role:delete'), requireWritable('system:role:delete'), asyncHandler((req, res) => { deleteRole(req.params.id); audit(req, 'system.role.delete', req.params.id); sendSuccess(res, { deleted: true }); }));
module.exports = router;
