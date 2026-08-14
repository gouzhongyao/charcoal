<template>
  <figure class="donut-figure" :class="{ 'donut-figure--compact': compact }" :aria-labelledby="captionId">
    <figcaption :id="captionId"><strong>{{ title }}</strong><span>{{ description }} · 单位 {{ unit }}</span></figcaption>
    <div class="donut-layout">
      <svg class="donut-chart" viewBox="0 0 240 240" role="img" :aria-labelledby="`${titleId} ${descriptionId}`" @mouseleave="activeRow = null">
        <title :id="titleId">{{ title }}</title>
        <desc :id="descriptionId">{{ chartDescription }}</desc>
        <circle cx="120" cy="120" r="76" pathLength="100" class="donut-track" />
        <circle
          v-for="segment in segments"
          :key="segment.key"
          cx="120"
          cy="120"
          r="76"
          pathLength="100"
          class="donut-segment"
          :style="{ stroke: segment.color, strokeDasharray: `${segment.percentage} ${100 - segment.percentage}`, strokeDashoffset: -segment.offset }"
          tabindex="0"
          role="img"
          :aria-label="rowAriaLabel(segment)"
          @mouseenter="activeRow = segment"
          @focus="activeRow = segment"
          @blur="activeRow = null"
          @keydown.esc="activeRow = null"
        />
        <line v-for="separator in separators" :key="separator.key" :x1="separator.x1" :y1="separator.y1" :x2="separator.x2" :y2="separator.y2" class="donut-separator" />
        <text x="120" y="109" text-anchor="middle" class="donut-center-label">{{ centerLabel }}</text>
        <text x="120" y="132" text-anchor="middle" class="donut-center-value">{{ formatNumber(totalValue) }}</text>
        <text x="120" y="151" text-anchor="middle" class="donut-center-unit">{{ unit }}</text>
      </svg>
      <div class="donut-legend" aria-label="图例">
        <div v-for="row in normalizedRows" :key="`legend-${row.key}`" class="donut-legend__row">
          <i :style="{ backgroundColor: row.color }" aria-hidden="true" />
          <span>{{ row.label }}</span>
          <strong>{{ formatNumber(row.value) }}</strong>
          <small>{{ percentageLabel(row.value) }}</small>
        </div>
      </div>
    </div>
    <p class="donut-tooltip" role="status">{{ activeRow ? rowAriaLabel(activeRow) : '可悬停或使用 Tab 聚焦非零扇区查看明细；真实零值保留在图例和等价数据表中。' }}</p>
    <details class="equivalent-table">
      <summary>查看等价数据表</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th scope="col">分类</th><th scope="col">数值</th><th scope="col">占比</th><th scope="col">说明</th></tr></thead>
          <tbody><tr v-for="row in normalizedRows" :key="`table-${row.key}`"><td><i class="table-dot" :style="{ backgroundColor: row.color }" aria-hidden="true" />{{ row.label }}</td><td>{{ formatNumber(row.value) }} {{ unit }}</td><td>{{ percentageLabel(row.value) }}</td><td>{{ row.detail || '—' }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<script setup>
import { computed, ref } from 'vue';

/** 单一单位环图输入属性。 */
const props = defineProps({
  chartId: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  unit: { type: String, required: true },
  rows: { type: Array, default: () => [] },
  centerLabel: { type: String, default: '合计' },
  /** 窄面板使用单列图表与图例，避免依赖视口宽度判断。 */
  compact: { type: Boolean, default: false }
});
/** 当前鼠标悬停或键盘聚焦的非零扇区。 */
const activeRow = ref(null);
/** 环图标题可访问标识。 */
const titleId = computed(() => `${props.chartId}-title`);
/** 环图说明可访问标识。 */
const descriptionId = computed(() => `${props.chartId}-description`);
/** 环图图注可访问标识。 */
const captionId = computed(() => `${props.chartId}-caption`);
/** 过滤非法输入并保留真实零值的结构行。 */
const normalizedRows = computed(() => (Array.isArray(props.rows) ? props.rows : []).map((row, index) => {
  const number = Number(row?.value);
  return {
    key: String(row?.key || `row-${index}`),
    label: String(row?.label || '未命名分类'),
    value: Number.isFinite(number) && number > 0 ? number : 0,
    color: String(row?.color || '#52514e'),
    detail: String(row?.detail || '')
  };
}));
/** 当前单一单位结构总量。 */
const totalValue = computed(() => normalizedRows.value.reduce((total, row) => total + row.value, 0));
/** 仅包含真实正值的可聚焦扇区。 */
const segments = computed(() => {
  let offset = 0;
  if (totalValue.value <= 0) return [];
  return normalizedRows.value.filter((row) => row.value > 0).map((row) => {
    const percentage = (row.value / totalValue.value) * 100;
    const segment = { ...row, percentage, offset };
    offset += percentage;
    return segment;
  });
});
/** 扇区边界分隔线，提供表面色间隔而不伪造扇区占比。 */
const separators = computed(() => segments.value.slice(1).map((segment) => {
  const angle = ((segment.offset / 100) * Math.PI * 2) - (Math.PI / 2);
  return {
    key: `separator-${segment.key}`,
    x1: 120 + Math.cos(angle) * 60,
    y1: 120 + Math.sin(angle) * 60,
    x2: 120 + Math.cos(angle) * 92,
    y2: 120 + Math.sin(angle) * 92
  };
}));
/** 环图整体可访问说明。 */
const chartDescription = computed(() => `${props.description}。仅包含单位 ${props.unit} 的 ${normalizedRows.value.length} 个分类，总量 ${formatNumber(totalValue.value)} ${props.unit}；真实零值不绘制伪扇区。`);

/** 格式化环图真实数值。 */
function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(number) : '—';
}

/** 返回真实占比文本，总量为零时所有行均为 0%。 */
function percentageLabel(value) {
  if (totalValue.value <= 0) return '0%';
  return `${formatNumber((Number(value || 0) / totalValue.value) * 100)}%`;
}

/** 生成扇区 tooltip 与 ARIA 文本。 */
function rowAriaLabel(row) {
  return `${row.label}：${formatNumber(row.value)} ${props.unit}，占比 ${percentageLabel(row.value)}${row.detail ? `，${row.detail}` : ''}。`;
}
</script>

<style scoped>
.donut-figure{margin:0;min-width:0}.donut-figure figcaption{display:grid;gap:4px;margin-bottom:10px}.donut-figure figcaption strong{color:var(--cockpit-heading,#123b79);font-size:13px}.donut-figure figcaption span{color:var(--cockpit-muted,#6d809e);font-size:11px;line-height:1.5}.donut-layout{display:grid;grid-template-columns:minmax(190px,.85fr) minmax(150px,1fr);align-items:center;gap:10px}.donut-figure--compact .donut-layout{grid-template-columns:minmax(0,1fr)}.donut-chart{display:block;width:100%;max-width:260px;justify-self:center;overflow:visible}.donut-figure--compact .donut-chart{max-width:220px}.donut-track,.donut-segment{fill:none;stroke-width:30}.donut-track{stroke:var(--cockpit-track,#e7f1ff)}.donut-segment{transform:rotate(-90deg);transform-origin:120px 120px;cursor:default;transition:stroke-width .15s ease}.donut-segment:hover,.donut-segment:focus{stroke-width:35;outline:none}.donut-segment:focus-visible{filter:drop-shadow(0 0 3px var(--cockpit-focus,#1769e0))}.donut-separator{stroke:var(--cockpit-chart-bg,#fcfcfb);stroke-width:3}.donut-center-label{fill:var(--cockpit-muted,#6d809e);font-size:10px}.donut-center-value{fill:var(--cockpit-heading,#123b79);font-size:19px;font-weight:700;font-variant-numeric:tabular-nums}.donut-center-unit{fill:var(--cockpit-accent,#1769e0);font-size:10px}.donut-legend{display:grid;gap:7px;min-width:0}.donut-legend__row{display:grid;grid-template-columns:10px minmax(72px,1fr) auto auto;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid var(--cockpit-table-border,#dce9fb);color:var(--cockpit-text,#183153);font-size:11px}.donut-legend__row i,.table-dot{width:9px;height:9px;border:1px solid var(--cockpit-mark-border,rgba(11,11,11,.1));border-radius:2px}.donut-legend__row strong{color:var(--cockpit-heading,#123b79);font-variant-numeric:tabular-nums}.donut-legend__row small{min-width:42px;color:var(--cockpit-muted,#6d809e);text-align:right}.donut-tooltip{min-height:20px;margin:10px 0 0;padding:8px 10px;border:1px solid var(--cockpit-tooltip-border,#c9dcf5);border-radius:8px;background:var(--cockpit-tooltip-bg,#edf5ff);color:var(--cockpit-text,#183153);font-size:12px;line-height:1.55}.equivalent-table{margin-top:10px;color:var(--cockpit-muted,#6d809e);font-size:12px}.equivalent-table summary{cursor:pointer;color:var(--cockpit-accent,#1769e0)}.table-scroll{max-width:100%;overflow-x:auto}.equivalent-table table{width:100%;margin-top:10px;border-collapse:collapse;white-space:nowrap}.equivalent-table th,.equivalent-table td{padding:8px 10px;border-bottom:1px solid var(--cockpit-table-border,#dce9fb);text-align:left}.equivalent-table th{color:var(--cockpit-heading,#123b79)}.equivalent-table td:first-child{display:flex;align-items:center;gap:6px}@media (max-width:520px){.donut-layout{grid-template-columns:1fr}.donut-chart{max-width:230px}}@media (prefers-reduced-motion:reduce){.donut-segment{transition:none}}
</style>
