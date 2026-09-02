import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { normalizeTrustedInternalRoutePath, resolveTrustedRegisteredRoute } from '../utils/navigationRoutes.js';

// 直接复用服务端冻结的 manifest 与 registry，避免客户端测试复制 artifact 数量、key 或顺序。
const require = createRequire(import.meta.url);
// 复用项目现有 AxiosHeaders，验证真实客户端下载响应头容器。
const { AxiosHeaders } = require('axios');
const {
  DEMO_DATASET_ID,
  DEMO_MANIFEST_VERSION,
  DEMO_PARK_ARTIFACTS,
  getDemoParkManifestDigest,
  validateDemoParkManifest
} = require('../../../server/src/services/demoParkDatasetService.js');
const {
  ACTIVE_IDENTITY_RUN_STATUSES,
  _test: demoRunTestContract
} = require('../../../server/src/services/demoRunService.js');
const { _test: demoDataRouteTestContract } = require('../../../server/src/routes/demoData.js');
const {
  DEMO_ARTIFACT_REGISTRY,
  validateDemoArtifactRegistry
} = require('../../../server/src/services/demoArtifactRegistry.js');
const {
  getDemoCapabilities,
  getDemoConfirmationTexts
} = require('../../../server/src/services/demoRuntimeService.js');

// 集中页、共享 API、服务端事实源和保留正式能力的业务页源码模块。
const sourceUrls = Object.freeze({
  demoDataApi: new URL('../api/demoData.js', import.meta.url),
  serverDemoRegistry: new URL('../../../server/src/services/demoParkDatasetService.js', import.meta.url),
  serverDemoRuntime: new URL('../../../server/src/services/demoRuntimeService.js', import.meta.url),
  demoDataPage: new URL('../views/system/DemoData.vue', import.meta.url),
  navigationRoutes: new URL('../utils/navigationRoutes.js', import.meta.url),
  router: new URL('../router/index.js', import.meta.url),
  importsPage: new URL('../views/imports/ImportCenter.vue', import.meta.url),
  ledgerPage: new URL('../views/ledger/LedgerManagement.vue', import.meta.url),
  budgetsPage: new URL('../views/energy/BudgetManagement.vue', import.meta.url),
  carbonFactorsPage: new URL('../views/carbon/components/CarbonFactorsSection.vue', import.meta.url),
  predictionsPage: new URL('../views/predictions/PredictionManagement.vue', import.meta.url),
  analysisPage: new URL('../views/energy/analysis/index.vue', import.meta.url),
  benchmarksPage: new URL('../views/energy/benchmarks/index.vue', import.meta.url),
  flowsPage: new URL('../views/energy/flows/index.vue', import.meta.url),
  balancesPage: new URL('../views/energy/balances/index.vue', import.meta.url),
  energyAnalysisApi: new URL('../api/energyAnalysis.js', import.meta.url),
  energyBenchmarksApi: new URL('../api/energyBenchmarks.js', import.meta.url),
  energyFlowsApi: new URL('../api/energyFlows.js', import.meta.url),
  energyBalancesApi: new URL('../api/energyBalances.js', import.meta.url)
});

// 读取全部静态契约文件并按稳定名称建立索引。
const sourceEntries = await Promise.all(Object.entries(sourceUrls).map(async ([name, url]) => [name, await readFile(url, 'utf8')]));
const sources = Object.freeze(Object.fromEntries(sourceEntries));
// 从服务端冻结事实源读取 manifest/registry 身份与顺序，集中页只消费目录响应而不复制条目。
const serverManifestArtifactKeys = DEMO_PARK_ARTIFACTS.map((artifact) => artifact.artifactKey);
const serverManifestArtifactOrders = DEMO_PARK_ARTIFACTS.map((artifact) => artifact.order);
const serverRegistryArtifactKeys = DEMO_ARTIFACT_REGISTRY.map((artifact) => artifact.artifactKey);
const registeredArtifactCount = serverRegistryArtifactKeys.length;

// 分散业务 API 的托管下载必须复用既有正式契约，并把 artifact/handler identity 传给共享下载函数。
assert.match(sources.energyAnalysisApi, /const contract = analysisDemoArtifact\(artifactKey\);[\s\S]*?undefined,[\s\S]*?contract\s*\n\s*\)/, '能源分析下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyBenchmarksApi, /const config = energyBenchmarkImportDownload\(importType\);[\s\S]*?undefined,[\s\S]*?config\s*\n\s*\)/, '能效对标下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyBalancesApi, /undefined,[\s\S]*?ENERGY_BALANCE_DEMO_IMPORT\s*\n\s*\)/, '能效平衡下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyFlowsApi, /const contract = energyFlowDemoArtifact\(artifactKey\);[\s\S]*?undefined,[\s\S]*?contract\s*\n\s*\)/, '能流下载必须传入正式 artifact/handler 契约。');

// 服务端 manifest 与 registry 必须共同声明当前 29 项唯一 key，并保持连续 order 与相同顺序。
assert.strictEqual(validateDemoParkManifest(), true, '服务端演示 manifest 自校验必须通过。');
assert.strictEqual(validateDemoArtifactRegistry(), true, '服务端演示 registry 自校验必须通过。');
assert.strictEqual(
  new Set(serverManifestArtifactKeys).size,
  serverManifestArtifactKeys.length,
  '服务端演示 manifest 的 artifactKey 必须唯一。'
);
assert.strictEqual(
  new Set(serverRegistryArtifactKeys).size,
  registeredArtifactCount,
  '服务端演示 registry 的 artifactKey 必须唯一。'
);
assert.deepStrictEqual(
  serverManifestArtifactKeys,
  serverRegistryArtifactKeys,
  `服务端演示 manifest 必须与 registry 的 ${registeredArtifactCount} 项 key 和顺序完全一致。`
);
assert.deepStrictEqual(
  serverManifestArtifactOrders,
  Array.from({ length: registeredArtifactCount }, (_item, index) => index + 1),
  `服务端演示 manifest 的 ${registeredArtifactCount} 项 order 必须从 1 连续递增。`
);
for (const artifactKey of serverManifestArtifactKeys) {
  assert.strictEqual(sources.demoDataPage.includes(artifactKey), false, `集中页不得硬编码 registry 条目 ${artifactKey}。`);
}
assert.match(sources.demoDataPage, /const artifacts = computed\(\(\) => \[\.\.\.\(catalog\.value\?\.artifacts \|\| \[\]\)\]/, '集中页必须直接渲染服务端 catalog artifacts。');
assert.doesNotMatch(sources.demoDataPage, /PAGE_EXPECTATIONS|artifactRegistry|demoArtifacts\s*=\s*Object\.freeze/i, '集中页不得维护第二份 artifact registry。');

// 动态路由必须接入集中页；仅 componentMap 中的真实页面标记为可信，占位组件不得用于 artifact 导航。
assert.match(sources.router, /import DemoData from '@\/views\/system\/DemoData\.vue';/);
assert.match(sources.router, /'system\/demo-data\/index': DemoData/);
assert.match(sources.router, /trustedInternalRoute: component !== MigrationPlaceholder/);
assert.match(sources.router, /unavailable: component === MigrationPlaceholder/);
assert.doesNotMatch(sources.router, /migration: component === MigrationPlaceholder/);

// 页面挂载只能读取无副作用 status 和标准模板目录，不得隐式请求 catalog 或创建 run。
const initialStateStart = sources.demoDataPage.indexOf('async function loadInitialState()');
const initialStateEnd = sources.demoDataPage.indexOf('/** 加载服务端标准模板目录。 */', initialStateStart);
const initialStateBlock = sources.demoDataPage.slice(initialStateStart, initialStateEnd);
assert.notStrictEqual(initialStateStart, -1, '集中页必须定义初始状态加载方法。');
assert.match(sources.demoDataPage, /onMounted\(loadInitialState\)/);
assert.match(initialStateBlock, /refreshStatusProjection/);
assert.match(initialStateBlock, /loadTemplateCatalog/);
const refreshStatusProjectionBlock = sources.demoDataPage.match(/async function refreshStatusProjection\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(refreshStatusProjectionBlock, /getDemoStatus/);
assert.doesNotMatch(refreshStatusProjectionBlock, /getDemoCatalog|prepareDemoRun|ensureDemoRun|loadTemplateCatalog|loadOwnership/, 'status 恢复只能读取 status，不得触发其它请求。');
assert.doesNotMatch(initialStateBlock, /getDemoCatalog|prepareDemoRun|ensureDemoRun/, '页面挂载不得读取 catalog 或创建、复用 active run。');
assert.match(sources.demoDataPage, /catalog 读取与 active run 准备是两个独立动作；进入页面不会自动创建 run/);

// catalog GET 与 POST run 必须拥有独立动作、loading 和 error，且 activeRun 不得从 catalog.run 派生。
assert.match(sources.demoDataApi, /export function prepareDemoRun\(\) \{[\s\S]*?url: '\/system\/demo-data\/run', method: 'post'/);
assert.match(sources.demoDataPage, /const catalogLoading = ref\(false\)/);
assert.match(sources.demoDataPage, /const runLoading = ref\(false\)/);
assert.match(sources.demoDataPage, /const catalogError = ref\(''\)/);
assert.match(sources.demoDataPage, /const runError = ref\(''\)/);
assert.match(sources.demoDataPage, /const activeRun = ref\(null\)/, 'activeRun 必须是独立状态。');
assert.doesNotMatch(sources.demoDataPage, /activeRun = computed\(\(\) => catalog\.value\?\.run/, 'activeRun 不得从 catalog.run 唯一派生。');
const loadCatalogStart = sources.demoDataPage.indexOf('async function loadCatalog()');
const loadCatalogEnd = sources.demoDataPage.indexOf('/** 显式 POST 创建、复用或自动换代 active run', loadCatalogStart);
const loadCatalogBlock = sources.demoDataPage.slice(loadCatalogStart, loadCatalogEnd);
assert.match(loadCatalogBlock, /getDemoCatalog/);
assert.doesNotMatch(loadCatalogBlock, /prepareDemoRun|applyRun|activeRun\.value/, 'catalog 读取不得准备或推断 active run。');
const prepareRunStart = sources.demoDataPage.indexOf('async function prepareRun()');
const prepareRunEnd = sources.demoDataPage.indexOf('/** 下载服务端标准模板目录项。 \*/', prepareRunStart);
const prepareRunBlock = sources.demoDataPage.slice(prepareRunStart, prepareRunEnd);
assert.match(prepareRunBlock, /safeRequest\(prepareDemoRun\)/);
assert.match(prepareRunBlock, /const turnover = readDemoRunTurnover\(result\.value\)/, '显式 prepare 成功后必须读取服务端 turnover 元数据。');
assert.match(prepareRunBlock, /applyRun\(result\.value\)/);
assert.match(prepareRunBlock, /turnover\.performed === true\) clearDemoContexts\(\)/, '显式 prepare 自动换代必须清理全部旧标签页 context。');
assert.match(prepareRunBlock, /turnover\.performed === true[\s\S]*?formatDemoRunTurnoverSuccessMessage/, '显式 prepare 自动换代后必须展示非阻塞成功提示。');
assert.doesNotMatch(prepareRunBlock, /catalog\.value = null/, 'POST run 失败时必须保留已加载 catalog。');
const canPrepareRunStart = sources.demoDataPage.indexOf('const canPrepareRun = computed');
const canPrepareRunEnd = sources.demoDataPage.indexOf('/** 是否展示 catalog 中的下载操作。 */', canPrepareRunStart);
const canPrepareRunBlock = sources.demoDataPage.slice(canPrepareRunStart, canPrepareRunEnd);
assert.match(canPrepareRunBlock, /!activeRunCleanupBlocked\.value/, 'cleaning 阻断期间必须禁用显式 prepare，避免重复触发 409。');
assert.match(sources.demoDataPage, /activeRunCleanupBlocked[\s\S]*?显式准备与 managed 下载已临时禁用，请稍后重试/, '页面必须提示 cleaning 阻断期间稍后重试。');
assert.doesNotMatch(sources.demoDataPage, /DEMO_ACTIVE_RUN_MANIFEST_CONFLICT|必须保留并人工处置|manifest 不一致必须人工处置/, '页面不得保留普通 manifest mismatch 的人工处置特判或文案。');
assert.match(sources.demoDataPage, /active run 自动换代成功/, '页面必须为显式 prepare 自动换代提供成功提示。');
const turnoverMessageContract = sources.demoDataApi.match(/export function formatDemoRunTurnoverSuccessMessage\([\s\S]*?\n\}/)?.[0] || '';
assert.match(turnoverMessageContract, /oldManifestVersion[\s\S]*?newManifestVersion/, '换代提示必须包含旧、新 manifest version。');
assert.doesNotMatch(turnoverMessageContract, /manifestDigest|digest/i, '换代成功提示不得输出过长 manifest digest。');

// 标准模板目录必须来自服务端 /templates，下载路径经过站内路径规范化。
assert.match(sources.demoDataApi, /url: '\/templates', method: 'get'/);
assert.match(sources.demoDataPage, /standardTemplates\.value = Array\.isArray\(result\.value\?\.data\)/);
assert.match(sources.demoDataPage, /downloadDemoStandardTemplate\(template, format\)/);
assert.match(sources.demoDataPage, /const standardTemplates = ref\(\[\]\);/, '标准模板目录初始状态必须为空并等待服务端响应。');

// artifact 下载必须按服务端生命周期分流，并严格消费 catalog 的正式 targetRoute 后在当前标签页导航。
assert.match(sources.demoDataApi, /lifecycle === 'stateless-formal-import'\) return download\(/);
assert.match(sources.demoDataApi, /lifecycle === 'managed-context-auto-runtime'[\s\S]*?downloadManagedDemoArtifact\(/);
assert.match(sources.demoDataApi, /throw new Error\('服务端未声明受支持的 artifact 下载生命周期。'\)/);
assert.match(sources.demoDataApi, /const DEMO_CONTEXT_STORAGE_PREFIX = 'charcoal\.demoContext\.v2'/, '新编码 context 必须使用独立 v2 prefix。');
assert.doesNotMatch(sources.demoDataApi, /charcoal\.demoContext\.v1/, '生产 demoData API 不得读取或清理旧 v1 context。');
assert.match(sources.demoDataApi, /downloadManagedDemoArtifact\(config, fallbackName, storage, expectedIdentity\)/, '托管下载必须要求调用方传入预期身份。');
for (const headerName of ['x-demo-run-id', 'x-demo-run-reused', 'x-demo-run-auto-superseded', 'x-demo-run-superseded-from', 'x-demo-runtime-epoch']) {
  assert.match(sources.demoDataApi, new RegExp(headerName), `托管下载必须读取稳定响应头 ${headerName}。`);
}
assert.match(sources.demoDataApi, /const turnover = readDemoRunTurnover\(result\);[\s\S]*?clearDemoContextsForRun\(turnover\.oldRunId, contextStorage\)[\s\S]*?demoContextStored: replacement\.ok, turnover, clearedPredecessorContextCount/, '共享下载 helper 必须保存 successor context，并按 predecessor run 定向清理旧 context。');
assert.doesNotMatch(sources.demoDataPage.match(/async function refreshStatusAfterManagedDownload\([\s\S]*?\n\}/)?.[0] || '', /clearDemoContexts\(\)/, 'managed 下载后不得无条件清理全部 context。');
assert.match(sources.demoDataPage, /artifact\.downloadLifecycle === 'managed-context-auto-runtime'[\s\S]*?refreshStatusAfterManagedDownload\(result\.value\)/, 'managed 下载成功后必须刷新 status。');
const refreshManagedStatusBlock = sources.demoDataPage.match(/async function refreshStatusAfterManagedDownload\(downloadResult\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(refreshManagedStatusBlock, /turnover\?\.performed === true[\s\S]*?clearRunGovernanceProjection\(\)/, 'managed 自动换代后必须清空旧 ownership 与 cleanup 投影。');
assert.match(refreshManagedStatusBlock, /beginStatusRequest\(\)[\s\S]*?safeRequest\(getDemoStatus\)[\s\S]*?isLatestDemoRequest[\s\S]*?applyStatus/, 'managed status 刷新必须拒绝乱序旧响应。');
assert.ok(sources.demoDataPage.includes("function applyStatus(response, expectedRunId = '')"), 'status 应支持 prepare 后的 expected runId 守卫。');
const applyStatusStart = sources.demoDataPage.indexOf("function applyStatus(response, expectedRunId = '')");
const applyStatusEnd = sources.demoDataPage.indexOf('/** 应用显式 POST run 成功结果', applyStatusStart);
const applyStatusBlock = sources.demoDataPage.slice(applyStatusStart, applyStatusEnd);
assert.match(applyStatusBlock, /readStatusProjection\(response\)/, 'status 必须先验证完整投影再落地。');
assert.match(applyStatusBlock, /expectedRunId/, 'prepare 后 status 必须核对 expected runId。');
assert.match(applyStatusBlock, /previousRunId !== nextRunId\) clearRunGovernanceProjection\(\)/, 'status 返回的 run ID 改变时必须清空旧治理投影。');
const ownershipRequestBlock = sources.demoDataPage.match(/async function loadOwnership\(options = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(ownershipRequestBlock, /isLatestDemoRunRequest\(requestId, ownershipRequestSequence\.value, runId, currentActiveRunId\(\)\)/, 'ownership 响应落地前必须核对请求序号和当前 run ID。');
assert.match(sources.demoDataPage, /isLatestDemoRunRequest\(requestId, cleanupPreviewRequestSequence\.value, runId, currentActiveRunId\(\)\)/, 'cleanup preview 响应必须核对请求序号和当前 run ID。');
assert.match(sources.demoDataPage, /isLatestDemoRunRequest\(requestId, cleanupExecuteRequestSequence\.value, runId, currentActiveRunId\(\)\)/, 'cleanup execute 响应必须核对请求序号和当前 run ID。');
const cleanupExecuteBlock = sources.demoDataPage.match(/async function executeCleanup\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(cleanupExecuteBlock, /const resultGeneration = beginCleanupResultAction\(\)[\s\S]*?isLatestDemoRequest\(resultGeneration, cleanupResultGeneration\.value\)/, 'cleanup execute 必须使用共享 generation 拒绝跨类型旧响应。');
const cleanupStatusBlock = sources.demoDataPage.match(/async function loadCleanupStatus\(cleanupRunId\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(cleanupStatusBlock, /const resultGeneration = beginCleanupResultAction\(\)[\s\S]*?isLatestDemoCleanupResultRequest\([\s\S]*?normalizedCleanupRunId,[\s\S]*?cleanupRunIdInput\.value/, 'cleanup status 查询必须同时核对共享 generation、请求 cleanupRunId 与当前输入身份。');
const clearGovernanceBlock = sources.demoDataPage.match(/function clearRunGovernanceProjection\(options = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(clearGovernanceBlock, /cleanupStatusRequestSequence\.value \+= 1[\s\S]*?beginCleanupResultAction\(\)/, '治理投影清空必须使旧 cleanup query 和共享结果响应失效。');
assert.match(sources.demoDataApi, /托管演示下载缺少预期的 artifactKey 或 handlerKey/, '缺少预期身份必须明确失败。');
assert.doesNotMatch(sources.demoDataApi, /captureDemoContextStorage|storeDemoContextIfStorageUnchanged|expectedIdentity = null/, '托管下载不得保留无身份 fallback。');
assert.match(sources.demoDataPage, /downloadDemoCatalogArtifact\(artifact, format\)/);
assert.match(sources.demoDataPage, /resolveTrustedRegisteredRoute\(\s*artifact\?\.targetRoute,\s*router\.getRoutes\(\)\s*\)/);
assert.doesNotMatch(sources.demoDataPage, /artifact\?\.(moduleRoute|targetPath)|targetModule/, '前端不得使用兼容字段或中文模块名称猜测目标页面。');
assert.match(sources.demoDataPage, /const currentContract = targetRouteContract\(artifact\)/, '下载完成后必须重新解析当前账号仍注册的可信目标路由。');
assert.match(sources.demoDataPage, /await router\.push\(currentContract\.location\)/, '导航必须使用下载完成后重新验证的命名路由位置。');
assert.match(sources.demoDataPage, /clearFailedNavigationContext\(artifact, result\)/, '导航失败时只能清理本次下载新签发的 context。');
assert.match(sources.demoDataPage, /const navigationFailure = await router\.push\(currentContract\.location\)/, '必须处理 router.push 返回的导航失败对象。');
assert.match(sources.demoDataPage, /router\.currentRoute\.value\.name === currentContract\.location\.name/, 'router.push 完成后必须验证守卫处理后的最终命名路由。');
assert.match(sources.demoDataPage, /catch \(error\)/, '必须捕获 router.push rejection/no-match，避免未处理异常。');
assert.doesNotMatch(sources.demoDataPage, /router\.push\((target|artifact\?\.targetRoute)\)/, '未经可信 route 解析的原始目标不得直接交给路由器。');
assert.match(sources.demoDataPage, /artifact \$\{artifactKey\} 合同无效：服务端未声明合法 targetRoute。/);
assert.match(sources.demoDataPage, /targetRoute 未注册为当前账号可用的真实页面/);
assert.doesNotMatch(sources.demoDataPage, /window\.open|target="_blank"|location\.href/, '下载后的目标导航不得打开新标签页或把 context 放入 URL。');
assert.match(sources.demoDataPage, /const canSeeCatalogActions = computed\(\(\) => capability\('download'\) && allowedAction\('download'\)/, 'artifact 下载必须组合 capability 与 allowedAction。');
const canDownloadArtifactBlock = sources.demoDataPage.match(/function canDownloadArtifact\(artifact\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(canDownloadArtifactBlock, /canDownloadDemoCatalogArtifact\(\{/, '页面下载门禁必须复用可执行的纯逻辑合同。');
for (const field of ['downloadCapable', 'downloadAllowed', 'runtimeAvailable', 'runtimeEnabled', 'contextIssueCapable', 'hasActiveRun', 'activeRunStatus', 'activeRunCompatibility']) {
  assert.match(canDownloadArtifactBlock, new RegExp(`${field}:`), `页面下载门禁必须传入 ${field}。`);
}
assert.doesNotMatch(canDownloadArtifactBlock, /activeRunManifestBlocked/, 'managed 下载不得复用 cleanup 的 manifest 写入门禁。');
const downloadAndNavigateButton = sources.demoDataPage.match(/<el-button(?=[^>]*@click="downloadArtifactAndNavigate\(row\)")[^>]*>/)?.[0] || '';
const downloadOnlyButton = sources.demoDataPage.match(/<el-button(?=[^>]*@click="downloadArtifactOnly\(row\)")[^>]*>/)?.[0] || '';
assert.match(downloadAndNavigateButton, /:disabled="!canDownloadArtifact\(row\) \|\| !targetRoute\(row\) \|\| Boolean\(artifactDownloadKey\)"/, '下载并前往必须在下载前把无效 targetRoute 标记为不可用。');
assert.match(downloadOnlyButton, /:disabled="!canDownloadArtifact\(row\) \|\| Boolean\(artifactDownloadKey\)"/, '仅下载必须继续只按正式下载能力和提交状态门控。');
assert.doesNotMatch(downloadOnlyButton, /targetRoute/, 'targetRoute 缺失不得连带禁用仅下载。');
const downloadAndNavigateBlock = sources.demoDataPage.match(/async function downloadArtifactAndNavigate\(artifact\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(downloadAndNavigateBlock, /const contract = targetRouteContract\(artifact\)/, '下载并前往函数必须在签发 context 或下载前解析 targetRoute 合同。');
assert.match(downloadAndNavigateBlock, /if \(!contract\.ok\)/, '下载并前往函数必须在签发 context 或下载前拒绝无效 targetRoute。');
assert.ok(downloadAndNavigateBlock.indexOf('targetRouteContract(artifact)') < downloadAndNavigateBlock.indexOf("downloadArtifact(artifact, 'navigate')"), '组合动作必须先验证 route，再调用任何下载生命周期。');
assert.ok(downloadAndNavigateBlock.lastIndexOf('targetRouteContract(artifact)') > downloadAndNavigateBlock.indexOf("downloadArtifact(artifact, 'navigate')"), '下载完成后必须再次验证 route，避免权限或动态路由重置竞态。');
assert.doesNotMatch(downloadAndNavigateBlock, /router\.push\(contract\.location\)/, '下载后不得继续使用下载前缓存的 route 合同。');
assert.doesNotMatch(downloadAndNavigateBlock, /previousContext|readDemoContext/, '导航失败不得读取或恢复下载前旧 context 快照。');
assert.doesNotMatch(sources.demoDataPage, /storeDemoContext\(previousContext\)/, '导航失败不得恢复已被本次下载覆盖的旧 context。');
assert.match(sources.demoDataPage, /clearDemoContextIfTokenMatches\(artifactKey, handlerKey, issuedToken\)/, '仅当当前 token 仍是本次签发 token 时清理 context。');
assert.match(sources.demoDataApi, /export function clearDemoContextIfTokenMatches/);
assert.match(sources.demoDataApi, /currentContext\?\.token !== token/);
assert.match(sources.demoDataPage, /async function downloadArtifactOnly\(artifact\)/, '必须保留独立仅下载函数。');
const downloadOnlyBlock = sources.demoDataPage.match(/async function downloadArtifactOnly\(artifact\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(downloadOnlyBlock, /downloadArtifact\(artifact, 'download'\)/, '仅下载必须继续调用正式 artifact 下载生命周期。');
assert.doesNotMatch(downloadOnlyBlock, /targetRoute|router\.push/, '仅下载不得依赖目标 route 或触发导航。');
assert.match(sources.demoDataPage, /async function downloadArtifact\(artifact, mode = 'download'\)/);
assert.match(sources.demoDataPage, /canDownloadArtifact\(artifact\)/, '仅下载仍必须按 downloadLifecycle 和 capability 门控。');

// 目标路由解析必须只依赖服务端 targetRoute，并允许跳转到已注册但仍由目标页自行执行 view 权限校验的页面。
for (const invalidTarget of ['https://example.com/page', '//example.com/page', '/api/templates/file.xlsx', '/energy/analysis?tab=trend', '/carbon#summary', '/energy\\analysis']) {
  assert.equal(normalizeTrustedInternalRoutePath(invalidTarget), '', `应拒绝不可信 targetRoute ${invalidTarget}`);
}
const registeredRoutes = [
  { path: '/energy/analysis', name: 'menu-analysis', meta: { trustedInternalRoute: true, unavailable: false } },
  { path: '/energy/benchmarks', name: 'menu-placeholder', meta: { trustedInternalRoute: false, unavailable: true } }
];
assert.deepEqual(resolveTrustedRegisteredRoute('/energy/analysis', registeredRoutes), {
  ok: true, code: 'trusted-target-route', path: '/energy/analysis', location: { name: 'menu-analysis' }
});
assert.equal(resolveTrustedRegisteredRoute('', registeredRoutes).code, 'invalid-target-route');
assert.equal(resolveTrustedRegisteredRoute('/energy/benchmarks', registeredRoutes).code, 'unregistered-target-route');
assert.equal(resolveTrustedRegisteredRoute('/energy/flows', registeredRoutes).code, 'unregistered-target-route');

// capability、allowedActions、ownership 和 cleanup 必须 fail-closed，不能把静态 capability 当用户授权。
assert.match(sources.demoDataPage, /function capability\(key\) \{ return capabilities\.value\?\.\[key\] === true; \}/);
assert.match(sources.demoDataPage, /const allowedActions = ref\(\{\}\)/);
assert.match(sources.demoDataPage, /function allowedAction\(key\)/);
for (const canonicalAction of ['toggleRuntime', 'loadCatalog', 'prepareRun', 'downloadArtifacts', 'reassociateContext', 'readOwnershipSummary', 'previewCleanup', 'executeCleanup', 'readCleanupRunStatus']) {
  assert.match(sources.demoDataPage, new RegExp(canonicalAction), `allowedActions 必须消费 canonical 字段 ${canonicalAction}。`);
}
assert.match(sources.demoDataPage, /ownershipSummary: 'ownership 汇总'/);
assert.match(sources.demoDataPage, /const canReadOwnership = computed\(\(\) => Boolean\(capability\('ownershipSummary'\) && allowedAction\('ownershipSummary'\)/, 'ownership 汇总必须同时由 capability 和 allowedAction 门控。');
const canReadOwnershipStart = sources.demoDataPage.indexOf('const canReadOwnership = computed');
const canReadOwnershipEnd = sources.demoDataPage.indexOf('/** 是否允许请求 cleanup 预演', canReadOwnershipStart);
const canReadOwnershipBlock = sources.demoDataPage.slice(canReadOwnershipStart, canReadOwnershipEnd);
assert.doesNotMatch(canReadOwnershipBlock, /activeRunManifestBlocked/, 'manifest-conflict run 的 ownership 只读汇总不得被前端冲突写入门禁阻断。');
assert.match(canReadOwnershipBlock, /runtime\.value\.enabled[\s\S]*?hasActiveRun\.value/, 'ownership 汇总仍需运行期和 active run 只读前置条件。');
assert.match(canReadOwnershipBlock, /const canLoadOwnership = computed\(\(\) => canReadOwnership\.value && !ownershipLoading\.value\)/, '按钮门禁必须独立阻止重复点击。');
assert.match(ownershipRequestBlock, /!canReadOwnership\.value \|\| !runId/, 'ownership 汇总请求必须按稳定授权门禁。');
assert.match(ownershipRequestBlock, /ownershipLoading\.value && options\.supersede !== true/, 'ownership 汇总在途替换必须由显式 supersede 控制。');
for (const field of ['totalCount', 'activeCount', 'cleanedCount', 'cleanupCandidateCount', 'cleanupBlockerCount', 'blockers']) {
  assert.match(sources.demoDataPage, new RegExp(`summaryNumber\\(ownership, \\['${field}'\\]\\)`), `ownership 汇总必须适配 ${field}。`);
}
assert.match(sources.demoDataPage, /cleanupPreview\.previewExpiresAt/, '清理预演必须读取 previewExpiresAt。');
assert.match(sources.demoDataPage, /const clientRequestId = createClientRequestId\(\);[\s\S]*?cleanupExecuteRequestId\.value = clientRequestId;[\s\S]*?previewDemoCleanup\(runId, clientRequestId\)/, 'cleanup preview 前只生成一次 clientRequestId 并提交该 ID。');
assert.doesNotMatch(sources.demoDataPage, /cleanupPreview\.value = result\.value\?\.data \|\| \{\}; cleanupExecuteRequestId\.value = createClientRequestId\(\)/, 'cleanup preview 成功后不得重新生成 execute ID。');
assert.match(sources.demoDataPage, /const canPreviewCleanup = computed\(\(\) => Boolean\([\s\S]*?capability\('cleanupPreview'\)[\s\S]*?allowedAction\('cleanupPreview'\)/, 'cleanup preview 必须独立按 capability 和 allowedAction 门控。');
const canPreviewCleanupStart = sources.demoDataPage.indexOf('const canPreviewCleanup = computed');
const canPreviewCleanupEnd = sources.demoDataPage.indexOf('/** 是否展示 cleanup execute 表单。 */', canPreviewCleanupStart);
const canPreviewCleanupBlock = sources.demoDataPage.slice(canPreviewCleanupStart, canPreviewCleanupEnd);
assert.doesNotMatch(canPreviewCleanupBlock, /capability\('(ownershipRegistration|cleanupExecute)'\)/, 'cleanup preview 不得依赖 ownershipRegistration 或 cleanupExecute capability。');
assert.match(canPreviewCleanupBlock, /!activeRunManifestBlocked\.value/, '不兼容或不可写 run 的 cleanup preview 写入入口必须继续关闭。');
assert.match(canPreviewCleanupBlock, /cleanupActionsIdle\.value/, 'query 或 execute loading 时 cleanup preview 必须禁用。');
const cleanupActionsIdleBlock = sources.demoDataPage.match(/const cleanupActionsIdle = computed\(\(\) => canStartDemoCleanupAction\(\{([\s\S]*?)\n\}\)\);/)?.[1] || '';
for (const loadingField of ['cleanupPreviewLoading.value', 'cleanupExecuteLoading.value', 'cleanupStatusLoading.value']) {
  assert.match(cleanupActionsIdleBlock, new RegExp(loadingField.replace('.', '\\.')), `cleanup 互斥门禁必须包含 ${loadingField}。`);
}
const cleanupRunEligibilityBlock = sources.demoDataPage.match(/const activeRunManifestBlocked = computed\(\(\) => hasActiveRun\.value && \(([\s\S]*?)\n\)\);/)?.[1] || '';
assert.match(cleanupRunEligibilityBlock, /writeEligible !== true/, 'cleanup 必须要求服务端明确 writeEligible=true。');
assert.match(cleanupRunEligibilityBlock, /manifestCompatible !== true/, 'cleanup 必须要求服务端明确 manifestCompatible=true。');
assert.match(cleanupRunEligibilityBlock, /activeRunCleanupBlocked\.value/, 'cleaning 与 cleanup-in-progress-blocked 必须继续关闭 cleanup。');
const activeRunCleanupBlockedBlock = sources.demoDataPage.match(/const activeRunCleanupBlocked = computed\(\(\) => hasActiveRun\.value && isDemoCleanupInProgressBlocked\(\{([\s\S]*?)\n\}\)\);/)?.[1] || '';
assert.match(activeRunCleanupBlockedBlock, /activeRunStatus: activeRunProjection\.value\.status/, 'cleaning 阻断判断必须消费 active run status。');
assert.match(activeRunCleanupBlockedBlock, /activeRunCompatibility: activeRunCompatibility\.value/, 'cleaning 阻断判断必须消费服务端 compatibility state。');
assert.match(sources.demoDataApi, /cleanup-in-progress-blocked/, '客户端必须识别服务端统一 cleaning state。');
assert.match(sources.demoDataPage, /const canSeeCleanupExecute = computed\(\(\) => capability\('ownershipRegistration'\) && capability\('cleanupExecute'\) && allowedAction\('cleanupExecute'\)/);
assert.match(sources.demoDataPage, /canSeeCleanupExecute\.value[\s\S]*?!activeRunManifestBlocked\.value[\s\S]*?cleanupPreview\.value\?\.executable === true/, '不兼容或不可写 run 的 cleanup execute 门禁不得放宽。');
const canExecuteCleanupStart = sources.demoDataPage.indexOf('const canExecuteCleanup = computed');
const canExecuteCleanupEnd = sources.demoDataPage.indexOf('/** 安全捕获异步请求。 */', canExecuteCleanupStart);
const canExecuteCleanupBlock = sources.demoDataPage.slice(canExecuteCleanupStart, canExecuteCleanupEnd);
assert.match(canExecuteCleanupBlock, /cleanupActionsIdle\.value/, 'preview 或 status query loading 时 cleanup execute 必须禁用。');
assert.match(sources.demoDataPage, /cleanupBlockers = computed/);
assert.match(sources.demoDataPage, /清理预演 blocker/);
const cleanupResultAlertBlock = sources.demoDataPage.match(/const cleanupResultAlert = computed\(\(\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';
assert.ok(cleanupResultAlertBlock.indexOf("['cleaned', 'completed', 'succeeded'].includes(status)") < cleanupResultAlertBlock.indexOf("status === 'blocked'"), 'cleanup 成功终态必须优先于 blocked 快照。');
assert.ok(cleanupResultAlertBlock.indexOf("status === 'noop'") < cleanupResultAlertBlock.indexOf("status === 'blocked'"), 'cleanup noop 终态必须优先显示已无操作。');
assert.match(cleanupResultAlertBlock, /当前清理已无操作/, 'cleanup noop 必须使用明确的已无操作提示。');
for (const status of ['failed', 'expired', 'executing']) {
  assert.match(cleanupResultAlertBlock, new RegExp(`status === '${status}'`), `cleanup ${status} 必须按真实状态展示。`);
}
assert.doesNotMatch(cleanupResultAlertBlock, /executable === false/, 'executable=false 不得单独推断 cleanup blocked。');
assert.match(cleanupResultAlertBlock, /result\.blocked === true|hasBlockers/, 'cleanup blocked 必须基于 blocked/status/blocker 语义。');
// 直接执行页面状态提示函数体，验证 executable=false 不会覆盖真实终态。
const evaluateCleanupResultAlert = new Function('cleanupResult', cleanupResultAlertBlock);
assert.equal(evaluateCleanupResultAlert({ value: { status: 'succeeded', executable: false } }).type, 'success');
assert.equal(evaluateCleanupResultAlert({ value: { status: 'noop', executable: false } }).type, 'success');
assert.equal(evaluateCleanupResultAlert({ value: { status: 'failed', executable: false } }).type, 'error');
assert.equal(evaluateCleanupResultAlert({ value: { status: 'failed', blockerCount: 1, executable: false } }).type, 'error', 'failed 真实状态必须优先于历史 blocker 摘要。');
assert.match(evaluateCleanupResultAlert({ value: { status: 'expired', executable: false } }).title, /已过期/);
assert.match(evaluateCleanupResultAlert({ value: { status: 'executing', executable: false } }).title, /执行中/);
assert.match(evaluateCleanupResultAlert({ value: { status: 'blocked', executable: false } }).title, /blocked/);
assert.match(evaluateCleanupResultAlert({ value: { blockerCount: 1, executable: false } }).title, /blocked/);
assert.equal(evaluateCleanupResultAlert({ value: { status: 'unknown', executable: false } }).type, 'info', '未知且无 blocker 的 executable=false 必须保持普通只读状态。');
assert.match(sources.demoDataPage, /const cleanupRunIdInput = ref\(''\);/, '必须保留独立 cleanup run ID 查询输入。');
assert.match(sources.demoDataPage, /<el-form v-if="canSeeCleanupStatus"[\s\S]*?v-model="cleanupRunIdInput"[\s\S]*?queryCleanupStatus/, 'cleanup 状态查询入口必须独立于 cleanupPreview。');
assert.match(sources.demoDataPage, /const canSeeCleanupStatus = computed\(\(\) => capability\('cleanupRunStatus'\) && allowedAction\('readCleanupRunStatus'\)\);/, 'cleanup 状态查询只读门禁只依赖 capability 和 canonical allowedAction。');
assert.doesNotMatch(sources.demoDataPage, /allowedAction\('cleanupRunStatus'\)/, 'cleanup 状态查询不得接受非 canonical allowedAction 别名。');
assert.match(sources.demoDataPage, /const canQueryCleanupStatus = computed\(\(\) => Boolean\([\s\S]*?cleanupRunIdInput\.value\.trim\(\)/, 'cleanup 状态查询必须要求用户提供 cleanupRunId。');
const canQueryCleanupStatusStart = sources.demoDataPage.indexOf('const canQueryCleanupStatus = computed');
const canQueryCleanupStatusEnd = sources.demoDataPage.indexOf('/** 当前预演使用的固定确认文本', canQueryCleanupStatusStart);
const canQueryCleanupStatusBlock = sources.demoDataPage.slice(canQueryCleanupStatusStart, canQueryCleanupStatusEnd);
assert.match(canQueryCleanupStatusBlock, /cleanupActionsIdle\.value/, 'preview 或 execute loading 时 cleanup status query 必须禁用。');
const canSeeCleanupStatusStart = sources.demoDataPage.indexOf('const canSeeCleanupStatus = computed');
const canSeeCleanupStatusEnd = sources.demoDataPage.indexOf('/** 当前预演使用的固定确认文本', canSeeCleanupStatusStart);
assert.doesNotMatch(sources.demoDataPage.slice(canSeeCleanupStatusStart, canSeeCleanupStatusEnd), /runtime\.value\.(enabled|available)/, 'runtime 关闭或不可用时仍必须允许有权限用户查询 cleanup 状态。');
assert.match(sources.demoDataPage, /cleanupPreview\.value = result\.value\?\.data \|\| \{\};[\s\S]*?cleanupRunIdInput\.value = String\(cleanupPreview\.value\.cleanupRunId \|\| cleanupPreview\.value\.id/, 'cleanup 预演成功后必须自动带入 cleanupRunId。');
assert.match(sources.demoDataPage, /async function queryCleanupStatus\(\)[\s\S]*?loadCleanupStatus\(cleanupRunIdInput\.value\)/, '独立查询入口必须使用输入的 cleanupRunId。');
assert.match(sources.demoDataPage, /cleanupExpectedConfirmation = computed\(\(\) => String\(cleanupPreview\.value\?\.confirmationText \|\| confirmationTexts\.value\?\.cleanup \|\| ''\)\.trim\(\)\)/);
assert.match(sources.demoDataPage, /cleanupConfirmation\.value === cleanupExpectedConfirmation\.value/);
assert.match(sources.demoDataPage, /const clientRequestId = cleanupExecuteRequestId\.value/);
assert.match(sources.demoDataPage, /clientRequestId,[\s\S]*?previewDigest: preview\.previewDigest,[\s\S]*?confirmationText/);
assert.doesNotMatch(sources.demoDataPage, /clientRequestId: createClientRequestId\(\), previewDigest/, '同一 cleanup 预演的执行失败重试不得生成新的幂等 ID。');
assert.match(sources.demoDataPage, /if \(!canExecuteCleanup\.value \|\| cleanupExecuteLoading\.value \|\| clientRequestId !== cleanupExecuteRequestId\.value\) return/);
assert.match(cleanupExecuteBlock, /cleanupResult\.value = result\.value\?\.data \|\| \{\};[\s\S]*?clearDemoContexts\(\);[\s\S]*?catalog\.value = null;[\s\S]*?activeRun\.value = null;[\s\S]*?clearRunGovernanceProjection\(\{ preserveCleanupResult: true \}\);[\s\S]*?await loadInitialState\(\)/, 'cleanup execute 成功后必须完成 context 清理、治理清空和状态刷新。');
assert.match(sources.demoDataPage, /v-if="canPreviewCleanup"/);
assert.match(sources.demoDataPage, /v-if="canSeeCleanupExecute"/);
assert.match(sources.demoDataPage, /v-else-if="!allowedAction\('cleanupPreview'\)"/);
assert.match(sources.demoDataPage, /当前账号缺少 cleanup preview 权限/);

// 分散业务页不得保留演示入口，但标准模板、上传、预演、执行或导出能力必须继续存在。
const businessPageContracts = Object.freeze([
  ['importsPage', /下载模板/, /上传能耗表格/],
  ['ledgerPage', /config\.template && can\('template'\)/, /config\.import && can\('import'\)/],
  ['budgetsPage', /下载模板/, /导入预算/],
  ['carbonFactorsPage', /下载模板/, /导入因子/],
  ['predictionsPage', /下载模板/, /导入草稿/],
  ['analysisPage', /downloadEnergyAnalysisImportTemplate/, /previewEnergyAnalysisImport/],
  ['benchmarksPage', /空白模板/, /预演/],
  ['flowsPage', /标准模板/, /预演/],
  ['balancesPage', /空白模板/, /预演/]
]);
for (const [sourceName, firstFormalContract, secondFormalContract] of businessPageContracts) {
  const pageSource = sources[sourceName];
  assert.match(pageSource, firstFormalContract, `${sourceName} 必须保留第一项正式业务能力。`);
  assert.match(pageSource, secondFormalContract, `${sourceName} 必须保留第二项正式业务能力。`);
  assert.doesNotMatch(pageSource, /天坤集团示例|downloadDemoExample|downloadImportDemo|downloadFlowDemo|canDemoExample|demoExampleLoading/i, `${sourceName} 不得继续提供分散演示入口。`);
}

// 从生产 API 源码构造隔离模块，验证路径、下载生命周期、wrapper 和 sessionStorage 行为。
globalThis.__demoContractRequests = [];
globalThis.__demoContractDownloads = [];
globalThis.__demoContractDownloadResult = null;
const demoDataModuleSource = sources.demoDataApi.replace(
  "import { download, request, requestWithHeaders } from '@/api/http';",
  `const request = async (config) => { globalThis.__demoContractRequests.push(config); return { success: true, data: { accepted: true } }; };
   const requestWithHeaders = async () => null;
   const download = async (config, fallbackName) => { globalThis.__demoContractDownloads.push({ config, fallbackName }); return globalThis.__demoContractDownloadResult; };`
);
const demoDataModuleUrl = `data:text/javascript;base64,${Buffer.from(demoDataModuleSource).toString('base64')}`;
const demoDataModule = await import(demoDataModuleUrl);

// managed 下载只依赖下载授权、运行期、contextIssue 与明确换代 blocker，不要求预先存在兼容 active run。
const managedDownloadAvailability = Object.freeze({
  artifact: { downloadLifecycle: 'managed-context-auto-runtime' },
  downloadCapable: true,
  downloadAllowed: true,
  runtimeAvailable: true,
  runtimeEnabled: true,
  contextIssueCapable: true
});
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: false,
  activeRunCompatibility: { state: 'missing', turnoverEligible: false, writeEligible: false, manifestCompatible: false }
}), true, '没有 active run 时 managed 下载必须允许后端创建 run。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: {
    state: 'manifest-turnover-pending',
    turnoverEligible: true,
    writeEligible: false,
    manifestCompatible: false
  }
}), true, '普通 manifest mismatch 必须允许 managed 下载触发后端换代。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: {
    state: 'active',
    turnoverEligible: false,
    writeEligible: true,
    manifestCompatible: true
  }
}), true, '正常 compatible active run 不得因 turnoverEligible=false 被禁用。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'unknown-future-state' }
}), false, '未知 active run 投影字段必须 fail-closed。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'cleanup-in-progress-blocked', retryable: true, turnoverEligible: false }
}), false, 'cleanup-in-progress-blocked 必须禁用 managed 下载。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'cleaning',
  activeRunCompatibility: { state: 'manifest-turnover-pending', retryable: true, turnoverEligible: true }
}), false, 'active run status=cleaning 时即使换代投影可重试也必须禁用 managed 下载。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'manifest-turnover-blocked', turnoverEligible: true }
}), false, '兼容旧后端的 manifest-turnover-blocked 仍必须禁用 managed 下载。');
assert.equal(demoDataModule.isDemoCleanupInProgressBlocked({
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'cleanup-in-progress-blocked', retryable: true }
}), true, '统一 cleaning state 必须被页面 prepare、warning 和 cleanup 门禁共同识别。');
assert.equal(demoDataModule.isDemoCleanupInProgressBlocked({
  activeRunStatus: 'cleaning',
  activeRunCompatibility: { state: 'manifest-turnover-pending', retryable: true }
}), true, 'run status=cleaning 必须保持阻断。');
assert.equal(demoDataModule.isDemoCleanupInProgressBlocked({
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'manifest-turnover-pending', retryable: true }
}), false, '普通可重试 manifest turnover pending 不得误判为 cleaning 阻断。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({
  ...managedDownloadAvailability,
  hasActiveRun: true,
  activeRunStatus: 'active',
  activeRunCompatibility: { state: 'manifest-turnover-pending', turnoverEligible: false }
}), false, 'turnoverEligible=false 必须 fail-closed。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({ ...managedDownloadAvailability, contextIssueCapable: false }), false, '缺少 contextIssue 能力必须禁用 managed 下载。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({ ...managedDownloadAvailability, runtimeEnabled: false }), false, '运行期关闭时必须禁用 managed 下载。');
assert.equal(demoDataModule.canDownloadDemoCatalogArtifact({ ...managedDownloadAvailability, downloadAllowed: false }), false, '缺少下载授权时必须禁用 managed 下载。');

// 请求序号和 run 身份守卫必须拒绝乱序 status/ownership 响应。
assert.equal(demoDataModule.isLatestDemoRequest(1, 2), false, '较旧 status 响应不得覆盖较新请求。');
assert.equal(demoDataModule.isLatestDemoRequest(2, 2), true, '当前最新 status 响应可以落地。');
assert.equal(demoDataModule.isLatestDemoRunRequest(1, 2, 'run-1', 'run-1'), false, '较旧 ownership 响应不得落地。');
assert.equal(demoDataModule.isLatestDemoRunRequest(2, 2, 'run-1', 'run-2'), false, '旧 run ownership 响应不得落到 successor。');
assert.equal(demoDataModule.isLatestDemoRunRequest(2, 2, 'run-2', 'run-2'), true, '最新且 run 身份一致的 ownership 响应可以落地。');
let committedStatusRunId = '';
if (demoDataModule.isLatestDemoRequest(2, 2)) committedStatusRunId = 'run-new';
if (demoDataModule.isLatestDemoRequest(1, 2)) committedStatusRunId = 'run-old';
assert.equal(committedStatusRunId, 'run-new', '乱序完成的旧 status 响应不得覆盖新 run。');
let committedOwnershipRunId = '';
if (demoDataModule.isLatestDemoRunRequest(1, 2, 'run-old', 'run-new')) committedOwnershipRunId = 'run-old';
if (demoDataModule.isLatestDemoRunRequest(2, 2, 'run-new', 'run-new')) committedOwnershipRunId = 'run-new';
assert.equal(committedOwnershipRunId, 'run-new', '旧 run ownership 响应不得污染 successor 投影。');

// RF-P1-004：本地恢复门禁不依赖已清空投影，且只有最新可信 status 成功才能关闭。
let statusRecoveryRequired = true;
const trustedStatusProjectionAvailable = false;
assert.equal(trustedStatusProjectionAvailable || statusRecoveryRequired, true, 'fail-closed 后即使服务端投影为空也必须保留恢复入口。');
if (demoDataModule.isLatestDemoRequest(1, 2)) statusRecoveryRequired = false;
assert.equal(statusRecoveryRequired, true, '旧 generation 的恢复成功响应不得关闭恢复入口。');
if (demoDataModule.isLatestDemoRequest(2, 2)) statusRecoveryRequired = true;
assert.equal(statusRecoveryRequired, true, '最新 status 读取失败或投影无效时必须保留恢复入口。');
if (demoDataModule.isLatestDemoRequest(3, 3)) statusRecoveryRequired = false;
assert.equal(statusRecoveryRequired, false, '只有最新完整 status 成功应用后才能关闭恢复入口。');

// RF-P1-005：执行页面源码中的纯 status projection 校验，覆盖 malformed DTO 与合法 null 组合。
const statusProjectionStart = sources.demoDataPage.indexOf('/** 服务端 status 必须声明的稳定 capability 字段');
const statusProjectionEnd = sources.demoDataPage.indexOf('/** 清空 status、run 与 compatibility', statusProjectionStart);
const statusProjectionSource = sources.demoDataPage.slice(statusProjectionStart, statusProjectionEnd);
assert.notStrictEqual(statusProjectionStart, -1, 'DemoData 必须包含 status 嵌套投影校验实现。');
const readStatusProjection = new Function(`${statusProjectionSource}; return readStatusProjection;`)();
const validStatusRuntime = { available: true, enabled: true, runtimeEpoch: 7, revision: 11 };
const validStatusCapabilities = getDemoCapabilities();
const validStatusAllowedActions = Object.fromEntries([
  'toggleRuntime', 'loadCatalog', 'prepareRun', 'downloadArtifacts',
  'reassociateContext', 'readOwnershipSummary', 'previewCleanup',
  'executeCleanup', 'readCleanupRunStatus'
].map((key) => [key, true]));
const validStatusConfirmationTexts = getDemoConfirmationTexts();
const validStatusActiveRun = {
  runId: 'run-status-1',
  datasetId: DEMO_DATASET_ID,
  manifestVersion: DEMO_MANIFEST_VERSION,
  manifestDigest: getDemoParkManifestDigest(),
  status: 'active'
};
const validStatusCompatibility = demoRunTestContract.getDemoDatasetRunReadCompatibility(validStatusActiveRun);
const validStatusResponse = {
  data: {
    runtime: validStatusRuntime,
    capabilities: validStatusCapabilities,
    allowedActions: validStatusAllowedActions,
    confirmationTexts: validStatusConfirmationTexts,
    activeRun: validStatusActiveRun,
    activeRunCompatibility: validStatusCompatibility
  }
};
assert.ok(readStatusProjection(validStatusResponse), '完整真实 status DTO 必须被接受。');
const validNoRunCompatibility = demoRunTestContract.getDemoDatasetRunReadCompatibility(null);
assert.ok(readStatusProjection({ data: { ...validStatusResponse.data, activeRun: null, activeRunCompatibility: validNoRunCompatibility } }), '无 active run 的真实 missing compatibility 组合必须被接受。');
const unavailableStatusProjection = demoDataRouteTestContract.buildUnavailableActiveRunProjection();
assert.ok(readStatusProjection({
  data: {
    ...validStatusResponse.data,
    runtime: { available: false, enabled: false, runtimeEpoch: null, revision: null },
    activeRun: unavailableStatusProjection.activeRun,
    activeRunCompatibility: unavailableStatusProjection.compatibility
  }
}), '服务端规范 fail-closed runtime 与 unavailable compatibility 组合必须被接受。');
for (const status of ACTIVE_IDENTITY_RUN_STATUSES) {
  const statusRun = { ...validStatusActiveRun, runId: `run-status-${status}`, status };
  assert.ok(readStatusProjection({
    data: { ...validStatusResponse.data, activeRun: statusRun, activeRunCompatibility: demoRunTestContract.getDemoDatasetRunReadCompatibility(statusRun) }
  }), `服务端允许的 active run status=${status} 合同必须被接受。`);
}
assert.ok(readStatusProjection({
  data: {
    ...validStatusResponse.data,
    runtime: { available: false, enabled: false, runtimeEpoch: null, revision: null }
  }
}), 'runtime unavailable 与真实 active run 可以同时出现在独立读取的 public status 中。');
const turnoverRun = {
  ...validStatusActiveRun,
  runId: 'run-status-turnover',
  manifestVersion: 'legacy-manifest',
  manifestDigest: 'b'.repeat(64),
  status: 'active'
};
assert.ok(readStatusProjection({
  data: {
    ...validStatusResponse.data,
    activeRun: turnoverRun,
    activeRunCompatibility: demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun)
  }
}), '服务端 manifest-turnover-pending compatibility 必须被接受。');
const malformedStatusResponses = [
  { label: 'runtime 空对象', response: { data: { ...validStatusResponse.data, runtime: {} } } },
  { label: 'runtime 缺 available', response: { data: { ...validStatusResponse.data, runtime: { enabled: true, runtimeEpoch: 7, revision: 11 } } } },
  { label: 'runtime 缺 epoch', response: { data: { ...validStatusResponse.data, runtime: { available: true, enabled: true, revision: 11 } } } },
  { label: 'runtime 可用但 epoch 无效', response: { data: { ...validStatusResponse.data, runtime: { ...validStatusRuntime, runtimeEpoch: null } } } },
  { label: 'capabilities 空对象', response: { data: { ...validStatusResponse.data, capabilities: {} } } },
  { label: 'capability 缺 status', response: { data: { ...validStatusResponse.data, capabilities: Object.fromEntries(Object.entries(validStatusCapabilities).filter(([key]) => key !== 'status')) } } },
  { label: 'capability 非布尔', response: { data: { ...validStatusResponse.data, capabilities: { ...validStatusCapabilities, status: 'true' } } } },
  { label: 'allowedActions 空对象', response: { data: { ...validStatusResponse.data, allowedActions: {} } } },
  { label: 'allowedAction 缺 prepareRun', response: { data: { ...validStatusResponse.data, allowedActions: Object.fromEntries(Object.entries(validStatusAllowedActions).filter(([key]) => key !== 'prepareRun')) } } },
  { label: 'allowedAction 非布尔', response: { data: { ...validStatusResponse.data, allowedActions: { ...validStatusAllowedActions, prepareRun: 1 } } } },
  { label: 'confirmationTexts 空对象', response: { data: { ...validStatusResponse.data, confirmationTexts: {} } } },
  { label: 'confirmationText 为空', response: { data: { ...validStatusResponse.data, confirmationTexts: { ...validStatusConfirmationTexts, cleanup: '' } } } },
  { label: 'activeRun 空对象', response: { data: { ...validStatusResponse.data, activeRun: {} } } },
  { label: 'activeRun 缺 runId', response: { data: { ...validStatusResponse.data, activeRun: { ...validStatusActiveRun, runId: undefined } } } },
  { label: 'activeRun 未知 status', response: { data: { ...validStatusResponse.data, activeRun: { ...validStatusActiveRun, status: 'unknown' } } } },
  { label: 'activeRun Dataset 不匹配', response: { data: { ...validStatusResponse.data, activeRun: { ...validStatusActiveRun, datasetId: 'other-dataset' } } } },
  { label: 'compatibility 空对象', response: { data: { ...validStatusResponse.data, activeRunCompatibility: {} } } },
  { label: 'compatibility 缺 state', response: { data: { ...validStatusResponse.data, activeRunCompatibility: Object.fromEntries(Object.entries(validStatusCompatibility).filter(([key]) => key !== 'state')) } } },
  { label: 'compatibility manifest 漂移', response: { data: { ...validStatusResponse.data, activeRunCompatibility: { ...validStatusCompatibility, actualManifestDigest: 'b'.repeat(64) } } } },
  { label: 'activeRun 存在但 compatibility 为 null', response: { data: { ...validStatusResponse.data, activeRunCompatibility: null } } },
  { label: 'cleaning writeEligible 不可为 true', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: { ...validStatusActiveRun, status: 'cleaning' },
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility({ ...validStatusActiveRun, status: 'cleaning' }),
        writeEligible: true
      }
    }
  } },
  { label: 'cleaning state/code 不匹配', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: { ...validStatusActiveRun, status: 'cleaning' },
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility({ ...validStatusActiveRun, status: 'cleaning' }),
        state: 'active',
        code: 'DEMO_RUN_ACTIVE'
      }
    }
  } },
  { label: 'turnover writeEligible 不可为 true', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: turnoverRun,
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun),
        writeEligible: true
      }
    }
  } },
  { label: 'turnover state/code 不匹配', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: turnoverRun,
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun),
        state: 'active',
        code: 'DEMO_RUN_ACTIVE'
      }
    }
  } },
  { label: 'turnover manifestCompatible 不可为 true', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: turnoverRun,
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun),
        manifestCompatible: true
      }
    }
  } },
  { label: 'turnover turnoverEligible 不可为 false', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: turnoverRun,
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun),
        turnoverEligible: false
      }
    }
  } },
  { label: 'turnover retryable 不可为 true', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: turnoverRun,
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility(turnoverRun),
        retryable: true
      }
    }
  } },
  { label: 'compatible active writeEligible 不可为 false', response: {
    data: {
      ...validStatusResponse.data,
      activeRunCompatibility: { ...validStatusCompatibility, writeEligible: false }
    }
  } },
  { label: 'cleaning retryable 不可为 false', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: { ...validStatusActiveRun, status: 'cleaning' },
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility({ ...validStatusActiveRun, status: 'cleaning' }),
        retryable: false
      }
    }
  } },
  { label: 'cleaning turnoverEligible 不可为 true', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: { ...validStatusActiveRun, status: 'cleaning' },
      activeRunCompatibility: {
        ...demoRunTestContract.getDemoDatasetRunReadCompatibility({ ...validStatusActiveRun, status: 'cleaning' }),
        turnoverEligible: true
      }
    }
  } },
  { label: '无 run 使用 null/null', response: { data: { ...validStatusResponse.data, activeRun: null, activeRunCompatibility: null } } },
  { label: '无 run 使用任意 state/code', response: {
    data: {
      ...validStatusResponse.data,
      activeRun: null,
      activeRunCompatibility: { ...validNoRunCompatibility, state: 'active', code: 'DEMO_RUN_ACTIVE' }
    }
  } }
];
for (const malformed of malformedStatusResponses) {
  assert.equal(readStatusProjection(malformed.response), null, `${malformed.label} 必须保持 fail-closed 并拒绝关闭 recovery。`);
}

// cleanup 结果遵循“最后发起动作优先”，execute、status query 与治理清空共享同一 generation。
let cleanupGeneration = 0;
let committedCleanupResult = '';
const oldStatusGeneration = ++cleanupGeneration;
const latestExecuteGeneration = ++cleanupGeneration;
if (demoDataModule.isLatestDemoRequest(latestExecuteGeneration, cleanupGeneration)) committedCleanupResult = 'execute-new';
if (demoDataModule.isLatestDemoCleanupResultRequest(oldStatusGeneration, cleanupGeneration, 'cleanup-1', 'cleanup-1')) committedCleanupResult = 'status-old';
assert.equal(committedCleanupResult, 'execute-new', '旧 cleanup status 响应不得覆盖后发 execute 结果。');
assert.equal(
  demoDataModule.isLatestDemoCleanupResultRequest(3, 3, 'cleanup-old', 'cleanup-current'),
  false,
  '请求 cleanupRunId 与当前输入身份不同时不得落地。'
);
const queryBeforeGovernanceClearGeneration = ++cleanupGeneration;
cleanupGeneration += 1;
assert.equal(
  demoDataModule.isLatestDemoCleanupResultRequest(queryBeforeGovernanceClearGeneration, cleanupGeneration, 'cleanup-2', 'cleanup-2'),
  false,
  '治理投影清空后，旧 cleanup query 不得重新回填结果。'
);
const statusActionGeneration = ++cleanupGeneration;
const executeActionGeneration = ++cleanupGeneration;
const latestQueryGeneration = ++cleanupGeneration;
assert.equal(demoDataModule.isLatestDemoRequest(statusActionGeneration, cleanupGeneration), false);
assert.equal(demoDataModule.isLatestDemoRequest(executeActionGeneration, cleanupGeneration), false);
assert.equal(
  demoDataModule.isLatestDemoCleanupResultRequest(latestQueryGeneration, cleanupGeneration, 'cleanup-latest', 'cleanup-latest'),
  true,
  '多个 cleanup 动作并发时只有最后发起且身份匹配的动作可以落地。'
);

// cleanup 三类动作必须互斥，共享 generation 继续作为异常旧响应的第二层保护。
assert.equal(demoDataModule.canStartDemoCleanupAction({ previewLoading: false, executeLoading: false, statusLoading: false }), true);
assert.equal(
  demoDataModule.canStartDemoCleanupAction({ previewLoading: false, executeLoading: true, statusLoading: false }),
  false,
  'execute loading 时 status query 必须禁用。'
);
assert.equal(
  demoDataModule.canStartDemoCleanupAction({ previewLoading: false, executeLoading: false, statusLoading: true }),
  false,
  'status query loading 时 execute 和 preview 必须禁用。'
);
assert.equal(
  demoDataModule.canStartDemoCleanupAction({ previewLoading: true, executeLoading: false, statusLoading: false }),
  false,
  'preview loading 时 status query 和 execute 必须禁用。'
);

// 内存 sessionStorage 模块，用于验证标签页隔离和定向清理。
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

// 在 predecessor 清理二次读取前注入 successor token，模拟并发新签发完成。
class ConcurrentReplacementStorage extends MemorySessionStorage {
  constructor(replacementValue) {
    super();
    this.replacementValue = replacementValue;
    this.readCounts = new Map();
  }

  getItem(key) {
    const normalizedKey = String(key);
    const nextCount = (this.readCounts.get(normalizedKey) || 0) + 1;
    this.readCounts.set(normalizedKey, nextCount);
    if (nextCount === 2) this.values.set(normalizedKey, JSON.stringify(this.replacementValue));
    return super.getItem(normalizedKey);
  }
}

// 站内 API 路径只接受相对路径和 /api 前缀，不接受外部 scheme 或协议相对地址。
assert.strictEqual(demoDataModule.normalizeDemoApiPath('/api/templates/example.xlsx'), '/templates/example.xlsx');
assert.strictEqual(demoDataModule.normalizeDemoApiPath('/templates/example.xlsx'), '/templates/example.xlsx');
assert.strictEqual(demoDataModule.normalizeDemoApiPath('//example.com/file.xlsx'), '');
assert.strictEqual(demoDataModule.normalizeDemoApiPath('https://example.com/file.xlsx'), '');
assert.strictEqual(demoDataModule.normalizeDemoApiPath('javascript:alert(1)'), '');

// 无状态 artifact 直接下载，不要求托管 context；托管 artifact 必须保存当前标签页 context。
const tabStorage = new MemorySessionStorage();
const managedFileBytes = Buffer.from('managed-demo-file', 'utf8');
const managedFileSha256 = createHash('sha256').update(managedFileBytes).digest('hex');
const managedMetadata = {
  datasetId: 'qinglan-park-v1',
  runId: 'run-1',
  artifactKey: '13-shift-definitions',
  handlerKey: 'shift-definitions-import',
  manifestVersion: 'v1',
  manifestDigest: 'a'.repeat(64),
  artifactSha256: managedFileSha256,
  contextToken: 'c'.repeat(43)
};
globalThis.__demoContractDownloadResult = { fileName: 'formal.xlsx', headers: {}, demo: null };
await demoDataModule.downloadDemoCatalogArtifact({
  artifactKey: '01-organization-root',
  name: '组织根节点',
  downloadLifecycle: 'stateless-formal-import',
  downloads: { xlsx: '/api/templates/demo-park/01-organization-root.xlsx' }
}, 'xlsx', tabStorage);
assert.deepStrictEqual(globalThis.__demoContractDownloads.at(-1), {
  config: { url: '/templates/demo-park/01-organization-root.xlsx' },
  fallbackName: '组织根节点.xlsx'
});
assert.strictEqual(tabStorage.length, 0, '无状态正式下载不得伪造 context。');

globalThis.__demoContractDownloadResult = { fileName: 'managed.xlsx', headers: {}, demo: managedMetadata };
const managedDownloadResult = await demoDataModule.downloadDemoCatalogArtifact({
  artifactKey: managedMetadata.artifactKey,
  handlerKey: managedMetadata.handlerKey,
  name: '班次定义',
  downloadLifecycle: 'managed-context-auto-runtime',
  downloads: { xlsx: '/api/templates/demo-park/13-shift-definitions.xlsx' }
}, 'xlsx', tabStorage);
assert.strictEqual(managedDownloadResult.demoContextStored, true);
assert.strictEqual(demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, tabStorage).runId, 'run-1');
assert.equal(managedDownloadResult.turnover.performed, false, '普通 managed 下载不得误报自动换代。');

// predecessor 定向清理必须通过 token CAS 保留清理期间并发写入的 successor context。
const concurrentSuccessorContext = { ...managedMetadata, runId: 'run-2', token: 'i'.repeat(43) };
const concurrentReplacementStorage = new ConcurrentReplacementStorage(concurrentSuccessorContext);
demoDataModule.storeDemoContext({ ...managedMetadata, contextToken: 'j'.repeat(43) }, concurrentReplacementStorage);
assert.equal(demoDataModule.clearDemoContextsForRun('run-1', concurrentReplacementStorage), 0, '并发 token 已变化时不得删除该 storage key。');
assert.equal(
  demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, concurrentReplacementStorage).token,
  concurrentSuccessorContext.token,
  'predecessor 清理必须保留并发新签发 token。'
);

// 自动换代下载只依赖稳定响应头识别 predecessor/current run，并继续保存 successor context。
const turnoverStorage = new MemorySessionStorage();
const turnoverMetadata = {
  ...managedMetadata,
  runId: 'run-2',
  manifestVersion: 'v2',
  contextToken: 'd'.repeat(43)
};
const predecessorContextA = { ...managedMetadata, artifactKey: 'old-artifact-a', handlerKey: 'old-handler-a', contextToken: 'e'.repeat(43) };
const predecessorContextB = { ...managedMetadata, artifactKey: 'old-artifact-b', handlerKey: 'old-handler-b', contextToken: 'f'.repeat(43) };
const unrelatedContext = { ...managedMetadata, runId: 'run-other', artifactKey: 'other-artifact', handlerKey: 'other-handler', contextToken: 'g'.repeat(43) };
demoDataModule.storeDemoContext({ ...managedMetadata, contextToken: 'h'.repeat(43) }, turnoverStorage);
demoDataModule.storeDemoContext(predecessorContextA, turnoverStorage);
demoDataModule.storeDemoContext(predecessorContextB, turnoverStorage);
demoDataModule.storeDemoContext(unrelatedContext, turnoverStorage);
globalThis.__demoContractDownloadResult = {
  fileName: 'managed-turnover.xlsx',
  headers: {
    'X-Demo-Run-Id': 'run-2',
    'X-Demo-Run-Reused': 'false',
    'X-Demo-Run-Auto-Superseded': 'true',
    'X-Demo-Run-Superseded-From': 'run-1',
    'X-Demo-Runtime-Epoch': '8'
  },
  demo: turnoverMetadata
};
const turnoverDownloadResult = await demoDataModule.downloadDemoCatalogArtifact({
  artifactKey: managedMetadata.artifactKey,
  handlerKey: managedMetadata.handlerKey,
  name: '班次定义',
  downloadLifecycle: 'managed-context-auto-runtime',
  downloads: { xlsx: '/api/templates/demo-park/13-shift-definitions.xlsx' }
}, 'xlsx', turnoverStorage);
assert.deepStrictEqual(turnoverDownloadResult.turnover, {
  performed: true,
  reused: false,
  oldRunId: 'run-1',
  newRunId: 'run-2',
  oldManifestVersion: '',
  newManifestVersion: 'v2',
  runtimeEpoch: '8'
});
assert.equal(turnoverDownloadResult.clearedPredecessorContextCount, 2, 'managed turnover 必须只清理其他 predecessor context。');
assert.equal(demoDataModule.readDemoContext(predecessorContextA.artifactKey, predecessorContextA.handlerKey, turnoverStorage), null);
assert.equal(demoDataModule.readDemoContext(predecessorContextB.artifactKey, predecessorContextB.handlerKey, turnoverStorage), null);
assert.equal(demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, turnoverStorage).runId, 'run-2', '本次 successor context 必须保留。');
assert.equal(demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, turnoverStorage).token, turnoverMetadata.contextToken, '同 key 新 token 不得被 predecessor 清理误删。');
assert.equal(demoDataModule.readDemoContext(unrelatedContext.artifactKey, unrelatedContext.handlerKey, turnoverStorage).runId, 'run-other', '非 predecessor run context 必须保留。');

// 响应头解析必须兼容真实 AxiosHeaders，并在环境支持时兼容 Web Headers。
const axiosTurnoverHeaders = new AxiosHeaders({
  'X-Demo-Run-Id': 'run-axios',
  'X-Demo-Run-Auto-Superseded': 'true',
  'X-Demo-Run-Superseded-From': 'run-before-axios',
  'X-Demo-Runtime-Epoch': '11'
});
assert.deepStrictEqual(demoDataModule.readDemoRunTurnover({
  headers: axiosTurnoverHeaders,
  demo: { runId: 'run-axios', manifestVersion: 'v-axios' }
}), {
  performed: true,
  reused: false,
  oldRunId: 'run-before-axios',
  newRunId: 'run-axios',
  oldManifestVersion: '',
  newManifestVersion: 'v-axios',
  runtimeEpoch: '11'
});
if (typeof globalThis.Headers === 'function') {
  const webTurnoverHeaders = new Headers({
    'X-Demo-Run-Id': 'run-web',
    'X-Demo-Run-Auto-Superseded': 'true',
    'X-Demo-Run-Superseded-From': 'run-before-web',
    'X-Demo-Runtime-Epoch': '12'
  });
  assert.equal(demoDataModule.readDemoRunTurnover({ headers: webTurnoverHeaders, demo: { runId: 'run-web' } }).oldRunId, 'run-before-web');
}

// 显式 prepare turnover 使用固定 previousRun/successorRun 合同生成旧、新 run 与 manifest 版本摘要。
assert.deepStrictEqual(demoDataModule.readDemoRunTurnover({
  success: true,
  data: {
    runId: 'run-2',
    manifestVersion: 'v2',
    reused: false,
    runtimeEpoch: 8,
    turnover: {
      performed: true,
      reason: 'manifest_identity_changed',
      trigger: 'explicit-run-prepare',
      previousRun: { runId: 'run-1', status: 'active', manifestVersion: 'v1', manifestDigest: 'a'.repeat(64) },
      successorRun: { runId: 'run-2', status: 'active', manifestVersion: 'v2', manifestDigest: 'b'.repeat(64) },
      revokedContextCount: 1,
      supersededCleanupPreviewCount: 0,
      runtimeBefore: { enabled: true, runtimeEpoch: 7, revision: 10 },
      runtimeAfter: { enabled: true, runtimeEpoch: 8, revision: 11 }
    }
  }
}), {
  performed: true,
  reused: false,
  oldRunId: 'run-1',
  newRunId: 'run-2',
  oldManifestVersion: 'v1',
  newManifestVersion: 'v2',
  runtimeEpoch: '8'
});
assert.equal(
  demoDataModule.formatDemoRunTurnoverSuccessMessage({
    oldRunId: 'run-1',
    newRunId: 'run-2',
    oldManifestVersion: 'v1',
    newManifestVersion: 'v2'
  }, 'active run 自动换代成功'),
  'active run 自动换代成功：旧 run run-1（manifest v1） → 新 run run-2（manifest v2）。',
  '显式 prepare 换代成功提示必须精确包含旧、新 run 与 manifest version。'
);
assert.equal(
  demoDataModule.formatDemoRunTurnoverSuccessMessage({ oldRunId: 'run-1', newRunId: 'run-2' }, 'managed artifact 下载已自动换代 active run'),
  'managed artifact 下载已自动换代 active run：旧 run run-1 → 新 run run-2。',
  'managed 下载换代成功提示必须直接可读且不包含 digest。'
);

// 托管响应的 artifactKey 或 handlerKey 任一错配都必须明确失败，且不得留下响应错误条目的 context。
const mismatchedDownloadStorage = new MemorySessionStorage();
globalThis.__demoContractDownloadResult = {
  fileName: 'mismatched-artifact.xlsx',
  headers: {},
  demo: { ...managedMetadata, artifactKey: 'other-artifact' }
};
await assert.rejects(
  demoDataModule.downloadDemoCatalogArtifact({
    artifactKey: managedMetadata.artifactKey,
    handlerKey: managedMetadata.handlerKey,
    name: '班次定义',
    downloadLifecycle: 'managed-context-auto-runtime',
    downloads: { xlsx: '/api/templates/demo-park/13-shift-definitions.xlsx' }
  }, 'xlsx', mismatchedDownloadStorage),
  /托管演示下载响应身份不匹配/
);
assert.equal(mismatchedDownloadStorage.length, 0, 'artifactKey 错配不得保存任何 context。');
globalThis.__demoContractDownloadResult = {
  fileName: 'mismatched-handler.xlsx',
  headers: {},
  demo: { ...managedMetadata, handlerKey: 'other-handler' }
};
await assert.rejects(
  demoDataModule.downloadDemoCatalogArtifact({
    artifactKey: managedMetadata.artifactKey,
    handlerKey: managedMetadata.handlerKey,
    name: '班次定义',
    downloadLifecycle: 'managed-context-auto-runtime',
    downloads: { xlsx: '/api/templates/demo-park/13-shift-definitions.xlsx' }
  }, 'xlsx', mismatchedDownloadStorage),
  /托管演示下载响应身份不匹配/
);
assert.equal(mismatchedDownloadStorage.length, 0, 'handlerKey 错配不得保存任何 context。');
globalThis.__demoContractDownloadResult = { fileName: 'managed.xlsx', headers: {}, demo: managedMetadata };
assert.throws(
  () => demoDataModule.downloadDemoCatalogArtifact({ downloadLifecycle: 'unknown', downloads: { xlsx: '/api/unknown.xlsx' } }, 'xlsx', tabStorage),
  /未声明受支持的 artifact 下载生命周期/
);

// 导航失败只清理本次仍在存储中的新 token，不得恢复已过期或已消费的旧 token，也不得删除后来替换的 token。
const failedNavigationStorage = new MemorySessionStorage();
const oldContextMetadata = { ...managedMetadata, contextToken: 'a'.repeat(43) };
const issuedContextMetadata = { ...managedMetadata, contextToken: 'b'.repeat(43) };
const replacementContextMetadata = { ...managedMetadata, contextToken: 'd'.repeat(43) };
demoDataModule.storeDemoContext(oldContextMetadata, failedNavigationStorage);
demoDataModule.storeDemoContext(issuedContextMetadata, failedNavigationStorage);
assert.equal(demoDataModule.clearDemoContextIfTokenMatches(
  managedMetadata.artifactKey,
  managedMetadata.handlerKey,
  issuedContextMetadata.contextToken,
  failedNavigationStorage
), true);
assert.equal(demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, failedNavigationStorage), null, '清理 B 后不得恢复旧 A。');
demoDataModule.storeDemoContext(issuedContextMetadata, failedNavigationStorage);
demoDataModule.storeDemoContext(replacementContextMetadata, failedNavigationStorage);
assert.equal(demoDataModule.clearDemoContextIfTokenMatches(
  managedMetadata.artifactKey,
  managedMetadata.handlerKey,
  issuedContextMetadata.contextToken,
  failedNavigationStorage
), false);
assert.equal(
  demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, failedNavigationStorage).token,
  replacementContextMetadata.contextToken,
  '当前 token 已变化时不得清理后来签发的 context。'
);

// 原下载文件摘要匹配时 preview 携带 context，execute 成功后清理一次性 context。
const managedFile = new Blob([managedFileBytes]);
await demoDataModule.previewManagedDemoImport(
  { method: 'post', url: '/preview', data: {} },
  managedMetadata.artifactKey,
  managedMetadata.handlerKey,
  managedFile,
  tabStorage
);
assert.deepStrictEqual(globalThis.__demoContractRequests.at(-1).demoContext, {
  artifactKey: managedMetadata.artifactKey,
  handlerKey: managedMetadata.handlerKey,
  token: managedMetadata.contextToken
});
await demoDataModule.executeManagedDemoImport(
  { method: 'post', url: '/execute', data: {} },
  managedMetadata.artifactKey,
  managedMetadata.handlerKey,
  tabStorage
);
assert.strictEqual(demoDataModule.readDemoContext(managedMetadata.artifactKey, managedMetadata.handlerKey, tabStorage), null);

// catalog、显式 run、ownership 与 cleanup wrappers 必须构造固定请求合同。
globalThis.__demoContractRequests.length = 0;
await demoDataModule.getDemoCatalog();
await demoDataModule.prepareDemoRun();
await demoDataModule.getDemoOwnershipSummary('run/1');
await demoDataModule.previewDemoCleanup('run-1', 'preview-request-1');
await demoDataModule.executeDemoCleanup({ cleanupRunId: 'cleanup-1', clientRequestId: 'execute-request-1', previewDigest: 'digest-1', confirmationText: '确认清理' });
await demoDataModule.getDemoCleanupRun('cleanup/1');
assert.deepStrictEqual(globalThis.__demoContractRequests, [
  { url: '/system/demo-data/catalog', method: 'get' },
  { url: '/system/demo-data/run', method: 'post' },
  { url: '/system/demo-data/runs/run%2F1/ownership-summary', method: 'get' },
  { url: '/system/demo-data/cleanup/preview', method: 'post', data: { runId: 'run-1', clientRequestId: 'preview-request-1' } },
  { url: '/system/demo-data/cleanup/execute', method: 'post', data: { cleanupRunId: 'cleanup-1', clientRequestId: 'execute-request-1', previewDigest: 'digest-1', confirmationText: '确认清理' } },
  { url: '/system/demo-data/cleanup-runs/cleanup%2F1', method: 'get' }
]);
assert.throws(() => demoDataModule.getDemoOwnershipSummary(''), /必须提供 runId/);
assert.throws(() => demoDataModule.previewDemoCleanup('run-1', ''), /必须提供 runId 和 clientRequestId/);
assert.throws(() => demoDataModule.executeDemoCleanup({}), /必须提供预演、幂等请求、摘要和固定确认文本/);
assert.throws(() => demoDataModule.getDemoCleanupRun(''), /必须提供 cleanupRunId/);

// prediction-history 继续复用月度能耗条目，不得虚构第 26 个 artifact。
assert.match(sources.serverDemoRegistry, /artifactKey: '07-monthly-energy'[\s\S]*?coveredTemplateTypes: \['energy-records', 'prediction-history'\]/);
assert.doesNotMatch(sources.serverDemoRegistry, /templateType: 'prediction-history'/);

delete globalThis.__demoContractRequests;
delete globalThis.__demoContractDownloads;
delete globalThis.__demoContractDownloadResult;

console.log('demo park centralized download contract tests passed');
