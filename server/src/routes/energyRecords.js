const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { getEnergyRecordContract } = require('../services/contractService');
const {
  getDimensionBreakdown,
  getEnergyRecordLedgerBackfillPreview,
  getEnergyRecordSummary,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords
} = require('../services/energyRecordStatisticsService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/contract', (req, res) => {
  sendSuccess(res, getEnergyRecordContract(), { meta: { contractOnly: false } });
});

router.get('/statistics/summary', asyncHandler(async (req, res) => {
  sendSuccess(res, getEnergyRecordSummary(req.query));
}));

router.get('/statistics/monthly-trend', asyncHandler(async (req, res) => {
  sendSuccess(res, getMonthlyTrend(req.query));
}));

router.get('/statistics/energy-type-breakdown', asyncHandler(async (req, res) => {
  sendSuccess(res, getEnergyTypeBreakdown(req.query));
}));

router.get('/statistics/dimension-breakdown', asyncHandler(async (req, res) => {
  const result = getDimensionBreakdown(req.query);
  sendSuccess(res, result.rows, { meta: { dimension: result.dimension } });
}));

router.get('/ledger-backfill/preview', asyncHandler(async (req, res) => {
  const result = getEnergyRecordLedgerBackfillPreview(req.query);
  sendSuccess(res, result, { meta: { dryRun: true, previewOnly: true, writesEnergyRecords: false } });
}));

router.get('/', asyncHandler(async (req, res) => {
  const result = listEnergyRecords(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
