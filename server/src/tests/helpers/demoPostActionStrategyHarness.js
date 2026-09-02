'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../../db/database');

// 策略生命周期测试 harness 只签发自身创建的隔离 SQLite，不改变 production broker/registry。
const SERVICE_MODULE_PATH = require.resolve('../../services/demoPostActionService');
const CANONICAL_SERVICE_MODULE_PATH = require.resolve(
  '../../services/demoPostActionCanonicalService'
);
const REGISTRY_MODULE_PATH = require.resolve('../../services/demoPostActionRegistry');
// WeakSet capability 只接受本模块实际打开的连接，调用方无法用同形 fake/Proxy 冒充。
const ISSUED_TEST_DATABASES = new WeakSet();

/** 将文件系统路径转换为跨 Windows 大小写和分隔符稳定的比较形式。 */
function normalizePathForComparison(filePath) {
  const normalizedPath = path.normalize(filePath);
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

/** 判断目标路径是否位于 canonical 临时根目录内，避免词法前缀误判。 */
function isPathWithinCanonicalRoot(canonicalRoot, canonicalTarget) {
  const relativePath = path.relative(
    normalizePathForComparison(canonicalRoot),
    normalizePathForComparison(canonicalTarget)
  );
  return Boolean(relativePath) && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

/** 读取真实路径；native realpath 能解析 Windows junction、symlink 和路径别名。 */
function readCanonicalRealpath(filePath) {
  const realpathSync = fs.realpathSync.native || fs.realpathSync;
  return realpathSync(filePath);
}

/** 找到目标或最近存在父目录，并把未创建的子路径接回 canonical 父目录。 */
function resolveCanonicalDatabasePath(requestedPath) {
  const absolutePath = path.resolve(requestedPath);
  const missingSegments = [];
  let existingPath = absolutePath;
  while (true) {
    try {
      fs.lstatSync(existingPath);
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        throw new Error('策略生命周期 harness 无法解析 SQLite 路径父目录。');
      }
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
  let canonicalExistingPath;
  try {
    canonicalExistingPath = readCanonicalRealpath(existingPath);
  } catch (error) {
    throw new Error(`策略生命周期 harness 无法解析 SQLite 路径 realpath：${error.message}`);
  }
  const canonicalExistingStat = fs.statSync(canonicalExistingPath);
  if (missingSegments.length > 0 && !canonicalExistingStat.isDirectory()) {
    throw new Error('策略生命周期 harness 的 SQLite 路径父级不是目录。');
  }
  return path.resolve(canonicalExistingPath, ...missingSegments);
}

/** 校验 harness 配置只包含隔离数据库路径和可选初始化回调。 */
function normalizeHarnessOptions(options) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('策略生命周期 harness 只允许 test 环境。');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new TypeError('策略生命周期 harness 必须接收普通配置对象。');
  }
  const unknownFields = Object.keys(options).filter((fieldName) => (
    !['databasePath', 'initializeDatabase'].includes(fieldName)
  ));
  if (unknownFields.length > 0) {
    throw new TypeError(`策略生命周期 harness 配置包含未知字段：${unknownFields.sort().join(', ')}`);
  }
  if (typeof options.databasePath !== 'string' || options.databasePath.trim() === '') {
    throw new TypeError('策略生命周期 harness 必须接收隔离 databasePath。');
  }
  if (options.initializeDatabase !== undefined
    && typeof options.initializeDatabase !== 'function') {
    throw new TypeError('initializeDatabase 必须为函数。');
  }
  const requestedPath = options.databasePath.trim();
  if (requestedPath === ':memory:') {
    return { databasePath: ':memory:', initializeDatabase: options.initializeDatabase || null };
  }
  const temporaryRoot = resolveCanonicalDatabasePath(os.tmpdir());
  const databasePath = resolveCanonicalDatabasePath(requestedPath);
  const targetStat = (() => {
    try {
      return fs.statSync(databasePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (targetStat && targetStat.isDirectory()) {
    throw new Error('策略生命周期 harness 的 SQLite 路径不能是目录。');
  }
  if (!isPathWithinCanonicalRoot(temporaryRoot, databasePath)) {
    throw new Error('策略生命周期 harness 拒绝 realpath 解析后位于临时根目录外的 SQLite 路径。');
  }
  return { databasePath, initializeDatabase: options.initializeDatabase || null };
}

/** 由 harness 自行打开隔离 SQLite；:memory: 保持真实内存语义，不经过 path.resolve。 */
function openIssuedTestDatabase(options) {
  const db = options.databasePath === ':memory:'
    ? new Database(':memory:')
    : openDatabase({ databasePath: options.databasePath });
  if (options.databasePath === ':memory:') db.pragma('foreign_keys = ON');
  ISSUED_TEST_DATABASES.add(db);
  try {
    if (options.initializeDatabase) options.initializeDatabase(db);
    return db;
  } catch (error) {
    ISSUED_TEST_DATABASES.delete(db);
    db.close();
    throw error;
  }
}

/** 校验 lifecycle 闭包仍绑定本 harness 签发且未关闭的连接。 */
function requireIssuedTestDatabase(db, state) {
  if (!ISSUED_TEST_DATABASES.has(db) || state.closed) {
    throw new Error('策略生命周期 harness 的隔离 SQLite 已失效。');
  }
  return db;
}

/** 读取已经正常初始化的 production service，并确认 service/registry cache identity 稳定。 */
function loadProductionService() {
  const serviceCacheEntry = require.cache[SERVICE_MODULE_PATH];
  const canonicalServiceCacheEntry = require.cache[CANONICAL_SERVICE_MODULE_PATH];
  const registryCacheEntry = require.cache[REGISTRY_MODULE_PATH];
  if (!serviceCacheEntry || serviceCacheEntry.loaded !== true
    || !canonicalServiceCacheEntry || canonicalServiceCacheEntry.loaded !== true
    || !registryCacheEntry || registryCacheEntry.loaded !== true) {
    throw new Error('策略生命周期 harness 要求 production service 与 registry 已正常初始化。');
  }
  const service = require(SERVICE_MODULE_PATH);
  if (require.cache[SERVICE_MODULE_PATH] !== serviceCacheEntry
    || require.cache[CANONICAL_SERVICE_MODULE_PATH] !== canonicalServiceCacheEntry
    || require.cache[REGISTRY_MODULE_PATH] !== registryCacheEntry
    || !serviceCacheEntry.children.includes(canonicalServiceCacheEntry)
    || !canonicalServiceCacheEntry.children.includes(registryCacheEntry)
    || service !== serviceCacheEntry.exports
    || service !== canonicalServiceCacheEntry.exports) {
    throw new Error('策略生命周期 harness 检测到 production cache identity 变化。');
  }
  return service;
}

/** 创建固定 strategy preview/execute 测试入口，服务闭包只绑定内部签发连接。 */
function createDemoPostActionStrategyHarness(options) {
  const normalizedOptions = normalizeHarnessOptions(options);
  const db = openIssuedTestDatabase(normalizedOptions);
  const state = { closed: false };
  // harness 只允许执行自身通过 strategy preview 获取的 actionRunId。
  const issuedActionRunIds = new Set();
  let service;
  try {
    service = loadProductionService();
  } catch (error) {
    state.closed = true;
    ISSUED_TEST_DATABASES.delete(db);
    db.close();
    throw error;
  }
  return Object.freeze({
    preview(actionOptions = {}) {
      requireIssuedTestDatabase(db, state);
      const preview = service.previewDemoPostAction({
        ...actionOptions,
        actionKey: 'strategy-evaluation-run',
        db
      });
      issuedActionRunIds.add(String(preview.actionRunId));
      return preview;
    },
    execute(actionOptions = {}) {
      requireIssuedTestDatabase(db, state);
      const actionRunId = String(actionOptions.actionRunId || '').trim();
      if (!issuedActionRunIds.has(actionRunId)) {
        throw new Error('策略生命周期 harness 只接受自身签发的 strategy-evaluation-run。');
      }
      return service.executeDemoPostAction({
        ...actionOptions,
        actionRunId,
        db
      });
    },
    withDatabase(callback) {
      requireIssuedTestDatabase(db, state);
      if (typeof callback !== 'function') throw new TypeError('withDatabase 必须接收函数。');
      return callback(db);
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      issuedActionRunIds.clear();
      ISSUED_TEST_DATABASES.delete(db);
      db.close();
    }
  });
}

module.exports = {
  createDemoPostActionStrategyHarness
};
