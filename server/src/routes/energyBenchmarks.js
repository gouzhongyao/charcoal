'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  buildBenchmarkExportRows,
  calculateBenchmarkQualificationRate,
  createBenchmarkDefinition,
  createBenchmarkTarget,
  createInternalHistoryBenchmark,
  evaluateEnergyBenchmark,
  getBenchmarkDefinition,
  getBenchmarkTarget,
  listBenchmarkDefinitions,
  listBenchmarkTargets,
  rankEnergyBenchmark,
  setBenchmarkDefinitionStatus,
  setBenchmarkTargetStatus,
  updateBenchmarkDefinition,
  updateBenchmarkTarget
} = require('../services/energyBenchmarkService');
const { AppError, badRequest } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 能效对标独立路由，正式中央挂载由后续单一集成人员处理。
const router = express.Router();
// 对标 JSON 输入限制，解析器必须位于认证、权限和写维护态检查之后。
const ENERGY_BENCHMARK_JSON_LIMIT = '256kb';
const ENERGY_BENCHMARK_JSON_LIMIT_BYTES = 256 * 1024;
const parseEnergyBenchmarkJson = express.json({ limit: ENERGY_BENCHMARK_JSON_LIMIT_BYTES, strict: true });
// 独立路由拟挂载位置和全局 JSON 顺序要求。
const ENERGY_BENCHMARK_ROUTER_MOUNT_REQUIREMENT = Object.freeze({
  beforeGlobalJsonParser: true,
  recommendedBasePath: '/api/energy-benchmarks'
});
// 对标查询、维护、分析和导出权限保持职责分离。
const ENERGY_BENCHMARK_PERMISSIONS = Object.freeze({
  view: 'energy:benchmarks:view',
  manage: 'energy:benchmarks:manage',
  analyze: 'energy:benchmarks:analyze',
  export: 'energy:benchmarks:export'
});
// 定义列表允许的查询字段。
const DEFINITION_QUERY_FIELDS = Object.freeze([
  'page', 'pageSize', 'status', 'benchmarkType', 'benchmarkCode', 'metricCode', 'scopeType', 'scopeReference'
]);
// 目标列表允许的查询字段。
const TARGET_QUERY_FIELDS = Object.freeze(['page', 'pageSize', 'definitionId', 'status']);
// 定义创建和完整修改允许的字段。
const DEFINITION_BODY_FIELDS = Object.freeze([
  'benchmarkCode', 'benchmarkName', 'benchmarkType', 'metricCode', 'unit', 'periodType',
  'scopeType', 'scopeReference', 'direction', 'source', 'effectiveStartUtc',
  'effectiveEndUtc', 'sourceTimeZone', 'status'
]);
// 目标创建允许的字段。
const TARGET_CREATE_FIELDS = Object.freeze([
  'benchmarkDefinitionId', 'targetValue', 'lowerBound', 'upperBound', 'status'
]);
// 目标修改不允许更换定义归属。
const TARGET_UPDATE_FIELDS = Object.freeze(['targetValue', 'lowerBound', 'upperBound', 'status']);
// 状态接口只接受状态字段。
const STATUS_BODY_FIELDS = Object.freeze(['status']);
// 内部历史原子接口只接受定义、参考期和显式计算范围，禁止客户端派生快照事实。
const INTERNAL_HISTORY_BODY_FIELDS = Object.freeze(['definition', 'referencePeriod', 'calculationScope']);
const INTERNAL_HISTORY_REFERENCE_FIELDS = Object.freeze(['startUtc', 'endUtc']);
const INTERNAL_HISTORY_SCOPE_FIELDS = Object.freeze(['productionUnitId', 'energyTypeCode']);
const INTERNAL_HISTORY_DERIVED_FIELDS = Object.freeze([
  'snapshot', 'frozenValue', 'sampleCount', 'productionSummary', 'productionSummaryJson',
  'sourceDataDigest', 'frozenAt', 'targetValue'
]);
// 单值执行接口只接受显式定义、目标和实际值。
const EVALUATE_BODY_FIELDS = Object.freeze(['definitionId', 'targetId', 'actual']);
// 排名、合格率和导出只接受显式对象数组。
const GROUP_ANALYSIS_BODY_FIELDS = Object.freeze(['definitionId', 'targetId', 'actuals']);

/**
 * 在认证、权限和写维护态之后解析受限 JSON，并安全归一化解析错误。
 * @param {object} req Express 请求。
 * @param {object} res Express 响应。
 * @param {Function} next Express 后续处理器。
 */
function parseBenchmarkJsonBody(req, res, next) {
  parseEnergyBenchmarkJson(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || Number(error.status) === 413) {
      next(new AppError('REQUEST_BODY_TOO_LARGE', '能效对标 JSON 请求体超过大小限制。', {
        statusCode: 413,
        details: {
          code: 'ENERGY_BENCHMARK_JSON_TOO_LARGE',
          maxBodyBytes: ENERGY_BENCHMARK_JSON_LIMIT_BYTES
        }
      }));
      return;
    }
    next(badRequest('能效对标 JSON 请求体格式无效。', {
      code: 'ENERGY_BENCHMARK_JSON_INVALID'
    }));
  });
}

/**
 * 校验对象只包含白名单字段并生成安全副本。
 * @param {*} source 原始对象。
 * @param {string[]} allowedFields 允许字段。
 * @param {string} location 输入位置。
 * @returns {object} 白名单副本。
 */
function pickAllowedFields(source, allowedFields, location) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw badRequest(`${location} 必须是对象。`, { code: 'ENERGY_BENCHMARK_INVALID_INPUT', location });
  }
  const unknownFields = Object.keys(source).filter((fieldName) => !allowedFields.includes(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest(`${location} 包含不支持的字段。`, {
      code: 'ENERGY_BENCHMARK_UNKNOWN_FIELDS',
      location,
      fields: unknownFields
    });
  }
  return Object.fromEntries(allowedFields.filter((fieldName) => source[fieldName] !== undefined)
    .map((fieldName) => [fieldName, source[fieldName]]));
}

/**
 * 将分页 service 结果转换为统一 data/meta 响应。
 * @param {object} res Express 响应。
 * @param {object} result 分页结果。
 */
function sendPagedResult(res, result) {
  sendSuccess(res, result.items, {
    meta: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    }
  });
}

/**
 * 从认证请求构造事务审计操作者。
 * @param {object} req Express 请求。
 * @returns {object} Service 写选项。
 */
function buildBenchmarkWriteOptions(req) {
  return {
    actor: {
      userId: req.user.id,
      username: req.user.username,
      ip: req.ip
    }
  };
}

/**
 * 严格规范内部历史请求并显式拒绝客户端派生事实。
 * @param {*} source 请求体。
 * @returns {object} 服务端允许的内部历史输入。
 */
function pickInternalHistoryBody(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw badRequest('body 必须是对象。', { code: 'ENERGY_BENCHMARK_INVALID_INPUT', location: 'body' });
  }
  const forbiddenFields = Object.keys(source).filter((fieldName) => INTERNAL_HISTORY_DERIVED_FIELDS.includes(fieldName));
  if (forbiddenFields.length > 0) {
    throw badRequest('内部历史派生事实必须由服务端计算，客户端不得提交。', {
      code: 'INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN',
      fields: forbiddenFields
    });
  }
  const body = pickAllowedFields(source, INTERNAL_HISTORY_BODY_FIELDS, 'body');
  return {
    definition: pickAllowedFields(body.definition, DEFINITION_BODY_FIELDS, 'body.definition'),
    referencePeriod: pickAllowedFields(body.referencePeriod, INTERNAL_HISTORY_REFERENCE_FIELDS, 'body.referencePeriod'),
    calculationScope: pickAllowedFields(body.calculationScope, INTERNAL_HISTORY_SCOPE_FIELDS, 'body.calculationScope')
  };
}

// 只读定义列表在维护态继续可用。
router.get('/definitions', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.view), asyncHandler(async (req, res) => {
  const query = pickAllowedFields(req.query, DEFINITION_QUERY_FIELDS, 'query');
  sendPagedResult(res, listBenchmarkDefinitions(query));
}));

// 只读定义详情在维护态继续可用。
router.get('/definitions/:definitionId', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.view), asyncHandler(async (req, res) => {
  sendSuccess(res, getBenchmarkDefinition(req.params.definitionId));
}));

// 新增定义属于写操作，先认证、授权和检查维护态，再解析 JSON。
router.post('/definitions', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:create-definition'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, DEFINITION_BODY_FIELDS, 'body');
    sendSuccess(res, createBenchmarkDefinition(body, buildBenchmarkWriteOptions(req)), { meta: { created: true } });
  }));

// 修改定义由服务端创建内部后继记录并保留历史目标。
router.put('/definitions/:definitionId', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:update-definition'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, DEFINITION_BODY_FIELDS, 'body');
    sendSuccess(res, updateBenchmarkDefinition(req.params.definitionId, body, buildBenchmarkWriteOptions(req)));
  }));

// 定义通过状态语义停用或恢复，不提供物理删除路由。
router.patch('/definitions/:definitionId/status', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:set-definition-status'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, STATUS_BODY_FIELDS, 'body');
    sendSuccess(res, setBenchmarkDefinitionStatus(req.params.definitionId, body.status, buildBenchmarkWriteOptions(req)));
  }));

// 内部历史定义和固化目标必须在同一事务内原子创建。
router.post('/internal-history', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:create-internal-history'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickInternalHistoryBody(req.body);
    sendSuccess(res, createInternalHistoryBenchmark(body, buildBenchmarkWriteOptions(req)), {
      meta: { created: true, frozen: true, autoRefresh: false }
    });
  }));

// 只读目标列表在维护态继续可用。
router.get('/targets', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.view), asyncHandler(async (req, res) => {
  const query = pickAllowedFields(req.query, TARGET_QUERY_FIELDS, 'query');
  sendPagedResult(res, listBenchmarkTargets(query));
}));

// 只读目标详情保留来源和内部快照追溯字段。
router.get('/targets/:targetId', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.view), asyncHandler(async (req, res) => {
  sendSuccess(res, getBenchmarkTarget(req.params.targetId));
}));

// 新增普通目标记录属于写操作。
router.post('/targets', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:create-target'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, TARGET_CREATE_FIELDS, 'body');
    sendSuccess(res, createBenchmarkTarget(body, buildBenchmarkWriteOptions(req)), { meta: { created: true } });
  }));

// 调整目标必须创建后继记录，原记录保留用于追溯且不能更换定义归属。
router.put('/targets/:targetId', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:update-target'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, TARGET_UPDATE_FIELDS, 'body');
    sendSuccess(res, updateBenchmarkTarget(req.params.targetId, body, buildBenchmarkWriteOptions(req)));
  }));

// 目标通过状态语义选择当前业务记录，不提供物理删除路由。
router.patch('/targets/:targetId/status', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.manage),
  requireWritable('energy-benchmarks:set-target-status'), parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, STATUS_BODY_FIELDS, 'body');
    sendSuccess(res, setBenchmarkTargetStatus(req.params.targetId, body.status, buildBenchmarkWriteOptions(req)));
  }));

// 单值分析不写数据库，维护态仍允许执行。
router.post('/evaluate', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.analyze),
  parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, EVALUATE_BODY_FIELDS, 'body');
    sendSuccess(res, evaluateEnergyBenchmark(body));
  }));

// 排名只使用调用方显式提供且兼容的对象，不构造同行数据。
router.post('/rankings', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.analyze),
  parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, GROUP_ANALYSIS_BODY_FIELDS, 'body');
    sendSuccess(res, rankEnergyBenchmark(body));
  }));

// 合格率分母只包含兼容对象，并返回全部排除原因。
router.post('/qualification-rate', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.analyze),
  parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, GROUP_ANALYSIS_BODY_FIELDS, 'body');
    sendSuccess(res, calculateBenchmarkQualificationRate(body));
  }));

// 导出接口只返回结构化行，正式文件下载层由中央集成人员决定。
router.post('/export-rows', authenticate, requirePermission(ENERGY_BENCHMARK_PERMISSIONS.export),
  parseBenchmarkJsonBody, asyncHandler(async (req, res) => {
    const body = pickAllowedFields(req.body, GROUP_ANALYSIS_BODY_FIELDS, 'body');
    sendSuccess(res, buildBenchmarkExportRows(body));
  }));

module.exports = router;
module.exports.ENERGY_BENCHMARK_JSON_LIMIT = ENERGY_BENCHMARK_JSON_LIMIT;
module.exports.ENERGY_BENCHMARK_PERMISSIONS = ENERGY_BENCHMARK_PERMISSIONS;
module.exports.ENERGY_BENCHMARK_ROUTER_MOUNT_REQUIREMENT = ENERGY_BENCHMARK_ROUTER_MOUNT_REQUIREMENT;
