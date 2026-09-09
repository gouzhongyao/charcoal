<template>
  <ManagementPage title="能耗统计">
    <template #title-extra><HelpIcon label="查看统计口径与台账回填说明" content="统计只读取 active energy_records。跨能源类型的标准化值合计仅作快速摘要；精确比较请查看能源类型结构。台账回填需要先预演，再以固定确认文本执行。" /></template>

    <ManagementToolbar :loading="loading" @search="applyFilters" @reset="resetFilters">
      <el-form-item label="开始月份"><el-date-picker v-model="draftFilters.normalizedMonthStart" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="开始月份" /></el-form-item>
      <el-form-item label="结束月份"><el-date-picker v-model="draftFilters.normalizedMonthEnd" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="结束月份" /></el-form-item>
      <el-form-item label="能源类型"><el-select v-model="draftFilters.energyTypeCode" clearable placeholder="全部能源类型"><el-option v-for="item in energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
      <el-form-item label="用能单元编码（精确）"><el-input v-model.trim="draftFilters.organizationUnitCode" clearable placeholder="例如 QL-ACTUAL-PARK 或 QL-PARK" /></el-form-item>
      <el-form-item label="字符搜索"><el-input v-model.trim="draftFilters.keyword" clearable placeholder="能源、组织、仪表或备注" /></el-form-item>
    </ManagementToolbar>

    <el-alert v-if="energyTypesError" type="warning" :closable="false" show-icon :title="`能源类型字典读取失败：${energyTypesError}`" />
    <PageState v-if="allRequestsFailed" :error="pageError" @retry="loadData" />
    <template v-else>
      <section class="stat-grid" aria-label="能耗汇总指标">
        <StatCard label="记录数" :value="formatInteger(summary.recordCount)" :note="`来源批次 ${formatInteger(summary.sourceBatchCount)}`" />
        <StatCard label="标准化合计" :value="formatNumber(summary.totalNormalizedValue)" note="跨能源类型仅作摘要" />
        <StatCard label="能源类型数" :value="formatInteger(summary.energyTypeCount)" :note="`组织 ${formatInteger(summary.organizationCount)}`" />
        <StatCard label="月份范围" :value="monthRange" note="来自 active 能耗明细" />
      </section>
      <el-alert v-if="summary.mixedUnitNotice" type="info" :closable="false" show-icon :title="summary.mixedUnitNotice" />

      <section class="chart-grid">
        <article class="page-card chart-panel">
          <header class="chart-heading"><h2>月度标准化值趋势</h2><span>单序列 · 最近 {{ visibleTrend.length }} 月</span></header>
          <PageState v-if="trendError" :error="trendError" @retry="loadData" />
          <PageState v-else-if="!visibleTrend.length" description="暂无趋势数据" />
          <template v-else>
            <div class="trend-chart-scroll">
              <svg class="trend-chart" viewBox="0 0 640 270" role="img" aria-label="月度标准化值趋势折线图" @mouseleave="trendTooltip = null">
                <line v-for="tick in 5" :key="tick" x1="52" :y1="44 + (tick - 1) * 38" x2="616" :y2="44 + (tick - 1) * 38" class="grid-line" />
                <text v-for="tick in 5" :key="`label-${tick}`" x="44" :y="48 + (tick - 1) * 38" text-anchor="end" class="axis-text">{{ formatNumber(trendMax * (1 - (tick - 1) / 4), 0) }}</text>
                <polyline :points="linePoints" class="trend-line" />
                <g v-for="(row, index) in visibleTrend" :key="row.month" class="trend-point" tabindex="0" role="button" :aria-label="trendLabel(row)" @mouseenter="trendTooltip = row" @focus="trendTooltip = row">
                  <circle :cx="xFor(index, visibleTrend.length)" :cy="yFor(row.totalNormalizedValue)" r="12" class="point-hit" />
                  <circle :cx="xFor(index, visibleTrend.length)" :cy="yFor(row.totalNormalizedValue)" r="4" class="point-dot" />
                </g>
                <text v-for="tick in trendAxisTicks" :key="`month-${tick.month}`" :x="xFor(tick.index, visibleTrend.length)" y="231" text-anchor="middle" class="axis-text trend-axis-label">
                  <tspan :x="xFor(tick.index, visibleTrend.length)" dy="0">{{ tick.yearLabel }}</tspan>
                  <tspan :x="xFor(tick.index, visibleTrend.length)" dy="14">{{ tick.monthLabel }}</tspan>
                </text>
              </svg>
            </div>
            <p v-if="trendTooltip" class="chart-tooltip" role="status">{{ trendLabel(trendTooltip) }}</p>
            <el-table :data="visibleTrend" size="small" class="chart-table">
              <el-table-column prop="month" label="月份" min-width="92" />
              <el-table-column label="标准化值合计" min-width="140"><template #default="{ row }">{{ formatNumber(row.totalNormalizedValue) }}</template></el-table-column>
              <el-table-column label="记录数" min-width="90"><template #default="{ row }">{{ formatInteger(row.recordCount) }}</template></el-table-column>
            </el-table>
          </template>
        </article>

        <article class="page-card chart-panel">
          <header class="chart-heading"><h2>能源类型结构</h2><span>固定能源类型顺序</span></header>
          <PageState v-if="breakdownError" :error="breakdownError" @retry="loadData" />
          <PageState v-else-if="!typeBreakdown.length" description="暂无能源类型结构数据" />
          <template v-else>
            <div class="bar-chart" @mouseleave="breakdownTooltip = null">
              <button v-for="row in typeBreakdown" :key="row.energyTypeCode" class="bar-row" type="button" :aria-label="typeLabel(row)" @mouseenter="breakdownTooltip = row" @focus="breakdownTooltip = row">
                <span class="bar-name"><i :style="{ backgroundColor: colorForType(row.energyTypeCode) }" />{{ row.energyTypeName || row.energyTypeCode }}</span>
                <span class="bar-track"><span class="bar-fill" :style="{ width: `${percentage(row.totalNormalizedValue, typeMax)}%`, backgroundColor: colorForType(row.energyTypeCode) }" /></span>
                <span class="bar-value">{{ formatNumber(row.totalNormalizedValue) }} {{ row.normalizedUnit || '' }}</span>
              </button>
            </div>
            <p v-if="breakdownTooltip" class="chart-tooltip" role="status">{{ typeLabel(breakdownTooltip) }}</p>
            <el-table :data="typeBreakdown" size="small" class="chart-table">
              <el-table-column prop="energyTypeName" label="能源类型" min-width="120" />
              <el-table-column label="标准化值合计" min-width="145"><template #default="{ row }">{{ formatNumber(row.totalNormalizedValue) }} {{ row.normalizedUnit || '' }}</template></el-table-column>
              <el-table-column label="记录数" min-width="85"><template #default="{ row }">{{ formatInteger(row.recordCount) }}</template></el-table-column>
            </el-table>
          </template>
        </article>
      </section>

      <article class="page-card chart-panel">
        <header class="chart-heading"><div><h2>{{ dimensionLabel }}维度结构</h2><span>单序列条形图</span></div><el-radio-group v-model="dimension" size="small" @change="loadDimension"><el-radio-button label="organizationUnit">用能单元</el-radio-button><el-radio-button label="meterDevice">计量器具</el-radio-button></el-radio-group></header>
        <PageState v-if="dimensionLoading" loading />
        <PageState v-else-if="dimensionError" :error="dimensionError" @retry="loadDimension" />
        <PageState v-else-if="!dimensionRows.length" :description="`暂无${dimensionLabel}维度数据`" />
        <template v-else>
          <div class="bar-chart dimension-chart" @mouseleave="dimensionTooltip = null"><button v-for="row in dimensionRows" :key="row.dimensionValue" class="bar-row" type="button" :aria-label="dimensionLabelFor(row)" @mouseenter="dimensionTooltip = row" @focus="dimensionTooltip = row"><span class="bar-name">{{ row.dimensionValue }}</span><span class="bar-track"><span class="bar-fill single-bar" :style="{ width: `${percentage(row.totalNormalizedValue, dimensionMax)}%` }" /></span><span class="bar-value">{{ formatNumber(row.totalNormalizedValue) }}</span></button></div>
          <p v-if="dimensionTooltip" class="chart-tooltip" role="status">{{ dimensionLabelFor(dimensionTooltip) }}</p>
          <el-table :data="dimensionRows" size="small" class="chart-table"><el-table-column prop="dimensionValue" :label="dimensionLabel" min-width="150" /><el-table-column label="标准化值合计" min-width="150"><template #default="{ row }">{{ formatNumber(row.totalNormalizedValue) }}</template></el-table-column><el-table-column label="记录数" min-width="90"><template #default="{ row }">{{ formatInteger(row.recordCount) }}</template></el-table-column></el-table>
        </template>
      </article>

      <article class="page-card ledger-card">
        <header class="chart-heading"><div class="heading-with-help"><h2>历史能耗台账回填</h2><HelpIcon label="查看台账回填操作说明" content="预演只读；导出仅下载预演审计预案。执行需使用最新预演签名、候选记录、固定确认文本，并由后端创建备份和做最终校验。" /></div></header>
        <div class="action-row" v-if="canLedgerPreview"><el-button :loading="previewLoading" @click="loadPreview">运行预演</el-button><el-button :loading="exportLoading" @click="exportPreview">导出预演</el-button><el-button v-if="canLedgerExecute" type="danger" :disabled="!canExecuteBackfill" @click="executeDrawerOpen = true">受控执行回填</el-button></div>
        <el-alert v-else type="info" :closable="false" show-icon title="当前账号没有台账回填查看权限。" />
        <el-alert v-if="backfillError" type="error" :closable="false" show-icon :title="backfillError" class="panel-alert" />
        <template v-if="backfillPreview"><div class="preview-summary"><span>扫描 {{ formatInteger(backfillPreview.summary?.totalScanned) }} 条</span><span>可回填 {{ formatInteger(backfillPreview.summary?.wouldUpdate) }} 条</span><span>预演仅只读</span></div><el-table :data="backfillPreview.items || []" size="small" max-height="260"><el-table-column label="记录" min-width="180"><template #default="{ row }">#{{ row.recordId }} / {{ row.source?.normalizedMonth }} / {{ row.source?.energyTypeName || row.source?.energyTypeCode }}</template></el-table-column><el-table-column label="状态" min-width="130"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column><el-table-column label="候选" min-width="180"><template #default="{ row }">{{ candidateLabel(row) }}</template></el-table-column></el-table></template>
      </article>

      <article class="page-card"><header class="chart-heading"><div><h2>能耗明细</h2><span>只读分析</span></div><el-button v-if="canExportRecords" :loading="recordsExportLoading" @click="exportRecords">导出当前筛选</el-button></header><el-alert v-if="recordsExportError" type="error" :closable="false" show-icon :title="recordsExportError" class="panel-alert" /><PageState v-if="recordsError" :error="recordsError" @retry="loadData" /><template v-else><el-table :data="records" v-loading="loading" stripe><el-table-column prop="normalizedMonth" label="月份" width="100" /><el-table-column prop="energyTypeName" label="能源类型" min-width="120" /><el-table-column label="标准化值" min-width="140"><template #default="{ row }">{{ formatNumber(row.normalizedValue) }} {{ row.normalizedUnit }}</template></el-table-column><el-table-column label="原始值" min-width="140"><template #default="{ row }">{{ formatNumber(row.originalValue) }} {{ row.originalUnit }}</template></el-table-column><el-table-column prop="organization" label="组织" min-width="120" show-overflow-tooltip /><el-table-column prop="department" label="部门" min-width="110" show-overflow-tooltip /><el-table-column label="台账关联" min-width="130"><template #default="{ row }"><StatusTag :status="row.ledgerAssociationStatus" :label="ledgerAssociationLabel(row)" /></template></el-table-column><el-table-column prop="sourceBatchId" label="来源批次" width="100" /></el-table><div class="pagination"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20, 50, 100]" :total="pagination.total || 0" @current-change="loadData" @size-change="changePageSize" /></div></template></article>
    </template>

    <ManagementDrawer v-model="executeDrawerOpen" title="确认历史能耗台账回填" confirm-label="确认执行" :loading="executeLoading" :confirm-disabled="confirmText !== LEDGER_BACKFILL_CONFIRM_TEXT" @save="executeBackfill"><p class="drawer-notice">此操作将请求后端按最新预演结果回填候选台账关联；后端仍负责权限、备份与防覆盖校验。</p><el-form label-position="top"><el-form-item :label="`请输入固定确认文本：${LEDGER_BACKFILL_CONFIRM_TEXT}`"><el-input v-model="confirmText" /></el-form-item></el-form></ManagementDrawer>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import { executeLedgerBackfill, exportEnergyRecords, exportLedgerBackfillPreview, getDimensionBreakdown, getEnergyRecords, getEnergySummary, getEnergyTypes, getEnergyTypeBreakdown, getLedgerBackfillPreview, getMonthlyTrend, LEDGER_BACKFILL_CONFIRM_TEXT, safeEnergyRequest } from '@/api/energy';
import { aggregateMonthlyTrend, buildEnergyFilters, buildMonthlyTrendAxisTicks, ENERGY_TYPE_COLORS, fixedEnergyTypeBreakdown, ledgerAssociationLabel, numberValue } from '@/utils/energyStatistics';
import { hasPermi } from '@/utils/permission';

const emptyFilters = () => ({ normalizedMonthStart: '', normalizedMonthEnd: '', energyTypeCode: '', organizationUnitCode: '', keyword: '' });
const draftFilters = ref(emptyFilters()); const appliedFilters = ref(emptyFilters());
const energyTypes = ref([]); const energyTypesError = ref(''); const summary = ref({}); const trendRows = ref([]); const breakdownRows = ref([]); const records = ref([]); const pagination = ref({ total: 0 });
const loading = ref(false); const summaryError = ref(''); const trendError = ref(''); const breakdownError = ref(''); const recordsError = ref('');
const page = ref(1); const pageSize = ref(20); const dimension = ref('organizationUnit'); const dimensionRows = ref([]); const dimensionLoading = ref(false); const dimensionError = ref('');
const trendTooltip = ref(null); const breakdownTooltip = ref(null); const dimensionTooltip = ref(null);
const backfillPreview = ref(null); const previewLoading = ref(false); const exportLoading = ref(false); const executeLoading = ref(false); const backfillError = ref(''); const executeDrawerOpen = ref(false); const confirmText = ref(''); const recordsExportLoading = ref(false); const recordsExportError = ref('');

const requestError = (result) => result?.error?.message || '接口请求失败。';
const formatNumber = (value, digits = 2) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numberValue(value));
const formatInteger = (value) => formatNumber(value, 0);
const monthRange = computed(() => summary.value.monthRange?.start && summary.value.monthRange?.end ? `${summary.value.monthRange.start} 至 ${summary.value.monthRange.end}` : '暂无');
const visibleTrend = computed(() => aggregateMonthlyTrend(trendRows.value).slice(-24));
// 趋势图横轴只控制标签显示密度，数据点和 tooltip 仍覆盖最近 24 月全部数据。
const trendAxisTicks = computed(() => buildMonthlyTrendAxisTicks(visibleTrend.value));
const trendMax = computed(() => Math.max(...visibleTrend.value.map((row) => numberValue(row.totalNormalizedValue)), 1));
const linePoints = computed(() => visibleTrend.value.map((row, index) => `${xFor(index, visibleTrend.value.length)},${yFor(row.totalNormalizedValue)}`).join(' '));
const typeBreakdown = computed(() => fixedEnergyTypeBreakdown(breakdownRows.value));
const typeMax = computed(() => Math.max(...typeBreakdown.value.map((row) => numberValue(row.totalNormalizedValue)), 1));
const dimensionMax = computed(() => Math.max(...dimensionRows.value.map((row) => numberValue(row.totalNormalizedValue)), 1));
const dimensionLabel = computed(() => dimension.value === 'meterDevice' ? '计量器具' : '用能单元');
const allRequestsFailed = computed(() => Boolean(summaryError.value && trendError.value && breakdownError.value && recordsError.value));
const pageError = computed(() => summaryError.value || recordsError.value || trendError.value || breakdownError.value);
const canLedgerPreview = computed(() => hasPermi(['energy:records:view', 'energy-records:view']));
const canLedgerExecute = computed(() => hasPermi('energy:records:ledger-backfill:execute'));
const canExportRecords = computed(() => hasPermi(['energy:records:export', 'energy-records:export']));
const canExecuteBackfill = computed(() => Boolean(backfillPreview.value?.previewSignature && numberValue(backfillPreview.value?.summary?.wouldUpdate) > 0 && Array.isArray(backfillPreview.value?.candidateRecordIds) && backfillPreview.value.candidateRecordIds.length === numberValue(backfillPreview.value.summary?.wouldUpdate)));

function xFor(index, total) { return total <= 1 ? 334 : 62 + (index * 544) / (total - 1); }
function yFor(value) { return 196 - (numberValue(value) / trendMax.value) * 152; }
function percentage(value, max) { return Math.max(2, Math.min(100, (numberValue(value) / max) * 100)); }
function colorForType(code) { return ENERGY_TYPE_COLORS[code] || ENERGY_TYPE_COLORS.other; }
function trendLabel(row) { return `${row.month}：标准化值合计 ${formatNumber(row.totalNormalizedValue)}，记录 ${formatInteger(row.recordCount)} 条`; }
function typeLabel(row) { return `${row.energyTypeName || row.energyTypeCode}：标准化值合计 ${formatNumber(row.totalNormalizedValue)} ${row.normalizedUnit || ''}，记录 ${formatInteger(row.recordCount)} 条`; }
function dimensionLabelFor(row) { return `${row.dimensionValue}：标准化值合计 ${formatNumber(row.totalNormalizedValue)}，记录 ${formatInteger(row.recordCount)} 条`; }
function candidateLabel(row) { const unit = row.matched?.organizationUnit?.unitName || row.matched?.organizationUnit?.unitPath; const meter = row.matched?.meterDevice?.meterName || row.matched?.meterDevice?.meterCode; return [meter && `仪表 ${meter}`, unit && `用能单元 ${unit}`].filter(Boolean).join('；') || '—'; }

async function loadEnergyTypes() { const result = await safeEnergyRequest(getEnergyTypes); if (result.ok) { energyTypes.value = result.value.data || []; energyTypesError.value = ''; } else energyTypesError.value = requestError(result); }
async function loadDimension() { dimensionLoading.value = true; dimensionError.value = ''; const result = await safeEnergyRequest(() => getDimensionBreakdown({ ...buildEnergyFilters(appliedFilters.value), dimension: dimension.value })); dimensionLoading.value = false; if (result.ok) dimensionRows.value = result.value.data || []; else { dimensionRows.value = []; dimensionError.value = requestError(result); } }
async function loadData() { loading.value = true; const filters = buildEnergyFilters(appliedFilters.value); const [summaryResult, trendResult, breakdownResult, recordsResult] = await Promise.all([safeEnergyRequest(() => getEnergySummary(filters)), safeEnergyRequest(() => getMonthlyTrend(filters)), safeEnergyRequest(() => getEnergyTypeBreakdown(filters)), safeEnergyRequest(() => getEnergyRecords({ ...filters, page: page.value, pageSize: pageSize.value }))]); loading.value = false;
  if (summaryResult.ok) { summary.value = summaryResult.value.data || {}; summaryError.value = ''; } else summaryError.value = requestError(summaryResult);
  if (trendResult.ok) { trendRows.value = trendResult.value.data || []; trendError.value = ''; } else trendError.value = requestError(trendResult);
  if (breakdownResult.ok) { breakdownRows.value = breakdownResult.value.data || []; breakdownError.value = ''; } else breakdownError.value = requestError(breakdownResult);
  if (recordsResult.ok) { records.value = recordsResult.value.data || []; pagination.value = recordsResult.value.meta?.pagination || {}; recordsError.value = ''; } else recordsError.value = requestError(recordsResult);
  await loadDimension();
}
function applyFilters() { appliedFilters.value = { ...draftFilters.value }; page.value = 1; backfillPreview.value = null; loadData(); }
function resetFilters() { draftFilters.value = emptyFilters(); appliedFilters.value = emptyFilters(); page.value = 1; backfillPreview.value = null; loadData(); }
function changePageSize() { page.value = 1; loadData(); }
async function exportRecords() { recordsExportLoading.value = true; recordsExportError.value = ''; const result = await safeEnergyRequest(() => exportEnergyRecords(buildEnergyFilters(appliedFilters.value), 'xlsx')); recordsExportLoading.value = false; if (!result.ok) recordsExportError.value = `能耗明细导出失败：${requestError(result)}`; }
async function loadPreview() { previewLoading.value = true; backfillError.value = ''; const result = await safeEnergyRequest(() => getLedgerBackfillPreview({ ...buildEnergyFilters(appliedFilters.value), limit: 100, detailLimit: 100 })); previewLoading.value = false; if (result.ok) backfillPreview.value = result.value.data || {}; else { backfillPreview.value = null; backfillError.value = `台账回填预演读取失败：${requestError(result)}`; } }
async function exportPreview() { exportLoading.value = true; backfillError.value = ''; const result = await safeEnergyRequest(() => exportLedgerBackfillPreview(buildEnergyFilters(appliedFilters.value))); exportLoading.value = false; if (!result.ok) backfillError.value = `台账回填预演导出失败：${requestError(result)}`; }
async function executeBackfill() { if (!canExecuteBackfill.value || confirmText.value !== LEDGER_BACKFILL_CONFIRM_TEXT) return; executeLoading.value = true; backfillError.value = ''; const preview = backfillPreview.value; const result = await safeEnergyRequest(() => executeLedgerBackfill({ confirmText: confirmText.value, previewSignature: preview.previewSignature, expectedWouldUpdate: numberValue(preview.summary?.wouldUpdate), candidateRecordIds: preview.candidateRecordIds, filters: preview.filters || buildEnergyFilters(appliedFilters.value), acknowledgeSkippedRisks: true, requireBackup: true })); executeLoading.value = false; if (!result.ok) { backfillError.value = `台账回填执行失败：${requestError(result)}`; return; } executeDrawerOpen.value = false; confirmText.value = ''; ElMessage.success(`台账回填已完成：更新 ${formatInteger(result.value.data?.updatedRecords)} 条记录。`); backfillPreview.value = null; await loadData(); }

onMounted(async () => { await loadEnergyTypes(); await loadData(); });
</script>

<style scoped>
.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.chart-panel{min-width:0}.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.chart-heading h2{margin:0;color:#123b79;font-size:16px}.chart-heading span{color:#7385a2;font-size:12px}.heading-with-help{display:flex;align-items:center}.trend-chart-scroll{width:100%;overflow-x:auto;overscroll-behavior-inline:contain}.trend-chart{display:block;width:100%;min-width:560px;min-height:270px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:10px}.grid-line{stroke:#e1e0d9;stroke-width:1}.axis-text{fill:#898781;font-size:11px}.trend-axis-label{font-variant-numeric:tabular-nums}.trend-line{fill:none;stroke:#2a78d6;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.point-hit{fill:transparent}.point-dot{fill:#2a78d6;stroke:#fcfcfb;stroke-width:2}.trend-point{cursor:pointer}.trend-point:focus{outline:none}.trend-point:focus .point-dot,.trend-point:hover .point-dot{r:6;filter:drop-shadow(0 2px 5px rgba(42,120,214,.35))}.chart-tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px}.chart-table{margin-top:10px;width:100%}.bar-chart{display:grid;gap:10px}.bar-row{display:grid;grid-template-columns:minmax(96px,.8fr) minmax(130px,2fr) minmax(112px,.8fr);align-items:center;gap:10px;width:100%;padding:5px 0;color:#183153;text-align:left;background:transparent;border:0;border-radius:6px}.bar-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.bar-row:hover{background:#f7fbff}.bar-name{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-name i{width:10px;height:10px;flex:0 0 10px;border:1px solid rgba(11,11,11,.1);border-radius:2px}.bar-track{height:14px;padding-right:2px;background:#e7f1ff;border-radius:999px}.bar-fill{display:block;height:14px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.single-bar{background:#2a78d6}.bar-value{color:#516170;font-size:12px;text-align:right;white-space:nowrap}.dimension-chart{max-width:880px}.ledger-card{display:grid;gap:12px}.panel-alert{margin-top:4px}.preview-summary{display:flex;flex-wrap:wrap;gap:16px;color:#516170;font-size:13px}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.drawer-notice{margin:0 0 16px;color:#516170;line-height:1.7}@media (max-width:1120px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.chart-grid{grid-template-columns:1fr}}@media (max-width:720px){.stat-grid{grid-template-columns:1fr}.bar-row{grid-template-columns:1fr}.bar-value{text-align:left}}
</style>
