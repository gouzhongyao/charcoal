<template>
  <ManagementPage title="能源消费分析与用能策略推荐">
    <template #title-extra>
      <HelpIcon label="查看分析口径" content="月度消费只读取 active energy_records；时序分析只读取显式导入的 15/30/60 分钟记录。缺失、真实零值、覆盖不足、不可计算和单位不可比会分别展示。策略为本地确定性规则，不接外部 AI，不自动控制设备，也不写入预算。" />
    </template>

    <template v-if="!canView">
      <PageState error="权限不足：需要 energy:analysis:view 才能访问能源消费分析。" />
    </template>
    <template v-else>
      <ManagementToolbar :loading="analysisLoading" @search="applyFilters" @reset="resetFilters">
        <el-form-item label="统计月起"><el-date-picker v-model="draftFilters.startMonth" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="开始月份" /></el-form-item>
        <el-form-item label="统计月止"><el-date-picker v-model="draftFilters.endMonth" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="结束月份" /></el-form-item>
        <el-form-item label="时序开始"><el-date-picker v-model="draftFilters.startUtc" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" :editable="true" placeholder="开始时间" /></el-form-item>
        <el-form-item label="时序结束"><el-date-picker v-model="draftFilters.endUtc" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" :editable="true" placeholder="结束时间" /></el-form-item>
        <el-form-item label="来源时区"><IanaTimeZoneSelect v-model="draftFilters.sourceTimeZone" placeholder="请选择或搜索来源时区" /></el-form-item>
        <el-form-item label="组织"><el-select v-model="draftFilters.organizationUnitId" clearable filterable placeholder="精确组织范围"><el-option v-for="item in organizations" :key="organizationId(item)" :label="organizationLabel(item)" :value="organizationId(item)" /></el-select></el-form-item>
        <el-form-item label="产能单元"><el-select v-model="draftFilters.productionUnitId" clearable filterable placeholder="强度分母范围"><el-option v-for="item in productionUnits" :key="productionUnitId(item)" :label="productionUnitLabel(item)" :value="productionUnitId(item)" /></el-select></el-form-item>
        <el-form-item label="表计"><el-select v-model="draftFilters.meterDeviceId" clearable filterable placeholder="单表计时序范围"><el-option v-for="item in meters" :key="meterId(item)" :label="meterLabel(item)" :value="meterId(item)" /></el-select></el-form-item>
        <el-form-item label="能源类型"><el-select v-model="draftFilters.energyTypeCode" clearable filterable placeholder="能源类型"><el-option v-for="item in energyTypes" :key="item.code" :label="`${item.name || item.code}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
        <el-form-item label="单位"><el-input v-model.trim="draftFilters.unit" placeholder="如 kWh" /></el-form-item>
        <el-form-item label="时序粒度"><el-select v-model="draftFilters.outputIntervalMinutes"><el-option :value="15" label="15 分钟" /><el-option :value="30" label="30 分钟" /><el-option :value="60" label="60 分钟" /></el-select></el-form-item>
        <el-form-item label="TOU 方案"><el-select v-model="draftFilters.touSchemeId" clearable filterable allow-create placeholder="显式选择或输入方案 ID"><el-option v-for="item in touSchemes" :key="item.id" :label="`${item.schemeName}（${item.schemeCode}/${item.version}）`" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="最低覆盖率"><el-input-number v-model="draftFilters.minimumCoverageRate" :min="1" :max="1" :precision="2" disabled /><div class="field-help">只读口径：负荷摘要固定要求 100% 覆盖率。</div></el-form-item>
        <template #actions><span class="applied-note">首次进入自动查询月度事实；后续输入变化点击查询后应用</span></template>
      </ManagementToolbar>

      <el-alert v-if="masterDataError" type="warning" :closable="false" show-icon :title="masterDataError" />
      <el-tabs v-model="activeTab" class="analysis-tabs">
        <el-tab-pane label="消费分析" name="analysis">
          <div class="tab-stack">
            <el-alert type="info" :closable="false" show-icon title="普通能耗导入只进入月度分析；时序卡片与曲线只读取受控 execute 实际写入的单表计时序事实。两类事实不会跨表复制或估算，不同单位不会直接相加。" />
            <PageState v-if="analysisInitialLoading" loading />
            <div v-else v-loading="analysisRefreshing" element-loading-text="正在按新筛选刷新分析结果" class="analysis-results">
              <el-alert v-if="analysisRefreshing" type="info" :closable="false" show-icon title="正在查询新筛选；刷新完成前仍展示上一次已提交查询快照，图表、表格和条件提示均按该旧快照解释。" />
              <el-alert v-if="analysisError" type="error" :closable="false" show-icon :title="analysisError" />
              <section class="stat-grid" aria-label="消费量、强度和负荷摘要">
                <StatCard label="月度累计消费" :value="formatAnalysisValue(selectedMonthlyFacetData?.totals?.value, { unit: selectedMonthlyFacetData?.unit })" :note="monthlyTotalNote" />
                <StatCard label="时序窗口总能耗" :value="formatAnalysisValue(loadSummary.metrics?.totalEnergy, { unit: loadSummary.metrics?.energyUnit, calculable: loadSummary.metrics?.totalEnergyComplete !== false })" :note="qualityStatusText(loadSummary.quality)" />
                <StatCard label="平均负荷" :value="formatAnalysisValue(loadSummary.metrics?.averageLoad, { unit: loadSummary.metrics?.loadUnit })" :note="reasonCodesText(loadSummary.quality?.reasonCodes)" />
                <StatCard label="最大负荷" :value="formatAnalysisValue(loadSummary.metrics?.maxLoad, { unit: loadSummary.metrics?.loadUnit })" :note="formatStrictUtcDateTimeDisplay(loadSummary.maxLoadInterval?.startUtc, '缺少可计算区间')" />
                <StatCard label="负载率" :value="formatAnalysisValue(loadSummary.metrics?.loadRatePercent, { unit: '%', calculable: loadSummary.metrics?.loadRateCalculable !== false })" :note="loadSummary.metrics?.loadRateReason || '平均负荷 / 最大负荷'" />
                <StatCard label="单位产量强度" :value="intensityHeadline" :note="intensityHeadlineNote" />
                <StatCard label="月度分面" :value="String(monthlyFacets.length)" note="按能源类型与单位独立分面" />
              </section>

              <article class="page-card chart-panel">
                <header class="panel-heading"><div><h2>固定 UTC 负荷曲线</h2><span>单轴 · 2px 折线 · 缺失桶断线 · 真实零值落在基线</span></div><div class="quality-tags"><StatusTag :status="loadSummary.quality?.status || 'unknown'" :label="`摘要：${qualityStatusText(loadSummary.quality)}`" /><StatusTag :status="loadCurve.quality?.status || 'unknown'" :label="`曲线：${qualityStatusText(loadCurve.quality)}`" /></div></header>
                <PageState v-if="!timeseriesReady" description="时序卡片和曲线不会由普通能耗导入填充。请完成时序 preview + execute 且实际写入大于 0，再选择精确表计、能源类型、标准化单位、来源时区和相交时间范围。" />
                <PageState v-else-if="!curveRows.length" :description="`暂无时序曲线数据。成功 0、失败 1 或仅完成 preview 都不会产生可分析事实。${reasonCodesText(loadCurve.quality?.reasonCodes)}`" />
                <template v-else>
                  <div class="wide-scroll">
                    <svg class="line-chart" viewBox="0 0 720 260" role="img" aria-labelledby="energy-load-curve-title energy-load-curve-desc" @mouseleave="curveTooltip = null">
                      <title id="energy-load-curve-title">固定 UTC 网格能耗折线图</title>
                      <desc id="energy-load-curve-desc">{{ curveChartDescription }}</desc>
                      <line v-for="tick in 5" :key="tick" x1="58" :y1="24 + (tick - 1) * 48.5" x2="700" :y2="24 + (tick - 1) * 48.5" class="grid-line" />
                      <polyline v-for="(segment, index) in curveSegments" :key="index" :points="segment" class="curve-line" />
                      <g v-for="point in curvePoints.filter((item) => Number.isFinite(item.y))" :key="point.key" aria-hidden="true" @mouseenter="curveTooltip = point">
                        <circle :cx="point.x" :cy="point.y" r="12" class="point-hit" />
                        <circle :cx="point.x" :cy="point.y" r="4" class="point-dot" />
                      </g>
                      <text x="58" y="248" class="axis-text">{{ formatStrictUtcDateTimeDisplay(curveRows[0]?.startUtc, '') }}</text>
                      <text x="700" y="248" text-anchor="end" class="axis-text">{{ formatStrictUtcDateTimeDisplay(curveRows.at(-1)?.endUtc, '') }}</text>
                    </svg>
                  </div>
                  <p v-if="curveTooltip" class="chart-tooltip" role="status">{{ curvePointLabel(curveTooltip) }}</p>
                  <div class="wide-scroll"><el-table :data="curveRows" size="small" max-height="320"><el-table-column label="桶开始 UTC" min-width="180"><template #default="{ row }">{{ formatStrictUtcDateTimeDisplay(row.startUtc) }}</template></el-table-column><el-table-column label="桶结束 UTC" min-width="180"><template #default="{ row }">{{ formatStrictUtcDateTimeDisplay(row.endUtc) }}</template></el-table-column><el-table-column label="能耗" min-width="130"><template #default="{ row }">{{ formatAnalysisValue(row.energy, { unit: row.energyUnit }) }}</template></el-table-column><el-table-column label="平均负荷" min-width="130"><template #default="{ row }">{{ formatAnalysisValue(row.averageLoad, { unit: row.loadUnit }) }}</template></el-table-column><el-table-column prop="observationMode" label="观测模式" min-width="120" /></el-table></div>
                </template>
              </article>

              <section class="two-column-grid">
                <article class="page-card chart-panel">
                  <header class="panel-heading"><div><h2>月度消费量与同环比</h2><span>缺月为“缺失”，有记录且为零显示 0</span></div></header>
                  <PageState v-if="!monthlyFacets.length" :description="monthlyEmptyDescription" />
                  <template v-else>
                    <el-select v-model="selectedMonthlyFacet" placeholder="选择能源与单位分面"><el-option v-for="(facet, index) in monthlyFacets" :key="monthlyFacetKey(facet)" :label="`${facet.energyType?.name || facet.energyType?.code || facet.energyTypeCode} / ${facet.unit}`" :value="index" /></el-select>
                    <div class="wide-scroll"><el-table :data="selectedMonthlyTrend" size="small" max-height="360"><el-table-column prop="month" label="月份" width="90" /><el-table-column label="消费量" min-width="130"><template #default="{ row }">{{ formatAnalysisValue(row.value, { unit: selectedMonthlyFacetData?.unit }) }}</template></el-table-column><el-table-column label="环比" min-width="150"><template #default="{ row }">{{ monthlyComparisonText(row.periodOverPeriod) }}</template></el-table-column><el-table-column label="同比" min-width="150"><template #default="{ row }">{{ monthlyComparisonText(row.yearOverYear) }}</template></el-table-column><el-table-column prop="recordCount" label="记录数" width="88" /></el-table></div>
                  </template>
                </article>

                <article class="page-card chart-panel">
                  <header class="panel-heading"><div><h2>消费强度</h2><span>精确组织范围；发电不抵扣；单位不可比不计算</span></div></header>
                  <PageState v-if="!analysisDisplayFilters.productionUnitId" description="请选择产能单元后点击查询。" />
                  <PageState v-else-if="!intensityFacets.length" description="暂无强度分面或分母数据不足。" />
                  <div v-else class="wide-scroll"><el-table :data="intensityFacets" size="small"><el-table-column prop="energyTypeName" label="能源类型" min-width="120"><template #default="{ row }">{{ row.energyTypeName || row.energyTypeCode }}</template></el-table-column><el-table-column label="单位可比" width="100"><template #default="{ row }"><StatusTag :status="row.unitComparable ? 'active' : 'warning'" :label="row.unitComparable ? '可比' : '不可比'" /></template></el-table-column><el-table-column label="累计消费量" min-width="145"><template #default="{ row }">{{ formatAnalysisValue(row.aggregate?.numeratorValue, { unit: row.numeratorUnit }) }}</template></el-table-column><el-table-column label="累计产量" min-width="145"><template #default="{ row }">{{ formatAnalysisValue(row.aggregate?.denominatorValue, { unit: row.denominatorUnit }) }}</template></el-table-column><el-table-column label="强度" min-width="160"><template #default="{ row }">{{ formatAnalysisValue(row.aggregate?.intensityValue, { unit: row.aggregate?.intensityUnit, calculable: row.aggregate?.calculable }) }}</template></el-table-column><el-table-column label="原因" min-width="220"><template #default="{ row }">{{ reasonCodesText(row.reasonCodes) }}</template></el-table-column></el-table></div>
                </article>
              </section>

              <section class="three-column-grid">
                <article class="page-card compact-panel"><header class="panel-heading"><div><h2>峰平谷</h2><span>显式 TOU 方案</span></div></header><PageState v-if="!analysisDisplayFilters.touSchemeId" description="请在配置加载后选择显式 TOU 方案。" /><template v-else-if="touPeriods.length"><div class="legend" aria-label="峰平谷图例"><span v-for="([key, presentation]) in touPresentationEntries" :key="key"><i :style="{ backgroundColor: presentation.color }" />{{ presentation.label }}</span></div><div v-for="row in touPeriods" :key="row.type" class="metric-bar" :aria-label="`${touPresentation(row.type).label} ${formatAnalysisValue(row.observed, { unit: row.energyUnit })}`"><span>{{ touPresentation(row.type).label }}</span><span class="metric-track" aria-hidden="true"><i :style="{ width: `${energyAnalysisBarPercentage(row.observed, touMax)}%`, backgroundColor: touPresentation(row.type).color }" /></span><strong>{{ formatAnalysisValue(row.observed, { unit: row.energyUnit }) }}</strong></div><el-table :data="touPeriods" size="small"><el-table-column label="时段"><template #default="{ row }">{{ touPresentation(row.type).label }}</template></el-table-column><el-table-column label="消费量"><template #default="{ row }">{{ formatAnalysisValue(row.observed, { unit: row.energyUnit }) }}</template></el-table-column><el-table-column label="覆盖率"><template #default="{ row }">{{ formatCoverageRate(row.coverageRate) }}</template></el-table-column></el-table></template><PageState v-else description="暂无峰平谷结果或方案不适用。" /></article>
                <article class="page-card compact-panel"><header class="panel-heading"><div><h2>班次</h2><span>按实际重叠分钟分配</span></div></header><PageState v-if="!shiftRows.length" :description="reasonCodesText(shiftAnalysis.quality?.reasonCodes)" /><div v-else class="wide-scroll"><el-table :data="shiftRows" size="small"><el-table-column prop="name" label="班次" min-width="100" /><el-table-column label="消费量" min-width="130"><template #default="{ row }">{{ formatAnalysisValue(row.observedEnergy, { unit: row.energyUnit }) }}</template></el-table-column><el-table-column label="覆盖率" min-width="100"><template #default="{ row }">{{ formatCoverageRate(row.coverageRate) }}</template></el-table-column></el-table></div></article>
                <article class="page-card compact-panel"><header class="panel-heading"><div><h2>设备状态与显式空载</h2><span>缺口和 unknown 不计空载</span></div></header><div class="boundary-note">仅 explicit idle 与时序能耗重叠部分作为空载事实；系统不会把未物化缺口推断为停机或浪费。</div><PageState v-if="!deviceStateRows.length" :description="reasonCodesText(deviceStateAnalysis.quality?.reasonCodes)" /><div v-else class="wide-scroll"><el-table :data="deviceStateRows" size="small"><el-table-column prop="status" label="状态" min-width="95" /><el-table-column prop="minutes" label="分钟" width="80" /><el-table-column label="占比" min-width="100"><template #default="{ row }">{{ formatAnalysisValue(Number(row.share || 0) * 100, { unit: '%' }) }}</template></el-table-column><el-table-column label="显式记录" width="90"><template #default="{ row }">{{ row.explicit ? '是' : '否' }}</template></el-table-column></el-table></div><p class="quality-line">显式 idle：{{ deviceStateAnalysis.quality?.idleMinutes ?? '缺失' }} 分钟；未物化缺口：{{ deviceStateAnalysis.quality?.unmaterializedGapMinutes ?? '缺失' }} 分钟</p></article>
              </section>

              <article class="page-card chart-panel"><header class="panel-heading"><div><h2>高峰贡献</h2><span>精确组织范围；覆盖不足只展示候选区间，不自动推断根因</span></div></header><PageState v-if="!analysisDisplayFilters.organizationUnitId" description="请选择精确组织范围后点击查询。" /><template v-else><div class="peak-summary"><strong>{{ peakContribution.peak?.calculable ? '可计算高峰' : '候选高峰' }}</strong><span>{{ formatAnalysisValue((peakContribution.peak?.calculable ? peakContribution.peak : peakContribution.candidatePeak)?.energy, { unit: (peakContribution.peak?.calculable ? peakContribution.peak : peakContribution.candidatePeak)?.energyUnit, calculable: peakContribution.peak?.calculable || peakContribution.candidatePeak?.available }) }}</span><span>{{ reasonCodesText((peakContribution.peak?.calculable ? peakContribution.peak : peakContribution.candidatePeak)?.reasonCodes) }}</span></div><div class="wide-scroll"><el-table :data="peakContribution.contributors || []" size="small"><el-table-column prop="meterCode" label="表计编码" min-width="120" /><el-table-column prop="meterName" label="表计名称" min-width="130" /><el-table-column prop="recordCount" label="记录数" width="90" /><el-table-column label="覆盖率" min-width="110"><template #default="{ row }">{{ formatCoverageRate(row.coverageRate) }}</template></el-table-column><el-table-column label="原因" min-width="220"><template #default="{ row }">{{ reasonCodesText(row.reasonCodes) }}</template></el-table-column></el-table></div></template></article>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="用能策略" name="strategy">
          <div class="tab-stack">
            <el-alert type="warning" :closable="false" show-icon title="策略仅运行本地确定性、可解释规则；不会连接外部 AI，不会自动控制设备、改变设备状态或写入预算。所有正式命中都需要人工复核。" />
            <article class="page-card">
              <header class="panel-heading"><div><h2>本地规则评价</h2><span>预演不落库；正式运行才创建运行与命中记录</span></div><div class="action-row"><el-button v-if="canEvaluateStrategy" :loading="strategyLoading" @click="evaluateStrategies">运行预演</el-button><el-button v-if="canRunStrategy" type="primary" :loading="strategyLoading" @click="runStrategies">正式运行</el-button></div></header>
              <el-select v-model="selectedRuleCodes" multiple clearable collapse-tags placeholder="留空表示所有当前有效规则"><el-option v-for="rule in strategyRules.filter((item) => item.status === 'active')" :key="rule.id" :label="`${rule.ruleName}（${rule.ruleCode}/${rule.ruleVersion}）`" :value="rule.ruleCode" /></el-select>
              <el-alert v-if="strategyError" type="error" :closable="false" show-icon :title="strategyError" class="panel-alert" />
              <el-alert v-if="strategyInputChangedNotice" type="info" :closable="false" show-icon :title="strategyInputChangedNotice" class="panel-alert" />
              <div v-loading="strategyLoading && (strategyEvaluations.length || strategyHits.length)" element-loading-text="正在按冻结输入快照运行本地策略">
                <PageState v-if="!strategyResult" :loading="strategyLoading" description="尚未运行策略预演或正式评价。" />
                <template v-else-if="strategyResult?.kind === 'evaluate'">
                  <h3 class="subheading">本次预演结果</h3>
                  <div class="wide-scroll"><el-table :data="strategyEvaluations" size="small"><el-table-column prop="ruleCode" label="规则" min-width="120" /><el-table-column prop="ruleVersion" label="版本" width="90" /><el-table-column prop="metricCode" label="指标" min-width="130" /><el-table-column prop="matchStatus" label="匹配状态" min-width="110" /><el-table-column label="实际值" min-width="130"><template #default="{ row }">{{ formatAnalysisValue(row.actualValue, { unit: row.threshold?.unit }) }}</template></el-table-column><el-table-column label="阈值" min-width="160"><template #default="{ row }">{{ thresholdLabel(row.threshold) }}</template></el-table-column><el-table-column label="覆盖率" min-width="110"><template #default="{ row }">{{ formatCoverageRate(row.coverageRate) }}</template></el-table-column><el-table-column prop="priority" label="优先级" width="90" /><el-table-column prop="recommendation" label="建议" min-width="240" show-overflow-tooltip /><el-table-column label="原因" min-width="220"><template #default="{ row }">{{ reasonCodesText(row.reasonCodes) }}</template></el-table-column></el-table></div>
                </template>
                <template v-else-if="strategyResult?.kind === 'run'">
                  <h3 class="subheading">本次正式运行命中</h3>
                  <div class="wide-scroll"><el-table :data="strategyHits" size="small"><el-table-column prop="ruleCode" label="规则" min-width="120" /><el-table-column prop="ruleName" label="规则名称" min-width="150" /><el-table-column label="人工状态" min-width="120"><template #default="{ row }"><StatusTag :status="row.manualStatus" :label="STRATEGY_STATUS_LABELS[row.manualStatus] || row.manualStatus" /></template></el-table-column><el-table-column label="实际值" min-width="120"><template #default="{ row }">{{ formatAnalysisValue(row.actualValue, { unit: row.threshold?.unit }) }}</template></el-table-column><el-table-column label="预计节能" min-width="135"><template #default="{ row }">{{ formatAnalysisValue(row.estimatedSaving, { unit: row.estimatedSavingUnit, missingText: '未估算', unavailableText: '未估算' }) }}</template></el-table-column><el-table-column label="人工备注" min-width="180"><template #default="{ row }">{{ row.reviewNote || '—' }}</template></el-table-column><el-table-column label="操作" width="190" fixed="right"><template #default="{ row }"><el-button v-if="canReviewStrategy && allowedStrategyStatuses(row.manualStatus).length" link type="primary" @click="openReview(row)">人工复核</el-button><span v-else>无可用流转</span></template></el-table-column></el-table></div>
                </template>
              </div>
            </article>
          </div>
        </el-tab-pane>

        <el-tab-pane label="分析配置" name="config">
          <div class="tab-stack">
            <PageState v-if="!canViewConfig" error="权限不足：需要 energy:analysis:config:view 才能查询排班、TOU 和策略规则配置。" />
            <template v-else>
              <el-alert type="info" :closable="false" show-icon title="配置采用版本化维护：新版本不会覆盖历史记录；启用某版本时由后端停用同编码的其他版本。维护态下写操作会被阻止。" />
              <el-alert v-if="configError" type="error" :closable="false" show-icon :title="configError" />
              <el-tabs v-model="configTab" type="border-card">
                <el-tab-pane label="排班定义" name="shifts"><div class="config-actions"><el-button @click="loadConfigurations">刷新</el-button><el-button v-if="canManageShift" type="primary" @click="openConfig('shift')">创建首版本</el-button></div><div class="wide-scroll"><el-table :data="shiftDefinitions" v-loading="configLoading" size="small"><el-table-column prop="shiftCode" label="编码" min-width="120" /><el-table-column prop="shiftName" label="名称" min-width="130" /><el-table-column label="时段" min-width="150"><template #default="{ row }">{{ minuteLabel(row.startMinute) }} - {{ minuteLabel(row.endMinute) }}{{ row.crossesMidnight ? '（跨日）' : '' }}</template></el-table-column><el-table-column prop="version" label="版本" width="90" /><el-table-column prop="sourceTimeZone" label="时区" min-width="130" /><el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column><el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><el-button v-if="canManageShift" link type="primary" @click="openConfig('shift', row)">新版本</el-button><el-button v-if="canManageShift" link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleConfigStatus('shift', row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column></el-table></div></el-tab-pane>
                <el-tab-pane label="TOU 方案" name="tou"><div class="config-actions"><el-button @click="loadConfigurations">刷新</el-button><el-button v-if="canManageTou" type="primary" @click="openConfig('tou')">创建首版本</el-button></div><div class="wide-scroll"><el-table :data="touSchemes" v-loading="configLoading" size="small"><el-table-column prop="schemeCode" label="编码" min-width="120" /><el-table-column prop="schemeName" label="名称" min-width="140" /><el-table-column prop="version" label="版本" width="90" /><el-table-column prop="documentNo" label="文号" min-width="120" /><el-table-column label="规则数" width="90"><template #default="{ row }">{{ row.periodRules?.length || 0 }}</template></el-table-column><el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column><el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><el-button v-if="canManageTou" link type="primary" @click="openConfig('tou', row)">新版本</el-button><el-button v-if="canManageTou" link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleConfigStatus('tou', row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column></el-table></div></el-tab-pane>
                <el-tab-pane label="策略规则" name="rules"><div class="config-actions"><el-button @click="loadConfigurations">刷新</el-button><el-button v-if="canManageRule" type="primary" @click="openConfig('rule')">创建首版本</el-button></div><div class="wide-scroll"><el-table :data="strategyRules" v-loading="configLoading" size="small"><el-table-column prop="ruleCode" label="编码" min-width="130" /><el-table-column prop="ruleName" label="名称" min-width="150" /><el-table-column prop="ruleVersion" label="版本" width="90" /><el-table-column prop="metricCode" label="指标" min-width="130" /><el-table-column prop="thresholdOperator" label="运算符" width="90" /><el-table-column prop="priority" label="优先级" width="90" /><el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column><el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><el-button v-if="canManageRule" link type="primary" @click="openConfig('rule', row)">新版本</el-button><el-button v-if="canManageRule" link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleConfigStatus('rule', row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column></el-table></div></el-tab-pane>
              </el-tabs>
            </template>
          </div>
        </el-tab-pane>

        <el-tab-pane label="受控导入" name="imports">
          <div class="tab-stack">
            <el-alert type="info" :closable="false" show-icon title="预演会在服务端保存原文件、生成签名和候选见证；执行只提交 JSON 见证，服务端会从原文件重新计算。页面不会伪造成功。" />
            <section class="import-grid">
              <article v-for="definition in importDefinitions" :key="definition.key" class="page-card import-card">
                <header class="panel-heading"><div><h2>{{ definition.label }}导入</h2><span>preview / execute</span></div></header>
                <el-alert v-if="!hasPermissionCode(definition.previewPermission)" type="warning" :closable="false" show-icon title="当前账号没有该类导入预演权限。" />
                <template v-else>
                  <div class="action-row import-downloads"><el-button @click="downloadImportTemplate(definition)">空白模板</el-button></div>
                  <el-upload :auto-upload="false" :limit="1" :file-list="importStates[definition.key].files" :on-change="(file) => selectImportFile(definition.key, file)" :on-remove="() => clearImport(definition.key)" :accept="definition.accept"><el-button>选择导入文件</el-button><template #tip><div class="el-upload__tip">仅接受 {{ definition.accept }}；文件大小由服务端限制，HTTP 413 会明确区分文件与 execute 正文超限。</div></template></el-upload>
                  <div class="action-row"><el-button :loading="importStates[definition.key].loading" :disabled="!importStates[definition.key].file" @click="previewImport(definition)">服务端预演</el-button><el-button v-if="hasPermissionCode(definition.executePermission)" type="primary" :disabled="!canExecuteEnergyAnalysisImport(importStates[definition.key].preview)" @click="openImportExecute(definition)">受控执行</el-button></div>
                  <el-alert v-if="importStates[definition.key].error" type="error" :closable="false" show-icon :title="importStates[definition.key].error" />
                  <dl v-if="importStates[definition.key].preview" class="preview-facts"><div><dt>状态</dt><dd>预演完成，未写业务事实</dd></div><div><dt>批次</dt><dd>{{ importStates[definition.key].preview.batchId }}</dd></div><div><dt>可导入</dt><dd>{{ importStates[definition.key].preview.summary?.wouldImport ?? importStates[definition.key].preview.expectedWouldImport ?? 0 }}</dd></div><div><dt>跳过</dt><dd>{{ importStates[definition.key].preview.summary?.skipped ?? importStates[definition.key].preview.summary?.wouldSkip ?? 0 }}</dd></div><div><dt>阻断</dt><dd>{{ importStates[definition.key].preview.summary?.blocked ?? importStates[definition.key].preview.summary?.wouldBlock ?? 0 }}</dd></div><div><dt>错误</dt><dd>{{ importStates[definition.key].preview.summary?.errors ?? 0 }}</dd></div></dl>
                </template>
              </article>
            </section>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <ManagementDrawer v-model="reviewDrawerOpen" title="策略命中人工复核" confirm-label="提交人工状态" :loading="reviewLoading" :confirm-disabled="!reviewValidation.valid" @save="submitReview">
      <el-form label-position="top"><el-form-item label="目标状态"><el-select v-model="reviewForm.manualStatus"><el-option v-for="status in allowedStrategyStatuses(reviewTarget?.manualStatus)" :key="status" :label="STRATEGY_STATUS_LABELS[status]" :value="status" /></el-select></el-form-item><el-form-item label="人工复核备注"><el-input v-model="reviewForm.reviewNote" type="textarea" :rows="5" maxlength="1000" show-word-limit placeholder="拒绝或解决时必填；接受时建议记录判断依据" /></el-form-item></el-form><el-alert v-if="!reviewValidation.valid" type="warning" :closable="false" :title="reviewValidation.message" />
    </ManagementDrawer>

    <ManagementDrawer v-model="configDrawerOpen" :title="configDrawerTitle" confirm-label="保存版本" :loading="configSaving" :confirm-disabled="configFormHydrationBlocked" @save="saveConfig">
      <el-alert type="info" :closable="false" show-icon title="新配置不会预选状态；班次、周期、阈值、有效期和启停状态都必须核对后显式填写。" class="panel-alert" />
      <el-form label-position="top" class="drawer-form">
        <template v-if="configKind === 'shift'"><el-form-item v-if="!configSource" label="排班编码"><el-input v-model.trim="configForm.shiftCode" placeholder="必填，请输入稳定业务编码" /></el-form-item><el-form-item label="排班名称"><el-input v-model.trim="configForm.shiftName" placeholder="必填" /></el-form-item><div class="form-grid"><el-form-item label="开始时间"><TimeOfDayInput v-model="configForm.startMinute" placeholder="请选择或输入开始时间" /></el-form-item><el-form-item label="结束时间"><TimeOfDayInput v-model="configForm.endMinute" placeholder="请选择或输入结束时间" /></el-form-item></div><el-form-item label="是否跨日"><el-radio-group v-model="configForm.crossesMidnight"><el-radio :label="false">否</el-radio><el-radio :label="true">是</el-radio></el-radio-group><div class="field-help">必须显式选择；页面不会根据起止分钟自动推断。</div></el-form-item><el-form-item label="版本"><el-input v-model.trim="configForm.version" placeholder="必填，请显式填写新版本" /></el-form-item></template>
        <template v-else-if="configKind === 'tou'"><el-form-item v-if="!configSource" label="方案编码"><el-input v-model.trim="configForm.schemeCode" /></el-form-item><el-form-item label="方案名称"><el-input v-model.trim="configForm.schemeName" /></el-form-item><el-form-item label="文号"><el-input v-model.trim="configForm.documentNo" /></el-form-item><el-form-item label="版本"><el-input v-model.trim="configForm.version" /></el-form-item><el-form-item label="完整周期规则 JSON"><el-input v-model="configForm.periodRulesText" type="textarea" :rows="10" /><div class="field-help">数组字段：dayOfWeek(1-7)、periodType(peak/flat/valley)、startMinute、endMinute；每天必须无缺口覆盖 0-1440。</div></el-form-item></template>
        <template v-else><el-form-item v-if="!configSource" label="规则编码"><el-input v-model.trim="configForm.ruleCode" /></el-form-item><el-form-item label="规则名称"><el-input v-model.trim="configForm.ruleName" /></el-form-item><div class="form-grid"><el-form-item label="规则版本"><el-input v-model.trim="configForm.ruleVersion" /></el-form-item><el-form-item label="公式版本"><el-select v-model="configForm.formulaVersion" placeholder="请选择固定公式版本"><el-option v-for="version in ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyFormulaVersions" :key="version" :label="`负荷分析 v1（${version}）`" :value="version" /></el-select></el-form-item></div><el-form-item label="指标"><el-select v-model="configForm.metricCode"><el-option v-for="metricCode in ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyMetricCodes" :key="metricCode" :label="strategyMetricLabel(metricCode)" :value="metricCode" /></el-select></el-form-item><div class="form-grid"><el-form-item label="阈值运算符"><el-select v-model="configForm.thresholdOperator"><el-option v-for="operator in ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyThresholdOperators" :key="operator" :value="operator" :label="operator" /></el-select></el-form-item><el-form-item label="阈值单位"><el-input v-model.trim="configForm.thresholdUnit" /></el-form-item></div><div class="form-grid"><el-form-item label="阈值"><el-input-number v-model="configForm.thresholdValue" /></el-form-item><el-form-item label="阈值下限"><el-input-number v-model="configForm.thresholdMin" /></el-form-item><el-form-item label="阈值上限"><el-input-number v-model="configForm.thresholdMax" /></el-form-item></div><div class="form-grid"><el-form-item label="可削减比例"><el-input-number v-model="configForm.reductionRate" :min="0" :max="1" :step="0.05" /></el-form-item><el-form-item label="优先级"><el-select v-model="configForm.priority"><el-option v-for="priority in ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyPriorities" :key="priority" :label="strategyPriorityLabel(priority)" :value="priority" /></el-select></el-form-item></div><el-form-item label="证据要求 JSON"><el-input v-model="configForm.evidenceRequirementsText" type="textarea" :rows="5" /></el-form-item><el-form-item label="建议文本"><el-input v-model="configForm.recommendationText" type="textarea" :rows="4" /></el-form-item></template>
        <el-form-item label="来源"><el-input v-model.trim="configForm.source" placeholder="必填，如制度文件或维护工单" /></el-form-item><el-form-item label="来源时区"><IanaTimeZoneSelect v-model="configForm.sourceTimeZone" placeholder="请选择或搜索来源时区" /></el-form-item><div class="form-grid"><el-form-item label="生效开始 UTC"><StrictUtcDateTimeInput v-model="configForm.effectiveStartUtc" placeholder="必须显式选择或输入 UTC 时间" /></el-form-item><el-form-item label="生效结束 UTC"><StrictUtcDateTimeInput v-model="configForm.effectiveEndUtc" placeholder="必须显式选择或输入 UTC 时间" /></el-form-item></div><el-form-item label="状态"><el-radio-group v-model="configForm.status"><el-radio v-for="status in ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.statuses" :key="status" :label="status">{{ configurationStatusLabel(status) }}</el-radio></el-radio-group><div class="field-help">必须显式选择启用或停用；建议先停用保存，复核后再从列表启用。</div></el-form-item>
      </el-form>
      <el-alert v-if="configFormError" type="error" :closable="false" show-icon :title="configFormError" />
    </ManagementDrawer>

    <ManagementDrawer v-model="importDrawerOpen" :title="`${activeImportDefinition?.label || ''}受控执行确认`" confirm-label="确认执行导入" :loading="importExecuteLoading" :confirm-disabled="importConfirmText !== activeImportPreview?.confirmText" @save="executeImport">
      <el-alert type="warning" :closable="false" show-icon title="后端将从预演保存的原文件重新计算，并核对签名、文件 SHA、摘要、候选和固定确认文本。" />
      <el-form label-position="top"><el-form-item :label="`请输入固定确认文本：${activeImportPreview?.confirmText || ''}`"><el-input v-model="importConfirmText" /></el-form-item></el-form>
    </ManagementDrawer>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import HelpIcon from '@/components/HelpIcon.vue';
import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import ManagementPage from '@/components/ManagementPage.vue';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import TimeOfDayInput from '@/components/TimeOfDayInput.vue';
import { ledgerApi } from '@/api/ledger';
import {
  createShiftDefinition, createShiftDefinitionVersion, createStrategyRule, createStrategyRuleVersion,
  createTouScheme, createTouSchemeVersion,
  downloadEnergyAnalysisImportTemplate, evaluateEnergyStrategies, executeEnergyAnalysisImport,
  getDeviceStateConsumptionAnalysis, getEnergyIntensityAnalysis, getEnergyLoadCurve, getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis, getPeakContributionAnalysis, getShiftConsumptionAnalysis, getTimeOfUseAnalysis,
  listShiftDefinitions, listStrategyRules, listTouSchemes, previewEnergyAnalysisImport, reviewEnergyStrategyHit,
  runEnergyStrategies, setShiftDefinitionStatus, setStrategyRuleStatus, setTouSchemeStatus
} from '@/api/energyAnalysis';
import { hasPermi } from '@/utils/permission';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';
import {
  ENERGY_ANALYSIS_CONFIGURATION_CONTRACT, ENERGY_ANALYSIS_IMPORT_TYPES, ENERGY_ANALYSIS_PERMISSIONS,
  ENERGY_ANALYSIS_TOU_PRESENTATION, STRATEGY_STATUS_LABELS,
  allowedStrategyStatuses, buildEnergyAnalysisConfigPayload, buildImportExecutePayload, buildIntensityParams,
  buildLoadCurveParams, buildLoadCurvePoints, buildLoadCurveSegments, buildLoadSummaryParams,
  buildMonthlyAnalysisParams, buildPeakContributionParams, buildStrategyParams, buildTimeseriesAnalysisParams,
  buildTouParams, canExecuteEnergyAnalysisImport, commitEnergyAnalysisStrategyResult,
  completeEnergyAnalysisResultTransition, createDefaultEnergyAnalysisFilters, createEmptyEnergyAnalysisResult,
  createEnergyAnalysisConfigForm, createEnergyAnalysisSnapshot, createLatestEnergyAnalysisRequestGate,
  energyAnalysisBarPercentage, energyAnalysisErrorText, formatAnalysisValue, formatCoverageRate, masterDataItems,
  monthlyComparisonText, normalizeLoadCurveRows, qualityStatusText, reasonCodesText,
  replaceEnergyAnalysisStrategyHit, responseItems, startEnergyAnalysisResultTransition,
  summarizeEnergyAnalysisImportExecuteResult, touPresentation, validateEnergyAnalysisLoadCurveGrid,
  validateStrategyReview
} from '@/utils/energyAnalysis';

// 页面筛选、标签和主数据模块变量。
const activeTab = ref('analysis');
const configTab = ref('shifts');
const defaultFilters = createDefaultEnergyAnalysisFilters();
const draftFilters = ref({ ...defaultFilters });
const appliedFilters = ref(createEnergyAnalysisSnapshot(defaultFilters));
const organizations = ref([]);
const meters = ref([]);
const productionUnits = ref([]);
const energyTypes = ref([]);
const masterDataError = ref('');
const touPresentationEntries = Object.entries(ENERGY_ANALYSIS_TOU_PRESENTATION);
const importDefinitions = Object.values(ENERGY_ANALYSIS_IMPORT_TYPES);

// 分析结果、输入快照、最新请求门和加载状态模块变量。
const analysisLoading = ref(false);
const analysisError = ref('');
const analysisRequestGate = createLatestEnergyAnalysisRequestGate();
const analysisResultState = ref(createEnergyAnalysisSnapshot({ displaySnapshot: null, pendingSnapshot: null }));
const curveTooltip = ref(null);
const selectedMonthlyFacet = ref(0);

// 单一策略展示快照、最新请求门和人工复核模块变量。
const strategyLoading = ref(false);
const strategyError = ref('');
const strategyInputChangedNotice = ref('');
const selectedRuleCodes = ref([]);
const strategyResult = ref(null);
const strategyRequestGate = createLatestEnergyAnalysisRequestGate();
const reviewDrawerOpen = ref(false);
const reviewLoading = ref(false);
const reviewTarget = ref(null);
const reviewForm = reactive({ manualStatus: '', reviewNote: '' });

// 配置列表、抽屉和表单模块变量。
const configLoading = ref(false);
const configSaving = ref(false);
const configError = ref('');
const configFormError = ref('');
const configFormHydrationBlocked = ref(false);
const shiftDefinitions = ref([]);
const touSchemes = ref([]);
const strategyRules = ref([]);
const configDrawerOpen = ref(false);
const configKind = ref('shift');
const configSource = ref(null);
const configForm = reactive({});

// 六类导入的文件、预演和执行模块变量。
const importStates = reactive(Object.fromEntries(importDefinitions.map((definition) => [definition.key, { file: null, files: [], preview: null, loading: false, error: '' }])));
const importDrawerOpen = ref(false);
const importExecuteLoading = ref(false);
const importConfirmText = ref('');
const activeImportDefinition = ref(null);
const activeImportPreview = ref(null);

// 权限计算属性模块。
const canView = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.view));
const canEvaluateStrategy = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.strategyEvaluate));
const canRunStrategy = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.strategyRun));
const canReviewStrategy = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.strategyReview));
const canViewConfig = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.configView));
const canManageShift = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.shiftManage));
const canManageTou = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.touManage));
const canManageRule = computed(() => hasPermi(ENERGY_ANALYSIS_PERMISSIONS.strategyRuleManage));

// 分析派生数据模块，所有结果语义必须绑定已提交结果自己的输入快照。
const analysisDisplaySnapshot = computed(() => analysisResultState.value.displaySnapshot);
const analysisDisplayFilters = computed(() => analysisDisplaySnapshot.value?.inputSnapshot || appliedFilters.value);
const analysisResultData = computed(() => analysisDisplaySnapshot.value?.resultSnapshot || createEmptyEnergyAnalysisResult());
const loadSummary = computed(() => analysisResultData.value.loadSummary);
const loadCurve = computed(() => analysisResultData.value.loadCurve);
const monthlyAnalysis = computed(() => analysisResultData.value.monthlyAnalysis);
const intensityAnalysis = computed(() => analysisResultData.value.intensityAnalysis);
const touAnalysis = computed(() => analysisResultData.value.touAnalysis);
const shiftAnalysis = computed(() => analysisResultData.value.shiftAnalysis);
const deviceStateAnalysis = computed(() => analysisResultData.value.deviceStateAnalysis);
const peakContribution = computed(() => analysisResultData.value.peakContribution);
const timeseriesReady = computed(() => isTimeseriesReady(analysisDisplayFilters.value));
const analysisInitialLoading = computed(() => analysisLoading.value && !analysisDisplaySnapshot.value);
const analysisRefreshing = computed(() => analysisLoading.value && Boolean(analysisDisplaySnapshot.value));
const curveRows = computed(() => normalizeLoadCurveRows(loadCurve.value.buckets));
const curvePoints = computed(() => buildLoadCurvePoints(curveRows.value));
const curveSegments = computed(() => buildLoadCurveSegments(curvePoints.value));
const curveChartDescription = computed(() => {
  const first = curveRows.value[0];
  const last = curveRows.value.at(-1);
  const unit = curveRows.value.find((row) => row.energyUnit)?.energyUnit || '未提供单位';
  const missingCount = curveRows.value.filter((row) => !Number.isFinite(row.energy)).length;
  return `单位 ${unit}；范围 ${formatStrictUtcDateTimeDisplay(first?.startUtc, '未知')} 至 ${formatStrictUtcDateTimeDisplay(last?.endUtc, '未知')}；共有 ${curveRows.value.length} 个时间桶，${missingCount} 个缺失桶以断线表示。详细数值见图后等价表格。`;
});
const monthlyFacets = computed(() => monthlyAnalysis.value.facets || []);
const selectedMonthlyFacetData = computed(() => monthlyFacets.value[selectedMonthlyFacet.value] || monthlyFacets.value[0] || null);
const selectedMonthlyTrend = computed(() => selectedMonthlyFacetData.value?.trend || []);
const monthlyTotalNote = computed(() => selectedMonthlyFacetData.value
  ? `${selectedMonthlyFacetData.value.totals?.recordCount ?? 0} 条月度事实，${selectedMonthlyFacetData.value.totals?.observedMonthCount ?? 0}/${selectedMonthlyFacetData.value.totals?.rangeMonthCount ?? 0} 个月有记录`
  : '普通能耗导入只填充月度分析；请选择已有分面');
const monthlyEmptyDescription = computed(() => {
  const filters = analysisDisplayFilters.value;
  return `暂无月度分面。已应用月份 ${filters.startMonth || '未选择'} 至 ${filters.endMonth || '未选择'}；组织 ${filters.organizationUnitId || '全部'}；能源类型 ${filters.energyTypeCode || '全部'}；单位 ${filters.unit || '全部'}。普通能耗导入会进入此区域；组织弱关联未命中、月份不相交或原始单位标准化后与精确单位筛选不一致时可能为空。`;
});
const intensityFacets = computed(() => intensityAnalysis.value.facets || []);
const touPeriods = computed(() => touAnalysis.value.periods || []);
const touMax = computed(() => Math.max(...touPeriods.value.map((row) => Number(row.observed) || 0), 1));
const shiftRows = computed(() => shiftAnalysis.value.shifts || []);
const deviceStateRows = computed(() => deviceStateAnalysis.value.states || []);
const intensityHeadlineFacet = computed(() => intensityFacets.value.find((facet) => facet.aggregate?.calculable) || intensityFacets.value[0] || null);
const intensityHeadline = computed(() => formatAnalysisValue(intensityHeadlineFacet.value?.aggregate?.intensityValue, { unit: intensityHeadlineFacet.value?.aggregate?.intensityUnit, calculable: intensityHeadlineFacet.value?.aggregate?.calculable }));
const intensityHeadlineNote = computed(() => intensityHeadlineFacet.value ? reasonCodesText(intensityHeadlineFacet.value.reasonCodes) : '请选择产能单元并查询');
const strategyEvaluations = computed(() => strategyResult.value?.kind === 'evaluate' ? strategyResult.value.resultSnapshot?.evaluations || [] : []);
const strategyHits = computed(() => strategyResult.value?.kind === 'run' ? strategyResult.value.resultSnapshot?.hits || [] : []);
const reviewValidation = computed(() => validateStrategyReview(reviewTarget.value?.manualStatus, reviewForm.manualStatus, reviewForm.reviewNote));
const configDrawerTitle = computed(() => `${configSource.value ? '创建新版本' : '创建首版本'} · ${{ shift: '排班定义', tou: 'TOU 方案', rule: '策略规则' }[configKind.value]}`);

/** 判断指定权限编码。 */
function hasPermissionCode(permission) { return hasPermi(permission); }
/** 从统一响应中读取业务数据。 */
function responseData(response) { return response?.data ?? {}; }
/** 返回组织主数据 ID。 */
function organizationId(item) { return item.id ?? item.organizationUnitId ?? item.unitId; }
/** 返回组织主数据标签。 */
function organizationLabel(item) { return item.unitPath || item.path || item.unitName || item.name || `组织 #${organizationId(item)}`; }
/** 返回表计主数据 ID。 */
function meterId(item) { return item.id ?? item.meterDeviceId; }
/** 返回表计主数据标签。 */
function meterLabel(item) { return `${item.meterName || item.name || item.meterCode || '表计'}${item.meterCode ? `（${item.meterCode}）` : ''}`; }
/** 返回产能单元主数据 ID。 */
function productionUnitId(item) { return item.id ?? item.productionUnitId; }
/** 返回产能单元主数据标签。 */
function productionUnitLabel(item) { return `${item.unitName || item.name || item.unitCode || '产能单元'}${item.outputUnit ? ` / ${item.outputUnit}` : ''}`; }
/** 返回月度分面稳定键。 */
function monthlyFacetKey(facet) { return `${facet.energyType?.code || facet.energyTypeCode}:${facet.unit}`; }
/** 判断快照是否具备单表计时序分析的完整输入。 */
function isTimeseriesReady(filters = {}) { return ['meterDeviceId', 'energyTypeCode', 'unit', 'startUtc', 'endUtc', 'sourceTimeZone'].every((key) => filters[key] !== '' && filters[key] !== null && filters[key] !== undefined); }
/** 将分钟数格式化为本地时刻。 */
function minuteLabel(value) { const minutes = Number(value) || 0; return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
/** 返回曲线点无障碍与悬浮文案。 */
function curvePointLabel(point) { return `${formatStrictUtcDateTimeDisplay(point.startUtc)} 至 ${formatStrictUtcDateTimeDisplay(point.endUtc)}：${formatAnalysisValue(point.energy, { unit: point.energyUnit })}；观测模式 ${point.observationMode}`; }
/** 返回策略阈值文案。 */
function thresholdLabel(threshold = {}) { return threshold.operator === 'between' ? `${threshold.minimum ?? threshold.min} - ${threshold.maximum ?? threshold.max} ${threshold.unit || ''}` : `${threshold.operator || ''} ${threshold.value ?? '缺失'} ${threshold.unit || ''}`; }
/** 返回冻结策略指标的中文标签。 */
function strategyMetricLabel(metricCode) { return metricCode === 'load_rate' ? '负载率 load_rate' : '高峰区间能耗 peak_interval_energy'; }
/** 返回冻结策略优先级的中文标签。 */
function strategyPriorityLabel(priority) { return { high: '高', medium: '中', low: '低' }[priority] || priority; }
/** 返回配置状态的中文标签。 */
function configurationStatusLabel(status) { return status === 'active' ? '启用' : '停用'; }

/** 安全执行单个请求并返回真假结果。 */
async function safeRequest(task) { try { return { ok: true, response: await task() }; } catch (error) { return { ok: false, error }; } }

/** 加载组织、表计、产能单元和能源类型主数据。 */
async function loadMasterData() {
  const results = await Promise.all([
    safeRequest(() => ledgerApi.units.list({ page: 1, pageSize: 500 })),
    safeRequest(() => ledgerApi.meters.list({ page: 1, pageSize: 500 })),
    safeRequest(() => ledgerApi.productionUnits.list({ page: 1, pageSize: 500 })),
    safeRequest(() => ledgerApi.energyTypes())
  ]);
  organizations.value = results[0].ok ? masterDataItems(results[0].response) : [];
  meters.value = results[1].ok ? masterDataItems(results[1].response) : [];
  productionUnits.value = results[2].ok ? masterDataItems(results[2].response) : [];
  energyTypes.value = results[3].ok ? masterDataItems(results[3].response) : [];
  const failures = results.filter((result) => !result.ok).map((result) => energyAnalysisErrorText(result.error, '主数据读取失败。', { suppressGlobalHandledStatus: true })).filter(Boolean);
  masterDataError.value = failures.length ? `部分主数据读取失败；组织、表计或产能单元筛选可能不完整。${[...new Set(failures)].join('；')}` : '';
}

/** 清理单一策略展示快照并使进行中的旧策略响应失效。 */
function clearStrategyResults(message = '') {
  const hadResults = Boolean(strategyResult.value);
  strategyRequestGate.invalidate();
  strategyLoading.value = false;
  strategyResult.value = null;
  reviewTarget.value = null;
  reviewDrawerOpen.value = false;
  strategyError.value = '';
  if (hadResults) strategyInputChangedNotice.value = message;
  else if (!message) strategyInputChangedNotice.value = '';
}

/** 应用草稿筛选快照并仅在按钮触发时请求分析。 */
function applyFilters() {
  appliedFilters.value = createEnergyAnalysisSnapshot(draftFilters.value);
  selectedMonthlyFacet.value = 0;
  clearStrategyResults('筛选输入已变化，旧策略结果已清空，请基于新筛选重新运行。');
  loadAnalysis();
}
/** 重置草稿和已应用筛选快照并在按钮触发时重新请求。 */
function resetFilters() {
  const defaults = createDefaultEnergyAnalysisFilters();
  draftFilters.value = { ...defaults };
  appliedFilters.value = createEnergyAnalysisSnapshot(defaults);
  selectedMonthlyFacet.value = 0;
  clearStrategyResults('筛选输入已重置，旧策略结果已清空。');
  loadAnalysis();
}
/** 按冻结输入快照并行加载消费分析，只允许最新请求原子提交全部切片。 */
async function loadAnalysis() {
  const run = analysisRequestGate.start(appliedFilters.value);
  const filters = run.inputSnapshot;
  const nextResult = createEmptyEnergyAnalysisResult();
  const requests = [];
  analysisResultState.value = startEnergyAnalysisResultTransition(analysisDisplaySnapshot.value, run);
  const addRequest = (key, label, task) => requests.push(safeRequest(task).then((result) => ({ key, label, ...result })));
  analysisLoading.value = true;
  analysisError.value = '';
  addRequest('monthlyAnalysis', '月度消费分析', () => getMonthlyConsumptionAnalysis(buildMonthlyAnalysisParams(filters)));
  if (filters.productionUnitId) addRequest('intensityAnalysis', '消费强度', () => getEnergyIntensityAnalysis(buildIntensityParams(filters)));
  if (isTimeseriesReady(filters)) {
    const loadCurveGridValidation = validateEnergyAnalysisLoadCurveGrid(filters);
    addRequest('loadSummary', '负荷摘要', () => getEnergyLoadSummary(buildLoadSummaryParams(filters)));
    if (loadCurveGridValidation.valid) addRequest('loadCurve', '负荷曲线', () => getEnergyLoadCurve(buildLoadCurveParams(filters)));
    else requests.push(Promise.resolve({ key: 'loadCurve', label: '负荷曲线', ok: false, validationMessage: loadCurveGridValidation.message }));
    addRequest('shiftAnalysis', '班次分析', () => getShiftConsumptionAnalysis(buildTimeseriesAnalysisParams(filters)));
    addRequest('deviceStateAnalysis', '设备状态', () => getDeviceStateConsumptionAnalysis(buildTimeseriesAnalysisParams(filters)));
    if (filters.touSchemeId) addRequest('touAnalysis', '峰平谷分析', () => getTimeOfUseAnalysis(buildTouParams(filters)));
  }
  if (filters.organizationUnitId && filters.energyTypeCode && filters.unit && filters.startUtc && filters.endUtc) {
    addRequest('peakContribution', '高峰贡献', () => getPeakContributionAnalysis(buildPeakContributionParams(filters)));
  }
  const settled = await Promise.all(requests);
  if (!analysisRequestGate.isLatest(run)) return;
  const failures = [];
  settled.forEach((result) => {
    if (result.ok) nextResult[result.key] = createEnergyAnalysisSnapshot(responseData(result.response));
    else {
      const message = result.validationMessage || energyAnalysisErrorText(result.error, '接口请求失败。', { suppressGlobalHandledStatus: true });
      if (message) failures.push(result.validationMessage ? message : `${result.label}：${message}`);
    }
  });
  analysisResultState.value = completeEnergyAnalysisResultTransition(analysisResultState.value, run, nextResult);
  curveTooltip.value = null;
  analysisError.value = failures.join('；');
  analysisLoading.value = false;
}

/** 校验策略评价必须具备已应用快照中的单表计时序筛选。 */
function ensureStrategyReady(filters = appliedFilters.value) {
  if (isTimeseriesReady(filters)) return true;
  strategyError.value = '请先选择表计、能源类型、单位、来源时区和完整时序范围并点击查询。';
  return false;
}

/** 运行单次策略请求并仅提交最新请求对应的冻结结果快照。 */
async function executeStrategyRequest(kind) {
  const requestInput = {
    filters: appliedFilters.value,
    ruleCodes: selectedRuleCodes.value
  };
  const run = strategyRequestGate.start(requestInput);
  const params = buildStrategyParams(run.inputSnapshot.filters, run.inputSnapshot.ruleCodes);
  strategyResult.value = null;
  reviewTarget.value = null;
  reviewDrawerOpen.value = false;
  strategyInputChangedNotice.value = '';
  if (!ensureStrategyReady(run.inputSnapshot.filters)) {
    strategyLoading.value = false;
    return;
  }
  strategyLoading.value = true;
  strategyError.value = '';
  const result = await safeRequest(() => kind === 'evaluate' ? evaluateEnergyStrategies(params) : runEnergyStrategies(params));
  if (!strategyRequestGate.isLatest(run)) return;
  strategyLoading.value = false;
  if (!result.ok) {
    strategyError.value = energyAnalysisErrorText(result.error, '策略请求失败。', { suppressGlobalHandledStatus: true });
    return;
  }
  const resultSnapshot = createEnergyAnalysisSnapshot(responseData(result.response));
  strategyResult.value = commitEnergyAnalysisStrategyResult(strategyResult.value, run, kind, resultSnapshot);
  if (kind === 'evaluate') {
    ElMessage.success(`预演完成，共返回 ${resultSnapshot.evaluations?.length || 0} 条规则评价。`);
  } else {
    ElMessage.success(`正式运行完成，共生成 ${resultSnapshot.hits?.length || 0} 条命中。`);
  }
}

/** 运行只读本地规则预演。 */
function evaluateStrategies() { return executeStrategyRequest('evaluate'); }
/** 正式运行本地规则并保存本次命中。 */
function runStrategies() { return executeStrategyRequest('run'); }
/** 打开当前正式运行结果快照中的单条策略命中。 */
function openReview(hit) {
  const snapshotHit = strategyHits.value.find((item) => item.id === hit.id);
  if (!snapshotHit) return;
  reviewTarget.value = snapshotHit;
  reviewForm.manualStatus = allowedStrategyStatuses(snapshotHit.manualStatus)[0] || '';
  reviewForm.reviewNote = '';
  reviewDrawerOpen.value = true;
}
/** 提交策略人工状态并以新冻结快照替换当前命中。 */
async function submitReview() {
  if (!reviewValidation.value.valid || !reviewTarget.value || strategyResult.value?.kind !== 'run') return;
  const targetId = reviewTarget.value.id;
  const sourceRun = strategyResult.value;
  reviewLoading.value = true;
  const result = await safeRequest(() => reviewEnergyStrategyHit(targetId, { manualStatus: reviewForm.manualStatus, reviewNote: reviewForm.reviewNote.trim() || undefined }));
  reviewLoading.value = false;
  if (!result.ok) {
    strategyError.value = energyAnalysisErrorText(result.error, '人工复核失败。', { suppressGlobalHandledStatus: true });
    return;
  }
  if (strategyResult.value !== sourceRun) return;
  strategyResult.value = replaceEnergyAnalysisStrategyHit(sourceRun, responseData(result.response));
  reviewDrawerOpen.value = false;
  ElMessage.success('人工复核状态已更新。');
}

/** 加载三类版本化配置列表。 */
async function loadConfigurations() { if (!canViewConfig.value) return; configLoading.value = true; configError.value = ''; const results = await Promise.all([safeRequest(() => listShiftDefinitions()), safeRequest(() => listTouSchemes()), safeRequest(() => listStrategyRules())]); configLoading.value = false; shiftDefinitions.value = results[0].ok ? responseItems(results[0].response) : []; touSchemes.value = results[1].ok ? responseItems(results[1].response) : []; strategyRules.value = results[2].ok ? responseItems(results[2].response) : []; const failures = results.filter((result) => !result.ok).map((result) => energyAnalysisErrorText(result.error, '请求失败。', { suppressGlobalHandledStatus: true })).filter(Boolean); configError.value = failures.join('；'); }
/** 配置导入成功后只刷新对应配置列表，避免无关列表失败掩盖本次写入结果。 */
async function refreshImportedConfiguration(refreshTarget) {
  const refreshContract = {
    'shift-config': { request: listShiftDefinitions, target: shiftDefinitions },
    'tou-config': { request: listTouSchemes, target: touSchemes },
    'strategy-config': { request: listStrategyRules, target: strategyRules }
  }[refreshTarget];
  if (!refreshContract || !canViewConfig.value) return;
  const result = await safeRequest(() => refreshContract.request());
  if (result.ok) refreshContract.target.value = responseItems(result.response);
  else configError.value = energyAnalysisErrorText(result.error, '配置列表刷新失败。', { suppressGlobalHandledStatus: true });
}
/** 按导入定义刷新受影响的分析或配置列表。 */
async function refreshAfterImport(definition) {
  if (definition.refreshTarget === 'shift-analysis') await Promise.all([loadConfigurations(), loadAnalysis()]);
  else if (definition.refreshTarget.endsWith('-config')) await refreshImportedConfiguration(definition.refreshTarget);
  else await loadAnalysis();
}
/** 打开首版本或新版本配置抽屉；新版本只复制已有事实并保持默认停用。 */
function openConfig(kind, source = null) {
  configKind.value = kind;
  configSource.value = source;
  configFormError.value = '';
  configFormHydrationBlocked.value = false;
  Object.keys(configForm).forEach((key) => delete configForm[key]);
  try {
    Object.assign(configForm, createEnergyAnalysisConfigForm(kind, source));
  } catch (error) {
    configFormHydrationBlocked.value = true;
    configFormError.value = `配置回显失败：${error.message}`;
  }
  configDrawerOpen.value = true;
}
/** 构造严格配置请求正文，未确认完整的业务字段不得进入载荷。 */
function buildConfigPayload() { return buildEnergyAnalysisConfigPayload(configKind.value, configForm, Boolean(configSource.value)); }
/** 保存首版本或新版本配置。 */
async function saveConfig() { if (configFormHydrationBlocked.value) { configFormError.value ||= '配置回显失败，当前数据不能保存。'; return; } configSaving.value = true; configFormError.value = ''; let payload; try { payload = buildConfigPayload(); } catch (error) { configSaving.value = false; configFormError.value = `配置未通过校验：${error.message}`; return; } const task = configKind.value === 'shift' ? (configSource.value ? () => createShiftDefinitionVersion(configSource.value.id, payload) : () => createShiftDefinition(payload)) : configKind.value === 'tou' ? (configSource.value ? () => createTouSchemeVersion(configSource.value.id, payload) : () => createTouScheme(payload)) : (configSource.value ? () => createStrategyRuleVersion(configSource.value.id, payload) : () => createStrategyRule(payload)); const result = await safeRequest(task); configSaving.value = false; if (!result.ok) { configFormError.value = energyAnalysisErrorText(result.error, '请求失败。', { suppressGlobalHandledStatus: true }); return; } configDrawerOpen.value = false; ElMessage.success('配置版本已保存。'); await loadConfigurations(); }
/** 启用或停用单个配置版本。 */
async function toggleConfigStatus(kind, row) { const target = row.status === 'active' ? 'inactive' : 'active'; try { await ElMessageBox.confirm(`确认${target === 'active' ? '启用' : '停用'}该版本？后端会保留历史记录。`, '配置状态确认', { type: 'warning' }); } catch { return; } const task = kind === 'shift' ? () => setShiftDefinitionStatus(row.id, target) : kind === 'tou' ? () => setTouSchemeStatus(row.id, target) : () => setStrategyRuleStatus(row.id, target); const result = await safeRequest(task); if (!result.ok) { configError.value = energyAnalysisErrorText(result.error, '请求失败。', { suppressGlobalHandledStatus: true }); return; } ElMessage.success('配置状态已更新。'); await loadConfigurations(); }

/** 下载当前导入类型的 XLSX 空白模板。 */
async function downloadImportTemplate(definition) {
  const result = await safeRequest(() => downloadEnergyAnalysisImportTemplate(definition.templateType, 'xlsx'));
  if (!result.ok) importStates[definition.key].error = energyAnalysisErrorText(result.error, '空白模板下载失败。', { suppressGlobalHandledStatus: true });
}
/** 选择导入文件并清理旧预演见证。 */
function selectImportFile(key, uploadFile) { const state = importStates[key]; state.file = uploadFile.raw; state.files = [uploadFile]; state.preview = null; state.error = ''; }
/** 清空单类导入文件和预演。 */
function clearImport(key) { Object.assign(importStates[key], { file: null, files: [], preview: null, error: '' }); }
/** 调用服务端生成签名、候选和固定确认文本；预演不刷新分析且不写业务事实。 */
async function previewImport(definition) { const state = importStates[definition.key]; if (!state.file) return; state.loading = true; state.error = ''; const result = await safeRequest(() => previewEnergyAnalysisImport(definition.key, state.file)); state.loading = false; if (!result.ok) { state.preview = null; state.error = energyAnalysisErrorText(result.error, '请求失败。', { suppressGlobalHandledStatus: true }); return; } state.preview = responseData(result.response); const summary = state.preview.summary || {}; ElMessage.success(`${definition.label}预演完成，未写业务事实：可导入 ${summary.wouldImport ?? state.preview.expectedWouldImport ?? 0}，跳过 ${summary.skipped ?? summary.wouldSkip ?? 0}，阻断 ${summary.blocked ?? summary.wouldBlock ?? 0}，错误 ${summary.errors ?? 0}。`); }
/** 打开导入 execute 固定确认抽屉。 */
function openImportExecute(definition) { const preview = importStates[definition.key].preview; if (!canExecuteEnergyAnalysisImport(preview)) return; activeImportDefinition.value = definition; activeImportPreview.value = preview; importConfirmText.value = ''; importDrawerOpen.value = true; }
/** 提交完整服务端见证，并按真实写入、跳过、阻断和错误数量分类反馈与刷新。 */
async function executeImport() {
  if (!activeImportDefinition.value || importConfirmText.value !== activeImportPreview.value?.confirmText) return;
  importExecuteLoading.value = true;
  const definition = activeImportDefinition.value;
  const state = importStates[definition.key];
  state.error = '';
  const result = await safeRequest(() => executeEnergyAnalysisImport(definition.key, buildImportExecutePayload(activeImportPreview.value)));
  importExecuteLoading.value = false;
  if (!result.ok) {
    state.error = energyAnalysisErrorText(result.error, '导入执行失败。', { suppressGlobalHandledStatus: true });
    return;
  }
  const executeSummary = summarizeEnergyAnalysisImportExecuteResult(responseData(result.response));
  const { imported, skipped, blocked, errors, warnings } = executeSummary;
  if (executeSummary.status === 'zero') {
    state.error = `${definition.label}执行完成但未写入${definition.resultNoun}：写入 ${imported}，跳过 ${skipped}，阻断 ${blocked}，错误 ${errors}。请保留当前文件和预演上下文并检查原因。`;
    ElMessage.warning(state.error);
    return;
  }
  importDrawerOpen.value = false;
  if (executeSummary.status === 'partial') {
    ElMessage.warning(`${definition.label}部分写入：写入 ${imported}，跳过 ${skipped}，阻断 ${blocked}，错误 ${errors}，警告 ${warnings}。页面只刷新本类导入影响的数据。`);
  } else {
    ElMessage.success(`${definition.label}完整写入 ${imported} 条${definition.resultNoun}。页面只刷新本类导入影响的数据。`);
  }
  clearImport(definition.key);
  await refreshAfterImport(definition);
}

// 筛选草稿或规则选择变化时，旧策略快照立即失效，避免后续操作沿用旧上下文。
watch(draftFilters, () => clearStrategyResults('筛选输入已变化，旧策略结果已清空，请应用筛选后重新运行。'), { deep: true });
watch(selectedRuleCodes, () => clearStrategyResults('规则选择已变化，旧策略结果已清空，请重新运行。'), { deep: true });

onMounted(async () => { if (!canView.value) return; await Promise.all([loadMasterData(), loadConfigurations(), loadAnalysis()]); });
</script>

<style scoped>
.analysis-tabs{min-width:0}.tab-stack,.analysis-results{display:grid;gap:16px;min-width:0}.applied-note{align-self:center;color:#7385a2;font-size:12px}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.two-column-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.three-column-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.chart-panel,.compact-panel{min-width:0}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.panel-heading h2{margin:0;color:#123b79;font-size:16px}.panel-heading span{color:#7385a2;font-size:12px}.quality-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.wide-scroll{max-width:100%;overflow-x:auto}.line-chart{width:100%;min-width:680px;min-height:260px;background:#fcfcfb;border:1px solid #dce9fb;border-radius:10px}.grid-line{stroke:#e1e7ef;stroke-width:1}.curve-line{fill:none;stroke:#1769e0;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.point-hit{fill:transparent}.point-dot{fill:#1769e0;stroke:#fcfcfb;stroke-width:2}g:hover .point-dot{r:6}.axis-text{fill:#728199;font-size:10px}.chart-tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px}.legend{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;color:#516170;font-size:12px}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:12px;height:12px;border:1px solid #fff;border-radius:3px;box-shadow:0 0 0 1px #c8d5e7}.metric-bar{display:grid;grid-template-columns:34px minmax(100px,1fr) minmax(92px,auto);align-items:center;gap:10px;width:100%;padding:7px 0;color:#183153;background:transparent;border:0;text-align:left}.metric-track{height:14px;background:#e7f1ff;border-radius:999px;overflow:hidden}.metric-track i{display:block;height:100%;border-radius:999px}.metric-bar strong{font-size:12px}.boundary-note{margin-bottom:10px;padding:9px;color:#516170;background:#f6f9fd;border-left:3px solid #1769e0;font-size:12px;line-height:1.6}.quality-line{color:#516170;font-size:12px}.peak-summary{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px;padding:12px;background:#f6f9fd;border-radius:8px}.subheading{margin:18px 0 8px;color:#183153;font-size:14px}.panel-alert{margin:12px 0}.config-actions{display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px}.import-downloads{flex-wrap:wrap}.import-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.import-card{display:grid;align-content:start;gap:12px;min-width:0}.preview-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}.preview-facts div{padding:8px;background:#f6f9fd;border-radius:8px}.preview-facts dt{color:#7385a2;font-size:12px}.preview-facts dd{margin:4px 0 0;color:#183153;font-weight:600;overflow-wrap:anywhere}.drawer-form{padding-right:4px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field-help{margin-top:6px;color:#7385a2;font-size:12px;line-height:1.5}@media (max-width:1200px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.three-column-grid,.import-grid{grid-template-columns:1fr}}@media (max-width:900px){.two-column-grid{grid-template-columns:1fr}}@media (max-width:680px){.stat-grid,.form-grid{grid-template-columns:1fr}.panel-heading{align-items:stretch;flex-direction:column}.peak-summary{flex-direction:column}.import-grid{grid-template-columns:minmax(0,1fr)}}
</style>
