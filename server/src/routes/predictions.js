const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission, requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { rejectUnconnectedDemoContext } = require('../middleware/demoContext');
const { recordOperation } = require('../services/sessionService');
const {
  buildPredictionStats,
  cancelOrArchivePredictionRun,
  copyPredictionConfig,
  createPredictionConfig,
  createPredictionConfigImportPreviewFromUpload,
  createPredictionRun,
  createRunFromConfig,
  executePredictionConfigImport,
  exportPredictionConfigs,
  exportPredictionResults,
  getPredictionConfig,
  getPredictionManagementContract,
  getPredictionRun,
  listPredictionConfigs,
  listPredictionResults,
  listPredictionRuns,
  setPredictionConfigStatus,
  updatePredictionConfig
} = require('../services/predictionService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();
// 旧综合 prediction:view 仅用于未完成菜单迁移的历史会话兼容；新的细分角色必须按资源域读取。
const requirePredictionContractView = requireAnyPermission('prediction:config:view', 'prediction:run:view', 'prediction:result:view', 'prediction:view');
const requirePredictionConfigView = requireAnyPermission('prediction:config:view', 'prediction:view');
const requirePredictionRunView = requireAnyPermission('prediction:run:view', 'prediction:view');
const requirePredictionResultView = requireAnyPermission('prediction:result:view', 'prediction:view');

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'yuce-wenjian.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function audit(req, operation, targetType, targetId, detail) {
  recordOperation({ userId: req.user.id, operation, targetType, targetId: String(targetId || ''), detail, ip: req.ip });
}

router.get('/contract', authenticate, requirePredictionContractView, (req, res) => {
  sendSuccess(res, getPredictionManagementContract(), { meta: { contractOnly: false } });
});

router.get('/configs/export', authenticate, requirePermission('prediction:config:export'), asyncHandler(async (req, res) => {
  const result = exportPredictionConfigs(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `yuce-peizhi.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));

router.post('/configs/import/preview', authenticate, requirePermission('prediction:config:import'), requireWritable('prediction:config:import-preview'), rejectUnconnectedDemoContext, (req, res, next) => {
  uploadImportFile(req, res, (uploadError) => {
    const error = normalizeUploadError(uploadError);
    if (error) { cleanupUploadedImportFile(req.file); next(error); return; }
    Promise.resolve().then(() => createPredictionConfigImportPreviewFromUpload(req.file)).then((preview) => {
      audit(req, 'prediction.config.import.preview', 'prediction_config_import', preview.batchId, { wouldImport: preview.summary.wouldImport, blocked: preview.summary.blocked });
      sendSuccess(res, preview);
    }).catch((reason) => { cleanupUploadedImportFile(req.file); next(reason); });
  });
});

router.post('/configs/import/execute', authenticate, requirePermission('prediction:config:import'), requireWritable('prediction:config:import-execute'), rejectUnconnectedDemoContext, asyncHandler(async (req, res) => {
  const result = await executePredictionConfigImport(req.body || {});
  audit(req, 'prediction.config.import.execute', 'prediction_config_import', result.batchId, { imported: result.imported, writesPredictionRuns: false, writesPredictionResults: false });
  sendSuccess(res, result);
}));

router.get('/configs/:configId', authenticate, requirePredictionConfigView, asyncHandler(async (req, res) => {
  sendSuccess(res, getPredictionConfig(req.params.configId));
}));
router.get('/configs', authenticate, requirePredictionConfigView, asyncHandler(async (req, res) => {
  const result = listPredictionConfigs(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination } });
}));
router.post('/configs', authenticate, requirePermission('prediction:config:create'), requireWritable('prediction:config:create'), asyncHandler(async (req, res) => {
  const config = createPredictionConfig(req.body || {});
  audit(req, 'prediction.config.create', 'prediction_config', config.id, { status: config.status });
  sendSuccess(res, config, { statusCode: 201 });
}));
router.put('/configs/:configId', authenticate, requirePermission('prediction:config:update'), requireWritable('prediction:config:update'), asyncHandler(async (req, res) => {
  const config = updatePredictionConfig(req.params.configId, req.body || {});
  audit(req, 'prediction.config.update', 'prediction_config', config.id, { status: config.status });
  sendSuccess(res, config);
}));
router.patch('/configs/:configId/status', authenticate, requirePermission('prediction:config:status'), requireWritable('prediction:config:status'), asyncHandler(async (req, res) => {
  const config = setPredictionConfigStatus(req.params.configId, req.body || {});
  audit(req, 'prediction.config.status', 'prediction_config', config.id, { status: config.status });
  sendSuccess(res, config);
}));
router.post('/configs/:configId/copy', authenticate, requirePermission('prediction:config:create'), requireWritable('prediction:config:copy'), asyncHandler(async (req, res) => {
  const config = copyPredictionConfig(req.params.configId);
  audit(req, 'prediction.config.copy', 'prediction_config', config.id, { sourceConfigId: req.params.configId });
  sendSuccess(res, config, { statusCode: 201 });
}));
router.post('/configs/:configId/runs', authenticate, requirePermission('prediction:run:create'), requireWritable('prediction:run:create-from-config'), asyncHandler(async (req, res) => {
  const result = createRunFromConfig(req.params.configId);
  audit(req, 'prediction.run.create', 'prediction_run', result.run.id, { configId: req.params.configId, status: result.run.status, resultCount: result.summary.resultCount });
  sendSuccess(res, result, { statusCode: 201 });
}));

router.get('/runs/stats', authenticate, requirePredictionRunView, asyncHandler(async (req, res) => {
  const result = buildPredictionStats(req.query);
  sendSuccess(res, result, { meta: result.meta });
}));
router.get('/runs/:runId/results', authenticate, requirePredictionResultView, asyncHandler(async (req, res) => {
  const result = listPredictionResults({ ...req.query, runId: req.params.runId });
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));
router.patch('/runs/:runId/status', authenticate, requirePermission('prediction:run:cancel'), requireWritable('prediction:run:cancel-or-archive'), asyncHandler(async (req, res) => {
  const run = cancelOrArchivePredictionRun(req.params.runId, req.body || {});
  audit(req, 'prediction.run.status', 'prediction_run', run.id, { status: run.status });
  sendSuccess(res, run);
}));
router.get('/runs/:runId', authenticate, requirePredictionRunView, asyncHandler(async (req, res) => {
  sendSuccess(res, getPredictionRun(req.params.runId));
}));
router.get('/runs', authenticate, requirePredictionRunView, asyncHandler(async (req, res) => {
  const result = listPredictionRuns(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));
// 保留历史创建契约，但仍受统一 RBAC 保护；新调用方应使用配置草稿创建运行。
router.post('/runs', authenticate, requirePermission('prediction:run:create'), requireWritable('prediction:run:create-legacy'), asyncHandler(async (req, res) => {
  const result = createPredictionRun(req.body || {});
  audit(req, 'prediction.run.create.legacy', 'prediction_run', result.run.id, { status: result.run.status, resultCount: result.summary.resultCount });
  sendSuccess(res, result, { statusCode: 201 });
}));

router.get('/results/export', authenticate, requirePermission('prediction:result:export'), asyncHandler(async (req, res) => {
  const result = exportPredictionResults(req.query);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `yuce-jieguo.${result.format}`));
  res.setHeader('Content-Length', String(result.body.length));
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.status(200).send(result.body);
}));
router.get('/results', authenticate, requirePredictionResultView, asyncHandler(async (req, res) => {
  const result = listPredictionResults(req.query);
  sendSuccess(res, result.rows, { meta: { pagination: result.pagination, sort: result.sort } });
}));

module.exports = router;
