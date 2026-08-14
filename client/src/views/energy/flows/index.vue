<template>
  <ManagementPage title="能流分析">
    <template #title-extra>
      <HelpIcon label="查看能流分析口径" content="能流只使用显式模型、节点、方向边、坐标和来源映射，不从组织树或表计位置推导拓扑。发电量、自发自用量、上网电量必须显式选择，不自动抵扣能耗或碳排；节点差额不自动命名为损耗。" />
    </template>

    <PageState v-if="!canView" description="当前账号没有 energy:flows:view 权限，请联系管理员授权。" />
    <template v-else>
      <el-alert type="info" :closable="false" show-icon title="读取模型、拓扑和分析在维护态仍可用；新增、修改、启停和导入会由后端维护态校验阻断。" />

      <ManagementToolbar :loading="modelLoading" @search="applyModelFilters" @reset="resetModelFilters">
        <el-form-item label="状态">
          <el-select v-model="modelDraft.status" clearable placeholder="全部状态">
            <el-option label="启用" value="active" /><el-option label="停用" value="inactive" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型编码"><el-input v-model.trim="modelDraft.modelCode" clearable placeholder="精确编码" /></el-form-item>
        <el-form-item label="版本"><el-input v-model.trim="modelDraft.version" clearable placeholder="精确版本" /></el-form-item>
        <el-form-item label="字符搜索"><el-input v-model.trim="modelDraft.keyword" clearable placeholder="名称、来源或文号" /></el-form-item>
        <template #actions>
          <el-button v-if="canManage" type="primary" @click="openModelCreate">新增模型版本</el-button>
        </template>
      </ManagementToolbar>

      <el-alert v-if="organizationUnitsLoading && !organizationUnitsLoaded" class="section-alert" type="info" :closable="false" show-icon title="正在读取全部组织依赖；完成前组织追溯下拉暂不可用。" />
      <el-alert v-if="energyTypesLoading && !energyTypesLoaded" class="section-alert" type="info" :closable="false" show-icon title="正在读取能源类型；完成前新增边和能源选择暂不可用。" />
      <div v-if="organizationUnitsError" class="dependency-error">
        <el-alert type="error" :closable="false" show-icon :title="organizationUnitsError" />
        <el-button :loading="organizationUnitsLoading" @click="loadOrganizationUnits">重试组织依赖</el-button>
      </div>
      <div v-if="energyTypesError" class="dependency-error">
        <el-alert type="error" :closable="false" show-icon :title="energyTypesError" />
        <el-button :loading="energyTypesLoading" @click="loadEnergyTypes">重试能源类型</el-button>
      </div>
      <el-alert v-if="organizationUnitsLoaded && !organizationUnitsError && !organizationUnits.length" class="section-alert" type="info" :closable="false" show-icon title="当前没有可选组织依赖；节点仍可维护，但不能补充组织追溯关联。" />
      <el-alert v-if="energyTypesLoaded && !energyTypesError && !energyTypes.length" class="section-alert" type="warning" :closable="false" show-icon title="当前没有 active 能源类型；拓扑可只读查看，但新增边和储能能源选择不可用。" />
      <article class="page-card">
        <header class="section-heading"><div><h2>模型与版本</h2><span>模型编码 + 版本形成不可覆盖的追溯身份</span></div></header>
        <PageState v-if="modelLoading" loading />
        <div v-else-if="modelListError" class="state-error">
          <el-alert type="error" :closable="false" show-icon :title="modelListError" />
          <el-button @click="loadModels">重试模型列表</el-button>
        </div>
        <PageState v-else-if="!models.length" description="暂无能流模型，请先维护显式模型版本。" />
        <template v-else>
          <div class="table-scroll">
            <el-table :data="models" stripe highlight-current-row @current-change="selectModel">
              <el-table-column prop="modelCode" label="模型编码" min-width="145" />
              <el-table-column prop="modelName" label="模型名称" min-width="170" />
              <el-table-column prop="version" label="版本" min-width="110" />
              <el-table-column prop="sourceTimeZone" label="来源时区" min-width="135" />
              <el-table-column label="有效期" min-width="250"><template #default="{ row }">{{ row.effectiveStartUtc }} 至 {{ row.effectiveEndUtc }}</template></el-table-column>
              <el-table-column label="节点 / 边 / 边值" min-width="135"><template #default="{ row }">{{ row.nodeCount }} / {{ row.edgeCount }} / {{ row.recordCount }}</template></el-table-column>
              <el-table-column label="状态" min-width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
              <el-table-column label="操作" fixed="right" min-width="245"><template #default="{ row }">
                <el-button link type="primary" @click.stop="selectModel(row)">查看</el-button>
                <el-button v-if="canManage" link type="primary" @click.stop="openModelEdit(row)">修改名称</el-button>
                <el-button v-if="canManage" link type="primary" @click.stop="openNewVersion(row)">新建版本</el-button>
                <el-button v-if="canManage" link :type="row.status === 'active' ? 'warning' : 'success'" @click.stop="toggleModelStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
              </template></el-table-column>
            </el-table>
          </div>
          <div class="pagination"><el-pagination v-model:current-page="modelPage" v-model:page-size="modelPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="modelPagination.total || 0" @current-change="loadModels" @size-change="changeModelPageSize" /></div>
        </template>
      </article>

      <article class="page-card import-workspace">
        <header class="section-heading"><div><h2>能流模型与拓扑导入</h2><span>依赖顺序：1 模型 → 2 节点 → 3 边 → 4 显式边值</span></div></header>
        <el-alert v-if="!canImportPreview" type="info" :closable="false" show-icon title="当前账号没有 energy:flows:import:preview 权限。" />
        <template v-else>
          <div class="import-dependency-list">
            <div v-for="definition in flowImportDownloads" :key="definition.key" class="import-dependency-row">
              <span><strong>{{ definition.order }}. {{ definition.label }}</strong>：{{ definition.description }}</span>
              <div class="action-row"><el-button @click="downloadFlowTemplate(definition)">空白模板</el-button><el-button @click="downloadFlowDemo(definition)">青岚示例</el-button></div>
            </div>
          </div>
          <section class="import-grid">
            <article class="page-card import-card">
              <header class="section-heading"><div><h2>模型导入</h2><span>XLSX 或 CSV；空库可直接预演</span></div></header>
              <p>模型身份固定为模型编码 + 版本；完全重复按 skip，身份冲突阻断，active 新版本会在 execute 事务内切换。</p>
              <el-upload :auto-upload="false" :limit="1" accept=".xlsx,.csv" :disabled="importExecuteLoading" :file-list="modelImportFileList" :on-change="(file) => selectImportFile('model', file)" :on-remove="() => clearImportSelection('model')"><el-button :disabled="importExecuteLoading">选择模型文件</el-button></el-upload>
              <el-button type="primary" :disabled="!modelImportFile || importExecuteLoading" :loading="modelImportLoading" @click="previewModelImport">运行模型预演</el-button>
              <ImportPreviewTable v-if="modelImportPreview" :preview="modelImportPreview" />
              <el-button v-if="canImportExecute" type="danger" :disabled="!canExecuteModelPreview" @click="openImportExecute('model')">执行模型导入</el-button>
            </article>

            <article class="page-card import-card">
              <header class="section-heading"><div><h2>节点导入</h2><span>XLSX 或 CSV；只绑定已存在 active 模型</span></div></header>
              <p>preview 不写节点；execute 使用预演签名、候选行、固定确认文本、跳过风险确认和自动备份。</p>
              <el-upload :auto-upload="false" :limit="1" accept=".xlsx,.csv" :disabled="importExecuteLoading" :file-list="nodeImportFileList" :on-change="(file) => selectImportFile('node', file)" :on-remove="() => clearImportSelection('node')"><el-button :disabled="importExecuteLoading">选择节点文件</el-button></el-upload>
              <el-button type="primary" :disabled="!nodeImportFile || importExecuteLoading" :loading="nodeImportLoading" @click="previewNodeImport">运行节点预演</el-button>
              <ImportPreviewTable v-if="nodeImportPreview" :preview="nodeImportPreview" />
              <el-button v-if="canImportExecute" type="danger" :disabled="!canExecuteNodePreview" @click="openImportExecute('node')">执行节点导入</el-button>
            </article>

            <article class="page-card import-card">
              <header class="section-heading"><div><h2>边与显式边值导入</h2><span>必须使用包含“能流边”和“显式边值”的 XLSX</span></div></header>
              <p>双工作表预演分别创建边批次和边值批次；执行只提交批次 ID 和确认字段，候选与签名由服务端恢复。</p>
              <el-upload :auto-upload="false" :limit="1" accept=".xlsx" :disabled="importExecuteLoading" :file-list="bundleImportFileList" :on-change="(file) => selectImportFile('bundle', file)" :on-remove="() => clearImportSelection('bundle')"><el-button :disabled="importExecuteLoading">选择双工作表文件</el-button></el-upload>
              <el-button type="primary" :disabled="!bundleImportFile || importExecuteLoading" :loading="bundleImportLoading" @click="previewBundleImport">运行边与边值预演</el-button>
              <template v-if="bundleImportPreview"><ImportPreviewTable title="能流边预演" :preview="bundleImportPreview.edgePreview" /><ImportPreviewTable title="显式边值预演" :preview="bundleImportPreview.recordPreview" /></template>
              <el-button v-if="canImportExecute" type="danger" :disabled="!canExecuteBundlePreview" @click="openImportExecute('bundle')">执行边与显式边值导入</el-button>
            </article>
          </section>
          <el-alert v-if="importError" type="error" :closable="false" show-icon :title="importError" />
        </template>
      </article>

      <template v-if="selectedModel">
        <PageState v-if="modelSelectionLoading" loading description="正在读取所选模型详情、完整拓扑及全部节点和边。" />
        <div v-else-if="modelSelectionError" class="state-error">
          <el-alert type="error" :closable="false" show-icon :title="modelSelectionError" />
          <el-button @click="retrySelectedModel">重试当前模型</el-button>
        </div>
        <template v-else-if="modelSelectionReady">
        <section class="stat-grid" aria-label="当前能流模型摘要">
          <StatCard label="当前模型" :value="selectedModel.modelName" :note="`${selectedModel.modelCode} / ${selectedModel.version}`" />
          <StatCard label="显式节点" :value="String(topology.nodes.length)" note="不从组织树推导" />
          <StatCard label="方向边" :value="String(topology.edges.length)" note="来源映射逐边维护" />
          <StatCard label="拓扑质量" :value="topology.quality?.complete ? '完整' : '待处理'" :note="`异常 ${topology.quality?.anomalyCount || 0} 项`" />
        </section>

        <el-tabs v-model="activeTab" class="flow-tabs">
          <el-tab-pane label="拓扑与维护" name="topology">
            <el-alert v-if="topology.quality?.anomalies?.length" type="warning" :closable="false" show-icon title="当前拓扑存在未映射、单位不可比、孤立节点或端点异常；请结合下方节点/边表修正。" />
            <EnergyFlowTopology :topology="topology" :edge-values="analysisResultDirty ? [] : analysisResult?.edgeValues || []" :color-domain="energyTypeColorDomain" :standard-coal-view="analysisFilters.standardCoalView" />

            <section class="maintenance-grid">
              <article class="page-card maintenance-card">
                <header class="section-heading"><div><h2>节点维护</h2><span>显式坐标决定 SVG 位置</span></div><el-button v-if="canManage" type="primary" @click="openNodeCreate">新增节点</el-button></header>
                <PageState v-if="!nodes.length" description="当前模型已加载，暂无显式节点。" />
                <div v-else class="table-scroll"><el-table :data="nodes" size="small" stripe>
                  <el-table-column prop="nodeCode" label="编码" min-width="110" />
                  <el-table-column prop="nodeName" label="名称" min-width="130" />
                  <el-table-column label="类型" min-width="90"><template #default="{ row }">{{ nodeTypeLabel(row.nodeType) }}</template></el-table-column>
                  <el-table-column label="坐标" min-width="100"><template #default="{ row }">{{ row.x }}, {{ row.y }}</template></el-table-column>
                  <el-table-column label="状态" min-width="80"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
                  <el-table-column v-if="canManage" label="操作" min-width="135"><template #default="{ row }"><el-button link type="primary" @click="openNodeEdit(row)">编辑</el-button><el-button link :type="row.status === 'active' ? 'warning' : 'success'" @click="toggleNodeStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
                </el-table></div>
              </article>

              <article class="page-card maintenance-card">
                <header class="section-heading"><div><h2>方向边与来源</h2><span>边值存在后冻结物理端点、能源、单位和来源绑定</span></div><el-button v-if="canManage" type="primary" :disabled="activeNodes.length < 2 || !energyTypes.length" @click="openEdgeCreate">新增边</el-button></header>
                <el-alert v-if="activeNodes.length < 2" type="warning" :closable="false" show-icon title="至少需要两个 active 显式节点才能新增方向边。" />
                <PageState v-if="!edges.length" description="当前模型已加载，暂无显式方向边。" />
                <div v-else class="table-scroll"><el-table :data="edges" size="small" stripe>
                  <el-table-column prop="edgeCode" label="边编码" min-width="115" />
                  <el-table-column label="方向" min-width="180"><template #default="{ row }">{{ row.fromNodeName }} → {{ row.toNodeName }}</template></el-table-column>
                  <el-table-column label="能源 / 单位" min-width="130"><template #default="{ row }">{{ row.energyTypeName || row.energyTypeCode }} / {{ row.unit }}</template></el-table-column>
                  <el-table-column label="显式来源" min-width="290" show-overflow-tooltip><template #default="{ row }">{{ sourceSummary(row) }}</template></el-table-column>
                  <el-table-column label="边值" min-width="75"><template #default="{ row }">{{ row.recordCount || 0 }}</template></el-table-column>
                  <el-table-column label="状态" min-width="80"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
                  <el-table-column v-if="canManage" label="操作" min-width="135"><template #default="{ row }"><el-button link type="primary" @click="openEdgeEdit(row)">编辑</el-button><el-button link :type="row.status === 'active' ? 'warning' : 'success'" @click="toggleEdgeStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
                </el-table></div>
              </article>
            </section>
          </el-tab-pane>

          <el-tab-pane label="流量与差额分析" name="analysis">
            <article class="page-card analysis-card">
              <header class="section-heading"><div><h2>分析筛选</h2><span>来源时区 {{ selectedModel.sourceTimeZone }}；范围必须位于模型有效期内</span></div><el-button type="primary" :loading="analysisLoading" @click="runAnalysis">运行分析</el-button></header>
              <el-form class="analysis-filters" label-position="top">
                <el-form-item label="统计期类型"><el-radio-group v-model="analysisFilters.rangeMode"><el-radio-button label="month">月份</el-radio-button><el-radio-button label="utc">UTC 区间</el-radio-button></el-radio-group></el-form-item>
                <template v-if="analysisFilters.rangeMode === 'month'">
                  <el-form-item label="开始月份"><el-date-picker v-model="analysisFilters.startMonth" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" /></el-form-item>
                  <el-form-item label="结束月份"><el-date-picker v-model="analysisFilters.endMonth" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" /></el-form-item>
                </template>
                <template v-else>
                  <el-form-item label="开始 UTC"><StrictUtcDateTimeInput v-model="analysisFilters.startUtc" placeholder="2026-01-01T00:00:00Z" /></el-form-item>
                  <el-form-item label="结束 UTC"><StrictUtcDateTimeInput v-model="analysisFilters.endUtc" placeholder="2026-02-01T00:00:00Z" /></el-form-item>
                </template>
                <el-form-item label="来源时区"><el-input :model-value="selectedModel.sourceTimeZone" disabled /></el-form-item>
                <el-form-item label="展示视图"><el-radio-group v-model="analysisFilters.standardCoalView"><el-radio-button label="original">原单位</el-radio-button><el-radio-button label="kgce">kgce</el-radio-button><el-radio-button label="tce">tce</el-radio-button></el-radio-group></el-form-item>
              </el-form>
              <el-alert type="info" :closable="false" show-icon title="原单位始终按能源类型和单位分面；折标视图仅在覆盖期存在唯一有效系数时显示，不能用折标掩盖原单位不可比。" />
            </article>

            <article class="page-card">
              <header class="section-heading"><div><h2>显式储能变化</h2><span>储能节点不会自动推断库存变化</span></div><el-button :disabled="!storageNodes.length" @click="addStorageChange">新增储能变化</el-button></header>
              <el-alert v-if="!storageNodes.length" type="info" :closable="false" show-icon title="当前模型没有 active 储能节点，无需填写储能变化。" />
              <el-alert v-else-if="!storageChanges.length" type="warning" :closable="false" show-icon title="当前模型包含储能节点；未提供显式储能变化时，对应节点分面会标记为未映射。" />
              <PageState v-if="!storageChanges.length" description="未填写储能变化；非储能节点按 0 处理，储能节点保持未映射。" />
              <div v-else class="table-scroll"><el-table :data="storageChanges" size="small">
                <el-table-column label="储能节点" min-width="160"><template #default="{ row }"><el-select v-model="row.nodeId" placeholder="选择储能节点"><el-option v-for="node in storageNodes" :key="node.id" :label="`${node.nodeName}（${node.nodeCode}）`" :value="node.id" /></el-select></template></el-table-column>
                <el-table-column label="能源类型" min-width="150"><template #default="{ row }"><el-select v-model="row.energyTypeCode" filterable allow-create placeholder="能源编码"><el-option v-for="item in energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></template></el-table-column>
                <el-table-column label="单位" min-width="110"><template #default="{ row }"><el-input v-model.trim="row.unit" /></template></el-table-column>
                <el-table-column label="变化值" min-width="130"><template #default="{ row }"><el-input-number v-model="row.value" controls-position="right" placeholder="请显式输入，0 需手填" /></template></el-table-column>
                <el-table-column label="来源标识" min-width="210"><template #default="{ row }"><el-input v-model.trim="row.sourceMapping.reference" placeholder="必填，可追溯" /></template></el-table-column>
                <el-table-column label="操作" width="75"><template #default="{ $index }"><el-button link type="danger" @click="removeStorageChange($index)">移除</el-button></template></el-table-column>
              </el-table></div>
            </article>

            <el-alert v-if="analysisError" type="error" :closable="false" show-icon :title="analysisError" />
            <PageState v-else-if="analysisLoading && !analysisResult" loading description="正在按当前模型、筛选和显式储能快照计算。" />
            <PageState v-else-if="!analysisHasRun" description="尚未运行分析；请选择统计期并按需填写显式储能变化。" />
            <template v-else-if="analysisResult">
              <el-alert v-if="analysisResultDirty" type="warning" :closable="false" show-icon title="当前模型统计期或储能输入已变化；下方仍展示上次请求快照结果，请重新运行分析后再用于判断。" />
              <el-alert type="info" :closable="false" show-icon :title="`结果请求快照：${analysisSnapshotRangeLabel}；显式储能变化 ${analysisRequestSnapshot?.storageChanges?.length || 0} 项。`" />
              <section class="stat-grid" aria-label="能流分析质量指标">
                <StatCard label="完整边" :value="`${analysisResult.coverage?.completeEdgeCount || 0} / ${analysisResult.coverage?.edgeCount || 0}`" :note="`覆盖率 ${percent(analysisResult.coverage?.completeRate)}`" />
                <StatCard label="部分 / 缺失" :value="`${analysisResult.coverage?.partialEdgeCount || 0} / ${analysisResult.coverage?.missingEdgeCount || 0}`" note="真实 0 与缺失分别展示" />
                <StatCard label="未映射 / 不可用" :value="`${analysisResult.coverage?.unmappedEdgeCount || 0} / ${analysisResult.coverage?.unavailableEdgeCount || 0}`" note="不伪造边值" />
                <StatCard label="异常项" :value="String(analysisResult.anomalies?.count || 0)" :note="analysisResult.anomalies?.truncated ? '仅展示前 1000 项' : '含差额和来源原因'" />
              </section>

              <article v-if="analysisReasons.length" class="page-card reason-card">
                <header class="section-heading"><div><h2>质量与原因提示</h2><span>状态不只依赖颜色</span></div></header>
                <el-alert v-for="reason in analysisReasons" :key="reason.code" :type="reason.type" :closable="false" show-icon :title="`${reason.code}：${reason.text}`" />
              </article>

              <section class="analysis-detail-grid">
                <article class="page-card">
                  <header class="section-heading"><div><h2>异常明细</h2><span>差额、缺失、未映射、单位与来源问题均保留技术原因码</span></div></header>
                  <PageState v-if="!analysisResult.anomalies?.items?.length" description="当前统计期没有异常项。" />
                  <div v-else class="table-scroll"><el-table :data="analysisResult.anomalies.items" size="small" stripe max-height="320">
                    <el-table-column prop="type" label="类型" min-width="115" />
                    <el-table-column label="对象" min-width="170"><template #default="{ row }">{{ anomalySubject(row) }}</template></el-table-column>
                    <el-table-column label="状态 / 差额" min-width="140"><template #default="{ row }">{{ anomalyStateText(row) }}</template></el-table-column>
                    <el-table-column label="原因" min-width="300"><template #default="{ row }">{{ anomalyReasonText(row) }}</template></el-table-column>
                  </el-table></div>
                </article>
                <article class="page-card">
                  <header class="section-heading"><div><h2>来源使用审计</h2><span>跨边复用来源记录不会重复计入</span></div></header>
                  <PageState v-if="!analysisResult.sourceUsage?.duplicates?.length" description="未发现来源记录跨边复用。" />
                  <div v-else class="table-scroll"><el-table :data="analysisResult.sourceUsage.duplicates" size="small" stripe max-height="320">
                    <el-table-column prop="sourceType" label="来源类型" min-width="120" />
                    <el-table-column prop="recordId" label="来源记录 ID" min-width="120" />
                    <el-table-column label="发电字段" min-width="120"><template #default="{ row }">{{ row.valueField || '—' }}</template></el-table-column>
                    <el-table-column label="复用边 ID" min-width="180"><template #default="{ row }">{{ row.edgeIds.join(', ') }}</template></el-table-column>
                  </el-table></div>
                </article>
              </section>

              <EnergyFlowTopology :topology="analysisResult.topology" :edge-values="analysisResult.edgeValues" :color-domain="energyTypeColorDomain" :standard-coal-view="analysisFilters.standardCoalView" />

              <article class="page-card">
                <header class="section-heading"><div><h2>节点流入、流出与差额</h2><span>差额 = 流入 - 流出 - 储能变化；不自动定性为损耗</span></div></header>
                <div class="table-scroll"><el-table :data="nodeBalanceRows" stripe>
                  <el-table-column prop="nodeName" label="节点" min-width="145" />
                  <el-table-column label="能源分面" min-width="130"><template #default="{ row }">{{ row.energyTypeCode }} / {{ row.unit }}</template></el-table-column>
                  <el-table-column label="流入" min-width="110"><template #default="{ row }">{{ balanceValue(row, 'inflow') }}</template></el-table-column>
                  <el-table-column label="流出" min-width="110"><template #default="{ row }">{{ balanceValue(row, 'outflow') }}</template></el-table-column>
                  <el-table-column label="储能变化" min-width="120"><template #default="{ row }">{{ balanceValue(row, 'storageChange') }}</template></el-table-column>
                  <el-table-column label="差额" min-width="110"><template #default="{ row }">{{ balanceValue(row, 'difference') }}</template></el-table-column>
                  <el-table-column label="不平衡率" min-width="105"><template #default="{ row }">{{ row.imbalanceRate === null ? '不可计算' : percent(row.imbalanceRate) }}</template></el-table-column>
                  <el-table-column label="状态 / 原因" min-width="250"><template #default="{ row }">{{ balanceStatusLabel(row.status) }}<span v-if="row.reasonCodes.length">；{{ row.reasonCodes.map(reasonText).join('；') }}</span></template></el-table-column>
                </el-table></div>
              </article>

              <article class="page-card">
                <header class="section-heading"><div><h2>原单位分面与折标可用性</h2><span>不同单位不直接相加</span></div></header>
                <div class="table-scroll"><el-table :data="analysisResult.facets || []" stripe>
                  <el-table-column label="能源分面" min-width="145"><template #default="{ row }">{{ row.energyTypeCode }} / {{ row.unit }}</template></el-table-column>
                  <el-table-column label="完整边" min-width="100"><template #default="{ row }">{{ row.completeEdgeCount }} / {{ row.edgeCount }}</template></el-table-column>
                  <el-table-column label="平均覆盖率" min-width="115"><template #default="{ row }">{{ percent(row.coverageRate) }}</template></el-table-column>
                  <el-table-column label="折标" min-width="120"><template #default="{ row }">{{ row.standardCoalAvailable ? '可用' : '不可用' }}</template></el-table-column>
                  <el-table-column label="原因" min-width="280"><template #default="{ row }">{{ row.reasonCodes?.length ? row.reasonCodes.map(reasonText).join('；') : '—' }}</template></el-table-column>
                </el-table></div>
              </article>
            </template>
            <PageState v-else description="分析请求已完成，但服务端未返回可展示结果；请重试或检查模型统计期。" />
          </el-tab-pane>

        </el-tabs>
        </template>
      </template>
      <PageState v-else description="请从模型列表选择一个显式能流模型。" />
    </template>

    <ManagementDrawer v-model="modelDrawer" :title="modelEditing ? '修改能流模型' : '新增能流模型版本'" :loading="saving" :confirm-disabled="saving" @save="saveModel">
      <el-alert v-if="modelEditing" type="info" :closable="false" show-icon title="模型编码、版本、来源、文号、有效期和来源时区创建后冻结；如需调整请新建版本。" />
      <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" />
      <el-form ref="modelFormRef" :model="modelForm" :rules="modelRules" label-position="top">
        <el-form-item label="模型编码" prop="modelCode"><el-input v-model.trim="modelForm.modelCode" :disabled="Boolean(modelEditing)" /></el-form-item>
        <el-form-item label="模型名称" prop="modelName"><el-input v-model.trim="modelForm.modelName" /></el-form-item>
        <el-form-item label="版本" prop="version"><el-input v-model.trim="modelForm.version" :disabled="Boolean(modelEditing)" placeholder="例如 v1" /></el-form-item>
        <el-form-item label="来源" prop="source"><el-input v-model.trim="modelForm.source" :disabled="Boolean(modelEditing)" /></el-form-item>
        <el-form-item label="文号 / 文件号"><el-input v-model.trim="modelForm.documentNo" :disabled="Boolean(modelEditing)" /></el-form-item>
        <el-form-item label="生效开始 UTC" prop="effectiveStartUtc"><StrictUtcDateTimeInput v-model="modelForm.effectiveStartUtc" :disabled="Boolean(modelEditing)" placeholder="2026-01-01T00:00:00Z" /></el-form-item>
        <el-form-item label="生效结束 UTC" prop="effectiveEndUtc"><StrictUtcDateTimeInput v-model="modelForm.effectiveEndUtc" :disabled="Boolean(modelEditing)" placeholder="2027-01-01T00:00:00Z" /></el-form-item>
        <el-form-item label="来源时区" prop="sourceTimeZone"><IanaTimeZoneSelect v-model="modelForm.sourceTimeZone" :disabled="Boolean(modelEditing)" placeholder="请选择或搜索来源时区" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="modelForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
      </el-form>
    </ManagementDrawer>

    <ManagementDrawer v-model="nodeDrawer" :title="nodeEditing ? '编辑能流节点' : '新增能流节点'" :loading="saving" @save="saveNode">
      <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" />
      <el-form ref="nodeFormRef" :model="nodeForm" :rules="nodeRules" label-position="top">
        <el-form-item label="节点编码" prop="nodeCode"><el-input v-model.trim="nodeForm.nodeCode" /></el-form-item>
        <el-form-item label="节点名称" prop="nodeName"><el-input v-model.trim="nodeForm.nodeName" /></el-form-item>
        <el-form-item label="节点类型" prop="nodeType"><el-select v-model="nodeForm.nodeType"><el-option v-for="item in nodeTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="用能单元（可选，仅追溯，不推导拓扑）"><el-select v-model="nodeForm.organizationUnitId" clearable filterable><el-option v-for="item in organizationUnits" :key="item.id" :label="`${item.unitPath || item.unitName}（${item.unitCode}）`" :value="item.id" /></el-select></el-form-item>
        <div class="coordinate-grid"><el-form-item label="X 坐标" prop="x"><el-input-number v-model="nodeForm.x" controls-position="right" /></el-form-item><el-form-item label="Y 坐标" prop="y"><el-input-number v-model="nodeForm.y" controls-position="right" /></el-form-item></div>
        <el-form-item label="状态"><el-select v-model="nodeForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
      </el-form>
    </ManagementDrawer>

    <ManagementDrawer v-model="edgeDrawer" :title="edgeEditing ? '编辑能流方向边' : '新增能流方向边'" :loading="saving" @save="saveEdge">
      <el-alert v-if="edgeBindingFrozen" type="warning" :closable="false" show-icon title="边已有可追溯边值，物理端点、能源分面和来源映射不可重写；单位和来源类型同样冻结；请新建边。" />
      <el-alert type="info" :closable="false" show-icon title="发电来源必须显式选择 generation、self_use 或 grid_export；页面和后端都不会自动抵扣能耗或碳排。" />
      <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" />
      <el-form ref="edgeFormRef" :model="edgeForm" :rules="edgeRules" label-position="top">
        <el-form-item label="边编码" prop="edgeCode"><el-input v-model.trim="edgeForm.edgeCode" /></el-form-item>
        <el-form-item label="起点" prop="fromNodeId"><el-select v-model="edgeForm.fromNodeId" :disabled="edgeBindingFrozen"><el-option v-for="item in edgeNodeOptions" :key="item.id" :label="`${item.nodeName}（${item.nodeCode}）`" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="终点" prop="toNodeId"><el-select v-model="edgeForm.toNodeId" :disabled="edgeBindingFrozen"><el-option v-for="item in edgeNodeOptions" :key="item.id" :label="`${item.nodeName}（${item.nodeCode}）`" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="能源类型" prop="energyTypeCode"><el-select v-model="edgeForm.energyTypeCode" :disabled="edgeBindingFrozen" filterable @change="syncEdgeUnit"><el-option v-for="item in energyTypes" :key="item.code" :label="`${item.name}（${item.code} / ${item.standardUnit}）`" :value="item.code" /></el-select></el-form-item>
        <el-form-item label="单位" prop="unit"><el-input v-model.trim="edgeForm.unit" :disabled="edgeBindingFrozen" /></el-form-item>
        <el-form-item label="来源类型" prop="sourceType"><el-select v-model="edgeForm.sourceType" :disabled="edgeBindingFrozen" @change="resetSourceMapping"><el-option v-for="item in sourceTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="来源标识" prop="sourceReference"><el-input v-model.trim="edgeForm.sourceReference" :disabled="edgeBindingFrozen" placeholder="必填，例如 meter:12 或 upload:batch-1" /></el-form-item>
        <el-form-item v-if="edgeForm.sourceType !== 'explicit_edge_value'" label="记录 ID（可选，逗号分隔）"><el-input v-model.trim="edgeForm.recordIds" :disabled="edgeBindingFrozen" /></el-form-item>
        <el-form-item v-if="['timeseries','monthly_energy'].includes(edgeForm.sourceType)" label="计量器具 ID（可选）"><el-input-number v-model="edgeForm.meterDeviceId" :disabled="edgeBindingFrozen" :min="1" controls-position="right" /></el-form-item>
        <el-form-item v-if="['monthly_energy','generation'].includes(edgeForm.sourceType)" label="用能单元（显式选择器）"><el-select v-model="edgeForm.organizationUnitId" :disabled="edgeBindingFrozen" clearable filterable><el-option v-for="item in organizationUnits" :key="item.id" :label="`${item.unitPath || item.unitName}（${item.unitCode}）`" :value="item.id" /></el-select></el-form-item>
        <el-form-item v-if="['timeseries','monthly_energy'].includes(edgeForm.sourceType)" label="来源时区（可选）"><IanaTimeZoneSelect v-model="edgeForm.sourceTimeZone" :disabled="edgeBindingFrozen" placeholder="请选择或搜索来源时区" /></el-form-item>
        <el-form-item v-if="edgeForm.sourceType === 'generation'" label="发电字段" prop="valueField"><el-select v-model="edgeForm.valueField" :disabled="edgeBindingFrozen"><el-option v-for="item in generationFields" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="状态"><el-select v-model="edgeForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
      </el-form>
    </ManagementDrawer>

    <ManagementDrawer :model-value="importExecuteDrawer" title="确认执行能流导入" confirm-label="确认执行" :loading="importExecuteLoading" :confirm-disabled="!activeImportCanExecute || confirmText !== activeImportPreview?.confirmText" @update:model-value="updateImportExecuteDrawer" @save="executeImport">
      <p class="drawer-notice">执行将由后端复核最新预演、固定确认文本、候选、原文件、跳过风险和自动备份。维护态会阻断执行。</p>
      <el-form-item :label="`请输入固定确认文本：${activeImportPreview?.confirmText || ''}`"><el-input v-model="confirmText" /></el-form-item>
      <el-alert v-if="importError" type="error" :closable="false" show-icon :title="importError" />
    </ManagementDrawer>
  </ManagementPage>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox, ElTable, ElTableColumn } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import EnergyFlowTopology from './EnergyFlowTopology.vue';
import { getEnergyTypes } from '@/api/energy';
import { ledgerApi } from '@/api/ledger';
import {
  analyzeEnergyFlow,
  createEnergyFlowEdge,
  createEnergyFlowModel,
  createEnergyFlowNode,
  downloadEnergyFlowDemoArtifact,
  downloadEnergyFlowImportTemplate,
  executeEnergyFlowBundleImport,
  executeEnergyFlowModelImport,
  executeEnergyFlowNodeImport,
  getEnergyFlowModel,
  getEnergyFlowTopology,
  listAllEnergyFlowEdges,
  listAllEnergyFlowNodes,
  listEnergyFlowModels,
  previewEnergyFlowBundleImport,
  previewEnergyFlowModelImport,
  previewEnergyFlowNodeImport,
  updateEnergyFlowEdge,
  updateEnergyFlowEdgeStatus,
  updateEnergyFlowModel,
  updateEnergyFlowModelStatus,
  updateEnergyFlowNode,
  updateEnergyFlowNodeStatus
} from '@/api/energyFlows';
import { hasPermi } from '@/utils/permission';
import { parseStrictUtcDateTime } from '@/utils/dateTimeFields';
import { isIanaTimeZone } from '@/utils/ianaTimeZones';
import {
  ENERGY_FLOW_NODE_TYPES,
  ENERGY_FLOW_SOURCE_TYPES,
  GENERATION_VALUE_FIELDS,
  buildEnergyFlowBundleImportExecutePayload,
  buildEnergyFlowModelImportExecutePayload,
  buildEnergyFlowNodeImportExecutePayload,
  buildEnergyFlowSourceMapping,
  canCommitEnergyFlowAnalysisResponse,
  canCommitEnergyFlowImportExecuteResponse,
  canExecuteEnergyFlowBundleImport,
  canExecuteEnergyFlowModelImport,
  canExecuteEnergyFlowNodeImport,
  collectEnergyFlowPaginatedRows,
  createEnergyFlowAnalysisInputFingerprint,
  createEnergyFlowAnalysisRequestSnapshot,
  createEnergyFlowImportExecuteSnapshot,
  createEnergyFlowImportFileFingerprint,
  createEnergyFlowLatestResponseGuard,
  energyFlowReasonText,
  energyFlowRequestErrorMessage,
  energyFlowSourceSummary,
  formatEnergyFlowValue,
  normalizeEnergyFlowAnalysisUtcFields,
  normalizeEnergyFlowModelUtcFields
} from '@/utils/energyFlow';

// 权限模块。
const canView = computed(() => hasPermi('energy:flows:view'));
const canManage = computed(() => hasPermi('energy:flows:manage'));
const canImportPreview = computed(() => hasPermi('energy:flows:import:preview'));
const canImportExecute = computed(() => hasPermi('energy:flows:import:execute'));

// 模型列表状态模块。
const emptyModelFilters = () => ({ status: '', modelCode: '', version: '', keyword: '' });
const modelDraft = ref(emptyModelFilters());
const modelApplied = ref(emptyModelFilters());
const models = ref([]);
const modelLoading = ref(false);
const modelPage = ref(1);
const modelPageSize = ref(20);
const modelPagination = ref({ total: 0 });
const selectedModel = ref(null);
const modelListError = ref('');
const modelSelectionLoading = ref(false);
const modelSelectionReady = ref(false);
const modelSelectionError = ref('');
const activeTab = ref('topology');
// 模型列表与模型切换 latest-response 守卫模块。
const modelListRequestGuard = createEnergyFlowLatestResponseGuard();
const modelSelectionRequestGuard = createEnergyFlowLatestResponseGuard();

// 拓扑与依赖数据模块。
const topology = ref({ nodes: [], edges: [], quality: {}, contract: {} });
const nodes = ref([]);
const edges = ref([]);
const organizationUnits = ref([]);
const organizationUnitsLoading = ref(false);
const organizationUnitsLoaded = ref(false);
const organizationUnitsError = ref('');
const energyTypes = ref([]);
const energyTypesLoading = ref(false);
const energyTypesLoaded = ref(false);
const energyTypesError = ref('');
const nodeTypes = ENERGY_FLOW_NODE_TYPES;
const sourceTypes = ENERGY_FLOW_SOURCE_TYPES;
const generationFields = GENERATION_VALUE_FIELDS;
const activeNodes = computed(() => nodes.value.filter((row) => row.status === 'active'));
const edgeNodeOptions = computed(() => edgeEditing.value ? nodes.value : activeNodes.value);
const storageNodes = computed(() => activeNodes.value.filter((row) => row.nodeType === 'storage'));
// 能源颜色完整业务色域模块，过滤前后始终按能源台账顺序绑定。
const energyTypeColorDomain = computed(() => energyTypes.value.map((row) => row.code).filter(Boolean));

// 分析状态模块。
const analysisFilters = ref({ rangeMode: 'month', startMonth: '', endMonth: '', startUtc: '', endUtc: '', standardCoalView: 'original' });
const storageChanges = ref([]);
const analysisResult = ref(null);
const analysisLoading = ref(false);
const analysisHasRun = ref(false);
const analysisError = ref('');
// UTC 初始化诊断模块：非法原文不留在父模型，仅保留可见错误供提交兜底使用。
const analysisUtcDiagnostic = ref('');
const analysisRequestSnapshot = ref(null);
// 分析请求 latest-response 守卫模块。
const analysisRequestGuard = createEnergyFlowLatestResponseGuard();
// 当前分析输入指纹与已展示结果脏状态模块。
const analysisCurrentInputFingerprint = computed(() => selectedModel.value
  ? createEnergyFlowAnalysisInputFingerprint(selectedModel.value.id, analysisFilters.value, storageChanges.value)
  : '');
const analysisResultDirty = computed(() => Boolean(analysisResult.value
  && analysisRequestSnapshot.value
  && analysisRequestSnapshot.value.inputFingerprint !== analysisCurrentInputFingerprint.value));
const analysisSnapshotRangeLabel = computed(() => {
  const filters = analysisRequestSnapshot.value?.filters;
  if (!filters) return '未记录统计期';
  return filters.rangeMode === 'utc'
    ? `${filters.startUtc || '未填写'} 至 ${filters.endUtc || '未填写'}（UTC）`
    : `${filters.startMonth || '未填写'} 至 ${filters.endMonth || '未填写'}（月份）`;
});
const nodeBalanceRows = computed(() => (analysisResult.value?.nodeBalances || []).flatMap((node) => (node.facets || []).map((facet) => ({ ...facet, nodeId: node.nodeId, nodeCode: node.nodeCode, nodeName: node.nodeName, nodeType: node.nodeType }))));
const analysisReasons = computed(() => {
  const result = analysisResult.value;
  if (!result) return [];
  const codes = new Set([
    ...(result.edgeValues || []).flatMap((row) => [...(row.reasonCodes || []), ...(row.configurationErrors || []), ...(row.standardCoal?.reasonCodes || [])]),
    ...(result.nodeBalances || []).flatMap((node) => (node.facets || []).flatMap((facet) => [...(facet.reasonCodes || []), ...(facet.standardCoal?.reasonCodes || [])])),
    ...(result.facets || []).flatMap((facet) => facet.reasonCodes || []),
    ...(result.anomalies?.items || []).flatMap((item) => [...(item.reasonCodes || []), ...(item.configurationErrors || []), ...(item.code ? [item.code] : [])])
  ]);
  return [...codes].filter(Boolean).map((code) => ({ code, text: energyFlowReasonText(code), type: ['SOURCE_OVERLAP_OR_DUPLICATE', 'SOURCE_RECORD_REUSED_ACROSS_EDGES', 'UNIT_NOT_COMPARABLE'].includes(code) ? 'error' : 'warning' }));
});

// 抽屉表单状态模块。
const saving = ref(false);
const formError = ref('');
// 模型 UTC 回显诊断模块：非法原文仅保留在错误文本，不进入可提交表单字段。
const modelUtcDiagnostic = ref('');
const modelDrawer = ref(false);
const modelEditing = ref(null);
const modelFormRef = ref(null);
const modelForm = ref({});
const nodeDrawer = ref(false);
const nodeEditing = ref(null);
const nodeFormRef = ref(null);
const nodeForm = ref({});
const edgeDrawer = ref(false);
const edgeEditing = ref(null);
const edgeFormRef = ref(null);
const edgeForm = ref({});
const edgeBindingFrozen = computed(() => Number(edgeEditing.value?.recordCount || 0) > 0);

// 能流模板和青岚示例依赖顺序模块；边与显式边值共享同一双工作表文件。
const flowImportDownloads = Object.freeze([
  Object.freeze({ key: 'model', order: 1, label: '模型', description: '先建立模型编码和版本。', templateType: 'energy-flow-models', demoArtifactKey: '22-energy-flow-models' }),
  Object.freeze({ key: 'node', order: 2, label: '节点', description: '依赖已存在的 active 模型。', templateType: 'energy-flow-nodes', demoArtifactKey: '23-energy-flow-nodes' }),
  Object.freeze({ key: 'edge', order: 3, label: '边', description: '依赖模型内已存在的节点。', templateType: 'energy-flow-edges', demoArtifactKey: '24-energy-flow-edges' }),
  Object.freeze({ key: 'record', order: 4, label: '显式边值', description: '与边共用双工作表 XLSX，不改变半开时间重叠契约。', templateType: 'energy-flow-edges', demoArtifactKey: '24-energy-flow-edges' })
]);
// 导入状态模块。
const modelImportFile = ref(null);
const modelImportFileList = ref([]);
const nodeImportFile = ref(null);
const nodeImportFileList = ref([]);
const bundleImportFile = ref(null);
const bundleImportFileList = ref([]);
const modelImportPreview = ref(null);
const nodeImportPreview = ref(null);
const bundleImportPreview = ref(null);
// 预演结果绑定模块，保存生成该结果的文件指纹和请求票据。
const modelImportPreviewBinding = ref(null);
const nodeImportPreviewBinding = ref(null);
const bundleImportPreviewBinding = ref(null);
const modelImportLoading = ref(false);
const nodeImportLoading = ref(false);
const bundleImportLoading = ref(false);
const importError = ref('');
const importExecuteDrawer = ref(false);
const importExecuteLoading = ref(false);
const importExecuteKind = ref('');
const confirmText = ref('');
// 上传预演 latest-response 守卫模块，文件移除后旧预演不可恢复可执行状态。
const modelImportRequestGuard = createEnergyFlowLatestResponseGuard();
const nodeImportRequestGuard = createEnergyFlowLatestResponseGuard();
const bundleImportRequestGuard = createEnergyFlowLatestResponseGuard();
// 导入执行 latest-response 守卫模块，确保旧 execute 响应不能提交到新的导入上下文。
const importExecuteRequestGuard = createEnergyFlowLatestResponseGuard();
const activeImportPreview = computed(() => importExecuteKind.value === 'model'
  ? modelImportPreview.value
  : importExecuteKind.value === 'node'
    ? nodeImportPreview.value
    : importExecuteKind.value === 'bundle' ? bundleImportPreview.value : null);
const canExecuteModelPreview = computed(() => canExecuteEnergyFlowModelImport(modelImportPreview.value, {
  loading: modelImportLoading.value,
  currentFileFingerprint: createEnergyFlowImportFileFingerprint(modelImportFile.value),
  previewFileFingerprint: modelImportPreviewBinding.value?.fileFingerprint,
  isLatest: modelImportRequestGuard.isCurrent(modelImportPreviewBinding.value?.ticket)
}));
const canExecuteNodePreview = computed(() => canExecuteEnergyFlowNodeImport(nodeImportPreview.value, {
  loading: nodeImportLoading.value,
  currentFileFingerprint: createEnergyFlowImportFileFingerprint(nodeImportFile.value),
  previewFileFingerprint: nodeImportPreviewBinding.value?.fileFingerprint,
  isLatest: nodeImportRequestGuard.isCurrent(nodeImportPreviewBinding.value?.ticket)
}));
const canExecuteBundlePreview = computed(() => canExecuteEnergyFlowBundleImport(bundleImportPreview.value, {
  loading: bundleImportLoading.value,
  currentFileFingerprint: createEnergyFlowImportFileFingerprint(bundleImportFile.value),
  previewFileFingerprint: bundleImportPreviewBinding.value?.fileFingerprint,
  isLatest: bundleImportRequestGuard.isCurrent(bundleImportPreviewBinding.value?.ticket)
}));
const activeImportCanExecute = computed(() => importExecuteKind.value === 'model'
  ? canExecuteModelPreview.value
  : importExecuteKind.value === 'node'
    ? canExecuteNodePreview.value
    : importExecuteKind.value === 'bundle' && canExecuteBundlePreview.value);

// 表单校验模块。
const required = (message) => ({ required: true, message, trigger: ['blur', 'change'] });
/** 校验严格 UTC 字段，拒绝隐藏的非零毫秒或非法日历日期。 */
const strictUtcRule = (label) => ({
  validator: (_rule, value, callback) => {
    if (value === '' || value === null || value === undefined) return callback();
    const result = parseStrictUtcDateTime(value);
    return result.valid ? callback() : callback(new Error(`${label}：${result.message}`));
  },
  trigger: ['change', 'blur']
});
/** 校验来源时区同时符合 IANA 字符串形态并可由当前 Intl 运行时识别。 */
const ianaTimeZoneRule = (requiredValue = false) => ({
  validator: (_rule, value, callback) => {
    const sourceTimeZone = String(value || '').trim();
    if (!sourceTimeZone) return requiredValue ? callback(new Error('请选择来源时区')) : callback();
    return isIanaTimeZone(sourceTimeZone) ? callback() : callback(new Error('请选择当前运行时可识别的 IANA 来源时区'));
  },
  trigger: ['change', 'blur']
});
const modelRules = { modelCode: [required('请填写模型编码')], modelName: [required('请填写模型名称')], version: [required('请填写版本')], source: [required('请填写来源')], effectiveStartUtc: [required('请填写生效开始 UTC'), strictUtcRule('生效开始 UTC')], effectiveEndUtc: [required('请填写生效结束 UTC'), strictUtcRule('生效结束 UTC')], sourceTimeZone: [ianaTimeZoneRule(true)] };
const nodeRules = { nodeCode: [required('请填写节点编码')], nodeName: [required('请填写节点名称')], nodeType: [required('请选择节点类型')], x: [required('请填写 X 坐标')], y: [required('请填写 Y 坐标')] };
const edgeRules = { edgeCode: [required('请填写边编码')], fromNodeId: [required('请选择起点')], toNodeId: [required('请选择终点')], energyTypeCode: [required('请选择能源类型')], unit: [required('请填写单位')], sourceType: [required('请选择来源类型')], sourceReference: [required('请填写来源标识')], sourceTimeZone: [ianaTimeZoneRule(false)], valueField: [{ validator: (_rule, value, callback) => edgeForm.value.sourceType !== 'generation' || value ? callback() : callback(new Error('发电来源必须显式选择 generation、self_use 或 grid_export')), trigger: 'change' }] };

// 导入预演表格局部组件模块。
const ImportPreviewTable = defineComponent({
  props: { title: { type: String, default: '预演结果' }, preview: { type: Object, default: () => ({}) } },
  setup(props) {
    return () => h('div', { class: 'import-preview' }, [
      h('strong', props.title),
      h('p', `总行 ${props.preview?.summary?.totalRows || 0}；可导入 ${props.preview?.summary?.wouldImport || props.preview?.expectedWouldImport || 0}；跳过 ${props.preview?.summary?.skipped || 0}；阻断 ${props.preview?.summary?.blocked || 0}`),
      h(ElTable, { data: props.preview?.items || [], size: 'small', maxHeight: 260 }, {
        default: () => [
          h(ElTableColumn, { prop: 'rowNumber', label: '行', width: 65 }),
          h(ElTableColumn, { prop: 'status', label: '状态', minWidth: 90 }),
          h(ElTableColumn, { label: '原因', minWidth: 220 }, { default: ({ row }) => (row.issues || []).map((issue) => issue.message || issue.code).join('；') || '—' })
        ]
      })
    ]);
  }
});

/** 安全执行请求并保留错误对象。 */
async function safeRequest(task) { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } }
/** 返回 API 错误中文消息，并补充失败影响。 */
function requestMessage(result, fallback = '接口请求失败。', impact = '') { return energyFlowRequestErrorMessage(result?.error, fallback, impact); }
/** 返回百分比文本。 */
function percent(value) { return value === null || value === undefined ? '不可计算' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value) * 100)}%`; }
/** 返回节点类型文案。 */
function nodeTypeLabel(value) { return nodeTypes.find((item) => item.value === value)?.label || value; }
/** 返回来源摘要。 */
function sourceSummary(edge) { return energyFlowSourceSummary(edge); }
/** 返回原因文案。 */
function reasonText(code) { return energyFlowReasonText(code); }
/** 返回节点平衡状态文案。 */
function balanceStatusLabel(value) { return ({ calculated: '已计算', incomplete: '不完整', storage_unmapped: '储能未映射', unavailable: '不可用' })[value] || value; }
/** 返回异常关联对象。 */
function anomalySubject(row) {
  if (row.type === 'edge') return `边 #${row.edgeId}`;
  if (row.type === 'node_balance') return `节点 #${row.nodeId} / ${row.energyTypeCode || ''} ${row.unit || ''}`.trim();
  if (row.type === 'source_reuse') return `${row.sourceType || '来源'}记录 #${row.recordId}`;
  return row.edgeId ? `边 #${row.edgeId}` : row.nodeId ? `节点 #${row.nodeId}` : '分析对象';
}
/** 返回异常状态或差额文本。 */
function anomalyStateText(row) {
  if (row.status) return row.status;
  if (row.type === 'node_balance') return `差额 ${formatEnergyFlowValue(row.difference, row.difference === 0)} ${row.unit || ''}`.trim();
  if (row.type === 'source_reuse') return '已阻止重复计入';
  return '待核查';
}
/** 返回异常原因中文文本。 */
function anomalyReasonText(row) {
  const codes = [...new Set([...(row.reasonCodes || []), ...(row.configurationErrors || []), ...(row.code ? [row.code] : [])])];
  return codes.length ? codes.map((code) => `${code}：${reasonText(code)}`).join('；') : '未提供原因码';
}
/** 按当前视图返回节点平衡字段。 */
function balanceValue(row, field) {
  if (analysisFilters.value.standardCoalView === 'original') return `${formatEnergyFlowValue(row[field], row.trueZero && field === 'difference')} ${row.unit}`;
  const coalField = ({ inflow: 'inflowKgce', outflow: 'outflowKgce', storageChange: 'storageChangeKgce', difference: 'kgce' })[field];
  const kgce = row.standardCoal?.[coalField];
  if (analysisFilters.value.standardCoalView === 'kgce') return `${formatEnergyFlowValue(kgce)} kgce`;
  return `${formatEnergyFlowValue(kgce === null || kgce === undefined ? null : Number(kgce) / 1000)} tce`;
}

/** 加载模型列表，并丢弃筛选或分页变化前的旧响应。 */
async function loadModels() {
  const requestTicket = modelListRequestGuard.begin({ filters: { ...modelApplied.value }, page: modelPage.value, pageSize: modelPageSize.value });
  modelLoading.value = true;
  modelListError.value = '';
  const result = await safeRequest(() => listEnergyFlowModels({ ...requestTicket.snapshot.filters, page: requestTicket.snapshot.page, pageSize: requestTicket.snapshot.pageSize }));
  if (!modelListRequestGuard.isCurrent(requestTicket)) return;
  modelLoading.value = false;
  if (!result.ok) {
    modelListError.value = requestMessage(result, '能流模型读取失败。', '模型列表不可用，无法选择或切换模型，请重试。');
    return;
  }
  models.value = result.value.data || [];
  modelPagination.value = result.value.meta?.pagination || {};
  if (selectedModel.value) {
    const refreshed = models.value.find((row) => Number(row.id) === Number(selectedModel.value.id));
    if (refreshed) selectedModel.value = refreshed;
  }
}

/** 分页加载全部组织依赖，仅用于显式追溯下拉，不推导拓扑。 */
async function loadOrganizationUnits() {
  organizationUnitsLoading.value = true;
  organizationUnitsError.value = '';
  const result = await safeRequest(() => collectEnergyFlowPaginatedRows((params) => ledgerApi.units.list(params)));
  organizationUnitsLoading.value = false;
  organizationUnitsLoaded.value = true;
  if (!result.ok) {
    organizationUnitsError.value = requestMessage(result, '组织依赖读取失败。', '组织追溯下拉不可用，但不会从组织树猜测物理拓扑。');
    return;
  }
  organizationUnits.value = result.value;
}

/** 加载 active 能源类型，失败时阻止依赖能源选项的写入。 */
async function loadEnergyTypes() {
  energyTypesLoading.value = true;
  energyTypesError.value = '';
  const result = await safeRequest(getEnergyTypes);
  energyTypesLoading.value = false;
  energyTypesLoaded.value = true;
  if (!result.ok) {
    energyTypesError.value = requestMessage(result, '能源类型读取失败。', '新增边、能源选择和稳定颜色图例暂不可用，请重试。');
    return;
  }
  energyTypes.value = result.value.data || [];
}

/** 并行加载两个相互独立的显式依赖。 */
async function loadDependencies() { await Promise.all([loadOrganizationUnits(), loadEnergyTypes()]); }

/** 选择模型并并行加载详情、完整拓扑、全部节点和全部边。 */
async function selectModel(row) {
  if (!row) return;
  const modelId = Number(row.id);
  const requestTicket = modelSelectionRequestGuard.begin({ modelId });
  analysisRequestGuard.invalidate();
  selectedModel.value = row;
  modelSelectionLoading.value = true;
  modelSelectionReady.value = false;
  modelSelectionError.value = '';
  topology.value = { nodes: [], edges: [], quality: {}, contract: {} };
  nodes.value = [];
  edges.value = [];
  storageChanges.value = [];
  analysisResult.value = null;
  analysisRequestSnapshot.value = null;
  analysisLoading.value = false;
  analysisHasRun.value = false;
  analysisError.value = '';
  analysisUtcDiagnostic.value = '';
  const [detailResult, topologyResult, nodeResult, edgeResult] = await Promise.all([
    safeRequest(() => getEnergyFlowModel(modelId)),
    safeRequest(() => getEnergyFlowTopology(modelId, { includeInactive: true })),
    safeRequest(() => listAllEnergyFlowNodes(modelId)),
    safeRequest(() => listAllEnergyFlowEdges(modelId))
  ]);
  if (!modelSelectionRequestGuard.isCurrent(requestTicket)) return;
  modelSelectionLoading.value = false;
  const failures = [
    !detailResult.ok && requestMessage(detailResult, '模型详情读取失败。', '无法确认模型身份、有效期和来源时区。'),
    !topologyResult.ok && requestMessage(topologyResult, '显式拓扑读取失败。', '拓扑图和拓扑质量不可用，不会投影为空拓扑。'),
    !nodeResult.ok && requestMessage(nodeResult, '模型节点读取失败。', '节点维护表、active 节点选择器和储能节点集合不可用。'),
    !edgeResult.ok && requestMessage(edgeResult, '模型方向边读取失败。', '方向边维护表和来源维护不可用。')
  ].filter(Boolean);
  if (failures.length) {
    modelSelectionError.value = failures.join('；');
    return;
  }
  selectedModel.value = detailResult.value.data || row;
  topology.value = topologyResult.value.data;
  nodes.value = nodeResult.value;
  edges.value = edgeResult.value;
  modelSelectionReady.value = true;
  initializeAnalysisRange();
}

/** 重试当前模型完整读取。 */
function retrySelectedModel() { if (selectedModel.value) selectModel(selectedModel.value); }

/** 根据模型有效期初始化统计月份和严格 UTC 输入，非法毫秒明确阻断 UTC 分析。 */
function initializeAnalysisRange() {
  const modelUtcNormalization = normalizeEnergyFlowModelUtcFields(selectedModel.value || {});
  selectedModel.value = modelUtcNormalization.value;
  const start = String(selectedModel.value?.effectiveStartUtc || '').slice(0, 7);
  const endDate = new Date(selectedModel.value?.effectiveEndUtc || '');
  if (Number.isFinite(endDate.getTime())) endDate.setUTCMonth(endDate.getUTCMonth() - 1);
  const end = Number.isFinite(endDate.getTime()) ? endDate.toISOString().slice(0, 7) : start;
  const analysisUtcNormalization = normalizeEnergyFlowAnalysisUtcFields({
    rangeMode: 'utc',
    startUtc: selectedModel.value?.effectiveStartUtc || '',
    endUtc: selectedModel.value?.effectiveEndUtc || ''
  });
  analysisFilters.value = {
    ...analysisFilters.value,
    startMonth: start,
    endMonth: end,
    startUtc: analysisUtcNormalization.value.startUtc,
    endUtc: analysisUtcNormalization.value.endUtc
  };
  analysisUtcDiagnostic.value = analysisUtcNormalization.message || modelUtcNormalization.message;
  analysisError.value = analysisUtcDiagnostic.value;
}

/** 应用模型筛选。 */
function applyModelFilters() { modelApplied.value = { ...modelDraft.value }; modelPage.value = 1; loadModels(); }
/** 重置模型筛选。 */
function resetModelFilters() { modelDraft.value = emptyModelFilters(); modelApplied.value = emptyModelFilters(); modelPage.value = 1; loadModels(); }
/** 修改模型分页大小。 */
function changeModelPageSize() { modelPage.value = 1; loadModels(); }

/** 返回空模型表单。 */
function blankModelForm() { return { modelCode: '', modelName: '', source: '', documentNo: '', version: 'v1', effectiveStartUtc: '', effectiveEndUtc: '', sourceTimeZone: 'Asia/Shanghai', status: 'active' }; }
/** 将模型回显值规范为共享组件可见的严格 UTC，并返回不能隐藏提交的错误。 */
function prepareModelForm(source, overrides = {}) {
  const normalization = normalizeEnergyFlowModelUtcFields({ ...blankModelForm(), ...source, ...overrides });
  modelForm.value = normalization.value;
  modelUtcDiagnostic.value = normalization.message;
  formError.value = modelUtcDiagnostic.value;
}
/** 打开模型新增。 */
function openModelCreate() { modelEditing.value = null; modelForm.value = blankModelForm(); modelUtcDiagnostic.value = ''; formError.value = ''; modelDrawer.value = true; }
/** 打开模型修改。 */
function openModelEdit(row) { modelEditing.value = row; prepareModelForm(row); modelDrawer.value = true; }
/** 基于旧模型打开新版本表单。 */
function openNewVersion(row) { modelEditing.value = null; prepareModelForm(row, { id: undefined, version: '', status: 'active' }); modelDrawer.value = true; }

/** 保存模型或新版本，并在调用 API 前再次阻断非法或非零毫秒 UTC。 */
async function saveModel() {
  const valid = await modelFormRef.value?.validate().catch(() => false);
  const utcNormalization = normalizeEnergyFlowModelUtcFields(modelForm.value);
  if (!utcNormalization.valid) { formError.value = modelUtcDiagnostic.value || utcNormalization.message; return; }
  if (!valid) return;
  if (!modelEditing.value && !isIanaTimeZone(utcNormalization.value.sourceTimeZone)) { formError.value = '请选择当前运行时可识别的 IANA 来源时区。'; return; }
  modelUtcDiagnostic.value = '';
  modelForm.value = utcNormalization.value;
  saving.value = true; formError.value = '';
  const payload = modelEditing.value ? { modelName: modelForm.value.modelName, status: modelForm.value.status } : { ...modelForm.value };
  const result = await safeRequest(() => modelEditing.value ? updateEnergyFlowModel(modelEditing.value.id, payload) : createEnergyFlowModel(payload));
  saving.value = false;
  if (!result.ok) { formError.value = requestMessage(result); return; }
  modelDrawer.value = false; ElMessage.success(modelEditing.value ? '能流模型名称已更新。' : '能流模型版本已创建。');
  await loadModels();
  await selectModel(result.value.data);
}

/** 确认并切换模型状态。 */
async function toggleModelStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active';
  if (!await confirmStatusChange(row.modelName, status, '模型停用不会物理删除节点、边和历史边值。')) return;
  const result = await safeRequest(() => updateEnergyFlowModelStatus(row.id, status));
  if (!result.ok) return ElMessage.error(requestMessage(result));
  ElMessage.success(status === 'active' ? '模型已启用。' : '模型已停用。'); await loadModels(); if (selectedModel.value?.id === row.id) await selectModel(result.value.data);
}

/** 返回空节点表单。 */
function blankNodeForm() { return { nodeCode: '', nodeName: '', nodeType: 'process', organizationUnitId: null, x: 0, y: 0, status: 'active' }; }
/** 打开节点新增。 */
function openNodeCreate() { nodeEditing.value = null; nodeForm.value = blankNodeForm(); formError.value = ''; nodeDrawer.value = true; }
/** 打开节点编辑。 */
function openNodeEdit(row) { nodeEditing.value = row; nodeForm.value = { ...blankNodeForm(), ...row }; formError.value = ''; nodeDrawer.value = true; }
/** 保存显式节点。 */
async function saveNode() {
  const valid = await nodeFormRef.value?.validate().catch(() => false); if (!valid) return;
  saving.value = true; formError.value = '';
  const result = await safeRequest(() => nodeEditing.value ? updateEnergyFlowNode(selectedModel.value.id, nodeEditing.value.id, nodeForm.value) : createEnergyFlowNode(selectedModel.value.id, nodeForm.value));
  saving.value = false;
  if (!result.ok) { formError.value = requestMessage(result); return; }
  nodeDrawer.value = false; ElMessage.success(nodeEditing.value ? '节点已更新。' : '节点已新增。'); await selectModel(selectedModel.value);
}
/** 切换节点状态。 */
async function toggleNodeStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active';
  if (!await confirmStatusChange(row.nodeName, status, 'active 边仍引用节点时，后端会拒绝停用。')) return;
  const result = await safeRequest(() => updateEnergyFlowNodeStatus(selectedModel.value.id, row.id, status));
  if (!result.ok) return ElMessage.error(requestMessage(result));
  ElMessage.success(status === 'active' ? '节点已启用。' : '节点已停用。'); await selectModel(selectedModel.value);
}

/** 返回空边表单。 */
function blankEdgeForm() { return { edgeCode: '', fromNodeId: null, toNodeId: null, energyTypeCode: '', unit: '', sourceType: 'explicit_edge_value', sourceReference: '', recordIds: '', meterDeviceId: null, organizationUnitId: null, sourceTimeZone: '', valueField: '', status: 'active' }; }
/** 打开边新增。 */
function openEdgeCreate() { edgeEditing.value = null; edgeForm.value = blankEdgeForm(); formError.value = ''; edgeDrawer.value = true; }
/** 打开边编辑并还原来源映射。 */
function openEdgeEdit(row) {
  edgeEditing.value = row;
  edgeForm.value = { ...blankEdgeForm(), ...row, sourceReference: row.sourceMapping?.reference || '', recordIds: (row.sourceMapping?.recordIds || []).join(','), meterDeviceId: row.sourceMapping?.meterDeviceId || null, organizationUnitId: row.sourceMapping?.organizationUnitId || null, sourceTimeZone: row.sourceMapping?.sourceTimeZone || '', valueField: row.sourceMapping?.valueField || '' };
  formError.value = ''; edgeDrawer.value = true;
}
/** 能源类型切换后同步标准单位。 */
function syncEdgeUnit(code) { const type = energyTypes.value.find((item) => item.code === code); if (type) edgeForm.value.unit = type.standardUnit; }
/** 来源类型切换后清理不适用选择器。 */
function resetSourceMapping() { const reference = edgeForm.value.sourceReference; edgeForm.value = { ...edgeForm.value, sourceReference: reference, recordIds: '', meterDeviceId: null, organizationUnitId: null, sourceTimeZone: '', valueField: '' }; }
/** 保存显式方向边和来源映射。 */
async function saveEdge() {
  const valid = await edgeFormRef.value?.validate().catch(() => false); if (!valid) return;
  if (Number(edgeForm.value.fromNodeId) === Number(edgeForm.value.toNodeId)) { formError.value = '起点和终点不能相同。'; return; }
  const edgeSourceTimeZone = String(edgeForm.value.sourceTimeZone || '').trim();
  if (edgeSourceTimeZone && !isIanaTimeZone(edgeSourceTimeZone)) { formError.value = '请选择当前运行时可识别的 IANA 来源时区。'; return; }
  const sourceMapping = buildEnergyFlowSourceMapping(edgeForm.value.sourceType, { reference: edgeForm.value.sourceReference, recordIds: edgeForm.value.recordIds, meterDeviceId: edgeForm.value.meterDeviceId, organizationUnitId: edgeForm.value.organizationUnitId, sourceTimeZone: edgeForm.value.sourceTimeZone, valueField: edgeForm.value.valueField });
  const hasSelector = {
    explicit_edge_value: true,
    timeseries: Boolean(sourceMapping.recordIds?.length || sourceMapping.meterDeviceId),
    monthly_energy: Boolean(sourceMapping.recordIds?.length || sourceMapping.meterDeviceId || sourceMapping.organizationUnitId),
    generation: Boolean(sourceMapping.recordIds?.length || sourceMapping.organizationUnitId)
  }[edgeForm.value.sourceType];
  if (!hasSelector) { formError.value = '当前来源类型缺少合法显式选择器；请填写记录 ID、计量器具或用能单元。'; return; }
  const payload = { edgeCode: edgeForm.value.edgeCode, fromNodeId: edgeForm.value.fromNodeId, toNodeId: edgeForm.value.toNodeId, energyTypeCode: edgeForm.value.energyTypeCode, unit: edgeForm.value.unit, sourceType: edgeForm.value.sourceType, sourceMapping, status: edgeForm.value.status };
  saving.value = true; formError.value = '';
  const result = await safeRequest(() => edgeEditing.value ? updateEnergyFlowEdge(selectedModel.value.id, edgeEditing.value.id, payload) : createEnergyFlowEdge(selectedModel.value.id, payload));
  saving.value = false;
  if (!result.ok) { formError.value = requestMessage(result); return; }
  edgeDrawer.value = false; ElMessage.success(edgeEditing.value ? '方向边已更新。' : '方向边已新增。'); await selectModel(selectedModel.value);
}
/** 切换边状态。 */
async function toggleEdgeStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active';
  if (!await confirmStatusChange(row.edgeCode, status, '停用不删除历史边值；重新启用时后端会复核显式来源。')) return;
  const result = await safeRequest(() => updateEnergyFlowEdgeStatus(selectedModel.value.id, row.id, status));
  if (!result.ok) return ElMessage.error(requestMessage(result));
  ElMessage.success(status === 'active' ? '方向边已启用。' : '方向边已停用。'); await selectModel(selectedModel.value);
}

/** 统一确认启停高影响操作。 */
async function confirmStatusChange(name, status, impact) {
  const verb = status === 'active' ? '启用' : '停用';
  try { await ElMessageBox.confirm(`确认${verb}“${name}”？${impact}`, `确认${verb}`, { type: status === 'active' ? 'info' : 'warning', confirmButtonText: `确认${verb}`, cancelButtonText: '取消' }); return true; } catch { return false; }
}

/** 新增显式储能变化输入，变化值保持空值直到用户明确输入。 */
function addStorageChange() { storageChanges.value.push({ nodeId: storageNodes.value[0]?.id || null, energyTypeCode: '', unit: '', value: null, sourceMapping: { reference: '' } }); }
/** 移除显式储能变化输入。 */
function removeStorageChange(index) { storageChanges.value.splice(index, 1); }
/** 返回储能变化未完成输入的校验消息。 */
function storageChangeValidationMessage() {
  const invalidIndex = storageChanges.value.findIndex((row) => !row.nodeId
    || !String(row.energyTypeCode || '').trim()
    || !String(row.unit || '').trim()
    || row.value === null
    || row.value === undefined
    || row.value === ''
    || !String(row.sourceMapping?.reference || '').trim());
  return invalidIndex >= 0 ? `请完整填写第 ${invalidIndex + 1} 项储能变化；变化值 0 也必须由用户显式输入。` : '';
}
/** 运行只读能流分析，并只接受仍绑定当前输入的最新请求响应。 */
async function runAnalysis() {
  let filters = analysisFilters.value;
  if (filters.rangeMode === 'month' && (!filters.startMonth || !filters.endMonth)) { analysisError.value = '请选择完整开始和结束月份。'; return; }
  if (filters.rangeMode === 'utc' && (!filters.startUtc || !filters.endUtc)) { analysisError.value = analysisUtcDiagnostic.value || '请填写完整 UTC 区间。'; return; }
  if (filters.rangeMode === 'utc') {
    const utcNormalization = normalizeEnergyFlowAnalysisUtcFields(filters);
    if (!utcNormalization.valid) { analysisError.value = analysisUtcDiagnostic.value || utcNormalization.message; return; }
    analysisUtcDiagnostic.value = '';
    analysisFilters.value = utcNormalization.value;
    filters = analysisFilters.value;
  }
  const storageValidationError = storageChangeValidationMessage();
  if (storageValidationError) { analysisError.value = storageValidationError; return; }
  const requestSnapshot = createEnergyFlowAnalysisRequestSnapshot(selectedModel.value.id, filters, storageChanges.value);
  const requestTicket = analysisRequestGuard.begin(requestSnapshot);
  analysisResult.value = null;
  analysisRequestSnapshot.value = null;
  analysisHasRun.value = false;
  analysisLoading.value = true;
  analysisError.value = '';
  const result = await safeRequest(() => analyzeEnergyFlow(requestSnapshot.modelId, requestSnapshot.payload));
  const isLatest = analysisRequestGuard.isCurrent(requestTicket);
  if (!isLatest) return;
  analysisLoading.value = false;
  if (!canCommitEnergyFlowAnalysisResponse({
    isLatest,
    snapshot: requestSnapshot,
    currentModelId: selectedModel.value?.id,
    currentInputFingerprint: analysisCurrentInputFingerprint.value
  })) {
    analysisError.value = '分析等待期间模型、统计期或储能输入已变化，旧响应已丢弃；请按当前输入重新运行。';
    return;
  }
  analysisHasRun.value = true;
  if (!result.ok) {
    analysisError.value = requestMessage(result, '能流分析失败。', '本次模型、统计期和储能变化没有生成分析结果，请修正后重试。');
    return;
  }
  analysisResult.value = result.value.data || null;
  analysisRequestSnapshot.value = requestSnapshot;
  activeTab.value = 'analysis';
}

/** 清空导入执行抽屉、确认文本和当前执行种类。 */
function resetImportExecutionContext() {
  if (importExecuteLoading.value) return;
  importExecuteRequestGuard.invalidate();
  importExecuteDrawer.value = false;
  importExecuteKind.value = '';
  confirmText.value = '';
}
/** 在 execute loading 期间拒绝抽屉关闭，避免冻结快照对应的上下文被用户改写。 */
function updateImportExecuteDrawer(open) {
  if (importExecuteLoading.value && !open) return;
  importExecuteDrawer.value = Boolean(open);
  if (!open) resetImportExecutionContext();
}
/** 清空指定上传选择、预演签名和执行状态，保持控件与实际提交一致。 */
function clearImportSelection(kind) {
  if (importExecuteLoading.value) return;
  if (kind === 'model') {
    modelImportRequestGuard.invalidate();
    modelImportFile.value = null;
    modelImportFileList.value = [];
    modelImportPreview.value = null;
    modelImportPreviewBinding.value = null;
    modelImportLoading.value = false;
  } else if (kind === 'node') {
    nodeImportRequestGuard.invalidate();
    nodeImportFile.value = null;
    nodeImportFileList.value = [];
    nodeImportPreview.value = null;
    nodeImportPreviewBinding.value = null;
    nodeImportLoading.value = false;
  } else {
    bundleImportRequestGuard.invalidate();
    bundleImportFile.value = null;
    bundleImportFileList.value = [];
    bundleImportPreview.value = null;
    bundleImportPreviewBinding.value = null;
    bundleImportLoading.value = false;
  }
  if (importExecuteKind.value === kind) resetImportExecutionContext();
  importError.value = '';
}
/** 选择导入文件并清空旧预演。 */
function selectImportFile(kind, upload) {
  if (importExecuteLoading.value) return;
  clearImportSelection(kind);
  if (kind === 'model') {
    modelImportFile.value = upload.raw || null;
    modelImportFileList.value = modelImportFile.value ? [upload] : [];
  } else if (kind === 'node') {
    nodeImportFile.value = upload.raw || null;
    nodeImportFileList.value = nodeImportFile.value ? [upload] : [];
  } else {
    bundleImportFile.value = upload.raw || null;
    bundleImportFileList.value = bundleImportFile.value ? [upload] : [];
  }
}
/** 开始新的预演前立即清空旧预演和全部执行上下文。 */
function prepareImportPreview(kind) {
  if (importExecuteLoading.value) return false;
  resetImportExecutionContext();
  if (kind === 'model') {
    modelImportPreview.value = null;
    modelImportPreviewBinding.value = null;
  } else if (kind === 'node') {
    nodeImportPreview.value = null;
    nodeImportPreviewBinding.value = null;
  } else {
    bundleImportPreview.value = null;
    bundleImportPreviewBinding.value = null;
  }
  importError.value = '';
  return true;
}
/** 下载能流依赖阶段的空白模板。 */
async function downloadFlowTemplate(definition) {
  const result = await safeRequest(() => downloadEnergyFlowImportTemplate(definition.templateType, 'xlsx'));
  if (!result.ok) importError.value = requestMessage(result, '能流空白模板下载失败。', '当前导入文件选择和预演状态保持不变。');
}
/** 下载能流依赖阶段的青岚示例。 */
async function downloadFlowDemo(definition) {
  const result = await safeRequest(() => downloadEnergyFlowDemoArtifact(definition.demoArtifactKey, 'xlsx'));
  if (!result.ok) importError.value = requestMessage(result, '青岚能流示例下载失败。', '当前导入文件选择和预演状态保持不变。');
}
/** 执行模型导入预演，并丢弃文件被替换或移除前的旧响应。 */
async function previewModelImport() {
  if (importExecuteLoading.value) return;
  if (!modelImportFile.value) { importError.value = '请先选择模型导入文件。'; return; }
  const fileFingerprint = createEnergyFlowImportFileFingerprint(modelImportFile.value);
  const requestTicket = modelImportRequestGuard.begin({ file: modelImportFile.value, fileFingerprint });
  if (!prepareImportPreview('model')) return;
  modelImportLoading.value = true;
  const result = await safeRequest(() => previewEnergyFlowModelImport(requestTicket.snapshot.file));
  if (!modelImportRequestGuard.isCurrent(requestTicket)) return;
  modelImportLoading.value = false;
  if (createEnergyFlowImportFileFingerprint(modelImportFile.value) !== requestTicket.snapshot.fileFingerprint) return;
  if (!result.ok) {
    importError.value = requestMessage(result, '模型导入预演失败。', '预演签名和执行入口均不可用。');
    return;
  }
  modelImportPreview.value = result.value.data || null;
  modelImportPreviewBinding.value = Object.freeze({ fileFingerprint: requestTicket.snapshot.fileFingerprint, ticket: requestTicket });
}
/** 执行节点导入预演，并丢弃文件被替换或移除前的旧响应。 */
async function previewNodeImport() {
  if (importExecuteLoading.value) return;
  if (!nodeImportFile.value) { importError.value = '请先选择节点导入文件。'; return; }
  const fileFingerprint = createEnergyFlowImportFileFingerprint(nodeImportFile.value);
  const requestTicket = nodeImportRequestGuard.begin({ file: nodeImportFile.value, fileFingerprint });
  if (!prepareImportPreview('node')) return;
  nodeImportLoading.value = true;
  const result = await safeRequest(() => previewEnergyFlowNodeImport(requestTicket.snapshot.file));
  if (!nodeImportRequestGuard.isCurrent(requestTicket)) return;
  nodeImportLoading.value = false;
  if (createEnergyFlowImportFileFingerprint(nodeImportFile.value) !== requestTicket.snapshot.fileFingerprint) return;
  if (!result.ok) {
    importError.value = requestMessage(result, '节点导入预演失败。', '预演签名和执行入口均不可用。');
    return;
  }
  nodeImportPreview.value = result.value.data || null;
  nodeImportPreviewBinding.value = Object.freeze({ fileFingerprint: requestTicket.snapshot.fileFingerprint, ticket: requestTicket });
}
/** 执行边和显式边值预演，并丢弃文件被替换或移除前的旧响应。 */
async function previewBundleImport() {
  if (importExecuteLoading.value) return;
  if (!bundleImportFile.value) { importError.value = '请先选择双工作表文件。'; return; }
  const fileFingerprint = createEnergyFlowImportFileFingerprint(bundleImportFile.value);
  const requestTicket = bundleImportRequestGuard.begin({ file: bundleImportFile.value, fileFingerprint });
  if (!prepareImportPreview('bundle')) return;
  bundleImportLoading.value = true;
  const result = await safeRequest(() => previewEnergyFlowBundleImport(requestTicket.snapshot.file));
  if (!bundleImportRequestGuard.isCurrent(requestTicket)) return;
  bundleImportLoading.value = false;
  if (createEnergyFlowImportFileFingerprint(bundleImportFile.value) !== requestTicket.snapshot.fileFingerprint) return;
  if (!result.ok) {
    importError.value = requestMessage(result, '边与显式边值预演失败。', '双批次执行入口不可用。');
    return;
  }
  bundleImportPreview.value = result.value.data || null;
  bundleImportPreviewBinding.value = Object.freeze({ fileFingerprint: requestTicket.snapshot.fileFingerprint, ticket: requestTicket });
}
/** 打开导入二次确认；无当前文件和最新预演绑定时拒绝打开。 */
function openImportExecute(kind) {
  const canExecute = kind === 'model'
    ? canExecuteModelPreview.value
    : kind === 'node' ? canExecuteNodePreview.value : canExecuteBundlePreview.value;
  if (!canExecute) return;
  importExecuteKind.value = kind;
  confirmText.value = '';
  importError.value = '';
  importExecuteDrawer.value = true;
}
/** 按导入种类构造并发送受控执行请求。 */
function submitEnergyFlowImport(kind, preview) {
  if (kind === 'model') return executeEnergyFlowModelImport(buildEnergyFlowModelImportExecutePayload(preview));
  if (kind === 'node') return executeEnergyFlowNodeImport(buildEnergyFlowNodeImportExecutePayload(preview));
  return executeEnergyFlowBundleImport(buildEnergyFlowBundleImportExecutePayload(preview));
}
/** 返回指定导入种类的当前文件指纹。 */
function currentImportFingerprint(kind) {
  if (kind === 'model') return createEnergyFlowImportFileFingerprint(modelImportFile.value);
  if (kind === 'node') return createEnergyFlowImportFileFingerprint(nodeImportFile.value);
  return createEnergyFlowImportFileFingerprint(bundleImportFile.value);
}
/** 执行受控模型、节点或双工作表导入，并只提交冻结快照对应的最新响应。 */
async function executeImport() {
  const kind = importExecuteKind.value;
  const preview = activeImportPreview.value;
  if (!activeImportCanExecute.value || !preview || confirmText.value !== preview.confirmText) return;
  const executeSnapshot = createEnergyFlowImportExecuteSnapshot(kind, preview, currentImportFingerprint(kind));
  const requestTicket = importExecuteRequestGuard.begin(executeSnapshot);
  importExecuteLoading.value = true; importError.value = '';
  const result = await safeRequest(() => submitEnergyFlowImport(executeSnapshot.kind, executeSnapshot.preview));
  const canCommit = canCommitEnergyFlowImportExecuteResponse({
    isLatest: importExecuteRequestGuard.isCurrent(requestTicket),
    snapshot: executeSnapshot,
    currentKind: importExecuteKind.value,
    currentFingerprint: currentImportFingerprint(executeSnapshot.kind)
  });
  if (!canCommit) {
    if (importExecuteRequestGuard.isCurrent(requestTicket)) importExecuteLoading.value = false;
    return;
  }
  importExecuteLoading.value = false;
  if (!result.ok) { importError.value = requestMessage(result, '能流导入执行失败。', '没有写入本次预演候选，请按页面提示处理后重试。'); return; }
  importExecuteDrawer.value = false; ElMessage.success('能流导入执行完成，后端审计与备份已保留。');
  clearImportSelection(executeSnapshot.kind);
  await loadModels();
  if (executeSnapshot.kind !== 'model' && selectedModel.value) await selectModel(selectedModel.value);
}

// 页面初始化模块。
onMounted(async () => { if (!canView.value) return; await Promise.all([loadDependencies(), loadModels()]); });
</script>

<style scoped>
.section-alert{margin-top:12px}.import-workspace{margin-top:16px}.import-dependency-list{display:grid;gap:8px}.import-dependency-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #e1e8f2;border-radius:8px;color:#516170;font-size:13px}.action-row{display:flex;flex-wrap:wrap;gap:8px}.dependency-error,.state-error{display:flex;align-items:center;gap:10px;margin-top:12px}.dependency-error :deep(.el-alert),.state-error :deep(.el-alert){flex:1}.page-card{min-width:0}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px}.section-heading h2{margin:0;color:#123b79;font-size:16px}.section-heading span{display:block;margin-top:5px;color:#7385a2;font-size:12px}.table-scroll{max-width:100%;overflow-x:auto}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.flow-tabs{min-width:0}.maintenance-grid,.import-grid,.analysis-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}.maintenance-card,.import-card{min-width:0}.analysis-card{display:grid;gap:12px}.analysis-filters{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:10px 14px}.analysis-filters :deep(.el-form-item){margin-bottom:0}.coordinate-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.reason-card{display:grid;gap:9px}.reason-card .section-heading{margin-bottom:2px}.import-card{display:flex;flex-direction:column;align-items:flex-start;gap:12px}.import-card>p{margin:0;color:#516170;font-size:13px;line-height:1.7}.import-preview{width:100%;padding-top:10px;border-top:1px solid #e1e8f2}.import-preview>p{margin:6px 0;color:#516170;font-size:13px}.drawer-notice{margin:0 0 16px;color:#516170;line-height:1.7}@media(max-width:1180px){.analysis-filters{grid-template-columns:repeat(3,minmax(150px,1fr))}.maintenance-grid,.import-grid,.analysis-detail-grid{grid-template-columns:1fr}.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.stat-grid,.analysis-filters,.coordinate-grid{grid-template-columns:1fr}.section-heading,.import-dependency-row{align-items:flex-start;flex-direction:column}}
</style>
