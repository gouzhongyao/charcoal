'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectUnconnectedDemoContext } = require('../middleware/demoContext');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  createCarbonCalculationRun,
  getCarbonCalculationRun,
  listCarbonCalculationRuns,
  normalizeCarbonAccountingServiceError
} = require('../services/carbonCalculationRunService');
const {
  exportCarbonAccountingResults,
  getCarbonAccountingStatistics,
  listCarbonAccountingResults,
  resolveAccountingSourceTypeFromQuery
} = require('../services/carbonAccountingResultService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 新 accounting 路由严格使用细分权限，旧 carbon:view 不作为活动来源权限兜底。
const CARBON_ACCOUNTING_PERMISSIONS = Object.freeze({
  activityView: 'carbon:activities:view',
  activityCalculate: 'carbon:activities:calculate',
  activityExport: 'carbon:activities:export',
  energyView: 'carbon:emissions:view',
  energyExport: 'carbon:emissions:export'
});
// POST /runs 在认证、授权、维护态和 demo context 拒绝后才解析最多 64 KiB JSON。
const CARBON_ACCOUNTING_JSON_LIMIT_BYTES = 64 * 1024;
const parseCarbonAccountingJson = express.json({ limit: CARBON_ACCOUNTING_JSON_LIMIT_BYTES });
// accounting 领域路由实例。
const router = express.Router();

/** 在前置安全中间件通过后解析受限 JSON，并隐藏 Express 底层错误文本。 */
function parseCarbonAccountingJsonBody(req, res, next) {
  parseCarbonAccountingJson(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      return next(new AppError('CARBON_ACCOUNTING_JSON_TOO_LARGE', '独立碳核算请求体超过大小限制。', {
        statusCode: 413,
        details: {
          code: 'CARBON_ACCOUNTING_JSON_TOO_LARGE',
          maxBodyBytes: CARBON_ACCOUNTING_JSON_LIMIT_BYTES
        }
      }));
    }
    return next(badRequest('独立碳核算 JSON 请求体格式无效。', {
      code: 'CARBON_ACCOUNTING_JSON_INVALID'
    }));
  });
}

/** 根据查询来源要求精确读取权限；all 必须同时拥有两套权限。 */
function requireAccountingResultView(req, res, next) {
  try {
    const sourceType = resolveAccountingSourceTypeFromQuery(req.query || {});
    if (sourceType === 'independent_activity') {
      requirePermission(CARBON_ACCOUNTING_PERMISSIONS.activityView)(req, res, next);
      return;
    }
    if (sourceType === 'energy_record') {
      requirePermission(CARBON_ACCOUNTING_PERMISSIONS.energyView)(req, res, next);
      return;
    }
    requirePermission(
      CARBON_ACCOUNTING_PERMISSIONS.activityView,
      CARBON_ACCOUNTING_PERMISSIONS.energyView
    )(req, res, next);
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
}

/** 根据导出来源要求精确导出权限；all 必须同时拥有两套权限。 */
function requireAccountingResultExport(req, res, next) {
  try {
    const sourceType = resolveAccountingSourceTypeFromQuery(req.query || {});
    if (sourceType === 'independent_activity') {
      requirePermission(CARBON_ACCOUNTING_PERMISSIONS.activityExport)(req, res, next);
      return;
    }
    if (sourceType === 'energy_record') {
      requirePermission(CARBON_ACCOUNTING_PERMISSIONS.energyExport)(req, res, next);
      return;
    }
    requirePermission(
      CARBON_ACCOUNTING_PERMISSIONS.activityExport,
      CARBON_ACCOUNTING_PERMISSIONS.energyExport
    )(req, res, next);
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
}

/** 构造冻结 actor 快照及成功操作审计需要的操作者字段。 */
function getAccountingActor(req) {
  return {
    userId: req.user?.id || null,
    username: req.user?.username || null,
    displayName: req.user?.displayName || null,
    ip: req.ip || null
  };
}

/** 生成 UTF-8 与稳定 ASCII 下载文件名。 */
function buildContentDisposition(fileName, asciiFileName) {
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.post(
  '/runs',
  authenticate,
  requirePermission(CARBON_ACCOUNTING_PERMISSIONS.activityCalculate),
  requireWritable('carbon-accounting:runs:create'),
  rejectUnconnectedDemoContext,
  parseCarbonAccountingJsonBody,
  (req, res, next) => {
    try {
      const run = createCarbonCalculationRun(req.body || {}, getAccountingActor(req));
      sendSuccess(res, run, { statusCode: 201 });
    } catch (error) {
      next(normalizeCarbonAccountingServiceError(error));
    }
  }
);

router.get('/runs', authenticate, requirePermission(CARBON_ACCOUNTING_PERMISSIONS.activityView), (req, res, next) => {
  try {
    const result = listCarbonCalculationRuns(req.query || {});
    sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
});

router.get('/runs/:runCode', authenticate, requirePermission(CARBON_ACCOUNTING_PERMISSIONS.activityView), (req, res, next) => {
  try {
    sendSuccess(res, getCarbonCalculationRun(req.params.runCode));
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
});

router.get('/results', authenticate, requireAccountingResultView, (req, res, next) => {
  try {
    sendSuccess(res, listCarbonAccountingResults(req.query || {}));
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
});

router.get('/statistics', authenticate, requireAccountingResultView, (req, res, next) => {
  try {
    sendSuccess(res, getCarbonAccountingStatistics(req.query || {}));
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
});

router.get('/export', authenticate, requireAccountingResultExport, (req, res, next) => {
  try {
    const result = exportCarbonAccountingResults(req.query || {});
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, result.asciiFileName));
    res.setHeader('Content-Length', String(result.body.length));
    res.setHeader('X-Exported-Row-Count-Independent-Activity', String(result.rowCounts.independent_activity || 0));
    res.setHeader('X-Exported-Row-Count-Energy-Record', String(result.rowCounts.energy_record || 0));
    res.status(200).send(result.body);
  } catch (error) {
    next(normalizeCarbonAccountingServiceError(error));
  }
});

/** 统一收敛 accounting 完整中间件链上的未知异常，已有领域错误保持原语义。 */
function normalizeCarbonAccountingRouteError(error, req, res, next) {
  next(normalizeCarbonAccountingServiceError(error));
}

router.use(normalizeCarbonAccountingRouteError);

module.exports = router;
module.exports.CARBON_ACCOUNTING_JSON_LIMIT_BYTES = CARBON_ACCOUNTING_JSON_LIMIT_BYTES;
module.exports.CARBON_ACCOUNTING_PERMISSIONS = CARBON_ACCOUNTING_PERMISSIONS;
module.exports.parseCarbonAccountingJsonBody = parseCarbonAccountingJsonBody;
module.exports.requireAccountingResultExport = requireAccountingResultExport;
module.exports.requireAccountingResultView = requireAccountingResultView;
