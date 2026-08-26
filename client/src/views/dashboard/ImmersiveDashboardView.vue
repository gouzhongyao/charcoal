<template>
  <main class="immersive-dashboard">
    <header class="immersive-header">
      <div class="immersive-header__brand">
        <span>LOCAL ENERGY &amp; CARBON COCKPIT</span>
        <h1>中控 · 园区业务大屏</h1>
        <p>真实业务面板与抽象园区示意分层展示；园区图不代表实时设备运行或物理拓扑。</p>
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

    <section class="immersive-grid" aria-label="沉浸中控独立数据布局">
      <div class="immersive-column immersive-column--left">
        <CockpitPanel title="年度能源态势" eyebrow="ENERGY" description="当前选定能源序列及同单位结构。完整月度趋势请在标准布局查看。" :status="viewModel.energyPanel.status" :error="viewModel.energyPanel.error" forbidden-text="需要能耗记录或能耗统计查看权限。" empty-text="当前年度暂无 active 能耗记录。" @retry="emit('retry-energy')">
          <template #actions>
            <el-select v-if="viewModel.energyPanel.status === 'success' && viewModel.energySeries.length" :model-value="viewModel.selectedEnergySeriesKey" :teleported="false" popper-class="immersive-dashboard-popper" class="immersive-panel-select" aria-label="选择能源序列" @change="emit('select-energy-series', $event)">
              <el-option v-for="series in viewModel.energySeries" :key="series.key" :label="`${series.energyTypeName} · ${series.normalizedUnit}`" :value="series.key" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无 active 能耗记录。</span></template>
          <div class="compact-metrics">
            <div><span>当前单位组</span><strong>{{ formatNumber(viewModel.selectedEnergyUnitGroup?.totalValue, 2) }} <small>{{ viewModel.selectedEnergyUnit }}</small></strong></div>
            <div><span>选定序列记录</span><strong>{{ formatInteger(viewModel.selectedEnergySeries?.recordCount) }} <small>条</small></strong></div>
            <div><span>数据月份</span><strong>{{ viewModel.energyMonthRange }}</strong></div>
          </div>
          <UnitDonutChart v-if="viewModel.energyStructureRows.length" chart-id="immersive-energy-structure" title="同单位能源结构" description="不跨标准单位合计" :unit="viewModel.selectedEnergyUnit" :rows="viewModel.energyStructureRows" center-label="单位组总量" compact />
        </CockpitPanel>

        <CockpitPanel title="已保存碳排概览" eyebrow="CARBON" description="仅展示当前 emissionUnit 下已有真实核算结果；因子缺失不估算。" :status="viewModel.carbonPanel.status" :error="viewModel.carbonPanel.error" forbidden-text="需要 carbon:emissions:view 权限。" empty-text="当前年度暂无碳排放结果。" @retry="emit('retry-carbon')">
          <template #actions>
            <el-select v-if="viewModel.carbonPanel.status === 'success' && viewModel.carbonUnitGroups.length" :model-value="viewModel.selectedCarbonUnit" :teleported="false" popper-class="immersive-dashboard-popper" class="immersive-panel-select immersive-panel-select--small" aria-label="选择碳排放单位" @change="emit('select-carbon-unit', $event)">
              <el-option v-for="group in viewModel.carbonUnitGroups" :key="group.unit" :label="group.unit" :value="group.unit" />
            </el-select>
          </template>
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无碳排放结果。</span></template>
          <div class="compact-metrics compact-metrics--three">
            <div><span>排放总量</span><strong v-if="!viewModel.carbonProjection.hasOnlyMissingFactors">{{ formatNumber(viewModel.selectedCarbonTotal, 4) }} <small>{{ viewModel.selectedCarbonUnit }}</small></strong><strong v-else class="metric-gap-text">无法形成</strong></div>
            <div><span>已计算</span><strong>{{ formatInteger(viewModel.carbonProjection.calculatedCount) }} <small>条</small></strong></div>
            <div><span>因子缺失</span><strong>{{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} <small>条</small></strong></div>
          </div>
          <div v-if="viewModel.carbonProjection.hasOnlyMissingFactors" class="immersive-gap" role="status"><strong>因子缺失，无法形成排放总量</strong><span>不显示伪零结构或伪趋势。</span></div>
          <UnitDonutChart v-else-if="viewModel.carbonStructureRows.length" chart-id="immersive-carbon-structure" title="当前排放单位结构" description="仅含已核算结果" :unit="viewModel.selectedCarbonUnit" :rows="viewModel.carbonStructureRows" center-label="已核算总量" compact />
          <p v-if="viewModel.carbonProjection.hasMissingGap" class="immersive-note">另有 {{ formatInteger(viewModel.carbonProjection.missingFactorCount) }} 条记录因子缺失，未纳入总量和结构。</p>
        </CockpitPanel>
      </div>

      <IndustrialParkScene class="immersive-scene" scene-id="immersive-industrial-park" :current-year="viewModel.selectedYear" :status="viewModel.sceneState.status" :status-description="viewModel.sceneState.description" :last-updated="viewModel.lastUpdated" />

      <div class="immersive-column immersive-column--right">
        <CockpitPanel title="用能预算风险" eyebrow="BUDGET" description="只展示真实预算比较风险；单位不一致保持不可比较。" :status="viewModel.budgetPanel.status" :error="viewModel.budgetPanel.error" forbidden-text="需要 energy:budget:view 权限。" empty-text="当前年度暂无用能预算比较结果。" @retry="emit('retry-budget')">
          <template #empty><strong class="panel-empty-value">0</strong><span>{{ viewModel.selectedYear }} 年暂无用能预算比较结果。</span></template>
          <div class="risk-kpis">
            <div><span>预警</span><strong>{{ formatInteger(viewModel.budgetProjection.warningCount) }}</strong></div>
            <div><span>超预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.exceeded) }}</strong></div>
            <div><span>接近</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.nearing) }}</strong></div>
            <div><span>缺预算</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.missingBudget) }}</strong></div>
            <div><span>单位不一致</span><strong>{{ formatInteger(viewModel.budgetProjection.counts.unitMismatch) }}</strong></div>
          </div>
          <div v-if="viewModel.budgetProjection.warningRows.length" class="immersive-warning-list">
            <div v-for="row in viewModel.budgetProjection.warningRows.slice(0, 4)" :key="budgetRowKey(row)"><i :class="`risk-dot risk-dot--${row.dashboardWarningLevel}`" /><span><strong>{{ row.energyTypeName || row.energyTypeCode }} · {{ row.periodMonth }}</strong><small>{{ row.organizationScope }} · {{ budgetWarningLabel(row) }}</small></span></div>
          </div>
          <p v-else class="immersive-success">当前年度预算比较未触发预警。</p>
          <details class="immersive-details"><summary>查看预算比较等价数据表</summary><div class="table-scroll"><table><thead><tr><th scope="col">月份</th><th scope="col">能源类型</th><th scope="col">状态</th><th scope="col">预算值</th><th scope="col">实际值</th></tr></thead><tbody><tr v-for="row in viewModel.budgetPanel.data?.rows || []" :key="`table-${budgetRowKey(row)}`"><td>{{ row.periodMonth }}</td><td>{{ row.energyTypeName || row.energyTypeCode }}</td><td>{{ budgetWarningLabel(row) }}</td><td>{{ formatNumber(row.budgetValue, 2) }} {{ row.budgetUnit || row.unit || '—' }}</td><td>{{ formatNumber(row.actualValue, 2) }} {{ row.actualUnit || '—' }}</td></tr></tbody></table></div></details>
        </CockpitPanel>

        <CockpitPanel title="计量器具台账" eyebrow="METER LEDGER" description="台账维护快照，不是实时遥测或设备在线判断。" :status="viewModel.meterPanel.status" :error="viewModel.meterPanel.error" forbidden-text="需要 ledger:meters:view 权限。" empty-text="本地台账暂无计量器具。" @retry="emit('retry-meter')">
          <template #empty><strong class="panel-empty-value">0</strong><span>本地计量器具台账暂无记录。</span></template>
          <div class="ledger-overview"><strong>{{ formatInteger(viewModel.meterPanel.data?.total) }}</strong><span>台账总数</span></div>
          <div class="ledger-bars">
            <div><span>启用 {{ formatInteger(viewModel.meterPanel.data?.active) }}</span><i><b :style="{ width: `${viewModel.meterActivePercentage}%` }" /></i></div>
            <div><span>停用 {{ formatInteger(viewModel.meterPanel.data?.inactive) }}</span><i><b class="ledger-bar--inactive" :style="{ width: `${viewModel.meterInactivePercentage}%` }" /></i></div>
          </div>
          <p class="immersive-note">onlineStatus 即使存在也仅为本地字段，不代表实时设备在线。</p>
        </CockpitPanel>

        <CockpitPanel title="导入累计摘要" eyebrow="IMPORT" description="全历史累计，不随年度变化。" :status="viewModel.importPanel.status" :error="viewModel.importPanel.error" forbidden-text="需要 imports:view 权限。" empty-text="当前没有导入批次或导入问题。" @retry="emit('retry-import')">
          <template #empty><strong class="panel-empty-value">0</strong><span>当前没有导入批次或导入问题。</span></template>
          <div class="import-kpis">
            <div><span>批次</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.batchCount) }}</strong></div>
            <div><span>成功写入</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.importedRowCount) }}</strong></div>
            <div><span>失败 / 跳过</span><strong>{{ formatInteger(viewModel.importPanel.data?.imports?.failedRowCount) }} / {{ formatInteger(viewModel.importPanel.data?.imports?.skippedRowCount) }}</strong></div>
            <div><span>阻断 / 警告</span><strong>{{ formatInteger(viewModel.importPanel.data?.errors?.blockingErrorCount) }} / {{ formatInteger(viewModel.importPanel.data?.errors?.warningCount) }}</strong></div>
          </div>
          <p class="immersive-note">最新活动时间 {{ formatDateTime(viewModel.importPanel.data?.imports?.latestBatchAt) }}。</p>
        </CockpitPanel>
      </div>
    </section>

    <section class="immersive-bottom">
      <div class="immersive-boundary" aria-labelledby="immersive-boundary-title">
        <header><span>CAPABILITY BOUNDARY</span><h2 id="immersive-boundary-title">尚未接入</h2><p>无权威数据源，不显示 0、正常状态或重试。</p></header>
        <div><article v-for="item in viewModel.unconnectedCapabilities" :key="item.key"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></article></div>
      </div>
      <nav class="immersive-links" aria-label="授权领域快捷入口">
        <header><span>AUTHORIZED LINKS</span><h2>业务快捷入口</h2><p>真实授权导航，不等同“应用中心”。</p></header>
        <div><el-button v-for="item in viewModel.quickLinks" :key="item.path" @click="emit('navigate', item.path)">{{ item.label }}</el-button><span v-if="!viewModel.quickLinks.length">当前账号没有可用入口。</span></div>
      </nav>
    </section>
  </main>
</template>

<script setup>
import CockpitPanel from './CockpitPanel.vue';
import IndustrialParkScene from './IndustrialParkScene.vue';
import UnitDonutChart from './UnitDonutChart.vue';

/** 沉浸驾驶舱视图只读输入。 */
defineProps({ viewModel: { type: Object, required: true } });
/** 沉浸驾驶舱向唯一控制器发送的交互事件。 */
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
.immersive-dashboard{--cockpit-surface:rgba(5,24,48,.94);--cockpit-surface-subtle:rgba(3,18,38,.66);--cockpit-surface-emphasis:rgba(10,31,57,.72);--cockpit-border:rgba(56,189,248,.2);--cockpit-chart-border:rgba(56,189,248,.13);--cockpit-table-border:rgba(148,184,218,.16);--cockpit-text:#e5f4ff;--cockpit-heading:#e6f4ff;--cockpit-muted:#8eabc8;--cockpit-accent:#38bdf8;--cockpit-focus:#7dd3fc;--cockpit-chart-bg:#031126;--cockpit-gridline:rgba(148,184,218,.16);--cockpit-axis:#87a7c6;--cockpit-track:rgba(95,139,181,.18);--cockpit-hover-bg:rgba(56,189,248,.08);--cockpit-tooltip-bg:rgba(3,18,38,.88);--cockpit-tooltip-border:rgba(56,189,248,.25);--cockpit-mark-border:rgba(125,211,252,.25);--cockpit-panel-padding:15px;--cockpit-panel-radius:16px;--cockpit-panel-shadow:0 16px 40px rgba(0,8,24,.3),inset 0 1px rgba(255,255,255,.04);--cockpit-panel-highlight:linear-gradient(90deg,#38bdf8,transparent);--cockpit-panel-highlight-width:45%;--cockpit-panel-highlight-height:2px;--cockpit-danger:#fda4af;--cockpit-danger-text:#fecdd3;min-height:100vh;min-width:0;max-width:100%;padding:18px;box-sizing:border-box;color:#e5f4ff;background-color:#020b18;background-image:linear-gradient(rgba(34,107,166,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(34,107,166,.07) 1px,transparent 1px),radial-gradient(circle at 50% 0,rgba(14,116,144,.22),transparent 40%);background-size:36px 36px,36px 36px,auto;overflow-x:hidden}.immersive-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:16px 18px;border:1px solid rgba(56,189,248,.2);border-radius:17px;background:rgba(5,24,48,.92);box-shadow:0 20px 46px rgba(0,8,24,.3)}.immersive-header__brand>span,.immersive-boundary header>span,.immersive-links header>span{color:#38bdf8;font-size:9px;font-weight:700;letter-spacing:.17em}.immersive-header h1{margin:4px 0 0;color:#e6f4ff;font-size:26px;letter-spacing:.04em}.immersive-header p{margin:6px 0 0;color:#8eabc8;font-size:11px;line-height:1.55}.immersive-controls{display:flex;align-items:flex-end;gap:8px}.immersive-controls label{display:grid;gap:5px;color:#8eabc8;font-size:10px}.immersive-controls :deep(.el-select){width:124px}.immersive-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 18px;padding-top:11px;border-top:1px solid rgba(148,184,218,.14);color:#8eabc8;font-size:10px}.immersive-meta span::before{content:"";display:inline-block;width:5px;height:5px;margin-right:6px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px rgba(56,189,248,.6)}
.immersive-grid{display:grid;grid-template-columns:minmax(270px,.82fr) minmax(440px,1.5fr) minmax(270px,.82fr);grid-template-areas:"left scene right";align-items:start;gap:12px;margin-top:12px}.immersive-column{display:grid;gap:12px;min-width:0}.immersive-column--left{grid-area:left}.immersive-column--right{grid-area:right}.immersive-scene{grid-area:scene;min-height:620px}.immersive-panel-select{width:170px}.immersive-panel-select--small{width:112px}.compact-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:12px}.compact-metrics--three{grid-template-columns:repeat(3,minmax(0,1fr))}.compact-metrics>div{padding:8px;border:1px solid rgba(56,189,248,.14);border-radius:9px;background:rgba(3,18,38,.55)}.compact-metrics>div:last-child:nth-child(3){grid-column:1/-1}.compact-metrics span,.risk-kpis span,.import-kpis span{display:block;color:#8eabc8;font-size:9px}.compact-metrics strong{display:block;margin-top:5px;color:#e6f4ff;font-size:14px;font-variant-numeric:tabular-nums}.compact-metrics small{color:#38bdf8;font-size:9px}.compact-metrics .metric-gap-text{color:#fbbf24;font-size:12px}.immersive-gap{display:grid;gap:4px;padding:16px;border:1px dashed rgba(251,191,36,.38);border-radius:10px;background:rgba(120,53,15,.1);text-align:center}.immersive-gap strong{color:#fde68a;font-size:12px}.immersive-gap span{color:#d6bd8b;font-size:10px}.immersive-note{margin:10px 0 0;color:#8eabc8;font-size:10px;line-height:1.55}.panel-empty-value{color:#38bdf8!important;font-size:34px!important;font-variant-numeric:tabular-nums}
.risk-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px}.risk-kpis>div{padding:7px 5px;border:1px solid rgba(56,189,248,.13);border-radius:8px;background:rgba(3,18,38,.55);text-align:center}.risk-kpis strong{display:block;margin-top:4px;color:#e6f4ff;font-size:17px}.immersive-warning-list{display:grid;gap:6px;margin-top:10px}.immersive-warning-list>div{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;background:rgba(10,31,57,.72)}.immersive-warning-list span{display:grid;gap:2px}.immersive-warning-list strong{color:#e6f4ff;font-size:10px}.immersive-warning-list small{color:#8eabc8;font-size:9px}.risk-dot{flex:0 0 auto;width:8px;height:8px;margin-top:2px;border-radius:50%;background:#60a5fa}.risk-dot--exceeded{background:#fb7185}.risk-dot--nearing{background:#fbbf24}.risk-dot--missing_budget{background:#f97316}.risk-dot--unit_mismatch{background:#fb923c}.immersive-success{margin:10px 0 0;color:#86efac;font-size:10px}.immersive-details{margin-top:9px;color:#8eabc8;font-size:10px}.immersive-details summary{cursor:pointer;color:#38bdf8}.table-scroll{max-width:100%;overflow-x:auto}.immersive-details table{width:100%;margin-top:8px;border-collapse:collapse;white-space:nowrap}.immersive-details th,.immersive-details td{padding:6px;border-bottom:1px solid rgba(148,184,218,.16);color:#e5f4ff;text-align:left}.immersive-details th{color:#bfe8ff}
.ledger-overview{display:flex;align-items:flex-end;gap:8px}.ledger-overview strong{color:#e6f4ff;font-size:36px;line-height:1}.ledger-overview span{color:#8eabc8;font-size:10px}.ledger-bars{display:grid;gap:8px;margin-top:12px}.ledger-bars span{display:block;color:#a9c7df;font-size:10px}.ledger-bars i{display:block;height:7px;margin-top:5px;border-radius:999px;background:rgba(95,139,181,.18);overflow:hidden}.ledger-bars b{display:block;height:100%;border-radius:999px;background:#34d399}.ledger-bars .ledger-bar--inactive{background:#64748b}.import-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.import-kpis>div{padding:8px;border:1px solid rgba(56,189,248,.13);border-radius:8px;background:rgba(3,18,38,.55)}.import-kpis strong{display:block;margin-top:4px;color:#e6f4ff;font-size:14px}
.immersive-bottom{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,.8fr);gap:12px;margin-top:12px}.immersive-boundary,.immersive-links{padding:14px 16px;border:1px solid rgba(56,189,248,.18);border-radius:16px;background:rgba(5,24,48,.9)}.immersive-boundary header,.immersive-links header{display:grid;gap:3px}.immersive-boundary h2,.immersive-links h2{margin:0;color:#e6f4ff;font-size:14px}.immersive-boundary header p,.immersive-links header p{margin:0;color:#8eabc8;font-size:9px}.immersive-boundary>div{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:10px}.immersive-boundary article{display:grid;gap:3px;padding:7px;border:1px dashed rgba(56,189,248,.16);border-radius:8px;background:rgba(3,18,38,.45)}.immersive-boundary article strong{color:#ccecff;font-size:10px}.immersive-boundary article span{color:#7899b5;font-size:9px;line-height:1.4}.immersive-links>div:last-child{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.immersive-links>div:last-child>span{color:#8eabc8;font-size:10px}
.immersive-dashboard :deep(.el-button){border-color:rgba(83,178,229,.32);background:rgba(8,34,66,.82);color:#ccecff}.immersive-dashboard :deep(.el-button:hover),.immersive-dashboard :deep(.el-button:focus-visible){border-color:#38bdf8;background:rgba(14,74,119,.74);color:#fff}.immersive-dashboard :deep(.el-button--primary){border-color:#0ea5e9;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff}.immersive-dashboard :deep(.el-select__wrapper){border:1px solid rgba(56,189,248,.24);background:rgba(3,18,38,.82);box-shadow:none}.immersive-dashboard :deep(.el-select__selected-item),.immersive-dashboard :deep(.el-select__placeholder){color:#d7efff}.immersive-dashboard :deep(.immersive-dashboard-popper){border-color:rgba(56,189,248,.25)!important;background:#061b33!important}.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item){color:#b9d8ef}.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item.is-hovering),.immersive-dashboard :deep(.immersive-dashboard-popper .el-select-dropdown__item.is-selected){background:rgba(56,189,248,.13);color:#fff}.immersive-dashboard :deep(.el-skeleton__item){background:linear-gradient(90deg,rgba(34,78,119,.26) 25%,rgba(43,99,146,.34) 37%,rgba(34,78,119,.26) 63%);background-size:400% 100%}
@media (max-width:1279px){.immersive-grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"scene scene" "left right"}.immersive-scene{min-height:0}.immersive-bottom{grid-template-columns:1fr}.immersive-boundary>div{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (max-width:1024px){.immersive-dashboard{padding:14px}.immersive-header{grid-template-columns:1fr}.immersive-controls{justify-content:flex-start}.immersive-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.immersive-boundary>div{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:960px){.immersive-grid{grid-template-columns:1fr;grid-template-areas:"scene" "left" "right"}.immersive-header{padding:14px}.immersive-column{grid-template-columns:1fr}.immersive-scene{order:-1}.immersive-bottom{grid-template-columns:1fr}}
@media (max-width:640px){.immersive-dashboard{padding:9px}.immersive-controls{align-items:stretch;flex-direction:column}.immersive-controls :deep(.el-select),.immersive-panel-select,.immersive-panel-select--small{width:100%}.compact-metrics,.compact-metrics--three,.risk-kpis,.import-kpis,.immersive-boundary>div{grid-template-columns:1fr}.compact-metrics>div:last-child:nth-child(3){grid-column:auto}}
@media (prefers-reduced-motion:reduce){.immersive-dashboard :deep(.el-skeleton__item){animation:none!important}.immersive-dashboard *{scroll-behavior:auto!important;transition:none!important}}
</style>
