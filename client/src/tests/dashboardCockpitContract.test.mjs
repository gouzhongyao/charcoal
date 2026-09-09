import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读取驾驶舱唯一控制器静态源码契约。 */
const dashboardSource = readFileSync(new URL('../views/dashboard/Dashboard.vue', import.meta.url), 'utf8');
/** 读取普通驾驶舱独立视图静态源码契约。 */
const standardSource = readFileSync(new URL('../views/dashboard/StandardDashboardView.vue', import.meta.url), 'utf8');
/** 读取沉浸驾驶舱独立视图静态源码契约。 */
const immersiveSource = readFileSync(new URL('../views/dashboard/ImmersiveDashboardView.vue', import.meta.url), 'utf8');
/** 读取单一单位环图静态源码契约。 */
const donutSource = readFileSync(new URL('../views/dashboard/UnitDonutChart.vue', import.meta.url), 'utf8');
/** 读取工业园区场景静态源码契约。 */
const sceneSource = readFileSync(new URL('../views/dashboard/IndustrialParkScene.vue', import.meta.url), 'utf8');
/** 读取驾驶舱 API 静态源码契约。 */
const dashboardApiSource = readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
/** 读取驾驶舱纯逻辑静态源码契约。 */
const dashboardUtilitySource = readFileSync(new URL('../utils/dashboardCockpit.js', import.meta.url), 'utf8');
/** 读取应用状态静态源码契约。 */
const appStoreSource = readFileSync(new URL('../stores/app.js', import.meta.url), 'utf8');
/** 读取默认布局静态源码契约。 */
const layoutSource = readFileSync(new URL('../layouts/DefaultLayout.vue', import.meta.url), 'utf8');
/** 读取全局主题静态源码契约。 */
const themeSource = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
/** 读取能源趋势图静态源码契约。 */
const trendChartSource = readFileSync(new URL('../views/dashboard/EnergyTrendChart.vue', import.meta.url), 'utf8');
/** 读取局部面板静态源码契约。 */
const panelSource = readFileSync(new URL('../views/dashboard/CockpitPanel.vue', import.meta.url), 'utf8');

// 唯一控制器必须条件挂载两套独立 DOM，并保留 dashboard:view 页面准入。
assert.match(dashboardSource, /<ImmersiveDashboardView\s+v-else-if="appStore\.immersiveMode"/);
assert.match(dashboardSource, /<StandardDashboardView\s+v-else/);
assert.doesNotMatch(dashboardSource, /v-show=/);
assert.match(dashboardSource, /dashboard:view/);
/** 唯一控制器模板源码，仅检查用户可见区域，不误伤内部技术注释。 */
const dashboardTemplateSource = dashboardSource.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
/** 标准布局模板源码，仅检查用户可见区域，不误伤内部技术注释。 */
const standardTemplateSource = standardSource.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
/** 沉浸布局模板源码，仅检查用户可见区域，不误伤内部技术注释。 */
const immersiveTemplateSource = immersiveSource.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
assert.match(standardTemplateSource, /<h1>中控<\/h1>/);
assert.match(immersiveTemplateSource, /<h1>中控 · 园区业务大屏<\/h1>/);
assert.match(dashboardTemplateSource, /当前账号没有查看中控的权限。请联系管理员授予 dashboard:view 权限。/);
assert.doesNotMatch(standardTemplateSource, /驾驶舱/);
assert.doesNotMatch(immersiveTemplateSource, /驾驶舱/);
assert.doesNotMatch(dashboardTemplateSource, /查看驾驶舱的权限/);
assert.match(dashboardUtilitySource, /中控摘要缺少明确的领域授权状态。/);
assert.match(dashboardUtilitySource, /中控摘要返回了无法识别的领域状态。/);
assert.match(dashboardUtilitySource, /previousCalendarMonth/);
assert.match(dashboardUtilitySource, /export function buildDashboardBaselineRange/);
assert.match(dashboardUtilitySource, /export function filterDashboardRowsByMonthRange/);
assert.match(dashboardUtilitySource, /export function attachSeriesComparisonRows/);
assert.match(dashboardUtilitySource, /'missing-previous-month'/);
assert.match(dashboardUtilitySource, /export function formatDashboardMeasurement/);
assert.match(dashboardUtilitySource, /export function formatDashboardPercentage/);
assert.match(dashboardUtilitySource, /export function resolveTrendAxisMaximum/);
assert.match(dashboardUtilitySource, /CARBON_MINIMUM_FRACTION_DIGITS/);
assert.doesNotMatch(dashboardUtilitySource, /'驾驶舱摘要缺少明确的领域授权状态。'/);
assert.doesNotMatch(dashboardUtilitySource, /'驾驶舱摘要返回了无法识别的领域状态。'/);

// 控制器必须保留唯一年度、单位、面板、请求版本、API 与领域权限状态。
assert.match(dashboardSource, /const selectedYear = ref\(currentYear\)/);
assert.match(dashboardSource, /const selectedEnergySeriesKey = ref\(''\)/);
assert.match(dashboardSource, /const selectedCarbonUnit = ref\(''\)/);
for (const panel of ['energyPanel', 'carbonPanel', 'budgetPanel', 'meterPanel', 'importPanel']) {
  assert.match(dashboardSource, new RegExp(`const ${panel} = ref\\(createDashboardPanelState\\(\\)\\)`));
}
assert.match(dashboardSource, /const requestVersion = ref\(0\)/);
assert.match(dashboardSource, /const meterRequestVersion = ref\(0\)/);
assert.match(dashboardSource, /const importRequestVersion = ref\(0\)/);
assert.match(dashboardSource, /buildDashboardYearRange\(selectedYear\.value/);
assert.match(dashboardSource, /isLatestDashboardRequest\(version, requestVersion\.value\)/);
assert.match(dashboardApiSource, /getDashboardSummary = \(params = \{\}\) => get\('\/dashboard\/summary', params\)/);
assert.match(dashboardSource, /getDashboardEnergyTrend/);
assert.match(dashboardSource, /getDashboardEnergyBreakdown/);
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

// 年度选择只刷新年度面板，模式切换不得调用任何 loader。
assert.match(dashboardSource, /function handleYearChange\(year\)[\s\S]*?selectedYear\.value = year;[\s\S]*?loadAnnualPanels\(\);[\s\S]*?\n}/);
const toggleFunction = dashboardSource.match(/function toggleImmersiveMode\(\) \{([\s\S]*?)\n}/)?.[1] || '';
assert.match(toggleFunction, /enterImmersiveMode|exitImmersiveMode/);
assert.doesNotMatch(toggleFunction, /load|refresh/);
assert.match(dashboardSource, /const viewModel = computed\(\(\) => \(\{/);
assert.doesNotMatch(dashboardSource, /UNCONNECTED_CAPABILITIES/);
assert.doesNotMatch(dashboardSource, /unconnectedCapabilities/);
assert.match(dashboardSource, /function formatDateTime\(value\)/, '控制器必须定义导入活动时间格式化方法，避免场景信号计算时报未定义。');
assert.match(dashboardSource, /sceneState: sceneState\.value/);
assert.match(dashboardSource, /projectSeriesChange/);
assert.match(dashboardSource, /energyTrendChange: energyTrendChange\.value/);
assert.match(dashboardSource, /carbonTrendChange: carbonTrendChange\.value/);
assert.match(dashboardSource, /sceneSignals: sceneSignals\.value/);
assert.match(dashboardSource, /comparisonStatus === 'missing-previous-month'/);
assert.match(dashboardSource, /formatDashboardMeasurement\(Math\.abs\(change\.delta\)/);
assert.match(dashboardSource, /formatDashboardPercentage\(Math\.abs\(change\.rate\)\)/, '普通模式场景变化率必须避免把极小非零值显示成 0.0%。');
assert.match(dashboardSource, /getDashboardEnergyTrend/);
assert.match(dashboardSource, /getCarbonEmissionStats/);
assert.match(dashboardSource, /const baselineRange = computed\(\(\) => buildDashboardBaselineRange\(selectedRange\.value\)\)/, '控制器必须从选定年度生成上一年十二月基线范围。');
assert.match(dashboardSource, /const trendParams = baselineRange\.value[\s\S]*?normalizedMonthStart: baselineRange\.value\.normalizedMonthStart/, '能源趋势请求必须扩展到上一年十二月真实基线。');
assert.match(dashboardSource, /getDashboardSummary\(params\)[\s\S]*?getDashboardEnergyTrend\(trendParams\)[\s\S]*?getDashboardEnergyBreakdown\(params\)/, '能源总量和结构必须保持当前年度参数，只有趋势请求包含基线。');
assert.match(dashboardSource, /filterDashboardRowsByMonthRange\(trendResult\.value\.data \|\| \[\], selectedRange\.value\)/, '能源年度图表行必须从扩展响应中重新隔离。');
assert.match(dashboardSource, /filterDashboardRowsByMonthRange\(trendResult\.value\.data \|\| \[\], baselineRange\.value\)/, '能源上一年十二月只能进入比较行。');
assert.match(dashboardSource, /attachSeriesComparisonRows\(currentSeries, baselineSeries\)/, '能源基线必须只挂入环比投影。');
assert.match(dashboardSource, /getCarbonEmissionStats\(params\)[\s\S]*?getCarbonEmissionStats\(baselineRange\.value \|\| params\)/, '碳排必须分别请求当前年度与上一年十二月真实基线。');
assert.match(dashboardSource, /trendSeries: attachSeriesComparisonRows\(currentProjection\.trendSeries, baselineProjection\.trendSeries\)/, '碳排基线不得进入当前年度总量和结构投影。');

// 子视图只能使用 props/emits，不得导入 API、store 或在 mounted/watch 中加载。
for (const source of [standardSource, immersiveSource]) {
  assert.match(source, /defineProps\(\{ viewModel:/);
  assert.match(source, /defineEmits\(/);
  assert.doesNotMatch(source, /@\/api\//);
  assert.doesNotMatch(source, /useAppStore|useRouter|onMounted|watch\s*\(/);
  assert.doesNotMatch(source, /getDashboard|getCarbonEmissionStats|getEnergyBudgetExecutionComparison|ledgerApi/);
}

// 普通视图必须是浅色多摘要卡，包含趋势、单单位环图、五类真实面板和快捷入口。
const energySummarySource = standardSource.match(/<article class="summary-card summary-card--energy">([\s\S]*?)<\/article>/)?.[1] || '';
/** 普通模式顶部导入累计摘要卡片段，避免由下方详细面板满足断言。 */
const importSummarySource = standardSource.match(/<article class="summary-card summary-card--import">([\s\S]*?)<\/article>/)?.[1] || '';
assert.match(standardSource, /class="summary-grid"/);
assert.match(energySummarySource, /年度能源用量/);
assert.match(energySummarySource, /viewModel\.selectedEnergySeries\.totalValue/);
assert.match(energySummarySource, /viewModel\.selectedEnergySeries\.normalizedUnit/);
assert.match(energySummarySource, /viewModel\.selectedEnergySeries\.energyTypeName \|\| viewModel\.selectedEnergySeries\.energyTypeCode/);
assert.match(energySummarySource, /viewModel\.selectedEnergySeries\.recordCount/);
assert.doesNotMatch(energySummarySource, /selectedEnergyUnitGroup\?\.totalValue/);
assert.match(energySummarySource, /当前没有可展示的单一能源类型与标准单位序列/);
assert.match(standardSource, /已保存碳排/);
assert.match(standardSource, /用能预算风险/);
assert.match(standardSource, /计量器具/);
assert.match(standardSource, /导入累计/);
assert.match(standardSource, /EnergyTrendChart/);
assert.match(standardSource, /UnitDonutChart/);
assert.match(standardSource, /chart-id="standard-carbon-structure"[\s\S]*?kind="carbon"/);
assert.match(standardSource, /年度用能分析/);
assert.match(standardSource, /年度碳排分析/);
assert.match(standardSource, /用能预算执行明细/);
assert.match(standardSource, /当前快照来自本地计量器具台账，不是实时遥测/);
assert.match(standardSource, /全历史导入累计/);
assert.doesNotMatch(standardTemplateSource, /boundary-section|boundary-grid|尚未接入的能力/);
assert.match(importSummarySource, /导入累计/);
assert.match(importSummarySource, /batchCount/);
assert.match(importSummarySource, /importedRowCount/);
assert.match(importSummarySource, /failedRowCount/);
assert.match(importSummarySource, /skippedRowCount/);
assert.match(importSummarySource, /blockingErrorCount/);
assert.match(importSummarySource, /warningCount/);
assert.match(importSummarySource, /最新活动 \{\{ formatDateTime\(viewModel\.importPanel\.data\?\.imports\?\.latestBatchAt\) \}\}/);
assert.match(importSummarySource, /全历史累计，不随年度变化/);
assert.match(standardSource, /单位不一致 \/ 不可比较/);
assert.match(standardSource, /row\.budgetUnit \|\| row\.unit/);
assert.match(standardSource, /row\.actualUnit \|\| '—'/);
assert.match(standardSource, /因子缺失，无法形成排放总量/);
assert.match(standardSource, /未纳入排放总量与趋势/);
assert.match(standardSource, /aria-label="授权领域快捷入口"/);
assert.doesNotMatch(standardSource, /IndustrialParkScene/);
assert.match(standardSource, /background:#fff/);
assert.match(standardSource, /@media \(max-width:1200px\)/);
assert.match(standardSource, /@media \(max-width:960px\)/);
assert.match(standardSource, /@media \(max-width:640px\)/);

// 沉浸视图必须使用独立深色 Grid，突出真实趋势、数量、异常和最新活动，并移除业务快捷入口。
assert.match(immersiveSource, /class="immersive-signals"/);
assert.match(immersiveSource, /class="immersive-grid"/);
assert.match(immersiveSource, /grid-template-areas:"left scene right"/);
assert.match(immersiveSource, /<IndustrialParkScene/);
assert.match(immersiveSource, /:signals="viewModel\.sceneSignals"/);
assert.match(immersiveSource, /immersive-column--left/);
assert.match(immersiveSource, /immersive-column--right/);
assert.match(immersiveSource, /<EnergyTrendChart :series="viewModel\.selectedEnergySeries" :color="viewModel\.energyTrendColor" compact \/>/);
assert.match(immersiveSource, /<EnergyTrendChart :series="viewModel\.selectedCarbonSeries" :color="viewModel\.carbonTrendColor" compact \/>/);
assert.match(immersiveSource, /viewModel\.energyTrendChange\.latestMonth/);
assert.match(immersiveSource, /viewModel\.carbonTrendChange\.latestMonth/);
assert.match(immersiveSource, /viewModel\.budgetProjection\.warningRows/);
assert.match(immersiveSource, /viewModel\.meterPanel\.data\?\.total/);
assert.match(immersiveSource, /viewModel\.importPanel\.data\?\.errors\?\.blockingErrorCount/);
assert.match(immersiveSource, /viewModel\.importPanel\.data\?\.imports\?\.latestBatchAt/);
assert.doesNotMatch(immersiveSource, /业务快捷入口|授权领域快捷入口|viewModel\.quickLinks|emit\('navigate'/);
assert.doesNotMatch(immersiveSource, /class="immersive-links"|class="immersive-bottom"/);
assert.doesNotMatch(immersiveSource, /panel-empty-value">0</, '沉浸面板空状态不得使用大号 0 代替明确文案。');
assert.match(immersiveSource, /暂无能源记录/);
assert.match(immersiveSource, /暂无已核算碳排/);
assert.match(immersiveSource, /暂无预算比较/);
assert.match(immersiveSource, /暂无计量器具/);
assert.match(immersiveSource, /暂无导入活动/);
assert.match(immersiveSource, /:teleported="false"/);
assert.match(immersiveSource, /popper-class="immersive-dashboard-popper"/);
assert.match(immersiveSource, /\.immersive-dashboard :deep\(\.el-select__wrapper\)/);
assert.doesNotMatch(immersiveSource, /^\s*:deep\(\.el-select__wrapper\)/m);
assert.match(immersiveSource, /@media \(max-width:1279px\)/);
assert.match(immersiveSource, /@media \(max-width:1024px\)/);
assert.match(immersiveSource, /@media \(max-width:960px\)/);
assert.match(immersiveSource, /上月无数据（自然上月/);
assert.match(immersiveSource, /formatDashboardMeasurement\(viewModel\.carbonTrendChange\.latestValue, \{ kind: 'carbon' \}\)/);
assert.match(immersiveSource, /formatDashboardPercentage\(Math\.abs\(change\.rate\)\)/, '沉浸变化率必须避免把极小非零值显示成 0.0%。');
assert.doesNotMatch(immersiveTemplateSource, /immersive-boundary|未接入能力不参与摘要/);
assert.doesNotMatch(immersiveSource, /\.immersive-boundary|immersive-boundary/);
assert.match(immersiveSource, /loading: '正在汇总已授权的真实业务信号。'/);
assert.match(immersiveSource, /empty: '已完成读取，但当前范围内暂无可展示的真实业务信号。'/);
assert.match(immersiveSource, /forbidden: '当前账号没有可用于园区摘要的领域数据权限。'/);
assert.match(immersiveSource, /error: '真实业务摘要读取失败，请使用各面板的重试入口。'/);
assert.doesNotMatch(immersiveSource, /当前授权真实业务面板尚未返回|等待已授权真实业务面板返回/);

// 环图必须接收单一单位，保留真实零，具备 ARIA、键盘、tooltip、图例和等价表格。
assert.match(donutSource, /unit: \{ type: String, required: true \}/);
assert.match(donutSource, /kind: \{ type: String, default: 'energy' \}/);
assert.match(donutSource, /formatDashboardMeasurement/);
assert.match(donutSource, /formatDashboardPercentage\(\(Number\(value \|\| 0\) \/ totalValue\.value\) \* 100/, '环图极小非零占比必须使用安全百分比文本。');
assert.match(donutSource, /compact: \{ type: Boolean, default: false \}/);
assert.match(donutSource, /'donut-figure--compact': compact/);
assert.match(donutSource, /\.donut-figure--compact \.donut-layout\{grid-template-columns:minmax\(0,1fr\)\}/);
assert.match(donutSource, /\.donut-figure--compact \.donut-chart\{max-width:220px\}/);
assert.match(donutSource, /value: Number\.isFinite\(number\) && number > 0 \? number : 0/);
assert.match(donutSource, /if \(totalValue\.value <= 0\) return \[\]/);
assert.match(donutSource, /filter\(\(row\) => row\.value > 0\)/);
assert.match(donutSource, /<figure/);
assert.match(donutSource, /<figcaption/);
assert.match(donutSource, /role="img"/);
assert.match(donutSource, /<title/);
assert.match(donutSource, /<desc/);
assert.match(donutSource, /tabindex="0"/);
assert.match(donutSource, /role="status"/);
assert.match(donutSource, /aria-label="图例"/);
assert.match(donutSource, /等价数据表/);
assert.match(donutSource, /<table>/);
assert.doesNotMatch(donutSource, /role="button"|<button|echarts|d3|chart\.js/i);

// 园区场景必须是纯 inline SVG/CSS，并始终准确声明业务示意边界。
assert.match(sceneSource, /<figure/);
assert.match(sceneSource, /<svg viewBox="0 0 1000 520" role="img"/);
assert.match(sceneSource, /signals: \{ type: Array, default: \(\) => \[\] \}/);
assert.match(sceneSource, /v-for="signal in signals"/);
assert.match(sceneSource, /emptySignalTitle/);
assert.match(sceneSource, /loading: '正在汇总业务信号'/);
assert.match(sceneSource, /empty: '当前范围暂无业务信号'/);
assert.match(sceneSource, /forbidden: '无权限展示业务信号'/);
assert.match(sceneSource, /error: '业务信号读取失败'/);
assert.doesNotMatch(sceneSource, /等待已授权真实业务面板返回/);
assert.match(sceneSource, /<title/);
assert.match(sceneSource, /<desc/);
assert.match(sceneSource, /role="status"|:role=/);
assert.match(sceneSource, /'alert'/);
assert.match(sceneSource, /业务示意，非实景、非物理拓扑、非实时/);
assert.match(sceneSource, /不表示真实建筑位置、设备连接、能源管线或流量方向/);
assert.match(sceneSource, /不绑定组织树、设备坐标或实时遥测/);
assert.doesNotMatch(sceneSource, /<img|base64|https?:\/\/|external/i);
assert.doesNotMatch(sceneSource, /particle|flow-arrow|流向动画|数值管线/i);
assert.match(sceneSource, /prefers-reduced-motion:reduce/);
assert.match(sceneSource, /max-height:clamp\(150px,32dvh,300px\)/);
assert.match(sceneSource, /overflow-y:auto/);

// 场景聚合纯函数必须覆盖 loading/success/partial/empty/forbidden/error 且保留局部异常。
assert.match(dashboardUtilitySource, /export function projectDashboardSceneState/);
for (const status of ['loading', 'success', 'partial', 'empty', 'forbidden', 'error']) {
  assert.match(dashboardUtilitySource, new RegExp(`status: '${status}'`));
}
assert.match(dashboardUtilitySource, /counts\.error \|\| counts\.forbidden/);
assert.match(dashboardUtilitySource, /if \(!counts\.success\)/, 'mixed 状态只有 success 面板才可表述为已汇总真实业务数据。');
assert.match(dashboardUtilitySource, /当前没有可汇总\/展示的真实业务数据/);

// 局部面板与趋势图继续保留完整状态、重试、键盘、ARIA 和等价表格。
for (const status of ['loading', 'success', 'empty', 'forbidden', 'error']) assert.match(panelSource, new RegExp(status));
assert.match(panelSource, /重试此面板/);
assert.match(trendChartSource, /compact: \{ type: Boolean, default: false \}/);
assert.match(trendChartSource, /trend-figure--compact/);
assert.match(trendChartSource, /role="img"/);
assert.match(trendChartSource, /tabindex="0"/);
assert.match(trendChartSource, /role="status"/);
assert.match(trendChartSource, /formatDashboardMeasurement/);
assert.match(trendChartSource, /resolveTrendAxisMaximum\(rows\.value\)/, '趋势轴只在真实最大值为 0 时回退。');
assert.doesNotMatch(trendChartSource, /Math\.max\(\.\.\.rows\.value\.map\([^\n]*, 1\)/, '趋势图不得给非零极小值强制设置 1 的最小轴值。');
assert.match(trendChartSource, /isCarbonSeries\.value \? 'carbon' : 'energy'/);
assert.match(trendChartSource, /equivalent-table \.table-scroll\{max-height:clamp\(/);
assert.match(trendChartSource, /overflow-y:auto/);
assert.match(trendChartSource, /等价数据表/);
assert.doesNotMatch(trendChartSource, /role="button"|<button/);

// 控制器必须保留浏览器全屏生命周期，布局/store 契约保持不变。
assert.match(appStoreSource, /sidebarCollapsed: false/);
assert.match(appStoreSource, /immersiveMode: false/);
assert.match(appStoreSource, /setImmersiveMode/);
assert.doesNotMatch(appStoreSource, /localStorage\.setItem\([^\n]*immersive/);
assert.match(layoutSource, /<Sidebar v-if="!appStore\.immersiveMode"/);
assert.match(layoutSource, /<Navbar v-if="!appStore\.immersiveMode"/);
assert.match(layoutSource, /shell-content--immersive/);
assert.match(dashboardSource, /ref="cockpitRoot"/);
assert.match(dashboardSource, /requestFullscreen/);
assert.match(dashboardSource, /fullscreenchange/);
assert.match(dashboardSource, /event\.key !== 'Escape'/);
assert.match(dashboardSource, /onBeforeRouteLeave/);
assert.match(dashboardSource, /onBeforeUnmount/);
assert.match(dashboardSource, /已保留沉浸模式/);

// 沉浸布局必须锁定动态视口并在退出、路由切换和卸载时恢复普通页面滚动。
assert.match(immersiveSource, /grid-template-rows:auto auto minmax\(0,1fr\);/);
assert.match(immersiveSource, /height:100dvh/);
assert.match(immersiveSource, /min-height:0/);
assert.match(immersiveSource, /padding:clamp\(/);
assert.doesNotMatch(immersiveSource, /min-height:620px/);
assert.match(immersiveSource, /@media \(max-width:960px\)\{[\s\S]*?\.immersive-grid\{[^}]*overflow-y:auto/);
assert.match(immersiveSource, /@media \(max-width:640px\)\{[\s\S]*?\.immersive-header\{[^}]*overflow-y:auto/);
assert.match(immersiveSource, /@media \(max-width:640px\)\{[\s\S]*?\.immersive-signals\{[^}]*overflow-y:auto/);
assert.match(layoutSource, /\.shell--immersive\{[^}]*height:100dvh[^}]*min-height:0[^}]*overflow:hidden/);
assert.match(dashboardSource, /\.dashboard-controller\[data-display-mode="immersive"\],\.dashboard-controller:fullscreen\{[^}]*height:100dvh[^}]*overflow:hidden/);
assert.doesNotMatch(dashboardSource, /overflow-y:auto/);
assert.match(dashboardSource, /function applyImmersiveDocumentClass\(enabled\)/);
assert.match(dashboardSource, /onBeforeRouteLeave\(\(\) => \{\s*cleanupImmersiveMode\(\)/);
assert.match(dashboardSource, /onBeforeUnmount\(\(\) => \{[\s\S]*?cleanupImmersiveMode\(\)/);
assert.match(themeSource, /html\.immersive-mode,[\s\S]*?#app\.immersive-mode\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);

// 两种视图均必须在 reduced motion 下关闭装饰过渡或骨架动画。
assert.match(standardSource, /prefers-reduced-motion:reduce/);
assert.match(immersiveSource, /prefers-reduced-motion:reduce/);
assert.match(sceneSource, /\.scene-beacon\{animation:none\}/);

console.log('dashboardCockpitContract.test.mjs passed');
