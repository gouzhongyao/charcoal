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
    pagePermissionMarker: 'ENERGY_ANALYSIS_PERMISSIONS.view',
    strictUtcInputCount: 2,
    strictUtcFields: ['configForm.effectiveStartUtc', 'configForm.effectiveEndUtc'],
    timeOfDayFields: ['configForm.startMinute', 'configForm.endMinute'],
    monthFields: ['draftFilters.startMonth', 'draftFilters.endMonth'],
    wallClockDateTimeFields: ['draftFilters.startUtc', 'draftFilters.endUtc'],
    ianaTimeZoneFields: ['draftFilters.sourceTimeZone', 'configForm.sourceTimeZone'],
    safeConfigurationHydration: true,
    autoLoadsAnalysis: true,
    separatedMonthlyTimeseriesFacts: true
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
    pagePermissionMarker: 'ENERGY_BENCHMARK_PERMISSIONS.view',
    ianaTimeZoneFields: ['definitionForm.sourceTimeZone', 'internalForm.definition.sourceTimeZone']
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
    pagePermissionMarker: "hasPermi('energy:flows:view')",
    strictUtcInputCount: 4,
    strictUtcFields: ['analysisFilters.startUtc', 'analysisFilters.endUtc', 'modelForm.effectiveStartUtc', 'modelForm.effectiveEndUtc'],
    ianaTimeZoneFields: ['modelForm.sourceTimeZone', 'edgeForm.sourceTimeZone']
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
    pagePermissionMarker: 'ENERGY_BALANCE_PERMISSIONS.view',
    strictUtcInputCount: 2,
    strictUtcFields: ['boundaryForm.effectiveStartUtc', 'boundaryForm.effectiveEndUtc'],
    ianaTimeZoneFields: ['boundaryForm.sourceTimeZone']
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
assert.ok(routerSource.includes('const component = componentMap[routeContract.componentKey] || MigrationPlaceholder;'), '未知组件必须继续回退到正式不可用提示页。');
assert.ok(routerSource.includes('unavailable: component === MigrationPlaceholder'), '未知动态组件必须标识为正式不可用状态。');
assert.equal(routerSource.includes('migration: component === MigrationPlaceholder'), false, '动态路由不得继续暴露迁移占位状态。');

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
  if (contract.strictUtcInputCount) {
    assert.ok(pageSource.includes("import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';"), `${contract.component} 必须引入共享严格 UTC 输入组件。`);
    assert.equal((pageSource.match(/<StrictUtcDateTimeInput\b/g) || []).length, contract.strictUtcInputCount, `${contract.component} 严格 UTC 组件数量不一致。`);
    for (const fieldName of contract.strictUtcFields) {
      assert.ok(pageSource.includes(`v-model="${fieldName}"`), `${contract.component} 必须保持严格 UTC 字段 ${fieldName}。`);
    }
  }
  if (contract.timeOfDayFields) {
    assert.ok(pageSource.includes("import TimeOfDayInput from '@/components/TimeOfDayInput.vue';"), `${contract.component} 必须引入共享日内时间输入组件。`);
    assert.equal((pageSource.match(/<TimeOfDayInput\b/g) || []).length, contract.timeOfDayFields.length, `${contract.component} 日内时间组件数量不一致。`);
    for (const fieldName of contract.timeOfDayFields) {
      assert.ok(pageSource.includes(`v-model="${fieldName}"`), `${contract.component} 必须保持分钟模型字段 ${fieldName}。`);
    }
  }
  if (contract.ianaTimeZoneFields) {
    assert.ok(pageSource.includes("import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';"), `${contract.component} 必须引入共享 IANA 时区选择组件。`);
    assert.equal((pageSource.match(/<IanaTimeZoneSelect\b/g) || []).length, contract.ianaTimeZoneFields.length, `${contract.component} 可编辑来源时区组件数量不一致。`);
    for (const fieldName of contract.ianaTimeZoneFields) {
      assert.ok(pageSource.includes(`<IanaTimeZoneSelect v-model="${fieldName}"`), `${contract.component} 必须保持来源时区字段 ${fieldName}。`);
      assert.equal(new RegExp(`<el-input[^>]+v-model(?:\\.trim)?="${escapeRegExp(fieldName)}"`).test(pageSource), false, `${contract.component} 来源时区字段 ${fieldName} 不得继续使用普通输入框。`);
    }
  }
  if (contract.safeConfigurationHydration) {
    assert.ok(pageSource.includes(':confirm-disabled="configFormHydrationBlocked"'), `${contract.component} 回显失败时必须禁用配置保存。`);
    assert.match(pageSource, /try \{\s*Object\.assign\(configForm, createEnergyAnalysisConfigForm\(kind, source\)\);\s*\} catch \(error\) \{[\s\S]*?configFormHydrationBlocked\.value = true;[\s\S]*?configFormError\.value = `配置回显失败：\$\{error\.message\}`;[\s\S]*?\}\s*configDrawerOpen\.value = true;/, `${contract.component} 必须捕获配置回显异常、展示可见错误并安全打开抽屉。`);
    assert.match(pageSource, /async function saveConfig\(\) \{ if \(configFormHydrationBlocked\.value\) \{[\s\S]*?return; \}/, `${contract.component} 回显失败后不得继续构造或提交 payload。`);
  }
  if (contract.autoLoadsAnalysis) {
    assert.match(pageSource, /const defaultFilters = createDefaultEnergyAnalysisFilters\(\);[\s\S]*?const draftFilters = ref\(\{ \.\.\.defaultFilters \}\);[\s\S]*?const appliedFilters = ref\(createEnergyAnalysisSnapshot\(defaultFilters\)\);/, `${contract.component} 初始化默认筛选只能生成一次。`);
    assert.match(pageSource, /onMounted\(async \(\) => \{ if \(!canView\.value\) return; await Promise\.all\(\[loadMasterData\(\), loadConfigurations\(\), loadAnalysis\(\)\]\); \}\);/, `${contract.component} 首次挂载必须并行加载主数据、配置和分析。`);
  }
  if (contract.separatedMonthlyTimeseriesFacts) {
    assert.match(pageSource, /label="月度累计消费"[\s\S]*?selectedMonthlyFacetData\?\.totals\?\.value/, `${contract.component} 月度累计 KPI 必须读取月度分面 totals。`);
    assert.ok(pageSource.includes('label="时序窗口总能耗"'), `${contract.component} 时序总能耗必须使用分域标签。`);
    assert.ok(pageSource.includes('普通能耗导入只进入月度分析'), `${contract.component} 必须说明普通月度事实边界。`);
    assert.match(pageSource, /未写入(?:可分析事实|\$\{definition\.resultNoun\})/, `${contract.component} execute 零写入不得宣称成功。`);
    assert.ok(pageSource.includes('validateEnergyAnalysisLoadCurveGrid(filters)'), `${contract.component} 必须在请求前校验固定 UTC 曲线网格。`);
  }
  if (contract.monthFields) {
    for (const fieldName of contract.monthFields) {
      assert.match(
        pageSource,
        new RegExp(`<el-date-picker(?=[^>]*v-model="${escapeRegExp(fieldName)}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`),
        `${contract.component} 月份字段 ${fieldName} 必须使用可编辑的 YYYY-MM 月份控件。`
      );
    }
  }
  if (contract.component === 'energy/analysis/index') {
    assert.match(utilitySource, /const sourceTimeZone = requiredConfigurationText\(form\.sourceTimeZone, '来源时区'\);\s*if \(!isIanaTimeZone\(sourceTimeZone\)\) throw new Error\('请选择当前运行时可识别的 IANA 来源时区。'\);[\s\S]*?sourceTimeZone,/, '能源分析配置载荷必须在 API 前执行运行时 IANA 校验。');
    assert.equal((utilitySource.match(/key: '(?:timeseries|shift-schedules|device-states|shift-definitions|tou-schemes|strategy-rules)'/g) || []).length, 6, '能源分析页必须声明六类真实受控导入。');
    assert.ok(utilitySource.includes("configurationImportPreview: 'energy:analysis:config:import:preview'"), '配置导入预演必须使用统一细分权限。');
    assert.ok(utilitySource.includes("configurationImportExecute: 'energy:analysis:config:import:execute'"), '配置导入执行必须使用统一细分权限。');
    assert.ok(utilitySource.includes("key: 'tou-schemes', label: 'TOU 方案与时段', accept: '.xlsx'"), 'TOU 导入必须只接受 XLSX。');
    assert.equal(utilitySource.includes("accept: '.xlsx,.xls,.csv'"), false, '新式能源分析导入不得继续接受 XLS。');
    assert.ok(pageSource.includes(':accept="definition.accept"'), '上传控件必须按导入定义应用 accept。');
    assert.ok(pageSource.includes('downloadEnergyAnalysisImportTemplate(definition.templateType'), '页面必须提供服务端空白模板下载。');
    assert.doesNotMatch(pageSource, /downloadEnergyAnalysisDemoArtifact|downloadImportDemo|天坤集团示例/, '业务页面不得继续分散提供演示下载入口。');
    assert.ok(pageSource.includes('await refreshImportedConfiguration(definition.refreshTarget)'), '配置 execute 成功后必须刷新对应配置列表。');
    assert.ok(apiSource.includes("import { download, query, request } from '@/api/http';"), '模板和受控导入必须复用共享 HTTP。');
    assert.ok(apiSource.includes('/templates/demo-park/${encodeURIComponent(artifactKey)}.${safeExtension}'), '集中演示下载仍保留受权限保护的 API 合同。');
    assert.doesNotMatch(apiSource, /axios|Axios/, '能源分析 API 不得新建 Axios 实例。');
  }
  if (contract.wallClockDateTimeFields) {
    for (const fieldName of contract.wallClockDateTimeFields) {
      assert.match(
        pageSource,
        new RegExp(`<el-date-picker(?=[^>]*v-model="${escapeRegExp(fieldName)}")(?=[^>]*type="datetime")(?=[^>]*value-format="YYYY-MM-DDTHH:mm")(?=[^>]*format="YYYY-MM-DD HH:mm")(?=[^>]*:editable="true")[^>]*>`),
        `${contract.component} 来源时区墙钟字段 ${fieldName} 必须继续使用可输入 datetime 选择器。`
      );
    }
    assert.ok(utilitySource.includes('toUtcIso(filters.startUtc, filters.sourceTimeZone)'), `${contract.component} 开始墙钟时间必须按来源时区转换。`);
    assert.ok(utilitySource.includes('toUtcIso(filters.endUtc, filters.sourceTimeZone)'), `${contract.component} 结束墙钟时间必须按来源时区转换。`);
  }
}

console.log('energyAnalysisPagesContract.test.mjs passed');
