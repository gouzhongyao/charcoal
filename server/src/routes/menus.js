const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { recordOperation } = require('../services/sessionService');
const { createMenu, deleteMenu, getMenu, listMenus, setMenuStatus, updateMenu } = require('../services/menuService');
const { sendSuccess } = require('../utils/response');
const router = express.Router();
router.use(authenticate);
function audit(req, operation, targetId, detail) { recordOperation({ userId: req.user.id, operation, targetType: 'menu', targetId, detail, ip: req.ip }); }
router.get('/', requirePermission('system:menu:view'), asyncHandler((req, res) => sendSuccess(res, listMenus(req.query))));
router.get('/:id', requirePermission('system:menu:view'), asyncHandler((req, res) => sendSuccess(res, getMenu(req.params.id))));
router.post('/', requirePermission('system:menu:create'), requireWritable('system:menu:create'), asyncHandler((req, res) => { const menu = createMenu(req.body || {}); audit(req, 'system.menu.create', menu.id, req.body); sendSuccess(res, menu, { statusCode: 201 }); }));
router.put('/:id', requirePermission('system:menu:update'), requireWritable('system:menu:update'), asyncHandler((req, res) => { const menu = updateMenu(req.params.id, req.body || {}); audit(req, 'system.menu.update', menu.id, req.body); sendSuccess(res, menu); }));
router.patch('/:id/status', requirePermission('system:menu:status'), requireWritable('system:menu:status'), asyncHandler((req, res) => { const menu = setMenuStatus(req.params.id, (req.body || {}).status); audit(req, 'system.menu.status', menu.id, { status: menu.status }); sendSuccess(res, menu); }));
router.delete('/:id', requirePermission('system:menu:delete'), requireWritable('system:menu:delete'), asyncHandler((req, res) => { deleteMenu(req.params.id); audit(req, 'system.menu.delete', req.params.id); sendSuccess(res, { deleted: true }); }));
module.exports = router;
