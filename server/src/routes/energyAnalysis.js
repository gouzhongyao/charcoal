'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  getDeviceStateConsumptionAnalysis,
  getEnergyLoadCurve,
  getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis,
  getShiftConsumptionAnalysis,
  getTimeOfUseConsumptionAnalysis
} = require('../services/energyConsumptionAnalysisService');
const {
  getPeakContributionAnalysis
} = require('../services/energyConsumptionPeakContributionService');
const {
  getEnergyIntensityAnalysis
} = require('../services/energyIntensityAnalysisService');
const {
  previewEnergyStrategies,
  runEnergyStrategyEvaluation,
  updateStrategyRuleHitStatus
} = require('../services/energyStrategyEvaluationService');
const {
  createShiftDefinition,
  createShiftDefinitionVersion,
  createStrategyRule,
  createStrategyRuleVersion,
  createTouScheme,
  createTouSchemeVersion,
  listShiftDefinitions,
  listStrategyRules,
  listTouSchemes,
  setShiftDefinitionStatus,
  setStrategyRuleStatus,
  setTouSchemeStatus
} = require('../services/energyConsumptionConfigurationService');
const { sendSuccess } = require('../utils/response');

// 消费分析只读查询权限，正式挂载时需由中央 RBAC 菜单种子提供。
const ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION = 'energy:analysis:view';
// 确定性策略预演权限，仅允许零写入评价。
const ENERGY_STRATEGY_EVALUATE_PERMISSION = 'energy:strategy:evaluate';
// 正式持久化策略运行权限。
const ENERGY_STRATEGY_RUN_PERMISSION = 'energy:strategy:run';
// 策略命中人工复核权限。
const ENERGY_STRATEGY_REVIEW_PERMISSION = 'energy:strategy:review';
// 三类生产配置的统一只读查询权限。
const ENERGY_CONFIGURATION_VIEW_PERMISSION = 'energy:analysis:config:view';
// 排班定义受控维护权限。
const ENERGY_SHIFT_CONFIGURATION_MANAGE_PERMISSION = 'energy:analysis:shift:manage';
// TOU 方案和周期规则受控维护权限。
const ENERGY_TOU_CONFIGURATION_MANAGE_PERMISSION = 'energy:analysis:tou:manage';
// 确定性策略规则受控维护权限。
const ENERGY_STRATEGY_RULE_MANAGE_PERMISSION = 'energy:strategy:rule:manage';
// 独立路由公开的权限集合，供正式挂载和权限配置统一复用。
const ENERGY_ANALYSIS_PERMISSIONS = Object.freeze({
  loadSummary: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  monthlyAnalysis: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  loadCurve: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  timeOfUseAnalysis: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  shiftAnalysis: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  deviceStateAnalysis: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  peakContribution: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  energyIntensity: ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  configurationView: ENERGY_CONFIGURATION_VIEW_PERMISSION,
  shiftConfigurationManage: ENERGY_SHIFT_CONFIGURATION_MANAGE_PERMISSION,
  touConfigurationManage: ENERGY_TOU_CONFIGURATION_MANAGE_PERMISSION,
  strategyRuleManage: ENERGY_STRATEGY_RULE_MANAGE_PERMISSION,
  strategyEvaluate: ENERGY_STRATEGY_EVALUATE_PERMISSION,
  strategyRun: ENERGY_STRATEGY_RUN_PERMISSION,
  strategyHitReview: ENERGY_STRATEGY_REVIEW_PERMISSION
});
// 单表计时序分析公共查询字段白名单。
const LOAD_SUMMARY_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'minimumCoverageRate'
]);
// 固定 UTC 负荷曲线额外接受输出粒度。
const LOAD_CURVE_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'outputIntervalMinutes'
]);
// 月度消费分析允许的筛选字段。
const MONTHLY_ANALYSIS_INPUT_FIELDS = Object.freeze([
  'startMonth',
  'endMonth',
  'organizationUnitId',
  'includeDescendants',
  'energyTypeCode',
  'unit',
  'topN'
]);
// 峰平谷分析必须显式指定单一方案。
const TIME_OF_USE_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'touSchemeId'
]);
// 班次和设备状态分析共享的固定字段。
const SHIFT_AND_DEVICE_STATE_INPUT_FIELDS = Object.freeze([
  'meterDeviceId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone'
]);
// 高峰贡献按精确组织、能源、单位和固定 UTC 粒度分面。
const PEAK_CONTRIBUTION_INPUT_FIELDS = Object.freeze([
  'organizationUnitId',
  'energyTypeCode',
  'unit',
  'startUtc',
  'endUtc',
  'sourceTimeZone',
  'outputIntervalMinutes',
  'topContributors'
]);
// 消费量和强度只读衔接字段。
const ENERGY_INTENSITY_INPUT_FIELDS = Object.freeze([
  'productionUnitId',
  'startMonth',
  'endMonth',
  'energyTypeCode',
  'unit'
]);
// 策略预演和正式运行允许从 JSON 正文进入服务的字段。
const STRATEGY_EVALUATION_INPUT_FIELDS = Object.freeze([
  ...LOAD_SUMMARY_INPUT_FIELDS,
  'ruleCodes'
]);
// 策略命中人工复核只允许状态和备注。
const STRATEGY_HIT_STATUS_INPUT_FIELDS = Object.freeze([
  'manualStatus',
  'reviewNote'
]);
// 配置列表只允许按状态和稳定编码精确筛选。
const CONFIGURATION_QUERY_FIELDS = Object.freeze(['status', 'code']);
// 排班定义创建字段白名单。
const SHIFT_CONFIGURATION_CREATE_FIELDS = Object.freeze([
  'shiftCode', 'shiftName', 'startMinute', 'endMinute', 'crossesMidnight',
  'sourceTimeZone', 'source', 'version', 'effectiveStartUtc', 'effectiveEndUtc', 'status'
]);
// 排班版本修改不允许更换稳定编码。
const SHIFT_CONFIGURATION_VERSION_FIELDS = Object.freeze(
  SHIFT_CONFIGURATION_CREATE_FIELDS.filter((fieldName) => fieldName !== 'shiftCode')
);
// TOU 方案创建字段包含完整周期规则快照。
const TOU_CONFIGURATION_CREATE_FIELDS = Object.freeze([
  'schemeCode', 'schemeName', 'sourceTimeZone', 'source', 'documentNo', 'version',
  'effectiveStartUtc', 'effectiveEndUtc', 'status', 'periodRules'
]);
// TOU 版本修改不允许更换稳定编码。
const TOU_CONFIGURATION_VERSION_FIELDS = Object.freeze(
  TOU_CONFIGURATION_CREATE_FIELDS.filter((fieldName) => fieldName !== 'schemeCode')
);
// 策略规则创建仅接受固定指标和固定阈值字段。
const STRATEGY_RULE_CREATE_FIELDS = Object.freeze([
  'ruleCode', 'ruleName', 'ruleVersion', 'formulaVersion', 'metricCode',
  'thresholdOperator', 'thresholdValue', 'thresholdMin', 'thresholdMax',
  'thresholdUnit', 'reductionRate', 'priority', 'evidenceRequirements',
  'recommendationText', 'source', 'effectiveStartUtc', 'effectiveEndUtc',
  'sourceTimeZone', 'status'
]);
// 策略规则版本修改不允许更换稳定编码。
const STRATEGY_RULE_VERSION_FIELDS = Object.freeze(
  STRATEGY_RULE_CREATE_FIELDS.filter((fieldName) => fieldName !== 'ruleCode')
);
// 三类配置启停接口只接受状态。
const CONFIGURATION_STATUS_FIELDS = Object.freeze(['status']);
// 独立能源分析路由；当前文件仍不修改正式中央入口。
const router = express.Router();

/**
 * 从普通对象投影允许字段，非法类型保留给领域服务统一校验。
 * @param {*} source 请求查询或正文。
 * @param {string[]} allowedFields 允许字段。
 * @returns {*} 白名单投影结果或原非法类型。
 */
function pickAllowedInput(source, allowedFields) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  const projectedInput = {};
  allowedFields.forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) {
      projectedInput[fieldName] = source[fieldName];
    }
  });
  return projectedInput;
}

/**
 * 构造统一只读响应元数据。
 * @param {object} result 领域服务结果。
 * @param {string} operation 稳定操作标识。
 * @returns {object} 响应元数据。
 */
function buildReadOnlyResponseMeta(result, operation) {
  return {
    operation,
    readOnly: true,
    maintenanceAllowed: true,
    formulaVersion: result.formulaVersion
  };
}

/**
 * 构造统一写响应元数据。
 * @param {object} result 领域服务结果。
 * @param {string} operation 稳定操作标识。
 * @returns {object} 响应元数据。
 */
function buildWritableResponseMeta(result, operation) {
  return {
    operation,
    readOnly: false,
    maintenanceAllowed: false,
    formulaVersion: result.formulaVersion || null
  };
}

/**
 * 从已认证请求构造服务层原子审计上下文。
 * @param {object} req Express 请求。
 * @returns {object} 操作者和来源 IP。
 */
function buildAtomicAuditOptions(req) {
  return {
    actorUserId: req.user.id,
    actorIp: req.ip
  };
}

// 查询单表计、单能源、单单位和单来源时区的负荷摘要。
router.get(
  '/consumption/load-summary',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.loadSummary),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, LOAD_SUMMARY_INPUT_FIELDS);
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
    const serviceInput = pickAllowedInput(req.query, MONTHLY_ANALYSIS_INPUT_FIELDS);
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
    const serviceInput = pickAllowedInput(req.query, LOAD_CURVE_INPUT_FIELDS);
    const result = await getEnergyLoadCurve(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-load-curve')
    });
  })
);

// 查询显式单方案峰平谷消费分析，不自动猜测方案。
router.get(
  '/consumption/time-of-use',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.timeOfUseAnalysis),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, TIME_OF_USE_INPUT_FIELDS);
    const result = await getTimeOfUseConsumptionAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'time-of-use-consumption-analysis')
    });
  })
);

// 查询已物化 UTC 排班的班次消费分析。
router.get(
  '/consumption/shifts',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.shiftAnalysis),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, SHIFT_AND_DEVICE_STATE_INPUT_FIELDS);
    const result = await getShiftConsumptionAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'shift-consumption-analysis')
    });
  })
);

// 查询显式设备状态消费分析，只有显式 idle 作为空载依据。
router.get(
  '/consumption/device-states',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.deviceStateAnalysis),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, SHIFT_AND_DEVICE_STATE_INPUT_FIELDS);
    const result = await getDeviceStateConsumptionAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'device-state-consumption-analysis')
    });
  })
);

// 查询精确组织范围的高峰贡献事实和覆盖不足候选区间。
router.get(
  '/consumption/peak-contribution',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.peakContribution),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, PEAK_CONTRIBUTION_INPUT_FIELDS);
    const result = await getPeakContributionAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'peak-contribution-analysis')
    });
  })
);

// 查询只由 energy_records 和生产事实形成的严格消费量和强度。
router.get(
  '/consumption/intensity',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.energyIntensity),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, ENERGY_INTENSITY_INPUT_FIELDS);
    const result = await getEnergyIntensityAnalysis(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-intensity-analysis')
    });
  })
);

// 查询排班定义及全部历史版本。
router.get(
  '/config/shifts',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.configurationView),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, CONFIGURATION_QUERY_FIELDS);
    const result = listShiftDefinitions(serviceInput);
    sendSuccess(res, result, { meta: buildReadOnlyResponseMeta(result, 'energy-shift-configuration-list') });
  })
);

// 创建首个排班定义版本。
router.post(
  '/config/shifts',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.shiftConfigurationManage),
  requireWritable('energy:analysis:shift:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, SHIFT_CONFIGURATION_CREATE_FIELDS);
    const result = createShiftDefinition(serviceInput, buildAtomicAuditOptions(req));
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-shift-configuration-create') });
  })
);

// 基于历史排班创建新版本，不覆盖原记录。
router.post(
  '/config/shifts/:shiftDefinitionId/versions',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.shiftConfigurationManage),
  requireWritable('energy:analysis:shift:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, SHIFT_CONFIGURATION_VERSION_FIELDS);
    const result = createShiftDefinitionVersion(
      req.params.shiftDefinitionId,
      serviceInput,
      buildAtomicAuditOptions(req)
    );
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-shift-configuration-version-create') });
  })
);

// 通过状态语义启用或停用排班版本，不提供物理删除。
router.patch(
  '/config/shifts/:shiftDefinitionId/status',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.shiftConfigurationManage),
  requireWritable('energy:analysis:shift:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, CONFIGURATION_STATUS_FIELDS);
    const result = setShiftDefinitionStatus(
      req.params.shiftDefinitionId,
      serviceInput,
      buildAtomicAuditOptions(req)
    );
    sendSuccess(res, result, { meta: buildWritableResponseMeta(result, 'energy-shift-configuration-status') });
  })
);

// 查询 TOU 方案、历史版本及每个版本的完整周期规则。
router.get(
  '/config/tou-schemes',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.configurationView),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, CONFIGURATION_QUERY_FIELDS);
    const result = listTouSchemes(serviceInput);
    sendSuccess(res, result, { meta: buildReadOnlyResponseMeta(result, 'energy-tou-configuration-list') });
  })
);

// 创建首个 TOU 方案和周期规则快照。
router.post(
  '/config/tou-schemes',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.touConfigurationManage),
  requireWritable('energy:analysis:tou:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, TOU_CONFIGURATION_CREATE_FIELDS);
    const result = createTouScheme(serviceInput, buildAtomicAuditOptions(req));
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-tou-configuration-create') });
  })
);

// 基于历史 TOU 方案创建独立新版本和规则快照。
router.post(
  '/config/tou-schemes/:touSchemeId/versions',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.touConfigurationManage),
  requireWritable('energy:analysis:tou:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, TOU_CONFIGURATION_VERSION_FIELDS);
    const result = createTouSchemeVersion(req.params.touSchemeId, serviceInput, buildAtomicAuditOptions(req));
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-tou-configuration-version-create') });
  })
);

// 通过状态语义启用或停用 TOU 方案版本，不提供物理删除。
router.patch(
  '/config/tou-schemes/:touSchemeId/status',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.touConfigurationManage),
  requireWritable('energy:analysis:tou:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, CONFIGURATION_STATUS_FIELDS);
    const result = setTouSchemeStatus(req.params.touSchemeId, serviceInput, buildAtomicAuditOptions(req));
    sendSuccess(res, result, { meta: buildWritableResponseMeta(result, 'energy-tou-configuration-status') });
  })
);

// 查询固定白名单策略规则及全部历史版本。
router.get(
  '/config/strategy-rules',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.configurationView),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.query, CONFIGURATION_QUERY_FIELDS);
    const result = listStrategyRules(serviceInput);
    sendSuccess(res, result, { meta: buildReadOnlyResponseMeta(result, 'energy-strategy-rule-configuration-list') });
  })
);

// 创建首个固定白名单策略规则版本。
router.post(
  '/config/strategy-rules',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyRuleManage),
  requireWritable('energy:strategy:rule:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, STRATEGY_RULE_CREATE_FIELDS);
    const result = createStrategyRule(serviceInput, buildAtomicAuditOptions(req));
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-strategy-rule-configuration-create') });
  })
);

// 基于历史策略规则创建新版本，不允许动态执行文本。
router.post(
  '/config/strategy-rules/:strategyRuleId/versions',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyRuleManage),
  requireWritable('energy:strategy:rule:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, STRATEGY_RULE_VERSION_FIELDS);
    const result = createStrategyRuleVersion(
      req.params.strategyRuleId,
      serviceInput,
      buildAtomicAuditOptions(req)
    );
    sendSuccess(res, result, { statusCode: 201, meta: buildWritableResponseMeta(result, 'energy-strategy-rule-configuration-version-create') });
  })
);

// 通过状态语义启用或停用策略规则版本，不提供物理删除。
router.patch(
  '/config/strategy-rules/:strategyRuleId/status',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyRuleManage),
  requireWritable('energy:strategy:rule:manage'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, CONFIGURATION_STATUS_FIELDS);
    const result = setStrategyRuleStatus(
      req.params.strategyRuleId,
      serviceInput,
      buildAtomicAuditOptions(req)
    );
    sendSuccess(res, result, { meta: buildWritableResponseMeta(result, 'energy-strategy-rule-configuration-status') });
  })
);

// 预演本地确定性策略规则，不创建运行或命中记录。
router.post(
  '/strategies/evaluate',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyEvaluate),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, STRATEGY_EVALUATION_INPUT_FIELDS);
    const result = await previewEnergyStrategies(serviceInput);
    sendSuccess(res, result, {
      meta: buildReadOnlyResponseMeta(result, 'energy-strategy-evaluation')
    });
  })
);

// 正式执行策略评价，并原子写入运行和规则命中。
router.post(
  '/strategies/runs',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyRun),
  requireWritable('energy:strategy:run'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, STRATEGY_EVALUATION_INPUT_FIELDS);
    const result = await runEnergyStrategyEvaluation(serviceInput, {
      actorUserId: req.user.id,
      actorIp: req.ip
    });
    sendSuccess(res, result, {
      statusCode: 201,
      meta: buildWritableResponseMeta(result, 'energy-strategy-run')
    });
  })
);

// 更新单条策略命中的人工处理状态，设备控制仍完全由人工和外部流程负责。
router.patch(
  '/strategies/hits/:hitId/manual-status',
  authenticate,
  requirePermission(ENERGY_ANALYSIS_PERMISSIONS.strategyHitReview),
  requireWritable('energy:strategy:hit-review'),
  asyncHandler(async (req, res) => {
    const serviceInput = pickAllowedInput(req.body, STRATEGY_HIT_STATUS_INPUT_FIELDS);
    const result = await updateStrategyRuleHitStatus(req.params.hitId, serviceInput, {
      actorUserId: req.user.id,
      actorIp: req.ip
    });
    sendSuccess(res, result, {
      meta: buildWritableResponseMeta(result, 'energy-strategy-hit-review')
    });
  })
);

module.exports = router;
module.exports.CONFIGURATION_QUERY_FIELDS = CONFIGURATION_QUERY_FIELDS;
module.exports.CONFIGURATION_STATUS_FIELDS = CONFIGURATION_STATUS_FIELDS;
module.exports.ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION = ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION;
module.exports.ENERGY_ANALYSIS_PERMISSIONS = ENERGY_ANALYSIS_PERMISSIONS;
module.exports.ENERGY_CONFIGURATION_VIEW_PERMISSION = ENERGY_CONFIGURATION_VIEW_PERMISSION;
module.exports.ENERGY_INTENSITY_INPUT_FIELDS = ENERGY_INTENSITY_INPUT_FIELDS;
module.exports.ENERGY_SHIFT_CONFIGURATION_MANAGE_PERMISSION = ENERGY_SHIFT_CONFIGURATION_MANAGE_PERMISSION;
module.exports.ENERGY_STRATEGY_EVALUATE_PERMISSION = ENERGY_STRATEGY_EVALUATE_PERMISSION;
module.exports.ENERGY_STRATEGY_REVIEW_PERMISSION = ENERGY_STRATEGY_REVIEW_PERMISSION;
module.exports.ENERGY_STRATEGY_RULE_MANAGE_PERMISSION = ENERGY_STRATEGY_RULE_MANAGE_PERMISSION;
module.exports.ENERGY_STRATEGY_RUN_PERMISSION = ENERGY_STRATEGY_RUN_PERMISSION;
module.exports.ENERGY_TOU_CONFIGURATION_MANAGE_PERMISSION = ENERGY_TOU_CONFIGURATION_MANAGE_PERMISSION;
module.exports.LOAD_CURVE_INPUT_FIELDS = LOAD_CURVE_INPUT_FIELDS;
module.exports.LOAD_SUMMARY_INPUT_FIELDS = LOAD_SUMMARY_INPUT_FIELDS;
module.exports.MONTHLY_ANALYSIS_INPUT_FIELDS = MONTHLY_ANALYSIS_INPUT_FIELDS;
module.exports.PEAK_CONTRIBUTION_INPUT_FIELDS = PEAK_CONTRIBUTION_INPUT_FIELDS;
module.exports.SHIFT_AND_DEVICE_STATE_INPUT_FIELDS = SHIFT_AND_DEVICE_STATE_INPUT_FIELDS;
module.exports.SHIFT_CONFIGURATION_CREATE_FIELDS = SHIFT_CONFIGURATION_CREATE_FIELDS;
module.exports.SHIFT_CONFIGURATION_VERSION_FIELDS = SHIFT_CONFIGURATION_VERSION_FIELDS;
module.exports.STRATEGY_EVALUATION_INPUT_FIELDS = STRATEGY_EVALUATION_INPUT_FIELDS;
module.exports.STRATEGY_HIT_STATUS_INPUT_FIELDS = STRATEGY_HIT_STATUS_INPUT_FIELDS;
module.exports.STRATEGY_RULE_CREATE_FIELDS = STRATEGY_RULE_CREATE_FIELDS;
module.exports.STRATEGY_RULE_VERSION_FIELDS = STRATEGY_RULE_VERSION_FIELDS;
module.exports.TIME_OF_USE_INPUT_FIELDS = TIME_OF_USE_INPUT_FIELDS;
module.exports.TOU_CONFIGURATION_CREATE_FIELDS = TOU_CONFIGURATION_CREATE_FIELDS;
module.exports.TOU_CONFIGURATION_VERSION_FIELDS = TOU_CONFIGURATION_VERSION_FIELDS;
