'use strict';

const crypto = require('crypto');
const { AppError } = require('../utils/errors');
const {
  getTemplateDefinition,
  renderCsv,
  renderXlsxBuffer
} = require('./templateService');
const { generateEnergyAnalysisTemplate } = require('./energyAnalysisTemplateService');
const {
  getDemoArtifactRegistration,
  listDemoArtifactRegistrations
} = require('./demoArtifactRegistry');

// Dataset 身份与版本固定进入 run/context 契约，治理语义变化时必须提升 manifest version。
const DEMO_DATASET_ID = 'qinglan-park-v1';
const DEMO_MANIFEST_VERSION = '1.4.0';
const DEMO_CANONICALIZATION_VERSION = 'canonical-json-v1';
// 天坤集团演示数据统一采用稳定业务前缀，不使用数据库自增 ID。
const DEMO_PARK_CODE_PREFIX = 'QL-';
// 演示数据的来源时区统一显式声明为 IANA 时区。
const DEMO_PARK_SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 目标路由只允许使用前端 componentMap 与内置 RBAC 菜单共同登记的真实页面入口。
const DEMO_PARK_TRUSTED_TARGET_ROUTES = new Set([
  '/imports',
  '/energy/analysis',
  '/energy/balances',
  '/energy/benchmarks',
  '/energy/budgets',
  '/energy/flows',
  '/ledger/generation',
  '/ledger/meter-readings',
  '/ledger/meters',
  '/ledger/organization',
  '/ledger/production-output',
  '/ledger/production-units',
  '/ledger/suppliers',
  '/carbon',
  '/predictions'
]);
// 目标路由必须是无查询、无片段、无反斜杠的站内绝对 path-only 值。
const DEMO_PARK_INTERNAL_ROUTE_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
// N6/N7 必须复用正式多工作表模板渲染器，不能进入能源分析专用生成器。
const FORMAL_MULTI_SHEET_TEMPLATE_TYPES = new Set(['carbon-emission-report', 'ghg-report']);

/** 冻结单个演示数据条目，避免调用方修改依赖和数据行。 */
function createArtifact(definition) {
  const rows = Array.isArray(definition.rows)
    ? Object.freeze(definition.rows.map((row) => Object.freeze([...row])))
    : null;
  const workbooks = definition.workbooks
    ? Object.freeze(Object.fromEntries(Object.entries(definition.workbooks).map(([sheetName, sheetRows]) => [
      sheetName,
      Object.freeze(sheetRows.map((row) => Object.freeze([...row])))
    ])))
    : null;
  return Object.freeze({
    ...definition,
    dependencies: Object.freeze([...(definition.dependencies || [])]),
    formats: Object.freeze([...(definition.formats || ['xlsx', 'csv'])]),
    coveredTemplateTypes: Object.freeze([...(definition.coveredTemplateTypes || [definition.templateType])]),
    rows,
    workbooks
  });
}

// 天坤集团固定下载顺序同时表达父子台账、配置、时序和计算模型依赖。
const DEMO_PARK_ARTIFACTS = Object.freeze([
  createArtifact({ artifactKey: '01-organization-root', order: 1, name: '用能单元根级', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', targetRoute: '/ledger/organization', postAction: '导入并确认根级园区组织已启用。', dependencies: [], rows: [['QL-PARK', '天坤集团', '', '', 'enterprise', 86000, 10, 'active', '天坤集团演示根级']] }),
  createArtifact({ artifactKey: '02-organization-departments', order: 2, name: '用能单元部门与车间', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', targetRoute: '/ledger/organization', postAction: '导入后核对父级路径和启用状态。', dependencies: ['01-organization-root'], rows: [
    ['QL-ENERGY', '能源管理部', 'QL-PARK', '天坤集团', 'department', 1800, 20, 'active', '能源管理部门'],
    ['QL-WORKSHOP-A', '精密制造一车间', 'QL-PARK', '天坤集团', 'workshop', 26000, 30, 'active', '主要生产车间'],
    ['QL-WORKSHOP-B', '装配二车间', 'QL-PARK', '天坤集团', 'workshop', 22000, 40, 'active', '装配生产车间'],
    ['QL-UTILITY', '公辅动力站', 'QL-PARK', '天坤集团', 'workshop', 6500, 50, 'active', '空压与能源站']
  ] }),
  createArtifact({ artifactKey: '03-organization-process-equipment', order: 3, name: '用能单元工序与设备', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', targetRoute: '/ledger/organization', postAction: '导入后核对工序和设备均挂接到已存在车间。', dependencies: ['02-organization-departments'], rows: [
    ['QL-PROC-MACHINING', '机加工工序', 'QL-WORKSHOP-A', '精密制造一车间', 'process', 8000, 110, 'active', '重点耗能工序'],
    ['QL-EQ-CNC-01', '数控加工中心01', 'QL-WORKSHOP-A', '精密制造一车间', 'equipment', 120, 111, 'active', '设备状态演示对象'],
    ['QL-PROC-ASSEMBLY', '总装工序', 'QL-WORKSHOP-B', '装配二车间', 'process', 7200, 120, 'active', '装配工序'],
    ['QL-EQ-AIR-01', '空压机01', 'QL-UTILITY', '公辅动力站', 'equipment', 180, 130, 'active', '公辅设备']
  ] }),
  createArtifact({ artifactKey: '04-meters', order: 4, name: '计量器具', templateType: 'meters', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:meters:import', targetPage: '基础台账/计量器具', targetRoute: '/ledger/meters', postAction: '导入后确认能源类型与所属用能单元匹配。', dependencies: ['03-organization-process-equipment'], rows: [
    ['QL-M-ELEC-PARK', '园区总进线电表', 'electricity', 'electricity', 'QL-PARK', '天坤集团', 'online', 'QL-GW-01', 1, 1, 'input', '总配电室', 'active', '园区总表'],
    ['QL-M-ELEC-CNC01', '数控中心电表', 'electricity', 'electricity', 'QL-EQ-CNC-01', '数控加工中心01', 'online', 'QL-GW-02', 1, 1, 'input', '一车间配电柜', 'active', '设备分表'],
    ['QL-M-GAS-UTILITY', '动力站天然气表', 'natural_gas', 'natural_gas', 'QL-UTILITY', '公辅动力站', 'online', 'QL-GW-03', 1, 1, 'input', '动力站', 'active', '天然气计量']
  ] }),
  createArtifact({ artifactKey: '05-production-units', order: 5, name: '产能单元', templateType: 'production-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:production:import', targetPage: '基础台账/产能单元', targetRoute: '/ledger/production-units', postAction: '预演并导入，确认产能单元关联启用的用能单元。', dependencies: ['03-organization-process-equipment'], rows: [
    ['QL-PU-PRECISION', '精密零件产能单元', 'QL-WORKSHOP-A', '精密零件', 't', '一车间产品产量', 'active'],
    ['QL-PU-ASSEMBLY', '成套设备产能单元', 'QL-WORKSHOP-B', '成套设备', '台', '二车间产品产量', 'active']
  ] }),
  createArtifact({ artifactKey: '06-production-outputs', order: 6, name: '月度产量', templateType: 'production-outputs', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:production:preview', targetPage: '基础台账/月度产量', targetRoute: '/ledger/production-output', postAction: '预演并导入后核对精密零件 2026-06 至 2026-08 连续产量及装配产量。', dependencies: ['05-production-units'], rows: [
    ['QL-PU-PRECISION', '精密零件产能单元', '2026-06', 1180, 't', 'upload', '天坤集团演示产量'],
    ['QL-PU-PRECISION', '精密零件产能单元', '2026-07', 1250, 't', 'upload', '天坤集团演示产量'],
    ['QL-PU-PRECISION', '精密零件产能单元', '2026-08', 1320, 't', 'upload', '天坤集团演示产量'],
    ['QL-PU-ASSEMBLY', '成套设备产能单元', '2026-07', 86, '台', 'upload', '天坤集团演示产量']
  ] }),
  createArtifact({ artifactKey: '07-monthly-energy', order: 7, name: '月度能耗与预测历史', templateType: 'energy-records', coveredTemplateTypes: ['energy-records', 'prediction-history'], formats: ['xlsx', 'csv'], requiredPermission: 'imports:create', targetPage: '能耗管理/能耗数据导入', targetRoute: '/imports', postAction: '创建导入批次；2026-01 至 2026-07 园区电力仅作为预测历史，2026-08 园区电力结算实际绑定 QL-M-ELEC-PARK，直接用于预算和强度分析；artifact 08 同表抄表预演遇同月同表直接事实时受控 conflict 跳过，conflict 为正常受控跳过，不视为错误。', dependencies: ['03-organization-process-equipment', '04-meters'], rows: [
    ['2026-01', 'electricity', 368000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-02', 'electricity', 376000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-03', 'electricity', 389000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-04', 'electricity', 401000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-05', 'electricity', 410000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-06', 'electricity', 420000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '预测训练历史'],
    ['2026-07', 'electricity', 445000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '平衡与预测历史'],
    ['2026-07', 'natural_gas', 18600, 'm3', 'QL-UTILITY', 'QL-M-GAS-UTILITY', '动力站天然气'],
    ['2026-08', 'electricity', 458000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK', '园区电费结算实际；与 artifact 08 园区总表抄表用量一致，不由抄表自动派生'],
    ['2026-08', 'natural_gas', 19300, 'm3', 'QL-UTILITY', 'QL-M-GAS-UTILITY', '动力站天然气结算实际'],
    ['2026-08', 'electricity', 138000, 'kWh', 'QL-WORKSHOP-A', '', '一车间结算实际；用于单位产品能耗']
  ] }),
  createArtifact({ artifactKey: '08-meter-readings-2026-08', order: 8, name: '2026-08 抄表演示', templateType: 'meter-readings', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:readings:import', targetPage: '基础台账/计量抄表', targetRoute: '/ledger/meter-readings', postAction: '导入后仅形成抄表记录；QL-M-ELEC-PARK 园区总表用量与 artifact 07 同月同表直接结算事实一致，受控生成预演应以 conflict 正常跳过且不视为错误；CNC 分表仍应形成 wouldGenerate 候选，不自动写入能耗记录。', dependencies: ['04-meters'], rows: [
    ['2026-08-01', 'QL-M-ELEC-PARK', '园区总进线电表', 1250000, 1708000, 1, '', 'kWh', '天坤集团', '458000 kWh 与直接结算实际一致；受控生成预演应 conflict 跳过，不自动进入月度能耗'],
    ['2026-08-01', 'QL-M-ELEC-CNC01', '数控中心电表', 320000, 412500, 1, '', 'kWh', '数控加工中心01', '设备分表；不自动进入月度能耗']
  ] }),
  createArtifact({ artifactKey: '09-generation-records', order: 9, name: '发电自用', templateType: 'generation-records', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:generation:preview', targetPage: '基础台账/发电自用', targetRoute: '/ledger/generation', postAction: '预演并导入；发电记录不自动写入能耗记录。', dependencies: ['01-organization-root'], rows: [['QL-PARK', '天坤集团', '2026-07', 68000, 54000, 14000, 'upload', '园区屋顶光伏']] }),
  createArtifact({ artifactKey: '10-energy-budgets', order: 10, name: '用能预算', templateType: 'energy-budgets', formats: ['xlsx', 'csv'], requiredPermission: 'energy:budget:import', targetPage: '能耗管理/用能预算', targetRoute: '/energy/budgets', postAction: '预演并导入后查看预算与实际对比。', dependencies: ['01-organization-root'], rows: [['2026-08', 'electricity', '天坤集团', 470000, 'kWh', '天坤集团月度电力预算', 'active'], ['2026-08', 'natural_gas', '公辅动力站', 20000, 'm3', '动力站天然气预算', 'active']] }),
  createArtifact({ artifactKey: '11-carbon-factors', order: 11, name: '碳因子', templateType: 'carbon-factors', formats: ['xlsx', 'csv'], requiredPermission: 'carbon:factor:import', targetPage: '碳核算/碳因子', targetRoute: '/carbon', postAction: '预演并导入后再执行碳核算。', dependencies: [], rows: [['electricity', 'default', 2026, 'kWh', 0.5703, 'kgCO2e', '天坤集团演示因子', '', '2026-01-01', '2026-12-31', 'active'], ['natural_gas', 'default', 2026, 'm3', 2.1622, 'kgCO2e', '天坤集团演示因子', '', '2026-01-01', '2026-12-31', 'active']] }),
  createArtifact({ artifactKey: '12-prediction-configs', order: 12, name: '预测配置', templateType: 'prediction-configs', formats: ['xlsx', 'csv'], requiredPermission: 'prediction:config:import', targetPage: '预测管理', targetRoute: '/predictions', postAction: '导入为草稿；来源批次 ID 必须在实际导入 07 后按真实批次关系填写，不得假设固定自增值。', dependencies: ['07-monthly-energy'], rows: [['天坤集团电力趋势预测', '基于已入库月度电耗', 'electricity', 'QL-PARK', 'QL-M-ELEC-PARK', '', '2026-01', '2026-07', '2026-08', '2026-10', 'moving_average', 3, 'draft']] }),
  createArtifact({ artifactKey: '13-shift-definitions', order: 13, name: '班次定义', templateType: 'shift-definitions', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/配置', targetRoute: '/energy/analysis', postAction: '预演并执行后核对班次版本和启用状态。', dependencies: [], rows: [
    ['QL-SHIFT-DAY', '天坤集团白班', 480, 1200, 0, DEMO_PARK_SOURCE_TIME_ZONE, '天坤集团排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active'],
    ['QL-SHIFT-NIGHT', '天坤集团夜班', 1200, 480, 1, DEMO_PARK_SOURCE_TIME_ZONE, '天坤集团排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active']
  ] }),
  createArtifact({ artifactKey: '14-shift-schedules', order: 14, name: '排班计划', templateType: 'shift-schedules', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:operations:preview', targetPage: '能源消费分析/运营记录', targetRoute: '/energy/analysis', postAction: '预演并导入，核对排班与 CNC 表计所属设备组织及严格 UTC 窗口一致。', dependencies: ['03-organization-process-equipment', '13-shift-definitions'], rows: [['QL-SHIFT-DAY', '天坤集团白班', 480, 1200, 0, DEMO_PARK_SOURCE_TIME_ZONE, '天坤集团排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'QL-EQ-CNC-01', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 'QL:shift:20260801:day', 'upload', 'active']] }),
  createArtifact({ artifactKey: '15-energy-timeseries', order: 15, name: '能耗时序', templateType: 'energy-timeseries', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:timeseries:preview', targetPage: '能源消费分析/时序导入', targetRoute: '/energy/analysis', postAction: '预演并导入 2026-08-01T00:00:00Z 至 04:00:00Z 连续 15 分钟数据后执行负荷、TOU、排班、状态和策略分析。', dependencies: ['04-meters'], rows: [
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:00:00Z', '2026-08-01T00:15:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 320, 'QL:timeseries:cnc01:001', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:15:00Z', '2026-08-01T00:30:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 345, 'QL:timeseries:cnc01:002', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:30:00Z', '2026-08-01T00:45:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 310, 'QL:timeseries:cnc01:003', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:45:00Z', '2026-08-01T01:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 295, 'QL:timeseries:cnc01:004', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T01:00:00Z', '2026-08-01T01:15:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 280, 'QL:timeseries:cnc01:005', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T01:15:00Z', '2026-08-01T01:30:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 305, 'QL:timeseries:cnc01:006', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T01:30:00Z', '2026-08-01T01:45:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 330, 'QL:timeseries:cnc01:007', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T01:45:00Z', '2026-08-01T02:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 360, 'QL:timeseries:cnc01:008', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T02:00:00Z', '2026-08-01T02:15:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 390, 'QL:timeseries:cnc01:009', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T02:15:00Z', '2026-08-01T02:30:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 410, 'QL:timeseries:cnc01:010', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T02:30:00Z', '2026-08-01T02:45:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 385, 'QL:timeseries:cnc01:011', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T02:45:00Z', '2026-08-01T03:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 350, 'QL:timeseries:cnc01:012', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T03:00:00Z', '2026-08-01T03:15:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 325, 'QL:timeseries:cnc01:013', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T03:15:00Z', '2026-08-01T03:30:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 300, 'QL:timeseries:cnc01:014', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T03:30:00Z', '2026-08-01T03:45:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 275, 'QL:timeseries:cnc01:015', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T03:45:00Z', '2026-08-01T04:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 290, 'QL:timeseries:cnc01:016', 'upload']
  ] }),
  createArtifact({ artifactKey: '16-device-states', order: 16, name: '设备状态', templateType: 'device-states', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:operations:preview', targetPage: '能源消费分析/运营记录', targetRoute: '/energy/analysis', postAction: '预演并导入后与时序数据联查。', dependencies: ['03-organization-process-equipment', '04-meters'], rows: [['QL-M-ELEC-CNC01', 'QL-EQ-CNC-01', 'running', '2026-08-01T00:00:00Z', '2026-08-01T04:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL:device-state:cnc01:001', 'upload']] }),
  createArtifact({ artifactKey: '17-tou-schemes', order: 17, name: 'TOU 方案与时段', templateType: 'tou-schemes', formats: ['xlsx'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/峰谷配置', targetRoute: '/energy/analysis', postAction: '预演并执行后核对方案版本；每天规则须完整覆盖 0 至 1440。', dependencies: [], workbooks: {
    TOU方案: [['QL-TOU-2026', '天坤集团峰平谷方案', DEMO_PARK_SOURCE_TIME_ZONE, '天坤集团用电制度', 'QL-TOU-2026-01', 'QL-TOU:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active']],
    时段规则: Array.from({ length: 7 }, (_value, dayIndex) => [
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'valley', 0, 480],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'flat', 480, 1020],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'peak', 1020, 1320],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'valley', 1320, 1440]
    ]).flat()
  } }),
  createArtifact({ artifactKey: '18-strategy-rules', order: 18, name: '策略规则', templateType: 'strategy-rules', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/策略配置', targetRoute: '/energy/analysis', postAction: '预演并执行后核对规则版本；导入只保存需人工复核的受控规则。', dependencies: [], rows: [['QL-STRATEGY-PEAK', '峰段能耗偏高提醒', 'strategy-rule:v1', 'load-analysis:v1', 'peak_interval_energy', 'gt', 300, '', '', 'kWh/15min', 0.08, 'high', 0.95, 10, 'window_total_energy', '建议复核峰段设备错峰安排。', '天坤集团能源制度', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '19-conversion-factors', order: 19, name: '能源折标系数', templateType: 'energy-conversion-factors', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/折标系数', targetRoute: '/energy/benchmarks', postAction: '预演并导入后用于统一折标。', dependencies: [], rows: [['QL-FACTOR-ELEC-2026', 'electricity', 'kWh', 0.1229, 'kgce', 'tce', 1000, '天坤集团能源制度', 'QL-ENERGY-2026', 'electricity-factor:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '20-benchmark-definitions', order: 20, name: '对标定义', templateType: 'energy-benchmark-definitions', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/定义', targetRoute: '/energy/benchmarks', postAction: '预演并导入后再导入对应目标。', dependencies: ['03-organization-process-equipment'], rows: [['QL-BENCH-INTENSITY', '精密零件单位产品综合能耗', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month', 'organization', 'QL-WORKSHOP-A', 'lower_better', '天坤集团能源管理目标', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '21-benchmark-targets', order: 21, name: '对标目标', templateType: 'energy-benchmark-targets', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/目标', targetRoute: '/energy/benchmarks', postAction: '预演并导入后执行对标分析。', dependencies: ['20-benchmark-definitions'], rows: [['QL-BENCH-INTENSITY', 128, '', '', '', '', '', '', '', '', '', 0, 0, 'active']] }),
  createArtifact({ artifactKey: '22-energy-flow-models', order: 22, name: '能流模型', templateType: 'energy-flow-models', formats: ['xlsx', 'csv'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/模型', targetRoute: '/energy/flows', postAction: '预演并导入能流模型；导入后不自动执行能流分析。', dependencies: [], rows: [['QL-FLOW-PARK', '天坤集团综合能流模型', '天坤集团能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '23-energy-flow-nodes', order: 23, name: '能流节点', templateType: 'energy-flow-nodes', formats: ['xlsx', 'csv'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/节点', targetRoute: '/energy/flows', postAction: '预演并导入后核对节点坐标和组织关联。', dependencies: ['22-energy-flow-models', '03-organization-process-equipment'], rows: [
    ['QL-FLOW-PARK', '天坤集团综合能流模型', '天坤集团能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL-NODE-GRID', '电网输入', 'source', 'QL-PARK', 80, 120, 'active'],
    ['QL-FLOW-PARK', '天坤集团综合能流模型', '天坤集团能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL-NODE-WSA', '一车间负荷', 'sink', 'QL-WORKSHOP-A', 360, 120, 'active']
  ] }),
  createArtifact({ artifactKey: '24-energy-flow-edges', order: 24, name: '能流边与显式边值', templateType: 'energy-flow-edges', formats: ['xlsx'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/边', targetRoute: '/energy/flows', postAction: '预演并导入后执行能流分析。', dependencies: ['23-energy-flow-nodes'], workbooks: {
    能流边: [['QL-FLOW-PARK', 'QL-FLOW:v1', 'QL-EDGE-GRID-WSA', 'QL-NODE-GRID', 'QL-NODE-WSA', 'electricity', 'kWh', 'explicit_edge_value', 'QL:explicit-edge:grid-wsa', 'active']],
    显式边值: [['QL-FLOW-PARK', 'QL-FLOW:v1', 'QL-EDGE-GRID-WSA', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'kWh', 445000, 'QL:explicit-edge-value:grid-wsa:202607', 'energy-flow:v1', 'active']]
  } }),
  createArtifact({ artifactKey: '25-energy-balance-configs', order: 25, name: '平衡边界与九角色项目', templateType: 'energy-balance-configs', formats: ['xlsx'], requiredPermission: 'energy:balance:import:preview', targetPage: '能效平衡与优化/配置', targetRoute: '/energy/balances', postAction: '预演并导入平衡配置；导入后不自动计算，请手工发起平衡快照计算。', dependencies: ['07-monthly-energy', '09-generation-records', '24-energy-flow-edges'], workbooks: {
    平衡边界: [['QL-BAL-PARK', '天坤集团综合能效平衡边界', 'QL-PARK', '天坤集团能源审计', 'QL-BAL-2026-01', 'QL-BAL:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 1, 'active']],
    九角色项目: [
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-INPUT-E', '园区外购电输入', 'input', 'electricity', 'kWh', 'monthly_energy', 'QL:monthly-energy:park:electricity', 'organization=QL-PARK;month=2026-07', '', '', '', '', 'active'],
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-GEN-E', '园区光伏自用', 'self_generation', 'electricity', 'kWh', 'generation', 'QL:generation:park:2026-07', 'organization=QL-PARK;month=2026-07', '', 'self_use_value_kwh', '', 'QL-GEN-PARK-202607', 'active'],
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-USE-E', '园区有用能', 'useful_utilization', 'electricity', 'kWh', 'explicit_balance_value', 'QL:balance:useful-electricity', '', '', '', 470000, '', 'active']
    ]
  } }),
  createArtifact({ artifactKey: '26-suppliers', order: 26, name: '供应商台账', templateType: 'suppliers', formats: ['xlsx'], requiredPermission: 'ledger:suppliers:import:preview', targetPage: '基础台账/供应商管理', targetRoute: '/ledger/suppliers', postAction: '预演并受控导入供应商台账；该文件走正式无状态导入，不登记演示 ownership，也不声明自动清理。', dependencies: [], rows: [
    ['QL-SUP-ELECTRIC', '天坤集团电力运维供应商', '天坤市产业路 8 号', '周工', '010-66001234', '园区供配电与计量服务', '合作中'],
    ['QL-SUP-GAS', '天坤集团燃气服务商', '天坤市能源大道 16 号', '陈经理', '+86 138-0000-2602', '动力站天然气供应与结算', '合作中'],
    ['QL-SUP-LEGACY', '天坤集团历史备件供应商', '天坤市仓储路 3 号', '赵经理', '021-66002999', '历史合作关系保留用于状态演示', '已踢出']
  ] }),
  createArtifact({ artifactKey: '27-carbon-activities', order: 27, name: '2026-08 独立碳活动', templateType: 'carbon-activities', formats: ['xlsx'], requiredPermission: 'carbon:activities:import:preview', targetPage: '碳核算/独立碳活动', targetRoute: '/carbon', postAction: '预演并受控导入 2026-08 电力和天然气活动事实；导入只写独立碳活动，不自动匹配因子或执行核算。', dependencies: ['01-organization-root', '02-organization-departments', '07-monthly-energy', '11-carbon-factors'], rows: [
    ['QL-CA-ELECTRICITY-202608', '', '范围二', '购入电力', 'QL-PARK', 'electricity', '2026-08-01T00:00', '2026-09-01T00:00', DEMO_PARK_SOURCE_TIME_ZONE, 458000, 'kWh', 'default', 'QL:monthly-energy:park:electricity:202608', 'QL-EVID-ELECTRICITY-202608', '对应园区 2026-08 电力结算实际'],
    ['QL-CA-GAS-202608', '', '范围一', '固定燃烧', 'QL-UTILITY', 'natural_gas', '2026-08-01T00:00', '2026-09-01T00:00', DEMO_PARK_SOURCE_TIME_ZONE, 19300, 'm3', 'default', 'QL:monthly-energy:utility:natural-gas:202608', 'QL-EVID-GAS-202608', '对应公辅动力站 2026-08 天然气结算实际']
  ] }),
  createArtifact({ artifactKey: '28-carbon-emission-report', order: 28, name: '2026-08 碳排放报告', templateType: 'carbon-emission-report', formats: ['xlsx'], requiredPermission: 'carbon:emission-reports:import:preview', targetPage: '碳核算/碳排放报告', targetRoute: '/carbon', postAction: '预演并受控导入 N6 碳排放报告；报告事实、证据与汇总已冻结，导入不重新核算，也不登记演示 ownership。', dependencies: ['27-carbon-activities'], workbooks: {
    报告信息: [['QL-CER-2026-08', '天坤集团 2026 年 8 月碳排放报告', '天坤集团', '2026-08-01', '2026-08-31', 'carbon-emission-report', '1.0', '基于 2026-08 电力与天然气结算事实']],
    组织与核算边界: [
      ['组织边界', '天坤集团 2026 年 8 月运营控制范围', '纳入天坤集团园区及公辅动力站的运营控制设施'],
      ['核算边界', '范围一固定燃烧与范围二购入电力', '纳入报告期间天然气固定燃烧和购入电力排放']
    ],
    报告项目: [
      ['QL-CER-ITEM-ELECTRICITY-202608', '范围二', '购入电力', 'electricity', 458000, 'kWh', 0.0005703, 'tCO2e/kWh', 261.1974, 'tCO2e', 'QL-EVID-ELECTRICITY-202608', '活动量与 artifact 27 电力活动一致'],
      ['QL-CER-ITEM-GAS-202608', '范围一', '固定燃烧', 'natural_gas', 19300, 'm3', 0.0021622, 'tCO2e/m3', 41.73046, 'tCO2e', 'QL-EVID-GAS-202608', '活动量与 artifact 27 天然气活动一致']
    ],
    汇总: [
      ['QL-CER-TOTAL-202608', '总计', '全部', 302.92786, 'tCO2e', '等于全部报告项目排放量之和'],
      ['QL-CER-SCOPE1-202608', '排放范围', '范围一', 41.73046, 'tCO2e', '固定燃烧汇总'],
      ['QL-CER-SCOPE2-202608', '排放范围', '范围二', 261.1974, 'tCO2e', '购入电力汇总']
    ],
    证据说明: [
      ['QL-EVID-ELECTRICITY-202608', '2026-08 园区电力结算与计量汇总', '计量与结算记录', '458000 kWh 园区购入电力结算实际及总表计量汇总', '对应 artifact 07 与 artifact 27'],
      ['QL-EVID-GAS-202608', '2026-08 动力站天然气结算与计量汇总', '计量与结算记录', '19300 m3 公辅动力站天然气结算实际及计量汇总', '对应 artifact 07 与 artifact 27']
    ]
  } }),
  createArtifact({ artifactKey: '29-ghg-report', order: 29, name: '2026-08 温室气体报告', templateType: 'ghg-report', formats: ['xlsx'], requiredPermission: 'carbon:ghg-reports:import:preview', targetPage: '碳核算/温室气体报告', targetRoute: '/carbon', postAction: '预演并受控导入 N7 温室气体报告；当前没有真实清除事实，清除量保持为零，导入不派生核算或自动清理。', dependencies: ['28-carbon-emission-report'], workbooks: {
    报告信息: [['QL-GHG-2026-08', '天坤集团 2026 年 8 月温室气体报告', '天坤集团', '2026-08-01', '2026-08-31', 'ghg-report', '1.0', '与 N6 报告使用同一期间和活动事实']],
    组织边界: [['QL-GHG-BOUNDARY-PARK', '天坤集团园区及公辅动力站', '运营控制法', '纳入报告期间由天坤集团运营控制的园区设施']],
    运行边界: [
      ['范围一', '固定燃烧', '公辅动力站天然气固定燃烧排放'],
      ['范围二', '购入电力', '园区购入电力产生的能源间接排放']
    ],
    报告项目: [
      ['QL-GHG-ITEM-ELECTRICITY-202608', '排放', '范围二', '购入电力', 'CO2', 'electricity', 458000, 'kWh', 261.1974, 1, 261.1974, 'tCO2e', '活动数据乘以 2026 电力因子并换算为 tCO2e', 'QL-EVID-ELECTRICITY-202608', '与 N6 购入电力项目一致'],
      ['QL-GHG-ITEM-GAS-202608', '排放', '范围一', '固定燃烧', 'CO2', 'natural_gas', 19300, 'm3', 41.73046, 1, 41.73046, 'tCO2e', '活动数据乘以 2026 天然气因子并换算为 tCO2e', 'QL-EVID-GAS-202608', '与 N6 固定燃烧项目一致']
    ],
    汇总: [
      ['QL-GHG-TOTAL-202608', '总计', '全部', 302.92786, 0, 302.92786, 'tCO2e', '净 CO2e 等于排放减清除'],
      ['QL-GHG-SCOPE1-202608', '排放范围', '范围一', 41.73046, 0, 41.73046, 'tCO2e', '范围一排放汇总'],
      ['QL-GHG-SCOPE2-202608', '排放范围', '范围二', 261.1974, 0, 261.1974, 'tCO2e', '范围二排放汇总'],
      ['QL-GHG-TYPE-EMISSION-202608', '记录类型', '排放', 302.92786, 0, 302.92786, 'tCO2e', '当前报告仅包含真实排放事实']
    ],
    证据说明: [
      ['QL-EVID-ELECTRICITY-202608', '2026-08 园区电力结算与计量汇总', '计量与结算记录', '458000 kWh 园区购入电力结算实际及总表计量汇总', '与 N6 报告共享证据口径'],
      ['QL-EVID-GAS-202608', '2026-08 动力站天然气结算与计量汇总', '计量与结算记录', '19300 m3 公辅动力站天然气结算实际及计量汇总', '与 N6 报告共享证据口径']
    ]
  } })
]);

// 按 key 建立无原型只读索引，拒绝特殊原型键。
const DEMO_PARK_ARTIFACT_BY_KEY = Object.freeze(Object.assign(
  Object.create(null),
  Object.fromEntries(DEMO_PARK_ARTIFACTS.map((artifact) => [artifact.artifactKey, artifact]))
));

/** 读取指定条目的单表或多工作表演示行。 */
function getArtifactRows(artifactKey, sheetName = null) {
  const artifact = DEMO_PARK_ARTIFACT_BY_KEY[artifactKey];
  if (!artifact) {
    throw new Error(`天坤集团演示数据条目不存在：${artifactKey}`);
  }
  if (sheetName) {
    const sheetRows = artifact.workbooks?.[sheetName];
    if (!sheetRows) {
      throw new Error(`天坤集团演示数据工作表不存在：${artifactKey}/${sheetName}`);
    }
    return sheetRows;
  }
  return artifact.rows || [];
}

/** 断言演示数据静态契约成立，并提供稳定错误上下文。 */
function assertManifestCondition(condition, message) {
  if (!condition) {
    throw new Error(`天坤集团演示数据校验失败：${message}`);
  }
}

/** 校验严格 UTC 秒精度区间，避免把来源时区墙钟时间误当 UTC。 */
function validateStrictUtcRange(startUtc, endUtc, label) {
  const strictUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assertManifestCondition(strictUtcPattern.test(startUtc), `${label} 开始时间不是严格 UTC 秒精度。`);
  assertManifestCondition(strictUtcPattern.test(endUtc), `${label} 结束时间不是严格 UTC 秒精度。`);
  assertManifestCondition(Date.parse(startUtc) < Date.parse(endUtc), `${label} 时间区间无效。`);
}

/** 校验天坤集团目录中的跨文件业务编码、版本、能源类型和有效期引用。 */
function validateDemoParkCrossReferences() {
  const organizationRows = [
    ...getArtifactRows('01-organization-root'),
    ...getArtifactRows('02-organization-departments'),
    ...getArtifactRows('03-organization-process-equipment')
  ];
  // 组织索引同时服务于名称范围和精确编码范围校验。
  const organizationCodes = new Set(organizationRows.map((row) => row[0]));
  const organizationByCode = new Map(organizationRows.map((row) => [row[0], row]));
  const organizationCodeByName = new Map(organizationRows.map((row) => [row[1], row[0]]));
  organizationRows.forEach((row) => {
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `组织编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    if (row[2]) {
      assertManifestCondition(organizationCodes.has(row[2]), `组织父级不存在：${row[0]} -> ${row[2]}`);
    }
  });

  const meterRows = getArtifactRows('04-meters');
  const meterCodes = new Set(meterRows.map((row) => row[0]));
  // 表计索引用于校验所有后续事实的能源类型和精确组织归属。
  const meterByCode = new Map(meterRows.map((row) => [row[0], row]));
  const energyTypeCodes = new Set([
    ...meterRows.map((row) => row[2]),
    ...getArtifactRows('07-monthly-energy').map((row) => row[1]),
    ...getArtifactRows('11-carbon-factors').map((row) => row[0])
  ]);
  meterRows.forEach((row) => {
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `仪表编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[4]), `仪表所属组织不存在：${row[0]} -> ${row[4]}`);
  });

  const productionUnitRows = getArtifactRows('05-production-units');
  const productionUnitCodes = new Set(productionUnitRows.map((row) => row[0]));
  const productionUnitByCode = new Map(productionUnitRows.map((row) => [row[0], row]));
  productionUnitRows.forEach((row) => {
    assertManifestCondition(organizationCodes.has(row[2]), `产能单元所属组织不存在：${row[0]} -> ${row[2]}`);
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `产能单元编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    assertManifestCondition(String(row[4]).trim() !== '', `产能单元输出单位不能为空：${row[0]}`);
  });
  const productionOutputKeys = new Set();
  getArtifactRows('06-production-outputs').forEach((row) => {
    const productionUnit = productionUnitByCode.get(row[0]);
    assertManifestCondition(productionUnitCodes.has(row[0]), `月度产量引用的产能单元不存在：${row[0]}`);
    assertManifestCondition(productionUnit && productionUnit[1] === row[1], `月度产量名称与产能单元不一致：${row[0]}`);
    assertManifestCondition(productionUnit && productionUnit[4] === row[4], `月度产量单位与产能单元不一致：${row[0]} / ${row[2]}`);
    const key = [row[0], row[2], row[4]].join('|');
    assertManifestCondition(!productionOutputKeys.has(key), `月度产量事实重复：${key}`);
    productionOutputKeys.add(key);
  });

  const monthlyEnergyRows = getArtifactRows('07-monthly-energy');
  const monthlyEnergyKeys = new Set();
  monthlyEnergyRows.forEach((row) => {
    assertManifestCondition(energyTypeCodes.has(row[1]), `月度能耗能源类型不存在：${row[1]}`);
    assertManifestCondition(organizationCodes.has(row[4]), `月度能耗引用的组织不存在：${row[4]}`);
    const monthlyEnergyKey = [row[0], row[1], row[3], row[4], row[5] || 'direct'].join('|');
    assertManifestCondition(!monthlyEnergyKeys.has(monthlyEnergyKey), `月度能耗事实来源重复：${monthlyEnergyKey}`);
    monthlyEnergyKeys.add(monthlyEnergyKey);
    if (row[5]) {
      assertManifestCondition(meterCodes.has(row[5]), `月度能耗引用的仪表不存在：${row[5]}`);
      const meter = meterByCode.get(row[5]);
      assertManifestCondition(meter && meter[2] === row[1] && meter[4] === row[4], `月度能耗仪表与能源类型或组织不一致：${row[5]}`);
    }
  });
  const meterReadingKeys = new Set();
  const meterReadingRows = getArtifactRows('08-meter-readings-2026-08');
  meterReadingRows.forEach((row) => {
    const meter = meterByCode.get(row[1]);
    assertManifestCondition(meterCodes.has(row[1]), `抄表记录引用的仪表不存在：${row[1]}`);
    assertManifestCondition(meter && meter[1] === row[2], `抄表记录的表计名称不一致：${row[1]}`);
    assertManifestCondition(meter && organizationByCode.get(meter[4])?.[1] === row[8], `抄表记录的用能单元不一致：${row[1]}`);
    const readingMonth = row[0].slice(0, 7);
    const meterReadingKey = [readingMonth, row[1]].join('|');
    assertManifestCondition(!meterReadingKeys.has(meterReadingKey), `抄表事实来源重复：${meterReadingKey}`);
    meterReadingKeys.add(meterReadingKey);

    // 同月同表直接结算事实允许作为可审计冲突存在，但数值必须与抄表用量严格一致，后续仅由受控预演跳过。
    const sameMeterDirectFacts = monthlyEnergyRows.filter((energyRow) => (
      energyRow[0] === readingMonth
      && energyRow[1] === meter[2]
      && energyRow[3] === row[7]
      && energyRow[4] === meter[4]
      && energyRow[5] === row[1]
    ));
    if (sameMeterDirectFacts.length > 0) {
      const readingUsageValue = row[6] === '' || row[6] === null || row[6] === undefined
        ? (Number(row[4]) - Number(row[3])) * Number(row[5])
        : Number(row[6]);
      assertManifestCondition(sameMeterDirectFacts.length === 1, `同月同表直接月度事实必须唯一：${meterReadingKey}`);
      assertManifestCondition(Number.isFinite(readingUsageValue) && readingUsageValue >= 0, `抄表用量无法审计：${meterReadingKey}`);
      assertManifestCondition(Number(sameMeterDirectFacts[0][2]) === readingUsageValue, `同月同表直接月度事实与抄表用量不一致：${meterReadingKey}`);
    }
  });

  // 园区 2026-08 直接实际与总表抄表必须形成明确同表绑定，确保冲突可审计而非依赖空 meter code 绕过。
  const augustParkDirectFacts = monthlyEnergyRows.filter((row) => (
    row[0] === '2026-08'
    && row[1] === 'electricity'
    && row[3] === 'kWh'
    && row[4] === 'QL-PARK'
    && row[5] === 'QL-M-ELEC-PARK'
  ));
  const augustParkReadingFacts = meterReadingRows.filter((row) => (
    row[0].slice(0, 7) === '2026-08'
    && row[1] === 'QL-M-ELEC-PARK'
  ));
  assertManifestCondition(augustParkDirectFacts.length === 1, '2026-08 园区电力必须唯一绑定 QL-M-ELEC-PARK 的直接实际。');
  assertManifestCondition(augustParkReadingFacts.length === 1, '2026-08 园区总表必须存在唯一抄表事实。');
  const augustParkReading = augustParkReadingFacts[0];
  const augustParkReadingUsage = augustParkReading[6] === '' || augustParkReading[6] === null || augustParkReading[6] === undefined
    ? (Number(augustParkReading[4]) - Number(augustParkReading[3])) * Number(augustParkReading[5])
    : Number(augustParkReading[6]);
  assertManifestCondition(Number.isFinite(augustParkReadingUsage) && augustParkReadingUsage >= 0, '2026-08 园区总表抄表用量必须可计算。');
  assertManifestCondition(Number(augustParkDirectFacts[0][2]) === augustParkReadingUsage, '2026-08 园区总表抄表用量必须与直接实际数值一致。');
  const augustParkEnergyPostAction = getDemoParkArtifact('07-monthly-energy').postAction;
  const augustParkReadingPostAction = getDemoParkArtifact('08-meter-readings-2026-08').postAction;
  assertManifestCondition(augustParkEnergyPostAction.includes('QL-M-ELEC-PARK') && augustParkEnergyPostAction.includes('conflict') && augustParkEnergyPostAction.includes('不视为错误'), 'artifact 07 postAction 必须声明园区总表绑定、正常 conflict 跳过且不视为错误。');
  assertManifestCondition(augustParkReadingPostAction.includes('QL-M-ELEC-PARK') && augustParkReadingPostAction.includes('conflict') && augustParkReadingPostAction.includes('wouldGenerate') && augustParkReadingPostAction.includes('不视为错误'), 'artifact 08 postAction 必须声明同表 conflict、CNC wouldGenerate 且不视为错误。');

  // 预算实际必须来自同月、同能源、同组织和同单位的直接月度事实，不以零填充制造关联。
  getArtifactRows('10-energy-budgets').forEach((row) => {
    const organizationCode = organizationCodeByName.get(row[2]);
    assertManifestCondition(Boolean(organizationCode), `预算组织范围不存在：${row[2]}`);
    const matchingActualRows = monthlyEnergyRows.filter((energyRow) => (
      energyRow[0] === row[0]
      && energyRow[1] === row[1]
      && energyRow[3] === row[4]
      && energyRow[4] === organizationCode
      && Number(energyRow[2]) > 0
    ));
    assertManifestCondition(matchingActualRows.length === 1, `预算缺少唯一真实实际交集：${row[0]}|${row[1]}|${row[2]}|${row[4]}`);
  });

  // 至少一个产能单元必须在同月、精确组织和能源标准单位上形成真实强度分子分母交集。
  const calculableIntensityIntersections = getArtifactRows('06-production-outputs').filter((outputRow) => {
    const productionUnit = productionUnitByCode.get(outputRow[0]);
    return monthlyEnergyRows.some((energyRow) => (
      productionUnit
      && energyRow[0] === outputRow[2]
      && energyRow[4] === productionUnit[2]
      && energyRow[1] === 'electricity'
      && energyRow[3] === 'kWh'
      && outputRow[4] === productionUnit[4]
      && Number(outputRow[3]) > 0
      && Number(energyRow[2]) > 0
    ));
  });
  assertManifestCondition(calculableIntensityIntersections.length > 0, '至少一个产能单元必须具备真实可计算的单位产品能耗交集。');

  const shiftRows = getArtifactRows('13-shift-definitions');
  const shiftVersions = new Set(shiftRows.map((row) => `${row[0]}|${row[7]}`));
  shiftRows.forEach((row) => {
    assertManifestCondition(row[5] === DEMO_PARK_SOURCE_TIME_ZONE, `班次来源时区不一致：${row[0]}`);
    validateStrictUtcRange(row[8], row[9], `班次 ${row[0]}`);
  });
  const shiftScheduleRows = getArtifactRows('14-shift-schedules');
  const shiftScheduleSourceKeys = new Set();
  shiftScheduleRows.forEach((row) => {
    assertManifestCondition(shiftVersions.has(`${row[0]}|${row[7]}`), `排班引用的班次版本不存在：${row[0]}|${row[7]}`);
    assertManifestCondition(organizationCodes.has(row[10]), `排班引用的组织不存在：${row[10]}`);
    assertManifestCondition(row[5] === DEMO_PARK_SOURCE_TIME_ZONE, `排班来源时区不一致：${row[13]}`);
    assertManifestCondition(!shiftScheduleSourceKeys.has(row[13]), `排班 source reference 重复：${row[13]}`);
    shiftScheduleSourceKeys.add(row[13]);
    validateStrictUtcRange(row[11], row[12], `排班 ${row[13]}`);
  });

  const timeseriesRows = getArtifactRows('15-energy-timeseries');
  const timeseriesSourceKeys = new Set();
  const sortedTimeseriesRows = [...timeseriesRows].sort((left, right) => Date.parse(left[3]) - Date.parse(right[3]));
  sortedTimeseriesRows.forEach((row, index) => {
    const meter = meterByCode.get(row[2]);
    assertManifestCondition(energyTypeCodes.has(row[0]), `时序记录能源类型不存在：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[1]), `时序记录引用的组织不存在：${row[1]}`);
    assertManifestCondition(meterCodes.has(row[2]), `时序记录引用的仪表不存在：${row[2]}`);
    assertManifestCondition(meter && meter[2] === row[0] && meter[4] === row[1], `时序记录与表计能源类型或精确组织不一致：${row[9]}`);
    assertManifestCondition(row[5] === DEMO_PARK_SOURCE_TIME_ZONE, `时序记录来源时区不一致：${row[9]}`);
    assertManifestCondition(row[6] === 15, `时序记录粒度必须固定为 15 分钟：${row[9]}`);
    assertManifestCondition(row[7] === 'kWh', `时序记录单位必须为 kWh：${row[9]}`);
    assertManifestCondition(!timeseriesSourceKeys.has(row[9]), `时序 source reference 重复：${row[9]}`);
    timeseriesSourceKeys.add(row[9]);
    validateStrictUtcRange(row[3], row[4], `时序记录 ${row[9]}`);
    assertManifestCondition(Date.parse(row[4]) - Date.parse(row[3]) === 15 * 60 * 1000, `时序记录区间必须恰好 15 分钟：${row[9]}`);
    if (index > 0) {
      assertManifestCondition(sortedTimeseriesRows[index - 1][4] === row[3], `时序记录存在缺口或重叠：${sortedTimeseriesRows[index - 1][9]} -> ${row[9]}`);
    }
  });
  assertManifestCondition(sortedTimeseriesRows.length === 16, '固定参考窗口必须包含连续 16 条 15 分钟时序事实。');
  assertManifestCondition(sortedTimeseriesRows[0][3] === '2026-08-01T00:00:00Z', '固定时序窗口开始时间必须为 2026-08-01T00:00:00Z。');
  assertManifestCondition(sortedTimeseriesRows[sortedTimeseriesRows.length - 1][4] === '2026-08-01T04:00:00Z', '固定时序窗口结束时间必须为 2026-08-01T04:00:00Z。');
  assertManifestCondition(Math.max(...sortedTimeseriesRows.map((row) => Number(row[8]))) > 300, '固定时序窗口必须真实命中峰值策略阈值。');

  const deviceStateRows = getArtifactRows('16-device-states');
  const deviceStateSourceKeys = new Set();
  deviceStateRows.forEach((row) => {
    const meter = meterByCode.get(row[0]);
    assertManifestCondition(meterCodes.has(row[0]), `设备状态引用的仪表不存在：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[1]), `设备状态引用的组织不存在：${row[1]}`);
    assertManifestCondition(meter && meter[4] === row[1], `设备状态与表计精确组织不一致：${row[6]}`);
    assertManifestCondition(organizationByCode.get(row[1])?.[4] === 'equipment', `设备状态组织必须为 equipment：${row[1]}`);
    assertManifestCondition(row[5] === DEMO_PARK_SOURCE_TIME_ZONE, `设备状态来源时区不一致：${row[6]}`);
    assertManifestCondition(!deviceStateSourceKeys.has(row[6]), `设备状态 source reference 重复：${row[6]}`);
    deviceStateSourceKeys.add(row[6]);
    validateStrictUtcRange(row[3], row[4], `设备状态 ${row[6]}`);
  });

  // 排班、时序和设备状态必须在同一 CNC 精确组织与固定 UTC 窗口形成交集。
  const timeseriesWindowStart = Date.parse(sortedTimeseriesRows[0][3]);
  const timeseriesWindowEnd = Date.parse(sortedTimeseriesRows[sortedTimeseriesRows.length - 1][4]);
  const cncMeter = meterByCode.get('QL-M-ELEC-CNC01');
  assertManifestCondition(Boolean(cncMeter), 'CNC 时序表计不存在。');
  const matchingShiftSchedules = shiftScheduleRows.filter((row) => (
    row[10] === cncMeter[4]
    && Date.parse(row[11]) < timeseriesWindowEnd
    && Date.parse(row[12]) > timeseriesWindowStart
  ));
  const matchingDeviceStates = deviceStateRows.filter((row) => (
    row[0] === cncMeter[0]
    && row[1] === cncMeter[4]
    && Date.parse(row[3]) <= timeseriesWindowStart
    && Date.parse(row[4]) >= timeseriesWindowEnd
  ));
  assertManifestCondition(matchingShiftSchedules.length > 0, 'CNC 时序窗口必须与同组织排班形成交集。');
  assertManifestCondition(matchingDeviceStates.length > 0, 'CNC 时序窗口必须被同表计同组织设备状态覆盖。');

  const touSchemeRows = getArtifactRows('17-tou-schemes', 'TOU方案');
  const touSchemeVersions = new Set(touSchemeRows.map((row) => `${row[0]}|${row[5]}`));
  const touRulesByDay = new Map();
  touSchemeRows.forEach((row) => validateStrictUtcRange(row[6], row[7], `TOU 方案 ${row[0]}`));
  getArtifactRows('17-tou-schemes', '时段规则').forEach((row) => {
    const schemeVersion = `${row[0]}|${row[1]}`;
    assertManifestCondition(touSchemeVersions.has(schemeVersion), `TOU 时段引用的方案版本不存在：${schemeVersion}`);
    assertManifestCondition(Number.isInteger(row[2]) && row[2] >= 1 && row[2] <= 7, `TOU 星期值无效：${row[2]}`);
    assertManifestCondition(row[4] >= 0 && row[4] < row[5] && row[5] <= 1440, `TOU 时段边界无效：${row[0]} 第 ${row[2]} 天。`);
    const dayKey = `${schemeVersion}|${row[2]}`;
    touRulesByDay.set(dayKey, [...(touRulesByDay.get(dayKey) || []), row]);
  });
  touSchemeVersions.forEach((schemeVersion) => {
    for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
      const dayRules = [...(touRulesByDay.get(`${schemeVersion}|${dayOfWeek}`) || [])]
        .sort((left, right) => left[4] - right[4] || left[5] - right[5]);
      assertManifestCondition(dayRules.length > 0, `TOU 方案缺少星期 ${dayOfWeek} 规则：${schemeVersion}`);
      assertManifestCondition(dayRules[0][4] === 0, `TOU 方案星期 ${dayOfWeek} 必须从 0 分钟开始：${schemeVersion}`);
      dayRules.forEach((row, index) => {
        if (index === 0) return;
        assertManifestCondition(dayRules[index - 1][5] === row[4], `TOU 方案星期 ${dayOfWeek} 存在缺口或重叠：${schemeVersion}`);
      });
      assertManifestCondition(dayRules[dayRules.length - 1][5] === 1440, `TOU 方案星期 ${dayOfWeek} 必须结束于 1440 分钟：${schemeVersion}`);
    }
  });
  getArtifactRows('18-strategy-rules').forEach((row) => {
    validateStrictUtcRange(row[17], row[18], `策略规则 ${row[0]}`);
    assertManifestCondition(row[19] === DEMO_PARK_SOURCE_TIME_ZONE, `策略规则来源时区不一致：${row[0]}`);
    assertManifestCondition(Date.parse(row[17]) < timeseriesWindowEnd && Date.parse(row[18]) > timeseriesWindowStart, `策略规则与固定时序窗口无交集：${row[0]}`);
    assertManifestCondition(row[4] === 'peak_interval_energy' && row[5] === 'gt' && Number(row[6]) < Math.max(...sortedTimeseriesRows.map((item) => Number(item[8]))), `策略规则无法被固定时序事实真实命中：${row[0]}`);
  });
  assertManifestCondition(touSchemeRows.some((row) => (
    row[2] === DEMO_PARK_SOURCE_TIME_ZONE
    && Date.parse(row[6]) < timeseriesWindowEnd
    && Date.parse(row[7]) > timeseriesWindowStart
  )), '固定时序窗口必须与有效 TOU 方案形成交集。');

  const benchmarkDefinitionRows = getArtifactRows('20-benchmark-definitions');
  const benchmarkCodes = new Set(benchmarkDefinitionRows.map((row) => row[0]));
  benchmarkDefinitionRows.forEach((row) => {
    assertManifestCondition(organizationCodes.has(row[7]), `对标定义引用的组织不存在：${row[7]}`);
    validateStrictUtcRange(row[10], row[11], `对标定义 ${row[0]}`);
  });
  getArtifactRows('21-benchmark-targets').forEach((row) => {
    assertManifestCondition(benchmarkCodes.has(row[0]), `对标目标引用的定义不存在：${row[0]}`);
    assertManifestCondition(!row[4] && !row[5], `普通对标目标不得伪造内部历史参考期：${row[0]}`);
  });

  const flowModelRows = getArtifactRows('22-energy-flow-models');
  const flowModelVersions = new Set(flowModelRows.map((row) => `${row[0]}|${row[4]}`));
  flowModelRows.forEach((row) => validateStrictUtcRange(row[5], row[6], `能流模型 ${row[0]}`));
  const flowNodeRows = getArtifactRows('23-energy-flow-nodes');
  const flowNodeCodes = new Set(flowNodeRows.map((row) => row[8]));
  flowNodeRows.forEach((row) => {
    assertManifestCondition(flowModelVersions.has(`${row[0]}|${row[4]}`), `能流节点引用的模型版本不存在：${row[0]}|${row[4]}`);
    assertManifestCondition(organizationCodes.has(row[11]), `能流节点引用的组织不存在：${row[11]}`);
    validateStrictUtcRange(row[5], row[6], `能流节点 ${row[8]}`);
  });
  const flowEdgeRows = getArtifactRows('24-energy-flow-edges', '能流边');
  const flowEdgeCodes = new Set(flowEdgeRows.map((row) => row[2]));
  flowEdgeRows.forEach((row) => {
    assertManifestCondition(flowModelVersions.has(`${row[0]}|${row[1]}`), `能流边引用的模型版本不存在：${row[0]}|${row[1]}`);
    assertManifestCondition(flowNodeCodes.has(row[3]) && flowNodeCodes.has(row[4]), `能流边引用的节点不存在：${row[2]}`);
    assertManifestCondition(energyTypeCodes.has(row[5]), `能流边能源类型不存在：${row[5]}`);
  });
  getArtifactRows('24-energy-flow-edges', '显式边值').forEach((row) => {
    assertManifestCondition(flowModelVersions.has(`${row[0]}|${row[1]}`), `显式边值引用的模型版本不存在：${row[0]}|${row[1]}`);
    assertManifestCondition(flowEdgeCodes.has(row[2]), `显式边值引用的能流边不存在：${row[2]}`);
    validateStrictUtcRange(row[3], row[4], `显式边值 ${row[9]}`);
  });

  const balanceBoundaryRows = getArtifactRows('25-energy-balance-configs', '平衡边界');
  const balanceBoundaryVersions = new Set(balanceBoundaryRows.map((row) => `${row[0]}|${row[5]}`));
  balanceBoundaryRows.forEach((row) => {
    assertManifestCondition(organizationCodes.has(row[2]), `平衡边界引用的组织不存在：${row[2]}`);
    validateStrictUtcRange(row[6], row[7], `平衡边界 ${row[0]}`);
  });
  getArtifactRows('25-energy-balance-configs', '九角色项目').forEach((row) => {
    assertManifestCondition(balanceBoundaryVersions.has(`${row[0]}|${row[1]}`), `平衡项目引用的边界版本不存在：${row[0]}|${row[1]}`);
    assertManifestCondition(energyTypeCodes.has(row[5]), `平衡项目能源类型不存在：${row[5]}`);
    const organizationMatch = String(row[8] || '').match(/organization=(QL-[^;]+)/);
    if (organizationMatch) {
      assertManifestCondition(organizationCodes.has(organizationMatch[1]), `平衡项目来源组织不存在：${organizationMatch[1]}`);
    }
  });

  // 供应商、独立碳活动和两类报告均使用真实领域已有的组织、能源类型、因子和证据交集。
  const supplierRows = getArtifactRows('26-suppliers');
  assertManifestCondition(supplierRows.length >= 2, '供应商演示数据至少需要两条记录。');
  assertManifestCondition(supplierRows.filter((row) => row[6] === '合作中').length >= 2, '供应商演示数据至少需要两条合作中记录。');
  const supplierCodes = new Set();
  supplierRows.forEach((row) => {
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `供应商编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    assertManifestCondition(!supplierCodes.has(row[0]), `供应商编码重复：${row[0]}`);
    assertManifestCondition(String(row[1]).includes('天坤集团'), `供应商名称必须体现天坤集团范围：${row[0]}`);
    supplierCodes.add(row[0]);
  });

  const carbonActivityRows = getArtifactRows('27-carbon-activities');
  const carbonFactorByEnergy = new Map(getArtifactRows('11-carbon-factors').map((row) => [row[0], row]));
  const activityCodes = new Set();
  carbonActivityRows.forEach((row) => {
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `独立碳活动编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    assertManifestCondition(!activityCodes.has(row[0]), `独立碳活动编码重复：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[4]), `独立碳活动用能单元不存在：${row[0]} -> ${row[4]}`);
    assertManifestCondition(energyTypeCodes.has(row[5]), `独立碳活动能源类型不存在：${row[0]} -> ${row[5]}`);
    assertManifestCondition(row[8] === DEMO_PARK_SOURCE_TIME_ZONE, `独立碳活动来源时区不一致：${row[0]}`);
    assertManifestCondition(Date.parse(`${row[6]}+08:00`) < Date.parse(`${row[7]}+08:00`), `独立碳活动时间区间无效：${row[0]}`);
    assertManifestCondition(Number(row[9]) > 0, `独立碳活动数据值必须为正数：${row[0]}`);
    const factor = carbonFactorByEnergy.get(row[5]);
    assertManifestCondition(factor && factor[3] === row[10] && factor[1] === row[11], `独立碳活动单位或因子地区无匹配因子：${row[0]}`);
    activityCodes.add(row[0]);
  });

  const n6Sheets = ['报告信息', '组织与核算边界', '报告项目', '汇总', '证据说明'];
  const n6Report = getArtifactRows('28-carbon-emission-report', '报告信息')[0];
  const n6Items = getArtifactRows('28-carbon-emission-report', '报告项目');
  const n6Summaries = getArtifactRows('28-carbon-emission-report', '汇总');
  const n6Evidence = getArtifactRows('28-carbon-emission-report', '证据说明');
  assertManifestCondition(n6Sheets.every((sheetName) => Boolean(getArtifactRows('28-carbon-emission-report', sheetName))), 'N6 报告工作表数据不完整。');
  assertManifestCondition(n6Report[2] === '天坤集团' && n6Report[3] === '2026-08-01' && n6Report[4] === '2026-08-31', 'N6 报告组织或期间必须匹配 2026-08 事实。');
  const n6EvidenceCodes = new Set(n6Evidence.map((row) => row[0]));
  n6Items.forEach((row) => {
    assertManifestCondition(n6EvidenceCodes.has(row[10]), `N6 项目证据不存在：${row[0]} -> ${row[10]}`);
    assertManifestCondition(Number(row[4]) >= 0 && Number(row[6]) > 0 && Number(row[8]) >= 0, `N6 项目数值无效：${row[0]}`);
  });
  const n6Total = n6Items.reduce((sum, row) => sum + Number(row[8]), 0);
  const n6TotalSummary = n6Summaries.find((row) => row[1] === '总计' && row[2] === '全部');
  assertManifestCondition(n6TotalSummary && Math.abs(Number(n6TotalSummary[3]) - n6Total) < 1e-9, 'N6 总计必须等于项目排放量之和。');
  n6Items.forEach((item) => {
    const matchingActivity = carbonActivityRows.find((activity) => activity[5] === item[3] && Number(activity[9]) === Number(item[4]));
    assertManifestCondition(matchingActivity, `N6 项目必须匹配独立碳活动事实：${item[0]}`);
  });

  const n7Report = getArtifactRows('29-ghg-report', '报告信息')[0];
  const n7Items = getArtifactRows('29-ghg-report', '报告项目');
  const n7Summaries = getArtifactRows('29-ghg-report', '汇总');
  const n7Evidence = getArtifactRows('29-ghg-report', '证据说明');
  assertManifestCondition(n7Report[2] === '天坤集团' && n7Report[3] === '2026-08-01' && n7Report[4] === '2026-08-31', 'N7 报告组织或期间必须匹配 2026-08 事实。');
  const n7EvidenceCodes = new Set(n7Evidence.map((row) => row[0]));
  n7Items.forEach((row) => {
    assertManifestCondition(row[1] === '排放', `N7 演示项目不得伪造清除事实：${row[0]}`);
    assertManifestCondition(n7EvidenceCodes.has(row[13]), `N7 项目证据不存在：${row[0]} -> ${row[13]}`);
    assertManifestCondition(Number(row[6]) >= 0 && Number(row[8]) >= 0 && Number(row[9]) > 0 && Number(row[10]) >= 0, `N7 项目数值无效：${row[0]}`);
  });
  const n7EmissionTotal = n7Items.reduce((sum, row) => sum + Number(row[10]), 0);
  const n7TotalSummary = n7Summaries.find((row) => row[1] === '总计' && row[2] === '全部');
  assertManifestCondition(n7TotalSummary
    && Math.abs(Number(n7TotalSummary[3]) - n7EmissionTotal) < 1e-9
    && Number(n7TotalSummary[4]) === 0
    && Math.abs(Number(n7TotalSummary[5]) - n7EmissionTotal) < 1e-9, 'N7 总计必须满足排放、清除和净值关系。');

  return true;
}

/** 返回不含业务数据行的天坤集团演示数据目录，并合并静态 handler 治理契约。 */
function listDemoParkArtifacts() {
  return DEMO_PARK_ARTIFACTS.map((artifact) => {
    const registration = getDemoArtifactRegistration(artifact.artifactKey);
    return {
      artifactKey: artifact.artifactKey,
      order: artifact.order,
      name: artifact.name,
      templateType: artifact.templateType,
      coveredTemplateTypes: [...artifact.coveredTemplateTypes],
      formats: [...artifact.formats],
      requiredPermission: registration?.permissions.download || artifact.requiredPermission,
      handlerKey: registration?.handlerKey || null,
      mode: registration?.mode || null,
      downloadLifecycle: registration?.downloadLifecycle || null,
      permissions: registration ? { ...registration.permissions } : null,
      routes: registration
        ? Object.fromEntries(Object.entries(registration.routes).map(([key, values]) => [key, [...values]]))
        : null,
      batchRoles: registration?.batchRoles.map((item) => ({ ...item })) || [],
      actor: registration ? { ...registration.actor } : null,
      guards: registration ? [...registration.guards] : [],
      ownershipTargets: registration ? [...registration.ownershipTargets] : [],
      blocker: registration ? { ...registration.blocker } : null,
      targetPage: artifact.targetPage,
      targetRoute: artifact.targetRoute,
      postAction: artifact.postAction,
      dependencies: [...artifact.dependencies],
      downloads: Object.fromEntries(artifact.formats.map((format) => [
        format,
        `/api/templates/demo-park/${artifact.artifactKey}.${format}`
      ]))
    };
  });
}

/** 对普通 JSON 值执行稳定对象键排序，数组顺序保持业务语义。 */
function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalizeJsonValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

/** 构造 digest 使用的稳定字段白名单，不包含业务数据行、函数或运行期信息。 */
function buildDemoParkManifestCanonicalPayload() {
  const registryByArtifact = new Map(listDemoArtifactRegistrations().map((item) => [item.artifactKey, item]));
  return {
    canonicalizationVersion: DEMO_CANONICALIZATION_VERSION,
    datasetId: DEMO_DATASET_ID,
    manifestVersion: DEMO_MANIFEST_VERSION,
    sourceTimeZone: DEMO_PARK_SOURCE_TIME_ZONE,
    artifacts: DEMO_PARK_ARTIFACTS.map((artifact) => {
      const registration = registryByArtifact.get(artifact.artifactKey);
      return {
        artifactKey: artifact.artifactKey,
        order: artifact.order,
        name: artifact.name,
        templateType: artifact.templateType,
        coveredTemplateTypes: [...artifact.coveredTemplateTypes],
        formats: [...artifact.formats],
        requiredPermission: registration.permissions.download,
        targetPage: artifact.targetPage,
        targetRoute: artifact.targetRoute,
        postAction: artifact.postAction,
        dependencies: [...artifact.dependencies],
        handlerKey: registration.handlerKey,
        mode: registration.mode,
        permissions: { ...registration.permissions },
        routes: registration.routes,
        batchRoles: registration.batchRoles,
        actor: registration.actor,
        guards: [...registration.guards],
        ownershipTargets: [...registration.ownershipTargets],
        blocker: registration.blocker
      };
    })
  };
}

/** 返回稳定 canonical JSON 字符串。 */
function getDemoParkManifestCanonicalJson() {
  return JSON.stringify(canonicalizeJsonValue(buildDemoParkManifestCanonicalPayload()));
}

/** 返回稳定 SHA-256 manifest digest。 */
function getDemoParkManifestDigest() {
  return crypto.createHash('sha256').update(getDemoParkManifestCanonicalJson(), 'utf8').digest('hex');
}

/** 返回 Dataset 版本、digest 和目录的完整 manifest。 */
function getDemoParkManifest() {
  return {
    datasetId: DEMO_DATASET_ID,
    manifestVersion: DEMO_MANIFEST_VERSION,
    canonicalizationVersion: DEMO_CANONICALIZATION_VERSION,
    manifestDigest: getDemoParkManifestDigest(),
    sourceTimeZone: DEMO_PARK_SOURCE_TIME_ZONE,
    codePrefix: DEMO_PARK_CODE_PREFIX,
    artifacts: listDemoParkArtifacts()
  };
}

/** 按稳定 key 读取演示数据条目。 */
function getDemoParkArtifact(artifactKey) {
  const normalizedArtifactKey = String(artifactKey || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEMO_PARK_ARTIFACT_BY_KEY, normalizedArtifactKey)
    ? DEMO_PARK_ARTIFACT_BY_KEY[normalizedArtifactKey]
    : null;
}

/** 将 N6/N7 演示行注入正式多工作表定义，并保留正式 sheet 顺序、表头和单元格类型配置。 */
function renderFormalMultiSheetArtifact(template, artifact) {
  const artifactSheetNames = Object.keys(artifact.workbooks || {});
  const templateSheetNames = template.sheets.map((sheet) => sheet.name);
  assertManifestCondition(
    artifactSheetNames.length === templateSheetNames.length
      && artifactSheetNames.every((sheetName, index) => sheetName === templateSheetNames[index]),
    `${artifact.artifactKey} 工作表名称或顺序与正式模板不一致。`
  );
  const sheets = template.sheets.map((sheet) => ({
    ...sheet,
    rows: artifact.workbooks[sheet.name]
  }));
  return renderXlsxBuffer({ ...template, sheets });
}

/** 生成单个天坤集团演示文件，全部内容仅在内存中构造。 */
function generateDemoParkArtifact(artifactKey, format = 'xlsx') {
  const artifact = getDemoParkArtifact(artifactKey);
  if (!artifact) {
    return null;
  }
  const normalizedFormat = String(format || 'xlsx').trim().replace(/^\./, '').toLowerCase();
  if (!artifact.formats.includes(normalizedFormat)) {
    throw new AppError('DEMO_ARTIFACT_FORMAT_UNSUPPORTED', '该演示数据文件不支持请求的格式。', {
      statusCode: 400,
      details: {
        artifactKey: artifact.artifactKey,
        format: normalizedFormat,
        supportedFormats: [...artifact.formats]
      }
    });
  }

  const template = getTemplateDefinition(artifact.templateType);
  if (!template) {
    throw new AppError('DEMO_ARTIFACT_TEMPLATE_MISSING', '演示数据关联的模板不存在。', {
      statusCode: 500,
      details: { artifactKey: artifact.artifactKey, templateType: artifact.templateType }
    });
  }

  let buffer;
  if (FORMAL_MULTI_SHEET_TEMPLATE_TYPES.has(template.type)) {
    assertManifestCondition(normalizedFormat === 'xlsx', `${artifact.artifactKey} 正式报告模板仅支持 XLSX。`);
    buffer = renderFormalMultiSheetArtifact(template, artifact);
  } else if (template.sheets) {
    const generated = generateEnergyAnalysisTemplate(template.type, normalizedFormat, {
      rows: artifact.rows,
      workbooks: artifact.workbooks
    });
    buffer = generated.buffer;
  } else if (normalizedFormat === 'csv') {
    buffer = Buffer.from(renderCsv(template.headers, artifact.rows || []), 'utf8');
  } else {
    buffer = renderXlsxBuffer({ ...template, rows: artifact.rows || [] });
  }

  const extension = normalizedFormat;
  const fileName = `${String(artifact.order).padStart(2, '0')}-${artifact.name}.${extension}`;
  const asciiFileName = `${artifact.artifactKey}.${extension}`;
  return {
    artifact,
    template,
    format: normalizedFormat,
    fileName,
    asciiFileName,
    mimeType: normalizedFormat === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer
  };
}

/** 校验目录中的模板权限与中央权限映射未发生漂移。 */
function validateDemoParkManifest() {
  const artifactKeys = new Set();
  const orders = new Set();
  DEMO_PARK_ARTIFACTS.forEach((artifact) => {
    if (artifactKeys.has(artifact.artifactKey) || orders.has(artifact.order)) {
      throw new Error('天坤集团演示数据目录存在重复 key 或顺序。');
    }
    artifactKeys.add(artifact.artifactKey);
    orders.add(artifact.order);
    if (!artifact.artifactKey.startsWith(`${String(artifact.order).padStart(2, '0')}-`)) {
      throw new Error(`演示数据条目顺序与 key 不一致：${artifact.artifactKey}`);
    }
    const registration = getDemoArtifactRegistration(artifact.artifactKey);
    if (!registration || registration.templateType !== artifact.templateType) {
      throw new Error(`演示数据条目未绑定正确的静态 handler：${artifact.artifactKey}`);
    }
    if (registration.permissions.download !== artifact.requiredPermission) {
      throw new Error(`演示数据条目权限与静态 registry 不一致：${artifact.artifactKey}`);
    }
    assertManifestCondition(
      typeof artifact.targetRoute === 'string' && DEMO_PARK_INTERNAL_ROUTE_PATTERN.test(artifact.targetRoute),
      `演示数据目标路由必须是站内 path-only 值：${artifact.artifactKey}`
    );
    assertManifestCondition(
      DEMO_PARK_TRUSTED_TARGET_ROUTES.has(artifact.targetRoute),
      `演示数据目标路由未登记为可信页面：${artifact.artifactKey} -> ${artifact.targetRoute}`
    );
    artifact.dependencies.forEach((dependencyKey) => {
      const dependency = DEMO_PARK_ARTIFACT_BY_KEY[dependencyKey];
      if (!dependency || dependency.order >= artifact.order) {
        throw new Error(`演示数据依赖不存在或顺序非法：${artifact.artifactKey} -> ${dependencyKey}`);
      }
    });
  });
  assertManifestCondition(artifactKeys.size === 29, 'manifest 必须恰好包含 29 个 artifact。');
  validateDemoParkCrossReferences();
  assertManifestCondition(/^[a-f0-9]{64}$/.test(getDemoParkManifestDigest()), 'manifest digest 格式无效。');
  return true;
}

validateDemoParkManifest();

module.exports = {
  DEMO_CANONICALIZATION_VERSION,
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  DEMO_PARK_ARTIFACTS,
  DEMO_PARK_CODE_PREFIX,
  DEMO_PARK_SOURCE_TIME_ZONE,
  buildDemoParkManifestCanonicalPayload,
  canonicalizeJsonValue,
  generateDemoParkArtifact,
  getDemoParkArtifact,
  getDemoParkManifest,
  getDemoParkManifestCanonicalJson,
  getDemoParkManifestDigest,
  listDemoParkArtifacts,
  validateDemoParkManifest
};
