<template>
  <main class="standard-dashboard">
    <header class="standard-header">
      <div class="standard-header__title">
        <span>LOCAL ENERGY &amp; CARBON PLATFORM</span>
        <h1>中控</h1>
        <p>基于本地 SQLite 已入库真实数据展示年度用能、已保存碳排、预算执行、计量器具台账和全历史导入累计。</p>
      </div>
      <div class="standard-controls" aria-label="中控筛选与显示控制">
        <label>
          <span>统计年度</span>
          <el-select :model-value="viewModel.selectedYear" aria-label="选择中控统计年度" @change="emit('change-year', $event)">
            <el-option v-for="year in viewModel.yearOptions" :key="year" :label="`${year} 年`" :value="year" />
          </el-select>
        </label>
        <el-button type="primary" :loading="viewModel.annualLoading" @click="emit('refresh')">刷新中控</el-button>
        <el-button @click="emit('toggle-immersive')">大屏模式</el-button>
      </div>
      <div class="standard-meta" aria-live="polite">
        <span>年度范围 {{ viewModel.selectedRange.normalizedMonthStart }} 至 {{ viewModel.selectedRange.normalizedMonthEnd }}</span>
        <span>最后更新 {{ formatDateTime(viewModel.lastUpdated) }}</span>
        <span>标准布局 · 年度仅影响能耗、碳排和预算</span>
      </div>
    </header>

    <section class="summary-grid" aria-label="中控摘要卡片">
      <article class="summary-card summary-card--energy">
        <span>年度能源用量</span>
        <template v-if="viewModel.energyPanel.status === 'success'">
          <template v-if="viewModel.selectedEnergySeries">
            <strong>{{ formatNumber(viewModel.selectedEnergySeries.totalValue, 2) }} <small>{{ viewModel.selectedEnergySeries.normalizedUnit }}</small></strong>
            <p>{{ viewModel.selectedEnergySeries.energyTypeName || viewModel.selectedEnergySeries.energyTypeCode }} · {{ formatInteger(viewModel.selectedEnergySeries.recordCount) }} 条选定序列记录</p>
          </template>
          <template v-else>
            <strong>—</strong>
            <p>当前没有可展示的单一能源类型与标准单位序列。</p>
          </template>
        </template>
        <strong v-else-if="viewModel.energyPanel.status === 'empty'">0</strong>
        <p v-else>{{ panelStatusLabel(viewModel.energyPanel) }}</p>
      </article>
      <article class="summary-card summary-card--carbon">
        <span>已保存碳排</span>
        <template v-if="viewModel.carbonPanel.status === 'success'">
          <strong v-if="!viewModel.carbonProjection.hasOnlyMissingFactors">{{ formatNumber(viewModel.selectedCarbonTotal, 4) }} <small>{{ viewModel.selectedCarbonUnit }}</small></strong>
          <strong v-else class="summary-card__gap">无法形成</strong>
          <p>已计算 {{ formatInteger(viewModel.carbonProjection.calculatedCount) }} 条 · 因子缺失 {{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} 条</p>
        </template>
        <strong v-else-if="viewModel.carbonPanel.status === 'empty'">0</strong>
        <p v-else>{{ panelStatusLabel(viewModel.carbonPanel) }}</p>
      </article>
      <article class="summary-card summary-card--budget">
        <span>用能预算风险</span>
        <template v-if="viewModel.budgetPanel.status === 'success'">
          <strong>{{ formatInteger(viewModel.budgetProjection.warningCount) }} <small>项</small></strong>
          <p>超预算 {{ formatInteger(viewModel.budgetProjection.counts.exceeded) }} · 接近 {{ formatInteger(viewModel.budgetProjection.counts.nearing) }} · 缺预算 {{ formatInteger(viewModel.budgetProjection.counts.missingBudget) }} · 单位不一致 {{ formatInteger(viewModel.budgetProjection.counts.unitMismatch) }}</p>
        </template>
        <strong v-else-if="viewModel.budgetPanel.status === 'empty'">0</strong>
        <p v-else>{{ panelStatusLabel(viewModel.budgetPanel) }}</p>
      </article>
      <article class="summary-card summary-card--meter">
        <span>计量器具</span>
        <template v-if="viewModel.meterPanel.status === 'success'">
          <strong>{{ formatInteger(viewModel.meterPanel.data?.total) }} <small>台账</small></strong>
          <p>启用 {{ formatInteger(viewModel.meterPanel.data?.active) }} · 停用 {{ formatInteger(viewModel.meterPanel.data?.inactive) }} · 非实时遥测</p>
        </template>
        <strong v-else-if="viewModel.meterPanel.status === 'empty'">0</strong>
        <p v-else>{{ panelStatusLabel(viewModel.meterPanel) }}</p>
      </article>
      <article class="summary-card summary-card--import">
        <span>导入累计</span>
        <template v-if="viewModel.importPanel.status === 'success'">
          <strong>{{ formatInteger(viewModel.importPanel.data?.imports?.batchCount) }} <small>批次</small></strong>
          <p>成功 {{ formatInteger(viewModel.importPanel.data?.imports?.importedRowCount) }} · 失败/跳过 {{ formatInteger(viewModel.importPanel.data?.imports?.failedRowCount) }}/{{ formatInteger(viewModel.importPanel.data?.imports?.skippedRowCount) }} · 阻断/警告 {{ formatInteger(viewModel.importPanel.data?.errors?.blockingErrorCount) }}/{{ formatInteger(viewModel.importPanel.data?.errors?.warningCount) }} · 最新活动 {{ formatDateTime(viewModel.importPanel.data?.imports?.latestBatchAt) }} · 全历史累计，不随年度变化</p>
        </template>
        <strong v-else-if="viewModel.importPanel.status === 'empty'">0</strong>
        <p v-else>{{ panelStatusLabel(viewModel.importPanel) }}</p>
      </article>
    </section>

    <section class="standard-grid" aria-label="中控真实数据面板">
      <CockpitPanel class="standard-span-two" title="年度用能分析" eyebrow="ENERGY ANALYSIS" description="趋势按 energyTypeCode + normalizedUnit 拆分为单一数值轴；环图只展示当前 normalizedUnit 的真实结构。" :status="viewModel.energyPanel.status" :error="viewModel.energyPanel.error" forbidden-text="需要能耗记录或能耗统计查看权限。dashboard:view 不替代领域权限。" empty-text="当前年度暂无 active 能耗记录。" wide @retry="emit('retry-energy')">
        <template #actions>
          <el-select v-if="viewModel.energyPanel.status === 'success' && viewModel.energySeries.length" :model-value="viewModel.selectedEnergySeriesKey" class="panel-select" aria-label="选择能源趋势序列" @change="emit('select-energy-series', $event)">
            <el-option v-for="series in viewModel.energySeries" :key="series.key" :label="`${series.energyTypeName} · ${series.normalizedUnit}`" :value="series.key" />
          </el-select>
        </template>
        <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无 active 能耗记录。</span></template>
        <div class="metric-row">
          <div><span>当前单位组总量</span><strong>{{ formatNumber(viewModel.selectedEnergyUnitGroup?.totalValue, 2) }} <small>{{ viewModel.selectedEnergyUnit }}</small></strong></div>
          <div><span>选定序列记录</span><strong>{{ formatInteger(viewModel.selectedEnergySeries?.recordCount) }} <small>条</small></strong></div>
          <div><span>能源单位组</span><strong>{{ formatInteger(viewModel.energyUnitGroups.length) }} <small>组</small></strong></div>
          <div><span>数据月份</span><strong>{{ viewModel.energyMonthRange }}</strong></div>
        </div>
        <div class="analysis-grid">
          <EnergyTrendChart v-if="viewModel.selectedEnergySeries" :series="viewModel.selectedEnergySeries" :color="energyColor(viewModel.selectedEnergySeries.energyTypeCode)" />
          <UnitDonutChart v-if="viewModel.energyStructureRows.length" chart-id="standard-energy-structure" title="年度能源结构" description="仅比较当前标准单位下的能源类型，不跨单位合计。" :unit="viewModel.selectedEnergyUnit" :rows="viewModel.energyStructureRows" center-label="当前单位总量" />
        </div>
      </CockpitPanel>

      <CockpitPanel class="standard-span-two" title="年度碳排分析" eyebrow="CARBON ANALYSIS" description="只展示已保存的真实碳排结果，并按 emissionUnit 隔离；因子缺失不估算排放。" :status="viewModel.carbonPanel.status" :error="viewModel.carbonPanel.error" forbidden-text="需要 carbon:emissions:view 权限；dashboard:view 不替代碳排领域权限。" empty-text="当前年度暂无碳排放结果。" wide @retry="emit('retry-carbon')">
        <template #actions>
          <el-select v-if="viewModel.carbonPanel.status === 'success' && viewModel.carbonUnitGroups.length" :model-value="viewModel.selectedCarbonUnit" class="panel-select panel-select--small" aria-label="选择碳排放单位" @change="emit('select-carbon-unit', $event)">
            <el-option v-for="group in viewModel.carbonUnitGroups" :key="group.unit" :label="group.unit" :value="group.unit" />
          </el-select>
        </template>
        <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无碳排放结果。</span></template>
        <div class="metric-row metric-row--compact">
          <div><span>排放总量</span><strong v-if="!viewModel.carbonProjection.hasOnlyMissingFactors">{{ formatNumber(viewModel.selectedCarbonTotal, 4) }} <small>{{ viewModel.selectedCarbonUnit }}</small></strong><strong v-else class="metric-gap-text">无法形成</strong></div>
          <div><span>已计算结果</span><strong>{{ formatInteger(viewModel.carbonProjection.calculatedCount) }} <small>条</small></strong></div>
          <div><span>因子缺失</span><strong>{{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} <small>条</small></strong></div>
        </div>
        <div v-if="viewModel.carbonProjection.hasOnlyMissingFactors" class="carbon-gap-state" role="status">
          <strong>因子缺失，无法形成排放总量</strong>
          <span>当前年度没有可用于总量、趋势或结构的已核算碳排结果，因此不显示伪零单位组、零线或伪扇区。</span>
        </div>
        <template v-else>
          <div class="analysis-grid">
            <EnergyTrendChart v-if="viewModel.selectedCarbonSeries" :series="viewModel.selectedCarbonSeries" :color="viewModel.carbonTrendColor" />
            <UnitDonutChart v-if="viewModel.carbonStructureRows.length" chart-id="standard-carbon-structure" title="按能源类型的碳排结构" description="仅比较当前排放单位下已有真实核算结果。" :unit="viewModel.selectedCarbonUnit" :rows="viewModel.carbonStructureRows" center-label="已核算总量" />
          </div>
          <p v-if="viewModel.carbonProjection.hasMissingGap" class="boundary-note">当前仅展示真实已核算总量和趋势；另有 {{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} 条记录因子缺失，未纳入排放总量与趋势。</p>
        </template>
      </CockpitPanel>

      <CockpitPanel class="standard-span-two" title="用能预算执行明细" eyebrow="BUDGET EXECUTION" description="按年度 active 预算与相同月份、能源类型的 active 能耗记录比较；单位不一致行明确标记为不可比较。" :status="viewModel.budgetPanel.status" :error="viewModel.budgetPanel.error" forbidden-text="需要 energy:budget:view 权限；dashboard:view 不替代预算领域权限。" empty-text="当前年度暂无 active 用能预算比较结果。" wide @retry="emit('retry-budget')">
        <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无用能预算比较结果。</span></template>
        <div class="warning-summary" :class="`warning-summary--${viewModel.budgetProjection.highestLevel}`">
          <div><span>预警项</span><strong>{{ formatInteger(viewModel.budgetProjection.warningCount) }}</strong></div>
          <div><span>超预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.exceeded) }}</strong></div>
          <div><span>接近预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.nearing) }}</strong></div>
          <div><span>未配置预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.missingBudget) }}</strong></div>
          <div><span>单位不一致 / 不可比较</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.unitMismatch) }}</strong></div>
        </div>
        <div v-if="viewModel.budgetProjection.warningRows.length" class="warning-list" aria-label="用能预算预警明细">
          <div v-for="row in viewModel.budgetProjection.warningRows.slice(0, 6)" :key="budgetRowKey(row)" class="warning-item">
            <span class="status-dot" :class="`status-dot--${row.dashboardWarningLevel}`" aria-hidden="true" />
            <div><strong>{{ row.energyTypeName || row.energyTypeCode }} · {{ row.periodMonth }}</strong><span>{{ row.organizationScope }} · {{ budgetWarningLabel(row) }} · {{ budgetUsageLabel(row) }}</span></div>
          </div>
        </div>
        <p v-else class="success-note">当前年度预算比较未触发预警。</p>
        <details class="data-details"><summary>查看预算比较等价数据表</summary><div class="table-scroll"><table><thead><tr><th scope="col">月份</th><th scope="col">能源类型</th><th scope="col">组织范围</th><th scope="col">状态</th><th scope="col">预算值</th><th scope="col">实际值</th></tr></thead><tbody><tr v-for="row in viewModel.budgetPanel.data?.rows || []" :key="`table-${budgetRowKey(row)}`"><td>{{ row.periodMonth }}</td><td>{{ row.energyTypeName || row.energyTypeCode }}</td><td>{{ row.organizationScope }}</td><td>{{ budgetWarningLabel(row) }}</td><td>{{ formatNumber(row.budgetValue, 2) }} {{ row.budgetUnit || row.unit || '—' }}</td><td>{{ formatNumber(row.actualValue, 2) }} {{ row.actualUnit || '—' }}</td></tr></tbody></table></div></details>
      </CockpitPanel>

      <CockpitPanel title="计量器具台账快照" eyebrow="METER LEDGER" description="当前快照来自本地计量器具台账，不是实时遥测、联网在线判断或网关心跳。" :status="viewModel.meterPanel.status" :error="viewModel.meterPanel.error" forbidden-text="需要 ledger:meters:view 权限；dashboard:view 不替代基础台账权限。" empty-text="本地台账暂无计量器具。" @retry="emit('retry-meter')">
        <template #empty><strong class="panel-empty-value">0</strong><span>本地计量器具台账暂无记录。</span></template>
        <div class="meter-kpi"><strong>{{ formatInteger(viewModel.meterPanel.data?.total) }}</strong><span>台账总数</span></div>
        <div class="meter-status-grid">
          <div><span>启用</span><strong>{{ formatInteger(viewModel.meterPanel.data?.active) }}</strong><i><b :style="{ width: `${viewModel.meterActivePercentage}%` }" /></i></div>
          <div><span>停用</span><strong>{{ formatInteger(viewModel.meterPanel.data?.inactive) }}</strong><i><b class="meter-bar--inactive" :style="{ width: `${viewModel.meterInactivePercentage}%` }" /></i></div>
        </div>
        <p class="boundary-note">“启用/停用”是台账维护状态；onlineStatus 即使存在也仅为本地字段，不代表实时设备在线。</p>
      </CockpitPanel>

      <CockpitPanel title="导入累计摘要" eyebrow="IMPORT SUMMARY" description="展示全历史导入批次和问题累计值，不随年度筛选变化；仅补充最新活动时间。" :status="viewModel.importPanel.status" :error="viewModel.importPanel.error" forbidden-text="需要 imports:view 权限；dashboard:view 不替代导入中心权限。" empty-text="当前没有导入批次或导入问题。" @retry="emit('retry-import')">
        <template #empty><strong class="panel-empty-value">0</strong><span>当前没有导入批次或导入问题。</span></template>
        <div class="import-grid">
          <div><span>导入批次</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.batchCount) }}</strong></div>
          <div><span>成功写入</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.importedRowCount) }}</strong></div>
          <div><span>失败 / 跳过行</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.failedRowCount) }} / {{ formatInteger(viewModel.importPanel.data?.imports?.skippedRowCount) }}</strong></div>
          <div><span>阻断 / 警告</span><strong>{{ formatInteger(viewModel.importPanel.data?.errors?.blockingErrorCount) }} / {{ formatInteger(viewModel.importPanel.data?.errors?.warningCount) }}</strong></div>
        </div>
        <p class="boundary-note">最新活动时间：{{ formatDateTime(viewModel.importPanel.data?.imports?.latestBatchAt) }}。以上数值为全历史导入累计摘要，不代表 {{ viewModel.selectedYear }} 年发生的导入。</p>
      </CockpitPanel>
    </section>

    <section class="boundary-section" aria-labelledby="standard-boundary-title">
      <header><span>CAPABILITY BOUNDARY</span><h2 id="standard-boundary-title">尚未接入的能力</h2><p>以下领域没有权威数据源，不显示 0、正常状态或重试入口。</p></header>
      <div class="boundary-grid">
        <article v-for="item in viewModel.unconnectedCapabilities" :key="item.key"><span>尚未接入</span><strong>{{ item.label }}</strong><p>{{ item.description }}</p></article>
      </div>
    </section>

    <nav class="quick-links" aria-label="授权领域快捷入口">
      <div><span>AUTHORIZED LINKS</span><strong>业务快捷入口</strong><p>仅导航到当前账号有查看权限的真实业务页面，不替代服务端鉴权，也不等同“应用中心”。</p></div>
      <div class="quick-links__actions"><el-button v-for="item in viewModel.quickLinks" :key="item.path" @click="emit('navigate', item.path)">{{ item.label }}</el-button><span v-if="!viewModel.quickLinks.length">当前账号没有可用的领域快捷入口。</span></div>
    </nav>
  </main>
</template>

<script setup>
import { ENERGY_TYPE_COLORS } from '@/utils/energyStatistics';
import CockpitPanel from './CockpitPanel.vue';
import EnergyTrendChart from './EnergyTrendChart.vue';
import UnitDonutChart from './UnitDonutChart.vue';

/** 普通驾驶舱视图只读输入。 */
defineProps({ viewModel: { type: Object, required: true } });
/** 普通驾驶舱向唯一控制器发送的交互事件。 */
const emit = defineEmits(['change-year', 'select-energy-series', 'select-carbon-unit', 'refresh', 'toggle-immersive', 'retry-energy', 'retry-carbon', 'retry-budget', 'retry-meter', 'retry-import', 'navigate']);

/** 格式化真实数值；缺失值不显示为零。 */
function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number) : '—';
}

/** 格式化真实整数。 */
function formatInteger(value) {
  return formatNumber(value, 0);
}

/** 格式化真实更新时间。 */
function formatDateTime(value) {
  if (!value) return '尚未成功更新';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/** 返回面板非成功状态的摘要文案。 */
function panelStatusLabel(panel) {
  if (panel?.status === 'loading' || panel?.status === 'idle') return '正在读取真实数据…';
  if (panel?.status === 'forbidden') return '当前账号无此领域权限';
  if (panel?.status === 'error') return panel.error || '读取失败，请在明细面板重试';
  return '当前暂无数据';
}

/** 返回项目既有能源类型固定颜色。 */
function energyColor(energyTypeCode) {
  return ENERGY_TYPE_COLORS[energyTypeCode] || ENERGY_TYPE_COLORS.other;
}

/** 返回预算比较行的稳定键。 */
function budgetRowKey(row) {
  return `${row.periodMonth}-${row.energyTypeCode}-${row.organizationScope}-${row.budgetUnit || row.unit || 'none'}-${row.actualUnit || 'none'}-${row.comparisonStatus || row.warningLevel || 'normal'}`;
}

/** 返回预算比较状态的可读文本。 */
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
</script>

<style scoped>
.standard-dashboard{--cockpit-surface:#fff;--cockpit-surface-subtle:#f8fbff;--cockpit-surface-emphasis:#edf5ff;--cockpit-border:#dce9fb;--cockpit-chart-border:#e1e0d9;--cockpit-table-border:#dce9fb;--cockpit-text:#183153;--cockpit-heading:#123b79;--cockpit-muted:#6d809e;--cockpit-accent:#1769e0;--cockpit-focus:#1769e0;--cockpit-chart-bg:#fcfcfb;--cockpit-gridline:#e1e0d9;--cockpit-axis:#898781;--cockpit-track:#e7f1ff;--cockpit-hover-bg:#f7fbff;--cockpit-tooltip-bg:#edf5ff;--cockpit-tooltip-border:#c9dcf5;--cockpit-mark-border:rgba(11,11,11,.1);--cockpit-panel-padding:20px;--cockpit-panel-radius:14px;--cockpit-panel-shadow:0 10px 28px rgba(30,91,180,.07);--cockpit-panel-highlight:#1769e0;--cockpit-panel-highlight-width:100%;--cockpit-panel-highlight-height:3px;--cockpit-danger:#c24156;--cockpit-danger-text:#9f3348;display:grid;gap:18px;min-width:0;max-width:100%;color:var(--cockpit-text)}
.standard-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:22px;border:1px solid #dce9fb;border-radius:16px;background:linear-gradient(135deg,#fff,#f5f9ff);box-shadow:0 12px 32px rgba(30,91,180,.08)}.standard-header__title>span,.boundary-section>header>span,.quick-links>div:first-child>span{display:block;margin-bottom:6px;color:#1769e0;font-size:10px;font-weight:700;letter-spacing:.16em}.standard-header h1{margin:0;color:#123b79;font-size:30px}.standard-header p{max-width:760px;margin:8px 0 0;color:#6d809e;font-size:13px;line-height:1.7}.standard-controls{display:flex;align-items:flex-end;justify-content:flex-end;gap:10px}.standard-controls label{display:grid;gap:6px;color:#6d809e;font-size:11px}.standard-controls :deep(.el-select){width:132px}.standard-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 20px;padding-top:14px;border-top:1px solid #dce9fb;color:#6d809e;font-size:11px}.standard-meta span::before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:#1769e0}
.summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.summary-card{min-width:0;padding:17px;border:1px solid #dce9fb;border-radius:14px;background:#fff;box-shadow:0 8px 24px rgba(30,91,180,.06)}.summary-card>span{color:#6d809e;font-size:11px}.summary-card strong{display:block;margin-top:10px;color:#123b79;font-size:25px;font-variant-numeric:tabular-nums}.summary-card small{color:#1769e0;font-size:11px}.summary-card p{margin:8px 0 0;color:#6d809e;font-size:11px;line-height:1.55}.summary-card--energy{border-top:3px solid #2a78d6}.summary-card--carbon{border-top:3px solid #38bdf8}.summary-card--budget{border-top:3px solid #eda100}.summary-card--meter{border-top:3px solid #1baf7a}.summary-card--import{border-top:3px solid #4a3aa7}.summary-card .summary-card__gap{color:#a16207;font-size:20px}
.standard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.standard-span-two{grid-column:span 2}.panel-select{width:220px}.panel-select--small{width:130px}.metric-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}.metric-row--compact{grid-template-columns:repeat(3,minmax(0,1fr))}.metric-row>div,.import-grid>div{min-width:0;padding:12px;border:1px solid var(--cockpit-border);border-radius:12px;background:var(--cockpit-surface-subtle)}.metric-row span,.import-grid span{display:block;color:var(--cockpit-muted);font-size:11px}.metric-row strong,.import-grid strong{display:block;margin-top:7px;color:var(--cockpit-heading);font-size:19px;font-variant-numeric:tabular-nums}.metric-row small{color:var(--cockpit-accent);font-size:11px}.metric-row .metric-gap-text{color:#a16207;font-size:15px}.analysis-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.8fr);gap:16px;align-items:start}
.warning-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:12px;border:1px solid var(--cockpit-border);border-radius:12px;background:var(--cockpit-surface-subtle)}.warning-summary>div{padding:8px;border-right:1px solid var(--cockpit-table-border)}.warning-summary>div:last-child{border-right:0}.warning-summary span{display:block;color:var(--cockpit-muted);font-size:11px}.warning-summary strong{display:block;margin-top:5px;color:var(--cockpit-heading);font-size:22px}.warning-summary--unit_mismatch{border-color:#e9a06f}.warning-summary--exceeded{border-color:#e9a1ad}.warning-summary--missing_budget,.warning-summary--nearing{border-color:#e5c46c}.warning-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}.warning-item{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--cockpit-table-border);border-radius:9px;background:var(--cockpit-surface-subtle)}.warning-item div{display:grid;gap:3px}.warning-item strong{color:var(--cockpit-heading);font-size:12px}.warning-item span{color:var(--cockpit-muted);font-size:11px}.status-dot{flex:0 0 auto;width:9px;height:9px;margin-top:3px;border-radius:50%;background:#2a78d6}.status-dot--exceeded{background:#d9475f}.status-dot--nearing{background:#c88a0a}.status-dot--missing_budget{background:#d66a16}.status-dot--unit_mismatch{background:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.16)}.success-note,.boundary-note{margin:14px 0 0;color:var(--cockpit-muted);font-size:12px;line-height:1.7}.success-note{color:#178447}.data-details{margin-top:12px;color:var(--cockpit-muted);font-size:12px}.data-details summary{cursor:pointer;color:var(--cockpit-accent)}.table-scroll{max-width:100%;overflow-x:auto}.data-details table{width:100%;margin-top:10px;border-collapse:collapse;white-space:nowrap}.data-details th,.data-details td{padding:8px;border-bottom:1px solid var(--cockpit-table-border);color:var(--cockpit-text);text-align:left}.data-details th{color:var(--cockpit-heading)}
.carbon-gap-state{display:grid;min-height:180px;place-content:center;gap:8px;padding:18px;border:1px dashed #e5c46c;border-radius:12px;background:#fff9e9;text-align:center}.carbon-gap-state strong{color:#8a5a00;font-size:17px}.carbon-gap-state span{max-width:560px;color:#75613b;font-size:12px;line-height:1.7}.meter-kpi{display:flex;align-items:flex-end;gap:10px}.meter-kpi strong{color:var(--cockpit-heading);font-size:42px;line-height:1;font-variant-numeric:tabular-nums}.meter-kpi span{color:var(--cockpit-muted);font-size:12px}.meter-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}.meter-status-grid>div{padding:12px;border:1px solid var(--cockpit-border);border-radius:11px;background:var(--cockpit-surface-subtle)}.meter-status-grid span{color:var(--cockpit-muted);font-size:11px}.meter-status-grid strong{float:right;color:var(--cockpit-heading)}.meter-status-grid i{display:block;clear:both;height:8px;margin-top:12px;border-radius:999px;background:var(--cockpit-track);overflow:hidden}.meter-status-grid b{display:block;height:100%;border-radius:999px;background:#22c55e}.meter-status-grid .meter-bar--inactive{background:#64748b}.import-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.panel-empty-value{color:var(--cockpit-accent)!important;font-size:40px!important;font-variant-numeric:tabular-nums}
.boundary-section{padding:20px;border:1px solid #dce9fb;border-radius:16px;background:#fff}.boundary-section h2{margin:0;color:#123b79;font-size:20px}.boundary-section>header p{margin:7px 0 0;color:#6d809e;font-size:12px}.boundary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:16px}.boundary-grid article{padding:13px;border:1px dashed #c9dcf5;border-radius:11px;background:#f8fbff}.boundary-grid article>span{color:#1769e0;font-size:10px}.boundary-grid strong{display:block;margin-top:6px;color:#123b79;font-size:13px}.boundary-grid p{margin:6px 0 0;color:#6d809e;font-size:11px;line-height:1.55}.quick-links{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 20px;border:1px solid #dce9fb;border-radius:14px;background:#fff;box-shadow:0 10px 28px rgba(30,91,180,.07)}.quick-links>div:first-child{display:grid;gap:4px}.quick-links strong{color:#123b79;font-size:15px}.quick-links p{margin:0;color:#6d809e;font-size:11px}.quick-links__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.quick-links__actions>span{color:#6d809e;font-size:12px}
@media (max-width:1200px){.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.analysis-grid{grid-template-columns:1fr}.metric-row{grid-template-columns:repeat(2,minmax(0,1fr))}.warning-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.boundary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:960px){.standard-grid{grid-template-columns:1fr}.standard-span-two{grid-column:span 1}.standard-header{grid-template-columns:1fr}.standard-controls{justify-content:flex-start}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.warning-list{grid-template-columns:1fr}.boundary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.quick-links{align-items:flex-start;flex-direction:column}.quick-links__actions{justify-content:flex-start}}
@media (max-width:640px){.standard-header{padding:17px}.standard-controls{align-items:stretch;flex-direction:column}.standard-controls :deep(.el-select),.panel-select,.panel-select--small{width:100%}.summary-grid,.metric-row,.metric-row--compact,.warning-summary,.meter-status-grid,.import-grid,.boundary-grid{grid-template-columns:1fr}.warning-summary>div{border-right:0;border-bottom:1px solid var(--cockpit-table-border)}.warning-summary>div:last-child{border-bottom:0}}
@media (prefers-reduced-motion:reduce){.standard-dashboard :deep(.el-skeleton__item){animation:none!important}.standard-dashboard *{scroll-behavior:auto!important;transition:none!important}}
</style>
