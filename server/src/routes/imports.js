const fs = require('fs');
const express = require('express');
const { openDatabase } = require('../db/database');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { assertWritableAllowed } = require('../services/maintenanceState');
const {
  cleanupUploadedImportFile,
  normalizeUploadError,
  uploadImportFile
} = require('../middleware/upload');
const { monthlyEnergyManagedDirectPreflight } = require('../middleware/demoContext');
const { getImportContract } = require('../services/contractService');
const {
  assertImportBatchDomainPermission,
  createImportBatchFromUpload,
  deleteImportBatch,
  getImportBatchFileDownload,
  getImportBatchQueryDetail,
  getRestrictedImportTypesForUser,
  listImportBatches,
  listImportErrors
} = require('../services/importService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'daoru-pici-yuanwen';
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

/** 记录 Artifact 07 孤立上传清理失败；日志不得包含 context token 或文件内容。 */
function logMonthlyEnergyUploadCleanupFailure(file, reason, error = null) {
  console.warn('[imports] Artifact 07 managed upload cleanup failed', {
    reason,
    storedFilename: file?.filename || null,
    errorCode: error?.code || null
  });
}

/** 仅删除没有 import_batches 引用的本次上传文件；查询失败时 fail-safe 保留并记录。 */
function cleanupUnreferencedMonthlyEnergyUpload(file, reason) {
  if (!file?.filename) {
    const cleaned = cleanupUploadedImportFile(file);
    if (!cleaned && file?.path) logMonthlyEnergyUploadCleanupFailure(file, reason);
    return cleaned;
  }
  let db;
  try {
    db = openDatabase();
    const references = Number(db.prepare(`SELECT COUNT(*) AS total
      FROM import_batches WHERE stored_filename = ?`).get(file.filename)?.total || 0);
    if (references > 0) return false;
    const fileExists = Boolean(file.path && fs.existsSync(file.path));
    const cleaned = cleanupUploadedImportFile(file);
    if (!cleaned && fileExists) logMonthlyEnergyUploadCleanupFailure(file, reason);
    return cleaned;
  } catch (error) {
    logMonthlyEnergyUploadCleanupFailure(file, `${reason}:reference-check`, error);
    return false;
  } finally {
    if (db?.open) db.close();
  }
}

router.get('/contract', authenticate, requirePermission('imports:view'), (req, res) => {
  sendSuccess(res, getImportContract(), { meta: { contractOnly: false } });
});

router.get('/batches', authenticate, requirePermission('imports:view'), asyncHandler(async (req, res) => {
  const excludedImportTypes = getRestrictedImportTypesForUser(req.user.id, 'view');
  const result = listImportBatches(req.query, { excludedImportTypes });
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/batches', authenticate, requirePermission('imports:create'), requireWritable('imports:create-batch'), monthlyEnergyManagedDirectPreflight, (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      if (req.demoContext) {
        cleanupUnreferencedMonthlyEnergyUpload(req.file, 'managed-upload-error');
      }
      next(normalizedUploadError);
      return;
    }

    Promise.resolve()
      .then(() => {
        assertWritableAllowed('imports:create-batch:after-upload');
        return createImportBatchFromUpload(req.file, {
          duplicateStrategy: req.body.duplicateStrategy || 'skip',
          fieldMapping: req.body.fieldMapping,
          demoContext: req.demoContext
        });
      })
      .then((batch) => {
        if (req.demoContext && batch.terminalReplay === true) {
          cleanupUnreferencedMonthlyEnergyUpload(req.file, 'terminal-replay');
        }
        sendSuccess(res, batch, { statusCode: 201 });
      })
      .catch((error) => {
        if (req.demoContext) {
          cleanupUnreferencedMonthlyEnergyUpload(req.file, 'managed-import-error');
        }
        next(error);
      });
  });
});

router.get('/batches/:batchId', authenticate, requirePermission('imports:view'), asyncHandler(async (req, res) => {
  assertImportBatchDomainPermission(req.params.batchId, req.user.id, 'view');
  const result = getImportBatchQueryDetail(req.params.batchId);
  sendSuccess(res, result);
}));

router.delete('/batches/:batchId', authenticate, requirePermission('imports:delete'), requireWritable('imports:delete-batch'), asyncHandler(async (req, res) => {
  // 删除结果由服务在强制备份、业务删除和持久化审计全部成功后返回。
  const result = await deleteImportBatch(req.params.batchId, {
    actor: {
      userId: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      ip: req.ip
    }
  });
  sendSuccess(res, result);
}));

router.get('/batches/:batchId/download', authenticate, requirePermission('imports:download'), asyncHandler(async (req, res, next) => {
  assertImportBatchDomainPermission(req.params.batchId, req.user.id, 'download');
  const result = getImportBatchFileDownload(req.params.batchId);
  res.setHeader('Content-Type', getImportFileContentType(result.fileType));
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `daoru-pici-yuanwen-${result.batchId}.${result.fileType}`));
  res.sendFile(result.filePath, (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
}));

router.get('/batches/:batchId/errors', authenticate, requirePermission('imports:view'), asyncHandler(async (req, res) => {
  assertImportBatchDomainPermission(req.params.batchId, req.user.id, 'view');
  const result = listImportErrors(req.params.batchId, req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

module.exports = router;
