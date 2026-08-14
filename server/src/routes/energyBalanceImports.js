'use strict';

const express = require('express');
const { openDatabase, uploadsDir } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  cleanupUploadedImportFile,
  normalizeUploadError,
  uploadImportFile
} = require('../middleware/upload');
const {
  demoContextPreflight
} = require('../middleware/demoContext');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  readSafeUploadFile,
  stableSerialize
} = require('../services/energyAnalysisImportCore');
const {
  ENERGY_BALANCE_CONFIRM_TEXT,
  buildEnergyBalanceBundleImportPreview,
  executeEnergyBalanceBundleImport,
  parseEnergyBalanceBundleRows,
  previewEnergyBalanceBundleImport
} = require('../services/energyBalanceImportService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 平衡导入预演权限模块。
const ENERGY_BALANCE_IMPORT_PREVIEW_PERMISSION = 'energy:balance:import:preview';
// 平衡导入执行权限模块。
const ENERGY_BALANCE_IMPORT_EXECUTE_PERMISSION = 'energy:balance:import:execute';
// 平衡导入权限集合模块。
const ENERGY_BALANCE_IMPORT_PERMISSIONS = Object.freeze({
  preview: ENERGY_BALANCE_IMPORT_PREVIEW_PERMISSION,
  execute: ENERGY_BALANCE_IMPORT_EXECUTE_PERMISSION
});
// 平衡导入路由实例模块。
const router = express.Router();
// execute 请求体大小限制模块。
const ENERGY_BALANCE_EXECUTE_JSON_LIMIT_BYTES = 64 * 1024;
// 路由内 execute JSON 解析器模块。
const executeJsonParser = express.json({
  limit: ENERGY_BALANCE_EXECUTE_JSON_LIMIT_BYTES,
  strict: true
});

/** 在认证、权限和维护态检查后解析 execute JSON。 */
function parseExecuteJsonBody(req, res, next) {
  executeJsonParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      next(new AppError('REQUEST_BODY_TOO_LARGE', '请求体超过平衡配置导入执行接口允许的大小。', {
        statusCode: 413,
        details: { maxBodyBytes: ENERGY_BALANCE_EXECUTE_JSON_LIMIT_BYTES }
      }));
      return;
    }
    next(new AppError('INVALID_JSON_BODY', '请求体必须是合法 JSON。', {
      statusCode: 400,
      details: null
    }));
  });
}

/** 抛出不污染 preview 批次的请求错误。 */
function throwBundleRequestError(code, message) {
  throw badRequest(message, { code });
}

/** 校验客户端必须显式提交的固定确认字段。 */
function assertBundleConfirmation(body) {
  if (body.confirmText !== ENERGY_BALANCE_CONFIRM_TEXT) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH', '固定中文确认文本不匹配。');
  }
  if (body.requireBackup !== true) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED', 'requireBackup 必须显式为 true。');
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED', 'acknowledgeSkippedRisks 必须显式为 true。');
  }
}

/** 判断两个批次具备无副作用 stale 预检所需的最小可信配对特征。 */
function canPreflightBundlePair(boundaryBatch, itemBatch) {
  const boundaryContext = boundaryBatch?.auditContext;
  const itemContext = itemBatch?.auditContext;
  return boundaryBatch?.importType === 'energy_balance_boundary'
    && itemBatch?.importType === 'energy_balance_item'
    && boundaryBatch.auditPhase === 'preview'
    && itemBatch.auditPhase === 'preview'
    && boundaryContext?.batchRole === 'boundary'
    && itemContext?.batchRole === 'item'
    && boundaryContext.uploadGroupId
    && boundaryContext.uploadGroupId === itemContext.uploadGroupId
    && boundaryBatch.storedFilename
    && boundaryBatch.storedFilename === itemBatch.storedFilename
    && boundaryBatch.fileSha256
    && boundaryBatch.fileSha256 === itemBatch.fileSha256
    && boundaryBatch.previewSignature === itemBatch.previewSignature
    && boundaryBatch.previewAuditDigest === itemBatch.previewAuditDigest;
}

/** 对双工作表上传执行无写入结构预检。 */
function preflightBundlePreviewUpload(file) {
  if (!file) return;
  if (String(file.originalname || '').split('.').pop().toLowerCase() !== 'xlsx') {
    throwBundleRequestError('ENERGY_BALANCE_BUNDLE_XLSX_REQUIRED', '平衡配置导入只允许 XLSX 文件。');
  }
  const safeFile = readSafeUploadFile(uploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined
  });
  const parsed = parseEnergyBalanceBundleRows(safeFile.buffer, file.originalname);
  const collectionErrors = (parsed.workbookResult?.sheetCollection?.issues || [])
    .filter((issue) => issue.severity !== 'warning');
  if (collectionErrors.length > 0) {
    throw badRequest('平衡配置双工作表模板结构不完整。', {
      code: 'ENERGY_BALANCE_BUNDLE_WORKBOOK_STRUCTURE_INVALID',
      issueCodes: [...new Set(collectionErrors.map((issue) => issue.code).filter(Boolean))]
    });
  }
}

/** 创建上传 preview 处理器并在失败时清理本次文件。 */
function createPreviewHandler(previewService, preflightUpload) {
  return (req, res, next) => {
    uploadImportFile(req, res, (uploadError) => {
      const normalizedUploadError = normalizeUploadError(uploadError);
      if (normalizedUploadError) {
        cleanupUploadedImportFile(req.file);
        next(normalizedUploadError);
        return;
      }
      const serviceOptions = req.demoContext ? { demoContext: {
        token: req.demoContext.token,
        userId: req.user.id,
        artifactKey: req.demoContext.artifactKey,
        handlerKey: req.demoContext.handlerKey
      } } : {};
      Promise.resolve()
        .then(() => preflightUpload(req.file))
        .then(() => previewService(req.file, serviceOptions))
        .then((preview) => {
          sendSuccess(res, preview);
        })
        .catch((error) => {
          cleanupUploadedImportFile(req.file);
          next(error);
        });
    });
  };
}

/** 从服务端持久化边界批次恢复联合候选见证。 */
function buildTrustedBundleExecuteBody(requestBody, boundaryBatch) {
  const auditContext = boundaryBatch?.auditContext && typeof boundaryBatch.auditContext === 'object'
    ? boundaryBatch.auditContext
    : {};
  const candidateRows = Array.isArray(auditContext.combinedCandidateRows)
    ? auditContext.combinedCandidateRows
    : [];
  const candidateRowIds = Array.isArray(auditContext.combinedCandidateRowIds)
    ? auditContext.combinedCandidateRowIds
    : candidateRows.map((row) => row.candidateRowId);
  return {
    boundaryBatchId: requestBody.boundaryBatchId,
    itemBatchId: requestBody.itemBatchId,
    uploadGroupId: auditContext.uploadGroupId,
    confirmText: requestBody.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: requestBody.requireBackup,
    acknowledgeSkippedRisks: requestBody.acknowledgeSkippedRisks,
    fileSha256: boundaryBatch.fileSha256,
    previewSignature: boundaryBatch.previewSignature,
    previewAuditDigest: boundaryBatch.previewAuditDigest,
    expectedWouldImport: candidateRows.length,
    candidateRowIds,
    candidateRows
  };
}

/** 在进入领域 execute 前使用当前数据库重算并阻断 stale。 */
function preflightBundleExecute(boundaryBatch, itemBatch) {
  if (!canPreflightBundlePair(boundaryBatch, itemBatch)) return;
  const auditContext = boundaryBatch.auditContext;
  const safeFile = readSafeUploadFile(uploadsDir, boundaryBatch.storedFilename, {
    expectedSizeBytes: boundaryBatch.fileSizeBytes
  });
  if (safeFile.fileSha256 !== boundaryBatch.fileSha256) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH', '服务端原文件摘要与 preview 批次不一致。');
  }
  const database = openDatabase();
  try {
    const currentPreview = buildEnergyBalanceBundleImportPreview({
      db: database,
      buffer: safeFile.buffer,
      originalFilename: boundaryBatch.originalFilename
    });
    const persistedCandidates = Array.isArray(auditContext.combinedCandidateRows)
      ? auditContext.combinedCandidateRows
      : [];
    if (currentPreview.candidateRows.length !== persistedCandidates.length) {
      throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH', '当前数据库重算候选数量与 preview 不一致。');
    }
    if (stableSerialize(currentPreview.candidateRows) !== stableSerialize(persistedCandidates)) {
      throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH', '当前数据库重算候选或业务来源与 preview 不一致。');
    }
  } finally {
    database.close();
  }
}

/** 创建平衡 bundle 显式 demo-aware preflight。 */
function demoAware(phase) {
  return demoContextPreflight({
    artifactKey: '25-energy-balance-configs',
    handlerKey: 'energy-balance-bundle-import',
    phase,
    allowFormal: true
  });
}

// 平衡边界和九角色项目双工作表预演路由。
router.post(
  '/bundle/preview',
  authenticate,
  requirePermission(ENERGY_BALANCE_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-balance:bundle-import-preview'),
  demoAware('preview'),
  createPreviewHandler(previewEnergyBalanceBundleImport, preflightBundlePreviewUpload)
);

// 平衡边界和九角色项目双工作表执行路由。
router.post(
  '/bundle/execute',
  authenticate,
  requirePermission(ENERGY_BALANCE_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-balance:bundle-import-execute'),
  demoAware('execute'),
  parseExecuteJsonBody,
  asyncHandler(async (req, res) => {
    const requestBody = req.body || {};
    assertBundleConfirmation(requestBody);
    const boundaryBatch = getImportAuditBatchDetail(requestBody.boundaryBatchId, { includeIssues: false });
    const itemBatch = getImportAuditBatchDetail(requestBody.itemBatchId, { includeIssues: false });
    preflightBundleExecute(boundaryBatch, itemBatch);
    const trustedBody = buildTrustedBundleExecuteBody(requestBody, boundaryBatch);
    const result = await executeEnergyBalanceBundleImport(trustedBody, {
      actor: {
        userId: req.user.id,
        username: req.user.username,
        ip: req.ip
      },
      demoContext: req.demoContext ? {
        token: req.demoContext.token,
        userId: req.user.id,
        artifactKey: req.demoContext.artifactKey,
        handlerKey: req.demoContext.handlerKey
      } : null
    });
    sendSuccess(res, result);
  })
);

module.exports = router;
module.exports.ENERGY_BALANCE_IMPORT_EXECUTE_PERMISSION = ENERGY_BALANCE_IMPORT_EXECUTE_PERMISSION;
module.exports.ENERGY_BALANCE_IMPORT_PERMISSIONS = ENERGY_BALANCE_IMPORT_PERMISSIONS;
module.exports.ENERGY_BALANCE_IMPORT_PREVIEW_PERMISSION = ENERGY_BALANCE_IMPORT_PREVIEW_PERMISSION;
