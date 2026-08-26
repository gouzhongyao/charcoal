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
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  executeCarbonEmissionReportImport,
  previewCarbonEmissionReportImport
} = require('../services/carbonEmissionReportImportService');
const {
  CARBON_EMISSION_REPORT_IMPORT_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
  assertCarbonEmissionReportAllowedFields
} = require('../services/carbonEmissionReportContracts');
const {
  exportCarbonEmissionReport,
  getCarbonEmissionReport,
  getCarbonEmissionReportByBatch,
  listCarbonEmissionReports
} = require('../services/carbonEmissionReportService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// N6-A 使用四个独立细分权限；旧 carbon:view 和其他碳领域权限不兜底。
const CARBON_EMISSION_REPORT_PERMISSIONS = Object.freeze({
  view: 'carbon:emission-reports:view',
  importPreview: 'carbon:emission-reports:import:preview',
  importExecute: 'carbon:emission-reports:import:execute',
  export: 'carbon:emission-reports:export'
});
// execute JSON 必须在认证、授权、维护态和 demo context 校验后受限解析。
const CARBON_EMISSION_REPORT_JSON_LIMIT_BYTES = 64 * 1024;
const parseCarbonEmissionReportJson = express.json({ limit: CARBON_EMISSION_REPORT_JSON_LIMIT_BYTES });
const router = express.Router();

/** 将受限 JSON 解析错误映射为稳定 N6-A 错误。 */
function parseCarbonEmissionReportJsonBody(req, res, next) {
  parseCarbonEmissionReportJson(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      return next(new AppError('CARBON_EMISSION_REPORT_JSON_TOO_LARGE', '碳排放报告请求体超过大小限制。', {
        statusCode: 413,
        details: { code: 'CARBON_EMISSION_REPORT_JSON_TOO_LARGE', maxBodyBytes: CARBON_EMISSION_REPORT_JSON_LIMIT_BYTES }
      }));
    }
    return next(badRequest('碳排放报告 JSON 请求体格式无效。', {
      code: 'CARBON_EMISSION_REPORT_JSON_INVALID'
    }));
  });
}

/** 构造受控导入和操作审计操作者。 */
function getActor(req) {
  return { userId: req.user?.id || null, ip: req.ip || null };
}

/** 将统一导入问题显式投影为 N6 预演公开字段。 */
function projectCarbonEmissionReportPreviewIssue(issue = {}) {
  return {
    rowNumber: Number(issue.rowNumber || 0),
    fieldName: String(issue.fieldName || ''),
    code: String(issue.code || ''),
    message: String(issue.message || ''),
    severity: String(issue.severity || 'error')
  };
}

/** 将共享服务内部预演显式投影为 N6 公共 DTO，禁止安全链和原始候选进入 HTTP。 */
function projectCarbonEmissionReportPreview(preview = {}) {
  const summary = preview.summary || {};
  return {
    batchId: Number(preview.batchId || 0),
    templateType: CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
    templateVersion: CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
    summary: {
      totalRows: Number(summary.totalRows || 0),
      wouldImport: Number(summary.wouldImport || 0),
      skipped: Number(summary.skipped || 0),
      blocked: Number(summary.blocked || 0),
      warnings: Number(summary.warnings || 0),
      errors: Number(summary.errors || 0)
    },
    notices: Array.isArray(preview.notices) ? preview.notices.map((notice) => String(notice)) : [],
    items: Array.isArray(preview.items) ? preview.items.map((item) => ({
      rowNumber: Number(item.rowNumber || 0),
      reportCode: item.reportCode === null || item.reportCode === undefined ? '' : String(item.reportCode),
      reportName: item.reportName === null || item.reportName === undefined ? '' : String(item.reportName),
      status: String(item.status || 'blocked'),
      counts: {
        boundaries: Number(item.counts?.boundaries || 0),
        items: Number(item.counts?.items || 0),
        summaries: Number(item.counts?.summaries || 0),
        evidence: Number(item.counts?.evidence || 0)
      },
      issues: Array.isArray(item.issues) ? item.issues.map(projectCarbonEmissionReportPreviewIssue) : []
    })) : []
  };
}

/** 将共享服务 execute 结果显式投影为 N6 公共 DTO，仅返回导入业务结果。 */
function projectCarbonEmissionReportExecuteResult(result = {}) {
  return {
    batchId: Number(result.batchId || 0),
    imported: Number(result.imported || 0),
    importedIds: Array.isArray(result.importedIds) ? result.importedIds.map((id) => Number(id)) : []
  };
}

/** 生成 UTF-8 和稳定 ASCII 下载响应头。 */
function buildContentDisposition(fileName, asciiFileName) {
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** 仅清理未被统一导入批次引用的上传文件，查询异常时 fail-safe 保留。 */
function cleanupUnreferencedCarbonEmissionReportFile(file) {
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

/** 将共享上传错误投影为稳定 N6-A 领域错误。 */
function normalizeCarbonEmissionReportUploadError(error) {
  const normalized = normalizeUploadError(error);
  if (normalized?.code === 'IMPORT_FILE_TOO_LARGE' || normalized?.details?.code === 'IMPORT_FILE_TOO_LARGE') {
    return new AppError('CARBON_EMISSION_REPORT_IMPORT_FILE_TOO_LARGE', '碳排放报告上传文件超过大小限制。', {
      statusCode: 413,
      details: { code: 'CARBON_EMISSION_REPORT_IMPORT_FILE_TOO_LARGE', maxFileSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES }
    });
  }
  return normalized;
}

/** 在所有访问控制后接收唯一 file 字段并执行零业务写入预演。 */
function carbonEmissionReportPreviewHandler(req, res, next) {
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeCarbonEmissionReportUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUnreferencedCarbonEmissionReportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve()
      .then(() => {
        const unexpectedFields = Object.keys(req.body || {});
        if (unexpectedFields.length > 0) {
          throw badRequest('碳排放报告预演只接受单个 file 文件字段。', {
            code: 'CARBON_EMISSION_REPORT_IMPORT_FORM_FIELDS_REJECTED', unexpectedFields
          });
        }
        return previewCarbonEmissionReportImport(req.file, { actor: getActor(req) });
      })
      .then((preview) => sendSuccess(res, projectCarbonEmissionReportPreview(preview)))
      .catch((error) => {
        cleanupUnreferencedCarbonEmissionReportFile(req.file);
        next(error);
      });
  });
}

/** execute 仅接受恢复服务端见证所需的固定四字段确认。 */
function normalizeCarbonEmissionReportExecuteBody(input) {
  assertCarbonEmissionReportAllowedFields(input, new Set([
    'batchId', 'confirmText', 'requireBackup', 'acknowledgeSkippedRisks'
  ]), 'import-execute');
  if (input.confirmText !== CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT
    || input.requireBackup !== true
    || input.acknowledgeSkippedRisks !== true) {
    throw badRequest('碳排放报告导入执行必须确认固定文案、备份和统一导入风险声明。', {
      code: 'CARBON_EMISSION_REPORT_IMPORT_CONFIRMATION_INVALID',
      expectedConfirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT
    });
  }
  const batch = getImportAuditBatchDetail(input.batchId, { includeIssues: false });
  if (batch.importType !== CARBON_EMISSION_REPORT_IMPORT_TYPE
    || batch.auditContext?.templateType !== CARBON_EMISSION_REPORT_TEMPLATE_TYPE) {
    throw badRequest('批次不属于碳排放报告预演。', {
      code: 'CARBON_EMISSION_REPORT_IMPORT_BATCH_TYPE_MISMATCH', batchId: input.batchId
    });
  }
  return {
    batchId: input.batchId,
    confirmText: input.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 将候选、签名、审计摘要或并发重复导致的预演漂移统一映射为 N6 领域 409。 */
function normalizeCarbonEmissionReportExecuteError(error) {
  const code = String(error?.details?.code || error?.code || '');
  const staleCodes = new Set([
    'CARBON_EMISSION_REPORT_CODE_STALE',
    'CARBON_EMISSION_REPORT_CODE_EXISTS',
    'ENERGY_ANALYSIS_IMPORT_RECOMPUTED_CANDIDATES_INVALID',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_INVALID',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_INVALID',
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID',
    'ENERGY_ANALYSIS_IMPORT_BATCH_FILE_SHA256_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_SIGNATURE_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_AUDIT_DIGEST_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_SOURCE_OR_BATCH_INVALID'
  ]);
  if (!staleCodes.has(code) && !code.startsWith('ENERGY_ANALYSIS_UPLOAD_')) return error;
  return new AppError(
    'CARBON_EMISSION_REPORT_PREVIEW_STALE',
    '碳排放报告预演已失效，请重新预演。',
    {
      statusCode: 409,
      details: { requiresNewPreview: true }
    }
  );
}

router.get('/', authenticate, requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.view), (req, res, next) => {
  try {
    const result = listCarbonEmissionReports(req.query || {});
    sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
  } catch (error) {
    next(error);
  }
});

// 固定 batches 路由必须先于动态报告 ID 路由。
router.get('/batches/:batchId', authenticate, requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.view), (req, res, next) => {
  try {
    sendSuccess(res, getCarbonEmissionReportByBatch(req.params.batchId));
  } catch (error) {
    next(error);
  }
});

router.post(
  '/imports/preview',
  authenticate,
  requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.importPreview),
  requireWritable('carbon-emission-reports:import-preview'),
  rejectUnconnectedDemoContext,
  carbonEmissionReportPreviewHandler
);

router.post(
  '/imports/execute',
  authenticate,
  requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.importExecute),
  requireWritable('carbon-emission-reports:import-execute'),
  rejectUnconnectedDemoContext,
  parseCarbonEmissionReportJsonBody,
  asyncHandler(async (req, res) => {
    const body = normalizeCarbonEmissionReportExecuteBody(req.body || {});
    try {
      const result = await executeCarbonEmissionReportImport(body, { actor: getActor(req) });
      sendSuccess(res, projectCarbonEmissionReportExecuteResult(result));
    } catch (error) {
      throw normalizeCarbonEmissionReportExecuteError(error);
    }
  })
);

router.get('/:reportId/export', authenticate, requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.export), (req, res, next) => {
  try {
    const result = exportCarbonEmissionReport(req.params.reportId);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, result.asciiFileName));
    res.setHeader('Content-Length', String(result.body.length));
    res.setHeader('X-Exported-Row-Count', String(result.rowCount));
    res.status(200).send(result.body);
  } catch (error) {
    next(error);
  }
});

router.get('/:reportId', authenticate, requirePermission(CARBON_EMISSION_REPORT_PERMISSIONS.view), (req, res, next) => {
  try {
    sendSuccess(res, getCarbonEmissionReport(req.params.reportId));
  } catch (error) {
    next(error);
  }
});

// N6-A 未知异常在路由边界统一收口，开发环境也不得泄漏文件路径、SQL、IP 或堆栈。
router.use((error, _req, _res, next) => {
  if (error instanceof AppError) {
    next(error);
    return;
  }
  next(new AppError('CARBON_EMISSION_REPORT_INTERNAL_ERROR', '碳排放报告服务暂时不可用。', {
    statusCode: 500
  }));
});

module.exports = router;
module.exports.CARBON_EMISSION_REPORT_PERMISSIONS = CARBON_EMISSION_REPORT_PERMISSIONS;
module.exports.normalizeCarbonEmissionReportExecuteBody = normalizeCarbonEmissionReportExecuteBody;
module.exports.normalizeCarbonEmissionReportExecuteError = normalizeCarbonEmissionReportExecuteError;
module.exports.normalizeCarbonEmissionReportUploadError = normalizeCarbonEmissionReportUploadError;
module.exports.projectCarbonEmissionReportExecuteResult = projectCarbonEmissionReportExecuteResult;
module.exports.projectCarbonEmissionReportPreview = projectCarbonEmissionReportPreview;
