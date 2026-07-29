const express = require('express');
const { getImportContract } = require('../services/contractService');
const { listEnergyTypes } = require('../services/dictionaryService');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/energy-types', asyncHandler(async (req, res) => {
  const energyTypes = listEnergyTypes();
  sendSuccess(res, energyTypes, { meta: { count: energyTypes.length } });
}));

router.get('/import-contract', (req, res) => {
  sendSuccess(res, getImportContract(), { meta: { contractOnly: true } });
});

module.exports = router;
