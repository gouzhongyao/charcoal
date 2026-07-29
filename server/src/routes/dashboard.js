const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { getDashboardSummary } = require('../services/energyRecordStatisticsService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/summary', asyncHandler(async (req, res) => {
  sendSuccess(res, getDashboardSummary());
}));

module.exports = router;
