'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

// argv 仅选择不可变测试文件，不作为取得通用测试能力的授权凭据。
const FIXED_SCENARIOS = Object.freeze({
  'carbon-accounting-derived-ownership': Object.freeze({
    injectCarbon: true,
    injectDemoOwnership: false,
    testPath: path.resolve(__dirname, '../carbonAccountingDerivedOwnership.test.js')
  }),
  'carbon-accounting-exact-calculation': Object.freeze({
    injectCarbon: true,
    injectDemoOwnership: false,
    testPath: path.resolve(__dirname, '../carbonAccountingExactCalculation.test.js')
  }),
  'carbon-accounting-routes': Object.freeze({
    injectCarbon: true,
    injectDemoOwnership: false,
    testPath: path.resolve(__dirname, '../carbonAccountingRoutes.test.js')
  }),
  'carbon-calculation-run-service': Object.freeze({
    injectCarbon: true,
    injectDemoOwnership: false,
    testPath: path.resolve(__dirname, '../carbonCalculationRunService.test.js')
  }),
  'demo-ownership-registration': Object.freeze({
    injectCarbon: false,
    injectDemoOwnership: true,
    testPath: path.resolve(__dirname, '../demoOwnershipRegistration.test.js')
  }),
  'energy-strategy-evaluation-service': Object.freeze({
    injectCarbon: false,
    injectDemoOwnership: true,
    testPath: path.resolve(__dirname, '../energyStrategyEvaluationService.test.js')
  })
});
// 物理 helper 绝不导出通用 runner；只在固定 test Module 首次加载期间由 loader 返回闭包能力。
const CARBON_HARNESS_PATH = require.resolve('./carbonAccountingFaultHarness');
const DEMO_HARNESS_PATH = require.resolve('./demoServiceTestHarness');
const CARBON_TRANSITIVE_FIXTURE_PATH = require.resolve(
  './carbonAccountingHarnessTransitiveFixture'
);
const DEMO_OWNERSHIP_COPY_FIXTURE_PATH = require.resolve(
  './demoOwnershipIdentityCopyFixture'
);
const DEMO_OWNERSHIP_SERVICE_PATH = require.resolve('../../services/demoOwnershipService');
const DEMO_OWNERSHIP_CANONICAL_PROTOCOL_SYMBOL = Symbol.for(
  'charcoal.demoOwnership.canonicalInternal.v1'
);
// Carbon 五个正式模块必须在单一初始化事务内完成加载。
const CARBON_SERVICE_PATHS = Object.freeze({
  calculation: require.resolve('../../services/carbonCalculationRunService'),
  result: require.resolve('../../services/carbonAccountingResultService'),
  ownership: require.resolve('../../services/carbonAccountingOwnershipService'),
  exactProtocol: require.resolve('../../services/carbonAccountingExactProtocol'),
  ownershipProtocol: require.resolve('../../services/carbonAccountingOwnershipProtocol')
});
// 私有 runtime state 只存在于隔离进程；初始化失败必须恢复进入前精确 scope identity。
const carbonHarnessRuntimeState = {
  capturedFaultScopes: new Map()
};

/**
 * 捕获 require.cache 的精确 key、module record 与既有 children 顺序。
 * @returns {Map<string, object>} cache 快照。
 */
function captureRequireCacheSnapshot() {
  return new Map(Object.keys(require.cache).map((cacheKey) => {
    const moduleRecord = require.cache[cacheKey];
    return [cacheKey, Object.freeze({
      children: Array.isArray(moduleRecord?.children) ? [...moduleRecord.children] : null,
      moduleRecord
    })];
  }));
}

/**
 * 恢复进入前精确 cache key → module record，并清理初始化新增项。
 * @param {Map<string, object>} snapshot 进入前快照。
 * @returns {void}
 */
function restoreRequireCacheSnapshot(snapshot) {
  Object.keys(require.cache).forEach((cacheKey) => {
    if (!snapshot.has(cacheKey)) delete require.cache[cacheKey];
  });
  snapshot.forEach((entry, cacheKey) => {
    require.cache[cacheKey] = entry.moduleRecord;
    if (entry.children && Array.isArray(entry.moduleRecord?.children)) {
      entry.moduleRecord.children.splice(
        0,
        entry.moduleRecord.children.length,
        ...entry.children
      );
    }
  });
}

/**
 * 断言当前 cache 与快照拥有完全相同的 key 和 module record identity。
 * @param {Map<string, object>} snapshot 期望快照。
 * @returns {void}
 */
function assertRequireCacheSnapshot(snapshot) {
  assert.deepStrictEqual([...Object.keys(require.cache)].sort(), [...snapshot.keys()].sort());
  snapshot.forEach((entry, cacheKey) => {
    assert.strictEqual(require.cache[cacheKey], entry.moduleRecord, `${cacheKey} record identity 必须恢复。`);
    if (entry.children) {
      assert.deepStrictEqual(entry.moduleRecord.children, entry.children, `${cacheKey} children 必须恢复。`);
    }
  });
}

/**
 * 首次加载一个 Carbon 服务并捕获唯一私有 AsyncLocalStorage。
 * @param {string} serviceName 服务名。
 * @param {string} modulePath 正式模块路径。
 * @param {object} options 初始化故障选项。
 * @returns {object} 正式 service 与私有 scope。
 */
function loadCarbonServiceWithCapturedScope(serviceName, modulePath, options) {
  if (require.cache[modulePath]) {
    const error = new Error(`Carbon 固定执行器必须先于 production 模块加载：${path.basename(modulePath)}`);
    error.code = 'CARBON_ACCOUNTING_HARNESS_TARGET_PREEXISTING';
    throw error;
  }
  const loadBeforeCapture = Module._load;
  const capturedScopes = [];
  let transitiveLoaded = false;
  const asyncHooks = require('async_hooks');
  class CapturingAsyncLocalStorage extends asyncHooks.AsyncLocalStorage {
    /** 记录当前目标服务创建的私有异步作用域。 */
    constructor(...args) {
      super(...args);
      capturedScopes.push(this);
    }
  }
  Module._load = function loadCarbonHarnessDependency(request, parent, isMain) {
    const loaded = loadBeforeCapture.call(this, request, parent, isMain);
    if (request === 'async_hooks' && parent?.filename === modulePath) {
      if (options.transitiveAt === serviceName && !transitiveLoaded) {
        transitiveLoaded = true;
        loadBeforeCapture.call(this, CARBON_TRANSITIVE_FIXTURE_PATH, parent, false);
      }
      return {
        ...loaded,
        AsyncLocalStorage: CapturingAsyncLocalStorage
      };
    }
    return loaded;
  };
  try {
    const service = require(modulePath);
    if (capturedScopes.length !== 1) {
      const error = new Error(`Carbon 固定执行器未捕获唯一私有作用域：${serviceName}`);
      error.code = 'CARBON_ACCOUNTING_HARNESS_SCOPE_CAPTURE_INVALID';
      throw error;
    }
    return Object.freeze({
      faultScope: capturedScopes[0],
      service
    });
  } finally {
    Module._load = loadBeforeCapture;
  }
}

/**
 * 以单一事务初始化 Carbon 正式模块和私有测试作用域。
 * @param {object} options 固定 canary 故障选项。
 * @returns {object} 仅供固定测试 Module 使用的冻结能力。
 */
function initializeCarbonAccountingCapability(options = {}) {
  const loadAtEntry = Module._load;
  const cacheSnapshot = captureRequireCacheSnapshot();
  const faultScopeSnapshot = new Map(carbonHarnessRuntimeState.capturedFaultScopes);
  const captured = new Map();
  try {
    Object.values(CARBON_SERVICE_PATHS).forEach((modulePath) => {
      if (require.cache[modulePath]) {
        const error = new Error(`Carbon 初始化前已存在 production cache：${path.basename(modulePath)}`);
        error.code = 'CARBON_ACCOUNTING_HARNESS_TARGET_PREEXISTING';
        throw error;
      }
    });
    ['calculation', 'result', 'ownership'].forEach((serviceName) => {
      const loaded = loadCarbonServiceWithCapturedScope(
        serviceName,
        CARBON_SERVICE_PATHS[serviceName],
        options
      );
      captured.set(serviceName, loaded);
      carbonHarnessRuntimeState.capturedFaultScopes.set(serviceName, loaded.faultScope);
      if (options.failAfter === serviceName) {
        const error = new Error(`固定初始化故障：${serviceName}`);
        error.code = 'CARBON_ACCOUNTING_HARNESS_INITIALIZATION_INJECTED';
        throw error;
      }
    });
    const carbonAccountingExactProtocol = require(CARBON_SERVICE_PATHS.exactProtocol);
    if (options.failAfter === 'exactProtocol') {
      const error = new Error('固定初始化故障：exactProtocol');
      error.code = 'CARBON_ACCOUNTING_HARNESS_INITIALIZATION_INJECTED';
      throw error;
    }
    const ownershipProtocolModule = require(CARBON_SERVICE_PATHS.ownershipProtocol);
    if (options.failAfter === 'ownershipProtocol') {
      const error = new Error('固定初始化故障：ownershipProtocol');
      error.code = 'CARBON_ACCOUNTING_HARNESS_INITIALIZATION_INJECTED';
      throw error;
    }
    const faultScopes = Object.freeze([
      captured.get('calculation').faultScope,
      captured.get('result').faultScope,
      captured.get('ownership').faultScope
    ]);
    /**
     * 在三个私有 ALS 内嵌套运行固定测试 operation。
     * @param {Function} faultInjector 固定测试 hook。
     * @param {Function} operation 固定测试操作。
     * @returns {*} 操作结果。
     */
    function runWithCarbonAccountingFaultInjectorForTest(faultInjector, operation) {
      if (typeof faultInjector !== 'function' || typeof operation !== 'function') {
        const error = new TypeError('Carbon 固定测试必须提供 hook 与 operation 函数。');
        error.code = 'CARBON_ACCOUNTING_TEST_FAULT_SCOPE_INVALID';
        throw error;
      }
      const scopedOperation = faultScopes.reduceRight(
        (nextOperation, faultScope) => () => faultScope.run(faultInjector, nextOperation),
        operation
      );
      return scopedOperation();
    }
    return Object.freeze({
      carbonAccountingExactProtocol,
      carbonAccountingOwnershipProtocol: ownershipProtocolModule.carbonAccountingOwnershipProtocol,
      carbonAccountingOwnershipProtocolModule: ownershipProtocolModule,
      carbonAccountingOwnershipService: captured.get('ownership').service,
      carbonAccountingResultService: captured.get('result').service,
      carbonCalculationRunService: captured.get('calculation').service,
      runWithCarbonAccountingFaultInjectorForTest
    });
  } catch (error) {
    carbonHarnessRuntimeState.capturedFaultScopes.clear();
    faultScopeSnapshot.forEach((faultScope, serviceName) => {
      carbonHarnessRuntimeState.capturedFaultScopes.set(serviceName, faultScope);
    });
    restoreRequireCacheSnapshot(cacheSnapshot);
    throw error;
  } finally {
    Module._load = loadAtEntry;
  }
}

/**
 * 从固定测试 Module 的真实 dependency record 取得 production ownership protocol。
 * @param {object} testModuleRecord 当前固定测试 Module record。
 * @returns {object} 仅供该测试 Module 使用的冻结能力。
 */
function initializeDemoOwnershipCapability(testModuleRecord) {
  const productionRecord = testModuleRecord.children.find(
    (childRecord) => childRecord?.filename === DEMO_OWNERSHIP_SERVICE_PATH
  );
  const currentRecord = require.cache[DEMO_OWNERSHIP_SERVICE_PATH];
  const productionExports = productionRecord?.exports;
  const protocolDescriptor = productionExports
    ? Object.getOwnPropertyDescriptor(
      productionExports,
      DEMO_OWNERSHIP_CANONICAL_PROTOCOL_SYMBOL
    )
    : null;
  const protocol = protocolDescriptor?.value;
  const valid = productionRecord
    && currentRecord === productionRecord
    && currentRecord.loaded === true
    && require(DEMO_OWNERSHIP_SERVICE_PATH) === productionExports
    && protocolDescriptor.enumerable === false
    && protocolDescriptor.writable === false
    && protocolDescriptor.configurable === false
    && Object.isFrozen(protocol) === true
    && typeof protocol.buildEntityRegistrationContract === 'function';
  if (!valid) {
    const error = new Error('Demo ownership production CommonJS wiring identity 无效。');
    error.code = 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID';
    throw error;
  }
  /** 每次 private contract 调用前重新确认真实 production record 与 protocol identity。 */
  function assertCurrentProductionIdentity() {
    const activeRecord = require.cache[DEMO_OWNERSHIP_SERVICE_PATH];
    const activeDescriptor = activeRecord?.exports
      ? Object.getOwnPropertyDescriptor(
        activeRecord.exports,
        DEMO_OWNERSHIP_CANONICAL_PROTOCOL_SYMBOL
      )
      : null;
    if (activeRecord !== productionRecord
      || activeRecord.loaded !== true
      || activeRecord.exports !== productionExports
      || activeDescriptor?.value !== protocol) {
      const error = new Error('Demo ownership production CommonJS wiring identity 无效。');
      error.code = 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID';
      throw error;
    }
  }
  return Object.freeze({
    /** 调用真实 production protocol 构造 registration contract。 */
    buildDemoEntityRegistrationContract(input) {
      assertCurrentProductionIdentity();
      return protocol.buildEntityRegistrationContract(input);
    }
  });
}

/**
 * 验证 Carbon 初始化任意阶段失败后可精确恢复并立即重试。
 * @returns {object} 立即重试成功后供当前固定测试使用的能力。
 */
function runCarbonInitializationRollbackCanary() {
  const sentinelFaultScope = Object.freeze({ sentinel: true });
  carbonHarnessRuntimeState.capturedFaultScopes.set('canary-sentinel', sentinelFaultScope);
  ['calculation', 'result', 'ownership', 'exactProtocol', 'ownershipProtocol']
    .forEach((failAfter, index) => {
      const cacheSnapshot = captureRequireCacheSnapshot();
      const loadAtEntry = Module._load;
      assert.throws(
        () => initializeCarbonAccountingCapability({
          failAfter,
          transitiveAt: index === 0 ? 'calculation' : null
        }),
        (error) => error?.code === 'CARBON_ACCOUNTING_HARNESS_INITIALIZATION_INJECTED'
      );
      assert.strictEqual(Module._load, loadAtEntry, 'Module._load identity 必须精确恢复。');
      assertRequireCacheSnapshot(cacheSnapshot);
      assert.strictEqual(require.cache[CARBON_TRANSITIVE_FIXTURE_PATH], undefined,
        '初始化新增 transitive cache entry 必须清理。');
      assert.deepStrictEqual(
        [...carbonHarnessRuntimeState.capturedFaultScopes.entries()],
        [['canary-sentinel', sentinelFaultScope]],
        '初始化失败必须恢复进入前 fault scope map 与对象 identity。'
      );
    });
  carbonHarnessRuntimeState.capturedFaultScopes.delete('canary-sentinel');

  const sentinelRecord = new Module(CARBON_SERVICE_PATHS.calculation, module);
  sentinelRecord.filename = CARBON_SERVICE_PATHS.calculation;
  sentinelRecord.loaded = false;
  sentinelRecord.exports = Object.freeze({ sentinel: true });
  require.cache[CARBON_SERVICE_PATHS.calculation] = sentinelRecord;
  const preexistingSnapshot = captureRequireCacheSnapshot();
  assert.throws(
    () => initializeCarbonAccountingCapability(),
    (error) => error?.code === 'CARBON_ACCOUNTING_HARNESS_TARGET_PREEXISTING'
  );
  assertRequireCacheSnapshot(preexistingSnapshot);
  assert.strictEqual(require.cache[CARBON_SERVICE_PATHS.calculation], sentinelRecord,
    '进入前已有 target record 不得被覆盖或删除。');
  delete require.cache[CARBON_SERVICE_PATHS.calculation];

  const failedSnapshot = captureRequireCacheSnapshot();
  assert.throws(
    () => initializeCarbonAccountingCapability({ failAfter: 'result' }),
    (error) => error?.code === 'CARBON_ACCOUNTING_HARNESS_INITIALIZATION_INJECTED'
  );
  assertRequireCacheSnapshot(failedSnapshot);
  const retriedCapability = initializeCarbonAccountingCapability();
  assert.strictEqual(typeof retriedCapability.runWithCarbonAccountingFaultInjectorForTest, 'function');
  assert.strictEqual(
    retriedCapability.runWithCarbonAccountingFaultInjectorForTest(
      () => assert.fail('无 production stage 时不得调用 fault hook。'),
      () => 'retry-ok'
    ),
    'retry-ok'
  );
  return retriedCapability;
}

/**
 * 验证 ownership 使用真实 CommonJS record，copy、替换与 loaded=false 均 fail-closed。
 * @returns {void}
 */
function runDemoOwnershipWiringCanary(testModuleRecord) {
  const productionExports = require(DEMO_OWNERSHIP_SERVICE_PATH);
  const productionRecord = require.cache[DEMO_OWNERSHIP_SERVICE_PATH];
  const guardedCapability = initializeDemoOwnershipCapability(testModuleRecord);
  assert(testModuleRecord.children.includes(productionRecord));
  assert.strictEqual(
    typeof guardedCapability.buildDemoEntityRegistrationContract,
    'function'
  );
  const copiedExports = require(DEMO_OWNERSHIP_COPY_FIXTURE_PATH);
  const copiedRecord = require.cache[DEMO_OWNERSHIP_COPY_FIXTURE_PATH];
  assert.notStrictEqual(copiedRecord, productionRecord, 'copy 必须拥有不同 CommonJS record。');
  assert.notStrictEqual(copiedExports, productionExports, 'copy 必须拥有不同 exports identity。');
  assert.strictEqual(
    copiedExports[DEMO_OWNERSHIP_CANONICAL_PROTOCOL_SYMBOL],
    productionExports[DEMO_OWNERSHIP_CANONICAL_PROTOCOL_SYMBOL],
    'copy canary 保持相同 protocol 值以证明 record identity 才是边界。'
  );

  require.cache[DEMO_OWNERSHIP_SERVICE_PATH] = copiedRecord;
  assert.throws(
    () => initializeDemoOwnershipCapability(testModuleRecord),
    (error) => error?.code === 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID'
  );
  assert.throws(
    () => guardedCapability.buildDemoEntityRegistrationContract({}),
    (error) => error?.code === 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID',
    '能力取得后替换 production record 也必须 fail-closed。'
  );
  require.cache[DEMO_OWNERSHIP_SERVICE_PATH] = productionRecord;
  productionRecord.loaded = false;
  assert.throws(
    () => initializeDemoOwnershipCapability(testModuleRecord),
    (error) => error?.code === 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID'
  );
  assert.throws(
    () => guardedCapability.buildDemoEntityRegistrationContract({}),
    (error) => error?.code === 'DEMO_OWNERSHIP_PRODUCTION_WIRING_INVALID',
    '能力取得后 production record loaded=false 也必须 fail-closed。'
  );
  productionRecord.loaded = true;
  assert.strictEqual(
    typeof initializeDemoOwnershipCapability(testModuleRecord).buildDemoEntityRegistrationContract,
    'function'
  );
}

/**
 * 运行固定测试文件，并只对该真实 test Module record 注入闭包能力。
 * @param {string} scenarioKey 固定场景键。
 * @returns {void}
 */
function runFixedScenario(scenarioKey) {
  if (arguments.length === 0) {
    const error = new Error('固定服务测试 runner 缺少场景参数。');
    error.code = 'FIXED_SERVICE_TEST_SCENARIO_MISSING';
    throw error;
  }
  if (arguments.length !== 1) {
    const error = new Error('固定服务测试 runner 只接受一个场景参数。');
    error.code = 'FIXED_SERVICE_TEST_SCENARIO_EXTRA';
    throw error;
  }
  if (!Object.hasOwn(FIXED_SCENARIOS, scenarioKey)) {
    const error = new Error('固定服务测试 runner 不识别该场景。');
    error.code = 'FIXED_SERVICE_TEST_SCENARIO_UNKNOWN';
    throw error;
  }
  const scenario = FIXED_SCENARIOS[scenarioKey];
  const loadAtEntry = Module._load;
  const carbonBootstrap = Object.freeze({
    fixedIsolatedChild: true,
    runFixedCarbonAccountingTest(testKey) {
      assert.strictEqual(testKey, scenarioKey, 'Carbon 子进程场景必须与固定测试一致。');
      return Object.freeze({
        delegated: false,
        isolated: true,
        status: 'running',
        testKey
      });
    }
  });
  const demoBootstrap = Object.freeze({
    fixedIsolatedChild: true,
    runFixedDemoOwnershipTest(testKey) {
      assert.strictEqual(testKey, scenarioKey, 'Demo 子进程场景必须与固定测试一致。');
      return Object.freeze({
        delegated: false,
        isolated: true,
        status: 'running',
        testKey
      });
    }
  });
  let carbonCapability = null;
  let carbonHelperRequestCount = 0;
  let demoOwnershipCapability = null;
  let demoHelperRequestCount = 0;
  Module._load = function loadFixedServiceTestDependency(request, parent, isMain) {
    const resolvedRequest = Module._resolveFilename(request, parent, isMain);
    const fixedTestModule = require.cache[scenario.testPath];
    const isExactFixedTestModule = parent
      && parent === fixedTestModule
      && parent.filename === scenario.testPath
      && parent.loaded === false;
    if (resolvedRequest === CARBON_HARNESS_PATH) {
      if (!scenario.injectCarbon || !isExactFixedTestModule) {
        const error = new Error('Carbon 私有测试能力只存在于固定隔离测试 Module。');
        error.code = 'CARBON_ACCOUNTING_FIXED_TEST_MODULE_REQUIRED';
        throw error;
      }
      carbonHelperRequestCount += 1;
      if (carbonHelperRequestCount === 1) return carbonBootstrap;
      if (carbonHelperRequestCount !== 2) {
        const error = new Error('Carbon 固定测试 helper 加载次数无效。');
        error.code = 'CARBON_ACCOUNTING_FIXED_TEST_LOAD_COUNT_INVALID';
        throw error;
      }
      if (!carbonCapability) {
        carbonCapability = scenarioKey === 'carbon-calculation-run-service'
          ? runCarbonInitializationRollbackCanary()
          : initializeCarbonAccountingCapability();
      }
      return carbonCapability;
    }
    if (resolvedRequest === DEMO_HARNESS_PATH) {
      if (!scenario.injectDemoOwnership || !isExactFixedTestModule) {
        const error = new Error('Demo ownership 私有测试能力只存在于固定隔离测试 Module。');
        error.code = 'DEMO_OWNERSHIP_FIXED_TEST_MODULE_REQUIRED';
        throw error;
      }
      demoHelperRequestCount += 1;
      const hasDemoBootstrap = scenario.injectDemoOwnership && !scenario.injectCarbon;
      if (hasDemoBootstrap && demoHelperRequestCount === 1) return demoBootstrap;
      const expectedRequestCount = hasDemoBootstrap ? 2 : 1;
      if (demoHelperRequestCount !== expectedRequestCount) {
        const error = new Error('Demo ownership 固定测试 helper 加载次数无效。');
        error.code = 'DEMO_OWNERSHIP_FIXED_TEST_LOAD_COUNT_INVALID';
        throw error;
      }
      if (scenarioKey === 'demo-ownership-registration') {
        runDemoOwnershipWiringCanary(parent);
      }
      if (!demoOwnershipCapability) {
        demoOwnershipCapability = initializeDemoOwnershipCapability(parent);
      }
      return Object.freeze({
        createDemoOwnershipTestHarness() {
          return demoOwnershipCapability;
        }
      });
    }
    return loadAtEntry.call(this, request, parent, isMain);
  };
  try {
    require(scenario.testPath);
  } finally {
    Module._load = loadAtEntry;
  }
}

// 被普通 require 时不给出 loader、initializer、private helper 或场景运行函数。
module.exports = Object.freeze({});

if (require.main === module) {
  try {
    // 将全部 CLI 场景参数交给同一基数校验，禁止静默忽略 argv[3+]。
    runFixedScenario(...process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
