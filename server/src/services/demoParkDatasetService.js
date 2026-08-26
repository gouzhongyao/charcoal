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
const DEMO_MANIFEST_VERSION = '1.1.0';
const DEMO_CANONICALIZATION_VERSION = 'canonical-json-v1';
// 青岚园区演示数据统一采用稳定业务前缀，不使用数据库自增 ID。
const DEMO_PARK_CODE_PREFIX = 'QL-';
// 演示数据的来源时区统一显式声明为 IANA 时区。
const DEMO_PARK_SOURCE_TIME_ZONE = 'Asia/Shanghai';

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

// 青岚园区固定下载顺序同时表达父子台账、配置、时序和计算模型依赖。
const DEMO_PARK_ARTIFACTS = Object.freeze([
  createArtifact({ artifactKey: '01-organization-root', order: 1, name: '用能单元根级', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', postAction: '导入并确认根级园区组织已启用。', dependencies: [], rows: [['QL-PARK', '青岚智造园区', '', '', 'enterprise', 86000, 10, 'active', '青岚园区演示根级']] }),
  createArtifact({ artifactKey: '02-organization-departments', order: 2, name: '用能单元部门与车间', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', postAction: '导入后核对父级路径和启用状态。', dependencies: ['01-organization-root'], rows: [
    ['QL-ENERGY', '能源管理部', 'QL-PARK', '青岚智造园区', 'department', 1800, 20, 'active', '能源管理部门'],
    ['QL-WORKSHOP-A', '精密制造一车间', 'QL-PARK', '青岚智造园区', 'workshop', 26000, 30, 'active', '主要生产车间'],
    ['QL-WORKSHOP-B', '装配二车间', 'QL-PARK', '青岚智造园区', 'workshop', 22000, 40, 'active', '装配生产车间'],
    ['QL-UTILITY', '公辅动力站', 'QL-PARK', '青岚智造园区', 'workshop', 6500, 50, 'active', '空压与能源站']
  ] }),
  createArtifact({ artifactKey: '03-organization-process-equipment', order: 3, name: '用能单元工序与设备', templateType: 'organization-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:units:import', targetPage: '基础台账/组织管理', postAction: '导入后核对工序和设备均挂接到已存在车间。', dependencies: ['02-organization-departments'], rows: [
    ['QL-PROC-MACHINING', '机加工工序', 'QL-WORKSHOP-A', '精密制造一车间', 'process', 8000, 110, 'active', '重点耗能工序'],
    ['QL-EQ-CNC-01', '数控加工中心01', 'QL-WORKSHOP-A', '精密制造一车间', 'equipment', 120, 111, 'active', '设备状态演示对象'],
    ['QL-PROC-ASSEMBLY', '总装工序', 'QL-WORKSHOP-B', '装配二车间', 'process', 7200, 120, 'active', '装配工序'],
    ['QL-EQ-AIR-01', '空压机01', 'QL-UTILITY', '公辅动力站', 'equipment', 180, 130, 'active', '公辅设备']
  ] }),
  createArtifact({ artifactKey: '04-meters', order: 4, name: '计量器具', templateType: 'meters', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:meters:import', targetPage: '基础台账/计量器具', postAction: '导入后确认能源类型与所属用能单元匹配。', dependencies: ['03-organization-process-equipment'], rows: [
    ['QL-M-ELEC-PARK', '园区总进线电表', 'electricity', 'electricity', 'QL-PARK', '青岚智造园区', 'online', 'QL-GW-01', 1, 1, 'input', '总配电室', 'active', '园区总表'],
    ['QL-M-ELEC-CNC01', '数控中心电表', 'electricity', 'electricity', 'QL-EQ-CNC-01', '数控加工中心01', 'online', 'QL-GW-02', 1, 1, 'input', '一车间配电柜', 'active', '设备分表'],
    ['QL-M-GAS-UTILITY', '动力站天然气表', 'natural_gas', 'natural_gas', 'QL-UTILITY', '公辅动力站', 'online', 'QL-GW-03', 1, 1, 'input', '动力站', 'active', '天然气计量']
  ] }),
  createArtifact({ artifactKey: '05-production-units', order: 5, name: '产能单元', templateType: 'production-units', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:production:import', targetPage: '基础台账/产能单元', postAction: '预演并导入，确认产能单元关联启用的用能单元。', dependencies: ['03-organization-process-equipment'], rows: [
    ['QL-PU-PRECISION', '精密零件产能单元', 'QL-WORKSHOP-A', '精密零件', 't', '一车间产品产量', 'active'],
    ['QL-PU-ASSEMBLY', '成套设备产能单元', 'QL-WORKSHOP-B', '成套设备', '台', '二车间产品产量', 'active']
  ] }),
  createArtifact({ artifactKey: '06-production-outputs', order: 6, name: '月度产量', templateType: 'production-outputs', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:production:preview', targetPage: '基础台账/月度产量', postAction: '预演并导入后核对 2026-06 至 2026-08 产量。', dependencies: ['05-production-units'], rows: [
    ['QL-PU-PRECISION', '精密零件产能单元', '2026-06', 1180, 't', 'upload', '青岚演示产量'],
    ['QL-PU-PRECISION', '精密零件产能单元', '2026-07', 1250, 't', 'upload', '青岚演示产量'],
    ['QL-PU-ASSEMBLY', '成套设备产能单元', '2026-07', 86, '台', 'upload', '青岚演示产量']
  ] }),
  createArtifact({ artifactKey: '07-monthly-energy', order: 7, name: '月度能耗与预测历史', templateType: 'energy-records', coveredTemplateTypes: ['energy-records', 'prediction-history'], formats: ['xlsx', 'csv'], requiredPermission: 'imports:create', targetPage: '能耗管理/能耗数据导入', postAction: '创建导入批次；预测历史复用本文件，不重复导入。', dependencies: ['03-organization-process-equipment', '04-meters'], rows: [
    ['2026-01', 'electricity', '电力', 368000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-01-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-02', 'electricity', '电力', 376000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-02-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-03', 'electricity', '电力', 389000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-03-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-04', 'electricity', '电力', 401000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-04-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-05', 'electricity', '电力', 410000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-05-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-06', 'electricity', '电力', 420000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-06-01 00:00:00', 'monthly-energy', '预测训练历史'],
    ['2026-07', 'electricity', '电力', 445000, 'kWh', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', '机加工工序', 'QL-M-ELEC-PARK', '2026-07-01 00:00:00', 'monthly-energy', '平衡与预测历史'],
    ['2026-07', 'natural_gas', '天然气', 18600, 'm3', '青岚智造园区/公辅动力站', '青岚智造园区', '公辅动力站', '', 'QL-M-GAS-UTILITY', '2026-07-01 00:00:00', 'monthly-energy', '动力站天然气']
  ] }),
  createArtifact({ artifactKey: '08-meter-readings-2026-08', order: 8, name: '2026-08 抄表演示', templateType: 'meter-readings', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:readings:import', targetPage: '基础台账/计量抄表', postAction: '导入后仅形成抄表记录；如需能耗记录必须另走受控预演。', dependencies: ['04-meters'], rows: [
    ['2026-08-01', 'QL-M-ELEC-PARK', '园区总进线电表', 1250000, 1698000, 1, '', 'kWh', '青岚智造园区', '按表码差计算'],
    ['2026-08-01', 'QL-M-ELEC-CNC01', '数控中心电表', 320000, 412500, 1, '', 'kWh', '数控加工中心01', '设备分表']
  ] }),
  createArtifact({ artifactKey: '09-generation-records', order: 9, name: '发电自用', templateType: 'generation-records', formats: ['xlsx', 'csv'], requiredPermission: 'ledger:generation:preview', targetPage: '基础台账/发电自用', postAction: '预演并导入；发电记录不自动写入能耗记录。', dependencies: ['01-organization-root'], rows: [['QL-PARK', '青岚智造园区', '2026-07', 68000, 54000, 14000, 'upload', '园区屋顶光伏']] }),
  createArtifact({ artifactKey: '10-energy-budgets', order: 10, name: '用能预算', templateType: 'energy-budgets', formats: ['xlsx', 'csv'], requiredPermission: 'energy:budget:import', targetPage: '能耗管理/用能预算', postAction: '预演并导入后查看预算与实际对比。', dependencies: ['01-organization-root'], rows: [['2026-08', 'electricity', '青岚智造园区', 470000, 'kWh', '青岚园区月度电力预算', 'active'], ['2026-08', 'natural_gas', '公辅动力站', 20000, 'm3', '动力站天然气预算', 'active']] }),
  createArtifact({ artifactKey: '11-carbon-factors', order: 11, name: '碳因子', templateType: 'carbon-factors', formats: ['xlsx', 'csv'], requiredPermission: 'carbon:factor:import', targetPage: '碳核算/碳因子', postAction: '预演并导入后再执行碳核算。', dependencies: [], rows: [['electricity', 'default', 2026, 'kWh', 0.5703, 'kgCO2e', '青岚演示因子', '', '2026-01-01', '2026-12-31', 'active'], ['natural_gas', 'default', 2026, 'm3', 2.1622, 'kgCO2e', '青岚演示因子', '', '2026-01-01', '2026-12-31', 'active']] }),
  createArtifact({ artifactKey: '12-prediction-configs', order: 12, name: '预测配置', templateType: 'prediction-configs', formats: ['xlsx', 'csv'], requiredPermission: 'prediction:config:import', targetPage: '预测管理', postAction: '导入为草稿，确认训练历史后手工创建预测运行。', dependencies: ['07-monthly-energy'], rows: [['青岚园区电力趋势预测', '基于已入库月度电耗', 'electricity', '青岚智造园区/精密制造一车间', '青岚智造园区', '精密制造一车间', 7, '2026-01', '2026-07', '2026-08', '2026-10', 'moving_average', 3, 'draft']] }),
  createArtifact({ artifactKey: '13-shift-definitions', order: 13, name: '班次定义', templateType: 'shift-definitions', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/配置', postAction: '预演并执行后核对班次版本和启用状态。', dependencies: [], rows: [
    ['QL-SHIFT-DAY', '青岚白班', 480, 1200, 0, DEMO_PARK_SOURCE_TIME_ZONE, '青岚园区排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active'],
    ['QL-SHIFT-NIGHT', '青岚夜班', 1200, 480, 1, DEMO_PARK_SOURCE_TIME_ZONE, '青岚园区排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active']
  ] }),
  createArtifact({ artifactKey: '14-shift-schedules', order: 14, name: '排班计划', templateType: 'shift-schedules', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:operations:preview', targetPage: '能源消费分析/运营记录', postAction: '预演并导入，核对严格 UTC 区间与班次定义版本。', dependencies: ['03-organization-process-equipment', '13-shift-definitions'], rows: [['QL-SHIFT-DAY', '青岚白班', 480, 1200, 0, DEMO_PARK_SOURCE_TIME_ZONE, '青岚园区排班制度', 'QL-SHIFT:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'QL-WORKSHOP-A', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 'QL:shift:20260801:day', 'upload', 'active']] }),
  createArtifact({ artifactKey: '15-energy-timeseries', order: 15, name: '能耗时序', templateType: 'energy-timeseries', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:timeseries:preview', targetPage: '能源消费分析/时序导入', postAction: '预演并导入后执行峰谷和负荷分析。', dependencies: ['04-meters'], rows: [
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:00:00Z', '2026-08-01T00:15:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 320, 'QL:timeseries:cnc01:001', 'upload'],
    ['electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', '2026-08-01T00:15:00Z', '2026-08-01T00:30:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 15, 'kWh', 345, 'QL:timeseries:cnc01:002', 'upload']
  ] }),
  createArtifact({ artifactKey: '16-device-states', order: 16, name: '设备状态', templateType: 'device-states', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:operations:preview', targetPage: '能源消费分析/运营记录', postAction: '预演并导入后与时序数据联查。', dependencies: ['03-organization-process-equipment', '04-meters'], rows: [['QL-M-ELEC-CNC01', 'QL-EQ-CNC-01', 'running', '2026-08-01T00:00:00Z', '2026-08-01T04:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL:device-state:cnc01:001', 'upload']] }),
  createArtifact({ artifactKey: '17-tou-schemes', order: 17, name: 'TOU 方案与时段', templateType: 'tou-schemes', formats: ['xlsx'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/峰谷配置', postAction: '预演并执行后核对方案版本；每天规则须完整覆盖 0 至 1440。', dependencies: [], workbooks: {
    TOU方案: [['QL-TOU-2026', '青岚园区峰平谷方案', DEMO_PARK_SOURCE_TIME_ZONE, '青岚园区用电制度', 'QL-TOU-2026-01', 'QL-TOU:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active']],
    时段规则: Array.from({ length: 7 }, (_value, dayIndex) => [
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'valley', 0, 480],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'flat', 480, 1020],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'peak', 1020, 1320],
      ['QL-TOU-2026', 'QL-TOU:v1', dayIndex + 1, 'valley', 1320, 1440]
    ]).flat()
  } }),
  createArtifact({ artifactKey: '18-strategy-rules', order: 18, name: '策略规则', templateType: 'strategy-rules', formats: ['xlsx', 'csv'], requiredPermission: 'energy:analysis:config:import:preview', targetPage: '能源消费分析/策略配置', postAction: '预演并执行后核对规则版本；导入只保存需人工复核的受控规则。', dependencies: [], rows: [['QL-STRATEGY-PEAK', '峰段能耗偏高提醒', 'strategy-rule:v1', 'load-analysis:v1', 'peak_interval_energy', 'gt', 300, '', '', 'kWh/15min', 0.08, 'high', 0.95, 10, 'window_total_energy', '建议复核峰段设备错峰安排。', '青岚园区能源制度', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '19-conversion-factors', order: 19, name: '能源折标系数', templateType: 'energy-conversion-factors', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/折标系数', postAction: '预演并导入后用于统一折标。', dependencies: [], rows: [['QL-FACTOR-ELEC-2026', 'electricity', 'kWh', 0.1229, 'kgce', 'tce', 1000, '青岚园区能源制度', 'QL-ENERGY-2026', 'electricity-factor:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '20-benchmark-definitions', order: 20, name: '对标定义', templateType: 'energy-benchmark-definitions', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/定义', postAction: '预演并导入后再导入对应目标。', dependencies: ['03-organization-process-equipment'], rows: [['QL-BENCH-INTENSITY', '精密零件单位产品综合能耗', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month', 'organization', 'QL-WORKSHOP-A', 'lower_better', '青岚园区能源管理目标', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '21-benchmark-targets', order: 21, name: '对标目标', templateType: 'energy-benchmark-targets', formats: ['xlsx', 'csv'], requiredPermission: 'energy:benchmarks:import:preview', targetPage: '能效对标/目标', postAction: '预演并导入后执行对标分析。', dependencies: ['20-benchmark-definitions'], rows: [['QL-BENCH-INTENSITY', 128, '', '', '', '', '', '', '', '', '', 0, 0, 'active']] }),
  createArtifact({ artifactKey: '22-energy-flow-models', order: 22, name: '能流模型', templateType: 'energy-flow-models', formats: ['xlsx', 'csv'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/模型', postAction: '预演并导入能流模型；导入后不自动执行能流分析。', dependencies: [], rows: [['QL-FLOW-PARK', '青岚园区综合能流模型', '青岚园区能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'active']] }),
  createArtifact({ artifactKey: '23-energy-flow-nodes', order: 23, name: '能流节点', templateType: 'energy-flow-nodes', formats: ['xlsx', 'csv'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/节点', postAction: '预演并导入后核对节点坐标和组织关联。', dependencies: ['22-energy-flow-models', '03-organization-process-equipment'], rows: [
    ['QL-FLOW-PARK', '青岚园区综合能流模型', '青岚园区能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL-NODE-GRID', '电网输入', 'source', 'QL-PARK', 80, 120, 'active'],
    ['QL-FLOW-PARK', '青岚园区综合能流模型', '青岚园区能源审计', 'QL-FLOW-2026-01', 'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'QL-NODE-WSA', '一车间负荷', 'sink', 'QL-WORKSHOP-A', 360, 120, 'active']
  ] }),
  createArtifact({ artifactKey: '24-energy-flow-edges', order: 24, name: '能流边与显式边值', templateType: 'energy-flow-edges', formats: ['xlsx'], requiredPermission: 'energy:flows:import:preview', targetPage: '能流分析/边', postAction: '预演并导入后执行能流分析。', dependencies: ['23-energy-flow-nodes'], workbooks: {
    能流边: [['QL-FLOW-PARK', 'QL-FLOW:v1', 'QL-EDGE-GRID-WSA', 'QL-NODE-GRID', 'QL-NODE-WSA', 'electricity', 'kWh', 'explicit_edge_value', 'QL:explicit-edge:grid-wsa', 'active']],
    显式边值: [['QL-FLOW-PARK', 'QL-FLOW:v1', 'QL-EDGE-GRID-WSA', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 'kWh', 445000, 'QL:explicit-edge-value:grid-wsa:202607', 'energy-flow:v1', 'active']]
  } }),
  createArtifact({ artifactKey: '25-energy-balance-configs', order: 25, name: '平衡边界与九角色项目', templateType: 'energy-balance-configs', formats: ['xlsx'], requiredPermission: 'energy:balance:import:preview', targetPage: '能效平衡与优化/配置', postAction: '预演并导入平衡配置；导入后不自动计算，请手工发起平衡快照计算。', dependencies: ['07-monthly-energy', '09-generation-records', '24-energy-flow-edges'], workbooks: {
    平衡边界: [['QL-BAL-PARK', '青岚园区综合能效平衡边界', 'QL-PARK', '青岚园区能源审计', 'QL-BAL-2026-01', 'QL-BAL:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', DEMO_PARK_SOURCE_TIME_ZONE, 1, 'active']],
    九角色项目: [
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-INPUT-E', '园区外购电输入', 'input', 'electricity', 'kWh', 'monthly_energy', 'QL:monthly-energy:park:electricity', 'organization=QL-PARK;month=2026-07', '', '', '', '', 'active'],
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-GEN-E', '园区光伏自用', 'self_generation', 'electricity', 'kWh', 'generation', 'QL:generation:park:2026-07', 'organization=QL-PARK;month=2026-07', '', 'self_use_value_kwh', '', 'QL-GEN-PARK-202607', 'active'],
      ['QL-BAL-PARK', 'QL-BAL:v1', 'QL-BAL-USE-E', '园区有用能', 'useful_utilization', 'electricity', 'kWh', 'explicit_balance_value', 'QL:balance:useful-electricity', '', '', '', 470000, '', 'active']
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
    throw new Error(`青岚园区演示数据条目不存在：${artifactKey}`);
  }
  if (sheetName) {
    const sheetRows = artifact.workbooks?.[sheetName];
    if (!sheetRows) {
      throw new Error(`青岚园区演示数据工作表不存在：${artifactKey}/${sheetName}`);
    }
    return sheetRows;
  }
  return artifact.rows || [];
}

/** 断言演示数据静态契约成立，并提供稳定错误上下文。 */
function assertManifestCondition(condition, message) {
  if (!condition) {
    throw new Error(`青岚园区演示数据校验失败：${message}`);
  }
}

/** 校验严格 UTC 秒精度区间，避免把来源时区墙钟时间误当 UTC。 */
function validateStrictUtcRange(startUtc, endUtc, label) {
  const strictUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assertManifestCondition(strictUtcPattern.test(startUtc), `${label} 开始时间不是严格 UTC 秒精度。`);
  assertManifestCondition(strictUtcPattern.test(endUtc), `${label} 结束时间不是严格 UTC 秒精度。`);
  assertManifestCondition(Date.parse(startUtc) < Date.parse(endUtc), `${label} 时间区间无效。`);
}

/** 校验青岚目录中的跨文件业务编码、版本、能源类型和有效期引用。 */
function validateDemoParkCrossReferences() {
  const organizationRows = [
    ...getArtifactRows('01-organization-root'),
    ...getArtifactRows('02-organization-departments'),
    ...getArtifactRows('03-organization-process-equipment')
  ];
  const organizationCodes = new Set(organizationRows.map((row) => row[0]));
  organizationRows.forEach((row) => {
    assertManifestCondition(String(row[0]).startsWith(DEMO_PARK_CODE_PREFIX), `组织编码未使用 ${DEMO_PARK_CODE_PREFIX} 前缀：${row[0]}`);
    if (row[2]) {
      assertManifestCondition(organizationCodes.has(row[2]), `组织父级不存在：${row[0]} -> ${row[2]}`);
    }
  });

  const meterRows = getArtifactRows('04-meters');
  const meterCodes = new Set(meterRows.map((row) => row[0]));
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
  productionUnitRows.forEach((row) => {
    assertManifestCondition(organizationCodes.has(row[2]), `产能单元所属组织不存在：${row[0]} -> ${row[2]}`);
  });
  getArtifactRows('06-production-outputs').forEach((row) => {
    assertManifestCondition(productionUnitCodes.has(row[0]), `月度产量引用的产能单元不存在：${row[0]}`);
  });

  getArtifactRows('07-monthly-energy').forEach((row) => {
    assertManifestCondition(energyTypeCodes.has(row[1]), `月度能耗能源类型不存在：${row[1]}`);
    assertManifestCondition(meterCodes.has(row[9]), `月度能耗引用的仪表不存在：${row[9]}`);
  });
  getArtifactRows('08-meter-readings-2026-08').forEach((row) => {
    assertManifestCondition(meterCodes.has(row[1]), `抄表记录引用的仪表不存在：${row[1]}`);
  });

  const shiftRows = getArtifactRows('13-shift-definitions');
  const shiftVersions = new Set(shiftRows.map((row) => `${row[0]}|${row[7]}`));
  shiftRows.forEach((row) => {
    assertManifestCondition(row[5] === DEMO_PARK_SOURCE_TIME_ZONE, `班次来源时区不一致：${row[0]}`);
    validateStrictUtcRange(row[8], row[9], `班次 ${row[0]}`);
  });
  getArtifactRows('14-shift-schedules').forEach((row) => {
    assertManifestCondition(shiftVersions.has(`${row[0]}|${row[7]}`), `排班引用的班次版本不存在：${row[0]}|${row[7]}`);
    assertManifestCondition(organizationCodes.has(row[10]), `排班引用的组织不存在：${row[10]}`);
    validateStrictUtcRange(row[11], row[12], `排班 ${row[13]}`);
  });

  getArtifactRows('15-energy-timeseries').forEach((row) => {
    assertManifestCondition(energyTypeCodes.has(row[0]), `时序记录能源类型不存在：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[1]), `时序记录引用的组织不存在：${row[1]}`);
    assertManifestCondition(meterCodes.has(row[2]), `时序记录引用的仪表不存在：${row[2]}`);
    validateStrictUtcRange(row[3], row[4], `时序记录 ${row[9]}`);
  });
  getArtifactRows('16-device-states').forEach((row) => {
    assertManifestCondition(meterCodes.has(row[0]), `设备状态引用的仪表不存在：${row[0]}`);
    assertManifestCondition(organizationCodes.has(row[1]), `设备状态引用的组织不存在：${row[1]}`);
    validateStrictUtcRange(row[3], row[4], `设备状态 ${row[6]}`);
  });

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
  getArtifactRows('18-strategy-rules').forEach((row) => validateStrictUtcRange(row[17], row[18], `策略规则 ${row[0]}`));

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

  return true;
}

/** 返回不含业务数据行的青岚园区演示数据目录，并合并静态 handler 治理契约。 */
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

/** 生成单个青岚园区演示文件，全部内容仅在内存中构造。 */
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
  if (template.sheets) {
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
      throw new Error('青岚园区演示数据目录存在重复 key 或顺序。');
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
    artifact.dependencies.forEach((dependencyKey) => {
      const dependency = DEMO_PARK_ARTIFACT_BY_KEY[dependencyKey];
      if (!dependency || dependency.order >= artifact.order) {
        throw new Error(`演示数据依赖不存在或顺序非法：${artifact.artifactKey} -> ${dependencyKey}`);
      }
    });
  });
  assertManifestCondition(artifactKeys.size === 25, 'manifest 必须恰好包含 25 个 artifact。');
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
