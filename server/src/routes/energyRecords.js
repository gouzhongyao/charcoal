const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission } = require('../middleware/permission');
const { getEnergyRecordContract } = require('../services/contractService');
const {
  exportEnergyRecords,
  getDimensionBreakdown,
  getEnergyRecordSummary,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords
} = require('../services/energyRecordStatisticsService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
const requireEnergyRecordView = requireAnyPermission('energy:records:view', 'energy-records:view', 'energy:statistics:view');

router.use(authenticate);

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'nenghao-wenjian.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/contract', requireEnergyRecordView, (req, res) => {
  sendSuccess(res, getEnergyRecordContract(), { meta: { contractOnly: false } });
});

router.get('/statistics/summary', requireEnergyRecordView, asyncHandler(async (req, res) => {
  sendSuccess(res, getEnergyRecordSummary(req.query));
}));

router.get('/statistics/monthly-trend', requireEnergyRecordView, asyncHandler(async (req, res) => {
  sendSuccess(res, getMonthlyTrend(req.query));
}));

router.get('/statistics/energy-type-breakdown', requireEnergyRecordView, asyncHandler(async (req, res) => {
  sendSuccess(res, getEnergyTypeBreakdown(req.query));
}));

router.get('/statistics/dimension-breakdown', requireEnergyRecordView, asyncHandler(async (req, res) => {
  const result = getDimensionBreakdown(req.query);
  sendSuccess(res, result.rows, { meta: { dimension: result.dimension } });
}));

router.get('/export', requireEnergyRecordView, asyncHandler(async (req, res) => {
  const result = exportEnergyRecords(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `nenghao-mingxi.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.get('/', requireEnergyRecordView, asyncHandler(async (req, res) => {
  const result = listEnergyRecords(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
