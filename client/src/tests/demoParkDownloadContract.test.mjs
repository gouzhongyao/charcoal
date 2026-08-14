import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// 服务端 CommonJS manifest 加载模块，测试直接以生产 manifest 为唯一条目真源。
const require = createRequire(import.meta.url);
const { DEMO_PARK_ARTIFACTS, listDemoParkArtifacts } = require('../../../server/src/services/demoParkDatasetService.js');

// 青岚下载路由、API、页面与权限的静态契约文件模块。
const routeUrl = new URL('../../../server/src/routes/templates.js', import.meta.url);
const sourceUrls = Object.freeze({
  ledgerApi: new URL('../api/ledger.js', import.meta.url),
  importsApi: new URL('../api/imports.js', import.meta.url),
  budgetsApi: new URL('../api/budgets.js', import.meta.url),
  carbonApi: new URL('../api/carbon.js', import.meta.url),
  predictionsApi: new URL('../api/predictions.js', import.meta.url),
  analysisApi: new URL('../api/energyAnalysis.js', import.meta.url),
  benchmarksApi: new URL('../api/energyBenchmarks.js', import.meta.url),
  flowsApi: new URL('../api/energyFlows.js', import.meta.url),
  balancesApi: new URL('../api/energyBalances.js', import.meta.url),
  demoDataApi: new URL('../api/demoData.js', import.meta.url),
  httpApi: new URL('../api/http.js', import.meta.url),
  ledgerPage: new URL('../views/ledger/LedgerManagement.vue', import.meta.url),
  importsPage: new URL('../views/imports/ImportCenter.vue', import.meta.url),
  budgetsPage: new URL('../views/energy/BudgetManagement.vue', import.meta.url),
  carbonPage: new URL('../views/carbon/CarbonManagement.vue', import.meta.url),
  predictionsPage: new URL('../views/predictions/PredictionManagement.vue', import.meta.url),
  analysisPage: new URL('../views/energy/analysis/index.vue', import.meta.url),
  analysisConfig: new URL('../utils/energyAnalysis.js', import.meta.url),
  benchmarksPage: new URL('../views/energy/benchmarks/index.vue', import.meta.url),
  benchmarksConfig: new URL('../utils/energyBenchmarkManagement.js', import.meta.url),
  flowsPage: new URL('../views/energy/flows/index.vue', import.meta.url),
  balancesPage: new URL('../views/energy/balances/index.vue', import.meta.url),
  balancesConfig: new URL('../utils/energyBalanceManagement.js', import.meta.url)
});

// 页面可见下载入口的明确映射表；每行同时绑定 manifest key、权限、API 方法与页面配置。
const PAGE_EXPECTATIONS = Object.freeze([
  { key: '01-organization-root', permission: 'ledger:units:import', kind: 'ledger', apiMethod: 'demoRoot' },
  { key: '02-organization-departments', permission: 'ledger:units:import', kind: 'ledger', apiMethod: 'demoDepartments' },
  { key: '03-organization-process-equipment', permission: 'ledger:units:import', kind: 'ledger', apiMethod: 'demoProcessEquipment' },
  { key: '04-meters', permission: 'ledger:meters:import', kind: 'ledger', apiMethod: 'demo' },
  { key: '05-production-units', permission: 'ledger:production:import', kind: 'ledger', apiMethod: 'demo' },
  { key: '06-production-outputs', permission: 'ledger:production:preview', kind: 'ledger', apiMethod: 'demo' },
  { key: '07-monthly-energy', permission: 'imports:create', kind: 'direct', apiSource: 'importsApi', pageSource: 'importsPage', apiFunction: 'downloadMonthlyEnergyDemoParkExample' },
  { key: '08-meter-readings-2026-08', permission: 'ledger:readings:import', kind: 'ledger', apiMethod: 'demo' },
  { key: '09-generation-records', permission: 'ledger:generation:preview', kind: 'ledger', apiMethod: 'demo' },
  { key: '10-energy-budgets', permission: 'energy:budget:import', kind: 'direct', apiSource: 'budgetsApi', pageSource: 'budgetsPage', apiFunction: 'downloadEnergyBudgetDemoParkExample' },
  { key: '11-carbon-factors', permission: 'carbon:factor:import', kind: 'direct', apiSource: 'carbonApi', pageSource: 'carbonPage', apiFunction: 'downloadCarbonFactorDemoParkExample' },
  { key: '12-prediction-configs', permission: 'prediction:config:import', kind: 'direct', apiSource: 'predictionsApi', pageSource: 'predictionsPage', apiFunction: 'downloadPredictionConfigDemoParkExample' },
  { key: '13-shift-definitions', permission: 'energy:analysis:config:import:preview', kind: 'analysis', permissionMember: 'configurationImportPreview' },
  { key: '14-shift-schedules', permission: 'energy:analysis:operations:preview', kind: 'analysis', permissionMember: 'operationsPreview' },
  { key: '15-energy-timeseries', permission: 'energy:analysis:timeseries:preview', kind: 'analysis', permissionMember: 'timeseriesPreview' },
  { key: '16-device-states', permission: 'energy:analysis:operations:preview', kind: 'analysis', permissionMember: 'operationsPreview' },
  { key: '17-tou-schemes', permission: 'energy:analysis:config:import:preview', kind: 'analysis', permissionMember: 'configurationImportPreview' },
  { key: '18-strategy-rules', permission: 'energy:analysis:config:import:preview', kind: 'analysis', permissionMember: 'configurationImportPreview' },
  { key: '19-conversion-factors', permission: 'energy:benchmarks:import:preview', kind: 'benchmark', importType: 'conversion-factors' },
  { key: '20-benchmark-definitions', permission: 'energy:benchmarks:import:preview', kind: 'benchmark', importType: 'definitions' },
  { key: '21-benchmark-targets', permission: 'energy:benchmarks:import:preview', kind: 'benchmark', importType: 'targets' },
  { key: '22-energy-flow-models', permission: 'energy:flows:import:preview', kind: 'flow', flowKey: 'model' },
  { key: '23-energy-flow-nodes', permission: 'energy:flows:import:preview', kind: 'flow', flowKey: 'node' },
  { key: '24-energy-flow-edges', permission: 'energy:flows:import:preview', kind: 'flow', flowKey: 'edge' },
  { key: '25-energy-balance-configs', permission: 'energy:balance:import:preview', kind: 'balance', apiFunction: 'downloadEnergyBalanceDemoParkExample' }
]);

// 转义静态契约字符串，供成组正则断言使用。
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 提取导出下载方法附近的实现块，确保方法本身而非无关源码包含共享 download 调用。
function functionWindow(source, functionName, length = 650) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, `API 必须定义 ${functionName}。`);
  return source.slice(start, start + length);
}

// 读取所有静态契约文件，避免逐条测试重复访问文件系统。
const [routeSource, sourceEntries] = await Promise.all([
  readFile(routeUrl, 'utf8'),
  Promise.all(Object.entries(sourceUrls).map(async ([name, url]) => [name, await readFile(url, 'utf8')]))
]);
// 按稳定名称索引 API、页面和页面配置源码。
const sources = Object.freeze(Object.fromEntries(sourceEntries));
// 服务端对外 manifest 投影，下载路径和页面目标均从这里读取。
const manifest = listDemoParkArtifacts();
// 生产 manifest 条目索引，保留多工作表信息用于格式断言。
const artifactsByKey = new Map(DEMO_PARK_ARTIFACTS.map((artifact) => [artifact.artifactKey, artifact]));
// 页面期望索引，用于双向覆盖检查，防止测试表静默漏项或虚构条目。
const expectationsByKey = new Map(PAGE_EXPECTATIONS.map((expectation) => [expectation.key, expectation]));

// 25 项 key、固定 XLSX 路径及页面映射必须完整且唯一。
assert.strictEqual(manifest.length, 25, '青岚 manifest 必须固定为 25 项。');
assert.strictEqual(new Set(manifest.map((artifact) => artifact.artifactKey)).size, 25, '25 个 artifactKey 必须唯一。');
assert.strictEqual(PAGE_EXPECTATIONS.length, 25, '页面下载入口期望必须逐项覆盖 25 个 manifest artifact。');
assert.strictEqual(expectationsByKey.size, 25, '页面下载入口期望不得重复 artifactKey。');
assert.deepStrictEqual(
  [...expectationsByKey.keys()].sort(),
  manifest.map((artifact) => artifact.artifactKey).sort(),
  '页面可见导入入口必须与 manifest 25 项双向一致。'
);
for (const artifact of manifest) {
  assert.strictEqual(artifact.downloads.xlsx, `/api/templates/demo-park/${artifact.artifactKey}.xlsx`, `${artifact.artifactKey} 必须可构造固定 XLSX 下载路径。`);
  assert.strictEqual(typeof artifact.targetPage, 'string');
  assert(artifact.targetPage.length > 0, `${artifact.artifactKey} 必须声明可见目标页面。`);
}

// 模板路由必须同时要求系统演示下载权限和条目真实领域权限。
for (const routeContract of [
  "router.get('/demo-park/manifest', authenticate",
  "router.get('/demo-park/:artifactKey.xlsx', requireDemoParkArtifactPermission",
  "router.get('/demo-park/:artifactKey.csv', requireDemoParkArtifactPermission",
  "'system:demo:download'",
  'registration.permissions.download',
  "sendDemoParkArtifact(req, res, next, 'xlsx')",
  "sendDemoParkArtifact(req, res, next, 'csv')"
]) assert(routeSource.includes(routeContract), `模板路由缺少青岚契约：${routeContract}`);
const permissionMiddlewareMatch = routeSource.match(/requirePermission\(\s*'system:demo:download',\s*registration\.permissions\.download\s*\)/);
assert(permissionMiddlewareMatch, '青岚 artifact 下载必须使用 requirePermission 的 AND 语义同时校验系统权限和领域权限。');

// 各类 API 都必须复用共享 HTTP download，禁止页面自行拼 Blob 或创建 Axios 实例。
for (const apiSourceName of ['ledgerApi', 'importsApi', 'budgetsApi', 'carbonApi', 'predictionsApi', 'analysisApi', 'benchmarksApi', 'flowsApi', 'balancesApi']) {
  assert(sources[apiSourceName].includes("import { download"), `${apiSourceName} 必须导入共享 download。`);
  assert(!sources[apiSourceName].includes('axios.create'), `${apiSourceName} 不得创建独立 Axios 实例。`);
}

// 每项页面入口必须按同一行期望成组匹配 key、requiredPermission、API 方法和下载路径。
for (const expectation of PAGE_EXPECTATIONS) {
  const artifact = artifactsByKey.get(expectation.key);
  assert(artifact, `页面期望不得引用 manifest 外条目：${expectation.key}`);
  assert.strictEqual(artifact.requiredPermission, expectation.permission, `${expectation.key} 页面权限必须对照 manifest。`);
  const clientPath = `/templates/demo-park/${expectation.key}.xlsx`;

  if (expectation.kind === 'ledger') {
    const apiBindingPattern = new RegExp(`${escapeRegExp(expectation.apiMethod)}:\\s*\\(\\)\\s*=>\\s*demoParkExample\\('${escapeRegExp(expectation.key)}'`);
    assert(apiBindingPattern.test(sources.ledgerApi), `${expectation.key} 必须由 ledgerApi.${expectation.apiMethod} 绑定共享 demoParkExample。`);
    assert(functionWindow(sources.ledgerApi.replace('const demoParkExample', 'function demoParkExample'), 'demoParkExample').includes('/templates/demo-park/${artifactKey}.xlsx'), '台账共享下载方法必须构造青岚 XLSX 路径。');
    const pageBindingPattern = new RegExp(`demoPermission:'${escapeRegExp(expectation.permission)}'[\\s\\S]{0,900}?artifactKey:'${escapeRegExp(expectation.key)}',apiMethod:'${escapeRegExp(expectation.apiMethod)}'`);
    assert(pageBindingPattern.test(sources.ledgerPage), `${expectation.key} 页面配置必须将 key、权限与 API 方法成组绑定。`);
    assert(sources.ledgerPage.includes('api.value[item.apiMethod]'), '台账页面必须通过配置的 API 方法下载当前条目。');
    continue;
  }

  if (expectation.kind === 'direct') {
    const apiBlock = functionWindow(sources[expectation.apiSource], expectation.apiFunction);
    assert(apiBlock.includes('return download('), `${expectation.apiFunction} 必须调用共享 download。`);
    assert(apiBlock.includes(clientPath), `${expectation.apiFunction} 必须下载 ${expectation.key}。`);
    assert(sources[expectation.pageSource].includes(expectation.apiFunction), `${expectation.key} 页面必须导入并调用 ${expectation.apiFunction}。`);
    assert(sources[expectation.pageSource].includes(`hasPermi('${expectation.permission}')`), `${expectation.key} 页面必须使用 manifest 权限 ${expectation.permission}。`);
    continue;
  }

  if (expectation.kind === 'analysis') {
    const definitionPattern = new RegExp(`demoArtifactKey:\\s*'${escapeRegExp(expectation.key)}'[\\s\\S]{0,180}?previewPermission:\\s*ENERGY_ANALYSIS_PERMISSIONS\\.${escapeRegExp(expectation.permissionMember)}`);
    assert(definitionPattern.test(sources.analysisConfig), `${expectation.key} 能源分析定义必须将 key 与预演权限成员成组绑定。`);
    assert(sources.analysisConfig.includes(`${expectation.permissionMember}: '${expectation.permission}'`), `${expectation.key} 权限成员必须等于 manifest requiredPermission。`);
    const apiBlock = functionWindow(sources.analysisApi, 'downloadEnergyAnalysisDemoArtifact');
    assert(apiBlock.includes('return download(') && apiBlock.includes('/templates/demo-park/${encodeURIComponent(artifactKey)}.${safeExtension}'), '能源分析共享方法必须通过 download 构造编码后的青岚路径。');
    assert(sources.analysisPage.includes("downloadEnergyAnalysisDemoArtifact(definition.demoArtifactKey, 'xlsx')"), `${expectation.key} 页面必须把配置 key 传给共享下载方法。`);
    assert(sources.analysisPage.includes('hasPermissionCode(definition.previewPermission)'), `${expectation.key} 页面入口必须使用同一配置权限控制可见性。`);
    continue;
  }

  if (expectation.kind === 'benchmark') {
    const apiMappingPattern = new RegExp(`(?:'${escapeRegExp(expectation.importType)}'|${escapeRegExp(expectation.importType)}):\\s*Object\\.freeze\\(\\{[^}]*artifactKey:\\s*'${escapeRegExp(expectation.key)}'`);
    assert(apiMappingPattern.test(sources.benchmarksApi), `${expectation.key} 必须绑定能效对标导入类型 ${expectation.importType}。`);
    const apiBlock = functionWindow(sources.benchmarksApi, 'downloadEnergyBenchmarkDemoParkExample');
    assert(apiBlock.includes('return download(') && apiBlock.includes('/templates/demo-park/${config.artifactKey}.xlsx'), '能效对标共享方法必须使用配置 key 调用 download。');
    assert(sources.benchmarksConfig.includes(`importPreview: '${expectation.permission}'`), `${expectation.key} 对标预演权限必须对照 manifest。`);
    assert(sources.benchmarksPage.includes('downloadEnergyBenchmarkDemoParkExample(importType.value)'), `${expectation.key} 页面必须按当前配置类型调用共享下载方法。`);
    assert(sources.benchmarksPage.includes('hasPermi(ENERGY_BENCHMARK_PERMISSIONS.importPreview)'), `${expectation.key} 页面必须以预演权限控制入口。`);
    continue;
  }

  if (expectation.kind === 'flow') {
    const flowDefinitionPattern = new RegExp(`key:\\s*'${escapeRegExp(expectation.flowKey)}'[^}]*demoArtifactKey:\\s*'${escapeRegExp(expectation.key)}'`);
    assert(flowDefinitionPattern.test(sources.flowsPage), `${expectation.key} 必须绑定能流入口 ${expectation.flowKey}。`);
    const apiBlock = functionWindow(sources.flowsApi, 'downloadEnergyFlowDemoArtifact');
    assert(apiBlock.includes('return download(') && apiBlock.includes('/templates/demo-park/${encodeURIComponent(artifactKey)}.${safeExtension}'), '能流共享方法必须通过 download 构造编码后的青岚路径。');
    assert(sources.flowsPage.includes("downloadEnergyFlowDemoArtifact(definition.demoArtifactKey, 'xlsx')"), `${expectation.key} 页面必须把配置 key 传给共享下载方法。`);
    assert(sources.flowsPage.includes(`hasPermi('${expectation.permission}')`), `${expectation.key} 页面必须以 manifest 权限控制入口。`);
    continue;
  }

  const apiBlock = functionWindow(sources.balancesApi, expectation.apiFunction);
  assert(apiBlock.includes('return download(') && apiBlock.includes(clientPath), `${expectation.key} 平衡 API 必须通过共享 download 使用固定 XLSX 路径。`);
  assert(sources.balancesConfig.includes(`importPreview: '${expectation.permission}'`), `${expectation.key} 平衡权限必须对照 manifest。`);
  assert(sources.balancesPage.includes(expectation.apiFunction), `${expectation.key} 平衡页面必须调用青岚下载方法。`);
  assert(sources.balancesPage.includes('hasPermi(ENERGY_BALANCE_PERMISSIONS.importPreview)'), `${expectation.key} 平衡页面必须以预演权限控制入口。`);
}

// 多工作表 artifact 只能发布 XLSX，页面也必须固定传入或接受 XLSX。
const multiSheetArtifacts = DEMO_PARK_ARTIFACTS.filter((artifact) => artifact.workbooks);
assert.deepStrictEqual(multiSheetArtifacts.map((artifact) => artifact.artifactKey), ['17-tou-schemes', '24-energy-flow-edges', '25-energy-balance-configs']);
for (const artifact of multiSheetArtifacts) {
  assert.deepStrictEqual([...artifact.formats], ['xlsx'], `${artifact.artifactKey} 多工作表条目只能使用 XLSX。`);
  assert.strictEqual(manifest.find((item) => item.artifactKey === artifact.artifactKey).downloads.csv, undefined, `${artifact.artifactKey} 不得构造 CSV 下载。`);
}
assert(sources.analysisConfig.includes("demoArtifactKey: '17-tou-schemes'") && sources.analysisConfig.includes("accept: '.xlsx'"), 'TOU 多工作表页面配置必须仅接受 XLSX。');
assert(sources.flowsPage.includes("demoArtifactKey: '24-energy-flow-edges'") && sources.flowsPage.includes("downloadEnergyFlowDemoArtifact(definition.demoArtifactKey, 'xlsx')"), '能流双工作表页面必须固定下载 XLSX。');
assert(sources.balancesApi.includes('/templates/demo-park/25-energy-balance-configs.xlsx') && !sources.balancesApi.includes('/templates/demo-park/25-energy-balance-configs.csv'), '平衡双工作表 API 只能提供 XLSX 示例。');

// 重新关联只能从响应 header 读取新 token，并成功替换当前标签页 sessionStorage。
assert(sources.httpApi.includes('export async function requestWithHeaders'), '共享 HTTP 必须提供不丢失响应头的受控请求入口。');
assert(sources.demoDataApi.includes('requestWithHeaders({'), '重新关联必须使用可读取响应头的共享请求。');
assert(sources.demoDataApi.includes("response.headers?.['x-demo-context']"), '重新关联的新 token 只能从 X-Demo-Context 响应头读取。');
assert(sources.demoDataApi.includes('storeDemoContext({'), '重新关联成功后必须替换 sessionStorage 中的 context。');
assert(!sources.demoDataApi.includes('contextToken: response.data'), '重新关联不得从响应 body 读取明文 token。');

// sessionStorage 生命周期使用真实纯逻辑函数验证，不以源码字符串代替存取、隔离和清理行为。
const demoDataModuleSource = sources.demoDataApi.replace(
  "import { request, requestWithHeaders } from '@/api/http';",
  'const request = async () => null; const requestWithHeaders = async () => null;'
);
const demoDataModuleUrl = `data:text/javascript;base64,${Buffer.from(demoDataModuleSource).toString('base64')}`;
const {
  DEMO_CONTEXT_STORAGE_PREFIX,
  clearDemoContexts,
  demoContextRequestConfig,
  readDemoContext,
  storeDemoContext
} = await import(demoDataModuleUrl);
class MemorySessionStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
}
const firstTabStorage = new MemorySessionStorage();
const secondTabStorage = new MemorySessionStorage();
const firstContextMetadata = {
  datasetId: 'qinglan-park-v1',
  runId: 'run-1',
  artifactKey: '13-shift-definitions',
  handlerKey: 'shift-definitions-import',
  manifestVersion: 'v1',
  manifestDigest: 'a'.repeat(64),
  artifactSha256: 'b'.repeat(64),
  contextToken: 'c'.repeat(43)
};
assert.strictEqual(storeDemoContext(firstContextMetadata, firstTabStorage).token, 'c'.repeat(43));
assert.strictEqual(readDemoContext('13-shift-definitions', 'shift-definitions-import', firstTabStorage).runId, 'run-1');
assert.deepStrictEqual(demoContextRequestConfig('13-shift-definitions', 'shift-definitions-import', firstTabStorage), {
  demoContext: {
    artifactKey: '13-shift-definitions',
    handlerKey: 'shift-definitions-import',
    token: 'c'.repeat(43)
  }
});
assert.strictEqual(readDemoContext('13-shift-definitions', 'shift-definitions-import', secondTabStorage), null, '不同标签页的 sessionStorage 不得共享 context');
storeDemoContext({ ...firstContextMetadata, artifactKey: '14-shift-schedules', handlerKey: 'shift-schedules-import', contextToken: 'd'.repeat(43) }, firstTabStorage);
firstTabStorage.setItem('unrelated', 'preserve');
clearDemoContexts('13-shift-definitions', 'shift-definitions-import', firstTabStorage);
assert.strictEqual(readDemoContext('13-shift-definitions', 'shift-definitions-import', firstTabStorage), null);
assert(readDemoContext('14-shift-schedules', 'shift-schedules-import', firstTabStorage));
clearDemoContexts(null, null, firstTabStorage);
assert.strictEqual(firstTabStorage.getItem('unrelated'), 'preserve');
assert.strictEqual([...firstTabStorage.values.keys()].some((key) => key.startsWith(`${DEMO_CONTEXT_STORAGE_PREFIX}:`)), false);
const invalidStorageKey = `${DEMO_CONTEXT_STORAGE_PREFIX}:13-shift-definitions:shift-definitions-import`;
firstTabStorage.setItem(invalidStorageKey, JSON.stringify({ ...firstContextMetadata, token: 'invalid' }));
assert.strictEqual(readDemoContext('13-shift-definitions', 'shift-definitions-import', firstTabStorage), null);
assert.strictEqual(firstTabStorage.getItem(invalidStorageKey), null, '畸形 context 必须在读取时清理');

// prediction-history 只复用月度能耗条目，不得伪造第 26 个独立 artifact。
const predictionHistoryArtifacts = DEMO_PARK_ARTIFACTS.filter((artifact) => artifact.coveredTemplateTypes.includes('prediction-history'));
assert.deepStrictEqual(predictionHistoryArtifacts.map((artifact) => artifact.artifactKey), ['07-monthly-energy']);
assert.strictEqual(DEMO_PARK_ARTIFACTS.some((artifact) => artifact.templateType === 'prediction-history'), false, '预测历史不得虚构独立青岚 artifact。');
assert(sources.importsApi.includes('月度能耗与预测历史') && sources.importsPage.includes('月度能耗与预测历史'), '页面和 API 必须明确说明预测历史复用月度能耗文件。');

console.log('demo park download contract tests passed');
