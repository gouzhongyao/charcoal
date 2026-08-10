const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');
const { getDashboardSummary } = require('../services/energyRecordStatisticsService');
const { AppError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

// 驾驶舱入口权限保持不变，未授权账号不能读取任何摘要状态。
const DASHBOARD_VIEW_PERMISSION = 'dashboard:view';
// 能耗摘要复用能耗记录路由现有的兼容查看权限集合。
const ENERGY_VIEW_PERMISSIONS = Object.freeze(['energy:records:view', 'energy-records:view', 'energy:statistics:view']);
// 导入批次与错误摘要沿用统一导入审计查看权限。
const IMPORT_VIEW_PERMISSIONS = Object.freeze(['imports:view']);

// 一次加载当前账号的真实权限，并生成驾驶舱分域裁剪上下文。
function resolveDashboardSummaryAccess(req) {
  if (isSuperAdmin(req.user.id)) {
    return { energyAuthorized: true, importsAuthorized: true };
  }

  const grantedPermissions = new Set(getUserPermissions(req.user.id));
  if (!grantedPermissions.has(DASHBOARD_VIEW_PERMISSION)) {
    throw new AppError('FORBIDDEN', '当前账号没有执行此操作的权限。', {
      statusCode: 403,
      details: { requiredPermissions: [DASHBOARD_VIEW_PERMISSION], mode: 'all' }
    });
  }

  return {
    energyAuthorized: ENERGY_VIEW_PERMISSIONS.some((permissionCode) => grantedPermissions.has(permissionCode)),
    importsAuthorized: IMPORT_VIEW_PERMISSIONS.some((permissionCode) => grantedPermissions.has(permissionCode))
  };
}

// 驾驶舱摘要保留原路径与月份参数，仅返回当前账号已获领域授权的数据。
router.get('/summary', authenticate, asyncHandler(async (req, res) => {
  const access = resolveDashboardSummaryAccess(req);
  sendSuccess(res, getDashboardSummary(req.query, access));
}));

module.exports = router;
