<template>
  <main class="immersive-dashboard">
    <header class="immersive-header">
      <div class="immersive-header__brand">
        <span>LOCAL ENERGY &amp; CARBON COCKPIT</span>
        <h1>中控 · 园区业务大屏</h1>
        <p>沉浸布局突出已授权真实业务数据；园区图仅作为业务状态容器，不代表实时设备运行或物理拓扑。</p>
      </div>
      <div class="immersive-controls" aria-label="沉浸中控筛选与显示控制">
        <label>
          <span>统计年度</span>
          <el-select :model-value="viewModel.selectedYear" :teleported="false" popper-class="immersive-dashboard-popper" aria-label="选择沉浸中控统计年度" @change="emit('change-year', $event)">
            <el-option v-for="year in viewModel.yearOptions" :key="year" :label="`${year} 年`" :value="year" />
          </el-select>
        </label>
        <el-button type="primary" :loading="viewModel.annualLoading" @click="emit('refresh')">刷新数据</el-button>
        <el-button @click="emit('toggle-immersive')">退出大屏</el-button>
      </div>
      <div class="immersive-meta" aria-live="polite">
        <span>{{ viewModel.selectedRange.normalizedMonthStart }} 至 {{ viewModel.selectedRange.normalizedMonthEnd }}</span>
        <span>最后更新 {{ formatDateTime(viewModel.lastUpdated) }}</span>
        <span>{{ viewModel.fullscreenActive ? '浏览器全屏' : '沉浸布局' }}</span>
        <span>年度仅影响能耗、碳排和预算</span>
      </div>
    </header>

    <section class="immersive-signals" aria-label="真实业务变化摘要">
      <article v-for="signal in viewModel.sceneSignals" :key="signal.key" class="immersive-signal" :class="`immersive-signal--${signal.tone}`">
        <span>{{ signal.label }}</span>
        <strong>{{ formatSignalValue(signal) }} <small>{{ signal.unit }}</small></strong>
        <p>{{ signal.detail }}</p>
      </article>
      <div v-if="!viewModel.sceneSignals.length" class="immersive-signals__empty" role="status">{{ emptySignalText }}</div>
    </section>

    <section class="immersive-grid" aria-label="沉浸中控真实数据布局">
      <div class="immersive-column immersive-column--left">
        <CockpitPanel title="年度能源趋势" eyebrow="ENERGY TREND" description="按能源类型与标准单位展示真实月度趋势，单位不跨组汇总。" :status="viewModel.energyPanel.status" :error="viewModel.energyPanel.error" forbidden-text="需要能耗记录或能耗统计查看权限。" empty-text="当前年度暂无 active 能耗记录。" @retry="emit('retry-energy')">
          <template #actions>
            <el-select v-if="viewModel.energyPanel.status === 'success' && viewModel.energySeries.length" :model-value="viewModel.selectedEnergySeriesKey" :teleported="false" popper-class="immersive-dashboard-popper" class="immersive-panel-select" aria-label="选择能源序列" @change="emit('select-energy-series', $event)">
              <el-option v-for="series in viewModel.energySeries" :key="series.key" :label="`${series.energyTypeName} · ${series.normalizedUnit}`" :value="series.key" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-title">暂无能源记录</strong><span>{{ viewModel.selectedYear }} 年没有可展示的 active 能耗数据。</span></template>
          <template v-if="viewModel.selectedEnergySeries">
            <div class="trend-change" :class="`trend-change--${viewModel.energyTrendChange.direction}`">
              <div><span>最新月份</span><strong>{{ viewModel.energyTrendChange.latestMonth }} · {{ formatNumber(viewModel.energyTrendChange.latestValue, 2) }} <small>{{ viewModel.selectedEnergySeries.normalizedUnit }}</small></strong></div>
              <div><span>与上月变化</span><strong>{{ changeText(viewModel.energyTrendChange, viewModel.selectedEnergySeries.normalizedUnit) }}</strong></div>
            </div>
            <EnergyTrendChart :series="viewModel.selectedEnergySeries" :color="viewModel.energyTrendColor" compact />
          </template>
          <div v-else class="immersive-inline-empty" role="status">当前授权范围没有完整的能源类型、单位和月份序列。</div>
        </CockpitPanel>

        <CockpitPanel title="已保存碳排趋势" eyebrow="CARBON TREND" description="仅展示当前排放单位下已有真实核算结果；因子缺失不估算。" :status="viewModel.carbonPanel.status" :error="viewModel.carbonPanel.error" forbidden-text="需要 carbon:emissions:view 权限。" empty-text="当前年度暂无碳排放结果。" @retry="emit('retry-carbon')">
          <template #actions>
            <el-select v-if="viewModel.carbonPanel.status === 'success' && viewModel.carbonUnitGroups.length" :model-value="viewModel.selectedCarbonUnit" :teleported="false" popper-class="immersive-dashboard-popper" class="immersive-panel-select immersive-panel-select--small" aria-label="选择碳排放单位" @change="emit('select-carbon-unit', $event)">
              <el-option v-for="group in viewModel.carbonUnitGroups" :key="group.unit" :label="group.unit" :value="group.unit" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-title">暂无已核算碳排</strong><span>{{ viewModel.selectedYear }} 年没有可展示的真实碳排结果。</span></template>
          <div v-if="viewModel.carbonProjection.hasOnlyMissingFactors" class="immersive-gap" role="status"><strong>因子缺失，无法形成排放趋势</strong><span>当前记录没有可用于总量和趋势的已核算结果，不显示伪零数据。</span></div>
          <template v-else-if="viewModel.selectedCarbonSeries">
            <div class="trend-change" :class="`trend-change--${viewModel.carbonTrendChange.direction}`">
              <div><span>最新月份</span><strong>{{ viewModel.carbonTrendChange.latestMonth }} · {{ formatDashboardMeasurement(viewModel.carbonTrendChange.latestValue, { kind: 'carbon' }) }} <small>{{ viewModel.selectedCarbonSeries.normalizedUnit }}</small></strong></div>
              <div><span>与上月变化</span><strong>{{ changeText(viewModel.carbonTrendChange, viewModel.selectedCarbonSeries.normalizedUnit, 'carbon') }}</strong></div>
            </div>
            <EnergyTrendChart :series="viewModel.selectedCarbonSeries" :color="viewModel.carbonTrendColor" compact />
            <p v-if="viewModel.carbonProjection.hasMissingGap" class="immersive-note">另有 {{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} 条记录因子缺失，未纳入排放趋势。</p>
          </template>
          <div v-else class="immersive-inline-empty" role="status">当前没有完整的排放单位和已核算月份序列。</div>
        </CockpitPanel>
      </div>

      <IndustrialParkScene class="immersive-scene" scene-id="immersive-industrial-park" :current-year="viewModel.selectedYear" :status="viewModel.sceneState.status" :status-description="viewModel.sceneState.description" :last-updated="viewModel.lastUpdated" :signals="viewModel.sceneSignals" />

      <div class="immersive-column immersive-column--right">
        <CockpitPanel title="用能预算风险" eyebrow="BUDGET RISK" description="展示真实预算比较异常；单位不一致保持不可比较。" :status="viewModel.budgetPanel.status" :error="viewModel.budgetPanel.error" forbidden-text="需要 energy:budget:view 权限。" empty-text="当前年度暂无用能预算比较结果。" @retry="emit('retry-budget')">
          <template #empty><strong class="panel-empty-title">暂无预算比较</strong><span>{{ viewModel.selectedYear }} 年没有可展示的 active 预算执行记录。</span></template>
          <div class="risk-kpis">
            <div><span>预警</span><strong>{{ formatInteger(viewModel.budgetProjection.warningCount) }}</strong></div>
            <div><span>超预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.exceeded) }}</strong></div>
            <div><span>接近</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.nearing) }}</strong></div>
            <div><span>缺预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.missingBudget) }}</strong></div>
            <div><span>不可比较</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.unitMismatch) }}</strong></div>
          </div>
          <div v-if="viewModel.budgetProjection.warningRows.length" class="immersive-warning-list" aria-label="用能预算预警明细">
            <div v-for="row in viewModel.budgetProjection.warningRows.slice(0, 3)" :key="budgetRowKey(row)"><i :class="`risk-dot risk-dot--${row.dashboardWarningLevel}`" aria-hidden="true" /><span><strong>{{ row.energyTypeName || row.energyTypeCode }} · {{ row.periodMonth }}</strong><small>{{ row.organizationScope }} · {{ budgetWarningLabel(row) }}</small></span></div>
          </div>
          <p v-else class="immersive-success">当前年度预算比较未触发预警。</p>
        </CockpitPanel>

        <CockpitPanel title="计量器具台账" eyebrow="METER LEDGER" description="本地台账维护快照，不是实时遥测或设备在线判断。" :status="viewModel.meterPanel.status" :error="viewModel.meterPanel.error" forbidden-text="需要 ledger:meters:view 权限。" empty-text="本地台账暂无计量器具。" @retry="emit('retry-meter')">
          <template #empty><strong class="panel-empty-title">暂无计量器具</strong><span>本地台账没有可展示的记录。</span></template>
          <div class="ledger-overview"><strong>{{ formatInteger(viewModel.meterPanel.data?.total) }}</strong><span>台账总数</span></div>
          <div class="ledger-bars">
            <div><span>启用 {{ formatInteger(viewModel.meterPanel.data?.active) }}</span><i><b :style="{ width: `${viewModel.meterActivePercentage}%` }" /></i></div>
            <div><span>停用 {{ formatInteger(viewModel.meterPanel.data?.inactive) }}</span><i><b class="ledger-bar--inactive" :style="{ width: `${viewModel.meterInactivePercentage}%` }" /></i></div>
          </div>
          <p class="immersive-note">台账状态只反映维护字段；不把 onlineStatus 当作实时在线。</p>
        </CockpitPanel>

        <CockpitPanel title="导入累计与最新活动" eyebrow="IMPORT ACTIVITY" description="全历史导入累计不随年度变化，补充最新活动时间与问题数量。" :status="viewModel.importPanel.status" :error="viewModel.importPanel.error" forbidden-text="需要 imports:view 权限。" empty-text="当前没有导入批次或导入问题。" @retry="emit('retry-import')">
          <template #empty><strong class="panel-empty-title">暂无导入活动</strong><span>当前没有可展示的导入批次或导入问题。</span></template>
          <div class="import-kpis">
            <div><span>批次</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.batchCount) }}</strong></div>
            <div><span>成功写入</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.importedRowCount) }}</strong></div>
            <div><span>失败 / 跳过</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.failedRowCount) }} / {{ formatInteger(viewModel.importPanel.data?.imports?.skippedRowCount) }}</strong></div>
            <div><span>阻断 / 警告</span><strong>{{ formatInteger(viewModel.importPanel.data?.errors?.blockingErrorCount) }} / {{ formatInteger(viewModel.importPanel.data?.errors?.warningCount) }}</strong></div>
          </div>
          <p class="immersive-note">最新活动 {{ formatDateTime(viewModel.importPanel.data?.imports?.latestBatchAt) }}；以上为全历史累计。</p>
        </CockpitPanel>
      </div>
    </section>

  </main>
</template>

<script setup>
import { computed } from 'vue';
import { formatDashboardMeasurement, formatDashboardPercentage } from '@/utils/dashboardCockpit';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';
import CockpitPanel from './CockpitPanel.vue';
import EnergyTrendChart from './EnergyTrendChart.vue';
import IndustrialParkScene from './IndustrialParkScene.vue';

/** 沉浸驾驶舱视图只读输入。 */
const props = defineProps({ viewModel: { type: Object, required: true } });
/** 沉浸驾驶舱向唯一控制器发送的交互事件。 */
const emit = defineEmits(['change-year', 'select-energy-series', 'select-carbon-unit', 'refresh', 'toggle-immersive', 'retry-energy', 'retry-carbon', 'retry-budget', 'retry-meter', 'retry-import']);

/** 沉浸顶部无信号时按聚合状态提供明确终态文案。 */
const emptySignalText = computed(() => ({
  loading: '正在汇总已授权的真实业务信号。',
  empty: '已完成读取，但当前范围内暂无可展示的真实业务信号。',
  forbidden: '当前账号没有可用于园区摘要的领域数据权限。',
  error: '真实业务摘要读取失败，请使用各面板的重试入口。',
  partial: '部分领域读取失败或无权限，当前没有可展示的完整业务信号。',
  success: '已完成读取，但当前暂无可展示的真实业务信号。'
}[props.viewModel?.sceneState?.status] || '正在汇总已授权的真实业务信号。'));

/** 格式化真实数值；缺失值不显示为零。 */
function formatNumber(value, digits = 0) {
  return formatDashboardMeasurement(value, { maximumFractionDigits: digits });
}

/** 按信号口径格式化数值，碳排使用安全小数精度。 */
function formatSignalValue(signal) {
  if (signal?.tone === 'carbon') return formatDashboardMeasurement(signal.value, { kind: 'carbon' });
  return formatNumber(signal?.value, signal?.tone === 'energy' ? 2 : 0);
}

/** 格式化真实整数。 */
function formatInteger(value) {
  return formatNumber(value, 0);
}

/** 格式化真实更新时间。 */
function formatDateTime(value) {
  return formatStrictUtcDateTimeDisplay(value, '尚未成功更新');
}

/** 将真实趋势变化投影为简短可读文本；缺月不伪称为上月。 */
function changeText(change, unit, kind = 'energy') {
  if (!change || change.status !== 'available') return '暂无可比较月份';
  if (change.comparisonStatus === 'missing-previous-month') return `上月无数据（自然上月 ${change.previousMonth}）`;
  if (change.comparisonStatus === 'single' || change.direction === 'single') return '单月数据，暂无上月对比';
  if (change.direction === 'flat') return '与上月持平';
  const direction = change.direction === 'up' ? '上升' : '下降';
  const value = formatDashboardMeasurement(Math.abs(change.delta), {
    kind,
    maximumFractionDigits: kind === 'carbon' ? 8 : 2
  });
  const rate = change.rate === null
    ? '上月为 0，百分比不可用'
    : formatDashboardPercentage(Math.abs(change.rate));
  return `${direction} ${value} ${unit || ''} · ${rate}`;
}

/** 返回预算比较行的稳定键。 */
function budgetRowKey(row) {
  return `${row.periodMonth}-${row.energyTypeCode}-${row.organizationScope}-${row.budgetUnit || row.unit || 'none'}-${row.actualUnit || 'none'}-${row.comparisonStatus || row.warningLevel || 'normal'}`;
}

/** 返回预算比较状态的沉浸视图文本。 */
function budgetWarningLabel(row) {
  if (row.dashboardWarningLevel === 'unit_mismatch' || row.comparisonStatus === 'unit_mismatch') return '单位不一致 / 不可比较';
  return row.warningLabel || row.warningReason || '正常';
}
</script>

<style scoped>
.immersive-dashboard{--cockpit-surface:rgba(5,24,48,.94);--cockpit-surface-subtle:rgba(3,18,38,.66);--cockpit-border:rgba(56,189,248,.2);--cockpit-chart-border:rgba(56,189,248,.13);--cockpit-table-border:rgba(148,184,218,.16);--cockpit-text:#e5f4ff;--cockpit-heading:#e6f4ff;--cockpit-muted:#8eabc8;--cockpit-accent:#38bdf8;--cockpit-focus:#7dd3fc;--cockpit-chart-bg:#031126;--cockpit-gridline:rgba(148,184,218,.16);--cockpit-axis:#87a7c6;--cockpit-track:rgba(95,139,181,.18);--cockpit-tooltip-bg:rgba(3,18,38,.88);--cockpit-tooltip-border:rgba(56,189,248,.25);--cockpit-mark-border:rgba(125,211,252,.25);--cockpit-panel-padding:12px;--cockpit-panel-radius:14px;--cockpit-panel-shadow:0 14px 34px rgba(0,8,24,.28),inset 0 1px rgba(255,255,255,.04);--cockpit-panel-highlight:linear-gradient(90deg,#38bdf8,transparent);--cockpit-panel-highlight-width:45%;--cockpit-panel-highlight-height:2px;--cockpit-danger:#fda4af;--cockpit-danger-text:#fecdd3;display:grid;grid-template-rows:auto auto minmax(0,1fr);min-height:0;height:100dvh;min-width:0;max-width:100%;padding:clamp(8px,1vw,14px);box-sizing:border-box;color:#e5f4ff;background-color:#020b18;background-image:linear-gradient(rgba(34,107,166,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(34,107,166,.07) 1px,transparent 1px),radial-gradient(circle at 50% 0,rgba(14,116,144,.22),transparent 40%);background-size:36px 36px,36px 36px,auto;overflow:hidden}.immersive-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:12px 15px;border:1px solid rgba(56,189,248,.2);border-radius:15px;background:rgba(5,24,48,.92);box-shadow:0 16px 34px rgba(0,8,24,.3)}.immersive-header__brand>span{color:#38bdf8;font-size:9px;font-weight:700;letter-spacing:.17em}.immersive-header h1{margin:3px 0 0;color:#e6f4ff;font-size:22px;letter-spacing:.04em}.immersive-header p{margin:4px 0 0;color:#8eabc8;font-size:10px;line-height:1.45}.immersive-controls{display:flex;align-items:flex-end;gap:7px}.immersive-controls label{display:grid;gap:4px;color:#8eabc8;font-size:9px}.immersive-controls :deep(.el-select){width:116px}.immersive-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 15px;padding-top:8px;border-top:1px solid rgba(148,184,218,.14);color:#8eabc8;font-size:9px}.immersive-meta span::before{content:"";display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px rgba(56,189,248,.6)}
.immersive-signals{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;min-width:0;margin-top:8px}.immersive-signal{min-width:0;padding:8px 10px;border:1px solid rgba(56,189,248,.16);border-top:2px solid #38bdf8;border-radius:10px;background:rgba(5,24,48,.82)}.immersive-signal--carbon{border-top-color:#38bdf8}.immersive-signal--warning{border-top-color:#fbbf24}.immersive-signal--good{border-top-color:#34d399}.immersive-signal--ledger{border-top-color:#60a5fa}.immersive-signal--import{border-top-color:#a78bfa}.immersive-signal>span{display:block;color:#8eabc8;font-size:9px}.immersive-signal strong{display:block;margin-top:3px;color:#e6f4ff;font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.immersive-signal small{color:#38bdf8;font-size:9px}.immersive-signal p{margin:3px 0 0;color:#9fbbd4;font-size:9px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.immersive-signals__empty{grid-column:1/-1;padding:10px 12px;border:1px dashed rgba(148,184,218,.25);border-radius:10px;color:#8eabc8;font-size:10px;text-align:center}
.immersive-grid{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(380px,1.35fr) minmax(240px,.85fr);grid-template-areas:"left scene right";align-items:stretch;min-height:0;gap:clamp(7px,.7vw,10px);margin-top:8px;overflow:hidden}.immersive-column{display:grid;gap:7px;min-width:0;min-height:0;overflow:hidden}.immersive-column--left{grid-area:left;grid-template-rows:repeat(2,minmax(0,1fr))}.immersive-column--right{grid-area:right;grid-template-rows:repeat(3,minmax(0,1fr))}.immersive-column :deep(.cockpit-panel){display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;overflow:hidden}.immersive-column :deep(.cockpit-panel__body),.immersive-column :deep(.cockpit-panel__state){min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.immersive-scene{grid-area:scene;min-height:0;height:100%;overflow:hidden}.immersive-panel-select{width:150px}.immersive-panel-select--small{width:105px}.trend-change{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:6px}.trend-change>div{min-width:0;padding:6px 8px;border:1px solid rgba(56,189,248,.14);border-radius:8px;background:rgba(3,18,38,.55)}.trend-change span{display:block;color:#8eabc8;font-size:8px}.trend-change strong{display:block;margin-top:3px;color:#e6f4ff;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.trend-change small{color:#38bdf8;font-size:8px}.trend-change--up>div:last-child strong{color:#fda4af}.trend-change--down>div:last-child strong{color:#86efac}.trend-change--flat>div:last-child strong{color:#c4b5fd}.panel-empty-title{color:#38bdf8!important;font-size:16px!important}.immersive-inline-empty{display:grid;place-content:center;min-height:105px;padding:12px;border:1px dashed rgba(148,184,218,.24);border-radius:9px;color:#8eabc8;font-size:10px;text-align:center}.immersive-gap{display:grid;gap:4px;padding:13px;border:1px dashed rgba(251,191,36,.38);border-radius:9px;background:rgba(120,53,15,.1);text-align:center}.immersive-gap strong{color:#fde68a;font-size:11px}.immersive-gap span{color:#d6bd8b;font-size:9px}.immersive-note{margin:7px 0 0;color:#8eabc8;font-size:9px;line-height:1.45}.risk-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}.risk-kpis>div{padding:5px 3px;border:1px solid rgba(56,189,248,.13);border-radius:7px;background:rgba(3,18,38,.55);text-align:center}.risk-kpis span{display:block;color:#8eabc8;font-size:8px}.risk-kpis strong{display:block;margin-top:3px;color:#e6f4ff;font-size:14px;font-variant-numeric:tabular-nums}.immersive-warning-list{display:grid;gap:5px;margin-top:7px}.immersive-warning-list>div{display:flex;align-items:flex-start;gap:7px;padding:5px 7px;border-radius:7px;background:rgba(10,31,57,.72)}.immersive-warning-list span{display:grid;gap:1px;min-width:0}.immersive-warning-list strong{color:#e6f4ff;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.immersive-warning-list small{color:#8eabc8;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.risk-dot{flex:0 0 auto;width:7px;height:7px;margin-top:2px;border-radius:50%;background:#60a5fa}.risk-dot--exceeded{background:#fb7185}.risk-dot--nearing{background:#fbbf24}.risk-dot--missing_budget{background:#f97316}.risk-dot--unit_mismatch{background:#fb923c}.immersive-success{margin:8px 0 0;color:#86efac;font-size:9px}.ledger-overview{display:flex;align-items:flex-end;gap:7px}.ledger-overview strong{color:#e6f4ff;font-size:30px;line-height:1}.ledger-overview span{color:#8eabc8;font-size:9px}.ledger-bars{display:grid;gap:6px;margin-top:9px}.ledger-bars span{display:block;color:#a9c7df;font-size:9px}.ledger-bars i{display:block;height:6px;margin-top:4px;border-radius:999px;background:rgba(95,139,181,.18);overflow:hidden}.ledger-bars b{display:block;height:100%;border-radius:999px;background:#34d399}.ledger-bars .ledger-bar--inactive{background:#64748b}.import-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.import-kpis>div{padding:6px 7px;border:1px solid rgba(56,189,248,.13);border-radius:7px;background:rgba(3,18,38,.55)}.import-kpis span{display:block;color:#8eabc8;font-size:8px}.import-kpis strong{display:block;margin-top:3px;color:#e6f4ff;font-size:12px;font-variant-numeric:tabular-nums}.immersive-dashboard :deep(.el-button){border-color:rgba(83,178,229,.32);background:rgba(8,34,66,.82);color:#ccecff}.immersive-dashboard :deep(.el-button:hover),.immersive-dashboard :deep(.el-button:focus-visible){border-color:#38bdf8;background:rgba(14,74,119,.74);color:#fff}.immersive-dashboard :deep(.el-button--primary){border-color:#0ea5e9;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff}.immersive-dashboard :deep(.el-select__wrapper){border:1px solid rgba(56,189,248,.24);background:rgba(3,18,38,.82);box-shadow:none}.immersive-dashboard :deep(.el-select__selected-item),.immersive-dashboard :deep(.el-select__placeholder){color:#d7efff}.immersive-dashboard :deep(.immersive-dashboard-popper){border-color:rgba(56,189,248,.25)!important;background:#061b33!important}.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item){color:#b9d8ef}.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item.is-hovering),.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item.is-selected){background:rgba(56,189,248,.13);color:#fff}.immersive-dashboard :deep(.el-skeleton__item){background:linear-gradient(90deg,rgba(34,78,119,.26) 25%,rgba(43,99,146,.34) 37%,rgba(34,78,119,.26) 63%);background-size:400% 100%}
@media (max-width:1279px){.immersive-grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"scene scene" "left right"}.immersive-column--left,.immersive-column--right{grid-template-rows:none}.immersive-scene{min-height:0}.immersive-signals{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1024px){.immersive-dashboard{padding:10px}.immersive-header{grid-template-columns:1fr}.immersive-controls{justify-content:flex-start}.immersive-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.immersive-signals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:960px){.immersive-grid{grid-template-columns:1fr;grid-template-areas:"scene" "left" "right";align-content:start;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.immersive-column{grid-template-columns:1fr;min-height:max-content;overflow:visible}.immersive-scene{order:-1;height:clamp(280px,56dvh,520px)}.immersive-signals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.immersive-dashboard{padding:8px}.immersive-header{max-height:32dvh;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.immersive-controls{align-items:stretch;flex-direction:column}.immersive-controls :deep(.el-select),.immersive-panel-select,.immersive-panel-select--small{width:100%}.immersive-signals{grid-template-columns:1fr;max-height:22dvh;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.trend-change,.risk-kpis,.import-kpis{grid-template-columns:1fr}.immersive-header h1{font-size:19px}}
@media (prefers-reduced-motion:reduce){.immersive-dashboard :deep(.el-skeleton__item){animation:none!important}.immersive-dashboard *{scroll-behavior:auto!important;transition:none!important}}
</style>
