const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  createOrganizationUnit,
  createOrganizationUnitImportBatchFromUpload,
  deactivateOrganizationUnit,
  exportOrganizationUnits,
  listOrganizationUnits,
  updateOrganizationUnit
} = require('../services/ledgerService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'organization-units.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/units/export', asyncHandler(async (req, res) => {
  const result = exportOrganizationUnits(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `organization-units.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/units/import', requireWritable('organization:import-units'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        assertWritableAllowed('organization:import-units:after-upload');
        return createOrganizationUnitImportBatchFromUpload(req.file, { duplicateStrategy: req.body.duplicateStrategy || 'skip' });
      })
      .then((batch) => sendSuccess(res, batch, { statusCode: 201 }))
      .catch(next);
  });
});

router.get('/units', asyncHandler(async (req, res) => {
  const result = listOrganizationUnits(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/units', requireWritable('organization:create-unit'), asyncHandler(async (req, res) => {
  const unit = createOrganizationUnit(req.body || {});
  sendSuccess(res, unit, { statusCode: 201 });
}));

router.put('/units/:id', requireWritable('organization:update-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateOrganizationUnit(req.params.id, req.body || {}));
}));

router.delete('/units/:id', requireWritable('organization:deactivate-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateOrganizationUnit(req.params.id));
}));

module.exports = router;
