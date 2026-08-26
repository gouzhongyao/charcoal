'use strict';

const express = require('express');
const { openDatabase } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const {
  SUPPLIER_IMPORT_CONFIRM_TEXT,
  SUPPLIER_TEMPLATE_TYPE,
  createSupplier,
  executeSupplierImport,
  exportSuppliers,
  getSupplier,
  listSuppliers,
  previewSupplierImport,
  setSupplierStatus,
  updateSupplier
} = require('../services/supplierService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 供应商接口权限与冻结 RBAC 节点一一对应，预演和执行保持分离。
const SUPPLIER_PERMISSIONS = Object.freeze({
  view: 'ledger:suppliers:view',
  create: 'ledger:suppliers:create',
  update: 'ledger:suppliers:update',
  status: 'ledger:suppliers:status',
  importPreview: 'ledger:suppliers:import:preview',
  importExecute: 'ledger:suppliers:import:execute',
  export: 'ledger:suppliers:export'
});
const SUPPLIER_JSON_LIMIT_BYTES = 64 * 1024;
const parseSupplierJson = express.json({ limit: SUPPLIER_JSON_LIMIT_BYTES });
const router = express.Router();

/** 在身份、权限和维护态通过后解析受限 JSON，并投影稳定错误。 */
function parseSupplierJsonBody(req, res, next) {
  parseSupplierJson(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      next(new AppError('REQUEST_BODY_TOO_LARGE', '供应商请求体超过大小限制。', {
        statusCode: 413,
        details: { code: 'SUPPLIER_JSON_TOO_LARGE', maxBodyBytes: SUPPLIER_JSON_LIMIT_BYTES }
      }));
      return;
    }
    next(badRequest('供应商 JSON 请求体格式无效。', { code: 'SUPPLIER_JSON_INVALID' }));
  });
}

/** 构造供应商服务使用的操作审计操作者。 */
function getActor(req) {
  return { userId: req.user?.id || null, ip: req.ip || null };
}

/** 生成兼容旧客户端和 UTF-8 文件名的下载响应头。 */
function buildContentDisposition(fileName) {
  return `attachment; filename="suppliers.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** 仅在没有任何导入批次引用时清理供应商上传文件，查询失败时安全保留。 */
function cleanupUnreferencedSupplierImportFile(file) {
  if (!file?.filename) return cleanupUploadedImportFile(file);
  let db;
  try {
    db = openDatabase();
    const referenceCount = Number(db.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE stored_filename = ?')
      .get(file.filename)?.total || 0);
    return referenceCount === 0 ? cleanupUploadedImportFile(file) : false;
  } catch (_error) {
    return false;
  } finally {
    if (db?.open) db.close();
  }
}

/** 预演成功保留服务端原文件；失败时仅清理未被批次引用的文件。 */
function supplierPreviewHandler(req, res, next) {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUnreferencedSupplierImportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => previewSupplierImport(req.file, { actor: getActor(req) }))
      .then((preview) => sendSuccess(res, preview))
      .catch((error) => {
        cleanupUnreferencedSupplierImportFile(req.file);
        next(error);
      });
  });
}

/** execute 只接收最小确认字段，客户端候选、签名和摘要字段一律拒绝。 */
function normalizeSupplierExecuteBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('供应商导入执行请求体必须是 JSON 对象。', { code: 'SUPPLIER_IMPORT_EXECUTE_BODY_INVALID' });
  }
  const allowedFields = new Set(['batchId', 'confirmText', 'requireBackup', 'acknowledgeSkippedRisks']);
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('供应商导入执行不接受客户端候选、签名或摘要字段。', {
      code: 'SUPPLIER_IMPORT_CLIENT_WITNESS_REJECTED',
      unknownFields
    });
  }
  if (input.confirmText !== SUPPLIER_IMPORT_CONFIRM_TEXT
    || input.requireBackup !== true
    || input.acknowledgeSkippedRisks !== true) {
    throw badRequest('供应商导入执行必须确认固定文案、备份和跳过风险。', {
      code: 'SUPPLIER_IMPORT_CONFIRMATION_INVALID',
      expectedConfirmText: SUPPLIER_IMPORT_CONFIRM_TEXT
    });
  }
  const batch = getImportAuditBatchDetail(input.batchId, { includeIssues: false });
  if (batch.importType !== 'supplier'
    || batch.auditContext?.templateType !== SUPPLIER_TEMPLATE_TYPE) {
    throw badRequest('批次不属于供应商导入预演。', {
      code: 'SUPPLIER_IMPORT_BATCH_TYPE_MISMATCH',
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

router.get('/', authenticate, requirePermission(SUPPLIER_PERMISSIONS.view), (req, res, next) => {
  try {
    const result = listSuppliers(req.query || {});
    sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
  } catch (error) {
    next(error);
  }
});

router.get('/export.xlsx', authenticate, requirePermission(SUPPLIER_PERMISSIONS.export), (req, res, next) => {
  try {
    const result = exportSuppliers(req.query || {});
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(result.fileName));
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
  requirePermission(SUPPLIER_PERMISSIONS.importPreview),
  requireWritable('suppliers:import-preview'),
  supplierPreviewHandler
);

router.post(
  '/imports/execute',
  authenticate,
  requirePermission(SUPPLIER_PERMISSIONS.importExecute),
  requireWritable('suppliers:import-execute'),
  parseSupplierJsonBody,
  asyncHandler(async (req, res) => {
    const body = normalizeSupplierExecuteBody(req.body || {});
    const result = await executeSupplierImport(body, { actor: getActor(req) });
    sendSuccess(res, result);
  })
);

router.get('/:id', authenticate, requirePermission(SUPPLIER_PERMISSIONS.view), (req, res, next) => {
  try {
    sendSuccess(res, getSupplier(req.params.id));
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  authenticate,
  requirePermission(SUPPLIER_PERMISSIONS.create),
  requireWritable('suppliers:create'),
  parseSupplierJsonBody,
  (req, res, next) => {
    try {
      sendSuccess(res, createSupplier(req.body || {}, getActor(req)), { statusCode: 201 });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  requirePermission(SUPPLIER_PERMISSIONS.update),
  requireWritable('suppliers:update'),
  parseSupplierJsonBody,
  (req, res, next) => {
    try {
      sendSuccess(res, updateSupplier(req.params.id, req.body || {}, getActor(req)));
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/status',
  authenticate,
  requirePermission(SUPPLIER_PERMISSIONS.status),
  requireWritable('suppliers:status'),
  parseSupplierJsonBody,
  (req, res, next) => {
    try {
      const body = req.body || {};
      const unknownFields = Object.keys(body).filter((fieldName) => fieldName !== 'status');
      if (unknownFields.length > 0) {
        throw badRequest('供应商状态接口仅接受 status 字段。', {
          code: 'SUPPLIER_STATUS_UNKNOWN_FIELDS_REJECTED',
          unknownFields
        });
      }
      sendSuccess(res, setSupplierStatus(req.params.id, body.status, getActor(req)));
    } catch (error) {
      next(error);
    }
  }
);

// 供应商业务仅允许踢出与恢复，不注册任何 DELETE 路由。
module.exports = router;
module.exports.SUPPLIER_PERMISSIONS = SUPPLIER_PERMISSIONS;
module.exports.normalizeSupplierExecuteBody = normalizeSupplierExecuteBody;
