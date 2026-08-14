const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { rejectUnconnectedDemoContext } = require('../middleware/demoContext');
const {
  createProductionOutput,
  createProductionOutputImportPreviewFromUpload,
  createProductionUnit,
  createProductionUnitImportPreviewFromUpload,
  deactivateProductionUnit,
  executeProductionOutputImport,
  executeProductionUnitImport,
  exportProductionOutputs,
  exportProductionUnits,
  getProductionStats,
  getUnitEnergyIntensity,
  listProductionOutputs,
  listProductionUnits,
  updateProductionOutput,
  updateProductionUnit,
  voidProductionOutput
} = require('../services/productionService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
const requireProductionUnitView = requireAnyPermission('ledger:production-unit:view', 'ledger:production:view');
const requireProductionOutputView = requireAnyPermission('ledger:production-output:view', 'ledger:production:view');
const requireProductionView = requireAnyPermission('ledger:production-unit:view', 'ledger:production-output:view', 'ledger:production:view');

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'chanliang-wenjian.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/statistics/unit-energy-intensity', authenticate, requireProductionUnitView, asyncHandler(async (req, res) => {
  const result = getUnitEnergyIntensity(req.query);
  sendSuccess(res, result.rows, { meta: result.meta });
}));

router.get('/stats', authenticate, requireProductionView, asyncHandler(async (req, res) => {
  const result = getProductionStats(req.query);
  sendSuccess(res, result, { meta: result.meta });
}));

router.get('/units', authenticate, requireProductionUnitView, asyncHandler(async (req, res) => {
  const result = listProductionUnits(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.get('/units/export', authenticate, requirePermission('ledger:production:export'), asyncHandler(async (req, res) => {
  const result = exportProductionUnits(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `channeng-danyuan.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/units/import/preview', authenticate, requirePermission('ledger:production:import'), requireWritable('production:units-import-preview'), rejectUnconnectedDemoContext, (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUploadedImportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        assertWritableAllowed('production:units-import-preview:after-upload');
        return createProductionUnitImportPreviewFromUpload(req.file);
      })
      .then((preview) => sendSuccess(res, preview))
      .catch((error) => {
        cleanupUploadedImportFile(req.file);
        next(error);
      });
  });
});

router.post('/units/import/execute', authenticate, requirePermission('ledger:production:import'), requireWritable('production:units-import-execute'), rejectUnconnectedDemoContext, asyncHandler(async (req, res) => {
  sendSuccess(res, await executeProductionUnitImport(req.body || {}));
}));

router.post('/units', authenticate, requirePermission('ledger:production:create'), requireWritable('production:create-unit'), asyncHandler(async (req, res) => {
  const unit = createProductionUnit(req.body || {});
  sendSuccess(res, unit, { statusCode: 201 });
}));

router.put('/units/:id', authenticate, requirePermission('ledger:production:update'), requireWritable('production:update-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionUnit(req.params.id, req.body || {}));
}));

router.delete('/units/:id', authenticate, requirePermission('ledger:production:deactivate'), requireWritable('production:deactivate-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateProductionUnit(req.params.id));
}));

router.get('/outputs/export', authenticate, requirePermission('ledger:production:export'), asyncHandler(async (req, res) => {
  const result = exportProductionOutputs(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `yuedu-chanliang.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/outputs/import/preview', authenticate, requirePermission('ledger:production:preview'), requireWritable('production:outputs-import-preview'), rejectUnconnectedDemoContext, (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        assertWritableAllowed('production:outputs-import-preview:after-upload');
        return createProductionOutputImportPreviewFromUpload(req.file);
      })
      .then((preview) => sendSuccess(res, preview))
      .catch(next);
  });
});

router.post('/outputs/import/execute', authenticate, requirePermission('ledger:production:execute'), requireWritable('production:outputs-import-execute'), rejectUnconnectedDemoContext, asyncHandler(async (req, res) => {
  const audit = await executeProductionOutputImport(req.body || {});
  sendSuccess(res, audit);
}));

router.get('/outputs', authenticate, requireProductionOutputView, asyncHandler(async (req, res) => {
  const result = listProductionOutputs(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/outputs', authenticate, requirePermission('ledger:production:create'), requireWritable('production:create-output'), asyncHandler(async (req, res) => {
  const output = createProductionOutput(req.body || {});
  sendSuccess(res, output, { statusCode: 201 });
}));

router.put('/outputs/:id', authenticate, requirePermission('ledger:production:update'), requireWritable('production:update-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionOutput(req.params.id, req.body || {}));
}));

router.delete('/outputs/:id', authenticate, requirePermission('ledger:production:void'), requireWritable('production:void-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidProductionOutput(req.params.id));
}));

module.exports = router;
