const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  buildGenerationMeta,
  createGenerationRecord,
  createGenerationRecordImportPreviewFromUpload,
  executeGenerationRecordImport,
  exportGenerationRecords,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  updateGenerationRecord,
  voidGenerationRecord
} = require('../services/generationService');
const { getGenerationContract } = require('../services/contractService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'generation-records.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', (req, res) => {
  sendSuccess(res, getGenerationContract(), { meta: { contractOnly: false } });
});

router.get('/statistics/monthly', asyncHandler(async (req, res) => {
  const result = getMonthlyGenerationStatistics(req.query);
  sendSuccess(res, result.rows, { meta: { ...result.meta, summary: result.summary } });
}));

router.get('/records/export', asyncHandler(async (req, res) => {
  const result = exportGenerationRecords(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `generation-records.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/records/import/preview', requireWritable('generation:records-import-preview'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUploadedImportFile(req.file);
      next(normalizedUploadError);
      return;
    }

    Promise.resolve()
      .then(() => createGenerationRecordImportPreviewFromUpload(req.file))
      .then((preview) => {
        sendSuccess(res, preview);
      })
      .catch((error) => {
        cleanupUploadedImportFile(req.file);
        next(error);
      });
  });
});

router.post('/records/import/execute', requireWritable('generation:records-import-execute'), asyncHandler(async (req, res) => {
  const audit = await executeGenerationRecordImport(req.body || {});
  sendSuccess(res, audit);
}));

router.get('/records', asyncHandler(async (req, res) => {
  const result = listGenerationRecords(req.query);
  sendSuccess(res, result.rows, { meta: { ...buildGenerationMeta(), pagination: result.pagination } });
}));

router.post('/records', requireWritable('generation:create-record'), asyncHandler(async (req, res) => {
  const record = createGenerationRecord(req.body || {});
  sendSuccess(res, record, { statusCode: 201, meta: buildGenerationMeta() });
}));

router.put('/records/:id', requireWritable('generation:update-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

router.delete('/records/:id', requireWritable('generation:void-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

module.exports = router;
