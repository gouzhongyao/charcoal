import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const componentUrl = new URL('../views/system/components/DemoPostActionPanel.vue', import.meta.url);
const parentUrl = new URL('../views/system/DemoData.vue', import.meta.url);
const registryUrl = new URL('../../../server/src/services/demoPostActionRegistry.js', import.meta.url);
const [componentSource, parentSource] = await Promise.all([
  readFile(componentUrl, 'utf8'),
  readFile(parentUrl, 'utf8')
]);
const registryModule = require(fileURLToPath(registryUrl));
const serverActions = registryModule.listDemoPostActions();

// 服务端 Registry 是动作集合唯一事实源；测试不复制任何生产 actionKey。
assert.ok(Array.isArray(serverActions) && serverActions.length > 0, '服务端 Registry 必须返回动作数组。');
assert.equal(new Set(serverActions.map((action) => action.actionKey)).size, serverActions.length, '服务端 Registry actionKey 必须唯一。');
const notConnectedKeys = serverActions
  .filter((action) => action.implementationStatus !== 'connected')
  .map((action) => action.actionKey);

// 页面必须直接导入四个严格 API wrapper，并禁止自行创建请求体。
assert.match(componentSource, /import \{ getDemoPostActionRegistry, previewDemoPostAction, executeDemoPostAction, getDemoPostActionRun \} from '@\/api\/demoData';/);
assert.match(componentSource, /previewDemoPostAction\(runId, actionKey, clientRequestId\)/);
assert.match(componentSource, /executeDemoPostAction\(actionRunId, \{ clientRequestId, previewDigest, confirmationText \}\)/);
assert.match(componentSource, /getDemoPostActionRun\(actionRunId\)/);
assert.doesNotMatch(componentSource, /\b(?:request|axios)\s*\(/, '页面不得绕过领域 wrapper 直接发 HTTP 请求。');
assert.doesNotMatch(componentSource, /\bdata[ \t]*:[ \t]*\{/, '页面不得自行提交领域 payload。');

// Registry identity、动作数组和动态 actionKey 校验必须 fail-closed，模板保持服务端原顺序。
assert.match(componentSource, /isValidDemoPostActionRegistryIdentity\(value\.identity\)/);
assert.match(componentSource, /Array\.isArray\(value\.actions\)/);
assert.match(componentSource, /const keys = new Set\(\)/);
assert.match(componentSource, /keys\.has\(actionKey\)/);
assert.match(componentSource, /v-for="action in registry\.actions"/);
assert.doesNotMatch(componentSource, /DEMO_POST_ACTION_KEYS|ACTION_KEYS|ACTION_DEFINITIONS/);
for (const action of serverActions) assert.doesNotMatch(componentSource, new RegExp(action.actionKey, 'g'), `页面不得复制服务端 actionKey：${action.actionKey}`);
for (const actionKey of notConnectedKeys) assert.doesNotMatch(componentSource, new RegExp(actionKey, 'g'), `页面不得硬编码未连接动作：${actionKey}`);

// 权限必须是单权限 AND，且领域权限编码先经过非空校验；禁止数组 OR。
assert.match(componentSource, /hasPermi\('system:demo:download'\) && hasPermi\(action\.previewPermission\)/);
assert.match(componentSource, /hasPermi\('system:demo:download'\) && hasPermi\(action\.executePermission\)/);
assert.doesNotMatch(componentSource, /hasPermi\(\s*\[/);
assert.match(componentSource, /typeof action\?\.previewPermission !== 'string'.*?trim\(\) === ''/s);
assert.match(componentSource, /typeof action\?\.executePermission !== 'string'.*?trim\(\) === ''/s);

// onMounted 只能读取 Registry；不能在挂载时预演、执行、查询或自动轮询。
assert.match(componentSource, /onMounted\(loadRegistry\);/);
const loadRegistryBody = componentSource.match(/async function loadRegistry\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(loadRegistryBody, /safeRequest\(getDemoPostActionRegistry\)/);
assert.doesNotMatch(loadRegistryBody, /previewDemoPostAction|executeDemoPostAction|getDemoPostActionRun/);
assert.doesNotMatch(componentSource, /setInterval|setTimeout/);
assert.doesNotMatch(componentSource, /dependencies[\s\S]{0,160}(?:previewAction|executeAction)\(/);

// 预演、执行和状态必须使用严格 helper 及动态 action 状态隔离。
assert.match(componentSource, /canPreviewDemoPostAction\(/);
assert.match(componentSource, /canExecuteDemoPostAction\(/);
assert.match(componentSource, /areDemoPostActionRequestsIdle\(/);
assert.match(componentSource, /const actionStates = reactive\(\{\}\)/);
assert.match(componentSource, /function createActionState\(\)/);
for (const field of ['preview', 'confirmationInput', 'execute', 'status', 'trackedActionRunId', 'successNotified']) {
  assert.match(componentSource, new RegExp(field), `动态 action 状态必须包含 ${field}。`);
}

// Registry、runtime、run、manifest 和 compatibility drift 必须失效旧预演证据。
for (const token of [
  'stableDemoPostActionSignature',
  'areDemoPostActionRegistryIdentitiesEqual',
  'isDemoPostActionBindingCurrent',
  'isLatestDemoPostActionGeneration',
  'props.runtime',
  'props.activeRun',
  'props.activeRunCompatibility',
  'registryIdentity',
  'bindingSnapshot'
]) assert.match(componentSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `必须包含 drift 守卫：${token}`);
assert.match(componentSource, /state\.preview\.clientRequestId = ''/);
assert.match(componentSource, /generateDemoPostActionClientRequestId\(\)/);
assert.match(componentSource, /state\.trackedActionRunId = normalizedRun\.actionRunId/);
assert.match(componentSource, /state\.status\.result\?\.status \|\| state\.execute\.result\?\.status/, '手工状态结果必须优先于旧执行结果收敛状态展示。');

// 最新可信 execute/status 观察不是精确 previewed 时，确认区域和执行资格必须 fail-closed。
assert.match(componentSource, /resolveDemoPostActionExecutablePreview/);
assert.match(componentSource, /runObservation: \{ result: null, invalidResponse: false \}/);
const executablePreviewBlock = componentSource.match(/function executablePreview\(action\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(executablePreviewBlock, /state\.runObservation\.invalidResponse/);
assert.match(executablePreviewBlock, /resolveDemoPostActionExecutablePreview\(preview, latestObservation\)/);
const showExecuteBlock = componentSource.match(/function canShowExecute\(action\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(showExecuteBlock, /executablePreview\(action\)/);
assert.match(showExecuteBlock, /isDemoPostActionBindingCurrent\(state\.preview\.bindingSnapshot, currentEnvironment\(\)\)/, '确认区域必须绑定当前 Registry、runtime、run 和 compatibility。');
assert.match(componentSource, /<el-form v-if="canShowExecute\(action\)"/);

// Status 查询必须只使用 actionRunId，并采用 generation、actionRunId 和原预演身份联合守卫。
assert.match(componentSource, /getDemoPostActionRun\(actionRunId\)/);
assert.match(componentSource, /isCurrentDemoPostActionStatusResult\(\{[\s\S]*requestGeneration,[\s\S]*latestGeneration:[\s\S]*requestActionRunId:[\s\S]*expectedActionRunId:/);
assert.match(componentSource, /function canQueryStatus\(action\)[\s\S]*?trackedActionRunId[\s\S]*?system:demo:view/);
assert.doesNotMatch(componentSource.match(/function canQueryStatus\(action\)[\s\S]*?\n\}/)?.[0] || '', /runtime|activeRun|implementationStatus/);
const statusStart = componentSource.indexOf('async function queryActionStatus(action)');
const statusEnd = componentSource.indexOf('/** 同一 actionRunId 的 succeeded', statusStart);
const statusBlock = componentSource.slice(statusStart, statusEnd);
for (const identityField of ['actionRunId', 'runId', 'actionKey', 'clientRequestId', 'previewDigest']) {
  assert.match(statusBlock, new RegExp(`normalizedRun\\.${identityField}`), `status 必须校验原预演身份字段 ${identityField}。`);
}
assert.match(statusBlock, /invalidResponse: !statusIdentityMatches/);
assert.match(statusBlock, /if \(!statusIdentityMatches\)[\s\S]*?state\.confirmationInput = ''/, '未知、无效或身份不匹配 status 必须关闭旧确认区域。');
const statusTransportFailure = statusBlock.match(/if \(!result\.ok\) \{([\s\S]*?)\n  \}/)?.[1] || '';
assert.match(statusTransportFailure, /state\.status\.error = errorText\(result\)/);
assert.doesNotMatch(statusTransportFailure, /preview\.result|runObservation|confirmationInput|clientRequestId|previewDigest/, 'status 网络或 HTTP 失败不得破坏原预演幂等证据。');

// Execute 网络失败重试必须复用原 clientRequestId、previewDigest 和 Registry 确认文本。
const executeStart = componentSource.indexOf('async function executeAction(action)');
const executeEnd = componentSource.indexOf('/** 验证执行响应只能对应当前 actionRun', executeStart);
const executeBlock = componentSource.slice(executeStart, executeEnd);
assert.match(executeBlock, /const clientRequestId = normalizedPreview\.clientRequestId/);
assert.match(executeBlock, /const previewDigest = normalizedPreview\.previewDigest/);
assert.match(executeBlock, /const confirmationText = action\.confirmationText/);
assert.match(executeBlock, /executeDemoPostAction\(actionRunId, \{ clientRequestId, previewDigest, confirmationText \}\)/);
assert.doesNotMatch(executeBlock, /generateDemoPostActionClientRequestId/, 'execute 重试不得生成新的幂等标识。');
const executeTransportFailure = executeBlock.match(/if \(!result\.ok\) \{([\s\S]*?)\n  \}/)?.[1] || '';
assert.match(executeTransportFailure, /state\.execute\.error = errorText\(result\)/);
assert.doesNotMatch(executeTransportFailure, /preview\.result|runObservation|confirmationInput|clientRequestId\s*=|previewDigest\s*=|confirmationText\s*=/, 'execute 网络失败不得覆盖原预演与用户确认证据。');
assert.match(executeBlock, /invalidResponse: true[\s\S]*?state\.confirmationInput = ''/, 'execute 无效 DTO 必须关闭旧预演执行资格。');

// succeeded 只通过统一事件发送一次，事件载荷必须包含公共身份四元组和结果。
assert.match(componentSource, /defineEmits\(\['succeeded'\]\)/);
assert.match(componentSource, /state\.successNotified === normalizedRun\.actionRunId/);
assert.match(componentSource, /emit\('succeeded', \{[\s\S]*actionRunId:[\s\S]*runId:[\s\S]*actionKey:[\s\S]*result[\s\S]*\}\)/);

// 父页位置必须是 catalog 卡片之后、ownership 卡片之前。
const panelIndex = parentSource.indexOf('<DemoPostActionPanel');
const ownershipIndex = parentSource.indexOf('<h2>ownership 进度</h2>');
const catalogEndIndex = parentSource.indexOf('</article>', parentSource.indexOf('class="page-card catalog-card"'));
assert.ok(panelIndex > catalogEndIndex && panelIndex < ownershipIndex, '面板必须插入 catalog 后、ownership 前。');
assert.match(parentSource, /import DemoPostActionPanel from '@\/views\/system\/components\/DemoPostActionPanel\.vue';/);
assert.match(parentSource, /:runtime="runtime"/);
assert.match(parentSource, /:active-run="activeRun"/);
assert.match(parentSource, /:active-run-compatibility="activeRunCompatibility"/);
assert.match(parentSource, /@succeeded="handlePostActionSucceeded"/);

// RF-P1-004：status 投影被清空后必须保留仅依赖本地标记的只读恢复入口。
assert.match(parentSource, /const statusRecoveryRequired = ref\(false\)/);
assert.match(parentSource, /const canSeeStatusRecovery = computed\(\(\) => statusRecoveryRequired\.value\)/);
assert.match(parentSource, /const canSeeStatusAction = computed\(\(\) => canSeeStatusRefresh\.value \|\| canSeeStatusRecovery\.value\)/);
assert.match(parentSource, /v-if="canSeeStatusAction"[\s\S]*?@click="refreshStatusProjection"[\s\S]*?重试读取状态/, 'fail-closed 后必须保留本地 status 重试按钮。');
const failClosedStart = parentSource.indexOf('function failClosedStatusProjection()');
const failClosedEnd = parentSource.indexOf('/** 应用服务端 status 响应', failClosedStart);
const failClosedBlock = parentSource.slice(failClosedStart, failClosedEnd);
assert.match(failClosedBlock, /statusRecoveryRequired\.value = true/, '初始或运行期 status 异常必须开启本地恢复入口。');
assert.match(failClosedBlock, /runtime\.value = \{ available: false, enabled: false/, '恢复入口不得恢复不可信写权限投影。');
const refreshStatusStart = parentSource.indexOf('async function refreshStatusProjection()');
const refreshStatusEnd = parentSource.indexOf('/** 加载状态和模板目录', refreshStatusStart);
const refreshStatusBlock = parentSource.slice(refreshStatusStart, refreshStatusEnd);
assert.match(refreshStatusBlock, /safeRequest\(getDemoStatus\)/);
assert.doesNotMatch(refreshStatusBlock, /prepareDemoRun|getDemoCatalog|loadTemplateCatalog|loadOwnership|toggleDemoRuntime/, 'status 恢复不得触发任何写操作或其它读取。');
assert.match(refreshStatusBlock, /!isLatestDemoRequest\(statusRequestId, statusRequestSequence\.value\)\) return false/, '旧 recovery generation 必须在落地前被拒绝。');
assert.match(refreshStatusBlock, /result\.ok[\s\S]*?applyStatus\(result\.value\)[\s\S]*?pageError\.value = ''[\s\S]*?runError\.value = ''[\s\S]*?return true/, '恢复成功必须应用完整 status 并清除错误。');
assert.match(refreshStatusBlock, /failClosedStatusProjection\(\)[\s\S]*?页面保持 fail-closed；请重试/, '恢复失败必须继续 fail-closed 并保留重试提示。');
const loadInitialStart = parentSource.indexOf('async function loadInitialState()');
const loadInitialEnd = parentSource.indexOf('/** 加载服务端标准模板目录', loadInitialStart);
const loadInitialBlock = parentSource.slice(loadInitialStart, loadInitialEnd);
assert.match(loadInitialBlock, /await refreshStatusProjection\(\)/, '初始 status 异常必须复用同一可恢复读取链路。');

// RF-P1-005：status 嵌套 DTO 必须满足真实 runtime、能力、授权、确认文本、run identity 与 compatibility 语义。
const statusProjectionContractStart = parentSource.indexOf('/** 服务端 status 必须声明的稳定 capability 字段');
const statusProjectionContractEnd = parentSource.indexOf('/** 清空 status、run 与 compatibility', statusProjectionContractStart);
const statusProjectionContractBlock = parentSource.slice(statusProjectionContractStart, statusProjectionContractEnd);
assert.notStrictEqual(statusProjectionContractStart, -1, '必须定义 status 嵌套投影校验合同。');
for (const runtimeField of ['available', 'enabled', 'runtimeEpoch', 'revision']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${runtimeField}'`), `runtime 必须显式校验 ${runtimeField}。`);
}
assert.match(statusProjectionContractBlock, /Number\.isSafeInteger\(generation\) && generation >= 1/, '可用 runtime 必须提供正安全整数 epoch/revision。');
assert.match(statusProjectionContractBlock, /!value\.available\)[\s\S]*?value\.enabled === false[\s\S]*?value\.runtimeEpoch === null[\s\S]*?value\.revision === null/, '服务端规范 fail-closed runtime 必须保持可接受。');
for (const capabilityKey of ['status', 'activeRun', 'ownershipRegistration', 'cleanupExecute', 'postActionRegistry', 'postActionRunStatus']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${capabilityKey}'`), `status 必须要求必要 capability ${capabilityKey}。`);
}
for (const actionKey of ['toggleRuntime', 'loadCatalog', 'prepareRun', 'readOwnershipSummary', 'executeCleanup', 'readCleanupRunStatus']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${actionKey}'`), `status 必须要求 canonical allowedAction ${actionKey}。`);
}
assert.match(statusProjectionContractBlock, /Object\.values\(value\)\.every\(\(item\) => typeof item === 'boolean'\)/, 'capability 与 allowedAction 容器不得包含非布尔投影。');
assert.match(statusProjectionContractBlock, /requiredDemoStatusConfirmationKeys = Object\.freeze\(\['legacyClaim', 'cleanup'\]\)/);
assert.match(statusProjectionContractBlock, /Object\.values\(data\.confirmationTexts\)\.every\(\(item\) => isDemoStatusText\(item\)\)/, '确认文本容器必须包含非空文本。');
for (const runIdentityField of ['runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${runIdentityField}'`), `activeRun 必须校验身份字段 ${runIdentityField}。`);
}
assert.match(statusProjectionContractBlock, /canonicalDemoDatasetId = 'qinglan-park-v1'/, 'activeRun 必须绑定 canonical Dataset 身份。');
for (const activeRunStatus of ['active', 'completed', 'cleanup_pending', 'cleaning']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${activeRunStatus}'`), `activeRun 必须限制服务端公开 status=${activeRunStatus}。`);
}
assert.match(statusProjectionContractBlock, /value\.datasetId === canonicalDemoDatasetId/);
assert.match(statusProjectionContractBlock, /validDemoActiveRunStatuses\.includes\(value\.status\)/);
for (const compatibilityField of ['readable', 'readOnly', 'writeEligible', 'turnoverEligible', 'retryable', 'state', 'code', 'manifestCompatible', 'historical', 'active', 'expectedManifestVersion', 'expectedManifestDigest', 'actualManifestVersion', 'actualManifestDigest']) {
  assert.match(statusProjectionContractBlock, new RegExp(`'${compatibilityField}'`), `compatibility 必须校验字段 ${compatibilityField}。`);
}
assert.match(statusProjectionContractBlock, /if \(value === null\) return false/, 'active run 存在或无 run 均不得用 null compatibility 冒充完整状态。');
assert.match(statusProjectionContractBlock, /state === 'missing'[\s\S]*?code === 'DEMO_RUN_NOT_FOUND'/, '无 run 只允许服务端 missing compatibility。');
assert.match(statusProjectionContractBlock, /state === 'unavailable'[\s\S]*?code === 'DEMO_ACTIVE_RUN_PROJECTION_UNAVAILABLE'/, '无 run 只允许服务端 unavailable compatibility。');
assert.match(statusProjectionContractBlock, /actualManifestVersion === activeRunValue\.manifestVersion[\s\S]*?actualManifestDigest === activeRunValue\.manifestDigest/, 'active run compatibility 必须匹配 run manifest identity。');
assert.match(statusProjectionContractBlock, /activeRunValue\.status === 'cleaning'[\s\S]*?cleanup-in-progress-blocked[\s\S]*?DEMO_RUN_CLEANUP_IN_PROGRESS/, 'cleaning compatibility 必须使用服务端阻断状态。');
assert.match(statusProjectionContractBlock, /'manifest-turnover-pending'/, 'turnover compatibility 必须使用服务端换代 state。');
assert.match(statusProjectionContractBlock, /'DEMO_RUN_MANIFEST_TURNOVER_PENDING'/, 'turnover compatibility 必须使用服务端换代 code。');
assert.match(statusProjectionContractBlock, /!isDemoStatusRuntime\(data\.runtime\)/);
assert.match(statusProjectionContractBlock, /!isDemoStatusBooleanMap\(data\.capabilities, requiredDemoStatusCapabilityKeys\)/);
assert.match(statusProjectionContractBlock, /!isDemoStatusBooleanMap\(data\.allowedActions, requiredDemoStatusAllowedActionKeys\)/);
assert.match(statusProjectionContractBlock, /!isDemoStatusActiveRun\(data\.activeRun\)/);
assert.match(statusProjectionContractBlock, /!isDemoStatusCompatibility\(data\.activeRunCompatibility, data\.activeRun\)/);

// POST run 只捕获待核对身份；最新 status 成功前 runtime、activeRun 和 compatibility 必须保持 fail-closed。
const applyRunStart = parentSource.indexOf('function applyRun(response)');
const applyRunEnd = parentSource.indexOf('/** 清空只属于旧 active run', applyRunStart);
const applyRunBlock = parentSource.slice(applyRunStart, applyRunEnd);
assert.match(applyRunBlock, /preparedRunId\.value/);
assert.match(applyRunBlock, /beginStatusRequest\(\)/, 'POST run 必须立即使旧 status generation 失效。');
assert.match(applyRunBlock, /failClosedStatusProjection\(\)/, 'POST run 后必须在 status 收敛前 fail-closed。');
assert.doesNotMatch(applyRunBlock, /activeRun\.value\s*=|activeRunCompatibility\.value\s*=|runtime\.value\s*=/, 'POST run 响应不得直接覆盖完整 status 投影。');
const prepareStart = parentSource.indexOf('async function prepareRun()');
const prepareEnd = parentSource.indexOf('/** 下载服务端标准模板目录项。 */', prepareStart);
const prepareBlock = parentSource.slice(prepareStart, prepareEnd);
assert.match(prepareBlock, /safeRequest\(prepareDemoRun\)/);
assert.match(prepareBlock, /applyRun\(result\.value\)[\s\S]*?safeRequest\(getDemoStatus\)/, 'prepare 成功后必须重新读取 status。');
assert.match(prepareBlock, /isLatestDemoRequest\(statusRequestId, statusRequestSequence\.value\)/, 'prepare 后 status 必须使用 generation 守卫。');
assert.match(prepareBlock, /applyStatus\(statusResult\.value, preparedRunId\.value\)/, 'prepare 后 status 必须匹配 POST 返回的 run 身份。');
assert.match(prepareBlock, /!statusResult\.ok[\s\S]*?failClosedStatusProjection\(\)/, 'prepare 后 status 失败必须保持 fail-closed。');
const applyStatusStart = parentSource.indexOf("function applyStatus(response, expectedRunId = '')");
const applyStatusEnd = parentSource.indexOf('/** 应用显式 POST run 成功结果', applyStatusStart);
const applyStatusBlock = parentSource.slice(applyStatusStart, applyStatusEnd);
assert.match(applyStatusBlock, /readStatusProjection\(response\)/);
assert.match(applyStatusBlock, /nextRunId !== normalizedExpectedRunId/);
assert.ok(
  applyStatusBlock.indexOf('if (!projection') < applyStatusBlock.indexOf('statusRecoveryRequired.value = false'),
  'malformed status 必须先 fail-closed，只有完整投影通过后才能关闭 recovery。'
);
assert.match(applyStatusBlock, /runtime\.value = projection\.runtime/, 'status 必须原子应用 runtime。');
assert.match(applyStatusBlock, /activeRun\.value = nextActiveRun/, 'status 必须原子应用校验后的 activeRun。');
assert.match(applyStatusBlock, /activeRunCompatibility\.value = projection\.activeRunCompatibility/, 'status 必须原子应用 activeRunCompatibility。');

// 父页成功副作用只允许同 run 且 ownership 可读时补刷 ownership，不清理、准备或重建 run。
const successHandler = parentSource.match(/async function handlePostActionSucceeded\(payload = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(successHandler, /payloadRunId === currentActiveRunId\(\)/);
assert.match(successHandler, /canReadOwnership\.value/);
assert.match(successHandler, /canLoadOwnership\.value \|\| ownershipLoading\.value/);
assert.match(successHandler, /ownershipLoading\.value\) await loadOwnership\(\{ supersede: true \}\)/, 'ownership 在途时 succeeded 必须替换旧请求并补刷。');
assert.match(successHandler, /else await loadOwnership\(\)/);
assert.doesNotMatch(successHandler, /clear|prepareRun|loadInitialState|toggle|catalog/);
const ownershipStart = parentSource.indexOf('async function loadOwnership(options = {})');
const ownershipEnd = parentSource.indexOf('/** 创建只针对当前 run 的 cleanup 预演', ownershipStart);
const ownershipBlock = parentSource.slice(ownershipStart, ownershipEnd);
assert.match(ownershipBlock, /ownershipRequestSequence\.value \+= 1[\s\S]*?const requestId = ownershipRequestSequence\.value/, '补刷必须递增序号使旧 ownership 响应失效。');
assert.match(ownershipBlock, /isLatestDemoRunRequest\(requestId, ownershipRequestSequence\.value, runId, currentActiveRunId\(\)\)/, 'ownership 结果必须同时核对请求序号和当前 run。');

// 页面源码只展示服务端公共字段，不携带内部实现或治理载荷字段。
for (const field of ['scope', 'ownership', 'lineage', 'SQL', 'adapter', 'handler', 'module', 'capability', 'witness', 'receipt']) {
  assert.doesNotMatch(componentSource, new RegExp(`\\b${field}\\s*:`, 'i'), `不得在页面载荷中出现内部字段：${field}`);
}

console.log('demoPostActionPageContract.test.mjs passed');
