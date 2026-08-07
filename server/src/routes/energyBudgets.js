const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  buildEnergyBudgetStats,
  createEnergyBudgetImportPreviewFromUpload,
  executeEnergyBudgetImport,
  exportEnergyBudgets,
  getEnergyBudgetContract,
  getEnergyBudgetExecutionComparison,
  listEnergyBudgets,
  setEnergyBudgetStatus,
  updateEnergyBudget,
  upsertEnergyBudget
} = require('../services/energyBudgetService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'yongneng-yusuan.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', authenticate, requirePermission('energy:budget:view'), (req, res) => {
  sendSuccess(res, getEnergyBudgetContract(), { meta: { contractOnly: false } });
});

router.get('/stats', authenticate, requirePermission('energy:budget:view'), asyncHandler(async (req, res) => {
  const result = buildEnergyBudgetStats(req.query);
  sendSuccess(res, result, { meta: result.meta });
}));

router.get('/execution-comparison', authenticate, requirePermission('energy:budget:view'), asyncHandler(async (req, res) => {
  const result = getEnergyBudgetExecutionComparison(req.query);
  sendSuccess(res, result.rows, { meta: { summary: result.summary, ...result.meta } });
}));

router.get('/export', authenticate, requirePermission('energy:budget:export'), asyncHandler(async (req, res) => {
  const result = exportEnergyBudgets(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `yongneng-yusuan.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/import/preview', authenticate, requirePermission('energy:budget:import'), requireWritable('energy:budget:import-preview'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUploadedImportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => createEnergyBudgetImportPreviewFromUpload(req.file))
      .then((preview) => sendSuccess(res, preview))
      .catch((error) => {
        cleanupUploadedImportFile(req.file);
        next(error);
      });
  });
});

router.post('/import/execute', authenticate, requirePermission('energy:budget:import'), requireWritable('energy:budget:import-execute'), asyncHandler(async (req, res) => {
  sendSuccess(res, await executeEnergyBudgetImport(req.body || {}));
}));

router.get('/', authenticate, requirePermission('energy:budget:view'), asyncHandler(async (req, res) => {
  const result = listEnergyBudgets(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/', authenticate, requirePermission('energy:budget:create'), requireWritable('energy:budget:create'), asyncHandler(async (req, res) => {
  const budget = upsertEnergyBudget(req.body || {});
  sendSuccess(res, budget, { statusCode: 201 });
}));

router.put('/:id', authenticate, requirePermission('energy:budget:update'), requireWritable('energy:budget:update'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateEnergyBudget(req.params.id, req.body || {}));
}));

router.patch('/:id/status', authenticate, requirePermission('energy:budget:status'), requireWritable('energy:budget:status'), asyncHandler(async (req, res) => {
  sendSuccess(res, setEnergyBudgetStatus(req.params.id, req.body || {}));
}));

module.exports = router;
