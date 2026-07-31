const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const {
  createProductionOutput,
  createProductionUnit,
  deactivateProductionUnit,
  getUnitEnergyIntensity,
  listProductionOutputs,
  listProductionUnits,
  updateProductionOutput,
  updateProductionUnit,
  voidProductionOutput
} = require('../services/productionService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/statistics/unit-energy-intensity', asyncHandler(async (req, res) => {
  const result = getUnitEnergyIntensity(req.query);
  sendSuccess(res, result.rows, { meta: result.meta });
}));

router.get('/units', asyncHandler(async (req, res) => {
  const result = listProductionUnits(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/units', requireWritable('production:create-unit'), asyncHandler(async (req, res) => {
  const unit = createProductionUnit(req.body || {});
  sendSuccess(res, unit, { statusCode: 201 });
}));

router.put('/units/:id', requireWritable('production:update-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionUnit(req.params.id, req.body || {}));
}));

router.delete('/units/:id', requireWritable('production:deactivate-unit'), asyncHandler(async (req, res) => {
  sendSuccess(res, deactivateProductionUnit(req.params.id));
}));

router.get('/outputs', asyncHandler(async (req, res) => {
  const result = listProductionOutputs(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));

router.post('/outputs', requireWritable('production:create-output'), asyncHandler(async (req, res) => {
  const output = createProductionOutput(req.body || {});
  sendSuccess(res, output, { statusCode: 201 });
}));

router.put('/outputs/:id', requireWritable('production:update-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, updateProductionOutput(req.params.id, req.body || {}));
}));

router.delete('/outputs/:id', requireWritable('production:void-output'), asyncHandler(async (req, res) => {
  sendSuccess(res, voidProductionOutput(req.params.id));
}));

module.exports = router;
