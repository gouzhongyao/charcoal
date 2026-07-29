const express = require('express');
const { listEnergyTypes } = require('../services/dictionaryService');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const energyTypes = listEnergyTypes();
  sendSuccess(res, energyTypes, { meta: { count: energyTypes.length } });
}));

module.exports = router;
