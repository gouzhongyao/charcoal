const express = require('express');
const { listTemplates, getTemplateCsv, getTemplateXlsx } = require('../services/templateService');
const { sendSuccess } = require('../utils/response');
const { notFound } = require('../utils/errors');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'template.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function templateNotFound(req, next) {
  next(notFound('导入模板不存在', {
    templateType: req.params.templateType,
    supportedTemplateTypes: listTemplates().map((template) => template.type)
  }));
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

router.get('/:templateType.xlsx', (req, res, next) => {
  const result = getTemplateXlsx(req.params.templateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `${result.template.type}.xlsx`));
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
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, `${result.template.type}.csv`));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

module.exports = router;
