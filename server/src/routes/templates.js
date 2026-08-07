const express = require('express');
const { listTemplates, getTemplateCsv, getTemplateXlsx } = require('../services/templateService');
const { sendSuccess } = require('../utils/response');
const { notFound } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'yewu-template.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// 受保护模板统一复用现有模板下载权限边界；能源分析模板复用数据导入查看权限。
const PROTECTED_TEMPLATE_PERMISSIONS = Object.freeze({
  'organization-units': 'ledger:units:template',
  meters: 'ledger:meters:template',
  'meter-readings': 'ledger:readings:template',
  'production-units': 'ledger:production:template',
  'production-outputs': 'ledger:production:template',
  'generation-records': 'ledger:generation:template',
  'energy-budgets': 'energy:budget:template',
  'carbon-factors': 'carbon:factor:template',
  'prediction-configs': 'prediction:config:template',
  'energy-timeseries': 'imports:view',
  'shift-schedules': 'imports:view',
  'device-states': 'imports:view',
  'energy-conversion-factors': 'imports:view',
  'energy-benchmark-definitions': 'imports:view',
  'energy-benchmark-targets': 'imports:view',
  'energy-flow-nodes': 'imports:view',
  'energy-flow-edges': 'imports:view'
});

// 模板路由为不支持 filename* 的旧客户端提供唯一且可辨识的拼音业务文件名。
const TEMPLATE_ASCII_NAMES = Object.freeze({
  'energy-budgets': 'yongneng-yusuan-template',
  'energy-records': 'nenghao-jilu-template',
  'meter-readings': 'jiliang-chaobiao-template',
  'production-units': 'channeng-danyuan-template',
  'production-outputs': 'yuedu-chanliang-template',
  'generation-records': 'fadian-ziyong-template',
  'organization-units': 'yongneng-danyuan-template',
  meters: 'jiliang-qiju-template',
  'carbon-factors': 'tan-yinzi-template',
  'prediction-configs': 'yuce-peizhi-template',
  'prediction-history': 'yuce-lishi-template'
});

/** 返回模板对应的稳定 ASCII 业务文件名。 */
function getTemplateAsciiName(templateType) {
  return TEMPLATE_ASCII_NAMES[templateType] || 'yewu-template';
}

/** 优先使用模板服务返回的 ASCII fallback，历史模板继续使用既有拼音映射。 */
function getTemplateAsciiFileName(result, extension) {
  return result.asciiFileName || `${getTemplateAsciiName(result.template.type)}.${extension}`;
}

/** 严格规范化路由模板 ID，拒绝点号、额外扩展名和其他非 ID 字符。 */
function normalizeRouteTemplateType(templateType) {
  const rawTemplateType = String(templateType || '');
  return /^[A-Za-z0-9-]+$/.test(rawTemplateType)
    ? rawTemplateType.toLowerCase()
    : null;
}

function templateNotFound(req, next) {
  next(notFound('导入模板不存在', {
    templateType: req.params.templateType,
    supportedTemplateTypes: listTemplates().map((template) => template.type)
  }));
}

function requireTemplateDownloadPermission(req, res, next) {
  const templateType = normalizeRouteTemplateType(req.params.templateType);
  if (!templateType) {
    templateNotFound(req, next);
    return;
  }

  // 后续权限判断与模板生成必须复用同一个严格规范化值。
  req.normalizedTemplateType = templateType;
  const permission = Object.prototype.hasOwnProperty.call(PROTECTED_TEMPLATE_PERMISSIONS, templateType)
    ? PROTECTED_TEMPLATE_PERMISSIONS[templateType]
    : null;
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
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'xlsx')));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/energy-budgets.csv', authenticate, requirePermission('energy:budget:template'), (req, res, next) => {
  const result = getTemplateCsv('energy-budgets');
  if (!result) { templateNotFound(req, next); return; }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'csv')));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

// 该参数化拦截器必须先于通用下载路由注册，以覆盖大小写与 URL 编码后的全部受保护模板请求。
router.get('/:templateType.xlsx', requireTemplateDownloadPermission);
router.get('/:templateType.csv', requireTemplateDownloadPermission);

router.get('/:templateType.xlsx', (req, res, next) => {
  const result = getTemplateXlsx(req.normalizedTemplateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'xlsx')));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/:templateType.csv', (req, res, next) => {
  const result = getTemplateCsv(req.normalizedTemplateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'csv')));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

module.exports = router;
