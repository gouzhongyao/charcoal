const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const {
  buildGenerationMeta,
  createGenerationRecord,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  updateGenerationRecord,
  voidGenerationRecord
} = require('../services/generationService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/statistics/monthly', asyncHandler(async (req, res) => {
  const result = getMonthlyGenerationStatistics(req.query);
  sendSuccess(res, result.rows, { meta: { ...result.meta, summary: result.summary } });
}));

router.get('/records', asyncHandler(async (req, res) => {
  const result = listGenerationRecords(req.query);
  sendSuccess(res, result.rows, { meta: { ...buildGenerationMeta(), pagination: result.pagination } });
}));

router.post('/records', requireWritable('generation:create-record'), asyncHandler(async (req, res) => {
  const record = createGenerationRecord(req.body || {});
  sendSuccess(res, record, { statusCode: 201, meta: buildGenerationMeta() });
}));

router.put('/records/:id', requireWritable('generation:update-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

router.delete('/records/:id', requireWritable('generation:void-record'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidGenerationRecord(req.params.id, req.body || {}), { meta: buildGenerationMeta() });
}));

module.exports = router;
