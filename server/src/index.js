const { loadRuntimeEnvironment } = require('../../config/runtimeEnvironment');

// 运行环境配置模块：必须先加载根 .env，再加载数据库、路由及其环境依赖。
const runtimeEnvironment = loadRuntimeEnvironment();

const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db/database');
const systemRoutes = require('./routes/system');
const dictionaryRoutes = require('./routes/dictionaries');
const energyTypeRoutes = require('./routes/energyTypes');
const importRoutes = require('./routes/imports');
const energyRecordRoutes = require('./routes/energyRecords');
const dashboardRoutes = require('./routes/dashboard');
const carbonRoutes = require('./routes/carbon');
const predictionRoutes = require('./routes/predictions');
const templateRoutes = require('./routes/templates');
const backupRoutes = require('./routes/backups');
const demoDataRoutes = require('./routes/demoData');
const organizationRoutes = require('./routes/organization');
const meterRoutes = require('./routes/meters');
const meterReadingRoutes = require('./routes/meterReadings');
const productionRoutes = require('./routes/production');
const generationRoutes = require('./routes/generation');
const energyBudgetRoutes = require('./routes/energyBudgets');
const energyAnalysisImportRoutes = require('./routes/energyAnalysisImports');
const energyBenchmarkImportRoutes = require('./routes/energyBenchmarkImports');
const energyFlowImportRoutes = require('./routes/energyFlowImports');
const energyBalanceImportRoutes = require('./routes/energyBalanceImports');
const energyBenchmarkRoutes = require('./routes/energyBenchmarks');
const energyAnalysisRoutes = require('./routes/energyAnalysis');
const energyFlowRoutes = require('./routes/energyFlows');
const energyBalanceRoutes = require('./routes/energyBalances');
// 供应商路由自带受限 JSON 解析器，必须在全局解析器前挂载。
const supplierRoutes = require('./routes/suppliers');
// 独立碳活动受控导入和作废同样必须在全局 JSON 解析器前挂载。
const carbonActivityRoutes = require('./routes/carbonActivities');
// 碳排放报告受控导入自带 64 KiB JSON 限制，必须先于全局解析器完成访问控制。
const carbonEmissionReportRoutes = require('./routes/carbonEmissionReports');
// 温室气体报告受控导入自带 64 KiB JSON 限制，必须先于全局解析器完成访问控制。
const ghgReportRoutes = require('./routes/ghgReports');
// 独立核算运行自带 64 KiB JSON 限制，必须在全局解析器前完成认证、权限和维护态检查。
const carbonAccountingRoutes = require('./routes/carbonAccounting');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const menuRoutes = require('./routes/menus');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { AppError } = require('./utils/errors');

const app = express();
// API 监听模块：端口来自集中配置，主机继续固定为本机回环地址。
const backendHost = runtimeEnvironment.backendHost;
const port = runtimeEnvironment.backendPort;
const defaultAllowedOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
  'http://127.0.0.1:7777',
  'http://localhost:7777',
  'http://[::1]:7777'
];

function parseAllowedOrigin(origin) {
  const rawOrigin = String(origin || '').trim();
  if (!rawOrigin || rawOrigin.includes('*')) {
    return '';
  }
  try {
    const parsedOrigin = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) {
      return '';
    }
    if (!parsedOrigin.hostname || parsedOrigin.username || parsedOrigin.password) {
      return '';
    }
    if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
      return '';
    }
    if (parsedOrigin.origin === 'null') {
      return '';
    }
    return parsedOrigin.origin;
  } catch (error) {
    return '';
  }
}

function buildAllowedOrigins(corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS || '') {
  const envAllowedOrigins = String(corsAllowedOrigins)
    .split(',')
    .map(parseAllowedOrigin)
    .filter(Boolean);
  return new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);
}

function isCorsOriginAllowed(origin, allowedOriginsSet = allowedOrigins) {
  return !origin || allowedOriginsSet.has(origin);
}

const allowedOrigins = buildAllowedOrigins();

app.use(cors({
  origin(origin, callback) {
    if (isCorsOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    callback(new AppError('CORS_ORIGIN_FORBIDDEN', '当前请求来源未被允许访问 API。', { statusCode: 403 }));
  },
  exposedHeaders: [
    'Content-Disposition',
    'Content-Length',
    'X-Recommended-Format',
    'X-Backup-Name',
    'X-Demo-Dataset-Id',
    'X-Demo-Run-Id',
    'X-Demo-Artifact-Key',
    'X-Demo-Handler-Key',
    'X-Demo-Manifest-Version',
    'X-Demo-Manifest-Digest',
    'X-Demo-Artifact-Sha256',
    'X-Demo-Context',
    'X-Exported-Row-Count',
    'X-Exported-Row-Count-Independent-Activity',
    'X-Exported-Row-Count-Energy-Record'
  ]
}));

// 受控导入和自带请求体限制的业务路由必须先完成认证、授权和维护态检查，再解析 JSON。
app.use('/api/energy-analysis/imports', energyAnalysisImportRoutes);
app.use('/api/energy-benchmarks/imports', energyBenchmarkImportRoutes);
app.use('/api/energy-flow-imports', energyFlowImportRoutes);
app.use('/api/energy-balance-imports', energyBalanceImportRoutes);
app.use('/api/energy-benchmarks', energyBenchmarkRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/carbon/activities', carbonActivityRoutes);
app.use('/api/carbon/emission-reports', carbonEmissionReportRoutes);
app.use('/api/carbon/ghg-reports', ghgReportRoutes);
app.use('/api/carbon/accounting', carbonAccountingRoutes);

app.use(express.json({ limit: '2mb' }));

app.use('/api', systemRoutes);
app.use('/api/dictionaries', dictionaryRoutes);
app.use('/api/energy-types', energyTypeRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/energy-records', energyRecordRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/carbon', carbonRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/system/backups', backupRoutes);
app.use('/api/system/demo-data', demoDataRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/meters', meterRoutes);
app.use('/api/meter-readings', meterReadingRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/generation', generationRoutes);
app.use('/api/energy-budgets', energyBudgetRoutes);
app.use('/api/energy-analysis', energyAnalysisRoutes);
app.use('/api/energy-flows', energyFlowRoutes);
app.use('/api/energy-balances', energyBalanceRoutes);
app.use('/api', authRoutes);
app.use('/api/system/users', userRoutes);
app.use('/api/system/roles', roleRoutes);
app.use('/api/system/menus', menuRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/menus', menuRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

function start() {
  initDatabase();
  app.listen(port, backendHost, () => {
    console.log(`Energy carbon platform API listening at ${runtimeEnvironment.backendOrigin}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  app,
  start,
  defaultAllowedOrigins,
  parseAllowedOrigin,
  buildAllowedOrigins,
  isCorsOriginAllowed
};
