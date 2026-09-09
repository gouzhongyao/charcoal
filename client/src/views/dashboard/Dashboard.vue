<template>
  <div ref="cockpitRoot" class="dashboard-controller" :data-display-mode="appStore.immersiveMode ? 'immersive' : 'standard'">
    <PageState v-if="!canView" description="当前账号没有查看中控的权限。请联系管理员授予 dashboard:view 权限。" />
    <ImmersiveDashboardView
      v-else-if="appStore.immersiveMode"
      :view-model="viewModel"
      @change-year="handleYearChange"
      @select-energy-series="selectEnergySeries"
      @select-carbon-unit="selectCarbonUnit"
      @refresh="refreshAll"
      @toggle-immersive="toggleImmersiveMode"
      @retry-energy="retryEnergyPanel"
      @retry-carbon="retryCarbonPanel"
      @retry-budget="retryBudgetPanel"
      @retry-meter="loadMeterSnapshot"
      @retry-import="loadImportSnapshot"
    />
    <StandardDashboardView
      v-else
      :view-model="viewModel"
      @change-year="handleYearChange"
      @select-energy-series="selectEnergySeries"
      @select-carbon-unit="selectCarbonUnit"
      @refresh="refreshAll"
      @toggle-immersive="toggleImmersiveMode"
      @retry-energy="retryEnergyPanel"
      @retry-carbon="retryCarbonPanel"
      @retry-budget="retryBudgetPanel"
      @retry-meter="loadMeterSnapshot"
      @retry-import="loadImportSnapshot"
      @navigate="goToModule"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import PageState from '@/components/PageState.vue';
import { getDashboardEnergyBreakdown, getDashboardEnergyTrend, getDashboardSummary } from '@/api/dashboard';
import { getCarbonEmissionStats } from '@/api/carbon';
import { getEnergyBudgetExecutionComparison } from '@/api/budgets';
import { ledgerApi } from '@/api/ledger';
import { useAppStore } from '@/stores/app';
import { ENERGY_TYPE_COLORS } from '@/utils/energyStatistics';
import { hasPermi } from '@/utils/permission';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';
import {
  DASHBOARD_PANEL_STATUS,
  attachSeriesComparisonRows,
  buildDashboardBaselineRange,
  buildDashboardYearRange,
  buildEnergyTrendSeries,
  calculateZeroSafePercentage,
  createDashboardPanelState,
  filterDashboardRowsByMonthRange,
  formatDashboardMeasurement,
  formatDashboardPercentage,
  groupEnergyRowsByUnit,
  isLatestDashboardRequest,
  projectBudgetWarningStatus,
  projectCarbonDashboardStats,
  projectDashboardSceneState,
  projectSeriesChange,
  resolveDashboardSummaryDomainState,
  settleDashboardPanelSuccess
} from '@/utils/dashboardCockpit';
import ImmersiveDashboardView from './ImmersiveDashboardView.vue';
import StandardDashboardView from './StandardDashboardView.vue';

/** 碳排趋势使用的驾驶舱单系列强调色。 */
const CARBON_TREND_COLOR = '#38bdf8';
/** 当前自然年度。 */
const currentYear = new Date().getFullYear();
/** 应用级沉浸模式状态。 */
const appStore = useAppStore();
/** 驾驶舱授权快捷入口路由器。 */
const router = useRouter();
/** 驾驶舱根节点，用于用户手势触发浏览器全屏。 */
const cockpitRoot = ref(null);
/** 当前选中的驾驶舱统计年度。 */
const selectedYear = ref(currentYear);
/** 年度请求版本，旧响应不得覆盖新年度。 */
const requestVersion = ref(0);
/** 计量器具快照请求版本。 */
const meterRequestVersion = ref(0);
/** 导入快照请求版本。 */
const importRequestVersion = ref(0);
/** 最近一次成功应用真实响应的时间。 */
const lastUpdated = ref('');
/** 浏览器当前是否处于全屏。 */
const fullscreenActive = ref(false);
/** 是否曾成功进入浏览器全屏，用于区分全屏拒绝后的纯沉浸模式。 */
const fullscreenWasEntered = ref(false);
/** 能源趋势当前选中序列键。 */
const selectedEnergySeriesKey = ref('');
/** 碳排当前选中单位。 */
const selectedCarbonUnit = ref('');
/** 年度用能局部状态。 */
const energyPanel = ref(createDashboardPanelState());
/** 年度碳排局部状态。 */
const carbonPanel = ref(createDashboardPanelState());
/** 用能预算预警局部状态。 */
const budgetPanel = ref(createDashboardPanelState());
/** 计量器具台账快照局部状态。 */
const meterPanel = ref(createDashboardPanelState());
/** 导入摘要快照局部状态。 */
const importPanel = ref(createDashboardPanelState());

/** 可选年度列表，覆盖当前年度及前七年。 */
const yearOptions = computed(() => Array.from({ length: 8 }, (_, index) => currentYear - index));
/** 当前年度标准化月份范围。 */
const selectedRange = computed(() => buildDashboardYearRange(selectedYear.value, currentYear));
/** 只供一月跨年环比使用的上一年十二月请求范围。 */
const baselineRange = computed(() => buildDashboardBaselineRange(selectedRange.value));
/** 驾驶舱基础查看权限。 */
const canView = computed(() => hasPermi('dashboard:view'));
/** 能耗记录或统计领域查看权限。 */
const canEnergyView = computed(() => hasPermi(['energy:records:view', 'energy-records:view', 'energy:statistics:view']));
/** 碳排放领域查看权限，兼容旧综合权限。 */
const canCarbonView = computed(() => hasPermi(['carbon:emissions:view', 'carbon:view']));
/** 用能预算领域查看权限。 */
const canBudgetView = computed(() => hasPermi('energy:budget:view'));
/** 计量器具领域查看权限，兼容旧权限编码。 */
const canMeterView = computed(() => hasPermi(['ledger:meters:view', 'ledger:meter:view']));
/** 导入中心领域查看权限，与驾驶舱摘要服务端授权编码保持一致。 */
const canImportView = computed(() => hasPermi('imports:view'));
/** 当前账号可见的只读领域快捷入口。 */
const quickLinks = computed(() => [
  canEnergyView.value && { label: '能耗统计', path: '/energy/statistics' },
  canCarbonView.value && { label: '碳核算', path: '/carbon' },
  canBudgetView.value && { label: '用能预算', path: '/energy/budgets' },
  canMeterView.value && { label: '计量器具', path: '/ledger/meters' },
  canImportView.value && { label: '数据导入', path: '/imports' }
].filter(Boolean));
/** 年度相关面板是否正在加载。 */
const annualLoading = computed(() => [energyPanel.value, carbonPanel.value, budgetPanel.value].some((panel) => panel.status === DASHBOARD_PANEL_STATUS.LOADING));
/** 按能源类型和单位拆分后的趋势序列。 */
const energySeries = computed(() => energyPanel.value.data?.series || []);
/** 当前选中的单一能源趋势序列。 */
const selectedEnergySeries = computed(() => energySeries.value.find((series) => series.key === selectedEnergySeriesKey.value) || energySeries.value[0] || null);
/** 当前能源序列最近两个真实月份的变化投影。 */
const energyTrendChange = computed(() => projectSeriesChange(selectedEnergySeries.value));
/** 能源结构的单位安全分组。 */
const energyUnitGroups = computed(() => energyPanel.value.data?.unitGroups || []);
/** 当前能源趋势和结构共用的单位。 */
const selectedEnergyUnit = computed(() => selectedEnergySeries.value?.normalizedUnit || energyUnitGroups.value[0]?.unit || '');
/** 当前能源单位组。 */
const selectedEnergyUnitGroup = computed(() => energyUnitGroups.value.find((group) => group.unit === selectedEnergyUnit.value) || null);
/** 当前能源单位组的结构图行。 */
const energyStructureRows = computed(() => buildStructureRows(selectedEnergyUnitGroup.value?.rows || [], {
  unitKey: 'normalizedUnit', valueKey: 'totalNormalizedValue', countKey: 'recordCount', detailSuffix: '条 active 记录'
}));
/** 当前年度能源月份覆盖。 */
const energyMonthRange = computed(() => {
  const range = energyPanel.value.data?.summary?.energy?.monthRange || {};
  return range.start && range.end ? `${range.start} 至 ${range.end}` : '暂无';
});
/** 碳排统计的总量、趋势和因子缺口统一投影。 */
const carbonProjection = computed(() => carbonPanel.value.data?.projection || projectCarbonDashboardStats());
/** 碳排统计中仅含真实已核算结果的单位安全分组。 */
const carbonUnitGroups = computed(() => carbonProjection.value.unitGroups || []);
/** 当前碳排单位总量。 */
const selectedCarbonTotal = computed(() => carbonUnitGroups.value.find((group) => group.unit === selectedCarbonUnit.value)?.totalValue ?? null);
/** 当前排放单位对应的单轴年度碳排趋势。 */
const selectedCarbonSeries = computed(() => (carbonProjection.value.trendSeries || []).find((series) => series.normalizedUnit === selectedCarbonUnit.value) || null);
/** 当前碳排序列最近两个真实月份的变化投影。 */
const carbonTrendChange = computed(() => projectSeriesChange(selectedCarbonSeries.value));
/** 当前碳排单位下按能源类型的真实已核算结构行。 */
const carbonStructureRows = computed(() => buildStructureRows(
  (carbonPanel.value.data?.stats?.byEnergyType || []).filter((row) => row.emissionUnit === selectedCarbonUnit.value && Number(row.calculatedCount || 0) > 0),
  { unitKey: 'emissionUnit', valueKey: 'totalEmissionValue', countKey: 'calculatedCount', missingKey: 'missingFactorCount', detailSuffix: '条已计算结果' }
));
/** 用能预算预警投影。 */
const budgetProjection = computed(() => projectBudgetWarningStatus(budgetPanel.value.data?.rows || []));
/** 计量器具启用比例。 */
const meterActivePercentage = computed(() => calculateZeroSafePercentage(meterPanel.value.data?.active, meterPanel.value.data?.total));
/** 计量器具停用比例。 */
const meterInactivePercentage = computed(() => calculateZeroSafePercentage(meterPanel.value.data?.inactive, meterPanel.value.data?.total));
/** 园区业务示意的五面板聚合状态。 */
const sceneState = computed(() => projectDashboardSceneState([
  energyPanel.value,
  carbonPanel.value,
  budgetPanel.value,
  meterPanel.value,
  importPanel.value
]));
/** 将真实趋势变化投影为园区场景可读的变化说明，不为单点或缺月数据补造环比。 */
function sceneChangeDetail(change, unit, kind = 'energy') {
  if (!change || change.status !== 'available') return '当前没有可比较的月份数据';
  if (change.comparisonStatus === 'missing-previous-month') {
    return `${change.latestMonth}，上月无数据（自然上月 ${change.previousMonth}）`;
  }
  if (change.comparisonStatus === 'single' || change.direction === 'single') return `${change.latestMonth}，暂无上月对比`;
  if (change.direction === 'flat') return `${change.latestMonth}，与上月持平`;
  const direction = change.direction === 'up' ? '较上月上升' : '较上月下降';
  const amount = `${formatDashboardMeasurement(Math.abs(change.delta), {
    kind,
    maximumFractionDigits: kind === 'carbon' ? 8 : 2
  })}${unit ? ` ${unit}` : ''}`;
  const rate = change.rate === null
    ? '上月为 0，百分比不可用'
    : formatDashboardPercentage(Math.abs(change.rate));
  return `${change.latestMonth}，${direction} ${amount}（${rate}）`;
}
/** 将预算最高风险级别转换为摘要中文标签。 */
function sceneBudgetRiskLabel(level) {
  return ({ unit_mismatch: '单位不一致', exceeded: '超预算', missing_budget: '缺预算', nearing: '接近预算', normal: '正常' })[level] || '未知';
}
/** 仅从已成功面板提取真实数量、最新月份和环比变化供园区示意展示。 */
const sceneSignals = computed(() => {
  const signals = [];
  if (energyPanel.value.status === DASHBOARD_PANEL_STATUS.SUCCESS && selectedEnergySeries.value && energyTrendChange.value.status === 'available') {
    signals.push({
      key: 'energy-trend', label: '最新能源用量', value: energyTrendChange.value.latestValue,
      unit: selectedEnergySeries.value.normalizedUnit, detail: sceneChangeDetail(energyTrendChange.value, selectedEnergySeries.value.normalizedUnit), tone: 'energy'
    });
  }
  if (carbonPanel.value.status === DASHBOARD_PANEL_STATUS.SUCCESS && selectedCarbonSeries.value && carbonTrendChange.value.status === 'available') {
    signals.push({
      key: 'carbon-trend', label: '最新已核算碳排', value: carbonTrendChange.value.latestValue,
      unit: selectedCarbonSeries.value.normalizedUnit, detail: sceneChangeDetail(carbonTrendChange.value, selectedCarbonSeries.value.normalizedUnit, 'carbon'), tone: 'carbon'
    });
  }
  if (budgetPanel.value.status === DASHBOARD_PANEL_STATUS.SUCCESS) {
    signals.push({
      key: 'budget-risk', label: '预算预警项', value: budgetProjection.value.warningCount,
      unit: '项', detail: budgetProjection.value.warningCount ? `最高级别：${sceneBudgetRiskLabel(budgetProjection.value.highestLevel)}` : '当前年度未触发预警', tone: budgetProjection.value.warningCount ? 'warning' : 'good'
    });
  }
  if (meterPanel.value.status === DASHBOARD_PANEL_STATUS.SUCCESS) {
    signals.push({
      key: 'meter-ledger', label: '计量器具台账', value: meterPanel.value.data?.total,
      unit: '台', detail: `启用 ${meterPanel.value.data?.active ?? '—'}，停用 ${meterPanel.value.data?.inactive ?? '—'}`, tone: 'ledger'
    });
  }
  if (importPanel.value.status === DASHBOARD_PANEL_STATUS.SUCCESS) {
    signals.push({
      key: 'import-activity', label: '导入累计批次', value: importPanel.value.data?.imports?.batchCount,
      unit: '批', detail: `最新活动 ${formatDateTime(importPanel.value.data?.imports?.latestBatchAt)}`, tone: 'import'
    });
  }
  return signals;
});
/** 两套独立视图共享的只读投影模型。 */
const viewModel = computed(() => ({
  selectedYear: selectedYear.value,
  yearOptions: yearOptions.value,
  selectedRange: selectedRange.value,
  lastUpdated: lastUpdated.value,
  annualLoading: annualLoading.value,
  fullscreenActive: fullscreenActive.value,
  energyPanel: energyPanel.value,
  carbonPanel: carbonPanel.value,
  budgetPanel: budgetPanel.value,
  meterPanel: meterPanel.value,
  importPanel: importPanel.value,
  energySeries: energySeries.value,
  selectedEnergySeriesKey: selectedEnergySeriesKey.value,
  selectedEnergySeries: selectedEnergySeries.value,
  energyTrendChange: energyTrendChange.value,
  energyTrendColor: energyColor(selectedEnergySeries.value?.energyTypeCode),
  energyUnitGroups: energyUnitGroups.value,
  selectedEnergyUnit: selectedEnergyUnit.value,
  selectedEnergyUnitGroup: selectedEnergyUnitGroup.value,
  energyStructureRows: energyStructureRows.value,
  energyMonthRange: energyMonthRange.value,
  carbonProjection: carbonProjection.value,
  carbonUnitGroups: carbonUnitGroups.value,
  selectedCarbonUnit: selectedCarbonUnit.value,
  selectedCarbonTotal: selectedCarbonTotal.value,
  selectedCarbonSeries: selectedCarbonSeries.value,
  carbonTrendChange: carbonTrendChange.value,
  carbonStructureRows: carbonStructureRows.value,
  carbonTrendColor: CARBON_TREND_COLOR,
  budgetProjection: budgetProjection.value,
  meterActivePercentage: meterActivePercentage.value,
  meterInactivePercentage: meterInactivePercentage.value,
  quickLinks: quickLinks.value,
  sceneState: sceneState.value,
  sceneSignals: sceneSignals.value
}));

/** 返回项目既有能源类型固定颜色。 */
function energyColor(energyTypeCode) {
  return ENERGY_TYPE_COLORS[energyTypeCode] || ENERGY_TYPE_COLORS.other;
}

/** 构建单一单位结构行，并将未知能源类型聚合为“其他能源类型”。 */
function buildStructureRows(rows, options) {
  const structureMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const rawCode = String(row?.energyTypeCode || 'other');
    const knownCode = Object.hasOwn(ENERGY_TYPE_COLORS, rawCode) && rawCode !== 'other' ? rawCode : 'other';
    const current = structureMap.get(knownCode) || {
      key: `${knownCode}-${row?.[options.unitKey] || 'unit'}`,
      label: knownCode === 'other' ? '其他能源类型' : (row?.energyTypeName || rawCode),
      value: 0,
      count: 0,
      missingCount: 0,
      color: energyColor(knownCode)
    };
    current.value += Number(row?.[options.valueKey]) || 0;
    current.count += Number(row?.[options.countKey]) || 0;
    current.missingCount += Number(row?.[options.missingKey]) || 0;
    structureMap.set(knownCode, current);
  });
  return [...structureMap.values()].map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    color: row.color,
    detail: `${formatInteger(row.count)} ${options.detailSuffix}${options.missingKey ? `，因子缺失 ${formatInteger(row.missingCount)} 条` : ''}`
  }));
}

/** 安全执行领域 API，并保留可读错误对象。 */
async function safeRequest(task) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 返回接口错误的用户可读文本。 */
function requestError(result) {
  return result?.error?.message || '接口请求失败。';
}

/** 格式化真实数值；缺失值不显示为零。 */
function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number) : '—';
}

/** 格式化真实整数；缺失值不显示为零。 */
function formatInteger(value) {
  return formatNumber(value, 0);
}

/** 格式化导入摘要最新活动时间。 */
function formatDateTime(value) {
  return formatStrictUtcDateTimeDisplay(value, '尚未成功更新');
}

/** 更新最近成功响应时间。 */
function touchLastUpdated() {
  lastUpdated.value = new Date().toISOString();
}

/** 将无权限领域面板设置为 forbidden，禁止发起领域请求。 */
function forbidPanel(panel) {
  panel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.FORBIDDEN);
}

/** 加载年度用能摘要、单一序列趋势和同单位结构。 */
async function loadEnergyPanel(version = requestVersion.value) {
  if (!canEnergyView.value) {
    forbidPanel(energyPanel);
    return;
  }
  energyPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING);
  const params = { normalizedMonthStart: selectedRange.value.normalizedMonthStart, normalizedMonthEnd: selectedRange.value.normalizedMonthEnd };
  const trendParams = baselineRange.value
    ? { ...params, normalizedMonthStart: baselineRange.value.normalizedMonthStart }
    : params;
  const [summaryResult, trendResult, breakdownResult] = await Promise.all([
    safeRequest(() => getDashboardSummary(params)),
    safeRequest(() => getDashboardEnergyTrend(trendParams)),
    safeRequest(() => getDashboardEnergyBreakdown(params))
  ]);
  if (!isLatestDashboardRequest(version, requestVersion.value)) return;
  if (!summaryResult.ok) {
    energyPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(summaryResult));
    return;
  }
  const summary = summaryResult.value.data || {};
  const summaryDomainState = resolveDashboardSummaryDomainState(summary.energy);
  if (summaryDomainState.status === DASHBOARD_PANEL_STATUS.FORBIDDEN) {
    forbidPanel(energyPanel);
    return;
  }
  if (summaryDomainState.status === DASHBOARD_PANEL_STATUS.ERROR) {
    energyPanel.value = summaryDomainState;
    return;
  }
  const failedResult = [trendResult, breakdownResult].find((result) => !result.ok);
  if (failedResult) {
    energyPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(failedResult));
    return;
  }
  const trendRows = filterDashboardRowsByMonthRange(trendResult.value.data || [], selectedRange.value);
  const baselineTrendRows = baselineRange.value
    ? filterDashboardRowsByMonthRange(trendResult.value.data || [], baselineRange.value)
    : [];
  const breakdownRows = filterDashboardRowsByMonthRange(breakdownResult.value.data || [], selectedRange.value);
  const totals = filterDashboardRowsByMonthRange(
    Array.isArray(summary.energy?.totals) ? summary.energy.totals : breakdownRows,
    selectedRange.value
  );
  const currentSeries = buildEnergyTrendSeries(trendRows);
  const baselineSeries = buildEnergyTrendSeries(baselineTrendRows);
  const series = attachSeriesComparisonRows(currentSeries, baselineSeries);
  const unitGroups = groupEnergyRowsByUnit(totals);
  energyPanel.value = settleDashboardPanelSuccess({ summary, series, unitGroups }, summaryDomainState.status === DASHBOARD_PANEL_STATUS.EMPTY);
  if (series.length && !series.some((item) => item.key === selectedEnergySeriesKey.value)) selectedEnergySeriesKey.value = series[0].key;
  touchLastUpdated();
}

/** 加载年度碳排统计，并按 emissionUnit 安全分组。 */
async function loadCarbonPanel(version = requestVersion.value) {
  if (!canCarbonView.value) {
    forbidPanel(carbonPanel);
    return;
  }
  carbonPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING);
  const params = { normalizedMonthStart: selectedRange.value.normalizedMonthStart, normalizedMonthEnd: selectedRange.value.normalizedMonthEnd };
  const [result, baselineResult] = await Promise.all([
    safeRequest(() => getCarbonEmissionStats(params)),
    safeRequest(() => getCarbonEmissionStats(baselineRange.value || params))
  ]);
  if (!isLatestDashboardRequest(version, requestVersion.value)) return;
  if (!result.ok) {
    carbonPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(result));
    return;
  }
  const stats = {
    ...(result.value.data || {}),
    byMonth: filterDashboardRowsByMonthRange(result.value.data?.byMonth || [], selectedRange.value)
  };
  const baselineData = baselineResult.ok ? (baselineResult.value.data || {}) : {};
  const baselineStats = {
    ...baselineData,
    byMonth: filterDashboardRowsByMonthRange(baselineData.byMonth || [], baselineRange.value || {})
  };
  const currentProjection = projectCarbonDashboardStats(stats);
  const baselineProjection = projectCarbonDashboardStats(baselineStats);
  const projection = {
    ...currentProjection,
    trendSeries: attachSeriesComparisonRows(currentProjection.trendSeries, baselineProjection.trendSeries)
  };
  carbonPanel.value = settleDashboardPanelSuccess({ stats, projection }, Number(stats.totalRecords || 0) === 0);
  if (projection.unitGroups.length && !projection.unitGroups.some((group) => group.unit === selectedCarbonUnit.value)) selectedCarbonUnit.value = projection.unitGroups[0].unit;
  if (!projection.unitGroups.length) selectedCarbonUnit.value = '';
  touchLastUpdated();
}

/** 加载年度用能预算执行比较和预警投影。 */
async function loadBudgetPanel(version = requestVersion.value) {
  if (!canBudgetView.value) {
    forbidPanel(budgetPanel);
    return;
  }
  budgetPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING);
  const params = { monthStart: selectedRange.value.normalizedMonthStart, monthEnd: selectedRange.value.normalizedMonthEnd };
  const result = await safeRequest(() => getEnergyBudgetExecutionComparison(params));
  if (!isLatestDashboardRequest(version, requestVersion.value)) return;
  if (!result.ok) {
    budgetPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(result));
    return;
  }
  const rows = result.value.data || [];
  budgetPanel.value = settleDashboardPanelSuccess({ rows, summary: result.value.meta?.summary || {} }, rows.length === 0);
  touchLastUpdated();
}

/** 并发刷新所有受年度筛选影响的领域面板。 */
async function loadAnnualPanels() {
  const version = requestVersion.value + 1;
  requestVersion.value = version;
  await Promise.all([loadEnergyPanel(version), loadCarbonPanel(version), loadBudgetPanel(version)]);
}

/** 处理年度选择并只刷新受年度影响的面板。 */
function handleYearChange(year) {
  selectedYear.value = year;
  loadAnnualPanels();
}

/** 更新控制器中的能源序列选择。 */
function selectEnergySeries(seriesKey) {
  selectedEnergySeriesKey.value = String(seriesKey || '');
}

/** 更新控制器中的碳排单位选择。 */
function selectCarbonUnit(unit) {
  selectedCarbonUnit.value = String(unit || '');
}

/** 独立重试年度用能面板，并沿用当前年度请求版本。 */
function retryEnergyPanel() {
  loadEnergyPanel(requestVersion.value);
}

/** 独立重试年度碳排面板，并沿用当前年度请求版本。 */
function retryCarbonPanel() {
  loadCarbonPanel(requestVersion.value);
}

/** 独立重试用能预算预警面板，并沿用当前年度请求版本。 */
function retryBudgetPanel() {
  loadBudgetPanel(requestVersion.value);
}

/** 加载当前计量器具台账快照，不受年度筛选影响。 */
async function loadMeterSnapshot() {
  if (!canMeterView.value) {
    forbidPanel(meterPanel);
    return;
  }
  const version = meterRequestVersion.value + 1;
  meterRequestVersion.value = version;
  meterPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING);
  const result = await safeRequest(() => ledgerApi.meters.stats());
  if (!isLatestDashboardRequest(version, meterRequestVersion.value)) return;
  if (!result.ok) {
    meterPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(result));
    return;
  }
  const data = result.value.data || {};
  meterPanel.value = settleDashboardPanelSuccess(data, Number(data.total || 0) === 0);
  touchLastUpdated();
}

/** 加载当前导入摘要与最近活动，不受年度筛选影响。 */
async function loadImportSnapshot() {
  if (!canImportView.value) {
    forbidPanel(importPanel);
    return;
  }
  const version = importRequestVersion.value + 1;
  importRequestVersion.value = version;
  importPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING);
  const result = await safeRequest(() => getDashboardSummary());
  if (!isLatestDashboardRequest(version, importRequestVersion.value)) return;
  if (!result.ok) {
    importPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(result));
    return;
  }
  const summary = result.value.data || {};
  const importsDomainState = resolveDashboardSummaryDomainState(summary.imports);
  const errorsDomainState = resolveDashboardSummaryDomainState(summary.errors);
  if ([importsDomainState, errorsDomainState].some((state) => state.status === DASHBOARD_PANEL_STATUS.FORBIDDEN)) {
    forbidPanel(importPanel);
    return;
  }
  const invalidDomainState = [importsDomainState, errorsDomainState].find((state) => state.status === DASHBOARD_PANEL_STATUS.ERROR);
  if (invalidDomainState) {
    importPanel.value = invalidDomainState;
    return;
  }
  const isEmpty = importsDomainState.status === DASHBOARD_PANEL_STATUS.EMPTY && errorsDomainState.status === DASHBOARD_PANEL_STATUS.EMPTY;
  importPanel.value = settleDashboardPanelSuccess({ imports: summary.imports, errors: summary.errors }, isEmpty);
  touchLastUpdated();
}

/** 同时刷新年度面板与当前快照面板。 */
function refreshAll() {
  loadAnnualPanels();
  loadMeterSnapshot();
  loadImportSnapshot();
}

/** 跳转到当前账号已授权的领域页面。 */
function goToModule(path) {
  router.push(path);
}

/** 响应浏览器全屏变化；Escape 或系统退出全屏时同步清理沉浸模式。 */
function handleFullscreenChange() {
  fullscreenActive.value = Boolean(document.fullscreenElement);
  if (fullscreenActive.value) {
    fullscreenWasEntered.value = true;
    applyImmersiveDocumentClass(true);
    return;
  }
  if (fullscreenWasEntered.value && appStore.immersiveMode) appStore.setImmersiveMode(false);
  fullscreenWasEntered.value = false;
  if (!appStore.immersiveMode) applyImmersiveDocumentClass(false);
}

/** 同步沉浸模式全局节点 class，避免离开页面后普通页面继续锁定滚动。 */
function applyImmersiveDocumentClass(enabled) {
  [document.documentElement, document.body, document.getElementById('app')].filter(Boolean).forEach((node) => {
    node.classList.toggle('immersive-mode', enabled);
  });
}

/** 响应 Escape，清理被拒绝全屏后仍保留的纯沉浸模式。 */
function handleEscape(event) {
  if (event.key !== 'Escape' || !appStore.immersiveMode) return;
  appStore.setImmersiveMode(false);
  applyImmersiveDocumentClass(false);
  if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen();
}

/** 在用户手势内进入沉浸模式并请求浏览器全屏。 */
async function enterImmersiveMode() {
  appStore.setImmersiveMode(true);
  applyImmersiveDocumentClass(true);
  const requestFullscreen = cockpitRoot.value?.requestFullscreen;
  if (typeof requestFullscreen !== 'function') {
    ElMessage.warning('当前浏览器不支持全屏，已保留沉浸模式。');
    return;
  }
  try {
    await requestFullscreen.call(cockpitRoot.value);
  } catch (error) {
    ElMessage.warning('浏览器拒绝全屏请求，已保留沉浸模式，可使用退出按钮或 Escape 返回。');
  }
}

/** 退出浏览器全屏并关闭沉浸模式。 */
async function exitImmersiveMode() {
  appStore.setImmersiveMode(false);
  applyImmersiveDocumentClass(false);
  fullscreenWasEntered.value = false;
  if (!document.fullscreenElement || !document.exitFullscreen) return;
  try {
    await document.exitFullscreen();
  } catch (error) {
    ElMessage.warning('浏览器全屏退出失败，请按 Escape 退出。');
  }
}

/** 切换驾驶舱大屏模式；此方法不调用任何数据 loader。 */
function toggleImmersiveMode() {
  if (appStore.immersiveMode) exitImmersiveMode();
  else enterImmersiveMode();
}

/** 离开驾驶舱时清理沉浸模式和浏览器全屏。 */
function cleanupImmersiveMode() {
  appStore.setImmersiveMode(false);
  applyImmersiveDocumentClass(false);
  fullscreenWasEntered.value = false;
  if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen();
}

onMounted(() => {
  appStore.setImmersiveMode(false);
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  window.addEventListener('keydown', handleEscape);
  if (canView.value) {
    loadAnnualPanels();
    loadMeterSnapshot();
    loadImportSnapshot();
  }
});

onBeforeRouteLeave(() => {
  cleanupImmersiveMode();
  return true;
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  window.removeEventListener('keydown', handleEscape);
  cleanupImmersiveMode();
});
</script>

<style scoped>
.dashboard-controller{min-width:0;max-width:100%;overflow-x:hidden}.dashboard-controller[data-display-mode="immersive"],.dashboard-controller:fullscreen{width:100%;height:100dvh;min-height:0;overflow:hidden;background:#020b18}
</style>
