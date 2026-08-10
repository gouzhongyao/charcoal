<template>
  <section class="balance-visual" aria-label="平衡输入输出发散对比">
    <div class="chart-legend" aria-label="平衡图例">
      <span><i class="legend-mark tone-input" />输入</span>
      <span><i class="legend-mark tone-output" />输出</span>
      <span><i class="legend-mark tone-storage" />储能变化</span>
      <span><i class="legend-mark tone-difference" />不可解释差额</span>
      <small>全部条形共用一条数值轴，中心线左右只表达平衡方向。</small>
    </div>

    <div class="diverging-chart" @mouseleave="activeRow = null">
      <div class="axis-caption"><span>输入侧 / 负向变化</span><span>输出侧 / 正向变化</span></div>
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        class="diverging-row"
        :aria-label="rowAriaLabel(row)"
        @mouseenter="activeRow = row"
        @focus="activeRow = row"
      >
        <span class="metric-label">{{ row.label }}</span>
        <span class="bar-axis">
          <span class="axis-center" />
          <span
            v-if="hasVisibleBar(row)"
            class="bar-mark"
            :class="[`bar-${row.side}`, `tone-${row.tone}`]"
            :style="{ width: `${barWidth(row)}%` }"
          />
          <span v-else-if="!row.available" class="unavailable-mark">不可计算</span>
        </span>
        <span class="metric-value">{{ formatValue(row.value) }} {{ row.unit }}</span>
      </button>
    </div>

    <p v-if="activeRow" class="chart-tooltip" role="status">{{ rowAriaLabel(activeRow) }}</p>

    <div class="table-scroll" aria-label="平衡图等价表格">
      <el-table :data="rows" size="small" class="chart-table">
        <el-table-column prop="label" label="指标" min-width="130" />
        <el-table-column label="数值" min-width="150">
          <template #default="{ row }">{{ formatValue(row.value) }} {{ row.unit }}</template>
        </el-table-column>
        <el-table-column label="方向" min-width="150">
          <template #default="{ row }">{{ row.available ? sideLabel(row) : '不可计算' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.available ? 'success' : 'warning'" size="small">
              {{ row.available ? '可展示' : '不可计算' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { calculateBalanceBarWidth } from '@/utils/energyBalanceManagement';

/** 由父页面统一构造、同时驱动图形和表格的数据行。 */
const props = defineProps({ rows: { type: Array, default: () => [] } });
/** 当前键盘聚焦或鼠标悬停的图形行。 */
const activeRow = ref(null);
/** 单轴采用全部可计算绝对值中的最大值。 */
const maximumValue = computed(() => Math.max(
  ...props.rows.filter((row) => row.available).map((row) => Number(row.absoluteValue) || 0),
  1
));

/** 计算半轴中的真实可见条形长度；整行按钮独立承担交互命中。 */
function barWidth(row) {
  return calculateBalanceBarWidth(row.absoluteValue, maximumValue.value);
}

/** 判断当前行是否需要渲染可见条形，真实零值不创建带边框的图形标记。 */
function hasVisibleBar(row) {
  return row.available && barWidth(row) > 0;
}

/** 格式化图表业务数值。 */
function formatValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(Number(value));
}

/** 返回发散方向的文字说明，避免只依赖颜色和位置。 */
function sideLabel(row) {
  if (row.key === 'input') return '输入侧';
  if (row.key === 'output') return '输出侧';
  if (row.key === 'storage') return row.value < 0 ? '库存减少 / 输入侧' : '库存增加 / 输出侧';
  return row.value >= 0 ? '输入大于输出' : '输出大于输入';
}

/** 返回图形行的可访问说明。 */
function rowAriaLabel(row) {
  return row.available
    ? `${row.label}：${formatValue(row.value)} ${row.unit}，${sideLabel(row)}。`
    : `${row.label}：不可计算，请查看下方原因码。`;
}
</script>

<style scoped>
.balance-visual{display:grid;gap:10px}.chart-legend{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;color:#516170;font-size:12px}.chart-legend span{display:inline-flex;align-items:center;gap:5px}.chart-legend small{color:#7385a2}.legend-mark{width:11px;height:11px;border:1px solid rgba(11,11,11,.15);border-radius:3px}.diverging-chart{display:grid;gap:6px;min-width:620px;padding:12px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:10px}.axis-caption{display:grid;grid-template-columns:1fr 1fr;margin-left:152px;color:#7385a2;font-size:11px;text-align:center}.diverging-row{display:grid;grid-template-columns:140px minmax(300px,1fr) 150px;align-items:center;gap:12px;width:100%;padding:7px;color:#183153;text-align:left;background:transparent;border:0;border-radius:7px}.diverging-row:hover{background:#f3f8ff}.diverging-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.metric-label{font-size:13px;font-weight:600}.metric-value{font-size:12px;text-align:right;white-space:nowrap}.bar-axis{position:relative;height:18px;background:linear-gradient(90deg,#f4f7fb 0 49.7%,#d4deeb 49.7% 50.3%,#f4f7fb 50.3% 100%);border-radius:5px;overflow:hidden}.axis-center{position:absolute;top:0;bottom:0;left:50%;width:1px;background:#9aacc2}.bar-mark{position:absolute;top:3px;height:12px;border:1px solid rgba(11,11,11,.08)}.bar-left{right:50%;border-right:2px solid #fcfcfb;border-radius:4px 0 0 4px}.bar-right{left:50%;border-left:2px solid #fcfcfb;border-radius:0 4px 4px 0}.tone-input{background:#2a78d6}.tone-output{background:#eb6834}.tone-storage{background-color:#1baf7a;background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.35) 4px 6px)}.tone-difference{background-color:#e34948;background-image:repeating-linear-gradient(135deg,transparent 0 4px,rgba(255,255,255,.35) 4px 6px)}.unavailable-mark{position:absolute;left:50%;transform:translateX(-50%);color:#926d13;font-size:11px;line-height:18px;white-space:nowrap}.chart-tooltip{margin:0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:12px}.table-scroll{max-width:100%;overflow-x:auto}.chart-table{min-width:560px}@media (max-width:760px){.balance-visual{overflow-x:auto}}
</style>
