import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 中央契约依赖文件读取模块。
const routerUrl = new URL('../router/index.js', import.meta.url);
const databaseUrl = new URL('../../../server/src/db/database.js', import.meta.url);
const httpUrl = new URL('../api/http.js', import.meta.url);
const apiBaseUrl = new URL('../utils/apiBase.js', import.meta.url);

// 四个正式页面的动态路由、菜单、权限和 API 契约模块。
const pageContracts = Object.freeze([
  {
    importName: 'EnergyAnalysis',
    pagePath: '../views/energy/analysis/index.vue',
    apiPath: '../api/energyAnalysis.js',
    utilityPath: '../utils/energyAnalysis.js',
    routePath: '/energy/analysis',
    component: 'energy/analysis/index',
    permission: 'energy:analysis:view',
    apiRoot: "const ANALYSIS_ROOT = '/energy-analysis';",
    pagePermissionMarker: 'ENERGY_ANALYSIS_PERMISSIONS.view'
  },
  {
    importName: 'EnergyBenchmarks',
    pagePath: '../views/energy/benchmarks/index.vue',
    apiPath: '../api/energyBenchmarks.js',
    utilityPath: '../utils/energyBenchmarkManagement.js',
    routePath: '/energy/benchmarks',
    component: 'energy/benchmarks/index',
    permission: 'energy:benchmarks:view',
    apiRoot: "const ENERGY_BENCHMARK_BASE_URL = '/energy-benchmarks';",
    pagePermissionMarker: 'ENERGY_BENCHMARK_PERMISSIONS.view'
  },
  {
    importName: 'EnergyFlows',
    pagePath: '../views/energy/flows/index.vue',
    apiPath: '../api/energyFlows.js',
    utilityPath: '../utils/energyFlow.js',
    routePath: '/energy/flows',
    component: 'energy/flows/index',
    permission: 'energy:flows:view',
    apiRoot: "const ENERGY_FLOW_BASE_URL = '/energy-flows';",
    pagePermissionMarker: "hasPermi('energy:flows:view')"
  },
  {
    importName: 'EnergyBalances',
    pagePath: '../views/energy/balances/index.vue',
    apiPath: '../api/energyBalances.js',
    utilityPath: '../utils/energyBalanceManagement.js',
    routePath: '/energy/balances',
    component: 'energy/balances/index',
    permission: 'energy:balance:view',
    apiRoot: "const BASE_URL = '/energy-balances';",
    pagePermissionMarker: 'ENERGY_BALANCE_PERMISSIONS.view'
  }
]);

/** 转义待写入正则表达式的固定契约文本。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 共享 Router、后端菜单和 API Base 源码读取模块。
const [routerSource, databaseSource, httpSource, apiBaseSource] = await Promise.all([
  readFile(routerUrl, 'utf8'),
  readFile(databaseUrl, 'utf8'),
  readFile(httpUrl, 'utf8'),
  readFile(apiBaseUrl, 'utf8')
]);

// 动态组件白名单必须精确接入四个正式页面，并保留未知组件安全回退。
for (const contract of pageContracts) {
  assert.ok(
    routerSource.includes(`import ${contract.importName} from '@/views/${contract.pagePath.replace('../views/', '')}';`),
    `${contract.component} 应导入正式页面组件。`
  );
  assert.ok(
    routerSource.includes(`'${contract.component}': ${contract.importName}`),
    `componentMap 应登记 ${contract.component}。`
  );
}
assert.ok(routerSource.includes('const component = componentMap[menu.component] || MigrationPlaceholder;'), '未知组件必须继续回退到 MigrationPlaceholder。');
assert.ok(routerSource.includes('migration: component === MigrationPlaceholder'), '动态路由必须继续标识迁移占位状态。');

// 后端菜单种子的路径、组件标识和查看权限必须与前端契约一致。
for (const contract of pageContracts) {
  const menuSeedPattern = new RegExp(
    `\\[\\s*'menu'\\s*,\\s*'[^']+'\\s*,\\s*'${escapeRegExp(contract.routePath)}'\\s*,\\s*'${escapeRegExp(contract.component)}'\\s*,\\s*'${escapeRegExp(contract.permission)}'`
  );
  assert.match(databaseSource, menuSeedPattern, `${contract.component} 的菜单种子路径、组件标识或查看权限不一致。`);
}

// 共享 HTTP 层统一使用受信任的 /api Base，领域 API 只声明相对根路径。
assert.ok(apiBaseSource.includes("const FALLBACK = '/api';"), '共享 API Base 必须以 /api 为默认前缀。');
assert.ok(httpSource.includes('const baseURL = normalizeApiBase(requestedBase);'), 'HTTP 层必须规范化 API Base。');
assert.ok(httpSource.includes('config.baseURL = baseURL;'), 'HTTP 请求必须统一应用受信任 API Base。');

// 页面、领域 API、权限映射和禁止演示数据契约模块。
for (const contract of pageContracts) {
  const [pageSource, apiSource, utilitySource] = await Promise.all([
    readFile(new URL(contract.pagePath, import.meta.url), 'utf8'),
    readFile(new URL(contract.apiPath, import.meta.url), 'utf8'),
    readFile(new URL(contract.utilityPath, import.meta.url), 'utf8')
  ]);
  assert.ok(pageSource.trim().length > 0, `${contract.component} 页面源文件必须存在且非空。`);
  assert.ok(apiSource.includes("from '@/api/http'"), `${contract.component} API 必须复用共享 HTTP 层。`);
  assert.ok(apiSource.includes(contract.apiRoot), `${contract.component} API 根路径不一致。`);
  assert.doesNotMatch(apiSource, /['"`]\/api(?:\/|['"`])/, `${contract.component} API 不得重复硬编码 /api 前缀。`);
  assert.ok(pageSource.includes(contract.pagePermissionMarker), `${contract.component} 页面缺少查看权限检查。`);
  assert.ok((pageSource + utilitySource).includes(contract.permission), `${contract.component} 缺少关键查看权限 ${contract.permission}。`);
  assert.doesNotMatch(
    pageSource,
    /MigrationPlaceholder|Math\.random|\b(?:mockData|demoData|fakeData)\b|演示数据|随机数据|模拟数据/i,
    `${contract.component} 页面不得包含迁移占位、演示数据或随机数据。`
  );
}

console.log('energyAnalysisPagesContract.test.mjs passed');
