const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const { normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { getImportContract } = require('../services/contractService');
const { createImportBatchFromUpload, deleteImportBatch, getImportBatchFileDownload, getImportBatchQueryDetail, listImportBatches, listImportErrors } = require('../services/importService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'import-file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function getImportFileContentType(fileType) {
  if (fileType === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (fileType === 'xls') {
    return 'application/vnd.ms-excel';
  }
  if (fileType === 'csv') {
    return 'text/csv; charset=utf-8';
  }
  return 'application/octet-stream';
}

router.get('/contract', (req, res) => {
  sendSuccess(res, getImportContract(), { meta: { contractOnly: false } });
});

router.get('/batches', asyncHandler(async (req, res) => {
  const result = listImportBatches(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/batches', requireWritable('imports:create-batch'), (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      next(normalizedUploadError);
      return;
    }

    Promise.resolve()
      .then(() => {
        assertWritableAllowed('imports:create-batch:after-upload');
        return createImportBatchFromUpload(req.file, {
          duplicateStrategy: req.body.duplicateStrategy || 'skip',
          fieldMapping: req.body.fieldMapping
        });
      })
      .then((batch) => {
        sendSuccess(res, batch, { statusCode: 201 });
      })
      .catch(next);
  });
});

router.get('/batches/:batchId', asyncHandler(async (req, res) => {
  const result = getImportBatchQueryDetail(req.params.batchId);
  sendSuccess(res, result);
}));

router.delete('/batches/:batchId', requireWritable('imports:delete-batch'), asyncHandler(async (req, res) => {
  const result = deleteImportBatch(req.params.batchId);
  sendSuccess(res, result);
}));

router.get('/batches/:batchId/download', asyncHandler(async (req, res, next) => {
  const result = getImportBatchFileDownload(req.params.batchId);
  res.setHeader('Content-Type', getImportFileContentType(result.fileType));
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `import-batch-${result.batchId}.${result.fileType}`));
  res.sendFile(result.filePath, (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
}));

router.get('/batches/:batchId/errors', asyncHandler(async (req, res) => {
  const result = listImportErrors(req.params.batchId, req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

module.exports = router;
