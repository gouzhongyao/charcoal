const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { getApiContract } = require('../services/contractService');
const { getMaintenanceState } = require('../services/maintenanceState');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

// 登录前 bootstrap 仅提供应用能力与维护态标识，不返回本地目录或数据库路径。
function getPublicMaintenanceState() {
  return { active: getMaintenanceState().active === true };
}

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
    mode: 'local',
    storage: 'local-file',
    maintenance: getPublicMaintenanceState(),
    contractOnly: false,
    nextCapabilities: ['energy-statistics', 'dashboard-summary', 'carbon-accounting', 'prediction-runs', 'backup-restore']
  });
});

router.get('/meta', authenticate, requirePermission('system:bootstrap:view'), (req, res) => {
  sendSuccess(res, {
    apiVersion: '0.1.0',
    architecture: 'local-lightweight',
    maintenance: getPublicMaintenanceState(),
    contract: getApiContract()
  });
});

router.get('/', authenticate, requirePermission('system:bootstrap:view'), (req, res) => {
  sendSuccess(res, {
    service: 'energy-carbon-platform-api',
    contractOnly: true,
    links: ['/api/health', '/api/bootstrap', '/api/meta', '/api/dictionaries/energy-types', '/api/imports/contract']
  });
});

module.exports = router;
