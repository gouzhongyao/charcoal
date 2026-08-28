import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeTrustedInternalRoutePath, resolveTrustedRegisteredRoute } from '../utils/navigationRoutes.js';

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
// 从服务端源码提取真实 artifactKey，仅验证集中页没有复制条目，不执行可能正处于迁移中的服务端初始化。
const serverArtifactKeys = [...sources.serverDemoRegistry.matchAll(/artifactKey: '([^']+)'/g)].map((match) => match[1]);
const uniqueServerArtifactKeys = [...new Set(serverArtifactKeys)];

// 分散业务 API 的托管下载必须复用既有正式契约，并把 artifact/handler identity 传给共享下载函数。
assert.match(sources.energyAnalysisApi, /const contract = analysisDemoArtifact\(artifactKey\);[\s\S]*?undefined,[\s\S]*?contract\s*\n\s*\)/, '能源分析下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyBenchmarksApi, /const config = energyBenchmarkImportDownload\(importType\);[\s\S]*?undefined,[\s\S]*?config\s*\n\s*\)/, '能效对标下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyBalancesApi, /undefined,[\s\S]*?ENERGY_BALANCE_DEMO_IMPORT\s*\n\s*\)/, '能效平衡下载必须传入正式 artifact/handler 契约。');
assert.match(sources.energyFlowsApi, /const contract = energyFlowDemoArtifact\(artifactKey\);[\s\S]*?undefined,[\s\S]*?contract\s*\n\s*\)/, '能流下载必须传入正式 artifact/handler 契约。');

// 服务端 registry 仍是唯一条目事实源，前端集中页不得复制 25 项映射。
assert.strictEqual(uniqueServerArtifactKeys.length, 25, '服务端演示 manifest 必须声明 25 个唯一 artifactKey。');
for (const artifactKey of uniqueServerArtifactKeys) {
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
assert.match(initialStateBlock, /getDemoStatus/);
assert.match(initialStateBlock, /loadTemplateCatalog/);
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
const loadCatalogEnd = sources.demoDataPage.indexOf('/** 显式 POST 准备 active run', loadCatalogStart);
const loadCatalogBlock = sources.demoDataPage.slice(loadCatalogStart, loadCatalogEnd);
assert.match(loadCatalogBlock, /getDemoCatalog/);
assert.doesNotMatch(loadCatalogBlock, /prepareDemoRun|applyRun|activeRun\.value/, 'catalog 读取不得准备或推断 active run。');
const prepareRunStart = sources.demoDataPage.indexOf('async function prepareRun()');
const prepareRunEnd = sources.demoDataPage.indexOf('/** 下载服务端标准模板目录项。 \*/', prepareRunStart);
const prepareRunBlock = sources.demoDataPage.slice(prepareRunStart, prepareRunEnd);
assert.match(prepareRunBlock, /safeRequest\(prepareDemoRun\)/);
assert.match(prepareRunBlock, /applyRun\(result\.value\)/);
assert.doesNotMatch(prepareRunBlock, /catalog\.value = null/, 'POST run 发生 409 等失败时必须保留已加载 catalog。');

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
assert.match(canDownloadArtifactBlock, /if \(!canSeeCatalogActions\.value \|\| !runtime\.value\.enabled\) return false;/, 'artifact 下载必须组合真实授权和运行态。');
assert.ok(canDownloadArtifactBlock.indexOf("lifecycle === 'stateless-formal-import'") < canDownloadArtifactBlock.indexOf('!hasActiveRun.value'), 'stateless 正式下载必须在 active run 门禁之前放行。');
assert.match(canDownloadArtifactBlock, /if \(!hasActiveRun\.value \|\| activeRunManifestBlocked\.value\) return false;/, '只有 managed lifecycle 必须要求有效且兼容的 active run。');
assert.match(canDownloadArtifactBlock, /managed-context-auto-runtime' && capability\('contextIssue'\)/, '托管下载必须在服务端 context 签发能力明确启用时开放。');
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
assert.match(sources.demoDataPage, /const canLoadOwnership = computed\(\(\) => Boolean\(capability\('ownershipSummary'\) && allowedAction\('ownershipSummary'\)/, 'ownership 汇总必须同时由 capability 和 allowedAction 门控。');
const canLoadOwnershipStart = sources.demoDataPage.indexOf('const canLoadOwnership = computed');
const canLoadOwnershipEnd = sources.demoDataPage.indexOf('/** 是否允许请求 cleanup 预演', canLoadOwnershipStart);
const canLoadOwnershipBlock = sources.demoDataPage.slice(canLoadOwnershipStart, canLoadOwnershipEnd);
assert.doesNotMatch(canLoadOwnershipBlock, /activeRunManifestBlocked/, 'manifest-conflict run 的 ownership 只读汇总不得被前端冲突写入门禁阻断。');
assert.match(canLoadOwnershipBlock, /runtime\.value\.enabled[\s\S]*?hasActiveRun\.value/, 'ownership 汇总仍需运行期和 active run 只读前置条件。');
assert.match(sources.demoDataPage, /if \(!canLoadOwnership\.value \|\| !runId\) return/, 'ownership 汇总请求必须按真实授权门控。');
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
assert.match(canPreviewCleanupBlock, /!activeRunManifestBlocked\.value/, 'manifest-conflict run 的 cleanup preview 写入入口必须继续关闭。');
assert.match(sources.demoDataPage, /const canSeeCleanupExecute = computed\(\(\) => capability\('ownershipRegistration'\) && capability\('cleanupExecute'\) && allowedAction\('cleanupExecute'\)/);
assert.match(sources.demoDataPage, /canSeeCleanupExecute\.value[\s\S]*?!activeRunManifestBlocked\.value[\s\S]*?cleanupPreview\.value\?\.executable === true/, 'manifest-conflict run 的 cleanup execute 门禁不得放宽。');
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
assert.match(sources.demoDataPage, /clearDemoContexts\(\);[\s\S]*?catalog\.value = null;[\s\S]*?activeRun\.value = null;[\s\S]*?ownership\.value = null;[\s\S]*?cleanupPreview\.value = null/);
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
