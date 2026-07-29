const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const {
  calculateCarbonEmissions,
  getEmissionStatistics,
  listCarbonEmissions,
  listCarbonFactors,
  listMissingCarbonFactors,
  setCarbonFactorStatus,
  upsertCarbonFactor
} = require('../services/carbonAccountingService');
const { getCarbonContract } = require('../services/contractService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/contract', (req, res) => {
  sendSuccess(res, getCarbonContract(), { meta: { contractOnly: false } });
});

router.get('/factors', asyncHandler(async (req, res) => {
  const result = listCarbonFactors(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/factors', requireWritable('carbon:upsert-factor'), asyncHandler(async (req, res) => {
  const factor = upsertCarbonFactor(req.body);
  sendSuccess(res, factor, { statusCode: factor.operation === 'created' ? 201 : 200 });
}));

router.post('/factors/upsert', requireWritable('carbon:upsert-factor'), asyncHandler(async (req, res) => {
  const factor = upsertCarbonFactor(req.body);
  sendSuccess(res, factor, { statusCode: factor.operation === 'created' ? 201 : 200 });
}));

router.patch('/factors/:factorId/status', requireWritable('carbon:set-factor-status'), asyncHandler(async (req, res) => {
  sendSuccess(res, setCarbonFactorStatus(req.params.factorId, req.body));
}));

router.post('/emissions/calculate', requireWritable('carbon:calculate-emissions'), asyncHandler(async (req, res) => {
  sendSuccess(res, calculateCarbonEmissions(req.body || {}), { statusCode: 201 });
}));

router.get('/emissions', asyncHandler(async (req, res) => {
  const result = listCarbonEmissions(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

router.get('/emissions/statistics', asyncHandler(async (req, res) => {
  const result = getEmissionStatistics(req.query);
  sendSuccess(res, result.rows, { meta: { groupBy: result.groupBy } });
}));

router.get('/emissions/missing-factors', asyncHandler(async (req, res) => {
  sendSuccess(res, listMissingCarbonFactors(req.query));
}));

module.exports = router;
