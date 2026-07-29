const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { getMeterReadingContract } = require('../services/contractService');
const {
  createMeterReading,
  createMeterReadingImportBatchFromUpload,
  exportMeterReadings,
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

router.get('/contract', (req, res) => {
  sendSuccess(res, getMeterReadingContract(), { meta: { contractOnly: false } });
});

router.get('/export', asyncHandler(async (req, res) => {
  const result = exportMeterReadings(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `meter-readings.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/import', requireWritable('meter-readings:import'), (req, res, next) => {
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

router.get('/', asyncHandler(async (req, res) => {
  const result = listMeterReadings(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/', requireWritable('meter-readings:create'), asyncHandler(async (req, res) => {
  const reading = createMeterReading(req.body || {});
  sendSuccess(res, reading, { statusCode: 201 });
}));

router.put('/:id', requireWritable('meter-readings:update'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateMeterReading(req.params.id, req.body || {}));
}));

router.delete('/:id', requireWritable('meter-readings:void'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidMeterReading(req.params.id));
}));

module.exports = router;
