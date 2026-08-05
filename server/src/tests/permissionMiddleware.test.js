const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-permission-'));
process.env.DATA_DIR = path.join(tmpDir, 'data'); process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'permission.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads'); process.env.BACKUPS_DIR = path.join(tmpDir, 'backups'); process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!'; process.env.CHARCOAL_ALLOW_REGISTER = 'true';
const { initDatabase } = require('../db/database');
const { register } = require('../services/authService');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
function invoke(middleware, user) { return new Promise((resolve) => middleware({ user }, {}, (error) => resolve(error || null))); }
(async () => {
  try {
    initDatabase();
    const reader = register({ username: 'reader2', password: 'Password123!' });
    const missing = await invoke(requirePermission('system:user:view'), { id: reader.id });
    assert(missing && missing.code === 'FORBIDDEN');
    const resetPasswordDenied = await invoke(requirePermission('system:user:reset-password'), { id: reader.id });
    assert(resetPasswordDenied && resetPasswordDenied.code === 'FORBIDDEN');
    assert.strictEqual(await invoke(requireAnyPermission('missing:permission', 'system:profile:update'), { id: reader.id }), null);
    const adminAllowed = await invoke(requirePermission('system:menu:delete'), { id: 1 });
    assert.strictEqual(adminAllowed, null, '超级管理员可拥有全系统权限，但维护态仍由路由 requireWritable 单独校验');
    const unauthenticated = await invoke(requirePermission('system:profile:update'), null);
    assert(unauthenticated && unauthenticated.code === 'UNAUTHENTICATED');
    console.log('permission middleware tests passed');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
