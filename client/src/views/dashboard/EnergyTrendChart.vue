<template>
  <figure class="trend-figure" :class="{ 'trend-figure--compact': compact }" :aria-labelledby="captionId">
    <figcaption :id="captionId">
      <span class="legend-dot" :style="{ backgroundColor: color }" aria-hidden="true" />
      {{ seriesLabel }} · {{ series.normalizedUnit }}
    </figcaption>
    <div class="trend-scroll">
      <svg class="trend-chart" viewBox="0 0 680 280" role="img" :aria-label="chartAriaLabel" @mouseleave="activeRow = null">
        <line v-for="tick in axisTicks" :key="`grid-${tick.index}`" x1="62" :y1="tick.y" x2="650" :y2="tick.y" class="grid-line" />
        <text v-for="tick in axisTicks" :key="`label-${tick.index}`" x="54" :y="tick.y + 4" text-anchor="end" class="axis-text">{{ formatNumber(tick.value) }}</text>
        <polyline :points="linePoints" class="trend-line" :style="{ stroke: color }" />
        <g v-for="(row, index) in rows" :key="`${row.month}-${index}`" class="trend-point" tabindex="0" role="img" :aria-label="pointLabel(row)" @mouseenter="activeRow = row" @focus="activeRow = row" @blur="activeRow = null">
          <circle :cx="xFor(index)" :cy="yFor(row.totalNormalizedValue)" r="12" class="point-hit" />
          <circle :cx="xFor(index)" :cy="yFor(row.totalNormalizedValue)" r="9" class="point-focus-ring" />
          <circle :cx="xFor(index)" :cy="yFor(row.totalNormalizedValue)" r="5" class="point-dot" :style="{ fill: color }" />
        </g>
        <text v-for="(row, index) in rows" :key="`month-${row.month}-${index}`" :x="xFor(index)" y="252" text-anchor="middle" class="axis-text">{{ row.month.slice(5) }}月</text>
      </svg>
    </div>
    <p class="trend-tooltip" role="status">{{ activeRow ? pointLabel(activeRow) : '可悬停或使用 Tab 聚焦数据点查看明细。' }}</p>
    <details class="equivalent-table">
      <summary>查看等价数据表</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th scope="col">月份</th><th scope="col">指标</th><th scope="col">数值</th><th scope="col">{{ isCarbonSeries ? '已计算结果' : '记录数' }}</th><th v-if="isCarbonSeries" scope="col">因子缺失</th></tr></thead>
          <tbody><tr v-for="row in rows" :key="`table-${row.month}`"><td>{{ row.month }}</td><td>{{ seriesLabel }}</td><td>{{ formatNumber(row.totalNormalizedValue) }} {{ series.normalizedUnit }}</td><td>{{ formatInteger(isCarbonSeries ? row.calculatedCount : row.recordCount) }}</td><td v-if="isCarbonSeries">{{ formatInteger(row.missingFactorCount) }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<script setup>
import { computed, ref } from 'vue';
import { formatDashboardMeasurement, resolveTrendAxisMaximum } from '@/utils/dashboardCockpit';

/** 单一能源或碳排序列图输入属性。 */
const props = defineProps({
  series: { type: Object, required: true },
  color: { type: String, required: true },
  compact: { type: Boolean, default: false }
});

/** 当前悬停或键盘聚焦的数据点。 */
const activeRow = ref(null);
/** 当前趋势是否展示碳排放结果。 */
const isCarbonSeries = computed(() => props.series?.kind === 'carbon');
/** 当前趋势序列的可读名称。 */
const seriesLabel = computed(() => props.series?.label || props.series?.energyTypeName || props.series?.energyTypeCode || '月度趋势');
/** 趋势图标题的稳定可访问标识。 */
const captionId = computed(() => `trend-caption-${String(props.series?.key || seriesLabel.value).replace(/[^a-zA-Z0-9一-龥]+/g, '-')}`);
/** 当前能源或碳排序列的有序月份行。 */
const rows = computed(() => Array.isArray(props.series?.rows) ? props.series.rows : []);
/** 当前序列数值轴最大值；非零极小数据保留真实最大值。 */
const maximumValue = computed(() => resolveTrendAxisMaximum(rows.value));
/** 趋势图单一序列折线坐标。 */
const linePoints = computed(() => rows.value.map((row, index) => `${xFor(index)},${yFor(row.totalNormalizedValue)}`).join(' '));
/** 趋势图纵轴刻度。 */
const axisTicks = computed(() => Array.from({ length: 5 }, (_, index) => ({
  index,
  y: 38 + index * 45,
  value: maximumValue.value * (1 - index / 4)
})));
/** 趋势图整体可访问描述。 */
const chartAriaLabel = computed(() => `${seriesLabel.value}，单位 ${props.series.normalizedUnit}，单一数值轴，共 ${rows.value.length} 个月份数据点${isCarbonSeries.value ? '，仅展示已有真实核算结果' : ''}。`);

/** 格式化趋势图数值；碳排至少保留四位小数且非零小值不得显示成零。 */
function formatNumber(value) {
  return formatDashboardMeasurement(value, {
    kind: isCarbonSeries.value ? 'carbon' : 'energy',
    maximumFractionDigits: 2
  });
}

/** 格式化趋势图记录数。 */
function formatInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number) : '—';
}

/** 计算趋势点横坐标。 */
function xFor(index) {
  return rows.value.length <= 1 ? 356 : 72 + (index * 568) / (rows.value.length - 1);
}

/** 计算趋势点纵坐标。 */
function yFor(value) {
  return 218 - ((Number(value) || 0) / maximumValue.value) * 180;
}

/** 生成趋势点 tooltip 与 ARIA 文本。 */
function pointLabel(row) {
  if (isCarbonSeries.value) {
    return `${row.month}，已核算碳排 ${formatNumber(row.totalNormalizedValue)} ${props.series.normalizedUnit}，${formatInteger(row.calculatedCount)} 条已计算结果，因子缺失 ${formatInteger(row.missingFactorCount)} 条。`;
  }
  return `${row.month}，${seriesLabel.value}用能 ${formatNumber(row.totalNormalizedValue)} ${props.series.normalizedUnit}，${formatInteger(row.recordCount)} 条记录。`;
}
</script>

<style scoped>
.trend-figure{margin:0;min-width:0}.trend-figure figcaption{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--cockpit-text,#183153);font-size:12px}.legend-dot{width:10px;height:10px;border-radius:3px;box-shadow:0 0 0 1px var(--cockpit-mark-border,rgba(11,11,11,.1))}.trend-scroll,.table-scroll{max-width:100%;overflow-x:auto}.trend-chart{display:block;width:100%;min-width:620px;border:1px solid var(--cockpit-chart-border,#e1e0d9);border-radius:12px;background:var(--cockpit-chart-bg,#fcfcfb)}.trend-figure--compact .trend-chart{width:100%;min-width:0;height:clamp(132px,18dvh,188px)}.trend-figure--compact figcaption{margin-bottom:6px;font-size:10px}.trend-figure--compact .trend-tooltip{min-height:0;margin-top:6px;padding:6px 8px;font-size:10px}.trend-figure--compact .equivalent-table{margin-top:6px;font-size:10px}.trend-figure--compact .equivalent-table .table-scroll{max-height:clamp(120px,28dvh,240px);overflow-x:auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.grid-line{stroke:var(--cockpit-gridline,#e1e0d9);stroke-dasharray:3 5}.axis-text{fill:var(--cockpit-axis,#898781);font-size:11px}.trend-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.point-hit{fill:transparent}.point-focus-ring{fill:none;stroke:transparent;stroke-width:2}.point-dot{stroke:var(--cockpit-chart-bg,#fcfcfb);stroke-width:3}.trend-point{cursor:default}.trend-point:focus{outline:none}.trend-point:focus .point-focus-ring,.trend-point:hover .point-focus-ring{stroke:var(--cockpit-focus,#1769e0)}.trend-point:focus .point-dot,.trend-point:hover .point-dot{r:7}.trend-tooltip{min-height:20px;margin:10px 0 0;padding:8px 10px;border:1px solid var(--cockpit-tooltip-border,#c9dcf5);border-radius:8px;background:var(--cockpit-tooltip-bg,#edf5ff);color:var(--cockpit-text,#183153);font-size:12px}.equivalent-table{margin-top:10px;color:var(--cockpit-muted,#6d809e);font-size:12px}.equivalent-table summary{cursor:pointer;color:var(--cockpit-accent,#1769e0)}.equivalent-table table{width:100%;margin-top:10px;border-collapse:collapse;white-space:nowrap}.equivalent-table th,.equivalent-table td{padding:8px 10px;border-bottom:1px solid var(--cockpit-table-border,#dce9fb);text-align:left}.equivalent-table th{color:var(--cockpit-heading,#123b79);font-weight:600}
</style>
