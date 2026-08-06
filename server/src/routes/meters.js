const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  createMeter,
  createMeterImportBatchFromUpload,
  deactivateMeter,
  exportMeters,
  getMeterStats,
  listMeters,
  updateMeter
} = require('../services/ledgerService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
const requireMeterView = requireAnyPermission('ledger:meters:view', 'ledger:meter:view');

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || '00000000.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/export', authenticate, requirePermission('ledger:meters:export'), asyncHandler(async (req, res) => {
  const result = exportMeters(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `00000000.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/stats', authenticate, requireMeterView, asyncHandler(async (req, res) => {
  sendSuccess(res, getMeterStats());
}));

router.post('/import', authenticate, requirePermission('ledger:meters:import'), requireWritable('meters:import'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        assertWritableAllowed('meters:import:after-upload');
        return createMeterImportBatchFromUpload(req.file, { duplicateStrategy: req.body.duplicateStrategy || 'skip' });
      })
      .then((batch) => sendSuccess(res, batch, { statusCode: 201 }))
      .catch(next);
  });
});

router.get('/', authenticate, requireMeterView, asyncHandler(async (req, res) => {
  const result = listMeters(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/', authenticate, requirePermission('ledger:meters:create'), requireWritable('meters:create'), asyncHandler(async (req, res) => {
  const meter = createMeter(req.body || {});
  sendSuccess(res, meter, { statusCode: 201 });
}));

router.put('/:id', authenticate, requirePermission('ledger:meters:update'), requireWritable('meters:update'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateMeter(req.params.id, req.body || {}));
}));

router.delete('/:id', authenticate, requirePermission('ledger:meters:deactivate'), requireWritable('meters:deactivate'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateMeter(req.params.id));
}));

module.exports = router;
