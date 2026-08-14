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
  executeShiftDefinitionImport,
  executeStrategyRuleImport,
  executeTouSchemeImport,
  previewShiftDefinitionImport,
  previewStrategyRuleImport,
  previewTouSchemeImport
} = require('../services/energyAnalysisConfigurationImportService');
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

// 班次、TOU 和策略规则配置导入共用独立预演与执行权限。
const ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS = Object.freeze({
  preview: 'energy:analysis:config:import:preview',
  execute: 'energy:analysis:config:import:execute'
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
function createExecuteHandler(executeService, options = {}) {
  return asyncHandler(async (req, res) => {
    const serviceOptions = options.withAuditActor === true
      ? { actorUserId: req.user.id, actorIp: req.ip }
      : {};
    if (req.demoContext) {
      serviceOptions.demoContext = {
        token: req.demoContext.token,
        userId: req.user.id,
        artifactKey: req.demoContext.artifactKey,
        handlerKey: req.demoContext.handlerKey
      };
    }
    const result = await executeService(req.body || {}, serviceOptions);
    sendSuccess(res, result);
  });
}

/** 构造显式 artifact/handler 的 demo-aware preflight；无 context 时保持正式导入行为。 */
function demoAware(artifactKey, handlerKey, phase) {
  return demoContextPreflight({ artifactKey, handlerKey, phase, allowFormal: true });
}

router.post(
  '/timeseries/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.preview),
  requireWritable('energy-analysis:timeseries-import-preview'),
  demoAware('15-energy-timeseries', 'energy-timeseries-import', 'preview'),
  createPreviewHandler(previewEnergyTimeseriesImport)
);

router.post(
  '/timeseries/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.execute),
  requireWritable('energy-analysis:timeseries-import-execute'),
  demoAware('15-energy-timeseries', 'energy-timeseries-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeEnergyTimeseriesImport)
);

router.post(
  '/shift-schedules/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.preview),
  requireWritable('energy-analysis:shift-schedule-import-preview'),
  demoAware('14-shift-schedules', 'shift-schedules-import', 'preview'),
  createPreviewHandler(previewShiftScheduleImport)
);

router.post(
  '/shift-schedules/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.execute),
  requireWritable('energy-analysis:shift-schedule-import-execute'),
  demoAware('14-shift-schedules', 'shift-schedules-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeShiftScheduleImport)
);

router.post(
  '/device-states/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.preview),
  requireWritable('energy-analysis:device-state-import-preview'),
  demoAware('16-device-states', 'device-states-import', 'preview'),
  createPreviewHandler(previewDeviceStateImport)
);

router.post(
  '/device-states/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.execute),
  requireWritable('energy-analysis:device-state-import-execute'),
  demoAware('16-device-states', 'device-states-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeDeviceStateImport)
);

router.post(
  '/shift-definitions/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-analysis:shift-definition-import-preview'),
  demoAware('13-shift-definitions', 'shift-definitions-import', 'preview'),
  createPreviewHandler(previewShiftDefinitionImport)
);

router.post(
  '/shift-definitions/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-analysis:shift-definition-import-execute'),
  demoAware('13-shift-definitions', 'shift-definitions-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeShiftDefinitionImport, { withAuditActor: true })
);

router.post(
  '/tou-schemes/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-analysis:tou-scheme-import-preview'),
  demoAware('17-tou-schemes', 'tou-schemes-import', 'preview'),
  createPreviewHandler(previewTouSchemeImport)
);

router.post(
  '/tou-schemes/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-analysis:tou-scheme-import-execute'),
  demoAware('17-tou-schemes', 'tou-schemes-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeTouSchemeImport, { withAuditActor: true })
);

router.post(
  '/strategy-rules/preview',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.preview),
  requireWritable('energy-analysis:strategy-rule-import-preview'),
  demoAware('18-strategy-rules', 'strategy-rules-import', 'preview'),
  createPreviewHandler(previewStrategyRuleImport)
);

router.post(
  '/strategy-rules/execute',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS.execute),
  requireWritable('energy-analysis:strategy-rule-import-execute'),
  demoAware('18-strategy-rules', 'strategy-rules-import', 'execute'),
  parseEnergyAnalysisExecuteJson,
  createExecuteHandler(executeStrategyRuleImport, { withAuditActor: true })
);

module.exports = router;
module.exports.ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS = ENERGY_ANALYSIS_CONFIGURATION_IMPORT_PERMISSIONS;
module.exports.ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT = ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT;
module.exports.ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT = ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT;
module.exports.ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS = ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS;
module.exports.ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS = ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS;
