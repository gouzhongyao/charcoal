const XLSX = require('xlsx');
const { AppError } = require('../utils/errors');
const {
  generateEnergyAnalysisTemplate,
  getEnergyAnalysisTemplateDefinition,
  listEnergyAnalysisTemplates
} = require('./energyAnalysisTemplateService');
const {
  GENERATION_RECORD_IMPORT_HEADERS,
  GENERATION_RECORD_IMPORT_TEMPLATE_ID
} = require('./generationService');
const {
  ENERGY_BUDGET_IMPORT_HEADERS,
  ENERGY_BUDGET_IMPORT_TEMPLATE_ID
} = require('./energyBudgetService');
const {
  CARBON_FACTOR_IMPORT_HEADERS,
  CARBON_FACTOR_IMPORT_TEMPLATE_ID
} = require('./carbonAccountingService');
const {
  PREDICTION_CONFIG_IMPORT_HEADERS,
  PREDICTION_CONFIG_IMPORT_TEMPLATE_ID
} = require('./predictionService');

const UTF8_BOM = '﻿';

// 已复审能源分析模板 ID 集合由独立模板服务生成，中央服务不重复维护模板定义。
const ENERGY_ANALYSIS_TEMPLATE_TYPES = new Set(
  listEnergyAnalysisTemplates().map((template) => template.id)
);

const TEMPLATE_DEFINITIONS = {
  [ENERGY_BUDGET_IMPORT_TEMPLATE_ID]: {
    type: ENERGY_BUDGET_IMPORT_TEMPLATE_ID,
    name: '用能预算导入模板',
    baseFileName: '用能预算导入模板',
    sheetName: '用能预算导入模板',
    route: '/api/templates/energy-budgets.xlsx',
    csvRoute: '/api/templates/energy-budgets.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['能耗管理', '用能预算'],
    contractRoute: 'POST /api/energy-budgets/import/preview -> POST /api/energy-budgets/import/execute',
    description: '用于预演并受控导入用能预算；预算月份、能源类型编码、组织范围、预算值、单位、备注、状态与后端契约一致。能源类型必须为 active；相同月份、能源类型和组织范围已存在或同文件重复时默认 skip warning，不覆盖、不物理删除既有预算。',
    headers: [...ENERGY_BUDGET_IMPORT_HEADERS],
    rows: [
      ['2026-01', 'electricity', '整体', '12000', 'kWh', '全公司电力月度预算', 'active'],
      ['2026/02', 'heat', '生产部', '8000', 'MJ', '组织范围可按实际业务文本填写', 'active']
    ]
  },
  'energy-records': {
    type: 'energy-records',
    name: '能耗数据导入模板',
    baseFileName: '能耗数据导入模板',
    sheetName: '能耗导入模板',
    route: '/api/templates/energy-records.xlsx',
    csvRoute: '/api/templates/energy-records.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['数据导入', '能耗统计', '预测管理历史数据'],
    contractRoute: 'POST /api/imports/batches',
    description: '用于上传能耗记录；预测管理的历史数据沿用此能耗记录导入结构，导入后按训练月份读取历史能耗。',
    headers: ['月份', '能源类型编码', '能源类型名称', '用量', '单位', '用能单元', '厂区', '部门', '产线', '仪表编码', '数据时间', '业务维度', '备注'],
    rows: [
      ['2026-01', 'electricity', '电力', '1000', 'kWh', '烟测集团/生产部', '烟测园区', '生产部', '一线', 'E-001', '2026-01-01 00:00:00', 'monthly-energy', '能耗导入与预测历史样例'],
      ['2026/02', 'natural_gas', '天然气', '50', 'm3', '烟测集团/动力部', '烟测园区', '动力部', '', 'G-001', '2026-02-01 00:00:00', 'monthly-energy', '碳核算缺失因子样例'],
      ['2026-03', 'photovoltaic', '光伏', '1.5', 'MWh', '烟测集团/能源站', '屋顶光伏区', '能源站', '', 'PV-001', '2026-03-01 00:00:00', 'self-generation', '光伏 MWh 自动标准化为 kWh'],
      ['2026-04', 'oil', '油', '800', 'kg', '烟测集团/锅炉房', '烟测园区', '锅炉房', '', 'OIL-001', '2026-04-01 00:00:00', 'monthly-energy', '通用油 kg 自动标准化为 t']
    ]
  },
  'meter-readings': {
    type: 'meter-readings',
    name: '计量抄表导入模板',
    baseFileName: '计量抄表导入模板',
    sheetName: '抄表导入模板',
    route: '/api/templates/meter-readings.xlsx',
    csvRoute: '/api/templates/meter-readings.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '计量抄表'],
    contractRoute: 'POST /api/meter-readings/import',
    description: '用于批量导入计量抄表记录；导入只写入计量抄表记录，不自动写入能耗记录，也不自动进入能耗统计。',
    headers: ['抄表日期', '计量器具编码', '计量器具名称', '上期表码', '本期表码', '倍率', '用量', '单位', '用能单元', '备注'],
    rows: [
      ['2026-02-28', 'E-001', '一车间电表', '12000', '12500', '1', '', 'kWh', '烟测集团/生产部', '用量为空时按表码差×倍率计算'],
      ['2026-02-28', '', '锅炉房热量表', '100', '110', '10', '', 'MJ', '烟测集团/锅炉房', '计量器具编码为空时用用能单元和计量器具名称匹配']
    ]
  },
  'production-units': {
    type: 'production-units',
    name: '产能单元导入模板',
    baseFileName: '产能单元导入模板',
    sheetName: '产能单元导入模板',
    route: '/api/templates/production-units.xlsx',
    csvRoute: '/api/templates/production-units.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '产能单元'],
    contractRoute: 'POST /api/production/units/import/preview -> POST /api/production/units/import/execute',
    description: '用于预演并受控导入产能单元；产能单元编码、产能单元名称、所属用能单元编码、产品名称、产量单位、备注、状态与后端契约一致。所属用能单元编码必须匹配 active 用能单元；已有产能单元编码或同文件重复默认 skip warning，不覆盖、不恢复、不物理删除既有台账。',
    headers: ['产能单元编码', '产能单元名称', '所属用能单元编码', '产品名称', '产量单位', '备注', '状态'],
    rows: [
      ['PU-001', '一线产能单元', 'OU-001', '产品A', 't', '所属用能单元必须已存在且 active', 'active'],
      ['PU-002', '二线产能单元', 'OU-002', '产品B', '件', '重复编码按 skip 处理，不覆盖既有单元', 'inactive']
    ]
  },
  'production-outputs': {
    type: 'production-outputs',
    name: '月度产量导入模板',
    baseFileName: '月度产量导入模板',
    sheetName: '月度产量导入模板',
    route: '/api/templates/production-outputs.xlsx',
    csvRoute: '/api/templates/production-outputs.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '产能单元', '月度产量'],
    contractRoute: 'POST /api/production/outputs/import/preview -> POST /api/production/outputs/import/execute',
    description: '用于预演并受控导入月度产量记录；产能单元编码必填且必须匹配 active 产能单元，同产能单元同月份已有 active 产量时 skip warning，不覆盖、不作废旧记录。',
    headers: ['产能单元编码', '产能单元名称', '月份', '产量值', '产量单位', '数据来源', '备注'],
    rows: [
      ['PU-001', '一线产能单元', '2026-01', '1000', 't', 'upload', '编码优先；名称仅用于辅助校验/展示'],
      ['PU-002', '二线产能单元', '2026/02', '2500', '件', '', '数据来源为空时默认按上传文件处理']
    ]
  },
  [GENERATION_RECORD_IMPORT_TEMPLATE_ID]: {
    type: GENERATION_RECORD_IMPORT_TEMPLATE_ID,
    name: '发电自用记录导入模板',
    baseFileName: '发电自用记录导入模板',
    sheetName: '发电自用记录导入模板',
    route: '/api/templates/generation-records.xlsx',
    csvRoute: '/api/templates/generation-records.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '发电自用', '发电记录导入'],
    contractRoute: 'POST /api/generation/records/import/preview -> POST /api/generation/records/import/execute',
    description: '用于预演并受控导入发电自用记录；用能单元编码必填且必须匹配启用的用能单元，同用能单元同月份已有启用的光伏发电记录或同文件重复候选时默认跳过并记录告警，不覆盖、不作废旧记录；导入只写发电自用记录，不写能耗记录、碳排放结果或单位产品能耗。',
    headers: [...GENERATION_RECORD_IMPORT_HEADERS],
    rows: [
      ['OU-001', '一车间', '2026-01', '1200', '900', '300', 'upload', '编码优先；名称仅用于辅助校验/展示'],
      ['OU-002', '二车间', '2026/02', '850', '700', '150', '', '数据来源为空时默认按上传文件处理']
    ]
  },
  'organization-units': {
    type: 'organization-units',
    name: '用能单元导入模板',
    baseFileName: '用能单元导入模板',
    sheetName: '用能单元模板',
    route: '/api/templates/organization-units.xlsx',
    csvRoute: '/api/templates/organization-units.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '用能单元'],
    contractRoute: 'POST /api/organization/units/import',
    description: '用于批量导入组织/用能单元；父级必须已存在，重复编码默认 skip 并写 warning，不覆盖已有台账。',
    headers: ['用能单元编码', '用能单元名称', '父级编码', '父级名称', '用能单元类型', '面积', '排序', '状态', '备注'],
    rows: [
      ['OU-001', '生产部', '', '', 'department', '1200', '10', 'active', '根级用能单元样例'],
      ['OU-002', '一车间', 'OU-001', '生产部', 'workshop', '600', '20', 'active', '父级必须已存在；同文件前一行不会被当作已存在父级']
    ]
  },
  'meters': {
    type: 'meters',
    name: '计量器具导入模板',
    baseFileName: '计量器具导入模板',
    sheetName: '计量器具模板',
    route: '/api/templates/meters.xlsx',
    csvRoute: '/api/templates/meters.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '计量器具'],
    contractRoute: 'POST /api/meters/import',
    description: '用于批量导入计量器具；能源类型和用能单元必须已存在，重复编码默认 skip 并写 warning，不覆盖已有台账。',
    headers: ['计量器具编码', '计量器具名称', '计量器具类型', '能源类型编码', '用能单元编码', '用能单元', '在线状态', '网关ID', '倍率', '允许手工抄表', '流向', '安装位置', '状态', '备注'],
    rows: [
      ['M-001', '一车间电表', 'electricity', 'electricity', 'OU-002', '生产部/一车间', 'unknown', 'GW-001', '1', '1', 'input', '配电室', 'active', '能源类型和用能单元必须已存在'],
      ['H-001', '锅炉房热量表', 'heat', 'heat', 'OU-003', '生产部/锅炉房', 'offline', '', '10', '1', 'input', '锅炉房', 'active', '在线状态仅作台账字段']
    ]
  },
  [CARBON_FACTOR_IMPORT_TEMPLATE_ID]: {
    type: CARBON_FACTOR_IMPORT_TEMPLATE_ID,
    name: '碳因子导入模板',
    baseFileName: '碳因子导入模板',
    sheetName: '碳因子模板',
    route: '/api/templates/carbon-factors.xlsx',
    csvRoute: '/api/templates/carbon-factors.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['碳核算', '碳因子维护'],
    contractRoute: 'POST /api/carbon/factors/import/preview -> POST /api/carbon/factors/import/execute',
    description: '用于预演并受控导入碳因子；字段与碳因子导出、详情和维护契约一致。能源类型必须为 active；相同能源类型、地区、年份、单位和来源已存在或同文件重复时默认 skip warning，不覆盖、不物理删除既有因子，也不写入碳排放结果。',
    headers: [...CARBON_FACTOR_IMPORT_HEADERS],
    rows: [
      ['electricity', 'default', '2026', 'kWh', '0.5703', 'kgCO2e', '业务维护', 'https://example.com/electricity-factor', '2026-01-01', '2026-12-31', 'active'],
      ['natural_gas', 'default', '2026', 'm3', '2.1622', 'kgCO2e', '业务维护', '', '2026-01-01', '', 'active']
    ]
  },
  [PREDICTION_CONFIG_IMPORT_TEMPLATE_ID]: {
    type: PREDICTION_CONFIG_IMPORT_TEMPLATE_ID,
    name: '预测配置草稿导入模板',
    baseFileName: '预测配置草稿导入模板',
    sheetName: '预测配置草稿',
    route: '/api/templates/prediction-configs.xlsx',
    csvRoute: '/api/templates/prediction-configs.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['预测管理', '预测配置草稿'],
    contractRoute: 'POST /api/predictions/configs/import/preview -> POST /api/predictions/configs/import/execute',
    description: '仅用于导入可编辑的草稿预测配置；不会运行预测，不会写预测结果、能耗记录或碳排放结果。预测结果必须由后端基于已入库能耗数据生成。',
    headers: [...PREDICTION_CONFIG_IMPORT_HEADERS],
    rows: [
      ['电力趋势预测草稿', '导入后可编辑，运行时由服务端读取已入库能耗', 'electricity', '生产部', 'A园区', '生产部', '', '2026-01', '2026-03', '2026-04', '2026-06', 'moving_average', '3', 'draft']
    ]
  },
  'prediction-history': {
    type: 'prediction-history',
    name: '预测历史数据模板',
    baseFileName: '预测历史数据模板',
    sheetName: '预测历史模板',
    route: '/api/templates/prediction-history.xlsx',
    csvRoute: '/api/templates/prediction-history.csv',
    recommendedFormat: 'xlsx',
    appliesTo: ['预测管理', '数据导入'],
    contractRoute: 'POST /api/imports/batches',
    reusableTemplateType: 'energy-records',
    description: '预测历史数据复用能耗记录导入结构；请先下载/填写并导入本模板或能耗数据导入模板，再在预测管理中选择训练月份。',
    headers: ['月份', '能源类型编码', '能源类型名称', '用量', '单位', '用能单元', '厂区', '部门', '产线', '仪表编码', '数据时间', '业务维度', '备注'],
    rows: [
      ['2026-01', 'electricity', '电力', '1000', 'kWh', '烟测集团/生产部', '烟测园区', '生产部', '一线', 'E-001', '2026-01-01 00:00:00', 'prediction-history', '预测训练历史第 1 月'],
      ['2026-02', 'electricity', '电力', '1100', 'kWh', '烟测集团/生产部', '烟测园区', '生产部', '一线', 'E-001', '2026-02-01 00:00:00', 'prediction-history', '预测训练历史第 2 月'],
      ['2026-03', 'electricity', '电力', '1200', 'kWh', '烟测集团/生产部', '烟测园区', '生产部', '一线', 'E-001', '2026-03-01 00:00:00', 'prediction-history', '移动平均至少需要 3 个历史月份']
    ]
  }
};

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function renderCsv(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(','));
  return `${UTF8_BOM}${lines.join('\n')}\n`;
}

function buildColumnWidths(headers, rows) {
  return headers.map((header, index) => {
    const maxLength = [header, ...rows.map((row) => row[index])]
      .reduce((max, value) => Math.max(max, String(value ?? '').length), 0);
    return { wch: Math.min(Math.max(maxLength + 4, 12), 36) };
  });
}

function renderXlsxBuffer(template) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([template.headers, ...template.rows]);
  worksheet['!cols'] = buildColumnWidths(template.headers, template.rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, template.sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function getFileName(template, extension) {
  return `${template.baseFileName}.${extension}`;
}

/** 规范化中央模板类型，兼容携带 CSV/XLSX 扩展名的调用。 */
function normalizeTemplateType(templateType) {
  return String(templateType || '')
    .trim()
    .replace(/\.(csv|xlsx)$/i, '')
    .toLowerCase();
}

/** 将能源分析模板定义适配为中央模板服务的统一元数据。 */
function buildEnergyAnalysisTemplateDefinition(templateType) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  if (!definition) {
    return null;
  }

  const xlsxRoute = `/api/templates/${definition.id}.xlsx`;
  const csvRoute = definition.formats.includes('csv')
    ? `/api/templates/${definition.id}.csv`
    : null;
  return {
    type: definition.id,
    name: definition.name,
    baseFileName: definition.baseFileName,
    asciiBaseFileName: definition.asciiBaseFileName,
    sheetName: definition.sheetName,
    route: xlsxRoute,
    csvRoute,
    recommendedFormat: 'xlsx',
    formats: [...definition.formats],
    appliesTo: ['能源分析'],
    contractRoute: null,
    description: `用于下载${definition.name}；当前仅接入中央模板服务，不代表领域预演或执行接口已开放。`,
    headers: definition.headers ? [...definition.headers] : null,
    rows: definition.rows,
    sheetNames: definition.sheets.map((sheet) => sheet.name),
    sheets: definition.sheets.map((sheet) => ({
      name: sheet.name,
      headers: [...sheet.headers]
    }))
  };
}

/** 将独立能源分析模板服务的稳定领域错误转换为 HTTP 可识别错误。 */
function convertEnergyAnalysisTemplateError(error) {
  if (error && error.code === 'TEMPLATE_FORMAT_UNSUPPORTED') {
    return new AppError(error.code, error.message, {
      statusCode: 400,
      details: error.details || null
    });
  }
  return error;
}

/** 调用独立能源分析模板服务生成文件，并适配中央下载结果。 */
function generateRegisteredEnergyAnalysisTemplate(templateType, format) {
  const template = buildEnergyAnalysisTemplateDefinition(templateType);
  if (!template) {
    return null;
  }
  try {
    return {
      ...generateEnergyAnalysisTemplate(template.type, format),
      template
    };
  } catch (error) {
    throw convertEnergyAnalysisTemplateError(error);
  }
}

/** 列出历史模板和已注册能源分析模板，历史模板元数据保持原有结构。 */
function listTemplates() {
  const historicalTemplates = Object.values(TEMPLATE_DEFINITIONS).map((template) => ({
    type: template.type,
    name: template.name,
    route: template.route,
    fileName: getFileName(template, 'xlsx'),
    csvRoute: template.csvRoute,
    csvFileName: getFileName(template, 'csv'),
    recommendedFormat: template.recommendedFormat,
    downloads: {
      xlsx: template.route,
      csv: template.csvRoute
    },
    appliesTo: template.appliesTo,
    contractRoute: template.contractRoute,
    reusableTemplateType: template.reusableTemplateType || null,
    description: template.description,
    headers: template.headers
  }));
  const energyAnalysisTemplates = listEnergyAnalysisTemplates().map((listedTemplate) => {
    const template = buildEnergyAnalysisTemplateDefinition(listedTemplate.id);
    return {
      type: template.type,
      name: template.name,
      route: template.route,
      fileName: getFileName(template, 'xlsx'),
      asciiFileName: `${template.asciiBaseFileName}.xlsx`,
      csvRoute: template.csvRoute,
      csvFileName: template.csvRoute ? getFileName(template, 'csv') : null,
      recommendedFormat: template.recommendedFormat,
      formats: [...template.formats],
      downloads: {
        xlsx: template.route,
        ...(template.csvRoute ? { csv: template.csvRoute } : {})
      },
      appliesTo: template.appliesTo,
      contractRoute: template.contractRoute,
      reusableTemplateType: null,
      description: template.description,
      headers: template.headers,
      sheetNames: [...template.sheetNames],
      sheets: template.sheets.map((sheet) => ({
        name: sheet.name,
        headers: [...sheet.headers]
      }))
    };
  });
  return [...historicalTemplates, ...energyAnalysisTemplates];
}

/** 读取中央模板定义，能源分析模板由独立服务按需适配。 */
function getTemplateDefinition(templateType) {
  const normalizedTemplateType = normalizeTemplateType(templateType);
  if (Object.prototype.hasOwnProperty.call(TEMPLATE_DEFINITIONS, normalizedTemplateType)) {
    return TEMPLATE_DEFINITIONS[normalizedTemplateType];
  }
  if (!ENERGY_ANALYSIS_TEMPLATE_TYPES.has(normalizedTemplateType)) {
    return null;
  }
  return buildEnergyAnalysisTemplateDefinition(normalizedTemplateType);
}

/** 生成中央注册模板的 CSV 文件。 */
function getTemplateCsv(templateType) {
  const template = getTemplateDefinition(templateType);
  if (!template) {
    return null;
  }
  if (ENERGY_ANALYSIS_TEMPLATE_TYPES.has(template.type)) {
    return generateRegisteredEnergyAnalysisTemplate(template.type, 'csv');
  }
  return {
    template,
    fileName: getFileName(template, 'csv'),
    csv: renderCsv(template.headers, template.rows)
  };
}

/** 生成中央注册模板的 XLSX 文件。 */
function getTemplateXlsx(templateType) {
  const template = getTemplateDefinition(templateType);
  if (!template) {
    return null;
  }
  if (ENERGY_ANALYSIS_TEMPLATE_TYPES.has(template.type)) {
    return generateRegisteredEnergyAnalysisTemplate(template.type, 'xlsx');
  }
  return {
    template,
    fileName: getFileName(template, 'xlsx'),
    buffer: renderXlsxBuffer(template)
  };
}

module.exports = {
  getTemplateCsv,
  getTemplateDefinition,
  getTemplateXlsx,
  listTemplates,
  renderCsv,
  renderXlsxBuffer,
  UTF8_BOM
};
