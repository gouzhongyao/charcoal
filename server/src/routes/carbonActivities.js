'use strict';

const express = require('express');
const { openDatabase } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { rejectUnconnectedDemoContext } = require('../middleware/demoContext');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  MAX_IMPORT_FILE_SIZE_BYTES,
  cleanupUploadedImportFile,
  normalizeUploadError,
  uploadImportFile
} = require('../middleware/upload');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  executeCarbonActivityImport,
  previewCarbonActivityImport
} = require('../services/carbonActivityImportService');
const {
  assertCarbonActivityAllowedFields,
  CARBON_ACTIVITY_TEMPLATE_TYPE
} = require('../services/carbonActivityContracts');
const {
  exportCarbonActivities,
  getCarbonActivity,
  listCarbonActivities,
  voidCarbonActivity
} = require('../services/carbonActivityService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 独立碳活动接口使用五个冻结细分权限，旧 carbon:view 和 emissions 权限不兜底。
const CARBON_ACTIVITY_PERMISSIONS = Object.freeze({
  view: 'carbon:activities:view',
  importPreview: 'carbon:activities:import:preview',
  importExecute: 'carbon:activities:import:execute',
  calculate: 'carbon:activities:calculate',
  export: 'carbon:activities:export'
});
// execute 和作废 JSON 在认证、权限和维护态之后受限解析。
const CARBON_ACTIVITY_JSON_LIMIT_BYTES = 64 * 1024;
const parseCarbonActivityJson = express.json({ limit: CARBON_ACTIVITY_JSON_LIMIT_BYTES });
const router = express.Router();

/** 在认证授权后解析受限 JSON，并投影稳定无底层文本错误。 */
function parseCarbonActivityJsonBody(req, res, next) {
  parseCarbonActivityJson(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      return next(new AppError('CARBON_ACTIVITY_JSON_TOO_LARGE', '独立碳活动请求体超过大小限制。', {
        statusCode: 413,
        details: { code: 'CARBON_ACTIVITY_JSON_TOO_LARGE', maxBodyBytes: CARBON_ACTIVITY_JSON_LIMIT_BYTES }
      }));
    }
    return next(badRequest('独立碳活动 JSON 请求体格式无效。', { code: 'CARBON_ACTIVITY_JSON_INVALID' }));
  });
}

/** 构造服务操作审计操作者。 */
function getActor(req) {
  return { userId: req.user?.id || null, ip: req.ip || null };
}

/** 生成 UTF-8 和稳定 ASCII 下载文件名。 */
function buildContentDisposition(fileName, asciiFileName) {
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** 仅在没有批次引用时清理当前活动上传文件；查询失败时 fail-safe 保留。 */
function cleanupUnreferencedCarbonActivityFile(file) {
  if (!file?.filename) return cleanupUploadedImportFile(file);
  let db;
  try {
    db = openDatabase();
    const references = Number(db.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE stored_filename = ?')
      .get(file.filename)?.total || 0);
    return references === 0 ? cleanupUploadedImportFile(file) : false;
  } catch (_error) {
    return false;
  } finally {
    if (db?.open) db.close();
  }
}

/** 将活动上传大小限制固定投影为 HTTP 413，其他历史导入合同保持不变。 */
function normalizeCarbonActivityUploadError(error) {
  const normalized = normalizeUploadError(error);
  if (normalized?.code === 'IMPORT_FILE_TOO_LARGE' || normalized?.details?.code === 'IMPORT_FILE_TOO_LARGE') {
    return new AppError('CARBON_ACTIVITY_IMPORT_FILE_TOO_LARGE', '独立碳活动上传文件超过大小限制。', {
      statusCode: 413,
      details: { code: 'CARBON_ACTIVITY_IMPORT_FILE_TOO_LARGE', maxFileSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES }
    });
  }
  return normalized;
}

/** 活动预演成功保留原文件；资源或合同失败时只清理未被审计批次引用的文件。 */
function carbonActivityPreviewHandler(req, res, next) {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeCarbonActivityUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUnreferencedCarbonActivityFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => previewCarbonActivityImport(req.file, { actor: getActor(req) }))
      .then((preview) => sendSuccess(res, preview))
      .catch((error) => {
        cleanupUnreferencedCarbonActivityFile(req.file);
        next(error);
      });
  });
}

/** execute 只接受服务端恢复见证所需的四个最小确认字段。 */
function normalizeCarbonActivityExecuteBody(input) {
  assertCarbonActivityAllowedFields(input, new Set([
    'batchId', 'confirmText', 'requireBackup', 'acknowledgeSkippedRisks'
  ]), 'import-execute');
  if (input.confirmText !== CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT
    || input.requireBackup !== true
    || input.acknowledgeSkippedRisks !== true) {
    throw badRequest('独立碳活动导入执行必须确认固定文案、备份和跳过风险。', {
      code: 'CARBON_ACTIVITY_IMPORT_CONFIRMATION_INVALID',
      expectedConfirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT
    });
  }
  const batch = getImportAuditBatchDetail(input.batchId, { includeIssues: false });
  if (batch.importType !== 'carbon_activity'
    || batch.auditContext?.templateType !== CARBON_ACTIVITY_TEMPLATE_TYPE) {
    throw badRequest('批次不属于独立碳活动预演。', {
      code: 'CARBON_ACTIVITY_IMPORT_BATCH_TYPE_MISMATCH',
      batchId: input.batchId
    });
  }
  return {
    batchId: input.batchId,
    confirmText: input.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

router.get('/', authenticate, requirePermission(CARBON_ACTIVITY_PERMISSIONS.view), (req, res, next) => {
  try {
    const result = listCarbonActivities(req.query || {});
    sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
  } catch (error) {
    next(error);
  }
});

// 静态 export 路由必须先于 /:activityId 注册。
router.get('/export', authenticate, requirePermission(CARBON_ACTIVITY_PERMISSIONS.export), (req, res, next) => {
  try {
    const result = exportCarbonActivities(req.query || {});
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, result.asciiFileName));
    res.setHeader('Content-Length', String(result.body.length));
    res.setHeader('X-Exported-Row-Count', String(result.rowCount));
    res.status(200).send(result.body);
  } catch (error) {
    next(error);
  }
});

router.post(
  '/imports/preview',
  authenticate,
  requirePermission(CARBON_ACTIVITY_PERMISSIONS.importPreview),
  requireWritable('carbon-activities:import-preview'),
  rejectUnconnectedDemoContext,
  carbonActivityPreviewHandler
);

router.post(
  '/imports/execute',
  authenticate,
  requirePermission(CARBON_ACTIVITY_PERMISSIONS.importExecute),
  requireWritable('carbon-activities:import-execute'),
  rejectUnconnectedDemoContext,
  parseCarbonActivityJsonBody,
  asyncHandler(async (req, res) => {
    const body = normalizeCarbonActivityExecuteBody(req.body || {});
    const result = await executeCarbonActivityImport(body, { actor: getActor(req) });
    sendSuccess(res, result);
  })
);

router.post(
  '/:activityId/void',
  authenticate,
  // 冻结权限没有独立作废编码；作废属于活动事实写操作，复用导入执行权限而不允许只读账号修改。
  requirePermission(CARBON_ACTIVITY_PERMISSIONS.importExecute),
  requireWritable('carbon-activities:void'),
  parseCarbonActivityJsonBody,
  (req, res, next) => {
    try {
      assertCarbonActivityAllowedFields(req.body || {}, new Set(['reason', 'expectedUpdatedAt']), 'void');
      sendSuccess(res, voidCarbonActivity(req.params.activityId, req.body || {}, getActor(req)));
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:activityId', authenticate, requirePermission(CARBON_ACTIVITY_PERMISSIONS.view), (req, res, next) => {
  try {
    sendSuccess(res, getCarbonActivity(req.params.activityId));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.CARBON_ACTIVITY_PERMISSIONS = CARBON_ACTIVITY_PERMISSIONS;
module.exports.normalizeCarbonActivityExecuteBody = normalizeCarbonActivityExecuteBody;
module.exports.normalizeCarbonActivityUploadError = normalizeCarbonActivityUploadError;
