const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { getEnergyRecordContract } = require('../services/contractService');
const {
  executeEnergyRecordLedgerBackfill,
  exportEnergyRecordLedgerBackfillPreview,
  getDimensionBreakdown,
  getEnergyRecordLedgerBackfillPreview,
  getEnergyRecordSummary,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords
} = require('../services/energyRecordStatisticsService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'energy-records-ledger-backfill-preview.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

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

router.get('/ledger-backfill/preview/export', asyncHandler(async (req, res) => {
  const result = exportEnergyRecordLedgerBackfillPreview(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `energy-records-ledger-backfill-preview.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.setHeader('X-Dry-Run', 'true');
  res.setHeader('X-Preview-Only', 'true');
  res.setHeader('X-Writes-Energy-Records', 'false');
  res.status(200).send(result.body);
}));

router.get('/ledger-backfill/preview', asyncHandler(async (req, res) => {
  const result = getEnergyRecordLedgerBackfillPreview(req.query);
  sendSuccess(res, result, { meta: { dryRun: true, previewOnly: true, writesEnergyRecords: false } });
}));

router.post('/ledger-backfill/execute', requireWritable('energy-records:ledger-backfill:execute'), asyncHandler(async (req, res) => {
  const result = await executeEnergyRecordLedgerBackfill(req.body || {});
  sendSuccess(res, result, { meta: { dryRun: false, previewOnly: false, writesEnergyRecords: true } });
}));

router.get('/', asyncHandler(async (req, res) => {
  const result = listEnergyRecords(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
