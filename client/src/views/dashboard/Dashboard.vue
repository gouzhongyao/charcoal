<template>
  <div ref="cockpitRoot" class="cockpit-root" :class="{ 'is-immersive': appStore.immersiveMode }" :data-display-mode="appStore.immersiveMode ? 'immersive' : 'standard'">
    <PageState v-if="!canView" description="当前账号没有查看驾驶舱的权限。请联系管理员授予 dashboard:view 权限。" />
    <template v-else>
      <header class="cockpit-hero">
        <div class="cockpit-hero__title">
          <span class="cockpit-kicker">LOCAL ENERGY & CARBON COCKPIT</span>
          <h1>驾驶舱</h1>
          <p>以本地 SQLite 已入库数据呈现年度用能、碳排、预算预警和计量器具台账快照；错误或无权限状态不会以 0 代替。</p>
        </div>
        <div class="cockpit-controls" aria-label="驾驶舱筛选与显示控制">
          <label class="year-control"><span>统计年度</span><el-select v-model="selectedYear" aria-label="选择驾驶舱统计年度" @change="loadAnnualPanels"><el-option v-for="year in yearOptions" :key="year" :label="`${year} 年`" :value="year" /></el-select></label>
          <el-button type="primary" :loading="annualLoading" @click="refreshAll">刷新驾驶舱</el-button>
          <el-button @click="toggleImmersiveMode">{{ appStore.immersiveMode ? '退出大屏' : '大屏模式' }}</el-button>
        </div>
        <div class="cockpit-meta" aria-live="polite">
          <span>年度范围 {{ selectedRange.normalizedMonthStart }} 至 {{ selectedRange.normalizedMonthEnd }}</span>
          <span>最后更新 {{ formatDateTime(lastUpdated) }}</span>
          <span>{{ appStore.immersiveMode ? (fullscreenActive ? '沉浸模式 · 浏览器全屏' : '沉浸模式') : '标准布局' }}</span>
        </div>
      </header>

      <section class="cockpit-grid" aria-label="驾驶舱真实数据面板">
        <CockpitPanel title="年度用能态势" eyebrow="ENERGY" description="趋势按 energyTypeCode + normalizedUnit 拆分，一次只显示一个单一数值轴；结构图使用同一单位组。" :status="energyPanel.status" :error="energyPanel.error" forbidden-text="需要能耗记录或能耗统计查看权限。dashboard:view 不替代领域权限。" empty-text="当前年度暂无 active 能耗记录。" wide @retry="retryEnergyPanel">
          <template #actions>
            <el-select v-if="energyPanel.status === 'success' && energySeries.length" v-model="selectedEnergySeriesKey" class="panel-select" aria-label="选择能源趋势序列">
              <el-option v-for="series in energySeries" :key="series.key" :label="`${series.energyTypeName} · ${series.normalizedUnit}`" :value="series.key" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ selectedYear }} 年暂无 active 能耗记录。</span></template>
          <div class="metric-row">
            <div><span>选定单位总量</span><strong>{{ formatNumber(selectedEnergyUnitGroup?.totalValue, 2) }} <small>{{ selectedEnergyUnit }}</small></strong></div>
            <div><span>选定序列记录</span><strong>{{ formatInteger(selectedEnergySeries?.recordCount) }} <small>条</small></strong></div>
            <div><span>能源单位组</span><strong>{{ formatInteger(energyUnitGroups.length) }} <small>组</small></strong></div>
            <div><span>数据月份</span><strong>{{ energyMonthRange }}</strong></div>
          </div>
          <div class="visual-grid">
            <EnergyTrendChart v-if="selectedEnergySeries" :series="selectedEnergySeries" :color="energyColor(selectedEnergySeries.energyTypeCode)" />
            <UnitBarChart v-if="energyStructureRows.length" title="年度能源结构" :unit="selectedEnergyUnit" :rows="energyStructureRows" />
          </div>
        </CockpitPanel>

        <CockpitPanel title="年度碳排概览" eyebrow="CARBON" description="只展示已保存的碳排放结果，并严格按 emissionUnit 分组；因子缺失不估算排放。" :status="carbonPanel.status" :error="carbonPanel.error" forbidden-text="需要 carbon:emissions:view 权限；dashboard:view 不替代碳排领域权限。" empty-text="当前年度暂无碳排放结果。" @retry="retryCarbonPanel">
          <template #actions>
            <el-select v-if="carbonPanel.status === 'success' && carbonUnitGroups.length" v-model="selectedCarbonUnit" class="panel-select panel-select--small" aria-label="选择碳排放单位">
              <el-option v-for="group in carbonUnitGroups" :key="group.unit" :label="group.unit" :value="group.unit" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ selectedYear }} 年暂无碳排放结果。</span></template>
          <div class="metric-row metric-row--compact">
            <div><span>排放总量</span><strong v-if="!carbonProjection.hasOnlyMissingFactors">{{ formatNumber(selectedCarbonTotal, 4) }} <small v-if="selectedCarbonUnit">{{ selectedCarbonUnit }}</small></strong><strong v-else class="metric-gap-text">无法形成</strong></div>
            <div><span>已计算结果</span><strong>{{ formatInteger(carbonProjection.calculatedCount) }} <small>条</small></strong></div>
            <div><span>因子缺失</span><strong>{{ formatInteger(carbonProjection.missingFactorCount) }} <small>条</small></strong></div>
          </div>
          <div v-if="carbonProjection.hasOnlyMissingFactors" class="carbon-gap-state" role="status">
            <strong>因子缺失，无法形成排放总量</strong>
            <span>当前年度没有可用于总量或趋势的已核算碳排结果，因此不显示 0 排放单位组或零线。</span>
          </div>
          <template v-else>
            <div class="visual-grid">
              <EnergyTrendChart v-if="selectedCarbonSeries" :series="selectedCarbonSeries" :color="CARBON_TREND_COLOR" />
              <UnitBarChart v-if="carbonStructureRows.length" title="按能源类型的碳排结构" :unit="selectedCarbonUnit" :rows="carbonStructureRows" />
            </div>
            <p v-if="carbonProjection.hasMissingGap" class="boundary-note">当前仅展示真实已核算总量和趋势；另有 {{ formatInteger(carbonProjection.missingFactorCount) }} 条记录因子缺失，未纳入排放总量与趋势。</p>
          </template>
        </CockpitPanel>

        <CockpitPanel title="用能预算预警" eyebrow="BUDGET ALERT" description="按年度 active 预算与相同月份、能源类型的 active 能耗记录比较；不做跨单位金额或数值汇总。" :status="budgetPanel.status" :error="budgetPanel.error" forbidden-text="需要 energy:budget:view 权限；dashboard:view 不替代预算领域权限。" empty-text="当前年度暂无 active 用能预算比较结果。" @retry="retryBudgetPanel">
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ selectedYear }} 年暂无用能预算比较结果。</span></template>
          <div class="warning-summary" :class="`warning-summary--${budgetProjection.highestLevel}`">
            <div><span>预警项</span><strong>{{ formatInteger(budgetProjection.warningCount) }}</strong></div>
            <div><span>超预算</span><strong>{{ formatInteger(budgetProjection.counts.exceeded) }}</strong></div>
            <div><span>接近预算</span><strong>{{ formatInteger(budgetProjection.counts.nearing) }}</strong></div>
            <div><span>未配置预算</span><strong>{{ formatInteger(budgetProjection.counts.missingBudget) }}</strong></div>
            <div><span>单位不一致 / 不可比较</span><strong>{{ formatInteger(budgetProjection.counts.unitMismatch) }}</strong></div>
          </div>
          <div v-if="budgetProjection.warningRows.length" class="warning-list" aria-label="用能预算预警明细">
            <div v-for="row in budgetProjection.warningRows.slice(0, 6)" :key="budgetRowKey(row)" class="warning-item">
              <span class="status-dot" :class="`status-dot--${row.dashboardWarningLevel}`" aria-hidden="true" />
              <div><strong>{{ row.energyTypeName || row.energyTypeCode }} · {{ row.periodMonth }}</strong><span>{{ row.organizationScope }} · {{ budgetWarningLabel(row) }} · {{ budgetUsageLabel(row) }}</span></div>
            </div>
          </div>
          <p v-else class="success-note">当前年度预算比较未触发预警。</p>
          <details class="data-details"><summary>查看预算比较等价数据表</summary><div class="table-scroll"><table><thead><tr><th>月份</th><th>能源类型</th><th>组织范围</th><th>状态</th><th>预算值</th><th>实际值</th></tr></thead><tbody><tr v-for="row in budgetPanel.data?.rows || []" :key="`table-${budgetRowKey(row)}`"><td>{{ row.periodMonth }}</td><td>{{ row.energyTypeName || row.energyTypeCode }}</td><td>{{ row.organizationScope }}</td><td>{{ budgetWarningLabel(row) }}</td><td>{{ formatNumber(row.budgetValue, 2) }} {{ row.budgetUnit || row.unit || '—' }}</td><td>{{ formatNumber(row.actualValue, 2) }} {{ row.actualUnit || '—' }}</td></tr></tbody></table></div></details>
        </CockpitPanel>

        <CockpitPanel title="计量器具状态" eyebrow="METER LEDGER" description="当前快照来自本地计量器具台账，不是实时遥测、联网在线判断或网关心跳。" :status="meterPanel.status" :error="meterPanel.error" forbidden-text="需要 ledger:meters:view 权限；dashboard:view 不替代基础台账权限。" empty-text="本地台账暂无计量器具。" @retry="loadMeterSnapshot">
          <template #empty><strong class="panel-empty-value">0</strong><span>本地计量器具台账暂无记录。</span></template>
          <div class="meter-kpi"><strong>{{ formatInteger(meterPanel.data?.total) }}</strong><span>台账总数</span></div>
          <div class="meter-status-grid">
            <div><span>启用</span><strong>{{ formatInteger(meterPanel.data?.active) }}</strong><i><b :style="{ width: `${meterActivePercentage}%` }" /></i></div>
            <div><span>停用</span><strong>{{ formatInteger(meterPanel.data?.inactive) }}</strong><i><b class="meter-bar--inactive" :style="{ width: `${meterInactivePercentage}%` }" /></i></div>
          </div>
          <p class="boundary-note">“启用/停用”是台账维护状态；onlineStatus 即使存在也仅为本地字段，不代表实时设备在线。</p>
        </CockpitPanel>

        <CockpitPanel title="导入累计摘要" eyebrow="IMPORT SUMMARY" description="展示全历史导入批次和问题累计值，不随年度筛选变化；仅补充最新活动时间。" :status="importPanel.status" :error="importPanel.error" forbidden-text="需要 imports:view 权限；dashboard:view 不替代导入中心权限。" empty-text="当前没有导入批次或导入问题。" @retry="loadImportSnapshot">
          <template #empty><strong class="panel-empty-value">0</strong><span>当前没有导入批次或导入问题。</span></template>
          <div class="metric-row">
            <div><span>导入批次</span><strong>{{ formatInteger(importPanel.data?.imports?.batchCount) }}</strong></div>
            <div><span>成功写入</span><strong>{{ formatInteger(importPanel.data?.imports?.importedRowCount) }}</strong></div>
            <div><span>失败 / 跳过行</span><strong>{{ formatInteger(importPanel.data?.imports?.failedRowCount) }} / {{ formatInteger(importPanel.data?.imports?.skippedRowCount) }}</strong></div>
            <div><span>阻断 / 警告</span><strong>{{ formatInteger(importPanel.data?.errors?.blockingErrorCount) }} / {{ formatInteger(importPanel.data?.errors?.warningCount) }}</strong></div>
          </div>
          <p class="boundary-note">最新活动时间：{{ formatDateTime(importPanel.data?.imports?.latestBatchAt) }}。以上数值为全历史导入累计摘要，不代表 {{ selectedYear }} 年发生的导入。</p>
        </CockpitPanel>

        <CockpitPanel title="碳资产" eyebrow="BOUNDARY" description="当前平台已接入碳核算结果，但尚未接入配额、履约、碳信用或交易资产台账。" status="success">
          <div class="not-connected-card"><span>尚未接入</span><strong>不显示伪零资产</strong><p>待未来明确资产台账、权限、核算边界和审计规则后再接入。</p></div>
        </CockpitPanel>
      </section>

      <nav class="cockpit-quick-links" aria-label="授权领域快捷入口">
        <div><span>AUTHORIZED LINKS</span><strong>模块快捷入口</strong><p>仅导航到当前账号有查看权限的领域页面，不替代服务端鉴权。</p></div>
        <div class="cockpit-quick-links__actions"><el-button v-for="item in quickLinks" :key="item.path" @click="goToModule(item.path)">{{ item.label }}</el-button><span v-if="!quickLinks.length">当前账号没有可用的领域快捷入口。</span></div>
      </nav>
    </template>
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
import {
  DASHBOARD_PANEL_STATUS,
  buildDashboardYearRange,
  buildEnergyTrendSeries,
  calculateZeroSafePercentage,
  createDashboardPanelState,
  groupEnergyRowsByUnit,
  isLatestDashboardRequest,
  projectBudgetWarningStatus,
  projectCarbonDashboardStats,
  resolveDashboardSummaryDomainState,
  settleDashboardPanelSuccess
} from '@/utils/dashboardCockpit';
import CockpitPanel from './CockpitPanel.vue';
import EnergyTrendChart from './EnergyTrendChart.vue';
import UnitBarChart from './UnitBarChart.vue';

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
/** 能源结构的单位安全分组。 */
const energyUnitGroups = computed(() => energyPanel.value.data?.unitGroups || []);
/** 当前能源趋势和结构共用的单位。 */
const selectedEnergyUnit = computed(() => selectedEnergySeries.value?.normalizedUnit || energyUnitGroups.value[0]?.unit || '');
/** 当前能源单位组。 */
const selectedEnergyUnitGroup = computed(() => energyUnitGroups.value.find((group) => group.unit === selectedEnergyUnit.value) || null);
/** 当前能源单位组的结构图行。 */
const energyStructureRows = computed(() => (selectedEnergyUnitGroup.value?.rows || []).map((row) => ({
  key: `${row.energyTypeCode}-${row.normalizedUnit}`,
  label: row.energyTypeName || row.energyTypeCode,
  value: Number(row.totalNormalizedValue) || 0,
  color: energyColor(row.energyTypeCode),
  detail: `${formatInteger(row.recordCount)} 条 active 记录`
})));
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
/** 当前碳排单位下按能源类型的真实已核算结构行。 */
const carbonStructureRows = computed(() => (carbonPanel.value.data?.stats?.byEnergyType || [])
  .filter((row) => row.emissionUnit === selectedCarbonUnit.value && Number(row.calculatedCount || 0) > 0)
  .map((row) => ({
    key: `${row.energyTypeCode}-${row.emissionUnit}`,
    label: row.energyTypeName || row.energyTypeCode,
    value: Number(row.totalEmissionValue) || 0,
    color: energyColor(row.energyTypeCode),
    detail: `${formatInteger(row.calculatedCount)} 条已计算结果，因子缺失 ${formatInteger(row.missingFactorCount)} 条`
  })));
/** 用能预算预警投影。 */
const budgetProjection = computed(() => projectBudgetWarningStatus(budgetPanel.value.data?.rows || []));
/** 计量器具启用比例。 */
const meterActivePercentage = computed(() => calculateZeroSafePercentage(meterPanel.value.data?.active, meterPanel.value.data?.total));
/** 计量器具停用比例。 */
const meterInactivePercentage = computed(() => calculateZeroSafePercentage(meterPanel.value.data?.inactive, meterPanel.value.data?.total));

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

/** 格式化服务端或本地更新时间。 */
function formatDateTime(value) {
  if (!value) return '尚未成功更新';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/** 返回项目既有能源类型固定颜色。 */
function energyColor(energyTypeCode) {
  return ENERGY_TYPE_COLORS[energyTypeCode] || ENERGY_TYPE_COLORS.other;
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
  const [summaryResult, trendResult, breakdownResult] = await Promise.all([
    safeRequest(() => getDashboardSummary(params)),
    safeRequest(() => getDashboardEnergyTrend(params)),
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
  const trendRows = trendResult.value.data || [];
  const breakdownRows = breakdownResult.value.data || [];
  const totals = Array.isArray(summary.energy?.totals) ? summary.energy.totals : breakdownRows;
  const series = buildEnergyTrendSeries(trendRows);
  const unitGroups = groupEnergyRowsByUnit(totals);
  const data = { summary, series, unitGroups };
  energyPanel.value = settleDashboardPanelSuccess(data, summaryDomainState.status === DASHBOARD_PANEL_STATUS.EMPTY);
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
  const result = await safeRequest(() => getCarbonEmissionStats(params));
  if (!isLatestDashboardRequest(version, requestVersion.value)) return;
  if (!result.ok) {
    carbonPanel.value = createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, requestError(result));
    return;
  }
  const stats = result.value.data || {};
  const projection = projectCarbonDashboardStats(stats);
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

/** 返回预算比较行的稳定键。 */
function budgetRowKey(row) {
  return `${row.periodMonth}-${row.energyTypeCode}-${row.organizationScope}-${row.budgetUnit || row.unit || 'none'}-${row.actualUnit || 'none'}-${row.comparisonStatus || row.warningLevel || 'normal'}`;
}

/** 返回预算比较状态的驾驶舱可读文本。 */
function budgetWarningLabel(row) {
  if (row.dashboardWarningLevel === 'unit_mismatch' || row.comparisonStatus === 'unit_mismatch') return '单位不一致 / 不可比较';
  return row.warningLabel || row.warningReason || '正常';
}

/** 返回预算使用率或不可比较口径。 */
function budgetUsageLabel(row) {
  if (row.dashboardWarningLevel === 'unit_mismatch' || row.comparisonStatus === 'unit_mismatch') {
    return `预算 ${formatNumber(row.budgetValue, 2)} ${row.budgetUnit || row.unit || '—'}；实际 ${formatNumber(row.actualValue, 2)} ${row.actualUnit || '—'}`;
  }
  if (row.isComparable === false || row.usageRate === null || row.usageRate === undefined) return row.warningReason || '暂无可比使用率';
  return `使用率 ${formatNumber(Number(row.usageRate) * 100, 1)}%`;
}

/** 响应浏览器全屏变化；Escape 或系统退出全屏时同步清理沉浸模式。 */
function handleFullscreenChange() {
  fullscreenActive.value = Boolean(document.fullscreenElement);
  if (fullscreenActive.value) {
    fullscreenWasEntered.value = true;
    return;
  }
  if (fullscreenWasEntered.value && appStore.immersiveMode) appStore.setImmersiveMode(false);
  fullscreenWasEntered.value = false;
}

/** 响应 Escape，清理被拒绝全屏后仍保留的纯沉浸模式。 */
function handleEscape(event) {
  if (event.key !== 'Escape' || !appStore.immersiveMode) return;
  appStore.setImmersiveMode(false);
  if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen();
}

/** 在用户手势内进入沉浸模式并请求浏览器全屏。 */
async function enterImmersiveMode() {
  appStore.setImmersiveMode(true);
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
  fullscreenWasEntered.value = false;
  if (!document.fullscreenElement || !document.exitFullscreen) return;
  try {
    await document.exitFullscreen();
  } catch (error) {
    ElMessage.warning('浏览器全屏退出失败，请按 Escape 退出。');
  }
}

/** 切换驾驶舱大屏模式。 */
function toggleImmersiveMode() {
  if (appStore.immersiveMode) exitImmersiveMode();
  else enterImmersiveMode();
}

/** 离开驾驶舱时清理沉浸模式和浏览器全屏。 */
function cleanupImmersiveMode() {
  appStore.setImmersiveMode(false);
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
/* 普通模式沿用平台浅色管理界面变量，沉浸模式仅在 is-immersive 下覆盖为科技风。 */
.cockpit-root{--cockpit-surface:#fff;--cockpit-surface-subtle:#f8fbff;--cockpit-surface-emphasis:#edf5ff;--cockpit-border:#dce9fb;--cockpit-chart-border:#e1e0d9;--cockpit-table-border:#dce9fb;--cockpit-text:#183153;--cockpit-heading:#123b79;--cockpit-muted:#6d809e;--cockpit-accent:#1769e0;--cockpit-focus:#1769e0;--cockpit-chart-bg:#fcfcfb;--cockpit-gridline:#e1e0d9;--cockpit-axis:#898781;--cockpit-track:#e7f1ff;--cockpit-hover-bg:#f7fbff;--cockpit-tooltip-bg:#edf5ff;--cockpit-tooltip-border:#c9dcf5;--cockpit-mark-border:rgba(11,11,11,.1);--cockpit-panel-padding:20px;--cockpit-panel-radius:14px;--cockpit-panel-shadow:0 10px 28px rgba(30,91,180,.07);--cockpit-panel-highlight:#1769e0;--cockpit-panel-highlight-width:100%;--cockpit-panel-highlight-height:3px;--cockpit-danger:#c24156;--cockpit-danger-text:#9f3348;display:grid;gap:16px;min-width:0;color:var(--cockpit-text)}.cockpit-root.is-immersive{--cockpit-surface:linear-gradient(145deg,rgba(8,30,58,.96),rgba(6,22,45,.94));--cockpit-surface-subtle:rgba(3,18,38,.52);--cockpit-surface-emphasis:rgba(10,31,57,.72);--cockpit-border:rgba(56,189,248,.18);--cockpit-chart-border:rgba(56,189,248,.12);--cockpit-table-border:rgba(148,184,218,.14);--cockpit-text:#e5f4ff;--cockpit-heading:#e6f4ff;--cockpit-muted:#8eabc8;--cockpit-accent:#38bdf8;--cockpit-focus:#7dd3fc;--cockpit-chart-bg:rgba(2,12,28,.44);--cockpit-gridline:rgba(148,184,218,.16);--cockpit-axis:#87a7c6;--cockpit-track:rgba(95,139,181,.16);--cockpit-hover-bg:rgba(56,189,248,.07);--cockpit-tooltip-bg:rgba(3,18,38,.82);--cockpit-tooltip-border:rgba(56,189,248,.24);--cockpit-mark-border:rgba(125,211,252,.24);--cockpit-panel-padding:18px;--cockpit-panel-radius:18px;--cockpit-panel-shadow:0 16px 40px rgba(0,8,24,.28),inset 0 1px rgba(255,255,255,.04);--cockpit-panel-highlight:linear-gradient(90deg,#38bdf8,transparent);--cockpit-panel-highlight-width:42%;--cockpit-panel-highlight-height:2px;--cockpit-danger:#fda4af;--cockpit-danger-text:#fecdd3;display:block;min-height:100vh;padding:24px 30px;box-sizing:border-box;background-color:#020b18;background-image:linear-gradient(rgba(34,107,166,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(34,107,166,.07) 1px,transparent 1px),radial-gradient(circle at 15% 0,rgba(14,116,144,.24),transparent 38%),radial-gradient(circle at 90% 12%,rgba(30,64,175,.22),transparent 34%);background-size:36px 36px,36px 36px,auto,auto}
.cockpit-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:20px;border:1px solid var(--cockpit-border);border-radius:14px;background:#fff;box-shadow:0 10px 28px rgba(30,91,180,.07)}.is-immersive .cockpit-hero{padding:20px 22px;border-radius:18px;background:linear-gradient(120deg,rgba(6,29,58,.96),rgba(4,19,40,.86));box-shadow:0 20px 46px rgba(0,8,24,.28)}.cockpit-kicker{display:block;margin-bottom:6px;color:var(--cockpit-accent);font-size:10px;font-weight:700;letter-spacing:.18em}.cockpit-hero h1{margin:0;color:var(--cockpit-heading);font-size:28px;letter-spacing:.02em}.is-immersive .cockpit-hero h1{font-size:30px;letter-spacing:.06em}.cockpit-hero p{max-width:780px;margin:9px 0 0;color:var(--cockpit-muted);font-size:13px;line-height:1.7}.cockpit-controls{display:flex;align-items:flex-end;justify-content:flex-end;gap:10px}.year-control{display:grid;gap:6px;color:var(--cockpit-muted);font-size:11px}.year-control :deep(.el-select){width:126px}.cockpit-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 18px;padding-top:13px;border-top:1px solid var(--cockpit-table-border);color:var(--cockpit-muted);font-size:11px}.cockpit-meta span::before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:var(--cockpit-accent)}.is-immersive .cockpit-meta span::before{box-shadow:0 0 9px rgba(34,211,238,.72)}
.cockpit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.is-immersive .cockpit-grid{gap:12px;margin-top:12px}.panel-select{width:220px}.panel-select--small{width:130px}.metric-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}.metric-row--compact{grid-template-columns:repeat(3,minmax(0,1fr))}.metric-row>div{min-width:0;padding:12px;border:1px solid var(--cockpit-border);border-radius:12px;background:var(--cockpit-surface-subtle)}.metric-row span{display:block;color:var(--cockpit-muted);font-size:11px}.metric-row strong{display:block;margin-top:7px;color:var(--cockpit-heading);font-size:19px;font-variant-numeric:tabular-nums}.metric-row small{color:var(--cockpit-accent);font-size:11px}.visual-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.85fr);gap:16px}
.warning-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:12px;border:1px solid var(--cockpit-border);border-radius:12px;background:var(--cockpit-surface-subtle)}.warning-summary>div{padding:8px;border-right:1px solid var(--cockpit-table-border)}.warning-summary>div:last-child{border-right:0}.warning-summary span{display:block;color:var(--cockpit-muted);font-size:11px}.warning-summary strong{display:block;margin-top:5px;color:var(--cockpit-heading);font-size:22px}.warning-summary--unit_mismatch{border-color:#e9a06f}.warning-summary--exceeded{border-color:#e9a1ad}.warning-summary--missing_budget,.warning-summary--nearing{border-color:#e5c46c}.is-immersive .warning-summary--unit_mismatch{border-color:rgba(249,115,22,.42)}.is-immersive .warning-summary--exceeded{border-color:rgba(251,113,133,.34)}.is-immersive .warning-summary--missing_budget,.is-immersive .warning-summary--nearing{border-color:rgba(251,191,36,.32)}.warning-list{display:grid;gap:8px;margin-top:14px}.warning-item{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--cockpit-table-border);border-radius:9px;background:var(--cockpit-surface-subtle)}.is-immersive .warning-item{border-color:transparent;background:var(--cockpit-surface-emphasis)}.warning-item div{display:grid;gap:3px}.warning-item strong{color:var(--cockpit-heading);font-size:12px}.warning-item span{color:var(--cockpit-muted);font-size:11px}.status-dot{flex:0 0 auto;width:9px;height:9px;margin-top:3px;border-radius:50%;background:#2a78d6}.status-dot--exceeded{background:#d9475f}.status-dot--nearing{background:#c88a0a}.status-dot--missing_budget{background:#d66a16}.status-dot--unit_mismatch{background:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.16)}.is-immersive .status-dot{background:#60a5fa}.is-immersive .status-dot--exceeded{background:#fb7185}.is-immersive .status-dot--nearing{background:#fbbf24}.is-immersive .status-dot--missing_budget{background:#f97316}.is-immersive .status-dot--unit_mismatch{background:#fb923c;box-shadow:0 0 0 2px rgba(251,146,60,.2)}
.metric-row .metric-gap-text{color:#a16207;font-size:15px}.is-immersive .metric-row .metric-gap-text{color:#fbbf24}.carbon-gap-state{display:grid;min-height:180px;place-content:center;gap:8px;padding:18px;border:1px dashed #e5c46c;border-radius:12px;background:#fff9e9;text-align:center}.carbon-gap-state strong{color:#8a5a00;font-size:17px}.carbon-gap-state span{max-width:520px;color:#75613b;font-size:12px;line-height:1.7}.is-immersive .carbon-gap-state{border-color:rgba(251,191,36,.38);background:rgba(120,53,15,.1)}.is-immersive .carbon-gap-state strong{color:#fde68a}.is-immersive .carbon-gap-state span{color:#d6bd8b}.success-note,.boundary-note{margin:14px 0 0;color:var(--cockpit-muted);font-size:12px;line-height:1.7}.success-note{color:#178447}.is-immersive .success-note{color:#86efac}.data-details{margin-top:12px;color:var(--cockpit-muted);font-size:12px}.data-details summary{cursor:pointer;color:var(--cockpit-accent)}.table-scroll{max-width:100%;overflow-x:auto}.data-details table{width:100%;margin-top:10px;border-collapse:collapse;white-space:nowrap}.data-details th,.data-details td{padding:8px;border-bottom:1px solid var(--cockpit-table-border);color:var(--cockpit-text);text-align:left}.data-details th{color:var(--cockpit-heading)}
.meter-kpi{display:flex;align-items:flex-end;gap:10px}.meter-kpi strong{color:var(--cockpit-heading);font-size:42px;line-height:1;font-variant-numeric:tabular-nums}.meter-kpi span{color:var(--cockpit-muted);font-size:12px}.meter-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}.meter-status-grid>div{padding:12px;border:1px solid var(--cockpit-border);border-radius:11px;background:var(--cockpit-surface-subtle)}.meter-status-grid span{color:var(--cockpit-muted);font-size:11px}.meter-status-grid strong{float:right;color:var(--cockpit-heading)}.meter-status-grid i{display:block;clear:both;height:8px;margin-top:12px;border-radius:999px;background:var(--cockpit-track);overflow:hidden}.meter-status-grid b{display:block;height:100%;border-radius:999px;background:#22c55e}.meter-status-grid .meter-bar--inactive{background:#64748b}.not-connected-card{display:grid;min-height:180px;place-content:center;text-align:center}.not-connected-card>span{justify-self:center;padding:5px 11px;border:1px solid var(--cockpit-border);border-radius:999px;color:var(--cockpit-accent);font-size:11px}.not-connected-card strong{margin-top:12px;color:var(--cockpit-heading);font-size:23px}.not-connected-card p{max-width:360px;margin:10px 0 0;color:var(--cockpit-muted);font-size:12px;line-height:1.7}
.cockpit-quick-links{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 20px;border:1px solid var(--cockpit-border);border-radius:14px;background:#fff;box-shadow:0 10px 28px rgba(30,91,180,.07)}.is-immersive .cockpit-quick-links{margin-top:12px;border-radius:16px;background:rgba(5,24,48,.9);box-shadow:none}.cockpit-quick-links>div:first-child{display:grid;gap:4px}.cockpit-quick-links>div:first-child span{color:var(--cockpit-accent);font-size:9px;font-weight:700;letter-spacing:.14em}.cockpit-quick-links strong{color:var(--cockpit-heading);font-size:15px}.cockpit-quick-links p{margin:0;color:var(--cockpit-muted);font-size:11px}.cockpit-quick-links__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.cockpit-quick-links__actions>span{color:var(--cockpit-muted);font-size:12px}.panel-empty-value{color:var(--cockpit-accent)!important;font-size:40px!important;font-variant-numeric:tabular-nums}
/* Element Plus 深色覆盖只作用于沉浸模式，普通模式保留平台全局主题。 */
.cockpit-root.is-immersive :deep(.el-button){border-color:rgba(83,178,229,.32);background:rgba(8,34,66,.82);color:#ccecff}.cockpit-root.is-immersive :deep(.el-button:hover),.cockpit-root.is-immersive :deep(.el-button:focus-visible){border-color:#38bdf8;background:rgba(14,74,119,.74);color:#fff}.cockpit-root.is-immersive :deep(.el-button--primary){border-color:#0ea5e9;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff}.cockpit-root.is-immersive :deep(.el-select__wrapper){border:1px solid rgba(56,189,248,.24);background:rgba(3,18,38,.82);box-shadow:none}.cockpit-root.is-immersive :deep(.el-select__selected-item),.cockpit-root.is-immersive :deep(.el-select__placeholder){color:#d7efff}.cockpit-root.is-immersive :deep(.el-skeleton__item){background:linear-gradient(90deg,rgba(34,78,119,.26) 25%,rgba(43,99,146,.34) 37%,rgba(34,78,119,.26) 63%);background-size:400% 100%}
@media (max-width:1200px){.visual-grid{grid-template-columns:1fr}.metric-row{grid-template-columns:repeat(2,minmax(0,1fr))}.warning-summary{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:960px){.cockpit-grid{grid-template-columns:1fr}.cockpit-hero{grid-template-columns:1fr}.cockpit-controls{justify-content:flex-start}.cockpit-quick-links{align-items:flex-start;flex-direction:column}.cockpit-quick-links__actions{justify-content:flex-start}.cockpit-root.is-immersive{padding:18px}}@media (max-width:640px){.cockpit-root.is-immersive{padding:12px}.cockpit-hero{padding:17px}.cockpit-controls{align-items:stretch;flex-direction:column}.year-control :deep(.el-select),.panel-select,.panel-select--small{width:100%}.metric-row,.metric-row--compact,.warning-summary,.meter-status-grid{grid-template-columns:1fr}.warning-summary>div{border-right:0;border-bottom:1px solid var(--cockpit-table-border)}.warning-summary>div:last-child{border-bottom:0}}@media (prefers-reduced-motion:reduce){.cockpit-root :deep(.el-skeleton__item){animation:none!important}}
</style>
