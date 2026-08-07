const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  buildCarbonEmissionStats,
  calculateCarbonEmissions,
  createCarbonFactor,
  createCarbonFactorImportPreviewFromUpload,
  executeCarbonFactorImport,
  exportCarbonEmissions,
  exportCarbonFactors,
  getCarbonFactor,
  getCarbonManagementContract,
  getEmissionStatistics,
  listCarbonEmissions,
  listCarbonFactors,
  listMissingCarbonFactors,
  setCarbonFactorStatus,
  updateCarbonFactor
} = require('../services/carbonAccountingService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
// 旧综合 carbon:view 仅用于未完成菜单迁移的历史会话兼容；新的细分角色必须按资源域读取。
const requireCarbonContractView = requireAnyPermission('carbon:factors:view', 'carbon:emissions:view', 'carbon:view');
const requireCarbonFactorsView = requireAnyPermission('carbon:factors:view', 'carbon:view');
const requireCarbonEmissionsView = requireAnyPermission('carbon:emissions:view', 'carbon:view');

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'tan-guanli.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', authenticate, requireCarbonContractView, (req, res) => {
  sendSuccess(res, getCarbonManagementContract(), { meta: { contractOnly: false } });
});

router.get('/factors/export', authenticate, requirePermission('carbon:factors:export'), asyncHandler(async (req, res) => {
  const result = exportCarbonFactors(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `tan-yinzi.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/factors/import/preview', authenticate, requirePermission('carbon:factor:import'), requireWritable('carbon:factor-import-preview'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUploadedImportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => createCarbonFactorImportPreviewFromUpload(req.file))
      .then((preview) => sendSuccess(res, preview))
      .catch((error) => {
        cleanupUploadedImportFile(req.file);
        next(error);
      });
  });
});

router.post('/factors/import/execute', authenticate, requirePermission('carbon:factor:import'), requireWritable('carbon:factor-import-execute'), asyncHandler(async (req, res) => {
  sendSuccess(res, await executeCarbonFactorImport(req.body || {}));
}));

router.get('/factors/:factorId', authenticate, requireCarbonFactorsView, asyncHandler(async (req, res) => {
  sendSuccess(res, getCarbonFactor(req.params.factorId));
}));

router.get('/factors', authenticate, requireCarbonFactorsView, asyncHandler(async (req, res) => {
  const result = listCarbonFactors(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/factors', authenticate, requirePermission('carbon:factors:create'), requireWritable('carbon:factors:create'), asyncHandler(async (req, res) => {
  sendSuccess(res, createCarbonFactor(req.body || {}), { statusCode: 201 });
}));

router.put('/factors/:factorId', authenticate, requirePermission('carbon:factors:update'), requireWritable('carbon:factors:update'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateCarbonFactor(req.params.factorId, req.body || {}));
}));

router.patch('/factors/:factorId/status', authenticate, requirePermission('carbon:factors:status'), requireWritable('carbon:factors:status'), asyncHandler(async (req, res) => {
  sendSuccess(res, setCarbonFactorStatus(req.params.factorId, req.body || {}));
}));

router.post('/emissions/calculate', authenticate, requirePermission('carbon:emissions:calculate'), requireWritable('carbon:emissions:calculate'), asyncHandler(async (req, res) => {
  sendSuccess(res, calculateCarbonEmissions(req.body || {}), { statusCode: 201 });
}));

router.get('/emissions/export', authenticate, requirePermission('carbon:emissions:export'), asyncHandler(async (req, res) => {
  const result = exportCarbonEmissions(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `tan-paifang-jieguo.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/emissions/stats', authenticate, requireCarbonEmissionsView, asyncHandler(async (req, res) => {
  const result = buildCarbonEmissionStats(req.query);
  sendSuccess(res, result, { meta: result.meta });
}));

router.get('/emissions/statistics', authenticate, requireCarbonEmissionsView, asyncHandler(async (req, res) => {
  const result = getEmissionStatistics(req.query);
  sendSuccess(res, result.rows, { meta: { groupBy: result.groupBy } });
}));

router.get('/emissions/missing-factors', authenticate, requireCarbonEmissionsView, asyncHandler(async (req, res) => {
  sendSuccess(res, listMissingCarbonFactors(req.query));
}));

router.get('/emissions', authenticate, requireCarbonEmissionsView, asyncHandler(async (req, res) => {
  const result = listCarbonEmissions(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
