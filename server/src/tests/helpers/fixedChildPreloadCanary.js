'use strict';

const path = require('path');

// 该 fixture 只检测 NODE_OPTIONS 是否越过物理 helper 注入固定执行器。
const FIXED_SERVICE_TEST_PROCESS_PATH = path.resolve(
  __dirname,
  'fixedServiceTestProcess.js'
);
const currentMainPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;

if (currentMainPath === FIXED_SERVICE_TEST_PROCESS_PATH) {
  const error = new Error('固定隔离子进程不得继承 Node 预加载注入。');
  error.code = 'FIXED_SERVICE_TEST_PRELOAD_INJECTION_DETECTED';
  throw error;
}

module.exports = Object.freeze({
  preloadCanary: true
});
