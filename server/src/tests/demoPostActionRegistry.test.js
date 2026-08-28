'use strict';

const assert = require('assert');
const {
  DEMO_POST_ACTION_KEYS,
  getDemoPostActionRegistryIdentity,
  listDemoPostActions,
  requireDemoPostAction,
  validateDemoPostActionRegistry
} = require('../services/demoPostActionRegistry');
const postActionService = require('../services/demoPostActionService');

// registry 测试只验证纯逻辑合同，不连接数据库或启动浏览器。
const actions = listDemoPostActions();
const identity = getDemoPostActionRegistryIdentity();

assert.strictEqual(validateDemoPostActionRegistry(), true);
assert.strictEqual(actions.length, 8);
assert.deepStrictEqual(actions.map((action) => action.actionKey), [...DEMO_POST_ACTION_KEYS]);
assert.strictEqual(new Set(actions.map((action) => action.actionKey)).size, 8);
assert.deepStrictEqual(
  actions.filter((action) => action.implementationStatus === 'connected').map((action) => action.actionKey),
  ['meter-readings-to-energy-records', 'energy-flow-analysis']
);
assert(actions.filter((action) => action.implementationStatus === 'not-connected').every(
  (action) => action.retryPolicy.mode === 'not-implemented' && action.retryPolicy.maxAttempts === 0
));
assert.strictEqual(identity.version, 'demo-post-actions:v3');
assert.strictEqual(identity.algorithm, 'sha256');
assert.strictEqual(identity.canonicalization, 'json-sorted-keys-v1');
assert.match(identity.digest, /^[a-f0-9]{64}$/);

const serialized = JSON.stringify({ identity, actions }).toLowerCase();
['adapter', 'adaptername', 'handler', 'executorfunction', 'sql', 'modulepath'].forEach((secretField) => {
  assert.strictEqual(serialized.includes(`"${secretField}"`), false, `安全投影不得包含 ${secretField}`);
});
const expectedDomainDependencies = Object.fromEntries(DEMO_POST_ACTION_KEYS.map((actionKey) => [actionKey, []]));
actions.forEach((action) => {
  action.dependencies.forEach((dependency) => assert(DEMO_POST_ACTION_KEYS.includes(dependency)));
  assert.deepStrictEqual(action.dependencies, expectedDomainDependencies[action.actionKey],
    `${action.actionKey} 只能声明真实领域输出依赖，不能把产品推荐顺序写成 predecessor`);
  assert.strictEqual(action.idempotencyScope, 'run-action-request');
  assert(Number.isSafeInteger(action.previewTtlMs) && action.previewTtlMs > 0);
});

assert.throws(
  () => requireDemoPostAction('unknown-action'),
  (error) => error.code === 'DEMO_ACTION_UNKNOWN' && error.statusCode === 404
);
assert.deepStrictEqual(getDemoPostActionRegistryIdentity(), identity, 'registry 身份必须稳定。');
['PRIVATE_ACTION_ADAPTERS', 'PRIVATE_ACTION_EXECUTORS', 'getPrivateActionAdapter',
  'resolveEnergyFlowActionAdapterInput', 'executeEnergyFlowAnalysis'].forEach((privateExport) => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(postActionService, privateExport), false,
    `服务出口不得暴露 ${privateExport}`);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(postActionService._test, privateExport), false,
    `测试出口不得暴露 ${privateExport}`);
});

console.log('demoPostActionRegistry.test.js passed');
