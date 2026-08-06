const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  createOrganizationUnit,
  createOrganizationUnitImportBatchFromUpload,
  deactivateOrganizationUnit,
  exportOrganizationUnits,
  getOrganizationUnitStats,
  listOrganizationUnits,
  updateOrganizationUnit
} = require('../services/ledgerService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
const requireOrganizationView = requireAnyPermission('ledger:units:view', 'ledger:organization:view');

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || '00000000.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/units/export', authenticate, requirePermission('ledger:units:export'), asyncHandler(async (req, res) => {
  const result = exportOrganizationUnits(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `00000000.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/units/stats', authenticate, requireOrganizationView, asyncHandler(async (req, res) => {
  sendSuccess(res, getOrganizationUnitStats());
}));

router.post('/units/import', authenticate, requirePermission('ledger:units:import'), requireWritable('organization:import-units'), (req, res, next) => {
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

router.get('/units', authenticate, requireOrganizationView, asyncHandler(async (req, res) => {
  const result = listOrganizationUnits(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/units', authenticate, requirePermission('ledger:units:create'), requireWritable('organization:create-unit'), asyncHandler(async (req, res) => {
  const unit = createOrganizationUnit(req.body || {});
  sendSuccess(res, unit, { statusCode: 201 });
}));

router.put('/units/:id', authenticate, requirePermission('ledger:units:update'), requireWritable('organization:update-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateOrganizationUnit(req.params.id, req.body || {}));
}));

router.delete('/units/:id', authenticate, requirePermission('ledger:units:deactivate'), requireWritable('organization:deactivate-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateOrganizationUnit(req.params.id));
}));

module.exports = router;
