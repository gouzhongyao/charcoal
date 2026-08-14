'use strict';

const assert = require('assert');
const XLSX = require('xlsx');
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

// 目录必须完整覆盖预期模板类型；预测历史通过月度能耗条目显式复用，不以固定条目数量限制后续扩展。
const EXPECTED_TEMPLATE_TYPES = Object.freeze([
  'organization-units', 'meters', 'production-units', 'production-outputs', 'energy-records', 'prediction-history',
  'meter-readings', 'generation-records', 'energy-budgets', 'carbon-factors', 'prediction-configs', 'shift-definitions',
  'shift-schedules', 'energy-timeseries', 'device-states', 'tou-schemes', 'strategy-rules', 'energy-conversion-factors',
  'energy-benchmark-definitions', 'energy-benchmark-targets', 'energy-flow-models', 'energy-flow-nodes',
  'energy-flow-edges', 'energy-balance-configs'
]);

assert.strictEqual(validateDemoParkManifest(), true);
assert.doesNotThrow(() => validateDemoParkManifest(), 'manifest 必须通过组织、仪表、产能、班次、能流、平衡、能源类型和有效期跨文件校验。');
assert.strictEqual(DEMO_DATASET_ID, 'qinglan-park-v1');
assert.strictEqual(DEMO_MANIFEST_VERSION, '1.0.0');
assert.strictEqual(DEMO_CANONICALIZATION_VERSION, 'canonical-json-v1');
assert.strictEqual(DEMO_PARK_CODE_PREFIX, 'QL-');
assert.strictEqual(DEMO_PARK_SOURCE_TIME_ZONE, 'Asia/Shanghai');
assert.strictEqual(DEMO_PARK_ARTIFACTS.length, 25);
const canonicalPayload = buildDemoParkManifestCanonicalPayload();
const canonicalJson = getDemoParkManifestCanonicalJson();
assert.deepStrictEqual(JSON.parse(canonicalJson), canonicalizeJsonValue(canonicalPayload));
assert.strictEqual(
  JSON.stringify(canonicalizeJsonValue({ z: 1, a: { y: 2, b: 3 } })),
  JSON.stringify(canonicalizeJsonValue({ a: { b: 3, y: 2 }, z: 1 }))
);
assert.strictEqual(getDemoParkManifestDigest(), '87daf9dccf6d5baf52f74637464a32209d070b28f23764abd0a07e62ee60df09');
const changedCanonicalPayload = structuredClone(canonicalPayload);
changedCanonicalPayload.artifacts[0].postAction = `${changedCanonicalPayload.artifacts[0].postAction}-changed`;
const changedCanonicalJson = JSON.stringify(canonicalizeJsonValue(changedCanonicalPayload));
const changedManifestDigest = require('crypto').createHash('sha256').update(changedCanonicalJson, 'utf8').digest('hex');
assert.notStrictEqual(changedManifestDigest, getDemoParkManifestDigest(), 'manifest 白名单内容变化必须产生不同 digest');
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

// 目录响应不得暴露原始行或本地文件路径，并为每个格式提供稳定下载路由。
const manifest = listDemoParkArtifacts();
assert.strictEqual(manifest.length, DEMO_PARK_ARTIFACTS.length);
assert.strictEqual(manifest.reduce((total, artifact) => total + artifact.batchRoles.length, 0), 27);
assert.strictEqual(manifest.find((artifact) => artifact.artifactKey === '07-monthly-energy').permissions.execute, 'imports:create');
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
  assert.strictEqual(typeof artifact.postAction, 'string');
  artifact.formats.forEach((format) => {
    assert.strictEqual(artifact.downloads[format], `/api/templates/demo-park/${artifact.artifactKey}.${format}`);
  });
});
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

// 预测历史和筛选值必须精确匹配生产服务的等值查询契约。
const monthlyEnergyRows = getDemoParkArtifact('07-monthly-energy').rows;
const electricityHistoryRows = monthlyEnergyRows.filter((row) => row[1] === 'electricity');
assert.deepStrictEqual(electricityHistoryRows.map((row) => row[0]), [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'
]);
const predictionConfigRow = getDemoParkArtifact('12-prediction-configs').rows[0];
assert.strictEqual(predictionConfigRow[3], electricityHistoryRows[0][5]);
assert.strictEqual(predictionConfigRow[4], electricityHistoryRows[0][6]);
assert.strictEqual(predictionConfigRow[5], electricityHistoryRows[0][7]);
assert.strictEqual(predictionConfigRow[6], 7);
assert.deepStrictEqual(predictionConfigRow.slice(7, 11), ['2026-01', '2026-07', '2026-08', '2026-10']);

// 策略、折标、对标与能流示例必须使用生产规范化函数支持的稳定契约。
const strategyRow = getDemoParkArtifact('18-strategy-rules').rows[0];
assert.deepStrictEqual([strategyRow[2], strategyRow[3], strategyRow[4], strategyRow[6], strategyRow[9]], [
  'strategy-rule:v1', 'load-analysis:v1', 'peak_interval_energy', 300, 'kWh/15min'
]);
assert.strictEqual(getDemoParkArtifact('19-conversion-factors').rows[0][9], 'electricity-factor:v1');
const benchmarkDefinitionRow = getDemoParkArtifact('20-benchmark-definitions').rows[0];
assert.deepStrictEqual([benchmarkDefinitionRow[2], benchmarkDefinitionRow[11]], ['manual_benchmark', 'energy-benchmark:v1']);
const benchmarkTargetRow = getDemoParkArtifact('21-benchmark-targets').rows[0];
assert.deepStrictEqual([benchmarkTargetRow[1], benchmarkTargetRow[14]], ['energy-benchmark:v1', 'benchmark-target:v1']);
assert(benchmarkTargetRow.slice(5, 12).every((value) => value === ''));
assert.deepStrictEqual([benchmarkTargetRow[12], benchmarkTargetRow[13]], [0, 0]);
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
assert.strictEqual(shiftRows[1][8], '2025-01-01T00:00:00Z');
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

// TOU 青岚示例必须显式包含七天完整覆盖，而不是仅依赖模板首日示例。
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

// 历史单表模板也必须注入青岚数据而非模板默认烟测样例。
const organizationXlsx = generateDemoParkArtifact('01-organization-root', 'xlsx');
const organizationWorkbook = XLSX.read(organizationXlsx.buffer, { type: 'buffer' });
const organizationRows = XLSX.utils.sheet_to_json(organizationWorkbook.Sheets['用能单元模板'], { header: 1, blankrows: false });
assert.strictEqual(organizationRows.length, 2);
assert.strictEqual(organizationRows[1][0], 'QL-PARK');
assert.strictEqual(organizationRows[1][1], '青岚智造园区');

console.log('demo park dataset service tests passed');
