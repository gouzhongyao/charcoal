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
const { SUPPLIER_IMPORT_RESOURCE_LIMITS } = require('./supplierContracts');
const {
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS,
  CARBON_ACTIVITY_TEMPLATE_TYPE,
  CARBON_ACTIVITY_WORKSHEET_NAME
} = require('./carbonActivityContracts');
const {
  CARBON_EMISSION_REPORT_RESOURCE_LIMITS,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION
} = require('./carbonEmissionReportContracts');
const {
  GHG_REPORT_RESOURCE_LIMITS,
  GHG_REPORT_SHEETS,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION
} = require('./ghgReportContracts');
const {
  formatWallClockMinuteForUser,
  normalizeUserVisibleWallClockMinuteInput
} = require('../utils/userVisibleDateTime');

const UTF8_BOM = '﻿';

// 已复审能源分析模板 ID 集合由独立模板服务生成，中央服务不重复维护模板定义。
const ENERGY_ANALYSIS_TEMPLATE_TYPES = new Set(
  listEnergyAnalysisTemplates().map((template) => template.id)
);

// 中央模板下载权限必须与各领域现有预演权限一致；新增配置和平衡导入使用独立 preview 权限。
const TEMPLATE_REQUIRED_PERMISSIONS = Object.freeze({
  'organization-units': 'ledger:units:import',
  meters: 'ledger:meters:import',
  'meter-readings': 'ledger:readings:import',
  'production-units': 'ledger:production:import',
  'production-outputs': 'ledger:production:preview',
  suppliers: 'ledger:suppliers:import:preview',
  'generation-records': 'ledger:generation:preview',
  'energy-budgets': 'energy:budget:import',
  'carbon-factors': 'carbon:factor:import',
  'carbon-activities': 'carbon:activities:import:preview',
  'carbon-emission-report': 'carbon:emission-reports:import:preview',
  'ghg-report': 'carbon:ghg-reports:import:preview',
  'prediction-configs': 'prediction:config:import',
  'energy-timeseries': 'energy:analysis:timeseries:preview',
  'shift-definitions': 'energy:analysis:config:import:preview',
  'tou-schemes': 'energy:analysis:config:import:preview',
  'strategy-rules': 'energy:analysis:config:import:preview',
  'shift-schedules': 'energy:analysis:operations:preview',
  'device-states': 'energy:analysis:operations:preview',
  'energy-conversion-factors': 'energy:benchmarks:import:preview',
  'energy-benchmark-definitions': 'energy:benchmarks:import:preview',
  'energy-benchmark-targets': 'energy:benchmarks:import:preview',
  'energy-flow-models': 'energy:flows:import:preview',
  'energy-flow-nodes': 'energy:flows:import:preview',
  'energy-flow-edges': 'energy:flows:import:preview',
  'energy-flow-workbook': 'energy:flows:import:preview',
  'energy-balance-configs': 'energy:balance:import:preview'
});

// 能源分析模板元数据必须指向各领域已经开放的真实预演与执行路由。
const ENERGY_ANALYSIS_TEMPLATE_CONTRACT_ROUTES = Object.freeze({
  'energy-timeseries': 'POST /api/energy-analysis/imports/timeseries/preview -> POST /api/energy-analysis/imports/timeseries/execute',
  'shift-definitions': 'POST /api/energy-analysis/imports/shift-definitions/preview -> POST /api/energy-analysis/imports/shift-definitions/execute',
  'tou-schemes': 'POST /api/energy-analysis/imports/tou-schemes/preview -> POST /api/energy-analysis/imports/tou-schemes/execute',
  'strategy-rules': 'POST /api/energy-analysis/imports/strategy-rules/preview -> POST /api/energy-analysis/imports/strategy-rules/execute',
  'shift-schedules': 'POST /api/energy-analysis/imports/shift-schedules/preview -> POST /api/energy-analysis/imports/shift-schedules/execute',
  'device-states': 'POST /api/energy-analysis/imports/device-states/preview -> POST /api/energy-analysis/imports/device-states/execute',
  'energy-conversion-factors': 'POST /api/energy-benchmarks/imports/conversion-factors/preview -> POST /api/energy-benchmarks/imports/conversion-factors/execute',
  'energy-benchmark-definitions': 'POST /api/energy-benchmarks/imports/definitions/preview -> POST /api/energy-benchmarks/imports/definitions/execute',
  'energy-benchmark-targets': 'POST /api/energy-benchmarks/imports/targets/preview -> POST /api/energy-benchmarks/imports/targets/execute',
  'energy-flow-models': 'POST /api/energy-flow-imports/models/preview -> POST /api/energy-flow-imports/models/execute',
  'energy-flow-nodes': 'POST /api/energy-flow-imports/nodes/preview -> POST /api/energy-flow-imports/nodes/execute',
  'energy-flow-edges': 'POST /api/energy-flow-imports/bundle/preview -> POST /api/energy-flow-imports/bundle/execute',
  'energy-flow-workbook': 'POST /api/energy-flow-imports/workbook/preview -> POST /api/energy-flow-imports/workbook/execute',
  'energy-balance-configs': 'POST /api/energy-balance-imports/bundle/preview -> POST /api/energy-balance-imports/bundle/execute'
});

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
    description: '用于上传能耗记录；用能单元编码必须精确匹配启用台账，计量器具编码可选且必须与能源类型和用能单元一致。预测历史复用本结构。',
    headers: ['月份', '能源类型编码', '用量', '单位', '用能单元编码', '计量器具编码', '备注'],
    rows: [
      ['2026-01', 'electricity', '1000', 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '能耗导入与预测历史样例'],
      ['2026/02', 'natural_gas', '50', 'm3', 'QL-UTILITY', 'QL-M-GAS-UTILITY', '天然气能耗样例'],
      ['2026-03', 'photovoltaic', '1.5', 'MWh', 'QL-PARK', '', '光伏 MWh 自动标准化为 kWh'],
      ['2026-04', 'oil', '800', 'kg', 'QL-UTILITY', '', '通用油 kg 自动标准化为 t']
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
  suppliers: {
    type: 'suppliers',
    name: '供应商导入模板',
    baseFileName: '供应商导入模板',
    sheetName: '供应商',
    route: '/api/templates/suppliers.xlsx',
    csvRoute: null,
    recommendedFormat: 'xlsx',
    appliesTo: ['基础台账', '供应商管理'],
    contractRoute: 'POST /api/suppliers/imports/preview -> POST /api/suppliers/imports/execute',
    description: '固定 Excel v1 供应商模板；联系电话 E2:E5001 按文本保存，最多 5000 条数据。合作状态必填，支持合作中、已踢出及冻结映射别名，空白或未知值阻断；编码按 trim、NFKC 和大写规范键判重，同文件重复阻断，库内已有编码 skip warning，不覆盖既有供应商。',
    headers: ['供应商编码', '供应商名称', '地址', '联系人', '联系电话', '备注', '合作状态'],
    rows: [
      ['SUP-001', '天坤集团设备服务商', '天坤集团产业路 1 号', '张工', '010-01234567', '电话列固定为文本', '合作中'],
      ['SUP-002', '示例原料供应商', '天坤集团仓储路 2 号', '李经理', '+86 138-0000-0000 转 801', '已停止合作的示例', '已踢出']
    ],
    textColumnIndexes: [4],
    textColumnDataRowLimit: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows
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
  [CARBON_ACTIVITY_TEMPLATE_TYPE]: {
    type: CARBON_ACTIVITY_TEMPLATE_TYPE,
    name: '独立碳活动导入模板',
    baseFileName: '独立碳活动导入模板',
    asciiBaseFileName: 'carbon-activities',
    sheetName: CARBON_ACTIVITY_WORKSHEET_NAME,
    route: '/api/templates/carbon-activities.xlsx',
    csvRoute: null,
    recommendedFormat: 'xlsx',
    appliesTo: ['碳核算', '独立碳活动'],
    contractRoute: 'POST /api/carbon/activities/imports/preview -> POST /api/carbon/activities/imports/execute',
    description: '固定 Excel v1 独立碳活动模板；仅接受一张可见的“独立碳活动”工作表和 15 列精确中文表头。来源墙钟在用户文件中使用 YYYY-MM-DD HH:mm:00，历史 YYYY-MM-DDTHH:mm 继续兼容；按 IANA 时区唯一转换为 UTC，DST gap/fold 拒绝；导入只写活动事实，不匹配碳因子、不创建计算运行、不写核算结果或旧碳排放结果。',
    headers: [...CARBON_ACTIVITY_IMPORT_HEADERS],
    rows: [
      ['CA-2026-0001', '', '范围二', '购入电力', 'OU-001', 'electricity', '2026-01-01T00:00', '2026-02-01T00:00', 'Asia/Shanghai', '12000', 'kWh', 'default', 'electric-meter-summary-2026-01', 'evidence://electricity/2026-01', '用户文件墙钟使用 YYYY-MM-DD HH:mm:00，内部仍精确到分钟'],
      ['CA-2026-0002', '', 'scope_1', '天然气燃烧', 'OU-002', 'natural_gas', '2026-01-01T00:00', '2026-02-01T00:00', 'Asia/Shanghai', '500', 'm3', 'default', 'gas-meter-summary-2026-01', '', '仅写独立活动事实']
    ],
    userVisibleWallClockColumnIndexes: [6, 7],
    textColumnIndexes: [0, 1, 6, 7, 8, 12, 13, 14],
    textColumnDataRowLimit: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows
  },
  [CARBON_EMISSION_REPORT_TEMPLATE_TYPE]: {
    type: CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
    name: '碳排放报告导入模板',
    baseFileName: '碳排放报告导入模板',
    asciiBaseFileName: 'carbon-emission-report',
    sheetName: CARBON_EMISSION_REPORT_SHEETS[0].name,
    route: '/api/templates/carbon-emission-report.xlsx',
    csvRoute: null,
    recommendedFormat: 'xlsx',
    appliesTo: ['碳核算', '碳排放报告'],
    contractRoute: 'POST /api/carbon/emission-reports/imports/preview -> POST /api/carbon/emission-reports/imports/execute',
    description: '固定结构化 Excel v1 碳排放报告模板；五张可见工作表的名称、顺序和中文表头必须完全一致。报告编码禁止重复，项目、汇总和证据必须自洽；导入仅写报告领域和统一审计，不创建或修改活动、核算运行、核算结果、旧碳排放或碳因子。',
    headers: [...CARBON_EMISSION_REPORT_SHEETS[0].headers],
    rows: [],
    sheets: [
      {
        name: '报告信息',
        headers: [...CARBON_EMISSION_REPORT_SHEETS[0].headers],
        rows: [['CER-2026-0001', '天坤集团 2026 年度碳排放报告', '天坤集团', '2026-01-01', '2026-12-31', CARBON_EMISSION_REPORT_TEMPLATE_TYPE, CARBON_EMISSION_REPORT_TEMPLATE_VERSION, '示例报告，只写报告事实']],
        textColumnIndexes: [0, 3, 4, 5, 6, 7],
        textColumnDataRowLimit: 1
      },
      {
        name: '组织与核算边界',
        headers: [...CARBON_EMISSION_REPORT_SHEETS[1].headers],
        rows: [['组织边界', '天坤集团全部受控生产与辅助设施', '按运营控制法确定组织边界'], ['核算边界', '范围一、范围二及已识别范围三排放', '报告期间内纳入核算的排放源']],
        textColumnIndexes: [0, 1, 2],
        textColumnDataRowLimit: 2
      },
      {
        name: '报告项目',
        headers: [...CARBON_EMISSION_REPORT_SHEETS[2].headers],
        rows: [['ITEM-001', '范围二', '购入电力', '电力', '12000', 'kWh', '0.00057', 'tCO2e/kWh', '6.84', 'tCO2e', 'EVID-001', '排放量为已冻结报告事实'], ['ITEM-002', '范围一', '固定燃烧', '天然气', '500', 'm3', '0.0021622', 'tCO2e/m3', '1.0811', 'tCO2e', 'EVID-002', '导入不重新计算']],
        textColumnIndexes: [0, 1, 2, 3, 5, 7, 9, 10, 11],
        textColumnDataRowLimit: CARBON_EMISSION_REPORT_SHEETS[2].maxDataRows
      },
      {
        name: '汇总',
        headers: [...CARBON_EMISSION_REPORT_SHEETS[3].headers],
        rows: [['TOTAL-001', '总计', '全部', '7.9211', 'tCO2e', '必须等于全部报告项目排放量之和'], ['SCOPE-001', '排放范围', '范围一', '1.0811', 'tCO2e', '可选分范围汇总'], ['SCOPE-002', '排放范围', '范围二', '6.84', 'tCO2e', '可选分范围汇总']],
        textColumnIndexes: [0, 1, 2, 4, 5],
        textColumnDataRowLimit: CARBON_EMISSION_REPORT_SHEETS[3].maxDataRows
      },
      {
        name: '证据说明',
        headers: [...CARBON_EMISSION_REPORT_SHEETS[4].headers],
        rows: [['EVID-001', '电力结算与计量汇总', '计量记录', '报告期间电力结算单和计量汇总说明', '项目必须引用已存在证据编号'], ['EVID-002', '天然气结算与计量汇总', '原始凭证', '报告期间天然气结算单和计量汇总说明', '证据只保存结构化说明，不上传附件']],
        textColumnIndexes: [0, 1, 2, 3, 4],
        textColumnDataRowLimit: CARBON_EMISSION_REPORT_SHEETS[4].maxDataRows
      }
    ],
    maxWorkbookTextCharacters: CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters
  },
  [GHG_REPORT_TEMPLATE_TYPE]: {
    type: GHG_REPORT_TEMPLATE_TYPE,
    name: '温室气体报告导入模板',
    baseFileName: '温室气体报告导入模板',
    asciiBaseFileName: 'ghg-report',
    sheetName: GHG_REPORT_SHEETS[0].name,
    route: '/api/templates/ghg-report.xlsx',
    csvRoute: null,
    recommendedFormat: 'xlsx',
    appliesTo: ['碳核算', '温室气体报告'],
    contractRoute: 'POST /api/carbon/ghg-reports/imports/preview -> POST /api/carbon/ghg-reports/imports/execute',
    description: '固定结构化 Excel v1 温室气体报告模板；六张可见工作表的名称、顺序和中文表头必须完全一致。排放与清除通过 record_type 显式区分，报告编码禁止重复；导入仅写 N7 报告事实和统一审计，不写 N6 报告、活动、核算运行、核算结果、旧排放或碳因子。',
    headers: [...GHG_REPORT_SHEETS[0].headers],
    rows: [],
    sheets: [
      {
        name: '报告信息',
        headers: [...GHG_REPORT_SHEETS[0].headers],
        rows: [['GHG-2026-0001', '天坤集团 2026 年度温室气体报告', '天坤集团', '2026-01-01', '2026-12-31', GHG_REPORT_TEMPLATE_TYPE, GHG_REPORT_TEMPLATE_VERSION, '示例报告，只写 N7 报告事实']],
        textColumnIndexes: [0, 3, 4, 5, 6, 7],
        textColumnDataRowLimit: 1
      },
      {
        name: '组织边界',
        headers: [...GHG_REPORT_SHEETS[1].headers],
        rows: [['ORG-001', '天坤集团全部受控生产与辅助设施', '运营控制法', '报告期间内由报告组织运营控制的设施']],
        textColumnIndexes: [0, 1, 2, 3],
        textColumnDataRowLimit: GHG_REPORT_SHEETS[1].maxDataRows
      },
      {
        name: '运行边界',
        headers: [...GHG_REPORT_SHEETS[2].headers],
        rows: [['范围一', '固定燃烧', '天然气锅炉直接排放及相关清除事实'], ['范围二', '购入电力', '购入电力产生的间接排放']],
        textColumnIndexes: [0, 1, 2],
        textColumnDataRowLimit: GHG_REPORT_SHEETS[2].maxDataRows
      },
      {
        name: '报告项目',
        headers: [...GHG_REPORT_SHEETS[3].headers],
        rows: [
          ['GHG-ITEM-001', '排放', '范围二', '购入电力', 'CO2', '购入电力', 12000, 'kWh', 6.84, 1, 6.84, 'tCO2e', '购入电力活动数据法', 'GHG-EVID-001', '排放事实示例'],
          ['GHG-ITEM-002', '清除', '范围一', '固定燃烧', 'CO2', '园区碳汇', 10, 'tCO2', 0.5, 1, 0.5, 'tCO2e', '碳汇监测法', 'GHG-EVID-002', '清除量保持非负并由记录类型表达']
        ],
        textColumnIndexes: [0, 1, 2, 3, 4, 5, 7, 11, 12, 13, 14],
        textColumnDataRowLimit: GHG_REPORT_SHEETS[3].maxDataRows
      },
      {
        name: '汇总',
        headers: [...GHG_REPORT_SHEETS[4].headers],
        rows: [
          ['GHG-TOTAL-001', '总计', '全部', 6.84, 0.5, 6.34, 'tCO2e', '净 CO2e 等于排放减清除'],
          ['GHG-TYPE-001', '记录类型', '排放', 6.84, 0, 6.84, 'tCO2e', '排放汇总'],
          ['GHG-TYPE-002', '记录类型', '清除', 0, 0.5, -0.5, 'tCO2e', '清除汇总']
        ],
        textColumnIndexes: [0, 1, 2, 6, 7],
        textColumnDataRowLimit: GHG_REPORT_SHEETS[4].maxDataRows
      },
      {
        name: '证据说明',
        headers: [...GHG_REPORT_SHEETS[5].headers],
        rows: [['GHG-EVID-001', '电力结算与计量汇总', '计量记录', '报告期间电力结算单和计量汇总说明', '项目必须引用已存在证据编号'], ['GHG-EVID-002', '园区碳汇监测记录', '监测记录', '报告期间清除量监测说明', '证据只保存结构化说明，不上传附件']],
        textColumnIndexes: [0, 1, 2, 3, 4],
        textColumnDataRowLimit: GHG_REPORT_SHEETS[5].maxDataRows
      }
    ],
    maxWorkbookTextCharacters: GHG_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters
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
      ['电力趋势预测草稿', '导入后可编辑，运行时由服务端读取已入库能耗', 'electricity', 'QL-PARK', 'QL-M-ELEC-PARK', '', '2026-01', '2026-03', '2026-04', '2026-06', 'moving_average', '3', 'draft']
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
    description: '预测历史数据复用能耗记录导入结构；用能单元编码必填，计量器具编码可选且必须匹配台账。导入后在预测管理中选择训练月份。',
    headers: ['月份', '能源类型编码', '用量', '单位', '用能单元编码', '计量器具编码', '备注'],
    rows: [
      ['2026-01', 'electricity', '1000', 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史第 1 月'],
      ['2026-02', 'electricity', '1100', 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史第 2 月'],
      ['2026-03', 'electricity', '1200', 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '移动平均至少需要 3 个历史月份']
    ]
  }
};

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function renderCsv(headers, rows, options = {}) {
  const visibleRows = formatHistoricalTemplateRowsForUser(options, rows);
  const lines = [headers, ...visibleRows].map((row) => row.map(escapeCsvCell).join(','));
  return `${UTF8_BOM}${lines.join('\n')}\n`;
}

function buildColumnWidths(headers, rows) {
  return headers.map((header, index) => {
    const maxLength = [header, ...rows.map((row) => row[index])]
      .reduce((max, value) => Math.max(max, String(value ?? '').length), 0);
    return { wch: Math.min(Math.max(maxLength + 4, 12), 36) };
  });
}

/** 按模板显式列语义格式化用户可见来源墙钟单元格。 */
function formatHistoricalTemplateRowsForUser(sheetDefinition, rows) {
  // 未声明墙钟列的历史模板保持原矩阵，避免日期、月份和普通文本被误转。
  const wallClockColumnIndexes = new Set(sheetDefinition.userVisibleWallClockColumnIndexes || []);
  return rows.map((row) => row.map((value, columnIndex) => {
    if (!wallClockColumnIndexes.has(columnIndex) || value === null || value === undefined || value === '') {
      return value;
    }
    return formatWallClockMinuteForUser(normalizeUserVisibleWallClockMinuteInput(value));
  }));
}

function renderXlsxBuffer(template) {
  const workbook = XLSX.utils.book_new();
  const sheetDefinitions = Array.isArray(template.sheets) && template.sheets.length > 0
    ? template.sheets
    : [{
        name: template.sheetName,
        headers: template.headers,
        rows: template.rows,
        userVisibleWallClockColumnIndexes: template.userVisibleWallClockColumnIndexes,
        textColumnIndexes: template.textColumnIndexes,
        textColumnDataRowLimit: template.textColumnDataRowLimit
      }];
  sheetDefinitions.forEach((sheetDefinition) => {
    const headers = sheetDefinition.headers || [];
    const rows = sheetDefinition.rows || [];
    const visibleRows = formatHistoricalTemplateRowsForUser(sheetDefinition, rows);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...visibleRows]);
    // 指定文本列从第 2 行预格式到领域最大数据行，避免 Excel/WPS 将编码或长文本数值化。
    (sheetDefinition.textColumnIndexes || []).forEach((columnIndex) => {
      const dataRowLimit = Number.isSafeInteger(sheetDefinition.textColumnDataRowLimit)
        ? sheetDefinition.textColumnDataRowLimit
        : rows.length;
      for (let dataRowIndex = 0; dataRowIndex < dataRowLimit; dataRowIndex += 1) {
        const address = XLSX.utils.encode_cell({ r: dataRowIndex + 1, c: columnIndex });
        const value = String(visibleRows[dataRowIndex]?.[columnIndex] ?? '');
        worksheet[address] = {
          ...(worksheet[address] || {}),
          t: 's',
          v: value,
          w: value,
          z: '@'
        };
      }
      const worksheetRange = XLSX.utils.decode_range(worksheet['!ref']);
      worksheetRange.e.r = Math.max(worksheetRange.e.r, dataRowLimit);
      worksheetRange.e.c = Math.max(worksheetRange.e.c, columnIndex);
      worksheet['!ref'] = XLSX.utils.encode_range(worksheetRange);
    });
    worksheet['!cols'] = buildColumnWidths(headers, visibleRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, String(sheetDefinition.name || ''));
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
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
    templateVersion: definition.templateVersion || null,
    sheetName: definition.sheetName,
    route: xlsxRoute,
    csvRoute,
    recommendedFormat: 'xlsx',
    formats: [...definition.formats],
    appliesTo: ['能源分析'],
    contractRoute: ENERGY_ANALYSIS_TEMPLATE_CONTRACT_ROUTES[definition.id] || null,
    requiredPermission: TEMPLATE_REQUIRED_PERMISSIONS[definition.id] || null,
    description: ENERGY_ANALYSIS_TEMPLATE_CONTRACT_ROUTES[definition.id]
      ? `用于按冻结字段和工作表契约预演并受控导入${definition.name.replace(/导入模板$/, '')}。`
      : `用于建立${definition.name}的冻结下载契约；本节点不开放该领域的预演或执行写入接口。`,
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
    requiredPermission: TEMPLATE_REQUIRED_PERMISSIONS[template.type] || null,
    formats: template.csvRoute ? ['xlsx', 'csv'] : ['xlsx'],
    sheetNames: Array.isArray(template.sheets) ? template.sheets.map((sheet) => sheet.name) : [template.sheetName],
    sheets: Array.isArray(template.sheets)
      ? template.sheets.map((sheet) => ({ name: sheet.name, headers: [...sheet.headers] }))
      : [{ name: template.sheetName, headers: [...template.headers] }],
    headers: template.headers
  }));
  const energyAnalysisTemplates = listEnergyAnalysisTemplates().map((listedTemplate) => {
    const template = buildEnergyAnalysisTemplateDefinition(listedTemplate.id);
    return {
      type: template.type,
      name: template.name,
      templateVersion: template.templateVersion,
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
      requiredPermission: template.requiredPermission,
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
  if (!template.csvRoute) {
    if ([CARBON_ACTIVITY_TEMPLATE_TYPE, CARBON_EMISSION_REPORT_TEMPLATE_TYPE, GHG_REPORT_TEMPLATE_TYPE].includes(template.type)) {
      const templateName = template.type === CARBON_ACTIVITY_TEMPLATE_TYPE
        ? '独立碳活动'
        : (template.type === CARBON_EMISSION_REPORT_TEMPLATE_TYPE ? '碳排放报告' : '温室气体报告');
      throw new AppError('TEMPLATE_FORMAT_UNSUPPORTED', `${templateName}固定模板仅支持 XLSX。`, {
        statusCode: 400,
        details: { templateId: template.type, format: 'csv', supportedFormats: ['xlsx'] }
      });
    }
    return null;
  }
  return {
    template,
    fileName: getFileName(template, 'csv'),
    csv: renderCsv(template.headers, template.rows, template)
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
  ENERGY_ANALYSIS_TEMPLATE_CONTRACT_ROUTES,
  TEMPLATE_REQUIRED_PERMISSIONS,
  getTemplateCsv,
  getTemplateDefinition,
  getTemplateXlsx,
  listTemplates,
  renderCsv,
  renderXlsxBuffer,
  UTF8_BOM
};
