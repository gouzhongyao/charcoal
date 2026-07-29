const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const {
  createPredictionRun,
  getPredictionRun,
  listPredictionResults,
  listPredictionRuns
} = require('../services/predictionService');
const { getPredictionContract } = require('../services/contractService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/contract', (req, res) => {
  sendSuccess(res, getPredictionContract(), { meta: { contractOnly: false } });
});

router.get('/runs', asyncHandler(async (req, res) => {
  const result = listPredictionRuns(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

router.post('/runs', requireWritable('predictions:create-run'), asyncHandler(async (req, res) => {
  const result = createPredictionRun(req.body || {});
  sendSuccess(res, result, { statusCode: 201 });
}));

router.get('/runs/:runId', asyncHandler(async (req, res) => {
  sendSuccess(res, getPredictionRun(req.params.runId));
}));

router.get('/runs/:runId/results', asyncHandler(async (req, res) => {
  const result = listPredictionResults({ ...req.query, runId: req.params.runId });
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

router.get('/results', asyncHandler(async (req, res) => {
  const result = listPredictionResults(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
