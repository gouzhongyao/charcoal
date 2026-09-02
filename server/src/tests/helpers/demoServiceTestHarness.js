'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Demo 私有 registration contract 只允许在以下固定隔离测试文件内使用。
const FIXED_DEMO_OWNERSHIP_TEST_KEYS = Object.freeze(new Set([
  'demo-ownership-registration',
  'energy-strategy-evaluation-service'
]));
// 隔离执行器不向 require 调用者导出 private helper、handler getter 或数据库能力。
const FIXED_SERVICE_TEST_PROCESS_PATH = path.resolve(
  __dirname,
  'fixedServiceTestProcess.js'
);

/**
 * 构造固定子进程环境，移除 Node 预加载与 symlink 解析注入开关。
 * @returns {object} 保留业务测试环境的独立环境副本。
 */
function createFixedChildEnvironment() {
  // Node 启动注入变量名按平台无关方式统一过滤。
  const blockedEnvironmentNames = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_PRESERVE_SYMLINKS',
    'NODE_PRESERVE_SYMLINKS_MAIN'
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([environmentName]) => !blockedEnvironmentNames.has(environmentName.toUpperCase())
    )
  );
}

// post-action wiring 必须绑定已加载的 wrapper、canonical core 与共享 pure module record。
const DEMO_POST_ACTION_SERVICE_PATH = require.resolve('../../services/demoPostActionService');
const DEMO_POST_ACTION_CANONICAL_SERVICE_PATH = require.resolve(
  '../../services/demoPostActionCanonicalService'
);
const DEMO_POST_ACTION_PRIMITIVES_PATH = require.resolve(
  '../../services/demoPostActionServicePrimitives'
);
// 捕获 helper 进入时的真实 CommonJS record，后续 cache 替换或 loaded=false 必须 fail-closed。
const capturedPostActionServiceRecord = require.cache[DEMO_POST_ACTION_SERVICE_PATH] || null;
const capturedPostActionCanonicalServiceRecord =
  require.cache[DEMO_POST_ACTION_CANONICAL_SERVICE_PATH] || null;
const capturedPostActionPrimitivesRecord = require.cache[DEMO_POST_ACTION_PRIMITIVES_PATH] || null;
const capturedPostActionServiceExports = capturedPostActionServiceRecord?.exports || null;
const capturedPostActionCanonicalServiceExports =
  capturedPostActionCanonicalServiceRecord?.exports || null;
const capturedPostActionPrimitivesExports = capturedPostActionPrimitivesRecord?.exports || null;

/**
 * 在隔离子进程中运行固定 Demo ownership 测试文件。
 * @param {string} testKey 固定测试场景键。
 * @returns {object} 不含 private helper 或 handler 的冻结结果。
 */
function runFixedDemoOwnershipTest(testKey) {
  if (arguments.length === 0) {
    const error = new Error('Demo ownership harness 缺少固定测试场景参数。');
    error.code = 'DEMO_OWNERSHIP_FIXED_TEST_ARGUMENT_MISSING';
    throw error;
  }
  if (arguments.length !== 1) {
    const error = new Error('Demo ownership harness 只接受一个固定测试场景参数。');
    error.code = 'DEMO_OWNERSHIP_FIXED_TEST_ARGUMENT_EXTRA';
    throw error;
  }
  if (typeof testKey !== 'string') {
    const error = new Error('Demo ownership harness 固定测试场景参数必须是字符串。');
    error.code = 'DEMO_OWNERSHIP_FIXED_TEST_ARGUMENT_TYPE_INVALID';
    throw error;
  }
  if (!FIXED_DEMO_OWNERSHIP_TEST_KEYS.has(testKey)) {
    const error = new Error('Demo ownership harness 不识别该固定测试场景。');
    error.code = 'DEMO_OWNERSHIP_FIXED_TEST_UNKNOWN';
    throw error;
  }
  const child = spawnSync(process.execPath, [FIXED_SERVICE_TEST_PROCESS_PATH, testKey], {
    cwd: path.resolve(__dirname, '..', '..', '..', '..'),
    env: createFixedChildEnvironment(),
    stdio: 'inherit',
    windowsHide: true
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const error = new Error(`Demo ownership 固定隔离测试失败：${testKey}`);
    error.code = 'DEMO_OWNERSHIP_FIXED_TEST_FAILED';
    error.details = Object.freeze({
      signal: child.signal || null,
      status: child.status
    });
    throw error;
  }
  return Object.freeze({
    delegated: true,
    isolated: true,
    status: 'passed',
    testKey
  });
}

/**
 * 确认 post-action service 真实依赖同一 CommonJS pure module record。
 * @returns {object} 仅包含固定布尔断言结果的冻结对象。
 */
function assertFixedDemoPostActionProductionWiring() {
  const currentServiceRecord = require.cache[DEMO_POST_ACTION_SERVICE_PATH];
  const currentCanonicalServiceRecord =
    require.cache[DEMO_POST_ACTION_CANONICAL_SERVICE_PATH];
  const currentPrimitivesRecord = require.cache[DEMO_POST_ACTION_PRIMITIVES_PATH];
  const valid = capturedPostActionServiceRecord
    && capturedPostActionCanonicalServiceRecord
    && capturedPostActionPrimitivesRecord
    && currentServiceRecord === capturedPostActionServiceRecord
    && currentCanonicalServiceRecord === capturedPostActionCanonicalServiceRecord
    && currentPrimitivesRecord === capturedPostActionPrimitivesRecord
    && currentServiceRecord.loaded === true
    && currentCanonicalServiceRecord.loaded === true
    && currentPrimitivesRecord.loaded === true
    && currentServiceRecord.exports === capturedPostActionServiceExports
    && currentCanonicalServiceRecord.exports === capturedPostActionCanonicalServiceExports
    && currentPrimitivesRecord.exports === capturedPostActionPrimitivesExports
    && currentServiceRecord.children.includes(currentCanonicalServiceRecord)
    && currentCanonicalServiceRecord.children.includes(currentPrimitivesRecord)
    && Object.isFrozen(currentPrimitivesRecord.exports) === true;
  if (!valid) {
    const error = new Error('demoPostActionService production CommonJS wiring identity 无效。');
    error.code = 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID';
    throw error;
  }
  return Object.freeze({
    commonJsIdentity: true,
    primitivesFrozen: true,
    serviceLoaded: true
  });
}

module.exports = Object.freeze({
  assertFixedDemoPostActionProductionWiring,
  fixedIsolatedChild: false,
  runFixedDemoOwnershipTest
});
