'use strict';

const crypto = require('crypto');
const { AppError } = require('../utils/errors');

// 真实领域依赖语义修正后的稳定 registry 版本；动作身份变化必须显式升级版本。
const DEMO_POST_ACTION_REGISTRY_VERSION = 'demo-post-actions:v3';
// registry 摘要算法固定为 SHA-256，避免不同运行期解释器生成不同身份。
const DEMO_POST_ACTION_REGISTRY_ALGORITHM = 'sha256';
// registry canonicalization 只允许服务端实现的稳定 JSON 规范化。
const DEMO_POST_ACTION_REGISTRY_CANONICALIZATION = 'json-sorted-keys-v1';
// 所有后置动作的默认预演有效期，单位为毫秒。
const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
// 后置动作固定白名单同时定义产品推荐展示顺序，但不构成领域 predecessor 或运行门禁。
const DEMO_POST_ACTION_KEYS = Object.freeze([
  'meter-readings-to-energy-records',
  'carbon-accounting-run',
  'prediction-run',
  'strategy-evaluation-run',
  'benchmark-evaluation',
  'energy-flow-analysis',
  'energy-balance-snapshot',
  'dashboard-refresh-check'
]);

/** 递归生成稳定 JSON，确保 registry 摘要与属性插入顺序无关。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/** 计算 registry 对外身份摘要。 */
function calculateRegistryDigest(definitions) {
  const canonical = JSON.stringify(canonicalize(definitions));
  return crypto.createHash(DEMO_POST_ACTION_REGISTRY_ALGORITHM).update(canonical, 'utf8').digest('hex');
}

/** 深冻结动作定义，防止运行期修改权限、依赖或生命周期。 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// registry 只保存安全元数据；dependencies 仅表示动作直接读取另一动作输出的真实领域依赖。
// 产品推荐顺序由固定白名单顺序表达，可执行性由 implementationStatus、权限、维护态和 runtime 门禁独立控制。
const ACTION_DEFINITIONS = [
  {
    actionKey: 'meter-readings-to-energy-records',
    displayName: '抄表转能耗记录',
    dependencies: [],
    requiredArtifactBindings: ['08-meter-readings-2026-08'],
    previewPermission: 'ledger:readings:preview',
    executePermission: 'ledger:readings:execute',
    effectMode: 'writes-energy-records',
    resolverVersion: 'meter-readings-resolver:v1',
    executorVersion: 'meter-readings-executor:v1',
    implementationStatus: 'connected',
    outputEntityTypes: ['energy_record'],
    confirmationText: '确认执行抄表转能耗记录',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'carbon-accounting-run',
    displayName: '碳核算运行',
    dependencies: [],
    requiredArtifactBindings: ['11-carbon-factors', '27-carbon-activities'],
    previewPermission: 'carbon:activities:calculate',
    executePermission: 'carbon:activities:calculate',
    effectMode: 'writes-carbon-results',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: ['carbon_calculation_run', 'carbon_accounting_result'],
    confirmationText: '确认执行碳核算运行',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'prediction-run',
    displayName: '预测运行',
    dependencies: [],
    requiredArtifactBindings: ['12-prediction-configs'],
    previewPermission: 'prediction:run:view',
    executePermission: 'prediction:run:create',
    effectMode: 'writes-prediction-results',
    resolverVersion: 'prediction-resolver:v1',
    executorVersion: 'prediction-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: ['prediction_run', 'prediction_result'],
    confirmationText: '确认执行预测运行',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'strategy-evaluation-run',
    displayName: '策略评估运行',
    dependencies: [],
    requiredArtifactBindings: ['18-strategy-rules'],
    previewPermission: 'energy:strategy:evaluate',
    executePermission: 'energy:strategy:run',
    effectMode: 'writes-strategy-hits',
    resolverVersion: 'strategy-evaluation-resolver:v1',
    executorVersion: 'strategy-evaluation-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: ['strategy_rule_hit'],
    confirmationText: '确认执行策略评估运行',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'benchmark-evaluation',
    displayName: '对标评估',
    dependencies: [],
    requiredArtifactBindings: ['20-benchmark-definitions', '21-benchmark-targets'],
    previewPermission: 'energy:benchmarks:analyze',
    executePermission: 'energy:benchmarks:analyze',
    effectMode: 'writes-benchmark-results',
    resolverVersion: 'benchmark-resolver:v1',
    executorVersion: 'benchmark-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: ['benchmark_evaluation'],
    confirmationText: '确认执行对标评估',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'energy-flow-analysis',
    displayName: '能流分析',
    dependencies: [],
    requiredArtifactBindings: [
      '22-energy-flow-models/primary',
      '23-energy-flow-nodes/primary',
      '24-energy-flow-edges/edge',
      '24-energy-flow-edges/record'
    ],
    previewPermission: 'energy:flows:view',
    executePermission: 'energy:flows:view',
    effectMode: 'read-only',
    resolverVersion: 'energy-flow-resolver:v1',
    executorVersion: 'energy-flow-executor:v1',
    implementationStatus: 'connected',
    outputEntityTypes: [],
    confirmationText: '确认执行能流分析',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'energy-balance-snapshot',
    displayName: '能效平衡快照',
    dependencies: [],
    requiredArtifactBindings: ['25-energy-balance-configs/boundary', '25-energy-balance-configs/item'],
    previewPermission: 'energy:balance:calculate',
    executePermission: 'energy:balance:calculate',
    effectMode: 'writes-energy-balance-snapshot',
    resolverVersion: 'energy-balance-resolver:v1',
    executorVersion: 'energy-balance-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: ['energy_balance_calculation_run', 'energy_balance_snapshot'],
    confirmationText: '确认执行能效平衡快照',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  },
  {
    actionKey: 'dashboard-refresh-check',
    displayName: '驾驶舱刷新检查',
    dependencies: [],
    requiredArtifactBindings: [],
    previewPermission: 'dashboard:view',
    executePermission: 'dashboard:view',
    effectMode: 'read-only',
    resolverVersion: 'dashboard-refresh-resolver:v1',
    executorVersion: 'dashboard-refresh-executor:not-connected',
    implementationStatus: 'not-connected',
    outputEntityTypes: [],
    confirmationText: '确认执行驾驶舱刷新检查',
    previewTtlMs: DEFAULT_PREVIEW_TTL_MS,
    retryPolicy: { mode: 'not-implemented', maxAttempts: 0 },
    idempotencyScope: 'run-action-request'
  }
].map((definition) => deepFreeze(definition));

const ACTION_BY_KEY = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
  ACTION_DEFINITIONS.map((definition) => [definition.actionKey, definition])
)));
const REGISTRY_DIGEST = calculateRegistryDigest(ACTION_DEFINITIONS);
const REGISTRY_IDENTITY = Object.freeze({
  version: DEMO_POST_ACTION_REGISTRY_VERSION,
  digest: REGISTRY_DIGEST,
  algorithm: DEMO_POST_ACTION_REGISTRY_ALGORITHM,
  canonicalization: DEMO_POST_ACTION_REGISTRY_CANONICALIZATION
});

/** 校验动作注册表的数量、唯一性、依赖存在性、无环和连接状态。 */
function validateDemoPostActionRegistry() {
  if (ACTION_DEFINITIONS.length !== DEMO_POST_ACTION_KEYS.length) throw new Error('后置动作 registry 数量不符合固定白名单。');
  const keys = new Set(ACTION_DEFINITIONS.map((definition) => definition.actionKey));
  if (keys.size !== ACTION_DEFINITIONS.length || DEMO_POST_ACTION_KEYS.some((key) => !keys.has(key))) {
    throw new Error('后置动作 registry 存在重复或缺失 key。');
  }
  ACTION_DEFINITIONS.forEach((definition) => definition.dependencies.forEach((dependency) => {
    if (!keys.has(dependency)) throw new Error(`后置动作依赖不存在：${definition.actionKey} -> ${dependency}`);
  }));
  const visiting = new Set();
  const visited = new Set();
  function visit(key) {
    if (visiting.has(key)) throw new Error(`后置动作依赖存在环：${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    ACTION_BY_KEY[key].dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  ACTION_DEFINITIONS.forEach((definition) => visit(definition.actionKey));
  if (ACTION_DEFINITIONS.filter((definition) => definition.implementationStatus === 'connected').map((definition) => definition.actionKey).join(',') !== 'meter-readings-to-energy-records,energy-flow-analysis') {
    throw new Error('当前后置动作切片只能连接 meter-readings-to-energy-records 与 energy-flow-analysis。');
  }
  return true;
}

/** 返回稳定 registry 身份，不暴露任何 handler、executor 或内部模块路径。 */
function getDemoPostActionRegistryIdentity() {
  return { ...REGISTRY_IDENTITY };
}

/** 返回单项安全投影，防止客户端看到服务端实现细节。 */
function toSafeProjection(definition) {
  return {
    actionKey: definition.actionKey,
    displayName: definition.displayName,
    dependencies: [...definition.dependencies],
    requiredArtifactBindings: [...definition.requiredArtifactBindings],
    previewPermission: definition.previewPermission,
    executePermission: definition.executePermission,
    effectMode: definition.effectMode,
    resolverVersion: definition.resolverVersion,
    executorVersion: definition.executorVersion,
    implementationStatus: definition.implementationStatus,
    outputEntityTypes: [...definition.outputEntityTypes],
    confirmationText: definition.confirmationText,
    previewTtlMs: definition.previewTtlMs,
    retryPolicy: { ...definition.retryPolicy },
    idempotencyScope: definition.idempotencyScope
  };
}

/** 返回全部动作的安全 registry 投影。 */
function listDemoPostActions() {
  return ACTION_DEFINITIONS.map(toSafeProjection);
}

/** 严格读取内部动作定义；未知动作稳定返回 DEMO_ACTION_UNKNOWN。 */
function requireDemoPostAction(actionKey) {
  const normalizedKey = String(actionKey || '').trim();
  const definition = Object.prototype.hasOwnProperty.call(ACTION_BY_KEY, normalizedKey)
    ? ACTION_BY_KEY[normalizedKey] : null;
  if (!definition) {
    throw new AppError('DEMO_ACTION_UNKNOWN', '演示后置动作不在服务端白名单中。', {
      statusCode: 404,
      details: { actionKey: normalizedKey || null }
    });
  }
  return definition;
}

validateDemoPostActionRegistry();

module.exports = {
  DEMO_POST_ACTION_KEYS,
  DEMO_POST_ACTION_REGISTRY_ALGORITHM,
  DEMO_POST_ACTION_REGISTRY_CANONICALIZATION,
  DEMO_POST_ACTION_REGISTRY_VERSION,
  getDemoPostActionRegistryIdentity,
  listDemoPostActions,
  requireDemoPostAction,
  validateDemoPostActionRegistry,
  _test: {
    canonicalize,
    calculateRegistryDigest,
    toSafeProjection
  }
};
