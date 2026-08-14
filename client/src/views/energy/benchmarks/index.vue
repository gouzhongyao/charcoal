<template>
  <ManagementPage title="能效对标">
    <template #title-extra>
      <HelpIcon label="查看能效对标口径" content="本页面只使用企业自定义、页面维护或本地模板导入的标准与标杆，不内置、不抓取也不虚构行业同行数据。排名和合格率仅使用调用方显式提交且通过指标、单位、周期、范围、层级和有效期校验的对象。" />
    </template>

    <PageState v-if="!canView" description="当前账号没有查看能效对标的权限。请联系管理员授予 energy:benchmarks:view 权限。" />
    <template v-else>
      <el-alert type="info" :closable="false" show-icon title="数据边界：只使用企业自定义或导入标准，不内置、不虚构行业同行数据。" />
      <el-alert v-if="maintenance.active" type="warning" :closable="false" show-icon :title="`系统处于维护态${maintenance.reason ? `（${maintenance.reason}）` : ''}：定义、目标和导入写操作已禁用；只读查询与分析仍可使用。`" />
      <el-alert v-if="pageError" type="error" :closable="false" show-icon :title="pageError" />

      <el-tabs v-model="activeTab" class="benchmark-tabs">
        <el-tab-pane label="对标分析" name="analysis">
          <PageState v-if="!canAnalyze" :description="hasExportPermission ? '当前账号仅有 energy:benchmarks:export；导出还需要 energy:benchmarks:analyze，当前无法形成可导出的成功分析快照。' : '对标分析需要 energy:benchmarks:analyze；导出需要同时具备 energy:benchmarks:analyze 和 energy:benchmarks:export。'" />
          <template v-else>
            <el-alert v-if="!hasExportPermission" type="info" :closable="false" show-icon title="当前账号可以分析；导出最近分析 CSV 还需要 energy:benchmarks:export 权限。" />
            <article class="page-card analysis-config-card">
              <header class="section-heading">
                <div><h2>显式对象分析</h2><p>对象由当前用户明确填写；系统不会自动构造或补齐同行企业样本。</p></div>
                <div class="action-row">
                  <el-button :disabled="actualRows.length >= 100 || !analysisDefinition" @click="addActualRow">新增对象</el-button>
                  <el-button v-if="canAnalyze" :loading="evaluationLoading" :disabled="!analysisReady" @click="evaluateFirstActual">评价首个对象</el-button>
                  <el-button v-if="canAnalyze" type="primary" :loading="analysisLoading" :disabled="!analysisReady" @click="runGroupAnalysis">计算排名与合格率</el-button>
                  <el-button v-if="canExport" :loading="exportLoading" :disabled="!canExportLatestAnalysis" @click="exportAnalysisCsv">导出最近分析 CSV</el-button>
                </div>
              </header>
              <el-form inline class="analysis-selector">
                <el-form-item label="对标定义">
                  <el-select v-model="analysisDefinitionId" filterable placeholder="选择启用定义" :loading="analysisDefinitionsLoading" @change="changeAnalysisDefinition">
                    <el-option v-for="item in activeDefinitions" :key="item.id" :label="`${item.benchmarkName} · ${item.version}`" :value="item.id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="目标版本">
                  <el-select v-model="analysisTargetId" filterable placeholder="选择启用目标" :loading="analysisTargetsLoading" @change="changeAnalysisTarget">
                    <el-option v-for="item in activeAnalysisTargets" :key="item.id" :label="`${item.version} · ${targetValueLabel(item, analysisDefinition)}`" :value="item.id" />
                  </el-select>
                </el-form-item>
              </el-form>
              <el-alert v-if="analysisDefinition" type="info" :closable="false" show-icon :title="`${ENERGY_BENCHMARK_DIRECTION_LABELS[analysisDefinition.direction]}；指标 ${analysisDefinition.metricCode}；单位 ${analysisDefinition.unit}；周期 ${analysisDefinition.periodType}；范围 ${ENERGY_BENCHMARK_SCOPE_LABELS[analysisDefinition.scopeType] || analysisDefinition.scopeType} / ${analysisDefinition.scopeReference}`" />
              <el-alert v-if="analysisStaleNotice" type="warning" :closable="false" show-icon :title="analysisStaleNotice" />
              <el-alert v-if="analysisDefinition?.scopeType === 'organization' && organizationObjectsError" type="error" :closable="false" show-icon :title="organizationObjectsError" />
              <el-alert v-if="analysisDefinition && !analysisReady && analysisValidation.errors.length" type="warning" :closable="false" show-icon :title="analysisValidation.errors[0]" />
              <PageState v-if="!analysisDefinition" description="请先选择一条启用的对标定义。分析选择器使用独立加载的全部 active 定义，不受管理列表筛选和分页影响。" />
              <template v-else>
                <el-table :data="actualRows" stripe class="actual-table">
                  <el-table-column prop="objectId" label="实际对象" min-width="190"><template #default="{ row }"><el-select v-if="analysisDefinition.scopeType === 'organization'" v-model="row.objectId" filterable clearable :loading="organizationObjectsLoading" placeholder="选择同层级 active 组织" @change="selectOrganizationActual(row, $event)"><el-option v-for="item in compatibleOrganizationObjects" :key="item.id" :label="`${item.unitPath || item.unitName}（${item.unitCode}）`" :value="item.unitCode" /></el-select><el-input v-else v-model.trim="row.objectId" placeholder="必填且唯一" /></template></el-table-column>
                  <el-table-column prop="objectName" label="对象名称" min-width="150"><template #default="{ row }"><el-input v-model.trim="row.objectName" :disabled="analysisDefinition.scopeType === 'organization'" :placeholder="analysisDefinition.scopeType === 'organization' ? '由组织主数据带出' : '对象名称'" /></template></el-table-column>
                  <el-table-column prop="objectLevel" label="对象层级" min-width="120"><template #default="{ row }"><el-input :model-value="ENERGY_BENCHMARK_ORGANIZATION_LEVEL_LABELS[row.objectLevel] || row.objectLevel || '待解析'" disabled /></template></el-table-column>
                  <el-table-column prop="actualValue" label="实际值" min-width="130"><template #default="{ row }"><el-input-number v-model="row.actualValue" :controls="false" class="full-control" /></template></el-table-column>
                  <el-table-column label="上下文" min-width="250"><template #default="{ row }"><span class="context-summary">{{ row.metricCode }} · {{ row.unit }} · {{ row.periodType }}<br>{{ row.periodStartUtc || '未填开始时间' }} → {{ row.periodEndUtc || '未填结束时间' }}</span></template></el-table-column>
                  <el-table-column label="操作" width="150" fixed="right"><template #default="{ row, $index }"><el-button link type="primary" @click="openActualContext(row, $index)">编辑上下文</el-button><el-button link type="danger" :disabled="actualRows.length <= 1" @click="removeActualRow($index)">移除</el-button></template></el-table-column>
                </el-table>
              </template>
            </article>

            <section v-if="singleEvaluation" class="stat-grid" aria-label="单对象评价结果">
              <StatCard label="实际值" :value="`${formatEnergyBenchmarkNumber(singleEvaluation.actualValue)} ${analysisDefinition?.unit || ''}`" note="调用方显式提交的实际值" />
              <StatCard label="目标 / 边界" :value="formatEnergyBenchmarkBoundary(singleEvaluation, analysisDefinition?.unit)" :note="ENERGY_BENCHMARK_DIRECTION_LABELS[singleEvaluation.direction]" />
              <StatCard label="差额" :value="formatEnergyBenchmarkNumber(singleEvaluation.absoluteDifference)" note="实际值减当前目标或最近边界" />
              <StatCard label="差距比例" :value="formatEnergyBenchmarkRatio(singleEvaluation.differenceRatio)" :note="singleEvaluation.differenceRatio === null ? '目标或最近边界为零时不计算比例' : '比例仅用于同口径展示'" />
            </section>
            <el-alert v-if="singleEvaluation" :type="energyBenchmarkStatusPresentation(singleEvaluation).type" :closable="false" show-icon :title="`${energyBenchmarkStatusPresentation(singleEvaluation).icon} ${energyBenchmarkStatusPresentation(singleEvaluation).label}；原因：${formatEnergyBenchmarkReasons(singleEvaluation.reasonCodes)}`" />

            <section v-if="rankingResult || qualificationResult" class="stat-grid" aria-label="排名与合格率指标">
              <StatCard label="输入对象" :value="formatInteger(rankingResult?.summary?.inputCount)" note="显式提交对象总数" />
              <StatCard label="兼容排名对象" :value="formatInteger(rankingResult?.summary?.rankedCount)" note="仅这些对象进入排名与合格率分母" />
              <StatCard label="排除对象" :value="formatInteger(rankingResult?.summary?.excludedCount)" note="排除原因在下方单独列示" />
              <StatCard label="合格率" :value="formatEnergyBenchmarkQualificationRate(qualificationResult?.qualificationRate, qualificationResult?.denominator)" :note="qualificationResult?.denominator ? `达标 ${qualificationResult.qualifiedCount} / 兼容 ${qualificationResult.denominator}` : '无兼容分母，不显示 0%'" />
            </section>

            <article v-if="rankingResult" class="page-card chart-panel viz-root">
              <header class="section-heading"><div><h2>兼容对象排名</h2><p>使用单一实际值轴；实体颜色由对象标识固定映射，不随名次改变。</p></div></header>
              <PageState v-if="!rankingRows.length" description="没有兼容对象，排名不可计算。请在排除对象表中核对原因。" />
              <template v-else>
                <div class="ranking-legend" aria-label="排名实体图例"><span v-for="row in chartRankingRows" :key="`legend-${row.objectId}-${row.rank}`"><i :style="{ backgroundColor: row.entityColor }" />{{ row.objectName || row.objectId || '未命名对象' }}</span></div>
                <el-alert v-if="tableOnlyRankingCount" type="info" :closable="false" show-icon :title="`图形最多展示 ${ENERGY_BENCHMARK_CHART_MAX_ENTITIES} 个明确对象；其余 ${tableOnlyRankingCount} 个对象仅在下方完整表格展示，绝不循环复用分类色。`" />
                <div class="ranking-chart" @mouseleave="rankingTooltip = null">
                  <button v-for="row in chartRankingRows" :key="`${row.objectId}-${row.rank}`" type="button" class="ranking-row" :aria-label="rankingAriaLabel(row)" @mouseenter="rankingTooltip = row" @focus="rankingTooltip = row">
                    <span class="rank-number">第 {{ row.rank }} 名</span>
                    <span class="rank-name"><i :style="{ backgroundColor: row.entityColor }" />{{ row.objectName || row.objectId || '未命名对象' }}</span>
                    <span class="rank-track"><i :style="{ width: `${row.barPercentage}%`, backgroundColor: row.entityColor }" /></span>
                    <span class="rank-value">{{ formatEnergyBenchmarkNumber(row.actualValue) }} {{ analysisDefinition?.unit }}</span>
                    <el-tag :type="energyBenchmarkStatusPresentation(row).type" effect="light">{{ energyBenchmarkStatusPresentation(row).icon }} {{ energyBenchmarkStatusPresentation(row).label }}</el-tag>
                  </button>
                </div>
                <p v-if="rankingTooltip" class="chart-tooltip" role="status">{{ rankingAriaLabel(rankingTooltip) }}</p>
                <el-table :data="rankingRows" size="small" class="equivalent-table">
                  <el-table-column prop="rank" label="排名" width="80" />
                  <el-table-column prop="objectId" label="对象标识" min-width="120" />
                  <el-table-column prop="objectName" label="对象名称" min-width="130" />
                  <el-table-column label="实际值" min-width="110"><template #default="{ row }">{{ formatEnergyBenchmarkNumber(row.actualValue) }} {{ analysisDefinition?.unit }}</template></el-table-column>
                  <el-table-column label="目标 / 边界" min-width="145"><template #default="{ row }">{{ formatEnergyBenchmarkBoundary(row, analysisDefinition?.unit) }}</template></el-table-column>
                  <el-table-column label="差额" min-width="100"><template #default="{ row }">{{ formatEnergyBenchmarkNumber(row.absoluteDifference) }}</template></el-table-column>
                  <el-table-column label="差距比例" min-width="105"><template #default="{ row }">{{ formatEnergyBenchmarkRatio(row.differenceRatio) }}</template></el-table-column>
                  <el-table-column label="状态" width="105"><template #default="{ row }"><el-tag :type="energyBenchmarkStatusPresentation(row).type" effect="light">{{ energyBenchmarkStatusPresentation(row).icon }} {{ energyBenchmarkStatusPresentation(row).label }}</el-tag></template></el-table-column>
                </el-table>
              </template>
            </article>

            <article v-if="rankingResult" class="page-card">
              <header class="section-heading"><div><h2>排除对象与原因</h2><p>排除对象不进入排名和合格率分母；原因码保留以便修正数据。</p></div></header>
              <PageState v-if="!excludedRows.length" description="没有排除对象，所有输入均通过兼容性校验。" />
              <el-table v-else :data="excludedRows" stripe>
                <el-table-column prop="objectId" label="对象标识" min-width="120" />
                <el-table-column prop="objectName" label="对象名称" min-width="130" />
                <el-table-column label="实际值" min-width="100"><template #default="{ row }">{{ formatEnergyBenchmarkNumber(row.actualValue) }}</template></el-table-column>
                <el-table-column label="状态" width="110"><template #default><el-tag type="info" effect="light">! 不兼容</el-tag></template></el-table-column>
                <el-table-column label="排除原因" min-width="320"><template #default="{ row }">{{ formatEnergyBenchmarkReasons(row.reasonCodes) }}</template></el-table-column>
              </el-table>
            </article>
          </template>
        </el-tab-pane>

        <el-tab-pane label="定义与目标" name="management">
          <ManagementToolbar :loading="definitionsLoading" @search="applyDefinitionFilters" @reset="resetDefinitionFilters">
            <el-form-item label="状态"><el-select v-model="definitionDraftFilters.status" clearable placeholder="全部状态"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
            <el-form-item label="类型"><el-select v-model="definitionDraftFilters.benchmarkType" clearable placeholder="全部类型"><el-option v-for="(label, value) in ENERGY_BENCHMARK_TYPE_LABELS" :key="value" :label="label" :value="value" /></el-select></el-form-item>
            <el-form-item label="对标编码"><el-input v-model.trim="definitionDraftFilters.benchmarkCode" clearable /></el-form-item>
            <el-form-item label="指标编码"><el-input v-model.trim="definitionDraftFilters.metricCode" clearable /></el-form-item>
            <template #actions>
              <el-button v-if="canManage" :disabled="writeDisabled" @click="openInternalHistory">固化内部历史基准</el-button>
              <el-button v-if="canManage" type="primary" :disabled="writeDisabled" @click="openCreateDefinition">新增定义</el-button>
            </template>
          </ManagementToolbar>

          <section class="stat-grid" aria-label="定义与目标汇总">
            <StatCard label="定义总数" :value="formatInteger(definitionPagination.total)" note="当前服务端筛选结果" />
            <StatCard label="当前页启用定义" :value="formatInteger(definitions.filter((item) => item.status === 'active').length)" note="启停用于版本选择，不物理删除" />
            <StatCard label="当前页内部基准" :value="formatInteger(definitions.filter((item) => item.benchmarkType === 'internal_history_baseline').length)" note="创建时固化，不自动刷新" />
            <StatCard label="目标版本" :value="formatInteger(targetPagination.total)" note="目标修改会创建后继版本" />
          </section>

          <article class="page-card">
            <header class="section-heading"><div><h2>对标定义</h2><p>外部标准必须填写真实来源和文号；普通定义已有目标后，口径字段由服务端保护。</p></div></header>
            <PageState v-if="definitionsError" :error="definitionsError" @retry="loadDefinitions" />
            <PageState v-else-if="!definitions.length && !definitionsLoading" description="暂无对标定义。企业可手工维护或通过受控模板导入真实标准。" />
            <template v-else>
              <el-table :data="definitions" v-loading="definitionsLoading" stripe>
                <el-table-column prop="benchmarkCode" label="编码" min-width="130" />
                <el-table-column prop="benchmarkName" label="名称" min-width="160" show-overflow-tooltip />
                <el-table-column label="类型" min-width="130"><template #default="{ row }">{{ ENERGY_BENCHMARK_TYPE_LABELS[row.benchmarkType] || row.benchmarkType }}</template></el-table-column>
                <el-table-column label="指标 / 单位" min-width="150"><template #default="{ row }">{{ row.metricCode }} / {{ row.unit }}</template></el-table-column>
                <el-table-column label="方向" min-width="100"><template #default="{ row }">{{ ENERGY_BENCHMARK_DIRECTION_LABELS[row.direction] || row.direction }}</template></el-table-column>
                <el-table-column label="范围" min-width="150"><template #default="{ row }">{{ ENERGY_BENCHMARK_SCOPE_LABELS[row.scopeType] || row.scopeType }} / {{ row.scopeReference }}</template></el-table-column>
                <el-table-column prop="version" label="版本" min-width="130" />
                <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
                <el-table-column label="操作" min-width="280" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDefinitionDetail(row)">详情</el-button><el-button v-if="canManage && row.benchmarkType !== 'internal_history_baseline'" link type="primary" :disabled="writeDisabled" @click="openEditDefinition(row)">修改</el-button><el-button v-if="canManage && row.benchmarkType !== 'internal_history_baseline'" link :disabled="writeDisabled" @click="openDefinitionVersion(row)">新建版本</el-button><el-button v-if="canManage && row.benchmarkType !== 'internal_history_baseline'" link :disabled="writeDisabled || row.status !== 'active'" @click="openCreateTarget(row)">新增目标</el-button><el-button v-if="canManage" link :type="row.status === 'active' ? 'warning' : 'success'" :disabled="writeDisabled" @click="confirmDefinitionStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
              </el-table>
              <div class="pagination"><el-pagination v-model:current-page="definitionPage" v-model:page-size="definitionPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="definitionPagination.total || 0" @current-change="changeDefinitionPage" @size-change="changeDefinitionPageSize" /></div>
            </template>
          </article>

          <article class="page-card">
            <header class="section-heading"><div><h2>目标版本</h2><p>修改目标会创建后继版本并保留旧版本；固化内部历史目标不可修改，只能启停。</p></div><el-select v-model="targetDefinitionFilter" clearable filterable placeholder="按定义筛选" @change="applyTargetFilter"><el-option v-for="item in definitions" :key="item.id" :label="`${item.benchmarkName} · ${item.version}`" :value="item.id" /></el-select></header>
            <PageState v-if="targetsError" :error="targetsError" @retry="loadTargets" />
            <PageState v-else-if="!targets.length && !targetsLoading" description="当前筛选下暂无目标版本。" />
            <template v-else>
              <el-table :data="targets" v-loading="targetsLoading" stripe>
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column prop="benchmarkDefinitionId" label="定义 ID" width="90" />
                <el-table-column label="目标 / 边界" min-width="150"><template #default="{ row }">{{ targetValueLabel(row, definitionById(row.benchmarkDefinitionId)) }}</template></el-table-column>
                <el-table-column prop="version" label="版本" min-width="135" />
                <el-table-column label="固化" width="90"><template #default="{ row }"><el-tag :type="row.isFrozen ? 'warning' : 'info'" effect="light">{{ row.isFrozen ? '锁 固化' : '普通' }}</el-tag></template></el-table-column>
                <el-table-column label="参考期" min-width="240"><template #default="{ row }">{{ row.referenceStartUtc ? `${row.referenceStartUtc} → ${row.referenceEndUtc}` : '—' }}</template></el-table-column>
                <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
                <el-table-column label="操作" min-width="160" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openTargetDetail(row)">详情</el-button><el-button v-if="canManage && !row.isFrozen" link type="primary" :disabled="writeDisabled" @click="openVersionTarget(row)">新版本</el-button><el-button v-if="canManage" link :type="row.status === 'active' ? 'warning' : 'success'" :disabled="writeDisabled" @click="confirmTargetStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
              </el-table>
              <div class="pagination"><el-pagination v-model:current-page="targetPage" v-model:page-size="targetPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="targetPagination.total || 0" @current-change="changeTargetPage" @size-change="changeTargetPageSize" /></div>
            </template>
          </article>
        </el-tab-pane>

        <el-tab-pane label="受控导入" name="imports">
          <PageState v-if="!canImportPreview" :description="hasImportExecutePermission ? '当前账号仅有 energy:benchmarks:import:execute；执行必须先具备 energy:benchmarks:import:preview 并完成服务端预演。' : '受控导入至少需要 energy:benchmarks:import:preview；执行还需同时具备 energy:benchmarks:import:execute。'" />
          <article v-else class="page-card import-card">
            <header class="section-heading"><div><h2>折标系数、定义与目标导入</h2><p>预演是执行的前置能力；执行需要同时具备 preview 与 execute 权限。页面只提交服务端持久化批次、固定确认文本和确认标志。</p></div></header>
            <el-alert v-if="!hasImportExecutePermission" type="info" :closable="false" show-icon title="当前账号可以预演；进入执行确认还需要 energy:benchmarks:import:execute 权限。" />
            <el-alert type="warning" :closable="false" show-icon title="导入只接受真实企业文件。对标定义模板不允许导入内部历史基准；内部历史必须由服务端按明确参考期固化。" />
            <el-alert type="info" :closable="false" show-icon title="推荐顺序：先导入能源折标系数，再导入对标定义，最后导入对标目标。外部标准定义必须保留真实来源和文号；下载模板或示例不会自动导入、计算或执行对标。" />
            <el-form label-position="top" class="import-form">
              <el-form-item label="导入类型"><el-radio-group v-model="importType" :disabled="importPreviewLoading"><el-radio-button v-for="item in ENERGY_BENCHMARK_IMPORT_TYPES" :key="item.value" :label="item.value">{{ item.label }}</el-radio-button></el-radio-group></el-form-item>
              <el-form-item label="当前类型文件"><div class="action-row"><el-button :loading="importTemplateLoading" @click="downloadImportTemplate">下载{{ currentImportTypeLabel }}空白模板</el-button><el-button :loading="importDemoExampleLoading" @click="downloadImportDemoExample">下载{{ currentImportTypeLabel }}青岚园区示例</el-button></div></el-form-item>
              <el-form-item label="选择文件"><el-upload :auto-upload="false" :limit="1" accept=".xlsx,.csv" :disabled="!canImportPreview || writeDisabled" :on-change="selectImportFile" :on-remove="clearImportFile"><el-button :disabled="!canImportPreview || writeDisabled">选择 .xlsx 或 .csv</el-button><template #tip><div class="el-upload__tip">服务端会校验冻结中文模板、字段、重复、有效期和范围主数据。</div></template></el-upload></el-form-item>
              <el-button v-if="canImportPreview" type="primary" :loading="importPreviewLoading" :disabled="!importFile || writeDisabled" @click="previewImport">开始预演</el-button>
            </el-form>
            <el-alert v-if="importError" type="error" :closable="false" show-icon :title="importError" />
            <template v-if="importPreview">
              <div class="preview-summary"><span>候选 {{ formatInteger(importPreview.summary?.wouldImport) }}</span><span>跳过 {{ formatInteger(importPreview.summary?.skipped) }}</span><span>阻断 {{ formatInteger(importPreview.summary?.blocked) }}</span><span>warning {{ formatInteger(importPreview.summary?.warnings) }}</span><span>批次 #{{ importPreview.batchId }}</span></div>
              <el-table :data="importPreview.items || []" size="small" max-height="330">
                <el-table-column prop="rowNumber" label="行" width="70" />
                <el-table-column prop="status" label="预演结果" width="110" />
                <el-table-column label="问题" min-width="320"><template #default="{ row }">{{ previewIssueText(row.issues) }}</template></el-table-column>
              </el-table>
              <el-alert v-if="!canExecuteEnergyBenchmarkImport(importPreview)" type="info" :closable="false" show-icon title="当前预演没有完整且可执行的候选上下文，执行入口保持禁用。" />
              <el-button v-if="canImportExecute" class="execute-button" type="danger" :disabled="writeDisabled || !canExecuteEnergyBenchmarkImport(importPreview)" @click="openImportExecute">进入执行确认</el-button>
            </template>
          </article>
        </el-tab-pane>
      </el-tabs>

      <ManagementDrawer v-model="definitionDrawerOpen" :title="definitionDrawerTitle" :loading="definitionSaving" :confirm-disabled="writeDisabled || definitionScopeBlocked" @save="saveDefinition">
        <el-alert v-if="definitionFormError" type="error" :closable="false" show-icon :title="definitionFormError" class="drawer-alert" />
        <el-alert v-if="definitionScopeNotice" :type="definitionScopeError ? 'error' : 'warning'" :closable="false" show-icon :title="definitionScopeNotice" class="drawer-alert" />
        <el-alert v-if="definitionMode === 'version'" type="info" :closable="false" show-icon title="新定义版本使用创建接口。请填写新的 name:v1 版本标识并调整有效期；同编码 active 有效期不得重叠。" class="drawer-alert" />
        <el-form ref="definitionFormRef" :model="definitionForm" :rules="definitionRules" label-position="top">
          <el-form-item label="对标编码" prop="benchmarkCode"><el-input v-model.trim="definitionForm.benchmarkCode" maxlength="100" /></el-form-item>
          <el-form-item label="对标名称" prop="benchmarkName"><el-input v-model.trim="definitionForm.benchmarkName" maxlength="200" /></el-form-item>
          <el-form-item label="定义类型" prop="benchmarkType"><el-select v-model="definitionForm.benchmarkType" class="full-control"><el-option label="外部标准" value="external_standard" /><el-option label="人工标杆" value="manual_benchmark" /></el-select></el-form-item>
          <el-form-item label="指标编码" prop="metricCode"><el-input v-model.trim="definitionForm.metricCode" /></el-form-item>
          <el-form-item label="指标单位" prop="unit"><el-input v-model.trim="definitionForm.unit" /></el-form-item>
          <el-form-item label="周期类型" prop="periodType"><el-input v-model.trim="definitionForm.periodType" placeholder="如 month" /></el-form-item>
          <el-form-item label="范围类型" prop="scopeType"><el-select v-model="definitionForm.scopeType" class="full-control" @change="changeDefinitionScopeType"><el-option label="组织" value="organization" /><el-option label="能源类型" value="energy" /><el-option label="产品" value="product" /></el-select></el-form-item>
          <el-form-item label="范围标识" prop="scopeReference"><el-select v-model="definitionForm.scopeReference" class="full-control" filterable clearable :loading="definitionScopeLoading" :disabled="definitionScopeBlocked" :placeholder="definitionScopePlaceholder"><el-option v-for="item in definitionScopeOptions" :key="definitionScopeOptionValue(item)" :label="formatEnergyBenchmarkScopeOptionLabel(definitionForm.scopeType, item)" :value="definitionScopeOptionValue(item)" /></el-select></el-form-item>
          <el-form-item label="指标方向" prop="direction"><el-select v-model="definitionForm.direction" class="full-control"><el-option v-for="(label, value) in ENERGY_BENCHMARK_DIRECTION_LABELS" :key="value" :label="label" :value="value" /></el-select></el-form-item>
          <el-form-item label="来源" prop="source"><el-input v-model.trim="definitionForm.source" maxlength="300" /></el-form-item>
          <el-form-item label="文号"><el-input v-model.trim="definitionForm.documentNo" placeholder="外部标准必填" /></el-form-item>
          <el-form-item label="版本" prop="version"><el-input v-model.trim="definitionForm.version" placeholder="如 enterprise-standard:v1" /></el-form-item>
          <el-form-item label="生效开始 UTC" prop="effectiveStartUtc"><StrictUtcDateTimeInput v-model="definitionForm.effectiveStartUtc" placeholder="2026-01-01T00:00:00Z" @change="validateUtcFormField(definitionFormRef, 'effectiveStartUtc')" @blur="validateUtcFormField(definitionFormRef, 'effectiveStartUtc')" /></el-form-item>
          <el-form-item label="生效结束 UTC（不含）" prop="effectiveEndUtc"><StrictUtcDateTimeInput v-model="definitionForm.effectiveEndUtc" placeholder="2027-01-01T00:00:00Z" @change="validateUtcFormField(definitionFormRef, 'effectiveEndUtc')" @blur="validateUtcFormField(definitionFormRef, 'effectiveEndUtc')" /></el-form-item>
          <el-form-item label="来源时区" prop="sourceTimeZone"><IanaTimeZoneSelect v-model="definitionForm.sourceTimeZone" placeholder="请选择或搜索来源时区" /></el-form-item>
          <el-form-item label="状态"><el-select v-model="definitionForm.status" class="full-control"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
        </el-form>
      </ManagementDrawer>

      <ManagementDrawer v-model="internalDrawerOpen" title="固化企业内部历史基准" :loading="internalSaving" :confirm-disabled="writeDisabled || internalMasterDataBlocked" confirm-label="由服务端计算并固化" @save="saveInternalHistory">
        <el-alert type="warning" :closable="false" show-icon title="页面只提交定义、参考期和显式计算范围。固化值、样本数、产量摘要、摘要哈希和固化时间全部由服务端计算，页面没有这些输入框。" class="drawer-alert" />
        <el-alert v-if="internalFormError" type="error" :closable="false" show-icon :title="internalFormError" class="drawer-alert" />
        <el-alert v-if="internalMasterDataNotice" :type="internalMasterDataError ? 'error' : 'warning'" :closable="false" show-icon :title="internalMasterDataNotice" class="drawer-alert" />
        <el-form ref="internalFormRef" :model="internalForm" :rules="internalRules" label-position="top">
          <el-form-item label="对标编码" prop="definition.benchmarkCode"><el-input v-model.trim="internalForm.definition.benchmarkCode" /></el-form-item>
          <el-form-item label="对标名称" prop="definition.benchmarkName"><el-input v-model.trim="internalForm.definition.benchmarkName" /></el-form-item>
          <el-form-item label="指标编码"><el-input v-model="internalForm.definition.metricCode" disabled /></el-form-item>
          <el-form-item label="指标单位" prop="definition.unit"><el-input v-model.trim="internalForm.definition.unit" placeholder="如 kWh/t" /></el-form-item>
          <el-form-item label="范围类型" prop="definition.scopeType"><el-select v-model="internalForm.definition.scopeType" class="full-control" @change="changeInternalScopeType"><el-option label="组织" value="organization" /><el-option label="能源类型" value="energy" /><el-option label="产品" value="product" /></el-select></el-form-item>
          <el-form-item label="范围标识" prop="definition.scopeReference"><el-select v-model="internalForm.definition.scopeReference" class="full-control" filterable clearable :loading="internalScopeLoading" :disabled="internalScopeBlocked" :placeholder="internalScopePlaceholder"><el-option v-for="item in internalScopeOptions" :key="internalScopeOptionValue(item)" :label="formatEnergyBenchmarkScopeOptionLabel(internalForm.definition.scopeType, item)" :value="internalScopeOptionValue(item)" /></el-select></el-form-item>
          <el-form-item label="来源" prop="definition.source"><el-input v-model.trim="internalForm.definition.source" /></el-form-item>
          <el-form-item label="版本" prop="definition.version"><el-input v-model.trim="internalForm.definition.version" placeholder="如 internal-baseline:v1" /></el-form-item>
          <el-form-item label="定义生效开始 UTC" prop="definition.effectiveStartUtc"><StrictUtcDateTimeInput v-model="internalForm.definition.effectiveStartUtc" placeholder="2026-01-01T00:00:00Z" @change="validateUtcFormField(internalFormRef, 'definition.effectiveStartUtc')" @blur="validateUtcFormField(internalFormRef, 'definition.effectiveStartUtc')" /></el-form-item>
          <el-form-item label="定义生效结束 UTC（不含）" prop="definition.effectiveEndUtc"><StrictUtcDateTimeInput v-model="internalForm.definition.effectiveEndUtc" placeholder="2027-01-01T00:00:00Z" @change="validateUtcFormField(internalFormRef, 'definition.effectiveEndUtc')" @blur="validateUtcFormField(internalFormRef, 'definition.effectiveEndUtc')" /></el-form-item>
          <el-form-item label="来源时区"><IanaTimeZoneSelect v-model="internalForm.definition.sourceTimeZone" placeholder="请选择或搜索来源时区" /></el-form-item>
          <el-form-item label="历史参考期开始 UTC" prop="referencePeriod.startUtc"><StrictUtcDateTimeInput v-model="internalForm.referencePeriod.startUtc" placeholder="2025-01-01T00:00:00Z" @change="validateUtcFormField(internalFormRef, 'referencePeriod.startUtc')" @blur="validateUtcFormField(internalFormRef, 'referencePeriod.startUtc')" /></el-form-item>
          <el-form-item label="历史参考期结束 UTC（不含）" prop="referencePeriod.endUtc"><StrictUtcDateTimeInput v-model="internalForm.referencePeriod.endUtc" placeholder="2026-01-01T00:00:00Z" @change="validateUtcFormField(internalFormRef, 'referencePeriod.endUtc')" @blur="validateUtcFormField(internalFormRef, 'referencePeriod.endUtc')" /></el-form-item>
          <el-form-item label="产能单元" prop="calculationScope.productionUnitId"><el-select v-model="internalForm.calculationScope.productionUnitId" class="full-control" filterable clearable :loading="productionMasterDataLoading" :disabled="Boolean(productionMasterDataError) || !productionUnits.length" placeholder="选择 active 产能单元"><el-option v-for="item in productionUnits" :key="item.id" :label="formatEnergyBenchmarkScopeOptionLabel('product', item)" :value="item.id" /></el-select></el-form-item>
          <el-form-item label="能源类型" prop="calculationScope.energyTypeCode"><el-select v-model="internalForm.calculationScope.energyTypeCode" class="full-control" filterable clearable :loading="energyTypesLoading" :disabled="Boolean(energyTypesError) || !energyTypes.length" placeholder="选择 active 能源类型"><el-option v-for="item in energyTypes" :key="item.code" :label="formatEnergyBenchmarkScopeOptionLabel('energy', item)" :value="item.code" /></el-select></el-form-item>
        </el-form>
      </ManagementDrawer>

      <ManagementDrawer v-model="targetDrawerOpen" :title="targetDrawerTitle" :loading="targetSaving" :confirm-disabled="writeDisabled" @save="saveTarget">
        <el-alert v-if="targetFormError" type="error" :closable="false" show-icon :title="targetFormError" class="drawer-alert" />
        <el-alert v-if="targetMode === 'version'" type="info" :closable="false" show-icon title="保存会创建后继目标版本，旧版本继续保留。新版本必须使用新的 name:v1 标识。" class="drawer-alert" />
        <el-form ref="targetFormRef" :model="targetForm" :rules="targetRules" label-position="top">
          <el-form-item label="对标定义"><el-input :model-value="targetDefinitionLabel" disabled /></el-form-item>
          <template v-if="targetDefinition?.direction === 'range'">
            <el-form-item label="下限值" prop="lowerBound"><el-input-number v-model="targetForm.lowerBound" :controls="false" class="full-control" /></el-form-item>
            <el-form-item label="上限值" prop="upperBound"><el-input-number v-model="targetForm.upperBound" :controls="false" class="full-control" /></el-form-item>
          </template>
          <el-form-item v-else label="目标值" prop="targetValue"><el-input-number v-model="targetForm.targetValue" :controls="false" class="full-control" /></el-form-item>
          <el-form-item label="目标版本" prop="version"><el-input v-model.trim="targetForm.version" placeholder="如 target-2026:v1" /></el-form-item>
          <el-form-item label="状态"><el-select v-model="targetForm.status" class="full-control"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
        </el-form>
      </ManagementDrawer>

      <el-dialog v-model="actualContextOpen" title="编辑实际值兼容上下文" width="720px" destroy-on-close>
        <el-alert type="info" :closable="false" show-icon title="排名要求同层级、同指标、同单位、同周期和同对标范围。时间必须是定义有效期内的严格 UTC Z 左闭右开区间。" />
        <el-form v-if="actualContextForm" :model="actualContextForm" label-position="top" class="context-form">
          <el-form-item label="指标编码"><el-input v-model.trim="actualContextForm.metricCode" /></el-form-item>
          <el-form-item label="单位"><el-input v-model.trim="actualContextForm.unit" /></el-form-item>
          <el-form-item label="周期类型"><el-input v-model.trim="actualContextForm.periodType" /></el-form-item>
          <el-form-item label="周期开始 UTC"><StrictUtcDateTimeInput v-model="actualContextForm.periodStartUtc" /></el-form-item>
          <el-form-item label="周期结束 UTC（不含）"><StrictUtcDateTimeInput v-model="actualContextForm.periodEndUtc" /></el-form-item>
          <el-form-item label="范围类型"><el-input v-model.trim="actualContextForm.scopeType" disabled /></el-form-item>
          <el-form-item label="对象自身范围标识"><el-input v-model.trim="actualContextForm.scopeReference" :disabled="analysisDefinition?.scopeType === 'organization'" /></el-form-item>
          <el-form-item label="对标范围标识"><el-input v-model.trim="actualContextForm.benchmarkScopeReference" disabled /></el-form-item>
          <el-form-item label="能源类型编码"><el-input v-model.trim="actualContextForm.energyTypeCode" /></el-form-item>
        </el-form>
        <template #footer><el-button @click="actualContextOpen=false">取消</el-button><el-button type="primary" @click="saveActualContext">保存上下文</el-button></template>
      </el-dialog>

      <el-dialog v-model="detailOpen" :title="detailTitle" width="860px" destroy-on-close>
        <PageState v-if="detailLoading" loading />
        <el-alert v-else-if="detailError" type="error" :closable="false" show-icon :title="detailError" />
        <el-descriptions v-else-if="detailData" :column="2" border>
          <el-descriptions-item v-for="item in detailDescriptions" :key="item.label" :label="item.label">{{ item.value }}</el-descriptions-item>
        </el-descriptions>
        <template v-if="detailData?.targets">
          <h3 class="detail-subtitle">目标版本历史</h3>
          <el-table :data="detailData.targets" size="small"><el-table-column prop="version" label="版本" min-width="130" /><el-table-column label="目标 / 边界" min-width="150"><template #default="{ row }">{{ targetValueLabel(row, detailData) }}</template></el-table-column><el-table-column label="固化" width="90"><template #default="{ row }">{{ row.isFrozen ? '是' : '否' }}</template></el-table-column><el-table-column prop="status" label="状态" width="90" /></el-table>
        </template>
      </el-dialog>

      <ManagementDrawer v-model="importExecuteOpen" title="确认执行能效对标导入" confirm-label="确认导入" :loading="importExecuteLoading" :confirm-disabled="writeDisabled || importConfirmText !== importPreview?.confirmText || !canExecuteEnergyBenchmarkImport(importPreview)" @save="executeImport">
        <p class="drawer-notice">服务端会依据持久化预演批次重新读取原文件、恢复签名和候选行、创建自动备份并执行导入。页面不会提交或覆盖服务端派生的完整性见证。</p>
        <el-form label-position="top"><el-form-item :label="`请输入固定确认文本：${importPreview?.confirmText || ''}`"><el-input v-model="importConfirmText" /></el-form-item></el-form>
        <el-alert v-if="importExecuteError" type="error" :closable="false" show-icon :title="importExecuteError" />
      </ManagementDrawer>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import {
  createEnergyBenchmarkDefinition,
  createEnergyBenchmarkInternalHistory,
  createEnergyBenchmarkTarget,
  downloadEnergyBenchmarkDemoParkExample,
  downloadEnergyBenchmarkImportTemplate,
  evaluateEnergyBenchmark,
  executeEnergyBenchmarkImport,
  getAllActiveEnergyBenchmarkDefinitions,
  getAllActiveEnergyBenchmarkOrganizationUnits,
  getAllActiveEnergyBenchmarkProductionUnits,
  getAllActiveEnergyBenchmarkTargets,
  getEnergyBenchmarkBootstrap,
  getEnergyBenchmarkDefinition,
  getEnergyBenchmarkDefinitions,
  getEnergyBenchmarkExportRows,
  getEnergyBenchmarkQualificationRate,
  getEnergyBenchmarkTarget,
  getEnergyBenchmarkTargets,
  previewEnergyBenchmarkImport,
  rankEnergyBenchmarks,
  updateEnergyBenchmarkDefinition,
  updateEnergyBenchmarkDefinitionStatus,
  updateEnergyBenchmarkTargetStatus,
  versionEnergyBenchmarkTarget
} from '@/api/energyBenchmarks';
import { getEnergyTypes } from '@/api/energy';
import {
  ENERGY_BENCHMARK_CHART_MAX_ENTITIES,
  ENERGY_BENCHMARK_DIRECTION_LABELS,
  ENERGY_BENCHMARK_IMPORT_TYPES,
  ENERGY_BENCHMARK_ORGANIZATION_LEVEL_LABELS,
  ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS,
  ENERGY_BENCHMARK_PERMISSIONS,
  ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS,
  ENERGY_BENCHMARK_SCOPE_LABELS,
  ENERGY_BENCHMARK_TYPE_LABELS,
  applyEnergyBenchmarkOrganizationSelection,
  buildEnergyBenchmarkAnalysisSnapshot,
  buildEnergyBenchmarkCapabilityMatrix,
  buildEnergyBenchmarkCsv,
  buildEnergyBenchmarkDefinitionFilters,
  buildEnergyBenchmarkDefinitionPayload,
  buildEnergyBenchmarkEvaluationPayload,
  buildEnergyBenchmarkGroupPayload,
  buildEnergyBenchmarkImportExecutePayload,
  buildEnergyBenchmarkInternalHistoryPayload,
  buildEnergyBenchmarkTargetFilters,
  buildEnergyBenchmarkTargetPayload,
  canExecuteEnergyBenchmarkImport,
  createEnergyBenchmarkActualRow,
  createEnergyBenchmarkEntityColorRegistry,
  createEnergyBenchmarkLatestRequestGuard,
  energyBenchmarkStatusPresentation,
  formatEnergyBenchmarkBoundary,
  formatEnergyBenchmarkNumber,
  formatEnergyBenchmarkQualificationRate,
  formatEnergyBenchmarkRatio,
  formatEnergyBenchmarkReasons,
  formatEnergyBenchmarkScopeOptionLabel,
  isEnergyBenchmarkStrictUtcRange,
  normalizeEnergyBenchmarkOrganizationAccessError,
  normalizeEnergyBenchmarkProductionAccessError,
  normalizeEnergyBenchmarkRankingRows,
  projectEnergyBenchmarkMaintenance,
  projectEnergyBenchmarkRequestError,
  reduceEnergyBenchmarkPageErrors,
  resetEnergyBenchmarkScopeSelection,
  resolveEnergyBenchmarkAnalysisInvalidation,
  resolveEnergyBenchmarkDefinitionObjectLevel,
  resolveEnergyBenchmarkErrorDestination,
  resolveEnergyBenchmarkScopeOptionValue,
  selectEnergyBenchmarkPageError,
  transitionEnergyBenchmarkAnalysisState,
  validateEnergyBenchmarkAnalysisContext,
  validateEnergyBenchmarkScopeSelection
} from '@/utils/energyBenchmarkManagement';
import { hasPermi } from '@/utils/permission';

defineOptions({ name: 'EnergyBenchmarksIndex' });

// 无局部错误容器的请求按工作流使用稳定来源，成功时只清除对应来源。
const PAGE_ERROR_SOURCES = Object.freeze({
  maintenance: 'maintenance',
  analysisDefinitions: 'analysis-definitions',
  definitions: 'definitions',
  analysisTargets: 'analysis-targets',
  evaluation: 'analysis-evaluation',
  ranking: 'analysis-ranking',
  qualification: 'analysis-qualification',
  export: 'analysis-export',
  definitionStatus: 'definition-status',
  targetStatus: 'target-status',
  targetVersionContext: 'target-version-context'
});

// 通用页面状态与权限模块。
const activeTab = ref('analysis');
// 全页错误按请求来源保存；清除一个来源时不得覆盖或误清其他来源。
const pageErrors = ref({});
const pageError = computed(() => selectEnergyBenchmarkPageError(pageErrors.value));
const maintenance = ref({ active: false, reason: '' });
// 页面先读取现有用户权限，再由纯函数计算需要组合权限的端到端能力。
const capabilityMatrix = computed(() => buildEnergyBenchmarkCapabilityMatrix({
  view: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.view),
  manage: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.manage),
  analyze: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.analyze),
  export: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.export),
  importPreview: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.importPreview),
  importExecute: hasPermi(ENERGY_BENCHMARK_PERMISSIONS.importExecute),
  organizationUnitsView: hasPermi(ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS.units),
  organizationView: hasPermi(ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS.organization),
  productionUnitView: hasPermi(ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS.unit),
  productionView: hasPermi(ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS.legacy)
}));
const canView = computed(() => capabilityMatrix.value.view);
const canManage = computed(() => capabilityMatrix.value.manage);
const canAnalyze = computed(() => capabilityMatrix.value.analyze);
const hasExportPermission = computed(() => capabilityMatrix.value.exportPermission);
const canExport = computed(() => capabilityMatrix.value.exportWorkflow);
const canImportPreview = computed(() => capabilityMatrix.value.importPreview);
const hasImportExecutePermission = computed(() => capabilityMatrix.value.importExecutePermission);
const canImportExecute = computed(() => capabilityMatrix.value.importExecuteWorkflow);
const canViewOrganizationObjects = computed(() => capabilityMatrix.value.organizationView);
const canViewProductionUnits = computed(() => capabilityMatrix.value.productionView);
const writeDisabled = computed(() => maintenance.value.active === true);

// 范围主数据模块；组织与产能接口按现有台账权限读取，能源类型复用现有公开字典接口。
const organizationUnits = ref([]);
const organizationMasterDataLoading = ref(false);
const organizationMasterDataError = ref('');
// 组织主数据状态：显式区分加载、权限、错误、空态和可用状态。
const organizationMasterDataStatus = ref('idle');
const productionUnits = ref([]);
const productionMasterDataLoading = ref(false);
const productionMasterDataError = ref('');
// 产能主数据状态：用于避免将 403 或失败后的旧候选误当成功数据。
const productionMasterDataStatus = ref('idle');
const energyTypes = ref([]);
const energyTypesLoading = ref(false);
const energyTypesError = ref('');
// 能源类型主数据状态：与组织和产能保持相同的状态机语义。
const energyTypesStatus = ref('idle');

// 对标定义列表、筛选和分页模块。
const emptyDefinitionFilters = () => ({ status: '', benchmarkType: '', benchmarkCode: '', metricCode: '', scopeType: '', scopeReference: '' });
const definitionDraftFilters = ref(emptyDefinitionFilters());
const definitionAppliedFilters = ref(emptyDefinitionFilters());
const definitions = ref([]);
const definitionsLoading = ref(false);
const definitionsError = ref('');
const definitionPage = ref(1);
const definitionPageSize = ref(20);
const definitionPagination = ref({ total: 0 });

// 分析定义使用独立的全部 active 数据源，禁止复用管理列表筛选和当前分页。
const analysisDefinitions = ref([]);
const analysisDefinitionsLoading = ref(false);
const activeDefinitions = computed(() => analysisDefinitions.value.filter((item) => item.status === 'active'));

// 对标目标列表、筛选和分页模块。
const targets = ref([]);
const targetsLoading = ref(false);
const targetsError = ref('');
const targetDefinitionFilter = ref('');
const targetPage = ref(1);
const targetPageSize = ref(20);
const targetPagination = ref({ total: 0 });

// 定义维护抽屉模块。
const emptyDefinitionForm = () => ({ benchmarkCode: '', benchmarkName: '', benchmarkType: 'manual_benchmark', metricCode: 'energy_intensity', unit: '', periodType: 'month', scopeType: 'organization', scopeReference: '', direction: 'lower_better', source: '企业自定义标杆', documentNo: '', version: '', effectiveStartUtc: '', effectiveEndUtc: '', sourceTimeZone: 'Asia/Shanghai', status: 'active' });
const definitionDrawerOpen = ref(false);
const definitionMode = ref('create');
const editingDefinitionId = ref(null);
const definitionForm = ref(emptyDefinitionForm());
const definitionFormRef = ref();
const definitionSaving = ref(false);
const definitionFormError = ref('');
const definitionDrawerTitle = computed(() => definitionMode.value === 'edit' ? '修改对标定义' : definitionMode.value === 'version' ? '新建对标定义版本' : '新增对标定义');
const definitionScopeOptions = computed(() => definitionForm.value.scopeType === 'organization' ? organizationUnits.value : definitionForm.value.scopeType === 'energy' ? energyTypes.value : definitionForm.value.scopeType === 'product' ? productionUnits.value : []);
const definitionScopeLoading = computed(() => definitionForm.value.scopeType === 'organization' ? organizationMasterDataLoading.value : definitionForm.value.scopeType === 'energy' ? energyTypesLoading.value : definitionForm.value.scopeType === 'product' ? productionMasterDataLoading.value : false);
const definitionScopeError = computed(() => definitionForm.value.scopeType === 'organization' ? organizationMasterDataError.value : definitionForm.value.scopeType === 'energy' ? energyTypesError.value : definitionForm.value.scopeType === 'product' ? productionMasterDataError.value : '');
const definitionScopeNotice = computed(() => {
  if (definitionScopeError.value) return definitionScopeError.value;
  if (!definitionScopeLoading.value && !definitionScopeOptions.value.length) return `当前没有可选择的 active ${ENERGY_BENCHMARK_SCOPE_LABELS[definitionForm.value.scopeType] || '范围'}主数据，请先维护对应台账。`;
  const validation = validateEnergyBenchmarkScopeSelection(definitionForm.value.scopeType, definitionForm.value.scopeReference, currentScopeSources());
  return definitionForm.value.scopeReference && !validation.valid ? `${validation.message}历史值保持原样显示，页面不会静默替换。` : '';
});
const definitionScopeBlocked = computed(() => definitionScopeLoading.value || Boolean(definitionScopeError.value) || !definitionScopeOptions.value.length);
const definitionScopePlaceholder = computed(() => definitionScopeBlocked.value ? '当前范围主数据不可用' : `选择 active ${ENERGY_BENCHMARK_SCOPE_LABELS[definitionForm.value.scopeType] || '范围'}主数据`);
const definitionRules = { benchmarkCode: requiredRule('请输入对标编码。'), benchmarkName: requiredRule('请输入对标名称。'), benchmarkType: requiredRule('请选择定义类型。'), metricCode: requiredRule('请输入指标编码。'), unit: requiredRule('请输入指标单位。'), periodType: requiredRule('请输入周期类型。'), scopeType: requiredRule('请选择范围类型。'), scopeReference: requiredRule('请选择 active 主数据范围。'), direction: requiredRule('请选择指标方向。'), source: requiredRule('请输入真实来源。'), version: requiredRule('请输入 name:v1 格式版本。'), effectiveStartUtc: requiredRule('请输入严格 UTC 生效开始时间。'), effectiveEndUtc: requiredRule('请输入严格 UTC 生效结束时间。') };

// 内部历史基准原子固化表单模块；表单中刻意不存在服务端派生字段。
const emptyInternalForm = () => ({ definition: { ...emptyDefinitionForm(), benchmarkType: 'internal_history_baseline', benchmarkName: '', metricCode: 'energy_intensity', periodType: 'month', scopeType: 'organization', direction: 'lower_better', source: '企业内部历史数据固化', documentNo: '', status: 'active' }, referencePeriod: { startUtc: '', endUtc: '' }, calculationScope: { productionUnitId: null, energyTypeCode: '' } });
const internalDrawerOpen = ref(false);
const internalForm = ref(emptyInternalForm());
const internalFormRef = ref();
const internalSaving = ref(false);
const internalFormError = ref('');
const internalScopeOptions = computed(() => internalForm.value.definition.scopeType === 'organization' ? organizationUnits.value : internalForm.value.definition.scopeType === 'energy' ? energyTypes.value : internalForm.value.definition.scopeType === 'product' ? productionUnits.value : []);
const internalScopeLoading = computed(() => internalForm.value.definition.scopeType === 'organization' ? organizationMasterDataLoading.value : internalForm.value.definition.scopeType === 'energy' ? energyTypesLoading.value : internalForm.value.definition.scopeType === 'product' ? productionMasterDataLoading.value : false);
const internalScopeError = computed(() => internalForm.value.definition.scopeType === 'organization' ? organizationMasterDataError.value : internalForm.value.definition.scopeType === 'energy' ? energyTypesError.value : internalForm.value.definition.scopeType === 'product' ? productionMasterDataError.value : '');
const internalScopeBlocked = computed(() => internalScopeLoading.value || Boolean(internalScopeError.value) || !internalScopeOptions.value.length);
const internalScopePlaceholder = computed(() => internalScopeBlocked.value ? '当前范围主数据不可用' : `选择 active ${ENERGY_BENCHMARK_SCOPE_LABELS[internalForm.value.definition.scopeType] || '范围'}主数据`);
const internalMasterDataError = computed(() => internalScopeError.value || productionMasterDataError.value || energyTypesError.value);
const internalMasterDataLoading = computed(() => internalScopeLoading.value || productionMasterDataLoading.value || energyTypesLoading.value);
const internalMasterDataNotice = computed(() => {
  if (internalMasterDataError.value) return internalMasterDataError.value;
  if (!internalScopeLoading.value && !internalScopeOptions.value.length) return `当前没有可选择的 active ${ENERGY_BENCHMARK_SCOPE_LABELS[internalForm.value.definition.scopeType] || '范围'}主数据，请先维护对应台账。`;
  if (!productionMasterDataLoading.value && !productionUnits.value.length) return '当前没有可选择的 active 产能单元，请先维护产能单元台账。';
  if (!energyTypesLoading.value && !energyTypes.value.length) return '当前没有可选择的 active 能源类型，请先维护能源类型。';
  return '';
});
const internalMasterDataBlocked = computed(() => internalMasterDataLoading.value || Boolean(internalMasterDataError.value) || !internalScopeOptions.value.length || !productionUnits.value.length || !energyTypes.value.length);
const internalRules = { 'definition.benchmarkCode': requiredRule('请输入对标编码。'), 'definition.benchmarkName': requiredRule('请输入对标名称。'), 'definition.unit': requiredRule('请输入指标单位。'), 'definition.scopeType': requiredRule('请选择范围类型。'), 'definition.scopeReference': requiredRule('请选择 active 主数据范围。'), 'definition.source': requiredRule('请输入来源。'), 'definition.version': requiredRule('请输入版本。'), 'definition.effectiveStartUtc': requiredRule('请输入定义生效开始时间。'), 'definition.effectiveEndUtc': requiredRule('请输入定义生效结束时间。'), 'referencePeriod.startUtc': requiredRule('请输入历史参考期开始时间。'), 'referencePeriod.endUtc': requiredRule('请输入历史参考期结束时间。'), 'calculationScope.productionUnitId': requiredRule('请选择产能单元。'), 'calculationScope.energyTypeCode': requiredRule('请选择能源类型。') };

// 目标版本维护抽屉模块。
const emptyTargetForm = () => ({ benchmarkDefinitionId: null, targetValue: null, lowerBound: null, upperBound: null, version: '', status: 'inactive' });
const targetDrawerOpen = ref(false);
const targetMode = ref('create');
const editingTargetId = ref(null);
const targetForm = ref(emptyTargetForm());
const targetFormRef = ref();
const targetSaving = ref(false);
const targetFormError = ref('');
const targetDefinitionContext = ref(null);
const targetDefinition = computed(() => definitionById(targetForm.value.benchmarkDefinitionId) || targetDefinitionContext.value);
const targetDefinitionLabel = computed(() => targetDefinition.value ? `${targetDefinition.value.benchmarkName} · ${targetDefinition.value.version} · ${ENERGY_BENCHMARK_DIRECTION_LABELS[targetDefinition.value.direction]}` : `定义 #${targetForm.value.benchmarkDefinitionId || '—'}`);
const targetDrawerTitle = computed(() => targetMode.value === 'version' ? '创建后继目标版本' : '新增对标目标');
const targetRules = { version: requiredRule('请输入新的 name:v1 目标版本。') };

// 显式实际值分析模块。
const analysisDefinitionId = ref(null);
const analysisTargetId = ref(null);
const analysisTargets = ref([]);
const analysisTargetsLoading = ref(false);
const organizationObjects = ref([]);
const organizationObjectsLoading = ref(false);
const organizationObjectsError = ref('');
const actualRows = ref([]);
const analysisLoading = ref(false);
const evaluationLoading = ref(false);
const exportLoading = ref(false);
const rankingResult = ref(null);
const qualificationResult = ref(null);
const singleEvaluation = ref(null);
const rankingTooltip = ref(null);
const analysisStaleNotice = ref('');
const latestSuccessfulAnalysis = ref(null);
// 页面所有异步请求共享按业务键隔离的 latest-response 守卫。
const latestRequestGuard = createEnergyBenchmarkLatestRequestGuard();
// 创建项目统一亮色科技风的图形颜色注册表；仅定义或目标语义上下文变化时整体重建。
function createRankingColorRegistry() {
  return createEnergyBenchmarkEntityColorRegistry([
    'var(--benchmark-series-1)', 'var(--benchmark-series-2)', 'var(--benchmark-series-3)', 'var(--benchmark-series-4)',
    'var(--benchmark-series-5)', 'var(--benchmark-series-6)', 'var(--benchmark-series-7)', 'var(--benchmark-series-8)'
  ]);
}
// 当前成功分析上下文专用颜色注册表；同一上下文内实体不因排名或筛选变化换色。
const rankingColorRegistry = ref(createRankingColorRegistry());
const analysisDefinition = computed(() => activeDefinitions.value.find((item) => Number(item.id) === Number(analysisDefinitionId.value)) || null);
const activeAnalysisTargets = computed(() => analysisTargets.value.filter((item) => item.status === 'active' && Number(item.benchmarkDefinitionId) === Number(analysisDefinitionId.value)));
const analysisTarget = computed(() => activeAnalysisTargets.value.find((item) => Number(item.id) === Number(analysisTargetId.value)) || null);
const analysisDefinitionObjectLevel = computed(() => resolveEnergyBenchmarkDefinitionObjectLevel(analysisDefinition.value || {}, organizationObjects.value));
const compatibleOrganizationObjects = computed(() => organizationObjects.value.filter((item) => item.status === 'active' && item.unitType === analysisDefinitionObjectLevel.value));
const analysisValidation = computed(() => validateEnergyBenchmarkAnalysisContext({ definition: analysisDefinition.value, target: analysisTarget.value, actualRows: actualRows.value, organizationUnits: organizationObjects.value }));
const analysisReady = computed(() => analysisValidation.value.ready);
const analysisInputSignature = computed(() => buildEnergyBenchmarkAnalysisSnapshot(analysisDefinitionId.value, analysisTargetId.value, actualRows.value));
// 实际对象快照与定义、目标语义上下文分离，便于只协调颜色而不误重建幸存对象槽位。
const analysisActualSignature = computed(() => buildEnergyBenchmarkAnalysisSnapshot(null, null, actualRows.value));
const canExportLatestAnalysis = computed(() => Boolean(analysisReady.value && latestSuccessfulAnalysis.value && latestSuccessfulAnalysis.value.signature === analysisInputSignature.value && rankingResult.value && qualificationResult.value));
const rankingRows = computed(() => normalizeEnergyBenchmarkRankingRows(rankingResult.value?.ranked || [], rankingColorRegistry.value));
const chartRankingRows = computed(() => rankingRows.value.filter((item) => item.entityColor).slice(0, ENERGY_BENCHMARK_CHART_MAX_ENTITIES));
const tableOnlyRankingCount = computed(() => Math.max(0, rankingRows.value.length - chartRankingRows.value.length));
const excludedRows = computed(() => rankingResult.value?.excluded || qualificationResult.value?.excluded || []);

// 实际值兼容上下文编辑模块。
const actualContextOpen = ref(false);
const actualContextIndex = ref(-1);
const actualContextForm = ref(null);

// 详情对话框模块。
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detailData = ref(null);
const detailKind = ref('definition');
const detailTitle = computed(() => detailKind.value === 'definition' ? '对标定义详情' : '对标目标详情');
const detailDescriptions = computed(() => buildDetailDescriptions(detailData.value, detailKind.value));

// 受控导入 preview/execute 模块。
const importType = ref('conversion-factors');
const importFile = ref(null);
const importPreview = ref(null);
const importTemplateLoading = ref(false);
const importDemoExampleLoading = ref(false);
const importPreviewLoading = ref(false);
const importError = ref('');
const importExecuteOpen = ref(false);
const importConfirmText = ref('');
const importExecuteLoading = ref(false);
const importExecuteError = ref('');
/** 当前导入类型的中文名称，用于明确模板和示例归属。 */
const currentImportTypeLabel = computed(() => ENERGY_BENCHMARK_IMPORT_TYPES.find((item) => item.value === importType.value)?.label || '能效对标');

/** 创建 Element Plus 必填规则，兼容日期选择器的 change 与 blur 校验触发。 */
function requiredRule(message) { return [{ required: true, message, trigger: ['blur', 'change'] }]; }
/** 响应共享日期选择器的 change 与 blur 事件并校验对应表单字段。 */
function validateUtcFormField(formInstance, field) { formInstance?.validateField(field).catch(() => false); }
/** 返回严格 UTC Z 左闭右开范围的保存兜底错误。 */
function strictUtcRangeError(startUtc, endUtc, rangeLabel) {
  return isEnergyBenchmarkStrictUtcRange(startUtc, endUtc)
    ? ''
    : `${rangeLabel}必须是合法严格 UTC Z 左闭右开区间，且开始早于结束（结束不含）。`;
}
/** 安全执行异步请求并统一返回成功标识。 */
async function safe(task) { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } }
/** 提取统一接口错误投影文案。 */
function requestError(result, action = '请求') { return projectEnergyBenchmarkRequestError(result?.error, action).message; }
/** 返回普通定义范围选择项的服务端契约值。 */
function definitionScopeOptionValue(item) { return resolveEnergyBenchmarkScopeOptionValue(definitionForm.value.scopeType, item); }
/** 返回内部历史定义范围选择项的服务端契约值。 */
function internalScopeOptionValue(item) { return resolveEnergyBenchmarkScopeOptionValue(internalForm.value.definition.scopeType, item); }
/** 返回当前 active 范围主数据集合，供保存前执行选择来源校验。 */
function currentScopeSources() { return { organizationUnits: organizationUnits.value, energyTypes: energyTypes.value, productionUnits: productionUnits.value }; }
/** 清除组织主数据失败后仍绑定在维护表单中的旧选择。 */
function clearOrganizationMasterDataSelections() {
  if (definitionForm.value.scopeType === 'organization') definitionForm.value.scopeReference = '';
  if (internalForm.value.definition.scopeType === 'organization') internalForm.value.definition.scopeReference = '';
}
/** 清除产能主数据失败后仍绑定在维护表单中的旧选择。 */
function clearProductionMasterDataSelections() {
  if (definitionForm.value.scopeType === 'product') definitionForm.value.scopeReference = '';
  if (internalForm.value.definition.scopeType === 'product') internalForm.value.definition.scopeReference = '';
  internalForm.value.calculationScope.productionUnitId = null;
}
/** 清除能源类型主数据失败后仍绑定在维护表单中的旧选择。 */
function clearEnergyTypeMasterDataSelections() {
  if (definitionForm.value.scopeType === 'energy') definitionForm.value.scopeReference = '';
  if (internalForm.value.definition.scopeType === 'energy') internalForm.value.definition.scopeReference = '';
  internalForm.value.calculationScope.energyTypeCode = '';
}
/** 清除指定请求来源的全页错误，不影响其他来源。 */
function clearPageRequestError(source) {
  pageErrors.value = reduceEnergyBenchmarkPageErrors(pageErrors.value, { type: 'clear', source });
}
/** 投影请求错误；有局部 target 时默认只写局部，只有显式 source 才写全页错误。 */
function presentRequestError(result, action, options = {}) {
  const projection = projectEnergyBenchmarkRequestError(result?.error, action);
  const destination = resolveEnergyBenchmarkErrorDestination(projection, {
    hasLocalTarget: Boolean(options.target),
    source: options.source,
    message: options.message
  });
  if (options.target) options.target.value = destination.localMessage;
  if (destination.pageErrorAction) pageErrors.value = reduceEnergyBenchmarkPageErrors(pageErrors.value, destination.pageErrorAction);
  if (options.toast !== false && !projection.suppressToast && !options.target) ElMessage.error(projection.message);
  return projection.message;
}
/** 格式化整数统计。 */
function formatInteger(value) { const numberValue = Number(value); return Number.isFinite(numberValue) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(numberValue) : '0'; }
/** 写操作局部错误统一包含 HTTP 状态和业务原因码，不默认污染全页错误。 */
function writeErrorText(result, action) { return requestError(result, action); }
/** 按定义主键读取当前页面已加载定义。 */
function definitionById(definitionId) { return definitions.value.find((item) => Number(item.id) === Number(definitionId)) || null; }
/** 格式化目标单值或区间。 */
function targetValueLabel(target = {}, definition = {}) { return definition?.direction === 'range' || (target.lowerBound !== null && target.lowerBound !== undefined) ? `${formatEnergyBenchmarkNumber(target.lowerBound)} ～ ${formatEnergyBenchmarkNumber(target.upperBound)} ${definition?.unit || ''}` : `${formatEnergyBenchmarkNumber(target.targetValue)} ${definition?.unit || ''}`; }
/** 格式化排名行无障碍说明。 */
function rankingAriaLabel(row) { const status = energyBenchmarkStatusPresentation(row); return `第 ${row.rank} 名，${row.objectName || row.objectId || '未命名对象'}，实际值 ${formatEnergyBenchmarkNumber(row.actualValue)} ${analysisDefinition.value?.unit || ''}，${status.label}，差额 ${formatEnergyBenchmarkNumber(row.absoluteDifference)}，差距比例 ${formatEnergyBenchmarkRatio(row.differenceRatio)}`; }
/** 汇总预演问题。 */
function previewIssueText(issues = []) { return Array.isArray(issues) && issues.length ? issues.map((item) => `${item.message || item.code}${item.code ? `（${item.code}）` : ''}`).join('；') : '—'; }

/** 读取组织范围主数据；递增请求令牌阻止旧响应覆盖新上下文。 */
async function loadOrganizationMasterData() {
  const requestSnapshot = { permission: canViewOrganizationObjects.value };
  const token = latestRequestGuard.next('organization-master-data', requestSnapshot);
  organizationMasterDataLoading.value = true;
  organizationMasterDataStatus.value = 'loading';
  organizationMasterDataError.value = '';
  if (!requestSnapshot.permission) {
    if (!latestRequestGuard.isLatest(token, requestSnapshot)) return false;
    organizationUnits.value = [];
    clearOrganizationMasterDataSelections();
    organizationMasterDataLoading.value = false;
    organizationMasterDataStatus.value = 'permission';
    organizationMasterDataError.value = normalizeEnergyBenchmarkOrganizationAccessError(null, false);
    return false;
  }
  const result = await safe(getAllActiveEnergyBenchmarkOrganizationUnits);
  if (!latestRequestGuard.isLatest(token, requestSnapshot)) return false;
  organizationMasterDataLoading.value = false;
  if (!result.ok) {
    organizationUnits.value = [];
    clearOrganizationMasterDataSelections();
    organizationMasterDataStatus.value = Number(result.error?.response?.status) === 403 ? 'permission' : 'error';
    organizationMasterDataError.value = normalizeEnergyBenchmarkOrganizationAccessError(result.error, true);
    return false;
  }
  organizationUnits.value = (result.value.data || []).filter((item) => item.status === 'active');
  organizationMasterDataStatus.value = organizationUnits.value.length ? 'ready' : 'empty';
  if (!organizationUnits.value.length) clearOrganizationMasterDataSelections();
  return true;
}
/** 读取全部 active 产能单元；递增请求令牌阻止旧响应覆盖新上下文。 */
async function loadProductionMasterData() {
  const requestSnapshot = { permission: canViewProductionUnits.value };
  const token = latestRequestGuard.next('production-master-data', requestSnapshot);
  productionMasterDataLoading.value = true;
  productionMasterDataStatus.value = 'loading';
  productionMasterDataError.value = '';
  if (!requestSnapshot.permission) {
    if (!latestRequestGuard.isLatest(token, requestSnapshot)) return false;
    productionUnits.value = [];
    clearProductionMasterDataSelections();
    productionMasterDataLoading.value = false;
    productionMasterDataStatus.value = 'permission';
    productionMasterDataError.value = normalizeEnergyBenchmarkProductionAccessError(null, false);
    return false;
  }
  const result = await safe(getAllActiveEnergyBenchmarkProductionUnits);
  if (!latestRequestGuard.isLatest(token, requestSnapshot)) return false;
  productionMasterDataLoading.value = false;
  if (!result.ok) {
    productionUnits.value = [];
    clearProductionMasterDataSelections();
    productionMasterDataStatus.value = Number(result.error?.response?.status) === 403 ? 'permission' : 'error';
    productionMasterDataError.value = normalizeEnergyBenchmarkProductionAccessError(result.error, true);
    return false;
  }
  productionUnits.value = (result.value.data || []).filter((item) => item.status === 'active');
  productionMasterDataStatus.value = productionUnits.value.length ? 'ready' : 'empty';
  if (!productionUnits.value.length) clearProductionMasterDataSelections();
  return true;
}
/** 复用现有能源类型接口读取 active 能源主数据，并丢弃旧响应。 */
async function loadEnergyTypeMasterData() {
  const token = latestRequestGuard.next('energy-type-master-data');
  energyTypesLoading.value = true;
  energyTypesStatus.value = 'loading';
  energyTypesError.value = '';
  const result = await safe(getEnergyTypes);
  if (!latestRequestGuard.isLatest(token)) return false;
  energyTypesLoading.value = false;
  if (!result.ok) {
    energyTypes.value = [];
    clearEnergyTypeMasterDataSelections();
    energyTypesStatus.value = Number(result.error?.response?.status) === 403 ? 'permission' : 'error';
    energyTypesError.value = requestError(result, '读取能源类型主数据');
    return false;
  }
  energyTypes.value = (result.value.data || []).filter((item) => Number(item.isActive) === 1 || item.isActive === true);
  energyTypesStatus.value = energyTypes.value.length ? 'ready' : 'empty';
  if (!energyTypes.value.length) clearEnergyTypeMasterDataSelections();
  return true;
}
/** 每次按当前范围类型重新读取主数据，空数据不会自动选择首项。 */
async function refreshScopeMasterData(scopeType) {
  if (scopeType === 'organization') return loadOrganizationMasterData();
  if (scopeType === 'energy') return loadEnergyTypeMasterData();
  if (scopeType === 'product') return loadProductionMasterData();
  return true;
}
/** 切换普通定义范围类型，清空旧范围值和字段校验，不自动选择首项。 */
async function changeDefinitionScopeType(scopeType) {
  definitionForm.value = resetEnergyBenchmarkScopeSelection(definitionForm.value, scopeType);
  definitionFormError.value = '';
  definitionFormRef.value?.clearValidate(['scopeType', 'scopeReference']);
  await refreshScopeMasterData(scopeType);
}
/** 切换内部历史定义范围类型，清空旧范围值和字段校验，不自动选择首项。 */
async function changeInternalScopeType(scopeType) {
  internalForm.value = { ...internalForm.value, definition: resetEnergyBenchmarkScopeSelection(internalForm.value.definition, scopeType) };
  internalFormError.value = '';
  internalFormRef.value?.clearValidate(['definition.scopeType', 'definition.scopeReference']);
  await refreshScopeMasterData(scopeType);
}

/** 读取 bootstrap 维护态，并丢弃早于当前上下文的响应。 */
async function loadMaintenance() {
  const token = latestRequestGuard.next('maintenance');
  const result = await safe(getEnergyBenchmarkBootstrap);
  if (!latestRequestGuard.isLatest(token)) return;
  if (result.ok) {
    maintenance.value = projectEnergyBenchmarkMaintenance(result.value.data || {});
    clearPageRequestError(PAGE_ERROR_SOURCES.maintenance);
  } else presentRequestError(result, '读取维护态', { toast: false, source: PAGE_ERROR_SOURCES.maintenance });
}
/** 独立读取全部 active 定义；管理列表筛选和分页不会改变该数据源。 */
async function loadAnalysisDefinitions() {
  const token = latestRequestGuard.next('analysis-definitions');
  analysisDefinitionsLoading.value = true;
  const result = await safe(getAllActiveEnergyBenchmarkDefinitions);
  if (!latestRequestGuard.isLatest(token)) return;
  analysisDefinitionsLoading.value = false;
  if (!result.ok) {
    analysisDefinitions.value = [];
    applyAnalysisStateTransition({ type: 'active-definitions-failed', notice: '启用定义数据读取失败，旧定义、目标、实际对象、分析结果和导出上下文已清空。' });
    presentRequestError(result, '读取全部启用对标定义', { toast: false, source: PAGE_ERROR_SOURCES.analysisDefinitions });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.analysisDefinitions);
  analysisDefinitions.value = result.value.data || [];
  const effects = applyAnalysisStateTransition({
    type: 'active-definitions-loaded',
    definitions: analysisDefinitions.value,
    notice: '原对标定义已失效或停用，旧定义、目标、实际对象、分析结果和导出上下文已清空。'
  });
  for (const effect of effects) await selectDefaultAnalysisDefinition(effect.definitionId);
}
/** 查询管理列表当前分页，响应必须匹配发起时筛选和页码快照。 */
async function loadDefinitions() {
  const snapshot = { filters: definitionAppliedFilters.value, page: definitionPage.value, pageSize: definitionPageSize.value };
  const token = latestRequestGuard.next('definitions', snapshot);
  definitionsLoading.value = true;
  definitionsError.value = '';
  const result = await safe(() => getEnergyBenchmarkDefinitions(buildEnergyBenchmarkDefinitionFilters(snapshot.filters, snapshot)));
  if (!latestRequestGuard.isLatest(token, { filters: definitionAppliedFilters.value, page: definitionPage.value, pageSize: definitionPageSize.value })) return;
  definitionsLoading.value = false;
  if (!result.ok) { definitions.value = []; presentRequestError(result, '读取对标定义列表', { target: definitionsError, toast: false, source: PAGE_ERROR_SOURCES.definitions }); return; }
  clearPageRequestError(PAGE_ERROR_SOURCES.definitions);
  definitions.value = result.value.data || [];
  definitionPagination.value = { total: result.value.meta?.total || 0 };
}
/** 通过分析状态控制器登记管理视图变化，明确返回无分析副作用。 */
function preserveAnalysisForManagementViewChange() { applyAnalysisStateTransition({ type: 'management-view-changed' }); }
/** 应用定义管理筛选；管理列表视图变化不影响独立分析上下文。 */
function applyDefinitionFilters() { preserveAnalysisForManagementViewChange(); definitionAppliedFilters.value = { ...definitionDraftFilters.value }; definitionPage.value = 1; loadDefinitions(); }
/** 重置定义管理筛选；不清空仍然有效的分析结果。 */
function resetDefinitionFilters() { preserveAnalysisForManagementViewChange(); definitionDraftFilters.value = emptyDefinitionFilters(); definitionAppliedFilters.value = emptyDefinitionFilters(); definitionPage.value = 1; loadDefinitions(); }
/** 修改定义管理分页大小；不影响独立 active 定义数据源。 */
function changeDefinitionPageSize() { preserveAnalysisForManagementViewChange(); definitionPage.value = 1; loadDefinitions(); }

/** 查询目标管理列表，响应必须匹配发起时筛选和页码快照。 */
async function loadTargets() {
  const snapshot = { definitionId: targetDefinitionFilter.value, page: targetPage.value, pageSize: targetPageSize.value };
  const token = latestRequestGuard.next('targets', snapshot);
  targetsLoading.value = true;
  targetsError.value = '';
  const result = await safe(() => getEnergyBenchmarkTargets(buildEnergyBenchmarkTargetFilters({ definitionId: snapshot.definitionId }, snapshot)));
  if (!latestRequestGuard.isLatest(token, { definitionId: targetDefinitionFilter.value, page: targetPage.value, pageSize: targetPageSize.value })) return;
  targetsLoading.value = false;
  if (!result.ok) { targets.value = []; presentRequestError(result, '读取目标版本列表', { target: targetsError, toast: false }); return; }
  targets.value = result.value.data || [];
  targetPagination.value = { total: result.value.meta?.total || 0 };
}
/** 应用目标管理筛选；不影响分析选择器独立目标数据。 */
function applyTargetFilter() { preserveAnalysisForManagementViewChange(); targetPage.value = 1; loadTargets(); }
/** 切换定义管理分页；不清空分析结果。 */
function changeDefinitionPage() { preserveAnalysisForManagementViewChange(); loadDefinitions(); }
/** 切换目标管理分页；不清空分析结果。 */
function changeTargetPage() { preserveAnalysisForManagementViewChange(); loadTargets(); }
/** 修改目标管理分页大小；不清空分析结果。 */
function changeTargetPageSize() { preserveAnalysisForManagementViewChange(); targetPage.value = 1; loadTargets(); }

/** 判断当前是否确有旧评价、分析、导出结果或在途分析请求需要失效。 */
function hasAnalysisStateToInvalidate() {
  return Boolean(
    evaluationLoading.value
    || analysisLoading.value
    || exportLoading.value
    || singleEvaluation.value
    || rankingResult.value
    || qualificationResult.value
    || latestSuccessfulAnalysis.value
  );
}
/** 提取当前实际对象标识，用于颜色槽位增删协调。 */
function currentAnalysisEntityKeys(rows = actualRows.value) {
  return rows.map((row) => row.objectId || row.objectName || '').filter(Boolean);
}
/** 清空评价、排名、合格率和导出快照，并按失效来源决定协调或重建颜色。 */
function invalidateAnalysisResults(notice = '分析输入已变化，旧结果和导出上下文已清空。', source = 'analysis-input') {
  const invalidation = resolveEnergyBenchmarkAnalysisInvalidation(source, true);
  if (!invalidation.invalidate) return;
  const hadAnalysisState = hasAnalysisStateToInvalidate();
  latestRequestGuard.invalidate('evaluation');
  latestRequestGuard.invalidate('group-analysis');
  latestRequestGuard.invalidate('export');
  evaluationLoading.value = false;
  analysisLoading.value = false;
  exportLoading.value = false;
  singleEvaluation.value = null;
  rankingResult.value = null;
  qualificationResult.value = null;
  latestSuccessfulAnalysis.value = null;
  rankingTooltip.value = null;
  if (invalidation.resetColors) rankingColorRegistry.value = createRankingColorRegistry();
  else rankingColorRegistry.value.reconcile(currentAnalysisEntityKeys());
  clearPageRequestError(PAGE_ERROR_SOURCES.evaluation);
  clearPageRequestError(PAGE_ERROR_SOURCES.ranking);
  clearPageRequestError(PAGE_ERROR_SOURCES.qualification);
  clearPageRequestError(PAGE_ERROR_SOURCES.export);
  if (notice === '') analysisStaleNotice.value = '';
  else if (hadAnalysisState) analysisStaleNotice.value = notice;
}
/** 读取页面当前分析状态，供纯状态控制器计算下一状态。 */
function currentAnalysisControllerState() {
  return {
    definitionId: analysisDefinitionId.value,
    targetId: analysisTargetId.value,
    targets: analysisTargets.value,
    actualRows: actualRows.value,
    organizationObjects: organizationObjects.value,
    organizationError: organizationObjectsError.value,
    singleEvaluation: singleEvaluation.value,
    rankingResult: rankingResult.value,
    qualificationResult: qualificationResult.value,
    latestSuccessfulAnalysis: latestSuccessfulAnalysis.value,
    staleNotice: analysisStaleNotice.value
  };
}
/** 应用控制器返回的下一分析状态。 */
function applyAnalysisControllerState(state) {
  analysisDefinitionId.value = state.definitionId;
  analysisTargetId.value = state.targetId;
  analysisTargets.value = state.targets;
  actualRows.value = state.actualRows;
  organizationObjects.value = state.organizationObjects;
  organizationObjectsError.value = state.organizationError;
  singleEvaluation.value = state.singleEvaluation;
  rankingResult.value = state.rankingResult;
  qualificationResult.value = state.qualificationResult;
  latestSuccessfulAnalysis.value = state.latestSuccessfulAnalysis;
  analysisStaleNotice.value = state.staleNotice;
}
/** 执行纯控制器转换；请求失效副作用先执行，目标重新加载副作用交还调用方。 */
function applyAnalysisStateTransition(event) {
  const transition = transitionEnergyBenchmarkAnalysisState(currentAnalysisControllerState(), event);
  for (const effect of transition.effects.filter((item) => item.type === 'invalidate-analysis-requests')) {
    latestRequestGuard.invalidate('analysis-targets');
    latestRequestGuard.invalidate('organization-objects');
    analysisTargetsLoading.value = false;
    organizationObjectsLoading.value = false;
    invalidateAnalysisResults(event.notice || '', effect.source);
  }
  applyAnalysisControllerState(transition.nextState);
  return transition.effects.filter((item) => item.type === 'load-targets');
}
/** 选择默认分析定义。 */
async function selectDefaultAnalysisDefinition(definitionId) { analysisDefinitionId.value = definitionId; await changeAnalysisDefinition(); }
/** 读取全部 active 组织对象；缺少台账权限或接口 403 时只显示组织范围专属错误。 */
async function loadOrganizationObjects() {
  if (!canViewOrganizationObjects.value) {
    latestRequestGuard.invalidate('organization-objects');
    organizationObjectsLoading.value = false;
    organizationObjects.value = [];
    organizationObjectsError.value = normalizeEnergyBenchmarkOrganizationAccessError(null, false);
    return false;
  }
  const token = latestRequestGuard.next('organization-objects');
  organizationObjectsLoading.value = true;
  organizationObjectsError.value = '';
  const result = await safe(getAllActiveEnergyBenchmarkOrganizationUnits);
  if (!latestRequestGuard.isLatest(token)) return false;
  organizationObjectsLoading.value = false;
  if (!result.ok) {
    organizationObjects.value = [];
    organizationObjectsError.value = normalizeEnergyBenchmarkOrganizationAccessError(result.error, true);
    return false;
  }
  organizationObjects.value = result.value.data || [];
  organizationUnits.value = organizationObjects.value.filter((item) => item.status === 'active');
  organizationMasterDataError.value = '';
  organizationObjectsError.value = '';
  return true;
}
/** 切换分析定义并独立读取全部 active 目标版本和必要组织主数据。 */
async function changeAnalysisDefinition() {
  invalidateAnalysisResults('对标定义已变化，旧分析结果已清空。', 'definition-context');
  latestRequestGuard.invalidate('organization-objects');
  analysisTargetId.value = null;
  analysisTargets.value = [];
  actualRows.value = [];
  organizationObjects.value = [];
  organizationObjectsLoading.value = false;
  organizationObjectsError.value = '';
  clearPageRequestError(PAGE_ERROR_SOURCES.analysisTargets);
  const definition = analysisDefinition.value;
  if (!definition) return;
  const snapshot = { definitionId: definition.id };
  const token = latestRequestGuard.next('analysis-targets', snapshot);
  analysisTargetsLoading.value = true;
  const requests = [safe(() => getAllActiveEnergyBenchmarkTargets(definition.id))];
  if (definition.scopeType === 'organization') requests.push(loadOrganizationObjects());
  const [targetResult, organizationLoaded = true] = await Promise.all(requests);
  if (!latestRequestGuard.isLatest(token, { definitionId: analysisDefinitionId.value })) return;
  analysisTargetsLoading.value = false;
  if (!targetResult.ok) {
    presentRequestError(targetResult, '读取当前定义全部启用目标', { toast: false, source: PAGE_ERROR_SOURCES.analysisTargets });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.analysisTargets);
  analysisTargets.value = targetResult.value.data || [];
  const objectLevel = resolveEnergyBenchmarkDefinitionObjectLevel(definition, organizationObjects.value);
  actualRows.value = [createEnergyBenchmarkActualRow(definition, { objectLevel })];
  if (definition.scopeType === 'organization' && !organizationLoaded) return;
  analysisTargetId.value = activeAnalysisTargets.value.length === 1 ? activeAnalysisTargets.value[0].id : null;
  analysisStaleNotice.value = '';
}
/** 切换目标语义上下文并整体重建当前定义下的实体颜色槽位。 */
function changeAnalysisTarget() {
  invalidateAnalysisResults('目标版本已变化，请重新分析。', 'target-context');
}
/** 将组织选择项映射为真实编码、名称、范围标识和五级 unitType。 */
function selectOrganizationActual(row, unitCode) {
  const organization = compatibleOrganizationObjects.value.find((item) => item.unitCode === unitCode) || null;
  Object.assign(row, applyEnergyBenchmarkOrganizationSelection(row, organization));
}
/** 新增一个继承当前定义口径的空白实际对象，不预填演示业务数据。 */
function addActualRow() {
  if (!analysisDefinition.value || actualRows.value.length >= 100) return;
  actualRows.value.push(createEnergyBenchmarkActualRow(analysisDefinition.value, { objectLevel: analysisDefinitionObjectLevel.value }));
}
/** 移除实际值对象。 */
function removeActualRow(index) { if (actualRows.value.length > 1) actualRows.value.splice(index, 1); }
/** 打开实际值上下文编辑。 */
function openActualContext(row, index) { actualContextIndex.value = index; actualContextForm.value = { ...row }; actualContextOpen.value = true; }
/** 保存实际值兼容上下文，并在写回分析行前兜底校验严格 UTC 左闭右开周期。 */
function saveActualContext() {
  if (actualContextIndex.value < 0 || !actualContextForm.value) return;
  const rangeError = strictUtcRangeError(actualContextForm.value.periodStartUtc, actualContextForm.value.periodEndUtc, '实际值周期');
  if (rangeError) { ElMessage.error(rangeError); return; }
  actualRows.value[actualContextIndex.value] = { ...actualRows.value[actualContextIndex.value], ...actualContextForm.value };
  actualContextOpen.value = false;
}
/** 对首个实际值调用服务端三方向评价，旧响应不得覆盖新输入。 */
async function evaluateFirstActual() {
  if (!analysisReady.value || !canAnalyze.value) return;
  const signature = analysisInputSignature.value;
  const token = latestRequestGuard.next('evaluation', signature);
  evaluationLoading.value = true;
  const payload = buildEnergyBenchmarkEvaluationPayload(analysisDefinitionId.value, analysisTargetId.value, actualRows.value[0]);
  const result = await safe(() => evaluateEnergyBenchmark(payload));
  if (!latestRequestGuard.isLatest(token, analysisInputSignature.value)) return;
  evaluationLoading.value = false;
  if (!result.ok) {
    presentRequestError(result, '单对象评价', { toast: false, source: PAGE_ERROR_SOURCES.evaluation });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.evaluation);
  singleEvaluation.value = result.value.data?.result || null;
  analysisStaleNotice.value = '';
}
/** 并行计算服务端排名与合格率，并保存最近成功分析的不可变导出快照。 */
async function runGroupAnalysis() {
  if (!analysisReady.value || !canAnalyze.value) return;
  invalidateAnalysisResults('', 'analysis-run');
  const signature = analysisInputSignature.value;
  const payload = buildEnergyBenchmarkGroupPayload(analysisDefinitionId.value, analysisTargetId.value, actualRows.value);
  const token = latestRequestGuard.next('group-analysis', signature);
  analysisLoading.value = true;
  const [ranking, qualification] = await Promise.all([safe(() => rankEnergyBenchmarks(payload)), safe(() => getEnergyBenchmarkQualificationRate(payload))]);
  if (!latestRequestGuard.isLatest(token, analysisInputSignature.value)) return;
  analysisLoading.value = false;
  if (ranking.ok) clearPageRequestError(PAGE_ERROR_SOURCES.ranking);
  else presentRequestError(ranking, '对标排名', { toast: false, source: PAGE_ERROR_SOURCES.ranking });
  if (qualification.ok) clearPageRequestError(PAGE_ERROR_SOURCES.qualification);
  else presentRequestError(qualification, '对标合格率', { toast: false, source: PAGE_ERROR_SOURCES.qualification });
  if (!ranking.ok || !qualification.ok) return;
  rankingColorRegistry.value.reconcile(currentAnalysisEntityKeys(ranking.value.data?.ranked || []));
  rankingResult.value = ranking.value.data || null;
  qualificationResult.value = qualification.value.data || null;
  latestSuccessfulAnalysis.value = { signature, payload: JSON.parse(JSON.stringify(payload)) };
  analysisStaleNotice.value = '';
  ElMessage.success('排名与合格率已按兼容对象计算。');
}
/** 导出只能使用最近成功分析快照；输入变化或旧响应返回时禁止下载。 */
async function exportAnalysisCsv() {
  if (!canExportLatestAnalysis.value || !canExport.value) return;
  const analysisSnapshot = latestSuccessfulAnalysis.value;
  const token = latestRequestGuard.next('export', analysisSnapshot.signature);
  exportLoading.value = true;
  const result = await safe(() => getEnergyBenchmarkExportRows(analysisSnapshot.payload));
  if (!latestRequestGuard.isLatest(token, latestSuccessfulAnalysis.value?.signature) || analysisInputSignature.value !== analysisSnapshot.signature) return;
  exportLoading.value = false;
  if (!result.ok) {
    presentRequestError(result, '对标导出', { toast: false, source: PAGE_ERROR_SOURCES.export });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.export);
  const csv = buildEnergyBenchmarkCsv(result.value.data || {});
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `能效对标结果-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 打开普通定义创建抽屉，并按默认 organization 范围加载主数据。 */
function openCreateDefinition() { definitionMode.value = 'create'; editingDefinitionId.value = null; definitionForm.value = emptyDefinitionForm(); definitionFormError.value = ''; definitionDrawerOpen.value = true; refreshScopeMasterData(definitionForm.value.scopeType); }
/** 打开普通定义修改抽屉；历史值仅展示原值，不自动替换为任意 active 首项。 */
function openEditDefinition(row) { definitionMode.value = 'edit'; editingDefinitionId.value = row.id; definitionForm.value = { ...emptyDefinitionForm(), ...row, documentNo: row.documentNo || '' }; definitionFormError.value = ''; definitionDrawerOpen.value = true; refreshScopeMasterData(definitionForm.value.scopeType); }
/** 打开普通定义新版本创建抽屉；继承历史值但不静默替换。 */
function openDefinitionVersion(row) { definitionMode.value = 'version'; editingDefinitionId.value = null; definitionForm.value = { ...emptyDefinitionForm(), ...row, version: '', status: 'inactive', documentNo: row.documentNo || '' }; definitionFormError.value = ''; definitionDrawerOpen.value = true; refreshScopeMasterData(definitionForm.value.scopeType); }
/** 保存普通定义或新定义版本。 */
async function saveDefinition() {
  if (writeDisabled.value) return;
  const valid = await definitionFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  const scopeValidation = validateEnergyBenchmarkScopeSelection(definitionForm.value.scopeType, definitionForm.value.scopeReference, currentScopeSources());
  if (!scopeValidation.valid) { definitionFormError.value = scopeValidation.message; return; }
  const effectiveRangeError = strictUtcRangeError(definitionForm.value.effectiveStartUtc, definitionForm.value.effectiveEndUtc, '定义生效期');
  if (effectiveRangeError) { definitionFormError.value = effectiveRangeError; return; }
  if (definitionForm.value.benchmarkType === 'external_standard' && !String(definitionForm.value.documentNo || '').trim()) { definitionFormError.value = '外部标准必须填写真实文号。'; return; }
  let payload;
  try { payload = buildEnergyBenchmarkDefinitionPayload(definitionForm.value); }
  catch (error) { definitionFormError.value = error.message; return; }
  const snapshot = { mode: definitionMode.value, id: editingDefinitionId.value, payload };
  const token = latestRequestGuard.next('save-definition', snapshot);
  definitionSaving.value = true;
  definitionFormError.value = '';
  const result = await safe(() => snapshot.mode === 'edit' ? updateEnergyBenchmarkDefinition(snapshot.id, payload) : createEnergyBenchmarkDefinition(payload));
  let currentPayload;
  try { currentPayload = buildEnergyBenchmarkDefinitionPayload(definitionForm.value); }
  catch (_error) { return; }
  const currentSnapshot = { mode: definitionMode.value, id: editingDefinitionId.value, payload: currentPayload };
  if (!latestRequestGuard.isLatest(token, currentSnapshot)) return;
  definitionSaving.value = false;
  if (!result.ok) { definitionFormError.value = writeErrorText(result, '保存对标定义'); return; }
  definitionDrawerOpen.value = false;
  ElMessage.success(snapshot.mode === 'edit' ? '对标定义已修改。' : '对标定义版本已创建。');
  await Promise.all([loadDefinitions(), loadTargets(), loadAnalysisDefinitions()]);
}
/** 二次确认并切换定义状态。 */
async function confirmDefinitionStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active';
  const action = status === 'active' ? '启用' : '停用';
  try { await ElMessageBox.confirm(`${action}对标定义“${row.benchmarkName} · ${row.version}”？停用不是物理删除，历史版本和目标仍保留。`, `确认${action}`, { type: status === 'active' ? 'info' : 'warning' }); } catch { return; }
  const snapshot = { id: row.id, status };
  const token = latestRequestGuard.next('definition-status', snapshot);
  const result = await safe(() => updateEnergyBenchmarkDefinitionStatus(row.id, status));
  if (!latestRequestGuard.isLatest(token, snapshot)) return;
  if (!result.ok) {
    presentRequestError(result, `${action}对标定义`, { toast: false, source: PAGE_ERROR_SOURCES.definitionStatus });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.definitionStatus);
  ElMessage.success(`对标定义已${action}。`);
  await Promise.all([loadDefinitions(), loadAnalysisDefinitions()]);
}

/** 打开内部历史固化抽屉，并加载组织、产能和能源三类 active 主数据。 */
function openInternalHistory() { internalForm.value = emptyInternalForm(); internalFormError.value = ''; internalDrawerOpen.value = true; Promise.all([refreshScopeMasterData(internalForm.value.definition.scopeType), refreshScopeMasterData('product'), refreshScopeMasterData('energy')]); }
/** 仅提交定义、参考期和显式计算范围创建内部历史基准。 */
async function saveInternalHistory() {
  if (writeDisabled.value) return;
  const valid = await internalFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  const scopeValidation = validateEnergyBenchmarkScopeSelection(internalForm.value.definition.scopeType, internalForm.value.definition.scopeReference, currentScopeSources());
  const productionSelected = productionUnits.value.some((item) => Number(item.id) === Number(internalForm.value.calculationScope.productionUnitId));
  const energySelected = energyTypes.value.some((item) => item.code === internalForm.value.calculationScope.energyTypeCode);
  if (!scopeValidation.valid || !productionSelected || !energySelected) { internalFormError.value = scopeValidation.message || (!productionSelected ? '请选择当前可见的 active 产能单元。' : '请选择当前可见的 active 能源类型。'); return; }
  const effectiveRangeError = strictUtcRangeError(internalForm.value.definition.effectiveStartUtc, internalForm.value.definition.effectiveEndUtc, '定义生效期');
  if (effectiveRangeError) { internalFormError.value = effectiveRangeError; return; }
  const referenceRangeError = strictUtcRangeError(internalForm.value.referencePeriod.startUtc, internalForm.value.referencePeriod.endUtc, '历史参考期');
  if (referenceRangeError) { internalFormError.value = referenceRangeError; return; }
  let payload;
  try { payload = buildEnergyBenchmarkInternalHistoryPayload(internalForm.value); }
  catch (error) { internalFormError.value = error.message; return; }
  const token = latestRequestGuard.next('save-internal-history', payload);
  internalSaving.value = true;
  internalFormError.value = '';
  const result = await safe(() => createEnergyBenchmarkInternalHistory(payload));
  let currentPayload;
  try { currentPayload = buildEnergyBenchmarkInternalHistoryPayload(internalForm.value); }
  catch (_error) { return; }
  if (!latestRequestGuard.isLatest(token, currentPayload)) return;
  internalSaving.value = false;
  if (!result.ok) { internalFormError.value = writeErrorText(result, '固化内部历史基准'); return; }
  internalDrawerOpen.value = false;
  ElMessage.success('内部历史基准及固化目标已由服务端原子创建，不会随历史数据自动刷新。');
  await Promise.all([loadDefinitions(), loadTargets(), loadAnalysisDefinitions()]);
}

/** 打开普通目标创建抽屉。 */
function openCreateTarget(definition) { targetMode.value = 'create'; editingTargetId.value = null; targetDefinitionContext.value = definition; targetForm.value = { ...emptyTargetForm(), benchmarkDefinitionId: definition.id }; targetFormError.value = ''; targetDrawerOpen.value = true; }
/** 打开后继目标版本抽屉；定义不在当前分页时通过目标详情补齐上下文。 */
async function openVersionTarget(row) {
  const snapshot = { targetId: row.id, definitionId: row.benchmarkDefinitionId };
  const token = latestRequestGuard.next('target-version-context', snapshot);
  targetMode.value = 'version';
  editingTargetId.value = row.id;
  targetDefinitionContext.value = definitionById(row.benchmarkDefinitionId);
  clearPageRequestError(PAGE_ERROR_SOURCES.targetVersionContext);
  if (!targetDefinitionContext.value) {
    const detail = await safe(() => getEnergyBenchmarkTarget(row.id));
    if (!latestRequestGuard.isLatest(token, { targetId: editingTargetId.value, definitionId: row.benchmarkDefinitionId })) return;
    if (!detail.ok) {
      presentRequestError(detail, '读取目标定义上下文', { toast: false, source: PAGE_ERROR_SOURCES.targetVersionContext });
      return;
    }
    clearPageRequestError(PAGE_ERROR_SOURCES.targetVersionContext);
    targetDefinitionContext.value = detail.value.data?.definition || null;
  }
  targetForm.value = { ...emptyTargetForm(), benchmarkDefinitionId: row.benchmarkDefinitionId, targetValue: row.targetValue, lowerBound: row.lowerBound, upperBound: row.upperBound, version: '', status: row.status };
  targetFormError.value = '';
  targetDrawerOpen.value = true;
}
/** 保存普通目标或后继目标版本。 */
async function saveTarget() {
  if (writeDisabled.value) return;
  const valid = await targetFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  const definition = targetDefinition.value;
  if (!definition) { targetFormError.value = '当前页面未加载目标所属定义，请刷新定义列表后重试。'; return; }
  if (definition.direction === 'range' && (targetForm.value.lowerBound === null || targetForm.value.upperBound === null || Number(targetForm.value.lowerBound) > Number(targetForm.value.upperBound))) { targetFormError.value = '区间方向必须填写合法下限和上限，且下限不能大于上限。'; return; }
  if (definition.direction !== 'range' && targetForm.value.targetValue === null) { targetFormError.value = '当前方向必须填写目标值。'; return; }
  const mode = targetMode.value;
  const targetId = editingTargetId.value;
  const payload = buildEnergyBenchmarkTargetPayload(targetForm.value, mode === 'create');
  const snapshot = { mode, targetId, payload };
  const token = latestRequestGuard.next('save-target', snapshot);
  targetSaving.value = true;
  targetFormError.value = '';
  const result = await safe(() => mode === 'version' ? versionEnergyBenchmarkTarget(targetId, payload) : createEnergyBenchmarkTarget(payload));
  const currentSnapshot = { mode: targetMode.value, targetId: editingTargetId.value, payload: buildEnergyBenchmarkTargetPayload(targetForm.value, targetMode.value === 'create') };
  if (!latestRequestGuard.isLatest(token, currentSnapshot)) return;
  targetSaving.value = false;
  if (!result.ok) { targetFormError.value = writeErrorText(result, '保存目标版本'); return; }
  targetDrawerOpen.value = false;
  ElMessage.success(mode === 'version' ? '后继目标版本已创建，旧版本继续保留。' : '目标版本已创建。');
  await Promise.all([loadTargets(), loadAnalysisDefinitions()]);
  if (Number(analysisDefinitionId.value) === Number(definition.id)) await changeAnalysisDefinition();
}
/** 二次确认并切换目标状态。 */
async function confirmTargetStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active';
  const action = status === 'active' ? '启用' : '停用';
  try { await ElMessageBox.confirm(`${action}目标版本“${row.version}”？同一定义只能有一个 active 目标，服务端会执行最终冲突校验。`, `确认${action}`, { type: status === 'active' ? 'info' : 'warning' }); } catch { return; }
  const snapshot = { id: row.id, status };
  const token = latestRequestGuard.next('target-status', snapshot);
  const result = await safe(() => updateEnergyBenchmarkTargetStatus(row.id, status));
  if (!latestRequestGuard.isLatest(token, snapshot)) return;
  if (!result.ok) {
    presentRequestError(result, `${action}目标版本`, { toast: false, source: PAGE_ERROR_SOURCES.targetStatus });
    return;
  }
  clearPageRequestError(PAGE_ERROR_SOURCES.targetStatus);
  ElMessage.success(`目标版本已${action}。`);
  await loadTargets();
  if (Number(analysisDefinitionId.value) === Number(row.benchmarkDefinitionId)) await changeAnalysisDefinition();
}

/** 打开定义详情。 */
async function openDefinitionDetail(row) {
  const snapshot = { kind: 'definition', id: row.id };
  const token = latestRequestGuard.next('detail', snapshot);
  detailKind.value = 'definition'; detailOpen.value = true; detailData.value = null; detailLoading.value = true; detailError.value = '';
  const result = await safe(() => getEnergyBenchmarkDefinition(row.id));
  if (!latestRequestGuard.isLatest(token, { kind: detailKind.value, id: row.id })) return;
  detailLoading.value = false;
  if (!result.ok) { presentRequestError(result, '读取对标定义详情', { target: detailError, toast: false }); return; }
  detailData.value = result.value.data || null;
}
/** 打开目标详情。 */
async function openTargetDetail(row) {
  const snapshot = { kind: 'target', id: row.id };
  const token = latestRequestGuard.next('detail', snapshot);
  detailKind.value = 'target'; detailOpen.value = true; detailData.value = null; detailLoading.value = true; detailError.value = '';
  const result = await safe(() => getEnergyBenchmarkTarget(row.id));
  if (!latestRequestGuard.isLatest(token, { kind: detailKind.value, id: row.id })) return;
  detailLoading.value = false;
  if (!result.ok) { presentRequestError(result, '读取对标目标详情', { target: detailError, toast: false }); return; }
  detailData.value = result.value.data || null;
}
/** 构造详情描述项。 */
function buildDetailDescriptions(data, kind) { if (!data) return []; if (kind === 'definition') return [{ label: '编码', value: data.benchmarkCode }, { label: '名称', value: data.benchmarkName }, { label: '类型', value: ENERGY_BENCHMARK_TYPE_LABELS[data.benchmarkType] || data.benchmarkType }, { label: '指标', value: `${data.metricCode} / ${data.unit}` }, { label: '方向', value: ENERGY_BENCHMARK_DIRECTION_LABELS[data.direction] || data.direction }, { label: '周期', value: data.periodType }, { label: '范围', value: `${ENERGY_BENCHMARK_SCOPE_LABELS[data.scopeType] || data.scopeType} / ${data.scopeReference}` }, { label: '来源', value: data.source }, { label: '文号', value: data.documentNo || '—' }, { label: '版本', value: data.version }, { label: '有效期', value: `${data.effectiveStartUtc} → ${data.effectiveEndUtc}` }, { label: '状态', value: data.status }]; return [{ label: '目标 ID', value: data.id }, { label: '定义', value: `${data.definition?.benchmarkName || data.benchmarkDefinitionId} · ${data.definition?.version || ''}` }, { label: '目标 / 边界', value: targetValueLabel(data, data.definition) }, { label: '版本', value: data.version }, { label: '状态', value: data.status }, { label: '是否固化', value: data.isFrozen ? '是' : '否' }, { label: '是否自动刷新', value: data.autoRefresh ? '是' : '否' }, { label: '参考期', value: data.referenceStartUtc ? `${data.referenceStartUtc} → ${data.referenceEndUtc}` : '—' }, { label: '固化值', value: formatEnergyBenchmarkNumber(data.frozenValue) }, { label: '样本数', value: formatInteger(data.sampleCount) }, { label: '来源数据摘要', value: data.sourceDataDigest || '—' }, { label: '固化时间', value: data.frozenAt || '—' }]; }

/** 下载当前类型空白 XLSX 模板，不自动进入预演。 */
async function downloadImportTemplate() { importTemplateLoading.value = true; const result = await safe(() => downloadEnergyBenchmarkImportTemplate(importType.value)); importTemplateLoading.value = false; if (!result.ok) ElMessage.error(`能效对标模板下载失败：${writeErrorText(result, '下载模板')}`); }
/** 下载当前类型青岚园区 XLSX 示例，不自动导入或执行对标。 */
async function downloadImportDemoExample() { importDemoExampleLoading.value = true; const result = await safe(() => downloadEnergyBenchmarkDemoParkExample(importType.value)); importDemoExampleLoading.value = false; if (!result.ok) ElMessage.error(`青岚园区示例下载失败：${writeErrorText(result, '下载示例')}`); }

/** 保存用户选择的导入文件并清空旧预演。 */
function selectImportFile(file) { latestRequestGuard.invalidate('import-preview'); latestRequestGuard.invalidate('import-execute'); importPreviewLoading.value = false; importExecuteLoading.value = false; importFile.value = file.raw || null; importPreview.value = null; importError.value = ''; }
/** 清空导入文件与预演。 */
function clearImportFile() { latestRequestGuard.invalidate('import-preview'); latestRequestGuard.invalidate('import-execute'); importPreviewLoading.value = false; importExecuteLoading.value = false; importFile.value = null; importPreview.value = null; }
/** 调用当前导入类型的服务端预演，文件或类型变化后旧响应必须丢弃。 */
async function previewImport() {
  if (!importFile.value || !canImportPreview.value || writeDisabled.value) return;
  const fileSnapshot = { type: importType.value, name: importFile.value.name, size: importFile.value.size, lastModified: importFile.value.lastModified };
  const token = latestRequestGuard.next('import-preview', fileSnapshot);
  importPreviewLoading.value = true;
  importError.value = '';
  const result = await safe(() => previewEnergyBenchmarkImport(fileSnapshot.type, importFile.value));
  const currentFileSnapshot = importFile.value ? { type: importType.value, name: importFile.value.name, size: importFile.value.size, lastModified: importFile.value.lastModified } : null;
  if (!latestRequestGuard.isLatest(token, currentFileSnapshot)) return;
  importPreviewLoading.value = false;
  if (!result.ok) { importPreview.value = null; importError.value = writeErrorText(result, '导入预演'); return; }
  importPreview.value = result.value.data || null;
  ElMessage.success('导入预演已完成，请核对候选、跳过、阻断和 warning。');
}
/** 打开导入执行确认。 */
function openImportExecute() { importConfirmText.value = ''; importExecuteError.value = ''; importExecuteOpen.value = true; }
/** 使用最小批次确认载荷执行导入，执行上下文变化后旧响应不得覆盖页面。 */
async function executeImport() {
  if (!canImportExecute.value || writeDisabled.value || !canExecuteEnergyBenchmarkImport(importPreview.value) || importConfirmText.value !== importPreview.value?.confirmText) return;
  const payload = buildEnergyBenchmarkImportExecutePayload(importPreview.value, importConfirmText.value);
  const snapshot = { type: importType.value, batchId: payload.batchId, confirmText: payload.confirmText };
  const token = latestRequestGuard.next('import-execute', snapshot);
  importExecuteLoading.value = true;
  importExecuteError.value = '';
  const result = await safe(() => executeEnergyBenchmarkImport(snapshot.type, payload));
  const currentSnapshot = { type: importType.value, batchId: importPreview.value?.batchId ?? null, confirmText: importConfirmText.value };
  if (!latestRequestGuard.isLatest(token, currentSnapshot)) return;
  importExecuteLoading.value = false;
  if (!result.ok) { importExecuteError.value = writeErrorText(result, '执行导入'); return; }
  importExecuteOpen.value = false;
  ElMessage.success(`导入完成：成功 ${formatInteger(result.value.data?.imported)} 条，跳过 ${formatInteger(result.value.data?.skipped)} 条。`);
  importPreview.value = null;
  importFile.value = null;
  await Promise.all([loadDefinitions(), loadTargets(), loadAnalysisDefinitions()]);
}

// 实际对象输入变化只协调实体颜色；定义和目标语义变化由各自处理函数整体重建颜色。
watch(analysisActualSignature, (current, previous) => {
  const invalidation = resolveEnergyBenchmarkAnalysisInvalidation('analysis-input', current !== previous);
  if (invalidation.invalidate) invalidateAnalysisResults();
});
// 切换导入类型时旧文件预演上下文失效，禁止跨类型执行。
watch(importType, () => { latestRequestGuard.invalidate('import-preview'); latestRequestGuard.invalidate('import-execute'); importPreviewLoading.value = false; importExecuteLoading.value = false; importPreview.value = null; importError.value = ''; });

onMounted(async () => { if (!canView.value) return; await Promise.all([loadMaintenance(), loadDefinitions(), loadTargets(), loadAnalysisDefinitions(), loadEnergyTypeMasterData()]); });
</script>

<style scoped>
.benchmark-tabs{min-width:0}.page-card{margin-bottom:16px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}.section-heading h2,.detail-subtitle{margin:0;color:#123b79;font-size:16px}.section-heading p,.drawer-notice{margin:5px 0 0;color:#7385a2;font-size:13px;line-height:1.65}.action-row{display:flex;flex-wrap:wrap;gap:8px}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}.analysis-config-card{min-width:0}.analysis-selector{margin-bottom:10px}.actual-table{margin-top:14px}.full-control{width:100%}.context-summary{color:#516170;font-size:12px;line-height:1.6}.chart-panel{min-width:0}.viz-root{color-scheme:light;--benchmark-series-1:#2a78d6;--benchmark-series-2:#eb6834;--benchmark-series-3:#1baf7a;--benchmark-series-4:#eda100;--benchmark-series-5:#e87ba4;--benchmark-series-6:#008300;--benchmark-series-7:#4a3aa7;--benchmark-series-8:#e34948}.ranking-legend{display:flex;flex-wrap:wrap;gap:8px 14px;margin-bottom:12px;color:#516170;font-size:12px}.ranking-legend span,.rank-name{display:inline-flex;align-items:center;gap:6px}.ranking-legend i,.rank-name i{width:10px;height:10px;flex:0 0 10px;border:1px solid rgba(11,11,11,.12);border-radius:2px}.ranking-chart{display:grid;gap:8px}.ranking-row{display:grid;grid-template-columns:70px minmax(120px,1fr) minmax(180px,2fr) minmax(105px,.8fr) 90px;align-items:center;gap:10px;width:100%;padding:7px;color:#183153;text-align:left;background:transparent;border:0;border-radius:8px}.ranking-row:hover{background:#f7fbff}.ranking-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.rank-number{font-weight:700;color:#155bc2}.rank-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rank-track{height:14px;padding-right:2px;background:#e7f1ff;border-radius:999px}.rank-track i{display:block;height:14px;border-right:2px solid #fff;border-radius:0 999px 999px 0}.rank-value{color:#516170;font-size:12px;text-align:right}.chart-tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px}.equivalent-table{margin-top:12px}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.drawer-alert{margin-bottom:12px}.detail-subtitle{margin:18px 0 10px}.import-card{max-width:1100px}.import-form{margin-top:16px}.preview-summary{display:flex;flex-wrap:wrap;gap:10px 18px;margin:18px 0;color:#516170;font-size:13px}.execute-button{margin-top:16px}.context-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;margin-top:16px}@media (max-width:1120px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ranking-row{grid-template-columns:70px minmax(110px,1fr) minmax(150px,2fr) 100px}.ranking-row :deep(.el-tag){grid-column:2 / -1;justify-self:start}}@media (max-width:720px){.stat-grid{grid-template-columns:1fr}.section-heading{align-items:flex-start;flex-direction:column}.ranking-row{grid-template-columns:1fr}.rank-value{text-align:left}.context-form{grid-template-columns:1fr}.analysis-selector :deep(.el-form-item){margin-right:0;width:100%}.analysis-selector :deep(.el-select){width:100%}}
</style>
