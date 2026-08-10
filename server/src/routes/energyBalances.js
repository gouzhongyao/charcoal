'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendSuccess } = require('../utils/response');
const {
  calculateAndSaveBalanceSnapshots,
  createBalanceBoundary,
  createBalanceItem,
  getBalanceBoundary,
  getBalanceSnapshot,
  getBalanceSnapshotRun,
  getEnergyBalanceContract,
  listBalanceBoundaries,
  listBalanceItems,
  listBalanceSnapshotRuns,
  listBalanceSnapshots,
  listBalanceSuggestions,
  setBalanceBoundaryStatus,
  setBalanceItemStatus,
  updateBalanceBoundary,
  updateBalanceItem,
  updateBalanceSuggestionStatus
} = require('../services/energyBalanceService');

// 独立能效平衡 Router，中央应用挂载由后续集成责任人完成。
const router = express.Router();
// 能效平衡只读权限编码。
const BALANCE_VIEW_PERMISSION = 'energy:balance:view';
// 能效平衡边界和项目维护权限编码。
const BALANCE_MANAGE_PERMISSION = 'energy:balance:manage';
// 能效平衡快照计算权限编码。
const BALANCE_CALCULATE_PERMISSION = 'energy:balance:calculate';
// 能效平衡建议人工复核权限编码。
const BALANCE_SUGGESTION_REVIEW_PERMISSION = 'energy:balance:suggestion:review';

// 边界维护输入白名单。
const BOUNDARY_INPUT_FIELDS = Object.freeze([
  'boundaryCode',
  'boundaryName',
  'organizationUnitId',
  'source',
  'documentNo',
  'version',
  'effectiveStartUtc',
  'effectiveEndUtc',
  'sourceTimeZone',
  'generationBoundaryConfirmed'
]);
// 项目维护输入白名单。
const ITEM_INPUT_FIELDS = Object.freeze([
  'itemCode',
  'itemName',
  'role',
  'energyTypeId',
  'originalUnit',
  'sourceType',
  'sourceMapping',
  'generationAntiDoubleCountKey'
]);
// 快照计算输入白名单。
const CALCULATION_INPUT_FIELDS = Object.freeze(['startUtc', 'endUtc', 'explicitValues']);
// 建议状态更新输入白名单。
const SUGGESTION_STATUS_FIELDS = Object.freeze(['manualStatus', 'reviewNote']);
// 主数据状态更新输入白名单。
const MASTER_STATUS_FIELDS = Object.freeze(['status']);
// 边界列表查询白名单。
const BOUNDARY_QUERY_FIELDS = Object.freeze(['page', 'pageSize', 'status', 'organizationUnitId', 'keyword']);
// 项目列表查询白名单。
const ITEM_QUERY_FIELDS = Object.freeze(['page', 'pageSize', 'status', 'role']);
// 快照列表查询白名单。
const SNAPSHOT_QUERY_FIELDS = Object.freeze([
  'page',
  'pageSize',
  'view',
  'boundaryId',
  'energyTypeId',
  'confirmationStatus',
  'calculationRunId',
  'sourceDataDigest'
]);
// 建议列表查询白名单。
const SUGGESTION_QUERY_FIELDS = Object.freeze([
  'page',
  'pageSize',
  'snapshotId',
  'boundaryId',
  'calculationRunId',
  'sourceDataDigest',
  'manualStatus',
  'priority'
]);

/**
 * 仅投影服务允许接收的字段，丢弃额外输入。
 * @param {*} source 原始输入。
 * @param {string[]} allowedFields 允许字段。
 * @returns {*} 白名单输入。
 */
function pickAllowedInput(source, allowedFields) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return source;
  const projectedInput = {};
  allowedFields.forEach((fieldName) => {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) {
      projectedInput[fieldName] = source[fieldName];
    }
  });
  return projectedInput;
}

/**
 * 从已认证请求构造服务层审计操作者上下文。
 * @param {object} req Express 请求。
 * @returns {{actor:{userId:number,username:string|null,ip:string|null}}} 服务选项。
 */
function buildWriteOptions(req) {
  return {
    actor: {
      userId: req.user.id,
      username: req.user.username || null,
      ip: req.ip || null
    }
  };
}

// 查询稳定平衡领域契约。
router.get(
  '/contract',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (_req, res) => {
    sendSuccess(res, getEnergyBalanceContract(), {
      meta: { domain: 'energy-balance', contractOnly: false }
    });
  })
);

// 分页查询平衡边界。
router.get(
  '/boundaries',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    const result = listBalanceBoundaries(pickAllowedInput(req.query, BOUNDARY_QUERY_FIELDS));
    sendSuccess(res, result.rows, { meta: { domain: 'energy-balance', pagination: result.pagination } });
  })
);

// 新增平衡边界。
router.post(
  '/boundaries',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const boundary = createBalanceBoundary(
      pickAllowedInput(req.body || {}, BOUNDARY_INPUT_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, boundary, { statusCode: 201, meta: { domain: 'energy-balance' } });
  })
);

// 查询单个平衡边界。
router.get(
  '/boundaries/:boundaryId',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    sendSuccess(res, getBalanceBoundary(req.params.boundaryId), { meta: { domain: 'energy-balance' } });
  })
);

// 修改平衡边界。
router.put(
  '/boundaries/:boundaryId',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const boundary = updateBalanceBoundary(
      req.params.boundaryId,
      pickAllowedInput(req.body || {}, BOUNDARY_INPUT_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, boundary, { meta: { domain: 'energy-balance' } });
  })
);

// 启用或停用平衡边界。
router.patch(
  '/boundaries/:boundaryId/status',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const boundary = setBalanceBoundaryStatus(
      req.params.boundaryId,
      pickAllowedInput(req.body || {}, MASTER_STATUS_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, boundary, { meta: { domain: 'energy-balance' } });
  })
);

// 分页查询边界下的九角色项目。
router.get(
  '/boundaries/:boundaryId/items',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    const result = listBalanceItems(
      req.params.boundaryId,
      pickAllowedInput(req.query, ITEM_QUERY_FIELDS)
    );
    sendSuccess(res, result.rows, { meta: { domain: 'energy-balance', pagination: result.pagination } });
  })
);

// 新增平衡项目。
router.post(
  '/boundaries/:boundaryId/items',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const item = createBalanceItem(
      req.params.boundaryId,
      pickAllowedInput(req.body || {}, ITEM_INPUT_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, item, { statusCode: 201, meta: { domain: 'energy-balance' } });
  })
);

// 修改平衡项目。
router.put(
  '/boundaries/:boundaryId/items/:itemId',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const item = updateBalanceItem(
      req.params.boundaryId,
      req.params.itemId,
      pickAllowedInput(req.body || {}, ITEM_INPUT_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, item, { meta: { domain: 'energy-balance' } });
  })
);

// 启用或停用平衡项目。
router.patch(
  '/boundaries/:boundaryId/items/:itemId/status',
  authenticate,
  requirePermission(BALANCE_MANAGE_PERMISSION),
  requireWritable(BALANCE_MANAGE_PERMISSION),
  asyncHandler(async (req, res) => {
    const item = setBalanceItemStatus(
      req.params.boundaryId,
      req.params.itemId,
      pickAllowedInput(req.body || {}, MASTER_STATUS_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, item, { meta: { domain: 'energy-balance' } });
  })
);

// 在单个事务内计算并保存平衡快照及确定性建议。
router.post(
  '/boundaries/:boundaryId/snapshots/calculate',
  authenticate,
  requirePermission(BALANCE_CALCULATE_PERMISSION),
  requireWritable(BALANCE_CALCULATE_PERMISSION),
  asyncHandler(async (req, res) => {
    const calculation = calculateAndSaveBalanceSnapshots(
      req.params.boundaryId,
      pickAllowedInput(req.body || {}, CALCULATION_INPUT_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, calculation, { statusCode: 201, meta: { domain: 'energy-balance' } });
  })
);

// 分页查询平衡快照；view=runs 时按 calculationRunId 返回轻量摘要，完整分面由运行详情按需读取。
router.get(
  '/snapshots',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    const query = pickAllowedInput(req.query, SNAPSHOT_QUERY_FIELDS);
    const result = query.view === 'runs'
      ? listBalanceSnapshotRuns(query)
      : listBalanceSnapshots(query);
    sendSuccess(res, result.rows, {
      meta: {
        domain: 'energy-balance',
        pagination: result.pagination,
        paginationUnit: query.view === 'runs' ? 'calculationRunId' : 'snapshotFacet'
      }
    });
  })
);

// 按运行编号读取完整分面，不受通用快照页大小上限截断。
router.get(
  '/snapshots/runs/:calculationRunId',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    sendSuccess(res, getBalanceSnapshotRun(req.params.calculationRunId), {
      meta: { domain: 'energy-balance', paginationUnit: 'calculationRunId' }
    });
  })
);

// 查询单个快照、同次计算分面、综合折标及建议首屏分页元数据。
router.get(
  '/snapshots/:snapshotId',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    sendSuccess(res, getBalanceSnapshot(req.params.snapshotId), { meta: { domain: 'energy-balance' } });
  })
);

// 分页查询确定性优化建议。
router.get(
  '/suggestions',
  authenticate,
  requirePermission(BALANCE_VIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    const result = listBalanceSuggestions(pickAllowedInput(req.query, SUGGESTION_QUERY_FIELDS));
    sendSuccess(res, result.rows, { meta: { domain: 'energy-balance', pagination: result.pagination } });
  })
);

// 人工接受、拒绝或解决建议，不触发任何自动执行。
router.patch(
  '/suggestions/:suggestionId/status',
  authenticate,
  requirePermission(BALANCE_SUGGESTION_REVIEW_PERMISSION),
  requireWritable(BALANCE_SUGGESTION_REVIEW_PERMISSION),
  asyncHandler(async (req, res) => {
    const suggestion = updateBalanceSuggestionStatus(
      req.params.suggestionId,
      pickAllowedInput(req.body || {}, SUGGESTION_STATUS_FIELDS),
      buildWriteOptions(req)
    );
    sendSuccess(res, suggestion, { meta: { domain: 'energy-balance' } });
  })
);

module.exports = router;
module.exports.BALANCE_CALCULATE_PERMISSION = BALANCE_CALCULATE_PERMISSION;
module.exports.BALANCE_MANAGE_PERMISSION = BALANCE_MANAGE_PERMISSION;
module.exports.BALANCE_SUGGESTION_REVIEW_PERMISSION = BALANCE_SUGGESTION_REVIEW_PERMISSION;
module.exports.BALANCE_VIEW_PERMISSION = BALANCE_VIEW_PERMISSION;
module.exports.pickAllowedInput = pickAllowedInput;
