'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const {
  executeDeviceStateImport,
  executeShiftScheduleImport,
  previewDeviceStateImport,
  previewShiftScheduleImport
} = require('../services/energyOperationsImportService');
const {
  executeEnergyTimeseriesImport,
  previewEnergyTimeseriesImport
} = require('../services/energyTimeseriesImportService');
const { AppError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 时序能耗导入的预演与执行权限保持独立，供后续 RBAC 种子稳定复用。
const ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS = Object.freeze({
  preview: 'energy:analysis:timeseries:preview',
  execute: 'energy:analysis:timeseries:execute'
});

// 排班与设备状态属于运营记录导入，共用预演与执行权限族。
const ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS = Object.freeze({
  preview: 'energy:analysis:operations:preview',
  execute: 'energy:analysis:operations:execute'
});

// execute JSON 体积与现有全局解析上限保持一致，但必须在认证、权限和维护态之后解析。
const ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT = '2mb';
// 阶段 8 必须先挂载本路由，再挂载应用级 express.json，避免匿名畸形 JSON 绕过认证边界。
const ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT = Object.freeze({
  beforeGlobalJsonParser: true,
  recommendedBasePath: '/api/energy-analysis/imports'
});
// execute 专用 JSON 解析器，不由调用方或全局中间件提前消费请求流。
const parseExecuteJsonBody = express.json({ limit: ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT });
// 能源分析受控导入路由实例。
const router = express.Router();

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

      Promise.resolve()
        .then(() => previewService(req.file))
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

/**
 * 在认证、权限和维护态校验后解析 execute JSON，并把 body-parser 错误映射为稳定脱敏响应。
 * @param {object} req Express 请求。
 * @param {object} res Express 响应。
 * @param {Function} next Express 后续函数。
 */
function parseEnergyAnalysisExecuteJson(req, res, next) {
  parseExecuteJsonBody(req, res, (parseError) => {
    if (!parseError) {
      next();
      return;
    }
    if (parseError.type === 'entity.too.large' || parseError.status === 413) {
      next(new AppError(
        'ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE',
        '能源分析导入 execute 请求体超过大小限制。',
        {
          statusCode: 413,
          details: {
            code: 'ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE',
            maxBodySize: ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT
          }
        }
      ));
      return;
    }
    next(new AppError(
      'ENERGY_ANALYSIS_EXECUTE_JSON_INVALID',
      '能源分析导入 execute 请求体必须是合法 JSON。',
      {
        statusCode: 400,
        details: { code: 'ENERGY_ANALYSIS_EXECUTE_JSON_INVALID' }
      }
    ));
  });
}

/**
 * 创建仅接收 JSON 批次见证的执行处理器，候选重算与授权全部交由领域服务完成。
 * @param {Function} executeService 对应领域的执行服务。
 * @returns {Function} Express 异步路由处理器。
 */
function createExecuteHandler(executeService) {
  return asyncHandler(async (req, res) => {
    const result = await executeService(req.body || {});
    sendSuccess(res, result);
  });
}

router.post(
  '/timeseries/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.preview),
  requireWritable('energy-analysis:timeseries-import-preview'),
  createPreviewHandler(previewEnergyTimeseriesImport)
);

router.post(
  '/timeseries/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.execute),
  requireWritable('energy-analysis:timeseries-import-execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeEnergyTimeseriesImport)
);

router.post(
  '/shift-schedules/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.preview),
  requireWritable('energy-analysis:shift-schedule-import-preview'),
  createPreviewHandler(previewShiftScheduleImport)
);

router.post(
  '/shift-schedules/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.execute),
  requireWritable('energy-analysis:shift-schedule-import-execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeShiftScheduleImport)
);

router.post(
  '/device-states/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.preview),
  requireWritable('energy-analysis:device-state-import-preview'),
  createPreviewHandler(previewDeviceStateImport)
);

router.post(
  '/device-states/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.execute),
  requireWritable('energy-analysis:device-state-import-execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeDeviceStateImport)
);

module.exports = router;
module.exports.ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT = ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT;
module.exports.ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT = ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT;
module.exports.ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS = ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS;
module.exports.ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS = ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS;
