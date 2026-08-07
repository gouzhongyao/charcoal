'use strict';

const express = require('express');
const { openDatabase, uploadsDir } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  readSafeUploadFile,
  stableSerialize
} = require('../services/energyAnalysisImportCore');
const {
  buildEnergyFlowBundleImportPreview,
  executeEnergyFlowBundleImport,
  executeEnergyFlowNodeImport,
  parseEnergyFlowBundleRows,
  parseEnergyFlowNodeRows,
  previewEnergyFlowBundleImport,
  previewEnergyFlowNodeImport
} = require('../services/energyFlowImportService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 能流导入预演权限，供后续 RBAC 种子和路由挂载稳定复用。
const ENERGY_FLOW_IMPORT_PREVIEW_PERMISSION = 'energy:flows:import:preview';
// 能流导入执行权限，供后续 RBAC 种子和路由挂载稳定复用。
const ENERGY_FLOW_IMPORT_EXECUTE_PERMISSION = 'energy:flows:import:execute';
// 能流导入权限集合，保持预演与执行权限相互独立。
const ENERGY_FLOW_IMPORT_PERMISSIONS = Object.freeze({
  preview: ENERGY_FLOW_IMPORT_PREVIEW_PERMISSION,
  execute: ENERGY_FLOW_IMPORT_EXECUTE_PERMISSION
});
// 独立能流导入路由实例；本阶段不挂载正式 index。
const router = express.Router();
// execute JSON 请求体上限，避免在认证后接受无界载荷。
const ENERGY_FLOW_EXECUTE_JSON_LIMIT_BYTES = 64 * 1024;
// 路由内 JSON 解析器，必须放在认证、权限和维护态之后调用。
const executeJsonParser = express.json({
  limit: ENERGY_FLOW_EXECUTE_JSON_LIMIT_BYTES,
  strict: true
});

/**
 * 在安全中间件之后解析 execute JSON，并将解析错误转换为稳定脱敏响应。
 * @param {object} req Express 请求。
 * @param {object} res Express 响应。
 * @param {Function} next Express 后续回调。
 */
function parseExecuteJsonBody(req, res, next) {
  executeJsonParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      next(new AppError('REQUEST_BODY_TOO_LARGE', '请求体超过能流导入执行接口允许的大小。', {
        statusCode: 413,
        details: { maxBodyBytes: ENERGY_FLOW_EXECUTE_JSON_LIMIT_BYTES }
      }));
      return;
    }
    next(new AppError('INVALID_JSON_BODY', '请求体必须是合法 JSON。', {
      statusCode: 400,
      details: null
    }));
  });
}

/**
 * 抛出不会修改审计批次的固定确认错误。
 * @param {string} code 稳定错误码。
 * @param {string} message 安全中文消息。
 * @returns {never} 始终抛出 BAD_REQUEST。
 */
function throwBundleRequestError(code, message) {
  throw badRequest(message, { code });
}

/**
 * 在调用双批次服务前验证用户必须显式提交的确认字段。
 * 该校验先于领域 execute，错误确认不会把可信 preview 批次改写为失败审计。
 * @param {object} body 客户端 JSON 请求体。
 */
function assertBundleConfirmation(body) {
  if (body.confirmText !== '确认导入能流边及显式边值') {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH', '固定中文确认文本不匹配。');
  }
  if (body.requireBackup !== true) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED', 'requireBackup 必须显式为 true。');
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED', 'acknowledgeSkippedRisks 必须显式为 true。');
  }
}

/**
 * 判断两个批次是否具备执行前文件与 stale 复核所需的最小可信配对特征。
 * 完整角色和签名校验仍由 energyFlowImportService 负责。
 * @param {object} edgeBatch 边批次详情。
 * @param {object} recordBatch 显式边值批次详情。
 * @returns {boolean} 是否可安全进入无副作用预检。
 */
function canPreflightBundlePair(edgeBatch, recordBatch) {
  const edgeContext = edgeBatch?.auditContext;
  const recordContext = recordBatch?.auditContext;
  return edgeBatch?.importType === 'energy_flow_edge'
    && recordBatch?.importType === 'energy_flow_record'
    && edgeBatch.auditPhase === 'preview'
    && recordBatch.auditPhase === 'preview'
    && edgeContext?.batchRole === 'edge'
    && recordContext?.batchRole === 'record'
    && edgeContext.uploadGroupId
    && edgeContext.uploadGroupId === recordContext.uploadGroupId
    && edgeBatch.storedFilename
    && edgeBatch.storedFilename === recordBatch.storedFilename
    && edgeBatch.fileSha256
    && edgeBatch.fileSha256 === recordBatch.fileSha256
    && edgeBatch.previewSignature === recordBatch.previewSignature
    && edgeBatch.previewAuditDigest === recordBatch.previewAuditDigest;
}

/**
 * 对双工作表上传执行无数据库写入的结构预检，缺失/额外工作表直接失败并清理文件。
 * @param {object} file Multer 已落盘文件。
 */
function preflightBundlePreviewUpload(file) {
  if (!file) return;
  const safeFile = readSafeUploadFile(uploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined
  });
  const parsed = parseEnergyFlowBundleRows(safeFile.buffer, file.originalname);
  const collectionErrors = (parsed.workbookResult?.sheetCollection?.issues || [])
    .filter((issue) => issue.severity !== 'warning');
  if (collectionErrors.length > 0) {
    throw badRequest('能流双工作表模板结构不完整。', {
      code: 'ENERGY_FLOW_BUNDLE_WORKBOOK_STRUCTURE_INVALID',
      issueCodes: [...new Set(collectionErrors.map((issue) => issue.code).filter(Boolean))]
    });
  }
}

/**
 * 对 XLSX 节点上传执行无数据库写入的工作表结构预检；CSV 沿用服务契约直接解析。
 * @param {object} file Multer 已落盘文件。
 */
function preflightNodePreviewUpload(file) {
  if (!file || String(file.originalname || '').split('.').pop().toLowerCase() !== 'xlsx') return;
  const safeFile = readSafeUploadFile(uploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined
  });
  const parsed = parseEnergyFlowNodeRows(safeFile.buffer, file.originalname);
  const structureErrors = (parsed.globalIssues || []).filter((issue) => issue.severity !== 'warning');
  if (structureErrors.some((issue) => issue.code === 'MISSING_TEMPLATE_SHEET' || issue.code === 'UNEXPECTED_TEMPLATE_SHEET')) {
    throw badRequest('能流节点模板工作表结构不完整。', {
      code: 'ENERGY_FLOW_NODE_WORKBOOK_STRUCTURE_INVALID',
      issueCodes: [...new Set(structureErrors.map((issue) => issue.code).filter(Boolean))]
    });
  }
}

/**
 * 创建上传预演处理器：成功保留原文件，任何上传、结构或领域失败均清理本次文件。
 * @param {Function} previewService 能流预演服务。
 * @param {Function} preflightUpload 无副作用上传预检。
 * @returns {Function} Express 路由处理器。
 */
function createPreviewHandler(previewService, preflightUpload) {
  return (req, res, next) => {
    uploadImportFile(req, res, (uploadError) => {
      const normalizedUploadError = normalizeUploadError(uploadError);
      if (normalizedUploadError) {
        cleanupUploadedImportFile(req.file);
        next(normalizedUploadError);
        return;
      }

      Promise.resolve()
        .then(() => preflightUpload(req.file))
        .then(() => previewService(req.file))
        .then((preview) => sendSuccess(res, preview))
        .catch((error) => {
          cleanupUploadedImportFile(req.file);
          next(error);
        });
    });
  };
}

/**
 * 从持久化边批次恢复双批次 execute 完整性见证，忽略客户端候选、签名和文件摘要。
 * @param {object} requestBody 客户端仅含批次 ID 与确认字段的请求体。
 * @param {object} edgeBatch 边批次详情。
 * @returns {object} 传给领域服务的服务端受控请求体。
 */
function buildTrustedBundleExecuteBody(requestBody, edgeBatch) {
  const auditContext = edgeBatch?.auditContext && typeof edgeBatch.auditContext === 'object'
    ? edgeBatch.auditContext
    : {};
  const candidateRows = Array.isArray(auditContext.combinedCandidateRows)
    ? auditContext.combinedCandidateRows
    : [];
  const candidateRowIds = Array.isArray(auditContext.combinedCandidateRowIds)
    ? auditContext.combinedCandidateRowIds
    : candidateRows.map((row) => row.candidateRowId);
  return {
    edgeBatchId: requestBody.edgeBatchId,
    recordBatchId: requestBody.recordBatchId,
    uploadGroupId: auditContext.uploadGroupId,
    confirmText: requestBody.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: requestBody.requireBackup,
    acknowledgeSkippedRisks: requestBody.acknowledgeSkippedRisks,
    fileSha256: edgeBatch.fileSha256,
    previewSignature: edgeBatch.previewSignature,
    previewAuditDigest: edgeBatch.previewAuditDigest,
    expectedWouldImport: candidateRows.length,
    candidateRowIds,
    candidateRows
  };
}

/**
 * 在领域 execute 前复核原文件与当前数据库候选，避免可恢复的篡改/stale 请求污染 preview 审计。
 * @param {object} edgeBatch 边批次详情。
 * @param {object} recordBatch 显式边值批次详情。
 */
function preflightBundleExecute(edgeBatch, recordBatch) {
  if (!canPreflightBundlePair(edgeBatch, recordBatch)) return;
  const auditContext = edgeBatch.auditContext;
  const safeFile = readSafeUploadFile(uploadsDir, edgeBatch.storedFilename, {
    expectedSizeBytes: edgeBatch.fileSizeBytes
  });
  if (safeFile.fileSha256 !== edgeBatch.fileSha256) {
    throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH', '服务端原文件摘要与 preview 批次不一致。');
  }

  const database = openDatabase();
  try {
    const currentPreview = buildEnergyFlowBundleImportPreview({
      db: database,
      buffer: safeFile.buffer,
      originalFilename: edgeBatch.originalFilename,
      fileSha256: safeFile.fileSha256,
      fileSizeBytes: safeFile.sizeBytes
    });
    const persistedCandidates = Array.isArray(auditContext.combinedCandidateRows)
      ? auditContext.combinedCandidateRows
      : [];
    if (currentPreview.candidateRows.length !== persistedCandidates.length) {
      throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH', '当前数据库重算候选数量与 preview 不一致。');
    }
    if (stableSerialize(currentPreview.candidateRows) !== stableSerialize(persistedCandidates)) {
      throwBundleRequestError('ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH', '当前数据库重算候选与 preview 不一致。');
    }
  } finally {
    database.close();
  }
}

// 能流节点单批次预演。
router.post(
  '/nodes/preview',
  authenticate,
  requirePermission(ENERGY_FLOW_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-flows:nodes-import-preview'),
  createPreviewHandler(previewEnergyFlowNodeImport, preflightNodePreviewUpload)
);

// 能流节点单批次执行。
router.post(
  '/nodes/execute',
  authenticate,
  requirePermission(ENERGY_FLOW_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-flows:nodes-import-execute'),
  parseExecuteJsonBody,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await executeEnergyFlowNodeImport(req.body || {}));
  })
);

// 能流边与显式边值双批次预演。
router.post(
  '/bundle/preview',
  authenticate,
  requirePermission(ENERGY_FLOW_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-flows:bundle-import-preview'),
  createPreviewHandler(previewEnergyFlowBundleImport, preflightBundlePreviewUpload)
);

// 能流边与显式边值双批次执行。
router.post(
  '/bundle/execute',
  authenticate,
  requirePermission(ENERGY_FLOW_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-flows:bundle-import-execute'),
  parseExecuteJsonBody,
  asyncHandler(async (req, res) => {
    const requestBody = req.body || {};
    assertBundleConfirmation(requestBody);
    const edgeBatch = getImportAuditBatchDetail(requestBody.edgeBatchId, { includeIssues: false });
    const recordBatch = getImportAuditBatchDetail(requestBody.recordBatchId, { includeIssues: false });
    preflightBundleExecute(edgeBatch, recordBatch);
    const trustedBody = buildTrustedBundleExecuteBody(requestBody, edgeBatch);
    sendSuccess(res, await executeEnergyFlowBundleImport(trustedBody));
  })
);

module.exports = router;
module.exports.ENERGY_FLOW_IMPORT_EXECUTE_PERMISSION = ENERGY_FLOW_IMPORT_EXECUTE_PERMISSION;
module.exports.ENERGY_FLOW_IMPORT_PERMISSIONS = ENERGY_FLOW_IMPORT_PERMISSIONS;
module.exports.ENERGY_FLOW_IMPORT_PREVIEW_PERMISSION = ENERGY_FLOW_IMPORT_PREVIEW_PERMISSION;
