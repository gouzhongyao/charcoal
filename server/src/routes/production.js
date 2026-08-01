const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  createProductionOutput,
  createProductionOutputImportPreviewFromUpload,
  createProductionUnit,
  deactivateProductionUnit,
  executeProductionOutputImport,
  exportProductionOutputs,
  getUnitEnergyIntensity,
  listProductionOutputs,
  listProductionUnits,
  updateProductionOutput,
  updateProductionUnit,
  voidProductionOutput
} = require('../services/productionService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'production-outputs.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/statistics/unit-energy-intensity', asyncHandler(async (req, res) => {
  const result = getUnitEnergyIntensity(req.query);
  sendSuccess(res, result.rows, { meta: result.meta });
}));

router.get('/units', asyncHandler(async (req, res) => {
  const result = listProductionUnits(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/units', requireWritable('production:create-unit'), asyncHandler(async (req, res) => {
  const unit = createProductionUnit(req.body || {});
  sendSuccess(res, unit, { statusCode: 201 });
}));

router.put('/units/:id', requireWritable('production:update-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionUnit(req.params.id, req.body || {}));
}));

router.delete('/units/:id', requireWritable('production:deactivate-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateProductionUnit(req.params.id));
}));

router.get('/outputs/export', asyncHandler(async (req, res) => {
  const result = exportProductionOutputs(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `production-outputs.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/outputs/import/preview', (req, res, next) => {
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

router.post('/outputs/import/execute', requireWritable('production:outputs-import-execute'), asyncHandler(async (req, res) => {
  const audit = await executeProductionOutputImport(req.body || {});
  sendSuccess(res, audit);
}));

router.get('/outputs', asyncHandler(async (req, res) => {
  const result = listProductionOutputs(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/outputs', requireWritable('production:create-output'), asyncHandler(async (req, res) => {
  const output = createProductionOutput(req.body || {});
  sendSuccess(res, output, { statusCode: 201 });
}));

router.put('/outputs/:id', requireWritable('production:update-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionOutput(req.params.id, req.body || {}));
}));

router.delete('/outputs/:id', requireWritable('production:void-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidProductionOutput(req.params.id));
}));

module.exports = router;
