import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateMonthlyTrend, buildEnergyFilters, buildMonthlyTrendAxisTicks, ENERGY_TYPE_COLORS, fixedEnergyTypeBreakdown } from '../utils/energyStatistics.js';
import { hasPermission } from '../utils/permissionCore.js';

// 能耗统计筛选契约：用能单元编码按精确参数透传，并忽略旧 organization 参数。
const filters = buildEnergyFilters({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '', energyTypeCode: 'coal', organizationUnitCode: 'QL-ACTUAL-PARK', organization: '旧组织参数', keyword: '仪表 Alpha', search: '兼容搜索字段' });
assert.deepEqual(filters, { normalizedMonthStart: '2026-01', energyTypeCode: 'coal', organizationUnitCode: 'QL-ACTUAL-PARK', keyword: '仪表 Alpha', search: '兼容搜索字段' });
assert.deepEqual(buildEnergyFilters({ organization: 'QL-PARK' }), {}, '旧 organization 参数不得继续发送。');

assert.deepEqual(aggregateMonthlyTrend([
  { month: '2026-02', totalNormalizedValue: 5, recordCount: 1 },
  { month: '2026-01', totalNormalizedValue: 2, recordCount: 1 },
  { month: '2026-02', totalNormalizedValue: 3, recordCount: 2 }
]), [
  { month: '2026-01', totalNormalizedValue: 2, recordCount: 1 },
  { month: '2026-02', totalNormalizedValue: 8, recordCount: 3 }
]);

const trendRows = Array.from({ length: 24 }, (_, index) => {
  const year = 2024 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { month: `${year}-${String(month).padStart(2, '0')}` };
});
assert.deepEqual(buildMonthlyTrendAxisTicks(trendRows).map((tick) => tick.index), [0, 3, 7, 10, 13, 16, 20, 23]);
assert.deepEqual(buildMonthlyTrendAxisTicks(trendRows).map((tick) => tick.monthLabel), ['01月', '04月', '08月', '11月', '02月', '05月', '09月', '12月']);
assert.deepEqual(buildMonthlyTrendAxisTicks(trendRows).map((tick) => tick.yearLabel), ['2024', '', '', '', '2025', '', '', '']);
assert.deepEqual(buildMonthlyTrendAxisTicks(trendRows.slice(0, 2), 8).map((tick) => tick.index), [0, 1]);
assert.deepEqual(buildMonthlyTrendAxisTicks(), []);

const breakdown = fixedEnergyTypeBreakdown([
  { energyTypeCode: 'oil', energyTypeName: '油', totalNormalizedValue: 4, recordCount: 1 },
  { energyTypeCode: 'electricity', energyTypeName: '电力', totalNormalizedValue: 8, recordCount: 2 },
  { energyTypeCode: 'biomass', energyTypeName: '生物质', totalNormalizedValue: 3, recordCount: 1 },
  { energyTypeCode: 'hydrogen', energyTypeName: '氢气', totalNormalizedValue: 2, recordCount: 1 }
]);
assert.deepEqual(breakdown.map((row) => row.energyTypeCode), ['electricity', 'oil', 'other']);
assert.equal(breakdown.at(-1).totalNormalizedValue, 5);
assert.equal(Object.keys(ENERGY_TYPE_COLORS).length, 9);

assert.equal(hasPermission('energy:records:ledger-backfill:execute', [], { roleCode: 'super_admin' }), true);
assert.equal(hasPermission('energy:records:export', [], { roles: [{ roleCode: 'super_admin' }] }), true);
assert.equal(hasPermission(['energy:records:view', 'energy-records:view'], ['energy-records:view'], { roleCode: 'user' }), true);
assert.equal(hasPermission(['energy:records:export', 'energy-records:export'], ['energy-records:export'], { roleCode: 'user' }), true);
assert.equal(hasPermission('energy:records:ledger-backfill:execute', ['energy:records:view'], { roleCode: 'user' }), false);

// 能耗统计月份筛选契约：保持 YYYY-MM 字符串 model，并同时支持下拉和键盘输入。
const statisticsPageSource = readFileSync(new URL('../views/energy/EnergyStatistics.vue', import.meta.url), 'utf8');
for (const fieldName of ['draftFilters.normalizedMonthStart', 'draftFilters.normalizedMonthEnd']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(
    statisticsPageSource,
    new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`),
    `${fieldName} 必须使用可编辑的 YYYY-MM 月份控件。`
  );
}

// 能耗统计用能单元筛选契约：页面字段、文案与请求字段必须使用精确编码语义。
assert.match(statisticsPageSource, /label="用能单元编码（精确）"/, '筛选文案必须明确用能单元编码精确匹配。');
assert.match(statisticsPageSource, /v-model\.trim="draftFilters\.organizationUnitCode"/, '筛选输入必须绑定 organizationUnitCode。');
assert.match(statisticsPageSource, /const trendAxisTicks = computed\(\(\) => buildMonthlyTrendAxisTicks\(visibleTrend\.value\)\)/, '趋势图必须使用独立的月份刻度抽样。');
assert.match(statisticsPageSource, /v-for="tick in trendAxisTicks"/, '趋势图横轴必须只渲染抽样后的月份刻度。');
assert.match(statisticsPageSource, /trend-axis-label/, '趋势图横轴必须保留专用布局样式。');
assert.match(statisticsPageSource, /trend-chart-scroll/, '趋势图横轴必须具备局部横向溢出容器。');
assert.doesNotMatch(statisticsPageSource, /v-for="\(row, index\) in visibleTrend"[^>]*y="244"/, '趋势图不得为每个数据点渲染拥挤的月份标签。');
assert.doesNotMatch(statisticsPageSource, /draftFilters\.organization\b/, '页面不得继续使用旧 organization 筛选字段。');
assert.doesNotMatch(statisticsPageSource, /精确组织名称|组织名称|后代/, '筛选文案不得误写为组织名称或后代范围。');

// 能耗统计维度契约：页面必须发送后端 canonical dimension 值，禁止回退旧枚举。
assert.match(statisticsPageSource, /const dimension = ref\('organizationUnit'\)/, '默认维度必须使用 organizationUnit。');
assert.match(
  statisticsPageSource,
  /<el-radio-button\b(?=[^>]*\blabel\s*=\s*["']organizationUnit["'])[^>]*>\s*用能单元\s*<\/el-radio-button\s*>/,
  '用能单元选项必须使用 organizationUnit。'
);
assert.match(
  statisticsPageSource,
  /<el-radio-button\b(?=[^>]*\blabel\s*=\s*["']meterDevice["'])[^>]*>\s*计量器具\s*<\/el-radio-button\s*>/,
  '计量器具选项必须使用 meterDevice。'
);
// 维度加载方法匹配结果：将请求断言限定在 loadDimension 方法体内。
const loadDimensionMatch = statisticsPageSource.match(/async\s+function\s+loadDimension\s*\(\s*\)\s*\{([\s\S]*?)\}\s*(?=(?:async\s+)?function\s+\w+\s*\()/);
assert.ok(loadDimensionMatch, '页面必须保留 loadDimension 方法。');
// 维度加载方法体：验证 dimension 参数未经条件表达式或旧枚举再次映射。
const loadDimensionSource = loadDimensionMatch[1];
assert.match(
  loadDimensionSource,
  /getDimensionBreakdown\s*\(\s*\{[\s\S]*?\bdimension\s*:\s*dimension\.value\s*(?=[,}])[\s\S]*?\}\s*\)/,
  'loadDimension 必须向 getDimensionBreakdown 直接传入 dimension.value。'
);
assert.doesNotMatch(
  loadDimensionSource,
  /\bdimension\s*:\s*(?:(?![,}]).)*\b(?:organization|department)\b/s,
  'loadDimension 不得将 dimension.value 映射回 organization 或 department。'
);
assert.doesNotMatch(statisticsPageSource, /label="organization"|label="department"|const dimension = ref\('(organization|department)'\)/, '维度值不得回退为 organization 或 department。');

console.log('energyStatistics.test.mjs passed');
