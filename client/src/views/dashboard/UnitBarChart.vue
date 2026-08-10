<template>
  <figure class="bar-figure" :aria-labelledby="captionId">
    <figcaption :id="captionId">{{ title }} · {{ unit }}</figcaption>
    <div class="bar-legend" aria-label="图例">
      <span v-for="row in rows" :key="row.key"><i :style="{ backgroundColor: row.color }" aria-hidden="true" />{{ row.label }}</span>
    </div>
    <div class="bar-chart" role="group" :aria-label="`${title}，单位 ${unit}`" @mouseleave="activeRow = null">
      <div v-for="row in rows" :key="row.key" class="bar-row" tabindex="0" role="img" :aria-label="rowAriaLabel(row)" @mouseenter="activeRow = row" @focus="activeRow = row" @blur="activeRow = null">
        <span class="bar-label">{{ row.label }}</span>
        <span class="bar-track"><i class="bar-fill" :style="{ width: `${percentage(row.value)}%`, backgroundColor: row.color }" /></span>
        <strong>{{ formatNumber(row.value) }}</strong>
      </div>
    </div>
    <p class="bar-tooltip" role="status">{{ activeRow ? rowAriaLabel(activeRow) : '可悬停或使用 Tab 聚焦条目查看明细。' }}</p>
    <details class="equivalent-table">
      <summary>查看等价数据表</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th scope="col">分类</th><th scope="col">数值</th><th scope="col">说明</th></tr></thead>
          <tbody><tr v-for="row in rows" :key="`table-${row.key}`"><td><i class="table-dot" :style="{ backgroundColor: row.color }" aria-hidden="true" />{{ row.label }}</td><td>{{ formatNumber(row.value) }} {{ unit }}</td><td>{{ row.detail || '—' }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<script setup>
import { computed, ref } from 'vue';
import { calculateZeroSafePercentage } from '@/utils/dashboardCockpit';

/** 同单位结构图输入属性。 */
const props = defineProps({
  title: { type: String, required: true },
  unit: { type: String, required: true },
  rows: { type: Array, default: () => [] }
});

/** 当前悬停或键盘聚焦的结构行。 */
const activeRow = ref(null);
/** 当前同单位结构图最大值。 */
const maximumValue = computed(() => Math.max(...props.rows.map((row) => Number(row.value) || 0), 1));
/** 结构图标题的稳定可访问标识。 */
const captionId = computed(() => `bar-caption-${props.title.replace(/[^a-zA-Z0-9一-龥]+/g, '-')}`);

/** 格式化结构图数值。 */
function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number) : '—';
}

/** 计算允许真实零值的结构条比例。 */
function percentage(value) {
  return calculateZeroSafePercentage(value, maximumValue.value);
}

/** 生成结构图 tooltip 与 ARIA 文本。 */
function rowAriaLabel(row) {
  return `${row.label}：${formatNumber(row.value)} ${props.unit}${row.detail ? `，${row.detail}` : ''}。`;
}
</script>

<style scoped>
.bar-figure{margin:0;min-width:0}.bar-figure figcaption{margin-bottom:10px;color:var(--cockpit-text,#183153);font-size:12px}.bar-legend{display:flex;flex-wrap:wrap;gap:7px 12px;margin-bottom:12px;color:var(--cockpit-muted,#6d809e);font-size:11px}.bar-legend span{display:inline-flex;align-items:center;gap:5px}.bar-legend i,.table-dot{width:9px;height:9px;border:1px solid var(--cockpit-mark-border,rgba(11,11,11,.1));border-radius:2px}.bar-chart{display:grid;gap:8px}.bar-row{display:grid;grid-template-columns:minmax(88px,1fr) minmax(120px,2fr) minmax(64px,auto);align-items:center;gap:10px;width:100%;padding:7px;border:0;border-radius:8px;background:transparent;color:var(--cockpit-text,#183153);text-align:left;cursor:default}.bar-row:hover,.bar-row:focus-visible{background:var(--cockpit-hover-bg,#f7fbff);outline:2px solid var(--cockpit-focus,#1769e0);outline-offset:1px}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:12px;border-radius:999px;background:var(--cockpit-track,#e7f1ff);overflow:hidden}.bar-fill{display:block;height:100%;border-right:2px solid var(--cockpit-chart-bg,#fcfcfb);border-radius:0 999px 999px 0}.bar-row strong{color:var(--cockpit-heading,#123b79);font-size:12px;font-variant-numeric:tabular-nums}.bar-tooltip{min-height:20px;margin:10px 0 0;padding:8px 10px;border:1px solid var(--cockpit-tooltip-border,#c9dcf5);border-radius:8px;background:var(--cockpit-tooltip-bg,#edf5ff);color:var(--cockpit-text,#183153);font-size:12px}.equivalent-table{margin-top:10px;color:var(--cockpit-muted,#6d809e);font-size:12px}.equivalent-table summary{cursor:pointer;color:var(--cockpit-accent,#1769e0)}.table-scroll{max-width:100%;overflow-x:auto}.equivalent-table table{width:100%;margin-top:10px;border-collapse:collapse;white-space:nowrap}.equivalent-table th,.equivalent-table td{padding:8px 10px;border-bottom:1px solid var(--cockpit-table-border,#dce9fb);text-align:left}.equivalent-table th{color:var(--cockpit-heading,#123b79)}.equivalent-table td:first-child{display:flex;align-items:center;gap:6px}@media (max-width:600px){.bar-row{grid-template-columns:1fr}.bar-track{height:10px}}
</style>
