'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  analyzeEnergyFlow,
  createEnergyFlowEdge,
  createEnergyFlowModel,
  createEnergyFlowNode,
  getEnergyFlowModel,
  getEnergyFlowTopology,
  listEnergyFlowEdges,
  listEnergyFlowModels,
  listEnergyFlowNodes,
  setEnergyFlowEdgeStatus,
  setEnergyFlowModelStatus,
  setEnergyFlowNodeStatus,
  updateEnergyFlowEdge,
  updateEnergyFlowModel,
  updateEnergyFlowNode
} = require('../services/energyFlowService');
const { sendSuccess } = require('../utils/response');

// 能流模型、拓扑和分析读取权限。
const ENERGY_FLOW_VIEW_PERMISSION = 'energy:flows:view';
// 能流模型、节点和边维护权限。
const ENERGY_FLOW_MANAGE_PERMISSION = 'energy:flows:manage';
// 独立 Router 对外公开的权限契约，中央集成人员可据此配置 RBAC。
const ENERGY_FLOW_PERMISSIONS = Object.freeze({
  view: ENERGY_FLOW_VIEW_PERMISSION,
  manage: ENERGY_FLOW_MANAGE_PERMISSION
});
// 模型列表查询字段白名单。
const MODEL_LIST_FIELDS = Object.freeze(['page', 'pageSize', 'status', 'keyword', 'search', 'modelCode', 'version']);
// 节点列表查询字段白名单。
const NODE_LIST_FIELDS = Object.freeze(['page', 'pageSize', 'status', 'nodeType', 'keyword', 'search']);
// 边列表查询字段白名单。
const EDGE_LIST_FIELDS = Object.freeze(['page', 'pageSize', 'status', 'sourceType', 'energyTypeCode', 'keyword', 'search']);
// 拓扑查询字段白名单。
const TOPOLOGY_QUERY_FIELDS = Object.freeze(['includeInactive']);
// 模型写入字段白名单。
const MODEL_WRITE_FIELDS = Object.freeze([
  'modelCode',
  'modelName',
  'source',
  'documentNo',
  'version',
  'effectiveStartUtc',
  'effectiveEndUtc',
  'sourceTimeZone',
  'status'
]);
// 节点写入字段白名单。
const NODE_WRITE_FIELDS = Object.freeze([
  'nodeCode',
  'nodeName',
  'nodeType',
  'organizationUnitId',
  'x',
  'y',
  'status'
]);
// 边写入字段白名单。
const EDGE_WRITE_FIELDS = Object.freeze([
  'edgeCode',
  'fromNodeId',
  'toNodeId',
  'energyTypeId',
  'energyTypeCode',
  'unit',
  'sourceType',
  'sourceMapping',
  'status'
]);
// 状态切换字段白名单。
const STATUS_WRITE_FIELDS = Object.freeze(['status']);
// 能流分析正文白名单；储能变化只能由调用方显式提交。
const ANALYSIS_INPUT_FIELDS = Object.freeze([
  'startMonth',
  'endMonth',
  'startUtc',
  'endUtc',
  'storageChanges'
]);
// 独立能流 Router；当前模块不修改中央 index 挂载。
const router = express.Router();

/**
 * 从请求对象中仅投影允许字段。
 * @param {*} source 请求查询或正文。
 * @param {string[]} allowedFields 字段白名单。
 * @returns {*} 投影结果或原非法类型。
 */
function pickAllowedInput(source, allowedFields) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return source;
  const projected = {};
  allowedFields.forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) projected[fieldName] = source[fieldName];
  });
  return projected;
}

/**
 * 构造能流读取响应元数据。
 * @param {string} operation 操作标识。
 * @param {object} result 领域结果。
 * @returns {object} 响应元数据。
 */
function buildReadMeta(operation, result = {}) {
  return {
    operation,
    readOnly: true,
    maintenanceAllowed: true,
    formulaVersion: result?.contract?.formulaVersion || null
  };
}

/**
 * 构造能流写入响应元数据。
 * @param {string} operation 操作标识。
 * @returns {object} 响应元数据。
 */
function buildWriteMeta(operation) {
  return { operation, readOnly: false, maintenanceAllowed: false };
}

/**
 * 记录能流写操作并发送统一成功响应，状态切换由操作日志保留可追溯快照。
 * @param {object} req Express 请求。
 * @param {object} res Express 响应。
 * @param {object} result 领域写入结果。
 * @param {object} options 操作元数据。
 */
function sendAuditedWriteSuccess(_req, res, result, options) {
  sendSuccess(res, result, {
    statusCode: options.statusCode || 200,
    meta: buildWriteMeta(options.operation)
  });
}

/**
 * 构造仅由路由注入、不能由请求正文控制的事务审计上下文。
 * @param {object} req Express 请求。
 * @param {string} operation 操作标识。
 * @param {string} targetType 目标类型。
 * @returns {object} 服务选项。
 */
function buildAuditOptions(req, operation, targetType) {
  return {
    audit: {
      userId: req.user.id,
      operation,
      targetType,
      ip: req.ip
    }
  };
}

// 分页查询模型版本。
router.get(
  '/models',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = listEnergyFlowModels(pickAllowedInput(req.query, MODEL_LIST_FIELDS));
    sendSuccess(res, result.rows, {
      meta: { ...buildReadMeta('energy-flow-model-list'), pagination: result.pagination }
    });
  })
);

// 新增模型版本，不覆盖既有版本。
router.post(
  '/models',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('新增能流模型版本'),
  asyncHandler(async (req, res) => {
    const result = createEnergyFlowModel(
      pickAllowedInput(req.body, MODEL_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-model-create', 'energy_flow_model')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-model-create', targetType: 'energy_flow_model', statusCode: 201
    });
  })
);

// 查询模型详情和追溯计数。
router.get(
  '/models/:modelId',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = getEnergyFlowModel(req.params.modelId);
    sendSuccess(res, result, { meta: buildReadMeta('energy-flow-model-detail') });
  })
);

// 修改模型非身份字段；modelCode 和 version 不能被覆盖。
router.put(
  '/models/:modelId',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('修改能流模型'),
  asyncHandler(async (req, res) => {
    const result = updateEnergyFlowModel(
      req.params.modelId,
      pickAllowedInput(req.body, MODEL_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-model-update', 'energy_flow_model')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-model-update', targetType: 'energy_flow_model'
    });
  })
);

// 启用或停用模型，不提供物理删除路由。
router.patch(
  '/models/:modelId/status',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('切换能流模型状态'),
  asyncHandler(async (req, res) => {
    const result = setEnergyFlowModelStatus(
      req.params.modelId,
      pickAllowedInput(req.body, STATUS_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-model-status', 'energy_flow_model')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-model-status', targetType: 'energy_flow_model'
    });
  })
);

// 分页查询模型节点。
router.get(
  '/models/:modelId/nodes',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = listEnergyFlowNodes(req.params.modelId, pickAllowedInput(req.query, NODE_LIST_FIELDS));
    sendSuccess(res, result.rows, {
      meta: { ...buildReadMeta('energy-flow-node-list'), pagination: result.pagination }
    });
  })
);

// 新增显式能流节点。
router.post(
  '/models/:modelId/nodes',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('新增能流节点'),
  asyncHandler(async (req, res) => {
    const result = createEnergyFlowNode(
      req.params.modelId,
      pickAllowedInput(req.body, NODE_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-node-create', 'energy_flow_node')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-node-create', targetType: 'energy_flow_node', statusCode: 201
    });
  })
);

// 修改节点名称、类型、组织关联、坐标或状态。
router.put(
  '/models/:modelId/nodes/:nodeId',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('修改能流节点'),
  asyncHandler(async (req, res) => {
    const result = updateEnergyFlowNode(
      req.params.modelId,
      req.params.nodeId,
      pickAllowedInput(req.body, NODE_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-node-update', 'energy_flow_node')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-node-update', targetType: 'energy_flow_node'
    });
  })
);

// 启用或停用节点；active 边引用保护由领域服务执行。
router.patch(
  '/models/:modelId/nodes/:nodeId/status',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('切换能流节点状态'),
  asyncHandler(async (req, res) => {
    const result = setEnergyFlowNodeStatus(
      req.params.modelId,
      req.params.nodeId,
      pickAllowedInput(req.body, STATUS_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-node-status', 'energy_flow_node')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-node-status', targetType: 'energy_flow_node'
    });
  })
);

// 分页查询模型物理边及显式来源映射。
router.get(
  '/models/:modelId/edges',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = listEnergyFlowEdges(req.params.modelId, pickAllowedInput(req.query, EDGE_LIST_FIELDS));
    sendSuccess(res, result.rows, {
      meta: { ...buildReadMeta('energy-flow-edge-list'), pagination: result.pagination }
    });
  })
);

// 新增显式物理边和来源映射。
router.post(
  '/models/:modelId/edges',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('新增能流边'),
  asyncHandler(async (req, res) => {
    const result = createEnergyFlowEdge(
      req.params.modelId,
      pickAllowedInput(req.body, EDGE_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-edge-create', 'energy_flow_edge')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-edge-create', targetType: 'energy_flow_edge', statusCode: 201
    });
  })
);

// 修改尚未被历史边值冻结的物理边配置。
router.put(
  '/models/:modelId/edges/:edgeId',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('修改能流边'),
  asyncHandler(async (req, res) => {
    const result = updateEnergyFlowEdge(
      req.params.modelId,
      req.params.edgeId,
      pickAllowedInput(req.body, EDGE_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-edge-update', 'energy_flow_edge')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-edge-update', targetType: 'energy_flow_edge'
    });
  })
);

// 启用或停用边，不物理删除历史记录。
router.patch(
  '/models/:modelId/edges/:edgeId/status',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.manage),
  requireWritable('切换能流边状态'),
  asyncHandler(async (req, res) => {
    const result = setEnergyFlowEdgeStatus(
      req.params.modelId,
      req.params.edgeId,
      pickAllowedInput(req.body, STATUS_WRITE_FIELDS),
      buildAuditOptions(req, 'energy-flow-edge-status', 'energy_flow_edge')
    );
    sendAuditedWriteSuccess(req, res, result, {
      operation: 'energy-flow-edge-status', targetType: 'energy_flow_edge'
    });
  })
);

// 读取完整显式拓扑；默认只返回 active 节点和边。
router.get(
  '/models/:modelId/topology',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = getEnergyFlowTopology(req.params.modelId, pickAllowedInput(req.query, TOPOLOGY_QUERY_FIELDS));
    sendSuccess(res, result, { meta: buildReadMeta('energy-flow-topology', result) });
  })
);

// 只读分析边值、节点差额、覆盖和异常；维护态下仍允许读取。
router.post(
  '/models/:modelId/analysis',
  authenticate,
  requirePermission(ENERGY_FLOW_PERMISSIONS.view),
  asyncHandler(async (req, res) => {
    const result = analyzeEnergyFlow(req.params.modelId, pickAllowedInput(req.body, ANALYSIS_INPUT_FIELDS));
    sendSuccess(res, result, { meta: buildReadMeta('energy-flow-analysis', result) });
  })
);

module.exports = router;
module.exports.ANALYSIS_INPUT_FIELDS = ANALYSIS_INPUT_FIELDS;
module.exports.EDGE_LIST_FIELDS = EDGE_LIST_FIELDS;
module.exports.EDGE_WRITE_FIELDS = EDGE_WRITE_FIELDS;
module.exports.ENERGY_FLOW_MANAGE_PERMISSION = ENERGY_FLOW_MANAGE_PERMISSION;
module.exports.ENERGY_FLOW_PERMISSIONS = ENERGY_FLOW_PERMISSIONS;
module.exports.ENERGY_FLOW_VIEW_PERMISSION = ENERGY_FLOW_VIEW_PERMISSION;
module.exports.MODEL_LIST_FIELDS = MODEL_LIST_FIELDS;
module.exports.MODEL_WRITE_FIELDS = MODEL_WRITE_FIELDS;
module.exports.NODE_LIST_FIELDS = NODE_LIST_FIELDS;
module.exports.NODE_WRITE_FIELDS = NODE_WRITE_FIELDS;
module.exports.STATUS_WRITE_FIELDS = STATUS_WRITE_FIELDS;
module.exports.TOPOLOGY_QUERY_FIELDS = TOPOLOGY_QUERY_FIELDS;
