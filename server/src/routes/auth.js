const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireWritable } = require('../middleware/maintenance');
const { changePassword, getProfile, login, logout, register, updateProfile } = require('../services/authService');
const { getUserMenus } = require('../services/menuService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
function context(req) { return { ip: req.ip, userAgent: req.get('user-agent'), sessionId: req.auth && req.auth.sessionId }; }
function loginHandler(req, res) { sendSuccess(res, login(req.body || {}, context(req))); }
function registerHandler(req, res) { sendSuccess(res, register(req.body || {}, context(req)), { statusCode: 201 }); }
function profileHandler(req, res) { sendSuccess(res, getProfile(req.user.id)); }
function menusHandler(req, res) { sendSuccess(res, getUserMenus(req.user.id)); }

router.post(['/auth/login', '/login'], asyncHandler(loginHandler));
router.post(['/auth/register', '/register'], requireWritable('auth:register'), asyncHandler(registerHandler));
router.post(['/auth/logout', '/logout'], authenticate, asyncHandler(async (req, res) => { logout(req.auth.token, { userId: req.user.id, ip: req.ip }); sendSuccess(res, { loggedOut: true }); }));
router.get(['/auth/profile', '/getInfo'], authenticate, asyncHandler(profileHandler));
router.put('/auth/profile', authenticate, requireWritable('auth:profile:update'), asyncHandler(async (req, res) => sendSuccess(res, updateProfile(req.user.id, req.body || {}, context(req)))));
router.put('/auth/password', authenticate, requireWritable('auth:password:change'), asyncHandler(async (req, res) => { changePassword(req.user.id, req.body || {}, context(req)); sendSuccess(res, { changed: true }); }));
router.get(['/auth/menus', '/getRouters'], authenticate, asyncHandler(menusHandler));
router.get('/auth/permissions', authenticate, asyncHandler((req, res) => sendSuccess(res, getProfile(req.user.id).permissions)));

module.exports = router;
