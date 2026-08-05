const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { getDashboardSummary } = require('../services/energyRecordStatisticsService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/summary', authenticate, requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, getDashboardSummary());
}));

module.exports = router;
