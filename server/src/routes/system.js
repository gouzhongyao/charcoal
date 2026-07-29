const express = require('express');
const { getDatabaseInfo } = require('../db/database');
const { getApiContract } = require('../services/contractService');
const { getMaintenanceState } = require('../services/maintenanceState');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

router.get('/health', (req, res) => {
  sendSuccess(res, {
    service: 'energy-carbon-platform-api',
    mode: 'local',
    database: 'sqlite',
    status: 'ok'
  });
});

router.get('/bootstrap', (req, res) => {
  sendSuccess(res, {
    appName: '本地轻量化能碳管理平台',
    stack: ['local-frontend', 'node-express', 'sqlite-local-file'],
    database: getDatabaseInfo(),
    maintenance: getMaintenanceState(),
    contractOnly: false,
    nextCapabilities: ['energy-statistics', 'dashboard-summary', 'carbon-accounting', 'prediction-runs', 'backup-restore']
  });
});

router.get('/meta', (req, res) => {
  sendSuccess(res, {
    apiVersion: '0.1.0',
    architecture: 'local-lightweight',
    database: getDatabaseInfo(),
    maintenance: getMaintenanceState(),
    contract: getApiContract()
  });
});

router.get('/', (req, res) => {
  sendSuccess(res, {
    service: 'energy-carbon-platform-api',
    contractOnly: true,
    links: ['/api/health', '/api/bootstrap', '/api/meta', '/api/dictionaries/energy-types', '/api/imports/contract']
  });
});

module.exports = router;
