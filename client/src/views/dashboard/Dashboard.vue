<template>
  <ManagementPage title="工作台">
    <template #title-extra><HelpIcon label="查看工作台数据口径" :content="scopeNotice" /></template>
    <PageState v-if="!canView" description="当前账号没有查看工作台的权限。请联系管理员授予 dashboard:view 权限。" />
    <template v-else>
      <el-alert type="info" :closable="false" show-icon :title="scopeNotice" />
      <el-alert v-if="partialFailure" type="warning" :closable="false" show-icon title="部分概览卡读取失败，失败卡已明确标示，未以 0 或演示数据替代。" class="panel-alert" />
      <PageState v-if="allFailed" :error="pageError" @retry="loadDashboard" />
      <template v-else>
        <section class="stat-grid" aria-label="工作台真实数据概览">
          <StatCard label="Active 能耗记录" :value="number(summary.energy?.activeRecordCount)" :note="monthRange" />
          <StatCard label="导入批次" :value="number(summary.imports?.batchCount)" :note="`成功行 ${number(summary.imports?.importedRowCount)}`" />
          <StatCard label="导入问题" :value="number(summary.errors?.importErrorCount)" :note="`阻断 ${number(summary.errors?.blockingErrorCount)} / warning ${number(summary.errors?.warningCount)}`" />
          <StatCard label="预算记录" :value="budgetError ? '读取失败' : number(budgetStats.totalBudgets)" :note="budgetError || '仅在有预算查看权限时读取'" />
        </section>

        <section class="chart-grid">
          <article class="page-card chart-panel">
            <header class="chart-heading"><div><h2>月度能耗记录趋势</h2><span>真实记录数 · 单一数值轴</span></div><el-button text :loading="loading" @click="loadDashboard">刷新</el-button></header>
            <PageState v-if="trendError" :error="trendError" @retry="loadDashboard" />
            <PageState v-else-if="!trendRows.length" description="当前筛选范围暂无能耗记录趋势" />
            <template v-else>
              <svg class="trend-chart" viewBox="0 0 640 270" role="img" aria-label="月度能耗记录数趋势折线图" @mouseleave="trendTooltip = null">
                <line v-for="tick in 5" :key="tick" x1="52" :y1="44 + (tick - 1) * 38" x2="616" :y2="44 + (tick - 1) * 38" class="grid-line" />
                <text v-for="tick in 5" :key="`tick-${tick}`" x="44" :y="48 + (tick - 1) * 38" text-anchor="end" class="axis-text">{{ number(maxCount * (1 - (tick - 1) / 4), 0) }}</text>
                <polyline :points="linePoints" class="trend-line" />
                <g v-for="(row, index) in trendRows" :key="row.month" class="trend-point" tabindex="0" role="button" :aria-label="trendLabel(row)" @mouseenter="trendTooltip = row" @focus="trendTooltip = row"><circle :cx="xFor(index, trendRows.length)" :cy="yFor(row.recordCount)" r="12" class="point-hit" /><circle :cx="xFor(index, trendRows.length)" :cy="yFor(row.recordCount)" r="4" class="point-dot" /></g>
                <text v-for="(row, index) in trendRows" :key="`month-${row.month}`" :x="xFor(index, trendRows.length)" y="244" text-anchor="middle" class="axis-text">{{ row.month }}</text>
              </svg>
              <p v-if="trendTooltip" class="chart-tooltip" role="status">{{ trendLabel(trendTooltip) }}</p>
              <el-table :data="trendRows" size="small" class="chart-table"><el-table-column prop="month" label="月份" /><el-table-column label="记录数"><template #default="{ row }">{{ number(row.recordCount) }}</template></el-table-column></el-table>
            </template>
          </article>

          <article class="page-card chart-panel">
            <header class="chart-heading"><div><h2>能源类型记录结构</h2><span>固定实体颜色 · 记录数</span></div></header>
            <PageState v-if="breakdownError" :error="breakdownError" @retry="loadDashboard" />
            <PageState v-else-if="!breakdownRows.length" description="当前范围暂无能源类型结构" />
            <template v-else>
              <div class="bar-legend" aria-label="能源类型图例"><span v-for="row in breakdownRows" :key="row.energyTypeCode"><i :style="{ backgroundColor: colorFor(row.energyTypeCode) }" />{{ row.energyTypeName || row.energyTypeCode }}</span></div>
              <div class="bar-chart" @mouseleave="breakdownTooltip = null"><button v-for="row in breakdownRows" :key="row.energyTypeCode" type="button" class="bar-row" :aria-label="breakdownLabel(row)" @mouseenter="breakdownTooltip = row" @focus="breakdownTooltip = row"><span>{{ row.energyTypeName || row.energyTypeCode }}</span><span class="bar-track"><i class="bar-fill" :style="{ width: `${percentage(row.recordCount, maxBreakdownCount)}%`, backgroundColor: colorFor(row.energyTypeCode) }" /></span><strong>{{ number(row.recordCount) }}</strong></button></div>
              <p v-if="breakdownTooltip" class="chart-tooltip" role="status">{{ breakdownLabel(breakdownTooltip) }}</p>
              <el-table :data="breakdownRows" size="small" class="chart-table"><el-table-column prop="energyTypeName" label="能源类型" /><el-table-column label="记录数"><template #default="{ row }">{{ number(row.recordCount) }}</template></el-table-column><el-table-column label="月份"><template #default="{ row }">{{ row.monthStart || '—' }} 至 {{ row.monthEnd || '—' }}</template></el-table-column></el-table>
            </template>
          </article>
        </section>

        <article class="page-card">
          <header class="chart-heading"><div><h2>模块快捷入口</h2><span>仅显示当前账号有查看权限的模块；不以快捷入口替代服务端鉴权。</span></div></header>
          <div class="quick-links"><el-button v-for="item in quickLinks" :key="item.path" @click="go(item.path)">{{ item.label }}</el-button><el-empty v-if="!quickLinks.length" description="当前账号没有可用的模块快捷入口。" /></div>
        </article>
      </template>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ManagementPage from '@/components/ManagementPage.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import { getDashboardBudgetStats, getDashboardEnergyBreakdown, getDashboardEnergyTrend, getDashboardSummary } from '@/api/dashboard';
import { ENERGY_TYPE_COLORS, aggregateMonthlyTrend } from '@/utils/energyStatistics';
import { chartPercentage, dashboardScopeNotice } from '@/utils/specialModules';
import { hasPermi } from '@/utils/permission';

// 工作台请求与显示状态。
const router = useRouter(); const loading = ref(false); const summary = ref({}); const budgetStats = ref({}); const trendRows = ref([]); const breakdownRows = ref([]); const summaryError = ref(''); const trendError = ref(''); const breakdownError = ref(''); const budgetError = ref(''); const trendTooltip = ref(null); const breakdownTooltip = ref(null);
const safe = async (task) => { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } };
const errorText = (result) => result?.error?.message || '接口请求失败。';
const canView = computed(() => hasPermi('dashboard:view'));
const canBudgetView = computed(() => hasPermi('energy:budget:view'));
const scopeNotice = computed(() => dashboardScopeNotice(summary.value));
const allFailed = computed(() => Boolean(summaryError.value && trendError.value && breakdownError.value));
const partialFailure = computed(() => Boolean(summaryError.value || trendError.value || breakdownError.value || budgetError.value));
const pageError = computed(() => summaryError.value || trendError.value || breakdownError.value || budgetError.value);
const monthRange = computed(() => { const range = summary.value.energy?.monthRange || {}; return range.start && range.end ? `${range.start} 至 ${range.end}` : '暂无数据范围'; });
const maxCount = computed(() => Math.max(...trendRows.value.map((row) => Number(row.recordCount) || 0), 1));
const maxBreakdownCount = computed(() => Math.max(...breakdownRows.value.map((row) => Number(row.recordCount) || 0), 1));
const linePoints = computed(() => trendRows.value.map((row, index) => `${xFor(index, trendRows.value.length)},${yFor(row.recordCount)}`).join(' '));
const quickLinks = computed(() => [
  hasPermi('imports:view') && { label: '数据导入', path: '/imports' },
  hasPermi(['energy:records:view', 'energy-records:view']) && { label: '能耗统计', path: '/energy/statistics' },
  canBudgetView.value && { label: '用能预算', path: '/energy/budgets' },
  hasPermi('system:backup:view') && { label: '备份恢复', path: '/system/backups' }
].filter(Boolean));

/** 格式化真实数值，不伪造缺失数值。 */
function number(value, digits = 0) { const input = Number(value); return Number.isFinite(input) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(input) : '—'; }
/** 计算单轴趋势图的横坐标。 */
function xFor(index, total) { return total <= 1 ? 334 : 62 + (index * 544) / (total - 1); }
/** 计算单轴趋势图的纵坐标。 */
function yFor(value) { return 196 - ((Number(value) || 0) / maxCount.value) * 152; }
/** 返回实体固定颜色。 */
function colorFor(code) { return ENERGY_TYPE_COLORS[code] || ENERGY_TYPE_COLORS.other; }
/** 返回不伪造零值的条形比例。 */
function percentage(value, maximum) { return chartPercentage(value, maximum); }
/** 生成趋势图 tooltip 文本。 */
function trendLabel(row) { return `${row.month}：${number(row.recordCount)} 条真实能耗记录`; }
/** 生成结构图 tooltip 文本。 */
function breakdownLabel(row) { return `${row.energyTypeName || row.energyTypeCode}：${number(row.recordCount)} 条记录，数据范围 ${row.monthStart || '—'} 至 ${row.monthEnd || '—'}`; }
/** 跳转到授权可见的模块路由。 */
function go(path) { router.push(path); }
/** 分卡并发读取工作台数据，任何一张卡失败都保留其真实失败状态。 */
async function loadDashboard() {
  loading.value = true;
  const tasks = [safe(getDashboardSummary), safe(getDashboardEnergyTrend), safe(getDashboardEnergyBreakdown), canBudgetView.value ? safe(getDashboardBudgetStats) : Promise.resolve({ ok: true, value: { data: {} } })];
  const [summaryResult, trendResult, breakdownResult, budgetResult] = await Promise.all(tasks);
  loading.value = false;
  if (summaryResult.ok) { summary.value = summaryResult.value.data || {}; summaryError.value = ''; } else { summary.value = {}; summaryError.value = errorText(summaryResult); }
  if (trendResult.ok) { trendRows.value = aggregateMonthlyTrend(trendResult.value.data || []).slice(-24); trendError.value = ''; } else { trendRows.value = []; trendError.value = errorText(trendResult); }
  if (breakdownResult.ok) { breakdownRows.value = trendResult.ok ? (breakdownResult.value.data || []) : (breakdownResult.value.data || []); breakdownError.value = ''; } else { breakdownRows.value = []; breakdownError.value = errorText(breakdownResult); }
  if (canBudgetView.value && !budgetResult.ok) { budgetError.value = errorText(budgetResult); } else { budgetStats.value = budgetResult.value?.data || {}; budgetError.value = ''; }
}

onMounted(() => { if (canView.value) loadDashboard(); });
</script>

<style scoped>
.stat-grid,.chart-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.chart-grid{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:16px}.page-card{margin-top:16px}.chart-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.chart-heading h2{margin:0;color:#123b79;font-size:16px}.chart-heading span{color:#7385a2;font-size:12px}.panel-alert{margin-top:12px}.trend-chart{width:100%;min-height:270px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:10px}.grid-line{stroke:#e1e0d9}.axis-text{fill:#7385a2;font-size:11px}.trend-line{fill:none;stroke:#2a78d6;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.point-hit{fill:transparent}.point-dot{fill:#2a78d6;stroke:#fcfcfb;stroke-width:2}.trend-point{cursor:pointer}.trend-point:focus{outline:none}.trend-point:focus .point-dot,.trend-point:hover .point-dot{r:6}.chart-tooltip{margin:8px 0;padding:8px 10px;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;color:#183153}.chart-table{margin-top:10px;width:100%}.bar-legend{display:flex;flex-wrap:wrap;gap:8px 12px;margin-bottom:10px;font-size:12px;color:#516170}.bar-legend span{display:inline-flex;align-items:center;gap:5px}.bar-legend i{width:10px;height:10px;border-radius:2px}.bar-chart{display:grid;gap:9px}.bar-row{display:grid;grid-template-columns:minmax(96px,1fr) minmax(120px,2fr) 50px;gap:8px;align-items:center;border:0;border-radius:6px;background:transparent;color:#183153;text-align:left;padding:5px}.bar-row:focus-visible{outline:2px solid #1769e0}.bar-track{height:14px;background:#e7f1ff;border-radius:999px}.bar-fill{display:block;height:14px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.quick-links{display:flex;flex-wrap:wrap;gap:10px}@media (max-width:1120px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.chart-grid{grid-template-columns:1fr}}@media (max-width:720px){.stat-grid{grid-template-columns:1fr}.chart-panel{overflow-x:auto}.trend-chart{min-width:620px}.bar-row{grid-template-columns:1fr}.chart-heading{align-items:flex-start;flex-direction:column}}
</style>
