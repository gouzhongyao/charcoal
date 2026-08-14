'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  demoContextPreflight
} = require('../middleware/demoContext');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY
} = require('../services/energyAnalysisImportCore');
const {
  executeEnergyBenchmarkDefinitionImport,
  executeEnergyBenchmarkTargetImport,
  executeEnergyConversionFactorImport,
  previewEnergyBenchmarkDefinitionImport,
  previewEnergyBenchmarkTargetImport,
  previewEnergyConversionFactorImport
} = require('../services/energyBenchmarkImportService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 折标系数与能效对标导入预演权限，供后续 RBAC 种子和正式挂载稳定复用。
const ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION = 'energy:benchmarks:import:preview';
// 折标系数与能效对标导入执行权限，供后续 RBAC 种子和正式挂载稳定复用。
const ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION = 'energy:benchmarks:import:execute';
// 预演与执行权限保持独立，避免只读预演账号获得业务写入能力。
const ENERGY_BENCHMARK_IMPORT_PERMISSIONS = Object.freeze({
  preview: ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION,
  execute: ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION
});
// execute JSON 请求体上限，避免在认证通过后接受无界请求体。
const ENERGY_BENCHMARK_EXECUTE_JSON_LIMIT_BYTES = 64 * 1024;
// 路由内 JSON 解析器必须位于认证、权限和维护态之后；阶段 8 正式挂载时 router 必须先于全局 express.json。
const parseEnergyBenchmarkExecuteJson = express.json({ limit: ENERGY_BENCHMARK_EXECUTE_JSON_LIMIT_BYTES });
// 独立折标系数与能效对标受控导入路由；本阶段不挂载正式 index。
const router = express.Router();

/**
 * 在身份、权限和维护态校验后解析受限 JSON，并将解析错误投影为安全稳定响应。
 * @param {object} req Express 请求。
 * @param {object} res Express 响应。
 * @param {Function} next Express 后续处理器。
 */
function parseExecuteJsonBody(req, res, next) {
  parseEnergyBenchmarkExecuteJson(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      next(new AppError('REQUEST_BODY_TOO_LARGE', 'execute JSON 请求体超过大小限制。', {
        statusCode: 413,
        details: {
          code: 'ENERGY_BENCHMARK_IMPORT_JSON_TOO_LARGE',
          maxBodyBytes: ENERGY_BENCHMARK_EXECUTE_JSON_LIMIT_BYTES
        }
      }));
      return;
    }
    next(badRequest('execute JSON 请求体格式无效。', {
      code: 'ENERGY_BENCHMARK_IMPORT_JSON_INVALID'
    }));
  });
}

/**
 * 将模板服务的稳定原生错误转换为统一 400，避免响应暴露原始异常。
 * @param {Error} error 预演阶段错误。
 * @returns {Error} 可交给统一错误中间件的安全错误。
 */
function normalizeBenchmarkPreviewError(error) {
  if (error instanceof AppError) return error;
  const stableCode = String(error?.code || '').trim();
  if (/^[A-Z][A-Z0-9_]{2,127}$/.test(stableCode)) {
    return badRequest('导入模板或文件校验失败。', { code: stableCode });
  }
  return error;
}

/**
 * 创建单文件导入预演处理器：成功保留原文件，任何上传或领域失败均清理当前文件。
 * @param {Function} previewService 对应领域的预演服务。
 * @returns {Function} Express 路由处理器。
 */
function createPreviewHandler(previewService) {
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
        .then(() => previewService(req.file, serviceOptions))
        .then((preview) => {
          sendSuccess(res, preview);
        })
        .catch((error) => {
          cleanupUploadedImportFile(req.file);
          next(normalizeBenchmarkPreviewError(error));
        });
    });
  };
}

/**
 * 从服务端持久化 preview 批次恢复 execute 完整性见证。
 * 客户端只负责提交 batchId 与固定确认字段，不能覆盖摘要、签名或候选行。
 * @param {object} requestBody 客户端 JSON 请求体。
 * @returns {object} 传给领域 execute 服务的服务端受控请求体。
 */
function buildTrustedExecuteBody(requestBody) {
  const batch = getImportAuditBatchDetail(requestBody.batchId, { includeIssues: false });
  const auditContext = batch?.auditContext && typeof batch.auditContext === 'object'
    ? batch.auditContext
    : {};
  const candidateRows = Array.isArray(auditContext.candidateRows)
    ? auditContext.candidateRows
    : [];
  const candidateRowIds = Array.isArray(auditContext.candidateRowIds)
    ? auditContext.candidateRowIds
    : candidateRows.map((row) => row.candidateRowId);
  return {
    batchId: requestBody.batchId,
    confirmText: requestBody.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: requestBody.requireBackup,
    acknowledgeSkippedRisks: requestBody.acknowledgeSkippedRisks,
    fileSha256: batch.fileSha256,
    previewSignature: batch.previewSignature,
    previewAuditDigest: batch.previewAuditDigest,
    expectedWouldImport: candidateRows.length,
    candidateRowIds,
    candidateRows
  };
}

/**
 * 创建只接收 JSON 批次与确认字段的执行处理器。
 * 原文件读取、当前数据库重算、授权、备份和写入仍由领域服务完成。
 * @param {Function} executeService 对应领域的执行服务。
 * @returns {Function} Express 异步路由处理器。
 */
function createExecuteHandler(executeService) {
  return asyncHandler(async (req, res) => {
    const trustedBody = buildTrustedExecuteBody(req.body || {});
    const serviceOptions = req.demoContext ? { demoContext: {
      token: req.demoContext.token,
      userId: req.user.id,
      artifactKey: req.demoContext.artifactKey,
      handlerKey: req.demoContext.handlerKey
    } } : {};
    const result = await executeService(trustedBody, serviceOptions);
    sendSuccess(res, result);
  });
}

/** 创建显式 artifact/handler 的 demo-aware preflight。 */
function demoAware(artifactKey, handlerKey, phase) {
  return demoContextPreflight({ artifactKey, handlerKey, phase, allowFormal: true });
}

// 能源折标系数预演与执行。
router.post(
  '/conversion-factors/preview',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-benchmarks:conversion-factors-import-preview'),
  demoAware('19-conversion-factors', 'energy-conversion-factors-import', 'preview'),
  createPreviewHandler(previewEnergyConversionFactorImport)
);
router.post(
  '/conversion-factors/execute',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-benchmarks:conversion-factors-import-execute'),
  demoAware('19-conversion-factors', 'energy-conversion-factors-import', 'execute'),
  parseExecuteJsonBody,
  createExecuteHandler(executeEnergyConversionFactorImport)
);

// 能效对标定义预演与执行。
router.post(
  '/definitions/preview',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-benchmarks:definitions-import-preview'),
  demoAware('20-benchmark-definitions', 'energy-benchmark-definitions-import', 'preview'),
  createPreviewHandler(previewEnergyBenchmarkDefinitionImport)
);
router.post(
  '/definitions/execute',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-benchmarks:definitions-import-execute'),
  demoAware('20-benchmark-definitions', 'energy-benchmark-definitions-import', 'execute'),
  parseExecuteJsonBody,
  createExecuteHandler(executeEnergyBenchmarkDefinitionImport)
);

// 能效对标目标预演与执行。
router.post(
  '/targets/preview',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-benchmarks:targets-import-preview'),
  demoAware('21-benchmark-targets', 'energy-benchmark-targets-import', 'preview'),
  createPreviewHandler(previewEnergyBenchmarkTargetImport)
);
router.post(
  '/targets/execute',
  authenticate,
  requirePermission(ENERGY_BENCHMARK_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-benchmarks:targets-import-execute'),
  demoAware('21-benchmark-targets', 'energy-benchmark-targets-import', 'execute'),
  parseExecuteJsonBody,
  createExecuteHandler(executeEnergyBenchmarkTargetImport)
);

module.exports = router;
module.exports.ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION = ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION;
module.exports.ENERGY_BENCHMARK_IMPORT_PERMISSIONS = ENERGY_BENCHMARK_IMPORT_PERMISSIONS;
module.exports.ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION = ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION;
