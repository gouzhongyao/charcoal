<template>
  <article class="chart-panel page-card">
    <header><h2>{{ title }}</h2><HelpIcon :label="`查看${title}说明`" :content="help" /></header>
    <PageState v-if="error" :error="error" @retry="$emit('retry')" />
    <PageState v-else-if="!rows.length" description="当前筛选下暂无真实统计数据" />
    <template v-else>
      <div class="bars" @mouseleave="active = null">
        <button v-for="row in rows" :key="row.label" type="button" class="bar-row" :aria-label="`${row.label}：${format(row.value)}`" @mouseenter="active = row" @focus="active = row">
          <span class="label">{{ row.label }}</span><span class="track"><i :style="{ width: `${percent(row.value)}%`, background: row.color }" /></span><span class="value">{{ format(row.value) }}</span>
        </button>
      </div>
      <p v-if="active" class="tooltip" role="status">{{ active.label }}：{{ format(active.value) }}</p>
      <el-table :data="rows" size="small" class="fallback"><el-table-column prop="label" label="维度" /><el-table-column label="数值"><template #default="{ row }">{{ format(row.value) }}</template></el-table-column></el-table>
    </template>
  </article>
</template>
<script setup>
import { computed, ref } from 'vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
const props = defineProps({ title: String, help: String, rows: { type: Array, default: () => [] }, error: String });
defineEmits(['retry']);
const active = ref(null); const max = computed(() => Math.max(...props.rows.map((row) => Number(row.value) || 0), 1));
const percent = (value) => Math.max(2, Math.min(100, ((Number(value) || 0) / max.value) * 100));
const format = (value) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value) || 0);
</script>
<style scoped>
.chart-panel header{display:flex;align-items:center;gap:4px;margin-bottom:12px}.chart-panel h2{margin:0;color:#123b79;font-size:16px}.bars{display:grid;gap:8px}.bar-row{display:grid;grid-template-columns:minmax(92px,1fr) minmax(120px,2fr) minmax(72px,.6fr);gap:9px;align-items:center;padding:5px 2px;color:#183153;text-align:left;background:transparent;border:0;border-radius:6px}.bar-row:hover{background:#f7fbff}.bar-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.track{height:14px;padding-right:2px;background:#e7f1ff;border-radius:999px}.track i{display:block;height:14px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.value{color:#516170;text-align:right;font-size:12px}.tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px}.fallback{width:100%;margin-top:10px}@media(max-width:600px){.bar-row{grid-template-columns:1fr}.value{text-align:left}}
</style>
