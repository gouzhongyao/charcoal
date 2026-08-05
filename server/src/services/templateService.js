const XLSX = require('xlsx');
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
    description: '用于预演并受控导入用能预算；periodMonth、energyTypeCode/能源类型、organizationScope、budgetValue、unit、remark、status 与后端契约一致。能源类型必须为 active；相同月份、能源类型和组织范围已存在或同文件重复时默认 skip warning，不覆盖、不物理删除既有预算。',
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
    headers: ['period', 'energy_type', 'energy_name', 'value', 'unit', 'organization_unit', 'site', 'department', 'production_line', 'meter_name', 'data_time', 'business_dimension', 'remark'],
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
    description: '用于批量导入计量抄表记录；导入只写入 meter_reading_records，不自动写入 energy_records，也不自动进入能耗统计。',
    headers: ['reading_date', 'meter_code', 'meter_name', 'previous_value', 'current_value', 'multiplier', 'usage_value', 'unit', 'organization_unit', 'remark'],
    rows: [
      ['2026-02-28', 'E-001', '一车间电表', '12000', '12500', '1', '', 'kWh', '烟测集团/生产部', 'usage_value 为空时按表码差×倍率计算'],
      ['2026-02-28', '', '锅炉房热量表', '100', '110', '10', '', 'MJ', '烟测集团/锅炉房', 'meter_code 为空时用 用能单元 + meter_name 匹配']
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
    description: '用于预演并受控导入产能单元；unitCode、unitName、organizationUnitCode、productName、outputUnit、remark、status 与后端契约一致。organizationUnitCode 必须匹配 active 用能单元；已有产能单元编码或同文件重复默认 skip warning，不覆盖、不恢复、不物理删除既有台账。',
    headers: ['unitCode', 'unitName', 'organizationUnitCode', 'productName', 'outputUnit', 'remark', 'status'],
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
      ['PU-002', '二线产能单元', '2026/02', '2500', '件', '', 'data_source 为空时默认 upload']
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
    description: '用于预演并受控导入发电自用记录；用能单元编码必填且必须匹配 active 用能单元，同用能单元同月份 photovoltaic 已有 active 发电记录或同文件重复候选时默认 skip warning，不覆盖、不作废旧记录；导入只写 generation_records，不写 energy_records、carbon_emissions 或单位产品能耗。',
    headers: [...GENERATION_RECORD_IMPORT_HEADERS],
    rows: [
      ['OU-001', '一车间', '2026-01', '1200', '900', '300', 'upload', '编码优先；名称仅用于辅助校验/展示'],
      ['OU-002', '二车间', '2026/02', '850', '700', '150', '', 'data_source 为空时默认 upload']
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
    headers: ['unit_code', 'unit_name', 'parent_code', 'parent_name', 'unit_type', 'area', 'sort_order', 'status', 'remark'],
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
    headers: ['meter_code', 'meter_name', 'meter_type', 'energy_type_code', 'organization_unit_code', 'organization_unit', 'online_status', 'gateway_id', 'multiplier', 'allow_manual_reading', 'flow_direction', 'install_location', 'status', 'remark'],
    rows: [
      ['M-001', '一车间电表', 'electricity', 'electricity', 'OU-002', '生产部/一车间', 'unknown', 'GW-001', '1', '1', 'input', '配电室', 'active', '能源类型和用能单元必须已存在'],
      ['H-001', '锅炉房热量表', 'heat', 'heat', 'OU-003', '生产部/锅炉房', 'offline', '', '10', '1', 'input', '锅炉房', 'active', 'online_status 仅作台账字段']
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
    description: '仅用于导入可编辑的 draft 预测配置；不会运行预测，不会写 prediction_results、energy_records 或 carbon_emissions。预测结果必须由后端基于已入库能耗数据生成。',
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
    headers: ['period', 'energy_type', 'energy_name', 'value', 'unit', 'organization_unit', 'site', 'department', 'production_line', 'meter_name', 'data_time', 'business_dimension', 'remark'],
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

function listTemplates() {
  return Object.values(TEMPLATE_DEFINITIONS).map((template) => ({
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
}

function normalizeTemplateType(templateType) {
  return String(templateType || '')
    .trim()
    .replace(/\.(csv|xlsx)$/i, '')
    .toLowerCase();
}

function getTemplateDefinition(templateType) {
  return TEMPLATE_DEFINITIONS[normalizeTemplateType(templateType)] || null;
}

function getTemplateCsv(templateType) {
  const template = getTemplateDefinition(templateType);
  if (!template) {
    return null;
  }
  return {
    template,
    fileName: getFileName(template, 'csv'),
    csv: renderCsv(template.headers, template.rows)
  };
}

function getTemplateXlsx(templateType) {
  const template = getTemplateDefinition(templateType);
  if (!template) {
    return null;
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
