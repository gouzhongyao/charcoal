<template>
  <section class="topology-card viz-root" :aria-labelledby="topologyHeadingId">
    <header class="topology-heading">
      <div>
        <h2 :id="topologyHeadingId">显式物理拓扑</h2>
        <p>坐标、节点、方向边和来源均来自当前模型，不从组织树推导。</p>
      </div>
      <div class="topology-actions" aria-label="拓扑缩放操作">
        <el-button size="small" :disabled="zoom <= 0.7" @click="changeZoom(-0.15)">缩小</el-button>
        <el-button size="small" @click="fitTopology">适配</el-button>
        <el-button size="small" :disabled="zoom >= 2" @click="changeZoom(0.15)">放大</el-button>
        <span aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
      </div>
    </header>

    <div v-if="legendRows.length" class="topology-legend" aria-label="能源类型图例">
      <span v-for="item in legendRows" :key="item.key"><i :style="{ backgroundColor: item.color }" />{{ item.label }}</span>
      <span><b class="status-mark complete">✓</b>完整</span>
      <span><b class="status-mark missing">!</b>缺失或异常</span>
    </div>

    <PageState v-if="!layout.nodes.length" description="当前模型没有可展示的显式节点。" />
    <template v-else>
      <div class="topology-scroll" tabindex="0" aria-label="能流 SVG 拓扑，可横向和纵向滚动">
        <svg
          class="topology-svg"
          :style="{ width: `${zoom * 100}%` }"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="img"
          :aria-labelledby="`${svgTitleId} ${svgDescId}`"
          @mouseleave="tooltip = null"
        >
          <title :id="svgTitleId">能流显式物理拓扑</title>
          <desc :id="svgDescId">每条边按起点到终点绘制箭头，并直接标注边编码、数值、单位和状态；下方提供等价表格。</desc>
          <defs>
            <marker
              v-for="marker in markerRows"
              :id="`${markerPrefix}-${marker.slot}`"
              :key="marker.slot"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L8,4 L0,8 z" :fill="marker.color" />
            </marker>
          </defs>

          <g
            v-for="edge in edgeRows"
            :key="`edge-${edge.id}`"
            class="edge-group"
            tabindex="0"
            role="group"
            :aria-label="edgeAriaLabel(edge)"
            @mouseenter="tooltip = { type: 'edge', row: edge }"
            @focus="tooltip = { type: 'edge', row: edge }"
          >
            <line
              v-if="edge.visible"
              :x1="edge.x1"
              :y1="edge.y1"
              :x2="edge.x2"
              :y2="edge.y2"
              class="edge-hit-line"
              stroke="transparent"
            />
            <line
              v-if="edge.visible"
              :x1="edge.x1"
              :y1="edge.y1"
              :x2="edge.x2"
              :y2="edge.y2"
              :stroke="edge.color"
              :class="['edge-line', { 'edge-line--warning': edge.analysisStatus !== 'complete' }]"
              :marker-end="`url(#${markerPrefix}-${edge.colorSlot})`"
            />
            <text v-if="edge.visible" :x="edge.labelX" :y="edge.labelY" text-anchor="middle" class="edge-label">
              {{ edge.energyTypeName || edge.energyTypeCode || '未知能源' }} · {{ edge.edgeCode }} · {{ edgeDisplayValue(edge) }} {{ edgeDisplayUnit(edge) }} · {{ analysisStatusLabel(edge.analysisStatus) }}
            </text>
          </g>

          <g
            v-for="node in layout.nodes"
            :key="`node-${node.id}`"
            class="node-group"
            tabindex="0"
            role="group"
            :aria-label="`${node.nodeName}，${nodeTypeLabel(node.nodeType)}节点，状态${statusLabel(node.status)}`"
            @mouseenter="tooltip = { type: 'node', row: node }"
            @focus="tooltip = { type: 'node', row: node }"
          >
            <rect
              :x="node.displayX - node.width / 2"
              :y="node.displayY - node.height / 2"
              :width="node.width"
              :height="node.height"
              rx="10"
              :class="['node-box', `node-box--${node.nodeType}`, { 'node-box--inactive': node.status !== 'active' }]"
            />
            <text :x="node.displayX" :y="node.displayY - 3" text-anchor="middle" class="node-title">{{ node.nodeName }}</text>
            <text :x="node.displayX" :y="node.displayY + 16" text-anchor="middle" class="node-subtitle">{{ node.nodeCode }} · {{ nodeTypeLabel(node.nodeType) }}</text>
          </g>
        </svg>
      </div>

      <p v-if="tooltip" class="topology-tooltip" role="status">{{ tooltipText }}</p>

      <el-tabs class="equivalent-tabs">
        <el-tab-pane label="节点等价表格">
          <div class="table-scroll">
            <el-table :data="layout.nodes" size="small" stripe>
              <el-table-column prop="nodeCode" label="节点编码" min-width="120" />
              <el-table-column prop="nodeName" label="节点名称" min-width="140" />
              <el-table-column label="类型" min-width="100"><template #default="{ row }">{{ nodeTypeLabel(row.nodeType) }}</template></el-table-column>
              <el-table-column label="显式坐标" min-width="130"><template #default="{ row }">{{ row.x }}, {{ row.y }}</template></el-table-column>
              <el-table-column label="状态" min-width="90"><template #default="{ row }">{{ statusLabel(row.status) }}</template></el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
        <el-tab-pane label="边等价表格">
          <div class="table-scroll">
            <el-table :data="edgeRows" size="small" stripe>
              <el-table-column prop="edgeCode" label="边编码" min-width="120" />
              <el-table-column prop="directionLabel" label="方向" min-width="210" />
              <el-table-column prop="energyTypeName" label="能源类型" min-width="120"><template #default="{ row }">{{ row.energyTypeName || row.energyTypeCode }}</template></el-table-column>
              <el-table-column label="数值" min-width="135"><template #default="{ row }">{{ edgeDisplayValue(row) }} {{ edgeDisplayUnit(row) }}</template></el-table-column>
              <el-table-column label="分析状态" min-width="120"><template #default="{ row }">{{ analysisStatusLabel(row.analysisStatus) }}</template></el-table-column>
              <el-table-column label="原因说明" min-width="320"><template #default="{ row }">{{ reasonSummary(row) }}</template></el-table-column>
              <el-table-column label="显式来源" min-width="300" show-overflow-tooltip><template #default="{ row }">{{ sourceSummary(row) }}</template></el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>
  </section>
</template>

<script setup>
import { computed, getCurrentInstance, ref } from 'vue';
import PageState from '@/components/PageState.vue';
import {
  ENERGY_FLOW_NODE_TYPES,
  buildDeterministicEnergyFlowTopology,
  buildEnergyFlowEdgePresentation,
  energyFlowReasonText,
  energyFlowSourceSummary,
  formatEnergyFlowValue
} from '@/utils/energyFlow';

// 拓扑组件输入模块。
const props = defineProps({
  topology: { type: Object, default: () => ({ nodes: [], edges: [] }) },
  edgeValues: { type: Array, default: () => [] },
  colorDomain: { type: Array, default: () => [] },
  standardCoalView: { type: String, default: 'original' }
});

// 拓扑交互状态模块，实例标识避免同页多个 SVG 的箭头定义冲突。
const instanceId = getCurrentInstance()?.uid ?? 'default';
const topologyHeadingId = `energy-flow-topology-${instanceId}`;
const svgTitleId = `energy-flow-svg-title-${instanceId}`;
const svgDescId = `energy-flow-svg-desc-${instanceId}`;
const markerPrefix = `energy-flow-arrow-${instanceId}`;
const zoom = ref(1);
const tooltip = ref(null);

// 拓扑派生数据模块，SVG 与表格共用同一确定性展示模型。
const layout = computed(() => buildDeterministicEnergyFlowTopology(props.topology?.nodes || [], props.topology?.edges || []));
const edgeRows = computed(() => buildEnergyFlowEdgePresentation(layout.value, props.edgeValues || [], { colorDomain: props.colorDomain }));
const legendRows = computed(() => {
  const seen = new Set();
  return edgeRows.value.filter((edge) => {
    const key = edge.isOtherSeries ? 'other' : String(edge.energyTypeCode || 'unknown');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((edge) => ({
    key: edge.isOtherSeries ? 'other' : String(edge.energyTypeCode || 'unknown'),
    label: edge.isOtherSeries ? '其他能源（超出固定色序）' : (edge.energyTypeName || edge.energyTypeCode || '未知能源'),
    color: edge.color
  }));
});
const markerRows = computed(() => {
  const seen = new Set();
  return edgeRows.value.filter((edge) => {
    if (seen.has(edge.colorSlot)) return false;
    seen.add(edge.colorSlot);
    return true;
  }).map((edge) => ({ slot: edge.colorSlot, color: edge.color }));
});
const tooltipText = computed(() => {
  const current = tooltip.value;
  if (!current) return '';
  if (current.type === 'node') {
    return `${current.row.nodeName}（${current.row.nodeCode}）：${nodeTypeLabel(current.row.nodeType)}节点，显式坐标 ${current.row.x}, ${current.row.y}，${statusLabel(current.row.status)}。`;
  }
  const edge = current.row;
  return `${edge.directionLabel}；${edge.energyTypeName || edge.energyTypeCode || '未知能源'}；${edge.edgeCode}；${edgeDisplayValue(edge)} ${edgeDisplayUnit(edge)}；${analysisStatusLabel(edge.analysisStatus)}；${sourceSummary(edge)}；${reasonSummary(edge)}`;
});

/**
 * 调整拓扑缩放比例。
 * @param {number} delta 缩放增量。
 */
function changeZoom(delta) {
  zoom.value = Math.min(2, Math.max(0.7, Number((zoom.value + delta).toFixed(2))));
}

/** 将拓扑恢复为适配视图。 */
function fitTopology() { zoom.value = 1; }

/** 返回节点类型中文文案。 */
function nodeTypeLabel(value) { return ENERGY_FLOW_NODE_TYPES.find((item) => item.value === value)?.label || value || '未知'; }
/** 返回启停状态中文文案。 */
function statusLabel(value) { return value === 'active' ? '启用' : value === 'inactive' ? '停用' : value || '未知'; }
/** 返回边分析状态中文文案。 */
function analysisStatusLabel(value) {
  return ({ complete: '完整', partial: '覆盖不足', missing: '缺失', unmapped: '未映射', unavailable: '不可用', unit_not_comparable: '单位不可比', not_analyzed: '未分析' })[value] || value || '未知';
}
/** 返回边来源摘要。 */
function sourceSummary(edge) { return energyFlowSourceSummary(edge); }
/** 返回边原因码及中文等价说明。 */
function reasonSummary(edge) {
  return edge.reasonCodes?.length
    ? edge.reasonCodes.map((code) => `${code}：${energyFlowReasonText(code)}`).join('；')
    : '无原因码';
}

/**
 * 按当前原单位/折标视图返回边数值。
 * @param {object} edge 边展示行。
 * @returns {string} 数值文本。
 */
function edgeDisplayValue(edge) {
  if (props.standardCoalView === 'kgce') return formatEnergyFlowValue(edge.analysis?.standardCoal?.kgce);
  if (props.standardCoalView === 'tce') return formatEnergyFlowValue(edge.analysis?.standardCoal?.tce);
  return formatEnergyFlowValue(edge.value, edge.trueZero);
}

/**
 * 按当前原单位/折标视图返回单位。
 * @param {object} edge 边展示行。
 * @returns {string} 单位。
 */
function edgeDisplayUnit(edge) {
  if (props.standardCoalView === 'kgce') return 'kgce';
  if (props.standardCoalView === 'tce') return 'tce';
  return edge.unit || '';
}

/** 返回边键盘可访问说明，内容与 tooltip 和等价表格一致。 */
function edgeAriaLabel(edge) {
  return `${edge.directionLabel}，${edge.energyTypeName || edge.energyTypeCode || '未知能源'}，${edge.edgeCode}，${edgeDisplayValue(edge)} ${edgeDisplayUnit(edge)}，${analysisStatusLabel(edge.analysisStatus)}，${sourceSummary(edge)}，${reasonSummary(edge)}`;
}
</script>

<style scoped>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-other:#657287}.topology-card{min-width:0;padding:18px;background:#fff;border:1px solid #dbe7f5;border-radius:12px}.topology-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.topology-heading h2{margin:0;color:#123b79;font-size:17px}.topology-heading p{margin:6px 0 0;color:#61728c;font-size:13px;line-height:1.6}.topology-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.topology-actions span{min-width:42px;color:#516170;font-size:12px;text-align:right}.topology-legend{display:flex;flex-wrap:wrap;gap:12px 18px;margin:14px 0;color:#516170;font-size:12px}.topology-legend span{display:inline-flex;align-items:center;gap:6px}.topology-legend i{width:12px;height:12px;border:1px solid rgba(11,11,11,.16);border-radius:3px}.status-mark{display:inline-grid;width:16px;height:16px;place-items:center;border-radius:50%;font-size:11px}.status-mark.complete{color:#0b6b0b;background:#e6f6e6}.status-mark.missing{color:#8b4d00;background:#fff2d1}.topology-scroll{max-width:100%;max-height:620px;overflow:auto;background:var(--surface-1);border:1px solid #e1e0d9;border-radius:10px}.topology-scroll:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.topology-svg{display:block;min-width:760px;min-height:460px;transition:width .15s ease}.edge-hit-line{stroke-width:24;fill:none;pointer-events:stroke}.edge-line{stroke-width:3;fill:none;pointer-events:none}.edge-line--warning{stroke-dasharray:8 5}.edge-label{fill:var(--text-secondary);font-size:12px;font-weight:600;paint-order:stroke;stroke:var(--surface-1);stroke-width:5px;stroke-linejoin:round}.edge-group:focus{outline:none}.edge-group:focus .edge-line,.edge-group:hover .edge-line{stroke-width:5}.node-box{fill:#edf5ff;stroke:#2a78d6;stroke-width:2}.node-box--source{fill:#eaf7f1;stroke:#1b8f68}.node-box--storage{fill:#fff4dc;stroke:#bd7d00}.node-box--sink{fill:#f2edff;stroke:#6751b5}.node-box--loss{fill:#fff0ea;stroke:#c45229}.node-box--boundary{fill:#f1f3f6;stroke:#657287}.node-box--inactive{stroke-dasharray:6 4;opacity:.72}.node-title{fill:var(--text-primary);font-size:13px;font-weight:700}.node-subtitle{fill:var(--text-secondary);font-size:11px}.node-group:focus{outline:none}.node-group:focus .node-box,.node-group:hover .node-box{stroke-width:4}.topology-tooltip{margin:10px 0 0;padding:9px 11px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px;line-height:1.6}.equivalent-tabs{margin-top:14px}.table-scroll{max-width:100%;overflow-x:auto}@media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--text-primary:#fff;--text-secondary:#c3c2b7;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-other:#898781}}:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--text-primary:#fff;--text-secondary:#c3c2b7;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-other:#898781}@media(max-width:760px){.topology-heading{flex-direction:column}.topology-actions{width:100%}}
</style>
