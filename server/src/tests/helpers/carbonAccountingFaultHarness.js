'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Carbon 故障测试只允许选择以下固定测试文件；选择值不承载任何生产能力授权。
const FIXED_CARBON_ACCOUNTING_TEST_KEYS = Object.freeze(new Set([
  'carbon-accounting-derived-ownership',
  'carbon-accounting-exact-calculation',
  'carbon-accounting-routes',
  'carbon-calculation-run-service'
]));
// 私有 ALS 捕获与测试控制面只存在于隔离子进程执行器闭包中。
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

/**
 * 在隔离子进程中运行一个固定 Carbon 测试文件，并只返回冻结断言结果。
 * @param {string} testKey 固定测试场景键。
 * @returns {object} 不含服务、hook 或数据库对象的固定结果。
 */
function runFixedCarbonAccountingTest(testKey) {
  if (arguments.length === 0) {
    const error = new Error('Carbon 故障 harness 缺少固定测试场景参数。');
    error.code = 'CARBON_ACCOUNTING_FIXED_TEST_ARGUMENT_MISSING';
    throw error;
  }
  if (arguments.length !== 1) {
    const error = new Error('Carbon 故障 harness 只接受一个固定测试场景参数。');
    error.code = 'CARBON_ACCOUNTING_FIXED_TEST_ARGUMENT_EXTRA';
    throw error;
  }
  if (typeof testKey !== 'string') {
    const error = new Error('Carbon 故障 harness 固定测试场景参数必须是字符串。');
    error.code = 'CARBON_ACCOUNTING_FIXED_TEST_ARGUMENT_TYPE_INVALID';
    throw error;
  }
  if (!FIXED_CARBON_ACCOUNTING_TEST_KEYS.has(testKey)) {
    const error = new Error('Carbon 故障 harness 不识别该固定测试场景。');
    error.code = 'CARBON_ACCOUNTING_FIXED_TEST_UNKNOWN';
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
    const error = new Error(`Carbon 固定隔离测试失败：${testKey}`);
    error.code = 'CARBON_ACCOUNTING_FIXED_TEST_FAILED';
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

module.exports = Object.freeze({
  fixedIsolatedChild: false,
  runFixedCarbonAccountingTest
});
