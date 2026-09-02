'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  DEMO_ACTUAL_ENERGY_ORGANIZATION,
  DEMO_ACTUAL_ENERGY_ROWS
} = require('../services/demoActualEnergyFixture');
const {
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
  getDemoParkManifestCanonicalJson,
  getDemoParkManifestDigest,
  listDemoParkArtifacts,
  validateDemoParkManifest
} = require('../services/demoParkDatasetService');
const {
  DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES,
  listDemoArtifactRegistrations
} = require('../services/demoArtifactRegistry');
const { SUPPLIER_IMPORT_HEADERS } = require('../services/supplierService');
const {
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_WORKSHEET_NAME
} = require('../services/carbonActivityContracts');
const { CARBON_EMISSION_REPORT_SHEETS } = require('../services/carbonEmissionReportContracts');
const { GHG_REPORT_SHEETS } = require('../services/ghgReportContracts');

// 目录必须完整覆盖预期模板类型；预测历史通过月度能耗条目显式复用，不以固定条目数量限制后续扩展。
const EXPECTED_TEMPLATE_TYPES = Object.freeze([
  'organization-units', 'meters', 'production-units', 'production-outputs', 'energy-records', 'prediction-history',
  'meter-readings', 'generation-records', 'energy-budgets', 'carbon-factors', 'prediction-configs', 'shift-definitions',
  'shift-schedules', 'energy-timeseries', 'device-states', 'tou-schemes', 'strategy-rules', 'energy-conversion-factors',
  'energy-benchmark-definitions', 'energy-benchmark-targets', 'energy-flow-models', 'energy-flow-nodes',
  'energy-flow-edges', 'energy-balance-configs', 'suppliers', 'carbon-activities',
  'carbon-emission-report', 'ghg-report'
]);

// 29 项目标路由逐项冻结；同域多条 artifact 复用真实统一页面，不使用 query/hash 猜测内部标签。
const EXPECTED_TARGET_ROUTES = Object.freeze({
  '01-organization-root': '/ledger/organization',
  '02-organization-departments': '/ledger/organization',
  '03-organization-process-equipment': '/ledger/organization',
  '04-meters': '/ledger/meters',
  '05-production-units': '/ledger/production-units',
  '06-production-outputs': '/ledger/production-output',
  '07-monthly-energy': '/imports',
  '08-meter-readings-2026-08': '/ledger/meter-readings',
  '09-generation-records': '/ledger/generation',
  '10-energy-budgets': '/energy/budgets',
  '11-carbon-factors': '/carbon',
  '12-prediction-configs': '/predictions',
  '13-shift-definitions': '/energy/analysis',
  '14-shift-schedules': '/energy/analysis',
  '15-energy-timeseries': '/energy/analysis',
  '16-device-states': '/energy/analysis',
  '17-tou-schemes': '/energy/analysis',
  '18-strategy-rules': '/energy/analysis',
  '19-conversion-factors': '/energy/benchmarks',
  '20-benchmark-definitions': '/energy/benchmarks',
  '21-benchmark-targets': '/energy/benchmarks',
  '22-energy-flow-models': '/energy/flows',
  '23-energy-flow-nodes': '/energy/flows',
  '24-energy-flow-edges': '/energy/flows',
  '25-energy-balance-configs': '/energy/balances',
  '26-suppliers': '/ledger/suppliers',
  '27-carbon-activities': '/carbon',
  '28-carbon-emission-report': '/carbon',
  '29-ghg-report': '/carbon'
});

/** 读取工作表的实际非空业务行，保留数值类型并忽略模板预格式空行。 */
function readWorkbookBusinessRows(workbook, sheetName) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false
  }).filter((row, index) => index === 0 || row.some((value) => value !== ''));
}

/** 断言用户可见表头全部使用中文业务标题且不暴露技术字段命名。 */
function assertUserVisibleHeaders(actualHeaders, expectedHeaders, contractName) {
  assert.deepStrictEqual(actualHeaders, expectedHeaders, `${contractName} 必须保持准确中文表头和固定顺序。`);
  assert.strictEqual(new Set(actualHeaders).size, actualHeaders.length, `${contractName} 表头不得重复。`);
  assert(!actualHeaders.some((header) => {
    const text = String(header);
    return /^[a-z]+(?:_[a-z0-9]+)+$/i.test(text)
      || (/^[A-Za-z][A-Za-z0-9]*$/.test(text) && /[a-z][A-Z]/.test(text));
  }), `${contractName} 不得暴露 snake_case 或 camelCase 技术字段。`);
}

assert.strictEqual(validateDemoParkManifest(), true);
assert.doesNotThrow(() => validateDemoParkManifest(), 'manifest 必须通过组织、仪表、产能、班次、能流、平衡、能源类型和有效期跨文件校验。');
assert.strictEqual(DEMO_DATASET_ID, 'qinglan-park-v1');
assert.strictEqual(DEMO_MANIFEST_VERSION, '1.7.0');
assert.strictEqual(DEMO_CANONICALIZATION_VERSION, 'canonical-json-v1');
assert.strictEqual(DEMO_PARK_CODE_PREFIX, 'QL-');
assert.strictEqual(DEMO_PARK_SOURCE_TIME_ZONE, 'Asia/Shanghai');
assert.strictEqual(DEMO_PARK_ARTIFACTS.length, 29);
const canonicalPayload = buildDemoParkManifestCanonicalPayload();
const canonicalJson = getDemoParkManifestCanonicalJson();
assert.deepStrictEqual(JSON.parse(canonicalJson), canonicalizeJsonValue(canonicalPayload));
assert.strictEqual(
  JSON.stringify(canonicalizeJsonValue({ z: 1, a: { y: 2, b: 3 } })),
  JSON.stringify(canonicalizeJsonValue({ a: { b: 3, y: 2 }, z: 1 }))
);
assert.strictEqual(getDemoParkManifestDigest(), 'fdee24ea8bb686a8d3174df313b464e3ff3edeaa886384fe31f373499008e503');
const changedCanonicalPayload = structuredClone(canonicalPayload);
changedCanonicalPayload.artifacts[0].postAction = `${changedCanonicalPayload.artifacts[0].postAction}-changed`;
const changedCanonicalJson = JSON.stringify(canonicalizeJsonValue(changedCanonicalPayload));
const changedManifestDigest = require('crypto').createHash('sha256').update(changedCanonicalJson, 'utf8').digest('hex');
assert.notStrictEqual(changedManifestDigest, getDemoParkManifestDigest(), 'manifest 白名单内容变化必须产生不同 digest');
// targetRoute 属于治理白名单元数据，任何修改都必须改变 digest。
const changedTargetRoutePayload = structuredClone(canonicalPayload);
changedTargetRoutePayload.artifacts[0].targetRoute = '/ledger/meters';
const changedTargetRouteDigest = require('crypto').createHash('sha256')
  .update(JSON.stringify(canonicalizeJsonValue(changedTargetRoutePayload)), 'utf8').digest('hex');
assert.notStrictEqual(changedTargetRouteDigest, getDemoParkManifestDigest(), 'targetRoute 变化必须进入 manifest digest。');
assert.deepStrictEqual(
  DEMO_PARK_ARTIFACTS.map((artifact) => artifact.order),
  Array.from({ length: DEMO_PARK_ARTIFACTS.length }, (_, index) => index + 1)
);
assert.strictEqual(
  new Set(DEMO_PARK_ARTIFACTS.map((artifact) => artifact.artifactKey)).size,
  DEMO_PARK_ARTIFACTS.length
);
assert.deepStrictEqual(
  [...new Set(DEMO_PARK_ARTIFACTS.flatMap((artifact) => artifact.coveredTemplateTypes))].sort(),
  [...EXPECTED_TEMPLATE_TYPES].sort()
);
assert.deepStrictEqual(DEMO_PARK_ARTIFACTS.slice(0, 3).map((artifact) => artifact.artifactKey), [
  '01-organization-root',
  '02-organization-departments',
  '03-organization-process-equipment'
]);
const rootOrganizationRows = getDemoParkArtifact('01-organization-root').rows;
assert.strictEqual(rootOrganizationRows.length, 2);
assert.deepStrictEqual(rootOrganizationRows.map((row) => row.slice(0, 5)), [
  ['QL-PARK', '天坤集团', '', '', 'enterprise'],
  ['QL-ACTUAL-PARK', '实际能耗样例企业', '', '', 'enterprise']
]);
assert.deepStrictEqual(rootOrganizationRows.map((row) => row[7]), ['active', 'active']);
assert.deepStrictEqual(rootOrganizationRows[1].slice(0, 2), [
  DEMO_ACTUAL_ENERGY_ORGANIZATION.code,
  DEMO_ACTUAL_ENERGY_ORGANIZATION.name
]);

// 目录响应不得暴露原始行或本地文件路径，并为每个格式提供稳定下载路由。
const manifest = listDemoParkArtifacts();
assert.strictEqual(manifest.length, DEMO_PARK_ARTIFACTS.length);
assert.strictEqual(manifest.reduce((total, artifact) => total + artifact.batchRoles.length, 0), 31);
const monthlyEnergyManifest = manifest.find((artifact) => artifact.artifactKey === '07-monthly-energy');
assert.strictEqual(monthlyEnergyManifest.permissions.execute, 'imports:create');
assert.strictEqual(monthlyEnergyManifest.name, '月度能耗与实际历史');
assert.strictEqual(monthlyEnergyManifest.mode, 'direct-upload');
assert.strictEqual(
  monthlyEnergyManifest.downloadLifecycle,
  DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME
);
assert.strictEqual(monthlyEnergyManifest.blocker.previewExecuteContext, null);
assert(monthlyEnergyManifest.postAction.includes('11 条'));
assert(monthlyEnergyManifest.postAction.includes('59 条'));
assert(monthlyEnergyManifest.postAction.includes('QL-ACTUAL-PARK'));
assert(monthlyEnergyManifest.postAction.includes('无计量器具关联'));
assert(monthlyEnergyManifest.postAction.includes('普通上传即执行'));
assert(monthlyEnergyManifest.postAction.includes('skip'));
// 阶段 A 把 11/27 两类碳输入接入中央 managed context，并冻结各自 ownership 实体类型。
const carbonFactorManifest = manifest.find((artifact) => artifact.artifactKey === '11-carbon-factors');
assert.strictEqual(carbonFactorManifest.downloadLifecycle, DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME);
assert.strictEqual(carbonFactorManifest.handlerKey, 'carbon-factors-import');
assert.deepStrictEqual(carbonFactorManifest.ownershipTargets, ['carbon_factor']);
assert.strictEqual(carbonFactorManifest.blocker.previewExecuteContext, null);
const predictionConfigManifest = manifest.find((artifact) => artifact.artifactKey === '12-prediction-configs');
assert.strictEqual(predictionConfigManifest.downloadLifecycle, DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME);
assert.strictEqual(predictionConfigManifest.handlerKey, 'prediction-configs-import');
assert.deepStrictEqual(predictionConfigManifest.ownershipTargets, ['prediction_config']);
assert.strictEqual(predictionConfigManifest.blocker.previewExecuteContext, null);
assert.deepStrictEqual(predictionConfigManifest.routes.preview, ['/api/predictions/configs/import/preview']);
assert.deepStrictEqual(predictionConfigManifest.routes.execute, ['/api/predictions/configs/import/execute']);
const carbonActivityManifest = manifest.find((artifact) => artifact.artifactKey === '27-carbon-activities');
assert.strictEqual(carbonActivityManifest.downloadLifecycle, DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME);
assert.strictEqual(carbonActivityManifest.handlerKey, 'carbon-activity-import');
assert.deepStrictEqual(carbonActivityManifest.ownershipTargets, ['carbon_activity_record']);
assert.strictEqual(carbonActivityManifest.blocker.previewExecuteContext, null);
assert.deepStrictEqual(manifest.find((artifact) => artifact.artifactKey === '17-tou-schemes').ownershipTargets, ['tou_scheme']);
assert.strictEqual(
  manifest.find((artifact) => artifact.artifactKey === '24-energy-flow-edges')
    .batchRoles.find((item) => item.role === 'record').entityType,
  'energy_flow_record'
);
[19, 20, 21].forEach((order) => {
  assert.deepStrictEqual(manifest[order - 1].guards, ['trusted-body-rebuild']);
});
[22, 23].forEach((order) => {
  assert.deepStrictEqual(manifest[order - 1].guards, ['preview-upload-preflight']);
});
[24, 25].forEach((order) => {
  assert.deepStrictEqual(manifest[order - 1].guards, [
    'preview-upload-preflight',
    'trusted-body-rebuild',
    'execute-stale-preflight'
  ]);
});
manifest.forEach((artifact) => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(artifact, 'rows'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(artifact, 'workbooks'), false);
  assert.strictEqual(typeof artifact.requiredPermission, 'string');
  assert.strictEqual(typeof artifact.targetPage, 'string');
  assert.strictEqual(typeof artifact.targetRoute, 'string');
  assert(artifact.targetRoute.length > 1);
  assert.strictEqual(artifact.targetRoute, EXPECTED_TARGET_ROUTES[artifact.artifactKey]);
  assert(/^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(artifact.targetRoute));
  assert(!artifact.targetRoute.startsWith('//'));
  assert.notStrictEqual(artifact.targetRoute, '/api');
  assert(!artifact.targetRoute.startsWith('/api/'));
  assert(!artifact.targetRoute.includes('?'));
  assert(!artifact.targetRoute.includes('#'));
  assert(!artifact.targetRoute.includes('\\'));
  assert(!/^[a-z][a-z\\d+.-]*:/i.test(artifact.targetRoute));
  assert.strictEqual(typeof artifact.postAction, 'string');
  artifact.formats.forEach((format) => {
    assert.strictEqual(artifact.downloads[format], `/api/templates/demo-park/${artifact.artifactKey}.${format}`);
  });
});
assert.strictEqual(Object.keys(EXPECTED_TARGET_ROUTES).length, 29);
assert.deepStrictEqual(
  canonicalPayload.artifacts.map((artifact) => [artifact.artifactKey, artifact.targetRoute]),
  DEMO_PARK_ARTIFACTS.map((artifact) => [artifact.artifactKey, EXPECTED_TARGET_ROUTES[artifact.artifactKey]])
);

// 路由 path 与 componentMap 只读静态源码合同，避免测试运行浏览器或让前端猜测目标页面。
const ROUTE_COMPONENT_CONTRACTS = Object.freeze({
  '/imports': 'imports/index',
  '/energy/analysis': 'energy/analysis/index',
  '/energy/benchmarks': 'energy/benchmarks/index',
  '/energy/flows': 'energy/flows/index',
  '/energy/balances': 'energy/balances/index',
  '/energy/budgets': 'energy/budgets/index',
  '/ledger/organization': 'ledger/organization/index',
  '/ledger/meters': 'ledger/meters/index',
  '/ledger/meter-readings': 'ledger/meter-readings/index',
  '/ledger/generation': 'ledger/generation/index',
  '/ledger/production-units': 'ledger/production-units/index',
  '/ledger/production-output': 'ledger/production-output/index',
  '/ledger/suppliers': 'ledger/suppliers/index',
  '/carbon': 'carbon/index',
  '/predictions': 'predictions/index'
});
const clientRouterSource = fs.readFileSync(path.resolve(__dirname, '../../../client/src/router/index.js'), 'utf8');
const serverMenuSeedSource = fs.readFileSync(path.resolve(__dirname, '../db/database.js'), 'utf8');
Object.entries(ROUTE_COMPONENT_CONTRACTS).forEach(([targetRoute, componentKey]) => {
  assert(clientRouterSource.includes(`'${componentKey}':`), `componentMap 缺少 ${componentKey}。`);
  assert(serverMenuSeedSource.includes(`'${targetRoute}', '${componentKey}'`),
    `RBAC 动态菜单缺少 ${targetRoute} -> ${componentKey}。`);
});
assert.strictEqual(
  new Set(manifest.map((artifact) => artifact.targetRoute)).size,
  Object.keys(ROUTE_COMPONENT_CONTRACTS).length,
  '29 项 targetRoute 应复用已登记的有限真实页面集合。'
);
assert.strictEqual(getDemoParkArtifact('__proto__'), null);
assert.strictEqual(getDemoParkArtifact('missing'), null);

// 组织分层必须只引用前序 artifact 已存在的父级，保证每项首次导入即全量成功。
const organizationDepartmentCodes = new Set([
  ...getDemoParkArtifact('01-organization-root').rows,
  ...getDemoParkArtifact('02-organization-departments').rows
].map((row) => row[0]));
getDemoParkArtifact('03-organization-process-equipment').rows.forEach((row) => {
  assert(organizationDepartmentCodes.has(row[2]), `artifact 03 父级必须已由前序条目导入：${row[0]} -> ${row[2]}`);
});

// artifact 07 保留原有 11 条联动事实，并追加独立企业实际样例的 59 条正式能耗模板行。
const monthlyEnergyRows = getDemoParkArtifact('07-monthly-energy').rows;
assert.strictEqual(monthlyEnergyRows.length, 70);
assert.deepStrictEqual(monthlyEnergyRows.slice(0, 11), [
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
]);
assert.deepStrictEqual(monthlyEnergyRows.slice(11), DEMO_ACTUAL_ENERGY_ROWS);
assert.strictEqual(monthlyEnergyRows.filter((row) => row[4] === 'QL-ACTUAL-PARK').length, 59);
assert.strictEqual(monthlyEnergyRows.filter((row) => row[4] === 'QL-PARK').length, 8);
assert(monthlyEnergyRows.slice(11).every((row) => row[5] === ''));
assert.strictEqual(new Set(monthlyEnergyRows.map((row) => [row[0], row[1], row[3], row[4], row[5] || 'direct'].join('|'))).size, 70);

// 预测历史和筛选值必须精确匹配生产服务的等值查询契约。
const electricityHistoryRows = monthlyEnergyRows.filter((row) => (
  row[0] >= '2026-01'
  && row[0] <= '2026-07'
  && row[1] === 'electricity'
  && row[4] === 'QL-PARK'
  && row[5] === 'QL-M-ELEC-PARK'
));
assert.deepStrictEqual(electricityHistoryRows.map((row) => row[0]), [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'
]);
const predictionConfigRow = getDemoParkArtifact('12-prediction-configs').rows[0];
assert.strictEqual(predictionConfigRow[3], electricityHistoryRows[0][4]);
assert.strictEqual(predictionConfigRow[4], electricityHistoryRows[0][5]);
assert.strictEqual(predictionConfigRow[5], '', '静态 manifest 不得绑定 SQLite 自增批次 ID。');
assert.deepStrictEqual(predictionConfigRow.slice(6, 10), ['2026-01', '2026-07', '2026-08', '2026-10']);

// 2026-08 必须同时具备精确预算实际和真实单位产品能耗交集。
const precisionOutputRows = getDemoParkArtifact('06-production-outputs').rows
  .filter((row) => row[0] === 'QL-PU-PRECISION');
assert.deepStrictEqual(precisionOutputRows.map((row) => row[2]), ['2026-06', '2026-07', '2026-08']);
assert.deepStrictEqual(precisionOutputRows[2].slice(2, 5), ['2026-08', 1320, 't']);
const augustParkElectricity = monthlyEnergyRows.find((row) => row[0] === '2026-08' && row[1] === 'electricity' && row[4] === 'QL-PARK');
const augustUtilityGas = monthlyEnergyRows.find((row) => row[0] === '2026-08' && row[1] === 'natural_gas' && row[4] === 'QL-UTILITY');
const augustWorkshopElectricity = monthlyEnergyRows.find((row) => row[0] === '2026-08' && row[1] === 'electricity' && row[4] === 'QL-WORKSHOP-A');
assert.deepStrictEqual(augustParkElectricity.slice(0, 6), ['2026-08', 'electricity', 458000, 'kWh', 'QL-PARK', 'QL-M-ELEC-PARK']);
assert.deepStrictEqual(augustUtilityGas.slice(0, 6), ['2026-08', 'natural_gas', 19300, 'm3', 'QL-UTILITY', 'QL-M-GAS-UTILITY']);
assert.deepStrictEqual(augustWorkshopElectricity.slice(0, 6), ['2026-08', 'electricity', 138000, 'kWh', 'QL-WORKSHOP-A', '']);
const budgetRows = getDemoParkArtifact('10-energy-budgets').rows;
assert.deepStrictEqual(budgetRows.map((row) => row.slice(0, 5)), [
  ['2026-08', 'electricity', '天坤集团', 470000, 'kWh'],
  ['2026-08', 'natural_gas', '公辅动力站', 20000, 'm3']
]);

// 抄表仍只保存原始事实；园区总表与 artifact 07 直接事实同表同月同值，后续预演按 conflict 受控跳过，CNC 分表保持可生成。
const readingArtifact = getDemoParkArtifact('08-meter-readings-2026-08');
assert.strictEqual(readingArtifact.postAction, '导入后仅形成抄表记录；QL-M-ELEC-PARK 园区总表用量与 artifact 07 同月同表直接结算事实一致，受控生成预演应以 conflict 正常跳过且不视为错误；CNC 分表仍应形成 wouldGenerate 候选，不自动写入能耗记录。');
assert(readingArtifact.rows.every((row) => row[9].includes('不自动进入月度能耗')));
const augustParkReading = readingArtifact.rows.find((row) => row[1] === 'QL-M-ELEC-PARK');
assert(augustParkReading);
assert.deepStrictEqual(augustParkReading.slice(0, 9), [
  '2026-08-01', 'QL-M-ELEC-PARK', '园区总进线电表', 1250000, 1708000, 1, '', 'kWh', '天坤集团'
]);
assert.strictEqual((Number(augustParkReading[4]) - Number(augustParkReading[3])) * Number(augustParkReading[5]), augustParkElectricity[2]);
assert.strictEqual(getDemoParkArtifact('07-monthly-energy').postAction, '创建导入批次；保留天坤集团现有预测、预算、抄表联动的 11 条事实，并追加实际能耗样例企业 QL-ACTUAL-PARK 的 59 条历史实际；实际样例企业无计量器具关联，下载后普通上传即执行，重复记录按 skip 处理；2026-08 天坤集团园区总表 QL-M-ELEC-PARK conflict 及后续联动边界保持不变，conflict 为正常受控跳过，不视为错误。');

// 固定窗口必须恰好包含 16 条连续、唯一来源键的 15 分钟时序事实。
const timeseriesRows = getDemoParkArtifact('15-energy-timeseries').rows;
assert.strictEqual(timeseriesRows.length, 16);
assert.strictEqual(new Set(timeseriesRows.map((row) => row[9])).size, 16);
assert.strictEqual(timeseriesRows[0][3], '2026-08-01T00:00:00Z');
assert.strictEqual(timeseriesRows[timeseriesRows.length - 1][4], '2026-08-01T04:00:00Z');
assert.strictEqual(timeseriesRows.reduce((total, row) => total + row[8], 0), 5270);
assert.strictEqual(Math.max(...timeseriesRows.map((row) => row[8])), 410);
timeseriesRows.forEach((row, index) => {
  assert.deepStrictEqual([row[0], row[1], row[2], row[5], row[6], row[7]], [
    'electricity', 'QL-EQ-CNC-01', 'QL-M-ELEC-CNC01', 'Asia/Shanghai', 15, 'kWh'
  ]);
  assert.strictEqual(Date.parse(row[4]) - Date.parse(row[3]), 15 * 60 * 1000);
  if (index > 0) assert.strictEqual(timeseriesRows[index - 1][4], row[3]);
});
const shiftScheduleRow = getDemoParkArtifact('14-shift-schedules').rows[0];
const deviceStateRow = getDemoParkArtifact('16-device-states').rows[0];
assert.strictEqual(shiftScheduleRow[10], 'QL-EQ-CNC-01');
assert(Date.parse(shiftScheduleRow[11]) <= Date.parse(timeseriesRows[0][3]));
assert(Date.parse(shiftScheduleRow[12]) >= Date.parse(timeseriesRows[timeseriesRows.length - 1][4]));
assert.deepStrictEqual(deviceStateRow.slice(0, 6), [
  'QL-M-ELEC-CNC01', 'QL-EQ-CNC-01', 'running',
  '2026-08-01T00:00:00Z', '2026-08-01T04:00:00Z', 'Asia/Shanghai'
]);

// 策略、折标、对标与能流示例必须使用生产规范化函数支持的稳定契约。
const strategyRow = getDemoParkArtifact('18-strategy-rules').rows[0];
assert.deepStrictEqual([strategyRow[2], strategyRow[3], strategyRow[4], strategyRow[6], strategyRow[9]], [
  'strategy-rule:v1', 'load-analysis:v1', 'peak_interval_energy', 300, 'kWh/15min'
]);
assert.strictEqual(getDemoParkArtifact('19-conversion-factors').rows[0][9], 'electricity-factor:v1');
const benchmarkDefinitionRow = getDemoParkArtifact('20-benchmark-definitions').rows[0];
assert.strictEqual(benchmarkDefinitionRow.length, 14);
assert.deepStrictEqual(
  [benchmarkDefinitionRow[2], benchmarkDefinitionRow[9], benchmarkDefinitionRow[10], benchmarkDefinitionRow[11]],
  ['manual_benchmark', '天坤集团能源管理目标', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z']
);
const benchmarkTargetRow = getDemoParkArtifact('21-benchmark-targets').rows[0];
assert.strictEqual(benchmarkTargetRow.length, 14);
assert.strictEqual(benchmarkTargetRow[1], 128);
assert(benchmarkTargetRow.slice(4, 11).every((value) => value === ''));
assert.deepStrictEqual([benchmarkTargetRow[11], benchmarkTargetRow[12]], [0, 0]);
assert.strictEqual(getDemoParkArtifact('23-energy-flow-nodes').rows[1][10], 'sink');

// 单工作表条目应按模板表头生成多行 XLSX/CSV，且业务编码统一使用 QL- 前缀。
const shiftArtifact = getDemoParkArtifact('13-shift-definitions');
assert(shiftArtifact.rows.every((row) => String(row[0]).startsWith('QL-')));
const shiftXlsx = generateDemoParkArtifact('13-shift-definitions', 'xlsx');
const shiftWorkbook = XLSX.read(shiftXlsx.buffer, { type: 'buffer' });
assert.deepStrictEqual(shiftWorkbook.SheetNames, ['班次定义']);
const shiftRows = XLSX.utils.sheet_to_json(shiftWorkbook.Sheets['班次定义'], { header: 1, blankrows: false });
assert.strictEqual(shiftRows.length, 3);
assert.strictEqual(shiftRows[1][0], 'QL-SHIFT-DAY');
assert.strictEqual(shiftRows[1][5], 'Asia/Shanghai');
assert.strictEqual(shiftArtifact.rows[0][8], '2025-01-01T00:00:00Z');
assert.strictEqual(shiftRows[1][8], '2025-01-01 00:00:00');
const shiftCsv = generateDemoParkArtifact('13-shift-definitions', 'csv');
assert.deepStrictEqual([...shiftCsv.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
assert.strictEqual(shiftCsv.buffer.toString('utf8').includes('QL-SHIFT-NIGHT'), true);

// 精确多工作表条目不得增加说明表，且必须拒绝 CSV。
for (const contract of [
  { key: '17-tou-schemes', sheets: ['TOU方案', '时段规则'] },
  { key: '24-energy-flow-edges', sheets: ['能流边', '显式边值'] },
  { key: '25-energy-balance-configs', sheets: ['平衡边界', '九角色项目'] }
]) {
  const result = generateDemoParkArtifact(contract.key, 'xlsx');
  const workbook = XLSX.read(result.buffer, { type: 'buffer' });
  assert.deepStrictEqual(workbook.SheetNames, contract.sheets);
  assert.throws(
    () => generateDemoParkArtifact(contract.key, 'csv'),
    (error) => error.code === 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED'
      && error.details.artifactKey === contract.key
  );
}

// TOU 天坤集团示例必须显式包含七天完整覆盖，而不是仅依赖模板首日示例。
const touArtifact = getDemoParkArtifact('17-tou-schemes');
const touRules = touArtifact.workbooks['时段规则'];
assert.strictEqual(touRules.length, 28);
for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
  const dayRules = touRules.filter((row) => row[2] === dayOfWeek).sort((left, right) => left[4] - right[4]);
  assert.strictEqual(dayRules.length, 4);
  assert.strictEqual(dayRules[0][4], 0);
  assert.strictEqual(dayRules[dayRules.length - 1][5], 1440);
  dayRules.slice(1).forEach((row, index) => assert.strictEqual(dayRules[index][5], row[4]));
}
const flowModelPostAction = manifest.find((artifact) => artifact.artifactKey === '22-energy-flow-models').postAction;
assert.strictEqual(flowModelPostAction, '预演并导入能流模型；导入后不自动执行能流分析。');
assert(flowModelPostAction.includes('不自动执行能流分析'));
const balanceConfigPostAction = manifest.find((artifact) => artifact.artifactKey === '25-energy-balance-configs').postAction;
assert.strictEqual(balanceConfigPostAction, '预演并导入平衡配置；导入后不自动计算，请手工发起平衡快照计算。');
assert(balanceConfigPostAction.includes('不自动计算'));
assert(balanceConfigPostAction.includes('手工发起平衡快照计算'));
['13-shift-definitions', '17-tou-schemes', '18-strategy-rules', '22-energy-flow-models', '25-energy-balance-configs']
  .forEach((artifactKey) => {
    assert(!manifest.find((artifact) => artifact.artifactKey === artifactKey).postAction.includes('后续'));
  });

// 历史单表模板也必须注入天坤集团数据而非模板默认烟测样例。
const organizationXlsx = generateDemoParkArtifact('01-organization-root', 'xlsx');
const organizationWorkbook = XLSX.read(organizationXlsx.buffer, { type: 'buffer' });
const organizationRows = readWorkbookBusinessRows(organizationWorkbook, '用能单元模板');
assert.strictEqual(organizationRows.length, 3);
assert.deepStrictEqual(organizationRows.slice(1).map((row) => row.slice(0, 5)), [
  ['QL-PARK', '天坤集团', '', '', 'enterprise'],
  ['QL-ACTUAL-PARK', '实际能耗样例企业', '', '', 'enterprise']
]);

// artifact 07 下载继续使用正式中文表头，并完整输出 70 条业务行且不暴露根目录 Excel 复合表头。
const monthlyEnergyXlsx = generateDemoParkArtifact('07-monthly-energy', 'xlsx');
assert.strictEqual(monthlyEnergyXlsx.fileName, '07-月度能耗与实际历史.xlsx');
const monthlyEnergyWorkbook = XLSX.read(monthlyEnergyXlsx.buffer, { type: 'buffer' });
const monthlyEnergyWorkbookRows = readWorkbookBusinessRows(monthlyEnergyWorkbook, '能耗导入模板');
assertUserVisibleHeaders(monthlyEnergyWorkbookRows[0], ['月份', '能源类型编码', '用量', '单位', '用能单元编码', '计量器具编码', '备注'], '07 月度能耗');
assert.strictEqual(monthlyEnergyWorkbookRows.length - 1, 70);
assert.strictEqual(monthlyEnergyWorkbookRows.filter((row) => row[4] === 'QL-ACTUAL-PARK').length, 59);
assert(!monthlyEnergyWorkbookRows.flat().some((cell) => ['合计', 'Q', 'R', '产值', '产量', '折标', '强度'].includes(String(cell))));
const monthlyEnergyCsv = generateDemoParkArtifact('07-monthly-energy', 'csv');
assert.strictEqual(monthlyEnergyCsv.fileName, '07-月度能耗与实际历史.csv');
assert.deepStrictEqual([...monthlyEnergyCsv.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
assert.strictEqual(monthlyEnergyCsv.buffer.toString('utf8').split(/\r?\n/).filter(Boolean).length, 71);

// 26、28、29 正式无状态模板必须冻结 XLSX-only、中文表头、用户可见名称和业务事实投影。
const registry = listDemoArtifactRegistrations();
assert.strictEqual(registry.length, 29);
const statelessFormalArtifactKeys = ['26-suppliers', '28-carbon-emission-report', '29-ghg-report'];
statelessFormalArtifactKeys.forEach((artifactKey) => {
  const registration = registry.find((item) => item.artifactKey === artifactKey);
  assert(registration, `${artifactKey} 必须存在 registry 注册项。`);
  assert.strictEqual(registration.downloadLifecycle, DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.STATELESS_FORMAL_IMPORT);
  assert(registration.blocker.previewExecuteContext, `${artifactKey} 不得误报中央 context 已接入。`);
  assert.deepStrictEqual(registration.routes.download, [`/api/templates/demo-park/${artifactKey}.xlsx`]);
  assert.strictEqual(registration.routes.download.some((route) => route.endsWith('.csv')), false);
  assert.strictEqual(registration.routes.preview.length, 1);
  assert.strictEqual(registration.routes.execute.length, 1);
});
const managedCarbonActivityRegistration = registry.find((item) => item.artifactKey === '27-carbon-activities');
assert.strictEqual(
  managedCarbonActivityRegistration.downloadLifecycle,
  DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME
);
assert.strictEqual(managedCarbonActivityRegistration.blocker.previewExecuteContext, null);
assert.deepStrictEqual(managedCarbonActivityRegistration.ownershipTargets, ['carbon_activity_record']);
assert.deepStrictEqual(managedCarbonActivityRegistration.routes.download, ['/api/templates/demo-park/27-carbon-activities.xlsx']);

const supplierArtifact = getDemoParkArtifact('26-suppliers');
const supplierWorkbookResult = generateDemoParkArtifact('26-suppliers', 'xlsx');
const supplierWorkbook = XLSX.read(supplierWorkbookResult.buffer, { type: 'buffer', cellNF: true });
assert.deepStrictEqual(supplierWorkbook.SheetNames, ['供应商']);
const supplierRows = readWorkbookBusinessRows(supplierWorkbook, '供应商');
assertUserVisibleHeaders(supplierRows[0], SUPPLIER_IMPORT_HEADERS, '26 供应商');
assert.strictEqual(supplierRows.length - 1, supplierArtifact.rows.length);
assert(supplierRows.length >= 4, '26 供应商必须至少包含三行真实演示数据。');
assert.deepStrictEqual(supplierRows.slice(1).map((row) => row[0]), ['QL-SUP-ELECTRIC', 'QL-SUP-GAS', 'QL-SUP-LEGACY']);
assert.deepStrictEqual(supplierRows.slice(1).map((row) => row[6]), ['合作中', '合作中', '已踢出']);
assert.strictEqual(supplierRows[1][4], '010-66001234', '26 联系电话必须保持前导 0 文本。');
assert.strictEqual(supplierWorkbook.Sheets['供应商'].E2.t, 's');
assert.strictEqual(generateDemoParkArtifact('26-suppliers', 'xlsx').fileName, '26-供应商台账.xlsx');
assert.throws(() => generateDemoParkArtifact('26-suppliers', 'csv'), (error) => (
  error.code === 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED' && error.details.supportedFormats[0] === 'xlsx'
));

const carbonActivityArtifact = getDemoParkArtifact('27-carbon-activities');
const carbonActivityWorkbookResult = generateDemoParkArtifact('27-carbon-activities', 'xlsx');
const carbonActivityWorkbook = XLSX.read(carbonActivityWorkbookResult.buffer, { type: 'buffer', cellNF: true });
assert.deepStrictEqual(carbonActivityWorkbook.SheetNames, [CARBON_ACTIVITY_WORKSHEET_NAME]);
const carbonActivityRows = readWorkbookBusinessRows(carbonActivityWorkbook, CARBON_ACTIVITY_WORKSHEET_NAME);
assertUserVisibleHeaders(carbonActivityRows[0], CARBON_ACTIVITY_IMPORT_HEADERS, '27 独立碳活动');
assert.strictEqual(carbonActivityRows.length - 1, 2);
carbonActivityRows.slice(1).forEach((row, index) => {
  assert(String(row[0]).startsWith('QL-CA-'));
  assert.strictEqual(row[8], DEMO_PARK_SOURCE_TIME_ZONE);
  assert.strictEqual(row[6], '2026-08-01 00:00:00', `27 第 ${index + 1} 行开始时间必须保持 Asia/Shanghai 墙钟投影。`);
  assert.strictEqual(row[7], '2026-09-01 00:00:00', `27 第 ${index + 1} 行结束时间必须保持 Asia/Shanghai 墙钟投影。`);
  assert(['electricity', 'natural_gas'].includes(row[5]));
  assert(['QL-PARK', 'QL-UTILITY'].includes(row[4]));
  assert(Number(row[9]) > 0);
  assert(String(row[10]).length > 0);
  assert(String(row[12]).startsWith('QL:'));
  assert(String(row[13]).startsWith('QL-EVID-'));
});
assert.deepStrictEqual(carbonActivityArtifact.rows.map((row) => row[4]), ['QL-PARK', 'QL-UTILITY']);
assert.throws(() => generateDemoParkArtifact('27-carbon-activities', 'csv'), (error) => (
  error.code === 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED'
));

const carbonEmissionArtifact = getDemoParkArtifact('28-carbon-emission-report');
const carbonEmissionWorkbookResult = generateDemoParkArtifact('28-carbon-emission-report', 'xlsx');
const carbonEmissionWorkbook = XLSX.read(carbonEmissionWorkbookResult.buffer, { type: 'buffer', cellNF: true });
assert.deepStrictEqual(carbonEmissionWorkbook.SheetNames, CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));
const carbonEmissionSheetRows = Object.fromEntries(CARBON_EMISSION_REPORT_SHEETS.map((sheet) => [
  sheet.key,
  readWorkbookBusinessRows(carbonEmissionWorkbook, sheet.name)
]));
CARBON_EMISSION_REPORT_SHEETS.forEach((sheet) => {
  assertUserVisibleHeaders(carbonEmissionSheetRows[sheet.key][0], sheet.headers, `28 ${sheet.name}`);
  assert(carbonEmissionSheetRows[sheet.key].length > 1, `28 ${sheet.name} 必须包含非空业务数据。`);
});
assert.strictEqual(carbonEmissionSheetRows.report[1][0], 'QL-CER-2026-08');
assert.strictEqual(carbonEmissionSheetRows.report[1][2], '天坤集团');
assert.deepStrictEqual(carbonEmissionSheetRows.report[1].slice(3, 5), ['2026-08-01', '2026-08-31']);
assert.deepStrictEqual(carbonEmissionSheetRows.items.slice(1).map((row) => row[0]), [
  'QL-CER-ITEM-ELECTRICITY-202608', 'QL-CER-ITEM-GAS-202608'
]);
const carbonEmissionTotal = Number(carbonEmissionSheetRows.summaries.slice(1).find((row) => row[0] === 'QL-CER-TOTAL-202608')[3]);
const carbonEmissionItemTotal = carbonEmissionSheetRows.items.slice(1).reduce((total, row) => total + Number(row[8]), 0);
assert.strictEqual(Math.round(carbonEmissionTotal * 1e9), Math.round(carbonEmissionItemTotal * 1e9));
const carbonEvidenceCodes = new Set(carbonEmissionSheetRows.evidence.slice(1).map((row) => row[0]));
assert(carbonEmissionSheetRows.items.slice(1).every((row) => carbonEvidenceCodes.has(row[10])));
assert.throws(() => generateDemoParkArtifact('28-carbon-emission-report', 'csv'), (error) => (
  error.code === 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED'
));

const ghgArtifact = getDemoParkArtifact('29-ghg-report');
const ghgWorkbookResult = generateDemoParkArtifact('29-ghg-report', 'xlsx');
const ghgWorkbook = XLSX.read(ghgWorkbookResult.buffer, { type: 'buffer', cellNF: true });
assert.deepStrictEqual(ghgWorkbook.SheetNames, GHG_REPORT_SHEETS.map((sheet) => sheet.name));
const ghgSheetRows = Object.fromEntries(GHG_REPORT_SHEETS.map((sheet) => [
  sheet.key,
  readWorkbookBusinessRows(ghgWorkbook, sheet.name)
]));
GHG_REPORT_SHEETS.forEach((sheet) => {
  assertUserVisibleHeaders(ghgSheetRows[sheet.key][0], sheet.headers, `29 ${sheet.name}`);
  assert(ghgSheetRows[sheet.key].length > 1, `29 ${sheet.name} 必须包含非空业务数据。`);
});
assert.strictEqual(ghgSheetRows.report[1][0], 'QL-GHG-2026-08');
assert.strictEqual(ghgSheetRows.report[1][2], '天坤集团');
assert.deepStrictEqual(ghgSheetRows.report[1].slice(3, 5), ['2026-08-01', '2026-08-31']);
const ghgItems = ghgSheetRows.items.slice(1);
assert(ghgItems.every((row) => row[1] === '排放'));
assert(ghgItems.every((row) => Number(row[8]) === Number(row[10])));
const ghgSummaryRows = ghgSheetRows.summaries.slice(1);
ghgSummaryRows.forEach((row) => {
  assert.strictEqual(Number(row[5]), Number(row[3]) - Number(row[4]), `29 ${row[0]} 必须满足净值=排放-清除。`);
  assert.strictEqual(Number(row[4]), 0, `29 ${row[0]} 清除量必须为零。`);
});
const ghgTotal = ghgSummaryRows.find((row) => row[0] === 'QL-GHG-TOTAL-202608');
assert.strictEqual(Math.round(Number(ghgTotal[3]) * 1e9), Math.round(ghgItems.reduce((total, row) => total + Number(row[10]), 0) * 1e9));
const ghgEvidenceCodes = new Set(ghgSheetRows.evidence.slice(1).map((row) => row[0]));
assert(ghgItems.every((row) => ghgEvidenceCodes.has(row[13])));
assert.strictEqual(ghgArtifact.rows, null);
assert.throws(() => generateDemoParkArtifact('29-ghg-report', 'csv'), (error) => (
  error.code === 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED'
));

console.log('demo park dataset service tests passed');
