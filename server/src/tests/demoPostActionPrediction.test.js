'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { types: utilTypes } = require('util');

// P5 复用 P4 已审查的 managed Artifact 07/12 隔离 SQLite 夹具。
const predictionFixture = require('./predictionPostActionProtocol.test');
const { openDatabase } = require('../db/database');
const createPredictionAdapter = require(
  '../services/demoPostActionPredictionAdapterFactory'
);
const postActionRegistry = require('../services/demoPostActionRegistry');

// 测试首次构造 canonical service 时捕获的 adapter core 与公开 canonical wrapper。
let predictionAdapter = null;
let canonicalPredictionAdapter = null;

const CURRENT_PREDICTION_REGISTRY_IDENTITY = Object.freeze({
  version: 'demo-post-actions:v7',
  digest: '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a',
  algorithm: 'sha256',
  canonicalization: 'json-sorted-keys-v1'
});
const CURRENT_PREDICTION_REQUIRED_BINDINGS = Object.freeze([
  '07-monthly-energy',
  '12-prediction-configs'
]);
const ADAPTER_EXPORT_FIELDS = Object.freeze([
  'resolve',
  'previewProbe',
  'revalidate',
  'execute',
  'projectPublicInput',
  'projectPublicResult',
  'mapPreviewBlocker'
]);
// Production v7 lifecycle 仅首次 require 一次；故障注入通过测试闭包切换，不重复领取 production issuer。
let predictionLifecycle = null;
let activePredictionAdapterOverride = null;
const predictionAdapterTestWrapper = Object.freeze(Object.fromEntries(
  ADAPTER_EXPORT_FIELDS.map((fieldName) => [fieldName, (...args) => {
    const handler = activePredictionAdapterOverride?.[fieldName]
      || predictionAdapter[fieldName];
    return handler(...args);
  }])
));

/** 生成隔离测试固定 SHA-256。 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// 独立测试 walker 禁止的内部 key 片段，不复用 production 投影或扫描函数。
const PREDICTION_PUBLIC_LEAKAGE_KEY_FRAGMENTS = Object.freeze([
  'digest', 'snapshot', 'sql', 'path', 'file', 'module', 'handler', 'adapter',
  'scope', 'witness', 'receipt', 'capability', 'authority', 'token', 'private',
  'internal', 'warning', 'error'
]);
const PREDICTION_PUBLIC_LEAKAGE_WHOLE_ID_KEY_PATTERN = /^(?:id|ids|pk)$/i;
const PREDICTION_PUBLIC_LEAKAGE_CAMEL_ID_KEY_PATTERN = /(?:Id|Ids|ID|IDs|Pk|PK)$/;
const PREDICTION_PUBLIC_LEAKAGE_SEPARATED_ID_KEY_PATTERN = /(?:_|-)(?:id|ids|pk)$/i;
const PREDICTION_PUBLIC_LEAKAGE_JSON_KEY_PATTERN = /(?:parameters?|filters?)json/;
const PREDICTION_PUBLIC_LEAKAGE_OPAQUE_VALUE_PATTERN = /^(?:cap|receipt|witness|authority)_/i;
const PREDICTION_PUBLIC_LEAKAGE_HEX_VALUE_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i;
const PREDICTION_PUBLIC_LEAKAGE_UUID_VALUE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PREDICTION_PUBLIC_LEAKAGE_JWT_VALUE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PREDICTION_PUBLIC_LEAKAGE_BEARER_VALUE_PATTERN = /^Bearer\s+\S+$/i;
const PREDICTION_PUBLIC_LEAKAGE_VALUE_PATTERN = /(?:\b(?:capability|authority|receipt|witness|scope|token|adapter|handler|module|sql)\b|\b(?:select|insert|update|delete|pragma|create|drop)\s+(?:from|into|table|trigger|database|[a-z_])|(?:^|[\\/])(?:users|home|var|tmp|data|server|client)(?:[\\/]|$)|(?:demo-action-run-|demo-run-|prediction-preview:)|(?:private|internal).*(?:version|error|message)|(?:version|error|message).*(?:private|internal)|\"(?:parameters?|filters?)[_-]?json\"\s*:)/i;

/** 将 key 归一化为测试 walker 使用的大小写无关字母数字形式。 */
function normalizePredictionPublicLeakageKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 判断领域 payload key 是否携带内部 ID、摘要、版本或私有协议语义。 */
function isForbiddenPredictionPublicLeakageKey(fieldName) {
  const original = String(fieldName);
  const normalized = normalizePredictionPublicLeakageKey(original);
  return PREDICTION_PUBLIC_LEAKAGE_WHOLE_ID_KEY_PATTERN.test(original)
    || PREDICTION_PUBLIC_LEAKAGE_CAMEL_ID_KEY_PATTERN.test(original)
    || PREDICTION_PUBLIC_LEAKAGE_SEPARATED_ID_KEY_PATTERN.test(original)
    || PREDICTION_PUBLIC_LEAKAGE_JSON_KEY_PATTERN.test(normalized)
    || normalized === 'methodnote'
    || normalized === 'failurereason'
    || normalized.endsWith('version')
    || PREDICTION_PUBLIC_LEAKAGE_KEY_FRAGMENTS.some((fragment) => (
      normalized.includes(fragment)
    ));
}

/** 判断字符串值是否伪装内部 ID、摘要、SQL、路径、协议对象或错误文本。 */
function isForbiddenPredictionPublicLeakageValue(value) {
  return PREDICTION_PUBLIC_LEAKAGE_HEX_VALUE_PATTERN.test(value)
    || PREDICTION_PUBLIC_LEAKAGE_UUID_VALUE_PATTERN.test(value)
    || PREDICTION_PUBLIC_LEAKAGE_JWT_VALUE_PATTERN.test(value)
    || PREDICTION_PUBLIC_LEAKAGE_BEARER_VALUE_PATTERN.test(value)
    || PREDICTION_PUBLIC_LEAKAGE_OPAQUE_VALUE_PATTERN.test(value)
    || PREDICTION_PUBLIC_LEAKAGE_VALUE_PATTERN.test(value);
}

/** 独立递归扫描公共领域 payload；反射异常结构直接使测试失败。 */
function collectPredictionPublicLeakage(value, pathLabel = '$', ancestors = new Set(), findings = []) {
  const valueType = typeof value;
  if (value === null || valueType === 'number' || valueType === 'boolean') return findings;
  if (valueType === 'string') {
    if (isForbiddenPredictionPublicLeakageValue(value)) {
      findings.push({ path: pathLabel, reason: 'forbidden-value' });
    }
    return findings;
  }
  assert.strictEqual(valueType, 'object', `${pathLabel} 出现不可 JSON 序列化值。`);
  assert.strictEqual(utilTypes.isProxy(value), false, `${pathLabel} 出现 Proxy。`);
  assert.strictEqual(ancestors.has(value), false, `${pathLabel} 出现循环引用。`);
  const isArray = Array.isArray(value);
  assert.strictEqual(
    Object.getPrototypeOf(value),
    isArray ? Array.prototype : Object.prototype,
    `${pathLabel} 出现自定义原型。`
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(value), [], `${pathLabel} 出现 Symbol 字段。`);
  ancestors.add(value);
  try {
    if (isArray) {
      const actualFields = Object.keys(descriptors);
      const expectedFields = [
        ...Array.from({ length: value.length }, (_item, index) => String(index)),
        'length'
      ];
      assert.deepStrictEqual(actualFields, expectedFields, `${pathLabel} 出现稀疏或附加数组字段。`);
      const lengthDescriptor = descriptors.length;
      assert.strictEqual(lengthDescriptor.enumerable, false, `${pathLabel}.length 枚举属性异常。`);
      assert.strictEqual(typeof lengthDescriptor.get, 'undefined', `${pathLabel}.length 不得为访问器。`);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        assert.strictEqual(descriptor.enumerable, true, `${pathLabel}[${index}] 不得隐藏。`);
        assert.strictEqual(typeof descriptor.get, 'undefined', `${pathLabel}[${index}] 不得为访问器。`);
        assert.strictEqual(typeof descriptor.set, 'undefined', `${pathLabel}[${index}] 不得为访问器。`);
        collectPredictionPublicLeakage(
          descriptor.value,
          `${pathLabel}[${index}]`,
          ancestors,
          findings
        );
      }
      return findings;
    }
    Object.entries(descriptors).forEach(([fieldName, descriptor]) => {
      assert.strictEqual(descriptor.enumerable, true, `${pathLabel}.${fieldName} 不得隐藏。`);
      assert.strictEqual(typeof descriptor.get, 'undefined', `${pathLabel}.${fieldName} 不得为访问器。`);
      assert.strictEqual(typeof descriptor.set, 'undefined', `${pathLabel}.${fieldName} 不得为访问器。`);
      if (isForbiddenPredictionPublicLeakageKey(fieldName)) {
        findings.push({ path: `${pathLabel}.${fieldName}`, reason: 'forbidden-key' });
      }
      collectPredictionPublicLeakage(
        descriptor.value,
        `${pathLabel}.${fieldName}`,
        ancestors,
        findings
      );
    });
    return findings;
  } finally {
    ancestors.delete(value);
  }
}

/** 断言单个公共领域 payload 不包含独立 walker 定义的泄漏。 */
function assertNoPredictionPublicLeakage(value, label) {
  assert.deepStrictEqual(collectPredictionPublicLeakage(value, label), [], `${label} 不得泄漏私有信息。`);
}

/** 按 previewed/succeeded 模式断言生命周期 payload 完整非空合同后再递归扫描。 */
function assertPredictionLifecycleDtoHasNoPublicLeakage(dto, label, mode) {
  assert(dto && typeof dto === 'object', `${label} lifecycle DTO 必须存在。`);
  assert.strictEqual(dto.status, mode, `${label} lifecycle 状态必须为 ${mode}。`);
  assert(Array.isArray(dto.outputs), `${label}.outputs 必须为数组。`);
  if (mode === 'previewed') {
    assert.notStrictEqual(dto.input, null, `${label}.input 必须非空。`);
    assert.strictEqual(dto.result, null, `${label}.result 必须为空。`);
    assert.strictEqual(dto.outputs.length, 0, `${label}.outputs 必须为空数组。`);
    assertNoPredictionPublicLeakage(dto.input, `${label}.input`);
    return;
  }
  assert.strictEqual(mode, 'succeeded', `${label} scanner mode 无效。`);
  assert.notStrictEqual(dto.input, null, `${label}.input 必须非空。`);
  assert.notStrictEqual(dto.result, null, `${label}.result 必须非空。`);
  assert.strictEqual(dto.outputs.length, 3, `${label}.outputs 必须精确包含三项。`);
  assert(dto.outputs.every((output) => output.outputRef !== null),
    `${label}.outputRef 必须全部非空。`);
  assertNoPredictionPublicLeakage(dto.input, `${label}.input`);
  assertNoPredictionPublicLeakage(dto.result, `${label}.result`);
  dto.outputs.forEach((output, index) => {
    assertNoPredictionPublicLeakage(
      output.outputRef,
      `${label}.outputs[${index}].outputRef`
    );
  });
}

/** 仅在隔离历史损坏测试中临时绕过 CHECK，模拟既有 malformed JSON。 */
function withIgnoredCheckConstraints(db, operation) {
  db.pragma('ignore_check_constraints = ON');
  try {
    return operation();
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
}

/** 断言异常命中稳定 code 或 details.code。 */
function hasAnyErrorCode(expectedCodes) {
  return (error) => expectedCodes.includes(error?.code)
    || expectedCodes.includes(error?.details?.code);
}

/** 读取 Prediction 生命周期相关领域、governance、output 和审计计数。 */
function readPredictionLifecycleCounts(harness) {
  const db = harness.db;
  const runId = harness.fixture.demoRun.runId;
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_runs').get().count),
    results: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_results').get().count),
    derived: Number(db.prepare(`SELECT COUNT(*) AS count FROM demo_data_registry
      WHERE run_id = ? AND ownership_kind = 'derived'
        AND entity_type IN ('prediction_run', 'prediction_result')`).get(runId).count),
    relations: Number(db.prepare(
      'SELECT COUNT(*) AS count FROM demo_data_relations WHERE run_id = ?'
    ).get(runId).count),
    outputs: Number(db.prepare(`SELECT COUNT(*) AS count FROM demo_post_action_outputs output
      JOIN demo_post_action_runs action ON action.action_run_id = output.action_run_id
      WHERE action.run_id = ? AND action.action_key = 'prediction-run'`).get(runId).count),
    executeAudits: Number(db.prepare(`SELECT COUNT(*) AS count FROM sys_operation_logs
      WHERE target_type = 'demo_post_action_run'
        AND operation = 'system.demo.post-action.execute'
        AND target_id IN (SELECT action_run_id FROM demo_post_action_runs
          WHERE run_id = ? AND action_key = 'prediction-run')`).get(runId).count)
  };
}

/** 断言 capability/protocol 词未进入 action JSON、output、failure 或 audit 持久字段。 */
function assertNoPersistedDefinitionCapabilityLeakage(harness, actionRunId) {
  const actionRow = harness.db.prepare(`SELECT input_json AS inputJson,
      blocker_json AS blockerJson, result_json AS resultJson,
      failure_reason AS failureReason
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRunId);
  const outputRows = harness.db.prepare(`SELECT output_ref_json AS outputRefJson
    FROM demo_post_action_outputs WHERE action_run_id = ? ORDER BY output_id`).all(actionRunId);
  const auditRows = harness.db.prepare(`SELECT detail_json AS detailJson
    FROM sys_operation_logs WHERE target_type = 'demo_post_action_run' AND target_id = ?
    ORDER BY id`).all(actionRunId);
  const persistedText = JSON.stringify({ actionRow, outputRows, auditRows });
  const forbiddenMatch = persistedText.match(
    /(?:definitioncapability|definition_capability|capability|authority|scope|witness|receipt|token|private)/i
  );
  assert.strictEqual(
    forbiddenMatch,
    null,
    `definition capability 不得进入 action、output 或 audit 持久字段：${forbiddenMatch?.[0] || 'none'}`
  );
}

/** 首次加载 production v7 lifecycle，并仅替换 adapter factory 以支持隔离故障注入。 */
function loadPredictionLifecycleService() {
  if (predictionLifecycle) return predictionLifecycle;
  const servicePath = require.resolve('../services/demoPostActionService');
  const corePath = require.resolve('../services/demoPostActionCanonicalService');
  const adapterPath = require.resolve('../services/demoPostActionPredictionAdapter');
  const adapterFactoryPath = require.resolve(
    '../services/demoPostActionPredictionAdapterFactory'
  );
  const originalAdapterFactoryEntry = require.cache[adapterFactoryPath];
  assert.strictEqual(require.cache[servicePath], undefined);
  assert.strictEqual(require.cache[corePath], undefined);
  require.cache[adapterFactoryPath] = {
    id: adapterFactoryPath,
    filename: adapterFactoryPath,
    loaded: true,
    exports: (options) => {
      predictionAdapter = createPredictionAdapter(options);
      return predictionAdapterTestWrapper;
    },
    children: [],
    paths: []
  };
  delete require.cache[servicePath];
  delete require.cache[adapterPath];
  try {
    const service = require(servicePath);
    canonicalPredictionAdapter = require(adapterPath);
    predictionLifecycle = Object.freeze({
      service,
      definition: postActionRegistry.requireDemoPostAction('prediction-run')
    });
    return predictionLifecycle;
  } finally {
    require.cache[adapterFactoryPath] = originalAdapterFactoryEntry;
  }
}

/** 在单例 staged service 上临时切换 adapter fault wrapper，结束后恢复 canonical adapter。 */
function withPredictionAdapterOverride(adapterOverride, operation) {
  const previousOverride = activePredictionAdapterOverride;
  activePredictionAdapterOverride = adapterOverride;
  try {
    return operation();
  } finally {
    activePredictionAdapterOverride = previousOverride;
  }
}

/** 执行 staged preview。 */
function previewPrediction(service, harness, clientRequestId, bodyOverride = {}) {
  return service.previewDemoPostAction({
    db: harness.db,
    runId: harness.fixture.demoRun.runId,
    actionKey: 'prediction-run',
    actorUserId: harness.actor.userId,
    actorIp: harness.actor.ip,
    body: { clientRequestId, ...bodyOverride }
  });
}

/** 执行 staged execute。 */
function executePrediction(service, definition, harness, preview, clientRequestId) {
  return service.executeDemoPostAction({
    db: harness.db,
    actionRunId: preview.actionRunId,
    actorUserId: harness.actor.userId,
    actorIp: harness.actor.ip,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
}

/** 验证七项固定 export、废弃 authority 无入口和初始化后 cache monkeypatch 隔离。 */
function testAdapterSurfaceAndCacheIsolation() {
  const lifecycle = loadPredictionLifecycleService();
  assert.deepStrictEqual(Object.keys(canonicalPredictionAdapter), ADAPTER_EXPORT_FIELDS);
  assert.strictEqual(Object.isFrozen(canonicalPredictionAdapter), true);
  ADAPTER_EXPORT_FIELDS.forEach((fieldName) => {
    const descriptor = Object.getOwnPropertyDescriptor(canonicalPredictionAdapter, fieldName);
    assert.strictEqual(typeof descriptor.value, 'function');
    assert.strictEqual(descriptor.enumerable, true);
    assert.strictEqual(descriptor.writable, false);
    assert.strictEqual(descriptor.configurable, false);
  });
  const adapterPath = require.resolve('../services/demoPostActionPredictionAdapter');
  const adapterModule = require.cache[adapterPath];
  const moduleExportsDescriptor = Object.getOwnPropertyDescriptor(adapterModule, 'exports');
  assert.strictEqual(moduleExportsDescriptor.writable, false);
  assert.strictEqual(moduleExportsDescriptor.configurable, false);
  assert.throws(() => { adapterModule.exports = { compromised: true }; }, TypeError);

  const deprecatedCapability = require('../services/demoPostActionDefinitionCapability');
  const deprecatedCapabilityKey = require('../services/demoPostActionDefinitionCapabilityKey');
  assert.deepStrictEqual(Object.keys(deprecatedCapability), []);
  assert.deepStrictEqual(Object.getOwnPropertySymbols(deprecatedCapability), []);
  assert.strictEqual(Object.isFrozen(deprecatedCapability), true);
  assert.strictEqual(Symbol.keyFor(deprecatedCapabilityKey), undefined);
  assert.strictEqual(
    Object.getOwnPropertySymbols(deprecatedCapability).some((protocolSymbol) => {
      const value = deprecatedCapability[protocolSymbol];
      return value && ['bindIssuer', 'bindAdapter', 'bindAdapterVerifier', 'bindP4', 'bindP4Verifier']
        .some((fieldName) => typeof value[fieldName] === 'function');
    }),
    false
  );

  const harness = predictionFixture.createHarness('p5-cache-isolation');
  const originalEntry = require.cache[adapterPath];
  let maliciousCalls = 0;
  const maliciousAdapter = Object.freeze(Object.fromEntries(ADAPTER_EXPORT_FIELDS.map((fieldName) => (
    [fieldName, () => { maliciousCalls += 1; throw new Error('MALICIOUS_ADAPTER_CALLED'); }]
  ))));
  try {
    require.cache[adapterPath] = {
      id: adapterPath,
      filename: adapterPath,
      loaded: true,
      exports: maliciousAdapter,
      children: [],
      paths: []
    };
    const preview = previewPrediction(lifecycle.service, harness, 'p5-cache-isolation');
    assert.strictEqual(preview.status, 'previewed');
    assert.strictEqual(maliciousCalls, 0);
  } finally {
    require.cache[adapterPath] = originalEntry;
    harness.db.close();
  }
}

/** 在独立进程验证 canonical authority、cache reload、parallel provenance 与 parent one-shot。 */
function testCanonicalDefinitionAuthorityIsolationCanary() {
  const childScript = `
    'use strict';
    const assert = require('assert');
    const fixture = require(${JSON.stringify(require.resolve('./predictionPostActionProtocol.test'))});
    const registryPath = ${JSON.stringify(require.resolve('../services/demoPostActionRegistry'))};
    const servicePath = ${JSON.stringify(require.resolve('../services/demoPostActionService'))};
    const adapterPath = ${JSON.stringify(require.resolve('../services/demoPostActionPredictionAdapter'))};
    const p4Path = ${JSON.stringify(require.resolve('../services/predictionPostActionProtocol'))};
    const capabilityPath = ${JSON.stringify(require.resolve('../services/demoPostActionDefinitionCapability'))};
    const keyPath = ${JSON.stringify(require.resolve('../services/demoPostActionDefinitionCapabilityKey'))};
    const capabilityFactoryPath = ${JSON.stringify(require.resolve('../services/demoPostActionDefinitionCapabilityFactory'))};
    const adapterFactoryPath = ${JSON.stringify(require.resolve('../services/demoPostActionPredictionAdapterFactory'))};
    const p4FactoryPath = ${JSON.stringify(require.resolve('../services/predictionPostActionProtocolFactory'))};

    const deprecatedKey = require(keyPath);
    const deprecatedCapability = require(capabilityPath);
    const createCapabilityAuthority = require(capabilityFactoryPath);
    const createAdapter = require(adapterFactoryPath);
    const createP4 = require(p4FactoryPath);
    assert.strictEqual(typeof deprecatedKey, 'symbol');
    assert.deepStrictEqual(Object.keys(deprecatedCapability), []);
    assert.deepStrictEqual(Object.getOwnPropertySymbols(deprecatedCapability), []);
    assert.strictEqual(typeof createCapabilityAuthority, 'function');
    assert.strictEqual(typeof createAdapter, 'function');
    assert.strictEqual(typeof createP4, 'function');

    const registry = require(registryPath);
    const registryIdentity = Object.freeze(registry.getDemoPostActionRegistryIdentity());
    assert.deepStrictEqual(registryIdentity, ${JSON.stringify(CURRENT_PREDICTION_REGISTRY_IDENTITY)});
    const service = require(servicePath);
    const canonicalAdapter = require(adapterPath);
    const p4Module = require(p4Path);
    function readCanonicalP4(protocolModule) {
      const protocolSymbols = Object.getOwnPropertySymbols(protocolModule);
      assert.strictEqual(protocolSymbols.length, 1);
      assert.strictEqual(Symbol.keyFor(protocolSymbols[0]), undefined);
      const descriptor = Object.getOwnPropertyDescriptor(
        protocolModule,
        protocolSymbols[0]
      );
      assert.strictEqual(descriptor.enumerable, false);
      assert.strictEqual(descriptor.writable, false);
      assert.strictEqual(descriptor.configurable, false);
      return descriptor.value;
    }
    const canonicalP4 = readCanonicalP4(p4Module);
    assert.deepStrictEqual(Object.keys(canonicalAdapter), ${JSON.stringify(ADAPTER_EXPORT_FIELDS)});
    assert.deepStrictEqual(Object.keys(p4Module), []);
    assert(canonicalP4 && Object.isFrozen(canonicalP4));

    const forbiddenRoleFields = new Set([
      'bindIssuer', 'bindAdapter', 'bindAdapterVerifier', 'bindP4', 'bindP4Verifier'
    ]);
    function hasForbiddenRole(value, seen = new Set()) {
      if ((!value || !['object', 'function'].includes(typeof value)) || seen.has(value)) return false;
      seen.add(value);
      return Reflect.ownKeys(value).some((fieldName) => {
        if (typeof fieldName === 'string' && forbiddenRoleFields.has(fieldName)) return true;
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, fieldName); } catch (_error) { return true; }
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ? hasForbiddenRole(descriptor.value, seen)
          : false;
      });
    }
    assert.strictEqual(hasForbiddenRole(service), false);
    assert.strictEqual(hasForbiddenRole(deprecatedCapability), false);
    assert.strictEqual(hasForbiddenRole(canonicalAdapter), false);
    assert.strictEqual(hasForbiddenRole(p4Module), false);

    const harness = fixture.createHarness('p5-canonical-authority-child');
    try {
      const runtimeRow = harness.db.prepare(
        'SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1'
      ).get();
      const runtime = {
        enabled: Number(runtimeRow.enabled),
        runtimeEpoch: Number(runtimeRow.runtimeEpoch),
        revision: Number(runtimeRow.revision)
      };
      const run = harness.fixture.demoRun;
      const actor = Object.freeze({ ...harness.actor });
      const definition = registry.requireDemoPostAction('prediction-run');
      const parallelAuthority = createCapabilityAuthority();
      const fakeP4 = Object.freeze({
        issueRegistrationScopeInCallerTransaction() { throw new Error('unused'); },
        registerDerivedOwnershipInCallerTransaction() { throw new Error('unused'); },
        verifyRegistrationReceiptInCallerTransaction() { throw new Error('unused'); },
        abortRegistrationScopeInCallerTransaction() { throw new Error('unused'); }
      });
      const parallelAdapter = createAdapter({
        verifyDefinitionCapability: parallelAuthority.verifyForAdapter,
        predictionRegistrationProtocol: fakeP4
      });
      const common = {
        db: harness.db,
        run,
        runtime,
        actor,
        definition,
        registryIdentity
      };
      function issue(stage, actionRunId, actionStatus, parentCapability, overrides = {}) {
        return parallelAuthority.issueForService({
          ...common,
          stage,
          actionRunId,
          actionStatus,
          parentCapability,
          ...overrides
        });
      }
      function verify(capability, stage, actionRunId, actionStatus, parentCapability) {
        return parallelAuthority.verifyForAdapter({
          capability,
          db: harness.db,
          stage,
          actionRunId,
          actionStatus,
          run,
          runtime,
          actor,
          parentCapability
        });
      }
      function issueExecuteChain(actionRunId) {
        const previewed = issue('previewed-revalidate', actionRunId, 'previewed', null);
        verify(previewed, 'previewed-revalidate', actionRunId, 'previewed', null);
        const executing = issue('executing-revalidate', actionRunId, 'executing', previewed);
        verify(executing, 'executing-revalidate', actionRunId, 'executing', previewed);
        const execute = issue('execute', actionRunId, 'executing', executing);
        verify(execute, 'execute', actionRunId, 'executing', executing);
        return { previewed, executing, execute };
      }

      harness.db.transaction(() => {
        const parallelResolve = issue('preview-resolve', null, null, null);
        const resolved = parallelAdapter.resolve(
          harness.db, run, runtime, actor.userId, actor.ip, parallelResolve, actor
        );
        assert(resolved && resolved.privateContext);
        assert.throws(
          () => canonicalAdapter.resolve(
            harness.db, run, runtime, actor.userId, actor.ip, parallelResolve, actor
          ),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED'
        );

        const previewParent = issue('preview-resolve', null, null, null);
        verify(previewParent, 'preview-resolve', null, null, null);
        const previewChild = issue('preview-probe', null, null, previewParent);
        assert.throws(
          () => issue('preview-probe', null, null, previewParent),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'
        );
        assert.throws(
          () => verify(previewChild, 'preview-probe', null, null, previewParent),
          (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_REPLAY',
            'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID'].includes(error.code)
        );

        const adapterReplayParent = issue('preview-resolve', null, null, null);
        verify(adapterReplayParent, 'preview-resolve', null, null, null);
        const adapterReplayChild = issue(
          'preview-probe',
          null,
          null,
          adapterReplayParent
        );
        assert.throws(
          () => verify(adapterReplayParent, 'preview-resolve', null, null, null),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REPLAY'
        );
        assert.throws(
          () => verify(
            adapterReplayChild,
            'preview-probe',
            null,
            null,
            adapterReplayParent
          ),
          (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_REPLAY',
            'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID'].includes(error.code)
        );

        const failedParent = issue('preview-resolve', null, null, null);
        verify(failedParent, 'preview-resolve', null, null, null);
        assert.throws(() => issue('preview-probe', null, null, failedParent, {
          definition: { ...definition }
        }));
        assert.throws(
          () => issue('preview-probe', null, null, failedParent),
          (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
            'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'].includes(error.code)
        );

        [
          { name: 'run', overrides: { run: Object.freeze({ ...run }) } },
          { name: 'runtime', overrides: { runtime: Object.freeze({ ...runtime }) } },
          { name: 'actor', overrides: { actor: Object.freeze({ ...actor }) } },
          {
            name: 'registry',
            overrides: { registryIdentity: Object.freeze({ ...registryIdentity }) }
          }
        ].forEach((testCase) => {
          const referenceParent = issue('preview-resolve', null, null, null);
          verify(referenceParent, 'preview-resolve', null, null, null);
          assert.throws(
            () => issue('preview-probe', null, null, referenceParent, testCase.overrides),
            (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
            testCase.name + ' clone 必须终结 parent。'
          );
          assert.throws(
            () => issue('preview-probe', null, null, referenceParent),
            (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
              'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'].includes(error.code)
          );
        });

        const fanOutChain = issueExecuteChain('parallel-action-one');
        assert.throws(
          () => issue(
            'executing-revalidate',
            'parallel-action-one',
            'executing',
            fanOutChain.previewed
          ),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'
        );
        const fanOutActionRun = Object.freeze({
          actionRunId: 'parallel-action-one',
          runId: run.runId,
          datasetId: run.datasetId,
          actionKey: 'prediction-run',
          requestedBy: actor.userId,
          status: 'executing'
        });
        assert.throws(
          () => parallelAuthority.verifyForP4({
            capability: fanOutChain.execute,
            db: harness.db,
            demoRun: run,
            actionRun: fanOutActionRun,
            actor
          }),
          (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_REPLAY',
            'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID'].includes(error.code)
        );

        const executeFanOutChain = issueExecuteChain('parallel-action-two');
        assert.throws(
          () => issue(
            'execute',
            'parallel-action-two',
            'executing',
            executeFanOutChain.executing
          ),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'
        );
        const executeFanOutActionRun = Object.freeze({
          ...fanOutActionRun,
          actionRunId: 'parallel-action-two'
        });
        assert.throws(
          () => parallelAuthority.verifyForP4({
            capability: executeFanOutChain.execute,
            db: harness.db,
            demoRun: run,
            actionRun: executeFanOutActionRun,
            actor
          }),
          (error) => ['DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_REPLAY',
            'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID'].includes(error.code)
        );

        const replayChain = issueExecuteChain('parallel-action-three');
        const replayActionRun = Object.freeze({
          ...fanOutActionRun,
          actionRunId: 'parallel-action-three'
        });
        parallelAuthority.verifyForP4({
          capability: replayChain.execute,
          db: harness.db,
          demoRun: run,
          actionRun: replayActionRun,
          actor
        });
        assert.throws(
          () => parallelAuthority.verifyForP4({
            capability: replayChain.execute,
            db: harness.db,
            demoRun: run,
            actionRun: replayActionRun,
            actor
          }),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_REPLAY'
        );

        const p4Chain = issueExecuteChain('parallel-action-four');
        const p4ActionRun = Object.freeze({
          ...fanOutActionRun,
          actionRunId: 'parallel-action-four'
        });
        assert.throws(
          () => canonicalP4.issueRegistrationScopeInCallerTransaction({
            db: harness.db,
            transactionScope: Object.freeze({}),
            completionWitness: Object.freeze({}),
            definitionCapability: p4Chain.execute,
            demoRun: run,
            actionRun: p4ActionRun,
            actor
          }),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED'
        );
      }).immediate();

      const originalAdapter = canonicalAdapter;
      const originalP4 = canonicalP4;
      [capabilityPath, keyPath, capabilityFactoryPath, adapterFactoryPath, p4FactoryPath,
        adapterPath, p4Path].forEach((modulePath) => { delete require.cache[modulePath]; });
      const reloadedAuthority = require(capabilityPath);
      const reloadedFactory = require(capabilityFactoryPath);
      const reloadedAdapter = require(adapterPath);
      const reloadedP4Module = require(p4Path);
      assert.deepStrictEqual(Object.keys(reloadedAuthority), []);
      assert.strictEqual(typeof reloadedFactory, 'function');
      assert.strictEqual(reloadedAdapter, originalAdapter);
      assert.strictEqual(readCanonicalP4(reloadedP4Module), originalP4);
      const reloadedParallelAuthority = reloadedFactory();
      harness.db.transaction(() => {
        const reloadedCapability = reloadedParallelAuthority.issueForService({
          db: harness.db,
          stage: 'preview-resolve',
          actionRunId: null,
          actionStatus: null,
          run,
          runtime,
          actor,
          definition,
          registryIdentity,
          parentCapability: null
        });
        assert.throws(
          () => originalAdapter.resolve(
            harness.db, run, runtime, actor.userId, actor.ip, reloadedCapability, actor
          ),
          (error) => error.code === 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED'
        );
      }).immediate();
      delete require.cache[servicePath];
      assert.strictEqual(require(servicePath), service);
    } finally {
      harness.db.close();
      fixture.cleanupPredictionFixtureRoot();
    }
  `;
  execFileSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });
}

/** 验证 CommonJS canonical broker 的 preload、cache fail-closed、surface 与 fresh v7。 */
function testCanonicalBrokerCacheCanaries() {
  const fixturePath = require.resolve('./predictionPostActionProtocol.test');
  const registryPath = require.resolve('../services/demoPostActionRegistry');
  const servicePath = require.resolve('../services/demoPostActionService');
  const corePath = require.resolve('../services/demoPostActionCanonicalService');
  const capabilityFactoryPath = require.resolve(
    '../services/demoPostActionDefinitionCapabilityFactory'
  );
  const preloadAndWrapperReloadScript = `
    'use strict';
    const assert = require('assert');
    const corePath = ${JSON.stringify(corePath)};
    const servicePath = ${JSON.stringify(servicePath)};
    const capabilityFactoryPath = ${JSON.stringify(capabilityFactoryPath)};
    const originalFactory = require(capabilityFactoryPath);
    let factoryCalls = 0;
    require.cache[capabilityFactoryPath] = {
      id: capabilityFactoryPath,
      filename: capabilityFactoryPath,
      loaded: true,
      exports: (...args) => {
        factoryCalls += 1;
        return originalFactory(...args);
      },
      children: [],
      paths: []
    };
    const core = require(corePath);
    const wrapper = require(servicePath);
    assert.strictEqual(wrapper, core);
    assert.strictEqual(factoryCalls, 1);
    const registry = core.getDemoPostActionRegistry();
    assert.strictEqual(registry.identity.version, 'demo-post-actions:v7');
    assert.strictEqual(
      registry.actions.find((item) => item.actionKey === 'prediction-run')
        .implementationStatus,
      'connected'
    );
    const forbiddenSurface = /issuer|verifier|secret|authority|capability/i;
    [core, wrapper].forEach((surface) => {
      assert.strictEqual(Object.isFrozen(surface), true);
      assert.strictEqual(
        Reflect.ownKeys(surface).some((fieldName) => forbiddenSurface.test(
          typeof fieldName === 'symbol'
            ? String(fieldName.description || '')
            : String(fieldName)
        )),
        false
      );
    });
    assert.strictEqual(
      Object.getOwnPropertyNames(globalThis).some(
        (fieldName) => /charcoalDemoPostActionCanonicalService/i.test(fieldName)
      ),
      false
    );
    delete require.cache[servicePath];
    assert.strictEqual(require(servicePath), core);
    assert.strictEqual(factoryCalls, 1);
  `;
  execFileSync(process.execPath, ['-e', preloadAndWrapperReloadScript], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });

  const coreReloadFailClosedScript = `
    'use strict';
    const assert = require('assert');
    const fixture = require(${JSON.stringify(fixturePath)});
    const corePath = ${JSON.stringify(corePath)};
    const capabilityFactoryPath = ${JSON.stringify(capabilityFactoryPath)};
    const originalFactory = require(capabilityFactoryPath);
    let factoryCalls = 0;
    require.cache[capabilityFactoryPath] = {
      id: capabilityFactoryPath,
      filename: capabilityFactoryPath,
      loaded: true,
      exports: (...args) => {
        factoryCalls += 1;
        return originalFactory(...args);
      },
      children: [],
      paths: []
    };
    const core = require(corePath);
    assert.strictEqual(factoryCalls, 1);
    const harness = fixture.createHarness('p5-canonical-core-reload');
    try {
      const readCounts = () => ({
        actions: harness.db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_runs').get().count,
        outputs: harness.db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs').get().count,
        audits: harness.db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE target_type = 'demo_post_action_run'").get().count,
        predictionRuns: harness.db.prepare('SELECT COUNT(*) AS count FROM prediction_runs').get().count,
        predictionResults: harness.db.prepare('SELECT COUNT(*) AS count FROM prediction_results').get().count
      });
      const before = readCounts();
      delete require.cache[corePath];
      assert.throws(
        () => require(corePath),
        (error) => [
          'PREDICTION_EXACT_P4_VERIFIER_BINDING_INVALID',
          'PREDICTION_EXACT_P4_LINKER_UNAVAILABLE'
        ].includes(error.code) || [
          'PREDICTION_EXACT_P4_VERIFIER_BINDING_INVALID',
          'PREDICTION_EXACT_P4_LINKER_UNAVAILABLE'
        ].includes(error.details && error.details.code)
      );
      assert.strictEqual(require.cache[corePath], undefined);
      assert.strictEqual(factoryCalls, 1);
      assert.deepStrictEqual(readCounts(), before);
      assert.strictEqual(core.getDemoPostActionRegistry().identity.version, 'demo-post-actions:v7');
    } finally {
      harness.db.close();
      fixture.cleanupPredictionFixtureRoot();
    }
  `;
  execFileSync(process.execPath, ['-e', coreReloadFailClosedScript], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });

  const historicalV6SingleRootScript = `
    'use strict';
    const assert = require('assert');
    const fixture = require(${JSON.stringify(fixturePath)});
    const registryPath = ${JSON.stringify(registryPath)};
    const servicePath = ${JSON.stringify(servicePath)};
    const corePath = ${JSON.stringify(corePath)};
    const liveRegistry = require(registryPath);
    const historicalIdentity = Object.freeze({
      version: 'demo-post-actions:v6',
      digest: 'd8823f2b483c3695087a1520ef5b61ca376db6424c5d5b47ea616325efdb635f',
      algorithm: 'sha256',
      canonicalization: 'json-sorted-keys-v1'
    });
    const toHistoricalDefinition = (definition) => definition.actionKey === 'prediction-run'
      ? Object.freeze({
          ...definition,
          requiredArtifactBindings: ['12-prediction-configs'],
          executorVersion: 'prediction-executor:not-connected',
          implementationStatus: 'not-connected'
        })
      : definition;
    const historicalRegistry = Object.freeze({
      ...liveRegistry,
      DEMO_POST_ACTION_REGISTRY_VERSION: historicalIdentity.version,
      getDemoPostActionRegistryIdentity() { return { ...historicalIdentity }; },
      listDemoPostActions() { return liveRegistry.listDemoPostActions().map(toHistoricalDefinition); },
      requireDemoPostAction(actionKey) {
        return toHistoricalDefinition(liveRegistry.requireDemoPostAction(actionKey));
      }
    });
    require.cache[registryPath].exports = historicalRegistry;
    const canonicalService = require(servicePath);
    require.cache[registryPath].exports = liveRegistry;
    const canonicalRegistry = canonicalService.getDemoPostActionRegistry();
    assert.deepStrictEqual(canonicalRegistry.identity, historicalIdentity);
    assert.strictEqual(
      canonicalRegistry.actions.find((item) => item.actionKey === 'prediction-run')
        .implementationStatus,
      'not-connected'
    );
    assert.strictEqual(require(${JSON.stringify(corePath)}), canonicalService);
    const harness = fixture.createHarness('p5-v6-process-anchor-reload');
    try {
      const readCounts = () => ({
        actions: harness.db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_runs').get().count,
        outputs: harness.db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs').get().count,
        audits: harness.db.prepare(\"SELECT COUNT(*) AS count FROM sys_operation_logs WHERE target_type = 'demo_post_action_run'\").get().count,
        predictionRuns: harness.db.prepare('SELECT COUNT(*) AS count FROM prediction_runs').get().count,
        predictionResults: harness.db.prepare('SELECT COUNT(*) AS count FROM prediction_results').get().count
      });
      const before = readCounts();
      assert.strictEqual(liveRegistry.getDemoPostActionRegistryIdentity().version, 'demo-post-actions:v7');
      delete require.cache[servicePath];
      const reloadedService = require(servicePath);
      assert.strictEqual(reloadedService, canonicalService);
      assert.deepStrictEqual(reloadedService.getDemoPostActionRegistry().identity, historicalIdentity);
      assert.deepStrictEqual(readCounts(), before);
      assert.strictEqual(require.cache[corePath].exports, canonicalService);
    } finally {
      require.cache[registryPath].exports = liveRegistry;
      harness.db.close();
      fixture.cleanupPredictionFixtureRoot();
    }
  `;
  execFileSync(process.execPath, ['-e', historicalV6SingleRootScript], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });

  const freshV7Script = `
    'use strict';
    const assert = require('assert');
    const fixture = require(${JSON.stringify(fixturePath)});
    const registryPath = ${JSON.stringify(registryPath)};
    const servicePath = ${JSON.stringify(servicePath)};
    const corePath = ${JSON.stringify(corePath)};
    const registry = require(registryPath);
    assert.deepStrictEqual(
      registry.getDemoPostActionRegistryIdentity(),
      ${JSON.stringify(CURRENT_PREDICTION_REGISTRY_IDENTITY)}
    );
    const core = require(corePath);
    const service = require(servicePath);
    assert.strictEqual(service, core);
    const harness = fixture.createHarness('p5-fresh-v7-canonical-success');
    try {
      const definition = registry.requireDemoPostAction('prediction-run');
      const requestId = 'p5-fresh-v7-canonical-success';
      const preview = service.previewDemoPostAction({
        db: harness.db,
        runId: harness.fixture.demoRun.runId,
        actionKey: 'prediction-run',
        actorUserId: harness.actor.userId,
        actorIp: harness.actor.ip,
        body: { clientRequestId: requestId }
      });
      assert.strictEqual(preview.status, 'previewed');
      assert.notStrictEqual(preview.input, null);
      assert.strictEqual(preview.result, null);
      assert.deepStrictEqual(preview.outputs, []);
      const completed = service.executeDemoPostAction({
        db: harness.db,
        actionRunId: preview.actionRunId,
        actorUserId: harness.actor.userId,
        actorIp: harness.actor.ip,
        body: {
          clientRequestId: requestId,
          previewDigest: preview.previewDigest,
          confirmationText: definition.confirmationText
        }
      });
      const failureAudit = harness.db.prepare(
        "SELECT detail_json AS detailJson FROM sys_operation_logs WHERE target_type = 'demo_post_action_run' AND target_id = ? ORDER BY id DESC LIMIT 1"
      ).get(preview.actionRunId);
      assert.strictEqual(
        completed.status,
        'succeeded',
        JSON.stringify({ completed, failureAudit })
      );
      assert.notStrictEqual(completed.input, null);
      assert.notStrictEqual(completed.result, null);
      assert.strictEqual(completed.outputs.length, 3);
      assert(completed.outputs.every((output) => output.outputRef !== null));
    } finally {
      harness.db.close();
      fixture.cleanupPredictionFixtureRoot();
    }
  `;
  execFileSync(process.execPath, ['-e', freshV7Script], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });
}

/** 验证 production v7 已连接，并让显式历史 v6 blocked fixture 继续安全回放。 */
function testProductionRegistryConnectedAndHistoricalV6Replay() {
  const identity = postActionRegistry.getDemoPostActionRegistryIdentity();
  const definition = postActionRegistry.requireDemoPostAction('prediction-run');
  assert.deepStrictEqual(identity, CURRENT_PREDICTION_REGISTRY_IDENTITY);
  assert.strictEqual(definition.implementationStatus, 'connected');
  assert.strictEqual(definition.resolverVersion, 'prediction-resolver:v1');
  assert.strictEqual(definition.executorVersion, 'prediction-executor:v1');
  assert.deepStrictEqual(definition.requiredArtifactBindings, CURRENT_PREDICTION_REQUIRED_BINDINGS);
  const lifecycle = loadPredictionLifecycleService();
  assert.deepStrictEqual(lifecycle.service.getDemoPostActionRegistry().identity,
    CURRENT_PREDICTION_REGISTRY_IDENTITY);
  assert.strictEqual(lifecycle.definition, definition);

  // 历史 v6 必须在 canonical core 首次加载前注入，随后恢复 live v7 export 也不得热升级该单根。
  const childScript = `
    'use strict';
    const assert = require('assert');
    const fixture = require(${JSON.stringify(require.resolve('./predictionPostActionProtocol.test'))});
    const registryPath = ${JSON.stringify(require.resolve('../services/demoPostActionRegistry'))};
    const servicePath = ${JSON.stringify(require.resolve('../services/demoPostActionService'))};
    const liveRegistry = require(registryPath);
    const historicalIdentity = Object.freeze({
      version: 'demo-post-actions:v6',
      digest: 'd8823f2b483c3695087a1520ef5b61ca376db6424c5d5b47ea616325efdb635f',
      algorithm: 'sha256',
      canonicalization: 'json-sorted-keys-v1'
    });
    const toHistoricalDefinition = (definition) => definition.actionKey === 'prediction-run'
      ? Object.freeze({
          ...definition,
          requiredArtifactBindings: ['12-prediction-configs'],
          executorVersion: 'prediction-executor:not-connected',
          implementationStatus: 'not-connected'
        })
      : definition;
    const historicalRegistry = Object.freeze({
      ...liveRegistry,
      DEMO_POST_ACTION_REGISTRY_VERSION: historicalIdentity.version,
      getDemoPostActionRegistryIdentity() { return { ...historicalIdentity }; },
      listDemoPostActions() { return liveRegistry.listDemoPostActions().map(toHistoricalDefinition); },
      requireDemoPostAction(actionKey) {
        return toHistoricalDefinition(liveRegistry.requireDemoPostAction(actionKey));
      }
    });
    require.cache[registryPath].exports = historicalRegistry;
    const service = require(servicePath);
    require.cache[registryPath].exports = liveRegistry;
    const harness = fixture.createHarness('p6-historical-v6-blocked-replay');
    try {
      const definition = historicalRegistry.requireDemoPostAction('prediction-run');
      const request = {
        db: harness.db,
        runId: harness.fixture.demoRun.runId,
        actionKey: 'prediction-run',
        actorUserId: harness.actor.userId,
        actorIp: harness.actor.ip,
        body: { clientRequestId: 'p6-historical-v6-blocked-replay' }
      };
      const blocked = service.previewDemoPostAction(request);
      assert.strictEqual(blocked.status, 'blocked');
      assert.strictEqual(blocked.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
      assert.deepStrictEqual(blocked.input, {
        requiredArtifactBindings: ['12-prediction-configs']
      });
      assert.deepStrictEqual(service.previewDemoPostAction(request), blocked);
      assert.deepStrictEqual(service.getDemoPostActionStatus({
        db: harness.db,
        actionRunId: blocked.actionRunId,
        actorUserId: harness.actor.userId
      }), blocked);
      assert.deepStrictEqual(service.getDemoPostActionRegistry().identity, historicalIdentity);
      assert.strictEqual(liveRegistry.getDemoPostActionRegistryIdentity().version, 'demo-post-actions:v7');
      assert.throws(() => service.executeDemoPostAction({
        db: harness.db,
        actionRunId: blocked.actionRunId,
        actorUserId: harness.actor.userId,
        actorIp: harness.actor.ip,
        body: {
          clientRequestId: 'p6-historical-v6-blocked-replay',
          previewDigest: blocked.previewDigest,
          confirmationText: definition.confirmationText
        }
      }), (error) => ['ACTION_HANDLER_NOT_CONNECTED', 'DEMO_POST_ACTION_BLOCKED']
        .includes(error.code || error.details?.code));
    } finally {
      harness.db.close();
      fixture.cleanupPredictionFixtureRoot();
    }
  `;
  execFileSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_OWNERSHIP_REGISTRATION_CONNECTED: 'false' },
    stdio: 'pipe'
  });
}

/** 验证完整 staged preview 只读领域数据，普通 caller 不能绕过 capability 直调 adapter。 */
function testResolverPreviewZeroWritesAndAlgorithms() {
  const lifecycle = loadPredictionLifecycleService();
  [
    ['moving_average', {}],
    ['linear_trend', {}],
    ['moving_average', { includePartialGroup: true }]
  ].forEach(([algorithm, options], index) => {
    const harness = predictionFixture.createHarness(`p5-preview-${index}-${algorithm}`, algorithm, options);
    try {
      const before = readPredictionLifecycleCounts(harness);
      assert.throws(() => harness.db.transaction(() => predictionAdapter.resolve(
        harness.db,
        harness.fixture.demoRun,
        { enabled: 1, runtimeEpoch: 1, revision: 1 },
        harness.actor.userId,
        harness.actor.ip
      )).immediate(), hasAnyErrorCode([
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED'
      ]));
      const preview = previewPrediction(
        lifecycle.service,
        harness,
        `p5-preview-${index}-${algorithm}`
      );
      assert.strictEqual(preview.status, 'previewed');
      assert.strictEqual(preview.outputCount, 0);
      assert.deepStrictEqual(preview.outputs, []);
      assert.strictEqual(preview.input.algorithm, algorithm);
      assert.strictEqual(preview.input.trainingRecordCount, options.includePartialGroup ? 6 : 4);
      assert.strictEqual(preview.input.trainingGroupCount, options.includePartialGroup ? 2 : 1);
      assert.strictEqual(preview.input.eligibleTrainingRecordCount, 4);
      assert.strictEqual(preview.input.minimumEligibleTrainingMonthCount, 4);
      assert.strictEqual(preview.input.eligibleGroupCount, 1);
      assert.strictEqual(preview.input.skippedGroupCount, options.includePartialGroup ? 1 : 0);
      assert.strictEqual(preview.input.expectedResultCount, 2);
      assert.deepStrictEqual(readPredictionLifecycleCounts(harness), before);
    } finally {
      harness.db.close();
    }
  });
}

/** 验证结构 wrapper、Proxy 与 revoked Proxy 都不能冒充原始数据库连接领取 capability。 */
function testFakeDatabaseObjectsCannotReceiveCapability() {
  const lifecycle = loadPredictionLifecycleService();
  const cases = [
    {
      name: 'plain-wrapper',
      create(db) {
        const wrapper = {};
        ['exec', 'prepare', 'pragma', 'transaction'].forEach((methodName) => {
          wrapper[methodName] = db[methodName].bind(db);
        });
        Object.defineProperties(wrapper, {
          open: { enumerable: true, get: () => db.open },
          inTransaction: { enumerable: true, get: () => db.inTransaction }
        });
        return wrapper;
      },
      expected: 'blocked'
    },
    {
      name: 'proxy-wrapper',
      create(db) {
        return new Proxy(db, {
          get(target, propertyName) {
            const value = Reflect.get(target, propertyName, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      },
      expected: 'blocked'
    },
    {
      name: 'revoked-proxy',
      create(db) {
        const revoked = Proxy.revocable(db, {});
        revoked.revoke();
        return revoked.proxy;
      },
      expected: 'throw'
    }
  ];
  cases.forEach((testCase) => {
    const harness = predictionFixture.createHarness(`p5-database-${testCase.name}`);
    const wrappedHarness = { ...harness, db: testCase.create(harness.db) };
    try {
      if (testCase.expected === 'throw') {
        assert.throws(() => previewPrediction(
          lifecycle.service,
          wrappedHarness,
          `p5-database-${testCase.name}`
        ));
      } else {
        const blocked = previewPrediction(
          lifecycle.service,
          wrappedHarness,
          `p5-database-${testCase.name}`
        );
        assert.strictEqual(blocked.status, 'blocked');
      }
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
      assert.strictEqual(readPredictionLifecycleCounts(harness).outputs, 0);
    } finally {
      harness.db.close();
    }
  });
}

/** 验证 config、ownership、record 与 batch 漂移矩阵全部 fail-closed 为 blocked preview。 */
function testResolverExactClosureNegativeMatrix() {
  const cases = [
    {
      name: 'archived-config',
      mutate(harness) {
        harness.db.prepare(`UPDATE prediction_configs
          SET status = 'archived', archived_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          harness.fixture.configId
        );
      }
    },
    {
      name: 'extra-config-ownership',
      mutate(harness) {
        harness.db.prepare(`INSERT INTO demo_data_registry
          (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
           identity_digest, snapshot_digest, source_batch_id, source_row_number, registered_by)
          VALUES (?, '12-prediction-configs', 'prediction_config', ?, 'imported', ?, ?, ?, 99, ?)`).run(
          harness.fixture.demoRun.runId,
          String(harness.fixture.sentinelConfigId),
          sha256('extra-config-identity'),
          sha256('extra-config-snapshot'),
          harness.fixture.configBatchId,
          harness.actor.userId
        );
      }
    },
    {
      name: 'ownership-snapshot-drift',
      mutate(harness) {
        harness.db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
          WHERE run_id = ? AND artifact_key = '07-monthly-energy'
            AND entity_type = 'energy_record' AND entity_pk = ?`).run(
          sha256('snapshot-drift'),
          harness.fixture.demoRun.runId,
          String(harness.fixture.trainingRecordIds[0])
        );
      }
    },
    {
      name: 'record-inactive',
      mutate(harness) {
        harness.db.prepare("UPDATE energy_records SET record_status = 'void' WHERE id = ?")
          .run(harness.fixture.trainingRecordIds[0]);
      }
    },
    {
      name: 'batch-fields-swapped',
      mutate(harness) {
        harness.db.prepare(`UPDATE prediction_configs
          SET source_batch_id = source_batch_filter_id,
              source_batch_filter_id = source_batch_id
          WHERE id = ?`).run(harness.fixture.configId);
      }
    },
    {
      name: 'missing-primary-context',
      mutate(harness) {
        harness.db.prepare(`DELETE FROM demo_run_import_batches
          WHERE run_id = ? AND artifact_key = '12-prediction-configs'
            AND batch_role = 'primary'`).run(harness.fixture.demoRun.runId);
      }
    }
  ];
  const lifecycle = loadPredictionLifecycleService();
  cases.forEach((testCase) => {
    const harness = predictionFixture.createHarness(`p5-negative-${testCase.name}`);
    try {
      testCase.mutate(harness);
      const preview = previewPrediction(
        lifecycle.service,
        harness,
        `p5-negative-${testCase.name}`
      );
      assert.strictEqual(preview.status, 'blocked', `${testCase.name} 必须 blocked。`);
      assert.strictEqual(preview.result, null);
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
    } finally {
      harness.db.close();
    }
  });
}

/** 验证无历史与全部样本不足通过完整 staged preview 返回受控 blocker 且零写。 */
function testPreviewControlledBlockers() {
  const lifecycle = loadPredictionLifecycleService();
  const cases = [
    {
      name: 'no-history',
      expectedCode: 'PREDICTION_EXACT_NO_HISTORY',
      create() {
        const harness = predictionFixture.createHarness('p5-preview-no-history');
        harness.db.prepare("UPDATE energy_records SET record_status = 'void'").run();
        return harness;
      }
    },
    {
      name: 'all-insufficient',
      expectedCode: 'PREDICTION_EXACT_NO_ELIGIBLE_GROUPS',
      create() {
        return predictionFixture.createHarness(
          'p5-preview-all-insufficient',
          'moving_average',
          { trainingMonthCount: 2 }
        );
      }
    }
  ];
  cases.forEach((testCase) => {
    const harness = testCase.create();
    try {
      const before = readPredictionLifecycleCounts(harness);
      const blocked = previewPrediction(lifecycle.service, harness, `p5-${testCase.name}`);
      assert.strictEqual(blocked.status, 'blocked');
      assert.strictEqual(blocked.blocker.code, testCase.expectedCode);
      assert.strictEqual(blocked.result, null);
      assert.strictEqual(blocked.outputCount, 0);
      assert.deepStrictEqual(readPredictionLifecycleCounts(harness), {
        ...before,
        executeAudits: 0
      });
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
    } finally {
      harness.db.close();
    }
  });
}

/** 验证独立 walker 能发现嵌套泄漏和全部异常结构，并扫描完整 staged DTO/replay。 */
function testIndependentPredictionPublicLeakageWalker() {
  const nestedSensitiveKey = {
    safe: [{ deeper: { predictionRunId: 'forged-domain-id' } }]
  };
  const nestedSensitiveValue = {
    safe: [{ deeper: { note: 'SELECT FROM prediction_runs' } }]
  };
  assert(collectPredictionPublicLeakage(nestedSensitiveKey).some((item) => (
    item.reason === 'forbidden-key' && item.path.endsWith('.predictionRunId')
  )), '独立 walker 必须发现故意嵌套的敏感 key。');
  assert(collectPredictionPublicLeakage(nestedSensitiveValue).some((item) => (
    item.reason === 'forbidden-value' && item.path.endsWith('.note')
  )), '独立 walker 必须发现故意嵌套的敏感 value。');
  [
    'id', 'ids', 'pk', 'registryId', 'recordId', 'RegistryID', 'recordIDs',
    'recordPk', 'record_id', 'record_ids', 'record_pk', 'record-id', 'record-ids', 'record-pk'
  ].forEach((fieldName) => {
    assert.strictEqual(
      isForbiddenPredictionPublicLeakageKey(fieldName),
      true,
      `${fieldName} 必须识别为内部 ID key。`
    );
  });
  assert.strictEqual(isForbiddenPredictionPublicLeakageKey('grid'), false);
  assert.deepStrictEqual(collectPredictionPublicLeakage({
    grid: 'ELECTRICITY',
    energyTypeCode: 'NATURAL_GAS'
  }), []);
  [
    'Bearer opaque-token',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    '123e4567-e89b-42d3-a456-426614174000',
    '0123456789abcdef0123456789abcdef',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'cap_hidden',
    'receipt_hidden',
    'witness_hidden',
    'authority_hidden'
  ].forEach((sensitiveValue) => {
    assert.strictEqual(isForbiddenPredictionPublicLeakageValue(sensitiveValue), true);
  });
  assert.throws(() => assertNoPredictionPublicLeakage({
    safe: [{ registryId: 'forged' }]
  }, '$assertion-canary'));

  const cycle = { safe: true };
  cycle.self = cycle;
  const symbolField = { safe: true };
  symbolField[Symbol('private')] = true;
  const hiddenField = { safe: true };
  Object.defineProperty(hiddenField, 'hidden', {
    enumerable: false,
    configurable: true,
    value: 'secret'
  });
  let accessorCalls = 0;
  const accessorField = { safe: true };
  Object.defineProperty(accessorField, 'computed', {
    enumerable: true,
    configurable: true,
    get() { accessorCalls += 1; return 'secret'; }
  });
  const sparseArray = new Array(2);
  sparseArray[1] = 'safe';
  const customPrototypeObject = Object.create({ inherited: true });
  customPrototypeObject.safe = true;
  const customPrototypeArray = [];
  Object.setPrototypeOf(customPrototypeArray, Object.create(Array.prototype));
  customPrototypeArray.push('safe');
  const ordinaryProxy = new Proxy({ safe: true }, {});
  const revokedProxy = Proxy.revocable({ safe: true }, {});
  revokedProxy.revoke();
  [
    cycle,
    symbolField,
    hiddenField,
    accessorField,
    sparseArray,
    customPrototypeObject,
    customPrototypeArray,
    ordinaryProxy,
    revokedProxy.proxy,
    Symbol('private-value')
  ].forEach((value, index) => {
    assert.throws(
      () => collectPredictionPublicLeakage(value, `$abnormal[${index}]`),
      `${index} 异常结构必须使独立 walker 测试失败。`
    );
  });
  assert.strictEqual(accessorCalls, 0, '独立 walker 不得执行 accessor。');

  const lifecycle = loadPredictionLifecycleService();
  const harness = predictionFixture.createHarness('p5-independent-public-leakage-walker');
  const requestId = 'p5-independent-public-leakage-walker';
  try {
    const preview = previewPrediction(lifecycle.service, harness, requestId);
    assert.notStrictEqual(preview.input, null, 'preview.input 必须非空。');
    assert.strictEqual(preview.result, null, 'preview.result 必须为空。');
    assert.deepStrictEqual(preview.outputs, [], 'preview.outputs 必须为空数组。');
    assertNoPredictionPublicLeakage(preview.input, 'preview.input');
    const previewStatus = lifecycle.service.getDemoPostActionStatus({
      db: harness.db,
      actionRunId: preview.actionRunId,
      actorUserId: harness.actor.userId
    });
    const previewReplay = previewPrediction(lifecycle.service, harness, requestId);
    [
      ['preview', preview],
      ['preview-status', previewStatus],
      ['preview-replay', previewReplay]
    ].forEach(([label, dto]) => assertPredictionLifecycleDtoHasNoPublicLeakage(
      dto,
      label,
      'previewed'
    ));

    const completed = executePrediction(
      lifecycle.service,
      lifecycle.definition,
      harness,
      preview,
      requestId
    );
    assert.notStrictEqual(completed.input, null, 'completed.input 必须非空。');
    assert.notStrictEqual(completed.result, null, 'completed.result 必须非空。');
    assert.strictEqual(completed.outputs.length, 3, 'completed.outputs 必须精确三项。');
    assert(completed.outputs.every((output) => output.outputRef !== null),
      'completed.outputRef 必须全部非空。');
    assertNoPredictionPublicLeakage(completed.input, 'completed.input');
    assertNoPredictionPublicLeakage(completed.result, 'completed.result');
    completed.outputs.forEach((output, index) => {
      assertNoPredictionPublicLeakage(
        output.outputRef,
        `completed.outputs[${index}].outputRef`
      );
    });
    const completedStatus = lifecycle.service.getDemoPostActionStatus({
      db: harness.db,
      actionRunId: preview.actionRunId,
      actorUserId: harness.actor.userId
    });
    const executeReplay = executePrediction(
      lifecycle.service,
      lifecycle.definition,
      harness,
      preview,
      requestId
    );
    [
      ['completed', completed],
      ['completed-status', completedStatus],
      ['execute-replay', executeReplay]
    ].forEach(([label, dto]) => assertPredictionLifecycleDtoHasNoPublicLeakage(
      dto,
      label,
      'succeeded'
    ));
  } finally {
    harness.db.close();
  }
}

/** 构造 strict public projector 可接受的最小 completed Prediction DTO。 */
function buildValidPublicResult() {
  return {
    algorithm: 'moving_average',
    windowSize: 3,
    trainingMonthStart: '2026-01',
    trainingMonthEnd: '2026-04',
    predictionMonthStart: '2026-05',
    predictionMonthEnd: '2026-06',
    trainingRecordCount: 4,
    trainingMonthCount: 4,
    trainingGroupCount: 1,
    eligibleTrainingRecordCount: 4,
    minimumEligibleTrainingMonthCount: 4,
    eligibleGroupCount: 1,
    skippedGroupCount: 0,
    expectedResultCount: 2,
    resultCount: 2,
    outputCount: 3,
    status: 'completed',
    results: [
      {
        energyTypeCode: 'electricity',
        canonicalUnit: 'kWh',
        targetMonth: '2026-05',
        predictedValue: 100,
        confidenceLow: 90,
        confidenceHigh: 110,
        method: 'moving_average'
      },
      {
        energyTypeCode: 'electricity',
        canonicalUnit: 'kWh',
        targetMonth: '2026-06',
        predictedValue: 105,
        confidenceLow: 94.5,
        confidenceHigh: 115.5,
        method: 'moving_average'
      }
    ]
  };
}

/** 断言 projector 对恶意边界不抛异常且 fail-closed 返回 null。 */
function assertPredictionProjectorNull(projectorCall, message) {
  let projected = Symbol('not-called');
  assert.doesNotThrow(() => { projected = projectorCall(); }, message);
  assert.strictEqual(projected, null, message);
}

/** 验证公共 projector 的 exact schema、业务闭包、Proxy 与反射异常全部 fail-closed。 */
function testStrictPublicProjectors() {
  const valid = buildValidPublicResult();
  assert.deepStrictEqual(predictionAdapter.projectPublicResult(valid), valid);
  const validInput = Object.fromEntries(Object.entries(valid).filter(([fieldName]) => ![
    'resultCount', 'outputCount', 'status', 'results'
  ].includes(fieldName)));
  assert.deepStrictEqual(predictionAdapter.projectPublicInput(validInput), validInput);
  assert.deepStrictEqual(predictionAdapter.projectPublicResult(valid.results[0], {
    kind: 'outputRef',
    outputEntityType: 'prediction_result'
  }), valid.results[0]);

  const missingField = { ...valid };
  delete missingField.algorithm;
  const malformed = [
    missingField,
    { ...valid, trainingRecordCount: '4' },
    { ...valid, trainingRecordCount: true },
    { ...valid, results: [{ ...valid.results[0], predictedValue: Number.NaN }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], confidenceHigh: Number.POSITIVE_INFINITY }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], predictedValue: 1e308 }, valid.results[1]] },
    { ...valid, predictionMonthStart: '2026-13' },
    { ...valid, results: [{ ...valid.results[0], targetMonth: '2026-13' }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], canonicalUnit: 'MWh' }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], method: 'linear_trend' }, valid.results[1]] },
    { ...valid, algorithm: 'year_over_year' },
    { ...valid, status: 'failed' },
    { ...valid, resultCount: 1 },
    { ...valid, outputCount: 2 },
    { ...valid, results: [valid.results[0], { ...valid.results[0] }] },
    { ...valid, internalId: 1 },
    { ...valid, privateDigest: sha256('private') },
    { ...valid, parameters_json: '{}' },
    { ...valid, warning: 'private warning' },
    { ...valid, handler: 'private-handler' },
    { ...valid, results: [{ ...valid.results[0], methodNote: 'raw note' }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], predictedValue: -1, confidenceLow: 0, confidenceHigh: 0 }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], confidenceLow: 91 }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], confidenceLow: 110, confidenceHigh: 90 }, valid.results[1]] },
    { ...valid, results: [{ ...valid.results[0], energyTypeCode: 'privateDigest' }, valid.results[1]] },
    { ...valid, windowSize: 12, minimumEligibleTrainingMonthCount: 4 },
    {
      ...valid,
      trainingRecordCount: 1,
      eligibleTrainingRecordCount: 1,
      minimumEligibleTrainingMonthCount: 4
    }
  ];
  malformed.forEach((value, index) => {
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicResult(value),
      `malformed public result ${index} 必须整体拒绝。`
    );
  });

  const overlongInput = {
    ...validInput,
    predictionMonthEnd: '2028-05',
    expectedResultCount: 25
  };
  assertPredictionProjectorNull(
    () => predictionAdapter.projectPublicInput(overlongInput),
    '超过 24 个月预测必须拒绝。'
  );
  const insufficientLinearInput = {
    ...validInput,
    algorithm: 'linear_trend',
    windowSize: null,
    minimumEligibleTrainingMonthCount: 2
  };
  assertPredictionProjectorNull(
    () => predictionAdapter.projectPublicInput(insufficientLinearInput),
    '线性趋势不足三个月样本必须拒绝。'
  );

  const accessorObject = { ...valid };
  Object.defineProperty(accessorObject, 'status', {
    enumerable: true,
    configurable: true,
    get() { return 'completed'; }
  });
  const symbolObject = { ...valid };
  symbolObject[Symbol('private-result')] = true;
  const hiddenExtraObject = { ...valid };
  Object.defineProperty(hiddenExtraObject, 'privateResult', {
    enumerable: false,
    configurable: true,
    value: true
  });
  const customPrototypeObject = { ...valid };
  Object.setPrototypeOf(customPrototypeObject, { custom: true });
  [accessorObject, symbolObject, hiddenExtraObject, customPrototypeObject].forEach((value, index) => {
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicResult(value),
      `非 exact 顶层对象 ${index} 必须整体拒绝。`
    );
  });

  const accessorResults = [...valid.results];
  Object.defineProperty(accessorResults, '0', {
    enumerable: true,
    configurable: true,
    get() { return valid.results[0]; }
  });
  const symbolResults = [...valid.results];
  symbolResults[Symbol('private-result')] = valid.results[0];
  const hiddenExtraResults = [...valid.results];
  Object.defineProperty(hiddenExtraResults, 'privateResult', {
    enumerable: false,
    configurable: true,
    value: valid.results[0]
  });
  const sparseResults = new Array(valid.results.length);
  sparseResults[0] = valid.results[0];
  const customPrototypeResults = [...valid.results];
  Object.setPrototypeOf(customPrototypeResults, []);
  const ordinaryArrayProxy = new Proxy([...valid.results], {});
  const revokedArray = Proxy.revocable([...valid.results], {});
  revokedArray.revoke();
  [
    accessorResults,
    symbolResults,
    hiddenExtraResults,
    sparseResults,
    customPrototypeResults,
    ordinaryArrayProxy,
    revokedArray.proxy
  ].forEach((results, index) => {
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicResult({ ...valid, results }),
      `非 exact results 数组 ${index} 必须整体拒绝。`
    );
  });

  const ordinaryObjectProxy = new Proxy(valid, {});
  const revokedObject = Proxy.revocable(valid, {});
  revokedObject.revoke();
  [ordinaryObjectProxy, revokedObject.proxy].forEach((value, index) => {
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicResult(value),
      `对象 Proxy ${index} 必须整体拒绝。`
    );
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicInput(value),
      `input 对象 Proxy ${index} 必须整体拒绝。`
    );
  });
  const ordinaryItemProxy = new Proxy(valid.results[0], {});
  const revokedItem = Proxy.revocable(valid.results[0], {});
  revokedItem.revoke();
  [ordinaryItemProxy, revokedItem.proxy].forEach((value, index) => {
    assertPredictionProjectorNull(
      () => predictionAdapter.projectPublicResult(value, {
        kind: 'outputRef',
        outputEntityType: 'prediction_result'
      }),
      `output item Proxy ${index} 必须整体拒绝。`
    );
  });
  const revokedProjection = Proxy.revocable({
    kind: 'outputRef',
    outputEntityType: 'prediction_result'
  }, {});
  revokedProjection.revoke();
  assertPredictionProjectorNull(
    () => predictionAdapter.projectPublicResult(valid.results[0], revokedProjection.proxy),
    'projection Proxy 必须整体拒绝。'
  );

  assertPredictionProjectorNull(
    () => predictionAdapter.projectPublicInput({ ...validInput, sourceBatchId: 1 }),
    'input 附加内部字段必须拒绝。'
  );
  assertPredictionProjectorNull(() => predictionAdapter.projectPublicResult(valid.results[0], {
    kind: 'outputRef',
    outputEntityType: 'unknown'
  }), '未知 output type 必须拒绝。');
}

/** 验证普通身份、clone、Proxy、错误对象与 replay 都不能替代阶段 capability。 */
function testRevalidateActionRunBindings() {
  const lifecycle = loadPredictionLifecycleService();
  const directHarness = predictionFixture.createHarness('p5-stage-direct');
  try {
    const preview = previewPrediction(lifecycle.service, directHarness, 'p5-stage-direct');
    const runtime = directHarness.db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch,
      revision FROM demo_runtime_settings WHERE id = 1`).get();
    assert.throws(() => directHarness.db.transaction(() => predictionAdapter.revalidate({
      db: directHarness.db,
      run: directHarness.fixture.demoRun,
      runtime,
      actionRunId: preview.actionRunId,
      actionStatus: 'previewed',
      definitionIdentity: {
        registryVersion: CURRENT_PREDICTION_REGISTRY_IDENTITY.version,
        registryDigest: CURRENT_PREDICTION_REGISTRY_IDENTITY.digest,
        actionKey: 'prediction-run',
        resolverVersion: 'prediction-resolver:v1',
        executorVersion: 'prediction-executor:v1'
      },
      actorUserId: directHarness.actor.userId,
      actorIp: directHarness.actor.ip,
      actor: Object.freeze({ ...directHarness.actor })
    })).immediate(), hasAnyErrorCode([
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_CONTEXT_INVALID'
    ]));
  } finally {
    directHarness.db.close();
  }

  const cases = [
    {
      name: 'missing-capability',
      mutate(context) { return { ...context, definitionCapability: null }; }
    },
    {
      name: 'spread-capability',
      mutate(context) {
        return { ...context, definitionCapability: { ...context.definitionCapability } };
      }
    },
    {
      name: 'json-capability',
      mutate(context) {
        return {
          ...context,
          definitionCapability: JSON.parse(JSON.stringify(context.definitionCapability))
        };
      }
    },
    {
      name: 'proxy-capability',
      mutate(context) {
        return { ...context, definitionCapability: new Proxy(context.definitionCapability, {}) };
      }
    },
    {
      name: 'revoked-proxy-capability',
      mutate(context) {
        const revoked = Proxy.revocable(context.definitionCapability, {});
        revoked.revoke();
        return { ...context, definitionCapability: revoked.proxy };
      }
    },
    {
      name: 'proxy-context',
      mutate(context) { return new Proxy(context, {}); }
    },
    {
      name: 'revoked-proxy-context',
      mutate(context) {
        const revoked = Proxy.revocable(context, {});
        revoked.revoke();
        return revoked.proxy;
      }
    },
    {
      name: 'ordinary-definition-identity',
      mutate(context) {
        return {
          ...context,
          definitionIdentity: {
            registryVersion: CURRENT_PREDICTION_REGISTRY_IDENTITY.version,
            registryDigest: CURRENT_PREDICTION_REGISTRY_IDENTITY.digest,
            actionKey: 'prediction-run',
            resolverVersion: 'prediction-resolver:v1',
            executorVersion: 'prediction-executor:v1'
          }
        };
      }
    },
    {
      name: 'wrong-action',
      mutate(context) { return { ...context, actionRunId: `${context.actionRunId}-forged` }; }
    },
    {
      name: 'wrong-status-stage',
      mutate(context) { return { ...context, actionStatus: 'executing' }; }
    },
    {
      name: 'wrong-actor-reference',
      mutate(context) { return { ...context, actor: Object.freeze({ ...context.actor }) }; }
    },
    {
      name: 'wrong-run-reference',
      mutate(context) { return { ...context, run: { ...context.run } }; }
    },
    {
      name: 'wrong-runtime-reference',
      mutate(context) { return { ...context, runtime: { ...context.runtime } }; }
    },
    {
      name: 'replay',
      invoke(context) {
        predictionAdapter.revalidate(context);
        return predictionAdapter.revalidate(context);
      }
    }
  ];
  cases.forEach((testCase) => {
    const scenarioKey = sha256(testCase.name).slice(0, 12);
    const harness = predictionFixture.createHarness(`p5-stage-${scenarioKey}`);
    const requestId = `p5-stage-${scenarioKey}`;
    try {
      const preview = previewPrediction(lifecycle.service, harness, requestId);
      const override = buildFaultAdapter({
        revalidate(context) {
          const mutated = testCase.mutate ? testCase.mutate(context) : context;
          return testCase.invoke
            ? testCase.invoke(mutated)
            : predictionAdapter.revalidate(mutated);
        }
      });
      assert.throws(() => withPredictionAdapterOverride(
        override,
        () => executePrediction(
          lifecycle.service,
          lifecycle.definition,
          harness,
          preview,
          requestId
        )
      ), hasAnyErrorCode(['DEMO_POST_ACTION_INPUT_STALE']));
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
      assert.strictEqual(readPredictionLifecycleCounts(harness).outputs, 0);
    } finally {
      harness.db.close();
    }
  });

  ['same-physical-second-connection', 'wrong-database'].forEach((name) => {
    const scenarioKey = sha256(name).slice(0, 12);
    const harness = predictionFixture.createHarness(`p5-stage-db-${scenarioKey}`);
    const otherHarness = name === 'wrong-database'
      ? predictionFixture.createHarness(`p5-stage-db-${scenarioKey}-other`)
      : null;
    const otherDb = otherHarness
      ? otherHarness.db
      : openDatabase({ databasePath: harness.databasePath });
    const requestId = `p5-stage-db-${scenarioKey}`;
    try {
      const preview = previewPrediction(lifecycle.service, harness, requestId);
      const override = buildFaultAdapter({
        revalidate(context) {
          return predictionAdapter.revalidate({ ...context, db: otherDb });
        }
      });
      assert.throws(() => withPredictionAdapterOverride(
        override,
        () => executePrediction(
          lifecycle.service,
          lifecycle.definition,
          harness,
          preview,
          requestId
        )
      ), hasAnyErrorCode(['DEMO_POST_ACTION_INPUT_STALE']));
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 0,
        results: 0,
        derived: 0,
        relations: 0
      });
      assert.strictEqual(readPredictionLifecycleCounts(harness).outputs, 0);
    } finally {
      if (otherDb.open) otherDb.close();
      harness.db.close();
    }
  });
}

/** 验证 moving average、linear trend 与 partial group 都可通过完整 staged lifecycle。 */
function testSuccessfulStagedLifecycleAlgorithms() {
  const lifecycle = loadPredictionLifecycleService();
  [
    ['moving_average', {}],
    ['linear_trend', {}],
    ['moving_average', { includePartialGroup: true }]
  ].forEach(([algorithm, options], index) => {
    const harness = predictionFixture.createHarness(`p5-success-${index}-${algorithm}`, algorithm, options);
    const clientRequestId = `p5-success-${index}-${algorithm}`;
    try {
      const preview = previewPrediction(lifecycle.service, harness, clientRequestId);
      assert.strictEqual(preview.status, 'previewed');
      assert.strictEqual(preview.input.algorithm, algorithm);
      assert.strictEqual(preview.input.eligibleGroupCount, 1);
      assert.strictEqual(preview.input.skippedGroupCount, options.includePartialGroup ? 1 : 0);
      const completed = executePrediction(
        lifecycle.service,
        lifecycle.definition,
        harness,
        preview,
        clientRequestId
      );
      assert.strictEqual(completed.status, 'succeeded', completed.failureReason || 'missing-failure-reason');
      assert.strictEqual(completed.result.status, 'completed');
      assert.strictEqual(completed.result.resultCount, 2);
      assert.strictEqual(completed.outputCount, 3);
      assert.deepStrictEqual(completed.outputs.map((output) => output.outputEntityType), [
        'prediction_run',
        'prediction_result',
        'prediction_result'
      ]);
      assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
        runs: 1,
        results: 2,
        derived: 3,
        relations: options.includePartialGroup ? 9 : 7
      });
      assert.strictEqual(readPredictionLifecycleCounts(harness).executeAudits, 1);
      assertNoPersistedDefinitionCapabilityLeakage(harness, preview.actionRunId);
    } finally {
      harness.db.close();
    }
  });
}

/** 包装 canonical adapter，保持七项 surface 并注入指定故障。 */
function buildFaultAdapter(overrides = {}) {
  return Object.freeze(Object.fromEntries(ADAPTER_EXPORT_FIELDS.map((fieldName) => (
    [fieldName, overrides[fieldName] || predictionAdapter[fieldName]]
  ))));
}

/** 运行单个执行故障并断言领域、derived、relation 与 output 全部回滚，action 收敛 failed。 */
function assertExecutionFaultRollsBack(name, setup) {
  const scenarioKey = sha256(name).slice(0, 12);
  const harness = predictionFixture.createHarness(`p5-fault-${scenarioKey}`);
  const fault = setup(harness);
  const lifecycle = loadPredictionLifecycleService();
  const requestId = `p5-fault-${scenarioKey}`;
  try {
    let preview = null;
    const terminal = withPredictionAdapterOverride(
      fault.adapter || predictionAdapter,
      () => {
        preview = previewPrediction(lifecycle.service, harness, requestId);
        assert.strictEqual(preview.status, 'previewed');
        if (fault.beforeExecute) fault.beforeExecute(preview);
        return executePrediction(
          lifecycle.service,
          lifecycle.definition,
          harness,
          preview,
          requestId
        );
      }
    );
    assert.strictEqual(terminal.status, 'failed', `${name} action 必须收敛为 failed。`);
    assert.strictEqual(terminal.outputCount, 0);
    assert.strictEqual(terminal.result, null);
    const actionRow = harness.db.prepare(`SELECT status, output_count AS outputCount,
        result_json AS resultJson, result_digest AS resultDigest,
        completed_at AS completedAt, failure_reason AS failureReason
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
    assert.strictEqual(actionRow.status, 'failed');
    assert.strictEqual(Number(actionRow.outputCount), 0);
    assert.strictEqual(actionRow.resultJson, null);
    assert.strictEqual(actionRow.resultDigest, null);
    assert.strictEqual(typeof actionRow.completedAt, 'string');
    assert(/^[A-Z0-9_:-]{1,128}$/.test(actionRow.failureReason));
    assert.strictEqual(actionRow.failureReason.toLowerCase().includes('p5 fault'), false);
    assert.strictEqual(actionRow.failureReason.includes('受控'), false);
    assert.strictEqual(
      /(?:capability|authority|scope|witness|receipt|token)/i.test(actionRow.failureReason),
      false,
      `${name} 不得持久化 private protocol 错误文本。`
    );
    const executeAudits = harness.db.prepare(`SELECT detail_json AS detailJson
      FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute'
        AND target_type = 'demo_post_action_run' AND target_id = ?
      ORDER BY id`).all(preview.actionRunId);
    assert.strictEqual(executeAudits.length, 1, `${name} 必须只有一条 failed execute audit。`);
    const auditDetail = JSON.parse(executeAudits[0].detailJson);
    assert.strictEqual(auditDetail.status, 'failed');
    assert.strictEqual(auditDetail.failureReason, actionRow.failureReason);
    assert.strictEqual(
      /(?:capability|authority|scope|witness|receipt|token)/i.test(executeAudits[0].detailJson),
      false,
      `${name} failed audit 不得泄漏 private protocol。`
    );
    assert.strictEqual(executeAudits.some((audit) => (
      JSON.parse(audit.detailJson).status === 'succeeded'
    )), false, `${name} 不得残留 success audit。`);
    assert.deepStrictEqual(predictionFixture.readDerivedCounts(harness), {
      runs: 0,
      results: 0,
      derived: 0,
      relations: 0
    });
    assert.strictEqual(readPredictionLifecycleCounts(harness).outputs, 0);
    assertNoPersistedDefinitionCapabilityLeakage(harness, preview.actionRunId);
  } finally {
    if (fault.cleanup) fault.cleanup();
    harness.db.close();
  }
}

/** 验证 execute capability、私有上下文、连接与 transaction 伪造均在领域写入前失败。 */
function testExecuteDefinitionCapabilityFailureMatrix() {
  const capabilityCases = [
    {
      name: 'execute-capability-missing',
      mutate(context) { return { ...context, definitionCapability: null }; }
    },
    {
      name: 'execute-capability-spread',
      mutate(context) {
        return { ...context, definitionCapability: { ...context.definitionCapability } };
      }
    },
    {
      name: 'execute-capability-json',
      mutate(context) {
        return {
          ...context,
          definitionCapability: JSON.parse(JSON.stringify(context.definitionCapability))
        };
      }
    },
    {
      name: 'execute-capability-proxy',
      mutate(context) {
        return { ...context, definitionCapability: new Proxy(context.definitionCapability, {}) };
      }
    },
    {
      name: 'execute-capability-revoked-proxy',
      mutate(context) {
        const revoked = Proxy.revocable(context.definitionCapability, {});
        revoked.revoke();
        return { ...context, definitionCapability: revoked.proxy };
      }
    },
    {
      name: 'execute-private-context-spread',
      mutate(context) { return { ...context, privateContext: { ...context.privateContext } }; }
    },
    {
      name: 'execute-private-context-proxy',
      mutate(context) {
        return { ...context, privateContext: new Proxy(context.privateContext, {}) };
      }
    },
    {
      name: 'execute-private-context-revoked-proxy',
      mutate(context) {
        const revoked = Proxy.revocable(context.privateContext, {});
        revoked.revoke();
        return { ...context, privateContext: revoked.proxy };
      }
    },
    {
      name: 'execute-wrong-action',
      mutate(context) { return { ...context, actionRunId: `${context.actionRunId}-forged` }; }
    },
    {
      name: 'execute-wrong-status',
      mutate(context) { return { ...context, actionStatus: 'previewed' }; }
    },
    {
      name: 'execute-wrong-actor-reference',
      mutate(context) { return { ...context, actor: Object.freeze({ ...context.actor }) }; }
    },
    {
      name: 'execute-wrong-run-reference',
      mutate(context) { return { ...context, run: { ...context.run } }; }
    },
    {
      name: 'execute-wrong-runtime-reference',
      mutate(context) { return { ...context, runtime: { ...context.runtime } }; }
    }
  ];
  capabilityCases.forEach((testCase) => {
    assertExecutionFaultRollsBack(testCase.name, () => ({
      adapter: buildFaultAdapter({
        execute(context) {
          return predictionAdapter.execute(testCase.mutate(context));
        }
      })
    }));
  });

  assertExecutionFaultRollsBack('execute-capability-replay', () => ({
    adapter: buildFaultAdapter({
      execute(context) {
        predictionAdapter.execute(context);
        return predictionAdapter.execute(context);
      }
    })
  }));

  assertExecutionFaultRollsBack('execute-wrong-second-connection', (harness) => {
    const secondDb = openDatabase({ databasePath: harness.databasePath });
    return {
      adapter: buildFaultAdapter({
        execute(context) {
          return predictionAdapter.execute({ ...context, db: secondDb });
        }
      }),
      cleanup() { if (secondDb.open) secondDb.close(); }
    };
  });

  assertExecutionFaultRollsBack('execute-rollback-rebegin', () => ({
    adapter: buildFaultAdapter({
      execute(context) {
        context.db.exec('ROLLBACK');
        context.db.exec('BEGIN IMMEDIATE');
        return predictionAdapter.execute(context);
      }
    })
  }));
}

/** 验证第二次 revalidate、P3/P4、output、action success 和 audit 故障均完整回滚。 */
function testLifecycleFaultRollbackMatrix() {
  testExecuteDefinitionCapabilityFailureMatrix();
  let revalidateCalls = 0;
  assertExecutionFaultRollsBack('second-revalidate-stale', () => ({
    adapter: buildFaultAdapter({
      revalidate(context) {
        revalidateCalls += 1;
        const resolved = predictionAdapter.revalidate(context);
        return revalidateCalls === 2
          ? { ...resolved, privateDigest: sha256('second-revalidate-stale') }
          : resolved;
      }
    })
  }));
  assert.strictEqual(revalidateCalls, 2);

  assertExecutionFaultRollsBack('p3-post-execute', () => ({
    adapter: buildFaultAdapter({
      execute(context) {
        predictionAdapter.execute(context);
        throw new Error('受控 P3 后置故障');
      }
    })
  }));

  [
    {
      name: 'p3-prediction-run',
      sql: `CREATE TEMP TRIGGER p5_fault_p3_prediction_run
        BEFORE INSERT ON prediction_runs
        BEGIN SELECT RAISE(ABORT, 'p5 fault p3 prediction run'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_p3_prediction_run'
    },
    {
      name: 'p4-registry',
      sql: `CREATE TEMP TRIGGER p5_fault_p4_registry
        BEFORE INSERT ON demo_data_registry
        WHEN NEW.ownership_kind = 'derived'
        BEGIN SELECT RAISE(ABORT, 'p5 fault p4 registry'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_p4_registry'
    },
    {
      name: 'p4-relation',
      sql: `CREATE TEMP TRIGGER p5_fault_p4_relation
        BEFORE INSERT ON demo_data_relations
        BEGIN SELECT RAISE(ABORT, 'p5 fault p4 relation'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_p4_relation'
    },
    {
      name: 'output-persist',
      sql: `CREATE TEMP TRIGGER p5_fault_output
        BEFORE INSERT ON demo_post_action_outputs
        BEGIN SELECT RAISE(ABORT, 'p5 fault output'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_output'
    },
    {
      name: 'action-success',
      sql: `CREATE TEMP TRIGGER p5_fault_action_success
        BEFORE UPDATE ON demo_post_action_runs
        WHEN NEW.status = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'p5 fault action'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_action_success'
    },
    {
      name: 'success-audit',
      sql: `CREATE TEMP TRIGGER p5_fault_success_audit
        BEFORE INSERT ON sys_operation_logs
        WHEN NEW.operation = 'system.demo.post-action.execute'
          AND NEW.detail_json LIKE '%\"status\":\"succeeded\"%'
        BEGIN SELECT RAISE(ABORT, 'p5 fault audit'); END`,
      drop: 'DROP TRIGGER IF EXISTS p5_fault_success_audit'
    }
  ].forEach((testCase) => {
    assertExecutionFaultRollsBack(testCase.name, (harness) => ({
      beforeExecute() { harness.db.exec(testCase.sql); },
      cleanup() {
        if (harness.db.open) harness.db.exec(testCase.drop);
      }
    }));
  });
}

/** 插入可控 run/artifact/entity/cleaned 状态的 derived fragment。 */
function insertPredictionDerivedFragment(harness, entityType, options = {}) {
  const runId = options.runId || harness.fixture.demoRun.runId;
  const artifactKey = options.artifactKey || '12-prediction-configs';
  const entityPk = options.entityPk || (entityType === 'prediction_run' ? '900001' : '900002');
  let cleanupRunId = null;
  let cleanedAt = null;
  let cleanupResult = null;
  if (options.cleaned === true) {
    cleanupRunId = `p5-cleanup-${crypto.randomUUID()}`;
    cleanedAt = new Date().toISOString();
    cleanupResult = 'already_missing';
    harness.db.prepare(`INSERT INTO demo_cleanup_runs
      (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
       runtime_revision, registry_watermark, candidate_count, blocker_count,
       requested_by, status, completed_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1, 0, ?, 'succeeded', ?)`).run(
      cleanupRunId,
      runId,
      `p5-cleaned-${crypto.randomUUID()}`,
      sha256(`cleaned-preview-${entityPk}`),
      new Date(Date.now() + 60 * 1000).toISOString(),
      `p5-cleaned-${entityPk}`,
      harness.actor.userId,
      cleanedAt
    );
  }
  harness.db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind,
     identity_digest, snapshot_digest, registered_by,
     cleaned_at, cleanup_run_id, cleanup_result)
    VALUES (?, ?, ?, ?, 'derived', ?, ?, ?, ?, ?, ?)`).run(
    runId,
    artifactKey,
    entityType,
    entityPk,
    sha256(`${entityType}-${entityPk}-identity`),
    sha256(`${entityType}-${entityPk}-snapshot`),
    harness.actor.userId,
    cleanedAt,
    cleanupRunId,
    cleanupResult
  );
}

/** 验证 run-level blocker、两个 request 竞争、同 request replay 和普通正式 run 隔离。 */
function testActiveDerivedClosureBlockerAndIsolation() {
  const lifecycle = loadPredictionLifecycleService();
  ['prediction_run', 'prediction_result'].forEach((entityType) => {
    const harness = predictionFixture.createHarness(`p5-fragment-${entityType}`);
    try {
      insertPredictionDerivedFragment(harness, entityType);
      const blocked = previewPrediction(lifecycle.service, harness, `p5-fragment-${entityType}`);
      assert.strictEqual(blocked.status, 'blocked');
      assert.strictEqual(
        blocked.blocker.code,
        'DEMO_PREDICTION_ACTIVE_DERIVED_CLOSURE_EXISTS'
      );
    } finally {
      harness.db.close();
    }
  });

  const exclusionCases = [
    {
      name: 'cleaned-row',
      insert(harness) {
        insertPredictionDerivedFragment(harness, 'prediction_run', {
          cleaned: true,
          entityPk: '910001'
        });
      }
    },
    {
      name: 'other-run',
      insert(harness) {
        const otherRunId = `p5-other-run-${crypto.randomUUID()}`;
        harness.db.prepare(`INSERT INTO demo_dataset_runs
          (run_id, dataset_id, manifest_version, manifest_digest, status, created_by)
          VALUES (?, ?, ?, ?, 'active', ?)`).run(
          otherRunId,
          `p5-other-dataset-${crypto.randomUUID()}`,
          harness.fixture.demoRun.manifestVersion,
          harness.fixture.demoRun.manifestDigest,
          harness.actor.userId
        );
        insertPredictionDerivedFragment(harness, 'prediction_run', {
          runId: otherRunId,
          entityPk: '910002'
        });
      }
    },
    {
      name: 'other-artifact',
      insert(harness) {
        insertPredictionDerivedFragment(harness, 'prediction_run', {
          artifactKey: '11-carbon-factors',
          entityPk: '910003'
        });
      }
    },
    {
      name: 'unrelated-entity-type',
      insert(harness) {
        insertPredictionDerivedFragment(harness, 'carbon_calculation_run', {
          entityPk: '910004'
        });
      }
    }
  ];
  exclusionCases.forEach((testCase) => {
    const harness = predictionFixture.createHarness(`p5-blocker-exclusion-${testCase.name}`);
    try {
      testCase.insert(harness);
      const preview = previewPrediction(
        lifecycle.service,
        harness,
        `p5-blocker-exclusion-${testCase.name}`
      );
      assert.strictEqual(preview.status, 'previewed', `${testCase.name} 不得阻断。`);
    } finally {
      harness.db.close();
    }
  });

  const formalHarness = predictionFixture.createHarness('p5-formal-run-isolation');
  try {
    formalHarness.db.prepare(`INSERT INTO prediction_runs
      (name, algorithm, status, train_start_month, train_end_month,
       predict_start_month, predict_end_month, parameters_json)
      VALUES ('普通正式 Prediction run', 'moving_average', 'completed',
        '2025-01', '2025-04', '2025-05', '2025-06', '{}')`).run();
    const preview = previewPrediction(lifecycle.service, formalHarness, 'p5-formal-run-isolation');
    assert.strictEqual(preview.status, 'previewed');
    assert.strictEqual(Number(formalHarness.db.prepare(
      'SELECT COUNT(*) AS count FROM prediction_runs'
    ).get().count), 1, 'preview 不得吸收或改写普通正式 run。');
  } finally {
    formalHarness.db.close();
  }

  const raceHarness = predictionFixture.createHarness('p5-run-level-race');
  try {
    const previewA = previewPrediction(lifecycle.service, raceHarness, 'p5-run-level-a');
    const previewB = previewPrediction(lifecycle.service, raceHarness, 'p5-run-level-b');
    const completedA = executePrediction(
      lifecycle.service,
      lifecycle.definition,
      raceHarness,
      previewA,
      'p5-run-level-a'
    );
    assert.strictEqual(completedA.status, 'succeeded');
    assert.deepStrictEqual(executePrediction(
      lifecycle.service,
      lifecycle.definition,
      raceHarness,
      previewA,
      'p5-run-level-a'
    ), completedA, '同 request execute 必须幂等重放。');
    assert.throws(() => executePrediction(
      lifecycle.service,
      lifecycle.definition,
      raceHarness,
      previewB,
      'p5-run-level-b'
    ), hasAnyErrorCode(['DEMO_POST_ACTION_INPUT_STALE']));
    const blocked = previewPrediction(lifecycle.service, raceHarness, 'p5-run-level-c');
    assert.strictEqual(blocked.status, 'blocked');
    assert.strictEqual(blocked.blocker.code, 'DEMO_PREDICTION_ACTIVE_DERIVED_CLOSURE_EXISTS');
    assert.deepStrictEqual(predictionFixture.readDerivedCounts(raceHarness), {
      runs: 1,
      results: 2,
      derived: 3,
      relations: 7
    });
  } finally {
    raceHarness.db.close();
  }

  const multiConnectionHarness = predictionFixture.createHarness('p5-run-level-multi-connection');
  const secondDb = openDatabase({ databasePath: multiConnectionHarness.databasePath });
  const secondCallerHarness = { ...multiConnectionHarness, db: secondDb };
  try {
    const previewA = previewPrediction(
      lifecycle.service,
      multiConnectionHarness,
      'p5-multi-connection-a'
    );
    const previewB = previewPrediction(
      lifecycle.service,
      secondCallerHarness,
      'p5-multi-connection-b'
    );
    const completedA = executePrediction(
      lifecycle.service,
      lifecycle.definition,
      multiConnectionHarness,
      previewA,
      'p5-multi-connection-a'
    );
    assert.strictEqual(completedA.status, 'succeeded');
    assert.throws(() => executePrediction(
      lifecycle.service,
      lifecycle.definition,
      secondCallerHarness,
      previewB,
      'p5-multi-connection-b'
    ), hasAnyErrorCode(['DEMO_POST_ACTION_INPUT_STALE']));
    assert.deepStrictEqual(predictionFixture.readDerivedCounts(multiConnectionHarness), {
      runs: 1,
      results: 2,
      derived: 3,
      relations: 7
    });
  } finally {
    secondDb.close();
    multiConnectionHarness.db.close();
  }
}

/** 验证固定 v1 allowlist、marker/row 伪造和历史 DTO 独立降级。 */
function testHistoricalProjectionCompatibility() {
  const harness = predictionFixture.createHarness('p5-historical');
  const lifecycle = loadPredictionLifecycleService();
  const requestId = 'p5-historical';
  try {
    const preview = previewPrediction(lifecycle.service, harness, requestId);
    const previewStatus = lifecycle.service.getDemoPostActionStatus({
      db: harness.db,
      actionRunId: preview.actionRunId,
      actorUserId: harness.actor.userId
    });
    assert.deepStrictEqual(previewStatus, preview, 'preview replay 与 status 必须一致。');
    const terminal = executePrediction(
      lifecycle.service,
      lifecycle.definition,
      harness,
      preview,
      requestId
    );
    assert.deepStrictEqual(executePrediction(
      lifecycle.service,
      lifecycle.definition,
      harness,
      preview,
      requestId
    ), terminal, 'execute replay 必须返回同一 terminal DTO。');
    const row = harness.db.prepare(`SELECT action_key AS actionKey,
        resolver_version AS resolverVersion, executor_version AS executorVersion,
        input_json AS inputJson, result_json AS resultJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId);
    const outputRows = harness.db.prepare(`SELECT output_id AS outputId,
        output_ref_json AS outputRefJson FROM demo_post_action_outputs
      WHERE action_run_id = ? ORDER BY output_id`).all(preview.actionRunId);
    const originalInput = JSON.parse(row.inputJson);
    const originalResult = JSON.parse(row.resultJson);
    assert.strictEqual(originalInput.publicProjectionActionKey, 'prediction-run');
    assert.strictEqual(originalInput.publicProjectionResolverVersion, 'prediction-resolver:v1');
    assert.strictEqual(originalInput.publicProjectionExecutorVersion, 'prediction-executor:v1');
    assert.strictEqual(originalInput.publicProjectionVersion, 1);

    const replay = () => lifecycle.service.getDemoPostActionStatus({
      db: harness.db,
      actionRunId: preview.actionRunId,
      actorUserId: harness.actor.userId
    });
    const restoreIdentity = () => harness.db.prepare(`UPDATE demo_post_action_runs
      SET action_key = ?, resolver_version = ?, executor_version = ?, input_json = ?, result_json = ?
      WHERE action_run_id = ?`).run(
      row.actionKey,
      row.resolverVersion,
      row.executorVersion,
      row.inputJson,
      row.resultJson,
      preview.actionRunId
    );
    const replayEntrypoints = () => [
      replay(),
      previewPrediction(lifecycle.service, harness, requestId),
      executePrediction(lifecycle.service, lifecycle.definition, harness, preview, requestId)
    ];
    const assertFullyRedacted = (message, options = {}) => {
      const redactedRows = options.statusOnly === true ? [replay()] : replayEntrypoints();
      redactedRows.forEach((redacted) => {
        assert.strictEqual(redacted.input, null, `${message} input 必须 redacted。`);
        assert.strictEqual(redacted.result, null, `${message} result 必须 redacted。`);
        assert(redacted.outputs.every((output) => output.outputRef === null),
          `${message} outputs 必须 redacted。`);
      });
      if (options.statusOnly !== true) {
        assert.deepStrictEqual(redactedRows[0], redactedRows[1], `${message} status/preview 必须一致。`);
        assert.deepStrictEqual(redactedRows[0], redactedRows[2], `${message} status/execute 必须一致。`);
      }
    };

    assert.deepStrictEqual(replay(), terminal);
    assert.deepStrictEqual(lifecycle.service.getDemoPostActionStatus({
      db: harness.db,
      actionRunId: preview.actionRunId,
      actorUserId: harness.actor.userId
    }), terminal, '合法 v1 历史投影只依赖固定 marker allowlist。');

    const markerFields = [
      ['publicProjectionActionKey', 1],
      ['publicProjectionResolverVersion', null],
      ['publicProjectionExecutorVersion', {}],
      ['publicProjectionVersion', '1']
    ];
    markerFields.forEach(([fieldName, invalidValue]) => {
      const missing = { ...originalInput };
      delete missing[fieldName];
      harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
        .run(JSON.stringify(missing), preview.actionRunId);
      assertFullyRedacted(`marker ${fieldName} 缺失`);
      harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
        .run(JSON.stringify({ ...originalInput, [fieldName]: invalidValue }), preview.actionRunId);
      assertFullyRedacted(`marker ${fieldName} 类型错误`);
    });

    [
      ['publicProjectionActionKey', 'prediction-run-forged'],
      ['publicProjectionResolverVersion', 'prediction-resolver:forged'],
      ['publicProjectionExecutorVersion', 'prediction-executor:forged'],
      ['publicProjectionVersion', 2]
    ].forEach(([fieldName, forgedValue]) => {
      harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
        .run(JSON.stringify({ ...originalInput, [fieldName]: forgedValue }), preview.actionRunId);
      assertFullyRedacted(`forged ${fieldName}`);
    });

    harness.db.prepare(`UPDATE demo_post_action_runs SET action_key = ?, input_json = ?
      WHERE action_run_id = ?`).run(
      'prediction-run-forged',
      JSON.stringify({ ...originalInput, actionKey: 'prediction-run-forged',
        publicProjectionActionKey: 'prediction-run-forged' }),
      preview.actionRunId
    );
    assertFullyRedacted('row+marker 同步伪造 action', { statusOnly: true });
    restoreIdentity();
    harness.db.prepare(`UPDATE demo_post_action_runs SET resolver_version = ?, input_json = ?
      WHERE action_run_id = ?`).run(
      'prediction-resolver:forged',
      JSON.stringify({ ...originalInput,
        publicProjectionResolverVersion: 'prediction-resolver:forged' }),
      preview.actionRunId
    );
    assertFullyRedacted('row+marker 同步伪造 resolver');
    restoreIdentity();
    harness.db.prepare(`UPDATE demo_post_action_runs SET executor_version = ?, input_json = ?
      WHERE action_run_id = ?`).run(
      'prediction-executor:forged',
      JSON.stringify({ ...originalInput,
        publicProjectionExecutorVersion: 'prediction-executor:forged' }),
      preview.actionRunId
    );
    assertFullyRedacted('row+marker 同步伪造 executor');
    restoreIdentity();
    harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
      .run(JSON.stringify({ ...originalInput, publicProjectionVersion: 2 }), preview.actionRunId);
    assertFullyRedacted('row+marker 同步伪造 projection version');

    withIgnoredCheckConstraints(harness.db, () => {
      harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
        .run('{malformed-json', preview.actionRunId);
    });
    assertFullyRedacted('malformed input JSON');

    restoreIdentity();
    harness.db.prepare('UPDATE demo_post_action_runs SET input_json = ? WHERE action_run_id = ?')
      .run(JSON.stringify({ ...originalInput, privateEnvelopeField: 'forbidden' }),
        preview.actionRunId);
    let independentlyRedacted = replay();
    assert.strictEqual(independentlyRedacted.input, null);
    assert.strictEqual(independentlyRedacted.result.status, 'completed');
    assert(independentlyRedacted.outputs.every((output) => output.outputRef !== null));

    restoreIdentity();
    withIgnoredCheckConstraints(harness.db, () => {
      harness.db.prepare('UPDATE demo_post_action_runs SET result_json = ? WHERE action_run_id = ?')
        .run('{malformed-json', preview.actionRunId);
    });
    independentlyRedacted = replay();
    assert.notStrictEqual(independentlyRedacted.input, null);
    assert.strictEqual(independentlyRedacted.result, null);
    assert(independentlyRedacted.outputs.every((output) => output.outputRef !== null));

    restoreIdentity();
    const malformedOutput = {
      ...JSON.parse(outputRows[0].outputRefJson),
      parameters_json: '{}'
    };
    harness.db.prepare('UPDATE demo_post_action_outputs SET output_ref_json = ? WHERE output_id = ?')
      .run(JSON.stringify(malformedOutput), outputRows[0].outputId);
    independentlyRedacted = replay();
    assert.notStrictEqual(independentlyRedacted.input, null);
    assert.strictEqual(independentlyRedacted.result.status, 'completed');
    assert.strictEqual(independentlyRedacted.outputs[0].outputRef, null);
    assert(independentlyRedacted.outputs.slice(1).every((output) => output.outputRef !== null));

    harness.db.prepare('UPDATE demo_post_action_outputs SET output_ref_json = ? WHERE output_id = ?')
      .run(outputRows[0].outputRefJson, outputRows[0].outputId);
    withIgnoredCheckConstraints(harness.db, () => {
      harness.db.prepare('UPDATE demo_post_action_outputs SET output_ref_json = ? WHERE output_id = ?')
        .run('{malformed-json', outputRows[1].outputId);
    });
    independentlyRedacted = replay();
    assert.notStrictEqual(independentlyRedacted.input, null);
    assert.strictEqual(independentlyRedacted.result.status, 'completed');
    assert.notStrictEqual(independentlyRedacted.outputs[0].outputRef, null);
    assert.strictEqual(independentlyRedacted.outputs[1].outputRef, null);
    assert.notStrictEqual(independentlyRedacted.outputs[2].outputRef, null);
    harness.db.prepare('UPDATE demo_post_action_outputs SET output_ref_json = ? WHERE output_id = ?')
      .run(outputRows[1].outputRefJson, outputRows[1].outputId);
    restoreIdentity();
    const throwingProjectorAdapter = buildFaultAdapter({
      projectPublicInput() { throw new Error('project input fault'); },
      projectPublicResult() { throw new Error('project result fault'); }
    });
    let throwingProjection;
    assert.doesNotThrow(() => {
      throwingProjection = withPredictionAdapterOverride(
        throwingProjectorAdapter,
        () => lifecycle.service.getDemoPostActionStatus({
          db: harness.db,
          actionRunId: preview.actionRunId,
          actorUserId: harness.actor.userId
        })
      );
    });
    assert.strictEqual(throwingProjection.input, null);
    assert.strictEqual(throwingProjection.result, null);
    assert(throwingProjection.outputs.every((output) => output.outputRef === null));
  } finally {
    harness.db.close();
  }
}

/** 运行 Prediction P5 staged adapter 专项测试。 */
function run() {
  testAdapterSurfaceAndCacheIsolation();
  testCanonicalDefinitionAuthorityIsolationCanary();
  testCanonicalBrokerCacheCanaries();
  testProductionRegistryConnectedAndHistoricalV6Replay();
  testResolverPreviewZeroWritesAndAlgorithms();
  testFakeDatabaseObjectsCannotReceiveCapability();
  testResolverExactClosureNegativeMatrix();
  testPreviewControlledBlockers();
  testIndependentPredictionPublicLeakageWalker();
  testStrictPublicProjectors();
  testRevalidateActionRunBindings();
  testSuccessfulStagedLifecycleAlgorithms();
  testLifecycleFaultRollbackMatrix();
  testActiveDerivedClosureBlockerAndIsolation();
  testHistoricalProjectionCompatibility();
  console.log('demoPostActionPrediction tests passed');
}

try {
  run();
} finally {
  predictionFixture.cleanupPredictionFixtureRoot();
}
