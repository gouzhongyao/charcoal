const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { getMeterReadingContract } = require('../services/contractService');
const {
  createMeterReading,
  createMeterReadingImportBatchFromUpload,
  executeMeterReadingEnergyRecordGeneration,
  exportMeterReadingEnergyRecordGenerationPreview,
  exportMeterReadings,
  getMeterReadingEnergyRecordGenerationPreview,
  getMeterReadingStats,
  listMeterReadings,
  updateMeterReading,
  voidMeterReading
} = require('../services/meterReadingService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'meter-readings.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', authenticate, requirePermission('ledger:readings:view'), (req, res) => {
  sendSuccess(res, getMeterReadingContract(), { meta: { contractOnly: false } });
});

router.get('/export', authenticate, requirePermission('ledger:readings:export'), asyncHandler(async (req, res) => {
  const result = exportMeterReadings(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `meter-readings.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/stats', authenticate, requirePermission('ledger:readings:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, getMeterReadingStats(req.query));
}));

router.get('/energy-record-generation/preview/export', authenticate, requirePermission('ledger:readings:preview'), asyncHandler(async (req, res) => {
  const result = exportMeterReadingEnergyRecordGenerationPreview(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `meter-reading-energy-record-generation-preview.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Dry-Run', 'true');
  res.setHeader('X-Preview-Only', 'true');
  res.setHeader('X-Writes-Energy-Records', 'false');
  res.setHeader('X-Preview-Signature', result.previewSignature || '');
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/energy-record-generation/preview', authenticate, requirePermission('ledger:readings:preview'), asyncHandler(async (req, res) => {
  const preview = getMeterReadingEnergyRecordGenerationPreview(req.query);
  sendSuccess(res, preview, { meta: { dryRun: true, previewOnly: true, writesEnergyRecords: false, carbonAccountingDeferred: true } });
}));

router.post('/energy-record-generation/execute', authenticate, requirePermission('ledger:readings:execute'), requireWritable('meter-readings:energy-record-generation:execute'), asyncHandler(async (req, res) => {
  const audit = await executeMeterReadingEnergyRecordGeneration(req.body || {});
  sendSuccess(res, audit);
}));

router.post('/import', authenticate, requirePermission('ledger:readings:import'), requireWritable('meter-readings:import'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        assertWritableAllowed('meter-readings:import:after-upload');
        return createMeterReadingImportBatchFromUpload(req.file, { duplicateStrategy: req.body.duplicateStrategy || 'skip' });
      })
      .then((batch) => sendSuccess(res, batch, { statusCode: 201 }))
      .catch(next);
  });
});

router.get('/', authenticate, requirePermission('ledger:readings:view'), asyncHandler(async (req, res) => {
  const result = listMeterReadings(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/', authenticate, requirePermission('ledger:readings:create'), requireWritable('meter-readings:create'), asyncHandler(async (req, res) => {
  const reading = createMeterReading(req.body || {});
  sendSuccess(res, reading, { statusCode: 201 });
}));

router.put('/:id', authenticate, requirePermission('ledger:readings:update'), requireWritable('meter-readings:update'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateMeterReading(req.params.id, req.body || {}));
}));

router.delete('/:id', authenticate, requirePermission('ledger:readings:void'), requireWritable('meter-readings:void'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidMeterReading(req.params.id));
}));

module.exports = router;
