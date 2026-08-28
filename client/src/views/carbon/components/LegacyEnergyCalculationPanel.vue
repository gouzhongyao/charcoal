<template>
  <section class="module-section" aria-labelledby="legacy-energy-title">
    <header class="module-heading">
      <div class="heading-with-help">
        <div><h2 id="legacy-energy-title">旧能耗来源核算</h2><p>兼容保留旧 <code>/api/carbon/emissions*</code> 能力；此来源必须由用户显式进入，不与独立碳活动结果直接合计。</p></div>
        <HelpIcon label="查看旧能耗核算边界" content="页面只读取、筛选、统计和导出服务端计算结果；重新计算时服务端会标记旧结果为 superseded。旧能耗来源与独立活动来源不可直接合计。" />
      </div>
    </header>
    <el-alert title="旧能耗来源仅用于兼容查看和重算。统一结果默认来源仍是 independent_activity；如需比较两来源，请在统一结果中显式选择 all 双分面。" type="warning" show-icon :closable="false" />
    <ManagementToolbar :loading="emissionLoading" @search="applyEmissionFilters" @reset="resetEmissionFilters">
      <el-form-item label="开始月份"><el-date-picker v-model="emissionDraftFilters.normalizedMonthStart" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="开始月份" /></el-form-item>
      <el-form-item label="结束月份"><el-date-picker v-model="emissionDraftFilters.normalizedMonthEnd" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="结束月份" /></el-form-item>
      <el-form-item label="能源类型"><el-select v-model="emissionDraftFilters.energyTypeCode" clearable placeholder="全部能源类型"><el-option v-for="item in props.energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
      <el-form-item label="组织"><el-input v-model.trim="emissionDraftFilters.organization" clearable placeholder="精确组织名称" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="emissionDraftFilters.status" clearable placeholder="全部有效状态"><el-option label="已计算" value="calculated" /><el-option label="因子缺失" value="factor_missing" /><el-option label="无效记录" value="invalid_record" /><el-option label="已替代" value="superseded" /></el-select></el-form-item>
      <el-form-item label="字符搜索"><el-input v-model.trim="emissionDraftFilters.keyword" clearable placeholder="能源、组织、站点或部门" /></el-form-item>
      <template #actions><el-button v-if="canEmissionExport" :loading="emissionExportLoading" @click="exportEmissions">导出当前筛选</el-button><el-button v-if="canEmissionCalculate" type="primary" @click="openCalculate">执行旧来源服务端计算</el-button></template>
    </ManagementToolbar>
    <el-alert v-if="emissionError" type="error" :closable="false" show-icon :title="emissionError" />
    <section class="stat-grid" aria-label="当前筛选下的旧能耗碳排放概览">
      <StatCard label="排放结果数" :value="formatInteger(emissionStats.totalRecords)" note="当前筛选命中记录" />
      <StatCard label="已计算 / 缺失" :value="`${formatInteger(emissionStats.calculatedCount)} / ${formatInteger(emissionStats.missingFactorCount)}`" note="缺失因子不估算排放" />
      <StatCard label="按排放单位总量" :value="totalsByEmissionUnitLabel(emissionStats.totalsByEmissionUnit)" note="按单位分列，禁止跨单位相加" />
      <StatCard label="无效 / 已替代" :value="`${formatInteger(emissionStats.invalidRecordCount)} / ${formatInteger(emissionStats.supersededCount)}`" note="统计来自服务端实际状态" />
    </section>
    <article class="page-card missing-panel">
      <header class="table-heading"><div class="heading-with-help"><h3>缺失因子</h3><HelpIcon label="查看缺失因子说明" content="缺失提示来自 factor_missing 排放结果，仅作为维护因子的参考；页面不会依据活动值估算或写入排放量。" /></div><span>当前筛选结果</span></header>
      <PageState v-if="missingError" :error="missingError" @retry="loadEmissions" />
      <PageState v-else-if="!missingFactors.length && !emissionLoading" description="当前筛选下没有缺失因子。" />
      <el-table v-else :data="missingFactors" size="small"><el-table-column prop="energyTypeName" label="能源类型" min-width="120" /><el-table-column prop="unit" label="活动单位" width="100" /><el-table-column prop="requestedRegion" label="请求地区" width="110" /><el-table-column prop="factorYear" label="因子年份" width="100" /><el-table-column prop="missingRecordCount" label="影响记录" width="100" /><el-table-column label="月份范围" min-width="140"><template #default="{ row }">{{ row.monthStart }} 至 {{ row.monthEnd }}</template></el-table-column></el-table>
    </article>
    <section class="chart-grid" aria-label="旧能耗碳排放统计图表">
      <article v-for="chart in chartDefinitions" :key="chart.key" class="page-card chart-panel">
        <header class="chart-heading"><div class="heading-with-help"><h3>{{ chart.title }}</h3><HelpIcon :label="`查看${chart.title}口径`" :content="`${chart.title}只展示所选排放单位 ${selectedEmissionUnit || '（暂无单位）'} 的服务端统计；图例使用固定实体色，并提供悬停提示与下方表格回退。`" /></div><el-select v-model="selectedEmissionUnit" size="small" class="unit-select" placeholder="选择排放单位"><el-option v-for="unit in emissionUnits" :key="unit" :label="unit" :value="unit" /></el-select></header>
        <PageState v-if="statsError" :error="statsError" @retry="loadEmissions" />
        <PageState v-else-if="!chartRows(chart.key).length" description="当前筛选及排放单位下暂无统计数据" />
        <template v-else>
          <div class="bar-legend" :aria-label="`${chart.title}图例`"><span v-for="row in chartRows(chart.key)" :key="chartEntityKey(chart.key, row)"><i :style="{ backgroundColor: carbonCategoryColor(chartEntityKey(chart.key, row)) }" />{{ chartLabel(chart.key, row) }}</span></div>
          <div class="bar-chart" @mouseleave="chartTooltip = null"><button v-for="row in chartRows(chart.key)" :key="chartEntityKey(chart.key, row)" class="bar-row" type="button" :aria-label="chartTooltipLabel(chart.key, row)" @mouseenter="chartTooltip = { key: chart.key, id: chartEntityKey(chart.key, row) }" @focus="chartTooltip = { key: chart.key, id: chartEntityKey(chart.key, row) }"><span class="bar-name"><i :style="{ backgroundColor: carbonCategoryColor(chartEntityKey(chart.key, row)) }" />{{ chartLabel(chart.key, row) }}</span><span class="bar-track"><span class="bar-fill" :style="{ width: `${percentage(row.totalEmissionValue, chartMax(chart.key))}%`, backgroundColor: carbonCategoryColor(chartEntityKey(chart.key, row)) }" /></span><span class="bar-value">{{ formatNumber(row.totalEmissionValue, 4) }} {{ row.emissionUnit }}</span></button></div>
          <p v-if="chartTooltip?.key === chart.key" class="chart-tooltip" role="status">{{ chartTooltipText(chart.key) }}</p>
          <el-table :data="chartRows(chart.key)" size="small" class="chart-table"><el-table-column :label="chart.columnLabel" min-width="120"><template #default="{ row }">{{ chartLabel(chart.key, row) }}</template></el-table-column><el-table-column label="排放量" min-width="145"><template #default="{ row }">{{ formatNumber(row.totalEmissionValue, 4) }} {{ row.emissionUnit }}</template></el-table-column><el-table-column prop="emissionRecordCount" label="结果数" width="90" /><el-table-column prop="calculatedCount" label="已计算" width="90" /><el-table-column prop="missingFactorCount" label="缺失" width="80" /></el-table>
        </template>
      </article>
    </section>
    <article class="page-card">
      <header class="table-heading"><div class="heading-with-help"><h3>旧来源结果列表</h3><HelpIcon label="查看旧排放列表说明" content="列表仅展示旧 /api/carbon/emissions* 保存的结果；没有人工编辑、删除或前端计算入口。" /></div><span>共 {{ formatInteger(emissionPagination.total) }} 条</span></header>
      <PageState v-if="emissionError && !emissions.length" :error="emissionError" @retry="loadEmissions" />
      <PageState v-else-if="!emissions.length && !emissionLoading" description="暂无旧能耗排放结果；维护因子后可显式执行旧来源服务端计算。" />
      <template v-else>
        <el-table :data="emissions" v-loading="emissionLoading" stripe>
          <el-table-column prop="normalizedMonth" label="月份" width="100" /><el-table-column prop="energyTypeName" label="能源类型" min-width="120" /><el-table-column prop="organization" label="组织" min-width="120" show-overflow-tooltip />
          <el-table-column label="活动值" min-width="130"><template #default="{ row }">{{ formatNumber(row.activityValue) }} {{ row.activityUnit }}</template></el-table-column>
          <el-table-column label="因子值" min-width="145"><template #default="{ row }">{{ row.factorValue === null ? '—（factor_missing）' : formatNumber(row.factorValue, 6) }}</template></el-table-column>
          <el-table-column label="排放量" min-width="165"><template #default="{ row }">{{ row.emissionValue === null ? '—（factor_missing）' : `${formatNumber(row.emissionValue, 4)} ${row.emissionUnit}` }}</template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag size="small" effect="light" :type="emissionStatusType(row.status)">{{ emissionStatusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="计算时间（UTC）" min-width="190"><template #default="scope">{{ formatStrictUtcDateTimeDisplay(scope.row.calculatedAt) }}</template></el-table-column>
        </el-table>
        <div class="pagination"><el-pagination v-model:current-page="emissionPage" v-model:page-size="emissionPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="emissionPagination.total || 0" @current-change="loadEmissions" @size-change="changeEmissionPageSize" /></div>
      </template>
    </article>
    <ManagementDrawer v-model="calculateDrawerOpen" title="执行旧能耗来源服务端碳排放计算" confirm-label="执行计算" :loading="calculateLoading" :confirm-disabled="!calculateForm.normalizedMonthStart && !calculateForm.normalizedMonthEnd" @save="calculateEmissions">
      <p class="drawer-notice">服务端只读取 active 能耗记录和 active 匹配因子；缺失因子会记录 factor_missing 而不是估算排放。重复计算由服务端保留 superseded 追溯。本操作不会创建 independent_activity 运行。</p>
      <el-form :model="calculateForm" label-position="top"><el-form-item label="开始月份"><el-date-picker v-model="calculateForm.normalizedMonthStart" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" class="drawer-control" /></el-form-item><el-form-item label="结束月份"><el-date-picker v-model="calculateForm.normalizedMonthEnd" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" class="drawer-control" /></el-form-item><el-form-item label="核算地区"><el-input v-model.trim="calculateForm.region" placeholder="default" /></el-form-item><el-form-item label="本次最多记录数"><el-input-number v-model="calculateForm.limit" :min="1" :max="5000" class="drawer-control" /></el-form-item></el-form>
      <el-alert v-if="calculateError" type="error" :closable="false" show-icon :title="calculateError" />
    </ManagementDrawer>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import {
  calculateCarbonEmissions,
  exportCarbonEmissions,
  getCarbonEmissionStats,
  getCarbonEmissions,
  getMissingCarbonFactors
} from '@/api/carbon';
import {
  buildCarbonEmissionFilters,
  carbonCategoryColor,
  limitChartCategories,
  numberValue,
  rowsForEmissionUnit,
  totalsByEmissionUnitLabel
} from '@/utils/carbonManagement';
import { hasPermi } from '@/utils/permission';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';

// 组件属性模块：能源字典由页面壳统一加载。
const props = defineProps({ energyTypes: { type: Array, default: () => [] } });
// 组件事件模块：旧来源计算完成后通知页面壳。
const emit = defineEmits(['calculated']);
// 空筛选和计算表单工厂：月份字段保留 YYYY-MM 原字符串。
const emptyEmissionFilters = () => ({ normalizedMonthStart: '', normalizedMonthEnd: '', energyTypeCode: '', organization: '', status: '', calculationMethod: '', includeSuperseded: false, keyword: '' });
const emptyCalculateForm = () => ({ normalizedMonthStart: '', normalizedMonthEnd: '', region: 'default', limit: 500 });
// 图表定义模块：旧能力继续保留三个维度。
const chartDefinitions = Object.freeze([{ key: 'month', title: '月度排放趋势', columnLabel: '月份' }, { key: 'energy', title: '能源类型排放', columnLabel: '能源类型' }, { key: 'organization', title: '组织排放', columnLabel: '组织' }]);
// 权限模块：前端精确控制旧来源按钮可见性。
const canEmissionCalculate = computed(() => hasPermi('carbon:emissions:calculate'));
const canEmissionExport = computed(() => hasPermi('carbon:emissions:export'));
// 列表、统计和筛选状态模块。
const emissionDraftFilters = ref(emptyEmissionFilters());
const emissionAppliedFilters = ref(emptyEmissionFilters());
const emissionPage = ref(1);
const emissionPageSize = ref(20);
const emissionPagination = ref({ total: 0 });
const emissions = ref([]);
const emissionStats = ref({ totalsByEmissionUnit: [], byMonth: [], byEnergyType: [], byOrganization: [] });
const missingFactors = ref([]);
const emissionLoading = ref(false);
const emissionError = ref('');
const statsError = ref('');
const missingError = ref('');
const emissionExportLoading = ref(false);
const selectedEmissionUnit = ref('');
const chartTooltip = ref(null);
// 旧来源计算抽屉状态模块。
const calculateDrawerOpen = ref(false);
const calculateForm = ref(emptyCalculateForm());
const calculateLoading = ref(false);
const calculateError = ref('');
// 服务端返回的排放单位列表。
const emissionUnits = computed(() => [...new Set((emissionStats.value.totalsByEmissionUnit || []).map((row) => row.emissionUnit).filter(Boolean))]);

// 方法模块：列表、统计、缺因子、图表、导出和旧来源计算。
/** 捕获请求错误并保留区域级结果。 */
async function safe(task) { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } }
/** 提取共享 HTTP 客户端的真实错误消息。 */
function requestError(result) { return result?.error?.apiError?.message || result?.error?.message || '接口请求失败。'; }
/** 格式化有限数值。 */
function formatNumber(value, digits = 2) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numberValue(value)); }
/** 格式化整数。 */
function formatInteger(value) { return formatNumber(value, 0); }
/** 计算同排放单位柱状图百分比。 */
function percentage(value, maximum) { return Math.max(2, Math.min(100, (numberValue(value) / maximum) * 100)); }
/** 返回选中单位指定维度的服务端统计行。 */
function chartRows(key) { const source = key === 'month' ? emissionStats.value.byMonth : key === 'energy' ? emissionStats.value.byEnergyType : emissionStats.value.byOrganization; const unitRows = rowsForEmissionUnit(source || [], selectedEmissionUnit.value); return key === 'month' ? [...unitRows].sort((left, right) => String(left.normalizedMonth).localeCompare(String(right.normalizedMonth))) : limitChartCategories(unitRows, key === 'energy' ? 'energyTypeCode' : 'organization'); }
/** 返回统计行标签。 */
function chartLabel(key, row) { return key === 'month' ? row.normalizedMonth : key === 'energy' ? (row.energyTypeName || row.energyTypeCode) : row.organization; }
/** 返回分类稳定颜色键。 */
function chartEntityKey(key, row) { return `${key}:${key === 'energy' ? row.energyTypeCode : chartLabel(key, row)}`; }
/** 返回单图最大排放值。 */
function chartMax(key) { return Math.max(...chartRows(key).map((row) => numberValue(row.totalEmissionValue)), 1); }
/** 返回悬停与键盘聚焦完整提示。 */
function chartTooltipLabel(key, row) { return `${chartLabel(key, row)}：${formatNumber(row.totalEmissionValue, 4)} ${row.emissionUnit}；结果 ${formatInteger(row.emissionRecordCount)} 条，已计算 ${formatInteger(row.calculatedCount)} 条，缺失因子 ${formatInteger(row.missingFactorCount)} 条。`; }
/** 返回当前图表提示文本。 */
function chartTooltipText(key) { const row = chartRows(key).find((item) => chartEntityKey(key, item) === chartTooltip.value?.id); return row ? chartTooltipLabel(key, row) : ''; }
/** 返回结果状态中文。 */
function emissionStatusLabel(status) { return ({ calculated: '已计算', factor_missing: '因子缺失', invalid_record: '无效记录', superseded: '已替代' })[status] || status || '未知'; }
/** 返回状态标签类型，不参与图表系列颜色。 */
function emissionStatusType(status) { return ({ calculated: 'success', factor_missing: 'warning', invalid_record: 'danger', superseded: 'info' })[status] || 'info'; }
/** 并行读取列表、统计和缺失因子。 */
async function loadEmissions() { emissionLoading.value = true; const filters = buildCarbonEmissionFilters(emissionAppliedFilters.value, { page: emissionPage.value, pageSize: emissionPageSize.value }); const [listResult, statsResult, missingResult] = await Promise.all([safe(() => getCarbonEmissions(filters)), safe(() => getCarbonEmissionStats(filters)), safe(() => getMissingCarbonFactors(filters))]); emissionLoading.value = false; if (listResult.ok) { emissions.value = listResult.value.data || []; emissionPagination.value = listResult.value.meta?.pagination || {}; emissionError.value = ''; } else { emissions.value = []; emissionError.value = requestError(listResult); } if (statsResult.ok) { emissionStats.value = statsResult.value.data || { totalsByEmissionUnit: [], byMonth: [], byEnergyType: [], byOrganization: [] }; statsError.value = ''; if (!emissionUnits.value.includes(selectedEmissionUnit.value)) selectedEmissionUnit.value = emissionUnits.value[0] || ''; } else { emissionStats.value = { totalsByEmissionUnit: [], byMonth: [], byEnergyType: [], byOrganization: [] }; statsError.value = requestError(statsResult); } if (missingResult.ok) { missingFactors.value = missingResult.value.data || []; missingError.value = ''; } else { missingFactors.value = []; missingError.value = requestError(missingResult); } }
/** 应用筛选并回到第一页。 */
function applyEmissionFilters() { emissionAppliedFilters.value = { ...emissionDraftFilters.value }; emissionPage.value = 1; loadEmissions(); }
/** 清空筛选并回到第一页。 */
function resetEmissionFilters() { emissionDraftFilters.value = emptyEmissionFilters(); emissionAppliedFilters.value = emptyEmissionFilters(); emissionPage.value = 1; loadEmissions(); }
/** 修改页大小后回到第一页。 */
function changeEmissionPageSize() { emissionPage.value = 1; loadEmissions(); }
/** 导出当前已应用筛选。 */
async function exportEmissions() { emissionExportLoading.value = true; const result = await safe(() => exportCarbonEmissions(buildCarbonEmissionFilters(emissionAppliedFilters.value))); emissionExportLoading.value = false; if (!result.ok) ElMessage.error(`碳排放结果导出失败：${requestError(result)}`); }
/** 打开旧来源计算抽屉并带入月份筛选。 */
function openCalculate() { calculateForm.value = { ...emptyCalculateForm(), normalizedMonthStart: emissionAppliedFilters.value.normalizedMonthStart, normalizedMonthEnd: emissionAppliedFilters.value.normalizedMonthEnd }; calculateError.value = ''; calculateDrawerOpen.value = true; }
/** 触发旧来源服务端计算并刷新结果。 */
async function calculateEmissions() { if (!calculateForm.value.normalizedMonthStart && !calculateForm.value.normalizedMonthEnd) return; calculateLoading.value = true; calculateError.value = ''; const result = await safe(() => calculateCarbonEmissions({ ...calculateForm.value })); calculateLoading.value = false; if (!result.ok) { calculateError.value = `碳排放计算失败：${requestError(result)}`; return; } calculateDrawerOpen.value = false; ElMessage.success(`旧来源服务端计算完成：已处理 ${formatInteger(result.value.data?.totalRecords)} 条，已计算 ${formatInteger(result.value.data?.calculatedCount)} 条，缺失因子 ${formatInteger(result.value.data?.missingFactorCount)} 条。`); await loadEmissions(); emit('calculated'); }

onMounted(loadEmissions);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between}.module-heading h2,.chart-heading h3{margin:0;color:#123b79;font-size:17px}.module-heading p{margin:6px 0 0;color:var(--el-text-color-secondary);line-height:1.6}.heading-with-help{display:flex;align-items:flex-start;gap:4px}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.table-heading,.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading small,.table-heading span{color:#7385a2;font-size:12px}.pagination{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}.missing-panel{overflow-x:auto}.chart-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.chart-panel{min-width:0}.unit-select{width:132px}.bar-legend{display:flex;flex-wrap:wrap;gap:8px 12px;margin-bottom:10px;color:#516170;font-size:12px}.bar-legend span{display:inline-flex;align-items:center;gap:5px}.bar-legend i,.bar-name i{width:10px;height:10px;flex:0 0 10px;border:1px solid rgba(11,11,11,.1);border-radius:2px}.bar-chart{display:grid;gap:8px}.bar-row{display:grid;grid-template-columns:minmax(72px,.8fr) minmax(110px,1.8fr) minmax(96px,.8fr);align-items:center;gap:8px;width:100%;padding:5px 0;color:#183153;text-align:left;background:transparent;border:0;border-radius:6px}.bar-row:hover{background:#f7fbff}.bar-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.bar-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:14px;padding-right:2px;background:#e7f1ff;border-radius:999px}.bar-fill{display:block;height:14px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.bar-value{color:#516170;font-size:12px;text-align:right;white-space:nowrap}.chart-tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:12px;line-height:1.5}.chart-table{width:100%;margin-top:10px}.drawer-notice{margin:0 0 16px;color:#516170;line-height:1.7}.drawer-control{width:100%}code{padding:1px 4px;background:var(--el-fill-color-light);border-radius:4px}@media (max-width:1240px){.chart-grid{grid-template-columns:1fr}.chart-panel{overflow-x:auto}}@media (max-width:900px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:640px){.stat-grid{grid-template-columns:1fr}.chart-heading{align-items:flex-start;flex-direction:column}.bar-row{grid-template-columns:1fr}.bar-value{text-align:left}}
</style>
