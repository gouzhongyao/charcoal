const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  buildGenerationMeta,
  createGenerationRecord,
  createGenerationRecordImportPreviewFromUpload,
  executeGenerationRecordImport,
  exportGenerationRecords,
  getGenerationStats,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  updateGenerationRecord,
  voidGenerationRecord
} = require('../services/generationService');
const { getGenerationContract } = require('../services/contractService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || '00000000.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', authenticate, requirePermission('ledger:generation:template'), (req, res) => {
  sendSuccess(res, getGenerationContract(), { meta: { contractOnly: false } });
});

router.get('/statistics/monthly', authenticate, requirePermission('ledger:generation:view'), asyncHandler(async (req, res) => {
  const result = getMonthlyGenerationStatistics(req.query);
  sendSuccess(res, result.rows, { meta: { ...result.meta, summary: result.summary } });
}));

router.get('/stats', authenticate, requirePermission('ledger:generation:view'), asyncHandler(async (req, res) => {
  const result = getGenerationStats(req.query);
  sendSuccess(res, result, { meta: result.meta });
}));

router.get('/records/export', authenticate, requirePermission('ledger:generation:export'), asyncHandler(async (req, res) => {
  const result = exportGenerationRecords(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `00000000.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/records/import/preview', authenticate, requirePermission('ledger:generation:preview'), requireWritable('generation:records-import-preview'), (req, res, next) => {
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

router.post('/records/import/execute', authenticate, requirePermission('ledger:generation:execute'), requireWritable('generation:records-import-execute'), asyncHandler(async (req, res) => {
  const audit = await executeGenerationRecordImport(req.body || {});
  sendSuccess(res, audit);
}));

router.get('/records', authenticate, requirePermission('ledger:generation:view'), asyncHandler(async (req, res) => {
  const result = listGenerationRecords(req.query);
  sendSuccess(res, result.rows, { meta: { ...buildGenerationMeta(), pagination: result.pagination } });
}));

router.post('/records', authenticate, requirePermission('ledger:generation:create'), requireWritable('generation:create-record'), asyncHandler(async (req, res) => {
  const record = createGenerationRecord(req.body || {});
  sendSuccess(res, record, { statusCode: 201, meta: buildGenerationMeta() });
}));

router.put('/records/:id', authenticate, requirePermission('ledger:generation:update'), requireWritable('generation:update-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

router.delete('/records/:id', authenticate, requirePermission('ledger:generation:void'), requireWritable('generation:void-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

module.exports = router;
