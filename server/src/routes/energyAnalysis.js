'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requirePermission } = require('../middleware/permission');
const {
  getEnergyLoadCurve,
  getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis
} = require('../services/energyConsumptionAnalysisService');
const { previewEnergyStrategies } = require('../services/energyStrategyEvaluationService');
const { sendSuccess } = require('../utils/response');

// 负荷摘要只读查询权限，阶段 8 可据此接入 RBAC 菜单种子。
const ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION = 'energy:analysis:view';
// 确定性策略预演权限，与普通分析查看权限保持独立。
const ENERGY_STRATEGY_EVALUATE_PERMISSION = 'energy:strategy:evaluate';
// 独立路由公开的权限集合，供正式挂载和权限配置统一复用。
const ENERGY_ANALYSIS_PERMISSIONS = Object.freeze({
  loadSummary: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  monthlyAnalysis: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  loadCurve: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  strategyEvaluate: ENERGY_STRATEGY_EVALUATE_PERMISSION
});
// 负荷摘要允许从查询字符串进入领域服务的字段白名单。
const LOAD_SUMMARY_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'minimumCoverageRate'
]);
// 固定 UTC 负荷曲线允许从查询字符串进入领域服务的字段白名单。
const LOAD_CURVE_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'outputIntervalMinutes'
]);
// 月度消费分析允许从查询字符串进入领域服务的字段白名单。
const MONTHLY_ANALYSIS_INPUT_FIELDS = Object.freeze([
  'startMonth',
  'endMonth',
  'organizationUnitId',
  'includeDescendants',
  'energyTypeCode',
  'unit',
  'topN'
]);
// 策略预演允许从 JSON 正文进入领域服务的字段白名单。
const STRATEGY_EVALUATION_INPUT_FIELDS = Object.freeze([
  ...LOAD_SUMMARY_INPUT_FIELDS,
  'ruleCodes'
]);
// 独立能源分析只读路由；本阶段不挂载正式 index。
const router = express.Router();

/**
 * 从普通对象中投影允许字段，数组和其他非法类型保留给领域服务统一校验。
 * @param {*} source 请求查询或正文。
 * @param {string[]} allowedFields 允许进入领域服务的字段。
 * @returns {*} 白名单投影后的输入或原非法类型。
 */
function pickAllowedInput(source, allowedFields) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  // 投影结果使用普通对象，兼容领域服务现有输入契约。
  const projectedInput = {};
  allowedFields.forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) {
      projectedInput[fieldName] = source[fieldName];
    }
  });
  return projectedInput;
}

/**
 * 构造统一只读响应元数据，只引用服务已经确定的公式版本。
 * @param {object} result 领域服务结果。
 * @param {string} operation 稳定操作标识。
 * @returns {object} 统一响应附加元数据。
 */
function buildReadOnlyResponseMeta(result, operation) {
  return {
    operation,
    readOnly: true,
    maintenanceAllowed: true,
    formulaVersion: result.formulaVersion
  };
}

// 查询单表计、单能源、单单位和单来源时区的负荷摘要。
router.get(
  '/consumption/load-summary',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.loadSummary),
  asyncHandler(async (req, res) => {
    // 查询参数只通过白名单进入负荷摘要服务，重复参数数组由服务安全拒绝。
    const serviceInput = pickAllowedInput(req.query, LOAD_SUMMARY_INPUT_FIELDS);
    // 领域服务保持只读并自行管理短生命周期 SQLite 连接。
    const result = await getEnergyLoadSummary(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-load-summary')
    });
  })
);

// 查询月度消费趋势、同环比、关联结构、TopN 和峰值月份。
router.get(
  '/consumption/monthly-analysis',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.monthlyAnalysis),
  asyncHandler(async (req, res) => {
    // 查询参数只通过白名单进入月度服务，重复参数数组由服务安全拒绝。
    const serviceInput = pickAllowedInput(req.query, MONTHLY_ANALYSIS_INPUT_FIELDS);
    // 月度服务只读取已明确写入的能耗事实，不应用发电抵扣或隐式主数据过滤。
    const result = await getMonthlyConsumptionAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'monthly-consumption-analysis')
    });
  })
);

// 查询固定 UTC 网格负荷曲线，并从同一组桶投影本地热力结果。
router.get(
  '/consumption/load-curve',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.loadCurve),
  asyncHandler(async (req, res) => {
    // 查询参数只通过白名单进入负荷曲线服务，重复参数数组由服务安全拒绝。
    const serviceInput = pickAllowedInput(req.query, LOAD_CURVE_INPUT_FIELDS);
    // 曲线服务保持只读并自行管理短生命周期 SQLite 连接。
    const result = await getEnergyLoadCurve(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-load-curve')
    });
  })
);

// 预演本地确定性策略规则，不创建运行记录、命中记录或控制指令。
router.post(
  '/strategies/evaluate',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyEvaluate),
  asyncHandler(async (req, res) => {
    // JSON 正文只投影公开字段，连接、测试钩子和其他额外字段不会进入服务 options。
    const serviceInput = pickAllowedInput(req.body, STRATEGY_EVALUATION_INPUT_FIELDS);
    // 预演服务在一致读取快照内计算结果，但不持久化评价运行或规则命中。
    const result = await previewEnergyStrategies(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-strategy-evaluation')
    });
  })
);

module.exports = router;
module.exports.ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION = ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION;
module.exports.ENERGY_ANALYSIS_PERMISSIONS = ENERGY_ANALYSIS_PERMISSIONS;
module.exports.ENERGY_STRATEGY_EVALUATE_PERMISSION = ENERGY_STRATEGY_EVALUATE_PERMISSION;
module.exports.LOAD_CURVE_INPUT_FIELDS = LOAD_CURVE_INPUT_FIELDS;
module.exports.LOAD_SUMMARY_INPUT_FIELDS = LOAD_SUMMARY_INPUT_FIELDS;
module.exports.MONTHLY_ANALYSIS_INPUT_FIELDS = MONTHLY_ANALYSIS_INPUT_FIELDS;
module.exports.STRATEGY_EVALUATION_INPUT_FIELDS = STRATEGY_EVALUATION_INPUT_FIELDS;
