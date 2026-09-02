import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEMO_POST_ACTION_STATUS_LABELS,
  areDemoPostActionRegistryIdentitiesEqual,
  areDemoPostActionValuesEqual,
  areDemoPostActionRequestsIdle,
  buildDemoPostActionBindingSnapshot,
  canExecuteDemoPostAction,
  canPreviewDemoPostAction,
  evaluateDemoPostActionPreview,
  findDemoPostActionDefinition,
  generateDemoPostActionClientRequestId,
  getDemoPostActionRegistryIdentitySignature,
  getDemoPostActionStatusPresentation,
  hasDemoPostActionPermissionAnd,
  isCurrentDemoPostActionStatusResult,
  isDemoPostActionBindingCurrent,
  isDemoPostActionCleaning,
  isDemoPostActionCompatibilityReady,
  isDemoPostActionConnected,
  isDemoPostActionRunReady,
  isDemoPostActionRuntimeReady,
  isLatestDemoPostActionGeneration,
  isLatestDemoPostActionStatusResult,
  isValidDemoPostActionRegistryIdentity,
  isValidDemoPostActionRunIdentity,
  isDemoPostActionPreviewUnexpired,
  normalizeDemoPostActionClientRequestId,
  normalizeDemoPostActionRegistryIdentity,
  normalizeDemoPostActionRun,
  normalizeDemoPostActionStatus,
  resolveDemoPostActionExecutablePreview,
  stableDemoPostActionSignature
} from '../utils/demoPostActionManagement.js';

// 使用服务端公开 identity 合同形状，不复制任何服务端动作白名单。
const registryDigest = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);
const manifestDigest = 'c'.repeat(64);
const registryIdentity = {
  version: 'demo-post-actions:test',
  digest: registryDigest,
  algorithm: 'sha256',
  canonicalization: 'json-sorted-keys-v1'
};
const connectedAction = {
  actionKey: 'test-connected-action',
  displayName: '测试已连接动作',
  implementationStatus: 'connected',
  confirmationText: '确认执行测试已连接动作'
};
const notConnectedAction = {
  actionKey: 'test-not-connected-action',
  implementationStatus: 'not-connected',
  confirmationText: '确认执行未连接动作'
};
const unknownStatusAction = {
  actionKey: 'test-unknown-status-action',
  implementationStatus: 'unknown',
  confirmationText: '确认执行未知动作'
};
const registry = { identity: registryIdentity, actions: [connectedAction, notConnectedAction, unknownStatusAction] };
const runtime = { available: true, enabled: true, runtimeEpoch: 7, revision: 11 };
const activeRun = {
  runId: 'demo-run/1',
  status: 'active',
  manifestVersion: 'demo-manifest:test',
  manifestDigest
};
const compatibility = {
  readable: true,
  writeEligible: true,
  manifestCompatible: true,
  active: true,
  state: 'active'
};
const previewRun = {
  actionRunId: 'demo-action-run/1',
  runId: activeRun.runId,
  actionKey: connectedAction.actionKey,
  clientRequestId: 'client-test-1',
  previewDigest,
  previewExpiresAt: '2026-09-01T12:05:00.000Z',
  status: 'previewed',
  blocker: null
};
const environment = {
  registry,
  runtime,
  activeRun,
  activeRunCompatibility: compatibility
};
const bindingSnapshot = buildDemoPostActionBindingSnapshot(environment);

assert.ok(bindingSnapshot, '完整服务端投影应能构造 binding snapshot。');
assert.equal(Object.isFrozen(bindingSnapshot), true, 'binding snapshot 必须不可变。');
assert.equal(Object.isFrozen(bindingSnapshot.registryIdentity), true);
assert.equal(Object.isFrozen(bindingSnapshot.compatibility), true);
assert.deepEqual(bindingSnapshot, {
  registryIdentity,
  runId: activeRun.runId,
  runtimeEpoch: 7,
  runtimeRevision: 11,
  manifestVersion: activeRun.manifestVersion,
  manifestDigest,
  compatibility
});

// identity 必须验证四元组，稳定签名不受对象键插入顺序影响。
assert.deepEqual(normalizeDemoPostActionRegistryIdentity(registry), registryIdentity);
assert.equal(isValidDemoPostActionRegistryIdentity(registryIdentity), true);
assert.equal(isValidDemoPostActionRegistryIdentity({ ...registryIdentity, digest: 'A'.repeat(64) }), false);
assert.equal(isValidDemoPostActionRegistryIdentity({ ...registryIdentity, algorithm: 'sha512' }), false);
assert.equal(isValidDemoPostActionRegistryIdentity({ ...registryIdentity, canonicalization: '' }), false);
assert.notEqual(getDemoPostActionRegistryIdentitySignature(registryIdentity), '');
assert.equal(areDemoPostActionRegistryIdentitiesEqual(registryIdentity, { ...registryIdentity }), true);
assert.equal(areDemoPostActionRegistryIdentitiesEqual(registryIdentity, { ...registryIdentity, version: 'other' }), false);
assert.equal(stableDemoPostActionSignature({ z: 1, a: { d: 2, c: 3 } }), stableDemoPostActionSignature({ a: { c: 3, d: 2 }, z: 1 }));
assert.equal(areDemoPostActionValuesEqual({ z: 1, a: 2 }, { a: 2, z: 1 }), true);
assert.equal(areDemoPostActionValuesEqual({ a: Number.NaN }, { a: null }), false, '异常数字不可通过稳定等值比较。');
assert.equal(stableDemoPostActionSignature({ a: undefined }), '', 'undefined 不得进入可写签名。');

// registry 查找与 connected 判断必须完全依赖服务端投影，unknown/not-connected 均关闭。
assert.equal(findDemoPostActionDefinition(registry, connectedAction.actionKey), connectedAction);
assert.equal(findDemoPostActionDefinition(registry, 'missing-action'), null);
assert.equal(isDemoPostActionConnected(connectedAction), true);
assert.equal(isDemoPostActionConnected(notConnectedAction), false);
assert.equal(isDemoPostActionConnected(unknownStatusAction), false);

// 显式系统权限和领域权限必须是 AND，不能用权限数组 OR。
assert.equal(hasDemoPostActionPermissionAnd(true, true), true);
assert.equal(hasDemoPostActionPermissionAnd(true, false), false);
assert.equal(hasDemoPostActionPermissionAnd(false, true), false);
assert.equal(hasDemoPostActionPermissionAnd({ allowed: true }, { allowed: true }), true);
assert.equal(hasDemoPostActionPermissionAnd({ granted: true }, true), false);

// runtime、active run、compatibility 和 cleaning 均覆盖正常与 fail-closed。
assert.equal(isDemoPostActionRuntimeReady(runtime), true);
assert.equal(isDemoPostActionRuntimeReady({ ...runtime, enabled: false }), false);
assert.equal(isDemoPostActionRuntimeReady({ ...runtime, runtimeEpoch: 0 }), false);
assert.equal(isDemoPostActionRuntimeReady({ ...runtime, revision: '11' }), false);
assert.equal(isDemoPostActionRunReady(activeRun), true);
assert.equal(isDemoPostActionRunReady({ ...activeRun, status: 'cleanup_pending' }), true);
assert.equal(isDemoPostActionRunReady({ ...activeRun, status: 'cleaning' }), false);
assert.equal(isDemoPostActionRunReady({ runId: activeRun.runId, status: 'unknown' }), false);
assert.equal(isDemoPostActionCompatibilityReady(compatibility), true);
assert.equal(isDemoPostActionCompatibilityReady({ ...compatibility, writeEligible: false }), false);
assert.equal(isDemoPostActionCompatibilityReady({ ...compatibility, active: undefined }), false);
assert.equal(isDemoPostActionCompatibilityReady({ ...compatibility, state: 'unknown' }), false);
assert.equal(isDemoPostActionCleaning({ activeRunStatus: 'cleaning' }), true);
assert.equal(isDemoPostActionCleaning({ activeRunStatus: 'active', compatibility: { state: 'cleanup-in-progress-blocked' } }), true);
assert.equal(isDemoPostActionCleaning({ activeRunStatus: 'active', compatibility }), false);

const previewOptions = {
  ...environment,
  actionKey: connectedAction.actionKey,
  systemPermission: true,
  domainPermission: true
};
assert.equal(canPreviewDemoPostAction(previewOptions), true);
assert.deepEqual(evaluateDemoPostActionPreview(previewOptions), {
  eligible: true,
  connected: true,
  permissions: true,
  runtimeReady: true,
  runReady: true,
  compatibilityReady: true,
  cleaning: false,
  bindingReady: true
});
const cleanupPendingPreviewOptions = {
  ...previewOptions,
  activeRun: { ...activeRun, status: 'cleanup_pending' }
};
assert.equal(canPreviewDemoPostAction(cleanupPendingPreviewOptions), true, '服务端确认可写的 cleanup_pending run 必须允许 Preview。');
assert.deepEqual(evaluateDemoPostActionPreview(cleanupPendingPreviewOptions), {
  eligible: true,
  connected: true,
  permissions: true,
  runtimeReady: true,
  runReady: true,
  compatibilityReady: true,
  cleaning: false,
  bindingReady: true
});
assert.equal(canPreviewDemoPostAction({ ...previewOptions, systemPermission: false }), false);
assert.equal(canPreviewDemoPostAction({ ...previewOptions, domainPermission: false }), false);
assert.equal(canPreviewDemoPostAction({ ...previewOptions, actionKey: notConnectedAction.actionKey }), false);
assert.equal(canPreviewDemoPostAction({ ...previewOptions, actionKey: unknownStatusAction.actionKey }), false);
assert.equal(canPreviewDemoPostAction({ ...previewOptions, runtime: { ...runtime, enabled: false } }), false);
assert.equal(canPreviewDemoPostAction({
  ...cleanupPendingPreviewOptions,
  activeRunCompatibility: { ...compatibility, writeEligible: false }
}), false, 'writeEligible=false 必须保持 fail-closed。');
assert.equal(canPreviewDemoPostAction({
  ...previewOptions,
  activeRun: { ...activeRun, status: 'cleaning' },
  activeRunCompatibility: {
    ...compatibility,
    writeEligible: false,
    state: 'cleanup-in-progress-blocked'
  }
}), false, 'cleaning 必须保持 fail-closed。');
assert.equal(canPreviewDemoPostAction({
  ...cleanupPendingPreviewOptions,
  activeRunCompatibility: {
    ...compatibility,
    writeEligible: false,
    manifestCompatible: false,
    state: 'manifest-turnover-pending'
  }
}), false, 'manifest-turnover-pending 必须保持 fail-closed。');
assert.equal(canPreviewDemoPostAction({
  ...previewOptions,
  activeRun: { ...activeRun, status: 'unknown' }
}), false, '未知 run 状态必须保持 fail-closed。');
assert.equal(canPreviewDemoPostAction({ ...previewOptions, cleaning: true }), false);

// binding 必须同时绑定 registry、run、runtime generation、manifest 和 compatibility。
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, environment), true);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, runtime: { ...runtime, revision: 12 } }), false);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, runtime: { ...runtime, enabled: false } }), false);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, activeRun: { ...activeRun, runId: 'other-run' } }), false);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, registry: { ...registry, identity: { ...registryIdentity, version: 'other' } } }), false);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, activeRun: { ...activeRun, manifestDigest: 'd'.repeat(64) } }), false);
assert.equal(isDemoPostActionBindingCurrent(bindingSnapshot, { ...environment, activeRunCompatibility: { ...compatibility, active: false } }), false);
assert.equal(buildDemoPostActionBindingSnapshot({ ...environment, runtime: { ...runtime, revision: null } }), null);
assert.equal(buildDemoPostActionBindingSnapshot({ ...environment, activeRun: { runId: activeRun.runId, status: activeRun.status } }), null);

// action run 基本身份必须包括 runId/actionKey/clientRequestId/actionRunId/previewDigest/status。
assert.deepEqual(normalizeDemoPostActionRun({ ...previewRun, status: 'PREVIEWED' }), {
  actionRunId: previewRun.actionRunId,
  runId: previewRun.runId,
  actionKey: previewRun.actionKey,
  clientRequestId: previewRun.clientRequestId,
  previewDigest,
  status: 'previewed',
  blocker: null,
  previewExpiresAt: previewRun.previewExpiresAt
});
assert.equal(isValidDemoPostActionRunIdentity(previewRun, {
  runId: activeRun.runId,
  actionKey: connectedAction.actionKey,
  clientRequestId: previewRun.clientRequestId,
  actionRunId: previewRun.actionRunId
}), true);
for (const [field, invalidExpected] of [['runId', ' '], ['actionKey', ' '], ['clientRequestId', ' '], ['actionRunId', ' ']]) {
  assert.equal(isValidDemoPostActionRunIdentity(previewRun, { [field]: invalidExpected }), false, `显式非法 expected.${field} 必须关闭。`);
}
assert.equal(isValidDemoPostActionRunIdentity(previewRun, { runId: null }), false, '显式 null expected.runId 必须关闭。');
assert.equal(isValidDemoPostActionRunIdentity(previewRun, { runId: undefined }), true, 'undefined expected 字段表示不约束。');
for (const field of ['runId', 'actionKey', 'clientRequestId', 'actionRunId', 'previewDigest', 'status']) {
  const invalid = { ...previewRun, [field]: field === 'status' ? 'unknown' : '' };
  assert.equal(isValidDemoPostActionRunIdentity(invalid), false, `${field} 缺失或异常必须关闭。`);
}
assert.equal(normalizeDemoPostActionClientRequestId('  client-1  '), 'client-1');
assert.equal(normalizeDemoPostActionClientRequestId('client with space'), '');
assert.equal(normalizeDemoPostActionStatus(' PREVIEWED '), 'previewed');

// 只有最新可信观察仍为同一 previewed 身份时，旧预演才保有执行资格。
assert.equal(resolveDemoPostActionExecutablePreview(previewRun, { ...previewRun }), previewRun);
for (const status of ['blocked', 'executing', 'succeeded', 'failed', 'expired']) {
  const blocker = status === 'blocked' ? { code: 'BLOCKED' } : null;
  assert.equal(
    resolveDemoPostActionExecutablePreview(previewRun, { ...previewRun, status, blocker }),
    null,
    `最新可信状态为 ${status} 时必须使旧预演执行资格失效。`
  );
}
for (const invalidLatestRun of [
  null,
  {},
  { ...previewRun, status: 'unknown' },
  { ...previewRun, actionRunId: 'demo-action-run/other' },
  { ...previewRun, runId: 'demo-run/other' },
  { ...previewRun, actionKey: 'other-action' },
  { ...previewRun, clientRequestId: 'client-other' },
  { ...previewRun, previewDigest: 'd'.repeat(64) },
  { ...previewRun, blocker: undefined }
]) {
  assert.equal(resolveDemoPostActionExecutablePreview(previewRun, invalidLatestRun), null, '未知、无效或身份不匹配的最新状态必须 fail-closed。');
}
assert.equal(resolveDemoPostActionExecutablePreview({ ...previewRun, status: 'failed' }, previewRun), null, '原预演本身不是 previewed 时不得恢复执行资格。');

// expiry 只接受合法时间并且必须严格晚于 now。
const now = Date.parse('2026-09-01T12:00:00.000Z');
assert.equal(isDemoPostActionPreviewUnexpired('2026-09-01T12:00:00.001Z', now), true);
assert.equal(isDemoPostActionPreviewUnexpired('2026-09-01T12:00:00.000Z', now), false);
assert.equal(isDemoPostActionPreviewUnexpired('not-a-date', now), false);
assert.equal(isDemoPostActionPreviewUnexpired('2026-09-01T20:05:00.000+08:00', now), false, '非严格 UTC 时间不得通过。');
assert.equal(isDemoPostActionPreviewUnexpired('2026-09-01T12:05:00Z', now), false, '缺少毫秒精度的时间不得静默适配。');
assert.equal(isDemoPostActionPreviewUnexpired('2026-09-01T12:05:00.000Z', Number.NaN), false);

// execute eligibility 必须同时要求 previewed、无 blocker、完整身份、未过期、binding、双权限、确认文本和三类请求空闲。
const executeOptions = {
  actionRun: previewRun,
  registry,
  bindingSnapshot,
  currentEnvironment: environment,
  systemPermission: true,
  domainPermission: true,
  confirmationText: connectedAction.confirmationText,
  now,
  previewLoading: false,
  executeLoading: false,
  statusLoading: false
};
assert.equal(areDemoPostActionRequestsIdle(executeOptions), true);
assert.equal(canExecuteDemoPostAction(executeOptions), true);
for (const field of ['previewLoading', 'executeLoading', 'statusLoading']) {
  assert.equal(canExecuteDemoPostAction({ ...executeOptions, [field]: true }), false, `${field} 在途时不得执行。`);
}
assert.equal(canExecuteDemoPostAction({ ...executeOptions, confirmationText: `${connectedAction.confirmationText} ` }), false, '确认文本必须逐字相等。');
assert.equal(canExecuteDemoPostAction({ ...executeOptions, systemPermission: false }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, domainPermission: false }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, currentEnvironment: { ...environment, runtime: { ...runtime, runtimeEpoch: 8 } } }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, actionRun: { ...previewRun, status: 'blocked', blocker: { code: 'BLOCKED' } } }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, actionRun: { ...previewRun, blocker: { code: 'BLOCKED' } } }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, actionRun: { ...previewRun, previewExpiresAt: '2026-09-01T11:59:59.999Z' } }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, actionDefinition: { ...connectedAction, actionKey: 'other-action' } }), false);
assert.equal(canExecuteDemoPostAction({ ...executeOptions, actionRun: { ...previewRun, blocker: undefined } }), false, '缺失 blocker 不得默认为无 blocker。');

// 状态展示覆盖公共状态，未知状态显式映射 unknown。
for (const status of ['previewed', 'blocked', 'executing', 'succeeded', 'failed', 'expired']) {
  assert.equal(getDemoPostActionStatusPresentation(status).status, status);
  assert.ok(getDemoPostActionStatusPresentation(status).label);
}
assert.equal(getDemoPostActionStatusPresentation('mystery').status, 'unknown');
assert.equal(DEMO_POST_ACTION_STATUS_LABELS.unknown, '未知状态');

// generation 与 actionRunId 双重守卫，且通用 generation 守卫不能接受无效数字。
assert.equal(isLatestDemoPostActionGeneration(3, 3), true);
assert.equal(isLatestDemoPostActionGeneration(2, 3), false);
assert.equal(isLatestDemoPostActionGeneration(0, 0), false);
assert.equal(isLatestDemoPostActionGeneration('3', 3), false);
assert.equal(isLatestDemoPostActionStatusResult(3, 3, 'action-run/1', 'action-run/1'), true);
assert.equal(isLatestDemoPostActionStatusResult(3, 3, 'action-run/1', 'action-run/2'), false);
assert.equal(isLatestDemoPostActionStatusResult(2, 3, 'action-run/1', 'action-run/1'), false);
assert.equal(isCurrentDemoPostActionStatusResult({
  requestGeneration: 3,
  latestGeneration: 3,
  requestActionRunId: 'action-run/1',
  expectedActionRunId: 'action-run/1'
}), true);
assert.equal(isCurrentDemoPostActionStatusResult(3, 3, 'action-run/1', 'action-run/2'), false);

// clientRequestId 优先使用随机 UUID，异常时仅生成合法的客户端幂等标识。
assert.equal(generateDemoPostActionClientRequestId(() => 'uuid-test-1'), 'uuid-test-1');
const fallbackRequestId = generateDemoPostActionClientRequestId(() => { throw new Error('randomUUID unavailable'); });
assert.match(fallbackRequestId, /^[\w:.\-/]{1,128}$/);
assert.notEqual(fallbackRequestId, '');

// API wrapper 静态合同：只验证源码中的目标路径、编码和严格字段，不启动 HTTP 服务。
const demoDataSource = await readFile(new URL('../api/demoData.js', import.meta.url), 'utf8');
assert.match(demoDataSource, /export function getDemoPostActionRegistry\(\)\s*\{[\s\S]*?url: '\/system\/demo-data\/post-actions'/);
assert.match(demoDataSource, /export function previewDemoPostAction\(runId, actionKey, clientRequestId\)[\s\S]*?encodeURIComponent\(normalizedRunId\)[\s\S]*?encodeURIComponent\(normalizedActionKey\)[\s\S]*?data: \{ clientRequestId: normalizedClientRequestId \}/);
assert.match(demoDataSource, /export function executeDemoPostAction\(actionRunId, payload = \{\}\)[\s\S]*?encodeURIComponent\(normalizedActionRunId\)[\s\S]*?data: \{[\s\S]*?clientRequestId: normalizedClientRequestId,[\s\S]*?previewDigest: normalizedPreviewDigest,[\s\S]*?confirmationText[\s\S]*?\}/);
assert.match(demoDataSource, /export function getDemoPostActionRun\(actionRunId\)[\s\S]*?encodeURIComponent\(normalizedActionRunId\)/);
assert.match(demoDataSource, /function requireDemoPostActionRequestText\(value, fieldName/);

// 将生产 API 模块的 HTTP import 替换为纯逻辑 adapter，直接验证真实 wrapper 请求配置。
const httpImport = "import { download, request, requestWithHeaders } from '@/api/http';";
assert.ok(demoDataSource.includes(httpImport), 'demoData.js 的共享 HTTP import 契约已变化。');
const apiTestSource = demoDataSource.replace(httpImport, `
const request = (config) => config;
const download = (config, fallbackName) => ({ config, fallbackName });
const requestWithHeaders = (config) => config;
`);
const apiModuleUrl = `data:text/javascript;base64,${Buffer.from(apiTestSource).toString('base64')}`;
const demoDataApi = await import(apiModuleUrl);
assert.deepEqual(demoDataApi.getDemoPostActionRegistry(), {
  url: '/system/demo-data/post-actions',
  method: 'get'
});
assert.deepEqual(demoDataApi.previewDemoPostAction(' run/1 ', 'action/key', ' client-1 '), {
  url: '/system/demo-data/runs/run%2F1/post-actions/action%2Fkey/preview',
  method: 'post',
  data: { clientRequestId: 'client-1' }
});
assert.deepEqual(demoDataApi.executeDemoPostAction(' action/run?1 ', {
  clientRequestId: ' client-1 ',
  previewDigest: ` ${previewDigest} `,
  confirmationText: connectedAction.confirmationText,
  ignoredField: '不得透传'
}), {
  url: '/system/demo-data/post-action-runs/action%2Frun%3F1/execute',
  method: 'post',
  data: {
    clientRequestId: 'client-1',
    previewDigest,
    confirmationText: connectedAction.confirmationText
  }
});
assert.deepEqual(demoDataApi.getDemoPostActionRun(' action/run?1 '), {
  url: '/system/demo-data/post-action-runs/action%2Frun%3F1',
  method: 'get'
});
assert.throws(() => demoDataApi.previewDemoPostAction(' ', connectedAction.actionKey, 'client-1'), /必须提供runId/);
assert.throws(() => demoDataApi.previewDemoPostAction(activeRun.runId, ' ', 'client-1'), /必须提供actionKey/);
assert.throws(() => demoDataApi.previewDemoPostAction(activeRun.runId, connectedAction.actionKey, '\t'), /必须提供clientRequestId/);
assert.throws(() => demoDataApi.executeDemoPostAction(' ', {}), /必须提供actionRunId/);
assert.throws(() => demoDataApi.executeDemoPostAction('action-run-1', { clientRequestId: ' ', previewDigest, confirmationText: '确认' }), /必须提供clientRequestId/);
assert.throws(() => demoDataApi.executeDemoPostAction('action-run-1', { clientRequestId: 'client-1', previewDigest: ' ', confirmationText: '确认' }), /必须提供previewDigest/);
assert.throws(() => demoDataApi.executeDemoPostAction('action-run-1', { clientRequestId: 'client-1', previewDigest, confirmationText: ' ' }), /必须提供confirmationText/);
assert.throws(() => demoDataApi.getDemoPostActionRun(' '), /必须提供actionRunId/);

console.log('demoPostActionManagement.test.mjs passed');
