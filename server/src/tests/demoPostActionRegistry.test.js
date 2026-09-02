'use strict';

const assert = require('assert');
const postActionRegistry = require('../services/demoPostActionRegistry');
const {
  DEMO_POST_ACTION_KEYS,
  getDemoPostActionRegistryIdentity,
  listDemoPostActions,
  requireDemoPostAction,
  validateDemoPostActionRegistry
} = postActionRegistry;
const demoOwnershipService = require('../services/demoOwnershipService');
const postActionService = require('../services/demoPostActionService');
const postActionPrimitives = require('../services/demoPostActionServicePrimitives');

// registry 测试只验证纯逻辑合同，不连接数据库或启动浏览器。
const actions = listDemoPostActions();
const identity = getDemoPostActionRegistryIdentity();

/** 断言 production 普通导出的字符串键严格等于正式 API 白名单。 */
function assertStringExportAllowList(exportsObject, expectedFields, label) {
  assert.deepStrictEqual(Object.getOwnPropertyNames(exportsObject).sort(), [...expectedFields].sort(),
    `${label} production 字符串导出必须严格匹配正式 API 白名单。`);
}

/** 断言 production 普通导出的 Symbol 键严格等于正式内部协议白名单。 */
function assertSymbolExportAllowList(exportsObject, expectedSymbolKeys, label) {
  const actualSymbolKeys = Object.getOwnPropertySymbols(exportsObject)
    .map((symbol) => Symbol.keyFor(symbol) || symbol.description || '')
    .sort();
  assert.deepStrictEqual(actualSymbolKeys, [...expectedSymbolKeys].sort(),
    `${label} production Symbol 导出必须严格匹配正式内部协议白名单。`);
}

// ownership production 字符串导出包含正式路由、导入、治理与派生协议消费者所需合同。
const ownershipProductionExports = [
  'abortStrategyEvaluationRegistrationScopeInTransaction',
  'activateStrategyEvaluationRegistrationScopeInTransaction',
  'calculateDemoEntityIdentityDigest',
  'calculateDemoEntitySnapshotDigest',
  'refreshDerivedStrategyRuleHitOwnershipInTransaction',
  'registerDerivedStrategyEvaluationInTransaction',
  'verifyDerivedStrategyEvaluationReceiptInTransaction',
  'DEMO_CLEANUP_ENTITY_HANDLERS',
  'DEMO_CLEANUP_ENTITY_ORDER',
  'DEMO_OWNERSHIP_ENTITY_HANDLERS',
  'DEMO_OWNERSHIP_REGISTRATION_CONNECTED',
  'DEMO_OWNERSHIP_SNAPSHOT_PROJECTION_VERSION',
  'createDemoOwnershipInsertWitness',
  'beginCarbonActivitySupersedeInOwnershipTransaction',
  'finalizeCarbonActivitySupersedeInOwnershipTransaction',
  'writeCarbonActivityExecuteAuditInOwnershipTransaction',
  'issueStrategyEvaluationRegistrationScopeInTransaction',
  'deactivateShiftDefinitionSiblingsInOwnershipTransaction',
  'deactivateStrategyRuleSiblingsInOwnershipTransaction',
  'writeShiftDefinitionImportAuditInOwnershipTransaction',
  'writeStrategyRuleImportAuditInOwnershipTransaction',
  'runWithDemoOwnershipTransaction',
  'runWithDemoOwnershipTransactionAsync',
  'buildDemoOwnershipPlan',
  'calculateRegistryWatermark',
  'getDemoCleanupEntityHandler',
  'getDemoOwnershipSummary',
  'readDemoRegistryRows',
  'registerImportedDemoOwnershipInTransaction',
  'registerDerivedMeterEnergyRecordsInTransaction',
  'updateDemoExecuteAuditInOwnershipTransaction',
  'validateDemoContextWithOwnershipTransaction',
  'markDemoContextExecutedWithOwnershipTransaction'
];
// registry production 字符串导出只保留稳定身份、安全投影与白名单查询合同。
const registryProductionExports = [
  'DEMO_POST_ACTION_KEYS',
  'DEMO_POST_ACTION_REGISTRY_ALGORITHM',
  'DEMO_POST_ACTION_REGISTRY_CANONICALIZATION',
  'DEMO_POST_ACTION_REGISTRY_VERSION',
  'getDemoPostActionRegistryIdentity',
  'listDemoPostActions',
  'requireDemoPostAction',
  'validateDemoPostActionRegistry'
];
// post-action service production 字符串导出只保留 registry、preview、execute 与 status 公共入口。
const serviceProductionExports = [
  'executeDemoPostAction',
  'getDemoPostActionRegistry',
  'getDemoPostActionStatus',
  'previewDemoPostAction'
];
assertStringExportAllowList(demoOwnershipService, ownershipProductionExports, 'demoOwnershipService');
assertSymbolExportAllowList(
  demoOwnershipService,
  [
    'charcoal.demoOwnership.canonicalInternal.v1',
    'charcoal.demoOwnership.predictionConfigManaged.v1'
  ],
  'demoOwnershipService'
);
assertStringExportAllowList(postActionRegistry, registryProductionExports, 'demoPostActionRegistry');
assertSymbolExportAllowList(postActionRegistry, [], 'demoPostActionRegistry');
assertStringExportAllowList(postActionService, serviceProductionExports, 'demoPostActionService');
assertSymbolExportAllowList(
  postActionService,
  ['charcoal.demoPostAction.canonicalPredictionInstances.v1'],
  'demoPostActionService'
);
const canonicalPredictionInstancesSymbol = Object.getOwnPropertySymbols(postActionService)[0];
const canonicalPredictionInstances = postActionService[canonicalPredictionInstancesSymbol];
assert(canonicalPredictionInstances && Object.isFrozen(canonicalPredictionInstances));
assert.deepStrictEqual(Object.keys(canonicalPredictionInstances), ['adapter', 'p4']);
assert.strictEqual(
  Reflect.ownKeys(canonicalPredictionInstances).some((fieldName) => (
    typeof fieldName === 'string'
    && /(?:issuer|verifier|secret|authority|bindIssuer|bindAdapter|bindP4)/i.test(fieldName)
  )),
  false
);
assertStringExportAllowList(
  postActionPrimitives,
  ['assertStrictBody', 'stableDigest'],
  'demoPostActionServicePrimitives'
);
assertSymbolExportAllowList(postActionPrimitives, [], 'demoPostActionServicePrimitives');
assert.strictEqual(Object.isFrozen(postActionPrimitives), true,
  'post-action 共享 pure module 必须冻结。');
assert.strictEqual(Object.isFrozen(demoOwnershipService.DEMO_OWNERSHIP_ENTITY_HANDLERS), true,
  '正式 ownership handler 表必须冻结，production consumer 只能读取固定合同。');
Object.values(demoOwnershipService.DEMO_OWNERSHIP_ENTITY_HANDLERS).forEach((handler) => {
  assert.strictEqual(Object.isFrozen(handler), true, `${handler.entityType} ownership handler 必须冻结。`);
});
// ownership canonical Symbol 继续只为固定 production consumer 提供稳定投影协议。
const canonicalOwnershipProtocolSymbol = Object.getOwnPropertySymbols(demoOwnershipService)
  .find((symbol) => Symbol.keyFor(symbol) === 'charcoal.demoOwnership.canonicalInternal.v1');
// canonical 内部协议必须保持非枚举、不可替换且字段固定。
const canonicalOwnershipProtocolDescriptor = Object.getOwnPropertyDescriptor(
  demoOwnershipService,
  canonicalOwnershipProtocolSymbol
);
assert.strictEqual(canonicalOwnershipProtocolDescriptor.enumerable, false);
assert.strictEqual(canonicalOwnershipProtocolDescriptor.writable, false);
assert.strictEqual(canonicalOwnershipProtocolDescriptor.configurable, false);
assert.strictEqual(Object.isFrozen(canonicalOwnershipProtocolDescriptor.value), true);
assert.deepStrictEqual(Object.keys(canonicalOwnershipProtocolDescriptor.value).sort(), [
  'buildEntityRegistrationContract',
  'calculateEntityIdentityDigest',
  'calculateEntitySnapshotDigest',
  'getEntityHandler',
  'sha256Stable',
  'verifyManagedImportedSourceExactClosure'
].sort(), 'canonical ownership Symbol 只保留固定派生 consumer 所需字段。');
// Artifact 12 managed Symbol 只能暴露唯一不可拆分 operation 入口。
const predictionManagedProtocolSymbol = Object.getOwnPropertySymbols(demoOwnershipService)
  .find((symbol) => Symbol.keyFor(symbol) === 'charcoal.demoOwnership.predictionConfigManaged.v1');
const predictionManagedProtocolDescriptor = Object.getOwnPropertyDescriptor(
  demoOwnershipService,
  predictionManagedProtocolSymbol
);
assert.strictEqual(predictionManagedProtocolDescriptor.enumerable, false);
assert.strictEqual(predictionManagedProtocolDescriptor.writable, false);
assert.strictEqual(predictionManagedProtocolDescriptor.configurable, false);
assert.strictEqual(Object.isFrozen(predictionManagedProtocolDescriptor.value), true);
assert.deepStrictEqual(
  Object.keys(predictionManagedProtocolDescriptor.value),
  ['executeManagedImport'],
  'Artifact 12 managed Symbol 只能暴露完整 operation，不得暴露分步 finalize、ownership 或 context CAS。'
);
['_test', 'setFaultInjectorForTest', 'readActionRunRow', 'stableDigest', 'assertStrictBody',
  'canonicalize', 'calculateRegistryDigest', 'toSafeProjection'].forEach((privateExport) => {
  [demoOwnershipService, postActionRegistry, postActionService].forEach((exportsObject) => {
    assert.strictEqual(Reflect.ownKeys(exportsObject).includes(privateExport), false,
      `production 导出不得暴露测试控制面 ${privateExport}`);
  });
});

assert.strictEqual(validateDemoPostActionRegistry(), true);
assert.strictEqual(actions.length, 8);
assert.deepStrictEqual(actions.map((action) => action.actionKey), [...DEMO_POST_ACTION_KEYS]);
assert.strictEqual(new Set(actions.map((action) => action.actionKey)).size, 8);
assert.deepStrictEqual(
  actions.filter((action) => action.implementationStatus === 'connected').map((action) => action.actionKey),
  [
    'meter-readings-to-energy-records',
    'carbon-accounting-run',
    'prediction-run',
    'strategy-evaluation-run',
    'energy-flow-analysis'
  ]
);
assert.deepStrictEqual(
  actions.filter((action) => action.implementationStatus === 'not-connected').map((action) => action.actionKey),
  [
    'benchmark-evaluation',
    'energy-balance-snapshot',
    'dashboard-refresh-check'
  ]
);
assert(actions.filter((action) => action.implementationStatus === 'not-connected').every(
  (action) => action.retryPolicy.mode === 'not-implemented' && action.retryPolicy.maxAttempts === 0
));
const carbonDefinition = actions.find((action) => action.actionKey === 'carbon-accounting-run');
assert(carbonDefinition, 'Carbon 动作必须存在。');
assert.deepStrictEqual(carbonDefinition.requiredArtifactBindings, [
  '11-carbon-factors',
  '27-carbon-activities'
]);
assert.strictEqual(carbonDefinition.implementationStatus, 'connected');
assert.strictEqual(carbonDefinition.resolverVersion, 'carbon-accounting-resolver:v1');
assert.strictEqual(carbonDefinition.executorVersion, 'carbon-accounting-executor:v1');
const predictionDefinition = actions.find((action) => action.actionKey === 'prediction-run');
assert(predictionDefinition, 'Prediction 动作必须存在。');
assert.deepStrictEqual(predictionDefinition.dependencies, []);
assert.deepStrictEqual(predictionDefinition.requiredArtifactBindings, [
  '07-monthly-energy',
  '12-prediction-configs'
]);
assert.strictEqual(predictionDefinition.previewPermission, 'prediction:run:view');
assert.strictEqual(predictionDefinition.executePermission, 'prediction:run:create');
assert.strictEqual(predictionDefinition.effectMode, 'writes-prediction-results');
assert.strictEqual(predictionDefinition.resolverVersion, 'prediction-resolver:v1');
assert.strictEqual(predictionDefinition.executorVersion, 'prediction-executor:v1');
assert.strictEqual(predictionDefinition.implementationStatus, 'connected');
assert.deepStrictEqual(predictionDefinition.outputEntityTypes, ['prediction_run', 'prediction_result']);
assert.strictEqual(predictionDefinition.confirmationText, '确认执行预测运行');
assert.deepStrictEqual(predictionDefinition.retryPolicy, { mode: 'not-implemented', maxAttempts: 0 });
assert.strictEqual(predictionDefinition.idempotencyScope, 'run-action-request');
const strategyDefinition = actions.find((action) => action.actionKey === 'strategy-evaluation-run');
assert(strategyDefinition, '策略动作必须存在。');
assert.deepStrictEqual(strategyDefinition.requiredArtifactBindings, [
  '15-energy-timeseries',
  '18-strategy-rules'
]);
assert.strictEqual(strategyDefinition.implementationStatus, 'connected');
assert.strictEqual(strategyDefinition.resolverVersion, 'strategy-evaluation-resolver:v1');
assert.strictEqual(strategyDefinition.executorVersion, 'strategy-evaluation-executor:v1');
assert.strictEqual(identity.version, 'demo-post-actions:v7');
assert.strictEqual(identity.algorithm, 'sha256');
assert.strictEqual(identity.canonicalization, 'json-sorted-keys-v1');
assert.strictEqual(identity.digest, '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a');
assert.notStrictEqual(identity.digest, 'd8823f2b483c3695087a1520ef5b61ca376db6424c5d5b47ea616325efdb635f');

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
  assert.strictEqual(Reflect.ownKeys(postActionService).includes(privateExport), false,
    `服务出口不得暴露 ${privateExport}`);
});

console.log('demoPostActionRegistry.test.js passed');
