const express = require('express');
const { listTemplates, getTemplateCsv, getTemplateXlsx } = require('../services/templateService');
const { sendSuccess } = require('../utils/response');
const { notFound } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || '00000000.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const LEDGER_TEMPLATE_PERMISSIONS = Object.freeze({
  'organization-units': 'ledger:units:template',
  meters: 'ledger:meters:template',
  'meter-readings': 'ledger:readings:template',
  'production-units': 'ledger:production:template',
  'production-outputs': 'ledger:production:template',
  'generation-records': 'ledger:generation:template',
  'energy-budgets': 'energy:budget:template',
  'carbon-factors': 'carbon:factor:template',
  'prediction-configs': 'prediction:config:template'
});

function templateNotFound(req, next) {
  next(notFound('导入模板不存在', {
    templateType: req.params.templateType,
    supportedTemplateTypes: listTemplates().map((template) => template.type)
  }));
}

function requireTemplateDownloadPermission(req, res, next) {
  const templateType = String(req.params.templateType || '').trim().toLowerCase();
  const permission = LEDGER_TEMPLATE_PERMISSIONS[templateType];
  if (!permission) {
    next('route');
    return;
  }

  authenticate(req, res, (authenticationError) => {
    if (authenticationError) {
      next(authenticationError);
      return;
    }
    requirePermission(permission)(req, res, next);
  });
}

router.get('/', (req, res) => {
  sendSuccess(res, listTemplates(), {
    meta: {
      recommendedFormat: 'xlsx',
      csvEncoding: 'UTF-8 with BOM',
      routes: ['GET /api/templates', 'GET /api/templates/:templateType.xlsx', 'GET /api/templates/:templateType.csv']
    }
  });
});

// 用能预算模板属于受保护业务能力；其他历史模板路由保持既有兼容性，不在本次全局改造范围内。
router.get('/energy-budgets.xlsx', authenticate, requirePermission('energy:budget:template'), (req, res, next) => {
  const result = getTemplateXlsx('energy-budgets');
  if (!result) { templateNotFound(req, next); return; }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, '00000000.xlsx'));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/energy-budgets.csv', authenticate, requirePermission('energy:budget:template'), (req, res, next) => {
  const result = getTemplateCsv('energy-budgets');
  if (!result) { templateNotFound(req, next); return; }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, '00000000.csv'));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

// 该参数化拦截器必须先于通用下载路由注册，以同时覆盖大小写与 URL 编码后落入通用路由的台账模板请求。
router.get('/:templateType.xlsx', requireTemplateDownloadPermission);
router.get('/:templateType.csv', requireTemplateDownloadPermission);

router.get('/:templateType.xlsx', (req, res, next) => {
  const result = getTemplateXlsx(req.params.templateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, '00000000.xlsx'));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/:templateType.csv', (req, res, next) => {
  const result = getTemplateCsv(req.params.templateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, '00000000.csv'));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

module.exports = router;
