import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读取驾驶舱相关静态源码契约。 */
const dashboardSource = readFileSync(new URL('../views/dashboard/Dashboard.vue', import.meta.url), 'utf8');
/** 读取驾驶舱 API 静态源码契约。 */
const dashboardApiSource = readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
/** 读取驾驶舱纯逻辑静态源码契约。 */
const dashboardUtilitySource = readFileSync(new URL('../utils/dashboardCockpit.js', import.meta.url), 'utf8');
/** 读取应用状态静态源码契约。 */
const appStoreSource = readFileSync(new URL('../stores/app.js', import.meta.url), 'utf8');
/** 读取默认布局静态源码契约。 */
const layoutSource = readFileSync(new URL('../layouts/DefaultLayout.vue', import.meta.url), 'utf8');
/** 读取能源趋势图静态源码契约。 */
const trendChartSource = readFileSync(new URL('../views/dashboard/EnergyTrendChart.vue', import.meta.url), 'utf8');
/** 读取同单位结构图静态源码契约。 */
const barChartSource = readFileSync(new URL('../views/dashboard/UnitBarChart.vue', import.meta.url), 'utf8');
/** 读取局部面板静态源码契约。 */
const panelSource = readFileSync(new URL('../views/dashboard/CockpitPanel.vue', import.meta.url), 'utf8');

// 用户可见标题统一为“驾驶舱”，内部路由契约不在页面重命名。
assert.match(dashboardSource, /<h1>驾驶舱<\/h1>/);
assert.match(dashboardSource, /dashboard:view/);
assert.doesNotMatch(dashboardSource, /title="工作台"/);

// 年度筛选必须使用标准化月份范围，并通过请求版本阻止旧年度响应覆盖。
assert.match(dashboardSource, /const selectedYear = ref\(currentYear\)/);
assert.match(dashboardSource, /buildDashboardYearRange\(selectedYear\.value/);
assert.match(dashboardSource, /normalizedMonthStart: selectedRange\.value\.normalizedMonthStart/);
assert.match(dashboardSource, /normalizedMonthEnd: selectedRange\.value\.normalizedMonthEnd/);
assert.match(dashboardSource, /isLatestDashboardRequest\(version, requestVersion\.value\)/);
assert.match(dashboardApiSource, /getDashboardSummary = \(params = \{\}\) => get\('\/dashboard\/summary', params\)/);

// 各领域必须使用既有真实 API，并在请求前检查对应领域权限。
assert.match(dashboardSource, /getCarbonEmissionStats/);
assert.match(dashboardSource, /getEnergyBudgetExecutionComparison/);
assert.match(dashboardSource, /ledgerApi\.meters\.stats\(\)/);
assert.match(dashboardSource, /energy:records:view/);
assert.match(dashboardSource, /carbon:emissions:view/);
assert.match(dashboardSource, /energy:budget:view/);
assert.match(dashboardSource, /ledger:meters:view/);
assert.match(dashboardSource, /hasPermi\('imports:view'\)/);
assert.doesNotMatch(dashboardSource, /'import:view'/);
assert.match(dashboardSource, /resolveDashboardSummaryDomainState\(summary\.energy\)/);
assert.match(dashboardSource, /resolveDashboardSummaryDomainState\(summary\.imports\)/);
assert.match(dashboardSource, /resolveDashboardSummaryDomainState\(summary\.errors\)/);
assert.match(dashboardSource, /forbidPanel\(energyPanel\)/);
assert.match(dashboardSource, /forbidPanel\(importPanel\)/);
assert.match(dashboardSource, /aria-label="授权领域快捷入口"/);
assert.match(dashboardSource, /goToModule\(item\.path\)/);

// 能源趋势禁止继续使用跨单位 aggregateMonthlyTrend，并使用既有能源颜色。
assert.doesNotMatch(dashboardSource, /aggregateMonthlyTrend/);
assert.match(dashboardSource, /ENERGY_TYPE_COLORS/);
assert.match(dashboardSource, /selectedEnergySeriesKey/);
assert.match(dashboardSource, /energyTypeCode \+ normalizedUnit|energyTypeCode \+.*normalizedUnit/);

// 面板必须明确完整局部状态、独立重试和真实空结果零值。
for (const status of ['loading', 'success', 'empty', 'forbidden', 'error']) assert.match(panelSource, new RegExp(status));
assert.match(panelSource, /重试此面板/);
assert.match(panelSource, /cockpit-panel__zero/);
assert.match(dashboardSource, /@retry="retryEnergyPanel"/);
assert.match(dashboardSource, /@retry="retryCarbonPanel"/);
assert.match(dashboardSource, /@retry="retryBudgetPanel"/);

// 计量器具、导入累计摘要和碳资产边界必须准确，不得宣称实时遥测、最近批次明细或伪零资产。
assert.match(dashboardSource, /当前快照来自本地计量器具台账，不是实时遥测/);
assert.match(dashboardSource, /title="导入累计摘要"/);
assert.match(dashboardSource, /全历史导入累计摘要/);
assert.match(dashboardSource, /最新活动时间/);
assert.doesNotMatch(dashboardSource, /最近批次活动|title="导入质量快照"/);
assert.match(dashboardSource, /failedRowCount/);
assert.match(dashboardSource, /skippedRowCount/);
assert.match(dashboardSource, /因子缺失，无法形成排放总量/);
assert.match(dashboardSource, /另有 \{\{ formatInteger\(carbonProjection\.missingFactorCount\) \}\} 条记录因子缺失/);
assert.match(dashboardSource, /selectedCarbonUnit\.value\)\?\.totalValue \?\? null/);
assert.match(dashboardSource, /尚未接入/);
assert.match(dashboardSource, /不显示伪零资产/);

// 碳排趋势必须消费 stats.byMonth，按 emissionUnit 隔离，并在全缺失时进入缺口空态。
assert.match(dashboardSource, /selectedCarbonSeries/);
assert.match(dashboardSource, /CARBON_TREND_COLOR/);
assert.match(dashboardSource, /projectCarbonDashboardStats\(stats\)/);
assert.match(dashboardUtilitySource, /buildCarbonTrendSeries\(stats\?\.byMonth \|\| \[\]\)/);
assert.match(dashboardUtilitySource, /hasOnlyMissingFactors/);
assert.match(dashboardUtilitySource, /calculatedCount === 0 && missingFactorCount > 0/);

// 预算必须单列单位不一致并显示预算、实际各自单位，不得为不可比较行计算使用率。
assert.match(dashboardUtilitySource, /comparisonStatus === 'unit_mismatch'/);
assert.match(dashboardUtilitySource, /unitMismatch/);
assert.match(dashboardSource, /单位不一致 \/ 不可比较/);
assert.match(dashboardSource, /row\.budgetUnit \|\| row\.unit/);
assert.match(dashboardSource, /row\.actualUnit \|\| '—'/);
assert.match(dashboardSource, /row\.isComparable === false/);
assert.match(dashboardSource, /dashboardWarningLevel === 'unit_mismatch'/);

// 图表必须提供 tooltip、键盘焦点、图例、ARIA 和等价数据表，聚焦标记不得伪装成操作按钮。
for (const source of [trendChartSource, barChartSource]) {
  assert.match(source, /role="img"/);
  assert.match(source, /tabindex="0"/);
  assert.match(source, /role="status"/);
  assert.match(source, /legend|图例/);
  assert.match(source, /等价数据表/);
  assert.match(source, /<table>/);
  assert.doesNotMatch(source, /role="button"|<button/);
}
assert.match(trendChartSource, /point-focus-ring/);
assert.match(barChartSource, /role="group"/);

// 普通模式必须使用平台浅色变量，科技风、网格背景和 Element Plus 深色覆盖只能由 is-immersive 启用。
assert.match(dashboardSource, /:class="\{ 'is-immersive': appStore\.immersiveMode \}"/);
assert.match(dashboardSource, /:data-display-mode="appStore\.immersiveMode \? 'immersive' : 'standard'"/);
assert.match(dashboardSource, /\.cockpit-root\{--cockpit-surface:#fff;/);
assert.match(dashboardSource, /--cockpit-heading:#123b79/);
assert.match(dashboardSource, /\.cockpit-root\.is-immersive\{[^}]*background-color:#020b18/);
assert.match(dashboardSource, /\.cockpit-root\.is-immersive :deep\(\.el-button\)/);
assert.match(dashboardSource, /\.cockpit-root\.is-immersive :deep\(\.el-select__wrapper\)/);
assert.doesNotMatch(dashboardSource, /\.cockpit-root :deep\(\.el-button\)/);
assert.doesNotMatch(dashboardSource, /\.cockpit-root :deep\(\.el-select__wrapper\)/);
assert.match(panelSource, /background:var\(--cockpit-surface,#fff\)/);
assert.match(trendChartSource, /background:var\(--cockpit-chart-bg,#fcfcfb\)/);
assert.match(barChartSource, /background:var\(--cockpit-track,#e7f1ff\)/);
assert.doesNotMatch(panelSource, /background:linear-gradient\(145deg,rgba\(8,30,58/);

// 沉浸模式必须非持久化，布局隐藏导航但保持 sidebarCollapsed 独立。
assert.match(appStoreSource, /sidebarCollapsed: false/);
assert.match(appStoreSource, /immersiveMode: false/);
assert.match(appStoreSource, /setImmersiveMode/);
assert.doesNotMatch(appStoreSource, /localStorage\.setItem\([^\n]*immersive/);
assert.match(layoutSource, /<Sidebar v-if="!appStore\.immersiveMode"/);
assert.match(layoutSource, /<Navbar v-if="!appStore\.immersiveMode"/);
assert.match(layoutSource, /shell-content--immersive/);
assert.match(dashboardSource, /requestFullscreen/);
assert.match(dashboardSource, /fullscreenchange/);
assert.match(dashboardSource, /event\.key !== 'Escape'/);
assert.match(dashboardSource, /onBeforeRouteLeave/);
assert.match(dashboardSource, /onBeforeUnmount/);
assert.match(dashboardSource, /已保留沉浸模式/);

console.log('dashboardCockpitContract.test.mjs passed');
